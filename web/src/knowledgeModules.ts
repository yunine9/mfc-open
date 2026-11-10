import { loadTechnologyStacks, technologyStackLabel, type TechnologyStack } from "./technologyStacks";
import type { BusinessModule, BusinessModuleKnowledgeLocation, HostSkillShelfEntry, SkillOperationRecord } from "./api";
import { getBusinessModules, getSkillLibrary } from "./api";
import type { ComponentRepository } from "./componentResearchApi";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeDocument } from "./knowledgeDocumentsApi";
import { documentRequest } from "./knowledgeDocumentsApi";
import type { ComponentGovernanceItem, ComponentGovernanceSnapshot } from "../../src/componentKnowledgeTypes";
import { createKnowledgeReadCache, knowledgeReadGeneration } from "./knowledgeReadCache";
import { markKnowledgeDirectoryReadFailed, recordKnowledgeDirectoryRevision } from "./knowledgeRevision";

export type KnowledgeModuleCategory = "business" | "engineering" | "unassigned";
export interface ModuleDocument extends KnowledgeDocument {
  maintainedAt?: string;
  skillDirectory?: string;
  componentIds?: string[];
}
export interface KnowledgeModuleGroup { id: string; name: string; documents: ModuleDocument[] }
export interface KnowledgeModule {
  key: string; id: string; name: string; description: string;
  category: KnowledgeModuleCategory;
  knowledgeLocation?: BusinessModuleKnowledgeLocation;
  documents: ModuleDocument[];
  repositories: KnowledgeModuleGroup[];
  documentCount: number; skillCount: number; inactiveCount: number;
  maintainedAt?: string; recentlyMaintained: number;
}
export interface KnowledgeModuleData {
  modules: KnowledgeModule[]; documents: ModuleDocument[]; warnings: string[];
}

