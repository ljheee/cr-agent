/**
 * submit_review 结构化交付工具（报告文件通道 + 源头约束）
 *
 * 三层设计（对治「LLM 自由文本输出 → 事后解析」链路的解析失败）：
 *  1. 源头约束：constrainedSampling json_schema strict——端点支持时参数在解码层
 *     受语法约束（裸引号/未闭合括号物理上生成不出来）；不支持时 SDK 自动降级为普通
 *     tool call（strict:"prefer"），仍走 schema 校验。
 *  2. 文件通道：模型调用本工具提交报告 → 参数直接是对象（无字符串解析环节）→
 *     落盘 report.json，workflow 优先读文件，文本输出降级为兜底。
 *  3. 早停：AgentToolResult.terminate:true——工具成功返回后 agent 循环即停，
 *     模型不再生成总结尾巴（省 token + 消灭尾部污染源）。
 *
 * schema 有意放宽（与 normalizeReport 的宽容解析对齐）：枚举/数值交给下游归一化，
 * 只硬约束「形状」（对象/数组/字符串），避免 strict 模式因长尾字段细节拒绝合法报告。
 */
import { Type } from "typebox";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { coerceStringifiedJsonFields } from "./report-schema.js";

/** submit_review 的参数 schema（strict 兼容子集：无 anyOf 嵌套对象、required=全部键） */
export function buildSubmitReviewSchema() {
  const Finding = Type.Object({
    id: Type.String(),
    title: Type.String(),
    severity: Type.String(),
    impact_radius: Type.Optional(Type.Union([Type.Literal("all-traffic"), Type.Literal("batch"), Type.Literal("single"), Type.Literal("none")])),
    trigger: Type.Optional(Type.Union([Type.Literal("certain"), Type.Literal("conditional"), Type.Literal("data-dependent")])),
    category: Type.Optional(Type.String()),
    dimension: Type.Optional(Type.String()),
    file: Type.String(),
    line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    code_snippet: Type.Optional(Type.String()),
    evidence: Type.String(),
    impact: Type.Optional(Type.String()),
    suggestion: Type.String(),
    confidence: Type.Optional(Type.Number()),
    evidence_level: Type.Optional(Type.String()),
    evidence_gap: Type.Optional(Type.String()),
    trace_ids: Type.Optional(Type.Array(Type.String())),
    introduced_by: Type.Optional(Type.String()),
    fix_effort: Type.Optional(Type.String()),
    exemptible: Type.Optional(Type.Boolean()),
  });
  return Type.Object({
    conclusion: Type.String(),
    one_line: Type.String(),
    impact_summary: Type.Optional(Type.String()),
    blockers: Type.Optional(Type.Array(Type.String())),
    findings: Type.Array(Finding),
    changes: Type.Optional(Type.Array(Type.Object({
      file: Type.String(),
      before_after: Type.Optional(Type.String()),
      facts: Type.Optional(Type.String()),
    }))),
    impact: Type.Optional(Type.Object({
      upstream_interfaces: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
      downstream_interfaces: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
      data_oracle_changes: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
      breaking_changes: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
    })),
    decision_changes: Type.Optional(Type.Array(Type.Object({
      trace_id: Type.String(),
      file: Type.String(),
      line: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
      check_kind: Type.Optional(Type.String()),
      decision: Type.Optional(Type.String()),
      boundary_input: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      evidence: Type.Optional(Type.String()),
    }))),
    risks: Type.Optional(Type.Array(Type.Object({
      risk: Type.String(),
      severity: Type.Optional(Type.String()),
      mitigation: Type.Optional(Type.String()),
    }))),
    tests: Type.Optional(Type.Array(Type.Object({
      scenario: Type.String(),
      priority: Type.Optional(Type.String()),
      why: Type.Optional(Type.String()),
    }))),
    release_plan: Type.Optional(Type.Object({
      preconditions: Type.Optional(Type.Array(Type.String())),
      monitoring: Type.Optional(Type.Array(Type.String())),
      rollback: Type.Optional(Type.Array(Type.String())),
    })),
    verification: Type.Optional(Type.Object({
      traces: Type.Optional(Type.Array(Type.Object({}))),
      unverified_upgrades: Type.Optional(Type.Array(Type.String())),
      degraded_steps: Type.Optional(Type.Array(Type.String())),
    })),
    checked_paths: Type.Optional(Type.Array(Type.String())),
    perspectives_covered: Type.Optional(Type.Array(Type.String())),
    // 元素放宽为 Any：提示词曾误导为 {id,reason} 对象；execute 内统一压成字符串，避免工具校验拒收后模型改吐中文
    perspectives_skipped: Type.Optional(Type.Array(Type.Any())),
  });
}

