/**
 * 审查视角体系（MECE 一级 6 轴 + 二级 checklist）
 *
 * 一级轴互斥穷尽，作为 finding.category / perspectives_covered 的主枚举；
 * 二级条目是经验弹药（原 21 平铺视角），只挂在轴下展开审查要点，不再作为平行一级分类。
 * 设计说明见 docs/mece-perspectives.md。
 */

/** 一级轴 id（= finding.category / dimension 对齐） */
export const DIMENSIONS = [
  "correctness",
  "contract",
  "data",
  "security_fund",
  "runtime",
  "delivery",
];

/**
 * 一级视角（6）。secondary[] 为二级 checklist。
 * weight：轴默认权重（定级仍由锚点规则推导，此处仅提示优先级）。
 */
export const PERSPECTIVES = [
  {
    id: "correctness",
    name: "正确性",
    dimension: "correctness",
    weight: 3,
    checklist: "逻辑能否成立、边界/并发是否安全、变更能否编译构建。",
    secondary: [
      {
        id: "logic",
        name: "逻辑正确性与边界条件",
        checklist: "检查空指针/自动拆箱 NPE、静默失败与异常吞掉、条件错位或恒真恒假、分页/游标语义、必现故障路径、数据丢失或重复、异常分支兜底是否正确。",
        patterns: ["NPE", "null", "拆箱", "静默", "越界", "必现", "恒为", "丢失", "重复", "兜底"],
      },
      {
        id: "concurrency",
        name: "并发与线程安全",
        checklist: "检查共享可变状态的竞态、锁粒度与死锁、异步回调对共享资源的写、线程池隔离与拒绝策略、Double-Check、volatile/原子性、缓存并发刷新。",
        patterns: ["竞态", "锁", "线程安全", "并发", "线程池", "volatile", "死锁"],
      },
      {
        id: "build",
        name: "构建/编译正确性",
        checklist: "静态推断编译可行性：调用的方法/字段是否存在、参数类型与个数、import 缺失、模块 reactor 顺序、资源文件与代码目录匹配。",
        patterns: ["编译", "构建", "不存在的方法", "参数类型", "import"],
      },
    ],
  },
  {
    id: "contract",
    name: "契约与兼容",
    dimension: "contract",
    weight: 3,
    checklist: "入站/出站接口、错误码与序列化兼容；前后端字段与空态对齐。",
    secondary: [
      {
        id: "api-contract",
        name: "上下游契约与兼容性",
        checklist: "检查接口签名/返回结构变更是否破坏调用方、错误码语义漂移、接口文档未同步、RPC 序列化兼容（新增字段、枚举值）、跨仓调用是否有人未适配。",
        patterns: ["调用方", "下游", "契约", "兼容", "签名", "序列化", "错误码", "文档"],
      },
      {
        id: "frontend",
        name: "前端与交互兼容",
        checklist: "检查前端变更的接口字段对齐、空态/错误态渲染、埋点参数、文案口径与后端一致、兼容旧接口响应结构（渐进式解析）。",
        patterns: ["前端", "渲染", "空态", "文案", "字段对齐", "兼容旧响应"],
      },
    ],
  },
  {
    id: "data",
    name: "数据与一致性",
    dimension: "data",
    weight: 3,
    checklist: "SQL/DDL 与发布顺序、事务与双写、MQ 幂等、口径与单位。",
    secondary: [
      {
        id: "data-consistency",
        name: "数据口径一致性",
        checklist: "检查双轨/影子对比是否比对了正确变体、新老链路枚举值与过滤条件口径、时间/时区、单位换算（如重量 1000 倍）、默认值语义差异。",
        patterns: ["口径", "双轨", "影子", "对比", "枚举", "单位", "换算"],
      },
      {
        id: "mq",
        name: "消息可靠性",
        checklist: "检查 MQ 异常消息处理（毒消息无限重试 vs 直接 ack 丢数据）、重复消费幂等、顺序性依赖、消费位点管理、重投递的副作用。",
        patterns: ["MQ", "重试", "ack", "幂等", "重复消费", "毒消息"],
      },
      {
        id: "db-perf",
        name: "数据库与 SQL 性能",
        checklist: "检查新增查询是否走索引（WHERE/ORDER BY 列）、批量 IN 列表规模、N+1 查询、大事务、分库分表键兼容、慢 SQL 风险、连接池占用。",
        patterns: ["索引", "慢SQL", "N+1", "大事务", "分库分表", "IN 列表"],
      },
      {
        id: "txn-consistency",
        name: "事务与多写一致性",
        checklist: "检查 DB 事务边界与 MQ 发送的先后（先发后提交的丢数/重数）、缓存与 DB 双写顺序、本地事务+远程调用混合、最终一致性补偿任务。",
        patterns: ["事务", "一致性", "双写", "补偿", "先发后提交"],
      },
      {
        id: "release-order",
        name: "上线顺序与 DDL",
        checklist: "检查新增列/表是否有 DDL 且顺序正确（DDL 先于代码）、ES 索引是否预建、缓存 key 迁移、旧数据兼容读取、双向兼容期设计。",
        patterns: ["DDL", "建表", "上线顺序", "索引", "迁移", "兼容期"],
      },
    ],
  },
  {
    id: "security_fund",
    name: "安全与资损",
    dimension: "security_fund",
    weight: 3,
    checklist: "注入/凭证/敏感信息；鉴权与隔离；金额精度与退款幂等。",
    secondary: [
      {
        id: "security-generic",
        name: "通用安全（注入/敏感信息/凭证）",
        checklist: "检查 SQL 拼接注入、命令注入、XSS、SSRF；硬编码密钥/密码/token；日志打印敏感字段（手机号/身份证）；反序列化风险；路径穿越。",
        patterns: ["注入", "硬编码", "密钥", "敏感", "SQL拼接", "反序列化", "SSRF"],
      },
      {
        id: "security-business",
        name: "业务安全与权限（业态鉴权）",
        checklist: "检查业态/角色/白名单口径变化、可见性收窄或放大是否符合预期、鉴权缺失路径、fail-open 还是 fail-safe、隔离策略是否被绕过。",
        patterns: ["权限", "鉴权", "白名单", "业态", "可见性", "越权"],
      },
      {
        id: "fund-safety",
        name: "资损与资金安全",
        checklist: "检查价格/优惠/结算/积分计算的精度（BigDecimal vs double）、舍入方向、单位换算、退款/补偿的幂等与防重、对账兜底、限额与风控关闭。",
        patterns: ["资损", "价格", "金额", "精度", "BigDecimal", "退款", "幂等", "对账"],
      },
    ],
  },
  {
    id: "runtime",
    name: "运行时质量",
    dimension: "runtime",
    weight: 2,
    checklist: "性能与资源、容量与限流熔断、可观测与告警。",
    secondary: [
      {
        id: "performance",
        name: "性能与资源",
        checklist: "检查热点路径重复解析/重复创建（如每次 new ObjectMapper）、循环内 IO 或远程调用放大、缓存无上限无淘汰、大集合全量加载、序列化开销。",
        patterns: ["性能", "放大", "循环内", "缓存", "重复解析", "串行", "内存"],
      },
      {
        id: "capacity",
        name: "容量与压测",
        checklist: "检查新增流量放大的容量影响、双读/并行阶段的下游 QPS 承受、是否有压测结论引用、限流/熔断配置是否就绪。",
        patterns: ["容量", "压测", "限流", "熔断", "QPS"],
      },
      {
        id: "observability",
        name: "可观测性",
        checklist: "检查热路径日志量与级别（ERROR 放大）、关键链路埋点/打点是否可区分、失败是否有告警、监控指标是否覆盖新行为、排障字段是否充分。",
        patterns: ["日志", "埋点", "监控", "告警", "指标", "Cat", "观测"],
      },
    ],
  },
  {
    id: "delivery",
    name: "可维护与交付",
    dimension: "delivery",
    weight: 1,
    checklist: "测试、依赖、灰度开关、模块边界与代码卫生（默认低优先级，无行为影响不阻塞）。",
    secondary: [
      {
        id: "test",
        name: "测试覆盖与质量",
        checklist: "检查新增/修改逻辑是否有等效单测、被删除的测试是否有替代、测试与实现签名是否一致（能否编译）、边界场景是否覆盖、测试数据是否自洽。",
        patterns: ["单测", "测试", "覆盖", "用例", "断言"],
      },
      {
        id: "dependency",
        name: "依赖治理",
        checklist: "检查 SNAPSHOT 依赖未冻结（发版必须定版）、版本回退、依赖传递隐式抬升、scope 误用（compile/test）、冲突依赖未 exclusion。",
        patterns: ["SNAPSHOT", "依赖", "版本", "pom", "exclusion"],
      },
      {
        id: "config",
        name: "灰度/开关/配置",
        checklist: "检查功能开关默认值语义（空列表+开关=全量？）、灰度放量顺序、配置中心/环境配置项读取方式、配置缺失时的行为、回滚开关是否真实生效。",
        patterns: ["灰度", "开关", "默认值", "配置", "放量", "回滚", "配置中心"],
      },
      {
        id: "maintainability",
        name: "可维护性与代码卫生",
        checklist: "检查死代码/未使用导入、注释与实现是否矛盾、同一逻辑是否重复实现两处、命名是否误导、超大函数是否该拆分。注意：风格类问题标注 P3 且不作为阻塞项。",
        patterns: ["死代码", "未使用", "注释", "重复实现", "命名"],
      },
      {
        id: "architecture",
        name: "架构与模块边界",
        checklist: "检查分层是否被打破（DAO 直调/跨层引用）、复制粘贴式重复代码块、循环依赖、公共库改动的影响半径、模块职责漂移。",
        patterns: ["分层", "循环依赖", "职责", "公共库", "重复代码块"],
      },
    ],
  },
];

