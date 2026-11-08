/**
 * P0/P1 独立验证会话（verifier 回路）——把「自报证据」升级为「对抗复核证据」
 *
 * 锚点定级后，P0/P1 属高风险结论：单凭 worker 自报的 evidence_level/锚点即可定级，
 * 谎报/幻觉会直通门禁。本模块对推导出的 P0/P1 findings 起一个**独立** pi 会话
 * （独立端点/密钥/模型可配，未配置兜底 worker 默认模型），专职复核证据链：
 * 读源码核对 finding.file:line、snippet、evidence 是否真实支持该定级。
 *
 * 裁决三值：confirmed（维持）/ downgrade（降 P2，程序化应用）/ void（证伪剔除）。
 * fail-open：verifier 会话失败不阻断主报告（锚点证据门仍在），degraded_steps 留痕。
 *
 * 会话隔离：独立 agentDir（pi-home-verifier）——全局多 PR 并行时与 worker 的
 * pi-home models.json/auth.json 互不污染（不同 baseUrl/apiKey）。
 */

import { mkdir, writeFile, symlink, lstat, unlink } from "node:fs/promises";
import path from "node:path";
import { runCrTurn, REVIEW_TOOLS } from "./pi-runner.js";

export const VERIFIER_SYSTEM_PROMPT = `你是独立的代码审查证据复核员（verifier）。给你一批已被初审定级为 P0/P1 的问题，你的唯一任务是逐条核实证据链是否真实、是否足以支撑该定级：
1. 用 read/grep 工具打开 finding 指向的源文件与行号，核对 code_snippet 是否真实存在、上下文是否被断章取义；
2. 核对 evidence 描述的行为是否真的会发生（触发条件、影响半径是否夸大）；
3. 只依据源码证据裁决，不看初审判级的高低表态。
仓库源码在工作目录下的 repo/ 符号链接内（已建好，直接 read/grep repo/<finding.file> 即可）。
每条裁决输出三值之一：confirmed（证据真实且支持定级）/ downgrade（问题存在但定级夸大，或证据不足以支撑 P0/P1）/ void（问题不存在或证据与源码明显不符）。
全部复核完成后，输出且只输出一个 JSON 对象（不要其它文字）：
{"verdicts":[{"id":"<finding id>","verdict":"confirmed|downgrade|void","reason":"<一句话源码依据>"}]}
每条 finding 都必须给出裁决；不确定时倾向 downgrade（宁降不纵）。`;

/**
 * 确保 verifier 会话 cwd 内可见源码树：在 .verifier/ 里建 repo → ../repo 符号链接。
 * 抽成导出函数可单测（修复：verifier cwd 是 .verifier，无此链接时提示词指向的
 * repo/ 解析为 .verifier/repo/ 不存在 → 模型读不到源码只能盲裁）。
 */
export async function ensureVerifierRepoLink(workDir) {
  const vWorkDir = path.join(workDir, ".verifier");
  await mkdir(vWorkDir, { recursive: true });
  const link = path.join(vWorkDir, "repo");
  try {
    await symlink(path.join("..", "repo"), link);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    // EEXIST 时校验现存目标确实是符号链接（防跨轮残留普通文件/错误链接导致链接失效）
    try {
      const st = await lstat(link);
      if (!st.isSymbolicLink()) { await unlink(link); await symlink(path.join("..", "repo"), link); }
    } catch { /* lstat 失败保守跳过：下次会话重建 */ }
  }
  return link;
}

/** 构建 verifier 用户提示词（紧凑逐条列出证据链，纯函数可单测） */
export function buildVerifierUserPrompt(findings, prMeta = {}) {
  const lines = findings.map((f) => [
    `### ${f.id}（初审定级 ${f.severity}，证据档 ${f.evidence_level || "unverified"}）`,
    `标题：${f.title || ""}`,
    `位置：${f.file || "?"}${f.line ? `:${f.line}` : ""}`,
    `锚点：impact_radius=${f.impact_radius || "?"} trigger=${f.trigger || "?"} introduced_by=${f.introduced_by || "?"}`,
    f.code_snippet ? `代码片段：\n\`\`\`\n${String(f.code_snippet).slice(0, 600)}\n\`\`\`` : "代码片段：（无）",
    `证据：${String(f.evidence || "").slice(0, 500)}`,
    f.impact ? `影响：${String(f.impact).slice(0, 300)}` : "",
  ].filter(Boolean).join("\n"));
  return [
    `待复核问题（${findings.length} 条）：仓库源码在工作目录 repo/ 下，PR：${prMeta.repo || "?"}#${prMeta.pr || "?"}${prMeta.title ? `（${prMeta.title}）` : ""}。`,
    "",
    ...lines,
    "",
    "逐条复核后输出裁决 JSON（格式见系统指令）。",
  ].join("\n");
}

