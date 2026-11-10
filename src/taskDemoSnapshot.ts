import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { AnnotationStore, type Annotation, type AnnotationOperation } from "./annotations.ts";
import { listArtifactsAsync, type ArtifactMeta } from "./artifacts.ts";
import { buildConversation, type ConversationView } from "./conversation.ts";
import { developerAssistantConversation, readDeveloperAssistant } from "./developerAssistant.ts";
import { NotFoundError } from "./errors.ts";
import { FeedbackStore, type FeedbackRecord } from "./feedbackStore.ts";
import { HumanGate, type WaitingRecord } from "./humanGate.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import { kernelPhases } from "./kernelPhases.ts";
import type { MemoryUsageEvent } from "./memoryUsage.ts";
import { currentStoryFile } from "./overallStoryStore.ts";
import { isMainTaskDelivery } from "./requirementDecisionContract.ts";
import type { ReviewRequest } from "./reviews.ts";
import type { SemanticEvent } from "./semanticEvents.ts";
import { MEMORY_ARCHIVE_DIR, MEMORY_DIR, type MemoryLedgerRow, type MemoryRecord } from "./taskMemory.ts";
import type { TaskService, TaskSummary } from "./taskService.ts";

/** 真实任务的读取快照。演示中的修改只能作用于浏览器副本。 */
export interface TaskDemoSnapshot {
  schema: "mae-flow-demo-snapshot/1";
  captured_at: string;
  source_task_id: string;
  /** 与进度条使用同一内核文件，仅供演示定位已有记录。 */
  phase_steps?: Record<string, string[]>;
  /** 历史确认卡使用步骤标题，按内核目录关联到原步骤。 */
  step_titles?: Record<string, string>;
  /** 当时确认卡的原始上下文，按 waiting_id 与会话记录对应。 */
  card_contexts?: Record<string, { context?: string; preface?: string }>;
  task: TaskSummary;
  /** 仅文档元信息；正文和代码差异由原有只读接口按需读取。 */
  artifacts: ArtifactMeta[];
  conversation: ConversationView;
  annotations: { items: Annotation[] };
  reviews: ReviewRequest[];
  memories: Array<{ record: MemoryRecord; content: string }>;
  memoryUsage: Array<MemoryUsageEvent & { ts: string }>;
  problems: string[];
}

type SnapshotSource = Pick<TaskService,
  "storedTaskSummary" | "artifactRoot" | "panelFile" | "readDisplayEvents" | "options">;

function readPresentationProgress(service: SnapshotSource, task: TaskSummary,
  root: string | undefined, problems: string[]): TaskSummary["progress"] {
  const vocabulary = kernelPhases(root);
  if (!vocabulary) {
    problems.push("内核阶段目录暂时无法读取，演示沿用来源已有的进度记录");
    return task.progress;
  }
  let current = task.progress;
  const pulsePath = service.panelFile(task.id, "panel-pulse.js");
  if (pulsePath) {
    try {
      const text = readFileSync(pulsePath, "utf-8");
      const first = text.indexOf("{"), last = text.lastIndexOf("}");
      if (first < 0 || last <= first) throw new Error("脉冲格式不完整");
      const pulse = JSON.parse(text.slice(first, last + 1));
      current = {
        phases: vocabulary.names,
        current_index: vocabulary.names.indexOf(String(pulse.phase ?? "").trim()),
        current_phase: String(pulse.phase ?? "").trim(),
        ...(pulse.step ? { step_id: String(pulse.step) } : {}),
        ...(pulse.step_title ? { step: String(pulse.step_title) } : {}),
        ...(Number.isFinite(Number(pulse.revision)) ? { revision: Number(pulse.revision) } : {}),
      };
    } catch { problems.push("来源进度记录暂时无法读取，未重新生成或改写原记录"); }
  }
  const currentIndex = vocabulary.names.indexOf(current?.current_phase ?? "");
  if (currentIndex < 0) problems.push("来源任务的当前阶段尚无可用记录；演示可按进度条查看各阶段");
  return { ...current, phases: [...vocabulary.names], current_index: currentIndex,
    current_phase: currentIndex >= 0 ? vocabulary.names[currentIndex] : "" };
}

function readPhaseSteps(root: string | undefined): Record<string, string[]> | undefined {
  const vocabulary = kernelPhases(root);
  if (!root || !vocabulary) return undefined;
  try {
    const document = JSON.parse(readFileSync(join(root, "flow", "phases.json"), "utf-8"));
    if (document.schema !== "mae-flow-phases/1" || !Array.isArray(document.phases)) return undefined;
    return Object.fromEntries(document.phases.filter((phase: { name?: string; steps?: unknown }) =>
      vocabulary.names.includes(phase.name ?? "") && Array.isArray(phase.steps))
      .map((phase: { name: string; steps: unknown[] }) =>
        [phase.name, phase.steps.filter((step): step is string => typeof step === "string")]));
  } catch { return undefined; }
}

