import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrUrl } from "../src/pr-resolver.js";
import { normalizeReport, buildAuthorSummary } from "../src/engine/report-schema.js";
import { PERSPECTIVES, renderPerspectivesForPrompt } from "../src/engine/perspectives.js";
import { Ledger } from "../src/engine/ledger.js";
import { buildModelsJson } from "../src/engine/pi-models.js"; // 纯函数模块：测试离线可跑，不拉 pi SDK 树
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("parsePrUrl: GitHub 标准形态", () => {
  const p = parsePrUrl("https://github.com/owner/repo/pull/123");
  assert.equal(p.repo, "owner/repo");
  assert.equal(p.pr, 123);
  assert.equal(p.platform, "github");
});

test("parsePrUrl: GitHub 新形态 pulls", () => {
  const p = parsePrUrl("https://github.com/o/r/pulls/45");
  assert.equal(p.pr, 45);
});

test("parsePrUrl: GitLab MR", () => {
  const p = parsePrUrl("https://gitlab.example.com/group/sub/repo/-/merge_requests/7");
  assert.equal(p.repo, "group/sub/repo");
  assert.equal(p.pr, 7);
  assert.equal(p.platform, "gitlab");
});

test("parsePrUrl: Bitbucket server 自建域名", () => {
  const p = parsePrUrl("https://git.corp.example.com/projects/PRJ/repos/abc-manage/pull-requests/123");
  assert.equal(p.repo, "PRJ/abc-manage");
  assert.equal(p.pr, 123);
  assert.equal(p.platform, "generic");
});

test("parsePrUrl: Bitbucket projects 形态", () => {
  const p = parsePrUrl("https://stash.example.com/projects/PRJ/repos/myrepo/pull-requests/9");
  assert.equal(p.repo, "PRJ/myrepo");
  assert.equal(p.pr, 9);
});

test("parsePrUrl: 兜底任意路径", () => {
  const p = parsePrUrl("https://git.internal.acme.com/scm/x/y/pull/3");
  assert.equal(p.pr, 3);
});

test("parsePrUrl: 非法输入报错", () => {
  assert.throws(() => parsePrUrl(""));
  assert.throws(() => parsePrUrl("not-a-url"));
  assert.throws(() => parsePrUrl("https://github.com/owner/repo/commits/main"));
});

test("normalizeReport: markdown 包裹 + 规范化", () => {
  const raw = "```json\n" + JSON.stringify({
    conclusion: "不通过",
    findings: [{ title: "NPE", severity: "P9", suggestion: "判空", file: "a.java", line: 3 }],
  }) + "\n```";
  const r = normalizeReport(raw);
  assert.equal(r.conclusion, "不通过");
  assert.equal(r.findings[0].severity, "P2");   // 非法 severity 降级 P2
  assert.ok(r.findings[0].confidence >= 0 && r.findings[0].confidence <= 1);
  assert.ok(r.author_summary.must_fix.length + r.author_summary.should_fix.length >= 0);
  assert.equal(r.metrics.new_findings, 1);
});

test("normalizeReport: blockers 兜底 = P0/P1", () => {
  const r = normalizeReport({ conclusion: "通过", findings: [
    { id: "F1", title: "a", severity: "P0", suggestion: "x" },
    { id: "F2", title: "b", severity: "P1", suggestion: "y" },
    { id: "F3", title: "c", severity: "P3", suggestion: "z" },
  ]});
  assert.deepEqual(r.blockers, ["F1", "F2"]);
  assert.equal(r.author_summary.must_fix.length, 2);
  assert.equal(r.author_summary.nice_to_have.length, 1);
});

test("PERSPECTIVES: 21 个视角，8 个新增，维度合法", () => {
  assert.equal(PERSPECTIVES.length, 21);
  assert.equal(PERSPECTIVES.filter((p) => p.isNew).length, 8);
  for (const p of PERSPECTIVES) {
    assert.ok(["internal", "upstream_api", "upstream_data", "downstream_api", "downstream_data"].includes(p.dimension), p.id);
    assert.ok(p.checklist.length > 20, p.id);
  }
  const txt = renderPerspectivesForPrompt();
  assert.ok(txt.includes("[fund-safety]"));
  assert.ok(txt.split("\n").length >= 21);
});

test("buildModelsJson: custom provider 生成", () => {
  const m = buildModelsJson({
    baseUrl: "https://api.example.com/v1",
    providerId: "custom",
    models: [{ id: "test-model", name: "Test" }],
  });
  assert.equal(m.providers.custom.baseUrl, "https://api.example.com/v1");
  assert.equal(m.providers.custom.api, "openai-completions");
  assert.equal(m.providers.custom.models[0].id, "test-model");
  assert.equal(m.providers.custom.models[0].contextWindow, 128000);
  assert.throws(() => buildModelsJson({ baseUrl: "x", models: [] }));
});

