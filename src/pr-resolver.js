/**
 * PR 链接解析与 diff 获取
 *
 * 支持的平台 URL 形态：
 *  - GitHub:     https://github.com/{owner}/{repo}/pull/{number}
 *  - GitLab:     https://gitlab.example.com/{group}/{repo}/-/merge_requests/{number}
 *  - Bitbucket:  https://bitbucket.example.com/{project}/repos/{repo}/pull-requests/{number}/overview
 *  - 通用:       任意 host，路径含 /pull/{n}、/pulls/{n}、/merge_requests/{n}、/pull-requests/{n}
 *
 * diff 获取策略（按序 fallback）：
 *  1. 平台 API（GitHub/GitLab/Bitbucket，需 token，可配置）
 *  2. git CLI（git fetch origin PR ref + git diff base...head，适用于有 clone 权限的环境）
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const exec = promisify(execFile);
// 大 PR 的 diff 全量 stdout 默认 1MB 必炸；统一 64MB + 120s 超时（与 fetch 对齐，防网络半开挂死）
const GIT_EXEC_OPTS = { maxBuffer: 64 * 1024 * 1024, timeout: 120000 };

/** diff 是否含真实内容行（+/- 且非 +++/--- 文件头）——拼装结果防线：无内容行则视为失败，走 git 兜底 */
function hasContentLines(diff) {
  // 标记后必须至少一个字符（.）：全部是裸 "+"/"-" 的剥离型 diff（字段名不匹配渲染出的空行）同样判失败
  return /^\+(?!\+\+)./m.test(diff || "") || /^-(?!--)./m.test(diff || "");
}

/** Bitbucket Server JSON diff 渲染为 unified diff（降级路径：无 @@ 行号头，行号校验自动跳过） */
function renderBitbucketJsonDiff(j) {
  return (j.diffs || []).map((d) => {
    // 删除文件 destination 为空/新增文件 source 为空：对称兑底到另一侧路径（与 git 同路径惯例一致），
    // 否则产出 b/ 空→ parseFiles 正则不认 → 文件丢失且内容行泄漏进上一桶
    const src = d.source?.toString || d.destination?.toString || "dev/null";
    const dest = d.destination?.toString || d.source?.toString || "dev/null";
    const body = (d.hunks || []).map((h) =>
      (h.segments || []).map((seg) =>
        (seg.lines || []).map((l) => `${seg.type === "ADDED" ? "+" : seg.type === "REMOVED" ? "-" : " "}${l.text ?? l.line ?? ""}`).join("\n")
      ).join("\n")
    ).join("\n");
    return `diff --git a/${src} b/${dest}\n${body}`;
  }).join("\n");
}

/**
 * 解析 PR 链接。
 * @param {string} url
 * @returns {{platform:string, host:string, repo:string, pr:number, webUrl:string}}
 * @throws {Error} 无法识别
 */
