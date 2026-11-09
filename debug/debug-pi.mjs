/**
 * 最小 pi 链路诊断：复用 cr-agent 的 pi-runner 配置跑一个 10 token 的会话，
 * 打印事件流与最终消息结构，定位「模型未返回任何文本」的真实原因。
 * 用法：node debug/debug-pi.mjs（需先配好 data/settings.json）
 */
import { Settings } from "../src/settings.js";
import { ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModelsJson } from "../src/engine/pi-models.js";

const DATA = process.env.CR_AGENT_DATA || path.join(process.cwd(), "data");
// fetch 钩子：记录 SDK 发出的每个网络请求（含非 2xx 响应体）
const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  console.log("[fetch]", init?.method || "GET", url, "| body:", (init?.body || "").toString().slice(0, 200));
  const res = await origFetch(input, init);
  console.log("[fetch res]", res.status, res.headers.get("content-type"));
  return res;
};
const settings = await Settings.load(DATA);
const s = settings.get();
console.log("[cfg]", s.baseUrl, "| model:", s.defaultModel, "| thinking:", s.defaultThinking);

const workDir = await mkdtemp(path.join(tmpdir(), "pi-debug-"));
const agentDir = path.join(DATA, "pi-home");
const { mkdir, writeFile } = await import("node:fs/promises");
await mkdir(agentDir, { recursive: true });
await writeFile(path.join(agentDir, "models.json"), JSON.stringify(buildModelsJson(s), null, 2));
await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({ [s.providerId || "custom"]: { type: "api_key", key: s.apiKey || "" } }, null, 2), { mode: 0o600 });

const modelRuntime = await ModelRuntime.create({
  authPath: path.join(agentDir, "auth.json"),
  modelsPath: path.join(agentDir, "models.json"),
});
const model = modelRuntime.getModel(s.providerId || "custom", s.defaultModel);
console.log("[model resolved]", model?.id || "(null)", "| api:", model?.api || "?");


// 完整真实链路：runCrTurn（与 workflow 一致）
import { runCrTurn } from "../src/engine/pi-runner.js";
try {
  const { text, usage, toolCalls } = await runCrTurn({
    settings: s, dataDir: DATA, workDir,
    systemPrompt: "你是 CR 助手，只输出 JSON。",
    userPrompt: '输出 {"conclusion":"通过","one_line":"ok","findings":[]}',
    model: s.defaultModel, thinkingLevel: s.defaultThinking || "high",
    timeoutMs: 120000,
    onEvent: (e) => console.log("[agent event]", e?.type),
  });
  console.log("=== runCrTurn 成功");
  console.log("text:", text.slice(0, 300));
  console.log("usage:", JSON.stringify(usage), "| toolCalls:", toolCalls);
} catch (e) {
  console.log("=== runCrTurn 失败:", String(e?.message || e).slice(0, 400));
}
process.exit(0);