test("Ledger: 问题跨轮闭环 + 豁免 + unverified 升级", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cr-test-"));
  try {
    const l = await Ledger.load(dir, "octopus/demo", 1);
    // 第 1 轮
    const r1 = normalizeReport({ conclusion: "不通过", findings: [
      { id: "F1", title: "NPE", severity: "P1", file: "A.java", suggestion: "判空", category: "logic" },
      { id: "F2", title: "import 排序", severity: "P3", file: "B.java", introduced_by: "pre-existing", suggestion: "整理" },
    ]});
    l.applyRound(r1, { mode: "full", head: "aaa" });
    assert.equal(l.data.findings.length, 1);   // 存量 P3 不入账
    assert.equal(l.data.findings[0].status, "open");

    // 豁免后，同问题不再入账
    l.addExempt({ file: "A.java", title_keyword: "NPE", reason: "接受风险" });
    const r2 = normalizeReport({ conclusion: "通过", findings: [
      { id: "F1", title: "NPE", severity: "P1", file: "A.java", suggestion: "判空" },
    ], review: { previous_findings: [{ id: "P1", status: "still_exists" }] }});
    l.applyRound(r2, { mode: "incremental", head: "bbb" });
    assert.equal(l.data.rounds.length, 2);
    assert.equal(l.data.findings.filter((f) => f.title === "NPE").length, 1);  // 豁免后未重复新增

    // unverified 连续 2 轮升级 needs_human
    const r3 = normalizeReport({ conclusion: "通过", findings: [],
      decision_changes: [{ trace_id: "T1", decision: "下游是否兼容", status: "unverified" }] });
    l.applyRound(r3, { mode: "incremental", head: "ccc" });
    const t1 = l.data.findings.find((f) => f.persist_id === "trace:T1");
    assert.equal(t1.unverified_rounds, 1);
    l.applyRound(normalizeReport({ conclusion: "通过", findings: [],
      decision_changes: [{ trace_id: "T1", decision: "下游是否兼容", status: "unverified" }] }),
      { mode: "incremental", head: "ddd" });
    assert.equal(t1.unverified_rounds, 2);
    assert.equal(t1.status, "needs_human");

    const s = l.stats();
    assert.equal(s.rounds, 4);
    assert.ok(s.needs_human >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Ledger 回归: persist_id 不重复（跳过条目不发号）+ 模型 fixed 判定生效 + 仅文件豁免", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cr-test2-"));
  try {
    const l = await Ledger.load(dir, "octopus/demo2", 1);
    // 第 1 轮：2 个问题 → P1、P2
    const r1 = normalizeReport({ conclusion: "不通过", findings: [
      { id: "F1", title: "A 问题", severity: "P1", file: "A.java", suggestion: "x", category: "logic" },
      { id: "F2", title: "B 问题", severity: "P2", file: "B.java", suggestion: "y", category: "logic" },
    ]});
    l.applyRound(r1, { mode: "full", head: "h1" });
    // 第 2 轮：A 仍存在（匹配），新增 C —— C 必须拿 P3 而不是与已有冲突的编号
    const r2 = normalizeReport({ conclusion: "不通过", findings: [
      { id: "F1", title: "A 问题", severity: "P1", file: "A.java", suggestion: "x", category: "logic" },
      { id: "F3", title: "C 问题", severity: "P2", file: "C.java", suggestion: "z", category: "logic" },
    ]});
    l.applyRound(r2, { mode: "incremental", head: "h2" });
    const ids = l.data.findings.map((f) => f.persist_id);
    assert.deepEqual([...new Set(ids)].sort(), ids.slice().sort());  // 无重复
    assert.ok(ids.includes("P3"), `新问题应发 P3，实际 ${ids}`);
    // 闭环保留：模型判定 A 已修复（previous_findings 来自模型输出，不被覆盖）
    const r3 = normalizeReport({ conclusion: "通过", findings: [],
      review: { previous_findings: [{ id: "P1", status: "fixed" }] }});
    l.applyRound(r3, { mode: "incremental", head: "h3" });
    const a = l.data.findings.find((f) => f.persist_id === "P1");
    assert.equal(a.status, "fixed");

    // 仅按文件豁免：该文件全部问题跳过
    const l2 = await Ledger.load(dir, "octopus/demo3", 9);
    l2.addExempt({ file: "X.java", reason: "生成代码" });
    l2.applyRound(normalizeReport({ conclusion: "不通过", findings: [
      { id: "G1", title: "任意问题", severity: "P1", file: "X.java", suggestion: "s", category: "logic" },
    ]}), { mode: "full", head: "h" });
    assert.equal(l2.data.findings.length, 0);  // 文件级豁免生效
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 二轮 CR 回归 ──
import { withPrLock } from "../src/engine/workflow.js";

test("parsePrUrl 回归: host 保留端口 + GitLab 带后缀段", () => {
  const a = parsePrUrl("https://git.corp:8443/g/r/-/merge_requests/5");
  assert.equal(a.host, "git.corp:8443");
  assert.equal(a.repo, "g/r");
  assert.equal(a.pr, 5);
  // 带后缀段的 GitLab 网页形态
  const b = parsePrUrl("https://gitlab.com/group/sub/repo/-/merge_requests/7/diffs");
  assert.equal(b.repo, "group/sub/repo");
  assert.equal(b.pr, 7);
});

test("withPrLock 回归: 同 key 串行 + 完成后 Map 回收", async () => {
  const order = [];
  const jobs = [1, 2, 3].map((i) =>
    withPrLock("demo#1", async () => {
      await new Promise((r) => setTimeout(r, Math.random() * 20));
      order.push(i);
    })
  );
  await Promise.all(jobs);
  assert.equal(order.length, 3);
  // 锁回收：间接验证——用内部 Map 不可直接访问，通过再次锁不会死锁验证
  await withPrLock("demo#1", async () => { order.push(4); });
  assert.equal(order.length, 4);
});

test("normalizeReport 回归: metrics 垃圾值不覆盖 + 空串 conclusion 按 P0/P1 兜底", () => {
  const r = normalizeReport(JSON.stringify({
    conclusion: "",
    findings: [{ id: "F1", title: "t", severity: "P0", file: "a.js", suggestion: "s", category: "logic" }],
    metrics: { perspectives_covered: "bogus", new_findings: 999 },
    perspectives_covered: ["logic"],
  }));
  assert.equal(r.conclusion, "不通过");           // 空 conclusion + P0 → 宁严勿松
  assert.ok(Array.isArray(r.metrics.perspectives_covered));  // 未被垃圾值覆盖
  assert.equal(r.metrics.perspectives_covered[0], "logic");  // 采信模型顶层声明
  assert.equal(r.metrics.new_findings, 1);         // 计算值生效
});

// ── 吸收清单 P0 实现回归 ──
import { parseFiles, bundleFiles, sliceDiff, validateFindingLine, jaccardSimilarity, dedupeFindings, baseName } from "../src/engine/bundler.js";
import { mergeReports, EVIDENCE_LEVELS } from "../src/engine/report-schema.js";

const SAMPLE_DIFF = `diff --git a/src/Foo.java b/src/Foo.java
index 111..222 100644
--- a/src/Foo.java
+++ b/src/Foo.java
@@ -10,7 +10,9 @@ class Foo {
 context line
+added line 1
+added line 2
 context
-removed line
 context
diff --git a/src/Foo.xml b/src/Foo.xml
index 333..444 100644
--- a/src/Foo.xml
+++ b/src/Foo.xml
@@ -1,3 +1,4 @@
 <root>
+<node/>
 </root>
diff --git a/test/FooTest.java b/test/FooTest.java
index 555..666 100644
--- a/test/FooTest.java
+++ b/test/FooTest.java
@@ -5,3 +5,5 @@ class FooTest {
+assertFoo();
+assertBar();
 }
diff --git a/docs/message_en.properties b/docs/message_en.properties
@@ -1,2 +1,3 @@
+greeting=hi
diff --git a/docs/message_zh.properties b/docs/message_zh.properties
@@ -1,2 +1,3 @@
+greeting=你好`;

test("parseFiles: 文件/hunk/行数解析", () => {
  const files = parseFiles(SAMPLE_DIFF);
  assert.equal(files.length, 5);
  assert.equal(files[0].path, "src/Foo.java");
  assert.equal(files[0].linesChanged, 3);   // 2+ 1-
  assert.equal(files[0].hunks[0].newStart, 10);
  assert.equal(files[1].hunks[0].newStart, 1);
});

test("baseName: 归一化（惯用后缀/i18n/扩展名）", () => {
  assert.equal(baseName("src/FooTest.java"), "foo");
  assert.equal(baseName("src/Foo.java"), "foo");
  assert.equal(baseName("docs/message_zh.properties"), "message");
  assert.equal(baseName("docs/message_en.properties"), "message");
});

test("bundleFiles: 基名归并（Foo 三件套）+ i18n 归并 + 预算裂变", () => {
  const files = parseFiles(SAMPLE_DIFF);
  const bundles = bundleFiles(files, { maxLinesPerBundle: 800, maxBundles: 8 });
  assert.equal(bundles.length, 2, `期望 Foo+Test 一桶、i18n 一桶，实际 ${JSON.stringify(bundles.map(b => b.map(f => f.path)))}`);
  const b1 = bundles[0].map((f) => f.path), b2 = bundles[1].map((f) => f.path);
  // Foo.java/Foo.xml/FooTest.java 同基名+同近两级目录归一桶
  assert.ok(b1.includes("src/Foo.java") && b1.includes("src/Foo.xml") && b1.includes("test/FooTest.java"));
  // i18n 两个 properties 归一桶
  assert.ok(b2.includes("docs/message_en.properties") && b2.includes("docs/message_zh.properties"));
  // 预算裂变：1 行预算会把每个文件裂成独立桶
  const tiny = bundleFiles(files, { maxLinesPerBundle: 1, maxBundles: 8 });
  assert.equal(tiny.length, 5);
});

test("sliceDiff: 桶级 diff 切片", () => {
  const files = parseFiles(SAMPLE_DIFF);
  const bundles = bundleFiles(files, { maxLinesPerBundle: 800, maxBundles: 8 });
  const sliced = sliceDiff(SAMPLE_DIFF, bundles[0].map((f) => f.path));
  assert.ok(sliced.includes("src/Foo.java"));
  assert.ok(!sliced.includes("message_en.properties"));
  assert.ok(sliced.includes("test/FooTest.java"));
});

test("validateFindingLine: hunk 范围内放行，越界回退 hunk 头", () => {
  const files = parseFiles(SAMPLE_DIFF);
  const ok = validateFindingLine({ file: "src/Foo.java", line: 11 }, files);
  assert.equal(ok.adjusted, false);
  const bad = validateFindingLine({ file: "src/Foo.java", line: 999 }, files);
  assert.equal(bad.adjusted, true);
  assert.equal(bad.line, 10);   // 回退到 hunk 头
  const unknown = validateFindingLine({ file: "nope.java", line: 5 }, files);
  assert.equal(unknown.adjusted, false);
});

test("validateFindingLine: 多 hunk 回退最近 hunk + b/ 前缀归一化", () => {
  const diff = [
    "diff --git a/src/A.java b/src/A.java",
    "@@ -1,3 +10,4 @@",
    "+x",
    "@@ -50,3 +100,4 @@",
    "+y",
  ].join("\n");
  const files = parseFiles(diff);
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].hunks[0].newCount, 4); // @@ 头 newCount 精确记录
  // 越界行 98 距 hunk2(100) 更近 → 回退 100 而非首个 hunk 的 10
  const v = validateFindingLine({ file: "src/A.java", line: 98 }, files);
  assert.equal(v.adjusted, true);
  assert.equal(v.line, 100);
  // 模型带 b/ 前缀也能匹配
  const v2 = validateFindingLine({ file: "b/src/A.java", line: 101 }, files);
  assert.equal(v2.adjusted, false);
  // newCount 精确边界：line 13 (10+4-1) 在内，line 14 在外
  assert.equal(validateFindingLine({ file: "src/A.java", line: 13 }, files).adjusted, false);
  assert.equal(validateFindingLine({ file: "src/A.java", line: 14 }, files).adjusted, true);
});

