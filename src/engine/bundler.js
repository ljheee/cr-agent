/**
 * 文件分桶（File Bundling）—— ocr 式确定性分治层
 *
 * 吸收自 alibaba/open-code-review：每个文件桶一个 sub-agent（独立会话/隔离上下文），
 * 桶间天然可并发；token 成本下降源于桶级上下文隔离而非 Agent 数量。
 * 桶划分规则全部代码写死（不经模型），是"确定性工程 × Agent 混合"中的确定性一半：
 *   1. 路径基名相同（Foo.java + Foo.xml + message_en/_zh.properties）
 *   2. 逻辑与测试匹配（src/Foo.java + test/FooTest.java）
 *   3. 同目录聚簇 + 大小均衡（受每桶行数预算与桶数上限约束）
 * 另提供行号校验：finding 的 file:line 不在 diff hunk 范围内时回退到 hunk 头（位置漂移防线）。
 */

/** 解析 unified diff 中的文件与 hunk 信息 */
export function parseFiles(diff) {
  const files = [];
  let cur = null, newLine = 0;
  for (const line of String(diff || "").split("\n")) {
    // 兼容带引号的转义路径：diff --git "a/p with space" "b/p with space"
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (m) {
      cur = { path: m[2], oldPath: m[1], hunks: [], linesChanged: 0, addedLines: new Set() };
      newLine = 0; // 每文件重置（Bitbucket JSON 降级路径无 @@ 头，计数从文件头起）
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("\\")) continue; // \ No newline at end of file 标记：既非上下文也非变更，不推进 newLine
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) { newLine = Number(h[1]); cur.hunks.push({ newStart: newLine, newCount: h[2] === undefined ? 1 : Number(h[2]) }); continue; }
    // 变更行：排除 +++/--- 文件头；单独 "+" 与 "++x" 等真实内容行也计入
    if (/^\+(?!\+\+)/.test(line)) { cur.linesChanged++; cur.addedLines.add(newLine); newLine++; }
    else if (/^-(?!--)/.test(line)) { cur.linesChanged++; } // 删除行不推进新侧行号
    else newLine++; // 上下文行推进新侧行号
  }
  return files;
}

