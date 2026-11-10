import { listKnowledgeDocuments, readKnowledgeDocument, eraseKnowledgeDocument, type KnowledgeDocument } from "./knowledgeDocuments.ts";
import { listKnowledgeDeletions, readKnowledgeDeletion, writeKnowledgeDeletion, type KnowledgeDeletion } from "./knowledgeDeletionStore.ts";
import type { KnowledgeSearch } from "./knowledgeSearch.ts";

// 旧萃取结果可能没有结构化 frontmatter，仍必须可以删除。
function componentDocument(doc: KnowledgeDocument) {
  return doc.research_source?.job_id.startsWith("cr-") || /^---\r?\n[\s\S]*?^schema:\s*"mfc\.component-[^"\r\n]+"/m.test(doc.content);
}
export function componentDeletionView(dir: string) {
  return {
    git_message: "平台删除不改动 Git 归档，请自行决定是否在归档仓删除对应文件。",
    documents: listKnowledgeDocuments(dir).filter(componentDocument).map(d => ({ id: d.id, title: d.title, revision: d.revision, active: d.active, archive_target: d.archive_target })),
    pending: listKnowledgeDeletions(dir).filter(d => d.index_state === "pending"),
  };
}
export async function retryKnowledgeDeletions(dir: string, search: Pick<KnowledgeSearch, "removeFromIndex">) {
  const pending = listKnowledgeDeletions(dir).filter(d => d.index_state === "pending");
  for (const record of pending) {
    eraseKnowledgeDocument(dir, record.id);
    const results = await Promise.all(record.index_ids.map(id => search.removeFromIndex(id)));
    if (results.every(Boolean)) writeKnowledgeDeletion(dir, { ...record, index_state: "removed" });
  }
  return componentDeletionView(dir);
}
export async function deleteComponentDocuments(dir: string, input: unknown, operator: string, search: Pick<KnowledgeSearch, "removeFromIndex">) {
  if (!Array.isArray(input) || !input.length || input.length > 100 || input.some(d => !d || typeof d.id !== "string" || typeof d.revision !== "string")) throw new Error("请选择 1–100 份组件知识");
  if (new Set(input.map(d => d.id)).size !== input.length) throw new Error("请勿重复选择知识");
  // 整批先校验，避免旧页面误删他人刚更新的知识。
  const records: KnowledgeDeletion[] = input.map(({ id, revision }) => {
    const previous = readKnowledgeDeletion(dir, id);
    if (previous) {
      if (previous.revision !== revision) throw new Error("知识版本不一致，请刷新");
      return previous;
    }
    const doc = readKnowledgeDocument(dir, id);
    if (!componentDocument(doc)) throw new Error("此入口只能删除组件知识");
    if (doc.revision !== revision) throw new Error("知识已更新，请刷新后删除");
    return { id, title: doc.title, revision, operator, research_job_id: doc.research_source?.job_id, at: new Date().toISOString(), index_state: "pending",
      index_ids: [id] };
  });
  for (const record of records) {
    writeKnowledgeDeletion(dir, record);
    eraseKnowledgeDocument(dir, record.id);
  }
  return retryKnowledgeDeletions(dir, search);
}