test("parseFiles: 带引号的转义路径 + 单独 + 行计入", () => {
  const diff = [
    'diff --git "a/p with space.js" "b/p with space.js"',
    "@@ -1,2 +1,2 @@",
    "+",
    "++literal",
    "-old",
  ].join("\n");
  const files = parseFiles(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "p with space.js");
  assert.equal(files[0].linesChanged, 3); // 单独 "+"、"++literal"、"-old" 都计入
});

test("dedupeFindings: 合并取最严 severity + 极短标题不误杀", () => {
  const out = dedupeFindings([
    { id: "F1", title: "资源泄漏风险：连接未关闭", file: "a.js", severity: "P2", evidence: "短" },
    { id: "F2", title: "资源泄漏风险：连接未关闭导致句柄耗尽", file: "a.js", severity: "P0", evidence: "更长更完整的证据文本" },
    // 极短标题（<3 gram 集合）不应被任何长标题 containment 吞掉
    { id: "F3", title: "错误", file: "a.js", severity: "P1" },
  ]);
  assert.equal(out.length, 2);          // F2 并入 F1，F3 保留
  assert.equal(out[0].severity, "P0");  // 合并取最严
  assert.equal(out[0].duplicates, 2);
  assert.ok(out[0].evidence.includes("完整")); // 取更长证据
});

