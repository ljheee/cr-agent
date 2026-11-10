/**
 * 结构化 CR 报告 schema
 *
 * 改良点：
 *  - findings 必带 evidence(file:line) + trace 引用 + confidence（新增：结论置信度）
 *  - callers 不设 40 上限（教训：42 个调用方装不下导致 upstream_interfaces 留空）
 *  - 新增 author_summary（作者摘要层：阻塞+必改，报告分层呈现）
 *  - 新增 verification（查证明细与失败升级建议：查不到就标 needs_human 而非每轮重试）
 *  - 新增 exempt（豁免清单：已接受风险的问题不再重复报）
 */
import { primaryPerspectiveId, DIMENSIONS } from "./perspectives.js";

export const REPORT_SCHEMA_VERSION = "cr-agent/1.0";

export const FINDING_SEVERITIES = ["P0", "P1", "P2", "P3"];

export const REVIEW_CONCLUSIONS = ["通过", "不通过"];

/** 证据四档分级：
 *  test-confirmed   测试确认（附失败测试/可复现验证）
 *  test-falsified   测试证伪（存在反例，问题不成立或降级）
 *  code-confirmed   源码追踪确认（写明为何不能构成测试）
 *  unverified       未验证（必须写明缺的具体条件）
 */
export const EVIDENCE_LEVELS = ["test-confirmed", "test-falsified", "code-confirmed", "unverified"];

/** 单条 finding 的规范结构 */
export function findingTemplate() {
  return {
    id: "F1",               // 本轮内稳定编号
    title: "",
    severity: "P2",          // P0-P3（模型初判；最终由 severity-anchors 按锚点重算）
    impact_radius: "single", // 锚点：all-traffic | batch | single | none
    trigger: "data-dependent", // 锚点：certain | conditional | data-dependent
    category: "",            // 一级视角轴 id（correctness|contract|data|security_fund|runtime|delivery）
    dimension: "correctness", // 与 category 对齐的一级轴（历史五维标签会在 normalize 时映射）
    file: "",
    line: null,
    code_snippet: "",
    evidence: "",            // 证据：引用 diff/源码/调用方数据，不编造
    impact: "",
    suggestion: "",          // 修复建议（必填）
    confidence: 0.8,         // 0-1，模型自评
    evidence_level: "unverified",  // 证据四档：test-confirmed | test-falsified | code-confirmed | unverified
    evidence_gap: "",        // unverified 时必填：缺什么具体条件才能验证
    trace_ids: [],           // 关联的跨仓查证编号
    introduced_by: "this-pr", // 是否本次引入（勿写 "a" | "b"：那是位或表达式，运行时变成数字 0）
    fix_effort: "small",
    exemptible: true,        // 是否可豁免（风格类 P3 默认可豁免）
  };
}

