# CR-Agent

基于 **pi-coding-agent**（`@earendil-works/pi-coding-agent` SDK，headless 编程接入）构建的通用 AI Code Review Agent。


## 能力总览

### 7 步执行流程

| 步骤 | CR-Agent 实现 |
|---|---|
| 1 触发 | 页面提交 PR 链接（manual）；push webhook 预留 |
| 2 模式选择 | 基于账本 lastHead 自动判定全量/增量；支持强制全量 |
| 3 Agent 执行 | pi-coding-agent SDK + 任意 OpenAI 兼容端点（模型可配）；小 diff（<200 行）走 fast-path 提示词 |
| 4 证据收集 | diff 落盘 + agent 只读 read/grep/find/ls 工具；查证失败标 unverified，不编造 |
| 5 结论生成 | 结构化 JSON schema + 容错解析 + 一次重试；findings 必带 confidence |
| 6 结论交付 | 报告页分层渲染（作者摘要→明细→原始 JSON） |
| 7 迭代闭环 | previous_findings 复核 + **豁免清单** + unverified 2 轮升级 needs_human |

### MECE 审查视角（一级 6 轴 + 二级 checklist）

一级轴（写入 `finding.category`）：**correctness** / **contract** / **data** / **security_fund** / **runtime** / **delivery**。

原 21 项经验下沉为各轴下的二级 checklist，只进 prompt 展开，不再平铺一级。设计说明见 [docs/mece-perspectives.md](docs/mece-perspectives.md)。

### 好的实践

- 证据驱动不编造（unverified 如实标注）+ 修复建议 100% 必填
- P0-P3 分级 + blockers + 上线三件套（前置条件/监控/回滚）
- 问题 ID 跨轮稳定、首次发现 head 留痕
- 跨仓查证 trace 体系（T 编号 + boundary_input + 状态机）

### 能力清单 P1/P2 能力

- **四档证据分级**：findings.evidence_level（test-confirmed / test-falsified / code-confirmed / unverified），测试证伪一律降 P3 不入阻塞
- **文件分桶**：≥400 变更行自动分桶，每桶一个 sub-agent 隔离上下文，确定性合并（最严结论 + Jaccard 去重取最严级别）
- **行号校验**：finding.line 不在 hunk 范围 → 回退最近 hunk 头，line_adjusted 标记
- **文件类型路由**：SQL/proto/配置/前端/JVM/Go/Python 等命中即升优先视角 + 附加检查指令（src/engine/routing.js）
- **pre-existing 程序化判定**：finding 落点不在本次新增行 → 程序判定存量、降一档不阻塞（对 base 比对，非模型猜测）
- **团队规则可选注入**：data/rules/{owner}_{repo}.md → REVIEW.md → AGENTS.md 逐级回退，Code Owner 手工维护（上限 8KB，防注意力稀释）
- **采纳率回收**：ledger stats 的 adoption_rate = 已修复/已复核，前端报告页直接可见
- **离线评测集**：npm run eval —— golden 按新增行自检 + 断言优先打分（file+line 区间匹配，不判 message）

## 快速开始

```bash
npm install
npm start            # http://localhost:3777
```

> **依赖注意（临时止血）**：`@earendil-works/pi-ai@1.4.0` 传递依赖声明了 registry 上不存在的
> `@aws-sdk/credential-provider-login@^3.972.87` / `@aws-sdk/nested-clients@^3.997.54`，
> 已在 package.json `overrides` 中钉住 `3.972.86` / `3.997.53` 保证可安装。
> 上游补发后应移除 overrides；每次升级 `pi-coding-agent` 需重新验证 `npm install`。

首次使用：
1. 打开 **设置** 页：填 OpenAI 兼容端点 Base URL（如 `https://api.openai.com/v1`，任意兼容服务均可）+ API Key
2. 「从端点拉取模型」或手动添加模型（如 `gpt-4o` / `deepseek-chat`），设默认模型
3. 「测试端点」验证连通性
4. 回到首页粘贴 PR 链接 → 开始审查

