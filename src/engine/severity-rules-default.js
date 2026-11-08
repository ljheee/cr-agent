/**
 * 定级锚点规则表——默认配置（声明式，可被 data/severity-rules.json 覆盖）
 *
 * 规则语义：按数组顺序求值，首中即定（first-match-wins）；一条都不中 → 兜底 P3。
 * 每条规则：
 *   id               规则编号（唯一，写入 finding._severity_rule 供审计）
 *   severity         "P0" | "P1" | "P2" | "P3" | "void"（void=作废剔除）
 *   escalation_clause 可选：命中时附到 finding._escalation_clause（升级条件说明）
 *   when             条件对象，全部满足才命中；省略的字段=不限制
 *     introduced_by  ["this-pr"]（本次引入）| ["pre-existing"]（存量）
 *     impact_radius  ["all-traffic","batch","single","none"] 子集（影响半径）
 *     impact_radius_not 排除上述枚举（契约路径要求 radius≠none：文档注解不匹配这类
 *                    无行为影响的问题不得拔高，#247 教训）
 *     trigger        ["certain","conditional","data-dependent"] 子集（触发确定性）
 *     trigger_not    排除上述枚举（如契约路径 P1-C2 用 trigger_not:["certain"]）
 *     evidence_level 精确匹配（["test-confirmed"] 等，用于测试确认/证伪/未验证门）
 *     evidence_min   证据下限（rank：test-confirmed 4 > code-confirmed 3 > unverified 2 > test-falsified 1）
 *     contract       true（要求契约破坏）| false（要求非契约）
 *     category_in    finding.category 落在给定一级/历史别名集合内（用于 P3 交付轴封顶等）
 *
 * 配置加载：workflow 每轮审查读 data/severity-rules.json——存在则校验后替换默认表，
 * 校验失败/文件损坏自动回退默认表并在报告 degraded_steps 留痕（不静默）。
 */

export const IMPACT_RADII = ["all-traffic", "batch", "single", "none"];
export const TRIGGERS = ["certain", "conditional", "data-dependent"];
export const EVIDENCE_LEVELS = ["test-confirmed", "test-falsified", "code-confirmed", "unverified"];
export const EVIDENCE_RANK = { "test-confirmed": 4, "code-confirmed": 3, unverified: 2, "test-falsified": 1 };
const SEVERITIES = ["P0", "P1", "P2", "P3", "void"];

export const DEFAULT_SEVERITY_RULES = [
  // 门0：测试证伪 → 作废（不进报告正文，degraded_steps 留痕）
  { id: "G0-falsified", severity: "void", when: { evidence_level: ["test-falsified"] } },

  // P0：全流量 + 必然触发 + 证据≥源码确认 + 本次引入
  { id: "P0-C1", severity: "P0", when: { introduced_by: ["this-pr"], impact_radius: ["all-traffic"], trigger: ["certain"], evidence_min: "code-confirmed" } },
  // P0：契约破坏 + 整批及以上 + 必然触发 + 证据≥源码确认 + 本次引入
  { id: "P0-C2", severity: "P0", when: { introduced_by: ["this-pr"], contract: true, impact_radius: ["all-traffic", "batch"], trigger: ["certain"], evidence_min: "code-confirmed" } },

  // 存量门（先于 P1）：存量且非契约 → 封顶 P2（坏契约的存量仍可走高）
  { id: "P2-C3-pre-existing-cap", severity: "P2", when: { introduced_by: ["pre-existing"], contract: false } },

  // P1：必然/有条件触发 × 全流量/整批 × 证据≥源码确认
  { id: "P1-C1", severity: "P1", when: { trigger: ["certain", "conditional"], impact_radius: ["all-traffic", "batch"], evidence_min: "code-confirmed" } },
  // P1：契约破坏（非必然触发）+ 影响半径非 none + 证据≥源码确认
  // radius≠none：文档注解不匹配（ir=none）无行为影响，不得走契约通道拔高（#247 教训）
  { id: "P1-C2", severity: "P1", when: { contract: true, impact_radius_not: ["none"], trigger_not: ["certain"], evidence_min: "code-confirmed" } },
  // P1：测试确认（有失败测试/复现步骤）且影响半径非 none
  { id: "P1-C3", severity: "P1", when: { evidence_level: ["test-confirmed"], impact_radius: ["all-traffic", "batch", "single"] } },

  // P3 交付轴卫生门（须早于 P2 地板规则）：delivery/历史卫生 category + 单点/无影响 → 封顶 P3
  // 避免「缺单测」被 P2-C4 抬成阻塞；全流量/整批仍可走上方 P0/P1
  { id: "P3-C3-delivery-cap", severity: "P3",
    when: { category_in: ["delivery", "maintainability", "test", "dependency", "architecture", "config"], impact_radius: ["single", "none"] } },

  // P2：数据依赖触发且影响半径非 none（CVSS「假设合理配置存在」→ 附升级条件）
  { id: "P2-C1", severity: "P2",
    escalation_clause: "若测试/线上观测证实该数据形态为常态且波及整批，应按 P1-C1 升级",
    when: { trigger: ["data-dependent"], impact_radius: ["all-traffic", "batch", "single"] } },
  // P2：证据门——unverified 封顶 P2（物理上到不了 P0/P1，消除「运气型升级」）
  { id: "P2-C2-unverified-cap", severity: "P2", when: { evidence_level: ["unverified"] } },
  // P2：本次引入 + 单请求级 + 必然/有条件触发 + 证据≥源码确认
  // （补门：此前会掉进 P3 兜底，低估「确定会坏但只伤单请求」的缺陷）
  { id: "P2-C4-single-confirmed", severity: "P2",
    escalation_clause: "若影响扩大到整批/全流量，应按 P1-C1 升级",
    when: { introduced_by: ["this-pr"], impact_radius: ["single"], trigger: ["certain", "conditional"], evidence_min: "code-confirmed" } },

  // P3：无行为影响（风格/卫生/文档）
  { id: "P3-C1", severity: "P3", when: { impact_radius: ["none"] } },
  // P3：兜底（无规则命中时）
  { id: "P3-C2-default", severity: "P3", when: {} },
];

