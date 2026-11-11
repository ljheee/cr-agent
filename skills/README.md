# Skills（可选）

在本目录放置 Agent Skills；**目录为空或不存在时行为与以前一致（不加载 skill）**。

## 用法

1. 新增子目录，内含 `SKILL.md`（推荐），或在本目录直接放 `.md` 文件。
2. 重启 cr-agent 服务后，下一次审查会话会通过 `additionalSkillPaths` 注入。
3. 也可在设置里用 `skillDir` 指向其它绝对/相对路径（相对 cr-agent 根）。

发现逻辑见 `src/engine/agent-extras.js`。技能只从 **cr-agent 安装根** 加载，不会扫描被审 PR 工作区。