function readStepTitles(root: string | undefined): Record<string, string> | undefined {
  if (!root) return undefined;
  try {
    const document = JSON.parse(readFileSync(join(root, "flow", "flow.json"), "utf-8"));
    if (!document.steps || typeof document.steps !== "object" || Array.isArray(document.steps)) return undefined;
    return Object.fromEntries(Object.entries(document.steps).flatMap(([id, step]) => {
      const title = (step as { title?: unknown } | null)?.title;
      return typeof title === "string" && title.trim() ? [[id, title]] : [];
    }));
  } catch { return undefined; }
}

/** 继续修改会归档旧确认记录；演示仍按原时间展示，当前记录优先。 */
function readDemoWaiting(task: TaskSummary, problems: string[]): WaitingRecord[] {
  const records = new Map<string, WaitingRecord>();
  const workspace = realpathSync(task.workspace);
  const read = (path: string, label: string) => {
    if (!existsSync(path)) return;
    try {
      const source = realpathSync(path);
      const pathInWorkspace = relative(workspace, source);
      if (pathInWorkspace === ".." || pathInWorkspace.startsWith(`..${sep}`) || isAbsolute(pathInWorkspace)) {
        throw new Error("确认记录不在任务目录中");
      }
      for (const record of new HumanGate(source).all()) {
        if (record.task_id === task.id && record.waiting_id) records.set(record.waiting_id, record);
      }
    } catch { problems.push(`${label}暂时无法读取，原记录保持不变`); }
  };
  for (const archive of new Set((task.delivery_history ?? []).map(history => history.archive))) {
    if (typeof archive !== "string" || !/^[a-zA-Z0-9-]+$/.test(archive)) {
      problems.push("历史交付记录编号无效，未读取任务目录以外的确认记录");
      continue;
    }
    read(join(task.workspace, "delivery-history", archive, "waiting.json"), "历史确认记录");
  }
  read(join(task.workspace, "waiting.json"), "当前确认记录");
  return [...records.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
}

function readReviews(path: string, taskId: string, problems: string[]): ReviewRequest[] {
  if (!existsSync(path)) return [];
  const records = new Map<string, ReviewRequest>();
  let skipped = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ReviewRequest;
      if (record?.id && record.task_id === taskId && record.committer) records.set(record.id, record);
    } catch { skipped += 1; }
  }
  if (skipped) problems.push(`检视邀请中有 ${skipped} 行无法读取；原记录保持不变`);
  return [...records.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function readMemoryRows<T>(path: string, label: string, problems: string[]): T[] {
  if (!existsSync(path)) return [];
  const records: T[] = [];
  let skipped = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line) as T); }
    catch { skipped += 1; }
  }
  if (skipped) problems.push(`${label}中有 ${skipped} 行无法读取；原记录保持不变`);
  return records;
}

function readMemories(dataDir: string, task: TaskSummary, problems: string[]):
  Pick<TaskDemoSnapshot, "memories" | "memoryUsage"> {
  const memoryUsage = readMemoryRows<MemoryUsageEvent & { ts: string }>(
    join(task.workspace, "memory-usage.jsonl"), "知识使用记录", problems)
    .filter(row => row && typeof row.ts === "string" && Array.isArray(row.ids));
  const referenced = new Set(memoryUsage.flatMap(row => row.ids));
  const root = join(dataDir, MEMORY_DIR);
  const latest = new Map<string, MemoryRecord>();
  for (const record of readMemoryRows<MemoryRecord>(join(root, "index.jsonl"), "经验候选", problems)) {
    if (record && typeof record.id === "string" && typeof record.file === "string") latest.set(record.id, record);
  }
  const superseded = new Map<string, string>();
  for (const record of latest.values()) if (record.supersedes) superseded.set(record.supersedes, record.id);
  const archived = new Map<string, string | undefined>();
  for (const row of readMemoryRows<MemoryLedgerRow>(join(root, "ledger.jsonl"), "经验归档记录", problems)) {
    if (!row || typeof row.id !== "string") continue;
    if (row.kind === "archive") archived.set(row.id, row.note);
    if (row.kind === "restore") archived.delete(row.id);
  }
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
  };
  const memories = [...latest.values()].filter(record => record.task === task.id || referenced.has(record.id))
    .map(record => {
      const derived = { ...record,
        ...(superseded.has(record.id) ? { superseded_by: superseded.get(record.id) } : {}),
        ...(archived.has(record.id) ? { archived: true, archive_reason: archived.get(record.id) } : {}),
      };
      let content = "";
      try {
        if (isAbsolute(record.file)) throw new Error("经验路径无效");
        const realRoot = realpathSync(root);
        for (const base of [root, join(root, MEMORY_ARCHIVE_DIR)]) {
          const path = resolve(base, record.file);
          if (!within(base, path)) throw new Error("经验路径越界");
          if (!existsSync(path)) continue;
          if (!within(realRoot, realpathSync(path))) throw new Error("经验路径越界");
          content = readFileSync(path, "utf-8");
          return { record: derived, content };
        }
      } catch { /* 元信息仍可用于展示，正文不读取目录以外的文件。 */ }
      problems.push(`经验 ${record.id} 的正文暂时无法读取，保留原记录`);
      return { record: derived, content };
    });
  return { memories, memoryUsage };
}

