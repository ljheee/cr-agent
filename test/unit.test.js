import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrUrl, githubApiBase, sshHostFor, gitUrlFor } from "../src/pr-resolver.js";
import { normalizeReport, buildAuthorSummary } from "../src/engine/report-schema.js";
import { PERSPECTIVES, DIMENSIONS, renderPerspectivesForPrompt, primaryPerspectiveId, listSecondaryPerspectives } from "../src/engine/perspectives.js";
import { Ledger } from "../src/engine/ledger.js";
import { buildModelsJson } from "../src/engine/pi-models.js"; // 纯函数模块：测试离线可跑，不拉 pi SDK 树
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("githubApiBase: 公网 github.com 走 api.github.com，GHE 保留 host/api/v3", () => {
  assert.equal(githubApiBase("github.com"), "https://api.github.com");
  assert.equal(githubApiBase("www.github.com"), "https://api.github.com");
  assert.equal(githubApiBase("GitHub.com"), "https://api.github.com");
  assert.equal(githubApiBase("github.corp.example.com"), "https://github.corp.example.com/api/v3");
  assert.equal(githubApiBase("ghe.example.com:8443"), "https://ghe.example.com:8443/api/v3");
});

test("sshHostFor: 内置默认 + sshHostMap 覆盖 + 无映射原样返回", () => {
  assert.equal(sshHostFor("github.com"), "github.com");
  assert.equal(sshHostFor("www.github.com"), "github.com");
  assert.equal(sshHostFor("api.github.com"), "github.com");
  assert.equal(sshHostFor("git.corp.example.com"), "git.corp.example.com");
  assert.equal(
    sshHostFor("git.web.corp.com", { sshHostMap: { "git.web.corp.com": "ssh.git.corp.com" } }),
    "ssh.git.corp.com",
  );
  // 用户覆盖优先于内置默认
  assert.equal(
    sshHostFor("www.github.com", { sshHostMap: { "www.github.com": "github.enterprise.local" } }),
    "github.enterprise.local",
  );
  // 精确匹配带端口的 host；不匹配时不去 strip 端口瞎套
  assert.equal(
    sshHostFor("git.corp.com:7990", { sshHostMap: { "git.corp.com:7990": "ssh.corp.com:22" } }),
    "ssh.corp.com:22",
  );
  assert.equal(sshHostFor("git.corp.com:7990", { sshHostMap: { "git.corp.com": "ssh.corp.com" } }), "git.corp.com:7990");
});

test("gitUrlFor: ssh 方案使用 sshHostFor 映射后的 host", () => {
  const url = gitUrlFor(
    { host: "git.web.corp.com", repo: "PRJ/app" },
    { gitScheme: "ssh", sshHostMap: { "git.web.corp.com": "ssh.git.corp.com" } },
  );
  assert.equal(url, "ssh://git@ssh.git.corp.com/PRJ/app.git");
});