/** finding.line 数值化：跳过 null/空串；拒绝 0/负数（Number(null)===0 的陷阱） */
export function coerceFindingLine(line) {
  if (line == null || line === "") return null;
  const n = Number(line);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** 降一档严重级别（P0→P1→P2→P3） */
function demote(sev) {
  const i = FINDING_SEVERITIES.indexOf(sev);
  return i < 0 ? "P3" : FINDING_SEVERITIES[Math.min(i + 1, FINDING_SEVERITIES.length - 1)];
}

/**
 * 程序化 pre-existing 降档（在 markPreExisting 打完标记后由 workflow 调用，幂等）：
 * 程序判定的存量问题降一档（P0→P1 仍属阻塞档属预期——只降一档不双降）；
 * 不是不报，而是作者优先关注本次引入；规范类问题建议交 SCA/Lint。
 * 同步重建 blockers 与 author_summary（降档会改变分档）。
 */
export function applyProgrammaticDemotion(report) {
  let changed = false;
  for (const f of report.findings || []) {
    if (f.introduced_by === "pre-existing" && f.pre_existing_detected === "programmatic" && !f.pre_existing_demoted) {
      f.severity = demote(f.severity);
      f.pre_existing_demoted = true; // 幂等标记：eval 重 normalize 时不二次降档
      changed = true;
    }
  }
  if (changed) {
    report.blockers = report.findings.filter((f) => f.severity === "P0" || f.severity === "P1").map((f) => f.id);
    report.author_summary = buildAuthorSummary(report);
    // 结论重估：降档后若已无任何 P0/P1（含非存量的），"不通过" 与空 blockers/空必改自相矛盾。
    // 重估保守：仅当降档前是不通过且现在无 P0/P1 时升为通过，并在 one_line 注明降档事实
    if (report.conclusion === "不通过" && report.blockers.length === 0) {
      report.conclusion = "通过";
      report.one_line = `${report.one_line || ""}（注：存量问题已程序化降档，非阻塞项）`.slice(0, 200);
    }
  }
  return report;
}

/** 完整报告结构 */
export function reportTemplate() {
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    pr: { url: "", repo: "", number: null, title: "", author: "", head: "", base: "", files_changed: 0, additions: 0, deletions: 0 },
    review: {
      mode: "full|incremental",      // 全量/增量
      round: 1,
      trigger: "manual|push|webhook",
      model: "", thinking: "",
      previous_findings: [],          // 复审：历史问题闭环状态
    },
    conclusion: "通过|不通过",
    one_line: "",                     // 一句话摘要
    impact_summary: "",               // 影响摘要
    blockers: [],                     // 阻塞项 finding id 列表
    author_summary: {                 // 分层呈现：作者只需要看这个
      must_fix: [],                   // {id,title,severity,file:line,suggestion}
      should_fix: [],
      nice_to_have: [],
      release_note: "",
    },
    findings: [/* findingTemplate() */],
    changes: [/* {file, before_after, facts} */],
    impact: {
      upstream_interfaces: [],        // [{name, callers:[{app, qps}] 无上限}]
      downstream_interfaces: [],
      data_oracle_changes: [],
      breaking_changes: [],
    },
    decision_changes: [/* {trace_id, file, line, check_kind, decision, boundary_input, status, evidence} */],
    risks: [/* {risk, severity, mitigation} */],
    tests: [/* {scenario, priority, why} */],
    release_plan: {
      preconditions: [], monitoring: [], rollback: [],
    },
    verification: {
      traces: [/* {id, target, method, result: consistent|conflicting|unverified|needs_human, note} */],
      unverified_upgrades: [],        // 建议升级人工确认的项（对治"每轮重试失败查证"）
      degraded_steps: [],             // 降级声明：执行中发生降级的步骤（如索引不可用退化为 grep）
    },
    checked_paths: [],        // "无问题"结论时必填：已检查的路径/文件清单（防最贵误判）
    exempt: [/* {finding_id, reason, exempted_by, exempted_at} */],
    metrics: {
      perspectives_covered: [],       // 实际覆盖的视角 id
      perspectives_skipped: [],
      new_findings: 0, prev_fixed: 0, prev_still: 0,
    },
  };
}

/**
 * 转义 JSON 字符串字面量内的裸控制字符（<0x20）。
 * 仅在字符串内生效：字符串外的 \n/\t/\r 是合法 JSON 空白，保持原样。
 */
