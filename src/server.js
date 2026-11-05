/**
 * CR-Agent 服务端
 *  - POST /api/review        提交 PR 链接触发 CR（进度轮询 /api/review/:id/progress；sync 可选）
 *  - GET  /api/settings      读取设置（apiKey 脱敏）
 *  - PUT  /api/settings      更新设置
 *  - POST /api/settings/models/fetch   从端点拉取模型列表
 *  - POST /api/settings/test 端点连通性测试
 *  - GET  /api/reports       报告列表
 *  - GET  /api/reports/:id   报告详情
 *  - GET  /api/ledger        PR 账本（问题闭环/豁免）
 *  - POST /api/ledger/exempt 豁免问题
 *  - GET  /api/perspectives  视角清单（设置页展示）
 */
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";
import { Settings } from "./settings.js";
import { CrWorkflow } from "./engine/workflow.js";
import { withPrLock } from "./engine/workflow.js";
import { Ledger } from "./engine/ledger.js";
import { PERSPECTIVES } from "./engine/perspectives.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.CR_AGENT_DATA || path.join(__dirname, "..", "data");
const PORT = process.env.PORT || 3777;

const settings = await Settings.load(DATA_DIR);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const ongoing = new Map(); // reviewId -> {events:[], done, result}
// 事件数上限：长会话/多桶时 agent-event 可达数万条，每次轮询全量返回会膨胀；超限后丢弃新 agent-event（仅计数）。
// 2000 实测会在 1 分钟内打满，进度接口“装死”被误判为断流；放宽到 30000（约 6MB，本机/内网可接受）
const MAX_EVENTS = 30000;
const MAX_CONCURRENT_REVIEWS = 3;  // 全局并发审查闸（每单起 pi 会话 + 临时 git clone）

