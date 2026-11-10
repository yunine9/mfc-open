import type { ExtractionKind } from "./knowledgeExtractionSkills.ts";

export interface KnowledgeArchiveDefaults {
  domain_directory: string; repository_directory: string;
}
/** 领域方法包里的归档默认目录。组件知识的归档位置统一在配置中心设置，文件按知识标题命名，方法包不再配置。 */
export function knowledgeArchiveDefaults(files: Record<string, string>, kind: ExtractionKind): KnowledgeArchiveDefaults {
  const defaults = { domain_directory: "docs", repository_directory: "docs" };
  const text = files["references/archive-defaults.md"];
  if (text === undefined) return defaults;
  const block = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!block) throw new Error("归档默认位置需要一个 JSON 配置块");
  const value = JSON.parse(block[1]);
  if (kind !== "domain") throw new Error("组件知识的归档位置在配置中心设置，方法包不需要 archive-defaults.md");
  const keys = ["domain_directory", "repository_directory"];
  if (!value || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("归档默认位置包含未知字段");
  for (const key of keys) {
    const path = value[key];
    if (typeof path !== "string" || !path || path !== path.trim() || path.length > 1000 || (path !== "." && path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(p))) ) throw new Error(`归档默认位置无效：${key}`);
  }
  return { ...defaults, ...value };
}