/** perspectives_skipped 统一为字符串（兼容 "id" / "id: reason" / {id,reason}） */
export function normalizePerspectivesSkipped(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => {
    if (typeof x === "string") return x;
    if (x && typeof x === "object") {
      const id = x.id ?? x.perspective ?? "";
      const reason = x.reason ?? "";
      if (id && reason) return `${id}: ${reason}`;
      if (id) return String(id);
      if (reason) return String(reason);
    }
    return x == null ? "" : String(x);
  }).filter((s) => s.length > 0);
}

/**
 * 创建 submit_review ToolDefinition。
 * @param {object} opts { workDir, onSubmitted, bundleIdx }
 *   onSubmitted(report)：提交回调（workflow 用它抓报告对象）
 *   bundleIdx：分桶审查时的桶号（1 起；单轮为 null/undefined）——
 *   报告落盘按桶分文件（report-bundle-<idx>.json），并行桶互不覆盖（串行下同样隔离，
 *   审计可对照每桶快照）；单轮落 report.json
 */
/**
 * 报告落盘（工具通道与文本通道共用）：按桶分文件 report-bundle-<idx>.json（单轮 report.json），
 * 原子写 tmp+rename。导出供 workflow 文本通道兜底复用——模型不调 submit_review 时
 * 分文件隔离与 audit 归档同样生效。
 */
export async function persistBundleReport(workDir, bundleIdx, report) {
  const reportDir = path.join(workDir, ".cr-agent");
  await mkdir(reportDir, { recursive: true });
  // 按桶分文件：并行桶互不覆盖；串行下同样隔离（审计对照每桶快照）
  const file = path.join(reportDir, bundleIdx ? `report-bundle-${bundleIdx}.json` : "report.json");
  // 原子写（tmp+rename）：并发审查/异常中断不留半截文件
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(report, null, 2));
  await rename(tmp, file);
  return file;
}

export function createSubmitReviewTool({ workDir, onSubmitted, bundleIdx }) {
  return {
    name: "submit_review",
    label: "Submit Review",
    description: "提交最终代码审查报告（唯一交付途径）。完成全部审查工作后，调用本工具一次性提交完整报告对象；调用即结束审查会话，之后不要再输出任何文字。",
    promptSnippet: "submit_review：提交最终审查报告（唯一交付途径，调用即结束）",
    parameters: buildSubmitReviewSchema(),
    // 源头约束：端点支持 strict 时参数在解码层受语法约束；不支持自动降级（prefer）
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    async execute(toolCallId, params) {
      // 部分模型把嵌套对象二次 stringify（review/tests 等成字符串）——先解一层再落盘/回调
      if (params && typeof params === "object") params = coerceStringifiedJsonFields(params);
      // perspectives_skipped 统一为字符串，保证下游 metrics 与 merge 的 Set 语义稳定
      if (params && Array.isArray(params.perspectives_skipped)) {
        params = { ...params, perspectives_skipped: normalizePerspectivesSkipped(params.perspectives_skipped) };
      }
      const file = await persistBundleReport(workDir, bundleIdx, params);
      if (onSubmitted) {
        try { onSubmitted(params); } catch { /* 回调失败不影响工具成功 */ }
      }
      return {
        content: [{ type: "text", text: "报告已接收并落盘。审查会话结束。" }],
        details: { file, findings: (params.findings || []).length },
        terminate: true, // 早停：不再让模型生成总结尾巴（省 token + 消灭尾部污染源）
      };
    },
  };
}