// ── 触发 CR ──
app.post("/api/review", async (req, res) => {
  const { url, forceFull, model, thinking, trigger } = req.body || {};
  if (typeof url !== "string" || !url.trim()) return res.status(400).json({ error: "缺少 PR 链接" });
  // 全局并发闸：每单起 pi 会话 + 临时 git clone，无上限会把主机资源打穿
  if ([...ongoing.values()].filter((s) => !s.done).length >= MAX_CONCURRENT_REVIEWS) {
    return res.status(429).json({ error: `并发审查已达上限（${MAX_CONCURRENT_REVIEWS}），请稍后再试` });
  }
  const reviewId = `rv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const events = [];
  const state = { events, done: false, result: null, error: null };
  ongoing.set(reviewId, state);
  // 完成后定时清理，避免长期运行内存无限增长
  const cleanup = () => { const t = setTimeout(() => ongoing.delete(reviewId), 2 * 60 * 60 * 1000); t.unref?.(); };

  const wf = new CrWorkflow({
    dataDir: DATA_DIR,
    settings,
    emit: (e) => {
      if (events.length >= MAX_EVENTS) {
        if (e.stage === "agent-event") { state.agentEventsDropped = (state.agentEventsDropped || 0) + 1; return; }
        // 非 agent-event 的重要阶段事件仍保留，但挤掉最老的 agent-event 腾位
        const firstAgentIdx = events.findIndex((x) => x.stage === "agent-event");
        if (firstAgentIdx >= 0) events.splice(firstAgentIdx, 1);
        else return; // 全是关键事件也满了：丢弃新事件
      }
      events.push({ at: new Date().toISOString(), ...e });
    },
  });

  const finish = async () => {
    await wf.run(url.trim(), { forceFull, model, thinking, trigger }).then(
      (r) => { state.done = true; state.result = r; },
      (e) => { state.done = true; state.error = e?.message || String(e); state.errorStatus = e?.status; },
    );
    cleanup();
  };

  if (req.body?.sync) {
    await finish();
    if (state.error) return res.status(state.errorStatus || 500).json({ reviewId, error: state.error });
    return res.json({ reviewId, ...state.result });
  }
  finish(); // 异步执行，进度走 /api/review/:id/progress
  res.json({ reviewId });
});

// ── 进度查询 ──
app.get("/api/review/:id/progress", (req, res) => {
  const s = ongoing.get(req.params.id);
  if (!s) return res.status(404).json({ error: "unknown review 或已过期清理（10 分钟）" });
  res.json({ events: s.events, done: s.done, error: s.error, errorStatus: s.errorStatus, reportId: s.result?.reportId, agentEventsDropped: s.agentEventsDropped || 0 });
});

// ── 设置 ──
const maskKey = (k) => (k ? `••••${k.slice(-4)}（${k.length}字符）` : "");
const MASK = "****";
const maskTokens = (t) => Object.fromEntries(Object.entries(t || {}).map(([h, v]) => [h, v ? MASK : ""]));

app.get("/api/settings", (req, res) => {
  const s = settings.get();
  res.json({ ...s, apiKey: maskKey(s.apiKey), hasApiKey: !!s.apiKey, platformTokens: maskTokens(s.platformTokens) });
});

app.put("/api/settings", async (req, res) => {
  try {
    const patch = { ...req.body };
    // 空字符串的 apiKey 视为不修改（避免脱敏值回写）
    if (!patch.apiKey) delete patch.apiKey;
    // 脱敏占位 **** 的平台 token 同样不回写，保留原值
    if (patch.platformTokens && typeof patch.platformTokens === "object") {
      const cur = settings.get().platformTokens || {};
      for (const [h, v] of Object.entries(patch.platformTokens)) {
        if (v === MASK) patch.platformTokens[h] = cur[h] || "";
      }
    }
    const s = await settings.update(patch);
    res.json({ ...s, apiKey: maskKey(s.apiKey), hasApiKey: !!s.apiKey, platformTokens: maskTokens(s.platformTokens) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/settings/models/fetch", async (req, res) => {
  try {
    let models = [];
    try { models = await settings.fetchModels(); }
    catch (e) {
      return res.status(502).json({ error: `端点拉取失败：${e.message}`, hint: "可在设置中手动添加模型" });
    }
    res.json({ models });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/settings/test", async (req, res) => {
  try { res.json(await settings.testEndpoint(req.body?.model)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ── 报告 ──
app.get("/api/reports", async (req, res) => {
  try {
    const dir = path.join(DATA_DIR, "reports");
    const files = await readdir(dir).catch(() => []);
    const list = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(await readFile(path.join(dir, f), "utf8"));
        list.push({
          id: f.replace(/\.json$/, ""), repo: j.pr?.repo, pr: j.pr?.number,
          conclusion: j.conclusion, round: j.review?.round, mode: j.review?.mode,
          model: j.review?.model, at: j.generated_at,
          findings: (j.findings || []).length,
          p0p1: (j.findings || []).filter((x) => x.severity === "P0" || x.severity === "P1").length,
        });
      } catch { /* 跳过坏文件 */ }
    }
    list.sort((a, b) => (b.at || "").localeCompare(a.at || ""));
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/reports/:id", async (req, res) => {
  const id = req.params.id;
  // 防路径穿越：只允许纯文件名（无路径分隔符、无 ..），并确保解析后仍在 reports 目录内
  if (!id || path.basename(id) !== id || id.includes("..") || /[\\/]/.test(id)) {
    return res.status(400).json({ error: "非法报告 ID" });
  }
  const f = path.join(DATA_DIR, "reports", `${id}.json`);
  if (path.dirname(f) !== path.join(DATA_DIR, "reports")) return res.status(400).json({ error: "非法报告 ID" });
  try {
    res.json(JSON.parse(await readFile(f, "utf8")));
  } catch { res.status(404).json({ error: "报告不存在" }); }
});

// ── 账本（问题闭环/豁免）──
app.get("/api/ledger", async (req, res) => {
  try {
    const { repo, pr } = req.query;
    // repo 白名单与 POST exempt 一致（Windows 部署下反斜杠可越目录）
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return res.status(400).json({ error: "repo 需形如 owner/name" });
    if (!repo || !pr) {
      // 全部账本统计
      const dir = path.join(DATA_DIR, "ledgers");
      const files = await readdir(dir).catch(() => []);
      const out = [];
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        try {
          const j = JSON.parse(await readFile(path.join(dir, f), "utf8"));
          const l = Object.assign(Object.create(Ledger.prototype), { data: j });
          out.push({ repo: j.repo, pr: j.pr, webUrl: j.webUrl, stats: l.stats(), rounds: j.rounds });
        } catch { /* skip */ }
      }
      return res.json(out);
    }
    const l = await Ledger.load(DATA_DIR, repo, Number(pr));
    res.json({ ...l.data, stats: l.stats() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/ledger/exempt", async (req, res) => {
  try {
    const { repo, pr, file, titleKeyword, reason, exemptedBy } = req.body || {};
    if (!repo || !pr || !(file || titleKeyword)) return res.status(400).json({ error: "需要 repo/pr 和豁免条件" });
    // repo 白名单：账本内容会回流前端 innerHTML 渲染，任意字符串构成存储 XSS 面
    if (!/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return res.status(400).json({ error: "repo 需形如 owner/name" });
    // 与审查同锁（repo#pr）：锁 key 用 parsePrUrl 同源规范化，防客户端传变体 repo（尾斜杠/大小写）绕过同一把锁
    const lockKey = normalizeLockKey(repo, pr);
    const result = await withPrLock(lockKey, async () => {
      const l = await Ledger.load(DATA_DIR, repo, Number(pr));
      l.addExempt({ file, title_keyword: titleKeyword, reason, exempted_by: exemptedBy });
      await l.save();
      return l.data.exempt;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/ledger/exempt", async (req, res) => {
  try {
    const { repo, pr, index } = req.body || {};
    const idx = Number(index);
    if (!repo || !pr || !Number.isInteger(idx) || idx < 0) return res.status(400).json({ error: "需要 repo/pr 和合法的 index" });
    // 与审查同锁（repo#pr，规范化 key 同上）
    const lockKey = normalizeLockKey(repo, pr);
    const result = await withPrLock(lockKey, async () => {
      const l = await Ledger.load(DATA_DIR, repo, Number(pr));
      if (idx >= l.data.exempt.length) throw Object.assign(new Error("index 超出范围"), { status: 400 });
      l.removeExempt(idx);
      await l.save();
      return l.data.exempt;
    });
    res.json(result);
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── 视角清单 ──
app.get("/api/perspectives", (req, res) => {
  res.json(PERSPECTIVES.map((p) => ({
    id: p.id, name: p.name, dimension: p.dimension, weight: p.weight, isNew: !!p.isNew,
  })));
});

// 锁 key 规范化：与 workflow.run 内 parsePrUrl 产出的 `${repo}#${pr}` 同构
// （客户端可能传带尾斜杠/大小写差异的 repo，直接拼会在两把不同的锁上互斥失效；
// 大小写不敏感文件系统（APFS/默认 Windows）下两个不同大小写的账本文件名实为同一文件，
// 并发读-改-写会丢失更新，统一小写归一）
function normalizeLockKey(repo, pr) {
  return `${String(repo || "").trim().replace(/\/+$/, "").toLowerCase()}#${Number(pr)}`;
}

// 默认只绑回环地址，避免无鉴权服务在内网暴露（可用 CR_AGENT_HOST=0.0.0.0 显式放开）
const HOST = process.env.CR_AGENT_HOST || "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`[CR-Agent] listening on http://${HOST}:${PORT}`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.log(`[CR-Agent] ⚠️ 服务无鉴权且已监听 ${HOST}：请确认部署环境可信，否则内网任何人都可提交审查/读取报告`);
  }
  console.log(`[CR-Agent] data dir: ${DATA_DIR}`);
  console.log(`[CR-Agent] model endpoint: ${settings.get().baseUrl || "(未配置，请到设置页填写)"} (models: ${(settings.get().models || []).length})`);
});
