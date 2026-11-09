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
 *  - tools: ["read","grep","find","ls","submit_review"] 为允许清单（只读审查，不给 edit/write）
 *    注意：SDK 中 tools 白名单同时管 customTools 的注册——不在名单里的自定义工具会被
 *    _isAllowedTool 静默过滤（不报错、模型完全看不到），故 submit_review 必须显式列入 tools
 *  - SessionManager.inMemory() 避免在工作目录落 session 文件
 *  - 事件：tool_execution_start 计数；message_end(assistant) 累计 token usage
 *  - 结束后 session.dispose() 释放资源
 */
import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { ModelRuntime, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
// 纯函数部分拆到 pi-models.js（零 SDK 依赖）：测试/CI 可离线导入，不必安装 pi SDK 树
import { PiRunnerError, buildModelsJson } from "./pi-models.js";
import { createSubmitReviewTool } from "./submit-review-tool.js";
import { normalizeReport } from "./report-schema.js";

export { PiRunnerError, buildModelsJson };

/** 同会话交卷纠正提示（未调 submit_review / 非 JSON 时追加一轮 prompt） */
export const FORMAT_RETRY_NUDGE =
  "（注意：上一次输出不是合法审查报告。请立即调用 submit_review 工具提交完整报告对象；若必须文本输出，只输出 JSON 本体，不要任何其他文字，也不要再调用其它工具。）";

/**
 * 本轮是否已具备可交付产物：submit_review 对象，或文本可 normalize 为报告。
 * 供同会话 nudge 循环与单测使用。
 */
export function isDeliveryReady(out, { wantSubmitTool = true } = {}) {
  if (!out || typeof out !== "object") return false;
  if (wantSubmitTool && out.submittedReport && typeof out.submittedReport === "object") return true;
  const text = typeof out.text === "string" ? out.text.trim() : "";
  if (!text) return false;
  try { normalizeReport(text); return true; }
  catch { return false; }
}

/**
 * 只读审查允许的工具（白名单，其余一律不给）。
 * 注意：不含 bash——任意 shell 可写文件/访问网络，diff 提示注入可诱导模型读 settings.json 外传凭证。
 * read/grep/find/ls 已覆盖代码查证需求（模型可 read PR.diff 与仓库源码）。
 */
export const REVIEW_TOOLS = ["read", "grep", "find", "ls"];

/**
 * 传给 SDK 的完整工具允许清单：内置只读工具 + submit_review。
 * SDK 语义：tools 里的普通名既决定默认启用集，也是 allowedToolNames 白名单；
 * customTools 中不在白名单内的工具会被 _isAllowedTool 静默丢弃（不报错、不注册、不进 system prompt），
 * 模型因此无法调用 submit_review，只能走文本输出兜底。submit_review 必须在名单里。
 */
export const SESSION_TOOLS = [...REVIEW_TOOLS, "submit_review"];

/**
 * 准备隔离的 pi agent 目录（models.json + auth.json）。
 * auth.json 为扁平结构：{ <providerId>: { type: "api_key", key: "..." } }
 */
export async function preparePiDir(settings, dataDir, sub = "") {
  // sub：隔离子目录（如 verifier）——多 PR 并行时不同端点/密钥的 models/auth 互不污染
  const agentDir = path.join(dataDir, sub ? `pi-home-${sub}` : "pi-home");
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
    // 非 SSE / 无 body：流不会消费，必须立刻 disarm，否则 30min 后空挂 abort
    clearTimeout(lifetime);
    return res;
  };
}

/**
 * 运行一轮 CR 会话。
 * @param {object} opts
 *   { settings, dataDir, workDir, systemPrompt, userPrompt, model, thinkingLevel, onEvent }
 * @returns {{ text: string, usage: object|null, toolCalls: number, submittedReport: object|null, earlyStopped: boolean, inSessionNudges: number }}
 */