function escapeRawControlChars(s) {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (!inStr) {
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = false; out += c; continue; }
    if (code < 0x20) {
      out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * 轻量 JSON 修复（自实现，不引依赖）：救「差一点就合法」的模型输出。
 * 修复规则（按状态机单趟应用，只动确有缺陷的位置）：
 *  1. 截断补闭合：字符串/对象/数组未收尾时补齐缺失的 "、]、}
 *  2. 对象/数组元素间缺逗号：value 后紧跟 {、[、" 时补 ,
 *  3. 字符串内裸控制字符转义（复用 escapeRawControlChars 语义）
 *  4. 单引号字符串 → 双引号（仅字符串边界处，成对替换）
 *  5. 尾部多余逗号（, 后直接 } 或 ]）删除
 * 修不好（结构性垃圾）返回原文，让上层抛原错误。
 */
export function repairJson(s) {
  if (typeof s !== "string" || !s.trim()) return s;
  let out = "";
  const stack = [];   // 栈：'{' | '['（字符串上下文不入栈，用 inStr 单独标记——inStr 即当前字符串未闭合）
  let inStr = false, esc = false;
  const isWs = (c) => c === " " || c === "\t" || c === "\n" || c === "\r";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      const code = s.charCodeAt(i);
      if (code < 0x20) {  // 裸控制字符：转义
        out += c === "\n" ? "\\n" : c === "\r" ? "\\r" : c === "\t" ? "\\t" : "\\u" + code.toString(16).padStart(4, "0");
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "'" ) {  // 单引号字符串 → 双引号（只处理字符串开头处）
      // 找配对单引号（忽略转义 \'）
      let j = i + 1, s2 = "";
      for (; j < s.length; j++) {
        if (s[j] === "\\") { s2 += s[j] + (s[j + 1] || ""); j++; continue; }
        if (s[j] === "'") break;
        const ch = s[j];
        const code = s.charCodeAt(j);
        // 必须用 ch（=s[j]），勿用外层循环的 c（那是开头的单引号）
        if (code < 0x20) {
          s2 += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : "\\u" + code.toString(16).padStart(4, "0");
          continue;
        }
        s2 += ch;
      }
      if (j < s.length) {  // 找到配对：整段替换为双引号字符串
        out += '"' + s2 + '"';
        i = j;
        continue;
      }
      out += c;  // 无配对：原样（后续报错由截断补齐兜底）
      continue;
    }
    if (c === "{" || c === "[") { stack.push(c); out += c; continue; }
    if (c === "}" || c === "]") {
      // 尾部多余逗号：上一个输出字符是 , 且是收尾括号 → 删逗号
      if (out.endsWith(",")) out = out.slice(0, -1);
      stack.pop();
      out += c;
      continue;
    }
    if (c === ",") {
      // , 后直接收尾括号 → 跳过（尾逗号）
      if (next && (next === "}" || next === "]")) continue;
      out += c;
      continue;
    }
    // 缺逗号：value 结束后（经空白）紧跟新的 key/value 开头（" { [ '）→ 补逗号。
    // 触发条件：当前字符是空白（分隔位），prev 是 value 结尾字符，next 是字符串/对象开头
    if (isWs(c) && next && (next === '"' || next === "{" || next === "[" || next === "'")) {
      const prev = out.replace(/\s+$/, "").slice(-1);
      if (prev && /[}\]"0-9a-zA-Z]/.test(prev)) {
        out += ",";
        // 跳过后续连续空白（逗号已补，剩余空白由 JSON.parse 容忍）
        while (i + 1 < s.length && isWs(s[i + 1])) i++;
        continue;
      }
    }
    out += c;
  }
  // 截断补闭合：仍在字符串内先闭引号，再按栈逆序补齐括号。
  // 保守边界：中断点必须是干净的元素边界——光标停在大括号内但缺失 key/value（
  // 如 {"file":"a 后直接断）说明 value 或字段没写完，补出来的 finding 残缺（title/evidence 空），
  // 宁可报错走模型重试也不静默收下「半成品报告」。
  // 判定：out 尾部（去空白）若以 { 或 [ 或 : 或 , 结尾 → 中断在结构中段，不补闭合，返回原文报错
  const outTrim = out.replace(/\s+$/, "");
  const lastCh = outTrim.slice(-1);
  if (lastCh === "{" || lastCh === "[" || lastCh === ":" || lastCh === ",") return s;  // 结构中段硬截断：不救
  if (inStr && stack.length > 0) return s;  // 字符串内截断且位于对象/数组深处：字段写了一半，不救（顶层裸对象字符串截断除外——极罕见）
  let tail = "";
  if (inStr) tail += '"';
  for (let i = stack.length - 1; i >= 0; i--) {
    tail += stack[i] === "{" ? "}" : "]";
  }
  // 补闭合前清尾逗号
  const repaired = (out + tail).replace(/,\s*([}\]])/g, "$1");
  return repaired;
}

/**
 * 部分模型（尤其 tool-call 参数）会把嵌套对象/数组再次 JSON.stringify 成字符串，
 * 例如 review: "{\"mode\":\"full\"}"、tests: "[{...}]"。解一层后交给后续规范化。
 */
export function coerceStringifiedJsonFields(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const keys = [
    "review", "impact", "release_plan", "verification", "author_summary",
    "findings", "changes", "decision_changes", "risks", "tests", "blockers",
    "checked_paths", "perspectives_covered", "perspectives_skipped",
  ];
  const out = { ...raw };
  for (const k of keys) {
    const v = out[k];
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || (t[0] !== "{" && t[0] !== "[")) continue;
    try { out[k] = JSON.parse(t); } catch { /* 保持原字符串，后续逻辑兜底 */ }
  }
  return out;
}

