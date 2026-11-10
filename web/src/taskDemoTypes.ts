import type { Annotation, ArtifactMeta, AuthUser, ConversationItem, MemoryRecord, MemoryUsageRow, ReviewRequest, TaskSummary } from "./api";
import type { ArchitectureNode } from "../../src/architectureDetails";
import type { StoryViewCoverage } from "../../src/storyViewCoverage";
import phaseCatalog from "../../kernel/flow/phases.json";

export const TASK_DEMO_ANALYSIS_PHASE = phaseCatalog.placeholders.analysis;
/** 演示的「写代码」段:名字取内核词表占位,组件不写阶段字面量。 */
export const TASK_DEMO_BUILD_PHASE = phaseCatalog.placeholders.delivering;
/** 演示的「检视与验证」段:按所属步骤从内核词表取名,组件不写阶段字面量。 */
export const TASK_DEMO_REVIEW_PHASE = phaseCatalog.phases
  .find((phase) => phase.steps.includes("delivery_review"))!.name;

export interface TaskDemoSnapshot {
  schema: "mae-flow-demo-snapshot/1";
  captured_at: string;
  source_task_id: string;
  task: TaskSummary;
  artifacts: ArtifactMeta[];
  conversation: { items: ConversationItem[]; problems?: string[] };
  annotations: { items: Annotation[] };
  reviews?: ReviewRequest[];
  memories?: Array<{ record: MemoryRecord; content: string }>;
  memoryUsage?: MemoryUsageRow[];
  phase_steps?: Record<string, string[]>;
  step_titles?: Record<string, string>;
  card_contexts?: Record<string, { context?: string; preface?: string }>;
  supplemental_cards?: Record<string, string[]>;
  problems: string[];
}

export interface TaskDemoControls {
  phase: string;
  sourceTaskId: string;
  sourceLabel: string;
  sourceStatus: string;
  preview?: boolean;
  onSelectPhase: (phase: string) => void;
  onReset: () => void;
  onExit: () => void;
  backLabel?: string;
  suggestedMessageId?: string;
  suggestedCardId?: string;
  focusKey?: number;
}

export interface TaskDemoPreviewInput {
  snapshot: TaskDemoSnapshot;
  actor: AuthUser;
  fetchRead: typeof fetch;
  architecture?: TaskDemoArchitectureFixture;
  relatedSnapshots?: TaskDemoSnapshot[];
}

/** 仅由本地 DEV 预览提供的内存图源，不从任务或远端接口加载。 */
export interface TaskDemoArchitectureFixture {
  projection: {
    renderer: string; warnings: string[];
    diagrams: Array<{ id: "demo-overview"; title: string; type: string; view: StoryViewCoverage["id"]; line?: number; nodes?: ArchitectureNode[] }>;
    views?: StoryViewCoverage[];
  };
  diagram: { html: string };
}

/** 历史卡保存的可能是步骤 ID，也可能是当时显示的步骤标题。 */
export function taskDemoPhaseSteps(task: TaskSummary, phase: string, phaseSteps?: Record<string, string[]>,
  stepTitles?: Record<string, string>): string[] {
  const fixedSteps = task.workflow_profile?.final_snapshot?.stages
    .filter(stage => stage.phase === phase).flatMap(stage => stage.steps) ?? [];
  const steps = fixedSteps.length ? fixedSteps : phaseSteps?.[phase]
    ?? phaseCatalog.phases.find(row => row.name === phase)?.steps ?? [];
  const matches = new Set(steps.flatMap(step => [step, ...(stepTitles?.[step] ? [stepTitles[step]] : [])]));
  // build 在 1293ac53 更名；历史确认卡仍保存原题名，仅用于演示读取。
  if (steps.includes("build")) matches.add("编码实现");
  if (phase === phaseCatalog.placeholders.queued) matches.add("cloud_requirement_analysis_confirm");
  if (phaseCatalog.phases.find(row => row.steps.includes("push"))?.name === phase) {
    for (const step of ["host_push_confirm", "cloud_push_confirm", "cloud_mr_description"]) matches.add(step);
  }
  if (task.split_escalation?.phase === phase) matches.add("cloud_split_proposal");
  if (phase === TASK_DEMO_ANALYSIS_PHASE) {
    matches.delete("cloud_requirement_analysis_confirm");
    if (task.requirement_graph) matches.add("requirement_analysis");
    // 分析主任务不运行内核，历史提问没有内核步骤标题。
    if (!task.parent_task_id && task.requirement_graph) matches.add("");
  }
  return [...matches];
}

