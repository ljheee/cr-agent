/**
 * 可选 Skills / MCP 发现（维护者在 cr-agent 根目录配置；空=与现在一致不启用）
 *
 * 约定：
 *  - skills：根目录 `skills/`（或 settings.skillDir），有 SKILL.md / .md 才启用
 *  - MCP：根目录 `.pi/mcp.json`（SDK 同款 mcpServers）；有启用的 server 才挂扩展
 *
 * 注意：配置读的是 **cr-agent 安装根**，不是被审 PR 的 workDir（防仓库投毒）。
 */
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** cr-agent 包根（src/engine → ../..） */
export const PACKAGE_ROOT = path.resolve(__dirname, "../..");

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** 目录是否含可加载 skill（SKILL.md 或根级 .md） */
export async function skillDirHasContent(dir) {
  if (!(await exists(dir))) return false;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    // 说明文档不算 skill，避免仅放 README 就误开
    if (e.isFile() && e.name.endsWith(".md") && !/^readme\.md$/i.test(e.name)) return true;
    if (e.isDirectory()) {
      if (await exists(path.join(dir, e.name, "SKILL.md"))) return true;
    }
  }
  return false;
}

/** 解析 `.pi/mcp.json`：返回启用中的 server 名列表；无效/空 → [] */
export function parseMcpServers(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const servers = raw.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return [];
  return Object.entries(servers)
    .filter(([, cfg]) => cfg && typeof cfg === "object" && cfg.enabled !== false)
    .map(([name]) => name);
}

/**
 * 发现可选 extras。
 * @param {object} [opts]
 * @param {string} [opts.packageRoot] 默认 PACKAGE_ROOT
 * @param {string} [opts.skillDir] 相对 packageRoot 或绝对路径；默认 "skills"
 */
export async function discoverAgentExtras(opts = {}) {
  const packageRoot = opts.packageRoot || PACKAGE_ROOT;
  const skillDirOpt = opts.skillDir || "skills";
  const skillDir = path.isAbsolute(skillDirOpt) ? skillDirOpt : path.join(packageRoot, skillDirOpt);
  const mcpPath = path.join(packageRoot, ".pi", "mcp.json");

  const hasSkills = await skillDirHasContent(skillDir);
  let mcpServers = [];
  let mcpRaw = null;
  if (await exists(mcpPath)) {
    try {
      mcpRaw = JSON.parse(await readFile(mcpPath, "utf8"));
      mcpServers = parseMcpServers(mcpRaw);
    } catch {
      mcpServers = [];
      mcpRaw = null;
    }
  }

  return {
    packageRoot,
    skillDir: hasSkills ? skillDir : null,
    mcpPath: mcpServers.length ? mcpPath : null,
    mcpServers,
    mcpRaw: mcpServers.length ? mcpRaw : null,
    hasSkills,
    hasMcp: mcpServers.length > 0,
  };
}

/**
 * 根据 discover 结果生成 ResourceLoader / createAgentSession 相关选项。
 * 空配置 → 与历史行为一致（noSkills/noExtensions，无 additionalSkillPaths）。
 */
export function buildResourceLoaderExtras(discovered) {
  const d = discovered || {};
  const out = {
    noExtensions: true,
    noSkills: true, // 始终不扫 workDir；仅靠 additionalSkillPaths
    noPromptTemplates: true,
    noThemes: true,
    additionalSkillPaths: d.hasSkills && d.skillDir ? [d.skillDir] : [],
    extensionFactories: [],
    /** 若启用 MCP，需并入 tools 白名单，否则 direct 暴露的 mcp__* 无法声明给模型 */
    extraToolAllowlist: d.hasMcp ? ["mcp__*"] : [],
  };
  return out;
}

/** 把维护者 `.pi/mcp.json` 写入 agentDir（SDK 从 agentDir/mcp.json 读 global 配置） */
export async function installMcpConfigToAgentDir(agentDir, mcpRaw) {
  if (!mcpRaw) return null;
  const dest = path.join(agentDir, "mcp.json");
  await writeFile(dest, JSON.stringify(mcpRaw, null, 2));
  return dest;
}
