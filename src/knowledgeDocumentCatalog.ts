/** One shelf over existing sources; no copies of adopted experiences or module assets. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listHostSkillShelf } from "./hostSkillShelf.ts";
import { listBusinessModules, readBusinessKnowledgeAsset } from "./businessModuleLibrary.ts";
import { type SearchableKnowledge, knowledgeProductVersions } from "./knowledgeSearch.ts";
import { createHash } from "node:crypto";
import { collectSearchableKnowledge } from "./knowledgeSearch.ts";
import { listFormalKnowledgeDocuments, listFormalKnowledgeDocumentMetadata, readKnowledgeDocument, type KnowledgeDocument, type KnowledgeDocumentMetadata } from "./knowledgeDocuments.ts";
import { withoutBoundModuleDrafts } from "./knowledgeRepositorySnapshots.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";

const allKnowledge = { repo: "", repositories: [], moduleIds: [] };
function externalDocuments(dir: string, assets: SearchableKnowledge[], manualIds: Set<string>) {
  // 技能仅在管理界面展示，消费仍走原生发现/加载；不进入语义索引。
  const skills: SearchableKnowledge[] = [];
  for (const skill of listHostSkillShelf(dir).skills) {
    try {
      const content = readFileSync(join(dir, "skills", skill.path), "utf8");
      skills.push({id:`skill:${skill.path}`, title:skill.name, kind:"skill", scope:"团队 Skill",
        summary:skill.description, whenToUse:skill.description, content, revision:skill.package_digest,
        applicability: { modules: skill.business_module_ids, repositories: skill.repositories,
          languages: skill.technologies, versions: [] },
        productVersions:knowledgeProductVersions(content)});
    } catch { /* 无法读取的包仍可在原 Skill 管理界面修复。 */ }
  }
  for (const module of listBusinessModules(dir).modules.filter(m => m.status === "active")) {
    for (const asset of module.assets.filter(a => a.status === "published" && a.form === "skill")) {
      try {
        const doc = readBusinessKnowledgeAsset(dir, module.id, asset.id);
        skills.push({id:`module:${module.id}:${asset.id}`,title:asset.title,kind:"skill",scope:`业务模块：${module.name}`,
          summary:asset.summary,whenToUse:asset.when_to_use,content:doc.content,revision:String(asset.version),productVersions:knowledgeProductVersions(doc.content)});
      } catch { /* 由原模块管理入口展示读取错误。 */ }
    }
  }
  return [...new Map([...assets,...skills].map(a=>[a.id,a])).values()].filter(a => !manualIds.has(a.id)).map(asset => {
    const digest = createHash("sha256").update(asset.content).digest("hex");
    const [origin, first, second] = asset.id.split(":");
    const focus = origin === "module" ? { kind: "business", moduleId: first, assetId: second, version: Number(asset.revision), digest }
      : origin === "skill" ? { kind: "skill", directory: asset.id.slice(6).split("/")[0], digest, packageDigest: asset.revision }
      : undefined;
    return { id: asset.id, title: asset.title, content: asset.content, revision: asset.revision,
      scope: (asset.scope.startsWith("业务模块") ? "module" : asset.scope.startsWith("代码仓") ? "repository" : "platform") as KnowledgeDocument["scope"],
      scope_label: asset.scope, module_ids: asset.applicability?.modules ?? [], repositories: asset.applicability?.repositories ?? [], technologies: asset.applicability?.languages ?? [], product_versions: asset.productVersions,
      when_to_use: asset.whenToUse, active: true, history: [], form: asset.kind, external: true, focus };
  });
}
const manualView = <T extends KnowledgeDocument | KnowledgeDocumentMetadata>(document: T) =>
  ({ ...document, form: "document", external: false, focus: undefined, scope_label: undefined });

export function knowledgeDocumentCatalog(dir: string) {
  const manuals = listFormalKnowledgeDocuments(dir);
  const catalog = collectSearchableKnowledge(dir, allKnowledge, true, manuals);
  return { assets: catalog.assets, documents: [...manuals.map(manualView),
    ...externalDocuments(dir, catalog.assets, new Set(manuals.map(document => document.id)))] };
}

/** 目录与索引准备分开：展示文件树不读取所有正文，也不计算全文索引状态。 */
export function knowledgeDocumentDirectory(dir: string) {
  const manuals = listFormalKnowledgeDocumentMetadata(dir);
  const external = externalDocuments(dir, collectSearchableKnowledge(dir, allKnowledge, true, []).assets,
    new Set(manuals.map(document => document.id)));
  return [...manuals.map(manualView), ...external.map(({ content, ...document }) =>
    ({ ...document, lines: content.split("\n").length }))];
}

/** 阅读版本只取正式文稿摘要和模块配置，不读正文、查 Git 或计算任务效果。 */
export function knowledgeDocumentReadRevision(dir: string, documents = listFormalKnowledgeDocumentMetadata(dir)) {
  const rows = documents.filter(document => /^(kg|kd)-/.test(document.id)).map(document => ({
    id: document.id, title: document.title, revision: document.revision, source: document.source,
    scope: document.scope, module_ids: [...document.module_ids].sort(), repositories: [...document.repositories].sort(),
    technologies: [...document.technologies].sort(), product_versions: [...document.product_versions].sort(),
    when_to_use: document.when_to_use, active: document.active,
    technology_assignment_required: document.technology_assignment_required,
    archive_target: document.archive_target, research_source: document.research_source,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const modules = listBusinessModules(dir).modules.map(module => ({
    id: module.id, name: module.name, description: module.description, status: module.status,
    repositories: [...module.repositories].sort(), knowledge_path: module.knowledge_path,
    repository_knowledge_exclusions: [...module.repository_knowledge_exclusions ?? []]
      .map(value => ({ repository: value.repository, paths: [...value.paths].sort() }))
      .sort((a, b) => a.repository.localeCompare(b.repository)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  // Git 提交必须参与：只改图片时正文 revision 不变；同步时间则不能造成反复刷新。
  return createHash("sha256").update(JSON.stringify({ documents: rows, modules, repository: readKnowledgeRepoConfig(dir) })).digest("hex");
}

/** 按文件编号读取，避免打开一篇正文时重新装配所有模块、Skill 和经验。 */
export function readCatalogKnowledgeDocument(dir: string, id: string) {
  if (id.startsWith("kg-") || id.startsWith("kd-")) {
    let document: KnowledgeDocument;
    try { document = readKnowledgeDocument(dir, id); } catch { return undefined; }
    if (id.startsWith("kd-") && !withoutBoundModuleDrafts(dir, [document]).length) return undefined;
    return manualView(document);
  }
  return externalDocuments(dir, collectSearchableKnowledge(dir, allKnowledge, true, []).assets, new Set())
    .find(document => document.id === id);
}