type DemoCard = Extract<ConversationItem, { kind: "card" }>;
type DemoCardSource = Pick<TaskDemoSnapshot, "task" | "conversation" | "phase_steps" | "step_titles">;

/** 当前等待记录可能比会话快照更新；把这张真实卡放回它原来的时间位置。 */
export function taskDemoConversation(task: TaskSummary, source: ConversationItem[]): ConversationItem[] {
  const items = [...source];
  const waiting = task.waiting;
  if (!waiting || items.some(item => item.kind === "card" && item.waiting_id === waiting.waiting_id)) return items;
  const card: DemoCard = {
    kind: "card", id: `card-${waiting.waiting_id}`, ts: waiting.created_at ?? "",
    waiting_id: waiting.waiting_id, step: waiting.step ?? task.progress?.step_id ?? "",
    purpose: waiting.question?.purpose ?? "confirmation",
    annotation_ids: [...(waiting.question?.annotation_ids ?? [])],
    questions: (waiting.question?.questions ?? []).map(question => ({
      question: question.question, options: [...(question.options ?? [])],
    })), status: "waiting",
  };
  const createdAt = Date.parse(card.ts);
  const next = Number.isFinite(createdAt) ? items.findIndex(item => Date.parse(item.ts) > createdAt) : -1;
  items.splice(next < 0 ? items.length : next, 0, card);
  return items;
}

export function taskDemoPhaseCard(snapshot: DemoCardSource, phase: string): DemoCard | undefined {
  const steps = taskDemoPhaseSteps(snapshot.task, phase, snapshot.phase_steps, snapshot.step_titles);
  const waiting = snapshot.task.waiting;
  const waitingMatches = waiting && (waiting.step !== undefined ? steps.includes(waiting.step)
    : snapshot.task.progress?.current_phase === phase);
  const history = taskDemoConversation(snapshot.task, snapshot.conversation.items).reverse();
  const direct = history.find((item): item is DemoCard =>
    item.kind === "card" && (item.waiting_id === waiting?.waiting_id ? waitingMatches === true : steps.includes(item.step)));
  if (direct || phaseCatalog.phases.find(row => row.steps.includes("build"))?.name !== phase) return direct;
  // 编码不要求单独举卡；演示代码成果时定位原任务的最终代码检视，保留卡片原阶段与原文。
  const reviewSteps = ["delivery_review", "cloud_push_confirm"].flatMap(step =>
    [step, ...(snapshot.step_titles?.[step] ? [snapshot.step_titles[step]] : [])]);
  return history.find((item): item is DemoCard => item.kind === "card" && reviewSteps.includes(item.step));
}

export function hasTaskDemoPhaseCard(snapshot: TaskDemoSnapshot, phase: string): boolean {
  return !!taskDemoPhaseCard(snapshot, phase);
}

export function suggestedDemoMessage(snapshot: TaskDemoSnapshot, phase: string): string | undefined {
  const card = taskDemoPhaseCard(snapshot, phase);
  if (!card) return undefined;
  if (snapshot.supplemental_cards?.[card.id]) return card.id;
  const items = taskDemoConversation(snapshot.task, snapshot.conversation.items);
  const cardIndex = items.findIndex(item => item.id === card.id);
  const candidates: Array<Extract<ConversationItem, { kind: "turn" }>> = [];
  for (let index = cardIndex - 1; index >= 0; index--) {
    const item = items[index];
    if (["card", "session", "decision", "steer", "delivery_reset"].includes(item.kind)) break;
    if (item.kind === "turn" && item.texts.some(text => text.text.trim())) candidates.push(item);
  }
  const context = snapshot.card_contexts?.[card.waiting_id]
    ?? (snapshot.task.waiting?.waiting_id === card.waiting_id ? snapshot.task.waiting : undefined);
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  const originalTexts = [context?.preface, context?.context].filter((text): text is string => !!text?.trim()).map(normalize);
  const match = originalTexts.map(original => candidates.find(item =>
    item.texts.some(text => normalize(text.text).includes(original)))).find(Boolean);
  return (match ?? candidates[0])?.id ?? card.id;
}
