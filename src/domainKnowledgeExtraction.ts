import { DomainArchiveProgressStore, copyDomainArchiveState, copyDomainPublication } from "./domainArchiveProgress.ts";
import { resolveBusinessModuleId, resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import { DomainKnowledgeStore } from "./domainKnowledgeStore.ts";
import { KnowledgeTaskCapacity } from "./knowledgeTaskCapacity.ts";
import { componentArchiveFiles, componentArchiveParts, componentArchivePath } from "./componentKnowledgeArchiveFormat.ts";
import { listFormalKnowledgeDocuments, listKnowledgeDocuments, readKnowledgeDocument, readKnowledgeDocumentFacts, readKnowledgeArchiveVersion, readKnowledgeArchiveVersionFacts, eraseKnowledgeDocument } from "./knowledgeDocuments.ts";
import { knowledgeDeleted, readKnowledgeDeletion, writeKnowledgeDeletion } from "./knowledgeDeletionStore.ts";
import { KnowledgeExtractionSkills } from "./knowledgeExtractionSkills.ts";
import { knowledgeArchiveDefaults } from "./knowledgeArchiveDefaults.ts";
import { assertModuleKnowledgePath, moduleKnowledgeDirectory, moduleKnowledgePaths, needsModuleKnowledgeLayout, directoryKnowledgeDirectory, directoryKnowledgePath, readableDomainKnowledgeDirectory, repositoryKnowledgeDirectory, hasOpaqueModuleDirectory } from "./domainKnowledgeLayout.ts";
import { freezeGitKnowledgeResources, readFrozenGitKnowledgeResource, readModuleKnowledgeSync } from "./knowledgeRepositorySnapshots.ts";
import { readKnowledgeRepoConfig } from "./knowledgeRepoConfig.ts";
import { resolveModuleKnowledgeLocation } from "./businessModuleKnowledge.ts";
import { readBusinessModule } from "./businessModuleLibrary.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { researchEvidencePage, researchEvidenceEntry } from "./knowledgeResearchEvidence.ts";
import { join, posix } from "node:path";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
import { readKnowledgeMaterial } from "./knowledgeMaterials.ts";
import { IncompleteDomainResearch, readSkillWorkDocuments, readSkillWorkDocumentSummaries, type SkillWorkResult } from "./domainSkillWork.ts";
import { domainKnowledgeTask } from "./knowledgeTaskCenter.ts";
import { readDomainReviewNoteBatch } from "./domainKnowledgeReviewNotes.ts";
import { currentKnowledgeArchiveBatches, projectKnowledgeProduction } from "./knowledgeProductionState.ts";
import type { KnowledgeArchivePreview, KnowledgeProductionAction } from "./knowledgeProductionTypes.ts";
import { continuingReviewProposal, assertLatestReviewProposal, assertReviewRevision, type ReviewProposal } from "./knowledgeReviewCore.ts";
import type { KnowledgeSourceCleanup } from "./knowledgeSourceCleanup.ts";
import { MR_PARTICIPANT_ROLES, normalizeMrParticipants } from "./mrParticipants.ts";

import type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainArchiveBatch, DomainKnowledgeJob, DomainExecution, DomainArchiveTargetsPreview } from "./domainKnowledgeTypes.ts";
export type { KnowledgeRepository, DomainDocumentContent, DomainDocument, DomainTurn, DomainPublication, DomainKnowledgeJob, DomainExecution } from "./domainKnowledgeTypes.ts";
export function knowledgeIssueNumber(value: unknown): string {
  const issue = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(issue)) throw new Error("请填写一个有效的关联单号（最多 120 位字母、数字、点、下划线或短横线）");
  return issue;
}

