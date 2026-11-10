import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DomainKnowledgeJob } from "./domainKnowledgeTypes.ts";
import type { ResearchRecord } from "./componentResearch.ts";
import type { ExtractionJobRecord } from "./knowledgeExtraction.ts";
import { listSkillSubmissions, type SkillSubmissionRecord } from "./hostSkillLibrary.ts";
import type { KnowledgeTaskCenterData, KnowledgeTaskRow } from "./knowledgeTaskCenterTypes.ts";
import { projectKnowledgeProduction } from "./knowledgeProductionState.ts";
import { listKnowledgeDocumentFacts } from "./knowledgeDocuments.ts";
import { latestModuleKnowledgeTasks } from "./knowledgeTaskModules.ts";

function validTime(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** 与研究详情一样按追加顺序取最新公开文字，不把工具输出当成思考。 */
export function latestKnowledgeResearchNote(evidence: Array<Record<string, unknown>>): KnowledgeTaskRow["latest_note"] {
  for (let index = evidence.length - 1; index >= 0; index--) {
    const item = evidence[index];
    if (item.tool !== "research_note" || typeof item.preview !== "string") continue;
    const text = item.preview.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (text) return { text, at: validTime(item.at) };
  }
  return undefined;
}

function projection(input: Parameters<typeof projectKnowledgeProduction>[0]) {
  const production = (input.kind === "domain" || input.kind === "component" && !input.archive) && input.record.production ? input.record.production : projectKnowledgeProduction(input);
  return { status_label: production.status_label, group: production.group, next_action: production.next_action, production };
}
export function domainKnowledgeTask(job: DomainKnowledgeJob): KnowledgeTaskRow {
  // 只看最近一轮：新一轮还在排队时显示「—」，不把上一轮的历时当成这一轮的。
  const ran = job.turns.at(-1);
  const state = projection({ kind: "domain", record: job });
  const formalId = job.documents.find(document => !document.deleted && document.knowledge_document_id)?.knowledge_document_id;
  const archived = state.production.archive.state === "opened" && !state.production.working && !state.production.documents.some(document => document.changed);
  const saved = job.documents.filter(document => !document.deleted && document.content.trim());
  const published = saved.filter(document => !!document.knowledge_document_id && document.published_document_revision === document.revision).length;
  const process = job.work_documents?.length ?? 0;
  return { id: job.id, kind: "domain", title: job.title, scope: job.scope, operator: job.operator,
    task_kind: job.task_kind ?? "extraction",
    module_id: job.module_id,
    module_entry: archived && formalId ? { kind: "document", document_id: formalId } : { kind: "task" },
    document_summary: { total: saved.length + process, published, drafts: saved.length - published, process },
    created_at: validTime(job.created_at), started_at: validTime(ran?.started_at), finished_at: validTime(ran?.finished_at), status: job.status, ...state,
    stage: job.stage, error: job.error, latest_note: latestKnowledgeResearchNote(job.evidence) };
}
export function componentKnowledgeTask(record: ResearchRecord, archive?: DomainKnowledgeJob): KnowledgeTaskRow {
  return { id: record.id, kind: "component", title: record.topic || `${record.language} 基础组件萃取`, scope: record.language,
    operator: record.operator, created_at: validTime(record.created_at), started_at: validTime(record.started_at), finished_at: validTime(record.finished_at),
    status: record.status, ...projection({ kind: "component", record, archive }), stage: record.stage, error: record.error,
    latest_note: latestKnowledgeResearchNote(record.evidence) };
}
export function skillExtractionTask(record: ExtractionJobRecord): KnowledgeTaskRow {
  return { id: record.id, kind: "skill-extraction", title: record.intent, scope: record.repo, operator: record.operator,
    created_at: validTime(record.created_at), started_at: validTime(record.started_at), finished_at: validTime(record.finished_at), status: record.status,
    ...projection({ kind: "skill-extraction", record }), error: record.error };
}
export function skillSubmissionTask(record: SkillSubmissionRecord): KnowledgeTaskRow {
  return { id: `${record.directory}/${record.id}`, kind: "skill-submission", title: record.directory,
    scope: [...record.business_module_ids ?? [], ...record.technologies ?? []].join(" · "), operator: record.operator,
    created_at: validTime(record.created_at), status: record.status, ...projection({ kind: "skill-submission", record }),
    error: record.reject_reason, stage: record.decided_at ? `审核时间 ${record.decided_at}` : "请审查 Skill 包，通过后上架" };
}

export interface KnowledgeTaskSources {
  dataDir: string;
  warnings?(): string[];
  domain: { taskRows?(): Array<KnowledgeTaskRow & { module_id?: string }>; list(): Array<{ id: string }>; get(id: string): DomainKnowledgeJob; componentArchive?(id: string): DomainKnowledgeJob | undefined; warnings?(): string[] };
  component: { taskRows?(): KnowledgeTaskRow[]; list(summaryOnly?: boolean): ResearchRecord[]; get(id: string): ResearchRecord; warnings?(): string[] };
  skillExtractionJob(id: string): ExtractionJobRecord | undefined;
}

/** 只读投影：各自的研究记录仍是状态来源，中心不保存第二份任务。 */
export function listKnowledgeTasks(sources: KnowledgeTaskSources): KnowledgeTaskCenterData {
  const tasks: KnowledgeTaskRow[] = [], warnings: string[] = [];
  warnings.push(...sources.warnings?.() ?? []);
  warnings.push(...sources.domain.warnings?.() ?? [], ...sources.component.warnings?.() ?? []);
  listKnowledgeDocumentFacts(sources.dataDir, warnings);
  const collect = (label: string, read: () => void) => {
    try { read(); } catch { warnings.push(`${label}暂时无法读取，请在原任务入口查看`); }
  };
  collect("领域萃取", () => {
    if (sources.domain.taskRows) {
      for (const task of sources.domain.taskRows()) {
        tasks.push(task);
      }
      return;
    }
    for (const job of sources.domain.list()) {
      const record = sources.domain.get(job.id);
      tasks.push(domainKnowledgeTask(record));
    }
  });
  collect("基础组件萃取", () => {
    if (sources.component.taskRows) { tasks.push(...sources.component.taskRows()); return; }
    for (const record of sources.component.list()) {
      tasks.push(componentKnowledgeTask(record, sources.domain.componentArchive?.(record.id)));
    }
  });
  collect("Skill 制作", () => {
    const root = join(sources.dataDir, "knowledge-extract");
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^ke-[a-z0-9-]{1,61}$/.test(entry.name)) continue;
      // 沿用现有读取方法，重启中断的记录不会显示为仍在运行。
      const record = sources.skillExtractionJob(entry.name);
      if (record) tasks.push(skillExtractionTask(record));
    }
  });
  collect("Skill 导入", () => tasks.push(...listSkillSubmissions(sources.dataDir, warnings).map(record => skillSubmissionTask({ ...record, business_module_ids: resolveBusinessModuleIds(sources.dataDir, record.business_module_ids) }))));
  // get() 可能在读取精确正式ID时发现坏文件，中心须在本次响应就给出告警。
  warnings.push(...sources.domain.warnings?.() ?? [], ...sources.component.warnings?.() ?? []);
  warnings.splice(0, warnings.length, ...new Set(warnings));
  tasks.sort((a, b) => Date.parse(b.created_at ?? b.started_at ?? "") - Date.parse(a.created_at ?? a.started_at ?? "") || a.id.localeCompare(b.id));
  // 文稿与建设状态必须来自同一次萃取，不能被更早的在途任务覆盖。
  const moduleActivity = new Map<string, { module_id: string; status_label: string; task_id: string }>();
  for (const [moduleId, task] of latestModuleKnowledgeTasks(tasks)) {
    if (task.group === "running") {
      moduleActivity.set(moduleId, { module_id: moduleId, status_label: "建设中", task_id: task.id });
    }
  }
  return { tasks, warnings, module_activity: [...moduleActivity.values()], summary: {
    running: tasks.filter(task => task.group === "running").length,
    attention: tasks.filter(task => task.group === "attention").length,
    total: tasks.length,
  } };
}
