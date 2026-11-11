/**
 * 反夸大钳制（窄域、可机器判定）
 *
 * 核实结论：夸大主因是「观察成立 + 后果/可达性写重」，不是 P0/P1 阈值失灵。
 * 只做封闭规则，不做通用 reachability / 标题 NLP：
 *  1. code-confirmed|test-confirmed 无可用 snippet → unverified；certain 无 snippet → data-dependent
 *  2. 文档/锁文件/测试路径强制 category=delivery（卫生项走 P3-C3；纯文档再压 impact=none）
 *  3. Settings.update 已校验字段的「缺守卫」叙事 → impact=none + delivery（最高 P3）
 *
 * 在 verifySnippets 之后、applyAnchorSeverity 之前调用。
 */

import { extractSnippetLines } from "./evidence-verify.js";

/** Settings.update 已做正整数/枚举校验的字段（手改磁盘才能绕过） */
const SETTINGS_GUARDED_FIELDS = [
  "maxDiffChars",
  "maxConcurrentReviews",
  "bundleConcurrency",
  "maxRounds",
  "defaultThinking",
  "gitScheme",
  "usePlatformApi",
  "verifierEnabled",
];

/** 纯卫生路径：强制 delivery + impact none → P3-C1 */
const HYGIENE_PATH_RE = /(?:^|\/)(?:README(?:\.\w+)?|\.gitignore|package-lock\.json|CHANGELOG(?:\.\w+)?|LICENSE(?:\.\w+)?|docs\/)/i;

/** 测试/评测路径：强制 delivery（保留原 impact，靠 P3-C3-delivery-cap） */
const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|eval|fixtures)\//i;
const TEST_FILE_RE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function hasUsableSnippet(f) {
  return extractSnippetLines(f?.code_snippet).length > 0;
}

function textBlob(f) {
  return [f?.title, f?.evidence, f?.suggestion, f?.impact, f?.evidence_gap]
    .map((x) => String(x || ""))
    .join("\n");
}

function markClamp(f, tag) {
  f._anchor_clamp = f._anchor_clamp ? `${f._anchor_clamp}+${tag}` : tag;
}

/**
 * 按路径强制一级轴。非卫生路径返回 null（不改模型 category）。
 * @returns {"delivery"|null}
 */
export function forceCategoryByPath(file) {
  const p = String(file || "").replace(/\\/g, "/");
  if (!p) return null;
  if (HYGIENE_PATH_RE.test(p) || TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p)) return "delivery";
  return null;
}

function isHygieneDocPath(file) {
  return HYGIENE_PATH_RE.test(String(file || "").replace(/\\/g, "/"));
}

/** 命中「Settings 已守卫字段」窄域降档 */
export function isKnownSettingsGuardFinding(f) {
  const file = String(f?.file || "").replace(/\\/g, "/");
  // 仅 settings.js / prompts.js：API 更新路径已校验，缺本地切片≠运行时必炸
  if (!/(?:^|\/)settings\.js$/.test(file) && !/(?:^|\/)prompts\.js$/.test(file)) return false;
  const blob = textBlob(f);
  return SETTINGS_GUARDED_FIELDS.some((name) => blob.includes(name));
}

/**
 * 原地钳制 findings 锚点；返回统计。
 */
export function clampExaggerationAnchors(report) {
  const stats = { checked: 0, noSnippet: 0, certainDemoted: 0, pathForced: 0, hygieneNone: 0, settingsGuard: 0 };
  if (!report || !Array.isArray(report.findings)) return stats;

  for (const f of report.findings) {
    if (!f || typeof f !== "object") continue;
    stats.checked++;

    // 1) 证据/触发硬约束：无可用 snippet 不得声称已确认或必然触发
    const usable = hasUsableSnippet(f);
    if (!usable) {
      if (f.evidence_level === "code-confirmed" || f.evidence_level === "test-confirmed") {
        f._evidence_level_model = f.evidence_level;
        f.evidence_level = "unverified";
        if (!f.evidence_gap) f.evidence_gap = "无可用 code_snippet，程序化降为 unverified";
        markClamp(f, "no-snippet");
        stats.noSnippet++;
      }
      if (f.trigger === "certain") {
        f._trigger_model = f.trigger;
        f.trigger = "data-dependent";
        markClamp(f, "certain-no-path");
        stats.certainDemoted++;
      }
    }

    // 2) 路径钳制 category（防 correctness/security 逃逸 delivery 卫生门）
    const forced = forceCategoryByPath(f.file);
    if (forced) {
      if (f.category !== forced) {
        f._category_model = f.category;
        f.category = forced;
        f.dimension = forced;
        markClamp(f, "path-category");
        stats.pathForced++;
      }
      if (isHygieneDocPath(f.file) && f.impact_radius !== "none") {
        f._impact_radius_model = f.impact_radius;
        f.impact_radius = "none";
        markClamp(f, "hygiene-none");
        stats.hygieneNone++;
      }
    }

    // 3) 已知 Settings 守卫：缺本地切片守卫 ≠ 运行时必炸
    if (isKnownSettingsGuardFinding(f)) {
      if (f.impact_radius !== "none") {
        f._impact_radius_model = f._impact_radius_model || f.impact_radius;
        f.impact_radius = "none";
      }
      if (f.category !== "delivery") {
        f._category_model = f._category_model || f.category;
        f.category = "delivery";
        f.dimension = "delivery";
      }
      markClamp(f, "known-settings-guard");
      stats.settingsGuard++;
    }
  }
  return stats;
}
