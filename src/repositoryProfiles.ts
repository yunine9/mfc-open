/** 首次由用户确认、后续复用的仓库技术画像。系统不猜。 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { requireTechnologyStacks } from "./technologyStacks.ts";

const ROOT = "repository-profiles";
const FILE = "profiles.json";
const OPERATIONS = "operations.jsonl";
const MAX_REPOSITORIES = 1000;

export class RepositoryProfileError extends Error {}

export interface RepositoryProfile {
  repository: string;
  technologies: string[];
  /** 历史数据可能存在 true + []；新任务不再把它视为已确认。 */
  confirmed: boolean;
  updated_at: string;
  updated_by: string;
}

type RepositoryProfileSelection = Pick<RepositoryProfile,
  "repository" | "technologies" | "confirmed">;

/** 新任务的硬契约：每个代码仓都要有用户确认的非空技术栈。
 * 只在创建新任务时调用，不倒查、不迁移历史任务。 */
export function requireRepositoryProfiles<T extends RepositoryProfileSelection>(
  repositories: string[],
  profiles: T[],
  dataDir?: string,
): T[] {
  const uniqueRepositories = [...new Set(repositories.map(validateRepository))];
  const byIdentity = new Map(profiles.map((profile) =>
    [repositoryIdentity(validateRepository(profile.repository)), profile]));
  return uniqueRepositories.map((repository) => {
    const profile = byIdentity.get(repositoryIdentity(repository));
    if (!profile || profile.confirmed !== true
        || !Array.isArray(profile.technologies)
        || profile.technologies.length === 0) {
      const name = repository.replace(/\/+$/, "").split("/").at(-1)
        ?.replace(/\.git$/i, "") || repository;
      throw new RepositoryProfileError(
        "代码仓 " + name + " 还没有选择技术栈，请先在发起页确认",
      );
    }
    if (dataDir !== undefined) {
      try { requireTechnologyStacks(dataDir, profile.technologies); }
      catch (error) {
        throw new RepositoryProfileError(
          error instanceof Error ? error.message : String(error));
      }
    }
    return profile;
  });
}

export interface RepositoryProfileResolution {
  repository: string;
  profile?: RepositoryProfile;
}

/** 持久化与“本单先采用”共用的归一化，避免保存失败后悄悄换作用域。 */
export function normalizeRepositoryProfile(
  input: { repository: string; technologies?: string[]; confirmed?: boolean },
  operator: string,
  dataDir?: string,
): RepositoryProfile {
  const repository = validateRepository(input.repository);
  let technologies: string[];
  try {
    technologies = normalizeKnowledgeLanguages(input.technologies ?? [])
      .filter((item) => item !== "agnostic");
  } catch (error) {
    throw new RepositoryProfileError(
      error instanceof Error ? error.message : String(error));
  }
  if (!technologies.length) {
    throw new RepositoryProfileError("请至少选择一种仓库技术栈");
  }
  if (dataDir !== undefined) {
    try { technologies = requireTechnologyStacks(dataDir, technologies); }
    catch (error) {
      throw new RepositoryProfileError(
        error instanceof Error ? error.message : String(error));
    }
  }
  return {
    repository,
    technologies,
    confirmed: input.confirmed !== false,
    updated_at: new Date().toISOString(),
    updated_by: operator,
  };
}

function home(dataDir: string): string { return join(dataDir, ROOT); }
function file(dataDir: string): string { return join(home(dataDir), FILE); }

function validateRepository(value: string): string {
  const repository = value.trim();
  if (!repository || repository.length > 512 || /[\0\r\n]/.test(repository)) {
    throw new RepositoryProfileError("代码仓地址不合法");
  }
  return repository;
}

function readAll(dataDir: string): RepositoryProfile[] {
  const path = file(dataDir);
  if (!existsSync(path)) return [];
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new RepositoryProfileError("仓库技术画像存储不是普通文件");
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(value)) throw new Error("not an array");
    return value.flatMap((item): RepositoryProfile[] => {
      if (!item || typeof item.repository !== "string") return [];
      try {
        return [{
          repository: validateRepository(item.repository),
          technologies: normalizeKnowledgeLanguages(
            Array.isArray(item.technologies) ? item.technologies : [])
            .filter((technology) => technology !== "agnostic"),
          confirmed: item.confirmed === true,
          updated_at: String(item.updated_at ?? ""),
          updated_by: String(item.updated_by ?? ""),
        }];
      } catch { return []; }
    });
  } catch {
    throw new RepositoryProfileError("仓库技术画像数据损坏");
  }
}

function writeAll(dataDir: string, profiles: RepositoryProfile[]): void {
  if (profiles.length > MAX_REPOSITORIES) {
    throw new RepositoryProfileError(`最多保存 ${MAX_REPOSITORIES} 个仓库画像`);
  }
  const root = home(dataDir);
  mkdirSync(root, { recursive: true, mode: 0o750 });
  const path = file(dataDir);
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(profiles, null, 2)}\n`, {
      encoding: "utf-8", mode: 0o640,
    });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function resolveRepositoryProfiles(
  dataDir: string,
  repositories: string[],
): RepositoryProfileResolution[] {
  const all = readAll(dataDir);
  const byIdentity = new Map(all.map((profile) =>
    [repositoryIdentity(profile.repository), profile]));
  return [...new Set(repositories.map(validateRepository))].map((repository) => ({
    repository,
    profile: byIdentity.get(repositoryIdentity(repository)),
  }));
}

export function saveRepositoryProfile(
  dataDir: string,
  input: { repository: string; technologies?: string[]; confirmed?: boolean },
  operator: string,
): RepositoryProfile {
  const profile = normalizeRepositoryProfile(input, operator, dataDir);
  const { repository, technologies } = profile;
  const identity = repositoryIdentity(repository);
  const all = readAll(dataDir).filter((item) =>
    repositoryIdentity(item.repository) !== identity);
  writeAll(dataDir, [...all, profile].sort((left, right) =>
    left.repository.localeCompare(right.repository)));
  appendFileSync(join(home(dataDir), OPERATIONS), `${JSON.stringify({
    at: profile.updated_at,
    operator,
    action: "confirm",
    repository,
    technologies,
  })}\n`, { encoding: "utf-8", mode: 0o640 });
  return profile;
}