export async function runCrTurn(opts) {
  const {
    settings, dataDir, workDir, systemPrompt, userPrompt, model: modelId, thinkingLevel = "high",
    onEvent, timeoutMs = 90 * 60 * 1000, agentDirSub = "", tools: allowedTools = SESSION_TOOLS,
    // 同会话格式纠正次数（首次 prompt 之外追加 nudge 的上限）；0=不纠正
    inSessionFormatRetries = 2,
    formatNudge = FORMAT_RETRY_NUDGE,
    onFormatRetry = null, // ({ attempt, text, reason }) => void
  } = opts;
  installMaxTokensHook();

  const agentDir = await preparePiDir(settings, dataDir, agentDirSub);
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

  // 3) 创建会话：工具白名单可配（verifier 复核会话不装 submit_review，文本 JSON 交付）
  //    submit_review（constrainedSampling strict:prefer + terminate）仅 CR 交付会话创建
  const wantSubmitTool = allowedTools.includes("submit_review");
  let submittedReport = null;
  const submitReviewTool = wantSubmitTool ? createSubmitReviewTool({
    workDir,
    bundleIdx: opts.bundleIdx,  // 分桶号：报告分文件落盘（report-bundle-<idx>.json），并行桶互不覆盖
    onSubmitted: (rep) => { submittedReport = rep; },
  }) : null;
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel,
    tools: allowedTools,
    customTools: submitReviewTool ? [submitReviewTool] : [],
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
  let earlyStopped = false;  // 文本通道流式早停：首个 { 平衡闭合即标记，尾部不入报告
  let lastAssistantSnapshot = null; // 空响应排障：保留最近一轮 assistant 的 parts 摘要（dispose 前）
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
      // 流式早停标记：message_update 增量文本中首个 { 已括号平衡闭合 → 报告已完整。
      // 不直接 abort 流（会丢 usage 与正常收尾）——只标记，最终文本提取时截到闭合点，
      // 尾部 token 丢弃；normalizeReport 的平衡扫描作最终兜底
      if (event?.type === "message_update" && !earlyStopped) {
        try {
          const texts = (event.message?.content || []).filter((c) => c && c.type === "text").map((c) => c.text).filter(Boolean);
          const acc = texts.join("");
          const s = acc.indexOf("{");
          if (s >= 0) {
            let depth = 0, inStr = false, esc = false;
            for (let i = s; i < acc.length; i++) {
              const ch = acc[i];
              if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
                continue;
              }
              if (ch === '"') inStr = true;
              else if (ch === "{") depth++;
              else if (ch === "}") { depth--; if (depth === 0) { earlyStopped = true; break; } }
            }
          }
        } catch { /* 早停扫描失败不阻塞主流程 */ }
      }
      if (event?.type === "message_end" && event.message?.role === "assistant") {
        addUsage(event.message.usage);
        const texts = (event.message.content || []).filter((c) => c && c.type === "text").map((c) => c.text).filter(Boolean);
        if (texts.length) eventTexts = texts;   // 覆盖式：保留最新一轮 assistant 文本
        lastAssistantSnapshot = snapshotAssistantMessage(event.message);
      }
      if (onEvent) onEvent(event);
    } catch { /* 事件解析失败不阻塞 */ }
  });

  // 5) 执行：同会话内可多次 prompt（交卷失败则 nudge），整体超时覆盖整段会话
  let timeoutHandle = null;
  let out = null;
  let inSessionNudges = 0;
  const extractOut = () => {
    // 优先用事件流累积的文本；早停时截到闭合点；退回读 session.state.messages
    let finalText = "";
    if (eventTexts.length) {
      finalText = eventTexts.join("\n");
      if (earlyStopped) finalText = truncateAtBalancedClose(finalText);
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
    if (!lastAssistantSnapshot) {
      const msgs = session.state?.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i]?.role === "assistant") { lastAssistantSnapshot = snapshotAssistantMessage(msgs[i]); break; }
      }
    }
    return {
      text: finalText,
      usage,
      toolCalls,
      submittedReport,
      earlyStopped,
      lastAssistant: lastAssistantSnapshot,
      inSessionNudges,
    };
  };
  const promptOnce = async (promptText) => {
    // 必须在 prompt 前清空本轮文本，避免与异步 message_update 竞态丢/串文本
    eventTexts = [];
    earlyStopped = false;
    lastAssistantSnapshot = null;
    const turn = (async () => {
      await session.prompt(promptText);
      await session.waitForIdle();
    })();
    turn.catch(() => {});
    await turn;
    return extractOut();
  };
  try {
    const timer = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new PiRunnerError(`审查会话超时（${Math.round(timeoutMs / 60000)} 分钟）`)), timeoutMs);
      timeoutHandle.unref?.();
    });
    const work = (async () => {
      out = await promptOnce(userPrompt);
      // 同会话纠正：未交卷且文本也不是报告 → 追加 nudge（保留工具轨迹，避免冷启动重读）
      const maxNudges = wantSubmitTool ? Math.max(0, Number(inSessionFormatRetries) || 0) : 0;
      while (out && !isDeliveryReady(out, { wantSubmitTool }) && inSessionNudges < maxNudges) {
        inSessionNudges++;
        try {
          await onFormatRetry?.({
            attempt: inSessionNudges,
            text: out.text || "",
            reason: "in-session-format-retry",
          });
        } catch { /* 回调失败不阻断纠正 */ }
        out = await promptOnce(formatNudge);
        out.inSessionNudges = inSessionNudges;
      }
    })();
    await Promise.race([work, timer]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { unsubscribe(); } catch { /* ignore */ }
    // 先 abort 中断底层 LLM 请求（避免超时后仍在计费），再 dispose 释放资源；
    // abort 与 10s grace 竞速：长跑工具（grep/find 大仓库）收尾慢时不让 finally 挂死、架空会话超时
    try { await Promise.race([session.abort?.() ?? Promise.resolve(), new Promise((r) => { const t = setTimeout(r, 10000); t.unref?.(); })]); } catch { /* ignore */ }
    try { session.dispose(); } catch { /* ignore */ }
  }

  if (!out || (!out.text && !(wantSubmitTool && out?.submittedReport))) {
    const err = new PiRunnerError("模型未返回任何文本且未调用 submit_review（检查端点/密钥/模型是否可用；若此前有 parse-fail，可能为重试轮会话异常，可重试整个审查）");
    err.diagnostics = {
      toolCalls,
      usage,
      earlyStopped,
      submittedReport: !!(out && out.submittedReport),
      lastAssistant: out?.lastAssistant || lastAssistantSnapshot,
      inSessionNudges,
    };
    err.deliveryFailed = true; // 允许 workflow 再冷启动一次
    throw err;
  }
  out.inSessionNudges = inSessionNudges;
  return out;
}

/** 排障用：摘要 assistant message 的 content parts（截断正文，避免 progress 膨胀） */
export function snapshotAssistantMessage(message, head = 800) {
  if (!message || typeof message !== "object") return null;
  const parts = Array.isArray(message.content) ? message.content : [];
  return {
    stopReason: message.stopReason || message.stop_reason || null,
    parts: parts.map((p) => {
      if (!p || typeof p !== "object") return { type: typeof p };
      const row = { type: p.type || "unknown" };
      if (typeof p.text === "string") {
        row.textLen = p.text.length;
        row.textHead = p.text.slice(0, head);
      }
      if (typeof p.thinking === "string") {
        row.thinkingLen = p.thinking.length;
        row.thinkingHead = p.thinking.slice(0, Math.min(head, 400));
      }
      if (p.name || p.toolName) row.toolName = p.name || p.toolName;
      if (p.id || p.toolCallId) row.toolCallId = p.id || p.toolCallId;
      return row;
    }),
  };
}

/** 文本截到首个括号平衡闭合点（字符串感知；无闭合点返回原文）——流式早停的截断工具 */
function truncateAtBalancedClose(text) {
  const s = text.indexOf("{");
  if (s < 0) return text;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return text.slice(s, i + 1); }
  }
  return text;
}
