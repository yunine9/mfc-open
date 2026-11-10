import type {
  Annotation, AnnotationClosure, ArtifactMeta, ConversationItem,
  BusinessModule, DeveloperAssistantView, EarlyStartPreview, MemoryRecord, MemoryUsageRow,
  PushReviewPresentation, ReviewRequest, TaskSummary,
} from "./api";
import { taskDemoConversation, taskDemoPhaseCard, taskDemoPhaseSteps, type TaskDemoArchitectureFixture } from "./taskDemoTypes";

export interface TaskDemoSandboxInput {
  task: TaskSummary;
  actor: string;
  conversation?: ConversationItem[];
  annotations?: Annotation[] | { items: Annotation[] };
  artifacts?: ArtifactMeta[];
  reviews?: ReviewRequest[];
  phaseSteps?: Record<string, string[]>;
  stepTitles?: Record<string, string>;
  cardContexts?: Record<string, { context?: string; preface?: string }>;
  memories?: Array<{ record: MemoryRecord; content: string }>;
  memoryUsage?: MemoryUsageRow[];
  businessModules?: BusinessModule[];
  architecture?: TaskDemoArchitectureFixture;
  /** The original, bound fetch. Only allowlisted source reads and diagram rendering reach it. */
  fetchRead: typeof fetch;
}

export interface TaskDemoSandbox {
  readonly sourceTaskId: string;
  readonly taskId: string;
  readonly task: TaskSummary;
  getTask(): TaskSummary;
  subscribe(listener: () => void): () => void;
  fetch: typeof fetch;
  selectPhase(phase: string): TaskSummary;
  reset(): TaskSummary;
  resolveAsset(path: string): string | undefined;
  dispose(): void;
}

const demoAssets = new Map<string, (path: string) => string | undefined>();
/** Ordinary tasks retain their normal asset URL; demo tasks never load attachments from production. */
export function resolveTaskDemoAsset(taskId: string, path: string): string | undefined {
  const resolve = demoAssets.get(taskId);
  if (!resolve) return undefined;
  return resolve(path) ?? `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="80"><rect width="400" height="80" fill="#f1f5f9"/><text x="20" y="45" font-size="15" fill="#475569">演示副本：原任务附图未载入</text></svg>')}`;
}

const copy = <T>(value: T): T => structuredClone(value);
const now = () => new Date().toISOString();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const error = (message: string, status = 400) => json({ error: message }, status);
const feedback = (text: string) => `演示反馈：${text}。仅更新当前演示副本，没有执行真实 Agent 或通知参与者。`;

/**
 * Browser-only, disposable copy. It has no persistence or task-write transport.
 * An unsupported operation fails closed instead of returning a pretend success.
 */
