import type { KnowledgeAssetFocus } from "./knowledgeNavigation";
import { createKnowledgeReadCache, invalidateKnowledgeReads } from "./knowledgeReadCache";
export interface KnowledgeDocument {
  external?: boolean; form?: string; scope_label?: string; focus?: KnowledgeAssetFocus;
  id: string; title: string; content?: string; scope: "platform" | "module" | "repository";
  module_ids: string[]; repositories: string[]; technologies: string[]; product_versions: string[];
  when_to_use: string; technology_assignment_required?: true; active: boolean; revision: string;
  source?: { repository: string; branch: string; path: string; revision: string };
  research_source?: { job_id:string; repository:string; branch:string; path:string; revision?:string; components?: Array<{ id: string }> };
  history: Array<{ at: string; operator: string; action: string }>;
  indexing?: { state: string; sections?: number; error?: string }; lines?: number;
}
export interface ChapterHit { id: string; heading?: string; start_line?: number; end_line?: number; revision: string; summary?: string }
export interface TrialResult { available: boolean; warnings: string[]; hits: ChapterHit[] }
const documentCache = createKnowledgeReadCache<KnowledgeDocument>({
  maxEntries: 24, maxWeight: 16 * 1024 * 1024, ttl: 30_000,
  weight: document => JSON.stringify(document).length * 2,
});
export function readKnowledgeDocument(id: string, revision: string, refresh = false, sourceRevision?: string) {
  return documentCache.read(JSON.stringify([id, revision, sourceRevision]),
    () => documentRequest<KnowledgeDocument>(`/${encodeURIComponent(id)}`), refresh,
    document => document.revision === revision && (sourceRevision === undefined || document.source?.revision === sourceRevision));
}
export function knowledgeDocumentResourceUrl(document: KnowledgeDocument, path: string) {
  return `/knowledge-documents/${encodeURIComponent(document.id)}/resources?path=${encodeURIComponent(path)}&revision=${encodeURIComponent(document.source?.revision ?? document.revision)}`;
}
export async function documentRequest<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(`/knowledge-documents${path}`, body === undefined ? { signal: AbortSignal.timeout(30_000), cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "请求失败");
  if (body !== undefined) invalidateKnowledgeReads();
  return data;
}
