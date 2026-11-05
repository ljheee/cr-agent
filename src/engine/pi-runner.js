/**
 * pi-coding-agent 编程式封装
 *
 * 用 SDK 的 createAgentSession + session.prompt + waitForIdle 跑一轮 CR。
 * 模型通过 pi 的 models.json 自定义 provider 接入任意 OpenAI 兼容端点，
 * provider/模型/密钥全部从本应用的 settings 读取，设置页可改。
 *
 * 关键设计（对齐 pi-coding-agent@1.4.0 真实 SDK API）：
 *  - agentDir 隔离到本应用数据目录（models.json + auth.json），不污染用户 ~/.pi
 *  - ModelRuntime.create({ authPath, modelsPath }) 解析自定义 provider 的 Model 对象
 *  - appendSystemPrompt 通过 DefaultResourceLoader 注入（SDK 无 settings 选项）
 *  - tools: ["read","bash","grep","find","ls"] 为允许清单（只读审查，不给 edit/write）
 *  - SessionManager.inMemory() 避免在工作目录落 session 文件
 *  - 事件：tool_execution_start 计数；message_end(assistant) 累计 token usage
 *  - 结束后 session.dispose() 释放资源
 */
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
// 纯函数部分拆到 pi-models.js（零 SDK 依赖）：测试/CI 可离线导入，不必安装 pi SDK 树
import { PiRunnerError, buildModelsJson } from "./pi-models.js";

export { PiRunnerError, buildModelsJson };

/**
 * 只读审查允许的工具（白名单，其余一律不给）。
 * 注意：不含 bash——任意 shell 可写文件/访问网络，diff 提示注入可诱导模型读 settings.json 外传凭证。
 * read/grep/find/ls 已覆盖代码查证需求（模型可 read PR.diff 与仓库源码）。
 */
export const REVIEW_TOOLS = ["read", "grep", "find", "ls"];

/**
 * 准备隔离的 pi agent 目录（models.json + auth.json）。
 * auth.json 为扁平结构：{ <providerId>: { type: "api_key", key: "..." } }
 */