/** 字符串数组字段：拒绝字符串展开成字符；非数组标量包一层 */
export function asStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => (x == null ? "" : String(x))).filter((s) => s.length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

/** introduced_by 归一：仅认 this-pr / pre-existing；非法值按存量封顶（保守） */
export function coerceIntroducedBy(v) {
  if (v === "this-pr" || v === "pre-existing") return v;
  if (v == null || v === "") return "this-pr";
  return "pre-existing";
}

function coerceReviewObject(v) {
  const base = reportTemplate().review;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...base };
  return {
    ...base,
    ...v,
    previous_findings: Array.isArray(v.previous_findings) ? v.previous_findings : [],
  };
}

function coerceReleasePlanObject(v) {
  const base = reportTemplate().release_plan;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...base };
  return {
    preconditions: asStringArray(v.preconditions),
    monitoring: asStringArray(v.monitoring),
    rollback: asStringArray(v.rollback),
  };
}

function coerceVerificationObject(v) {
  const base = reportTemplate().verification;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...base };
  return {
    ...base,
    ...v,
    traces: Array.isArray(v.traces) ? v.traces : [],
    unverified_upgrades: asStringArray(v.unverified_upgrades),
    degraded_steps: asStringArray(v.degraded_steps),
  };
}

/** 向 verification.degraded_steps 追加说明（保证数组形状，防字符串展开） */
export function appendDegradedStep(report, msg) {
  if (!report || !msg) return report;
  report.verification = coerceVerificationObject(report.verification);
  report.verification.degraded_steps = [...report.verification.degraded_steps, String(msg)];
  return report;
}

