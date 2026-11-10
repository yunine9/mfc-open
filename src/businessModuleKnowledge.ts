import { BusinessModuleError, normalizeModuleKnowledgeLocation, readBusinessModule, updateBusinessModule, type BusinessModuleKnowledgeLocation } from "./businessModuleLibrary.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";

/** 仓库与分支只有平台配置一个来源；模块只保存目录，读取不会写配置。 */
export function resolveModuleKnowledgeLocation(dataDir: string, moduleId: string): BusinessModuleKnowledgeLocation | undefined {
  const module = readBusinessModule(dataDir, moduleId), configured = readKnowledgeRepoConfig(dataDir);
  if (!configured?.url || !module.knowledge_path) return undefined;
  return normalizeModuleKnowledgeLocation({ repository: configured.url, branch: configured.branch || "master", docs_path: module.knowledge_path });
}

export function saveModuleKnowledgeLocation(dataDir: string, moduleId: string, input: unknown, operator: string, expectedRevision?: number) {
  const current = readBusinessModule(dataDir, moduleId);
  if (current.id !== moduleId || current.status !== "active") throw new BusinessModuleError("业务模块已迁移或停用，请刷新列表");
  if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new BusinessModuleError("模块配置已变化，请刷新后再保存领域知识目录");
  if (typeof input === "string") return updateBusinessModule(dataDir, moduleId, { knowledge_path: input }, operator);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new BusinessModuleError("请填写领域知识仓内相对目录");
  const value = input as Record<string, unknown>;
  const legacy = value.location ?? (["repository", "branch"].some(key => key in value) ? value : undefined);
  const path = value.knowledge_path ?? (legacy === undefined ? value.docs_path : undefined);
  if (path === undefined && legacy === undefined) throw new BusinessModuleError("请填写领域知识仓内相对目录");
  return updateBusinessModule(dataDir, moduleId, { knowledge_path: path, knowledge_location: legacy }, operator);
}
