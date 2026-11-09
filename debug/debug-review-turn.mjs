/**
 * 复现真实 CR turn 的"模型未返回任何文本"：真实 diff + 完整 message_end dump。
 * 用法：NODE_TLS_REJECT_UNAUTHORIZED=0 node debug/debug-review-turn.mjs
 */
import { Settings } from "../src/settings.js";
import { resolvePr } from "../src/pr-resolver.js";
import { runCrTurn } from "../src/engine/pi-runner.js";
import { buildSystemPrompt, buildFullReviewUserPrompt } from "../src/engine/prompts.js";
import { parseFiles, sliceDiff } from "../src/engine/bundler.js";
import { routeByFileTypes } from "../src/engine/routing.js";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const DATA = process.env.CR_AGENT_DATA || path.join(process.cwd(), "data");
const settings = (await Settings.load(DATA)).get();
console.log("[cfg]", settings.baseUrl, "| model:", settings.defaultModel);

const prUrl = "https://github.com/sindresorhus/is/pull/210";
console.log("[resolve] start");
const pr = await resolvePr(prUrl, settings);
console.log("[resolve] ok | diff chars:", (pr.diff || "").length, "| files:", (pr.meta?.filesChanged || []).length);

const files = parseFiles(pr.diff || "");
const promptCtx = {
  pr: { ...pr, title: pr.meta?.title || `PR #${pr.pr}`, filesChanged: files.map((f) => f.path), stat: pr.meta?.stat, commits: pr.meta?.commits, base: pr.meta?.base, head: pr.meta?.head },
  diff: pr.diff || "",
  round: 1,
  previousFindings: [],
  exempt: [],
  settings,
  routing: routeByFileTypes(files.map((f) => f.path)),
  teamRules: null,
};
const systemPrompt = buildSystemPrompt();
const userPrompt = buildFullReviewUserPrompt(promptCtx);
console.log("[prompt] system:", systemPrompt.length, "chars | user:", userPrompt.length, "chars");

let endCount = 0;
const workDir = await mkdtemp(path.join(tmpdir(), "cr238-"));
try {
  const { text, usage, toolCalls } = await runCrTurn({
    settings, dataDir: DATA, workDir,
    systemPrompt, userPrompt,
    model: settings.defaultModel, thinkingLevel: settings.defaultThinking || "high",
    timeoutMs: 600000,
    onEvent: (e) => {
      if (e?.type === "message_end") {
        endCount++;
        const m = e.message || {};
        if (m.role === "assistant") {
          console.log(`[msg_end #${endCount}] FULL:`, JSON.stringify({ stopReason: m.stopReason, usage: m.usage, content: m.content }).slice(0, 600));
        }
      }
      if (e?.type === "tool_execution_start") console.log("[tool] start");
    },
  });
  console.log("=== 成功 | text len:", text.length, "| toolCalls:", toolCalls);
  console.log("text 前200:", text.slice(0, 200));
} catch (e) {
  console.log("=== 失败:", String(e?.message || e).slice(0, 300));
}
process.exit(0);
