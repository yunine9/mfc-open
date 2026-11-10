import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import { listBusinessModules } from "./businessModuleLibrary.ts";
import { componentUsageDocument } from "./componentKnowledgeCards.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import type { KnowledgeSearch, KnowledgeContext, KnowledgeHit, SearchableKnowledge } from "./knowledgeSearch.ts";
import type { KnowledgeAnswerExecution, KnowledgeAnswerEvidence } from "./knowledgeAnswerTypes.ts";
import { KnowledgeAnswerError } from "./knowledgeAnswerModel.ts";

type SourceOptions = { dataDir: string; search: KnowledgeSearch; maxChars: number };
const DOCUMENT_CHARS = 16_000;
const SECTION_CHARS = 24_000;
type EvidenceSection = Pick<KnowledgeAnswerEvidence, "content" | "location" | "start_line" | "end_line" | "truncated">;

/** 长用法按完整小节读取；代码围栏内的标题不切分，约束和配置优先于长示例。 */
function componentSections(asset: SearchableKnowledge, usage: NonNullable<ReturnType<typeof componentUsageDocument>>, id: string): EvidenceSection[] {
  const lines = asset.content.split(/\r?\n/), parts: Array<EvidenceSection & { priority: number }> = [];
  const metadata = usage.text.slice(0, usage.sections[0].start_offset).trim();
  parts.push({ content: metadata, location: `用法 ${id} 的适用范围与来源（正式文档元数据）`, truncated: true, priority: 0 });
  for (const range of usage.sections) {
    let start = range.start_line, heading = range.heading, fence = "";
    const append = (end: number) => {
      const content = lines.slice(start - 1, end).join("\n");
      if (!content.replace(/^ {0,3}#{1,3}\s+.*$/gm, "").replace(/^<a id="component-[a-z0-9-]+"><\/a>$/gm, "").trim()) return;
      parts.push({ content, start_line: start, end_line: end, truncated: true,
        location: `用法 ${id} · ${heading}（分节读取，仅以已读原文为依据）`,
        priority: /适用场景|使用约束|常见误用|接入配置/.test(heading) ? 1 : /示例/.test(heading) ? 3 : 2 });
    };
    for (let line = start; line <= range.end_line; line++) {
      const text = lines[line - 1], marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      } else if (marker) fence = marker[1];
      else {
        const title = /^ {0,3}#{1,3}\s+(.+?)\s*#*\s*$/.exec(text)?.[1];
        if (title) { append(line - 1); start = line; heading = title; }
      }
    }
    append(range.end_line);
  }
  return parts.sort((a, b) => a.priority - b.priority).map(({ priority: _priority, ...part }) => part);
}

export function knowledgeAnswerSourceCatalog(dataDir: string, search?: KnowledgeSearch) {
  const modules = listBusinessModules(dataDir);
  const catalog = search?.catalog({ repo: "", repositories: [], moduleIds: [] }, true);
  return {
    modules: modules.modules.filter(m => m.status === "active").map(m => ({ id: m.id, name: m.name })),
    documents: (catalog?.assets ?? []).filter(a => a.kind !== "experience").map(a => ({
      id: a.id, title: a.title, module_ids: a.applicability?.modules ?? [], revision: a.revision,
    })),
    sources: [{ kind: "knowledge" as const, label: "已发布知识文档", available: !!search,
      detail: "从知识库的 Markdown 文档中检索相关章节，依据原文回答。文档发布或更新后提前建立索引。" }],
    warnings: [...modules.warnings, ...(catalog?.warnings ?? [])],
  };
}

/** 保留完整章节与围栏代码，不以任意字符截断条件、表格或代码示例。 */
function excerpt(asset: SearchableKnowledge, hit: Pick<KnowledgeHit, "start_line" | "end_line">) {
  const lines = asset.content.split(/\r?\n/);
  if (asset.content.length <= DOCUMENT_CHARS) return { content: asset.content, start_line: 1, end_line: lines.length };
  const first = hit.start_line, last = hit.end_line ?? first;
  if (!first || !last || first < 1 || last < first || last > lines.length) return undefined;
  const headings: Array<{ line: number; depth: number }> = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
      continue;
    }
    const heading = !fence && /^ {0,3}(#{1,6})\s+/.exec(line);
    if (heading) headings.push({ line: index + 1, depth: heading[1].length });
  }
  // 优先保留二级章节，包括其中所有小节；无二级章节时使用命中所在小节。
  const before = headings.filter(h => h.line <= first);
  const parent = before.filter(h => h.depth <= 2).at(-1);
  const heading = parent?.depth === 2 ? parent : before.at(-1);
  const start = heading?.line ?? 1;
  const end = (headings.find(h => h.line > last && h.depth <= (heading?.depth ?? 1))?.line ?? lines.length + 1) - 1;
  return { content: lines.slice(start - 1, end).join("\n"), start_line: start, end_line: end };
}

