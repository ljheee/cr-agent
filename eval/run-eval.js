/**
 * ReviewBench 式离线评测（吸收清单 P1：改 prompt/换模型必跑，防回归）
 *
 * 方法论（吸收 Multica/ReviewBench 一手经验）：
 *  - 断言优先 > LLM judge > 人工：golden findings 按 file + line 区间精确匹配，message 不判（模糊 judge 打分就低）
 *  - 指标：precision / recall / F1（位置维度）
 *  - 用法：node eval/run-eval.js [--self-check]；带 --report <报告.json> --fixture <name> 时做 golden 打分
 *    （模型输出的报告 JSON 可从 data/reports/ 取，或由外部脚本驱动 workflow 产出后传入）
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeReport } from "../src/engine/report-schema.js";
import { parseFiles, isChangedLine } from "../src/engine/bundler.js";
import { routeByFileTypes } from "../src/engine/routing.js";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 载入 fixtures：每个 .json = { name, diff, golden: [{file, line, line_end?, category, producer}] } */
function loadFixtures() {
  return readdirSync(path.join(EVAL_DIR, "fixtures"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(path.join(EVAL_DIR, "fixtures", f), "utf8")));
}

/** 位置匹配：finding.file 相同且 line 落在 [golden.line, golden.line_end||line] 区间内 */
function locationMatch(f, g) {
  const norm = (p) => String(p || "").replace(/^b\//, "").replace(/^\//, "");
  if (norm(f.file) !== norm(g.file)) return false;
  if (f.line == null) return false; // Number(null)=0 且 isInteger(0)=true，会误匹配 line≥0 的 golden 区间
  const l = Number(f.line);
  if (!Number.isInteger(l)) return false;
  const end = g.line_end ?? g.line;
  return l >= g.line && l <= end;
}

/** 打分：assertion-first，仅位置维度 */
export function score(fixture, report) {
  const findings = report.findings || [];
  const golds = fixture.golden || [];
  const matched = new Set();
  let tp = 0;
  for (const g of golds) {
    const idx = findings.findIndex((f, i) => !matched.has(i) && locationMatch(f, g));
    if (idx >= 0) { tp++; matched.add(idx); }
  }
  const precision = findings.length ? tp / findings.length : 0;
  const recall = golds.length ? tp / golds.length : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { name: fixture.name, tp, goldens: golds.length, predicted: findings.length, precision: +precision.toFixed(2), recall: +recall.toFixed(2), f1: +f1.toFixed(2) };
}

/** 确定性自检（无需模型）：golden 合法性（必须指向新增行）+ diff 链路 + 路由命中 */
export function selfCheck() {
  const fixtures = loadFixtures();
  const results = [];
  for (const fx of fixtures) {
    const files = parseFiles(fx.diff);
    const errs = [];
    if (!files.length) errs.push("diff 解析不出文件");
    for (const g of fx.golden || []) {
      const onAdded = isChangedLine(files, g.file, g.line);
      if (onAdded !== true) errs.push(`golden ${g.file}:${g.line} 不在新增行上（isChangedLine=${onAdded}）——golden 必须指向本次引入`);
    }
    const routing = routeByFileTypes(files.map((f) => f.path));
    results.push({ name: fx.name, ok: errs.length === 0, errs, routing: routing.focusPerspectives });
  }
  return results;
}

// ── CLI（仅作为主模块运行时执行；被单测 import 时只暴露 selfCheck/score，不 process.exit） ──
// realpath+pathToFileURL：同时解决符号链接不对称与路径含 #/?/% 的编码差异
const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes("--report")) {
    const reportPath = args[args.indexOf("--report") + 1];
    const report = normalizeReport(readFileSync(reportPath, "utf8"));
    const fixtureName = args.includes("--fixture") ? args[args.indexOf("--fixture") + 1] : null;
    const fx = loadFixtures().find((f) => f.name === fixtureName) || loadFixtures()[0];
    console.log(JSON.stringify(score(fx, report), null, 2));
  } else {
    const checks = selfCheck();
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}  路由: ${c.routing.join(",") || "(无命中)"}`);
      for (const e of c.errs) console.log(`    - ${e}`);
    }
    const bad = checks.filter((c) => !c.ok).length;
    console.log(bad ? `\n${bad} 个 fixture 自检失败` : `\n${checks.length} 个 fixture 自检全部通过（golden 合法 + 链路确定性 OK）`);
    process.exit(bad ? 1 : 0);
  }
}
