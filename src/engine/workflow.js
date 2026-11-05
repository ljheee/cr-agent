/**
 * CR 工作流编排 —— 覆盖 7 步流程
 *
 *  1) 触发        页面提交 PR 链接（manual）；webhook /push 预留
 *  2) 模式选择    首次全量 / 新 commit 增量 / 强制全量；基于 ledger.lastHead 判定
 *  3) Agent 执行  pi-coding-agent（OpenAI 兼容端点，模型可配置，thinking high 默认）
 *                 + 风险自适应：小 diff 走 fast-path 提示词
 *  4) 证据收集    agent 只读工具 read/grep/find/ls + diff 文件落盘；查证失败→unverified→升级 needs_human
 *  5) 结论生成    schema JSON（normalize 容错解析 + 重试一次）
 *  6) 结论交付    报告页渲染（分层：作者摘要/全量 JSON）；评论回帖接口预留
 *  7) 迭代闭环    ledger 问题跨轮复核 + 豁免清单 + 质量统计
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolvePr, parsePrUrl } from "../pr-resolver.js";
import { runCrTurn } from "./pi-runner.js";
import { normalizeReport, applyProgrammaticDemotion, buildAuthorSummary } from "./report-schema.js";
import { buildSystemPrompt, buildFastSystemPrompt, buildFullReviewUserPrompt, buildIncrementalUserPrompt } from "./prompts.js";
import { Ledger } from "./ledger.js";
import { routeByFileTypes } from "./routing.js";
import { isChangedLine } from "./bundler.js";
import { readFile } from "node:fs/promises";

/** 读团队规则（可选注入）：data/rules/{owner}_{repo}.md → data/rules/AGENTS.md 全局兑底 */
async function readTeamRules(dataDir, repo) {
  const candidates = [
    path.join(dataDir, "rules", `${String(repo).replace(/\//g, "_")}.md`),
    path.join(dataDir, "rules", "REVIEW.md"),
    path.join(dataDir, "rules", "AGENTS.md"),
  ];
  for (const p of candidates) {
    try {
      const txt = (await readFile(p, "utf8")).trim();
      if (txt) return txt.slice(0, 8000); // 上限：规则过多会稀释注意力（ocr 实践：规则上限 30 条）
    } catch { /* 不存在则试下一个 */ }
  }
  return null;
}
import { parseFiles, bundleFiles, sliceDiff, validateFindingLine, dedupeFindings } from "./bundler.js";
import { mergeReports } from "./report-schema.js";

const FAST_PATH_THRESHOLD_LINES = 200;   // 小 PR 快速通道阈值
const BUNDLE_THRESHOLD_LINES = 400;      // 超过则分桶多轮审查（分治防大变更注意力稀释）
const MAX_JSON_RETRIES = 2;
const MAX_ROUNDS = 3;                    // 轮次上限（Anthropic 收敛四规则）：超限强制 needs_human

// 同一 PR 的审查串行化：防止并发提交时账本读-改-写互相覆盖
const prLocks = new Map();
export async function withPrLock(key, fn) {
  const prev = prLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const chained = prev.then(() => gate);   // Map 里存的与 finally 比较的必须是同一个链式 promise
  prLocks.set(key, chained);
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
    if (prLocks.get(key) === chained) prLocks.delete(key);
  }
}

export class CrWorkflow {
  /**
   * @param {object} cfg { dataDir, settings (runtime settings), emit(event) }
   */
  constructor(cfg) {
    this.dataDir = cfg.dataDir;
    this.settings = cfg.settings;
    this.emit = cfg.emit || (() => {});
  }

  async run(prUrl, options = {}) {
    // 锁粒度用 repo#pr（同一 PR 的变体链接——尾斜杠/query/overview——应串行，而不是各自加锁）；
    // 解析纯链接幂等只读，可在锁外完成。统一小写：大小写不敏感文件系统下同一账本文件应同一把锁
    const parsed = parsePrUrl(prUrl);
    if (!parsed) throw new Error(`无法解析 PR 链接: ${prUrl}`);
    // 轮次上限提前判定（在锁外也可，但为串行化账本读改写仍在锁内、只移到网络解析之前）：
    // 超限拒绝不应对外付出取 PR 的网络成本
    return withPrLock(`${parsed.repo}#${parsed.pr}`.toLowerCase(), () => this._run(prUrl, parsed, options));
  }