export function knowledgeIssueDescription(value: unknown, options: { required?: boolean } = {}): string | undefined {
  if (value === undefined && !options.required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("请填写关联单号对应的准确描述，将原样用作 MR 标题");
  const description = value.trim();
  if (description.length > 2000 || /[\x00-\x1f\x7f\u2028\u2029]/.test(description)) throw new Error("单号描述须为单行文本，最多 2000 字");
  return description;
}

export function knowledgeRelativePath(value: unknown, markdown = false): string {
  const path = String(value ?? "").trim().replace(/\/$/, "");
  if (!path || path.length > 1000 || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(p)) || (markdown && !path.endsWith(".md"))) throw new Error("请使用仓内文档相对路径，文档必须为 .md");
  return path;
}
function repository(input: any, id: string): KnowledgeRepository {
  const url = String(input?.repository ?? "").trim(), branch = String(input?.branch ?? "").trim();
  if (!/^https?:\/\//.test(url) || new URL(url).username || new URL(url).password) throw new Error("仓库地址须为不带凭据的 HTTP/HTTPS 地址");
  assertRepositoryCloneAddress(url);
  if (!branch || branch.length > 255 || branch.startsWith("-") || /[\s\\~^:?*\[\x00-\x1f]|\.\.|@\{|\/\/|\.$|\/$|\.lock(?:\/|$)/.test(branch)) throw new Error("请填写有效的目标分支");
  return { id, name: String(input.name ?? "").trim().slice(0, 100) || id, repository: url, branch,
    path: input.path ? knowledgeRelativePath(input.path) : "", docs_path: input.docs_path === "." ? "." : knowledgeRelativePath(input.docs_path || "docs/knowledge") };
}
function archiveRepositoryGroups(targets: KnowledgeRepository[]) {
  const groups: Array<{ target: KnowledgeRepository; ids: string[] }> = [];
  for (const target of targets) {
    const group = groups.find(group => group.target.repository === target.repository && group.target.branch === target.branch);
    if (group) group.ids.push(target.id); else groups.push({ target, ids: [target.id] });
  }
  return groups;
}
function archiveCollisionGroup(target: Pick<KnowledgeRepository, "id" | "repository" | "branch">) {
  return JSON.stringify([target.repository ? repositoryIdentity(target.repository) : target.id, target.branch]);
}
function overlappingKnowledgeDirectory(first: string, second: string) {
  first = first.toLowerCase(); second = second.toLowerCase();
  return first === second || first.startsWith(`${second}/`) || second.startsWith(`${first}/`);
}
const LEGACY_MODULE_ARCHIVE_MESSAGE = "此任务沿用旧归档目录。请先确认并发布本次文稿，平台会同时整理仓内相对路径和文稿链接，再新建归档；文稿、调查和历史版本保留，不重新研究。已有归档批次仍可按原版本重试。";
const MODULE_LAYOUT_PUBLICATION = "发布时整理旧模块目录";
const REPOSITORY_LAYOUT_MIGRATION = "整理仓内路径";
const CONFIRMED_ARCHIVE_DIRECTORY_CHANGE = "调整已确认知识的归档目录";
const ARCHIVE_PATH_OPERATORS = [MODULE_LAYOUT_PUBLICATION, REPOSITORY_LAYOUT_MIGRATION, CONFIRMED_ARCHIVE_DIRECTORY_CHANGE, "归档设置"];
type ArchiveDirectoryInput = { targets: unknown; documents?: unknown; base_revision?: number; use_module_layout?: boolean; use_repository_layout?: boolean; use_directory_layout?: boolean };

/** 改目录只重算 Markdown 链接目的地，不替换代码、来源文字或外部网址。 */
function relocateMarkdownLinks(content: string, oldPath: string, newPath: string, paths: Map<string, string>): string {
  const destination = (value: string) => {
    const bracketed = value.startsWith("<") && value.endsWith(">");
    const raw = bracketed ? value.slice(1, -1) : value;
    if (!raw || /^(?:[A-Za-z][A-Za-z\d+.-]*:|\/\/|#|\?)/.test(raw)) return value;
    const match = /^([^?#]*)([?#][\s\S]*)?$/.exec(raw)!;
    let decoded: string;
    try { decoded = decodeURIComponent(match[1].replace(/\\([\\()[\]<> ])/g, "$1")); } catch { return value; }
    const absolute = decoded.startsWith("/");
    const previous = posix.normalize(absolute ? decoded.slice(1) : posix.join(posix.dirname(oldPath), decoded));
    const next = paths.get(previous) ?? previous;
    if (oldPath === newPath && next === previous) return value;
    const relative = absolute ? `/${next}` : posix.relative(posix.dirname(newPath), next);
    if (!relative || relative === decoded) return value;
    const escaped = encodeURI(relative).replace(/[?#]/g, character => encodeURIComponent(character));
    const result = `${escaped}${match[2] ?? ""}`;
    return bracketed ? `<${result}>` : result.replace(/[()]/g, character => `\\${character}`);
  };
  let fence: { character: string; length: number } | undefined;
  return content.split(/(\r?\n)/).map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker?.[0] === fence.character && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      return line;
    }
    if (marker) { fence = { character: marker[0], length: marker.length }; return line; }
    if (/^(?: {4}|\t)/.test(line)) return line;
    // 行内代码中的链接示例保持原样；普通行内链接和引用式链接使用相同的路径解析。
    return line.split(/(`+[^`]*`+)/g).map((part, index) => index % 2 ? part : part
      .replace(/(\]\(\s*)(<[^>\r\n]+>|(?:\\.|[^\s()\\]|\([^()\s]*\))+)(?=[ \t)])/g, (_, prefix, value) => `${prefix}${destination(value)}`)
      .replace(/^( {0,3}\[[^\]\r\n]+\]:[ \t]*)(<[^>\r\n]+>|(?:\\.|[^\s\\])+)/, (_, prefix, value) => `${prefix}${destination(value)}`)
    ).join("");
  }).join("");
}

const STOP_BUDGET_MS = 60_000;
const STOP_TIMEOUT = "停止超时：执行体 60 秒内未退出，已强制释放";
const isRecord = (value: any): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function validMrUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value) return false;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
function validPublication(value: any): value is DomainPublication {
  const documents = (value: any) => Array.isArray(value) && value.every(document => isRecord(document)
    && ["id", "path", "content"].every(key => typeof document[key] === "string") && Number.isSafeInteger(document.revision) && document.revision > 0
    && ["knowledge_document_id", "knowledge_revision"].every(key => document[key] === undefined || typeof document[key] === "string")
    && (document.deleted === undefined || typeof document.deleted === "boolean"));
  const participants = (value: any) => {
    if (!isRecord(value) || !["applied", "failed", "skipped"].includes(value.status)
      || !isRecord(value.requested) || !MR_PARTICIPANT_ROLES.every(role => Array.isArray(value.requested[role]))
      || value.message !== undefined && typeof value.message !== "string") return false;
    try { normalizeMrParticipants(value.requested); return true; } catch { return false; }
  };
  return isRecord(value) && typeof value.target_id === "string" && typeof value.branch === "string" && ["pending", "opened", "failed"].includes(value.state)
    && documents(value.documents) && (value.attempted_documents === undefined || documents(value.attempted_documents))
    && (value.navigation_files === undefined || Array.isArray(value.navigation_files) && value.navigation_files.every((file: unknown) => isRecord(file)
      && typeof file.path === "string" && typeof file.content === "string"))
    && (value.url === undefined || validMrUrl(value.url)) && (value.state !== "opened" || validMrUrl(value.url))
    && (value.mr_attempted === undefined || typeof value.mr_attempted === "boolean")
    && (value.mr_state === undefined || ["opened", "closed", "merged"].includes(value.mr_state))
    && (value.checked_at === undefined || typeof value.checked_at === "string")
    && (value.mr_participants === undefined || participants(value.mr_participants))
    && ["revision", "error", "updated_at"].every(key => value[key] === undefined || typeof value[key] === "string")
    && (value.mr_id === undefined || typeof value.mr_id === "string" || typeof value.mr_id === "number" && Number.isFinite(value.mr_id));
}
function validStoredJob(value: any, id: string): value is DomainKnowledgeJob {
  const strings = (values: any) => Array.isArray(values) && values.every(value => typeof value === "string");
  const fields = (value: any, keys: string[]) => isRecord(value) && keys.every(key => typeof value[key] === "string");
  const revisionMap = (value: any) => isRecord(value) && Object.values(value).every(revision => typeof revision === "string");
  const nullableText = (value: any) => value === null || typeof value === "string";
  const content = (doc: any) => isRecord(doc) && ["id", "title", "target_id", "path", "content", "sources"].every(key => typeof doc[key] === "string") && ["domain", "repository"].includes(doc.layer);
  const document = (doc: any) => content(doc) && Number.isSafeInteger(doc.revision) && doc.revision > 0
    && typeof doc.selected === "boolean" && nullableText(doc.base_content) && typeof doc.base_revision === "string"
    && (doc.base_path === undefined || typeof doc.base_path === "string")
    && (doc.deleted === undefined || typeof doc.deleted === "boolean")
    && Array.isArray(doc.history) && doc.history.every((history: any) => fields(history, ["content", "sources", "title", "operator", "at"])
      && Number.isSafeInteger(history.revision) && history.revision > 0 && (history.path === undefined || typeof history.path === "string")
      && (history.deleted === undefined || typeof history.deleted === "boolean"));
  const target = (target: any) => isRecord(target) && ["id", "repository", "branch", "docs_path"].every(key => typeof target[key] === "string");
  const research = (research: any) => isRecord(research) && typeof research.inventory_complete === "boolean"
    && ["research", "review", "complete"].includes(research.phase) && Array.isArray(research.capabilities)
    && research.capabilities.every((capability: any) => fields(capability, ["id", "title", "findings"])
      && ["pending", "researched", "blocked"].includes(capability.state) && strings(capability.repository_ids) && strings(capability.document_ids)
      && Array.isArray(capability.sources) && capability.sources.every((source: any) => fields(source, ["repository_id", "path"])));
  return isRecord(value) && value.id === id && ["title", "scope", "operator", "created_at", "stage"].every(key => typeof value[key] === "string")
    && (value.key === undefined || typeof value.key === "string")
    && (value.task_kind === undefined || ["extraction", "inspection"].includes(value.task_kind))
    && (value.inspection_source === undefined || fields(value.inspection_source, ["document_id", "started_at"]))
    && (value.reextract_of === undefined || typeof value.reextract_of === "string")
    && (value.knowledge_layout === undefined || value.knowledge_layout === "directory-v1" || value.knowledge_layout === "repository-v1" || value.knowledge_layout === "module-v1" && typeof value.module_id === "string")
    && ["idle", "queued", "running", "paused", "done", "failed", "cancelled"].includes(value.status) && target(value.knowledge_target)
    && Array.isArray(value.repositories) && value.repositories.every(target) && strings(value.material_ids)
    && revisionMap(value.revisions) && Array.isArray(value.evidence) && value.evidence.every(isRecord)
    && (value.source_repositories === undefined || Array.isArray(value.source_repositories) && value.source_repositories.every(target))
    && (value.source_cleanup === undefined || isRecord(value.source_cleanup)
      && (value.source_cleanup.started === undefined || typeof value.source_cleanup.started === "boolean")
      && Array.isArray(value.source_cleanup.repositories) && value.source_cleanup.repositories.every(target)
      && Array.isArray(value.source_cleanup.plans) && Array.isArray(value.source_cleanup.publications)
      && (value.source_cleanup.started === true || value.source_cleanup.plans.every((plan: any) => fields(plan, ["id", "target_id", "target_revision"])
        && strings(plan.paths) && Array.isArray(plan.entries) && plan.entries.every((entry: any) => fields(entry, ["path", "mode", "oid"]))
        && (plan.selected_paths === undefined || strings(plan.selected_paths) && plan.selected_paths.every((path: string) => plan.entries.some((entry: any) => entry.path === path))))
        && value.source_cleanup.publications.every((publication: any) => typeof publication.cleanup_plan_id === "string"
          && strings(publication.removed_paths) && validPublication(publication))))
    && (value.technologies === undefined || strings(value.technologies))
    && Array.isArray(value.documents) && value.documents.every((doc: any) => document(doc)
      && [value.knowledge_target, ...value.repositories].some(target => target.id === doc.target_id))
    && Array.isArray(value.turns) && value.turns.every((turn: any) => isRecord(turn)
      && fields(turn, ["id", "message", "operator", "created_at"]) && ["extract", "discuss", "revise", "update"].includes(turn.mode) && strings(turn.document_ids)
      && ["queued", "running", "paused", "done", "failed", "cancelled"].includes(turn.status) && Array.isArray(turn.proposals)
      && (turn.review_note_ids === undefined || turn.mode === "revise" && strings(turn.review_note_ids))
      && (turn.waiting === undefined || fields(turn.waiting, ["id", "summary"]) && strings(turn.waiting.document_ids) && strings(turn.waiting.work_document_ids))
      && (turn.status !== "paused" || !!turn.waiting)
      && (turn.human_replies === undefined || Array.isArray(turn.human_replies) && turn.human_replies.every((reply: any) => fields(reply, ["request_id", "message", "operator", "at"])))
      && (turn.research === undefined || research(turn.research))
      && (turn.revisions === undefined || revisionMap(turn.revisions)) && (turn.previous_revisions === undefined || revisionMap(turn.previous_revisions))
      && turn.proposals.every((proposal: any) => isRecord(proposal) && content(proposal.document) && Number.isSafeInteger(proposal.base_revision)
        && ["pending", "accepted", "discarded"].includes(proposal.status)))
    && (!["queued", "running"].includes(value.status) || value.turns.some((turn: any) => ["queued", "running"].includes(turn.status)))
    && (value.status !== "paused" || value.turns.at(-1)?.status === "paused")
    && Array.isArray(value.publications) && value.publications.every(validPublication)
    && (value.publication_history === undefined || Array.isArray(value.publication_history) && value.publication_history.every(validPublication))
    && (value.archive_batches === undefined || Array.isArray(value.archive_batches) && value.archive_batches.every((batch: any) => isRecord(batch)
      && fields(batch, ["id", "created_at", "operator"]) && ["pending", "running", "done", "failed", "superseded"].includes(batch.state)
      && (batch.knowledge_layout === undefined || ["module-v1", "repository-v1", "directory-v1"].includes(batch.knowledge_layout))
      && (batch.issue_no === undefined || typeof batch.issue_no === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(batch.issue_no))
      && (batch.issue_description === undefined || typeof batch.issue_description === "string" && !!batch.issue_description.trim()
        && batch.issue_description.length <= 2000 && !/[\x00-\x1f\x7f\u2028\u2029]/.test(batch.issue_description))
      && Array.isArray(batch.documents) && batch.documents.every(document) && Array.isArray(batch.targets) && batch.targets.every(target)
      && batch.documents.every((doc: any) => batch.targets.some((target: any) => target.id === doc.target_id))
      && Array.isArray(batch.publications) && batch.publications.every(validPublication)
      && (batch.replacements === undefined || Array.isArray(batch.replacements) && batch.replacements.every((replacement: any) => isRecord(replacement)
        && target(replacement.target) && validPublication(replacement.publication) && ["pending", "closed", "merged", "failed"].includes(replacement.state)
        && ["batch_id", "error", "closed_at", "merged_at"].every(key => replacement[key] === undefined || typeof replacement[key] === "string")))));
}

interface DomainRunning {
  controller: AbortController;
  work: Promise<void>;
  released: Promise<void>;
  release: () => void;
  turn: DomainTurn;
  stopTimer?: ReturnType<typeof setTimeout>;
}

export class DomainKnowledgeExtraction {
  private jobs = new Map<string, DomainKnowledgeJob>();
  private running = new Map<string, DomainRunning>();
  private readWarnings: string[] = [];
  private store = new DomainKnowledgeStore(message => this.readWarnings.push(message));
  private publishing = new Map<string, symbol>();
  private archiving = new Map<string, Promise<void>>();
  private stopped = false;
  private publicationRefreshCursor = 0;
  private publicationRefreshes = new Map<string, Promise<DomainKnowledgeJob>>();
  private capacity: KnowledgeTaskCapacity;
  constructor(readonly dataDir: string, private execute: (input: DomainExecution) => Promise<string | SkillWorkResult>, private options: {
    publish?: (job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string, save: (publication: DomainPublication) => void, signal?: AbortSignal) => Promise<DomainPublication>;
    closePublication?: (job: DomainKnowledgeJob, target: KnowledgeRepository, publication: DomainPublication, operator: string) => Promise<void | "closed" | "merged">;
    refreshPublication?: (target: KnowledgeRepository, publication: DomainPublication, operator: string) => Promise<DomainPublication>;
    onIndexed?: () => void;
    shutdown?: () => Promise<void>;
    sourceCleanup?: KnowledgeSourceCleanup;
    capacity?: KnowledgeTaskCapacity;
  } = {}) {
    this.capacity = options.capacity ?? new KnowledgeTaskCapacity();
    this.capacity.register(() => this.running.size, () => this.pump());
    const root = join(dataDir, "domain-extraction");
    if (existsSync(root)) for (const name of readdirSync(root).filter(n => /^dkx-[a-f0-9-]{36}$/.test(n))) {
      const path = join(root, name, "job.json");
      if (!existsSync(path)) continue;
      try {
        const job: unknown = this.store.read(path);
        if (!validStoredJob(job, name)) throw new Error("记录形状无效");
        let changed = false;
        for (const batch of job.archive_batches ?? []) {
          if (batch.state === "running" || batch.state === "pending" && !!batch.issue_no) {
            batch.state = "failed"; batch.error = "服务重启中断了人工归档，请手动重试";
            for (const publication of batch.publications) if (publication.state === "pending") {
              publication.state = "failed"; publication.error = batch.error;
              const current = job.publications.find(current => current.target_id === publication.target_id && current.branch === publication.branch);
              if (current) { current.state = "failed"; current.error = batch.error; }
            }
            changed = true;
          }
          if (batch.state !== "pending" || batch.issue_no || batch.publications.length) continue;
          // 仅恢复已真正落入正式库的发布，不触发 Git；未写成篇不能成为已发布知识。
          batch.documents = batch.documents.filter(document => {
            if (!document.knowledge_document_id || !document.published_revision) return false;
            let formal;
            try { formal = document.deleted ? readKnowledgeArchiveVersion(this.dataDir, document.knowledge_document_id, document.published_revision).document : readKnowledgeDocument(this.dataDir, document.knowledge_document_id); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!(error instanceof Error) || error.message !== "知识已删除")) this.readWarnings.push(`请检查损坏的知识记录：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`);
              return false;
            }
            if (formal.revision !== document.published_revision) return false;
            if (document.deleted) this.erasePublishedDocument(formal, batch.operator);
            const draft = job.documents.find(draft => draft.id === document.id);
            if (draft && (!document.deleted || draft.deleted && draft.revision === document.published_document_revision)
                && (draft.knowledge_document_id !== formal.id || draft.published_revision !== formal.revision)) {
              Object.assign(draft, { knowledge_document_id: formal.id, published_revision: formal.revision,
                published_document_revision: document.published_document_revision, published_at: document.published_at });
              this.indexPublished(job.id); changed = true;
            }
            return true;
          });
          changed = true;
        }
        if (job.archive_batches) job.archive_batches = job.archive_batches.filter(batch => batch.state !== "pending" || !!batch.issue_no || !!batch.publications.length || !!batch.documents.length);
        if (!job.deleted_at && ["queued", "running"].includes(job.status)) {
          job.status = "queued"; job.stage = "接续原研究会话"; changed = true;
          for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) { turn.status = "queued"; turn.error = undefined; }
        }
        if (changed) this.persist(job);
        this.jobs.set(job.id, job);
      } catch {
        // repros/r8 实测：单条坏文件不能阻断其他记录，不删除或重写现场。
        this.readWarnings.push(`请检查损坏的知识记录：domain-extraction/${name}/job.json；其余任务照常可用`);
      }
    }
    queueMicrotask(() => this.pump());
  }
  private root(id: string) { return join(this.dataDir, "domain-extraction", id); }
  private live(id: string) { const job = this.jobs.get(id); if (!job || job.deleted_at) throw new Error("领域萃取任务不存在或已删除"); return job; }
  private assertModuleDirectories(job: DomainKnowledgeJob) {
    if (job.knowledge_layout !== "module-v1") return;
    for (const target of [job.knowledge_target, ...job.repositories].filter(target => target.repository)) {
      for (const other of this.jobs.values()) {
        if (other.id === job.id || resolveBusinessModuleId(this.dataDir, other.module_id ?? "") === resolveBusinessModuleId(this.dataDir, job.module_id ?? "") || other.knowledge_layout !== "module-v1") continue;
        const occupied = [other.knowledge_target, ...other.repositories].find(candidate => candidate.repository
          && repositoryIdentity(candidate.repository) === repositoryIdentity(target.repository) && candidate.branch === target.branch
          && overlappingKnowledgeDirectory(candidate.docs_path, target.docs_path));
        if (occupied) throw new Error(`归档目录 ${target.docs_path} 与业务模块 ${other.module_id} 的目录 ${occupied.docs_path} 重叠，请使用独立目录`);
      }
    }
  }
  private acquirePublication(id: string) {
    if (this.stopped) throw new Error("服务正在停止");
    if (this.publishing.has(id)) throw new Error("正在发布或归档，请等待当前操作完成");
    const owner = Symbol(id);
    this.publishing.set(id, owner);
    return owner;
  }
  private releasePublication(id: string, owner: symbol) {
    if (this.publishing.get(id) !== owner) return false;
    this.publishing.delete(id);
    return true;
  }
  private assertPublicationOwner(id: string, owner: symbol) {
    if (this.stopped || this.publishing.get(id) !== owner) throw new Error("服务已停止，迟到结果未保存");
  }
  private persist(job: DomainKnowledgeJob) {
    mkdirSync(this.root(job.id), { recursive: true });
    const path = join(this.root(job.id), "job.json");
    this.store.save(path, job);
    const live = this.jobs.get(job.id);
    if (live) live.archive_progress_revision = job.archive_progress_revision;
  }
  private indexPublished(id: string) {
    try { this.options.onIndexed?.(); }
    catch (error) { this.readWarnings.push(`知识已发布，索引更新失败：domain-extraction/${id}/job.json；${error instanceof Error ? error.message : String(error)}`); }
  }
  private erasePublishedDocument(document: ReturnType<typeof readKnowledgeDocument>, operator: string) {
    const previous = readKnowledgeDeletion(this.dataDir, document.id);
    if (previous && previous.revision !== document.revision) throw new Error("删除版本已变化，请刷新后重新确认");
    if (!previous) writeKnowledgeDeletion(this.dataDir, { id: document.id, title: document.title, revision: document.revision,
      at: new Date().toISOString(), operator, research_job_id: document.research_source?.job_id,
      index_ids: [document.id], index_state: "pending" });
    eraseKnowledgeDocument(this.dataDir, document.id);
  }
  warnings() { return [...this.readWarnings]; }
  private confirmedDocumentDeletion(document: DomainDocument) {
    return !!document.deleted && document.published_document_revision === document.revision
      && !!document.knowledge_document_id && knowledgeDeleted(this.dataDir, document.knowledge_document_id);
  }
  private legacyModuleDeletion(job: DomainKnowledgeJob, document: DomainDocument, formal: ReturnType<typeof readKnowledgeDocument>) {
    if (!job.knowledge_layout || !this.confirmedDocumentDeletion(document)) return false;
    if (job.module_id && (formal.scope !== "module" || !resolveBusinessModuleIds(this.dataDir, formal.module_ids).includes(resolveBusinessModuleId(this.dataDir, job.module_id)))) return true;
    const target = [job.knowledge_target, ...job.repositories].find(target => target.id === document.target_id)!;
    if (job.knowledge_layout === "directory-v1") {
      const location = formal.archive_target ?? formal.research_source;
      return !location || location.path !== (document.archive_path ?? document.path)
        || repositoryIdentity(location.repository) !== repositoryIdentity(target.repository) || location.branch !== target.branch;
    }
    try { assertModuleKnowledgePath(job, target, document.archive_path ?? document.path); return false; }
    catch { return true; }
  }
  private pendingModuleLayoutPublication(job: DomainKnowledgeJob, document: DomainDocument, formal: ReturnType<typeof readKnowledgeDocument>) {
    if (!job.knowledge_layout || !document.history.some(history => [MODULE_LAYOUT_PUBLICATION, REPOSITORY_LAYOUT_MIGRATION].includes(history.operator)
      && history.revision >= (document.published_document_revision ?? 0))) return false;
    return (formal.archive_target?.path ?? formal.research_source?.path) !== (document.archive_path ?? document.path)
      || !!job.module_id && (formal.scope !== "module" || !resolveBusinessModuleIds(this.dataDir, formal.module_ids).includes(resolveBusinessModuleId(this.dataDir, job.module_id))) || formal.content !== document.content.replace(/\r\n/g, "\n");
  }
  private currentFormalRevisions(job: DomainKnowledgeJob) {
    const current: Record<string, string> = {};
    for (const document of job.documents) {
      if (!document.knowledge_document_id) continue;
      try {
        if (job.knowledge_layout && !this.confirmedDocumentDeletion(document)
          && document.history.some(history => [MODULE_LAYOUT_PUBLICATION, REPOSITORY_LAYOUT_MIGRATION].includes(history.operator) && history.revision >= (document.published_document_revision ?? 0))) {
          const formal = readKnowledgeDocument(this.dataDir, document.knowledge_document_id);
          if (this.canArchiveWithLayoutMigration(job) || !this.pendingModuleLayoutPublication(job, document, formal)) current[formal.id] = formal.revision;
          continue;
        }
        // 只有模块迁移涉及的删除记录需要旧范围信息；正常列表仍使用轻量版本摘要。
        if (job.knowledge_layout && this.confirmedDocumentDeletion(document) && document.published_revision) {
          const formal = readKnowledgeArchiveVersion(this.dataDir, document.knowledge_document_id, document.published_revision).document;
          if (!this.legacyModuleDeletion(job, document, formal)) current[formal.id] = formal.revision;
          continue;
        }
        const formal = document.deleted && document.published_revision
          ? readKnowledgeArchiveVersionFacts(this.dataDir, document.knowledge_document_id, document.published_revision)
          : readKnowledgeDocumentFacts(this.dataDir, document.knowledge_document_id);
        if (job.component_research_id && "component_archive_valid" in formal && formal.component_archive_valid === false) {
          const warning = `请检查损坏的组件知识结构：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
          if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
          continue;
        }
        current[formal.id] = formal.revision;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "知识已删除") continue;
        const warning = `请检查损坏的知识记录：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
      }
    }
    return current;
  }
  private view(job: DomainKnowledgeJob, summaryOnly = false): DomainKnowledgeJob {
    const readWork = summaryOnly ? readSkillWorkDocumentSummaries : readSkillWorkDocuments;
    const work_documents = job.turns.flatMap(turn => {
      if (!/^[a-f0-9-]{36}$/.test(turn.id)) return [];
      try { return readWork(join(this.root(job.id), "skill-runs", turn.id, "work.json")).map(document => ({ ...document, turn_id: turn.id })); }
      catch (error) {
        const warning = `过程文稿读取失败：${job.id}/${turn.id}；${error instanceof Error ? error.message : String(error)}`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        return [];
      }
    });
    const current_revisions = !job.component_research_id ? undefined : summaryOnly ? this.currentFormalRevisions(job)
      : Object.fromEntries(this.formalArchiveDocuments(job).map(document => [document.knowledge_document_id!, document.published_revision!]));
    const record = { ...job, ...(job.module_id ? { module_id: resolveBusinessModuleId(this.dataDir, job.module_id), module_name: this.moduleDirectoryName(job) } : {}), work_documents };
    return { ...record, production: projectKnowledgeProduction({ kind: "domain", record, current_revisions }), deletion: this.deletionView(job.id) };
  }
  get(id: string): DomainKnowledgeJob { return structuredClone(this.view(this.live(id))); }
  reader(id: string): DomainKnowledgeJob {
    const { documents, evidence, publications, publication_history, archive_batches, ...current } = this.view(this.live(id), true);
    return structuredClone({ ...current, deferred_details: true, evidence: [], publications: [],
      documents: documents.map(({ history, base_content, ...document }) => ({ ...document, history: [], base_content: null })),
    });
  }
  evidencePage(id: string, before?: string) { return researchEvidencePage(this.live(id).evidence, before); }
  evidenceEntry(id: string, index: string) { return researchEvidenceEntry(this.live(id).evidence, index); }
  documentHistory(id: string, documentId: string) {
    const document = this.live(id).documents.find(document => document.id === documentId);
    if (!document) throw new Error("知识文稿不存在");
    return structuredClone(document.history);
  }
  workDocument(id: string, turnId: string, documentId: string) {
    if (!this.live(id).turns.some(turn => turn.id === turnId) || !/^[a-f0-9-]{36}$/.test(turnId)) throw new Error("研究轮次不存在");
    const document = readSkillWorkDocuments(join(this.root(id), "skill-runs", turnId, "work.json")).find(document => document.id === documentId);
    if (!document) throw new Error("过程文稿不存在");
    return { ...document, turn_id: turnId };
  }
  taskRows() {
    return [...this.jobs.values()].filter(job => !job.component_research_id && !job.deleted_at).map(job => ({
      ...domainKnowledgeTask(this.view(job, true)),
    }));
  }
  list() {
    return [...this.jobs.values()].filter(job => !job.component_research_id && !job.deleted_at)
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).map(job => {
        // 列表只读元数据，先排除全文和历史，再复制；不能先加载整份详情再丢弃。
        const { documents, turns, evidence, publications, publication_history, archive_batches, work_documents, ...metadata } = job;
        const current_revisions = job.component_research_id ? this.currentFormalRevisions(job) : undefined;
        return structuredClone({ ...metadata, ...(job.module_id ? { module_id: resolveBusinessModuleId(this.dataDir, job.module_id), module_name: this.moduleDirectoryName(job) } : {}), documents: documents.map(({ content, history, base_content, ...document }) => document),
          work_documents: [], evidence: [], turns: [], publications: [], publication_history: [],
          production: projectKnowledgeProduction({ kind: "domain", record: job, current_revisions }), deletion: this.deletionView(job.id) });
      });
  }
  componentArchive(researchId: string, summaryOnly = false) {
    const job = [...this.jobs.values()].find(job => !job.deleted_at && job.component_research_id === researchId);
    // 摘要只供状态投影读取，不复制文稿全文；用户详情仍返回独立副本。
    return job ? summaryOnly ? this.view(job, true) : this.get(job.id) : undefined;
  }
  private formalArchiveDocuments(job: DomainKnowledgeJob, strict = false): DomainDocument[] {
    return (job.component_research_id ? job.documents.slice(0, 1) : job.documents).flatMap(document => {
      if (!document.knowledge_document_id) return [];
      let formal;
      try { formal = document.deleted && document.published_revision
        ? readKnowledgeArchiveVersion(this.dataDir, document.knowledge_document_id, document.published_revision).document
        : readKnowledgeDocument(this.dataDir, document.knowledge_document_id); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "知识已删除") return [];
        const warning = `请检查损坏的知识记录：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        if (strict) throw new Error(warning);
        return [];
      }
      if (this.legacyModuleDeletion(job, document, formal)) return [];
      const confirmedPathChange = this.canArchiveWithLayoutMigration(job) && document.published_document_revision !== document.revision;
      if (!confirmedPathChange && this.pendingModuleLayoutPublication(job, document, formal)) return [];
      if (strict && job.knowledge_layout && !job.component_research_id && !confirmedPathChange) {
        const formalPath = formal.archive_target?.path ?? formal.research_source?.path;
        const changedLayout = document.history.some(history => ["归档设置", MODULE_LAYOUT_PUBLICATION, REPOSITORY_LAYOUT_MIGRATION].includes(history.operator) && history.revision >= (document.published_document_revision ?? 0));
        if (formalPath !== (document.archive_path ?? document.path) || !!job.module_id && !resolveBusinessModuleIds(this.dataDir, formal.module_ids).includes(resolveBusinessModuleId(this.dataDir, job.module_id))
            || changedLayout && document.content.replace(/\r\n/g, "\n") !== formal.content) {
          throw new Error("模块目录或文稿链接已调整，请先发布这次修改，再创建 Git 归档；已完成的研究和旧正式知识均保留");
        }
      }
      let parts;
      try { parts = { content: confirmedPathChange ? document.content : job.component_research_id ? componentArchiveParts(formal.content).content : formal.content }; }
      catch {
        const warning = `请检查损坏的组件知识结构：knowledge-documents/${document.knowledge_document_id}.json；其余任务照常可用`;
        if (!this.readWarnings.includes(warning)) this.readWarnings.push(warning);
        if (strict) throw new Error(warning);
        return [];
      }
      const outgoing = { ...structuredClone({ ...document, ...parts, history: [] }), title: confirmedPathChange ? document.title : formal.title, selected: true,
        knowledge_document_id: formal.id, published_revision: formal.revision,
        published_document_revision: document.revision, published_at: formal.history.at(-1)?.at };
      const guidePath = (document.archive_path ?? document.path).replace(/\/README\.md$/, ".md");
      return job.component_research_id ? componentArchiveFiles(formal.content, guidePath, document.id)
        .map(file => ({ ...outgoing, ...file, ...(file.path === (document.archive_path ?? document.path) ? { title: formal.title } : {}), archive_path: file.path })) : [outgoing];
    });
  }
  previewComponentArchive(input: { research_id: string; knowledge_document_id: string; knowledge_revision?: string }, operator: string): KnowledgeArchivePreview {
    if (this.stopped) throw new Error("服务正在停止");
    const formal = readKnowledgeDocument(this.dataDir, input.knowledge_document_id);
    if (input.knowledge_revision !== undefined && input.knowledge_revision !== formal.revision) throw new Error("正式知识已有新版本，请刷新归档预览");
    let job = [...this.jobs.values()].find(job => !job.deleted_at && job.component_research_id === input.research_id);
    if (job && job.documents[0]?.knowledge_document_id !== formal.id) throw new Error("正式知识绑定已变化，请刷新归档预览");
    if (!job) {
      const configured = readKnowledgeRepoConfig(this.dataDir);
      const target: KnowledgeRepository = { id: "domain", name: "组件知识仓", repository: configured?.url ?? "", branch: configured?.branch ?? "master", path: "", docs_path: configured?.docs_path ?? "docs/knowledge/components" };
      const { content } = componentArchiveParts(formal.content);
      const path = componentArchivePath(target.docs_path, formal);
      job = { id: `dkx-${randomUUID()}`, title: formal.title, scope: "正式组件知识手动归档", operator, created_at: new Date().toISOString(),
        component_research_id: input.research_id, technologies: formal.technologies, repositories: [], knowledge_target: target,
        archive_configured: !!target.repository, knowledge_layout: "directory-v1", material_ids: [], status: "done", stage: "已发布", revisions: {},
        documents: [{ id: "component-guide", title: formal.title, target_id: "domain", path, layer: "domain", content, sources: formal.research_source?.path || "正式知识库",
          revision: 1, selected: true, base_content: null, base_revision: "", history: [], knowledge_document_id: formal.id, published_revision: formal.revision, published_document_revision: 1 }],
        turns: [], evidence: [], publications: [], archive_batches: [] };
      this.persist(job); this.jobs.set(job.id, job);
    } else if (!job.knowledge_target.repository) {
      // 后续全局设置可为占位归档任务提供位置；已有人工批次仍保留自己的固定目标。
      const configured = readKnowledgeRepoConfig(this.dataDir);
      if (configured) {
        const candidate = structuredClone(job), docs_path = configured.docs_path ?? job.knowledge_target.docs_path;
        candidate.knowledge_target = { ...job.knowledge_target, repository: configured.url, branch: configured.branch ?? "master", docs_path };
        candidate.documents[0].path = componentArchivePath(docs_path, formal); candidate.archive_configured = true;
        this.persist(candidate); Object.assign(job, candidate);
      }
    } else if (!job.documents[0].archive_path && job.documents[0].published_revision !== formal.revision && !job.archive_batches?.some(batch => batch.state === "running")) {
      // 标题改名必然产生新正式版本，文件名跟着走；同一版本不动路径，失败批次的重试仍对得上原路径。已开的 MR 保留各自当时的路径。
      const path = componentArchivePath(job.knowledge_target.docs_path, formal);
      if (job.documents[0].path !== path || job.documents[0].title !== formal.title) {
        const candidate = structuredClone(job); candidate.documents[0].path = path; candidate.documents[0].title = formal.title;
        this.persist(candidate); Object.assign(job, candidate);
      }
    }
    if (!job.archive_batches?.some(batch => batch.state === "running")) {
      const candidate = structuredClone(job), source = candidate.documents[0];
      const path = source.archive_path?.replace(/\/README\.md$/, ".md") ?? componentArchivePath(candidate.knowledge_target.docs_path, formal);
      candidate.documents = componentArchiveFiles(formal.content, path, source.id).map(file => ({ ...source, ...file, archive_path: undefined,
        ...(file.path === path ? { title: formal.title } : {}), knowledge_document_id: formal.id, published_revision: formal.revision }));
      if (JSON.stringify(candidate.documents) !== JSON.stringify(job.documents)) { this.persist(candidate); Object.assign(job, candidate); }
    }
    return this.previewArchive(job.id);
  }
  private moduleDirectoryName(job: Pick<DomainKnowledgeJob, "module_id" | "title">) {
    if (job.module_id) try { return readBusinessModule(this.dataDir, job.module_id).name; } catch { /* 旧模块已移除时保留任务名称。 */ }
    return job.title;
  }
  private hasConfirmedArchiveLayoutChanges(job: DomainKnowledgeJob) {
    return job.documents.some(document => !this.confirmedDocumentDeletion(document) && document.published_document_revision !== document.revision
      && document.history.some(history => ARCHIVE_PATH_OPERATORS.includes(history.operator) && history.revision >= (document.published_document_revision ?? 0)));
  }
  private canArchiveWithLayoutMigration(job: DomainKnowledgeJob) {
    return !["queued", "running"].includes(job.status) && job.documents.some(document => !this.confirmedDocumentDeletion(document))
      && job.documents.every(document => this.confirmedDocumentDeletion(document) || !!document.knowledge_document_id && !!document.published_revision && (
        document.published_document_revision === document.revision || document.published_document_revision !== undefined
        && document.history.filter(history => history.revision >= document.published_document_revision!).length === document.revision - document.published_document_revision
        && document.history.filter(history => history.revision >= document.published_document_revision!).every(history => ARCHIVE_PATH_OPERATORS.includes(history.operator))))
      && !job.turns.some(turn => turn.proposals.some(proposal => proposal.status === "pending"));
  }
  private candidateJob(job: DomainKnowledgeJob): DomainKnowledgeJob {
    const candidate = structuredClone(job);
    for (const document of candidate.documents) {
      if (!document.selected) continue;
      const pending = candidate.turns.flatMap(turn => turn.proposals.map(proposal => ({ turn, proposal })))
        .filter(item => item.proposal.document.id === document.id && item.proposal.status === "pending");
      const latest = pending.at(-1);
      if (!latest) continue;
      if (latest.turn.status !== "done" || latest.proposal.base_revision !== document.revision) throw new Error("修订尚未完成或正文已变化，请先处理修改差异");
      document.history.push({ revision: document.revision, title: document.title, path: document.path, content: document.content,
        sources: document.sources, deleted: document.deleted, operator: "检视意见修订", at: latest.turn.finished_at ?? latest.turn.created_at });
      if (document.path !== latest.proposal.document.path) document.base_path ??= document.path;
      Object.assign(document, latest.proposal.document, { revision: document.revision + 1, deleted: false });
      if (document.archive_path) document.archive_path = document.path;
      for (const item of pending) item.proposal.status = item === latest ? "accepted" : "discarded";
    }
    return candidate;
  }
  private candidateDocuments(job: DomainKnowledgeJob) {
    return job.documents.filter(document => document.selected && (!document.deleted || document.base_content !== null
      || [...job.publications, ...job.publication_history ?? []].some(publication => publication.documents.some(old => old.id === document.id))));
  }
  private matchingManualBatch(job: DomainKnowledgeJob, documents: DomainDocument[]) {
    if (!job.component_research_id) return (job.archive_batches ?? []).filter(batch => !!batch.issue_no && batch.state !== "superseded"
      && batch.documents.length === documents.length && documents.every(document => batch.documents.some(old => old.id === document.id
        && old.revision === document.revision && old.content === document.content && !!old.deleted === !!document.deleted
        && (old.archive_path ?? old.path) === (document.archive_path ?? document.path)))
      && batch.targets.every(target => [job.knowledge_target, ...job.repositories].some(current => current.id === target.id
        && current.repository === target.repository && current.branch === target.branch && current.docs_path === target.docs_path))).at(-1);
    return currentKnowledgeArchiveBatches(job, Object.fromEntries(documents.map(document => [document.knowledge_document_id!, document.published_revision!])), documents).at(-1);
  }
  previewArchive(id: string): KnowledgeArchivePreview {
    const original = this.live(id), job = original.component_research_id ? original : this.candidateJob(original);
    const documents = job.component_research_id ? this.formalArchiveDocuments(job, true) : this.candidateDocuments(job);
    return this.archivePreview(job, documents);
  }
  private archivePreview(job: DomainKnowledgeJob, documents: DomainDocument[]): KnowledgeArchivePreview {
    const id = job.id;
    const batch = this.matchingManualBatch(job, documents);
    const needsModuleLayout = !!job.component_research_id && (needsModuleKnowledgeLayout(job) || this.hasConfirmedArchiveLayoutChanges(job)), autoLayout = needsModuleLayout && this.canArchiveWithLayoutMigration(job);
    const action = (value: KnowledgeProductionAction) => ({ ...value, href: value.id === "configure" ? undefined
      : `?kbPage=task&kbKind=${job.component_research_id ? "component" : "domain"}&kbTask=${encodeURIComponent(job.component_research_id ?? id)}${value.view === "review" ? "&kbReview=1" : "&kbStage=publish"}` });
    const groups = archiveRepositoryGroups([job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id)));
    // 「Git 归档设置」只出现一次：单仓放在弹窗底部动作里，多仓才放到各个未配置的仓旁边。
    const perTarget = groups.length > 1;
    const targets = groups.map(({ target, ids }) => {
      const publication = batch?.publications.find(publication => ids.includes(publication.target_id));
      // 知识仓配置收本地路径（拉仓可用），建 MR 却只收 HTTP/HTTPS；预览不先用同一把尺量，
      // 人要点了「创建归档 MR」才看到报错（2026-10-08 走查实测）。量不过就按未配置处理并说出原因。
      const problem = target.repository.trim() ? (() => { try { repository(target, target.id); return ""; } catch (error) { return (error as Error).message; } })() : "";
      const configured = !!target.repository.trim() && !problem;
      const status_label = batch?.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state) && ids.includes(item.publication.target_id)) && batch.state === "failed" ? "归档失败" : publication?.state === "opened" ? "已归档" : publication?.state === "failed" || batch?.state === "failed" ? "归档失败" : batch?.state === "running" ? "归档中" : "已发布（未归档）";
      const actions: KnowledgeProductionAction[] = !configured ? perTarget && (!needsModuleLayout || autoLayout) ? [action({ id: "configure", label: "Git 归档设置", view: "archive", target_id: target.id })] : []
        : status_label === "归档失败" ? [action({ id: "retry-archive", label: "重试此仓归档", view: "archive", target_id: target.id, batch_id: batch!.id })] : [];
      return { id: target.id, name: target.name, repository: target.repository, branch: target.branch, docs_path: target.docs_path, configured, status_label,
        // 失败原因只放 error（红字）一处；message 说出路。两处都放原因，弹窗里同一句话会叠着出现。
        message: problem ? `归档仓设置不能用于创建 MR：${problem}。请在 Git 归档设置中修改。` : !configured ? "未配置 Git 归档仓，请联系管理员在知识仓设置中配置。" : status_label === "归档失败" ? "此仓归档失败，原因见下方；处理后重试此仓，重试复用同一分支。"
          : status_label === "已归档" ? "MR 已创建，后续合入由人处理。" : "",
        error: publication?.error || (status_label === "归档失败" ? batch?.error : undefined), url: publication?.url, mr_participants: publication?.mr_participants, actions,
        files: documents.filter(document => ids.includes(document.target_id)).flatMap(document => {
          const file = { id: document.id, title: document.title, path: document.archive_path ?? document.path, content: document.content,
            knowledge_document_id: document.knowledge_document_id ?? document.id, knowledge_revision: job.component_research_id ? document.published_revision! : String(document.revision) };
          return [file];
        }) };
    });
    const status_label = targets.some(target => target.status_label === "归档失败") || batch?.state === "failed" ? "归档失败"
      : batch?.state === "running" ? "归档中" : targets.length && targets.every(target => target.status_label === "已归档") ? "已归档" : "已发布（未归档）";
    const actions: KnowledgeProductionAction[] = needsModuleLayout && !autoLayout && !batch ? [] : status_label === "归档失败" ? [action({ id: "retry-archive", label: "重试失败归档", view: "archive", batch_id: batch!.id })]
      : status_label === "已发布（未归档）" && targets.length && targets.every(target => target.configured) ? [action({ id: "create-archive", label: job.component_research_id ? "创建归档 MR" : "创建 MR", view: "archive" })]
        : perTarget || targets.every(target => target.configured) ? [] : [action({ id: "configure", label: "Git 归档设置", view: "archive" })];
    if (job.component_research_id && batch?.state === "done" && batch.publications.some(publication => publication.state === "opened") && !this.publishing.has(id)) {
      actions.push(action(autoLayout ? { id: "create-archive", label: "整理路径并重新归档", view: "archive" }
        : { id: "replace-archive", label: "重新创建并撤销旧 MR", view: "archive" }));
    }
    if (needsModuleLayout && !autoLayout) {
      actions.push(action({ id: "review", label: "去确认并发布", view: "review" }));
    }
    const statusMessage = status_label === "归档失败" ? (batch?.error ?? (targets.length ? "有仓归档失败，原因见对应仓；只需重试失败的仓。" : "归档失败，请重试。")) : status_label === "已归档" ? "MR 已创建，后续合入由人处理。" : job.component_research_id ? "只导出已发布的正式知识；填写关联单号后手动创建 MR，创建后归档结束。" : "只归档已发布的正式知识；使用任务已有单号直接创建 MR，缺少必要信息时请补充。";
    const layoutMessage = autoLayout ? "归档时自动整理已确认成果的目录和链接，保留文稿编号、历史与研究记录；未确认正文或建议须先确认并发布。领域入口写入所选领域目录，代码仓文稿集中在 docs 下的业务目录。" : needsModuleLayout ? LEGACY_MODULE_ARCHIVE_MESSAGE : job.knowledge_layout
      ? "领域知识及其 AGENTS.md 入口放在所选领域相对目录；代码仓文稿放在 docs 下的业务目录，代码仓根 AGENTS.md 统一导航。旧正文保留在 Git 历史中。" : "";
    const displayStatus = (status: string) => job.component_research_id ? status : ({ "已归档": "MR 待合入", "已发布（未归档）": "待创建 MR", "归档中": "正在创建 MR", "归档失败": "MR 创建失败" }[status] ?? status);
    if (!job.component_research_id) for (const target of targets) {
      target.status_label = batch?.publications.find(publication => publication.target_id === target.id)?.mr_state === "merged" ? "MR 已合入" : displayStatus(target.status_label);
      target.message = target.url ? "MR 已创建，修改继续更新原分支；合入并同步后进入正式知识库。" : target.message;
    }
    return JSON.parse(JSON.stringify({ job_id: id, title: job.title, status_label: targets.length && targets.every(target => target.status_label === "MR 已合入") ? "MR 已合入" : displayStatus(status_label), message: job.component_research_id ? [layoutMessage, statusMessage].filter(Boolean).join("\n") : "直接提交任务文稿；MR 合入并同步后，正式知识库才会更新。已创建的未合入 MR 继续复用。",
      issue_no: batch?.issue_no ?? job.issue_no, issue_description: batch?.issue_description ?? job.issue_description, archive_revision: job.archive_revision ?? 0,
      expected_revisions: Object.fromEntries(documents.map(document => job.component_research_id ? [document.knowledge_document_id!, document.published_revision!] : [document.id, String(document.revision)])), actions, targets })) as KnowledgeArchivePreview;
  }
  async createArchive(id: string, input: { issue_no: string; issue_description?: string; expected_revisions: Record<string, string>; replace_existing?: boolean; expected_archive_revision?: number }, operator: string) {
    if (!this.live(id).component_research_id) return this.createCandidateArchive(id, input, operator);
    let job = structuredClone(this.live(id)); const owner = this.acquirePublication(id);
    try {
      const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description);
      if (input.expected_archive_revision !== undefined && input.expected_archive_revision !== (job.archive_revision ?? 0)) throw new Error("归档位置已被修改，请刷新路径预览后重新创建 MR");
      if (!this.options.publish) throw new Error("未配置 Git 归档发布器");
      let documents = this.formalArchiveDocuments(job, true);
      if (!documents.length) throw new Error("没有已发布的正式知识可归档");
      if (!isRecord(input.expected_revisions) || documents.some(document => input.expected_revisions[document.knowledge_document_id!] !== document.published_revision)
        || Object.keys(input.expected_revisions).length !== new Set(documents.map(document => document.knowledge_document_id)).size) throw new Error("正式知识版本已变化，请刷新归档预览");
      if (input.replace_existing !== undefined && typeof input.replace_existing !== "boolean") throw new Error("替换旧 MR 须为布尔值");
      if ("target_ids" in input) throw new Error("首次人工归档包含全部目标；失败后可以按目标重试");
      for (const target of [job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id))) {
        if (!target.repository.trim()) throw new Error("未配置 Git 归档仓，请联系管理员在知识仓设置中配置");
        repository(target, target.id);
      }
      const targetIds = [...new Set(documents.map(document => document.target_id))];
      const targets = [job.knowledge_target, ...job.repositories].filter(target => targetIds.includes(target.id));
      const paths = new Set<string>();
      for (const target of targets) {
        if (!target.repository.trim()) throw new Error("未配置 Git 归档仓，请联系管理员在知识仓设置中配置");
        repository(target, target.id);
        for (const document of documents.filter(document => document.target_id === target.id)) {
          const path = knowledgeRelativePath(document.archive_path ?? document.path, true), key = JSON.stringify([target.repository, target.branch, path]);
          if (paths.has(key)) throw new Error("多个知识文档指向同一个归档文件，请调整设置"); paths.add(key);
        }
      }
      let batch = this.matchingManualBatch(job, documents);
      if (batch && (!input.replace_existing || batch.state !== "done")) {
        const existingPublications = batch.publications;
        const unfinished = archiveRepositoryGroups(batch.targets).filter(group => !existingPublications.some(publication =>
          group.ids.includes(publication.target_id) && publication.state === "opened" && validMrUrl(publication.url)));
        if (unfinished.length || batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state))) await this.runManualArchive(job, batch, unfinished.flatMap(group => group.ids), operator, owner);
        return this.previewArchive(id);
      }
      if (needsModuleKnowledgeLayout(job)) throw new Error(LEGACY_MODULE_ARCHIVE_MESSAGE);
      const closedUrls = new Set((job.archive_batches ?? []).flatMap(batch => batch.replacements?.filter(item => (["closed", "merged"] as string[]).includes(item.state)).map(item => item.publication.url) ?? []));
      const covered = (previous: Array<{ id: string; knowledge_document_id?: string }>) => previous.every(old => documents.some(document =>
        old.knowledge_document_id ? old.knowledge_document_id === document.knowledge_document_id : old.id === document.id));
      const previousBatches = (job.archive_batches ?? []).filter(batch => !!batch.issue_no && batch.state !== "superseded"
        && batch.targets.some(old => targetIds.includes(old.id)));
      if (previousBatches.some(batch => covered(batch.documents) && (batch.state !== "done" || batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state))))) {
        throw new Error("还有未完成的归档批次，请先重试该批次；已有文稿和 MR 均保留");
      }
      const replacements: NonNullable<DomainArchiveBatch["replacements"]> = [];
      const addReplacement = (publication: DomainPublication, target: KnowledgeRepository | undefined, batch_id?: string) => {
        if (!target || !covered(publication.documents) || publication.state !== "opened" || !validMrUrl(publication.url) || closedUrls.has(publication.url)
          || replacements.some(item => item.publication.url === publication.url) || !targetIds.includes(target.id)) return;
        replacements.push({ batch_id, target: structuredClone(target), publication: structuredClone(publication), state: "pending" });
      };
      for (const previous of previousBatches) for (const publication of previous.publications) addReplacement(publication, previous.targets.find(target => target.id === publication.target_id), previous.id);
      for (const publication of job.publications) addReplacement(publication, [job.knowledge_target, ...job.repositories].find(target => target.id === publication.target_id));
      if (replacements.length && !this.options.closePublication) throw new Error("尚未配置旧 MR 撤销能力，未创建替换 MR");
      batch = { id: randomUUID(), created_at: new Date().toISOString(), operator, state: "pending", knowledge_layout: job.knowledge_layout,
        documents: structuredClone(documents), targets: structuredClone(targets), issue_no, issue_description, publications: [], ...(replacements.length ? { replacements } : {}) };
      (job.archive_batches ??= []).push(batch); this.persist(job); this.live(id).archive_batches = structuredClone(job.archive_batches);
      await this.runManualArchive(job, batch, targetIds, operator, owner);
      return this.previewArchive(id);
    } finally { this.releasePublication(id, owner); }
  }
  private async createCandidateArchive(id: string, input: { issue_no: string; issue_description?: string; expected_revisions: Record<string, string>; expected_archive_revision?: number; replace_existing?: boolean }, operator: string) {
    const owner = this.acquirePublication(id);
    try {
      let job = this.candidateJob(this.live(id));
      if (job.module_id && readBusinessModule(this.dataDir, job.module_id).status !== "active") throw new Error("所选业务模块已停用，候选与原 MR 记录保留");
      if (["queued", "running", "paused"].includes(job.status)) throw new Error("请等待本轮完成后创建 MR，文稿和检视意见已保留");
      if (!this.options.publish) throw new Error("未配置 Git 归档发布器");
      const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description);
      if (input.expected_archive_revision !== undefined && input.expected_archive_revision !== (job.archive_revision ?? 0)) throw new Error("归档位置已被修改，请刷新路径预览后重新创建 MR");
      const documents = this.candidateDocuments(job);
      if (!documents.length) throw new Error("请选择至少一篇任务文稿创建 MR");
      if (!isRecord(input.expected_revisions) || Object.keys(input.expected_revisions).length !== documents.length
        || documents.some(document => input.expected_revisions[document.id] !== String(document.revision))) throw new Error("文稿已有新版本，请刷新 MR 预览");
      const targets = [job.knowledge_target, ...job.repositories].filter(target => documents.some(document => document.target_id === target.id));
      const paths = new Set<string>();
      for (const target of targets) {
        repository(target, target.id);
        for (const document of documents.filter(document => document.target_id === target.id)) {
          this.validateDocument(job, document);
          const key = JSON.stringify([repositoryIdentity(target.repository), target.branch, document.archive_path ?? document.path]);
          if (paths.has(key)) throw new Error("多个文稿指向同一个文件，请调整 MR 路径");
          paths.add(key);
        }
      }
      let batch = this.matchingManualBatch(job, documents);
      if (batch) {
        if (this.options.refreshPublication) {
          for (const publication of batch.publications) if (publication.url) {
            const target = batch.targets.find(target => target.id === publication.target_id)!;
            Object.assign(publication, await this.options.refreshPublication(target, publication, operator));
          }
          job.publications = structuredClone(batch.publications); this.assertPublicationOwner(id, owner);
          this.persist(job); Object.assign(this.live(id), job);
        }
        const unfinished = archiveRepositoryGroups(batch.targets).filter(group => !batch!.publications.some(publication => group.ids.includes(publication.target_id)
          && (publication.state === "opened" || publication.mr_state === "merged") && validMrUrl(publication.url)));
        if (unfinished.length) await this.runManualArchive(job, batch, unfinished.flatMap(group => group.ids), operator, owner);
        return this.previewArchive(id);
      }
      const previous = archiveRepositoryGroups(targets).flatMap(({ target }) => {
        let found: DomainPublication | undefined;
        for (const batch of [...job.archive_batches ?? []].reverse()) {
          found = batch.publications.find(publication => {
            const previousTarget = batch.targets.find(previous => previous.id === publication.target_id);
            return previousTarget && repositoryIdentity(previousTarget.repository) === repositoryIdentity(target.repository) && previousTarget.branch === target.branch;
          });
          if (found) break;
        }
        found ??= job.publications.find(publication => publication.target_id === target.id);
        // 同一物理仓的领域/代码角色可合并成一个 MR；调整勾选范围不应另建分支。
        return found ? [{ target, publication: { ...structuredClone(found), target_id: target.id } }] : [];
      });
      for (const entry of previous) {
        if (entry.publication.url && this.options.refreshPublication) entry.publication = await this.options.refreshPublication(entry.target, entry.publication, operator);
        if (entry.publication.mr_state === "merged") throw new Error("此任务 MR 已合入，请从正式知识库开始新的检视，避免覆盖后续更新");
        if (entry.publication.mr_state === "closed") throw new Error("此任务 MR 已关闭，请重新打开原 MR 后继续修改");
      }
      this.assertPublicationOwner(id, owner);
      batch = { id: randomUUID(), created_at: new Date().toISOString(), operator, state: "pending", knowledge_layout: job.knowledge_layout,
        documents: structuredClone(documents), targets: structuredClone(targets), issue_no, issue_description,
        publications: previous.map(entry => ({ ...entry.publication, state: "pending" as const })) };
      (job.archive_batches ??= []).push(batch);
      this.persist(job); Object.assign(this.live(id), job);
      await this.runManualArchive(job, batch, targets.map(target => target.id), operator, owner);
      return this.previewArchive(id);
    } finally { this.releasePublication(id, owner); }
  }
  async refreshPublicationStatus() {
    const jobs = [...this.jobs.values()].filter(job => !job.deleted_at && !job.component_research_id && !this.publishing.has(job.id)
      && job.publications.some(publication => publication.url && publication.mr_state !== "merged"));
    if (!jobs.length) return;
    const start = this.publicationRefreshCursor % jobs.length;
    const selected = Array.from({ length: Math.min(4, jobs.length) }, (_, index) => jobs[(start + index) % jobs.length]);
    this.publicationRefreshCursor = (start + selected.length) % jobs.length;
    await Promise.allSettled(selected.map(async job => {
      try { await this.refreshPublications(job.id, job.operator); }
      catch (error) {
        const message = `MR 状态刷新失败：${job.id}；${error instanceof Error ? error.message : String(error)}`;
        if (!this.readWarnings.includes(message)) this.readWarnings.push(message);
      }
    }));
  }
  async refreshPublications(id: string, operator: string) {
    const existing = this.publicationRefreshes.get(id);
    if (existing) return existing;
    if (this.stopped) throw new Error("服务已停止，迟到结果未保存");
    const work = (async () => {
      const snapshot = structuredClone(this.live(id));
      if (!this.options.refreshPublication) return this.get(id);
      const refreshed = new Map<string, Pick<DomainPublication, "mr_state" | "checked_at">>();
      for (const batch of snapshot.archive_batches ?? []) for (const publication of batch.publications) {
        if (!publication.url) continue;
        const target = batch.targets.find(target => target.id === publication.target_id);
        if (!target) continue;
        const key = JSON.stringify([target.repository, publication.url]);
        if (!refreshed.has(key)) {
          const fact = await this.options.refreshPublication(target, publication, operator);
          refreshed.set(key, { mr_state: fact.mr_state, checked_at: fact.checked_at });
        }
      }
      if (this.stopped) throw new Error("服务已停止，迟到结果未保存");
      // 查询期间研究仍可保存正文；这里只合并远端状态，不能拿旧快照覆盖文稿或新回合。
      const current = this.live(id), candidate = structuredClone(current);
      for (const batch of candidate.archive_batches ?? []) for (const publication of batch.publications) {
        const target = batch.targets.find(target => target.id === publication.target_id);
        const fact = target && publication.url ? refreshed.get(JSON.stringify([target.repository, publication.url])) : undefined;
        if (fact) Object.assign(publication, fact);
      }
      for (const publication of candidate.publications) {
        const target = [candidate.knowledge_target, ...candidate.repositories].find(target => target.id === publication.target_id);
        const fact = target && publication.url ? refreshed.get(JSON.stringify([target.repository, publication.url])) : undefined;
        if (fact) Object.assign(publication, fact);
      }
      this.persist(candidate);
      current.archive_batches = candidate.archive_batches; current.publications = candidate.publications;
      if (current.publications.some(publication => publication.mr_state === "merged") && ["queued", "running", "paused"].includes(current.status)) this.stop(id);
      return this.get(id);
    })();
    this.publicationRefreshes.set(id, work);
    try { return await work; }
    finally { if (this.publicationRefreshes.get(id) === work) this.publicationRefreshes.delete(id); }
  }
  async retryArchive(id: string, operator: string, input: { batch_id: string; target_id?: string }) {
    const job = structuredClone(this.live(id)), owner = this.acquirePublication(id);
    try {
      const batch = job.archive_batches?.find(batch => batch.id === input?.batch_id && !!batch.issue_no);
      if (!batch || batch.state === "superseded") throw new Error("人工归档记录不存在");
      if (input.target_id && !batch.targets.some(target => target.id === input.target_id)) throw new Error("归档目标不存在");
      const targets = archiveRepositoryGroups(batch.targets).filter(group => {
        const publication = batch.publications.find(publication => group.ids.includes(publication.target_id));
        return (!input.target_id || group.ids.includes(input.target_id)) && publication?.state !== "opened" && publication?.mr_state !== "merged";
      });
      if (targets.length || batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state))) await this.runManualArchive(job, batch, targets.flatMap(group => group.ids), operator, owner);
      else if (batch.state !== "done" && batch.targets.length && archiveRepositoryGroups(batch.targets).every(group =>
        batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened" && validMrUrl(publication.url)))) {
        // MR 回执已耐久，人工重试只补最终状态；不重复 Git 或创建 MR。
        this.assertPublicationOwner(id, owner);
        const candidate = structuredClone(this.live(id)), completed = candidate.archive_batches!.find(current => current.id === batch.id)!;
        completed.state = "done"; completed.error = undefined;
        this.persist(candidate); this.live(id).archive_batches = structuredClone(candidate.archive_batches);
      }
      const current = this.live(id), frozen = current.archive_batches!.find(candidate => candidate.id === batch.id)!;
      return this.archivePreview({ ...current, knowledge_layout: frozen.knowledge_layout,
        knowledge_target: frozen.targets.find(target => target.id === "domain") ?? current.knowledge_target,
        repositories: frozen.targets.filter(target => target.id !== "domain") }, frozen.documents);
    } finally { this.releasePublication(id, owner); }
  }
  private async runManualArchive(job: DomainKnowledgeJob, original: DomainArchiveBatch, targetIds: string[], operator: string, owner: symbol) {
    if (!this.options.publish) throw new Error("未配置 Git 归档发布器");
    if (!this.live(job.id).archive_progress_revision) this.persist(this.live(job.id));
    let snapshot = copyDomainArchiveState(job);
    const progress = new DomainArchiveProgressStore();
    const batchId = original.id;
    const currentBatch = () => snapshot.archive_batches!.find(batch => batch.id === batchId)!;
    // 操作的私有副本与读取副本分离；耐久写成功后才替换公开记录。
    const commit = (change: (candidate: DomainKnowledgeJob, batch: DomainArchiveBatch) => void) => {
      this.assertPublicationOwner(job.id, owner);
      const candidate = copyDomainArchiveState(this.live(job.id)), batch = candidate.archive_batches!.find(batch => batch.id === batchId)!;
      change(candidate, batch); progress.save(join(this.root(job.id), "job.json"), candidate); snapshot = candidate;
      // 研究执行体持有 turn/document 引用；这里只换归档字段，不能替换仍在执行的嵌套对象。
      Object.assign(this.live(job.id), { archive_batches: candidate.archive_batches, publications: candidate.publications });
    };
    const fail = (reason: string, targetId?: string, previous?: DomainPublication) => {
      const update = (candidate: DomainKnowledgeJob, batch: DomainArchiveBatch) => {
        if (targetId) {
          const saved = batch.publications.find(publication => publication.target_id === targetId) ?? previous;
          // 已保存的 MR 创建事实不因后续操作异常而变成归档失败。
          const coversCurrent = saved && batch.documents.filter(document => document.target_id === targetId).every(document => saved.documents.some(old => old.id === document.id
            && old.content === document.content && old.revision === document.revision && !!old.deleted === !!document.deleted));
          const publication: DomainPublication = saved?.state === "opened" && validMrUrl(saved.url) && (candidate.component_research_id || coversCurrent)
            ? saved
            : { ...(saved ?? { target_id: targetId, branch: "", documents: [] }), state: "failed", error: reason };
          batch.publications = [...batch.publications.filter(publication => publication.target_id !== targetId),
            publication];
          candidate.publications = batch.publications;
        }
        batch.state = archiveRepositoryGroups(batch.targets).every(group => batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened")) && !batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state)) ? "done" : "failed";
        batch.error = batch.state === "failed" ? reason : undefined;
      };
      try { commit(update); }
      catch (error) {
        this.assertPublicationOwner(job.id, owner);
        const candidate = copyDomainArchiveState(this.live(job.id)); update(candidate, candidate.archive_batches!.find(batch => batch.id === batchId)!);
        Object.assign(this.live(job.id), { archive_batches: candidate.archive_batches, publications: candidate.publications });
        this.readWarnings.push(`人工归档失败记录保存失败：domain-extraction/${job.id}/archive-progress.json；${error instanceof Error ? error.message : String(error)}；请检查磁盘后手动重试`);
      }
    };
    const work = (async () => {
      try { commit((_, batch) => {
        batch.state = archiveRepositoryGroups(batch.targets).every(group => batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened")) && !batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state)) ? "done" : "running";
        batch.error = undefined;
      }); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); return; }
      for (const { target, ids } of archiveRepositoryGroups(original.targets).filter(group => group.ids.some(id => targetIds.includes(id)))) {
        this.assertPublicationOwner(job.id, owner);
        const previous = currentBatch().publications.find(publication => ids.includes(publication.target_id));
        if (previous?.mr_state === "merged") continue;
        if (previous?.state === "opened" && (job.component_research_id || original.documents.filter(document => ids.includes(document.target_id)).every(document => previous.documents.some(old => old.id === document.id && old.revision === document.revision && old.content === document.content && !!old.deleted === !!document.deleted)))) continue;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, accepting = true;
        const save = (publication: DomainPublication) => {
          if (!accepting || controller.signal.aborted) return;
          if (!validPublication(publication)) throw new Error("MR 回执格式不正确或缺少有效链接，未记为已归档；请手动重试");
          commit((candidate, batch) => {
            batch.publications = [...batch.publications.filter(current => current.target_id !== target.id), copyDomainPublication(publication)];
            candidate.publications = batch.publications;
          });
        };
        try {
          const batch = currentBatch();
          const publicationJob = structuredClone({ ...snapshot, evidence: [], turns: [], documents: batch.documents.filter(document => ids.includes(document.target_id)),
            knowledge_layout: batch.knowledge_layout,
            knowledge_target: structuredClone(batch.targets.find(candidate => candidate.id === "domain") ?? snapshot.knowledge_target),
            repositories: structuredClone(batch.targets.filter(candidate => candidate.id !== "domain")), issue_no: batch.issue_no, issue_description: batch.issue_description });
          const publication = await Promise.race([this.options.publish!(publicationJob, structuredClone(target), previous && structuredClone(previous), operator, save, controller.signal), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { accepting = false; controller.abort(); reject(new Error("人工归档超时：此仓操作 600 秒内未完成，请手动重试")); }, 600_000);
          })]);
          this.assertPublicationOwner(job.id, owner); save(publication);
        } catch (error) {
          this.assertPublicationOwner(job.id, owner); fail(error instanceof Error ? error.message : String(error), target.id, previous);
        } finally { accepting = false; clearTimeout(timer); controller.abort(); }
      }
      const opened = archiveRepositoryGroups(currentBatch().targets).every(group => currentBatch().publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened"));
      if (opened) for (const replacement of currentBatch().replacements ?? []) {
        if (replacement.state === "closed" || replacement.state === "merged") continue;
        const url = replacement.publication.url!;
        try {
          if (currentBatch().publications.some(publication => publication.url === url)) throw new Error("新旧 MR 链接相同，未撤销；请核对归档发布器");
          if (!this.options.closePublication) throw new Error("未配置旧 MR 撤销能力");
          commit((candidate, batch) => {
            for (const item of batch.replacements ?? []) if (item.batch_id) {
              const previous = candidate.archive_batches!.find(old => old.id === item.batch_id);
              const replacedUrls = new Set([...batch.replacements!.map(item => item.publication.url),
                ...candidate.archive_batches!.flatMap(old => old.replacements?.filter(item => item.state === "closed" || item.state === "merged").map(item => item.publication.url) ?? [])]);
              if (previous?.state === "done" && previous.publications.every(publication => replacedUrls.has(publication.url))) previous.state = "superseded";
            }
          });
          const outcome = await this.options.closePublication(structuredClone({ ...snapshot, evidence: [], turns: [] }), structuredClone(replacement.target), structuredClone(replacement.publication), operator);
          commit((_, batch) => {
            const current = batch.replacements!.find(item => item.publication.url === url)!;
            current.state = outcome === "merged" ? "merged" : "closed"; current.error = undefined;
            if (current.state === "merged") current.merged_at = new Date().toISOString(); else current.closed_at = new Date().toISOString();
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          try { commit((_, batch) => { const current = batch.replacements!.find(item => item.publication.url === url)!; current.state = "failed"; current.error = reason; }); }
          catch (failure) { fail(failure instanceof Error ? failure.message : String(failure)); }
        }
      }
      try { commit((_, batch) => {
        batch.state = archiveRepositoryGroups(batch.targets).every(group => batch.publications.some(publication => group.ids.includes(publication.target_id) && publication.state === "opened")) && !batch.replacements?.some(item => !(["closed", "merged"] as string[]).includes(item.state)) ? "done" : "failed";
        batch.error = batch.publications.find(publication => publication.state === "failed")?.error ?? batch.replacements?.find(item => item.state === "failed")?.error;
      }); } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    })();
    this.archiving.set(job.id, work);
    try { await work; } finally { if (this.archiving.get(job.id) === work) this.archiving.delete(job.id); }
  }
  create(input: any, operator: string) { return this.createJob(input, operator); }
  reextract(id: string, operator: string) {
    const replacement = [...this.jobs.values()].find(job => job.reextract_of === id && !job.deleted_at);
    if (replacement) { this.remove(id, operator); return this.get(replacement.id); }
    const original = this.live(id);
    if (original.component_research_id) throw new Error("请在基础组件萃取中管理对应任务");
    if (this.publishing.has(id)) throw new Error("正在发布或归档，请等待当前操作完成后再重新萃取");
    const next = this.createJob({ title: original.title, scope: original.scope, instructions: original.instructions,
      issue_no: original.issue_no, issue_description: original.issue_description, module_id: original.module_id,
      repositories: original.source_repositories ?? original.repositories, material_ids: original.material_ids }, operator, original);
    this.remove(id, operator);
    return next;
  }
  beginInspection(documentId: string, input: { issue_no: string; issue_description?: string; expected_revision?: string; module_id?: string }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const published = readKnowledgeDocument(this.dataDir, documentId);
    if (!published.source) throw new Error("请先同步远端仓库正式文档，再开始检视");
    if (input.expected_revision && input.expected_revision !== published.revision) throw new Error("知识已有新版本，请刷新后开始检视");
    const module_id = input.module_id ? resolveBusinessModuleId(this.dataDir, input.module_id) : published.module_ids.length === 1 ? published.module_ids[0] : undefined;
    if (!module_id) throw new Error("请选择文档所属业务模块后开始检视");
    const module = readBusinessModule(this.dataDir, module_id), location = resolveModuleKnowledgeLocation(this.dataDir, module_id);
    if (module.status !== "active") throw new Error("业务模块已停用");
    if (!location) throw new Error("平台领域知识仓尚未配置，请联系管理员");
    if (!published.module_ids.includes(module_id)) throw new Error("文档不在所选业务模块的知识范围内");
    const knowledge_target = repository(location, "domain");
    const allFormal = listFormalKnowledgeDocuments(this.dataDir).filter(document => document.active && document.source && document.module_ids.includes(module_id));
    const synchronized = readModuleKnowledgeSync(this.dataDir, module_id)?.repositories ?? [];
    const revisions: Record<string, string> = {};
    // 源码工具覆盖模块绑定仓；没有文档的代码仓也能按实际远端 HEAD 读取，不能因正文缺失丢失源码能力。
    const source_repositories: KnowledgeRepository[] = module.repositories.map((url, index) => {
      const source = allFormal.find(document => document.scope === "repository" && repositoryIdentity(document.source!.repository) === repositoryIdentity(url))?.source
        ?? synchronized.find(source => source.scope === "repository" && repositoryIdentity(source.repository) === repositoryIdentity(url))
        ?? synchronized.find(source => !source.scope && repositoryIdentity(source.repository) === repositoryIdentity(url));
      const id = `repo-${index + 1}`;
      if (source?.revision) revisions[id] = source.revision;
      return { id, name: url.split("/").at(-1)?.replace(/\.git$/, "") ?? url, repository: url, branch: source?.branch ?? "", path: "",
        docs_path: `docs/${repositoryKnowledgeDirectory(module.name)}` };
    });
    const repositories = structuredClone(source_repositories);
    const formal = allFormal.filter(document => !/(?:^|\/)agents\.md$/i.test(document.source!.path));
    const documents: DomainDocument[] = formal.map(document => {
      const source = document.source!;
      const domain = document.scope !== "repository" && repositoryIdentity(source.repository) === repositoryIdentity(location.repository) && source.branch === location.branch
        && source.path.startsWith(`${location.docs_path}/`);
      let target = domain ? knowledge_target : repositories.find(target => repositoryIdentity(target.repository) === repositoryIdentity(source.repository) && target.branch === source.branch);
      if (!target) {
        target = { id: `repo-${repositories.length + 1}`, name: source.repository.split("/").at(-1)?.replace(/\.git$/, "") ?? "代码仓",
          repository: source.repository, branch: source.branch, path: "", docs_path: "docs" };
        repositories.push(target);
      }
      if (!domain && !source.path.startsWith(`${target.docs_path}/`)) target.docs_path = "docs";
      if (revisions[target.id] && revisions[target.id] !== source.revision) throw new Error("同一仓库的正式文档版本不一致，请重新同步后开始检视");
      revisions[target.id] = source.revision;
      return { id: document.id, title: document.title, target_id: target.id, path: source.path, layer: domain ? "domain" : "repository",
        content: document.content, sources: `${source.repository}@${source.revision}:${source.path}`, revision: 1, selected: true,
        base_content: document.content, base_revision: source.revision, base_path: source.path, history: [], knowledge_document_id: document.id,
        published_revision: document.revision, published_document_revision: 1 };
    });
    if (!documents.length) throw new Error("此模块尚无可检视正文，请先同步正式知识");
    const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, task_kind: "inspection", title: module.name, scope: `检视业务模块：${module.name}。${module.description}`,
      module_id, issue_no: knowledgeIssueNumber(input.issue_no), issue_description: knowledgeIssueDescription(input.issue_description), operator,
      created_at: new Date().toISOString(), inspection_source: { document_id: formal.find(document => document.id === documentId)?.id ?? formal[0].id, started_at: new Date().toISOString() },
      git_resources: freezeGitKnowledgeResources(this.dataDir, formal),
      knowledge_layout: "directory-v1", repositories, knowledge_target, source_repositories, archive_configured: true, archive_revision: 0,
      material_ids: [], status: "idle", stage: "检视中", revisions, documents, turns: [], evidence: [], publications: [], archive_batches: [] };
    this.jobs.set(job.id, job); this.persist(job); return this.get(job.id);
  }
  inspectionResource(id: string, documentId: string, href: string) {
    const job = this.live(id);
    if (!job.documents.some(document => document.id === documentId)) throw new Error("文稿不存在或不在本次任务范围");
    const refs = job.git_resources?.[documentId];
    return refs ? readFrozenGitKnowledgeResource(this.dataDir, refs, href) : undefined;
  }
  finishInspection(id: string) {
    const job = this.live(id);
    if (job.task_kind !== "inspection" || job.turns.length) throw new Error("当前检视已提交处理，请查看研究过程");
    const notesPath = join(this.dataDir, "knowledge-review", "domain", `${id}.json`);
    if (existsSync(notesPath)) {
      const notes = JSON.parse(readFileSync(notesPath, "utf8"));
      if (!Array.isArray(notes)) throw new Error("检视意见无法读取，原意见已保留，请重试");
      if (notes.some(note => note.status === "open")) throw new Error("仍有未提交的检视意见，请提交意见后结束检视");
    }
    job.status = "done"; job.stage = job.documents.every(document => document.content === document.base_content && !document.deleted && document.path === (document.base_path ?? document.path)) ? "检视完成，无需修改" : "文稿修改完成，可创建 MR";
    if (job.inspection_source) job.inspection_source.finished_at = new Date().toISOString();
    this.persist(job); return this.get(id);
  }
  beginUpdate(documentId: string, input: { message?: string; expected_revision?: string; material_ids?: string[] }, operator: string) {
    const published = readKnowledgeDocument(this.dataDir, documentId);
    if (input.expected_revision && input.expected_revision !== published.revision) throw new Error("知识已有新版本，请刷新后发起更新");
    const original = this.jobs.get(published.research_source?.job_id ?? "");
    if (!original || original.component_research_id) throw new Error("此知识不属于领域研究，请使用其原有维护入口");
    const source = original.documents.find(d => d.knowledge_document_id === documentId
      || d.id === published.research_source?.document_id || d.path === published.research_source?.path);
    if (!source) throw new Error("找不到知识的研究来源，不能猜测更新基线");
    const document: DomainDocument = { ...structuredClone(source), title: published.title, content: published.content,
      knowledge_document_id: published.id, published_revision: published.revision, published_document_revision: 1,
      revision: 1, history: [], selected: true, human_edited: true, research_turn_id: undefined };
    const archiveHistory = new Map<string, DomainPublication>();
    const remember = (publication: DomainPublication) => {
      if (!publication.revision) return;
      const documents = publication.documents.filter(document => document.knowledge_document_id === published.id && document.knowledge_revision);
      if (!documents.length) return;
      const fact = { ...structuredClone(publication), documents: structuredClone(documents) };
      delete fact.attempted_documents;
      archiveHistory.set(JSON.stringify([fact.branch, fact.revision, documents.map(document => document.path)]), fact);
    };
    // 新任务不接管原任务的归档操作，但改名必须保留同一知识已推送的精确文件事实。
    for (const publication of [...original.publication_history ?? [], ...original.publications]) remember(publication);
    for (const batch of original.archive_batches ?? []) for (const publication of batch.publications) remember(publication);
    const job: DomainKnowledgeJob = { ...structuredClone(original), id: `dkx-${randomUUID()}`, operator,
      created_at: new Date().toISOString(), deleted_at: undefined, deleted_by: undefined, reextract_of: undefined, status: "idle", stage: "准备增量研究",
      documents: [document], turns: [], evidence: [], archive_batches: [], publications: [], publication_history: [...archiveHistory.values()],
      revisions: { ...(published.research_source?.source_revisions ?? original.revisions) },
      material_ids: published.research_source?.material_ids ?? original.material_ids };
    this.jobs.set(job.id, job); this.persist(job);
    return this.run(job.id, { mode: "update", document_ids: [document.id], message: input.message?.trim() || "核对来源变化，更新受影响知识；保留现有人工内容，无变化时说明原因",
      material_ids: input.material_ids }, operator);
  }
  private createJob(input: any, operator: string, reextractSource?: DomainKnowledgeJob) {
    if (this.stopped) throw new Error("服务正在停止");
    const issue_no = knowledgeIssueNumber(input.issue_no), issue_description = knowledgeIssueDescription(input.issue_description);
    if (input.prepare_cleanup !== undefined && typeof input.prepare_cleanup !== "boolean") throw new Error("萃取前清理须为布尔值");
    const module_id = input.module_id ? String(input.module_id) : undefined;
    if (module_id && !reextractSource) {
      const module = readBusinessModule(this.dataDir, module_id);
      if (module.status !== "active") throw new Error("业务模块已停用");
      input = { ...input, title: module.name, scope: `业务模块：${module.name}。模块说明：${module.description}`,
        repositories: module.repositories.map(url => ({ repository: url, name: url.split("/").at(-1)?.replace(/\.git$/, "") || module.name, branch: input.baseline_branch || "master", path: "" })) };
    }
    const title = String(input.title ?? "").trim(), scope = String(input.scope ?? "").trim();
    if (input.instructions !== undefined && typeof input.instructions !== "string") throw new Error("本次要求须为文本");
    const instructions = input.instructions?.trim() || undefined;
    if (instructions && instructions.length > 20000) throw new Error("本次要求最多 20000 字");
    if (!title || title.length > 160 || !scope || scope.length > 10000) throw new Error("请填写业务域名称及本次研究范围");
    if (!Array.isArray(input.repositories) || input.repositories.length > 30) throw new Error("业务仓须为数组，最多 30 个；无源码时可传空数组");
    const defaults = knowledgeArchiveDefaults(new KnowledgeExtractionSkills(this.dataDir).current("domain").files, "domain");
    const name = this.moduleDirectoryName({ module_id, title });
    const repositories = input.repositories.map((r: any, i: number) => repository({ ...r,
      docs_path: typeof r.docs_path === "string" && r.docs_path.startsWith("docs/") && !hasOpaqueModuleDirectory(r.docs_path) ? r.docs_path
        : directoryKnowledgeDirectory(r.docs_path || defaults.repository_directory, name, module_id, false) }, `repo-${i + 1}`));
    const configured = readKnowledgeRepoConfig(this.dataDir), moduleLocation = module_id && !reextractSource ? resolveModuleKnowledgeLocation(this.dataDir, module_id) : undefined;
    const knowledge_target = reextractSource ? structuredClone(reextractSource.knowledge_target) : moduleLocation ? repository(moduleLocation, "domain") : input.knowledge_target ? repository(input.knowledge_target, "domain") : {
      id: "domain", name: "领域知识仓", repository: configured?.url || "", branch: configured?.branch || "master", path: "",
      docs_path: configured?.docs_path || defaults.domain_directory,
    };
    if (!moduleLocation && (!input.knowledge_target && reextractSource?.knowledge_layout !== "directory-v1" || knowledge_target.docs_path === ".")) {
      knowledge_target.docs_path = directoryKnowledgeDirectory(knowledge_target.docs_path, name, module_id, true);
    } else if (!moduleLocation && !reextractSource) knowledge_target.docs_path = readableDomainKnowledgeDirectory(knowledge_target.docs_path, module_id, name);
    const archiveRepositories = structuredClone(reextractSource?.repositories ?? repositories).map((target: KnowledgeRepository) => ({ ...target,
      docs_path: (!reextractSource || reextractSource.knowledge_layout === "directory-v1") && target.docs_path.startsWith("docs/") && !hasOpaqueModuleDirectory(target.docs_path)
        ? target.docs_path : directoryKnowledgeDirectory(target.docs_path, name, module_id, false) }));
    if (new Set(repositories.map(r => r.repository)).size !== repositories.length || (input.knowledge_target && repositories.some(r => r.repository === knowledge_target.repository))) throw new Error("业务仓不能重复，领域知识仓须独立指定");
    const material_ids = this.materialIds(input.material_ids ?? []);
    scanForSecrets("业务范围", Buffer.from(JSON.stringify({ title, scope, instructions })));
    const job: DomainKnowledgeJob = { id: `dkx-${randomUUID()}`, task_kind: "extraction", reextract_of: reextractSource?.id, title, scope, instructions, issue_no, issue_description, module_id,
      knowledge_layout: "directory-v1", operator, created_at: new Date().toISOString(), repositories: archiveRepositories, knowledge_target,
      source_repositories: structuredClone(repositories), archive_configured: !!knowledge_target.repository, archive_revision: 0,
      material_ids, status: "idle", stage: "准备研究", revisions: {}, documents: [], turns: [], evidence: [], publications: [] };
    if (input.prepare_cleanup) {
      const targets = archiveRepositoryGroups([knowledge_target, ...job.repositories].filter(target => target.repository)).map(group => group.target);
      if (!targets.length) throw new Error("没有可清理的来源仓，请配置业务仓或知识仓");
      job.source_cleanup = { repositories: structuredClone(targets), plans: [], publications: [] };
      job.stage = "等待人工清理旧知识";
    }
    // 请求键在创建时保存；后续维护不会改变原请求的身份。
    const requestKey = (value: DomainKnowledgeJob) => JSON.stringify([value.title, value.scope, value.instructions,
      value.issue_no, value.issue_description, value.module_id, value.knowledge_layout, value.source_repositories, value.knowledge_target,
      value.archive_configured, value.material_ids, ...(value.source_cleanup ? ["prepare-cleanup"] : [])]);
    job.key = requestKey(job);
    const previous = [...this.jobs.values()].reverse().find(existing => !existing.component_research_id && !existing.deleted_at
      && existing.operator === operator && (["queued", "running"].includes(existing.status) || existing.source_cleanup && !existing.source_cleanup.started)
      && (existing.turns[0]?.mode === "extract" || existing.source_cleanup && !existing.source_cleanup.started) && existing.key === job.key);
    if (previous && !reextractSource) return this.get(previous.id);
    this.assertModuleDirectories(job);
    this.jobs.set(job.id, job); this.persist(job);
    if (job.source_cleanup) return this.get(job.id);
    return this.run(job.id, { mode: "extract", message: scope }, operator);
  }
  async sourceCleanupAction(id: string, action: string, input: any, operator: string) {
    const job = this.live(id);
    if (!job.source_cleanup || job.source_cleanup.started) throw new Error("当前任务不在萃取前清理阶段");
    if (this.publishing.has(id)) throw new Error("清理操作正在进行，请等待完成");
    if (action === "start") {
      return this.run(id, { mode: "extract", message: job.scope }, operator);
    }
    if (!this.options.sourceCleanup) throw new Error("清理 MR 服务未配置");
    const owner = this.acquirePublication(id);
    try {
      const candidate = structuredClone(job);
      await this.options.sourceCleanup.action(candidate, action, input, operator, () => {
        this.assertPublicationOwner(id, owner); this.persist(candidate); Object.assign(job, structuredClone(candidate));
      }, AbortSignal.timeout(5 * 60_000));
      return this.get(id);
    } finally { this.releasePublication(id, owner); }
  }
  previewArchiveTargets(id: string, input: ArchiveDirectoryInput): DomainArchiveTargetsPreview {
    const candidate = this.archiveTargetsCandidate(id, input);
    return { targets: [candidate.knowledge_target, ...candidate.repositories],
      ...(candidate.component_research_id ? { archive_preview: this.archivePreview(candidate, this.formalArchiveDocuments(candidate, true)) } : {}),
      documents: (candidate.component_research_id ? this.formalArchiveDocuments(candidate, true) : candidate.documents)
        .map(({ id, title, target_id, path, archive_path }) => ({ id, title, target_id, path: archive_path ?? path })), archive_revision: candidate.archive_revision ?? 0 };
  }
  private archiveTargetsCandidate(id: string, input: ArchiveDirectoryInput): DomainKnowledgeJob {
    const job = this.live(id);
    if (this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("请等待当前操作完成再设置归档位置");
    if (job.publications.some(publication => publication.mr_state === "merged")) throw new Error("已有 MR 合入，当前任务保留原目录；剩余失败仓请重试原批次");
    if (input.base_revision !== (job.archive_revision ?? 0)) throw new Error("归档位置已被修改，请刷新后重新设置");
    if (!Array.isArray(input.targets) || !input.targets.length) throw new Error("请提供归档目标");
    if (job.component_research_id) {
      if (input.targets.length !== 1 || input.targets[0]?.id !== job.knowledge_target.id) throw new Error("请设置当前组件知识的归档仓");
      if (input.documents !== undefined && (!Array.isArray(input.documents) || input.documents.length)) throw new Error("组件能力文件路径由平台按已发布内容计算，请修改归档目录");
      const target = repository({ ...input.targets[0], name: "组件知识归档仓", path: "" }, job.knowledge_target.id);
      if (target.docs_path === ".") throw new Error("请选择组件知识的仓内相对目录，例如 docs/components");
      const candidate = structuredClone(job), formal = readKnowledgeDocument(this.dataDir, job.documents[0].knowledge_document_id!);
      candidate.knowledge_target = target; candidate.archive_configured = true; candidate.knowledge_layout = "directory-v1";
      const path = componentArchivePath(target.docs_path, formal), source = candidate.documents[0];
      candidate.documents = componentArchiveFiles(formal.content, path, source.id).map(file => ({ ...source, ...file, archive_path: undefined,
        ...(file.path === path ? { title: formal.title } : {}), knowledge_document_id: formal.id, published_revision: formal.revision }));
      candidate.archive_revision = (job.archive_revision ?? 0) + 1;
      return candidate;
    }
    if (job.module_id) {
      const binding = resolveModuleKnowledgeLocation(this.dataDir, job.module_id);
      const domain = input.targets.find((target: any) => target.id === job.knowledge_target.id);
      if (binding && domain) {
        const same = (target: { repository: string; branch: string; docs_path: string }) => repositoryIdentity(domain.repository) === repositoryIdentity(target.repository)
          && domain.branch === target.branch && domain.docs_path === target.docs_path;
        if (!same(job.knowledge_target) && (!same(binding) || job.publications.length)) throw new Error("领域知识目录使用模块长期配置；请先在业务模块设置目录，新任务使用新配置，当前已提交 MR 保留原目录");
      }
    }
    if (job.documents.length && job.documents.every(document => this.confirmedDocumentDeletion(document))) return structuredClone(job);
    return this.archiveLayoutCandidate(job, input, true);
  }
  configureArchive(id: string, input: ArchiveDirectoryInput) {
    const job = this.live(id), candidate = this.archiveTargetsCandidate(id, input);
    this.persist(candidate); Object.assign(job, candidate); return this.get(id);
  }
  private archiveLayoutCandidate(job: DomainKnowledgeJob, input: { targets?: unknown; documents?: unknown; use_module_layout?: boolean; use_repository_layout?: boolean; use_directory_layout?: boolean }, requireRepository: boolean) {
    if (input.targets !== undefined && (!Array.isArray(input.targets) || !input.targets.length)) throw new Error("请提供归档目标");
    for (const key of ["use_module_layout", "use_repository_layout", "use_directory_layout"] as const) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error("整理归档目录须为布尔值");
    }
    const previous = [job.knowledge_target, ...job.repositories], candidate = structuredClone(job);
    candidate.knowledge_layout = "directory-v1";
    const organized = true, converting = true, name = this.moduleDirectoryName(job);
    const confirmedDeletions = new Set(candidate.documents.filter(document => this.confirmedDocumentDeletion(document)).map(document => document.id));
    const ids = new Set<string>();
    for (const value of input.targets ?? []) {
      const old = previous.find(t => t.id === value?.id);
      if (!old || ids.has(old.id)) throw new Error("归档目标无效或重复");
      ids.add(old.id);
      const next = repository({ ...value, path: old.path, name: old.name }, old.id);
      if (input.use_directory_layout && (next.docs_path === "." || next.id !== "domain" && !next.docs_path.startsWith("docs/"))) {
        throw new Error(next.id === "domain" ? "领域知识请选择仓内相对目录，不能选择仓根" : "代码仓知识请选择 docs 下的业务目录，例如 docs/订单管理");
      }
      if (!input.use_directory_layout && !(candidate.module_id && next.id === candidate.knowledge_target.id && resolveModuleKnowledgeLocation(this.dataDir, candidate.module_id))) next.docs_path = directoryKnowledgeDirectory(next.docs_path, name, candidate.module_id, next.id === "domain");
      if (next.id === "domain") candidate.knowledge_target = next;
      else candidate.repositories = candidate.repositories.map(t => t.id === next.id ? next : t);
    }
    const targets = [candidate.knowledge_target, ...candidate.repositories];
    for (const target of targets) if (!ids.has(target.id) && job.knowledge_layout !== "directory-v1") target.docs_path = directoryKnowledgeDirectory(target.docs_path, name, job.module_id, target.id === "domain");
    const remap = (targetId: string, path: string) => {
      const old = previous.find(target => target.id === targetId)!, next = targets.find(target => target.id === targetId)!;
      return directoryKnowledgePath(old.docs_path, next.docs_path, path, targetId === "domain" ? [] : [old.name, old.repository.split("/").at(-1)?.replace(/\.git$/, "") ?? ""]);
    };
    const requestedPaths = new Map<string, string>();
    if (input.documents !== undefined) {
      if (!Array.isArray(input.documents)) throw new Error("请提供各文件的归档路径");
      const documentIds = new Set<string>();
      for (const value of input.documents) {
        const doc = job.documents.find(document => document.id === value?.id);
        if (!doc || documentIds.has(doc.id)) throw new Error("归档文件无效或重复");
        documentIds.add(doc.id);
        if (confirmedDeletions.has(doc.id)) continue;
        let path = knowledgeRelativePath(value.path, true);
        if (converting && path === (doc.archive_path ?? doc.path)) path = remap(doc.target_id, path);
        requestedPaths.set(doc.id, path);
      }
    }
    const ownFormalIds = new Map(job.documents.filter(doc => !!doc.knowledge_document_id).map(doc => [doc.knowledge_document_id!, doc.id]));
    const groups = new Set(targets.filter(target => !!target.repository).map(archiveCollisionGroup));
    const occupiedPaths = converting ? listFormalKnowledgeDocuments(this.dataDir).flatMap(formal => {
      const location = formal.archive_target ?? formal.source ?? formal.research_source;
      if (!location?.repository || !location.path || !location.branch) return [];
      const collision_group = archiveCollisionGroup({ id: "", repository: location.repository, branch: location.branch });
      return groups.has(collision_group) ? [{ collision_group, path: location.path, document_id: ownFormalIds.get(formal.id) }] : [];
    }) : [];
    const layout = converting ? moduleKnowledgePaths(job.documents.filter(doc => !confirmedDeletions.has(doc.id)).map(doc => ({
      id: doc.id, target_id: doc.target_id, path: doc.path, desired_path: requestedPaths.get(doc.id) ?? remap(doc.target_id, doc.archive_path ?? doc.path),
    })), targets.map(target => ({ id: target.id, old_directory: previous.find(old => old.id === target.id)!.docs_path,
      new_directory: target.docs_path, collision_group: archiveCollisionGroup(target),
    })), occupiedPaths) : undefined;
    for (const doc of candidate.documents) {
      if (confirmedDeletions.has(doc.id)) continue;
      const old = previous.find(target => target.id === doc.target_id)!, next = targets.find(target => target.id === doc.target_id)!;
      const oldPath = doc.path;
      if (job.module_id && doc.title === job.module_id) doc.title = this.moduleDirectoryName(job);
      if (layout) doc.path = layout.paths.get(doc.id)!;
      else if (!doc.archive_path || organized) {
        doc.path = remap(doc.target_id, doc.path);
      }
      if (!layout && requestedPaths.has(doc.id)) doc.path = requestedPaths.get(doc.id)!;
      if (doc.archive_path || requestedPaths.has(doc.id)) doc.archive_path = doc.path;
      if (repositoryIdentity(next.repository) !== repositoryIdentity(old.repository) || next.branch !== old.branch || job.archive_configured === false) {
        doc.base_content = null; doc.base_revision = ""; delete doc.base_path;
      } else if (doc.path !== oldPath && doc.base_content !== null) {
        doc.base_path ??= oldPath;
      }
    }
    const navigation = new Map<string, DomainDocument[]>();
    for (const target of targets) {
      const renamed = layout?.renamed.filter(item => item.target_id === target.id).map(item => candidate.documents.find(doc => doc.id === item.id)!) ?? [];
      if (!renamed.length) continue;
      const group = archiveCollisionGroup(target), groupIds = new Set(targets.filter(other => archiveCollisionGroup(other) === group).map(other => other.id));
      const documents = candidate.documents.filter(doc => groupIds.has(doc.target_id) && !doc.deleted && (target.docs_path === "." || doc.path.startsWith(`${target.docs_path}/`)));
      const entry = (target.docs_path === "." ? documents.find(doc => doc.path === "docs/README.md") : undefined) ?? documents.find(doc => doc.path === (target.docs_path === "." ? "README.md" : `${target.docs_path}/README.md`)) ?? documents.find(doc => doc.path === (target.docs_path === "." ? "index.md" : `${target.docs_path}/index.md`))
        ?? documents.find(doc => job.documents.find(old => old.id === doc.id)?.path.toLowerCase() === "agents.md")
        ?? documents.find(doc => /\/(?:README|index)\.md$/i.test(doc.path)) ?? documents[0];
      if (entry) navigation.set(entry.id, [...(navigation.get(entry.id) ?? []), ...renamed.filter(doc => doc.id !== entry.id && !doc.deleted)]);
    }
    const pathMaps = new Map(targets.map(target => {
      const group = archiveCollisionGroup(target), groupIds = new Set(targets.filter(other => archiveCollisionGroup(other) === group).map(other => other.id));
      const related = job.documents.filter(doc => groupIds.has(doc.target_id)), counts = new Map<string, number>();
      for (const document of related) counts.set(document.path, (counts.get(document.path) ?? 0) + 1);
      const paths = new Map(related.filter(doc => counts.get(doc.path) === 1).map(doc => [doc.path, candidate.documents.find(next => next.id === doc.id)!.path]));
      for (const doc of related.filter(doc => doc.target_id === target.id)) paths.set(doc.path, candidate.documents.find(next => next.id === doc.id)!.path);
      return [target.id, paths] as const;
    }));
    for (const doc of candidate.documents) {
      if (confirmedDeletions.has(doc.id)) continue;
      const old = job.documents.find(document => document.id === doc.id)!;
      assertModuleKnowledgePath(candidate, targets.find(target => target.id === doc.target_id)!, doc.path);
      const paths = pathMaps.get(doc.target_id)!;
      if (organized) {
        doc.content = relocateMarkdownLinks(old.content, old.path, doc.path, paths);
        doc.sources = relocateMarkdownLinks(old.sources, old.path, doc.path, paths);
      }
      const links = navigation.get(doc.id)?.map(other => `- [${other.title.replace(/[\r\n]/g, " ").replace(/[\\[\]]/g, "\\$&")}](${encodeURI(posix.relative(posix.dirname(doc.path), other.path)).replace(/[?#()]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)})`).join("\n");
      if (links) doc.content += `\n\n## 保留的相关文稿\n\n${links}\n`;
      if (organized && (job.knowledge_layout !== candidate.knowledge_layout || doc.title !== old.title || doc.path !== old.path || doc.content !== old.content || doc.sources !== old.sources)) {
        doc.history.push({ revision: old.revision, title: old.title, path: old.path, deleted: old.deleted, content: old.content, sources: old.sources,
          operator: requireRepository && this.canArchiveWithLayoutMigration(job) ? CONFIRMED_ARCHIVE_DIRECTORY_CHANGE : REPOSITORY_LAYOUT_MIGRATION, at: new Date().toISOString() });
        doc.revision = old.revision + 1; doc.human_edited = true;
      }
      for (const turn of candidate.turns) for (const proposal of turn.proposals.filter(proposal => proposal.status === "pending" && proposal.document.id === doc.id)) {
        const oldPath = proposal.document.path;
        proposal.document.path = doc.path;
        if (organized) {
          proposal.document.content = relocateMarkdownLinks(proposal.document.content, oldPath, doc.path, paths);
          proposal.document.sources = relocateMarkdownLinks(proposal.document.sources, oldPath, doc.path, paths);
        }
        if (links) proposal.document.content += `\n\n## 保留的相关文稿\n\n${links}\n`;
        if (proposal.base_revision === old.revision) proposal.base_revision = doc.revision;
      }
    }
    const paths = new Set<string>();
    for (const doc of candidate.documents.filter(d => (organized || d.selected) && !confirmedDeletions.has(d.id))) {
      const target = targets.find(t => t.id === doc.target_id)!;
      if (requireRepository && doc.selected) repository(target, target.id);
      const key = JSON.stringify([archiveCollisionGroup(target), doc.path.toLowerCase()]);
      if (paths.has(key)) throw new Error(`多个知识文档指向同一个目标文件 ${doc.path}，请在 Git 归档设置中调整文件路径`);
      paths.add(key);
    }
    this.assertModuleDirectories(candidate);
    candidate.source_repositories ??= structuredClone(job.repositories);
    if (requireRepository) candidate.archive_configured = true;
    candidate.archive_revision = (job.archive_revision ?? 0) + (requireRepository || job.knowledge_layout !== candidate.knowledge_layout || JSON.stringify(job.documents) !== JSON.stringify(candidate.documents) ? 1 : 0);
    return candidate;
  }
  private materialIds(ids: unknown): string[] {
    if (!Array.isArray(ids) || ids.length > 30 || ids.some(id => typeof id !== "string")) throw new Error("最多关联 30 份资料");
    const unique = [...new Set(ids)] as string[];
    const bytes = unique.reduce((sum, id) => {
      const material = readKnowledgeMaterial(join(this.dataDir, "knowledge-materials"), id);
      if (material.state !== "ready") throw new Error(`资料 ${material.name} 解析失败，请重新上传或移除后再开始研究：${material.error ?? "没有可读内容"}`);
      return sum + material.bytes;
    }, 0);
    if (bytes > 100 * 1024 * 1024) throw new Error("本次资料总容量不能超过 100 MiB");
    return unique;
  }
  run(id: string, input: { mode: DomainTurn["mode"]; document_ids?: string[]; message?: string; use_latest_skill?: boolean; material_ids?: string[]; review_note_ids?: string[] }, operator: string) {
    if (this.stopped) throw new Error("服务正在停止");
    const job = this.live(id);
    if (job.publications.some(publication => publication.mr_state === "merged")) throw new Error("此任务 MR 已合入，请从正式知识库开始新的检视");
    if (job.component_research_id) throw new Error("请在基础组件萃取任务中生成修订建议");
    if (job.status === "paused") throw new Error("请先答复当前待确认内容，再继续研究");
    if (this.running.has(id) || this.publishing.has(id) || ["queued", "running"].includes(job.status)) throw new Error("请等待本轮完成或停止后继续");
    if (!["extract", "discuss", "revise", "update"].includes(input.mode)) throw new Error("未知研究操作");
    const ids = [...new Set(input.document_ids ?? [])], message = String(input.message ?? "").trim();
    if (input.mode !== "extract" && (!ids.length || ids.some(docId => !job.documents.some(doc => doc.id === docId)))) throw new Error("请选择本轮处理的文档");
    if (!message || message.length > 20000) throw new Error("请填写本轮问题或修订要求，最多 20000 字");
    const reviewNoteIds = input.review_note_ids === undefined ? undefined : [...new Set(readDomainReviewNoteBatch(this.dataDir, id, input.review_note_ids).map(note => note.id))];
    if (reviewNoteIds && input.mode !== "revise") throw new Error("检视意见只用于文稿修订");
    scanForSecrets("研究意见", Buffer.from(message));
    if (input.material_ids) job.material_ids = this.materialIds(input.material_ids);
    if (input.mode === "extract" && job.source_cleanup) job.source_cleanup.started = true;
    const turn: DomainTurn = { id: randomUUID(), mode: input.mode, document_ids: ids, message, operator, status: "queued", created_at: new Date().toISOString(), proposals: [], use_latest_skill: input.use_latest_skill === true };
    if (job.task_kind === "inspection" && input.mode === "revise") turn.revisions = { ...job.revisions };
    if (reviewNoteIds) turn.review_note_ids = reviewNoteIds;
    if (input.mode === "update") { turn.previous_revisions = { ...job.revisions }; job.revisions = {}; }
    job.turns.push(turn); job.status = "queued"; job.stage = "等待研究"; job.error = undefined;
    this.persist(job); this.pump(); return this.get(id);
  }
  resume(id: string, operator: string, useLatestSkill = false, reply?: { request_id: string; message: string }) {
    if (this.stopped) throw new Error("服务正在停止");
    const job = this.live(id), turn = job.turns.at(-1);
    if (job.component_research_id || this.running.has(id) || this.publishing.has(id) || !turn
        || !["failed", "cancelled", "done", "paused"].includes(job.status)) throw new Error("当前任务不能接续");
    if (job.status === "done" && turn.mode !== "extract") throw new Error("请选择文档发起新的修订");
    if (job.status === "paused") {
      if (!reply) throw new Error("请提交本次待确认内容的答复");
      if (reply.request_id !== turn.waiting?.id) throw new Error("待确认内容已变化，请刷新后重新答复");
      if (typeof reply.message !== "string" || !reply.message.trim() || reply.message.length > 20000) throw new Error("请填写答复，最多 20000 字");
      scanForSecrets("研究答复", Buffer.from(reply.message));
    } else if (reply) throw new Error("待确认内容已变化，请刷新后重新答复");
    // 答复先保存成功再启动；写盘失败不能在内存里替人消耗这次确认。
    const next = structuredClone(job), nextTurn = next.turns.at(-1)!;
    if (reply) (nextTurn.human_replies ??= []).push({ request_id: reply.request_id, message: reply.message, operator, at: new Date().toISOString() });
    delete nextTurn.waiting;
    nextTurn.pipeline_continue = (nextTurn.pipeline_continue ?? 0) + 1;
    nextTurn.status = "queued"; nextTurn.operator = operator; nextTurn.error = undefined;
    if (useLatestSkill) { nextTurn.use_latest_skill = true; nextTurn.skill = undefined; }
    if (nextTurn.research) { nextTurn.research.phase = "research"; nextTurn.research.finish_requested = false; }
    next.status = "queued"; next.stage = "接续原研究会话"; next.error = undefined;
    this.persist(next); Object.assign(job, next); this.pump(); return this.get(id);
  }
  private validateDocument(job: DomainKnowledgeJob, input: DomainDocumentContent, documents = job.documents) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(input.id) || !input.title?.trim() || input.title.length > 160 || !input.content?.trim() || !input.sources?.trim()) throw new Error("文档需要稳定编号、标题、正文与来源");
    const maxBytes = (job.component_research_id ? 16 : 2) * 1024 * 1024;
    if (Buffer.byteLength(input.content) > maxBytes) throw new Error(`单份草稿不能超过 ${maxBytes / 1024 / 1024} MiB`);
    const target = [job.knowledge_target, ...job.repositories].find(r => r.id === input.target_id);
    if (!target || input.layer !== (target.id === "domain" ? "domain" : "repository")) throw new Error("领域文档进入知识仓，仓内文档进入对应业务仓");
    const path = knowledgeRelativePath(input.path, true);
    assertModuleKnowledgePath(job, target, path);
    const targets = [job.knowledge_target, ...job.repositories];
    const occupied = documents.find(doc => {
      const other = targets.find(candidate => candidate.id === doc.target_id);
      return doc.id !== input.id && (doc.target_id === input.target_id || !!target.repository
        && other?.repository === target.repository && other.branch === target.branch) && (doc.archive_path ?? doc.path) === path;
    });
    if (occupied) throw new Error(occupied.target_id !== input.target_id
      ? `${path} 指向同一归档仓和分支的另一篇文稿，请使用其他路径`
      : "该目标文件已有草稿或修订建议，请更新原编号或使用其他路径");
    scanForSecrets("领域知识草稿", Buffer.from(JSON.stringify(input)));
  }
  private reviewProposals(turns: readonly DomainTurn[]): ReviewProposal<DomainDocumentContent>[] {
    return turns.flatMap(turn => turn.proposals.map(proposal => ({ turn_id: turn.id, document_id: proposal.document.id,
      turn_status: turn.status, status: proposal.status, base_revision: proposal.base_revision, value: proposal.document })));
  }
  private pump() {
    if (this.stopped) return;
    for (const job of this.jobs.values()) {
      if (!this.capacity.canStart()) return;
      if (job.deleted_at || job.status !== "queued" || this.running.has(job.id)) continue;
      const turn = job.turns.find(t => t.status === "queued")!;
      const controller = new AbortController(), base = structuredClone(job.documents);
      let release!: () => void;
      const entry: DomainRunning = { controller, turn, work: Promise.resolve(), released: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
      turn.document_revisions ??= Object.fromEntries(base.map(doc => [doc.id, doc.revision]));
      const proposals = this.reviewProposals(job.turns), turnIds = job.turns.map(turn => turn.id);
      const workingDocuments = base.map(doc => {
        if (turn.mode === "extract") return doc;
        const proposal = continuingReviewProposal(proposals, doc.id, doc.revision, turn.id, turnIds);
        // 后续意见接着已完成的新稿修改，正文与发布基线仍等人工确认。
        return proposal ? { ...doc, ...proposal.value, deleted: false, ...(doc.archive_path ? { archive_path: proposal.value.path } : {}) } : doc;
      });
      job.status = "running"; job.stage = "研究中"; turn.status = "running"; turn.started_at = new Date().toISOString(); turn.finished_at = undefined; this.persist(job);
      const work = Promise.resolve().then(async () => {
        try {
          if (controller.signal.aborted) return;
          const result = await this.execute({ job: { ...this.get(job.id), documents: structuredClone(workingDocuments) }, turn: structuredClone(turn), root: this.root(job.id), signal: controller.signal,
            read: () => structuredClone(workingDocuments),
            update: patch => { if (!controller.signal.aborted && !job.deleted_at) { const { research, ...rest } = patch; Object.assign(job, rest); if (research) turn.research = structuredClone(research); if (patch.skill) turn.skill = patch.skill; if (patch.revisions) turn.revisions = { ...turn.revisions, ...patch.revisions }; this.persist(job); } },
            evidence: event => { if (!controller.signal.aborted && !job.deleted_at) { scanForSecrets("研究记录", Buffer.from(JSON.stringify(event))); this.store.appendEvidence(join(this.root(job.id), "job.json"), job, { at: new Date().toISOString(), ...event }); } },
            remove: documentId => {
              if (controller.signal.aborted || job.deleted_at) throw new Error("本轮已停止");
              if (turn.mode === "discuss") throw new Error("讨论不修改文档");
              const document = job.documents.find(document => document.id === documentId);
              if (!document) throw new Error("文稿不存在或不在本次任务范围");
              if (!document.deleted) {
                document.history.push({ revision: document.revision, title: document.title, path: document.path, content: document.content,
                  sources: document.sources, deleted: document.deleted, operator: "领域研究 Agent", at: new Date().toISOString() });
                document.deleted = true; document.selected = true; document.revision++;
                turn.document_revisions![documentId] = document.revision;
              }
              for (const proposal of job.turns.flatMap(turn => turn.proposals)) if (proposal.document.id === documentId && proposal.status === "pending") proposal.status = "discarded";
              const working = workingDocuments.find(current => current.id === documentId);
              if (working) Object.assign(working, structuredClone(document));
              this.persist(job); return structuredClone(document);
            },
            save: (input, baseline) => {
              if (controller.signal.aborted || job.deleted_at) throw new Error("本轮已停止");
              if (turn.mode === "discuss") throw new Error("讨论不修改文档");
              // Model output is content only; publication and human-review fields
              // are exclusively managed by explicit service operations.
              input = { id: input.id, title: input.title, target_id: input.target_id, path: knowledgeRelativePath(input.path, true), layer: input.layer, content: input.content, sources: input.sources };
              this.validateDocument(job, input, workingDocuments);
              const existing = job.documents.find(doc => doc.id === input.id);
              if (existing && (existing.target_id !== input.target_id || existing.layer !== input.layer)) throw new Error("已有文档不能改变归档仓或文档层级");
              if (!existing) {
                const created: DomainDocument = { ...structuredClone(input), revision: 1, research_turn_id: turn.id, selected: true, base_content: baseline?.content ?? null, base_revision: baseline?.revision ?? "", history: [] };
                job.documents.push(created);
                workingDocuments.push(structuredClone(created));
                turn.document_revisions![input.id] = 1;
                this.persist(job); return structuredClone(input);
              }
              const owned = existing.research_turn_id === turn.id || (!existing.research_turn_id && existing.revision === 1 && !existing.history.length);
              const protectedDraft = !owned || existing.human_edited || existing.knowledge_document_id
                || [...job.publications, ...(job.publication_history ?? [])].some(publication => publication.documents.some(document => document.id === existing.id));
              if (turn.mode !== "extract" || protectedDraft) {
                const previous = turn.proposals.find(p => p.document.id === input.id);
                turn.proposals = [...turn.proposals.filter(p => p.document.id !== input.id), { document: structuredClone(input), base_revision: previous?.base_revision ?? turn.document_revisions![input.id], status: "pending" }];
                const working = workingDocuments.find(doc => doc.id === input.id)!;
                if (working.archive_path) working.archive_path = input.path;
                Object.assign(working, structuredClone(input), { deleted: false });
                this.persist(job);
              } else {
                // Continuing an interrupted extraction must preserve already completed or edited documents.
                if (existing) {
                  if (!existing.deleted && Object.entries(input).every(([key, value]) => existing[key as keyof DomainDocument] === value)) return structuredClone(input);
                  existing.history.push({ revision: existing.revision, title: existing.title, path: existing.path, deleted: existing.deleted, content: existing.content, sources: existing.sources, operator: "领域研究 Agent", at: new Date().toISOString() });
                  if (existing.path !== input.path) {
                    existing.base_path ??= existing.path;
                    if (existing.archive_path) existing.archive_path = input.path;
                  }
                  Object.assign(existing, input, { deleted: false, revision: existing.revision + 1, research_turn_id: turn.id });
                  Object.assign(workingDocuments.find(document => document.id === existing.id)!, structuredClone(existing));
                  this.persist(job); return structuredClone(input);
                }
              }
              return structuredClone(input);
            },
          });
          if (controller.signal.aborted || job.deleted_at) return;
          const reply = typeof result === "string" ? result : result.summary;
          if (!reply.trim()) throw new Error("本轮没有返回结果");
          scanForSecrets("研究答复", Buffer.from(reply));
          const paused = typeof result !== "string" && result.status === "paused";
          if (!paused && turn.mode === "extract" && !job.documents.length) throw new Error("尚未生成领域知识草稿，已保存内容保留");
          // Agent 按仓编号（repo-1 等）引用代码以便校验；给人看的回复换成仓名，路径与行号保留。
          const named = (job.source_repositories ?? job.repositories).reduce((text, repo) => text.split(`${repo.id}:`).join(`${repo.name}:`), reply);
          turn.reply = named; turn.finished_at = new Date().toISOString();
          if (paused) {
            turn.waiting = { id: randomUUID(), summary: named, document_ids: result.document_ids, work_document_ids: result.work_document_ids ?? [] };
            turn.status = "paused"; job.status = "paused"; job.stage = "等待你确认或补充";
          } else { turn.status = "done"; job.status = "done"; job.stage = "本轮完成，等待审查"; }
        } catch (error) {
          if (controller.signal.aborted || job.deleted_at) return;
          turn.status = "failed"; turn.finished_at = new Date().toISOString(); job.status = "failed"; job.error = turn.error = error instanceof Error ? error.message : "研究失败"; job.stage = error instanceof IncompleteDomainResearch ? "研究尚未完成，草稿与进度保留" : "本轮失败，已有文档保留";
        } finally { if (!controller.signal.aborted && this.running.get(job.id) === entry) this.persist(job); }
      }).finally(() => {
        // 强制释放后可能已有新一轮，旧 finally 不能释放新一轮的槽位或再落旧盘。
        if (this.running.get(job.id) !== entry) return;
        clearTimeout(entry.stopTimer); this.running.delete(job.id); entry.release(); this.capacity.wake();
      });
      entry.work = work; this.running.set(job.id, entry);
    }
  }
  private assertEditable(job: DomainKnowledgeJob) {
    if (job.publications.some(publication => publication.mr_state === "merged")) throw new Error("此任务 MR 已合入，请从正式知识库开始新的检视");
    let status = job.status;
    if (job.component_research_id) {
      const path = join(this.dataDir, "component-research", job.component_research_id, "record.json");
      if (existsSync(path)) {
        try { status = JSON.parse(readFileSync(path, "utf8")).status; }
        catch { throw new Error(`请检查损坏的知识记录：component-research/${job.component_research_id}/record.json`); }
      }
    }
    if (["queued", "running"].includes(status)) throw new Error("研究进行中：请先停止，或等本轮结束后再改");
  }
  private editableDocument(id: string, input: { document: DomainDocumentContent; base_revision: number }) {
    const job = this.live(id), doc = job.documents.find(d => d.id === input.document?.id);
    this.assertEditable(job);
    if (!doc || this.publishing.has(id)) throw new Error("文档不存在或正在归档");
    assertReviewRevision(doc.revision, input.base_revision, "文档已有新版本，请比较差异后重新保存");
    this.validateDocument(job, input.document);
    if (doc.target_id !== input.document.target_id || doc.layer !== input.document.layer) throw new Error("不能通过编辑改变归档仓或文档层级");
    return { job, doc };
  }
  edit(id: string, input: { document: DomainDocumentContent; base_revision: number }, operator: string) {
    input = { ...input, document: { ...input.document, path: knowledgeRelativePath(input.document.path, true) } };
    const { job, doc } = this.editableDocument(id, input);
    doc.history.push({ revision: doc.revision, title: doc.title, path: doc.path, deleted: doc.deleted, content: doc.content, sources: doc.sources, operator, at: new Date().toISOString() });
    if (doc.deleted && doc.knowledge_document_id && knowledgeDeleted(this.dataDir, doc.knowledge_document_id)) {
      delete doc.knowledge_document_id; delete doc.published_revision; delete doc.published_document_revision; delete doc.published_at;
    }
    if (doc.path !== input.document.path) {
      doc.base_path ??= doc.path;
      if (doc.archive_path) doc.archive_path = input.document.path;
    }
    Object.assign(doc, { deleted: false, title: input.document.title, path: input.document.path, content: input.document.content, sources: input.document.sources, revision: doc.revision + 1, human_edited: true }); this.persist(job); return this.get(id);
  }
  decide(id: string, turnId: string, documentId: string, decision: "accept" | "discard", operator: string) {
    const job = this.live(id), turn = job.turns.find(t => t.id === turnId), proposal = turn?.proposals.find(p => p.document.id === documentId);
    if (turn && ["queued", "running"].includes(turn.status)) throw new Error("本轮仍在生成修订建议，请等待完成");
    if (!proposal || !["accept", "discard"].includes(decision)) throw new Error("修订建议或操作无效");
    if (decision === "accept" && ["queued", "running"].includes(job.status)) throw new Error("当前研究仍在进行，请等待完成后再确认修改");
    if (proposal.status !== "pending") return this.get(id);
    if (decision === "accept") {
      const document = job.documents.find(document => document.id === documentId);
      if (!document) throw new Error("文档不存在或正在归档");
      assertLatestReviewProposal(this.reviewProposals(job.turns), turnId, documentId, document.revision, ["queued", "running"].includes(job.status));
      this.edit(id, { document: proposal.document, base_revision: proposal.base_revision }, operator);
      for (const old of job.turns.flatMap(item => item.proposals)) if (old !== proposal && old.document.id === documentId && old.status === "pending") old.status = "discarded";
    }
    proposal.status = decision === "accept" ? "accepted" : "discarded"; this.persist(job); return this.get(id);
  }
  restore(id: string, documentId: string, revision: number, baseRevision: number, operator: string) {
    this.assertEditable(this.live(id));
    const doc = this.live(id).documents.find(d => d.id === documentId), previous = doc?.history.find(h => h.revision === revision);
    if (!doc || !previous) throw new Error("历史版本不存在");
    this.edit(id, { document: { ...doc, path: previous.path ?? doc.path, content: previous.content, title: previous.title, sources: previous.sources }, base_revision: baseRevision }, operator);
    this.persist(this.live(id)); return this.get(id);
  }
  select(id: string, ids: string[], selected: boolean) {
    const job = this.live(id);
    if (this.publishing.has(id) || !Array.isArray(ids) || typeof selected !== "boolean" || ids.some(docId => !job.documents.some(d => d.id === docId))) throw new Error("请选择有效文档，归档时不能调整清单");
    job.documents.forEach(doc => { if (ids.includes(doc.id)) doc.selected = selected; }); this.persist(job); return this.get(id);
  }
  stop(id: string) {
    const job = this.live(id);
    if (["queued", "running", "paused"].includes(job.status)) {
      job.status = "cancelled"; job.stage = "已停止，草稿保留";
      job.turns.filter(t => ["queued", "running", "paused"].includes(t.status)).forEach(t => { if (t.status === "running") t.finished_at = new Date().toISOString(); t.status = "cancelled"; delete t.waiting; });
      const entry = this.running.get(id);
      if (entry) this.stopExecution(job, entry);
      this.persist(job);
    }
    return this.get(id);
  }
  private stopExecution(job: DomainKnowledgeJob, entry: DomainRunning) {
    entry.controller.abort();
    if (entry.stopTimer) return;
    entry.stopTimer = setTimeout(() => {
      if (this.running.get(job.id) !== entry) return;
      this.running.delete(job.id); entry.release();
      try {
        if (!job.deleted_at) {
          job.status = "failed"; job.stage = STOP_TIMEOUT; job.error = STOP_TIMEOUT;
          entry.turn.status = "failed"; entry.turn.error = STOP_TIMEOUT;
          try { this.persist(job); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            const reason = `${code ? `${code}：` : ""}${error instanceof Error ? error.message : String(error)}`;
            job.error = `${STOP_TIMEOUT}；状态记录保存失败：${reason}`;
            entry.turn.error = job.error;
            this.readWarnings.push(`请检查状态记录保存失败：domain-extraction/${job.id}/job.json；${reason}；并发槽位已释放`);
          }
        }
      } finally { this.capacity.wake(); }
    }, STOP_BUDGET_MS);
    entry.stopTimer.unref?.();
  }
  deletionView(id: string) {
    const job = this.live(id);
    const archive_batches = (job.archive_batches ?? []).filter(batch => !!batch.issue_no && ["pending", "running", "failed"].includes(batch.state))
      .map(batch => ({ id: batch.id, state: batch.state, error: batch.error,
        documents: batch.documents.map(document => ({ id: document.id, title: document.title, path: document.path })),
        publications: batch.publications.map(publication => ({ target_id: publication.target_id, branch: publication.branch,
          state: publication.state, url: publication.url, error: publication.error })) }));
    return { title: job.title, archive_batches, message: archive_batches.length
      ? "以下人工归档尚未完成。删除任务会保留已发布知识、来源记录和 MR 历史；请先在本任务完成归档或手动重试。"
      : "删除任务会保留已发布知识、来源记录和 MR 历史。MR 后续合入由人处理。" };
  }
  remove(id: string, operator: string) {
    const existing = this.jobs.get(id);
    if (existing?.deleted_at) return { deleted: true };
    const job = this.live(id);
    if (job.component_research_id) throw new Error("请在基础组件萃取中管理对应任务");
    if (this.publishing.has(id)) throw new Error("正在发布或归档，请等待当前操作完成后再删除");
    this.stop(id);
    // Keep source and MR history for published knowledge, as component task deletion does.
    job.deleted_at = new Date().toISOString(); job.deleted_by = operator;
    this.persist(job); this.pump(); return { deleted: true };
  }
  setIssueNumber(id: string, value: unknown, description?: unknown) {
    const job = this.live(id), issue = knowledgeIssueNumber(value);
    const nextDescription = knowledgeIssueDescription(description) ?? (job.issue_no === issue ? job.issue_description : undefined);
    if (this.publishing.has(id)) throw new Error("正在创建 MR，请稍后修改关联单号和描述");
    if (job.issue_no === issue && job.issue_description === nextDescription) return this.get(id);
    job.issue_no = issue; job.issue_description = nextDescription;
    this.persist(job); return this.get(id);
  }
  async publish(id: string, _operator: string, _input: { document_ids?: string[]; expected_revisions?: Record<string, number> } = {}): Promise<DomainKnowledgeJob> {
    if (this.live(id).component_research_id) throw new Error("组件知识请在基础组件萃取任务中修改和发布");
    throw new Error("领域任务文稿请直接创建 MR；正式知识库在合入后同步，无需先发布");
  }
  async shutdown() {
    this.stopped = true;
    const errors: unknown[] = [];
    for (const job of this.jobs.values()) if (!job.deleted_at && ["queued", "running"].includes(job.status)) {
      job.status = "queued"; job.stage = "等待接续原研究会话";
      for (const turn of job.turns) if (["queued", "running"].includes(turn.status)) turn.status = "queued";
      try { this.persist(job); }
      catch (error) {
        errors.push(error);
        this.readWarnings.push(`请检查关停记录保存失败：domain-extraction/${job.id}/job.json；${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const [id, entry] of this.running) this.stopExecution(this.jobs.get(id)!, entry);
    // 发布器取消 Git 与研究停止并行使用同一个预算，不能串行各等 60 秒。
    const settling = Promise.allSettled([...this.running.values()].map(r => r.released)
      .concat([...this.archiving.values()], Promise.resolve().then(() => this.options.shutdown?.())));
    let timer: ReturnType<typeof setTimeout> | undefined, expired = false;
    try { await Promise.race([settling, new Promise<void>(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, STOP_BUDGET_MS); timer.unref?.(); })]); }
    finally {
      clearTimeout(timer);
      // 已关停的管理器不再拥有这些异步操作；迟到回调须按原 owner 丢弃，不能覆盖新实例。
      this.publishing.clear(); this.archiving.clear();
      if (expired) for (const job of this.jobs.values()) {
        const active = job.archive_batches?.filter(batch => batch.state === "running") ?? [];
        if (!active.length) continue;
        const reason = "知识归档停止超时：操作 60 秒内未退出，已停止等待";
        for (const batch of active) {
          batch.state = "failed"; batch.error = reason;
          for (const publication of batch.publications) if (publication.state === "pending") {
            publication.state = "failed"; publication.error = reason;
            const current = job.publications.find(current => current.target_id === publication.target_id && current.branch === publication.branch);
            if (current) { current.state = "failed"; current.error = reason; }
          }
        }
        try { this.persist(job); }
        catch { this.readWarnings.push(`请检查归档停止记录的保存失败：domain-extraction/${job.id}/job.json`); }
      }
    }
    if (errors.length) throw new AggregateError(errors, "领域知识关停记录保存失败，执行体与发布器已停止等待");
  }
}
