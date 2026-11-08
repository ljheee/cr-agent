/**
 * 定级锚点量化（severity anchoring）——业界实践落地
 *
 * 依据：CVSS v3.1（维度枚举 + 确定性推导）、OWASP Risk Rating（锚点选项 + 矩阵）、
 * CISA SSVC（布尔决策树）、SonarQube（severity 绑定规则而非逐案裁量）、
 * AWS CodeGuru（severity 与 confidence 正交）。
 *
 * 核心思想：LLM 只输出锚点枚举字段（impact_radius / trigger / evidence_level /
 * introduced_by / 契约破坏标志），severity 由规则表确定性推导——把漂移源从
 * 生成端（模型自由裁量）移到规则端（首中即定、可复核、可单测、可配置）。
 * 实测痛点：同 head 两轮审查，同一问题（证据逐字相同）定级 P3↔P1 漂移。
 *
 * 规则表可配置：默认表在 severity-rules-default.js；运行时用 data/severity-rules.json
 * 覆盖（workflow 每轮加载+校验，失败回退默认并留痕）——调阈值/加规则不用改代码。
 *
 * 约束：fix_cost/confidence 不参与定级（severity≠risk，CVSS 明文；confidence 只用于
 * 展示与 verifier 触发）。unverified 物理上到不了 P0/P1——证据门默认表内置。
 */

import { DEFAULT_SEVERITY_RULES, EVIDENCE_RANK, IMPACT_RADII, TRIGGERS } from "./severity-rules-default.js";
import { buildAuthorSummary } from "./report-schema.js";

// severity 字典序排名（不依赖 "P0"<"P1"<"P2"<"P3"<"void" 的字典序巧合）
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 锚点字段归一化（模型输出宽容收敛：未知值/缺省 → 保守档） */
export function normalizeAnchors(f) {
  const radius = IMPACT_RADII.includes(f.impact_radius) ? f.impact_radius : null;
  const trigger = TRIGGERS.includes(f.trigger) ? f.trigger : null;
  // 缺省推导：无法判半径 → single（保守）；无法判触发 → data-dependent（保守，P2 档）
  return {
    radius: radius || "single",
    trigger: trigger || "data-dependent",
    radiusKnown: radius !== null,
    triggerKnown: trigger !== null,
  };
}

/** 契约破坏判定：仅 category 显式契约维度才认。
 * 教训（#247 实测）：impact 文本含「契约关注面」措辞的单测建议（category=test）
 * 被关键词误伤判契约拔高定级——文本关键词不再单独触发。 */
function isContractBreak(f, report) {
  // 精确匹配一级轴 contract / 旧别名 api-contract / 中文「契约」
  if (/^(contract|api-contract|契约)$/.test(String(f.category || "").trim())) return true;
  const breaking = report?.impact?.breaking_changes;
  return Array.isArray(breaking) && breaking.some((b) => {
    const n = typeof b === "object" ? String(b.name || "") : String(b);
    return String(f.file || "").length > 0 && n.includes(String(f.file).split("/").pop());
  });
}

const hasEvidence = (f, min) => (EVIDENCE_RANK[f.evidence_level] || 0) >= EVIDENCE_RANK[min];

/** 单条规则是否命中（when 全部条件满足；省略=不限制） */
function ruleMatches(rule, f, a, isThisPr, contract) {
  const w = rule.when || {};
  if (w.introduced_by !== undefined && !w.introduced_by.includes(isThisPr ? "this-pr" : "pre-existing")) return false;
  if (w.impact_radius !== undefined && !w.impact_radius.includes(a.radius)) return false;
  if (w.impact_radius_not !== undefined && w.impact_radius_not.includes(a.radius)) return false;
  if (w.trigger !== undefined && !w.trigger.includes(a.trigger)) return false;
  if (w.trigger_not !== undefined && w.trigger_not.includes(a.trigger)) return false;
  if (w.evidence_level !== undefined && !w.evidence_level.includes(f.evidence_level)) return false;
  if (w.evidence_min !== undefined && !hasEvidence(f, w.evidence_min)) return false;
  if (w.contract !== undefined && contract !== w.contract) return false;
  if (w.category_in !== undefined) {
    const cat = String(f.category || "").trim();
    if (!w.category_in.includes(cat)) return false;
  }
  return true;
}

