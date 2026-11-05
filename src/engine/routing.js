/**
 * 按文件类型路由视角 + per-path 规则（吸收 ocr rule_docs / rule.json 一手经验）
 *
 * ocr 做法：50+ 文件类型各一份 rule_docs，每条规则内嵌"用 code_search/file_read 确认"的工具指令；
 * rule.json 支持 per-path 规则。cr-agent 通用化取舍：
 *  - 不维护 50 份文档，而是一张「文件模式 → 重点视角 + 专项检查指令」路由表，注入用户提示词；
 *  - 规则仍由 21 视角统一承载，路由只做"优先级排序 + 附加指令"，防止视角平铺导致注意力稀释；
 *  - per-path 规则走 data/rules/（团队 REVIEW.md / AGENTS.md，由 workflow 注入）。
 */

/** 文件模式 → 路由：重点视角（升优先）+ 附加检查指令（靠前的规则先命中，专项规则置于通用扩展名之前） */
const FILETYPE_RULES = [
  {
    // 测试目录/文件：边界化目录段，避免 contest/ 子串误命中；先于通用扩展名，否则 .ts/.py/.java 全被截胡
    match: /(?:^|\/)(?:(?:test|tests|__tests__|spec)\/|[^\/]*\.(?:test|spec)\.[a-z]+$|[^\/]*(?:Test|Tests)\.[a-zA-Z]+$)/,
    focus: ["test"],
    note: "测试变更：断言是否真的断言（非空跑）；边界与回归用例覆盖新逻辑。",
  },
  {
    // 容器专项先于通用 YAML，否则 docker-compose.yml 只命中配置规则
    match: /(?:^|\/)dockerfile|docker-compose/i,
    focus: ["build", "security-generic"],
    note: "容器：基础镜像 tag 可变性、secrets 进镜像层、端口暴露面。",
  },
  {
    match: /\.(sql|ddl)$/i,
    focus: ["db-perf", "data-consistency", "release-order"],
    note: "SQL/DDL：逐条语句检查索引命中与锁范围；DDL 必须给出与代码发布的前后顺序（先加列后发代码 / 先停写后改列）。",
  },
  {
    match: /\.(proto|thrift|graphql|gql)$/i,
    focus: ["contract", "release-order"],
    note: "接口定义：字段编号/required 变更即破坏性变更，必须列进 breaking_changes 并给双写或版本化过渡方案。",
  },
  {
    match: /\.(ya?ml|properties|conf|ini|toml|env)$/i,
    focus: ["config", "release-order"],
    note: "配置变更：区分代码仓库配置与线上配置中心；给出回滚时配置与代码的顺序依赖。",
  },
  {
    match: /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i,
    focus: ["logic", "contract", "frontend"],
    note: "前端/JS：注意 async 错误传播（未 await/未 catch）、空值短路、状态更新竞态；涉及金额用整数分运算。",
  },
  {
    match: /\.(java|kt)$/i,
    focus: ["logic", "concurrency", "observability"],
    note: "JVM 系：检查资源关闭（try-with-resources）、并发容器选择、异常吞掉（catch 后仅打日志）。",
  },
  {
    match: /\.(go)$/i,
    focus: ["logic", "concurrency", "observability"],
    note: "Go：error 未检查/未包装、goroutine 泄漏（缺 ctx 取消）、defer 在循环内。",
  },
  {
    match: /\.(py)$/i,
    focus: ["logic", "security-business"],
    note: "Python：可变默认参数、裸 except、eval/exec 注入面。",
  },
  {
    match: /\.(sh|bash)$/i,
    focus: ["release-order", "security-generic"],
    note: "脚本：set -e/-u 缺失、未引用变量、rm -rf 路径拼接。",
  },
  {
    match: /\.(mq|kafka|topic)$/i,
    focus: ["mq"],
    note: "MQ：消费幂等、重试与死信、顺序性假设。",
  },
];

/**
 * 对本次变更文件做路由：返回 { focusPerspectives: [...], notes: [...], routedFiles: n }
 *  - focusPerspectives：命中的重点视角（按命中文件数排序，最多 6 个）
 *  - notes：附加检查指令（去重）
 */
export function routeByFileTypes(paths) {
  const focusCount = new Map();
  const notes = [];
  let routedFiles = 0;
  for (const p of paths || []) {
    const hit = FILETYPE_RULES.find((r) => r.match.test(p));
    if (!hit) continue;
    routedFiles++;
    for (const id of hit.focus) focusCount.set(id, (focusCount.get(id) || 0) + 1);
    if (!notes.includes(hit.note)) notes.push(hit.note);
  }
  const focusPerspectives = [...focusCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id]) => id);
  return { focusPerspectives, notes, routedFiles };
}