/** 校验 + 规范化模型返回的 JSON（宽容解析） */
export function normalizeReport(raw) {
  if (typeof raw === "string") {
    // 剥离可能的 markdown 代码块包裹：仅当整体以 ``` 开头时才剥（取首块）。
    // 若 JSON 本体后追加了尾部代码块（模型补充材料），不能让正则抢匹配尾块导致丢主体
    if (raw.trimStart().startsWith("```")) {
      const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) raw = m[1];
    }
    raw = raw.trim();
    // 截取首个 { 到第一个括号平衡闭合的 }（字符串感知扫描）：模型常在 JSON 本体后追加解释文字，
    // 尾巴里可能再含 } 或第二个代码块，lastIndexOf("}") 会把尾巴圈进来 →
    // "Unexpected non-whitespace character after JSON" 整单报废
    const s = raw.indexOf("{");
    if (s >= 0) {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = s; i < raw.length; i++) {
        const ch = raw[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === "\\") esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > s) raw = raw.slice(s, end + 1);
    }
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      if (!/Bad control character|Bad escaped character|Unterminated string/.test(err.message)) {
        // ④ jsonrepair 兜底（链末最后一档）：模型输出常见的尾部/局部缺陷——
        // 截断（缺闭合）、缺逗号、裸控制字符、字符串内裸引号——轻量状态机修复后重试，
        // 修复档只救「差一点就合法」的输出，不救结构性垃圾（修不好照旧抛错）
        try { raw = JSON.parse(repairJson(raw)); }
        catch { throw err; }
      } else {
        // 模型在 evidence 中原样引用 diff 行时常夹带未转义控制字符（裸 \n/\t 等），
        // 导致整个报告解析失败且重试也难纠正：解析失败时按状态机仅转义字符串字面量内的裸控制字符后重试
        try { raw = JSON.parse(escapeRawControlChars(raw)); }
        catch { try { raw = JSON.parse(repairJson(raw)); } catch { throw err; } }
      }
    }
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("模型报告不是合法 JSON 对象");
  }
  raw = coerceStringifiedJsonFields(raw);
  const report = { ...reportTemplate(), ...raw };
  report.schema_version = REPORT_SCHEMA_VERSION;
  // 形状兜底必须在任何 [...x]/join 之前：模型常把 review/release_plan/verification 吐成字符串
  report.review = coerceReviewObject(report.review);
  report.release_plan = coerceReleasePlanObject(report.release_plan);
  report.verification = coerceVerificationObject(report.verification);
  // 先规范化 findings（结论兜底依赖它；模型返回非数组时不能先 .some）
  const findings = Array.isArray(report.findings) ? report.findings : [];
  if (!REVIEW_CONCLUSIONS.includes(report.conclusion)) {
    // 兜底方向：宁严勿松——空串/无法识别时，若存在 P0/P1 或原文含失败语义则不通过；
    // 其余非法值（措辞漂移如「有条件通过」「无法通过」）一律归为「不通过」而非「通过」，
    // 避免静默放行（「无法通过」不含「不通过」子串，旧正则会误判为通过）
    const hasBlocker = findings.some((f) => f.severity === "P0" || f.severity === "P1");
    const passish = /^(?:通过|pass|approve|approved|ok|lgtm|✅)$/i.test(String(report.conclusion || "").trim());
    report.conclusion = (hasBlocker || !passish) ? "不通过" : "通过";
  }
  report.findings = findings.map((f, i) => {
    const cat = primaryPerspectiveId(f.category) || primaryPerspectiveId(f.dimension) || "";
    const dim = DIMENSIONS.includes(cat) ? cat : (DIMENSIONS.includes(f.dimension) ? f.dimension : (cat || "correctness"));
    return {
      ...findingTemplate(),
      ...f,
      id: f.id || `F${i + 1}`,
      severity: FINDING_SEVERITIES.includes(f.severity) ? f.severity : "P2",
      category: cat || String(f.category || ""),
      dimension: dim,
      confidence: typeof f.confidence === "number" ? Math.max(0, Math.min(1, f.confidence)) : 0.7,
      evidence_level: EVIDENCE_LEVELS.includes(f.evidence_level) ? f.evidence_level : "unverified",
      introduced_by: coerceIntroducedBy(f.introduced_by),
    };
  });
  // 修复档防线：repairJson 救活的截断报告可能带残缺 finding（缺 title——
  // findings 数组中途截断后被补闭合）。无标题条目没有审查价值且无法呈现，
  // 丢弃并记录降级声明；evidence 缺失不丢（模型本可省略，有默认值语义）
  const dropped = report.findings.filter((f) => !String(f.title || "").trim());
  if (dropped.length) {
    report.findings = report.findings.filter((f) => String(f.title || "").trim());
    appendDegradedStep(report, `丢弃 ${dropped.length} 条残缺 finding（截断修复产物，缺 title/evidence）`);
    // 同步 blockers（被丢的 id 不应残留）
    const kept = new Set(report.findings.map((f) => f.id));
    report.blockers = (Array.isArray(report.blockers) ? report.blockers : []).filter((b) => kept.has(b));
  }
  // 测试证伪的 finding 降级（实测：117 疑似 → 3 条被证伪）：无论原级别一律降 P3，防 P2 保持原级的语义倒挂。
  // 注意：程序化 pre-existing 降档不在此处（normalize 先于 markPreExisting 执行，此处降不到）——
  // 见 applyProgrammaticDemotion（workflow 在打标记后调用）
  let falsified = false;
  for (const f of report.findings) {
    if (f.evidence_level === "test-falsified") { f.severity = "P3"; falsified = true; }
  }
  // 证伪降级后同步重估：模型自带 blockers 可能含已降为 P3 的 id；
  // 若降后无任何 P0/P1，"不通过"与空阻塞自相矛盾（与 applyProgrammaticDemotion 同款保守重估）
  if (falsified) {
    // 先剔除指向不存在 id 的旧阻塞项，再按降级后的 P0/P1 重建（保持 blockers ⊆ findings 且与严重级一致）
    const validIds = new Set(report.findings.map((f) => f.id));
    report.blockers = report.findings.filter((f) => (f.severity === "P0" || f.severity === "P1") && validIds.has(f.id)).map((f) => f.id);
    if (report.conclusion === "不通过" && report.blockers.length === 0) {
      report.conclusion = "通过";
      report.one_line = `${report.one_line || ""}（注：疑似问题被测试证伪，无阻塞项）`.slice(0, 200);
    }
  }
  // 规则 10 程序化兑底：结论为通过且无发现但 checked_paths 为空 → 视为未检查，降级声明
  if (report.conclusion === "通过" && report.findings.length === 0 && !(Array.isArray(report.checked_paths) && report.checked_paths.length)) {
    appendDegradedStep(report, "结论为通过且无发现，但未提供 checked_paths（规则 10：空清单视为未检查，建议人工确认覆盖范围）");
  }
  // blockers 校验：模型提供的非空清单必须是合法 finding id 子集，否则重建（防垃圾 id / 漏 P0）
  const validIds = new Set(report.findings.map((f) => f.id));
  report.blockers = (Array.isArray(report.blockers) ? report.blockers : []).filter((b) => validIds.has(b));
  if (report.blockers.length === 0) {
    report.blockers = report.findings.filter((f) => f.severity === "P0" || f.severity === "P1").map((f) => f.id);
  }
  // 再归一一次 verification（上面 append 已保证；此处兜底 traces 等）
  report.verification = coerceVerificationObject(report.verification);

  // author_summary 兜底生成
  if (!raw.author_summary) {
    report.author_summary = buildAuthorSummary(report);
  }
  // 视角覆盖：优先用模型顶层声明的 perspectives_covered/skipped（更真实），
  // 缺失时才用 findings.category 派生（只按有 finding 的视角算会低估覆盖）
  const declaredCovered = Array.isArray(raw.perspectives_covered) ? raw.perspectives_covered : null;
  // 兼容模型误传 {id,reason} 对象：压成 "id: reason" 字符串（与 submit_review 工具侧一致）
  const declaredSkipped = Array.isArray(raw.perspectives_skipped)
    ? raw.perspectives_skipped.map((x) => {
        if (typeof x === "string") return x;
        if (x && typeof x === "object") {
          const id = x.id ?? x.perspective ?? "";
          const reason = x.reason ?? "";
          if (id && reason) return `${id}: ${reason}`;
          if (id) return String(id);
          if (reason) return String(reason);
        }
        return x == null ? "" : String(x);
      }).filter((s) => s.length > 0)
    : null;
  // 防护：模型返回非数组真值（如 "none"）不 crash（findings/checked_paths 同款兜底）；
  // applyRound/mergeReports 都依赖它可 filter
  const prevFindingsArr = Array.isArray(report.review.previous_findings) ? report.review.previous_findings : [];
  report.review.previous_findings = prevFindingsArr;
  report.metrics = {
    perspectives_covered: (declaredCovered ?? [...new Set(report.findings.map((f) => f.category).filter(Boolean))])
      .map((id) => primaryPerspectiveId(id) || id)
      .filter(Boolean),
    perspectives_skipped: declaredSkipped ?? [],
    new_findings: report.findings.length,
    prev_fixed: prevFindingsArr.filter((p) => p.status === "fixed").length,
    prev_still: prevFindingsArr.filter((p) => p.status === "still_exists").length,
  };
  // 模型的 raw.metrics 只取白名单数值字段，防止垃圾值/非数组覆盖上面的计算结果
  if (raw.metrics && typeof raw.metrics === "object") {
    for (const k of ["agent_turns", "tool_calls", "files_examined", "evidence_gathered"]) {
      if (typeof raw.metrics[k] === "number") report.metrics[k] = raw.metrics[k];
    }
  }
  return report;
}

