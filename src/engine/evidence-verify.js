/**
 * 证据程序化核验（evidence snippet 回查）——对治「模型谎报 code-confirmed 换定级」
 *
 * 思路：worker 自报的 evidence_level 语义真实性无法由 LLM 自证，但 code_snippet
 * 声称来自源码——源码树就在 workDir/repo（withRepo 落盘），可程序化回查：
 * 提取 snippet 的实质代码行，在 finding.file 指定的源文件中查找；查不到 =
 * 证据与源码对不上 → 强制降 unverified（锚点规则表中 unverified 物理封顶 P2，
 * P0/P1 门禁自动收紧），并在 evidence_gap 留痕。
 *
 * 保守边界（避免误伤）：
 *  - code_snippet 为空（prompt 违规但无回查依据）→ 不降级，只计数
 *  - 文件定位失败 → 不降级（无法判定≠证伪），只计数
 *  - 回查在 applyAnchorSeverity 之前执行：降级后的 unverified 由规则表统一收敛
 */

import { readFile, stat, readdir } from "node:fs/promises";
import path from "node:path";

/** 从 code_snippet 提取实质代码行：仅剥真实行号形态（数字后紧跟 : 或 |）与 diff 符号，
 *  过滤过短与非代码行（保守：数字开头的真实代码行如 "500 * timeout" 不误剥） */
export function extractSnippetLines(snippet) {
  return String(snippet || "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*[:|]\s?/, "").replace(/^[+-]\s?/, "").trim())
    .filter((l) => l.length >= 12 && /[A-Za-z_$]/.test(l))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
}

/** 空白折叠（模型引用常把 tab 换空格/多空格压一行）：匹配两侧统一折叠后再比子串 */
const collapse = (s) => s.split(/\s+/).join(" ");

/** 定位 finding.file 对应的源文件候选：直接拼路径；失败按 basename 收集全部同名文件，
 *  路径后缀（目录链）一致者优先——同名不同目录（src/ vs test/fixtures/）不能只取首个 */
async function locateFile(repoDir, file) {
  const rel = String(file || "");
  const direct = path.join(repoDir, rel);
  try { if ((await stat(direct)).isFile()) return [direct]; } catch { /* fallback */ }
  const base = path.basename(rel);
  if (!base) return [];
  let visited = 0;
  const candidates = [];
  const walk = async (dir) => {
    if (visited++ > 5000 || candidates.length >= 20) return;   // 大仓库限量，防回查拖死管线
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        await walk(p);
      } else if (e.name === base) candidates.push(p);
    }
  };
  await walk(repoDir);
  // 排序：候选路径以 path.sep + file 相对路径为后缀的排前（path.sep 锚定：防 mysrc/ 误排 src/）
  const suffix = path.sep + rel.split("/").join(path.sep);
  return candidates.sort((a, b) => Number(b.endsWith(suffix)) - Number(a.endsWith(suffix)));
}

/**
 * 对整份报告做 snippet 回查。返回统计（写入报告 _snippet_check 留痕）。
 * 未命中 → evidence_level 强降 unverified（原值留 _evidence_level_model，审计对照）。
 */
export async function verifySnippets(report, repoDir) {
  const stats = { enabled: !!repoDir, checked: 0, missed: 0, unlocatable: 0, emptySnippet: 0, notes: [] };
  if (!repoDir || !Array.isArray(report.findings)) return stats;
  const textCache = new Map();   // 同名多候选场景多个 finding 共读同文件：缓存整文件文本
  for (const f of report.findings) {
    const lines = extractSnippetLines(f.code_snippet);
    if (!lines.length) { stats.emptySnippet++; continue; }
    stats.checked++;
    const candidates = await locateFile(repoDir, f.file);
    if (!candidates.length) { stats.unlocatable++; continue; }
    // 多候选逐一尝试 + 空白折叠匹配：任一候选命中任一实质行即通过（宽松方向减误伤）
    let hit = false;
    for (const loc of candidates) {
      let fileText;
      if (textCache.has(loc)) fileText = textCache.get(loc);
      else {
        try { fileText = await readFile(loc, "utf8"); } catch { continue; }
        textCache.set(loc, fileText);
      }
      const hay = collapse(fileText);
      if (lines.some((l) => hay.includes(collapse(l)))) { hit = true; break; }
    }
    if (hit) continue;
    f._evidence_level_model = f.evidence_level;
    f.evidence_level = "unverified";
    f.evidence_gap = [f.evidence_gap, "snippet 回查未命中源码（程序化证据核验，防谎报升级）"].filter(Boolean).join("；");
    stats.missed++;
    stats.notes.push(`${f.id || "?"} 降 unverified`);
  }
  return stats;
}
