/**
 * 运行时配置（settings.json）
 * 模型端点：任意 OpenAI 兼容服务（如 https://api.openai.com/v1），在设置页配置；不默认指向任何特定服务
 * 凭证可为平台 API Key 或 token（Bearer）。模型列表支持自动拉取 + 手动管理。
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
  hostPlatforms: {},       // { host: platform } 自定义域名→平台映射（如 { "abc.com": "bitbucket" }），detectPlatform 优先于此
  sshHostMap: {},          // { webHost: sshHost } Web/API 域名→SSH git 主机（如 { "git.web.corp.com": "ssh.git.corp.com" }）
  gitScheme: "https",
  maxConcurrentReviews: 3,   // 全局并发审查闸（每单起 pi 会话 + 临时 git clone；设置页可调）
  bundleConcurrency: 1,      // 桶间并行度（单审内分桶 agent 并发数；1=串行保守，怕端点限流勿调高）
  maxRounds: 3,              // 同 PR 审查轮次上限（防无限重审烧 token；设置页可调）
  verifierEnabled: true,     // P0/P1 独立验证会话开关（复核证据链，防谎报定级）
  verifierBaseUrl: "",       // verifier 专属端点（空 = 兕底 worker baseUrl）
  verifierApiKey: "",        // verifier 专属 API Key（空 = 兕底 worker apiKey）
  verifierModel: "",         // verifier 专属模型（空 = 兕底 worker 默认模型）
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
    try {
      const text = await readFile(s.file, "utf8");
      try { s.data = { ...DEFAULTS, ...JSON.parse(text) }; }
      catch (e) {
        // 文件存在但损坏：不写回磁盘，仅内存回退默认并留痕（避免静默当「首次运行」丢凭证）
        console.warn(`[settings] ${s.file} 解析失败，使用默认值（未覆盖磁盘）: ${e.message}`);
        s._loadError = e.message;
      }
    } catch (e) {
      if (e?.code !== "ENOENT") console.warn(`[settings] 读取失败: ${e.message}`);
    }
    return s;
  }

  get() { return { ...this.data }; }

  async update(patch) {
    const allowed = ["baseUrl", "providerId", "providerName", "apiKey", "models", "defaultModel", "defaultThinking", "maxDiffChars", "usePlatformApi", "platformTokens", "hostPlatforms", "sshHostMap", "gitScheme", "maxConcurrentReviews", "bundleConcurrency", "maxRounds", "verifierEnabled", "verifierBaseUrl", "verifierApiKey", "verifierModel"];
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
    if (next.maxConcurrentReviews !== undefined) {
      if (!Number.isInteger(next.maxConcurrentReviews) || next.maxConcurrentReviews < 1 || next.maxConcurrentReviews > 20) throw new Error("maxConcurrentReviews 必须是 1~20 的整数");
    }
    if (next.bundleConcurrency !== undefined) {
      if (!Number.isInteger(next.bundleConcurrency) || next.bundleConcurrency < 1 || next.bundleConcurrency > 8) throw new Error("bundleConcurrency 必须是 1~8 的整数");
    }
    if (next.maxRounds !== undefined) {
      if (!Number.isInteger(next.maxRounds) || next.maxRounds < 1 || next.maxRounds > 20) throw new Error("maxRounds 必须是 1~20 的整数");
    }
    if (next.verifierEnabled !== undefined && typeof next.verifierEnabled !== "boolean") throw new Error("verifierEnabled 必须是布尔值");
    if (next.verifierBaseUrl) this._checkBaseUrl(next.verifierBaseUrl);
    if (next.verifierApiKey !== undefined && typeof next.verifierApiKey !== "string") throw new Error("verifierApiKey 必须是字符串");
    if (next.verifierModel !== undefined && typeof next.verifierModel !== "string") throw new Error("verifierModel 必须是字符串");
    if (next.gitScheme !== undefined && !["https", "http", "ssh"].includes(next.gitScheme)) throw new Error("gitScheme 仅支持 https/http/ssh");
    if (next.models !== undefined && !Array.isArray(next.models)) throw new Error("models 必须是数组");
    if (next.platformTokens !== undefined && (typeof next.platformTokens !== "object" || next.platformTokens === null || Array.isArray(next.platformTokens))) throw new Error("platformTokens 必须是对象");
    if (next.hostPlatforms !== undefined) {
      if (typeof next.hostPlatforms !== "object" || next.hostPlatforms === null || Array.isArray(next.hostPlatforms)) throw new Error("hostPlatforms 必须是对象");
      for (const [h, p] of Object.entries(next.hostPlatforms)) {
        if (!/^[a-z0-9.-]+$/i.test(h)) throw new Error(`hostPlatforms 域名不合法: ${h}`);
        if (!["github", "gitlab", "bitbucket"].includes(p)) throw new Error(`hostPlatforms 平台仅支持 github/gitlab/bitbucket: ${p}`);
      }
    }
    if (next.sshHostMap !== undefined) {
      if (typeof next.sshHostMap !== "object" || next.sshHostMap === null || Array.isArray(next.sshHostMap)) throw new Error("sshHostMap 必须是对象");
      // host 可带端口（GHE/自建常见 git.corp:7999 → ssh.corp:22）
      const hostRe = /^[a-z0-9.-]+(?::\d+)?$/i;
      for (const [from, to] of Object.entries(next.sshHostMap)) {
        if (!hostRe.test(from)) throw new Error(`sshHostMap 源域名不合法: ${from}`);
        if (typeof to !== "string" || !hostRe.test(to)) throw new Error(`sshHostMap 目标域名不合法: ${to}`);
      }
    }
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