/** 固定检索已发布文档并读取原文；整个过程不调用模型、代码仓或外部知识服务。 */
export async function retrieveKnowledgeAnswerEvidence(input: KnowledgeAnswerExecution, options: SourceOptions): Promise<void> {
  const selected = input.record.context ?? {}, moduleIds = resolveBusinessModuleIds(options.dataDir, selected.module_ids ?? []);
  const modules = listBusinessModules(options.dataDir).modules.filter(m => m.status === "active" && moduleIds.includes(m.id));
  const context: KnowledgeContext = { repo: "", repositories: modules.flatMap(m => m.repositories), moduleIds, productVersion: selected.product_version };
  const all = !moduleIds.length;
  const check = () => { if (input.signal.aborted) throw new Error("知识检索已取消"); };
  const read = (id: string) => {
    const asset = options.search.read(context, id, all);
    return asset?.kind !== "experience" ? asset : undefined;
  };
  check();
  const reference = selected.document_id ? read(selected.document_id) : undefined;
  if (selected.document_id && !reference) {
    input.warn("指定文档不可读、已停用或不在所选模块与版本范围，请重新选择文档");
    return;
  }
  // 已明确指定的小文档可直接读取，无需向量服务，也无需模型寻找来源。
  let hits: Array<Pick<KnowledgeHit, "id" | "revision" | "paradigm_id" | "start_line" | "end_line">>;
  if (reference && reference.content.length <= DOCUMENT_CHARS) hits = [{ id: reference.id, revision: reference.revision }];
  else {
    const result = await options.search.searchDocuments(context, input.record.question, { all, documentId: selected.document_id, limit: 8 });
    check();
    for (const warning of result.warnings) input.warn(warning);
    if (!result.available) throw new KnowledgeAnswerError(result.warnings.at(-1) ?? "文档检索暂时不可用，请稍后重试。");
    hits = result.hits;
  }
  let used = 0, omittedForSize = false;
  const seen = new Set<string>();
  for (const hit of hits) {
    check();
    const asset = read(hit.id);
    if (!asset || asset.revision !== hit.revision) {
      input.warn("检索期间有文档更新或停用，已排除其旧版结果，请重新提问获取新版内容");
      continue;
    }
    const usage = hit.paradigm_id ? componentUsageDocument(asset, hit.paradigm_id) : undefined;
    const section = hit.paradigm_id ? usage && { content: usage.text, location: `完整用法 ${hit.paradigm_id}（含公共配置）` } : excerpt(asset, hit);
    if (!section?.content.trim()) { input.warn(`未取得「${asset.title}」的完整原文章节，请缩小问题或指定文档`); continue; }
    const evidenceFor = (part: EvidenceSection): Omit<KnowledgeAnswerEvidence, "id" | "digest" | "retrieved_at"> => ({
      kind: "knowledge", title: asset.title, ...part, source_id: asset.id, revision: asset.revision,
      scope: `${asset.scope}；适用产品版本：${asset.productVersions.join("、") || "未声明，需核对正文"}；适用条件：${asset.whenToUse}`,
    });
    const completeFits = section.content.length <= SECTION_CHARS && used + JSON.stringify(evidenceFor(section)).length + 200 <= options.maxChars;
    const parts: EvidenceSection[] = usage && hit.paradigm_id && !completeFits ? componentSections(asset, usage, hit.paradigm_id) : [section];
    let omitted = 0;
    for (const part of parts) {
      const key = `${asset.id}:${part.start_line === undefined ? `${hit.paradigm_id ?? "full"}:${part.location ?? ""}` : `${part.start_line}-${part.end_line}`}`;
      if (seen.has(key)) continue;
      const evidence = evidenceFor(part), chars = JSON.stringify(evidence).length + 200;
      if (seen.size >= 80 || part.content.length > SECTION_CHARS || used + chars > options.maxChars) { omitted++; omittedForSize = true; continue; }
      try { scanForSecrets("知识问答依据", Buffer.from(part.content)); }
      catch { input.warn(`「${asset.title}」的章节含疑似敏感字段，未用于回答，请先检查知识文档`); continue; }
      input.addEvidence(evidence);
      seen.add(key); used += chars;
    }
    if (omitted) input.warn(`「${asset.title}」有 ${omitted} 个完整章节超出本次原文预算；其余可容纳章节已读取，未读内容不作为依据。可指定文档并缩小问题范围继续查询。`);
  }
  if (!used && omittedForSize) throw new KnowledgeAnswerError("已找到相关文档，但相关原文章节超过本次读取容量；请指定文档并缩小问题范围后重试。");
}
