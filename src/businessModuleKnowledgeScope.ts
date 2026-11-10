import { repositoryIdentity } from "./knowledgeAssetModel.ts";

export interface RepositoryKnowledgeExclusion { repository: string; paths: string[] }
interface RepositoryScope {
  repositories: readonly string[];
  repository_knowledge_exclusions?: RepositoryKnowledgeExclusion[];
}

export function normalizeRepositoryKnowledgeExclusions(value: unknown, repositories: readonly string[]): RepositoryKnowledgeExclusion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > repositories.length) throw new Error("知识文档筛选格式不正确");
  const bound = new Map(repositories.map(repository => [repositoryIdentity(repository), repository]));
  const seen = new Set<string>();
  return value.flatMap(entry => {
    if (!entry || typeof entry !== "object" || typeof entry.repository !== "string" || !Array.isArray(entry.paths)
        || entry.paths.length > 1000) throw new Error("请按关联代码仓设置需要排除的目录或文件");
    const identity = repositoryIdentity(entry.repository), repository = bound.get(identity);
    if (!repository || seen.has(identity)) throw new Error("筛选只能设置当前模块的关联代码仓，每个仓填写一次");
    seen.add(identity);
    const paths: string[] = entry.paths.map((raw: unknown) => {
      if (typeof raw !== "string") throw new Error("筛选路径必须是 docs 下的相对目录或文件");
      const path = raw.trim().replace(/\/+$/, "");
      if (path.length > 1000 || (path !== "docs" && !path.startsWith("docs/"))
          || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
        throw new Error("筛选路径必须是 docs 下的相对目录或文件，不能包含上级路径");
      }
      return path;
    });
    const distinct = [...new Set(paths)].sort();
    const minimal = distinct.filter(path => !distinct.some(parent => parent !== path && path.startsWith(`${parent}/`)));
    return minimal.length ? [{ repository, paths: minimal }] : [];
  }).sort((a, b) => repositoryIdentity(a.repository).localeCompare(repositoryIdentity(b.repository)));
}

/** 筛选属于业务模块；同仓其他模块的选择不影响此处，根导航始终保留。 */
export function moduleIncludesRepositoryKnowledge(module: RepositoryScope, source: { repository: string; path: string }): boolean {
  const identity = repositoryIdentity(source.repository);
  if (!module.repositories.some(repository => repositoryIdentity(repository) === identity)) return false;
  if (source.path === "AGENTS.md") return true;
  const excluded = module.repository_knowledge_exclusions?.find(entry => repositoryIdentity(entry.repository) === identity)?.paths ?? [];
  return !excluded.some(path => source.path === path || source.path.startsWith(`${path}/`));
}
