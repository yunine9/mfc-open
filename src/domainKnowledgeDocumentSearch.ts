import type { DomainDocument } from "./domainKnowledgeTypes.ts";

/** 只返回定位摘录，避免把一两百篇全文塞进修订协调会话。 */
export function searchDomainKnowledgeDocuments(documents: DomainDocument[], input: { query?: string; keywords?: string[]; start?: number; limit?: number }) {
  if (input.query !== undefined && input.keywords !== undefined) throw new Error("query 或 keywords 请只填写一种；query 按完整字面短语匹配，keywords 任一词命中");
  const keywords = [...new Set((input.query !== undefined ? [input.query] : input.keywords ?? []).map(value => value.trim().toLocaleLowerCase()).filter(Boolean))];
  if (!keywords.length || keywords.length > 20 || keywords.some(value => value.length > 300)) throw new Error("请填写非空 query 或 keywords，最多 20 个字面关键词，每项最多 300 字符");
  const matches = documents.flatMap(document => {
    const excerpts: Array<{ field: "title" | "path" | "content" | "sources"; line: number; text: string }> = [];
    for (const field of ["title", "path", "content", "sources"] as const) {
      for (const [index, line] of document[field].split("\n").entries()) {
        const normalized = line.toLocaleLowerCase();
        const positions = keywords.map(keyword => normalized.indexOf(keyword)).filter(position => position >= 0);
        if (!positions.length) continue;
        const offset = Math.max(0, Math.min(...positions) - 60), end = Math.min(line.length, offset + 240);
        excerpts.push({ field, line: index + 1, text: (offset ? "…" : "") + line.slice(offset, end) + (end < line.length ? "…" : "") });
        if (excerpts.length === 3) break;
      }
      if (excerpts.length === 3) break;
    }
    return excerpts.length ? [{ id: document.id, title: document.title, path: document.path, target_id: document.target_id,
      layer: document.layer, revision: document.revision, deleted: document.deleted === true, matches: excerpts }] : [];
  });
  const start = Math.max(0, Math.floor(input.start ?? 0)), limit = Math.min(100, Math.max(1, Math.floor(input.limit ?? 30)));
  return { total: matches.length, documents: matches.slice(start, start + limit), next_start: start + limit < matches.length ? start + limit : undefined };
}