export async function preparePiDir(settings, dataDir) {
  const agentDir = path.join(dataDir, "pi-home");
  await mkdir(agentDir, { recursive: true });
  const models = buildModelsJson(settings);
  // 原子写（tmp+rename，随机后缀防并发 rename 竞速 ENOENT）：并发审查共享 pi-home
  const tmpSuffix = `.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const modelsTmp = path.join(agentDir, `models.json${tmpSuffix}.tmp`);
  await writeFile(modelsTmp, JSON.stringify(models, null, 2));
  await rename(modelsTmp, path.join(agentDir, "models.json"));
  const providerId = settings.providerId || "custom";
  const auth = { [providerId]: { type: "api_key", key: settings.apiKey || "" } };
  const authTmp = path.join(agentDir, `auth.json${tmpSuffix}.tmp`);
  await writeFile(authTmp, JSON.stringify(auth, null, 2), { mode: 0o600 });  // 含明文 apiKey：仅属主可读（tmp 同权限）
  await rename(authTmp, path.join(agentDir, "auth.json"));
  return agentDir;
}

/**
 * max_tokens 注入钩子（只装一次）：
 * 部分 OpenAI 兼容网关在请求未带 max_tokens 时用极小默认值（实测 1024），
 * thinking=high 的推理 token 会把预算吃光（stopReason=length、正文为空）。
 * pi-ai 的 openai-completions 仅在请求级 options.maxTokens 时发送该字段，
 * models.json 的 model.maxTokens 只作思考预算钳制上限、不会发出，agent 层也无入口透传，
 * 故用 fetch 钩子给发往 chat/completions 的请求体补 max_tokens（取 models.json 的 model.maxTokens，缺省 65536）。
 */
let maxTokensHookInstalled = false;
function installMaxTokensHook() {
  if (maxTokensHookInstalled) return;
  maxTokensHookInstalled = true;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    try {
      if (init?.body && typeof init.body === "string" && url.includes("/chat/completions")) {
        const body = JSON.parse(init.body);
        // 部分网关只认 max_tokens，忽略 OpenAI 新字段 max_completion_tokens（实测按默认 1024 截断）：
        // 统一改写为 max_tokens；缺省时取 65536
        if (!body.max_tokens) {
          body.max_tokens = body.max_completion_tokens || 65536;
          delete body.max_completion_tokens;
          init = { ...init, body: JSON.stringify(body) };
        }
      }
    } catch { /* body 非 JSON 时按原样发送 */ }
    // 响应头超时：网关偶发"发出后连响应头都不回"（半开挂死），
    // 120 秒未收到响应头即中断，让本轮快速失败并可被上层重试
    const ctrl = new AbortController();
    if (init?.signal) {
      if (init.signal.aborted) ctrl.abort(init.signal.reason);
      else init.signal.addEventListener("abort", () => ctrl.abort(init.signal.reason), { once: true });
    }
    const headerTimer = setTimeout(() => ctrl.abort(new PiRunnerError("模型请求 120 秒未收到响应，疑似连接挂死，已主动中断")), 120000);
    headerTimer.unref?.();
    let res;
    try {
      res = await origFetch(input, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(headerTimer);
    }
    // 整体硬超时：不设短的上限——最终报告长流（thinking high + 大 maxTokens）本身可能超过 10 分钟，
    // 固定短超时会把正常流掐进“杀死→重启”死循环（实测 6 次重启无法收敛）。
    // 挂死防护交给 60 秒空闲中断（真断流 1 分钟内必触发）；30 分钟仅作极端兜底。
    const lifetime = setTimeout(() => ctrl.abort(new PiRunnerError("模型请求超过 30 分钟未完成，已主动中断")), 1800000);
    lifetime.unref?.();
    if (url.includes("/chat/completions") && res.status === 200 && res.body) {
      // SSE 空闲中断：流式生成期间 chunk 间隔为亚秒级，60 秒无新数据必为链路静默掐断。
      // 不用 controller.error()（经实验传播不可靠），统一走 ctrl.abort —— 传输层 abort
      // 必然让底层流报错并传播到读取侧，SDK 会重启 agent 循环快速重试。
      const abortIdle = () => ctrl.abort(new PiRunnerError("模型 SSE 流 60 秒无新数据，疑似链路静默掐断，已主动中断"));
      let idle = setTimeout(abortIdle, 60000);
      idle.unref?.();
      const resetIdle = () => { clearTimeout(idle); idle = setTimeout(abortIdle, 60000); idle.unref?.(); };
      const finish = () => { clearTimeout(idle); clearTimeout(lifetime); };
      const ts = new TransformStream({
        // start 即 arm：覆盖“响应头已回但 body 一个字节都不来”的挂死形态
        start() { resetIdle(); },
        transform(chunk, controller) { resetIdle(); controller.enqueue(chunk); },
        flush() { finish(); },
        cancel() { finish(); },
      });
      return new Response(res.body.pipeThrough(ts), res);
    }
    return res;
  };
}

/**
 * 运行一轮 CR 会话。
 * @param {object} opts
 *   { settings, dataDir, workDir, systemPrompt, userPrompt, model, thinkingLevel, onEvent }
 * @returns {{ text: string, usage: object|null, toolCalls: number }}
 */
export async function runCrTurn(opts) {
  const { settings, dataDir, workDir, systemPrompt, userPrompt, model: modelId, thinkingLevel = "high", onEvent, timeoutMs = 90 * 60 * 1000 } = opts;
  installMaxTokensHook();

  const agentDir = await preparePiDir(settings, dataDir);
  // 任务文件落盘（模型可用 read 工具查看）
  await writeFile(path.join(workDir, "CR_TASK.md"), userPrompt);

  // 1) ModelRuntime：从隔离目录读 models.json / auth.json，解析自定义 provider 的 Model 对象
  const providerId = settings.providerId || "custom";
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
  });
  const model = modelRuntime.getModel(providerId, modelId);
  if (!model) {
    throw new PiRunnerError(`模型 ${providerId}/${modelId} 不在 models.json 中，请检查设置页模型列表`);
  }

  // 2) ResourceLoader：appendSystemPrompt 注入 CR 系统提示词（SDK 唯一官方途径）
  const settingsManager = SettingsManager.create(workDir, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    settingsManager,
    appendSystemPrompt: [systemPrompt],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  // 3) 创建会话：只读工具白名单 + 内存会话（不落 session 文件）
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    tools: REVIEW_TOOLS,
    resourceLoader,
    sessionManager: SessionManager.inMemory(workDir),
  });

  // 4) 收集事件：工具调用计数 + assistant message usage 累计
  //    finalText 直接从事件流累积（message_end 时抓 text part），
  //    不依赖事后读 session.state.messages——长会话（大量工具循环）后
  //    二次 prompt 的会话状态可能异常，事件流仍可靠
  let toolCalls = 0;
  let usage = null;
  let eventTexts = [];   // 最近一轮 assistant 的 text parts（新 prompt 开始时清空）
  const addUsage = (u) => {
    if (!u || typeof u !== "object") return;
    if (!usage) usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, turns: 0 };
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
      if (typeof u[k] === "number") usage[k] += u[k];
    }
    usage.turns += 1;
    usage.total = (usage.input || 0) + (usage.output || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0);
  };
  const unsubscribe = session.subscribe((event) => {
    try {
      if (event?.type === "tool_execution_start") toolCalls++;
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        addUsage(event.message.usage);
        const texts = (event.message.content || []).filter((c) => c && c.type === "text").map((c) => c.text).filter(Boolean);
        if (texts.length) eventTexts = texts;   // 覆盖式：保留最新一轮 assistant 文本
      }
      if (onEvent) onEvent(event);
    } catch { /* 事件解析失败不阻塞 */ }
  });

  // 5) 执行（带整体超时，防 agent 会话挂死占住资源）+ 提取最终 assistant 文本
  let timeoutHandle = null;
  let out = null;
  try {
    const turn = (async () => {
      await session.prompt(userPrompt);
      await session.waitForIdle();
    })();
    // 预挂 catch：超时后 turn 仍在运行，若后续 reject（dispose 触发）无观察者会 crash 进程
    turn.catch(() => {});
    eventTexts = [];   // 新一轮 prompt：清空上一轮的累积文本
    const timer = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new PiRunnerError(`审查会话超时（${Math.round(timeoutMs / 60000)} 分钟）`)), timeoutMs);
      timeoutHandle.unref?.();
    });
    await Promise.race([turn, timer]);
    // 优先用事件流累积的文本（会话状态异常时仍可靠）；退回读 session.state.messages
    let finalText = "";
    if (eventTexts.length) {
      finalText = eventTexts.join("\n");
    } else {
      const msgs = session.state?.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === "assistant" && Array.isArray(m.content)) {
          const texts = m.content.filter((c) => c && c.type === "text").map((c) => c.text);
          if (texts.length) { finalText = texts.join("\n"); break; }
        }
      }
    }
    out = { text: finalText, usage, toolCalls };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { unsubscribe(); } catch { /* ignore */ }
    // 先 abort 中断底层 LLM 请求（避免超时后仍在计费），再 dispose 释放资源；
    // abort 与 10s grace 竞速：长跑工具（grep/find 大仓库）收尾慢时不让 finally 挂死、架空会话超时
    try { await Promise.race([session.abort?.() ?? Promise.resolve(), new Promise((r) => { const t = setTimeout(r, 10000); t.unref?.(); })]); } catch { /* ignore */ }
    try { session.dispose(); } catch { /* ignore */ }
  }

  if (!out.text) throw new PiRunnerError("模型未返回任何文本（检查端点/密钥/模型是否可用；若此前有 parse-fail，可能为重试轮会话异常，可重试整个审查）");
  return out;
}
