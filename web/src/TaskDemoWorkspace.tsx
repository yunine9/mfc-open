import { useEffect, useRef, useState } from "react";
import { statusText, type AuthUser, type TaskSummary } from "./api";
import { TaskWorkspace } from "./TaskWorkspace";
import { MemoryBoard } from "./MemoryBoard";
import { ConfirmDialogHost } from "./ConfirmDialog";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { createTaskDemoSandbox } from "./taskDemoSandbox";
import { suggestedDemoMessage, taskDemoPhaseCard, TASK_DEMO_ANALYSIS_PHASE, type TaskDemoPreviewInput, type TaskDemoSnapshot } from "./taskDemoTypes";
import "./TaskDemo.css";

type Sandbox = ReturnType<typeof createTaskDemoSandbox>;
type DemoEntry = { sandbox: Sandbox; snapshot: TaskDemoSnapshot };
type DemoSession = DemoEntry & { actor: string; actorName: string; backLabel: string };
type OriginalTransport = {
  fetch: typeof fetch;
  events: typeof EventSource;
  beacon: typeof navigator.sendBeacon;
};

function exitDemo() {
  if (window.parent !== window) window.parent.postMessage({ type: "mae-flow-demo-close" }, location.origin);
  else location.assign("/");
}

/** 仅为已知关联显示导航；请求仍使用副本 ID，权限仍由副本处理。 */
function taskWithDemoNavigation({ sandbox, snapshot }: DemoEntry): TaskSummary {
  const task = sandbox.getTask();
  const source = snapshot.task;
  if (source.parent_task_id) task.parent_task_id = source.parent_task_id;
  if (source.parent_task) task.parent_task = structuredClone(source.parent_task);
  if (task.requirement_graph && source.requirement_graph) {
    const sourceRows = new Map(source.requirement_graph.repositories.map(row => [row.id, row]));
    for (const row of task.requirement_graph.repositories) {
      const taskId = sourceRows.get(row.id)?.task_id;
      if (taskId) row.task_id = taskId === snapshot.source_task_id ? sandbox.taskId : taskId;
    }
  }
  if (task.blocked_by?.length && source.blocked_by?.length) {
    const localDependencies = new Map(source.blocked_by.map((id, index) => [`${sandbox.taskId}-dependency-${index + 1}`, id]));
    task.blocked_by = task.blocked_by.map(id => localDependencies.get(id) ?? id);
  }
  return task;
}

function relatedTaskIds(snapshot: TaskDemoSnapshot): Set<string> {
  return new Set([
    snapshot.source_task_id,
    snapshot.task.parent_task_id,
    snapshot.task.parent_task?.id,
    ...(snapshot.task.blocked_by ?? []),
    ...(snapshot.task.requirement_graph?.repositories.map(row => row.task_id) ?? []),
  ].filter((id): id is string => Boolean(id)));
}