## 配置

| 环境变量 | 说明 | 默认 |
|---|---|---|
| `PORT` | 服务端口 | 3777 |
| `CR_AGENT_DATA` | 数据目录（settings/ledgers/reports/workspaces/pi-home） | `./data` |

设置项（设置页 / `data/settings.json`）：`baseUrl`、`apiKey`、`models[]`、`defaultModel`、`defaultThinking`、`maxDiffChars`、`platformTokens`（各 git host 的 token）、`usePlatformApi`、`gitScheme`。

## PR 链接支持

- GitHub：`https://github.com/{owner}/{repo}/pull/{n}`
- GitLab：`https://host/{group}/{repo}/-/merge_requests/{n}`
- Bitbucket：`https://host/{project}/repos/{repo}/pull-requests/{n}`（自建 Bitbucket/兼容域名均可）
- 通用兜底：路径含 `pull|pulls|merge_requests|pull-requests/{n}`

diff 获取：平台 API 优先（配 token）→ git CLI 兜底（fetch PR ref + 与 origin/<主分支> 三点 diff，diff 前校验 merge-base 可用，分叉超出浅克隆深度时回退 head~1）。

## 安全边界（部署前必读）

- **只审可信仓库**：审查 agent 的只读工具（read/grep/find/ls）无路径沙箱，可读运行用户可及的任意文件
  （含 pi-home/auth.json、~/.ssh）。恶意 PR diff 中的提示注入可能诱导模型把敏感内容写进报告。
  报告落盘与 sync 响应已做 apiKey/platformTokens 脱敏，但不覆盖环境内其他凭证——
  **不要用本工具直接审查外部不可信贡献 PR**，或用专用低权限账号/容器运行。
- 默认只绑 `127.0.0.1`（无鉴权服务；`CR_AGENT_HOST=0.0.0.0` 自担风险）。
- 服务无用户鉴权，部署共享实例时需自加网关鉴权。

## 目录结构

```
src/
  server.js               # express 服务 + REST API
  settings.js             # 设置管理（models/auth）
  pr-resolver.js          # PR 链接解析 + diff 获取（API/git 双通道）
  engine/
    workflow.js           # 7 步流程编排（模式选择/风险自适应/分桶/降级声明/凭证脱敏）
    perspectives.js       # MECE 一级 6 轴 + 二级 checklist
    routing.js            # 文件类型→一级轴路由
    severity-anchors.js   # 锚点定级（P0–P3 门禁规则求值）
    severity-rules-default.js  # 默认定级规则表（可被 data/severity-rules.json 覆盖）
    bundler.js            # diff 解析/文件分桶/行号校验/Jaccard 去重
    prompts.js            # 系统/用户提示词（纪律条款 + schema 指令 + fast-path）
    report-schema.js      # 结构化报告 schema + 容错规范化
    ledger.js             # 审查账本（跨轮闭环/豁免/needs_human 升级）
    pi-runner.js          # pi-coding-agent 编程封装（隔离 agentDir/只读工具集）
public/index.html         # SPA（提交/报告/账本/设置）
test/                     # 单测 + 端到端
```

## API

- `POST /api/review` `{url, forceFull?, model?, thinking?, trigger?, sync?}` → `{reviewId}`（异步）+ `GET /api/review/:id/progress`；`sync=true` 同步返回完整报告（响应同样经凭证脱敏）
- `GET/PUT /api/settings`、`POST /api/settings/models/fetch`、`POST /api/settings/test`
- `GET /api/reports`、`GET /api/reports/:id`
- `GET /api/ledger?repo&pr`、`POST/DELETE /api/ledger/exempt`
- `GET /api/perspectives`

## 测试与评测

```bash
npm test    # node --test：URL 解析、分桶/行号校验/去重、报告规范化、账本闭环、证据分级、路由、采纳率、脱敏、证伪重估等 53 项
npm run eval  # 离线评测自检：golden 合法性（必须指向新增行）+ 路由命中；带 --report <报告.json> 可对模型输出做 P/R/F1 打分
```