/** 旧一级 id / 别名 → 新一级轴（兼容历史 finding.category） */
const LEGACY_CATEGORY_MAP = Object.freeze({
  logic: "correctness",
  concurrency: "correctness",
  build: "correctness",
  contract: "contract",
  "api-contract": "contract",
  frontend: "contract",
  "data-consistency": "data",
  mq: "data",
  "db-perf": "data",
  "txn-consistency": "data",
  "release-order": "data",
  "security-generic": "security_fund",
  "security-business": "security_fund",
  "fund-safety": "security_fund",
  performance: "runtime",
  capacity: "runtime",
  observability: "runtime",
  test: "delivery",
  dependency: "delivery",
  config: "delivery",
  maintainability: "delivery",
  architecture: "delivery",
  // 旧五维报告标签
  internal: "correctness",
  upstream_api: "contract",
  upstream_data: "data",
  downstream_api: "contract",
  downstream_data: "data",
});

/** 二级 id → 一级轴 */
const SECONDARY_TO_PRIMARY = (() => {
  const m = new Map();
  for (const p of PERSPECTIVES) {
    for (const s of p.secondary || []) m.set(s.id, p.id);
  }
  return m;
})();

export function perspectiveById(id) {
  if (!id) return undefined;
  const primary = PERSPECTIVES.find((p) => p.id === id);
  if (primary) return primary;
  for (const p of PERSPECTIVES) {
    const sec = (p.secondary || []).find((s) => s.id === id);
    if (sec) return { ...sec, dimension: p.id, parent: p.id, weight: p.weight };
  }
  return undefined;
}