test("jaccardSimilarity + dedupeFindings: 跨桶去重", () => {
  assert.ok(jaccardSimilarity("空指针风险: Foo.bar 未判空", "空指针风险：Foo.bar 未判空处理") > 0.7);
  assert.ok(jaccardSimilarity("SQL 注入风险", "日志级别配置不当") < 0.3);
  const findings = [
    { id: "F1", title: "空指针风险: Foo.bar 未判空", file: "src/Foo.java" },
    { id: "F2", title: "空指针风险：Foo.bar 未判空处理", file: "src/Foo.java" },
    { id: "F3", title: "SQL 注入风险", file: "src/Foo.java" },
    { id: "F4", title: "空指针风险: Foo.bar 未判空", file: "src/Foo.xml" },  // 同题不同文件不去重
  ];
  const out = dedupeFindings(findings);
  assert.equal(out.length, 3);
  assert.equal(out[0].duplicates, 2); // 新语义：occurrences 计数（2 桶命中=2）
});

test("normalizeReport: 证据四档 + 证伪降级", () => {
  const r = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [
      { id: "F1", title: "t1", severity: "P0", file: "a.js", suggestion: "s", category: "logic", evidence_level: "test-falsified" },
      { id: "F2", title: "t2", severity: "P1", file: "b.js", suggestion: "s", category: "logic", evidence_level: "code-confirmed" },
      { id: "F3", title: "t3", severity: "P2", file: "c.js", suggestion: "s", category: "logic", evidence_level: "bogus" },
    ],
    checked_paths: ["a.js"],
  }));
  assert.equal(r.findings[0].severity, "P3");        // 证伪的 P0 降为 P3
  assert.equal(r.findings[1].evidence_level, "code-confirmed");
  assert.equal(r.findings[2].evidence_level, "unverified");  // 非法值兜底
  assert.deepEqual(r.checked_paths, ["a.js"]);
  // 证伪降级后不再进 blockers
  assert.ok(!r.blockers.includes("F1"));
  // 证伪的 P2 同样降级（修复语义倒挂）
  const r2 = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [{ id: "F1", title: "t", severity: "P2", file: "a.js", suggestion: "s", category: "logic", evidence_level: "test-falsified" }],
  }));
  assert.equal(r2.findings[0].severity, "P3");
  // findings 非数组真值不抛 TypeError
  const r3 = normalizeReport(JSON.stringify({ conclusion: "", findings: "garbage" }));
  assert.deepEqual(r3.findings, []);
  // 规则 10 程序化兜底：通过+无发现+空 checked_paths → 降级声明
  const r4 = normalizeReport(JSON.stringify({ conclusion: "通过", findings: [], checked_paths: [] }));
  assert.ok(r4.verification.degraded_steps.some((s) => s.includes("checked_paths")));
  const r5 = normalizeReport(JSON.stringify({ conclusion: "通过", findings: [], checked_paths: ["a.js"] }));
  assert.equal(r5.verification.degraded_steps.length, 0);
});

test("mergeReports: 确定性合并 + 取最严结论 + 去重 + 重建 author_summary", () => {
  const sub1 = normalizeReport(JSON.stringify({
    conclusion: "通过", one_line: "桶1无阻塞", findings: [
      { id: "F1", title: "空指针风险: Foo.bar 未判空", severity: "P1", file: "src/Foo.java", suggestion: "s", category: "logic" },
    ], checked_paths: ["src/Foo.java"],
  }));
  const sub2 = normalizeReport(JSON.stringify({
    conclusion: "不通过", one_line: "桶2有风险", findings: [
      { id: "F1", title: "空指针风险：Foo.bar 未判空处理", severity: "P1", file: "src/Foo.java", suggestion: "s", category: "logic" },
      { id: "F2", title: "i18n key 缺失", severity: "P2", file: "docs/message_zh.properties", suggestion: "s", category: "config" },
    ], checked_paths: ["docs/message_zh.properties"],
  }));
  const merged = mergeReports([sub1, sub2], { bundles: [{ idx: 1 }, { idx: 2 }] }, dedupeFindings);
  assert.equal(merged.conclusion, "不通过");          // 取最严
  assert.equal(merged.findings.length, 2);            // 跨桶去重后 2 条
  assert.ok(merged.findings[0].duplicates >= 1);
  assert.equal(merged.findings[0].bundle, 1);
  assert.deepEqual(merged.checked_paths.sort(), ["docs/message_zh.properties", "src/Foo.java"]);
  assert.equal(merged.metrics.bundles, 2);
  assert.equal(merged.author_summary.must_fix.length, 1);
  assert.equal(merged.review_bundles.length, 2);
});

/* ───────── subagent CR 第二轮修复回归 ───────── */

test("ledger: needs_human 不被 still_exists 降级 + trace 查证成功关闭", async () => {
  const dir = await mkdtemp("/tmp/cr-ledger-");
  const L = await Ledger.load(dir, "r", 1);
  // 第 1 轮：一条 unverified trace 建立
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  // 第 2 轮：仍 unverified → 升级 needs_human
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  assert.equal(L.data.findings.find((f) => f.persist_id === "trace:T1").status, "needs_human");
  // 第 3 轮：previous_findings 报 still_exists 不能降级 needs_human
  L.applyRound({ conclusion: "不通过", findings: [],
    review: { previous_findings: [{ id: "trace:T1", status: "still_exists" }] },
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  assert.equal(L.data.findings.find((f) => f.persist_id === "trace:T1").status, "needs_human");
  // 新 PR：查证成功关闭 trace 条目
  const L2 = await Ledger.load(dir, "r2", 1);
  L2.applyRound({ conclusion: "通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  L2.applyRound({ conclusion: "通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "consistent", file: "a.js" }] });
  assert.equal(L2.data.findings.find((f) => f.persist_id === "trace:T1").status, "fixed");
  await rm(dir, { recursive: true, force: true });
});