export function parsePrUrl(url, settings) {
  if (!url || typeof url !== "string") throw new Error("PR 链接不能为空");
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("请提供完整的 http(s) PR 链接");

  let u;
  try { u = new URL(url); } catch { throw new Error("URL 格式不合法"); }

  // host 含端口（u.hostname 丢弃端口会导致 API/git URL 连错端点）
  const host = u.host;
  const segments = u.pathname.split("/").filter(Boolean);

  const patterns = [
    { // GitHub /pull/{n}
      re: /^(\d+)$/, kind: "pull", offset: 1,
    },
  ];

  // 依次匹配常见 PR 路径形态
  // GitLab: 任意位置 merge_requests/{n}（兼容 group/sub/repo/-/merge_requests/7/diffs 等后缀形态）
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === "merge_requests" && /^\d+$/.test(segments[i + 1])) {
      const repoSegs = segments.slice(0, i).filter((s) => s !== "-");
      return { platform: detectPlatform(host, settings), host, repo: repoSegs.join("/"), pr: Number(segments[i + 1]), webUrl: url };
    }
  }
  // GitHub: owner/repo/pull/123
  if (segments.length >= 4 && segments[2] === "pull" && /^\d+$/.test(segments[3])) {
    return { platform: detectPlatform(host, settings), host, repo: `${segments[0]}/${segments[1]}`, pr: Number(segments[3]), webUrl: url };
  }
  // GitHub new UI: owner/repo/pulls/123
  if (segments.length >= 4 && segments[2] === "pulls" && /^\d+$/.test(segments[3])) {
    return { platform: detectPlatform(host, settings), host, repo: `${segments[0]}/${segments[1]}`, pr: Number(segments[3]), webUrl: url };
  }
  // GitLab: group/repo/-/merge_requests/123
  if (segments.length >= 5 && segments[segments.length - 3] === "-" && segments[segments.length - 2] === "merge_requests" && /^\d+$/.test(segments[segments.length - 1])) {
    return { platform: detectPlatform(host, settings), host, repo: segments.slice(0, segments.length - 3).join("/"), pr: Number(segments[segments.length - 1]), webUrl: url };
  }
  // Bitbucket: project/repos/repo/pull-requests/123
  if (segments.length >= 5 && segments[1] === "repos" && segments[2] !== undefined && segments[3] === "pull-requests" && /^\d+$/.test(segments[4])) {
    return { platform: detectPlatform(host, settings), host, repo: `${segments[0]}/${segments[2]}`, pr: Number(segments[4]), webUrl: url };
  }
  // Bitbucket older: projects/P/repos/r/pull-requests/123
  if (segments.length >= 6 && segments[0] === "projects" && segments[2] === "repos" && segments[4] === "pull-requests" && /^\d+$/.test(segments[5])) {
    return { platform: detectPlatform(host, settings), host, repo: `${segments[1]}/${segments[3]}`, pr: Number(segments[5]), webUrl: url };
  }
  // 兜底：路径中任意位置 pull|pulls|merge_requests|pull-requests|pr 后紧跟数字
  // （"pr" 覆盖新 UI 形态如 /code/repo/{p}/{r}/pr/{n}）
  for (let i = 0; i < segments.length - 1; i++) {
    if (/^(pull|pulls|merge_requests|pull-requests|pr)$/.test(segments[i]) && /^\d+$/.test(segments[i + 1])) {
      const repoSegs = segments.slice(0, i).filter((s) => s !== "-" && s !== "projects" && s !== "code" && s !== "repo");
      return {
        platform: detectPlatform(host, settings), host,
        repo: repoSegs.slice(-2).join("/") || repoSegs.join("/"),
        pr: Number(segments[i + 1]),
        webUrl: url,
      };
    }
  }
  throw new Error(`无法从链接识别 PR 编号: ${url}`);
}

function detectPlatform(host, settings) {
  // 优先用户自定义域名映射（hostPlatforms：{ "abc.com": "bitbucket" }），
  const custom = settings?.hostPlatforms?.[host];
  if (custom) return custom;
  // host 是白名单验证过的合法域名，仅做后缀匹配防子域名错觉（github.evil.example 不匹配 github.com）
  const customHit = Object.entries(settings?.hostPlatforms || {}).find(([h]) => host.endsWith("." + h) || host === h);
  if (customHit) return customHit[1];
  if (/github\./i.test(host)) return "github";
  if (/gitlab/i.test(host)) return "gitlab";
  if (/bitbucket|stash/i.test(host)) return "bitbucket";
  return "generic";
}

/**
 * GitHub REST API base：
 *  - 公网 github.com → https://api.github.com（无 /api/v3 前缀）
 *  - GitHub Enterprise Server → https://{host}/api/v3
 * host 可带端口（GHE 自建常见）。
 */
export function githubApiBase(host) {
  const bare = String(host || "").replace(/:\d+$/, "").toLowerCase();
  if (bare === "github.com" || bare === "www.github.com") return "https://api.github.com";
  return `https://${host}/api/v3`;
}

/**
 * 通过平台 API 获取 PR 元数据 + diff。
 * token 从 settings 读取（平台维度的 token map）。
 */
