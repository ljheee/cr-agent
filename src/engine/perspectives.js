/**
 * 审查视角体系（21 个）
 *
 * 每个视角带：checklist 指令（给模型）+ 典型问题模式（用于自检与统计）。
 */

export const PERSPECTIVES = [
  {
    id: "logic",
    name: "逻辑正确性与边界条件",
    dimension: "internal",
    weight: 3,
    checklist: "检查空指针/自动拆箱 NPE、静默失败与异常吞掉、条件错位或恒真恒假、分页/游标语义、必现故障路径、数据丢失或重复、异常分支兜底是否正确。",
    patterns: ["NPE", "null", "拆箱", "静默", "越界", "必现", "恒为", "丢失", "重复", "兜底"],
  },
  {
    id: "contract",
    name: "上下游契约与兼容性",
    dimension: "upstream_api",
    weight: 3,
    checklist: "检查接口签名/返回结构变更是否破坏调用方、错误码语义漂移、接口文档未同步、RPC 序列化兼容（新增字段、枚举值）、跨仓调用是否有人未适配。",
    patterns: ["调用方", "下游", "契约", "兼容", "签名", "序列化", "错误码", "文档"],
  },
  {
    id: "config",
    name: "灰度/开关/配置",
    dimension: "internal",
    weight: 3,
    checklist: "检查功能开关默认值语义（空列表+开关=全量？）、灰度放量顺序、配置中心/环境配置项读取方式、配置缺失时的行为、回滚开关是否真实生效。",
    patterns: ["灰度", "开关", "默认值", "配置", "放量", "回滚", "配置中心"],
  },
  {
    id: "test",
    name: "测试覆盖与质量",
    dimension: "internal",
    weight: 2,
    checklist: "检查新增/修改逻辑是否有等效单测、被删除的测试是否有替代、测试与实现签名是否一致（能否编译）、边界场景是否覆盖、测试数据是否自洽。",
    patterns: ["单测", "测试", "覆盖", "用例", "断言"],
  },
  {
    id: "observability",
    name: "可观测性",
    dimension: "internal",
    weight: 2,
    checklist: "检查热路径日志量与级别（ERROR 放大）、关键链路埋点/打点是否可区分、失败是否有告警、监控指标是否覆盖新行为、排障字段是否充分。",
    patterns: ["日志", "埋点", "监控", "告警", "指标", "观测"],
  },
  {
    id: "maintainability",
    name: "可维护性与代码卫生",
    dimension: "internal",
    weight: 1,
    checklist: "检查死代码/未使用导入、注释与实现是否矛盾、同一逻辑是否重复实现两处、命名是否误导、超大函数是否该拆分。注意：风格类问题标注 P3 且不作为阻塞项。",
    patterns: ["死代码", "未使用", "注释", "重复实现", "命名"],
  },
  {
    id: "performance",
    name: "性能与资源",
    dimension: "internal",
    weight: 2,
    checklist: "检查热点路径重复解析/重复创建（如每次 new ObjectMapper）、循环内 IO 或远程调用放大、缓存无上限无淘汰、大集合全量加载、序列化开销。",
    patterns: ["性能", "放大", "循环内", "缓存", "重复解析", "串行", "内存"],
  },
  {
    id: "dependency",
    name: "依赖治理",
    dimension: "internal",
    weight: 2,
    checklist: "检查 SNAPSHOT 依赖未冻结（发版必须定版）、版本回退、依赖传递隐式抬升、scope 误用（compile/test）、冲突依赖未 exclusion。",
    patterns: ["SNAPSHOT", "依赖", "版本", "pom", "exclusion"],
  },
  {
    id: "security-business",
    name: "业务安全与权限",
    dimension: "internal",
    weight: 3,
    checklist: "检查权限/角色/白名单口径变化、可见性收窄或放大是否符合预期、鉴权缺失路径、fail-open 还是 fail-safe、隔离策略是否被绕过。",
    patterns: ["权限", "鉴权", "白名单", "可见性", "越权"],
  },
  {
    id: "build",
    name: "构建/编译正确性",
    dimension: "internal",
    weight: 3,
    checklist: "静态推断编译可行性：调用的方法/字段是否存在、参数类型与个数、import 缺失、模块 reactor 顺序、资源文件与代码目录匹配。",
    patterns: ["编译", "构建", "不存在的方法", "参数类型", "import"],
  },
  {
    id: "data-consistency",
    name: "数据口径一致性",
    dimension: "downstream_data",
    weight: 3,
    checklist: "检查双轨/影子对比是否比对了正确变体、新老链路枚举值与过滤条件口径、时间/时区、单位换算（如重量 1000 倍）、默认值语义差异。",
    patterns: ["口径", "双轨", "影子", "对比", "枚举", "单位", "换算"],
  },
  {
    id: "mq",
    name: "消息可靠性",
    dimension: "downstream_data",
    weight: 2,
    checklist: "检查 MQ 异常消息处理（毒消息无限重试 vs 直接 ack 丢数据）、重复消费幂等、顺序性依赖、消费位点管理、重投递的副作用。",
    patterns: ["MQ", "重试", "ack", "幂等", "重复消费", "毒消息"],
  },
  {
    id: "release-order",
    name: "上线顺序与 DDL",
    dimension: "internal",
    weight: 2,
    checklist: "检查新增列/表是否有 DDL 且顺序正确（DDL 先于代码）、ES 索引是否预建、缓存 key 迁移、旧数据兼容读取、双向兼容期设计。",
    patterns: ["DDL", "建表", "上线顺序", "索引", "迁移", "兼容期"],
  },

  {
    id: "security-generic",
    name: "通用安全（注入/敏感信息/凭证）",
    dimension: "internal",
    weight: 3,
    checklist: "检查 SQL 拼接注入、命令注入、XSS、SSRF；硬编码密钥/密码/token；日志打印敏感字段（手机号/身份证）；反序列化风险；路径穿越。",
    patterns: ["注入", "硬编码", "密钥", "敏感", "SQL拼接", "反序列化", "SSRF"]
  },
  {
    id: "db-perf",
    name: "数据库与 SQL 性能",
    dimension: "downstream_data",
    weight: 2,
    checklist: "检查新增查询是否走索引（WHERE/ORDER BY 列）、批量 IN 列表规模、N+1 查询、大事务、分库分表键兼容、慢 SQL 风险、连接池占用。",
    patterns: ["索引", "慢SQL", "N+1", "大事务", "分库分表", "IN 列表"]
  },
  {
    id: "concurrency",
    name: "并发与线程安全",
    dimension: "internal",
    weight: 2,
    checklist: "检查共享可变状态的竞态、锁粒度与死锁、异步回调对共享资源的写、线程池隔离与拒绝策略、Double-Check、volatile/原子性、缓存并发刷新。",
    patterns: ["竞态", "锁", "线程安全", "并发", "线程池", "volatile", "死锁"]
  },
  {
    id: "fund-safety",
    name: "资损与资金安全",
    dimension: "internal",
    weight: 3,
    checklist: "检查价格/优惠/结算/积分计算的精度（BigDecimal vs double）、舍入方向、单位换算、退款/补偿的幂等与防重、对账兜底、限额与风控阈值。",
    patterns: ["资损", "价格", "金额", "精度", "BigDecimal", "退款", "幂等", "对账"]
  },
  {
    id: "capacity",
    name: "容量与压测",
    dimension: "internal",
    weight: 1,
    checklist: "检查新增流量放大的容量影响、双读/并行阶段的下游 QPS 承受、是否有压测结论引用、限流/熔断配置是否就绪。",
    patterns: ["容量", "压测", "限流", "熔断", "QPS"]
  },
  {
    id: "txn-consistency",
    name: "事务与多写一致性",
    dimension: "internal",
    weight: 2,
    checklist: "检查 DB 事务边界与 MQ 发送的先后（先发后提交的丢数/重数）、缓存与 DB 双写顺序、本地事务+远程调用混合、最终一致性补偿任务。",
    patterns: ["事务", "一致性", "双写", "补偿", "先发后提交"]
  },
  {
    id: "frontend",
    name: "前端与交互兼容",
    dimension: "internal",
    weight: 1,
    checklist: "检查前端变更的接口字段对齐、空态/错误态渲染、埋点参数、文案口径与后端一致、兼容旧接口响应结构（渐进式解析）。",
    patterns: ["前端", "渲染", "空态", "文案", "字段对齐", "兼容旧响应"]
  },
  {
    id: "architecture",
    name: "架构与模块边界",
    dimension: "internal",
    weight: 1,
    checklist: "检查分层是否被打破（DAO 直调/跨层引用）、复制粘贴式重复代码块、循环依赖、公共库改动的影响半径、模块职责漂移。",
    patterns: ["分层", "循环依赖", "职责", "公共库", "重复代码块"]
  },
];

/** 按维度分组（与 CR 报告 dimensions 标注对齐） */
export const DIMENSIONS = ["internal", "upstream_api", "upstream_data", "downstream_api", "downstream_data"];

export function perspectiveById(id) {
  return PERSPECTIVES.find((p) => p.id === id);
}

/** 生成给模型的视角清单文本 */
export function renderPerspectivesForPrompt() {
  return PERSPECTIVES.map((p, i) => {
    const tag = p.isNew ? "（新增视角）" : "";
    return `${i + 1}. [${p.id}] ${p.name}${tag}（dimension=${p.dimension}, 权重=${p.weight}）\n   审查要点：${p.checklist}`;
  }).join("\n");
}
