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
import { mkdir, writeFile, rm, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { resolvePr, parsePrUrl } from "../pr-resolver.js";
import { runCrTurn, FORMAT_RETRY_NUDGE } from "./pi-runner.js";
import { normalizeReport, applyProgrammaticDemotion, coerceStringifiedJsonFields, coerceFindingLine, appendDegradedStep } from "./report-schema.js";
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
import { applyAnchorSeverity, recomputeReportAggregates } from "./severity-anchors.js";
import { verifySnippets } from "./evidence-verify.js";
import { clampExaggerationAnchors } from "./anti-exaggeration.js";
import { runVerifierSession, applyVerifierVerdicts } from "./verifier.js";
import { persistBundleReport } from "./submit-review-tool.js";
import { DEFAULT_SEVERITY_RULES, validateSeverityRules } from "./severity-rules-default.js";

/**
 * 加载定级规则表：data/severity-rules.json 存在则替换默认表（每轮重读，改完即生效）；
 * 校验失败/文件损坏回退默认表并返回降级说明（不静默吞，写入报告 degraded_steps）。
 */
async function loadSeverityRules(dataDir) {
  const file = path.join(dataDir, "severity-rules.json");
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch { return { rules: DEFAULT_SEVERITY_RULES, note: null }; } // 无自定义文件：静默用默认
  try {
    const rules = validateSeverityRules(JSON.parse(raw));
    return { rules, note: `定级规则表：自定义（${rules.length} 条，data/severity-rules.json）` };
  } catch (e) {
    return { rules: DEFAULT_SEVERITY_RULES,
      note: `定级规则表加载失败已回退内置默认（${e.message}）；请修正 data/severity-rules.json` };
  }
}

const FAST_PATH_THRESHOLD_LINES = 200;   // 小 PR 快速通道阈值
const BUNDLE_THRESHOLD_LINES = 400;      // 超过则分桶多轮审查（分治防大变更注意力稀释）
/** 同会话内交卷失败后的格式纠正次数（追加 prompt，不丢工具轨迹） */
const MAX_IN_SESSION_FORMAT_RETRIES = 2;
/** 同会话仍失败后的冷启动兜底次数（全新 session；默认 1） */
const MAX_COLD_START_FALLBACKS = 1;
// 轮次上限（Anthropic 收敛四规则）：超限强制 needs_human；可在设置页调整（settings.maxRounds，默认 3）
const DEFAULT_MAX_ROUNDS = 3;

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
    const parsed = parsePrUrl(prUrl, this.settings.get());
    if (!parsed) throw new Error(`无法解析 PR 链接: ${prUrl}`);
    // 轮次上限提前判定（在锁外也可，但为串行化账本读改写仍在锁内、只移到网络解析之前）：
    // 超限拒绝不应对外付出取 PR 的网络成本
    return withPrLock(`${parsed.repo}#${parsed.pr}`.toLowerCase(), () => this._run(prUrl, parsed, options));
  }

  /**
   * P0/P1 verifier 回路（fail-open）：锚点定级后的高风险 findings 起独立验证会话复核证据链。
   * 独立端点/密钥/模型可配（settings.verifier*），未设置兕底 worker 同款模型。
   * 失败/解析不出不阻断主报告，degraded_steps 留痕（锚点证据门仍是底线）。
   */
  async _runVerifier(report, settings, workDir, modelId, prMeta = {}) {
    const high = (report.findings || []).filter((f) => f.severity === "P0" || f.severity === "P1");
    if (settings.verifierEnabled === false || high.length === 0) return null;
    // 源码树实体检查：repo checkout 降级（仅剩 .git/无文件）时 verifier 会读不到源码只能盲裁，
    // 系统提示词「不确定倾向 downgrade」会成批误降合法 P0/P1——直接跳过并留痕
    const repoDir = path.join(workDir, "repo");
    let repoUsable = false;
    try {
      const entries = await readdir(repoDir).catch(() => []);
      repoUsable = entries.some((n) => n !== ".git");
    } catch { /* 目录不存在 */ }
    if (!repoUsable) {
      report._verifier = { enabled: true, count: high.length, skipped: true, reason: "repo 源码树不可用（checkout 降级），跳过复核防盲裁" };
      appendDegradedStep(report,
        `P0/P1 独立验证跳过：workDir/repo 无源码（checkout 降级），保留锚点定级（${high.length} 条未复核）`);
      this.emit({ stage: "verifier", status: "skip", reason: "repo-unavailable" });
      return report._verifier;
    }
    this.emit({ stage: "verifier", status: "start", count: high.length, model: settings.verifierModel || modelId });
    try {
      const { verdicts, usage, model } = await runVerifierSession({
        settings, dataDir: this.dataDir, workDir, findings: high, workerModelId: modelId, prMeta,
        emit: (e) => { if (e?.type === "tool_execution_start") this.emit({ stage: "verifier-event", event: { type: e.type } }); },
      });
      const res = applyVerifierVerdicts(report, verdicts);
      recomputeReportAggregates(report, "复核");
      report._verifier = { enabled: true, count: high.length, model, ...res, usage };
      if (res.voided.length) {
        appendDegradedStep(report,
          `verifier 证伪剔除 ${res.voided.length} 条：${res.voided.slice(0, 3).join("；")}${res.voided.length > 3 ? "…" : ""}`);
      }
      if (res.downgraded.length) {
        appendDegradedStep(report,
          `verifier 降级 ${res.downgraded.length} 条：${res.downgraded.slice(0, 3).join("；")}${res.downgraded.length > 3 ? "…" : ""}`);
      }
      this.emit({ stage: "verifier", status: "done", confirmed: res.confirmed, downgraded: res.downgraded.length, voided: res.voided.length });
    } catch (e) {
      report._verifier = { enabled: true, count: high.length, failed: true, error: String(e.message || e).slice(0, 300) };
      appendDegradedStep(report,
        `P0/P1 独立验证会话失败（fail-open，保留锚点定级）：${String(e.message || e).slice(0, 200)}`);
      this.emit({ stage: "verifier", status: "fail", error: String(e.message || e).slice(0, 200) });
    }
    return report._verifier;
  }

  async _run(prUrl, parsed, options = {}) {
    const t0 = Date.now();
    const settings = this.settings.get();

    // 凭证脱敏（声明在 try 外：主报告落盘与 finally 归档脱敏共用；
    // try 早期失败时 finally 仍可访问，不会 ReferenceError）
    const redact = (txt, secs) => {
      let out = txt;
      for (const s of secs) { if (s && s.length >= 8) out = out.split(s).join("[REDACTED]"); }
      return out;
    };
    const secrets = [settings.apiKey, settings.verifierApiKey, ...Object.values(settings.platformTokens || {})].filter((s) => typeof s === "string" && s);

    // ── 轮次上限（Anthropic 收敛四规则：防"夜间 50 轮死循环"）：超限强制收敛为 needs_human
    //    放在 resolvePr 之前：repo#pr 已从链接解析得到，拒绝前不应再付出取 PR 的网络成本
    const capLedger = await Ledger.load(this.dataDir, parsed.repo, parsed.pr);
    const maxRounds = Math.max(1, Math.min(20, Number(settings.maxRounds) || DEFAULT_MAX_ROUNDS));
    if (capLedger.round >= maxRounds) {
      this.emit({ stage: "mode", status: "done", mode: "full", round: capLedger.round + 1, roundsCapped: true });
      capLedger.data.needs_human_reason = `已达轮次上限 ${maxRounds}，剩余未闭环问题请人工确认`;
      await capLedger.save();
      const err = new Error(`该 PR 已审查 ${capLedger.round} 轮（上限 ${maxRounds}），请人工确认剩余问题后再触发新审查；如确需重置可删除账本文件 data/ledgers/${String(parsed.repo || "").trim().replace(/\/+$/, "").replace(/\//g, "_").toLowerCase()}#${Number(parsed.pr)}.json`);
      err.status = 429;
      throw err;
    }

    // ── 1) 触发 & 解析 PR（withRepo：源码树落盘 workDir/repo，供 agent read/grep 未改动代码） ──
    // workDir/reportId 提升到 try 外：finally 归档与清理都要用；mkdir/resolvePr 也必须在 try 内，
    // 否则 resolve 失败会泄漏空工作区（注释承诺「任何失败路径都清理」）
    let workDir = null;
    let reportId = null;
    try {
    this.emit({ stage: "resolve", status: "start", prUrl });
    // workDir 命名在 pr 声明之前：从 URL 提取 repo/pr（容错：解析失败退化为时间戳）
    const nameHint = prUrl.match(/\/([^/]+)\/pull-requests\/(\d+)/) || prUrl.match(/([^/]+)\/(\d+)/);
    workDir = path.join(this.dataDir, "workspaces", `${(nameHint ? nameHint[1].replace(/\.git$/, "") : "pr").replace(/\//g, "_")}-${nameHint ? nameHint[2] : Date.now()}-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    const pr = await resolvePr(prUrl, settings, { withRepo: path.join(workDir, "repo") });
    this.emit({ stage: "resolve", status: "done", pr: { repo: pr.repo, number: pr.pr, title: pr.meta?.title }, head: pr.meta?.head || null });

    // ── 2) 模式选择（基于账本） ──
    const ledger = await Ledger.load(this.dataDir, pr.repo, pr.pr);
    // head 在 pr.meta.head（resolvePr 返回结构），增量判定用它
    const head = pr.meta?.head;
    // 幂等门：同一 head 审过至少一轮且未勾强制全量 → 不重跑（代码未变，重跑大概率得到近似结果且烧轮次预算）
    if (!options.forceFull && ledger.round > 0 && head && ledger.lastHead && head === ledger.lastHead) {
      this.emit({ stage: "mode", status: "done", mode: "unchanged", round: ledger.round, headUnchanged: true });
      const err = new Error(`PR 无新提交（head 未变化，上次审查为第 ${ledger.round} 轮）；如需重审请勾选「强制全量重审」`);
      err.status = 409; err.headUnchanged = true;
      throw err;
    }
    let mode = "full";
    if (!options.forceFull && ledger.round > 0 && head && ledger.lastHead && head !== ledger.lastHead) {
      mode = "incremental";
    }
    if (options.forceFull) mode = "full";
    this.emit({ stage: "mode", status: "done", mode, round: ledger.round + 1 });

    // ── 3) 准备 agent 工作区（diff 落盘供工具查看；源码树已 checkout 到 workDir/repo） ──
    await writeFile(path.join(workDir, "PR.diff"), pr.diff || "");
    // GitHub 的 meta.commits 是次数（数字）；只有数组形态才落盘提交列表
    if (Array.isArray(pr.meta?.commits)) await writeFile(path.join(workDir, "PR_COMMITS.txt"), pr.meta.commits.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n"));
    // ── 风险自适应调度（按实际变更行数，与 parseFiles 同口径：排除 +++/--- 文件头） ──
    const additions = (pr.diff || "").match(/^\+(?!\+\+)/gm) || [];
    const deletions = (pr.diff || "").match(/^-(?!--)/gm) || [];
    const diffLines = (pr.diff || "").split("\n").length;
    const changedLines = additions.length + deletions.length;
    // 空 diff 防线：diff 无内容行（拉取退化/PR 无变更）时禁止 fast_path——曾因 changedLines=0 静默走快速通道，
    // 66 findings 降为 9 findings 的质量塌方；此时按无 diff 处理并在报告里如实声明
    const diffEmpty = !/^\+(?!\+\+)/m.test(pr.diff || "") && !/^-(?!--)/m.test(pr.diff || "");
    const fastPath = mode === "full" && changedLines < FAST_PATH_THRESHOLD_LINES && !diffEmpty && !options.forceFull;
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

    // ── 团队规则可选注入（吸收 Copilot） ──
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

    // progress / audit 排障：截断后的模型原文（脱敏）；全文落盘 .cr-agent/raw-*.json
    const RAW_TEXT_HEAD = 4000;
    const persistAgentRaw = async (wd, payload) => {
      try {
        const dir = path.join(wd, ".cr-agent");
        await mkdir(dir, { recursive: true });
        const name = `raw-${payload.kind}-b${payload.bundleIdx ?? 0}-a${payload.attempt}.json`;
        const file = path.join(dir, name);
        const body = {
          at: new Date().toISOString(),
          kind: payload.kind,
          bundleIdx: payload.bundleIdx ?? null,
          attempt: payload.attempt,
          error: payload.error || null,
          textLen: (payload.text || "").length,
          text: payload.text || "",
          diagnostics: payload.diagnostics || null,
        };
        await writeFile(file, redact(JSON.stringify(body, null, 2), secrets));
        return name;
      } catch { return null; }
    };

    // ── 4+5) Agent 执行 + 结论生成（双通道：submit_review 工具对象直传优先，文本 JSON 解析兜底；分桶时逐桶执行后确定性合并） ──
    const runOneTurn = async (ctx) => {
      const { systemPrompt, userPrompt, workDir: wd } = ctx;
      this.emit({ stage: "agent", status: "start", model: modelId, bundle: ctx.bundleIdx });
      // 只转发低频关键事件：message_update 是逐 token 高频流水（每分钟数千条），
      // 打爆进度事件数组（MAX_EVENTS）导致进度接口"装死"被误判为断流
      const noisy = new Set(["message_update"]);
      const onAgentEvent = (e) => {
        const type = e?.type;
        if (noisy.has(type)) return;
        this.emit({ stage: "agent-event", event: { type }, bundle: ctx.bundleIdx });
      };
      const emitDeliveryFail = async ({ kind, attempt, sessionKind, text, error, toolCalls, submitted, diagnostics }) => {
        const rawName = await persistAgentRaw(wd, {
          kind,
          bundleIdx: ctx.bundleIdx,
          attempt,
          text: text || "",
          error: error || null,
          diagnostics: diagnostics || null,
        });
        this.emit({
          stage: "agent",
          status: kind === "empty-response" || kind === "agent-fail" ? kind : "parse-fail",
          attempt,
          session: sessionKind,
          bundle: ctx.bundleIdx,
          error: error || "",
          textLen: (text || "").length,
          textHead: redact((text || "").slice(0, RAW_TEXT_HEAD), secrets),
          toolCalls,
          submitted: !!submitted,
          rawFile: rawName,
          diagnostics: diagnostics || undefined,
        });
      };
      /** 单次会话：同会话内最多 MAX_IN_SESSION_FORMAT_RETRIES 次 nudge；成功返回 report，失败返回 null */
      let lastTextHead = "";
      let lastError = "";
      const runSession = async (prompt, sessionKind) => {
        let text = "";
        let usage = null;
        let toolCalls = 0;
        let submittedReport = null;
        let inSessionNudges = 0;
        try {
          ({ text, usage, toolCalls, submittedReport, inSessionNudges } = await runCrTurn({
            settings, dataDir: this.dataDir, workDir: wd, bundleIdx: ctx.bundleIdx,
            systemPrompt, userPrompt: prompt,
            model: modelId, thinkingLevel,
            inSessionFormatRetries: MAX_IN_SESSION_FORMAT_RETRIES,
            formatNudge: FORMAT_RETRY_NUDGE,
            onEvent: onAgentEvent,
            onFormatRetry: async ({ attempt, text: failText }) => {
              lastTextHead = (failText || "").slice(0, 120);
              lastError = "同会话交卷失败，追加格式纠正提示";
              await emitDeliveryFail({
                kind: "parse-fail",
                attempt,
                sessionKind,
                text: failText,
                error: lastError,
                toolCalls: null,
                submitted: false,
              });
            },
          }));
        } catch (e) {
          const diagnostics = e?.diagnostics || null;
          const status = diagnostics ? "empty-response" : "agent-fail";
          const headFromParts = (diagnostics?.lastAssistant?.parts || [])
            .map((p) => p.textHead || p.thinkingHead || "")
            .filter(Boolean)
            .join("\n");
          lastTextHead = headFromParts.slice(0, 120);
          lastError = e?.message || String(e);
          await emitDeliveryFail({
            kind: status,
            attempt: (diagnostics?.inSessionNudges || 0) + 1,
            sessionKind,
            text: headFromParts,
            error: lastError,
            toolCalls: diagnostics?.toolCalls,
            submitted: diagnostics?.submittedReport,
            diagnostics,
          });
          // 可交卷失败（空响应）允许外层冷启动；超时/模型缺失等硬错误直接抛
          if (e?.deliveryFailed) return null;
          throw e;
        }
        // 通道 1：submit_review
        if (submittedReport && typeof submittedReport === "object") {
          try {
            const rep = normalizeReport(coerceStringifiedJsonFields(submittedReport));
            rep._usage = usage; rep._toolCalls = toolCalls; rep._submitted = true;
            rep._inSessionNudges = inSessionNudges || 0;
            rep._sessionKind = sessionKind;
            return rep;
          } catch (e) {
            const dumped = (() => { try { return JSON.stringify(submittedReport); } catch { return String(submittedReport); } })();
            lastTextHead = dumped.slice(0, 120);
            lastError = `submit_review 参数校验失败：${e.message}`;
            await emitDeliveryFail({
              kind: "submit-normalize-fail",
              attempt: (inSessionNudges || 0) + 1,
              sessionKind,
              text: dumped,
              error: lastError,
              toolCalls,
              submitted: true,
            });
          }
        }
        // 通道 2：文本 JSON
        try {
          const rep = normalizeReport(text);
          rep._usage = usage; rep._toolCalls = toolCalls;
          rep._inSessionNudges = inSessionNudges || 0;
          rep._sessionKind = sessionKind;
          try { await persistBundleReport(wd, ctx.bundleIdx, rep); rep._file_persisted = "text-channel"; }
          catch (e) { this.emit({ stage: "agent", status: "persist-fail", bundle: ctx.bundleIdx, error: String(e.message || e) }); }
          return rep;
        } catch (e) {
          lastTextHead = (text || "").slice(0, 120);
          lastError = e.message;
          await emitDeliveryFail({
            kind: "parse-fail",
            attempt: (inSessionNudges || 0) + 1,
            sessionKind,
            text: text || "",
            error: e.message,
            toolCalls,
            submitted: !!submittedReport,
          });
          return null;
        }
      };

      // 主会话（同会话 nudge）→ 仍失败则冷启动兜底 1 次
      const primary = await runSession(userPrompt, "primary");
      if (primary) return primary;
      for (let cold = 1; cold <= MAX_COLD_START_FALLBACKS; cold++) {
        this.emit({ stage: "agent", status: "cold-start", attempt: cold, bundle: ctx.bundleIdx });
        const fallback = await runSession(`${userPrompt}\n\n${FORMAT_RETRY_NUDGE}`, `cold-start-${cold}`);
        if (fallback) return fallback;
      }
      throw new Error(`模型输出无法解析为 JSON 报告（同会话纠正 ${MAX_IN_SESSION_FORMAT_RETRIES} 次 + 冷启动 ${MAX_COLD_START_FALLBACKS} 次均失败；末次输出开头：${lastTextHead}）${lastError ? `：${lastError}` : ""}`);
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
        // 行号数值化：跳过 null（Number(null)===0 会误判存量）；模型可能输出 "13" 字符串
        f.line = coerceFindingLine(f.line);
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
      // 分桶执行：每桶一个 sub-agent（独立会话/隔离上下文），共享 PR 头信息。
      // 桶间并行度可配（设置页 bundleConcurrency，默认 1=串行）：每桶输入独立（sliceDiff 切片）、
      // 输出独立子报告，合并不依赖顺序；进度事件带桶号。并行时 token 峰值 = 并发数 × 单桶。
      const allPaths = files.map((f) => f.path);
      const concurrency = Math.max(1, Math.min(8, Number(settings.bundleConcurrency) || 1));
      const subReports = new Array(bundles.length);
      const bundleErrors = [];
      let next = 0;
      // fail-soft：单桶失败不拖死整单（此前 6/7 成功仍因末桶散文无法 JSON 整单报废）；
      // 成功桶照常合并，失败桶记入 verification.degraded_steps / review_bundles。
      const worker = async () => {
        while (true) {
          const bi = next++;
          if (bi >= bundles.length) return;
          const b = bundles[bi];
          const paths = b.map((f) => f.path);
          const bundleCtx = {
            ...promptCtx,
            diff: sliceDiff(pr.diff || "", paths),
            // 共享头：全 PR 文件清单（让桶知道还有别的桶，防只见树木）
            otherFiles: allPaths.filter((p) => !paths.includes(p)),
          };
          try {
            const sub = await runOneTurn({
              systemPrompt: fastPath ? buildFastSystemPrompt() : buildSystemPrompt(),
              userPrompt: (mode === "incremental"
                ? buildIncrementalUserPrompt(bundleCtx)
                : buildFullReviewUserPrompt(bundleCtx)) + `\n\n【分桶说明】本次是分治审查的第 ${bi + 1}/${bundles.length} 桶，你只审以上文件；其他文件由并行会话负责，不要报告它们的未变化部分。`,
              workDir, bundleIdx: bi + 1,
            });
            subReports[bi] = sub;
          } catch (e) {
            const msg = e?.message || String(e);
            bundleErrors.push({ idx: bi + 1, error: msg });
            subReports[bi] = null;
            this.emit({ stage: "agent", status: "bundle-fail", bundle: bi + 1, error: msg });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, bundles.length) }, () => worker()));
      const okCount = subReports.filter(Boolean).length;
      if (!okCount) {
        const detail = bundleErrors.map((e) => `b${e.idx}:${e.error}`).join(" | ").slice(0, 500);
        throw new Error(`全部分桶失败（${bundleErrors.length}/${bundles.length}）：${detail}`);
      }
      // finding.file 归一化 + 行号校验（位置漂移防线）；跳过失败桶空洞
      for (const sub of subReports) {
        if (!sub) continue;
        normalizeFindingFile(sub);
        validateLines(sub);
        markPreExisting(sub);
      }
      // 确定性合并（纯程序化，非模型）：findings 拼接 + Jaccard 去重 + 取最严结论；失败桶空洞跳过
      report = mergeReports(subReports, { bundles: bundleMeta, bundleErrors }, dedupeFindings);
      // provenance 全局裁决：合并后的 findings 用全 PR 的 files 重跑存量判定
      //（桶间对同一问题可能给出不同 introduced_by，去重合并只保留首个——以全局行号证据统一）
      markPreExisting(report);
      // 程序化降档（必须后于 markPreExisting：先打标记后降档；幂等）
      applyProgrammaticDemotion(report);
      // 证据程序化核验（先于锚点：谎报 snippet 降 unverified → 规则表自动封顶 P2）
      report._snippet_check = await verifySnippets(report, path.join(workDir, "repo"));
      if (report._snippet_check.missed) {
        appendDegradedStep(report,
          `snippet 回查未命中源码强制降 unverified ${report._snippet_check.missed} 条：${report._snippet_check.notes.slice(0, 3).join("；")}${report._snippet_check.notes.length > 3 ? "…" : ""}`);
      }
      // 反夸大窄域钳制（无 snippet / 路径轴 / 已知 Settings 守卫）→ 再锚点定级
      report._anchor_clamp = clampExaggerationAnchors(report);
      // 定级锚点重算（含 P0/P1 证据门：unverified 物理封顶 P2；test-falsified 作废；
      // blockers 随推导重算，杜绝悬挂）——同 head 两轮 P3↔P1 漂移的根治；规则表可配置
      const { rules: sevRules, note: sevNote } = await loadSeverityRules(this.dataDir);
      applyAnchorSeverity(report, sevRules);
      if (sevNote) appendDegradedStep(report, sevNote);
      report._severity_rules = sevRules.map((r) => r.id).join(",");
      report._usage = { bundles: subReports.map((r) => r?._usage || null) };
      report._toolCalls = subReports.reduce((a, r) => a + (r?._toolCalls || 0), 0);
      // submit_review 工具通道生效统计（每桶是否经工具交付而非文本解析）
      report._submittedBundles = subReports.reduce((a, r) => a + (r?._submitted ? 1 : 0), 0);
      report._failedBundles = bundleErrors.length;
      // P0/P1 verifier 回路：独立会话复核证据链（fail-open）
      await this._runVerifier(report, settings, workDir, modelId, { repo: pr.repo, pr: pr.pr, title: pr.meta?.title });
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
      // 证据程序化核验（同分桶路径）
      report._snippet_check = await verifySnippets(report, path.join(workDir, "repo"));
      if (report._snippet_check.missed) {
        appendDegradedStep(report,
          `snippet 回查未命中源码强制降 unverified ${report._snippet_check.missed} 条：${report._snippet_check.notes.slice(0, 3).join("；")}${report._snippet_check.notes.length > 3 ? "…" : ""}`);
      }
      report._anchor_clamp = clampExaggerationAnchors(report);
      // 定级锚点重算（含 P0/P1 证据门：unverified 物理封顶 P2）；规则表可配置
      const { rules: sevRules, note: sevNote } = await loadSeverityRules(this.dataDir);
      applyAnchorSeverity(report, sevRules);
      if (sevNote) appendDegradedStep(report, sevNote);
      report._severity_rules = sevRules.map((r) => r.id).join(",");
      // 单轮 _usage 统一为 {bundles:[...]}，与分桶路径同形
      report._usage = { bundles: [report._usage || null] };
      // P0/P1 verifier 回路：独立会话复核证据链（fail-open）
      await this._runVerifier(report, settings, workDir, modelId, { repo: pr.repo, pr: pr.pr, title: pr.meta?.title });
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
      head: pr.meta?.head || null, // 审查时 head（列表按短 sha 区分同 PR 不同代码版本）
      model: modelId, thinking: thinkingLevel, fast_path: fastPath,
      // 保留模型返回的 previous_findings（fixed/still_exists 判定），供 applyRound 闭环使用；
      // 提示词里给出的快照另存字段，不覆盖模型输出
      previous_findings: report.review?.previous_findings || [],
      prompt_previous_findings: mode === "incremental" ? promptCtx.previousFindings : [],
      elapsed_ms: Date.now() - t0,
    };

    // ── 截断/降级声明：diff 截断与拉取降级如实声明（防静默漏审） ──
    const pushDegraded = (note) => { appendDegradedStep(report, note); };
    if (diffEmpty) {
      pushDegraded(`diff 无内容行（拉取退化或 PR 无变更）：本报告基于无 diff 的全仓检查，未做变更行级审查，结论不可作为发布依据`);
    }
    const maxDiffChars = Number.isInteger(settings.maxDiffChars) && settings.maxDiffChars > 0 ? settings.maxDiffChars : 400000;
    if ((pr.diff || "").length > maxDiffChars) {
      pushDegraded(`diff 超过 maxDiffChars（${(pr.diff || "").length}/${maxDiffChars}），提示词中被截断；完整 diff 已落盘工作区 PR.diff，仅当 agent 未主动 read 查看时存在漏审风险`);
    }
    // GitLab >10 页 diff 条目截断（meta.diff_truncated 由 pr-resolver 声明）
    if (pr.meta?.diff_truncated) {
      pushDegraded(pr.meta.diff_truncated);
    }
    // API 拉取失败走 git 兜底（resolveErrors 由 pr-resolver 收集）：声明降级与 base 语义差异
    if (Array.isArray(pr.resolveErrors) && pr.resolveErrors.length) {
      pushDegraded(`PR 拉取降级：${pr.resolveErrors.join("；")}（diff 来自 git 兜底，base 可能退化为 prhead~1，审查范围可能缩小）`);
    }

    // ── 7) 迭代闭环：入账 ──
    const roundNo = ledger.applyRound(report, { mode, model: modelId, thinking: thinkingLevel, head: pr.meta?.head, trigger: options.trigger || "manual" });
    await ledger.save();

    // 持久化报告
    const reportsDir = path.join(this.dataDir, "reports");
    await mkdir(reportsDir, { recursive: true });
    reportId = `${pr.repo.replace(/\//g, "_")}-${pr.pr}-r${roundNo}-${Date.now()}`;
    const reportFile = path.join(reportsDir, `${reportId}.json`);
    // 落盘前脱敏：提示注入可诱导 agent 读 data/settings.json 或 auth.json 并写进报告——
    // 凭证子串一律替换（确定性防线，不依赖 SDK read 的路径约束）。
    // 同样的脱敏作用于返回给调用方的内存对象（sync 模式 res.json 直接回传），防公开 API 分支绕过。
    // redact/secrets 已声明在 try 外（归档脱敏也用，见 finally）。
    const reportText = redact(JSON.stringify({ ...report, ledger_stats: ledger.stats() }, null, 2), secrets);
    await writeFile(reportFile, reportText);
    // 返回的 report 从已脱敏文本读回（内存对象与落盘一致；sync 响应不泄漏凭证）
    const redactedReport = JSON.parse(reportText);

    this.emit({ stage: "done", status: "ok", reportId, conclusion: redactedReport.conclusion, stats: ledger.stats() });
    // reportFile 是服务器磁盘绝对路径，不随返回值外发（异步模式本就不返回；本地工具用途有限，
    // 但与报告 ID防护同源的保守策略）：报告已落盘，详情走 GET /api/reports/:id
    return { reportId, report: redactedReport, ledger: ledger.stats() };
    } finally {
      // 清理临时工作区（报告已含全部证据；失败路径同样清理，避免 workspaces 磁盘泄漏）。
      // 审计快照保留：submit_review 落盘的 .cr-agent/report.json 先归档到 reports 目录旁
      //（工具通道物证 + 调试用；rename 移动而非拷贝，清不掉也不影响主流程）
      if (workDir) {
        try {
          const auditSrc = path.join(workDir, ".cr-agent");
          await mkdir(path.join(this.dataDir, "reports", "audit"), { recursive: true });
          // 归档前脱敏：两条通道的 report-bundle-N.json 落盘发生在主报告 redact 之前，
          // 提示注入诱导的凭证泄漏会原样进入 audit 归档——虽未被 API 暴露，仍按同一防线处理
          try {
            for (const name of await readdir(auditSrc).catch(() => [])) {
              if (!name.endsWith(".json")) continue;
              const auditFile = path.join(auditSrc, name);
              const raw = await readFile(auditFile, "utf8");
              const clean = redact(raw, secrets);
              if (clean !== raw) await writeFile(auditFile, clean);
            }
          } catch { /* 脱敏失败不阻断归档（归档物证优先），rename 照常 */ }
          await rename(auditSrc, path.join(this.dataDir, "reports", "audit", `${reportId || Date.now()}`)).catch(() => {});
        } catch { /* 归档失败不阻断清理 */ }
        rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