export default function TaskDemoWorkspace({ sourceTaskId, preview }: {
  sourceTaskId?: string; preview?: TaskDemoPreviewInput;
}) {
  const [session, setSession] = useState<DemoSession>();
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  const [stageFocus, setStageFocus] = useState(0);
  const [retryTask, setRetryTask] = useState<string>();
  const [memoryOpen, setMemoryOpen] = useState(false);
  const initial = useRef({ sourceTaskId, preview });
  const originals = useRef<OriginalTransport | null>(null);
  const navigate = useRef<(taskId: string) => void>(() => {});
  const goBack = useRef<() => void>(exitDemo);
  const retryInitial = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let current: DemoEntry | undefined;
    let actor: AuthUser | undefined;
    let navigation = 0;
    const controller = new AbortController();
    const entries = new Map<string, DemoEntry>();
    const byCopyId = new Map<string, DemoEntry>();
    const pending = new Map<string, Promise<DemoEntry>>();
    const unsubscribes: Array<() => void> = [];
    let visited: string[] = [];
    const input = initial.current;
    const original = originals.current ??= {
      fetch: window.fetch, events: window.EventSource, beacon: navigator.sendBeacon,
    };
    const originalFetch = original.fetch.bind(window);
    const read = input.preview?.fetchRead ?? originalFetch;
    const previewSnapshots = new Map([
      ...(input.preview ? [input.preview.snapshot, ...(input.preview.relatedSnapshots ?? [])] : []),
    ].map(snapshot => [snapshot.source_task_id, snapshot]));
    const previewQuery = new URLSearchParams(location.search);
    const previewTaskId = previewQuery.get("taskDemoTask");
    const initialTaskId = input.preview
      ? previewTaskId && previewSnapshots.has(previewTaskId) ? previewTaskId : input.preview.snapshot.source_task_id
      : input.sourceTaskId;
    const blocked = (message: string, status = 403) => Promise.resolve(new Response(JSON.stringify({ error: message }), {
      status, headers: { "content-type": "application/json", "cache-control": "no-store" },
    }));

    // 任务切换不替换 fetch；旧组件迟到的请求仍只进入原来的副本。
    const dispatch: typeof fetch = (request, init) => {
      if (!alive) return blocked("演示已退出，副本已清除。", 410);
      let url: URL;
      try { url = new URL(request instanceof Request ? request.url : String(request), location.href); }
      catch { return blocked("演示请求地址无效。", 400); }
      if (url.origin !== location.origin) return blocked("演示不能访问外部接口。");
      let target = current;
      try {
        const taskMatch = /^\/tasks\/([^/]+)(?:\/|$)/.exec(url.pathname);
        if (taskMatch) {
          target = byCopyId.get(decodeURIComponent(taskMatch[1]));
          if (!target) return blocked("演示只能访问已加载的任务副本。");
        } else {
          const recordMatch = /^\/(?:memory-insights|reviews)\/([^/]+)/.exec(url.pathname);
          if (recordMatch) {
            const id = decodeURIComponent(recordMatch[1]);
            target = [...byCopyId.values()].find(entry => id.startsWith(`${entry.sandbox.taskId}-`)) ?? current;
          }
        }
      } catch { return blocked("演示请求地址无效。", 400); }
      return target ? target.sandbox.fetch(request, init) : blocked("演示副本尚未准备完成。");
    };
    window.fetch = dispatch;
    class SnapshotEvents extends EventTarget {
      static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSED = 2;
      readonly CONNECTING = 0; readonly OPEN = 1; readonly CLOSED = 2;
      readyState = 2; withCredentials = false; url: string;
      onopen = null; onmessage = null; onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        super(); this.url = String(url);
        queueMicrotask(() => { const event = new Event("error"); this.onerror?.(event); this.dispatchEvent(event); });
      }
      close() { this.readyState = 2; }
    }
    window.EventSource = SnapshotEvents as unknown as typeof EventSource;
    navigator.sendBeacon = () => false;

    function show(entry: DemoEntry) {
      if (!alive || !actor) return;
      current = entry;
      const id = entry.snapshot.source_task_id;
      const previous = visited.indexOf(id);
      visited = previous >= 0 ? visited.slice(0, previous + 1) : [...visited, id];
      setSession({ ...entry, actor: actor.username, actorName: actor.display_name ?? actor.username,
        backLabel: visited.length > 1 ? "返回上一任务" : "退出演示" });
      setMemoryOpen(false); setNotice(""); setRetryTask(undefined); setError("");
    }

    async function load(taskId: string): Promise<DemoEntry> {
      const cached = entries.get(taskId);
      if (cached) return cached;
      const loading = pending.get(taskId);
      if (loading) return loading;
      const operation = (async () => {
        let snapshot = previewSnapshots.get(taskId);
        if (!snapshot) {
          if (input.preview) throw new Error("这个任务没有演示样例资料。");
          const response = await originalFetch(`/tasks/${encodeURIComponent(taskId)}/demo-snapshot`, { signal: controller.signal });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            throw new Error(body.error ?? "演示资料暂时无法读取，请稍后重试。");
          }
          snapshot = await response.json() as TaskDemoSnapshot;
        }
        if (!alive || !actor) throw new Error("演示已退出。");
        if (snapshot.schema !== "mae-flow-demo-snapshot/1" || snapshot.source_task_id !== taskId || snapshot.task.id !== taskId) {
          throw new Error("演示资料与所选任务不一致，请重试。");
        }
        // 读取真实记录即可打开；模型生成不属于进入或切换演示的前置条件。
        const sandbox = createTaskDemoSandbox({ task: snapshot.task, actor: actor.username,
          conversation: snapshot.conversation.items, annotations: snapshot.annotations.items,
          artifacts: snapshot.artifacts, reviews: snapshot.reviews, phaseSteps: snapshot.phase_steps,
          stepTitles: snapshot.step_titles, cardContexts: snapshot.card_contexts,
          memories: snapshot.memories, memoryUsage: snapshot.memoryUsage,
          architecture: input.preview?.architecture,
          fetchRead: (request, init) => {
            const method = (init?.method ?? (request instanceof Request ? request.method : "GET")).toUpperCase();
            const diagram = method === "POST" && request === "/diagrams/plantuml";
            if (method !== "GET" && method !== "HEAD" && !diagram) return Promise.reject(new Error("演示副本不能写入原任务。"));
            // 图源来自副本文档，渲染仍使用平台接口；预览资料只负责提供文档内容。
            return (diagram ? originalFetch : read)(request, { ...init, method, signal: init?.signal
              ? AbortSignal.any([controller.signal, init.signal]) : controller.signal });
          },
        });
        try {
          const phases = sandbox.getTask().progress?.phases ?? [];
          const phase = !snapshot.task.parent_task_id && snapshot.task.requirement_graph && phases.includes(TASK_DEMO_ANALYSIS_PHASE)
            ? TASK_DEMO_ANALYSIS_PHASE : phases[0];
          const previewPhase = input.preview && taskId === initialTaskId ? previewQuery.get("taskDemoPhase") : null;
          if (previewPhase && phases.includes(previewPhase)) sandbox.selectPhase(previewPhase);
          else if (phase) sandbox.selectPhase(phase);
        } catch (reason) { sandbox.dispose(); throw reason; }
        const entry = { sandbox, snapshot };
        entries.set(taskId, entry); byCopyId.set(sandbox.taskId, entry);
        unsubscribes.push(sandbox.subscribe(() => { if (alive) setRevision(value => value + 1); }));
        return entry;
      })();
      pending.set(taskId, operation);
      try { return await operation; }
      finally { pending.delete(taskId); }
    }

    function openTask(requestedId: string) {
      if (!current) return;
      const taskId = byCopyId.get(requestedId)?.snapshot.source_task_id ?? requestedId;
      if (!entries.has(taskId) && !relatedTaskIds(current.snapshot).has(taskId)) {
        setNotice("这里只能打开当前任务关联的演示副本。"); setRetryTask(undefined); return;
      }
      const request = ++navigation;
      const cached = entries.get(taskId);
      if (cached) { show(cached); return; }
      setNotice("正在读取关联任务的演示资料…"); setRetryTask(undefined);
      void load(taskId).then(entry => {
        if (alive && request === navigation) show(entry);
      }).catch(reason => {
        if (alive && request === navigation) {
          setNotice(reason instanceof Error ? reason.message : String(reason)); setRetryTask(taskId);
        }
      });
    }
    navigate.current = openTask;
    goBack.current = () => {
      if (visited.length <= 1) { exitDemo(); return; }
      const entry = entries.get(visited[visited.length - 2]);
      if (entry) { navigation += 1; show(entry); }
    };

    async function openInitial() {
      const request = ++navigation;
      setError("");
      actor = input.preview?.actor;
      if (!actor) {
        const response = await originalFetch("/auth/me", { signal: controller.signal });
        if (!response.ok) throw new Error("请使用管理员账户登录后进入演示模式。");
        actor = await response.json() as AuthUser;
      }
      if (actor.role !== "admin") throw new Error("只有 admin 账户可以进入演示模式。请返回后使用管理员账户登录。");
      const id = initialTaskId;
      if (!id) throw new Error("缺少演示来源任务。");
      const entry = await load(id);
      if (alive && request === navigation) show(entry);
    }
    const start = () => { void openInitial().catch(reason => {
      if (alive) setError(reason instanceof Error ? reason.message : String(reason));
    }); };
    retryInitial.current = start;

    const onLink = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!target || target.getAttribute("href")?.startsWith("#")) return;
      const url = new URL(target.href, location.href);
      if (url.protocol === "blob:") return;
      if (current && url.origin === location.origin && url.pathname === "/"
          && url.searchParams.get("deliveryAnalysis") === "1"
          && url.searchParams.get("deliveryTask") === current.snapshot.source_task_id
          && (input.preview ? url.searchParams.get("taskDemoPreview") === "1" : !url.searchParams.has("taskDemoPreview"))) return;
      event.preventDefault();
      if (url.origin === location.origin && url.searchParams.get("kbPage") === "experience") {
        setMemoryOpen(true); return;
      }
      if (url.origin === location.origin) {
        const match = /^\/work\/([^/]+)(?:\/|$)/.exec(url.pathname);
        const taskId = match ? decodeURIComponent(match[1]) : url.searchParams.get("task");
        if (taskId) { openTask(taskId); return; }
      }
      if (target.hasAttribute("download") && url.origin === location.origin) {
        void dispatch(url.href).then(async response => {
          if (!response.ok) throw new Error("演示副本暂不提供这份文件的下载。");
          const blob = URL.createObjectURL(await response.blob());
          const link = document.createElement("a"); link.href = blob; link.download = target.download || "演示材料";
          link.click(); window.setTimeout(() => URL.revokeObjectURL(blob), 1000);
        }).catch(reason => { if (alive) setNotice(String(reason.message ?? reason)); });
      } else setNotice("演示副本保留当前工作台；外部链接请退出演示后查看。");
    };
    document.addEventListener("click", onLink, true);
    // 分析页返回仍在内存中的演示副本，保留批注、决定和主子任务位置。
    const returnChannel = input.preview && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("mae-flow-demo-return") : undefined;
    if (returnChannel) returnChannel.onmessage = ({ data }) => {
      if (!alive || data?.type !== "return-to-demo" || typeof data.requestId !== "string") return;
      const entry = byCopyId.get(data.copyId);
      if (!entry) return;
      if (current !== entry) { navigation += 1; show(entry); }
      window.focus();
      returnChannel.postMessage({ type: "demo-returned", requestId: data.requestId });
    };
    start();
    return () => {
      alive = false; controller.abort();
      returnChannel?.close();
      navigate.current = () => {}; goBack.current = exitDemo; retryInitial.current = () => {};
      unsubscribes.forEach(unsubscribe => unsubscribe());
      entries.forEach(entry => entry.sandbox.dispose());
      entries.clear(); byCopyId.clear(); pending.clear();
      document.removeEventListener("click", onLink, true);
      window.fetch = original.fetch; window.EventSource = original.events; navigator.sendBeacon = original.beacon;
    };
  }, []);

  if (error && !session) return <main className="task-demo-loading"><h1>无法打开演示副本</h1><p role="alert">{error}</p><button onClick={() => retryInitial.current()}>重试</button><button onClick={exitDemo}>返回工作台</button></main>;
  if (!session) return <main className="task-demo-loading"><h1>正在准备演示副本</h1><p>读取任务资料与历史回复…</p></main>;
  const { sandbox, snapshot, actor, actorName } = session;
  const task = taskWithDemoNavigation(session);
  const phase = task.progress?.current_phase ?? "";
  return <>
    <TaskWorkspace key={task.id} task={task} viewerUsername={actor} viewerDisplayName={`${actorName} · 演示 owner`}
      canOverride canOperate canCollaborate canRequestReview
      onChanged={() => setRevision(value => value + 1)} onClose={() => goBack.current()}
      onOpenTask={taskId => navigate.current(taskId)}
      demo={{ phase, backLabel: session.backLabel, sourceTaskId: snapshot.source_task_id, sourceLabel: snapshot.task.title ?? snapshot.task.requirement,
        sourceStatus: statusText(snapshot.task), preview: Boolean(preview),
        onSelectPhase: selected => { setStageFocus(value => value + 1); sandbox.selectPhase(selected); setNotice(""); setRetryTask(undefined); },
        onReset: () => { setStageFocus(value => value + 1); sandbox.reset(); if (phase && sandbox.getTask().progress?.phases.includes(phase)) sandbox.selectPhase(phase); setNotice("已重置演示副本，原任务没有变化。"); setRetryTask(undefined); },
        onExit: exitDemo, suggestedMessageId: suggestedDemoMessage(snapshot, phase),
        suggestedCardId: taskDemoPhaseCard(snapshot, phase)?.id, focusKey: stageFocus }}
      demoRevision={revision} />
    <ConfirmDialogHost />
    <Dialog open={memoryOpen} onOpenChange={open => {
      setMemoryOpen(open);
      if (!open) { const url = new URL(location.href); url.searchParams.delete("memory_id"); history.replaceState(null, "", url); }
    }}>
      <DialogContent className="!w-[min(1500px,94vw)] !max-w-none max-h-[90vh] overflow-auto">
        <DialogTitle>演示副本 · 经验审查与复用</DialogTitle>
        <p className="text-sm text-muted-foreground">采纳、修订和停用仅保存在演示副本，不会进入团队知识库。</p>
        <MemoryBoard onOpenTask={taskId => { setMemoryOpen(false); navigate.current(taskId); }} />
      </DialogContent>
    </Dialog>
    {notice && <div className="task-demo-toast" role="status">{notice}
      {retryTask && <button onClick={() => navigate.current(retryTask)}>重试</button>}
      <button onClick={() => { setNotice(""); setRetryTask(undefined); }} aria-label="关闭提示">×</button>
    </div>}
  </>;
}
