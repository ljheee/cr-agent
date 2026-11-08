/**
 * 审查账本（Review Ledger）
 *
 * 承接好的实践 + 修复痛点：
 *  - 好实践：问题 ID 跨轮稳定、"首次发现于" sha、previous_findings 复核（fixed/still_exists）
 *  - 痛点修复：
 *    1. 豁免清单（still_exists 345 条次重报 → 豁免后不再报）
 *    2. 存量 P3 不入账（风格类噪声治理）
 *    3. unverified 查证失败连续 2 轮 → 自动升级 needs_human，不再每轮重试
 *
 * 存储：data/ledgers/{repoSlug}#{pr}.json
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class Ledger {
  constructor(file) {
    this.file = file;
    this.data = {
      repo: "", pr: null, webUrl: "",
      rounds: [],        // 每轮：{round, mode, at, conclusion, model, head}
      findings: [],      // 问题账本（跨轮）
      exempt: [],        // 豁免清单
      lastHead: null,    // 上次审查的 head（用于增量判定）
    };
  }

  static async load(dataDir, repo, pr) {
    const slug = `${repo.replace(/[\/]/g, "_")}#${pr}`;
    const dir = path.join(dataDir, "ledgers");
    await mkdir(dir, { recursive: true });
    const l = new Ledger(path.join(dir, `${slug}.json`));
    try {
      l.data = { ...l.data, ...JSON.parse(await readFile(l.file, "utf8")) };
    } catch { /* 新账本 */ }
    l.data.repo = repo; l.data.pr = pr;
    return l;
  }

  async save() {
    // 临时文件 + rename 原子替换，避免进程崩溃截断账本
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    const { rename } = await import("node:fs/promises");
    await rename(tmp, this.file);
  }

  get round() { return this.data.rounds.length; }
  get lastHead() { return this.data.lastHead ?? null; }
  get previousFindings() {
    return this.data.findings.filter((f) => f.status !== "fixed" && f.status !== "not_applicable");
  }
  get exemptList() { return this.data.exempt; }

  /** 记录一轮结果，合并 findings，返回合并后的报告 */
  applyRound(report, meta = {}) {
    const roundNo = this.data.rounds.length + 1;
    this.data.rounds.push({
      round: roundNo, mode: meta.mode || "full", at: new Date().toISOString(),
      conclusion: report.conclusion, model: meta.model || "", thinking: meta.thinking || "",
      head: meta.head || null, trigger: meta.trigger || "manual",
    });
    if (meta.head) this.data.lastHead = meta.head;

    // 合并新 findings 入账
    // 序号取现有 P<n> 的最大 n（而非条目数：匹配/豁免/不入账的都会跳过，用 length 会重复发号）
    let seq = this.data.findings.reduce((m, f) => {
      const n = /^P(\d+)$/.exec(f.persist_id || "");
      return n ? Math.max(m, Number(n[1])) : m;
    }, 0);
    for (const f of report.findings || []) {
      // 存量 P3 风格类不入账（噪声治理）
      // 存量 P3 不入账（噪声治理）。设计取舍：程序化降档后的存量 P2 会变 P3 也不入账，
    // 每轮会重报但无法闭环/豁免——由报告内 finding 的"存量（程序判定）"标签引导作者自行加豁免；
    // 未来可考虑 demoted 条目以 pre-existing-demoted 状态入账
      if (f.introduced_by === "pre-existing" && f.severity === "P3") continue;
      // 已豁免的（按 file+title 模糊匹配）跳过
      if (this.isExempted(f)) continue;
      const existing = this.matchExisting(f);
      if (existing) {
        existing.last_seen_round = roundNo;
        // needs_human 是升级态：findings 重报也不能击穿（守卫与 previous_findings 循环一致）
        if (existing.status !== "needs_human") existing.status = "still_exists";
        existing.history.push({ round: roundNo, severity: f.severity, note: f.title });
      } else {
        this.data.findings.push({
          persist_id: `P${++seq}`, round_id: f.id, title: f.title, severity: f.severity,
          category: f.category, file: f.file, line: f.line,
          suggestion: f.suggestion, trace_ids: f.trace_ids || [], status: "open",
          first_seen_round: roundNo, first_seen_head: meta.head || null,
          last_seen_round: roundNo,
          unverified_rounds: 0,
          history: [{ round: roundNo, severity: f.severity, note: f.title }],
        });
      }
    }

    // 处理 previous_findings 复核结果
    // 只按 persist_id（P<n>）匹配：round_id（F<n>）是模型逐轮重新编号的序号，
    // 模型回显 F 编号时 find() 会误中历史同序号条目而错误关闭它；
    // 且本轮 findings 循环已新建/命中过的条目跳过（防模型自相矛盾：重报 + 判 fixed 最终误闭）
    const touched = new Set(this.data.findings.filter((x) => x.last_seen_round === roundNo && x.status !== "fixed").map((x) => x.persist_id));
    for (const pf of report.review?.previous_findings || []) {
      const target = this.data.findings.find((x) => x.persist_id === pf.id);
      if (!target || touched.has(target.persist_id)) continue;
      // needs_human 是查证失败的升级态，只允许人工/显式操作关闭，
      // 模型的 still_exists 复核不能把它降级回去（否则升级机制自相矛盾）
      if (target.status === "needs_human" && pf.status !== "fixed" && pf.status !== "not_applicable") continue;
      if (pf.status === "fixed") target.status = "fixed";
      else if (pf.status === "not_applicable") target.status = "not_applicable";
      else if (pf.status === "still_exists") target.status = "still_exists";
    }

    // unverified 升级：decision_changes 里 unverified 的 trace，连续 2 轮 → needs_human；
    // 已验证（consistent/conflicting）的 trace 同名条目关闭，不再滞留 stats。
    // 键稳定性：分桶轮的 trace_id 带 B{idx}- 桶前缀（展示用，防撞），后续不分桶轮模型用裸 T1 ——
    // 匹配时先按全键找，找不到则去前缀后按裸 id 找（B1-T1 与 T1 归并为同一逻辑查证点）
    for (const dc of report.decision_changes || []) {
      // status 白名单：模型输出垃圾值会被当作"查证成功"误关 trace 条目
      const DC_STATUS = ["consistent", "conflicting", "unverified", "needs_human"];
      if (!DC_STATUS.includes(dc.status)) continue;
      // 键稳定性：分桶轮的 trace_id 带 B{idx}- 前缀（展示防撞），后续轮可能用裸 id（或反之）。
      // 先按全键找；找不到则按"去前缀后的裸 id"找既有条目（B1-T1 与 T1 归并为同一逻辑查证点）
      let entry = this.data.findings.find((f) => f.persist_id === `trace:${dc.trace_id}`);
      if (!entry) {
        const bare = String(dc.trace_id || "").replace(/^B\d+-/, "");
        if (bare !== dc.trace_id) {
          entry = this.data.findings.find((f) =>
            (f.persist_id === `trace:${bare}` ||
             String(f.persist_id || "").replace(/^trace:B\d+-/, "trace:") === `trace:${bare}`));
          if (entry) {
            // 归并：把本轮键记为别名（防每轮新键漂移出孤儿条目）
            entry.trace_aliases = [...new Set([...(entry.trace_aliases || []), `trace:${dc.trace_id}`])];
          }
        }
      }
      if (dc.status !== "unverified") {
        // 查证成功 → 关闭对应 trace 条目（含去前缀归并后的，若无则不建）
        if (entry && entry.status !== "fixed") {
          entry.status = "fixed";
          entry.history.push({ round: roundNo, note: `查证成功关闭: ${dc.status}` });
        }
        continue;
      }
      if (!entry) {
        this.data.findings.push({
          persist_id: `trace:${dc.trace_id}`, round_id: dc.trace_id, title: `查证失败: ${dc.decision || ""}`.slice(0, 120),
          severity: "P2", category: "verification", file: dc.file, line: dc.line,
          suggestion: "请人工确认该判定点（Agent 连续查证失败已升级）", status: "open",
          unverified_rounds: 1, first_seen_round: roundNo, last_seen_round: roundNo,
          history: [{ round: roundNo, note: dc.decision || "" }],
        });
      } else {
        entry.unverified_rounds = (entry.unverified_rounds || 0) + 1;
        if (entry.unverified_rounds >= 2) entry.status = "needs_human";
      }
    }
    return roundNo;
  }

  isExempted(f) {
    return this.data.exempt.some((e) => {
      if (e.file && e.title_keyword) return f.file === e.file && f.title.includes(e.title_keyword);
      if (e.title_keyword) return f.title.includes(e.title_keyword);
      if (e.file) return f.file === e.file;   // 仅按文件豁免：该文件全部豁免
      return false;
    });
  }

  matchExisting(f) {
    // needs_human 也可匹配：模型复核确认仍存在时更新 last_seen/history，但状态不被降级（见 applyRound 守卫）
    return this.data.findings.find((x) => x.status === "open" || x.status === "still_exists" || x.status === "needs_human"
      ? x.file === f.file && x.title === f.title : false);
  }

  addExempt(entry) {
    this.data.exempt.push({ ...entry, exempted_at: new Date().toISOString(), exempted_by: entry.exempted_by || "user" });
  }

  removeExempt(index) {
    this.data.exempt.splice(index, 1);
  }

  /** 供提示词使用的历史问题清单 */
  previousFindingsForPrompt() {
    return this.previousFindings.map((f) => ({
      id: f.persist_id, severity: f.severity, title: f.title,
      file: f.file, line: f.line, suggestion: (f.suggestion || "").slice(0, 200),
      status: f.status,
    }));
  }

  stats() {
    const by = (k) => this.data.findings.reduce((a, f) => ((a[f[k]] = (a[f[k]] || 0) + 1), a), {});
    // 采纳率（fix detector 思路：后续轮模型复核 fixed / 仍存在 / 升级的比例）。
    // 只计真实 findings：trace: 查证条目是 agent 自身的查证闭环（关闭≠作者采纳），
    // needs_human 是 agent 失败升级态——均不计入分母（注释与代码一致：judged = fixed+not_applicable+still_exists）
    const realFindings = this.data.findings.filter((f) => !String(f.persist_id || "").startsWith("trace:"));
    const closed = realFindings.filter((f) => ["fixed", "not_applicable"].includes(f.status));
    const judged = closed.length + realFindings.filter((f) => f.status === "still_exists").length;
    return {
      rounds: this.data.rounds.length,
      total_findings: this.data.findings.length,
      open: this.data.findings.filter((f) => f.status === "open" || f.status === "still_exists").length,
      fixed: this.data.findings.filter((f) => f.status === "fixed").length,
      needs_human: this.data.findings.filter((f) => f.status === "needs_human").length,
      by_severity: by("severity"), by_status: by("status"),
      exempt: this.data.exempt.length,
      // 采纳率 = 已关闭（fixed+not_applicable）/ 已复核（closed+still_exists，不含 needs_human）；无复核历史时为 null
      adoption_rate: judged > 0 ? Number((closed.length / judged).toFixed(2)) : null,
    };
  }
}
