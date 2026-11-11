# MCP（可选）

将 `mcp.json.example` 复制为 `mcp.json` 并按需填写；**无 `mcp.json` 或 `mcpServers` 为空时不启用 MCP**（与历史行为一致）。

```bash
cp .pi/mcp.json.example .pi/mcp.json
```

配置形状与 Cursor / 常见 MCP 客户端相同（`mcpServers`）。审查会话会把该文件安装到隔离 `agentDir/mcp.json`，并通过 SDK `createMcpExtension` 挂载。

建议对需要模型直接调用的工具设 `"exposure": "direct"`（默认 codemode 在本产品只读工具集下基本不可达）。工具名形如 `mcp__<server>__<tool>`，启用 MCP 时会自动加入 `mcp__*` 白名单。