export async function fetchPrViaApi(parsed, settings) {
  const { platform, host, repo, pr } = parsed;
  const tokens = settings?.platformTokens || {};
  // token 严格按 host 精确匹配：平台级兜底（tokens[platform]）配合子串域名识别
  // 会把真实 token 发给 github.evil.example 之类的任意主机（凭证外带）
  const token = tokens[host] || "";

  let apiUrl;
  const headers = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["PRIVATE-TOKEN"] = token;   // GitLab
    headers["x-api-key"] = token;        // Bitbucket
  }

  if (platform === "github") {
    apiUrl = `${githubApiBase(host)}/repos/${repo}/pulls/${pr}`;
    headers["Accept"] = "application/vnd.github.v3.diff";
  } else if (platform === "gitlab") {
    // 主请求用 MR 详情端点（/diffs 返回纯数组拿不到 title/head）；diff 分页另拉
    apiUrl = `https://${host}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests/${pr}`;
    headers["Accept"] = "application/json";
  } else if (platform === "bitbucket") {
    // PR 详情（含 head/base sha，增量判定依赖）—— diff 端点返回 JSON 需另行拼装
    const [project, slug] = repo.split("/");
    if (!project || !slug) throw new Error(`Bitbucket 仓库名需 project/repo 形式，实际 ${repo}`);
    apiUrl = `https://${host}/rest/api/1.0/projects/${project}/repos/${slug}/pull-requests/${pr}`;
    headers["Accept"] = "application/json";
  } else {
    throw new Error(`generic 平台无 API 策略，请使用 git 模式`);
  }

  const res = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(60000) }); // 60s 超时：undici 默认 headers/body timeout 各 300s，翻页最坏 ~55min 会挂死并发闸位与锁
  if (!res.ok) throw new Error(`平台 API ${res.status}`);

  const meta = {};
  const ct = res.headers.get("content-type") || "";
  let diff;
  if (ct.includes("json")) {
    const j = await res.json();
    if (platform === "github") {
      meta.title = j.title; meta.author = j.user?.login; meta.base = j.base?.sha; meta.head = j.head?.sha;
      meta.state = j.state; meta.commits = j.commits; meta.files = j.changed_files;
      diff = await fetchDiffAgain(parsed, headers);
    } else if (platform === "gitlab") {
      meta.title = j.title; meta.author = j.author?.username;
      meta.head = j.sha; meta.base = j.diff_refs?.base_sha; meta.state = j.state;
      // /diffs 端点默认每页 ~20 条：大 MR 必须翻页，否则静默丢文件
      const diffEntries = [];
      let pageFailed = false;
      let truncated10Pages = false;
      for (let page = 1; page <= 10; page++) {
        const rd = await fetch(`https://${host}/api/v4/projects/${encodeURIComponent(repo)}/merge_requests/${pr}/diffs?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(30000) }); // 翻页单请求 30s
        if (!rd.ok) {
          // page 1 失败：throw 走 git 兑底；中途失败但已拿到部分：宁失败勿静默——丢文件比失败更危险
          if (diffEntries.length) { pageFailed = true; break; }
          throw new Error(`GitLab diffs 分页拉取失败：${rd.status}`);
        }
        const jd = await rd.json().catch(() => null);
        const arr = Array.isArray(jd) ? jd : (jd?.diffs || []);
        if (!arr.length) break;
        diffEntries.push(...arr);
        if (arr.length === 100 && page === 10) truncated10Pages = true; // >1000 条 MR：上限声明而非静默截断
        if (arr.length < 100) break;
      }
      if (truncated10Pages) meta.diff_truncated = "GitLab diffs 超 10 页上限（>1000 条目），超出部分未包含";
      if (pageFailed) throw new Error("GitLab diffs 翻页中途失败（已拒绝静默截断，走 git 兑底）");
      const diffs = diffEntries.map((d) => `diff --git a/${d.old_path} b/${d.new_path}\n${d.diff}`).join("\n");
      if (!hasContentLines(diffs)) throw new Error("GitLab diff 拼装失败（无内容行）");
      return { meta, diff: diffs };
    } else {
      // Bitbucket PR 详情：meta 从 JSON 取，diff 优先单独拉原始 unified diff（text/plain），
      // JSON 分段渲染作降级兑底；两路都无内容行则 throw —— resolvePr 会走 git 兑底而非静默空审
      meta.title = j.title; meta.author = j.author?.slug;
      meta.state = j.state; meta.head = j.fromRef?.latestChangeset ?? j.fromRef?.latestCommit; meta.base = j.toRef?.latestChangeset ?? j.toRef?.latestCommit;
      meta.files = j.changesCount;
      const [proj, slug] = repo.split("/");
      try {
        diff = await fetchDiffAgain(parsed, headers);   // Accept: text/plain 原始 unified diff
      } catch { diff = ""; }
      if (!hasContentLines(diff)) {
        try {
          const r3 = await fetch(`https://${host}/rest/api/1.0/projects/${proj}/repos/${slug}/pull-requests/${pr}/diff`, { headers: { ...headers, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
          if (r3.ok) diff = renderBitbucketJsonDiff(await r3.json());
        } catch { /* 交由下方校验判定 */ }
      }
      if (!hasContentLines(diff)) throw new Error("Bitbucket diff 获取失败（无内容行）");
    }
  } else {
    diff = await res.text();
    // GitHub 带 Accept: diff 头时返回纯文本 diff，meta 为空 —— 补拉 JSON 元数据（增量判定依赖 meta.head）
    if (platform === "github" && !meta.head) {
      try {
        const r2 = await fetch(`${githubApiBase(host)}/repos/${repo}/pulls/${pr}`, {
          headers: { ...headers, Accept: "application/vnd.github+json" },
        });
        if (r2.ok) {
          const j2 = await r2.json();
          meta.title = j2.title; meta.author = j2.user?.login;
          meta.base = j2.base?.sha; meta.head = j2.head?.sha;
          meta.state = j2.state; meta.commits = j2.commits; meta.files = j2.changed_files;
        }
      } catch { /* 元数据失败不阻塞 diff 流程 */ }
    }
  }
  return { meta, diff };
}

