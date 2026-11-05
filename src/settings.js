/**
 * 运行时配置（settings.json）
 * 模型端点：任意 OpenAI 兼容服务（如 https://api.openai.com/v1），在设置页配置；不默认指向任何特定服务
 * 凭证可为平台 API Key 或 SSO token（Bearer）。模型列表支持自动拉取 + 手动管理。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULTS = {
  baseUrl: "",                 // OpenAI 兼容端点，必填（设置页配置）
  providerId: "custom",         // pi models.json 中的 provider 标识
  providerName: "Custom OpenAI-Compatible Endpoint",
  apiKey: "",
  models: [],
  defaultModel: "",
  defaultThinking: "high",
  maxDiffChars: 400000,
  usePlatformApi: true,
  platformTokens: {},      // { host: token } 平台 API/git 凭证
  gitScheme: "https",
};

export class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this._watchers = [];
  }

  static async load(dataDir) {
    await mkdir(dataDir, { recursive: true });
    const s = new Settings(path.join(dataDir, "settings.json"));
    try { s.data = { ...DEFAULTS, ...JSON.parse(await readFile(s.file, "utf8")) }; }
    catch { /* 首次 */ }
    return s;
  }

  get() { return { ...this.data }; }

  async update(patch) {
    const allowed = ["baseUrl", "providerId", "providerName", "apiKey", "models", "defaultModel", "defaultThinking", "maxDiffChars", "usePlatformApi", "platformTokens", "gitScheme"];
    // 快照式更新：先在副本上校验，全部通过才落到 this.data（校验抛错时内存不落脏数据）
    const next = { ...this.data };
    for (const k of allowed) if (patch[k] !== undefined) next[k] = patch[k];
    // 类型/范围校验：模型输出与前端输入都可能是任意 JSON
    if (typeof next.baseUrl !== "string") throw new Error("baseUrl 必须是字符串");
    if (next.baseUrl) this._checkBaseUrl(next.baseUrl);
    if (typeof next.apiKey !== "string") throw new Error("apiKey 必须是字符串");
    if (next.maxDiffChars !== undefined) {
      if (!Number.isInteger(next.maxDiffChars) || next.maxDiffChars <= 0) throw new Error("maxDiffChars 必须是正整数");
    }
    if (next.usePlatformApi !== undefined && typeof next.usePlatformApi !== "boolean") throw new Error("usePlatformApi 必须是布尔值");
    if (next.gitScheme !== undefined && !["https", "http", "ssh"].includes(next.gitScheme)) throw new Error("gitScheme 仅支持 https/http/ssh");
    if (next.models !== undefined && !Array.isArray(next.models)) throw new Error("models 必须是数组");
    if (next.platformTokens !== undefined && (typeof next.platformTokens !== "object" || next.platformTokens === null || Array.isArray(next.platformTokens))) throw new Error("platformTokens 必须是对象");
    if (next.defaultThinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(next.defaultThinking)) throw new Error("defaultThinking 仅支持 off/minimal/low/medium/high/xhigh/max");
    this.data = next;
    await this.save();
    this._watchers.forEach((w) => { try { w(this.get()); } catch { /* ignore */ } });
    return this.get();
  }

  async save() {
    // 临时文件 + rename 原子替换，避免进程崩溃截断 settings.json
    const tmp = `${this.file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;  // 随机后缀：并发 PUT 固定 tmp 名 rename 竞速 ENOENT
    await writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });  // 含明文 token/apiKey：仅属主可读
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.file);
  }

  onChange(w) { this._watchers.push(w); }

  /** 校验 baseUrl：仅允许 http(s)，防 SSRF 凭证外带（改指外站收割 apiKey） */
  _checkBaseUrl(baseUrl) {
    let u;
    try { u = new URL(baseUrl); } catch { throw new Error("baseUrl 不是合法 URL"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("baseUrl 仅支持 http/https");
    return u;
  }

  /** 从端点拉取模型列表（OpenAI 兼容 /models） */
  async fetchModels() {
    const { baseUrl, apiKey } = this.data;
    if (!baseUrl) throw new Error("未配置 baseUrl");
    this._checkBaseUrl(baseUrl);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {},
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`拉取模型失败 HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const j = await res.json();
    const list = (j.data || j.models || []).map((m) => m.id || m.model || m).filter(Boolean);
    return list;
  }

  /** 测试端点连通性（发一条最小 chat 请求） */
  async testEndpoint(modelId) {
    const { baseUrl, apiKey } = this.data;
    if (!baseUrl) throw new Error("未配置 baseUrl");
    this._checkBaseUrl(baseUrl);
    const model = modelId || this.data.defaultModel || this.data.models?.[0]?.id;
    if (!model) throw new Error("未指定测试模型");
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "回复OK" }], max_tokens: 8 }),
      signal: AbortSignal.timeout(60000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    return { ok: true, model, sample: body.slice(0, 150) };
  }
}
