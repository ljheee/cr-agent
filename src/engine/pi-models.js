/**
 * 纯函数工具（与 SDK 零依赖）。
 * 从 pi-runner 拆出：buildModelsJson 是纯函数，测试与 CI 无需安装 200MB+ 的 pi SDK 树即可离线运行。
 */
export class PiRunnerError extends Error {}

/**
 * 生成 pi 的 models.json 内容（自定义 OpenAI 兼容 provider）。
 * schema 见 pi-coding-agent model-config.js：
 *   providers.<id>: { name?, baseUrl?, api?, models: [{id, name?, reasoning?, contextWindow?, maxTokens?, input?, cost?}] }
 */
export function buildModelsJson(settings) {
  const models = (settings.models || []).map((m) => ({
    id: m.id,
    name: m.name || m.id,
    reasoning: m.reasoning !== false,
    input: ["text"],
    contextWindow: m.contextWindow || 128000,
    ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  if (!models.length) throw new PiRunnerError("设置中没有可用模型，请先在设置页添加");
  const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
  return {
    providers: {
      [settings.providerId || "custom"]: {
        name: settings.providerName || "AI Proxy",
        // SDK ProviderConfigSchema：baseUrl 若出现则 minLength≥1；空串会校验失败且错误被遮蔽
        ...(baseUrl ? { baseUrl } : {}),
        api: "openai-completions",
        models,
      },
    },
  };
}