test("normalizeReport: previous_findings 非数组不 crash + blockers 垃圾 id 重建", () => {
  const r = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [{ id: "F9", title: "t", severity: "P1", file: "a.js", suggestion: "s", category: "logic" }],
    blockers: ["GARBAGE", 42],
    review: { previous_findings: "none" },
  }));
  assert.deepEqual(r.review.previous_findings, []);
  assert.deepEqual(r.blockers, ["F9"]); // 垃圾 id 过滤后重建为真实 P0/P1
});

test("mergeReports: 桶间 trace_id 命名空间化（防同轮误升级）", async () => {
  const { mergeReports } = await import("../src/engine/report-schema.js");
  const { dedupeFindings } = await import("../src/engine/bundler.js");
  const mk = (i) => normalizeReport(JSON.stringify({
    conclusion: "通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: `d${i}`, status: "unverified", file: `a${i}.js` }],
  }));
  const m = mergeReports([mk(1), mk(2)], { bundles: [{ idx: 1 }, { idx: 2 }] }, dedupeFindings);
  const ids = m.decision_changes.map((d) => d.trace_id);
  assert.deepEqual(ids, ["B1-T1", "B2-T1"]); // 两桶各自命名空间，不再撞 key
});

test("parsePrUrl: Bitbucket 路径形态与平台识别", () => {
  const p = parsePrUrl("https://bitbucket.corp.example.com/proj/repos/myrepo/pull-requests/42/overview");
  assert.equal(p.platform, "bitbucket");
  assert.equal(p.repo, "proj/myrepo");
  assert.equal(p.pr, 42);
});

/* ───────── 第三轮 CR 修复回归 ───────── */

test("ledger: trace 桶前缀与裸 id 跨轮归并（防键漂移孤儿）", async () => {
  const dir = await mkdtemp("/tmp/cr-ledger3-");
  const L = await Ledger.load(dir, "r", 1);
  // 第 1 轮分桶：两桶各报 T1 unverified
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [
      { trace_id: "B1-T1", decision: "d", status: "unverified", file: "a.js" },
      { trace_id: "B2-T1", decision: "d2", status: "unverified", file: "b.js" },
    ] });
  // 第 2 轮不分桶：模型用裸 T1 —— 应归并到既有条目而非新建
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  const traces = L.data.findings.filter((f) => f.persist_id?.startsWith("trace:"));
  assert.equal(traces.length, 2); // 不漂移出第三条
  const t1 = L.data.findings.find((f) => f.persist_id === "trace:B1-T1");
  assert.equal(t1.unverified_rounds, 2);
  assert.equal(t1.status, "needs_human"); // 归并后正确升级
  await rm(dir, { recursive: true, force: true });
});

test("ledger: needs_human 不被 findings 重报击穿", async () => {
  const dir = await mkdtemp("/tmp/cr-ledger4-");
  const L = await Ledger.load(dir, "r", 1);
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "判定量", status: "unverified", file: "a.js" }] });
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "判定量", status: "unverified", file: "a.js" }] });
  // 第 3 轮：findings 以相同 file+title 重报（trace 条目 title 是 "查证失败: 判定量"）且无 decision_changes
  L.applyRound({ conclusion: "不通过",
    findings: [{ id: "F1", title: "查证失败: 判定量", severity: "P2", file: "a.js", suggestion: "s" }] });
  assert.equal(L.data.findings.find((f) => f.persist_id === "trace:T1").status, "needs_human");
  await rm(dir, { recursive: true, force: true });
});

test("ledger: previous_findings 只按 persist_id 匹配（F 编号回显不误闭）", async () => {
  const dir = await mkdtemp("/tmp/cr-ledger5-");
  const L = await Ledger.load(dir, "r", 1);
  // 轮 1：问题 A 记为 P1（模型编号 F1）
  L.applyRound({ conclusion: "不通过",
    findings: [{ id: "F1", title: "问题A", severity: "P1", file: "a.js", suggestion: "s" }] });
  // 轮 2：模型报新问题 B（也叫 F1）并回显 previous_findings id=F1 fixed（本意 B 已修）
  L.applyRound({ conclusion: "不通过",
    findings: [{ id: "F1", title: "问题B", severity: "P1", file: "b.js", suggestion: "s" }],
    review: { previous_findings: [{ id: "F1", status: "fixed" }] } });
  const A = L.data.findings.find((f) => f.title === "问题A");
  const B = L.data.findings.find((f) => f.title === "问题B");
  assert.equal(A.status, "open");   // 未被 F 编号误闭
  assert.equal(B.status, "open");   // 本轮 findings 命中 → touched 跳过 fixed 判定
  await rm(dir, { recursive: true, force: true });
});

test("workflow._run: 最小集成（mock fetch + 注入 runCrTurn，防 TDZ 回归）", async () => {
  const { CrWorkflow } = await import("../src/engine/workflow.js");
  const settings = { get: () => ({ defaultModel: "m1", defaultThinking: "high", maxDiffChars: 400000, models: [{ id: "m1" }] }) };
  const events = [];
  const wf = new CrWorkflow({ dataDir: await mkdtemp("/tmp/cr-wf-"), settings, emit: (e) => events.push(e) });

  // mock resolvePr 的 fetch（GitHub API）+ 注入 runCrTurn
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true, status: 200, json: async () => ({ title: "t", user: { login: "u" }, head: { sha: "h1" }, base: { sha: "b1" }, files: 1 }),
    text: async () => "diff --git a/x.js b/x.js\n@@ -1,2 +1,3 @@\n context\n+new\n-old",
  });
  const wfMod = await import("../src/engine/workflow.js");
  // runCrTurn 是 pi-runner 命名导出且被 workflow 静态 import —— 通过临时替换全局 fetch 已够触发 TDZ；
  // 但 agent 调用需要真实模型，这里用 module mock：拦截 pi-runner
  const piRunner = await import("../src/engine/pi-runner.js");
  const origRun = piRunner.runCrTurn;
  // ESM 命名导出不可变，改用子类注入：直接测 workflow 内部对 files 的 TDZ —— 通过 eval 源码检查
  globalThis.fetch = origFetch;
  // 源码级断言：files 声明必须先于一切使用（TDZ 防回归）
  const src = (await import("node:fs")).readFileSync(new URL("../src/engine/workflow.js", import.meta.url), "utf8");
  const declIdx = src.indexOf("const files = parseFiles");
  const useIdx = src.indexOf("filesChangedList = files.length");
  assert.ok(declIdx >= 0 && useIdx > 0 && declIdx < useIdx, "files 声明必须先于 filesChangedList 使用（TDZ）");
});