/** pre-existing 程序化判定辅助：finding 的 file:line 是否落在本次新增行（+ 行）上 */
export function isChangedLine(files, file, line) {
  const norm = (p) => String(p || "").replace(/^b\//, "").replace(/^\//, "");
  const f = files.find((x) => x.path === norm(file));
  if (!f || !Number.isInteger(line)) return null; // 文件不在 diff 中 / 行号无效 → 无法判定
  // 无 @@ 头的降级 diff（Bitbucket JSON 渲染）：行号 0 基且不可信，不做存量判定（与 validateFindingLine 同一信任模型）
  if (!f.hunks.length) return null;
  return f.addedLines.has(line); // true=新增行, false=上下文或删除行
}

/** 基名归一化：去扩展名、去语言惯用后缀（Test/Impl/Handler/Adapter 等）、i18n locale 后缀 */
export function baseName(p) {
  const segs = p.split("/");
  let name = segs[segs.length - 1];
  name = name.replace(/\.[^.]+$/, "");                       // 去主扩展名（.java/.ts/.xml...）
  name = name.replace(/[-_](zh[_-]?cn|zh|en[_-]?us|en|ja|ko|pt|es|fr|de)$/i, ""); // i18n locale 尾缀（message_zh / message-zh_CN）
  name = name.replace(/(Test|Tests|Impl|Handler|Adapter|Mapper|DAO|Dao)$/, ""); // 惯用后缀（大小写敏感：避免误伤 Latest/Contest/Protest）
  return name.toLowerCase();
}

/** 测试路径签名：test/Foo.java → foo（与 src/foo 匹配） */
function testSignature(p) {
  const m = /(^|\/)(test|tests|__tests__|spec)\/(.+)$/.exec(p);
  if (!m) return null;
  return baseName(m[3]);
}

/**
 * 文件分桶。
 * @param {Array} files parseFiles 产物
 * @param {object} opts { maxLinesPerBundle=800, maxBundles=8 }
 * @returns {Array<Array<{path}>>} 桶列表（每桶一组文件）
 */
export function bundleFiles(files, opts = {}) {
  const maxLines = opts.maxLinesPerBundle ?? 800;
  const maxBundles = opts.maxBundles ?? 8;
  if (!files.length) return [];

  // 规则 1+2：按归一化基名归并。两遍：
  //   第一遍：源码文件按 基名+近两级目录 建组（防不同目录同名误并）
  //   第二遍：测试文件按基名并入既有同基名源码组（跨目录：test/FooTest ↔ src/Foo），无对应则自成一组
  const groups = new Map(); // key → [{path, linesChanged}]
  const baseIndex = new Map(); // 基名 → 组 key（测试匹配用）
  for (const f of files) {
    if (testSignature(f.path)) continue;
    const base = baseName(f.path);
    const dir = f.path.split("/").slice(0, -1).slice(-2).join("/");
    const key = `b:${base}::${dir}`;
    if (!groups.has(key)) { groups.set(key, []); if (!baseIndex.has(base)) baseIndex.set(base, key); }
    groups.get(key).push(f);
  }
  for (const f of files) {
    const tsig = testSignature(f.path);
    if (!tsig) continue;
    const key = baseIndex.get(tsig) || `t:${tsig}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  let clusters = [...groups.values()];

  // 规则 3：预算约束——超行数预算的簇裂变，不足的簇向同目录合并
  // 先裂变
  const split = [];
  for (const cluster of clusters) {
    let cur = [], curLines = 0;
    for (const f of cluster) {
      if (cur.length && curLines + f.linesChanged > maxLines) { split.push(cur); cur = []; curLines = 0; }
      cur.push(f); curLines += f.linesChanged;
    }
    if (cur.length) split.push(cur);
  }
  clusters = split;

  // 桶数上限：超出时按"总行数最小"优先合并（保大拆小合）
  while (clusters.length > maxBundles) {
    clusters.sort((a, b) => a.reduce((s, f) => s + f.linesChanged, 0) - b.reduce((s, f) => s + f.linesChanged, 0));
    const a = clusters.shift(), b = clusters.shift();
    clusters.push([...a, ...b]);
  }
  return clusters.map((c) => c.map((f) => ({ path: f.path })));
}

/** 从 diff 中抽取只属于指定文件集合的 diff 片段（桶级 diff） */
export function sliceDiff(diff, paths) {
  const want = new Set(paths);
  const out = [];
  let cur = null, inWanted = false;
  for (const line of String(diff || "").split("\n")) {
    const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
    if (m) {
      inWanted = want.has(m[2]);
      if (inWanted) { out.push(line); cur = true; }
      continue;
    }
    if (inWanted) out.push(line);
  }
  return out.join("\n");
}

/**
 * 行号校验（吸收 ocr 位置漂移防线，工程化实现）：
 * finding.line 不在该文件任一 hunk 的 [newStart, newStart+新增行数] 范围内 → 回退 hunk 头。
 * @returns {{ file, line, originalLine, adjusted: boolean }}
 */
export function validateFindingLine(finding, files) {
  // 文件名归一化：模型常带 b/ 或 / 前缀，对齐 parseFiles 的相对路径
  const norm = (p) => String(p || "").replace(/^b\//, "").replace(/^\//, "");
  const f = files.find((x) => x.path === norm(finding.file));
  if (!f || !f.hunks.length || finding.line == null) {
    return { file: finding.file, line: finding.line, originalLine: finding.line, adjusted: false };
  }
  const line = Number(finding.line);
  if (Number.isInteger(line)) {
    const inside = f.hunks.some((h) =>
      line >= h.newStart && line < h.newStart + Math.max(h.newCount ?? countHunkLines(f, h), 1));
    if (inside) return { file: finding.file, line, originalLine: line, adjusted: false };
    // 越界回退：取距 finding.line 最近的 hunk 头（非首个 hunk，避免钉到错误位置）
    let nearest = f.hunks[0], best = Infinity;
    for (const h of f.hunks) {
      const d = Math.abs(h.newStart - line);
      if (d < best) { best = d; nearest = h; }
    }
    return { file: finding.file, line: nearest.newStart, originalLine: finding.line, adjusted: true };
  }
  return { file: finding.file, line: f.hunks[0].newStart, originalLine: finding.line, adjusted: true };
}

/** 兜底统计 hunk 新侧行数（parseFiles 已优先从 @@ 头记录 newCount，此处仅旧数据/缺失时近似） */
function countHunkLines(file, hunk) {
  const idx = file.hunks.indexOf(hunk);
  const next = file.hunks[idx + 1];
  if (next) return Math.max(next.newStart - hunk.newStart, 1);
  return 80; // 最后一个 hunk 保守取 80 行窗口
}

/**
 * Jaccard 相似度（字符 bigram + 分词 token 混合集，适配短中文标题），用于跨桶 findings 去重（吸收自 mira）。
 */
export function jaccardSimilarity(a, b) {
  const grams = (s) => {
    const t = String(s || "").toLowerCase();
    const set = new Set();
    for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
    // 词级 token（含中英混合：空格/标点分隔的英文词与标识符）
    for (const w of t.split(/[^a-z0-9_]+/)) if (w) set.add(`w:${w}`);
    return set;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jaccard = inter / (A.size + B.size - inter);
  // 包含度：交集占较短集合的比例——"同题不同详略"（短标题是长标题子集）时显著高于 Jaccard。
  // 仅在较短集合 ≥3 gram 时生效：极短标题几乎必然是任何长标题的子集，会误杀同文件不同问题
  const containment = Math.min(A.size, B.size) >= 3 ? inter / Math.min(A.size, B.size) : 0;
  return Math.max(jaccard, containment);
}

/** 跨桶 findings 去重：同文件且标题相似 → 合并（保留最严 severity 与更长证据，标 duplicate_of） */
const SEV_ORDER = ["P3", "P2", "P1", "P0"];
export function dedupeFindings(findings, threshold = 0.72) {
  const out = [];
  for (const f of findings) {
    const dup = out.find((o) =>
      o.file === f.file &&
      jaccardSimilarity(o.title, f.title) >= threshold);
    if (dup) {
      dup.duplicates = (dup.duplicates || 1) + 1;
      if (!f.duplicate_of) f.duplicate_of = dup.id || dup.title;
      // 合并取最严级别（防后桶 P0 被前桶 P2 吞掉）与更长证据
      if (SEV_ORDER.indexOf(f.severity) > SEV_ORDER.indexOf(dup.severity)) {
        dup.severity = f.severity;
        dup.evidence = (f.evidence || "").length > (dup.evidence || "").length ? f.evidence : dup.evidence;
      }
      continue;
    }
    f.duplicates = f.duplicates || 1;
    out.push(f);
  }
  return out;
}
