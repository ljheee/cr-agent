/**
 * 按文件类型路由到 MECE 一级视角 + 附加检查指令
 *
 * 一级轴由 perspectives.js 定义；路由只做「升优先 + 附加指令」，
 * 防止把二级 checklist 平铺进注意力窗口。团队 per-path 规则仍走 data/rules/。
 */

/** 文件模式 → 一级 focus + 附加检查指令（靠前的规则先命中） */
const FILETYPE_RULES = [
  {
    match: /(?:^|\/)(?:(?:test|tests|__tests__|spec)\/|[^\/]*\.(?:test|spec)\.[a-z]+$|[^\/]*(?:Test|Tests)\.[a-zA-Z]+$)/,
    focus: ["delivery"],
    note: "测试变更（delivery/test）：断言是否真的断言（非空跑）；边界与回归用例覆盖新逻辑。",
  },
  {
    match: /(?:^|\/)(?:dockerfile|docker-compose)/i,
    focus: ["delivery", "security_fund"],
    note: "容器：基础镜像 tag 可变性、secrets 进镜像层、端口暴露面。",
  },
  {
    match: /\.(sql|ddl)$/i,
    focus: ["data"],
    note: "SQL/DDL（data）：逐条语句检查索引命中与锁范围；DDL 必须给出与代码发布的前后顺序（先加列后发代码 / 先停写后改列）。",
  },
  {
    match: /\.(proto|thrift|graphql|gql)$/i,
    focus: ["contract", "data"],
    note: "接口定义（contract）：字段编号/required 变更即破坏性变更，必须列进 breaking_changes 并给双写或版本化过渡方案。",
  },
  {
    match: /\.(ya?ml|properties|conf|ini|toml|env)$/i,
    focus: ["delivery"],
    note: "配置变更（delivery/config）：区分代码仓库配置与线上配置中心；给出回滚时配置与代码的顺序依赖。",
  },
  {
    match: /\.(js|jsx|ts|tsx|mjs|cjs|vue|svelte)$/i,
    focus: ["correctness", "contract"],
    note: "前端/JS：注意 async 错误传播（未 await/未 catch）、空值短路、状态更新竞态；涉及金额用整数分运算（security_fund）。",
  },
  {
    match: /\.(java|kt)$/i,
    focus: ["correctness", "runtime"],
    note: "JVM 系：检查资源关闭（try-with-resources）、并发容器选择、异常吞掉（catch 后仅打日志）。",
  },
  {
    match: /\.(go)$/i,
    focus: ["correctness", "runtime"],
    note: "Go：error 未检查/未包装、goroutine 泄漏（缺 ctx 取消）、defer 在循环内。",
  },
  {
    match: /\.(py)$/i,
    focus: ["correctness", "security_fund"],
    note: "Python：可变默认参数、裸 except、eval/exec 注入面。",
  },
  {
    match: /\.(sh|bash)$/i,
    focus: ["delivery", "security_fund"],
    note: "脚本：set -e/-u 缺失、未引用变量、rm -rf 路径拼接。",
  },
  {
    match: /\.(mq|kafka|topic)$/i,
    focus: ["data"],
    note: "MQ（data/mq）：消费幂等、重试与死信、顺序性假设。",
  },
];

/**
 * 对本次变更文件做路由：返回 { focusPerspectives, notes, routedFiles }
 *  - focusPerspectives：命中的一级轴（按命中文件数排序，最多 6 个）
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
