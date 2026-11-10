/**
 * 团队知识的统一语义模型。
 *
 * nature 回答“正文讲的是业务事实还是工程方法”；form 回答“以什么
 * 形态让人/Agent 使用”。模块、仓库、技术栈只是作用范围，不能拿来
 * 反推 nature：一个用于订单仓排障的 Java Skill，正文若讲定位方法，
 * 它仍然是工程知识，只是带订单模块上下文并限定到对应仓库。
 */

import {
  normalizeKnowledgeLanguages,
  readSkillLanguages,
  writeSkillLanguages,
} from "./knowledgeLanguages";

const MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MODULES = 8;
const MAX_REPOSITORIES = 20;

export type KnowledgeNature = "business" | "engineering" | "unclassified";
export type KnowledgeForm = "document" | "skill" | "rule" | "example";

export interface KnowledgeAssetMetadata {
  nature: KnowledgeNature;
  form: KnowledgeForm;
  /** 业务知识的归属；工程知识可用它表达业务上下文。 */
  business_module_ids: string[];
  /** 空数组表示对所处范围内全部仓库适用。 */
  repositories: string[];
  /** 只描述工程适用面；复用历史 languages 的规范化值。 */
  technologies: string[];
}

function frontmatter(content: string): string | undefined {
  return /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/
    .exec(content)?.[1];
}