/** 不调用会修复台账、同步外部检视或推进任务的常规工作台读取方法。 */
export async function readTaskDemoSnapshot(service: SnapshotSource, id: string): Promise<TaskDemoSnapshot> {
  const stored = service.storedTaskSummary(id);
  if (!stored) throw new NotFoundError(`任务 ${id} 不存在`);
  const task = structuredClone(stored) as TaskSummary;
  const kernelRoot = service.options.host?.kernelRoot ?? discoverKernelRoot(resolve(process.cwd()));
  const phaseSteps = readPhaseSteps(kernelRoot);
  const stepTitles = readStepTitles(kernelRoot);
  const problems: string[] = [];
  task.progress = readPresentationProgress(service, task, kernelRoot, problems);
  const capture = async <T>(label: string, read: () => T | Promise<T>, fallback: T): Promise<T> => {
    try { return await read(); }
    catch { problems.push(`${label}暂时无法读取，演示副本未包含这部分记录`); return fallback; }
  };
  const [events, annotationSnapshot, waiting, feedback, reviews, artifacts, memory] = await Promise.all([
    capture("Agent 会话", () => service.readDisplayEvents(id), [] as SemanticEvent[]),
    capture("批注", () => new AnnotationStore(join(task.workspace, "annotations.jsonl"), true).snapshot(),
      { items: [] as Annotation[], history: [] as AnnotationOperation[], skipped: 0 }),
    capture("人工决定", () => readDemoWaiting(task, problems), [] as WaitingRecord[]),
    capture("检视反馈", () => new FeedbackStore(join(task.workspace, "feedback", "index.jsonl")).list(), [] as FeedbackRecord[]),
    capture("检视邀请", () => readReviews(join(service.options.dataDir, "reviews.jsonl"), id, problems), [] as ReviewRequest[]),
    capture("产出文档", () => listArtifactsAsync(service.artifactRoot(id), {
      pipelineRoot: join(task.workspace, "pipeline"),
      taskMaterialRoot: task.workspace,
      publishedStory: !!currentStoryFile(task.workspace),
      analysisStory: task.requirement_graph && !task.parent_task_id && !isMainTaskDelivery(task)
        ? `${task.ticket ?? task.id}/story.md` : undefined,
    }, "doc"), [] as ArtifactMeta[]),
    capture("知识记录", () => readMemories(service.options.dataDir, task, problems),
      { memories: [], memoryUsage: [] } as Pick<TaskDemoSnapshot, "memories" | "memoryUsage">),
  ]);
  if (annotationSnapshot.skipped) {
    problems.push(`批注中有 ${annotationSnapshot.skipped} 行无法读取；原记录保持不变`);
  }
  const assistant = await capture("开发助手会话", () =>
    developerAssistantConversation(readDeveloperAssistant(task.workspace), events), []);
  const conversation = buildConversation({
    events, waiting, annotations: annotationSnapshot.items,
    annotationHistory: annotationSnapshot.history, feedback, assistant,
    running: task.status === "running", problems,
    taskId: task.id, crossRepositoryUpdates: task.cross_repository_updates ?? [],
  });
  // 返回值与服务内存及各读取结果断开引用，副本不能反向修改来源。
  return structuredClone({
    schema: "mae-flow-demo-snapshot/1", captured_at: new Date().toISOString(),
    source_task_id: id, ...(phaseSteps ? { phase_steps: phaseSteps } : {}),
    ...(stepTitles ? { step_titles: stepTitles } : {}),
    card_contexts: Object.fromEntries(waiting.map(record => [record.waiting_id, {
      ...(typeof record.context === "string" ? { context: record.context } : {}),
      ...(typeof record.preface === "string" ? { preface: record.preface } : {}),
    }])),
    task, artifacts, conversation,
    annotations: { items: annotationSnapshot.items.filter(item => item.status !== "dropped") },
    reviews, ...memory, problems,
  });
}