async function fetchDiffAgain(parsed, headers) {
  const { platform, host, repo, pr } = parsed;
  let url;
  if (platform === "github") url = `${githubApiBase(host)}/repos/${repo}/pulls/${pr}`;
  else if (platform === "bitbucket") {
    const [p, s] = repo.split("/");
    url = `https://${host}/rest/api/1.0/projects/${p}/repos/${s}/pull-requests/${pr}/diff`;
  } else throw new Error("no diff endpoint");
  headers["Accept"] = platform === "github" ? "application/vnd.github.v3.diff" : "text/plain";
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`diff 拉取 ${r.status}`);
  const text = await r.text();
  // 空 200/错误体防线：无内容行即 throw 走 git 兜底（与 GitLab/Bitbucket 拼装同款防线）
  if (!hasContentLines(text)) throw new Error("diff 端点返回无内容行");
  return text;
}

/**
 * 内置：Web/API 域名 → 可 SSH clone 的 git 主机。
 * 仅覆盖公网已知分叉；自建域名靠 settings.sshHostMap。
 * 精确匹配（含端口），不做后缀模糊——SSH 指错主机等于凭证打到错误机器。
 */
const DEFAULT_SSH_HOST_MAP = Object.freeze({
  "www.github.com": "github.com",
  "api.github.com": "github.com",
});

/**
 * ssh 兑底远端的 host 映射：部分平台 API/Web 域名不提供 git ssh 服务。
 * 优先级：settings.sshHostMap[host] > 内置默认 > 原 host。
 */
export function sshHostFor(host, settings) {
  if (!host) return host;
  const custom = settings?.sshHostMap?.[host];
  if (typeof custom === "string" && custom) return custom;
  return DEFAULT_SSH_HOST_MAP[host] || host;
}

/**
 * 构造 git 远端 URL。凭证优先级：
 * 1. gitScheme=ssh（或环境有 ssh key 且 https+token 走不通时自动降级尝试）→ ssh://git@host/repo.git
 * 2. settings.platformTokens[host] → https://<token>@host/repo.git（Bitbucket Server HTTP PAT）
 */
export function gitUrlFor(parsed, settings) {
  const { host, repo } = parsed;
  const scheme = settings?.gitScheme || "https";
  if (scheme === "ssh") return `ssh://git@${sshHostFor(host, settings)}/${repo}.git`;
  const cred = settings?.platformTokens?.[host];
  // token 需 URL 编码：含 / @ : 等字符的 token 直接拼会坏 URL
  const authPrefix = cred ? `${encodeURIComponent(cred)}@` : "";
  return `${scheme}://${authPrefix}${host}/${repo}.git`;
}

/** 检测环境是否有可用 ssh key（存在即认为可用；BatchMode 下失败会快速报错，不影响降级链） */
function hasSshKey() {
  try {
    const home = process.env.HOME || "/root";
    return existsSync(path.join(home, ".ssh", "id_rsa")) || existsSync(path.join(home, ".ssh", "id_ed25519"));
  } catch { return false; }
}