export function createTaskDemoSandbox(input: TaskDemoSandboxInput): TaskDemoSandbox {
  if (!input.actor.trim()) throw new Error("演示需要当前管理员账号。");
  const original = copy(input.task);
  const sourceTaskId = original.id;
  const taskId = `demo-${sourceTaskId}-${Math.random().toString(36).slice(2, 9)}`;
  const sourceConversation = taskDemoConversation(original, copy(input.conversation ?? []));
  const sourceAnnotations = copy(Array.isArray(input.annotations) ? input.annotations : input.annotations?.items ?? []);
  const sourceArtifacts = copy(input.artifacts ?? []);
  const sourceReviews = copy(input.reviews ?? []);
  const phaseSteps = copy(input.phaseSteps ?? {});
  const stepTitles = copy(input.stepTitles ?? {});
  const cardContexts = copy(input.cardContexts ?? {});
  const phases = [...(original.progress?.phases ?? [])];
  const sourceMemories = copy(input.memories ?? []);
  const sourceMemoryUsage = copy(input.memoryUsage ?? []);
  const sourceModules = copy(input.businessModules ?? []);
  const previewArchitecture = input.architecture ? copy(input.architecture) : undefined;
  const listeners = new Set<() => void>();
  const reads = new Set<AbortController>();
  const readCache = new Map<string, Response>();
  const readPending = new Map<string, Promise<Response>>();
  const localDocuments = new Map<string, string>();
  const images = new Map<string, { content: Uint8Array; type: string; url: string }>();
  const readDocuments = new Map<string, string>();
  let readArtifacts: Promise<ArtifactMeta[]> | undefined;
  let memories: Array<{ record: MemoryRecord; content: string }>;
  let memoryUsage: MemoryUsageRow[];
  let modules: BusinessModule[];
  const memoryHistory = new Map<string, MemoryRecord[]>();
  let story: { eligible: boolean; current: string; stale: boolean; label: string; sources: Array<{ id: string; name: string }>; pending_reviews: number; can_confirm: boolean; revisions: Array<{ id: string; at: string; by: string; additions: number; deletions: number }>; confirmed?: { revision: string; by: string; at: string } };
  let architectureRevision = "demo-architecture-0";
  const revokeAssets = () => { for (const asset of images.values()) URL.revokeObjectURL(asset.url); images.clear(); };
  const origin = (globalThis as unknown as { location?: { origin: string } }).location?.origin || "http://demo.local";
  let task: TaskSummary;
  let conversation: ConversationItem[];
  let annotations: Annotation[];
  let artifacts: ArtifactMeta[];
  let reviews: ReviewRequest[];
  let assistant: DeveloperAssistantView;
  let sequence = 0;
  let disposed = false;
  const id = (kind: string) => `${taskId}-${kind}-${++sequence}`;

  // IDs in source relationships must never navigate to another writable task.
  function isolated<T>(value: T): T {
    if (Array.isArray(value)) return value.map(isolated) as T;
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
      if (["mr_url", "parent_task", "parent_task_id", "blocked_by", "target_task_ids", "cross_repository_updates"].includes(key)) return [];
      if (key === "task_id" || key === "source_task_id") return item === sourceTaskId ? [[key, taskId]] : [];
      return [[key, isolated(item)]];
    })) as T;
  }
  const notify = () => { if (!disposed) for (const listener of listeners) listener(); };
  const getTask = () => { if (disposed) throw new Error("演示已退出。"); return copy(task); };
  const addFeedback = (text: string) => {
    const at = now();
    conversation.push({ kind: "assistant", id: id("feedback"), ts: at, role: "assistant", text: feedback(text) });
    task.updated_at = at;
  };
  function reset(): TaskSummary {
    if (disposed) throw new Error("演示已退出。");
    localDocuments.clear(); revokeAssets();
    memoryHistory.clear();
    architectureRevision = "demo-architecture-0";
    task = isolated(copy(original));
    task.id = taskId;
    task.luban_account = input.actor;
    task.detail = `演示副本 · 来源任务 ${sourceTaskId}；所有操作仅保存在当前窗口。`;
    task.approval_mode = "manual";
    // Source relationships and permissions are evidence, not navigation or approval authority.
    task.collaborators = [];
    // Preserve dependency shape using local IDs, never a live task navigation target.
    if (original.blocked_by?.length) task.blocked_by = original.blocked_by.map((_, index) => `${taskId}-dependency-${index + 1}`);
    delete task.requirement_revision;
    delete task.continuation;
    delete task.ticket_correction;
    if (task.requirement_graph) task.requirement_graph.repositories.forEach(row => { row.assignee = input.actor; });
    if (task.waiting) task.waiting.waiting_id = id("waiting");
    conversation = isolated(copy(sourceConversation)).map(row => {
      if (row.kind === "card" || row.kind === "decision") row.waiting_id = `${taskId}-source-${row.waiting_id}`;
      return row;
    });
    conversation.unshift({ kind: "session", id: id("source-label"), ts: original.created_at, phase: "started",
      detail: `以下为原任务 ${sourceTaskId} 的只读会话记录；新增模拟内容会标明“演示反馈”。` });
    annotations = isolated(copy(sourceAnnotations)).map(row => ({ ...row,
      ...(row.assignee ? { assignee: input.actor } : {}) }));
    artifacts = copy(sourceArtifacts).map(row => ({ ...row, label: `原任务 · ${row.label}` }));
    reviews = isolated(copy(sourceReviews)).map(row => ({ ...row, id: id("review"), task_id: taskId,
      requester: input.actor, committer: input.actor, delivered: false }));
    assistant = { state: "idle", messages: [], tools: [], availability: { available: true,
      code: "user_override", mode: "edit", reason: "演示副本：可以体验助手对话，不执行真实代码修改。" } };
    const mappedMemoryIds = new Map<string, string>();
    memories = sourceMemories.map(entry => {
      const record = copy(entry.record); const previousId = record.id;
      record.id = id("memory"); mappedMemoryIds.set(previousId, record.id);
      record.task = taskId; record.can_review = true; record.trigger = `原任务 · ${record.trigger}`;
      return { record, content: `> 原任务 ${sourceTaskId} 的经验记录副本；此处修改不会影响真实知识库。\n\n${entry.content}` };
    });
    if (!memories.length) memories.push(makeMemory("【演示示例】接口超时后的重试", "先确认接口是否幂等，再决定是否自动重试。\n\n适用例外：存在重复扣款等副作用时，必须先确认去重条件。", "delivery_review"));
    for (const entry of memories) {
      if (entry.record.merged_into) entry.record.merged_into = mappedMemoryIds.get(entry.record.merged_into);
      if (entry.record.supersedes) entry.record.supersedes = mappedMemoryIds.get(entry.record.supersedes);
      if (entry.record.superseded_by) entry.record.superseded_by = mappedMemoryIds.get(entry.record.superseded_by);
      memoryHistory.set(entry.record.id, [copy(entry.record)]);
    }
    memoryUsage = sourceMemoryUsage.map(row => ({ ...copy(row), ids: row.ids.flatMap(value => mappedMemoryIds.has(value) ? [mappedMemoryIds.get(value)!] : []) }));
    task.memories_recorded = memories.length;
    modules = sourceModules.length ? copy(sourceModules) : [{
      id: original.business_module?.id ?? `${taskId}-module`, name: original.business_module?.name ?? "演示业务模块",
      description: "演示副本内的业务模块选项", owner: input.actor, maintainers: [], repositories: original.repositories ?? [],
      status: "active", revision: 1, assets: [], created_at: now(), created_by: input.actor, updated_at: now(), updated_by: input.actor, can_manage: false,
    }];
    modules.push({ ...copy(modules[0]), id: `${taskId}-module-example`, name: "演示示例 · 另一业务模块" });
    story = { eligible: true, current: "demo-story-0", stale: false, label: "演示副本 · 文档维护示例",
      sources: artifacts.filter(row => row.kind === "doc").map(row => ({ id: row.name, name: row.label })),
      pending_reviews: 0, can_confirm: true, revisions: [] };
    notify();
    return getTask();
  }

  function makeMemory(trigger: string, conclusion: string, source: MemoryRecord["source"] = "user_note") {
    const record: MemoryRecord = { id: id("memory"), source, judged_by: source === "delivery_review" ? "agent" : "human",
      scope: "local", repo: original.repo_url ?? "演示仓库", paths: [], task: taskId, evidence: "演示示例；未写入知识库或检索索引。",
      author: input.actor, trigger, conclusion, at: now(), file: "demo-memory.md", can_review: true, revision: 1,
      review: { status: "pending" }, draft: "model", drafting: false };
    return { record, content: `# 演示经验\n\n${trigger}\n\n${conclusion}\n\n> 仅保存在演示副本。` };
  }
  function memoryInsights() {
    return { generated_at: now(), drafting: 0, sidecar: "absent", repos: [], memories: memories.map(({ record }) => ({
      ...record, draft: record.draft ?? "model", drafting: false, weight: 0, pushes: 0, hits: 0, reworks: 0,
    })) };
  }
  function reviewMemory(memoryId: string, body: Record<string, unknown>): Response {
    const entry = memories.find(row => row.record.id === memoryId);
    if (!entry) return error("未找到演示经验。", 404);
    const record = entry.record;
    if (body.revision !== undefined && Number(body.revision) !== (record.revision ?? 1)) return error("演示经验已更新，请刷新后再试。", 409);
    if (!["pending", "accepted", "rejected"].includes(String(body.decision))) return error("请选择经验处理方式。");
    if (body.merged_into && !memories.some(row => row.record.id === body.merged_into && row.record.id !== memoryId && row.record.review?.status === "accepted")) return error("请选择演示副本中已采纳的目标经验。");
    if (!record.review?.original) record.review = { status: record.review?.status ?? "pending", original: { trigger: record.trigger, conclusion: record.conclusion, scope: record.scope } };
    for (const key of ["trigger", "conclusion", "repo", "module", "merged_into"] as const) if (typeof body[key] === "string") record[key] = String(body[key]);
    if (["one_off", "local", "general", "platform"].includes(String(body.scope))) record.scope = body.scope as MemoryRecord["scope"];
    if (typeof body.dimension === "string") record.dimension = body.dimension as MemoryRecord["dimension"];
    if (Array.isArray(body.product_versions)) record.product_versions = body.product_versions.map(String);
    record.review = { ...record.review, status: body.decision as "accepted", by: input.actor, at: now() };
    record.maintenance_note = `演示反馈：仅在副本中${body.decision === "accepted" ? "采纳" : body.decision === "rejected" ? "停用" : "保存草稿"}；未写入真实知识库。${String(body.note ?? "")}`;
    record.revision = (record.revision ?? 1) + 1; record.edited_by = input.actor; record.edited_at = now();
    entry.content = `# 演示经验\n\n${record.trigger}\n\n${record.conclusion}\n\n> ${record.maintenance_note}`;
    memoryHistory.get(memoryId)?.push(copy(record));
    addFeedback("已保存经验结论和适用范围，真实知识库与检索结果保持不变");
    return json(record);
  }

  function selectPhase(phase: string): TaskSummary {
    if (disposed) throw new Error("演示已退出。");
    const index = phases.indexOf(phase);
    if (index < 0) throw new Error("该阶段不在当前演示的进度条中。");
    const steps = taskDemoPhaseSteps(original, phase, phaseSteps, stepTitles);
    const card = taskDemoPhaseCard({ task: original, conversation: { items: sourceConversation },
      phase_steps: phaseSteps, step_titles: stepTitles }, phase);
    const sourceWaiting = card?.waiting_id === original.waiting?.waiting_id ? original.waiting : undefined;
    // 切换阶段撤下上一张互动副本，真实历史卡和实际回答保持原位。
    conversation = conversation.filter(row => !(row.kind === "card" && row.id.startsWith(`${taskId}-card-`)));
    const step = card?.step ?? sourceWaiting?.step ?? steps[0] ?? "demo_confirmation";
    task.progress = { phases: copy(phases), current_index: index, current_phase: phase,
      step_id: step, step: phase };
    task.status = "waiting_for_human";
    task.status_label = card?.id.startsWith("demo-supplement-") ? "依据原任务资料补充" : "原任务问题 · 演示确认";
    task.focus = { kind: "human_action", headline: `演示：${phase}`, next_action: "在副本中体验批注、回复或确认。",
      owner: "responsible", needs_attention: true, priority: 1 };
    delete task.completed_at;
    delete task.execution_plan;
    if (original.execution_plan?.step.phase === phase) task.execution_plan = copy(original.execution_plan);
    if (!card && !sourceWaiting) {
      delete task.waiting;
      delete task.focus;
      task.status = "paused";
      task.status_label = "原任务历史";
      notify();
      return getTask();
    }
    const questions = copy(card?.questions ?? sourceWaiting?.question?.questions ?? []);
    const originalContext = (card ? cardContexts[card.waiting_id] : undefined) ?? sourceWaiting;
    task.waiting = { waiting_id: id("waiting"), state_version: sequence, step,
      created_at: card?.ts ?? sourceWaiting?.created_at,
      question: { questions, purpose: card?.purpose ?? sourceWaiting?.question?.purpose ?? "confirmation" },
      context: originalContext?.context,
      preface: originalContext?.preface,
      recommended_view: sourceWaiting?.recommended_view,
      choice_effects: [{ key: "demo-adjust", answers: ["需要调整", "需要调整代码"], allows_source_edit: true,
        handles_feedback: true, closes_feedback: false }] };
    conversation.push({ kind: "card", id: id("card"), ts: now(), waiting_id: task.waiting.waiting_id,
      step, purpose: task.waiting.question?.purpose ?? "confirmation", annotation_ids: [],
      questions: questions.map(q => ({ ...q, options: q.options ?? [] })), status: "waiting" });
    notify();
    return getTask();
  }

  function closures(): AnnotationClosure[] {
    return annotations.map(row => {
      const closed = row.status === "verified" || row.status === "dropped";
      const answered = !!row.owner_reply || !!row.response;
      const pending = !closed && !answered;
      return { id: row.id, tone: closed ? "done" : "review", bucket: closed ? "closed" : "mine",
        text: closed ? "演示：已闭环" : answered ? "演示：待责任人确认闭环" : "演示：待处理",
        hint: "演示副本：管理员以任务责任人身份操作，原任务保持不变。",
        delivery_text: "仅在演示副本内处理", owner_controlled: true,
        verdict_ready: answered, actionable: !closed, can_verify: !closed && answered,
        can_resolve: !closed && answered, can_delete: pending, can_edit: pending,
        can_reopen: closed || answered, can_override_verify: false, can_override_drop: false,
        can_route: pending, needs_clarification: false, receipt_missing: false };
    });
  }
  function submitted(ids?: unknown): Annotation[] {
    const wanted = Array.isArray(ids) ? new Set(ids) : undefined;
    return annotations.filter(row => (wanted ? wanted.has(row.id) : row.status === "draft")
      && row.status !== "verified" && row.status !== "dropped");
  }
  function simulateResponse(items: Annotation[]) {
    for (const row of items) {
      row.route = "agent"; row.status = "sent"; row.sent_at = now(); row.sent_by = input.actor;
      row.sent_via = "interrupt"; row.agent_assigned = false;
      row.response = { revision: row.rework ?? 0, outcome: "fixed", responded_at: now(), evidence: ["演示示例，不是实际代码或验证证据。"],
        summary: feedback("已模拟意见提交与回复，接下来可以体验确认闭环或重新处理") };
    }
  }
  async function bodyOf(request: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Record<string, unknown>> {
    const body = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
    if (!body) return {};
    if (typeof body !== "string") throw new Error("演示仅支持 JSON 请求。");
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求内容必须是 JSON 对象。");
    return parsed;
  }
  async function readSource(path: string, search: string, signal?: AbortSignal | null): Promise<Response> {
    const key = path + search;
    const cached = readCache.get(key);
    if (cached) return cached.clone();
    const pending = readPending.get(key);
    if (pending) return (await pending).clone();
    const controller = new AbortController(); reads.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const read = (async () => {
      const response = await input.fetchRead(key, { method: "GET", signal: controller.signal, redirect: "error" });
      if (disposed) return error("演示已退出。", 410);
      const safe = response.headers.get("content-type")?.includes("application/json")
        ? json(isolated(await response.json()), response.status) : response;
      if (safe.ok) readCache.set(key, safe.clone());
      return safe;
    })();
    readPending.set(key, read);
    try { return (await read).clone(); }
    finally { reads.delete(controller); signal?.removeEventListener("abort", abort); readPending.delete(key); }
  }

  async function renderDiagram(source: string, signal?: AbortSignal | null): Promise<Response> {
    const controller = new AbortController(); reads.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await input.fetchRead("/diagrams/plantuml", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }), signal: controller.signal, redirect: "error",
      });
      return disposed ? error("演示已退出。", 410) : response;
    } finally { reads.delete(controller); signal?.removeEventListener("abort", abort); }
  }

  async function sandboxFetch(request: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
    if (disposed) return error("演示已退出，副本已清除。", 410);
    const method = (init?.method ?? (request instanceof Request ? request.method : "GET")).toUpperCase();
    let url: URL;
    try { url = new URL(request instanceof Request ? request.url : String(request), origin); }
    catch { return error("演示请求地址无效。"); }
    if (url.origin !== origin) return error("演示不能访问外部接口。", 403);
    const prefix = `/tasks/${encodeURIComponent(taskId)}`;
    const taskRoute = url.pathname === prefix || url.pathname.startsWith(prefix + "/");
    const route = taskRoute ? url.pathname.slice(prefix.length) : "";
    const writable = !["GET", "HEAD"].includes(method);
    // This guard deliberately precedes every path fallback, including source task IDs.
    if (writable) {
      let body: Record<string, unknown>;
      try { body = await bodyOf(request, init); }
      catch { return error("演示请求内容无效。"); }
      // 出图接口只把文档中的源码转换为 SVG，不修改任务，也不启动 Agent。
      if (url.pathname === "/diagrams/plantuml" && !url.search && method === "POST") {
        if (typeof body.source !== "string" || !body.source.trim()) return error("缺少 PlantUML 源码。");
        return renderDiagram(body.source, init?.signal ?? (request instanceof Request ? request.signal : undefined));
      }
      const reviewMatch = /^\/reviews\/([^/]+)\/complete$/.exec(url.pathname);
      if (reviewMatch && method === "POST") {
        const review = reviews.find(row => row.id === decodeURIComponent(reviewMatch[1]));
        if (!review) return error("未找到演示检视记录。", 404);
        review.status = "completed"; review.completed_at = now(); addFeedback("已保存演示检视结论"); notify(); return json(review);
      }
      const memoryMatch = /^\/memory-insights\/([^/]+)\/review$/.exec(url.pathname);
      if (memoryMatch && method === "POST") { const result = reviewMemory(decodeURIComponent(memoryMatch[1]), body); if (result.ok) notify(); return result; }
      if (url.pathname === "/memory-insights" && method === "POST") {
        if (!String(body.trigger ?? "").trim() || !String(body.conclusion ?? "").trim()) return error("请填写经验标题和内容。");
        const entry = makeMemory(String(body.trigger), String(body.conclusion)); memories.push(entry);
        memoryHistory.set(entry.record.id, [copy(entry.record)]); task.memories_recorded = memories.length;
        addFeedback("已保存经验草稿"); notify(); return json(entry.record);
      }
      if (!taskRoute) return error("演示只允许修改当前副本。", 403);
      const result = writeLocal(route, method, body);
      if (result.ok) notify();
      return result;
    }
    if (url.pathname === "/auth/me") return json({ username: input.actor, role: "admin", display_name: `${input.actor}（演示责任人）` });
    if (["/auth/people", "/auth/committers"].includes(url.pathname) && !url.search) {
      return readSource(url.pathname, "", init?.signal);
    }
    if (url.pathname === "/reviews/mine") return json(reviews);
    if (url.pathname === "/business-modules") return json({ modules, repositories: [] });
    if (url.pathname === "/product-versions") return json({ versions: original.product_version ? [{ id: "demo-version", version: original.product_version, branch: "演示副本" }] : [] });
    if (url.pathname === "/memory-insights") return json(memoryInsights());
    const memoryRead = /^\/memory-insights\/([^/]+)(\/history)?$/.exec(url.pathname);
    if (memoryRead) {
      const entry = memories.find(row => row.record.id === decodeURIComponent(memoryRead[1]));
      return entry ? json(memoryRead[2] ? memoryHistory.get(entry.record.id) ?? [] : entry) : error("未找到演示经验。", 404);
    }
    if (!taskRoute) return error("演示不开放这个读取接口。", 403);
    if (!route) return json(task);
    if (route === "/conversation") return json({ items: conversation, events_seen: 0,
      problems: [], demo_source: { task_id: sourceTaskId, label: "原任务只读记录；演示新增内容单独标记" } });
    if (route === "/annotations") return json({ items: annotations, checks: annotations.map(row => ({ id: row.id, state: "hit", line: row.line })),
      closures: closures(), submission: { ordinary: { enabled: true, hint: "演示：提交后展示模拟回复，不启动真实 Agent。" },
        story: { enabled: true, hint: "演示：意见只保存在本副本。" } } });
    if (route === "/reviews") return json(reviews);
    if (route === "/artifacts") {
      readArtifacts ??= readSource(`/tasks/${encodeURIComponent(sourceTaskId)}/artifacts`, "", init?.signal)
        .then(async response => { if (!response.ok) throw new Error("原任务产物目录读取失败。"); const rows = await response.json();
          return Array.isArray(rows) ? rows as ArtifactMeta[] : []; })
        .catch(() => { readArtifacts = undefined; return []; });
      const rows = await readArtifacts;
      if (disposed) return error("演示已退出。", 410);
      const combined = new Map(rows.map(row => [row.name, { ...row, label: `原任务 · ${row.label}` }]));
      for (const row of artifacts) combined.set(row.name, row);
      return json([...combined.values()].filter(row => !url.searchParams.get("kind") || row.kind === url.searchParams.get("kind")));
    }
    if (route === "/interrupts") return json(conversation.filter(row => row.kind === "steer").map(row => ({
      text: row.text, at: row.ts, delivered: false, said: [] })));
    if (route === "/developer-assistant") return json(assistant);
    if (route === "/memories") return json(memories.map(entry => entry.record));
    if (route === "/memories/usage") return json(memoryUsage);
    if (/^\/memories\/[^/]+$/.test(route)) {
      const entry = memories.find(row => row.record.id === decodeURIComponent(route.slice("/memories/".length)));
      return entry ? json(entry) : error("未找到演示经验。", 404);
    }
    if (route === "/overall-story") return json(story);
    if (/^\/overall-story\/revisions\/[^/]+$/.test(route)) return json({ diff: "演示示例：本次修订仅保存在演示副本，没有修改原文档。" });
    if (route === "/architecture" && previewArchitecture) return json({ ...previewArchitecture.projection, revision: architectureRevision });
    if (route === "/architecture/demo-overview" && previewArchitecture) return json({ ...previewArchitecture.diagram, revision: architectureRevision });
    if (!previewArchitecture && /^\/architecture(?:\/[A-Za-z0-9._-]+)?$/.test(route)) {
      return readSource(`/tasks/${encodeURIComponent(sourceTaskId)}${route}`, url.search, init?.signal);
    }
    if (route === "/knowledge-source") {
      const resource = task.knowledge_usage?.resources.find(row => row.id === url.searchParams.get("resource"));
      return json({ name: resource?.name ?? "演示知识", path: resource?.path ?? "demo-knowledge.md", version_changed: false,
        content: `# ${resource?.name ?? "演示知识"}\n\n> 演示说明：此处仅展示任务快照中的知识描述，没有读取或修改真实知识库。\n\n${resource?.description ?? "资料原文未随演示快照保存。"}` });
    }
    if (route === "/diff-review") {
      const review: PushReviewPresentation = task.delivery?.push_review ?? { kind: "delivery", title: "演示示例 · 代码比较范围", description: "没有原任务的比较摘要，本项只展示检视交互。",
        base_sha: "demo-base", baseline_sha: "demo-base", head_sha: "demo-head", has_focused_changes: true, file_count: 1,
        additions: 0, deletions: 0, stats_unavailable_reason: "演示示例，没有实际改动统计。", commits: [], all_paths: ["demo-example.txt"], committed_paths: ["demo-example.txt"] };
      return json({ review });
    }
    if (route === "/push-review-diff") return json({ content: "diff --git a/demo-example.txt b/demo-example.txt\n--- a/demo-example.txt\n+++ b/demo-example.txt\n@@ -1 +1 @@\n-演示示例：原始处理\n+演示示例：根据已确认的验收条件调整处理；不代表真实代码改动\n", branch: "演示示例" });
    if (route === "/actions") return json([]);
    if (route === "/timeline") return json(conversation.filter(row => row.kind === "assistant").map(row => ({ ts: row.ts, kind: "agent", title: "演示反馈", detail: row.text, tone: "info" })));

    if (route === "/annotation-asset") {
      const item = images.get(url.searchParams.get("path") ?? "");
      if (item) return new Response(item.content as unknown as ConstructorParameters<typeof Response>[0], { headers: { "content-type": item.type } });
    }
    if (route.startsWith("/artifacts/")) {
      const name = decodeURIComponent(route.slice("/artifacts/".length));
      const content = localDocuments.get(name);
      if (content !== undefined) return json({ content, kind: "doc" });
    }
    // Some nominal GETs repair/persist production state. Only verified pure
    // artifact and architecture reads may leave this copy; all other views are answered locally.
    if (!/^\/artifacts\/[^/]+$/.test(route)) return error("演示暂未提供这个读取入口。", 501);
    const response = await readSource(`/tasks/${encodeURIComponent(sourceTaskId)}${route}`, url.search, init?.signal);
    if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.clone().json() as { content?: string };
      if (typeof body.content === "string") readDocuments.set(decodeURIComponent(route.slice("/artifacts/".length)), body.content);
    }
    return response;
  }

  function earlyStartPreview(body: Record<string, unknown>): EarlyStartPreview {
    const prerequisites = (task.blocked_by ?? []).map((dependencyId, index) => ({ id: dependencyId, title: `演示前置任务 ${index + 1}`, ticket: "", repository: "演示仓库" }));
    const wanted = Array.isArray(body.release_ids) ? new Set(body.release_ids.map(String)) : new Set(prerequisites.map(row => row.id));
    const released = prerequisites.filter(row => wanted.has(row.id));
    const remaining = prerequisites.filter(row => !wanted.has(row.id));
    return { task: { id: taskId, title: task.title ?? task.requirement, ticket: task.ticket ?? "", repository: "演示仓库" },
      owner: input.actor, can_operate: true, available: prerequisites.length > 0, revision: `demo-dependencies-${(task.blocked_by ?? []).join("-")}`,
      ...(prerequisites.length ? {} : { unavailable_reason: "当前演示副本没有等待中的前置任务。" }),
      prerequisites, release_ids: released.map(row => row.id).sort(), no_longer_waiting: released, remaining,
      parallel: [], conflicts: [], downstream: [], ticket: String(body.ticket ?? task.ticket ?? "").trim(), errors: [],
      result: "演示示例：只调整副本的等待关系，真实任务的执行顺序保持不变" };
  }
  function writeLocal(route: string, method: string, body: Record<string, unknown>): Response {
    const memoryWithdraw = /^\/memories\/([^/]+)\/withdraw$/.exec(route);
    if (memoryWithdraw && method === "POST") {
      const entry = memories.find(row => row.record.id === decodeURIComponent(memoryWithdraw[1]));
      if (!entry) return error("未找到演示经验。", 404);
      entry.record.withdrawn = true; entry.record.edited_at = now(); entry.record.edited_by = input.actor;
      entry.record.maintenance_note = "演示反馈：已在副本中撤回，真实知识库不受影响。";
      entry.record.revision = (entry.record.revision ?? 1) + 1;
      memoryHistory.get(entry.record.id)?.push(copy(entry.record)); addFeedback("已撤回副本中的经验"); return json({});
    }
    if (route === "/business-module" && method === "PUT") {
      const target = modules.find(row => row.id === body.module_id);
      if (body.module_id && !target) return error("请选择演示副本中的业务模块。");
      const before = copy(task.business_module);
      task.business_module = target ? { id: target.id, name: target.name } : undefined;
      task.business_module_history = [...(task.business_module_history ?? []), { at: now(), by: input.actor, from: before, to: copy(task.business_module) }];
      addFeedback("已调整副本所属模块，原任务和知识关联保持不变"); return json(task);
    }
    if (route === "/early-start/preview" && method === "POST") return json(earlyStartPreview(body));
    if (route === "/early-start" && method === "POST") {
      const preview = earlyStartPreview(body);
      if (!preview.available) return error(preview.unavailable_reason ?? "演示任务无法提前开始。", 409);
      if (body.revision !== preview.revision) return error("演示依赖已变化，请重新核对。", 409);
      task.dependency_adjustments = [...(task.dependency_adjustments ?? []), { revision: preview.revision, at: now(), by: input.actor,
        released: preview.release_ids, remaining: preview.remaining.map(row => row.id), no_longer_waiting: preview.no_longer_waiting.map(row => row.id),
        parallel: [], previous_ticket: task.ticket ?? "", ticket: preview.ticket }];
      task.ticket = preview.ticket; task.blocked_by = preview.remaining.map(row => row.id);
      if (!task.blocked_by.length) task.status = "running";
      addFeedback("已保存演示中的依赖调整"); return json(task);
    }
    if (/^\/build-fix\/(retry|skip|stop)$/.test(route) && method === "POST") {
      task.delivery ??= {};
      const retry = route.endsWith("/retry");
      task.delivery.prepush = { state: retry ? "compiling" : "user_skipped", round: (task.delivery.prepush?.round ?? 0) + (retry ? 1 : 0),
        sha: "demo-head", message: feedback(retry ? "已模拟重跑编译的运行状态" : "已模拟停止本轮验证；没有推送代码或触发流水线"), updated_at: now() };
      task.delivery.prepush_runtime = { state: retry ? "running" : "stopped", message: task.delivery.prepush.message ?? "演示验证状态" };
      addFeedback(retry ? "已切换到演示编译状态，可以继续体验停止操作" : "已停止演示验证"); return json(task);
    }
    if (["/overall-story", "/overall-story/stop", "/overall-story/confirm", "/overall-story/architecture"].includes(route) && method === "POST") {
      if (route === "/overall-story/confirm") {
        if (body.revision && body.revision !== story.current) return error("演示文档版本已变化，请重新确认。", 409);
        story.confirmed = { revision: story.current, by: input.actor, at: now() }; story.can_confirm = false;
        story.label = "演示副本 · 文档确认已保存";
      } else if (route === "/overall-story/architecture") {
        architectureRevision = id("architecture"); story.label = "演示副本 · 架构图示例已更新";
      } else if (route === "/overall-story/stop") story.label = "演示副本 · 已停止文档整理";
      else {
        story.current = id("story-revision"); story.can_confirm = true; story.confirmed = undefined;
        story.revisions.push({ id: story.current, at: now(), by: input.actor, additions: 0, deletions: 0 });
        story.label = "演示副本 · 修订示例已保存（无实际改动统计）";
        const name = "task-materials/overall-story.md";
        localDocuments.set(name, `# 演示文档修订\n\n> 仅用于体验更新、批注和确认；未修改原文档或子任务。\n\n${readDocuments.get(name) ?? "原文未随演示读取，此处使用明确标记的交互示例。"}`);
        artifacts = artifacts.filter(row => row.name !== name);
        artifacts.push({ name, label: "演示示例 · 整体设计修订", kind: "doc", bytes: localDocuments.get(name)!.length, modified_at: now(), purpose: "overall_story", story_published: true });
      }
      addFeedback("已记录文档维护操作"); return json(story);
    }

    if (route === "/annotations" && method === "POST") {
      if (!String(body.note ?? "").trim() || !String(body.artifact ?? "").trim()) return error("请填写批注内容和文档位置。");
      const row: Annotation = { ...copy(body) as unknown as Annotation, id: id("annotation"), author: input.actor,
        created_at: now(), status: body.route === "memory" ? "verified" : "draft", kind: body.kind === "code" ? "code" : "doc",
        note: String(body.note), artifact: String(body.artifact), file: String(body.file ?? body.artifact),
        line: Number(body.line) || 1, anchor: String(body.anchor ?? ""), assignee: input.actor };
      annotations.push(row); addFeedback("已保存批注"); return json(row);
    }
    if (route === "/annotations/send" && method === "POST") {
      const items = submitted(body.ids); simulateResponse(items);
      addFeedback(`已模拟提交 ${items.length} 条意见及回复`);
      return json({ sent: items.map(row => row.id), receipt: feedback("意见已在副本中处理，可继续确认闭环") });
    }
    const annotationMatch = /^\/annotations\/([^/]+)(?:\/(reply|resolve|verify|reopen))?$/.exec(route);
    if (annotationMatch) {
      const row = annotations.find(item => item.id === decodeURIComponent(annotationMatch[1]));
      if (!row) return error("未找到演示批注。", 404);
      const action = annotationMatch[2];
      if (!action && method === "DELETE") annotations = annotations.filter(item => item.id !== row.id);
      else if (!action && method === "PATCH") {
        if (typeof body.note === "string") { row.note = body.note; row.edited_at = now(); row.rework = (row.rework ?? 0) + 1; }
        else if (typeof body.context === "string") row.agent_context = { text: body.context, by: input.actor, at: now(), revision: row.rework ?? 0 };
        else return error("批注修改内容为空。");
      } else if (action === "reply" && method === "POST") {
        row.owner_reply = { author: input.actor, text: String(body.text ?? ""), replied_at: now() };
        row.status = "sent"; row.route = "owner_reply"; row.sent_via = "owner_pending"; row.response = undefined;
      } else if ((action === "resolve" || action === "verify") && method === "POST") {
        row.status = "verified"; row.verified_at = now(); row.verified_by = input.actor;
        const outcomes = ["fixed", "not_adopted", "deferred", "accepted_risk"];
        row.resolution = { revision: row.rework ?? 0, outcome: (outcomes.includes(String(body.outcome)) ? body.outcome : "fixed") as "fixed",
          reason: String(body.reason ?? "演示：已核对处理结果"), by: input.actor, at: now() };
      } else if (action === "reopen" && method === "POST") {
        row.status = "draft"; row.rework = (row.rework ?? 0) + 1; row.returned = (row.returned ?? 0) + 1;
        row.response = undefined; row.owner_reply = undefined; row.resolution = undefined; row.sent_via = undefined; row.agent_assigned = false;
      } else return error("演示暂不支持这个批注操作。", 501);
      addFeedback("已更新批注状态"); return json(row);
    }
    if (route === "/annotation-assets" && method === "POST") {
      const encoded = String(body.content_base64 ?? "");
      if (!encoded || encoded.length > 10 * 1024 * 1024) return error("请使用小于 7 MB 的演示图片。");
      try {
        const binary = atob(encoded); const content = Uint8Array.from(binary, c => c.charCodeAt(0));
        const type = content[0] === 0x89 ? "image/png" : content[0] === 0xff ? "image/jpeg" : content[0] === 0x47 ? "image/gif" : "image/webp";
        const path = `demo-assets/${id("image")}`; images.set(path, { content, type, url: URL.createObjectURL(new Blob([content], { type })) });
        return json({ path, mime_type: type, bytes: content.length });
      } catch { return error("演示图片内容无效。"); }
    }
    if (route === "/decision" && method === "POST") {
      if (!task.waiting) return error("演示当前没有待确认问题。", 409);
      if (body.waiting_id && body.waiting_id !== task.waiting.waiting_id) return error("演示阶段已切换，请重新确认。", 409);
      if (body.state_version !== undefined && body.state_version !== task.waiting.state_version) return error("演示问题已变化，请重新确认。", 409);
      const waitingId = task.waiting.waiting_id;
      for (const row of conversation) if (row.kind === "card" && row.waiting_id === waitingId) row.status = "resolved";
      const answers = { ...(body.selected_options as Record<string, string> ?? {}), ...(body.free_responses as Record<string, string> ?? {}) };
      conversation.push({ kind: "decision", id: id("decision"), ts: now(), waiting_id: waitingId, by: input.actor,
        decision: Object.values(answers).join("；"), answers, notes: String(body.comment ?? ""),
        purpose: task.waiting.question?.purpose ?? "confirmation", annotation_ids: [] });
      if (Array.isArray(body.annotation_ids)) simulateResponse(submitted(body.annotation_ids));
      delete task.waiting; task.status = "running"; task.status_label = "演示确认已保存";
      addFeedback("已保存选择，可点击进度条演示下一阶段"); return json({});
    }
    if (route === "/interrupt" && method === "POST") {
      conversation.push({ kind: "steer", id: id("steer"), ts: now(), text: String(body.text ?? ""), delivered: false });
      addFeedback("已记录补充要求，实际任务没有收到这条消息"); return json({});
    }
    if (route === "/review-request" && method === "POST") {
      const row: ReviewRequest = { id: id("review"), task_id: taskId, task_title: task.title ?? task.requirement,
        requester: input.actor, committer: String(body.committer ?? input.actor), status: "pending",
        created_at: now(), delivered: false, attempts: 0 };
      reviews.push(row); addFeedback("已创建演示检视邀请，没有发送通知"); return json(row);
    }
    if (["/pause", "/resume", "/cancel", "/retry", "/rerun"].includes(route) && method === "POST") {
      if (route === "/rerun") { reset(); if (original.progress?.phases[0]) selectPhase(original.progress.phases[0]); }
      else {
        task.status = route === "/pause" ? "paused" : route === "/cancel" ? "canceled" : task.waiting ? "waiting_for_human" : "running";
        task.status_label = `演示：${route === "/pause" ? "已暂停" : route === "/cancel" ? "已停止" : "已恢复"}`;
        if (route === "/pause" || route === "/resume" || route === "/cancel") task.control = { last_action: route.slice(1) as "pause", actor: input.actor, at: now() };
      }
      addFeedback("已更新副本的运行状态"); return json(task);
    }
    if (route === "/skills/sync" && method === "POST") {
      addFeedback("已演示 Skill 同步入口，保留原任务的 Skill 快照");
      return json({ added: [], warnings: ["演示不会读取或更新真实 Skill 版本。"], receipt: feedback("同步操作已记录") });
    }
    if (route === "/delivery-report" && method === "POST") {
      const name = "task-materials/交付报告.md";
      localDocuments.set(name, "# 演示交付报告\n\n> 演示示例，不是实际代码、测试或交付证明。\n\n本页展示交付报告入口。实际演示应打开原任务的报告，核对代码变化、已有验证和未验证项。\n");
      artifacts = artifacts.filter(row => row.name !== name);
      artifacts.push({ name, label: "演示示例 · 交付报告", kind: "doc", bytes: localDocuments.get(name)!.length, modified_at: now() });
      task.delivery_report = { status: "completed", available: true, head: "demo", message: "演示示例已生成，未运行分析或测试。" };
      addFeedback("已创建带有演示标记的报告示例"); return json(task);
    }
    if (route === "/correct-ticket" && method === "POST") {
      if (body.action !== "cancel") { task.ticket = String(body.ticket ?? ""); task.title = String(body.title ?? task.title ?? ""); }
      addFeedback("已更新副本单号，真实单号、分支和 MR 保持不变"); return json(task);
    }
    if (route === "/continue-delivery" && method === "POST") {
      task.status = "running"; delete task.completed_at; addFeedback(`已记录后续修改：${String(body.text ?? "")}`); return json(task);
    }
    if (route === "/push-confirmation" && method === "PUT") { task.push_confirmation = body.on === true; return json(task); }
    if (route === "/moonlight" && method === "PUT") {
      if (!["inherit", "manual", "moonlight"].includes(String(body.mode))) return error("无效的演示审批方式。");
      task.approval_mode = body.mode as TaskSummary["approval_mode"]; return json({ task, swept: 0, blocked_annotations: 0 });
    }
    if (route === "/collaborators" && method === "PUT") {
      task.collaborators = Array.isArray(body.collaborators) ? body.collaborators.map(String) : []; return json(task);
    }
    if (route === "/repository-assignees" && method === "PUT") {
      const assignees = body.repository_assignees as Record<string, string> | undefined;
      const tickets = body.repository_tickets as Record<string, string> | undefined;
      task.requirement_graph?.repositories.forEach(row => { if (assignees?.[row.id]) row.assignee = String(assignees[row.id]); if (tickets?.[row.id]) row.ticket = String(tickets[row.id]); });
      return json(task);
    }
    if (route === "/refresh-mr" && method === "POST") return json({ message: "演示仅展示原任务的 MR 快照，没有查询或关联真实 MR。", candidates: [] });
    if (route.startsWith("/developer-assistant") && method === "POST") {
      if (route === "/developer-assistant") {
        const at = now(); assistant.state = "ready";
        assistant.messages.push({ id: id("assistant-user"), role: "user", text: String(body.text ?? ""), at },
          { id: id("assistant-demo"), role: "assistant", text: feedback("已模拟接收说明，可以体验结束助手并返回主任务"), at });
        task.assistant_engaged = true; task.status = "paused";
      } else if (route === "/developer-assistant/interrupt") assistant.state = "interrupted";
      else if (route === "/developer-assistant/return") { task.assistant_engaged = false; task.status = task.waiting ? "waiting_for_human" : "running"; addFeedback("已交回演示任务"); return json(task); }
      else return error("演示暂不支持这个助手操作。", 501);
      return json(assistant);
    }
    if (route === "/scope-decision" && method === "POST") { if (task.delivery) delete task.delivery.scope_violation; addFeedback("已记录目录范围的演示决定"); return json({}); }
    if (!route && method === "DELETE") { task.status = "canceled"; task.status_label = "演示副本已删除"; addFeedback("副本已标记删除"); return json({}); }
    return error("演示暂不支持这个操作；没有向真实任务发送任何请求。", 501);
  }

  reset();
  demoAssets.set(taskId, path => images.get(path)?.url);
  return { sourceTaskId, taskId, get task() { return getTask(); }, getTask,
    subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    fetch: sandboxFetch as typeof fetch, selectPhase, reset,
    resolveAsset(path) { return disposed ? undefined : images.get(path)?.url; },
    dispose() { disposed = true; demoAssets.delete(taskId); for (const controller of reads) controller.abort(); reads.clear(); readCache.clear(); readPending.clear(); listeners.clear();
      localDocuments.clear(); revokeAssets();
    memoryHistory.clear();
    architectureRevision = "demo-architecture-0"; annotations = []; conversation = []; reviews = []; artifacts = []; },
  };
}
