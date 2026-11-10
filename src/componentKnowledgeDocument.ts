import type { SearchableKnowledge } from "./knowledgeSearch.ts";
import type { ComponentPolicy } from "./componentKnowledgeTypes.ts";
import { effectiveComponentPolicy } from "./componentKnowledgePolicy.ts";
import { validateComponentParadigm, type ComponentParadigm } from "./componentParadigms.ts";
import { validateComponentUsageMarkdown } from "./componentKnowledgeMarkdown.ts";

export interface PublishedComponentParadigm extends ComponentParadigm {
  mapping_id: string; source_digest: string; policy: ComponentPolicy;
  id: string; title: string; revision: number;
  document_id: string; document_revision: string; start_line: number; end_line: number;
  product_versions: string[]; source_repositories: string[];
}
/** 读取正式文档自身的格式，不读取研究记录或旁路生成的缓存。 */
export function publishedComponentParadigms(asset: Pick<SearchableKnowledge, "id" | "revision" | "content" | "productVersions">): PublishedComponentParadigm[] {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(asset.content);
  if (!front || !/^schema:.*mfc\.component-/m.test(front[1])) return [];
  const lines = asset.content.split(/\r?\n/);
  const source = { document_id: asset.id, document_revision: asset.revision, product_versions: asset.productVersions, source_repositories: [] as string[], mapping_id: "", source_digest: "", policy: effectiveComponentPolicy(undefined, "") };
  if (!/^schema: "mfc\.component-guide\/v1"$/m.test(front[1])) throw new Error("不支持的组件知识 schema");
  const headers = front[1].split(/\r?\n/);
  if (headers.length !== 2 || !headers[1].startsWith("component_paradigms: ")) throw new Error("组件联合文档头部格式不完整或包含重复字段");
  const entries = JSON.parse(headers[1].slice("component_paradigms: ".length));
  if (!Array.isArray(entries) || !entries.length) throw new Error("组件联合文档没有结构化产物");
  const seen = new Set<string>();
  const validated = entries.map(entry => {
    const { id, title, revision, ...metadata } = entry;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(id) || seen.has(id)
      || typeof title !== "string" || !title.trim() || !Number.isInteger(revision) || revision < 1) throw new Error("组件范式编号、标题或版本无效");
    seen.add(id);
    validateComponentParadigm(metadata, Array.isArray(metadata.evidence) ? metadata.evidence.map(e => e?.repository_id) : []);
    return { id, title, revision, metadata };
  });
  return validated.filter(entry => entry.metadata.kind === "paradigm" && entry.metadata.status === "recommended").map(({ id, title, revision, metadata }) => {
    const anchors = lines.flatMap((line, index) => line === `<a id="component-${id}"></a>` ? [index] : []);
    if (anchors.length !== 1) throw new Error(`范式 ${id} 缺少唯一正文位置`);
    const start = anchors[0], next = lines.findIndex((line, index) => index > start && /^<a id="component-[a-z0-9-]+"><\/a>$/.test(line));
    const body = lines.slice(start, next < 0 ? lines.length : next).join("\n");
    const content = /^<a id="component-[a-z0-9-]+"><\/a>\n\n## [^\n]+\n\n([\s\S]+)$/.exec(body);
    if (!content) throw new Error(`范式 ${id} 正文缺少用法标题与内容`);
    try { validateComponentUsageMarkdown(content[1]); }
    catch (error) { throw new Error(`范式 ${id} 正文不完整：${error instanceof Error ? error.message : String(error)}`); }
    return { ...metadata, id, title, revision, ...source, start_line: start + 1, end_line: next < 0 ? lines.length : next };
  });
}