function scalar(value: string, key: string): string | undefined {
  return new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, "im")
    .exec(value)?.[1]?.replace(/^['"]|['"]$/g, "").trim();
}

function list(value: string, key: string): string[] {
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`, "i").exec(lines[index]);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline.startsWith("[") && inline.endsWith("]")) {
      return inline.slice(1, -1).split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
    if (inline) return [inline.replace(/^['"]|['"]$/g, "")];
    const values: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const item = /^\s+-\s*(.+)$/.exec(lines[cursor]);
      if (!item) break;
      values.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
    }
    return values;
  }
  return [];
}

function moduleIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("业务模块必须是数组");
  const result = [...new Set(value.map(String).map((item) => item.trim())
    .filter(Boolean))].sort();
  if (result.length > MAX_MODULES) {
    throw new Error(`一项知识最多关联 ${MAX_MODULES} 个业务模块`);
  }
  for (const id of result) {
    if (!MODULE_ID.test(id)) throw new Error(`业务模块 ID 不合法：${id}`);
  }
  return result;
}

function repositoryList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("适用仓库必须是数组");
  const result = [...new Set(value.map(String).map((item) => item.trim())
    .filter(Boolean))].sort();
  if (result.length > MAX_REPOSITORIES) {
    throw new Error(`一项知识最多限定 ${MAX_REPOSITORIES} 个仓库`);
  }
  for (const repository of result) {
    if (repository.length > 512 || /[\0\r\n]/.test(repository)) {
      throw new Error("适用仓库地址不合法");
    }
  }
  return result;
}

export function normalizeKnowledgeAssetMetadata(input: {
  nature?: unknown;
  form?: unknown;
  business_module_ids?: unknown;
  repositories?: unknown;
  technologies?: unknown;
}, options: { allowUnclassified?: boolean; fixedForm?: KnowledgeForm;
  allowIncompleteEngineering?: boolean } = {}): KnowledgeAssetMetadata {
  const rawNature = input.nature === undefined
    ? "unclassified" : String(input.nature).trim().toLowerCase();
  if (!["business", "engineering", "unclassified"].includes(rawNature)) {
    throw new Error("知识性质只能是业务知识或工程知识");
  }
  if (rawNature === "unclassified" && !options.allowUnclassified) {
    throw new Error("请明确选择知识性质：业务知识或工程知识");
  }
  const rawForm = options.fixedForm
    ?? String(input.form ?? "document").trim().toLowerCase();
  if (!["document", "skill", "rule", "example"].includes(rawForm)) {
    throw new Error("知识形态只能是文档、Skill、规则或示例");
  }
  const modules = moduleIds(input.business_module_ids ?? []);
  const repositories = repositoryList(input.repositories ?? []);
  const technologies = normalizeKnowledgeLanguages(input.technologies ?? [])
    .filter(item => rawNature !== "business" || item !== "agnostic");
  if (rawNature === "business") {
    if (!modules.length) {
      throw new Error("业务知识必须至少选择一个归属业务模块");
    }
    if (technologies.length) {
      throw new Error("业务知识不能标工程语言；若正文包含实现方法，请拆出一项工程知识");
    }
  }
  if (rawNature === "engineering" && !technologies.length
      && !options.allowIncompleteEngineering) {
    throw new Error("工程知识必须至少选择一种适用语言");
  }
  return {
    nature: rawNature as KnowledgeNature,
    form: rawForm as KnowledgeForm,
    business_module_ids: modules,
    repositories,
    technologies,
  };
}

/** 读取 Skill frontmatter；兼容旧 languages 与上一版短暂使用过的
 * skill_kind/business_modules 字段，读时迁移、写时只产新模型。 */
export function readSkillKnowledgeMetadata(content: string): KnowledgeAssetMetadata {
  const metadata = frontmatter(content);
  if (metadata === undefined) {
    return { nature: "unclassified", form: "skill",
      business_module_ids: [], repositories: [], technologies: [] };
  }
  const modules = list(metadata, "business_modules");
  const repositories = list(metadata, "repositories");
  const technologies = list(metadata, "technologies");
  const legacyLanguages = readSkillLanguages(content);
  const declared = scalar(metadata, "knowledge_nature")
    ?? scalar(metadata, "skill_kind");
  const inferred = declared === "general" ? "unclassified"
    : declared ?? ((technologies.length || legacyLanguages.length)
      ? "engineering" : modules.length ? "business" : "unclassified");
  return normalizeKnowledgeAssetMetadata({
    nature: inferred,
    form: "skill",
    business_module_ids: modules,
    repositories,
    technologies: technologies.length ? technologies : legacyLanguages,
  }, { allowUnclassified: true, fixedForm: "skill",
    allowIncompleteEngineering: true });
}

function withoutField(lines: string[], field: RegExp): string[] {
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!field.test(lines[index])) {
      kept.push(lines[index]);
      continue;
    }
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
    }
  }
  return kept;
}

export function writeSkillKnowledgeMetadata(
  content: string,
  input: KnowledgeAssetMetadata,
  options: { allowIncompleteEngineering?: boolean } = {},
): string {
  const value = normalizeKnowledgeAssetMetadata(input,
    { fixedForm: "skill", ...options });
  // 清理历史 languages；新字段叫 technologies，避免再把语言当知识归属。
  let result = writeSkillLanguages(content, []);
  const match = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---(?:\s*\r?\n|$))/.exec(result);
  if (!match) throw new Error("SKILL.md 缺少 YAML frontmatter");
  let lines = match[2].split(/\r?\n/);
  for (const field of [
    /^knowledge_nature\s*:/i, /^skill_kind\s*:/i,
    /^business_modules\s*:/i, /^repositories\s*:/i,
    /^technologies\s*:/i,
  ]) lines = withoutField(lines, field);
  lines.push(`knowledge_nature: ${value.nature}`);
  if (value.business_module_ids.length) {
    lines.push(`business_modules: [${value.business_module_ids.join(", ")}]`);
  }
  if (value.repositories.length) {
    lines.push(`repositories: [${value.repositories.join(", ")}]`);
  }
  if (value.technologies.length) {
    lines.push(`technologies: [${value.technologies.join(", ")}]`);
  }
  const next = lines.join("\n").replace(/\n+$/, "");
  return `${match[1]}${next}${match[3]}${result.slice(match[0].length)}`;
}

/** 删除目录项只移除关联；工程性质和正文保留，空关联等待重新选择。 */
export function clearSkillTechnology(content: string, technologyId: string): string {
  const metadata = readSkillKnowledgeMetadata(content);
  if (!metadata.technologies.includes(technologyId)) return content;
  return writeSkillKnowledgeMetadata(content, {
    ...metadata,
    technologies: metadata.technologies.filter((id) => id !== technologyId),
  }, { allowIncompleteEngineering: true });
}

export function repositoryIdentity(value: string): string {
  return value.trim().replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
}

export function knowledgeMatchesTask(metadata: KnowledgeAssetMetadata, context: {
  repositories: string[];
  technologies: string[];
  businessModuleIds: string[];
}): boolean {
  // 历史未治理资产可以继续在管理面展示并补标签，但不能靠“无标签”
  // 绕过匹配进入任务。匹配失败应回到知识治理端修正，而不是让任务
  // 发起人临时猜选。
  if (metadata.nature === "unclassified") return false;
  if (metadata.nature === "engineering" && !metadata.technologies.length) return false;
  const taskRepositories = new Set(context.repositories.map(repositoryIdentity));
  if (metadata.repositories.length && !metadata.repositories.some((item) =>
    taskRepositories.has(repositoryIdentity(item)))) return false;
  if (metadata.nature === "business"
      && !metadata.business_module_ids.some((id) =>
        context.businessModuleIds.includes(id))) return false;
  if (metadata.nature === "engineering" && metadata.business_module_ids.length
      && !metadata.business_module_ids.some((id) =>
        context.businessModuleIds.includes(id))) return false;
  if (metadata.nature === "engineering" && metadata.technologies.length
      && !metadata.technologies.includes("agnostic")
      && !metadata.technologies.some((item) =>
        context.technologies.includes(item))) return false;
  return true;
}

/**
 * 问题会话的匹配口径（ADR-0005）：任务口径上做一处豁免——未限定
 * 仓库/模块作用域的工程知识是团队通用方法（通用问题定位 skill 就以
 * 这个形态发布），进所有问题会话。其余与任务同款按作用域过滤；技术
 * 栈维度问题会话没有口径，不参与过滤。未分类资产维持“不进任务”。
 */
export function knowledgeMatchesIssueSession(
  metadata: KnowledgeAssetMetadata,
  context: { repositories: string[]; businessModuleIds: string[] },
): boolean {
  if (metadata.nature === "unclassified") return false;
  if (metadata.nature === "engineering" && !metadata.technologies.length) return false;
  if (metadata.nature === "engineering"
      && !metadata.repositories.length
      && !metadata.business_module_ids.length) return true;
  const issueRepositories = new Set(
    context.repositories.map(repositoryIdentity));
  if (metadata.repositories.length && !metadata.repositories.some((item) =>
    issueRepositories.has(repositoryIdentity(item)))) return false;
  if (metadata.business_module_ids.length
      && !metadata.business_module_ids.some((id) =>
        context.businessModuleIds.includes(id))) return false;
  return true;
}