export const repositoryKey = (value: string) => value.trim().replace(/\/$/, "").replace(/\.git$/, "");
export const repositoryName = (value: string) => repositoryKey(value).split(/[/:]/).filter(Boolean).at(-1) || value;
export function knowledgeFilePath(doc: KnowledgeDocument): string {
  // 组件研究的 research_source.path 是组件源码目录（如 src），不是知识文件；当文件名用会让树里出现一个叫 src 的"文件"。
  const researchPath = doc.research_source?.components ? "" : doc.research_source?.path;
  return doc.form === "skill" ? "SKILL.md" : doc.source?.path || researchPath || doc.title;
}
export function knowledgeFileName(doc: KnowledgeDocument): string {
  return knowledgeFilePath(doc).split("/").at(-1) || doc.title;
}
function latestDate(values: Array<string | undefined>): string | undefined {
  return values.filter((value): value is string => !!value && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
function skillMaintenance(operations: SkillOperationRecord[], directory: string) {
  return latestDate(operations.filter(op => op.directory === directory
    && ["upload", "update", "approve", "rollback", "offline"].includes(op.action)).map(op => op.at));
}

/** 展示投影只使用明确归属；Git 来源仓可能是归档位置，不能当适用仓。 */
export function projectKnowledgeModules(input: {
  documents: KnowledgeDocument[]; businessModules: BusinessModule[];
  components: ComponentRepository[]; skills?: HostSkillShelfEntry[];
  skillOperations?: SkillOperationRecord[]; now?: number; technologyStacks?: TechnologyStack[];
}): KnowledgeModuleData {
  const now = input.now ?? Date.now(), business = input.businessModules.filter(m => m.status === "active");
  const skills = new Map((input.skills ?? []).map(s => [s.path.split("/")[0], s]));
  const documents = [...new Map(input.documents.filter(d => !d.id.startsWith("platform-skill-")).map(d => [d.id, d])).values()].map((original): ModuleDocument => {
    const doc: ModuleDocument = { ...original, module_ids: [...(original.module_ids ?? [])], repositories: [...(original.repositories ?? [])], technologies: [...(original.technologies ?? [])] };
    if (doc.focus?.kind === "business") {
      const focus = doc.focus, module = business.find(m => m.id === focus.moduleId), asset = module?.assets.find(a => a.id === focus.assetId);
      doc.module_ids = [...new Set([...doc.module_ids, focus.moduleId])];
      if (asset) { doc.repositories = [...asset.repositories]; doc.maintainedAt = asset.updated_at; }
    }
    if (doc.focus?.kind === "skill") {
      const directory = doc.focus.directory, skill = skills.get(directory);
      doc.skillDirectory = directory;
      if (skill) {
        doc.module_ids = [...(skill.business_module_ids ?? [])]; doc.repositories = [...(skill.repositories ?? [])];
        doc.technologies = [...(skill.technologies ?? [])]; doc.active = skill.loadable && !(skill.nature === "engineering" && !skill.technologies.length);
        doc.technology_assignment_required = skill.nature === "engineering" && !skill.technologies.length ? true : undefined;
      }
      doc.maintainedAt = skillMaintenance(input.skillOperations ?? [], directory);
    } else doc.maintainedAt = latestDate([doc.maintainedAt, ...(doc.history ?? []).map(h => h.at)]);
    const components = (doc.research_source as (KnowledgeDocument["research_source"] & { components?: Array<{ id: string }> }))?.components;
    doc.componentIds = components?.map(c => c.id);
    return doc;
  });
  // 目录接口略过的不可装载 Skill 仍保留，避免把需要修复的包藏起来。
  for (const [directory, skill] of skills) if (!documents.some(d => d.skillDirectory === directory)) documents.push({
    id: `skill:${skill.path}`, title: skill.name, form: "skill", scope: "platform", skillDirectory: directory,
    module_ids: [...(skill.business_module_ids ?? [])], repositories: [...(skill.repositories ?? [])], technologies: [...(skill.technologies ?? [])], product_versions: [],
    when_to_use: skill.description, technology_assignment_required: skill.nature === "engineering" && !skill.technologies.length ? true : undefined, active: skill.loadable && !(skill.nature === "engineering" && !skill.technologies.length), revision: skill.digest, history: [],
    maintainedAt: skillMaintenance(input.skillOperations ?? [], directory),
  });
  const modules: KnowledgeModule[] = business.map(m => ({ key: `business:${m.id}`, id: m.id, name: m.name, description: m.description, category: "business", knowledgeLocation: m.knowledge_location, documents: [], repositories: m.repositories.map(r => ({ id: repositoryKey(r), name: repositoryName(r), documents: [] })), documentCount: 0, skillCount: 0, inactiveCount: 0, recentlyMaintained: 0 }));
  function language(id: string) {
    let module = modules.find(m => m.key === `engineering:${id}`);
    if (!module) { module = { key: `engineering:${id}`, id, name: id === "agnostic" ? "通用" : technologyStackLabel(id, input.technologyStacks ?? []), description: id === "agnostic" ? "不区分语言和业务的工程方法与团队 Skill" : "基础组件知识与团队 Skill", category: "engineering", documents: [], repositories: [], documentCount: 0, skillCount: 0, inactiveCount: 0, recentlyMaintained: 0 }; modules.push(module); }
    return module;
  }
  for (const component of input.components.filter(c => c.enabled)) for (const id of component.languages) language(id);
  language("agnostic");
  const unassigned: KnowledgeModule = { key: "unassigned", id: "unassigned", name: "待整理知识", description: "尚未明确模块或技术栈归属，原有内容仍可阅读", category: "unassigned", documents: [], repositories: [], documentCount: 0, skillCount: 0, inactiveCount: 0, recentlyMaintained: 0 };
  for (const doc of documents) {
    const matches = modules.filter(m => m.category === "business" && (doc.module_ids.includes(m.id) || (!doc.module_ids.length && doc.repositories.some(r => m.repositories.some(g => g.id === repositoryKey(r))))));
    const targets = matches.length ? matches : doc.module_ids.length || doc.focus?.kind === "business" ? [] : [...new Set(doc.technologies)].map(language);
    if (!targets.length) unassigned.documents.push(doc);
    for (const target of targets) {
      target.documents.push(doc);
      // 工程知识逐篇展示，基础仓只作为来源；领域知识保留明确的适用仓分组。
      if (doc.form === "skill" || target.category !== "business") continue;
      const groups = target.repositories.filter(g => doc.repositories.some(r => repositoryKey(r) === g.id));
      for (const group of groups) group.documents.push(doc);
      if (!groups.length && doc.repositories.length) {
        let unknown = target.repositories.find(g => g.id === "unassigned");
        if (!unknown) { unknown = { id: "unassigned", name: "待确认关联仓", documents: [] }; target.repositories.push(unknown); }
        unknown.documents.push(doc);
      }
    }
  }
  if (unassigned.documents.length) modules.push(unassigned);
  for (const module of modules) {
    module.documentCount = module.documents.filter(d => d.active && d.form !== "skill").length;
    module.skillCount = module.documents.filter(d => d.active && d.form === "skill").length;
    module.inactiveCount = module.documents.filter(d => !d.active).length;
    module.maintainedAt = latestDate(module.documents.map(d => d.maintainedAt));
    module.recentlyMaintained = module.documents.filter(d => d.maintainedAt && now - Date.parse(d.maintainedAt) >= 0 && now - Date.parse(d.maintainedAt) <= 30 * 86400000).length;
  }
  return { modules, documents, warnings: [] };
}

/** 正式目录按维护时间与名称排列，不受萃取任务或未合入产物影响。 */
export function compareKnowledgeModules(a: KnowledgeModule, b: KnowledgeModule) {
  return b.recentlyMaintained - a.recentlyMaintained
    || (Date.parse(b.maintainedAt ?? "") || 0) - (Date.parse(a.maintainedAt ?? "") || 0)
    || a.name.localeCompare(b.name, "zh-CN");
}

const moduleCache = createKnowledgeReadCache<KnowledgeModuleData>({
  maxEntries: 1, maxWeight: 32 * 1024 * 1024, ttl: 30_000,
  weight: value => JSON.stringify(value).length * 2,
});
export const cachedKnowledgeModules = () => moduleCache.peek("catalog");
export function loadKnowledgeModules(refresh = false): Promise<KnowledgeModuleData> {
  return moduleCache.read("catalog", readKnowledgeModules, refresh);
}
/** 技术栈改名只影响显示名称，不再次读取全部知识。 */
export function knowledgeModuleNames(data: KnowledgeModuleData | undefined, stacks: TechnologyStack[]) {
  if (!data) return data;
  return { ...data, modules: data.modules.map(module => module.category === "engineering"
    ? { ...module, name: module.id === "agnostic" ? "通用" : technologyStackLabel(module.id, stacks) } : module) };
}
async function readKnowledgeModules(): Promise<KnowledgeModuleData> {
  const generation = knowledgeReadGeneration();
  const directory = documentRequest<{ documents: KnowledgeDocument[]; revision?: string }>("?view=directory");
  const [documents, modules, components, skills, technologies] = await Promise.allSettled([
    directory, directory.then(() => getBusinessModules(AbortSignal.timeout(30_000))),
    componentRequest<{ components: ComponentRepository[] }>("/component-repositories"), getSkillLibrary({ directoryOnly: true }), loadTechnologyStacks(),
  ]);
  if (documents.status === "rejected" || modules.status === "rejected") {
    if (generation === knowledgeReadGeneration()) markKnowledgeDirectoryReadFailed();
    throw documents.status === "rejected" ? documents.reason : modules.status === "rejected" ? modules.reason : new Error("知识目录读取失败");
  }
  const result = projectKnowledgeModules({ documents: documents.value.documents,
    technologyStacks: technologies.status === "fulfilled" ? technologies.value : [],
    businessModules: modules.value.modules,
    components: components.status === "fulfilled" ? components.value.components : [],
    skills: skills.status === "fulfilled" ? skills.value.skills : [],
    skillOperations: skills.status === "fulfilled" ? skills.value.operations : [],
  });
  if (components.status === "rejected") result.warnings.push("基础组件配置读取失败，组件归属暂不可用。");
  if (skills.status === "rejected") result.warnings.push("Skill 归属读取失败，部分 Skill 暂列待整理。");
  if (technologies.status === "rejected") result.warnings.push("技术栈清单读取失败，暂时显示原始标识。");
  if (generation === knowledgeReadGeneration()) recordKnowledgeDirectoryRevision(documents.value.revision);
  return result;
}

/** 组件治理快照（规则级别、命中与反馈）；读取失败时调用方隐藏规则数，不推断为 0。 */
export type ComponentRule = ComponentGovernanceItem;
export const loadComponentGovernance = () => componentRequest<ComponentGovernanceSnapshot>("/component-knowledge");
/** 规则按"所属文档 ∪ 证据仓"归到组件：治理里的 component 是范式短名，与组件仓 id 不同名。 */
export function componentRuleMatches(rule: ComponentRule, documentIds: string[], componentId?: string): boolean {
  return rule.kind === "rule" && (documentIds.includes(rule.paradigm.document_id) || (!!componentId && rule.paradigm.evidence.some(e => e.repository_id === componentId)));
}
export function rulesForComponent(snapshot: ComponentGovernanceSnapshot, group: KnowledgeModuleGroup): ComponentRule[] {
  return snapshot.items.filter(rule => componentRuleMatches(rule, group.documents.map(d => d.id), group.id));
}
/** 首页只数"提示"与"只记录"；关闭的规则不计入，避免把不出声的规则算成覆盖。 */
export function languageRuleSummary(snapshot: ComponentGovernanceSnapshot, language: string) {
  const rules = snapshot.items.filter(i => i.kind === "rule" && i.paradigm.language === language);
  return { warning: rules.filter(r => r.policy.level === "warning").length, shadow: rules.filter(r => r.policy.level === "shadow").length };
}
/** 仓地址转浏览地址；ssh 形式 git@host:group/repo 转为 https。 */
export function repositoryWebUrl(value: string): string | undefined {
  const key = repositoryKey(value), ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(key);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  return /^https?:\/\//.test(key) ? key : undefined;
}
