# MECE 审查视角：一级轴 + 二级 checklist

## 为什么改

旧版把约 21 个经验项平铺成一级「视角」，存在：

- **不互斥**：性能 / DB 性能 / 容量重叠；一致性族（口径 / 事务 / MQ）重叠；安全族重叠
- **不穷尽于声明维**：报告写了 `upstream_data` / `downstream_api` 却几乎无条目
- **不利于 agent**：模型重复打标、统计虚高、prompt 注意力被稀释

CR agent 需要的主分类应服务三件事：不漏审、finding 可归因、定级/统计不打架。

## 结构

| 层级 | 作用 | 写入报告？ |
|------|------|------------|
| **一级轴（6）** | MECE 主分类；`finding.category` / `dimension` / `perspectives_covered` | 是 |
| **二级 checklist** | 轴下经验要点（原 21 项下沉）；只进 prompt 展开 | 否（勿写入 category） |

### 一级六轴

1. **correctness** — 正确性（逻辑 / 并发 / 构建）
2. **contract** — 契约与兼容（API 契约 / 前端字段对齐）
3. **data** — 数据与一致性（口径 / MQ / SQL / 事务 / DDL 顺序）
4. **security_fund** — 安全与资损（通用安全 / 鉴权 / 资金）
5. **runtime** — 运行时质量（性能 / 容量 / 可观测）
6. **delivery** — 可维护与交付（测试 / 依赖 / 配置灰度 / 卫生 / 架构）

实现：`src/engine/perspectives.js`。文件类型路由升优先一级轴：`src/engine/routing.js`。

## 与定级门禁的关系

视角轴 **不直接决定** P0–P3；定级由锚点规则（`severity-rules-default.js`）推导。视角只影响：

- 审查覆盖与 `perspectives_skipped`
- 契约破坏识别（`category=contract`）
- **P3-C3**：`delivery`（及历史卫生别名）+ `impact_radius∈{single,none}` → 封顶 P3，避免缺测/命名被抬成阻塞

## 兼容

`primaryPerspectiveId()` 将旧二级 id（如 `logic`、`mq`）与旧五维标签映射到一级轴；`normalizeReport` 会归一 `category` / `dimension` / `perspectives_covered`。

## 使用约定（给模型 / 提示词）

1. 六个一级轴都要过一遍；不适用写入 `perspectives_skipped`（字符串，如 `"delivery: 无测试与配置变更"`）
2. `category` **只填一级轴 id**
3. 二级条目按 diff / 路由重点展开，不必每条都产出 finding