  async _run(prUrl, parsed, options = {}) {
    const t0 = Date.now();
    const settings = this.settings.get();

    // ── 轮次上限（Anthropic 收敛四规则：防"夜间 50 轮死循环"）：超限强制收敛为 needs_human
    //    放在 resolvePr 之前：repo#pr 已从链接解析得到，拒绝前不应再付出取 PR 的网络成本
    const capLedger = await Ledger.load(this.dataDir, parsed.repo, parsed.pr);
    if (capLedger.round >= MAX_ROUNDS) {
      this.emit({ stage: "mode", status: "done", mode: "full", round: capLedger.round + 1, roundsCapped: true });
      capLedger.data.needs_human_reason = `已达轮次上限 ${MAX_ROUNDS}，剩余未闭环问题请人工确认`;
      await capLedger.save();
      const err = new Error(`该 PR 已审查 ${capLedger.round} 轮（上限 ${MAX_ROUNDS}），请人工确认剩余问题后再触发新审查；如确需重置可删除账本文件 data/ledgers/${parsed.repo.replace(/\//g, "_")}#${parsed.pr}.json`);
      err.status = 429;
      throw err;
    }

    // ── 1) 触发 & 解析 PR ──
    this.emit({ stage: "resolve", status: "start", prUrl });
    const pr = await resolvePr(prUrl, settings);
    this.emit({ stage: "resolve", status: "done", pr: { repo: pr.repo, number: pr.pr, title: pr.meta?.title } });

    // ── 2) 模式选择（基于账本） ──
    const ledger = await Ledger.load(this.dataDir, pr.repo, pr.pr);
    // head 在 pr.meta.head（resolvePr 返回结构），增量判定用它
    const head = pr.meta?.head;
    let mode = "full";
    if (!options.forceFull && ledger.round > 0 && head && ledger.lastHead && head !== ledger.lastHead) {
      mode = "incremental";
    }
    if (options.forceFull) mode = "full";
    this.emit({ stage: "mode", status: "done", mode, round: ledger.round + 1 });

    // ── 3) 准备 agent 工作区（diff 落盘供工具查看） ──
    const workDir = path.join(this.dataDir, "workspaces", `${pr.repo.replace(/\//g, "_")}-${pr.pr}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    // ── 主体 try/finally：任何失败路径都清理临时工作区，避免 workspaces 磁盘泄漏 ──
    try {
    await writeFile(path.join(workDir, "PR.diff"), pr.diff || "");
    // GitHub 的 meta.commits 是次数（数字）；只有数组形态才落盘提交列表
    if (Array.isArray(pr.meta?.commits)) await writeFile(path.join(workDir, "PR_COMMITS.txt"), pr.meta.commits.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n"));
    // ── 风险自适应调度（按实际变更行数，与 parseFiles 同口径：排除 +++/--- 文件头） ──
    const additions = (pr.diff || "").match(/^\+(?!\+\+)/gm) || [];
    const deletions = (pr.diff || "").match(/^-(?!--)/gm) || [];
    const diffLines = (pr.diff || "").split("\n").length;
    const changedLines = additions.length + deletions.length;
    const fastPath = mode === "full" && changedLines < FAST_PATH_THRESHOLD_LINES && !options.forceFull;
    const systemPrompt = fastPath ? buildFastSystemPrompt() : buildSystemPrompt();
    const modelId = options.model || settings.defaultModel || (settings.models?.[0]?.id);
    const thinkingLevel = options.thinking || settings.defaultThinking || "high";
    if (!modelId) throw new Error("未配置模型，请先到设置页选择");

    // ── 分桶决策前置：files/filesChangedList 必须在 promptCtx 之前声明（TDZ） ──
    // filesChanged 统一从 parseFiles(diff) 派生：API 路径 meta.files 是数字、git 路径才是数组，
    // 直接信 meta 会导致提示词"变更文件"恒空
    const files = parseFiles(pr.diff || "");
    const filesChangedList = files.length ? files.map((f) => f.path) : (Array.isArray(pr.meta?.filesChanged) ? pr.meta.filesChanged : []);

    // ── 用户提示词（全量 vs 增量；分桶时每桶单独构建） ──
    // ── 文件类型路由（吸收 ocr：按变更文件类型升优先视角 + 附加检查指令） ──
    const routing = routeByFileTypes(filesChangedList);

    // ── 团队规则可选注入（吸收 Copilot/ai-pr-code-review 的 REVIEW.md 机制） ──
    // 查找顺序：data/rules/{owner}_{repo}.md（per-repo）→ data/rules/AGENTS.md（全局）；
    // 规则由 Code Owner 手工维护，不进模型自学习（防规则漂移）
    const teamRules = await readTeamRules(this.dataDir, parsed.repo);

    const promptCtx = {
      pr: { ...pr, title: pr.meta?.title || `PR #${pr.pr}`, filesChanged: filesChangedList, stat: pr.meta?.stat, commits: pr.meta?.commits, base: pr.meta?.base, head: pr.meta?.head },
      diff: pr.diff || "",
      round: ledger.round + 1,
      previousFindings: mode === "incremental" ? ledger.previousFindingsForPrompt() : [],
      exempt: ledger.exemptList,
      settings,
      routing,
      teamRules,
    };

    // ── 分桶决策（确定性工程：大 diff 分治，每桶一个 sub-agent 隔离上下文；仅全量首轮分桶，增量复审需跨轮闭环不分桶） ──
    const doBundle = mode === "full" && changedLines >= BUNDLE_THRESHOLD_LINES && files.length >= 2;
    let bundles = null;
    if (doBundle) {
      bundles = bundleFiles(files, { maxLinesPerBundle: 800, maxBundles: 8 });
      // 分桶退化保护：分完只有 1 桶则不启分桶
      if (bundles.length <= 1) { bundles = null; }
    }
    const bundleMeta = bundles ? bundles.map((b, i) => ({ idx: i + 1, files: b.map((f) => f.path) })) : null;
    this.emit({ stage: "schedule", status: "done", fastPath, diffLines, changedLines, bundled: !!bundles, bundles: bundleMeta?.length || 0, model: modelId, thinking: thinkingLevel });

    // ── 4+5) Agent 执行 + 结论生成（JSON 解析失败重试；分桶时逐桶执行后确定性合并） ──
    const runOneTurn = async (ctx) => {
      const { systemPrompt, userPrompt, workDir: wd } = ctx;
      this.emit({ stage: "agent", status: "start", model: modelId, bundle: ctx.bundleIdx });
      for (let attempt = 1; attempt <= MAX_JSON_RETRIES; attempt++) {
        const extra = attempt > 1 ? "\n\n（注意：上一次输出不是合法 JSON。这次只输出 JSON 本体，不要任何其他文字，也不要再调用工具。）" : "";
        // 只转发低频关键事件：message_update 是逐 token 高频流水（每分钟数千条），
        // 打爆进度事件数组（MAX_EVENTS）导致进度接口"装死"被误判为断流
        const noisy = new Set(["message_update"]);
        const { text, usage, toolCalls } = await runCrTurn({
          settings, dataDir: this.dataDir, workDir: wd,
          systemPrompt, userPrompt: userPrompt + extra,
          model: modelId, thinkingLevel,
          onEvent: (e) => {
            const type = e?.type;
            if (noisy.has(type)) return;
            this.emit({ stage: "agent-event", event: { type }, bundle: ctx.bundleIdx });
          },
        });
        try {
          const rep = normalizeReport(text);
          rep._usage = usage; rep._toolCalls = toolCalls;
          return rep;
        } catch (e) {
          if (attempt >= MAX_JSON_RETRIES) throw new Error(`模型输出无法解析为 JSON 报告（末次输出开头：${(text || "").slice(0, 120)}）：${e.message}`);
          this.emit({ stage: "agent", status: "parse-fail", attempt, bundle: ctx.bundleIdx, error: e.message });
        }
      }
    };

    let report;
    const normalizeFindingFile = (rep) => {
      // finding.file 归一化（去 b/ 与 / 前缀）：跨桶去重、豁免匹配、账本跨轮匹配都做精确比较，
      // 变体路径（b/src/Foo.java）会让同一问题每次都新建条目（P2-4）
      for (const f of rep.findings || []) {
        f.file = String(f.file || "").replace(/^b\//, "").replace(/^\//, "");
      }
    };
    const validateLines = (rep) => {
      for (const f of rep.findings || []) {
        const v = validateFindingLine(f, files);
        if (v.adjusted) { f.line = v.line; f.line_adjusted = true; f.original_line = v.originalLine; }
      }
    };
    // pre-existing 程序化判定（吸收 Claude Code 实践：59% "问题代码"系存量，对 base 比对而非模型猜测）：
    // finding 的 file:line 不在本次新增行（+ 行）上 → 存量代码，标记并由 normalize 兑底降级
    const markPreExisting = (rep) => {
      for (const f of rep.findings || []) {
        // 行号数值化：模型可能输出 "13"（字符串），isChangedLine 的 Number.isInteger 检查会静默跳过
        const n = Number(f.line);
        f.line = Number.isInteger(n) ? n : null;
        // 校正过的行号（line_adjusted）本身不可信：被钉到 hunk 头的位置不能作为存量判定依据
        if (f.line == null || f.line_adjusted) continue;
        const onAdded = isChangedLine(files, f.file, f.line);
        if (onAdded === false) {
          f.introduced_by = "pre-existing";
          f.pre_existing_detected = "programmatic"; // 区别于模型猜测
        } else if (onAdded === true && f.introduced_by === "pre-existing") {
          f.introduced_by = "this-pr"; // 程序化证据纠正模型猜测
          f.pre_existing_detected = "programmatic";
        }
      }
    };
    if (bundles) {
      // 分桶执行：每桶一个 sub-agent（独立会话/隔离上下文），共享 PR 头信息
      const allPaths = files.map((f) => f.path);
      const subReports = [];
      for (const [bi, b] of bundles.entries()) {
        const paths = b.map((f) => f.path);
        const bundleCtx = {
          ...promptCtx,
          diff: sliceDiff(pr.diff || "", paths),
          // 共享头：全 PR 文件清单（让桶知道还有别的桶，防只见树木）
          otherFiles: allPaths.filter((p) => !paths.includes(p)),
        };
        const sub = await runOneTurn({
          systemPrompt: fastPath ? buildFastSystemPrompt() : buildSystemPrompt(),
          userPrompt: (mode === "incremental"
            ? buildIncrementalUserPrompt(bundleCtx)
            : buildFullReviewUserPrompt(bundleCtx)) + `\n\n【分桶说明】本次是分治审查的第 ${bi + 1}/${bundles.length} 桶，你只审以上文件；其他文件由并行会话负责，不要报告它们的未变化部分。`,
          workDir, bundleIdx: bi + 1,
        });
        subReports.push(sub);
      }
      // finding.file 归一化 + 行号校验（位置漂移防线）
      for (const sub of subReports) {
        normalizeFindingFile(sub);
        validateLines(sub);
        markPreExisting(sub);
      }
      // 确定性合并（纯程序化，非模型）：findings 拼接 + Jaccard 去重 + 取最严结论
      report = mergeReports(subReports, { bundles: bundleMeta }, dedupeFindings);
      // provenance 全局裁决：合并后的 findings 用全 PR 的 files 重跑存量判定
      //（桶间对同一问题可能给出不同 introduced_by，去重合并只保留首个——以全局行号证据统一）
      markPreExisting(report);
      // 程序化降档（必须后于 markPreExisting：先打标记后降档；幂等）
      applyProgrammaticDemotion(report);
      report._usage = { bundles: subReports.map((r) => r._usage) };
      report._toolCalls = subReports.reduce((a, r) => a + (r._toolCalls || 0), 0);
    } else {
      // 单轮执行（原有路径）
      const userPrompt = mode === "incremental"
        ? buildIncrementalUserPrompt(promptCtx)
        : buildFullReviewUserPrompt(promptCtx);
      report = await runOneTurn({ systemPrompt, userPrompt, workDir, bundleIdx: null });
      // finding.file 归一化 + 行号校验 + 程序化存量判定同样生效
      normalizeFindingFile(report);
      validateLines(report);
      markPreExisting(report);
      // 程序化降档（必须后于 markPreExisting：先打标记后降档）+ 用归一化后的 file 重建摘要
      applyProgrammaticDemotion(report);
      report.author_summary = buildAuthorSummary(report);
    }

    // ── 补充元数据 ──
    report.pr = {
      url: prUrl, repo: pr.repo, number: pr.pr, title: pr.meta?.title || "",
      author: pr.meta?.author || "", head: pr.meta?.head || "", base: pr.meta?.base || "",
      files_changed: filesChangedList.length,
      additions: additions.length,
      deletions: deletions.length,
    };
    report.review = {
      ...(report.review || {}),
      mode, round: ledger.round + 1, trigger: options.trigger || "manual",
      model: modelId, thinking: thinkingLevel, fast_path: fastPath,
      // 保留模型返回的 previous_findings（fixed/still_exists 判定），供 applyRound 闭环使用；
      // 提示词里给出的快照另存字段，不覆盖模型输出
      previous_findings: report.review?.previous_findings || [],
      prompt_previous_findings: mode === "incremental" ? promptCtx.previousFindings : [],
      elapsed_ms: Date.now() - t0,
    };

    // ── 截断/降级声明：diff 截断与拉取降级如实声明（防静默漏审） ──
    const maxDiffChars = Number.isInteger(settings.maxDiffChars) && settings.maxDiffChars > 0 ? settings.maxDiffChars : 400000;
    if ((pr.diff || "").length > maxDiffChars) {
      if (!Array.isArray(report.verification?.degraded_steps)) report.verification = { ...(report.verification || {}) };
      report.verification.degraded_steps = [...(report.verification.degraded_steps || []),
        `diff 超过 maxDiffChars（${(pr.diff || "").length}/${maxDiffChars}），提示词中被截断；完整 diff 已落盘工作区 PR.diff，仅当 agent 未主动 read 查看时存在漏审风险`];
    }
    // GitLab >10 页 diff 条目截断（meta.diff_truncated 由 pr-resolver 声明）
    if (pr.meta?.diff_truncated) {
      if (!Array.isArray(report.verification?.degraded_steps)) report.verification = { ...(report.verification || {}) };
      report.verification.degraded_steps = [...(report.verification.degraded_steps || []), pr.meta.diff_truncated];
    }
    // API 拉取失败走 git 兜底（resolveErrors 由 pr-resolver 收集）：声明降级与 base 语义差异
    if (Array.isArray(pr.resolveErrors) && pr.resolveErrors.length) {
      if (!Array.isArray(report.verification?.degraded_steps)) report.verification = { ...(report.verification || {}) };
      report.verification.degraded_steps = [...(report.verification.degraded_steps || []),
        `PR 拉取降级：${pr.resolveErrors.join("；")}（diff 来自 git 兜底，base 可能退化为 prhead~1，审查范围可能缩小）`];
    }

    // ── 7) 迭代闭环：入账 ──
    const roundNo = ledger.applyRound(report, { mode, model: modelId, thinking: thinkingLevel, head: pr.meta?.head, trigger: options.trigger || "manual" });
    await ledger.save();

    // 持久化报告
    const reportsDir = path.join(this.dataDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    const reportId = `${pr.repo.replace(/\//g, "_")}-${pr.pr}-r${roundNo}-${Date.now()}`;
    const reportFile = path.join(reportsDir, `${reportId}.json`);
    // 落盘前脱敏：提示注入可诱导 agent 读 data/settings.json 或 auth.json 并写进报告——
    // 凭证子串一律替换（确定性防线，不依赖 SDK read 的路径约束）。
    // 同样的脱敏作用于返回给调用方的内存对象（sync 模式 res.json 直接回传），防公开 API 分支绕过
    const redact = (txt, secrets) => {
      let out = txt;
      for (const s of secrets) { if (s && s.length >= 8) out = out.split(s).join("[REDACTED]"); }
      return out;
    };
    const secrets = [settings.apiKey, ...Object.values(settings.platformTokens || {})].filter((s) => typeof s === "string" && s);
    const reportText = redact(JSON.stringify({ ...report, ledger_stats: ledger.stats() }, null, 2), secrets);
    await writeFile(reportFile, reportText);
    // 返回的 report 从已脱敏文本读回（内存对象与落盘一致；sync 响应不泄漏凭证）
    const redactedReport = JSON.parse(reportText);

    this.emit({ stage: "done", status: "ok", reportId, conclusion: redactedReport.conclusion, stats: ledger.stats() });
    // reportFile 是服务器磁盘绝对路径，不随返回值外发（异步模式本就不返回；本地工具用途有限，
    // 但与报告 ID防护同源的保守策略）：报告已落盘，详情走 GET /api/reports/:id
    return { reportId, report: redactedReport, ledger: ledger.stats() };
    } finally {
      // 清理临时工作区（报告已含全部证据；失败路径同样清理，避免 workspaces 磁盘泄漏）
      rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