/** 从模型文本提取首个括号平衡 JSON 对象（字符串感知；无则 null） */
export function extractJson(text) {
  const s = String(text || "").indexOf("{");
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { try { return JSON.parse(text.slice(s, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * 程序化应用裁决（原地改 report.findings）：
 * downgrade → P0/P1 降 P2；void → 剔除；confirmed/未知 id/非法 verdict → 保守不动。
 * 返回统计，聚合重算由调用方 recomputeReportAggregates 统一做。
 */
export function applyVerifierVerdicts(report, verdicts) {
  const res = { total: Array.isArray(verdicts) ? verdicts.length : 0, confirmed: 0, downgraded: [], voided: [], maintained: 0, unknown: 0, invalid: 0 };
  if (!Array.isArray(verdicts) || !Array.isArray(report.findings)) return res;
  for (const v of verdicts) {
    if (!v || typeof v !== "object") { res.invalid++; continue; }
    const verdict = String(v.verdict || "").toLowerCase();
    if (!["confirmed", "downgrade", "void"].includes(verdict)) { res.invalid++; continue; }
    if (typeof v.id !== "string" || !v.id) { res.invalid++; continue; }   // 防缺 id 时 undefined===undefined 误命中
    const f = report.findings.find((x) => x && x.id === v.id);
    if (!f) { res.unknown++; continue; }
    const reason = String(v.reason || "").slice(0, 200);
    if (verdict === "confirmed") {
      res.confirmed++;
      f._verifier = { verdict, reason };
    } else if (verdict === "downgrade") {
      if (f.severity === "P0" || f.severity === "P1") {
        res.downgraded.push(`${f.id} ${f.severity}→P2`);
        f.severity = "P2";
        f._verifier = { verdict, reason };
      } else { res.maintained++; f._verifier = { verdict: "confirmed", reason: "复核降级请求但已低于 P1，维持" }; }
    } else {
      res.voided.push(`${f.id} ${String(f.title || "").slice(0, 30)}`);
      f._verifier = { verdict, reason };
    }
  }
  // void 剔除（留痕由调用方写入 degraded_steps）
  // void 剔除：仅从已通过 id 类型校验的 verdict 收集（防数字/缺失 id 绕过校验静默剔除）
  const voidIds = new Set(verdicts
    .filter((v) => v && typeof v === "object" && typeof v.id === "string" && v.id && String(v.verdict || "").toLowerCase() === "void")
    .map((v) => v.id));
  if (voidIds.size) report.findings = report.findings.filter((f) => !voidIds.has(f.id));
  return res;
}

/**
 * 跑 verifier 会话：独立 agentDir（不与 worker 的 pi-home 互踩）+ 可配端点/密钥/模型。
 * @returns verdicts 数组（解析失败/会话失败抛错，由调用方 fail-open 留痕）
 */
export async function runVerifierSession({ settings, dataDir, workDir, findings, workerModelId, prMeta = {}, emit }) {
  // 兜底链：verifier 专属模型 → worker 默认模型；端点/密钥未设置 → worker 同款
  const vModel = settings.verifierModel || workerModelId;
  const vSettings = { ...settings };
  if (settings.verifierBaseUrl) vSettings.baseUrl = settings.verifierBaseUrl;
  if (settings.verifierApiKey) vSettings.apiKey = settings.verifierApiKey;
  // verifier 专属模型可能不在 worker 的模型列表：注入 models.json 保证可解析（其余列表保留）
  const list = (settings.models || []).map((m) => m.id || m);
  if (vModel && !list.includes(vModel)) {
    vSettings.models = [...(settings.models || []), { id: vModel, name: vModel, reasoning: true }];
  }

  await ensureVerifierRepoLink(workDir);   // P0 修复：cwd 内可见源码树
  const vWorkDir = path.join(workDir, ".verifier");
  const { text, usage } = await runCrTurn({
    settings: vSettings, dataDir, workDir: vWorkDir,
    agentDirSub: "verifier",            // 独立 pi-home：多 PR 并行时不污染 worker 的 models/auth
    tools: REVIEW_TOOLS,                // 只读核查：读源码即可，无 submit_review（文本 JSON 交付）
    systemPrompt: VERIFIER_SYSTEM_PROMPT,
    userPrompt: buildVerifierUserPrompt(findings, prMeta),
    model: vModel,
    thinkingLevel: "medium",            // 复核任务固定中档推理（省成本）
    timeoutMs: 20 * 60 * 1000,
    onEvent: (e) => { if (emit) emit(e); },
  });
  const parsed = extractJson(text);
  const verdicts = parsed?.verdicts;
  if (!Array.isArray(verdicts)) throw new Error(`verifier 输出不可解析（无 verdicts 数组）：${String(text || "").slice(0, 200)}`);
  return { verdicts, usage, model: vModel };
}