/**
 * 通过 git CLI 获取 diff：浅 fetch PR head 分支并与 base 比对。
 * 适用于有 git ssh/http
 */
export async function fetchPrViaGit(parsed, settings, opts = {}) {
  const { platform, host, repo, pr } = parsed;
  const { keepRepo } = opts; // keepRepo：指定目录时不清理临时 clone，供工作区落源码树复用
  // Bitbucket PR ref: refs/pull-requests/{n}/from；GitHub: refs/pull/{n}/head；GitLab: merge-requests/{n}/head
  const prRefs = {
    github: [`refs/pull/${pr}/head`],
    gitlab: [`refs/merge-requests/${pr}/head`, `refs/merge-requests/${pr}/merge`],
    bitbucket: [`refs/pull-requests/${pr}/from`, `refs/pull-requests/${pr}/raw`],
    generic: [`refs/pull/${pr}/head`, `refs/pull-requests/${pr}/from`, `refs/merge-requests/${pr}/head`],
  }[platform] || [`refs/pull/${pr}/head`];

  // 远端候选链（按优先级）：https(+token) → http(+token) → ssh（仅当环境已有 key 时作最末尾兑底）。
  // ssh 依赖部署环境预置的 ~/.ssh/id_rsa（通用环境不一定有），
  // 故仅作兑底且绝不作为首选；https+token 对 API PAT 常被 重定向拒掉，ssh 兑底实测可用
  const remoteCandidates = [];
  const originUrl = gitUrlFor(parsed, settings); // 尊重显式 gitScheme（https/http/ssh/file）
  remoteCandidates.push(originUrl);
  // 显式指定 ssh 时不重复；host 存在且环境有 key 时追加 ssh 兑底
  if (settings?.gitScheme !== "ssh" && host && hasSshKey()) {
    remoteCandidates.push(`ssh://git@${sshHostFor(host, settings)}/${repo}.git`);
  }
  const sshEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o StrictHostKeyChecking=no -o BatchMode=yes" };
  const env = sshEnv;
  const dir = keepRepo || await mkdtemp(path.join(tmpdir(), `cr-pr-${pr}-`));
  if (keepRepo) await mkdir(keepRepo, { recursive: true }); // cwd 不存在时 spawn 直接 ENOENT
  try {
    // 错误信息脱敏：凭证不出现在任何报错里（git 报错常带完整 URL）
    const cred = settings?.platformTokens?.[host];
    const sanitize = (msg) => {
      let s = String(msg);
      if (cred) s = s.split(cred).join("***");
      return s.split("@").length > 1 ? s.replace(/\/\/[^@/]+@/, `//${host}/`) : s;
    };

    await exec("git", ["init", "-q"], { cwd: dir, env });
    await exec("git", ["remote", "add", "origin", remoteCandidates[0]], { cwd: dir, env });

    // 远端候选逐个尝试 fetch：https(+token) 失败（重定向/401）自动切 ssh
    let headSha = null, fetchErrs = [];
    for (const remoteUrl of remoteCandidates) {
      if (remoteUrl !== remoteCandidates[0]) await exec("git", ["remote", "set-url", "origin", remoteUrl], { cwd: dir, env });
      for (const ref of prRefs) {
        try {
          await exec("git", ["fetch", "--depth=51", "origin", `${ref}:prhead`], { cwd: dir, env, timeout: 120000 });
          headSha = ref;
          break;
        } catch (e) { fetchErrs.push(`${ref}: ${sanitize(e.message).slice(0, 120)}`); }
      }
      if (headSha) break;
    }
    if (!headSha) throw new Error(`git fetch PR ref 失败: ${fetchErrs.join(" | ")}`);

    const head = (await exec("git", ["rev-parse", "prhead"], { cwd: dir, env })).stdout.trim();
    // keepRepo：fetch 成功即 checkout 源码树（必须在下方 diff 校验之前——浅 fetch merge-base 缺失时
    // 空 diff 防线会 throw，若 checkout 放在那之后，源码树永远落不了盘）
    if (keepRepo) {
      await exec("git", ["checkout", "-q", "prhead"], { cwd: dir, env });
      // 凭证不落盘：fetch 完成后把 origin 改写为无 token URL（agent 只需本地树；.git/config 不再残留 PAT）
      const cleanOrigin = gitUrlFor(parsed, { ...settings, platformTokens: {} });
      await exec("git", ["remote", "set-url", "origin", cleanOrigin], { cwd: dir, env }).catch(() => {});
    }
    // merge-base 与 diff：fetch 主分支做 base（尽力而为）
    // 注意：`git fetch origin <branch>` 只创建 refs/remotes/origin/<branch>，不创建本地 <branch> ref，
    // 后续 diff 必须引用 origin/<branch>（引用本地名会 fatal: ambiguous argument，已在 git 2.50 实测）
    let base = null;
    for (const main of ["master", "main", "develop"]) {
      try {
        await exec("git", ["fetch", "--depth=51", "origin", main], { cwd: dir, env, timeout: 120000 });
        // merge-base 校验：--depth=51 截断时分叉超过 51 个 commit 时 merge-base 缺失，
        // 三点 diff 会退化到不可预期结果，此时放弃该 base 继续尝试/回退 head~1
        await exec("git", ["merge-base", `origin/${main}`, "prhead"], { cwd: dir, env });
        base = `origin/${main}`;
        break;
      } catch { /* try next */ }
    }

    let diff;
    const files = (await exec("git", ["diff", "--name-only", base ? `${base}...prhead` : "prhead~1..prhead"], { cwd: dir, env, ...GIT_EXEC_OPTS })).stdout.trim();
    const stat = (await exec("git", ["diff", "--stat", base ? `${base}...prhead` : "prhead~1..prhead"], { cwd: dir, env, ...GIT_EXEC_OPTS })).stdout.trim();
    diff = (await exec("git", ["diff", "--find-renames", base ? `${base}...prhead` : "prhead~1..prhead"], { cwd: dir, env, ...GIT_EXEC_OPTS })).stdout;

    const log = (await exec("git", ["log", "--oneline", "-20", base ? `${base}..prhead` : "prhead"], { cwd: dir, env, ...GIT_EXEC_OPTS })).stdout.trim();

    // 空diff防线：base...prhead 在浅 fetch（depth=51）下 merge-base 缺失会退化出空 diff，
    // 曾导致静默空审（changedLines=0 误走 fast_path）。无内容行则报错让上层走降级/报错，而非静默空审
    if (!hasContentLines(diff)) throw new Error(`git 通道 diff 无内容行（base=${base || "head~1"}），疑似浅 fetch merge-base 退化或 PR ref 异常`);

    return {
      meta: {
        head, base: base ? base.replace(/^origin\//, "") : "(default branch not fetched, used head~1)",
        title: `PR #${pr} (${repo})`,
        filesChanged: files ? files.split("\n") : [],
        stat, commits: log,
        fetchedVia: `git ${headSha} base=${base ? base.replace(/^origin\//, "") : "head~1"}`,
      },
      diff,
      ...(keepRepo ? { repoDir: dir } : {}),
    };
  } finally {
    if (!keepRepo) rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * 主入口：解析链接并获取 diff（API 优先，git 兜底）。
 */
export async function resolvePr(url, settings, opts = {}) {
  const parsed = parsePrUrl(url, settings);
  const { withRepo } = opts; // withRepo：源码树落盘目录；提供时 git 通道把仓库 checkout 到该目录（diff 仍走 API 优先）
  let result = null, errors = [];
  if (settings?.usePlatformApi !== false) {
    try { result = await fetchPrViaApi(parsed, settings); }
    catch (e) { errors.push(`api: ${e.message}`); }
  }
  if (!result) {
    try { result = await fetchPrViaGit(parsed, settings, { keepRepo: withRepo || undefined }); }
    catch (e) { errors.push(`git: ${e.message}`); }
  }
  // API 通道成功但需源码树：git 通道仅负责浅 fetch + checkout（diff 以 API 为准；失败不阻断审查，仅缺源码树）
  if (result && withRepo && !result.repoDir) {
    try {
      const g = await fetchPrViaGit(parsed, settings, { keepRepo: withRepo });
      if (g?.repoDir) result.repoDir = g.repoDir;
    } catch { /* 源码树属增强能力，失败降级为仅 diff 审查 */ }
  }
  if (!result) {
    throw new Error(`获取 PR 失败（${parsed.repo}#${parsed.pr}）：${errors.join("；").slice(0, 500)}`);
  }
  return { ...parsed, ...result, resolveErrors: errors };
}
