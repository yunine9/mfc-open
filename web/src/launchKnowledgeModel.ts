export interface LaunchTeamSkill {
  name: string;
  description: string;
  nature: "business" | "engineering";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  path: string;
}

export interface LaunchBusinessKnowledge {
  id: string;
  title: string;
  summary: string;
  when_to_use: string;
  form: "document" | "skill" | "rule" | "example";
  repositories: string[];
  version: number;
}

export interface MatchedBusinessKnowledge extends LaunchBusinessKnowledge {
  module_id: string;
  module_name: string;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim()).filter(Boolean))];
}

function repositoryIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

/**
 * 预览必须和创建任务时的模块知识匹配口径一致：只看已选模块，知识若
 * 限定了仓库，则至少命中当前任务的一个仓库。旧服务没有 knowledge
 * 字段时返回空清单，不能拿模块总数冒充本任务会实际使用的数量。
 */
export function matchBusinessModuleKnowledge(
  modules: ReadonlyArray<{
    id: string;
    name: string;
    knowledge?: readonly LaunchBusinessKnowledge[];
  }>,
  selectedModuleIds: readonly string[],
  repositories: readonly string[],
): MatchedBusinessKnowledge[] {
  const selected = new Set(selectedModuleIds);
  const taskRepositories = new Set(repositories
    .map(repositoryIdentity).filter(Boolean));
  return modules.filter((module) => selected.has(module.id))
    .flatMap((module) => (module.knowledge ?? [])
      .filter((item) => !item.repositories.length
        || item.repositories.some((repository) =>
          taskRepositories.has(repositoryIdentity(repository))))
      .map((item) => ({
        ...item,
        repositories: [...item.repositories],
        module_id: module.id,
        module_name: module.name,
      })));
}

/**
 * launch-options is a deployment boundary: an older service or one legacy
 * asset must not be able to take down the whole launch screen. Invalid rows
 * and knowledge without mandatory governance scope are ignored: the launch
 * page must never pretend an unclassified asset will be matched.
 */
export function normalizeLaunchKnowledgeCatalog(value: unknown): {
  skills: LaunchTeamSkill[];
} {
  const source = record(value);
  const skills: LaunchTeamSkill[] = [];
  const skillPaths = new Set<string>();
  const rawSkills = Array.isArray(source?.team_skills) ? source.team_skills : [];
  for (const raw of rawSkills) {
    const item = record(raw);
    const path = string(item?.path);
    const nature = string(item?.nature);
    const businessModuleIds = strings(item?.business_module_ids);
    const technologies = strings(item?.technologies);
    if (!item || !path || skillPaths.has(path)
        || nature !== "business" && nature !== "engineering"
        || nature === "business" && !businessModuleIds.length
        || nature === "engineering" && !technologies.length) continue;
    skillPaths.add(path);
    skills.push({
      path,
      name: string(item.name) || path,
      description: string(item.description),
      nature,
      business_module_ids: businessModuleIds,
      repositories: strings(item.repositories),
      technologies,
    });
  }
  return { skills };
}