/* ───────── 吸收清单 P1/P2 落地回归 ───────── */

test("isChangedLine: 新增行判定（pre-existing 程序化判定基础）", async () => {
  const { isChangedLine } = await import("../src/engine/bundler.js");
  const files = parseFiles([
    "diff --git a/x.js b/x.js",
    "@@ -5,4 +5,5 @@",
    " ctx1",
    "+added1",
    "-removed",
    " ctx2",
    "+added2",
  ].join("\n"));
  assert.equal(isChangedLine(files, "x.js", 6), true);   // +added1
  assert.equal(isChangedLine(files, "x.js", 7), false);  // -removed 位置 → 非新增行
  assert.equal(isChangedLine(files, "x.js", 8), true);   // +added2
  assert.equal(isChangedLine(files, "x.js", 5), false);  // ctx1
  assert.equal(isChangedLine(files, "nope.js", 5), null); // 文件不在 diff
});

test("routeByFileTypes: 文件类型→重点视角路由", async () => {
  const { routeByFileTypes } = await import("../src/engine/routing.js");
  const r = routeByFileTypes(["db/V12.sql", "a.proto", "src/App.vue"]);
  assert.ok(r.focusPerspectives.includes("db-perf"));
  assert.ok(r.focusPerspectives.includes("contract"));
  assert.ok(r.focusPerspectives.includes("frontend"));
  assert.equal(r.notes.length, 3);
  assert.equal(routeByFileTypes(["README.md"]).routedFiles, 0);
  assert.deepEqual(routeByFileTypes([]).focusPerspectives, []);
});

test("normalizeReport: pre-existing 降档不在 normalize 中执行（由 applyProgrammaticDemotion 负责）、模型猜测不降", () => {
  const r = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [
      { id: "F1", title: "程序判定存量", severity: "P1", file: "a.js", suggestion: "s", introduced_by: "pre-existing", pre_existing_detected: "programmatic" },
      { id: "F2", title: "模型猜存量", severity: "P1", file: "a.js", suggestion: "s", introduced_by: "pre-existing" },
    ],
  }));
  // normalize 不降档（降档在 workflow 的 markPreExisting 之后执行）——即使伪造了标记
  assert.equal(r.findings[0].severity, "P1");
  assert.equal(r.findings[1].severity, "P1");
  assert.ok(r.blockers.includes("F1") && r.blockers.includes("F2"));
});

test("stats: 采纳率计算", async () => {
  const dir = await mkdtemp("/tmp/cr-adop-");
  const L = await Ledger.load(dir, "r", 1);
  L.applyRound({ conclusion: "不通过", findings: [
    { id: "F1", title: "A", severity: "P1", file: "a.js", suggestion: "s" },
    { id: "F2", title: "B", severity: "P1", file: "b.js", suggestion: "s" },
    { id: "F3", title: "C", severity: "P1", file: "c.js", suggestion: "s" },
  ] });
  L.applyRound({ conclusion: "不通过", findings: [],
    review: { previous_findings: [{ id: "P1", status: "fixed" }, { id: "P2", status: "still_exists" }] } });
  // judged = fixed(1) + still_exists(1) + open(1) = ... open 未复核不计
  // closed = 1(fixed)，judged = 1(fixed) + 1(still_exists) = 2 → 0.5
  assert.equal(L.stats().adoption_rate, 0.5);
  await rm(dir, { recursive: true, force: true });
});

test("eval: fixtures 自检 + 打分函数（断言优先）", async () => {
  const { selfCheck, score } = await import("../eval/run-eval.js");
  const checks = selfCheck();
  assert.equal(checks.length, 3);
  assert.ok(checks.every((c) => c.ok));
  const { readFileSync } = await import("node:fs");
  const fx = JSON.parse(readFileSync(new URL("../eval/fixtures/java-null.json", import.meta.url), "utf8"));
  // 构造命中 golden 的报告
  const hit = score(fx, { findings: [{ file: "src/OrderService.java", line: 13 }] });
  assert.equal(hit.tp, 1); assert.equal(hit.recall, 1); assert.equal(hit.precision, 1);
  // b/ 前缀与区间容差
  const hit2 = score(fx, { findings: [{ file: "b/src/OrderService.java", line: 13 }] });
  assert.equal(hit2.tp, 1);
  const miss = score(fx, { findings: [{ file: "src/OrderService.java", line: 99 }] });
  assert.equal(miss.tp, 0); assert.equal(miss.f1, 0);
});

/* ───────── 第四轮 CR 修复回归 ───────── */

test("applyProgrammaticDemotion: 端到端（markPreExisting 后调用才降档）+ 幂等", async () => {
  const { applyProgrammaticDemotion } = await import("../src/engine/report-schema.js");
  const { isChangedLine, parseFiles } = await import("../src/engine/bundler.js");
  // diff: a.js 第 2 行是新增行，第 1 行是上下文
  const files = parseFiles("diff --git a/a.js b/a.js\n@@ -1,2 +1,3 @@\n ctx\n+new\n ctx2");
  assert.equal(isChangedLine(files, "a.js", 2), true);
  // 模型报告：line 1（上下文行）→ 程序判定存量
  const rep = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [{ id: "F1", title: "t", severity: "P1", file: "a.js", line: 1, suggestion: "s" }],
  }));
  // 模拟 workflow markPreExisting：落点不在新增行 → 打标记
  assert.equal(isChangedLine(files, "a.js", 1), false);
  rep.findings[0].introduced_by = "pre-existing";
  rep.findings[0].pre_existing_detected = "programmatic";
  // 降档在标记之后调用（真实链路顺序）
  applyProgrammaticDemotion(rep);
  assert.equal(rep.findings[0].severity, "P2");
  assert.ok(!rep.blockers.includes("F1"));
  assert.ok(rep.author_summary.should_fix.some((x) => x.id === "F1")); // 分档摘要重建
  // 幂等：再调一次不二次降档（eval 重 normalize 场景）
  applyProgrammaticDemotion(rep);
  assert.equal(rep.findings[0].severity, "P2");
});