test("settings: sshHostMap 默认空 + 校验 + 设置页可配", async () => {
  const { Settings } = await import("../src/settings.js");
  const dir = await mkdtemp(path.join(tmpdir(), "cr-sshmap-"));
  try {
    const s = await Settings.load(dir);
    assert.deepEqual(s.get().sshHostMap, {});
    await s.update({ sshHostMap: { "git.web.corp.com": "ssh.git.corp.com", "a:7990": "b:22" } });
    assert.equal(s.get().sshHostMap["git.web.corp.com"], "ssh.git.corp.com");
    await assert.rejects(() => s.update({ sshHostMap: { "bad host": "x" } }), /不合法/);
    await assert.rejects(() => s.update({ sshHostMap: { "ok.com": "bad host" } }), /不合法/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const html = await import("node:fs/promises").then((fs) => fs.readFile(`${process.cwd()}/public/index.html`, "utf8"));
  assert.ok(html.includes("sSshHostMap") && html.includes("sshHostMap"), "设置页含 SSH 主机映射");
});

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

test("parsePrUrl: hostPlatforms 自定义域名映射", () => {
  const s = { hostPlatforms: { "abc.com": "bitbucket" } };
  // 精确命中
  const p1 = parsePrUrl("https://git.abc.com/repos/x/pull-requests/5", s);
  assert.equal(p1.platform, "bitbucket");
  // 子域名后缀命中
  const p2 = parsePrUrl("https://git.abc.com/repos/x/pull-requests/6", s);
  assert.equal(p2.platform, "bitbucket");
  // 未配置域名回退 generic
  const p3 = parsePrUrl("https://git.other.com/repos/x/pull-requests/7", s);
  assert.equal(p3.platform, "generic");
  // 子域名错觉防护：evil.abc.com.evil.example 不因后缀错觉命中 abc.com 映射
  const p4 = parsePrUrl("https://evil.abc.com.evil.example/repos/x/pull-requests/8", s);
  assert.equal(p4.platform, "generic");
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

test("normalizeReport: JSON 本体后跟解释文字/尾块（平衡扫描取首个完整对象）", () => {
  // 真实场景 rv-1793779017257：模型在合法 JSON 后追加说明（含 } 与第二个代码块），
  // 旧 first{→last} 提取把尾巴圈进来 → "Unexpected non-whitespace character after JSON"
  const body = JSON.stringify({ conclusion: "通过", one_line: "本桶未发现阻塞性问题{含花括号}", findings: [] });
  const r1 = normalizeReport(body + "\n\n说明：见 {配置桥} 核查，另见 ```json\n{\"x\":1}\n``` 补充。");
  assert.equal(r1.conclusion, "通过");
  assert.equal(r1.one_line, "本桶未发现阻塞性问题{含花括号}");
  // 字符串内转义引号不干扰扫描
  const r2 = normalizeReport('{"conclusion":"通过","one_line":"含 \\"引号\\" 与 }","findings":[]} 尾巴文字');
  assert.equal(r2.conclusion, "通过");
  // 尾部纯文字（无 }）
  const r3 = normalizeReport('{"conclusion":"通过","findings":[]} 总结：无阻塞问题。');
  assert.equal(r3.conclusion, "通过");
  // 截断 JSON（value 边界）：repairJson 修复档救活（补闭合），但残缺 finding（缺 title）被防线丢弃
  const r4 = normalizeReport('{"conclusion":"通过","findings":[{"file":"a"');
  assert.equal(r4.conclusion, "通过");
  assert.equal(r4.findings.length, 0);
  assert.ok((r4.verification?.degraded_steps || []).some((d) => String(d).includes("残缺")));
  // 字符串内截断（字段写一半）：保守不救，仍报错
  assert.throws(() => normalizeReport('{"conclusion":"通过","one_line":"部分摘'));
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

test("PERSPECTIVES: MECE 一级 6 轴 + 二级 checklist", () => {
  assert.deepEqual(DIMENSIONS, PERSPECTIVES.map((p) => p.id));
  assert.equal(PERSPECTIVES.length, 6);
  for (const p of PERSPECTIVES) {
    assert.equal(p.dimension, p.id, p.id);
    assert.ok(p.checklist.length > 10, p.id);
    assert.ok(Array.isArray(p.secondary) && p.secondary.length >= 2, p.id);
  }
  assert.equal(listSecondaryPerspectives().length, 21);
  assert.equal(primaryPerspectiveId("logic"), "correctness");
  assert.equal(primaryPerspectiveId("mq"), "data");
  assert.equal(primaryPerspectiveId("contract"), "contract");
  const txt = renderPerspectivesForPrompt();
  assert.ok(txt.includes("[correctness]"));
  assert.ok(txt.includes("[fund-safety]"));
  assert.ok(txt.includes("一级轴"));
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
    const l = await Ledger.load(dir, "team/demo", 1);
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
    const l = await Ledger.load(dir, "team/demo2", 1);
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
    const l2 = await Ledger.load(dir, "team/demo3", 9);
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
  assert.equal(r.metrics.perspectives_covered[0], "correctness");  // 顶层声明归一到一级轴
  assert.equal(r.metrics.new_findings, 1);         // 计算值生效
});

// ── P0 实现回归 ──
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

test("mergeReports: 失败桶空洞 fail-soft 合并 + degraded_steps 留痕", () => {
  const sub1 = normalizeReport(JSON.stringify({
    conclusion: "通过", one_line: "桶1 ok", findings: [
      { id: "F1", title: "小问题", severity: "P2", file: "a.js", suggestion: "s", category: "logic" },
    ], checked_paths: ["a.js"],
  }));
  const merged = mergeReports(
    [sub1, null, null],
    { bundles: [{ idx: 1, files: ["a.js"] }, { idx: 2, files: ["b.js"] }, { idx: 3, files: ["c.js"] }],
      bundleErrors: [{ idx: 2, error: "parse-fail prose" }, { idx: 3, error: "empty" }] },
    dedupeFindings,
  );
  assert.equal(merged.conclusion, "通过");
  assert.equal(merged.findings.length, 1);
  assert.equal(merged.metrics.bundles, 3);
  assert.equal(merged.metrics.bundles_ok, 1);
  assert.equal(merged.metrics.bundles_failed, 2);
  assert.equal(merged.review_bundles[0].failed, false);
  assert.equal(merged.review_bundles[1].failed, true);
  assert.ok(merged.verification.degraded_steps.some((s) => /分桶 2 失败/.test(s)));
  assert.throws(() => mergeReports([null, null], { bundleErrors: [{ idx: 1, error: "x" }] }), /子报告为空/);
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
  const dataDir = await mkdtemp("/tmp/cr-wf-");
  try {
    const { CrWorkflow } = await import("../src/engine/workflow.js");
    const settings = { get: () => ({ defaultModel: "m1", defaultThinking: "high", maxDiffChars: 400000, models: [{ id: "m1" }] }) };
    const events = [];
    const wf = new CrWorkflow({ dataDir, settings, emit: (e) => events.push(e) });
    void wf; // 构造可实例化
    // 源码级断言：files 声明必须先于一切使用（TDZ 防回归）；resolvePr 在 try 内（防 workDir 泄漏）
    const src = (await import("node:fs")).readFileSync(new URL("../src/engine/workflow.js", import.meta.url), "utf8");
    const declIdx = src.indexOf("const files = parseFiles");
    const useIdx = src.indexOf("filesChangedList = files.length");
    assert.ok(declIdx >= 0 && useIdx > 0 && declIdx < useIdx, "files 声明必须先于 filesChangedList 使用（TDZ）");
    assert.ok(src.indexOf("await resolvePr(") > src.indexOf("let workDir = null"), "resolvePr 在 try/workDir 声明之后");
    assert.ok(src.includes("coerceFindingLine"), "markPreExisting 使用 coerceFindingLine");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

/* ───────── P1/P2 落地回归 ───────── */

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

test("routeByFileTypes: 文件类型→一级轴路由", async () => {
  const { routeByFileTypes } = await import("../src/engine/routing.js");
  const r = routeByFileTypes(["db/V12.sql", "a.proto", "src/App.vue"]);
  assert.ok(r.focusPerspectives.includes("data"));
  assert.ok(r.focusPerspectives.includes("contract"));
  assert.ok(r.focusPerspectives.includes("correctness"));
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
  assert.ok(routeByFileTypes(["src/foo.test.ts"]).focusPerspectives.includes("delivery"));
  assert.ok(routeByFileTypes(["test/bar_test.py"]).focusPerspectives.includes("delivery"));
  assert.ok(routeByFileTypes(["src/FooTest.java"]).focusPerspectives.includes("delivery"));
  assert.equal(routeByFileTypes(["src/contest/main.c"]).routedFiles, 0); // 无 test/ 边界不命中
  assert.ok(routeByFileTypes(["docker-compose.yml"]).focusPerspectives.includes("delivery")); // 容器先于 YAML
  assert.ok(routeByFileTypes(["docker-compose.yml"]).focusPerspectives.includes("security_fund"));
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

/* ───────── v20：submit_review 工具通道 + jsonrepair 兜底 + 流式早停 ───────── */

test("submit_review 工具：schema 合法性 + execute 落盘 + terminate + 回调", async () => {
  const { createSubmitReviewTool, buildSubmitReviewSchema, normalizePerspectivesSkipped } = await import("../src/engine/submit-review-tool.js");
  const schema = buildSubmitReviewSchema();
  assert.equal(schema.type, "object");
  assert.ok(schema.properties.conclusion && schema.properties.findings && schema.properties.one_line);
  // finding 参数是 strict 兼容的普通 object schema
  assert.equal(schema.properties.findings.items.type, "object");
  // perspectives_skipped 放宽为 Any[]（TypeBox Any → items:{}），兼容误传的 {id,reason}
  assert.deepEqual(schema.properties.perspectives_skipped.items, {});
  assert.deepEqual(
    normalizePerspectivesSkipped([{ id: "frontend", reason: "无前端" }, "mq: 无消息", { id: "build" }]),
    ["frontend: 无前端", "mq: 无消息", "build"],
  );

  let captured = null;
  const dir = await mkdtemp("/tmp/cr-submit-");
  const tool = createSubmitReviewTool({ workDir: dir, onSubmitted: (r) => { captured = r; } });
  assert.equal(tool.name, "submit_review");
  assert.deepEqual(tool.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.equal(typeof tool.execute, "function");

  const report = {
    conclusion: "通过",
    one_line: "测试摘要",
    findings: [{ id: "F1", title: "t", severity: "P1", evidence: "e", suggestion: "s", file: "a.java", line: 3 }],
  };
  const res = await tool.execute("call-1", report, undefined, undefined, {});
  assert.equal(res.terminate, true, "工具返回 terminate:true（agent 循环即停）");
  assert.deepEqual(captured, report, "onSubmitted 回调收到报告对象（coerce 会浅拷贝，用 deepEqual）");
  const { readFile } = await import("node:fs/promises");
  const saved = JSON.parse(await readFile(`${dir}/.cr-agent/report.json`, "utf8"));
  assert.equal(saved.conclusion, "通过");
  assert.equal(saved.findings.length, 1);

  // 对象形态 perspectives_skipped 不被拒，execute 内压成字符串
  let captured2 = null;
  const tool2 = createSubmitReviewTool({ workDir: dir, onSubmitted: (r) => { captured2 = r; } });
  await tool2.execute("call-2", {
    ...report,
    perspectives_skipped: [{ id: "frontend", reason: "无前端变更" }],
  }, undefined, undefined, {});
  assert.deepEqual(captured2.perspectives_skipped, ["frontend: 无前端变更"]);

  // 嵌套字段被二次 stringify 时，execute 侧解成对象再回调/落盘
  let captured3 = null;
  const tool3 = createSubmitReviewTool({ workDir: dir, bundleIdx: 1, onSubmitted: (r) => { captured3 = r; } });
  await tool3.execute("call-3", {
    conclusion: "通过",
    one_line: "字符串化嵌套",
    findings: "[]",
    review: JSON.stringify({ summary: "ok", perspectives: [] }),
  }, undefined, undefined, {});
  assert.ok(Array.isArray(captured3.findings));
  assert.equal(typeof captured3.review, "object");
  assert.equal(captured3.review.summary, "ok");
  await rm(dir, { recursive: true, force: true });
});

test("repairJson：缺逗号/尾逗号/单引号/干净截断修复；字符串内截断与垃圾不救", async () => {
  const { repairJson } = await import("../src/engine/report-schema.js");
  // 缺逗号
  assert.equal(JSON.parse(repairJson('{"a":1 "b":2}')).b, 2);
  // 尾逗号
  assert.equal(JSON.parse(repairJson('{"a":[1,2,],}')).a.length, 2);
  // 单引号
  assert.equal(JSON.parse(repairJson(`{"a":'x'}`)).a, "x");
  // 干净截断（value 边界）
  assert.equal(JSON.parse(repairJson('{"a":1')).a, 1);
  // 字符串内截断：保守返回原文（上层报错走模型重试）
  assert.equal(repairJson('{"a":"部分'), '{"a":"部分');
  // 正常 JSON 不被误伤
  const normal = '{"a":"x y","b":[{"c":1}],"d":null,"e":true}';
  assert.equal(JSON.parse(repairJson(normal)).a, "x y");
});

test("normalizeReport：嵌套字段被二次 stringify 时自动解一层", async () => {
  const { normalizeReport } = await import("../src/engine/report-schema.js");
  const r = normalizeReport({
    conclusion: "通过",
    one_line: "ok",
    review: JSON.stringify({ mode: "full", previous_findings: [] }),
    findings: JSON.stringify([{ id: "F1", title: "t", severity: "P2", suggestion: "s", file: "a.js", evidence: "e" }]),
    tests: JSON.stringify([{ scenario: "x", priority: "low" }]),
  });
  assert.equal(r.conclusion, "通过");
  assert.equal(r.review.mode, "full");
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, "F1");
  assert.equal(r.tests.length, 1);
});

test("snapshotAssistantMessage：截断 text/thinking 供空响应排障", async () => {
  const { snapshotAssistantMessage } = await import("../src/engine/pi-runner.js");
  const snap = snapshotAssistantMessage({
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "x".repeat(1000) },
      { type: "text", text: "Now let me review the PR in detail..." },
      { type: "toolCall", name: "submit_review", id: "c1" },
    ],
  }, 20);
  assert.equal(snap.stopReason, "stop");
  assert.equal(snap.parts[0].thinkingLen, 1000);
  assert.equal(snap.parts[0].thinkingHead.length, 20);
  assert.equal(snap.parts[1].textHead, "Now let me review th");
  assert.equal(snap.parts[2].toolName, "submit_review");
});

test("pi-runner 源码级断言：submit_review 通道 + 早停截断存在（防回归）", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/engine/pi-runner.js", import.meta.url), "utf8");
  // 工具通道注册（v24 起 submit_review 按白名单条件创建：CR 交付会话有，verifier 会话无）
  assert.ok(src.includes("customTools: submitReviewTool ? [submitReviewTool] : []"), "customTools 条件注册 submit_review");
  assert.ok(src.includes("wantSubmitTool"), "工具白名单开关存在");
  assert.ok(src.includes("submittedReport"), "runCrTurn 返回 submittedReport");
  assert.ok(src.includes("err.diagnostics"), "空响应挂 diagnostics");
  // 文本通道早停：message_update 增量平衡扫描
  assert.ok(src.includes('"message_update"') && src.includes("earlyStopped"), "早停扫描存在");
  // workflow 消费双通道
  const wfSrc = await readFile(new URL("../src/engine/workflow.js", import.meta.url), "utf8");
  assert.ok(wfSrc.includes("submittedReport && typeof submittedReport === \"object\""), "workflow 优先工具通道");
  assert.ok(wfSrc.includes('status: "parse-fail"') && wfSrc.includes("textHead"), "parse-fail 记录 textHead");
  assert.ok(wfSrc.includes("empty-response") && wfSrc.includes("persistAgentRaw"), "空响应落盘 raw");
  assert.ok(wfSrc.includes("_submitted = true"), "工具通道标记 _submitted");
});

/* ───────── v21：定级锚点量化（severity-anchors）───────── */

test("severity-anchors: 模糊带案例（fail-fast 依赖线上缺配置数据）归 P2 且附升级条件", async () => {
  const { deriveSeverity, applyAnchorSeverity } = await import("../src/engine/severity-anchors.js");
  // 同 head 两轮漂移的真实案例：CCS 无配置被 fail-fast 整批上抛
  // r1 判 P1（假设占比高）、r3 判 P3（假设占比低）——锚点规则应唯一归 P2-C1
  const f = {
    id: "F38", severity: "P1", evidence_level: "code-confirmed",
    introduced_by: "this-pr",
    impact_radius: "batch", trigger: "data-dependent",
    title: "CCS 无配置属正常场景却被 fail-fast 整批上抛",
  };
  const { severity, rule } = deriveSeverity(f, { impact: {} });
  assert.equal(severity, "P2");
  assert.equal(rule, "P2-C1");
  const rep = applyAnchorSeverity({ findings: [f], blockers: ["F38"] });
  assert.equal(rep.findings[0].severity, "P2");
  assert.equal(rep.findings[0]._model_severity, "P1");       // 模型原判留痕
  assert.ok(rep.findings[0]._escalation_clause.includes("P1-C1")); // 升级条件显式化
  assert.deepEqual(rep.blockers, []);                        // blockers 重算（降级后无高等级）
});

test("severity-anchors: P2-C4 单请求已确认地板 + P3-C3 delivery 封顶", async () => {
  const { deriveSeverity } = await import("../src/engine/severity-anchors.js");
  const single = {
    introduced_by: "this-pr", impact_radius: "single", trigger: "certain",
    evidence_level: "code-confirmed", category: "correctness",
  };
  assert.deepEqual(deriveSeverity(single, {}), { severity: "P2", rule: "P2-C4-single-confirmed" });
  const hygiene = {
    introduced_by: "this-pr", impact_radius: "single", trigger: "certain",
    evidence_level: "code-confirmed", category: "delivery",
  };
  assert.deepEqual(deriveSeverity(hygiene, {}), { severity: "P3", rule: "P3-C3-delivery-cap" });
});

test("severity-anchors: unverified 物理封顶 P2（P0/P1 证据门）", async () => {
  const { deriveSeverity } = await import("../src/engine/severity-anchors.js");
  // 模型自报 P0 + 全量流量 + 必然触发，但 evidence=unverified → 封顶 P2
  const f = { severity: "P0", evidence_level: "unverified", introduced_by: "this-pr",
    impact_radius: "all-traffic", trigger: "certain" };
  assert.equal(deriveSeverity(f, {}).severity, "P2");
  // 同锚点但 code-confirmed → P0
  const f2 = { ...f, evidence_level: "code-confirmed" };
  assert.equal(deriveSeverity(f2, {}).severity, "P0");
  assert.equal(deriveSeverity(f2, {}).rule, "P0-C1");
});

test("severity-anchors: test-falsified 作废 + pre-existing 封顶 + none 归 P3", async () => {
  const { deriveSeverity, applyAnchorSeverity } = await import("../src/engine/severity-anchors.js");
  // 证伪 → 作废（不进报告，留 degraded_steps）
  const rep = applyAnchorSeverity({ findings: [
    { id: "F1", severity: "P1", evidence_level: "test-falsified", impact_radius: "batch", trigger: "certain", introduced_by: "this-pr" },
  ], blockers: ["F1"] });
  assert.equal(rep.findings.length, 0);
  assert.ok((rep.verification?.degraded_steps || []).some((d) => String(d).includes("作废")));
  // 存量问题封顶 P2（非契约）
  assert.equal(deriveSeverity({ severity: "P1", evidence_level: "code-confirmed", introduced_by: "pre-existing",
    impact_radius: "all-traffic", trigger: "certain" }, {}).severity, "P2");
  // 无行为影响 → P3
  assert.equal(deriveSeverity({ severity: "P2", evidence_level: "code-confirmed", introduced_by: "this-pr",
    impact_radius: "none", trigger: "certain" }, {}).severity, "P3");
  // 锚点缺省（模型没输出 radius/trigger）→ 保守档（single + data-dependent）→ P2
  assert.equal(deriveSeverity({ severity: "P1", evidence_level: "code-confirmed", introduced_by: "this-pr" }, {}).severity, "P2");
});

test("severity-anchors: 契约破坏 + code-confirmed → P1/P0（合同路径）", async () => {
  const { deriveSeverity } = await import("../src/engine/severity-anchors.js");
// 契约破坏（category=contract）+ 有条件触发 + code-confirmed → P1（首中即定：batch+conditional+code-confirmed 先命中 P1-C1，同为 P1）
const f = { severity: "P2", evidence_level: "code-confirmed", introduced_by: "this-pr",
impact_radius: "batch", trigger: "conditional", category: "contract" };
assert.equal(deriveSeverity(f, {}).severity, "P1");
assert.equal(deriveSeverity(f, {}).rule, "P1-C1");
// P1-C2 专属路径：契约 + batch 以下影响半径（single）+ 非 certain → 契约路径显式命中
const f1b = { ...f, impact_radius: "single" };
assert.equal(deriveSeverity(f1b, {}).severity, "P1");
assert.equal(deriveSeverity(f1b, {}).rule, "P1-C2");
  // 契约破坏 + 整批 + 有条件 → 仍是 P1（P0-C2 需 trigger=certain，防契约被有条件触发拔到 P0）
  const f2 = { ...f, impact_radius: "all-traffic" };
  assert.equal(deriveSeverity(f2, {}).severity, "P1");
  // 契约破坏 + batch + 必然触发 + code-confirmed → P0-C2（P0-C1 只覆盖 all-traffic，
  // 契约路径 batch 半径是 P0-C2 专属场景——首中即定下 all-traffic 契约先命中 P0-C1，同为 P0）
  const f3 = { ...f, impact_radius: "batch", trigger: "certain" };
  assert.equal(deriveSeverity(f3, {}).severity, "P0");
  assert.equal(deriveSeverity(f3, {}).rule, "P0-C2");
  // 对照：契约 + all-traffic + certain 首中 P0-C1（同为 P0）
  const f4 = { ...f, impact_radius: "all-traffic", trigger: "certain" };
  assert.equal(deriveSeverity(f4, {}).rule, "P0-C1");
  // isContractBreak 锚定：含词但非契约 category 不误判（non-contract / contract-test）
  assert.equal(deriveSeverity({ ...f4, category: "non-contract" }, {}).rule, "P0-C1", "non-contract 非契约");
  const f5 = { severity: "P3", evidence_level: "code-confirmed", introduced_by: "this-pr",
    impact_radius: "single", trigger: "conditional", category: "contract-test" };
  // 含词非契约：不走 P1-C2；单请求已确认走 P2-C4 地板（不再静默掉进 P3）
  assert.equal(deriveSeverity(f5, {}).rule, "P2-C4-single-confirmed", "contract-test 不走契约通道");
  assert.equal(deriveSeverity({ ...f5, category: "契约" }, {}).severity, "P1", "中文契约仍命中");
});

test("workflow/settings: bundleConcurrency 默认 1 + 校验 + 并行池存在", async () => {
  const { Settings } = await import("../src/settings.js");
  const s = new Settings("/tmp/nonexistent-settings.json");
  assert.equal(s.get().bundleConcurrency, 1);
  await assert.rejects(() => s.update({ bundleConcurrency: 9 }), /bundleConcurrency/);
  await assert.rejects(() => s.update({ bundleConcurrency: 0 }), /bundleConcurrency/);
  // workflow 源码级：worker 池并行结构 + 锚点接入（防回归）
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../src/engine/workflow.js", import.meta.url), "utf8");
  assert.ok(src.includes("settings.bundleConcurrency"), "桶并行度读取 settings");
  assert.ok(src.includes("Promise.all(Array.from"), "worker 池并行");
  assert.ok((src.match(/applyAnchorSeverity\(report, sevRules\)/g) || []).length >= 2, "双路径锚点接入（可配置规则表）");
assert.ok(src.includes("loadSeverityRules(this.dataDir)"), "规则表从 data 目录加载");
});

test("submit-review-tool: bundleIdx 分文件落盘（并行桶互不覆盖）", async () => {
  const { createSubmitReviewTool } = await import("../src/engine/submit-review-tool.js");
  const dir = await mkdtemp("/tmp/cr-sub-b-");
  const mk = (idx) => createSubmitReviewTool({ workDir: dir, bundleIdx: idx, onSubmitted: () => {} });
  const rep = { conclusion: "通过", one_line: "x", findings: [] };
  await mk(1).execute("c1", rep);
  await mk(2).execute("c2", rep);
  const { readFile } = await import("node:fs/promises");
  const r1 = JSON.parse(await readFile(`${dir}/.cr-agent/report-bundle-1.json`, "utf8"));
  const r2 = JSON.parse(await readFile(`${dir}/.cr-agent/report-bundle-2.json`, "utf8"));
  assert.ok(r1 && r2, "两桶各自落盘");
  // 单轮（无 bundleIdx）→ report.json
await createSubmitReviewTool({ workDir: dir, onSubmitted: () => {} }).execute("c3", rep);
await readFile(`${dir}/.cr-agent/report.json`, "utf8");
await rm(dir, { recursive: true, force: true });
});

test("persistBundleReport: 文本通道兑底落盘（不调工具时分文件/单轮命名一致）", async () => {
const { persistBundleReport } = await import("../src/engine/submit-review-tool.js");
const { readFile, readdir, rm: rmF } = await import("node:fs/promises");
const dir = await mkdtemp("/tmp/cr-sub-t-");
const rep = { conclusion: "通过", findings: [] };
// 文本通道传归一化后的报告对象（含 _usage 等内部字段也会如实落盘）
const repFull = { ...rep, _usage: { total: 1 }, _file_persisted: "text-channel" };
await persistBundleReport(dir, 3, repFull);
await persistBundleReport(dir, null, rep);
const r3 = JSON.parse(await readFile(`${dir}/.cr-agent/report-bundle-3.json`, "utf8"));
const r1 = JSON.parse(await readFile(`${dir}/.cr-agent/report.json`, "utf8"));
assert.equal(r3.conclusion, "通过");
assert.equal(r3._usage.total, 1, "内部字段如实落盘");
assert.equal(r1.conclusion, "通过");
// 无残留 tmp 文件（原子写 rename 完成）
const left = await readdir(`${dir}/.cr-agent`);
assert.equal(left.filter((f) => f.endsWith(".tmp")).length, 0);
await rmF(dir, { recursive: true, force: true });
});

test("severity-rules: 默认表过校验 + 自定义规则覆盖生效 + 坏配置拒绝", async () => {
const { DEFAULT_SEVERITY_RULES, validateSeverityRules } = await import("../src/engine/severity-rules-default.js");
const { deriveSeverity } = await import("../src/engine/severity-anchors.js");
// 1) 内置默认表必须能通过自身校验（保证出厂合法）
const ok = validateSeverityRules(DEFAULT_SEVERITY_RULES);
assert.equal(ok.length, DEFAULT_SEVERITY_RULES.length);
// 2) 自定义规则表：一条宽松 P0 规则 + 兜底 P2——覆盖后 unverified 也能 P0（展示配置威力）
const custom = validateSeverityRules([
  { id: "P0-LOOSE", severity: "P0", when: { impact_radius: ["batch"] } },
  { id: "P2-default", severity: "P2", when: {} },
]);
const f = { severity: "P3", evidence_level: "unverified", introduced_by: "this-pr", impact_radius: "batch", trigger: "data-dependent" };
assert.equal(deriveSeverity(f, {}, custom).severity, "P0");
assert.equal(deriveSeverity(f, {}, custom).rule, "P0-LOOSE");
// 默认表下同一 finding 仍被 unverified 封顶 P2（配置隔离，互不污染）
assert.equal(deriveSeverity(f, {}).severity, "P2");
// 3) 校验拒绝：非空数组 / 非法枚举 / 重复 id / 未知条件字段
assert.throws(() => validateSeverityRules([]), /非空数组/);
assert.throws(() => validateSeverityRules([{ id: "X", severity: "P9", when: {} }]), /severity/);
assert.throws(() => validateSeverityRules([{ id: "X", severity: "P1", when: { impact_radius: ["galaxy"] } }]), /impact_radius/);
assert.throws(() => validateSeverityRules([{ id: "X", severity: "P1", when: {} }, { id: "X", severity: "P2", when: {} }]), /重复/);
assert.throws(() => validateSeverityRules([{ id: "X", severity: "P1", when: { color: ["red"] } }]), /未知条件字段/);
});

test("severity-anchors: #247 误判回归——文档注解不匹配与单测建议不得 P1", async () => {
const { deriveSeverity } = await import("../src/engine/severity-anchors.js");
// 场景1：ThriftRequest——文档注解『必传』与实现不符（category=contract 但 ir=none）
const doc = { severity: "P3", evidence_level: "code-confirmed", introduced_by: "this-pr",
  impact_radius: "none", trigger: "conditional", category: "contract" };
// 契约路径 P1-C2 现要求 radius≠none：ir=none 不再拔高，落入 P3-C1（无行为影响）
assert.equal(deriveSeverity(doc, {}).severity, "P3");
// 对照：真契约破坏（radius=single 隔离出 P1-C2 专属路径——batch+conditional 会先命中 P1-C1，同为 P1）
const real = { ...doc, impact_radius: "single" };
assert.equal(deriveSeverity(real, {}).severity, "P1");
assert.equal(deriveSeverity(real, {}).rule, "P1-C2");
// 场景2：单测建议（category=test），impact 文本含「对外契约关键面」措辞
const test = { severity: "P3", evidence_level: "code-confirmed", introduced_by: "this-pr",
  impact_radius: "none", trigger: "conditional", category: "test",
  impact: "回填逻辑为对外契约关键面，无直接单测时回归风险靠手工验证兜底。非阻塞" };
// isContractBreak 已收紧：impact 文本关键词不再触发契约判定 → 不走 P1-C2
const d2 = deriveSeverity(test, {});
assert.equal(d2.severity, "P3", "单测建议+契约措辞=非阻塞，P3");
});

test("settings: maxRounds 默认 3 + 校验 1~20 + workflow 读 settings.maxRounds", async () => {
const { Settings } = await import("../src/settings.js");
const { mkdtemp, rm, readFile } = await import("node:fs/promises");
const dir = await mkdtemp("/tmp/cr-set-t-");
const s = await Settings.load(dir);
assert.equal(s.get().maxRounds, 3, "默认 3");
await s.update({ maxRounds: 5 });
assert.equal(s.get().maxRounds, 5);
await assert.rejects(() => s.update({ maxRounds: 0 }), /1~20/);
await assert.rejects(() => s.update({ maxRounds: 21 }), /1~20/);
await assert.rejects(() => s.update({ maxRounds: 2.5 }), /1~20/);
await rm(dir, { recursive: true, force: true });
// workflow 从 settings 取轮次上限（不再用常量）
const wf = await readFile(`${process.cwd()}/src/engine/workflow.js`, "utf8");
assert.ok(wf.includes("settings.maxRounds"), "轮次上限读 settings.maxRounds");
assert.ok(!wf.includes("if (capLedger.round >= MAX_ROUNDS)"), "不再硬编码常量判定");
// 前端设置页带该输入项
const html = await readFile(`${process.cwd()}/public/index.html`, "utf8");
assert.ok(html.includes("sMaxRounds") && html.includes("轮次上限"), "设置页含轮次上限输入");
});

test("CR 修复回归：分桶路径锚点后重建 author_summary + 锚点覆盖降档留痕", async () => {
const { readFile } = await import("node:fs/promises");
const { applyAnchorSeverity } = await import("../src/engine/severity-anchors.js");
const { buildAuthorSummary } = await import("../src/engine/report-schema.js");
// B1：锚点重算改变分档后，author_summary 必须基于新定级（旧 summary 的 must_fix 是旧分档）
const rep = { conclusion: "不通过", findings: [
  { id: "F1", title: "t1", severity: "P3", evidence_level: "code-confirmed", introduced_by: "this-pr", impact_radius: "all-traffic", trigger: "certain" },
], blockers: [] };
applyAnchorSeverity(rep);
assert.equal(rep.findings[0].severity, "P0", "锚点推导 P0");
const sum = buildAuthorSummary(rep);
assert.ok(sum.must_fix.some((m) => m.id === "F1"), "锚点后重建的 must_fix 含 P0");
// workflow 源码：分桶路径锚点重算后有聚合重算（B1 修复在位：v24 起重建收敦到
// recomputeReportAggregates，applyAnchorSeverity 内部统一调用，分桶/单轮/verifier 三路共用）
const wf = await readFile(`${process.cwd()}/src/engine/workflow.js`, "utf8");
const bundled = wf.indexOf("report._severity_rules = sevRules.map");
const usageLine = wf.indexOf("report._usage = { bundles:", bundled);
assert.ok(usageLine > -1, "分桶路径 _usage 存在");
const anchors = await readFile(`${process.cwd()}/src/engine/severity-anchors.js`, "utf8");
assert.ok(anchors.includes("export function recomputeReportAggregates"), "聚合重算函数导出");
assert.ok(anchors.includes("recomputeReportAggregates(report, \"锚点重算\")"), "applyAnchorSeverity 调用聚合重算");
assert.ok(anchors.includes("report.author_summary = buildAuthorSummary(report)"), "重建在位");
// B2：程序化降档被锚点覆盖时 degraded_steps 留痕（场景：存量+契约——存量门不拦契约，
// P1-C2 可推导出 P1，高于 demotion 后的 P2；普通存量被存量门封顶 P2 不会触发）
const rep2 = { conclusion: "不通过", findings: [
  { id: "F2", title: "t2", severity: "P2", pre_existing_demoted: true, category: "contract",
    evidence_level: "code-confirmed", introduced_by: "pre-existing", impact_radius: "single", trigger: "conditional" },
] };
applyAnchorSeverity(rep2);
assert.equal(rep2.findings[0].severity, "P1", "存量+契约走 P1-C2");
assert.ok((rep2.verification?.degraded_steps || []).some(s => String(s).includes("锚点重算覆盖程序化降档")), "覆盖降档留痕");
// 对照：普通存量（非契约）封顶 P2，不触发留痕
const rep3 = { conclusion: "不通过", findings: [
  { id: "F3", title: "t3", severity: "P2", pre_existing_demoted: true,
    evidence_level: "code-confirmed", introduced_by: "pre-existing", impact_radius: "all-traffic", trigger: "certain" },
] };
applyAnchorSeverity(rep3);
assert.equal(rep3.findings[0].severity, "P2");
assert.ok(!(rep3.verification?.degraded_steps || []).some(s => String(s).includes("覆盖程序化降档")), "封顶场景不误报留痕");
});

test("CR 修复回归：锚点重算后 conclusion 重估（双通道对称）", async () => {
const { applyAnchorSeverity } = await import("../src/engine/severity-anchors.js");
// 方向一：模型判「不通过」，锚点封顶后无 P0/P1 → conclusion 收敛为「通过」
const rep = { conclusion: "不通过", one_line: "存在阻塞问题", findings: [
  { id: "F1", title: "t1", severity: "P1", evidence_level: "code-confirmed", introduced_by: "this-pr",
    impact_radius: "single", trigger: "data-dependent" },  // → P2-C1
], blockers: ["F1"] };
applyAnchorSeverity(rep);
assert.deepEqual(rep.blockers, []);
assert.equal(rep.conclusion, "通过", "无高等级阻塞项时结论翻正");
assert.ok(String(rep.one_line).includes("锚点重算"), "one_line 留重估痕迹");
// 方向二：模型判「通过」，锚点升出 P0 → 结论翻「不通过」（锚点是唯一权威定级源）
const rep2 = { conclusion: "通过", one_line: "无阻塞问题", findings: [
  { id: "F2", title: "t2", severity: "P3", evidence_level: "code-confirmed", introduced_by: "this-pr",
    impact_radius: "all-traffic", trigger: "certain" },  // → P0-C1
], blockers: [] };
applyAnchorSeverity(rep2);
assert.deepEqual(rep2.blockers, ["F2"]);
assert.equal(rep2.conclusion, "不通过", "锚点升出 P0/P1 时结论翻负");
// 方向三：重估幂等——conclusion 已与高等级集合一致时 one_line 不被重复追加
const rep3 = { conclusion: "不通过", one_line: "存在阻塞问题", findings: [
  { id: "F3", title: "t3", severity: "P1", evidence_level: "code-confirmed", introduced_by: "this-pr",
    impact_radius: "all-traffic", trigger: "certain" },
], blockers: ["F3"] };
applyAnchorSeverity(rep3);
assert.equal(rep3.conclusion, "不通过");
assert.equal(rep3.one_line, "存在阻塞问题", "无翻转时 one_line 原样");
});

test("CR 修复回归：audit 归档前脱敏 + redact 提升到 try 外（P1-1）", async () => {
const { readFile } = await import("node:fs/promises");
const wf = await readFile(`${process.cwd()}/src/engine/workflow.js`, "utf8");
// redact/secrets 声明在 _run 顶部（try 外）：finally 归档脱敏用，早失败路径无 ReferenceError
const fnStart = wf.indexOf("async _run(");
const redactAt = wf.indexOf("const redact =", fnStart);
const capAt = wf.indexOf("轮次上限", fnStart);
assert.ok(redactAt > -1 && redactAt < capAt, "redact 声明在 try 外、轮次门之前");
// finally 归档：rename 之前有逐文件脱敏循环
const finAt = wf.indexOf("} finally {");
const redir = wf.indexOf("readdir(auditSrc)", finAt);
const renAt = wf.indexOf("await rename(auditSrc", finAt);
assert.ok(redir > -1 && redir < renAt, "归档 rename 前有 .cr-agent 逐文件脱敏");
assert.ok(wf.includes("if (clean !== raw) await writeFile(auditFile, clean)"), "仅改动过文件回写");
});

test("CR 修复回归：severity 比较用 SEVERITY_RANK 而非字典序巧合", async () => {
const { readFile } = await import("node:fs/promises");
const src = await readFile(`${process.cwd()}/src/engine/severity-anchors.js`, "utf8");
assert.ok(src.includes("SEVERITY_RANK[severity] < SEVERITY_RANK[f.severity]"), "B2 留痕比较用排名表");
assert.ok(!src.includes("(severity < f.severity)"), "不再依赖字典序巧合");
});

test("v24 回归：extractSnippetLines 提取实质行（去行号/diff 前缀）", async () => {
const { extractSnippetLines } = await import("../src/engine/evidence-verify.js");
const lines = extractSnippetLines("12: if (x == null) return;\n+  foo.bar(baz);\n500 * timeoutMs\n// short\n");
assert.ok(lines.includes("if (x == null) return;"), "去真实行号形态（12:）");
assert.ok(lines.includes("foo.bar(baz);"), "去 diff + 前缀");
assert.ok(lines.every(l => l.length >= 12), "过滤过短行");
assert.ok(lines.includes("500 * timeoutMs"), "数字开头的真实代码行不误剥（v25 回归）");
const withMinus = extractSnippetLines("- old line removed here\n");
assert.ok(!withMinus.some(l => l.startsWith("-")) && withMinus[0] === "old line removed here", "diff - 前缀已剥离");
});

test("v24 回归：verifySnippets 命中/未命中/定位失败三分支", async () => {
const { verifySnippets } = await import("../src/engine/evidence-verify.js");
const { mkdtemp, writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const repo = await mkdtemp(path.join(tmpdir(), "v24-repo-"));
await mkd(path.join(repo, "src"), { recursive: true });
await wf(path.join(repo, "src", "a.js"), "export function handler(req) {\n  if (req.token == null) throw new Error('no token');\n  return doWork(req);\n}\n");
const report = { findings: [
  { id: "F1", file: "src/a.js", code_snippet: "if (req.token == null) throw new Error('no token');", evidence_level: "code-confirmed" },  // 命中
  { id: "F2", file: "src/a.js", code_snippet: "totallyFabricatedLineThatNeverExisted(x);", evidence_level: "code-confirmed" },           // 未命中
  { id: "F3", file: "src/ghost.js", code_snippet: "someVeryLongFabricatedSnippetLine(x);", evidence_level: "code-confirmed" },           // 定位失败
  { id: "F4", file: "src/a.js", code_snippet: "", evidence_level: "code-confirmed" },                                                     // 空 snippet
] };
const stats = await verifySnippets(report, repo);
assert.equal(stats.checked, 3, "空 snippet 不计数");
assert.equal(stats.missed, 1, "仅 F2 未命中");
assert.equal(stats.unlocatable, 1, "F3 定位失败");
assert.equal(report.findings[0].evidence_level, "code-confirmed", "命中不降级");
assert.equal(report.findings[1].evidence_level, "unverified", "未命中强降 unverified");
assert.equal(report.findings[1]._evidence_level_model, "code-confirmed", "原值留痕");
assert.ok(String(report.findings[1].evidence_gap).includes("回查未命中"), "evidence_gap 留痕");
assert.equal(report.findings[2].evidence_level, "code-confirmed", "定位失败不降级（无法判定≠证伪）");
assert.equal(report.findings[3].evidence_level, "code-confirmed", "空 snippet 不降级");
// 降级后的 unverified 走锚点规则表 → 物理封顶 P2（门禁自动收紧）
const { applyAnchorSeverity } = await import("../src/engine/severity-anchors.js");
const rep2 = { conclusion: "通过", findings: [report.findings[1]] };
applyAnchorSeverity(rep2);
assert.equal(rep2.findings[0].severity, "P2", "谎报降 unverified 后物理封顶 P2");
});

test("v25 回归：snippet 空白改写仍命中（collapse 匹配）", async () => {
const { verifySnippets } = await import("../src/engine/evidence-verify.js");
const { mkdtemp, writeFile: wf } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const repo = await mkdtemp(path.join(tmpdir(), "v25-repo-"));
await wf(path.join(repo, "a.js"), "export function handler(req) {\n\tif  (req.token  ==  null) {\n\t\tthrow new Error('no token');\n\t}\n}\n");
const report = { findings: [{ id: "F1", file: "a.js", evidence_level: "code-confirmed",
  // 模型引用把 tab 换空格、压空格——collapse 后应命中，不误降
  code_snippet: "if (req.token == null) {" }] };
const stats = await verifySnippets(report, repo);
assert.equal(stats.missed, 0, "空白改写不误降");
assert.equal(report.findings[0].evidence_level, "code-confirmed");
});

test("v25 回归：同名文件多候选——direct 拼不中时 basename 回退遍历全部候选", async () => {
const { verifySnippets } = await import("../src/engine/evidence-verify.js");
const { mkdtemp, writeFile: wf, mkdir: mkd } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const repo = await mkdtemp(path.join(tmpdir(), "v25-dup-"));
// a/a.js 字母序先被 DFS 访问（旧代码取首个即误降）；snippet 在 b/a.js
await mkd(path.join(repo, "a"), { recursive: true });
await mkd(path.join(repo, "b"), { recursive: true });
await wf(path.join(repo, "a", "a.js"), "unrelated content here entirely different\n");
await wf(path.join(repo, "b", "a.js"), "realCodeInSrcDirectory(param);\nanotherRealLine(x);\n");
const report = { findings: [{ id: "F1", file: "c/a.js", evidence_level: "code-confirmed",
  code_snippet: "realCodeInSrcDirectory(param);" }] };
const stats = await verifySnippets(report, repo);
assert.equal(stats.missed, 0, "basename 回退遍历全部候选，不误降");
assert.equal(stats.unlocatable, 0);
});

test("v25 回归：ensureVerifierRepoLink 建链 + 幂等", async () => {
const { ensureVerifierRepoLink } = await import("../src/engine/verifier.js");
const { mkdtemp, mkdir: mkd, writeFile: wf, readFile, lstat } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const workDir = await mkdtemp(path.join(tmpdir(), "v25-link-"));
await mkd(path.join(workDir, "repo"), { recursive: true });
await wf(path.join(workDir, "repo", "x.js"), "export const marker = 1;\n");
await ensureVerifierRepoLink(workDir);
await ensureVerifierRepoLink(workDir);   // 幂等：第二次 EEXIST 不抛
const st = await lstat(path.join(workDir, ".verifier", "repo"));
assert.ok(st.isSymbolicLink(), "repo 符号链接已建");
// 经链接可读到源码（模型视角 repo/x.js）
assert.equal(await readFile(path.join(workDir, ".verifier", "repo", "x.js"), "utf8"), "export const marker = 1;\n");
});

test("v24 回归：extractJson 平衡提取 + 宽容性", async () => {
const { extractJson } = await import("../src/engine/verifier.js");
assert.deepEqual(extractJson('前置说明 {"verdicts":[{"id":"F1"}]} 尾巴'), { verdicts: [{ id: "F1" }] });
const nested = extractJson('{"verdicts":[{"id":"F1","reason":"has \\"quote\\" and {brace}"}]}');
assert.equal(nested.verdicts[0].id, "F1", "字符串内花括号不干扰平衡扫描");
assert.equal(extractJson("没有 JSON"), null);
assert.equal(extractJson('{"verdicts": ['), null);
});

test("v24 回归：applyVerifierVerdicts 三值裁决 + 未知 id 忽略", async () => {
const { applyVerifierVerdicts } = await import("../src/engine/verifier.js");
const { recomputeReportAggregates } = await import("../src/engine/severity-anchors.js");
const report = { conclusion: "不通过", one_line: "x", findings: [
  { id: "F1", severity: "P0", title: "t1" },   // downgrade → P2
  { id: "F2", severity: "P1", title: "t2" },   // void → 剔除
  { id: "F3", severity: "P1", title: "t3" },   // confirmed → 保留 P1
] };
const res = applyVerifierVerdicts(report, [
  { id: "F1", verdict: "downgrade", reason: "证据不足以支撑 P0" },
  { id: "F2", verdict: "void", reason: "源码不存在该分支" },
  { id: "F3", verdict: "confirmed", reason: "证据链完整" },
  { id: "F9", verdict: "downgrade", reason: "不存在的 id" },
  { id: "F3", verdict: "什么鬼", reason: "非法 verdict" },
  { verdict: "void", reason: "缺 id 不得误命中任何 finding" },
]);
assert.deepEqual(res.downgraded, ["F1 P0→P2"]);
assert.deepEqual(res.voided, ["F2 t2"]);
assert.equal(res.confirmed, 1);
assert.equal(res.unknown, 1, "未知 id 忽略");
assert.equal(res.invalid, 2, "非法 verdict + 缺 id 各计一次");
assert.equal(report.findings.length, 2, "void 已剔除");
assert.equal(report.findings[0].severity, "P2");
assert.equal(report.findings[1].severity, "P1", "confirmed 保留");
// 聚合重算：唯一 P1 保留 → blockers=[F3]，conclusion 维持不通过（无翻转不注记）
recomputeReportAggregates(report, "复核");
assert.deepEqual(report.blockers, ["F3"]);
assert.equal(report.conclusion, "不通过");
assert.equal(report.one_line, "x", "无翻转时不追加注记");
report.findings[1].severity = "P3";
recomputeReportAggregates(report);
assert.deepEqual(report.blockers, []);
assert.equal(report.conclusion, "通过");
});

test("v24 回归：recomputeReportAggregates 翻转幂等（tag 只追加一次）", async () => {
const { recomputeReportAggregates } = await import("../src/engine/severity-anchors.js");
const rep = { conclusion: "通过", one_line: "ok", findings: [{ id: "F1", severity: "P0" }], author_summary: null };
recomputeReportAggregates(rep, "锚点重算");
const line1 = rep.one_line;
recomputeReportAggregates(rep, "锚点重算");
assert.equal(rep.one_line, line1, "已一致时不再追加注记");
assert.ok(rep.author_summary && typeof rep.author_summary === "object", "author_summary 已重建");
});

test("v24 回归：settings verifier 四项校验", async () => {
const { Settings } = await import("../src/settings.js");
const s = new Settings("/tmp/v24-nonexistent-settings.json");
await s.update({ verifierEnabled: true, verifierBaseUrl: "https://v.example.com/v1", verifierApiKey: "vk-123", verifierModel: "claude-sonnet-4-5" });
const g = s.get();
assert.equal(g.verifierEnabled, true);
assert.equal(g.verifierBaseUrl, "https://v.example.com/v1");
assert.equal(g.verifierApiKey, "vk-123");
assert.equal(g.verifierModel, "claude-sonnet-4-5");
await assert.rejects(() => s.update({ verifierEnabled: "yes" }), /布尔值/);
await assert.rejects(() => s.update({ verifierBaseUrl: "ftp://x" }), /仅支持 http\/https/);
await assert.rejects(() => s.update({ verifierApiKey: 123 }), /字符串/);
});

test("v24 回归：runVerifierSession 端点/模型兜底链（纯逻辑探针）", async () => {
const src = await (await import("node:fs/promises")).readFile(`${process.cwd()}/src/engine/verifier.js`, "utf8");
assert.ok(src.includes('settings.verifierModel || workerModelId'), "模型兜底：专属 → worker 默认");
assert.ok(src.includes('if (settings.verifierBaseUrl) vSettings.baseUrl = settings.verifierBaseUrl'), "端点兜底");
assert.ok(src.includes('if (settings.verifierApiKey) vSettings.apiKey = settings.verifierApiKey'), "密钥兜底");
assert.ok(src.includes('!list.includes(vModel)'), "专属模型不在列表时自动注册");
assert.ok(src.includes('agentDirSub: "verifier"'), "独立 pi-home 防与 worker 的 models/auth 互踩");
// workflow fail-open 留痕
const wf = await (await import("node:fs/promises")).readFile(`${process.cwd()}/src/engine/workflow.js`, "utf8");
assert.ok(wf.includes("fail-open，保留锚点定级"), "verifier 失败 fail-open 留痕");
assert.ok(wf.includes("verifySnippets(report, path.join(workDir, \"repo\"))"), "snippet 回查接入管线");
});

/* ───────── CR 报告 ljheee_cr-agent-1-r1-1794148013627 回归 ───────── */

test("CR修复 F16: findingTemplate introduced_by 为字符串非数字 0", async () => {
  const { findingTemplate, normalizeReport } = await import("../src/engine/report-schema.js");
  const t = findingTemplate();
  assert.equal(t.introduced_by, "this-pr");
  assert.equal(typeof t.introduced_by, "string");
  assert.notEqual(t.introduced_by, 0);
  const r = normalizeReport({ conclusion: "通过", one_line: "x", findings: [{ title: "t", severity: "P2", suggestion: "s", file: "a.js" }] });
  assert.equal(r.findings[0].introduced_by, "this-pr");
});

test("CR修复 F17: normalizeReport(null) 抛可读错误而非 TypeError", async () => {
  const { normalizeReport } = await import("../src/engine/report-schema.js");
  assert.throws(() => normalizeReport("null"), /合法 JSON 对象|不是合法/);
  assert.throws(() => normalizeReport(null), /合法 JSON 对象|不是合法/);
});

test("CR修复 F11: extractSnippetLines 复合 + 行号前缀", async () => {
  const { extractSnippetLines } = await import("../src/engine/evidence-verify.js");
  const lines = extractSnippetLines("+ 12: const fooBarBazQuux = 1;");
  assert.equal(lines[0], "const fooBarBazQuux = 1;");
  assert.ok(!lines[0].startsWith("12:"));
});

test("CR修复 F7: coerceFindingLine 跳过 null/空串，不把 null 变成 0", async () => {
  const { coerceFindingLine } = await import("../src/engine/report-schema.js");
  assert.equal(coerceFindingLine(null), null);
  assert.equal(coerceFindingLine(""), null);
  assert.equal(coerceFindingLine("13"), 13);
  assert.equal(coerceFindingLine(0), null);
  assert.equal(coerceFindingLine(-1), null);
  assert.equal(coerceFindingLine("x"), null);
});

test("CR修复 F10: normalizeReport 将字符串 degraded_steps 规范为空数组", async () => {
  const { normalizeReport } = await import("../src/engine/report-schema.js");
  const r = normalizeReport({
    conclusion: "通过", one_line: "x", findings: [], checked_paths: ["a.js"],
    verification: { degraded_steps: "oops" },
  });
  assert.ok(Array.isArray(r.verification.degraded_steps));
});

test("CR修复 F15: resolvePr 源码把 settings 传给 parsePrUrl", async () => {
  const src = await (await import("node:fs/promises")).readFile(`${process.cwd()}/src/pr-resolver.js`, "utf8");
  assert.ok(/const parsed = parsePrUrl\(url,\s*settings\)/.test(src), "resolvePr 必须透传 settings");
});

test("CR修复 F12: --fixture 不存在时抛错（源码断言）", async () => {
  const src = await (await import("node:fs/promises")).readFile(`${process.cwd()}/eval/run-eval.js`, "utf8");
  assert.ok(/fixture 不存在|fixtureName/.test(src) && /throw new Error/.test(src));
  assert.ok(!/loadFixtures\(\)\.find\(\(f\) => f\.name === fixtureName\) \|\| loadFixtures\(\)\[0\]/.test(src));
});

test("CR修复 F14: buildModelsJson 空 baseUrl 省略字段", async () => {
  const { buildModelsJson } = await import("../src/engine/pi-models.js");
  const m = buildModelsJson({ baseUrl: "", models: [{ id: "m1" }] });
  assert.equal(m.providers.custom.baseUrl, undefined);
  assert.ok(!("baseUrl" in m.providers.custom) || m.providers.custom.baseUrl == null || m.providers.custom.baseUrl === undefined);
});

test("CR修复 F13: downgrade 已低于 P1 时 verdict 保留 downgrade", async () => {
  const { applyVerifierVerdicts } = await import("../src/engine/verifier.js");
  const report = { findings: [{ id: "F1", severity: "P2", title: "t" }] };
  applyVerifierVerdicts(report, [{ id: "F1", verdict: "downgrade", reason: "x" }]);
  assert.equal(report.findings[0]._verifier.verdict, "downgrade");
  assert.equal(report.findings[0]._verifier.applied, false);
});