export function buildAuthorSummary(report) {
  const must = report.findings.filter((f) => f.severity === "P0" || f.severity === "P1");
  const should = report.findings.filter((f) => f.severity === "P2");
  const nice = report.findings.filter((f) => f.severity === "P3");
  const fmt = (f) => ({ id: f.id, title: f.title, severity: f.severity, where: `${f.file}${f.line ? ":" + f.line : ""}`, suggestion: f.suggestion });
  return {
    must_fix: must.map(fmt),
    should_fix: should.map(fmt),
    nice_to_have: nice.map(fmt),
    release_note: (() => {
      const rp = coerceReleasePlanObject(report.release_plan);
      return [rp.preconditions.join("；"), rp.rollback.join("；")].filter(Boolean).join(" | ");
    })(),
  };
}

/**
 * 分桶子报告的确定性合并（吸收 ocr 分治拓扑：每桶一个 sub-agent，合并纯程序化非模型）。
 * @param {Array<object>} subReports 各桶的 normalizeReport 产物
 * @param {object} meta { bundles: [{files, findings}] 分桶元数据 }
 * @param {function} dedupeFn 跨桶去重函数（bundler.dedupeFindings），可注入便于测试
 */
export function mergeReports(subReports, meta = {}, dedupeFn = null) {
  // 允许空洞（fail-soft：某桶失败时槽位为 null）——只合并成功桶；全空则抛错
  const present = subReports.filter((r) => r && typeof r === "object");
  if (!present.length) throw new Error("mergeReports: 子报告为空");
  const first = present[0];
  let fid = 0;
  const findings = [];
  for (const [bi, r] of subReports.entries()) {
    if (!r) continue;
    for (const f of r.findings || []) {
      findings.push({ ...f, id: `F${++fid}`, bundle: bi + 1 });
    }
  }
  const deduped = dedupeFn ? dedupeFn(findings) : findings;
  const conclusion = present.some((r) => r.conclusion === "不通过") ? "不通过" : "通过";
  const failedNotes = (meta.bundleErrors || []).map((e) =>
    `分桶 ${e.idx} 失败未计入合并：${String(e.error || "").slice(0, 160)}`);
  const merged = {
    ...reportTemplate(),
    schema_version: REPORT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    pr: first.pr,
    review: { ...(first.review || {}) },
    conclusion,
    one_line: present.map((r) => r.one_line).filter(Boolean).join("；").slice(0, 300) || "",
    impact_summary: present.map((r) => r.impact_summary).filter(Boolean).join("\n").slice(0, 2000),
    findings: deduped,
    blockers: deduped.filter((f) => f.severity === "P0" || f.severity === "P1").map((f) => f.id),
    author_summary: null, // 下方重建
    // 数组型字段直接拼接（changes/risks/tests/decision_changes 等）
    changes: present.flatMap((r) => r.changes || []),
    impact: {
      upstream_interfaces: present.flatMap((r) => r.impact?.upstream_interfaces || []),
      downstream_interfaces: present.flatMap((r) => r.impact?.downstream_interfaces || []),
      data_oracle_changes: present.flatMap((r) => r.impact?.data_oracle_changes || []),
      breaking_changes: present.flatMap((r) => r.impact?.breaking_changes || []),
    },
    decision_changes: subReports.flatMap((r, i) =>
      (!r ? [] : (r.decision_changes || [])).map((dc) => ({ ...dc, trace_id: dc.trace_id ? `B${i + 1}-${dc.trace_id}` : dc.trace_id }))),
    risks: present.flatMap((r) => r.risks || []),
    tests: present.flatMap((r) => r.tests || []),
    release_plan: {
      preconditions: [...new Set(present.flatMap((r) => asStringArray(r.release_plan?.preconditions)))],
      monitoring: [...new Set(present.flatMap((r) => asStringArray(r.release_plan?.monitoring)))],
      rollback: [...new Set(present.flatMap((r) => asStringArray(r.release_plan?.rollback)))],
    },
    verification: {
      traces: subReports.flatMap((r, i) =>
        (!r ? [] : (Array.isArray(r.verification?.traces) ? r.verification.traces : [])).map((t) => ({ ...t, id: t.id ? `B${i + 1}-${t.id}` : t.id }))),
      unverified_upgrades: present.flatMap((r) => asStringArray(r.verification?.unverified_upgrades)),
      degraded_steps: [
        ...present.flatMap((r) => asStringArray(r.verification?.degraded_steps)),
        ...failedNotes,
      ],
    },
    checked_paths: [...new Set(present.flatMap((r) => asStringArray(r.checked_paths)))],
    metrics: {
      perspectives_covered: [...new Set(present.flatMap((r) => asStringArray(r.metrics?.perspectives_covered)))],
      perspectives_skipped: [...new Set(present.flatMap((r) => asStringArray(r.metrics?.perspectives_skipped)))],
      new_findings: deduped.length,
      prev_fixed: present.reduce((s, r) => s + (r.metrics?.prev_fixed || 0), 0),
      prev_still: present.reduce((s, r) => s + (r.metrics?.prev_still || 0), 0),
      bundles: meta.bundles?.length || subReports.length,
      bundles_ok: present.length,
      bundles_failed: (meta.bundleErrors || []).length,
    },
    review_bundles: (meta.bundles || []).map((b, i) => ({
      ...b,
      submitted: subReports[i]?._submitted === true,
      failed: !subReports[i],
      error: (meta.bundleErrors || []).find((e) => e.idx === i + 1)?.error || null,
    })),
  };
  merged.author_summary = buildAuthorSummary(merged);
  return merged;
}