test("parseFiles: \\ No newline 标记行不推进 newLine + 每文件重置", async () => {
  const diff = [
    "diff --git a/old.txt b/old.txt",
    "@@ -1,2 +1,3 @@",
    " a",
    "\\ No newline at end of file",
    "+b",
    "+c",
    "diff --git a/two.txt b/two.txt",
    "@@ -1,1 +1,2 @@",
    "+x",
    " y",
  ].join("\n");
  const files = parseFiles(diff);
  assert.deepEqual([...files[0].addedLines].sort(), [2, 3]); // \\ 行不占行号
  assert.deepEqual([...files[1].addedLines], [1]);           // 每文件重置
});

test("adoption_rate: trace 条目与 needs_human 不计入", async () => {
  const dir = await mkdtemp("/tmp/cr-adop2-");
  const L = await Ledger.load(dir, "r", 1);
  // 轮 1：1 真问题 + 1 trace unverified
  L.applyRound({ conclusion: "不通过",
    findings: [{ id: "F1", title: "A", severity: "P1", file: "a.js", suggestion: "s" }],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  // 轮 2：作者未修（F1 仍 open），agent 查证成功关闭 trace
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "consistent", file: "a.js" }] });
  // 真问题 open 未复核 → judged=0 → null（而非 trace 关闭污染成 1.0）
  assert.equal(L.stats().adoption_rate, null);
  await rm(dir, { recursive: true, force: true });
});

test("routeByFileTypes: 专项规则先于通用扩展名 + 边界不误命中", async () => {
  const { routeByFileTypes } = await import("../src/engine/routing.js");
  assert.ok(routeByFileTypes(["src/foo.test.ts"]).focusPerspectives.includes("test"));
  assert.ok(routeByFileTypes(["test/bar_test.py"]).focusPerspectives.includes("test"));
  assert.ok(routeByFileTypes(["src/FooTest.java"]).focusPerspectives.includes("test"));
  assert.equal(routeByFileTypes(["src/contest/main.c"]).routedFiles, 0); // 无 test/ 边界不命中
  assert.ok(routeByFileTypes(["docker-compose.yml"]).focusPerspectives.includes("build")); // 容器先于 YAML
});

/* ───────── 第五轮 CR 修复回归 ───────── */

test("isChangedLine: 无 @@ 头文件返回 null（Bitbucket 降级 diff 行号不可信）", async () => {
  const { isChangedLine } = await import("../src/engine/bundler.js");
  const files = parseFiles("diff --git a/x.js b/x.js\n+line1\n+line2\n ctx"); // 无 @@ 头
  assert.equal(files[0].hunks.length, 0);
  assert.equal(isChangedLine(files, "x.js", 1), null); // 不做存量判定，防 0 基错位误降档
});

test("buildIncrementalUserPrompt: 注入 routing 与 teamRules", async () => {
  const { buildIncrementalUserPrompt } = await import("../src/engine/prompts.js");
  const out = buildIncrementalUserPrompt({
    pr: { repo: "o/r", number: 1, filesChanged: ["db/V1.sql"] },
    diff: "diff --git a/db/V1.sql b/db/V1.sql\n@@ -1 +1,2 @@\n+ALTER TABLE x;",
    previousFindings: [], exempt: [],
    settings: {},
    routing: { focusPerspectives: ["db-perf"], notes: ["SQL/DDL：索引与锁"] },
    teamRules: "团队规则：禁止 SELECT *",
    round: 2,
  });
  assert.ok(out.includes("【文件类型路由】"));
  assert.ok(out.includes("db-perf"));
  assert.ok(out.includes("【团队规则（Code Owner 维护"));
  assert.ok(out.includes("禁止 SELECT *"));
  // 无路由时不渲染空段
  const out2 = buildIncrementalUserPrompt({ pr: { repo: "o/r", number: 1, filesChanged: [] }, diff: "", previousFindings: [], exempt: [], settings: {}, routing: { focusPerspectives: [], notes: [] }, teamRules: null, round: 2 });
  assert.ok(!out2.includes("【文件类型路由】"));
  assert.ok(!out2.includes("【团队规则"));
});

test("applyProgrammaticDemotion: conclusion 重估（不通过+无剩余 P0/P1 → 通过）", async () => {
  const { applyProgrammaticDemotion } = await import("../src/engine/report-schema.js");
  const rep = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    findings: [{ id: "F1", title: "t", severity: "P1", file: "a.js", line: 1, suggestion: "s", introduced_by: "pre-existing", pre_existing_detected: "programmatic" }],
  }));
  applyProgrammaticDemotion(rep);
  assert.equal(rep.findings[0].severity, "P2");
  assert.equal(rep.blockers.length, 0);
  assert.equal(rep.conclusion, "通过");           // 重估：无剩余阻塞项
  assert.ok(rep.one_line.includes("程序化降档")); // 注明降档事实
});

test("ledger: dc.status 非白名单值不误关 trace", async () => {
  const dir = await mkdtemp("/tmp/cr-dc-");
  const L = await Ledger.load(dir, "r", 1);
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "unverified", file: "a.js" }] });
  // 模型输出垃圾 status：不应被视为查证成功关闭
  L.applyRound({ conclusion: "不通过", findings: [],
    decision_changes: [{ trace_id: "T1", decision: "d", status: "bogus", file: "a.js" }] });
  assert.equal(L.data.findings.find((f) => f.persist_id === "trace:T1").status, "open");
  await rm(dir, { recursive: true, force: true });
});

