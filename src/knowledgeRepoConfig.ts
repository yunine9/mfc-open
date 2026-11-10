/** 配置中心·知识仓(#286,ADR-0033):管理员指定的全局领域知识代码仓,
 * 单仓单值。仅管理员可见可写——配置中心"全员维护"哲学的第一条例外:
 * 强制全局影响所有人的所有会话,是运营决策不是团队协作资产。
 * URL 校验与拉仓同一把尺(validateRepoUrl):配置能存下的,开工就能克隆。 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateRepoUrl } from "./issueFlow/issueGit.ts";

export class KnowledgeRepoConfigError extends Error {}

export interface KnowledgeRepoConfig { url: string; branch?: string; docs_path?: string }

const file = (dataDir: string) => join(dataDir, "knowledge-repo.json");

/** 未配置返回 undefined——读缺席不落文件、不抛错,调用方按"没有知识仓"走。 */
export function readKnowledgeRepoConfig(
  dataDir: string,
): KnowledgeRepoConfig | undefined {
  if (!existsSync(file(dataDir))) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file(dataDir), "utf8"));
  } catch {
    throw new KnowledgeRepoConfigError(
      "知识仓配置文件损坏,请删除后重新配置(knowledge-repo.json)");
  }
  if (typeof data !== "object" || data === null
    || typeof (data as { url?: unknown }).url !== "string") {
    throw new KnowledgeRepoConfigError(
      "知识仓配置文件格式错误,请删除后重新配置(knowledge-repo.json)");
  }
  const saved = data as KnowledgeRepoConfig;
  return { url: saved.url, ...(saved.branch ? { branch: saved.branch } : {}), ...(saved.docs_path ? { docs_path: saved.docs_path } : {}) };
}

/** scp/ssh 形态(git@host:path):validateRepoUrl 会把它误当本地路径
 * resolve 放行——运行期有克隆失败回执兜底,配置期存进必败地址只会在
 * 每个会话撒失败事件,保存口单独打回这一种已知必败形态;除此之外与
 * 拉仓同一把尺,不造第二真相。 */
function isScpForm(input: string): boolean {
  return input.includes("@") && !/:\//.test(input);
}

/** 覆盖式单值保存;打回时不留半截配置(先验证后写盘)。
 * 校验比拉仓运行期严一档(先例:saveProductVersion 配置期跑
 * git check-ref-format)。 */
export function saveKnowledgeRepoConfig(
  dataDir: string,
  rawUrl: string,
  defaults: { branch?: string; docs_path?: string } = {},
): KnowledgeRepoConfig {
  const input = String(rawUrl ?? "");
  let url: string;
  try {
    url = validateRepoUrl(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new KnowledgeRepoConfigError(
      `知识仓地址无效:${reason}(与问题拉仓同一把尺,只收 HTTPS 或本地路径)`);
  }
  if (url !== input.trim() && isScpForm(input)) {
    throw new KnowledgeRepoConfigError(
      "知识仓地址无效:不支持 ssh/scp 形态(git@host:path),"
        + "请改用 HTTPS 地址");
  }
  const branch = defaults.branch?.trim(), docs_path = defaults.docs_path?.trim().replace(/\/$/, "");
  if (branch && (branch.startsWith("-") || /[\s\\~^:?*\[\x00-\x1f]|\.\.|@\{|\/\/|\.$|\/$|\.lock(?:\/|$)/.test(branch))) throw new KnowledgeRepoConfigError("归档默认分支格式无效");
  if (docs_path && docs_path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(p))) throw new KnowledgeRepoConfigError("归档目录必须是仓内相对路径");
  const config = { url, ...(branch ? { branch } : {}), ...(docs_path ? { docs_path } : {}) };
  write(dataDir, config);
  return config;
}

export function clearKnowledgeRepoConfig(dataDir: string): void {
  write(dataDir, undefined);
}

function write(dataDir: string, config?: KnowledgeRepoConfig): void {
  mkdirSync(dataDir, { recursive: true });
  if (!config) {
    rmSync(file(dataDir), { force: true });
    return;
  }
  const temporary = file(dataDir) + ".tmp";
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n",
    { mode: 0o600 });
  renameSync(temporary, file(dataDir));
}