/**
 * 锚点 → severity 确定性推导（规则表按序求值，首中即定；全不中 → 兜底 P3）。
 * @param rules 可选：自定义规则表（已过 validateSeverityRules）；缺省用内置默认表
 * @returns {severity, rule} rule=命中的规则编号（如 "P1-C1"），审计可解释（SARIF 思路）
 */
export function deriveSeverity(f, report, rules = DEFAULT_SEVERITY_RULES) {
  const a = normalizeAnchors(f);
  const isThisPr = f.introduced_by !== "pre-existing";
  const contract = isContractBreak(f, report);
  for (const rule of rules) {
    if (ruleMatches(rule, f, a, isThisPr, contract)) {
      return { severity: rule.severity, rule: rule.id };
    }
  }
  return { severity: "P3", rule: "P3-fallback" };
}

/**
 * 聚合重算（导出复用）：blockers = P0/P1 集合；conclusion 双向重估；author_summary 重建。
 * applyAnchorSeverity 与 verifier 裁决应用后都必须走这里，保证聚合与 findings 一致。
 * @param tag 非空时在 one_line 追加重估注记（如「锚点重算」「复核」）
 */
export function recomputeReportAggregates(report, tag = null) {
  if (!report || !Array.isArray(report.findings)) return report;
  const highIds = report.findings.filter((f) => f.severity === "P0" || f.severity === "P1").map((f) => f.id);
  report.blockers = highIds;
  const high = highIds.length > 0;
  if (report.conclusion === "通过" && high) {
    report.conclusion = "不通过";
    if (tag) report.one_line = `${report.one_line || ""}（注：${tag}升出 P0/P1）`.slice(0, 200);
  } else if (report.conclusion === "不通过" && !high) {
    report.conclusion = "通过";
    if (tag) report.one_line = `${report.one_line || ""}（注：${tag}后无 P0/P1 阻塞项）`.slice(0, 200);
  }
  report.author_summary = buildAuthorSummary(report);
  return report;
}

/**
 * 对整份报告跑锚点定级（normalizeReport 之后调用）。
 * - 重写每条 finding 的 severity 为推导值，保留模型原值作 _model_severity（审计）
 * - 记录命中规则 _severity_rule（可解释）；规则带 escalation_clause 时附 _escalation_clause
 * - void 级 findings 移入 verification.degraded_steps（作废留痕）
 * - blockers 由 P0/P1 集合重算（与推导结果一致，杜绝悬挂引用）
 * @param rules 可选：自定义规则表；缺省用内置默认表
 */
export function applyAnchorSeverity(report, rules = DEFAULT_SEVERITY_RULES) {
  if (!Array.isArray(report.findings)) return report;
  const voided = [];
  const kept = [];
  const demotedOverrides = [];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const f of report.findings) {
    const { severity, rule } = deriveSeverity(f, report, rules);
    if (severity === "void") { voided.push(`${f.id || "?"} ${String(f.title || "").slice(0, 40)}`); continue; }
    // B2 语义澄清：程序化存量降档（demoted）后被锚点重写更高档时留痕，
    // 不静默覆盖（否则 pre_existing_demoted 标记与 severity 互相矛盾）
    if (f.pre_existing_demoted && severity !== "P3" && SEVERITY_RANK[severity] < SEVERITY_RANK[f.severity]) {
      demotedOverrides.push(`${f.id || "?"} 降档 ${f.severity} → 锚点 ${severity}（${rule}）`);
    }
    f._model_severity = f.severity;      // 模型原判（审计对照）
    f.severity = severity;
    f._severity_rule = rule;
    const clause = ruleById.get(rule)?.escalation_clause;
    if (clause) f._escalation_clause = clause;
    kept.push(f);
  }
  report.findings = kept;
  if (voided.length) {
    report.verification = report.verification || {};
    report.verification.degraded_steps = [...(report.verification.degraded_steps || []),
      `锚点规则作废 ${voided.length} 条（void 级，如 test-falsified 证伪）：${voided.slice(0, 3).join("；")}${voided.length > 3 ? "…" : ""}`];
  }
  if (demotedOverrides.length) {
    report.verification = report.verification || {};
    report.verification.degraded_steps = [...(report.verification.degraded_steps || []),
      `锚点重算覆盖程序化降档 ${demotedOverrides.length} 条：${demotedOverrides.slice(0, 3).join("；")}${demotedOverrides.length > 3 ? "…" : ""}`];
  }
  // 聚合重算（blockers/conclusion/author_summary）——与 verifier 裁决应用共用同一收敦函数
  recomputeReportAggregates(report, "锚点重算");
  return report;
}