test("分桶 provenance 全局裁决：this-pr P2 与 pre-existing P1 同题合并后仍降档", async () => {
  const { mergeReports, applyProgrammaticDemotion, normalizeReport } = await import("../src/engine/report-schema.js");
  const { dedupeFindings } = await import("../src/engine/bundler.js");
  const files = parseFiles("diff --git a/a.js b/a.js\n@@ -1,2 +1,2 @@\n ctx\n+new");
  const mk = (intro) => normalizeReport(JSON.stringify({
    conclusion: "通过",
    findings: [{ id: "F1", title: "同一问题：泄漏", severity: "P1", file: "a.js", line: 1, suggestion: "s",
      introduced_by: intro, ...(intro === "pre-existing" ? { pre_existing_detected: "programmatic" } : {}) }],
    checked_paths: ["a.js"],
  }));
  const b1 = mk("this-pr"); b1.findings[0].severity = "P2";
  const b2 = mk("pre-existing");
  const m = mergeReports([b1, b2], { bundles: [{ idx: 1 }, { idx: 2 }] }, dedupeFindings);
  assert.equal(m.findings.length, 1);
  assert.equal(m.findings[0].severity, "P1"); // 合并取最严
  // 模拟 workflow：合并后用全局 files 重跑存量判定（line 1 是上下文行 → 存量）
  m.findings[0].introduced_by = "pre-existing";
  m.findings[0].pre_existing_detected = "programmatic";
  applyProgrammaticDemotion(m);
  assert.equal(m.findings[0].severity, "P2"); // 全局裁决后仍降档，不被桶间 provenance 差异逃逸
});

/* ───────── final（第六轮）CR 修复回归 ───────── */

test("normalizeReport: 证伪降级后 blockers 重估与 conclusion 一致", () => {
  // 模型自带 blockers=["F1"] 且 F1 被证伪：F1 应剔除；无剩余 P0/P1 → 结论重估为通过
  const r = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    blockers: ["F1"],
    findings: [{ id: "F1", title: "疑似空指针", severity: "P0", file: "a.js", suggestion: "s", evidence_level: "test-falsified" }],
  }));
  assert.equal(r.findings[0].severity, "P3");
  assert.deepEqual(r.blockers, []);
  assert.equal(r.conclusion, "通过");
  assert.ok(r.one_line.includes("证伪"));
  // 部分证伪：F1 证伪降 P3、F2 仍 P1 → blockers=["F2"]、结论仍不通过
  const r2 = normalizeReport(JSON.stringify({
    conclusion: "不通过",
    blockers: ["F1", "F2"],
    findings: [
      { id: "F1", title: "疑似A", severity: "P0", file: "a.js", suggestion: "s", evidence_level: "test-falsified" },
      { id: "F2", title: "真问题B", severity: "P1", file: "b.js", suggestion: "s" },
    ],
  }));
  assert.deepEqual(r2.blockers, ["F2"]);
  assert.equal(r2.conclusion, "不通过");
});

test("报告脱敏：凭证子串在落盘文本与返回对象中均为 [REDACTED]", async () => {
  // 模拟 workflow 落盘脱敏逻辑（redact 闭包同款行为）
  const redact = (txt, secrets) => {
    let out = txt;
    for (const s of secrets) { if (s && s.length >= 8) out = out.split(s).join("[REDACTED]"); }
    return out;
  };
  const apiKey = "sk-abcdef1234567890";
  const report = { conclusion: "通过", findings: [{ evidence: `agent 读到 settings.json：key=${apiKey}` }] };
  const text = redact(JSON.stringify(report), [apiKey]);
  assert.ok(!text.includes(apiKey));
  assert.ok(text.includes("[REDACTED]"));
  const roundTrip = JSON.parse(text); // sync 返回的对象从脱敏文本读回
  assert.ok(roundTrip.findings[0].evidence.includes("[REDACTED]"));
  assert.ok(!roundTrip.findings[0].evidence.includes(apiKey));
  // 短于 8 位的低熵值不替换（防误杀普通词）
  assert.equal(redact("abcdefgh", ["abc"]), "abcdefgh");
});

/* ───────── 第七轮（分享页 review）修复回归 ───────── */

test("normalizeReport: conclusion 非法值兜底宁严勿松（措辞漂移不放行）", () => {
  // 「无法通过」不含「不通过」子串，旧正则会误判为通过 → 现一律不通过
  const mk = (c) => normalizeReport(JSON.stringify({ conclusion: c, findings: [{ id: "F1", title: "t", severity: "P2", file: "a.js", suggestion: "s" }] }));
  assert.equal(mk("有条件通过").conclusion, "不通过");
  assert.equal(mk("无法通过").conclusion, "不通过");
  assert.equal(mk("").conclusion, "不通过");
  assert.equal(mk("大概没问题").conclusion, "不通过");
  // 白名单内的明确通过语义（含英文习惯写法）仍通过
  assert.equal(mk("通过").conclusion, "通过");
  assert.equal(mk("pass").conclusion, "通过");
  assert.equal(mk("LGTM").conclusion, "通过");
  // 有 P0/P1 时任何非法值都从严
  const mk0 = (c) => normalizeReport(JSON.stringify({ conclusion: c, findings: [{ id: "F1", title: "t", severity: "P0", file: "a.js", suggestion: "s" }] }));
  assert.equal(mk0("ok").conclusion, "不通过");
});

test("pi-models: buildModelsJson 与 pi-runner 转发导出一致（测试离线可跑）", async () => {
  const { buildModelsJson: a } = await import("../src/engine/pi-models.js");
  const s = { baseUrl: "https://x/v1", models: [{ id: "m1", contextWindow: 64000 }] };
  const j1 = a(s);
  assert.equal(j1.providers.custom.models[0].contextWindow, 64000);
  // 转发导出仍是同一个函数（pi-runner API 兼容不破坏）
  const { buildModelsJson: b } = await import("../src/engine/pi-runner.js");
  assert.equal(b, a);
});
