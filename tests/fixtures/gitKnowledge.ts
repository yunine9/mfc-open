import { createHash } from "node:crypto";
import { readBusinessModule, updateBusinessModule } from "../../src/businessModuleLibrary.ts";
import type { KnowledgeDocument } from "../../src/knowledgeDocuments.ts";
import { readGitKnowledgeSnapshot, writeGitKnowledgeSnapshot } from "../../src/knowledgeRepositorySnapshots.ts";
import { readKnowledgeRepoConfig, saveKnowledgeRepoConfig } from "../../src/knowledgeRepoConfig.ts";
import { resolveModuleKnowledgeLocation } from "../../src/businessModuleKnowledge.ts";

/** 检索单测直接装入已同步的正式快照；网络与 Git 行为由 knowledgeRepositorySync 的真 Git 测试覆盖。 */
export function gitKnowledgeDocument(dataDir: string, moduleId: string, input: Pick<KnowledgeDocument, "title" | "content"> & {
  path?: string; technologies?: string[]; product_versions?: string[]; when_to_use?: string;
}): KnowledgeDocument {
  const module = readBusinessModule(dataDir, moduleId);
  if (!readKnowledgeRepoConfig(dataDir)) saveKnowledgeRepoConfig(dataDir, "https://knowledge.example.test/team/domain.git", { branch: "main" });
  if (!module.knowledge_path) updateBusinessModule(dataDir, moduleId, { knowledge_path: `domains/${moduleId}` }, "fixture");
  const location = resolveModuleKnowledgeLocation(dataDir, moduleId)!;
  const previous = readGitKnowledgeSnapshot(dataDir, moduleId);
  const path = input.path ?? `${location.docs_path}/${input.title.replace(/[\\/:*?"<>|]/g, "-").replace(/\.md$/i, "")}.md`;
  const fields = { title: input.title, content: input.content, scope: "module" as const, module_ids: [moduleId], repositories: [], technologies: input.technologies ?? [],
    product_versions: input.product_versions ?? [], when_to_use: input.when_to_use ?? "", active: true };
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const commit = createHash("sha1").update(JSON.stringify([previous?.repositories[0]?.revision, path, input])).digest("hex");
  const revision = hash(JSON.stringify(fields)), at = new Date().toISOString();
  const document: KnowledgeDocument = { ...fields, id: `kg-${hash(JSON.stringify([location.repository, location.branch, path]))}`, revision,
    source: { repository: location.repository, branch: location.branch, path, revision: commit },
    archive_target: { repository: location.repository, branch: location.branch, path }, history: [{ at, operator: "fixture", action: "从正式分支同步", revision }] };
  const documents = [...previous?.documents.filter(row => row.id !== document.id) ?? [], document]
    .map(row => ({ ...row, source: { ...row.source!, revision: commit } }));
  writeGitKnowledgeSnapshot(dataDir, { module_id: moduleId, location, synced_at: at, documents, resources: {},
    repositories: [{ repository: location.repository, branch: location.branch, revision: commit, scope: "module", synced_at: at }] });
  return document;
}
export function removeGitKnowledgeDocument(dataDir: string, moduleId: string, id: string) {
  const snapshot = readGitKnowledgeSnapshot(dataDir, moduleId)!;
  const revision = createHash("sha1").update(JSON.stringify([snapshot.repositories[0]?.revision, id, "delete"])).digest("hex");
  writeGitKnowledgeSnapshot(dataDir, { ...snapshot, documents: snapshot.documents.filter(document => document.id !== id)
    .map(document => ({ ...document, source: { ...document.source!, revision } })),
    repositories: snapshot.repositories.map(source => ({ ...source, revision })), synced_at: new Date().toISOString() });
}