/** 将任意历史/二级 category 归一到一级轴 id；未知则原样返回 */
export function primaryPerspectiveId(category) {
  const c = String(category || "").trim();
  if (!c) return "";
  if (DIMENSIONS.includes(c)) return c;
  if (SECONDARY_TO_PRIMARY.has(c)) return SECONDARY_TO_PRIMARY.get(c);
  if (LEGACY_CATEGORY_MAP[c]) return LEGACY_CATEGORY_MAP[c];
  return c;
}

/** 二级 checklist 扁平列表（路由/统计用） */
export function listSecondaryPerspectives() {
  return PERSPECTIVES.flatMap((p) =>
    (p.secondary || []).map((s) => ({ ...s, parent: p.id, dimension: p.id, weight: p.weight })),
  );
}

/** 生成给模型的视角清单文本（一级 + 二级） */
export function renderPerspectivesForPrompt() {
  return PERSPECTIVES.map((p, i) => {
    const secs = (p.secondary || [])
      .map((s, j) => `   ${i + 1}.${j + 1} [${s.id}] ${s.name}\n      要点：${s.checklist}`)
      .join("\n");
    return `${i + 1}. [${p.id}] ${p.name}（一级轴，weight=${p.weight}）\n   轴要点：${p.checklist}\n   二级 checklist：\n${secs}`;
  }).join("\n");
}