/**
 * 校验自定义规则表：结构/枚举/唯一性全查，任何一处不合法抛错（调用方决定回退）。
 * 返回归一化后的规则数组（浅拷贝每条，防外部篡改默认表）。
 */
export function validateSeverityRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error("severity 规则表必须是非空数组");
  const seen = new Set();
  return rules.map((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error(`规则[${i}] 必须是对象`);
    if (typeof r.id !== "string" || !/^[\w-]{1,64}$/.test(r.id)) throw new Error(`规则[${i}].id 不合法: ${JSON.stringify(r.id)}`);
    if (seen.has(r.id)) throw new Error(`规则 id 重复: ${r.id}`);
    seen.add(r.id);
    if (!SEVERITIES.includes(r.severity)) throw new Error(`规则 ${r.id}.severity 必须是 ${SEVERITIES.join("/")}: ${r.severity}`);
    const w = r.when ?? {};
    if (typeof w !== "object" || Array.isArray(w)) throw new Error(`规则 ${r.id}.when 必须是对象`);
    const checkEnum = (key, allowed) => {
      if (w[key] === undefined) return;
      if (!Array.isArray(w[key]) || w[key].length === 0 || !w[key].every((v) => allowed.includes(v)))
        throw new Error(`规则 ${r.id}.when.${key} 必须是 ${allowed.join("|")} 的非空子集`);
    };
    checkEnum("introduced_by", ["this-pr", "pre-existing"]);
    checkEnum("impact_radius", IMPACT_RADII);
    checkEnum("impact_radius_not", IMPACT_RADII);
    checkEnum("trigger", TRIGGERS);
    checkEnum("trigger_not", TRIGGERS);
    checkEnum("evidence_level", EVIDENCE_LEVELS);
    if (w.evidence_min !== undefined && !EVIDENCE_LEVELS.includes(w.evidence_min))
      throw new Error(`规则 ${r.id}.when.evidence_min 必须是 ${EVIDENCE_LEVELS.join("|")}`);
    if (w.contract !== undefined && typeof w.contract !== "boolean")
      throw new Error(`规则 ${r.id}.when.contract 必须是布尔值`);
    if (w.category_in !== undefined) {
      if (!Array.isArray(w.category_in) || w.category_in.length === 0 || !w.category_in.every((v) => typeof v === "string" && v))
        throw new Error(`规则 ${r.id}.when.category_in 必须是非空字符串数组`);
    }
    const unknown = Object.keys(w).filter((k) => !["introduced_by", "impact_radius", "impact_radius_not", "trigger", "trigger_not", "evidence_level", "evidence_min", "contract", "category_in"].includes(k));
    if (unknown.length) throw new Error(`规则 ${r.id}.when 含未知条件字段: ${unknown.join(",")}`);
    if (r.escalation_clause !== undefined && typeof r.escalation_clause !== "string")
      throw new Error(`规则 ${r.id}.escalation_clause 必须是字符串`);
    return { ...r, when: { ...w } };
  });
}
