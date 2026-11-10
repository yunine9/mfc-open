import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
/** Human-maintained manuals. One atomic record holds original text and its audit trail. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { knowledgeDeleted, listKnowledgeDeletions, readKnowledgeDeletion } from "./knowledgeDeletionStore.ts";
import { join } from "node:path";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { requireTechnologyStackChanges } from "./technologyStacks.ts";
import { durableWriteFileSync } from "./durableWrite.ts";
import { FileProjectionCache } from "./fileProjectionCache.ts";
import { componentArchiveParts } from "./componentKnowledgeArchiveFormat.ts";
import { listGitKnowledgeDocuments, listGitKnowledgeDocumentMetadata, readGitKnowledgeDocument, withoutBoundModuleDrafts } from "./knowledgeRepositorySnapshots.ts";
export interface KnowledgeDocument {
  id: string; title: string; content: string; scope: "platform" | "module" | "repository";
  module_ids: string[]; repositories: string[]; technologies: string[]; product_versions: string[];
  when_to_use: string; active: boolean; revision: string;
  /** 删除最后一个技术栈后，补齐关联才能重新启用。 */
  technology_assignment_required?: true;
  source?: { repository: string; branch: string; path: string; revision: string };
  archive_target?: { repository: string; branch: string; path: string };
  research_source?: { job_id:string; document_id?: string; layer?: "domain" | "repository"; repository:string; branch:string; path:string; revision?:string; source_revisions?: Record<string, string>; material_ids?: string[]; skill?: { name: string; digest: string }; components?: Array<{id:string; repository:string; branch:string; path:string; revision?:string}> };
  history: Array<{ at: string; operator: string; action: string; revision?: string }>;
}
export type KnowledgeDocumentMetadata = Omit<KnowledgeDocument, "content"> & { lines: number };
const documentMetadata = new FileProjectionCache<KnowledgeDocumentMetadata>();
function metadataOf(document: KnowledgeDocument): KnowledgeDocumentMetadata {
  const { content, ...metadata } = document;
  return { ...metadata, lines: content.split("\n").length };
}
const root = (dir: string) => join(dir, "knowledge-documents");
function file(dir: string, id: string) {
  if (!/^kd-[a-f0-9-]{36}$/.test(id)) throw new Error("文档不存在");
  return join(root(dir), `${id}.json`);
}
function storedDocument(value: unknown, id: string): KnowledgeDocument {
  const record = value as KnowledgeDocument | null;
  const text = (value: unknown) => typeof value === "string";
  const list = (value: unknown) => Array.isArray(value) && value.every(text);
  const location = (value: unknown, keys: string[]) => value === undefined || !!value && typeof value === "object" && !Array.isArray(value)
    && keys.every(key => text((value as Record<string, unknown>)[key]));
  const research = record?.research_source;
  if (!record || typeof record !== "object" || Array.isArray(record) || record.id !== id
    || !text(record.title) || !record.title.trim() || !text(record.content) || !record.content.trim()
    || !["platform", "module", "repository"].includes(record.scope) || typeof record.active !== "boolean"
    || !text(record.revision) || !/^[a-f0-9]{64}$/.test(record.revision)
    || ![record.module_ids, record.repositories, record.technologies, record.product_versions].every(list)
    || !text(record.when_to_use) || record.technology_assignment_required !== undefined && record.technology_assignment_required !== true
    || !Array.isArray(record.history) || !record.history.length
    || record.history.some(item => !item || typeof item !== "object" || !text(item.at) || !Number.isFinite(Date.parse(item.at))
      || !text(item.operator) || !text(item.action) || item.revision !== undefined && !text(item.revision))
    || !location(record.source, ["repository", "branch", "path", "revision"])
    || !location(record.archive_target, ["repository", "branch", "path"])
    || !location(research, ["job_id"])
    || research?.layer !== undefined && !["domain", "repository"].includes(research.layer)
    || research && ["repository", "branch", "path"].some(key => research[key as keyof typeof research] !== undefined
      && !text(research[key as keyof typeof research]))) throw new Error("知识记录形状不正确");
  return record;
}
function readStoredKnowledgeDocument(dir: string, id: string): KnowledgeDocument {
  if (knowledgeDeleted(dir, id)) throw new Error("知识已删除");
  const path = file(dir, id);
  try { return storedDocument(JSON.parse(readFileSync(path, "utf8")), id); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`记录损坏：knowledge-documents/${id}.json`);
  }
}
export function readKnowledgeDocument(dir: string, id: string): KnowledgeDocument {
  if (id.startsWith("kg-")) return readGitKnowledgeDocument(dir, id);
  const doc = readStoredKnowledgeDocument(dir, id);
  return { ...doc, module_ids: resolveBusinessModuleIds(dir, doc.module_ids) };
}
export type KnowledgeDocumentFacts = Pick<KnowledgeDocument, "id" | "revision"> & { component_archive_valid?: false };
const documentFacts = new FileProjectionCache<KnowledgeDocumentFacts>();
function knowledgeDocumentFacts(document: KnowledgeDocument): KnowledgeDocumentFacts {
  let component_archive_valid: false | undefined;
  if (/^---\r?\nschema: "mfc\.component-guide\/v1"\r?\n/.test(document.content)) {
    try { componentArchiveParts(document.content); } catch { component_archive_valid = false; }
  }
  return { id: document.id, revision: document.revision, ...(component_archive_valid === false ? { component_archive_valid } : {}) };
}
export function readKnowledgeDocumentFacts(dir: string, id: string): KnowledgeDocumentFacts {
  if (id.startsWith("kg-")) return knowledgeDocumentFacts(readGitKnowledgeDocument(dir, id));
  if (knowledgeDeleted(dir, id)) throw new Error("知识已删除");
  return { ...documentFacts.read(file(dir, id), () => knowledgeDocumentFacts(readKnowledgeDocument(dir, id))) };
}
/** 任务中心只需发现坏记录，不必每次读取并保留所有知识正文。 */
export function listKnowledgeDocumentFacts(dir: string, warnings?: string[]): KnowledgeDocumentFacts[] {
  if (!existsSync(root(dir))) return [];
  const facts: KnowledgeDocumentFacts[] = [];
  for (const name of readdirSync(root(dir)).filter(name => /^kd-[a-f0-9-]{36}\.json$/.test(name) && !knowledgeDeleted(dir, name.slice(0, -5)))) {
    try { facts.push(readKnowledgeDocumentFacts(dir, name.slice(0, -5))); }
    catch {
      const warning = `请检查损坏的知识记录：knowledge-documents/${name}；其余任务照常可用`;
      if (warnings && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  return facts;
}
export function eraseKnowledgeDocument(dir: string, id: string) {
  if (!knowledgeDeleted(dir, id)) throw new Error("请先记录知识删除操作");
  rmSync(file(dir, id), { force: true });
}
export function listKnowledgeDocuments(dir: string, warnings?: string[]): KnowledgeDocument[] {
  if (!existsSync(root(dir))) return [];
  const documents: KnowledgeDocument[] = [];
  for (const name of readdirSync(root(dir)).filter(name => /^kd-[a-f0-9-]{36}\.json$/.test(name) && !knowledgeDeleted(dir, name.slice(0, -5)))) {
    try { documents.push(readKnowledgeDocument(dir, name.slice(0, -5))); }
    catch {
      const warning = `请检查损坏的知识记录：knowledge-documents/${name}；其余任务照常可用`;
      if (warnings && !warnings.includes(warning)) warnings.push(warning);
    }
  }
  return documents.sort((a, b) => b.history.at(-1)!.at.localeCompare(a.history.at(-1)!.at));
}
/** 正式阅读和问答只消费绑定来源的 Git 快照；旧任务记录仍可单独追溯。 */
export function listFormalKnowledgeDocuments(dir: string, warnings?: string[]): KnowledgeDocument[] {
  return [...withoutBoundModuleDrafts(dir, listKnowledgeDocuments(dir, warnings)), ...listGitKnowledgeDocuments(dir)];
}
/** 阅读目录只需要名称、来源和版本，旧文稿正文也只在文件变化时读取。 */
export function listFormalKnowledgeDocumentMetadata(dir: string): KnowledgeDocumentMetadata[] {
  const documents: KnowledgeDocumentMetadata[] = [];
  if (existsSync(root(dir))) {
    for (const name of readdirSync(root(dir)).filter(name => /^kd-[a-f0-9-]{36}\.json$/.test(name))) {
      const id = name.slice(0, -5);
      if (knowledgeDeleted(dir, id)) continue;
      try {
        const metadata = documentMetadata.read(file(dir, id), () => metadataOf(readStoredKnowledgeDocument(dir, id)));
        const resolved = { ...metadata, module_ids: resolveBusinessModuleIds(dir, metadata.module_ids) };
        if (withoutBoundModuleDrafts(dir, [{ ...resolved, content: "" }]).length) documents.push(resolved);
      } catch { /* 与正文目录一致：坏记录由任务中心报告，其余知识继续可读。 */ }
    }
  }
  documents.sort((a, b) => b.history.at(-1)!.at.localeCompare(a.history.at(-1)!.at));
  return [...documents, ...listGitKnowledgeDocumentMetadata(dir)];
}
export interface KnowledgeDocumentVersion { document: KnowledgeDocument; published_at: string; operator: string }
function versionRoot(dir: string, id: string) {
  file(dir, id);
  return join(dir, "knowledge-document-versions", id);
}
function retainVersion(dir: string, document: KnowledgeDocument) {
  const folder = versionRoot(dir, document.id);
  mkdirSync(folder, { recursive: true });
  const last = document.history.at(-1)!;
  const version: KnowledgeDocumentVersion = { document, published_at: last.at, operator: last.operator };
  const path = join(folder, `${document.revision}.json`);
  if (!existsSync(path)) durableWriteFileSync(path, JSON.stringify(version), { mode: 0o640 });
}
export function listKnowledgeDocumentVersions(dir: string, id: string) {
  // Existing records acquire a recoverable baseline without inventing older text.
  const current = readStoredKnowledgeDocument(dir, id);
  retainVersion(dir, current);
  const committed = new Set([current.revision, ...current.history.map(h => h.revision)]);
  return readdirSync(versionRoot(dir, id)).filter(name => /^[a-f0-9]{64}\.json$/.test(name) && committed.has(name.slice(0, -5)))
    .map(name => readKnowledgeDocumentVersion(dir, id, name.slice(0, -5)))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
}
export function readKnowledgeDocumentVersion(dir: string, id: string, revision: string): KnowledgeDocumentVersion {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("知识版本无效");
  const current = readStoredKnowledgeDocument(dir, id);
  if (current.revision !== revision && !current.history.some(h => h.revision === revision)) throw new Error("该版本尚未发布或不存在");
  if (current.revision === revision) retainVersion(dir, current);
  return JSON.parse(readFileSync(join(versionRoot(dir, id), `${revision}.json`), "utf8"));
}
/** 归档删除操作只读取删除记录绑定的精确版本；普通读取和知识消费仍拒绝已删除知识。 */
export function readKnowledgeArchiveVersion(dir: string, id: string, revision: string): KnowledgeDocumentVersion {
  if (!knowledgeDeleted(dir, id)) return readKnowledgeDocumentVersion(dir, id, revision);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("知识版本无效");
  const deletion = readKnowledgeDeletion(dir, id);
  if (deletion?.id !== id || deletion.revision !== revision) throw new Error("已删除知识只能归档删除时绑定的精确版本");
  const path = join(versionRoot(dir, id), `${revision}.json`);
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as KnowledgeDocumentVersion;
    const document = storedDocument(value?.document, id);
    if (document.revision !== revision || typeof value.published_at !== "string" || !Number.isFinite(Date.parse(value.published_at))
        || typeof value.operator !== "string" || !value.operator.trim()) throw new Error("归档版本形状不正确");
    return { document, published_at: value.published_at, operator: value.operator };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("已删除知识的精确归档版本未保留，请检查删除记录与版本文件");
    throw new Error(`归档版本记录损坏：knowledge-document-versions/${id}/${revision}.json`);
  }
}
const archiveVersionFacts = new FileProjectionCache<KnowledgeDocumentFacts>();
/** 删除归档的列表摘要仍逐次核对删除记录，只复用未变化的精确版本文件校验。 */
export function readKnowledgeArchiveVersionFacts(dir: string, id: string, revision: string): KnowledgeDocumentFacts {
  const load = () => knowledgeDocumentFacts(readKnowledgeArchiveVersion(dir, id, revision).document);
  if (!knowledgeDeleted(dir, id)) return load();
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error("知识版本无效");
  const deletion = readKnowledgeDeletion(dir, id);
  if (deletion?.id !== id || deletion.revision !== revision) throw new Error("已删除知识只能归档删除时绑定的精确版本");
  try { return { ...archiveVersionFacts.read(join(versionRoot(dir, id), `${revision}.json`), load) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return load(); throw error; }
}
function strings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== "string" || v.length > 512)) throw new Error("适用范围格式不正确");
  return [...new Set(value.map(v => v.trim()).filter(Boolean))];
}
export interface PreparedKnowledgeDocument {
  document: KnowledgeDocument;
  previous_revision: string | null;
  unchanged: boolean;
  /** 人工确认新文稿时可分配新编号，已删除的原编号仍禁止复活。 */
  allowNewResearchDocument?: true;
}
/** 预检只读磁盘，并确定精确的正式版本，供发布器先保存归档批次。 */
export function prepareKnowledgeDocument(dir: string, input: Record<string, unknown>, operator: string, id?: string,
  options: { maxContentBytes?: number; expectedRevision?: string; technologyAssignmentRequired?: true; allowNewResearchDocument?: true } = {}): PreparedKnowledgeDocument {
  const previous = id ? readStoredKnowledgeDocument(dir, id) : undefined;
  if (options.expectedRevision !== undefined && previous?.revision !== options.expectedRevision) throw new Error("正式知识已有新版本，请比较最新内容后重新发布，未覆盖他人修改");
  const merged = { ...previous, ...input };
  const research = merged.research_source as KnowledgeDocument["research_source"];
  if (!previous && !options.allowNewResearchDocument && research?.job_id && listKnowledgeDeletions(dir).some(d => d.research_job_id === research.job_id)) throw new Error("本次萃取的知识已删除；如需重新入库，请新建萃取任务，旧归档同步不会恢复知识");
  const title = String(merged.title ?? "").trim();
  const content = String(merged.content ?? "").replace(/\r\n/g, "\n");
  if (!title || title.length > 160) throw new Error("请填写文档名称（最多 160 字）");
  // 联合研究由宿主分段生成，可显式使用更大容量；普通上传保持原限制。
  // 已保存的长文档仅调整范围或启停时，不能因上传限制而失败。
  const maxContentBytes = Math.max(options.maxContentBytes ?? 2 * 1024 * 1024, Buffer.byteLength(previous?.content ?? ""));
  if (!content.trim() || content.includes("\0") || Buffer.byteLength(content) > maxContentBytes) throw new Error(`请提供非空 UTF-8 Markdown 文档，最大 ${Math.ceil(maxContentBytes / 1024 / 1024)} MiB`);
  const scope = merged.scope ?? "platform";
  if (!["platform", "module", "repository"].includes(String(scope))) throw new Error("请选择适用范围");
  const module_ids = scope === "module" ? strings(merged.module_ids ?? [], 8) : [];
  const repositories = scope === "repository" ? strings(merged.repositories ?? []) : [];
  if (scope === "module" && !module_ids.length) throw new Error("请选择业务模块");
  for (const moduleId of module_ids) if (readBusinessModule(dir, moduleId).status !== "active") throw new Error("所选业务模块已停用");
  if (scope === "repository" && !repositories.length) throw new Error("请填写适用代码仓地址");
  if (merged.active !== undefined && typeof merged.active !== "boolean") throw new Error("文档状态不正确");
  const technologies = normalizeKnowledgeLanguages(merged.technologies ?? []);
  const concreteTechnologies = technologies.filter((id) => id !== "agnostic");
  requireTechnologyStackChanges(dir, concreteTechnologies, previous?.technologies.filter((id) => id !== "agnostic"));
  const technologyAssignmentRequired = !concreteTechnologies.length
    && (previous?.technology_assignment_required === true || options.technologyAssignmentRequired === true);
  if (technologyAssignmentRequired && merged.active !== false) {
    throw new Error("该知识的技术栈已删除，请先补充技术栈关联再启用");
  }
  const fields = { title, content, scope: scope as KnowledgeDocument["scope"], module_ids, repositories,
    technologies, product_versions: strings(merged.product_versions ?? []),
    ...(technologyAssignmentRequired ? { technology_assignment_required: true as const } : {}),
    when_to_use: String(merged.when_to_use ?? "").trim().slice(0, 1000), active: merged.active !== false,
    research_source: merged.research_source as KnowledgeDocument["research_source"],
    archive_target: merged.archive_target as KnowledgeDocument["archive_target"],
    source: merged.source as KnowledgeDocument["source"] };
  const revision = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  if (previous?.revision === revision) return { document: previous, previous_revision: previous.revision, unchanged: true };
  const action = !previous ? "上传文档" : previous.active !== fields.active ? fields.active ? "启用文档" : "停用文档"
    : previous.source?.revision !== fields.source?.revision && fields.source ? "从仓库更新"
    : previous.content !== content ? "替换文档" : "修改适用范围";
  const history = structuredClone(previous?.history ?? []);
  if (previous && history.length && !history.at(-1)!.revision) history.at(-1)!.revision = previous.revision;
  const doc: KnowledgeDocument = { ...fields, id: previous?.id ?? `kd-${randomUUID()}`, revision,
    history: [...history, { at: new Date().toISOString(), operator, action, revision }] };
  return { document: doc, previous_revision: previous?.revision ?? null, unchanged: false,
    ...(options.allowNewResearchDocument ? { allowNewResearchDocument: true as const } : {}) };
}
/** 提交前重验磁盘基线、删除记录与模块状态，精确写入已准备的版本。 */
export function writePreparedKnowledgeDocument(dir: string, prepared: PreparedKnowledgeDocument): KnowledgeDocument {
  const document = storedDocument(prepared.document, prepared.document.id);
  if (knowledgeDeleted(dir, document.id)) throw new Error("知识已删除");
  const target = file(dir, document.id);
  const previous = existsSync(target) ? readStoredKnowledgeDocument(dir, document.id) : undefined;
  if ((previous?.revision ?? null) !== prepared.previous_revision) throw new Error("正式知识已有新版本，请比较最新内容后重新发布，未覆盖他人修改");
  const verified = prepareKnowledgeDocument(dir, { ...document }, document.history.at(-1)!.operator, previous?.id,
    { expectedRevision: previous?.revision, maxContentBytes: Math.max(2 * 1024 * 1024, Buffer.byteLength(document.content)),
      ...(prepared.allowNewResearchDocument ? { allowNewResearchDocument: true as const } : {}),
      ...(document.technology_assignment_required ? { technologyAssignmentRequired: true } : {}) });
  if (verified.document.revision !== document.revision) throw new Error("准备的正式知识版本已变化，请重新发布");
  if (prepared.unchanged) {
    if (!previous || previous.revision !== document.revision) throw new Error("正式知识已有新版本，请重新发布");
    return previous;
  }
  if (previous) retainVersion(dir, previous);
  retainVersion(dir, document);
  mkdirSync(root(dir), { recursive: true });
  durableWriteFileSync(target, JSON.stringify(document), { mode: 0o640 });
  return structuredClone(document);
}
export function saveKnowledgeDocument(dir: string, input: Record<string, unknown>, operator: string, id?: string,
  options: { maxContentBytes?: number; expectedRevision?: string } = {}): KnowledgeDocument {
  return writePreparedKnowledgeDocument(dir, prepareKnowledgeDocument(dir, input, operator, id, options));
}
