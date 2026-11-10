import { useEffect, useRef, useState } from "react";
import { withArchifyPresentation } from "./archifyPresentation";
import { storyViewCoverage, type StoryViewCoverage } from "../../src/storyViewCoverage";
import { storyViewTitles } from "./storyViewTitles";
import type { ArchitectureNode } from "../../src/architectureDetails";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/Empty";

interface Projection {
  revision: string; renderer: string; warnings: string[];
  diagrams: Array<{ id: string; title: string; type: string; renderer?: string; line?: number; view?: StoryViewCoverage["id"]; nodes?: ArchitectureNode[]; overview_id?: string; focus_node?: string }>;
  views?: StoryViewCoverage[];
}
interface GenerationJob { started_at?: string; progress?: string; kind?: string }
interface GenerationState { job?: GenerationJob; error?: string; error_kind?: "story" | "architecture" }
async function read<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `读取失败（${response.status}）`);
  return body;
}

/** Story 与平台图源由服务端绑定版本；这里只保存选择状态，不显示过期图。 */
export function StoryArchitecture({ taskId, onOpenStory, requestedLine, onOpenView, onAnnotate, canUpdate = false, flush = false }: { taskId: string; onOpenStory(): void; requestedLine?: number; onOpenView?(id: string): void; onAnnotate?(note: string): Promise<void>; canUpdate?: boolean; /** 任务工作台 chain 视图挂载:去 padding、交出滚动(贴边豁免,滚动归 ws-doc)。 */ flush?: boolean }) {
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentError, setCommentError] = useState("");
  async function saveComment() {
    if (!onAnnotate || !comment.trim() || commentBusy) return;
    setCommentBusy(true); setCommentError("");
    try { await onAnnotate(comment.trim()); setComment(""); setCommentOpen(false); }
    catch (reason) { setCommentError(reason instanceof Error ? reason.message : "保存失败，请重试"); }
    finally { setCommentBusy(false); }
  }
  const [projection, setProjection] = useState<Projection>();
  const [selected, setSelected] = useState("");
  const [activeView, setActiveView] = useState("logical");
  const [error, setError] = useState("");
  const [pulse, refresh] = useState(0);
  const [job, setJob] = useState<{ busy: boolean; error?: string; errorKind?: GenerationState["error_kind"]; detail?: GenerationJob }>({ busy: false });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!job.busy) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job.busy]);
  const [submitting, setSubmitting] = useState(false);
  const generationBase = `/tasks/${encodeURIComponent(taskId)}/overall-story`;
  useEffect(() => {
    if (!canUpdate) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let wasBusy = false;
    async function poll() {
      try {
        const state = await read<GenerationState>(generationBase, controller.signal);
        if (controller.signal.aborted) return;
        setJob({ busy: !!state.job, error: state.error, errorKind: state.error_kind, detail: state.job });
        if (wasBusy && !state.job) refresh((n) => n + 1);
        wasBusy = !!state.job;
      } catch (reason) {
        if (!controller.signal.aborted) setJob((previous) => ({ ...previous, errorKind: "architecture",
          error: `进度暂时无法读取：${reason instanceof Error ? reason.message : String(reason)}` }));
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2000);
    }
    setJob({ busy: false }); void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [generationBase, canUpdate]);
  async function updateArchitecture() {
    setSubmitting(true);
    try {
      const response = await fetch(`${generationBase}/architecture`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "更新失败");
      setJob({ busy: !!body.job, error: body.error, errorKind: body.error_kind, detail: body.job });
    } catch (reason) { setJob({ busy: false, errorKind: "architecture",
      error: reason instanceof Error ? reason.message : String(reason) }); }
    finally { setSubmitting(false); }
  }
  const [rendered, setRendered] = useState<{ key: string; html?: string; error?: string }>();
  const frame = useRef<HTMLIFrameElement>(null);
  const [presenting, setPresenting] = useState("");
  const base = `/tasks/${encodeURIComponent(taskId)}/architecture`;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setProjection(undefined); setError("");
    async function update() {
      try {
        const next = await read<Projection>(base, controller.signal);
        if (!controller.signal.aborted) {
          setProjection((previous) => previous?.revision === next.revision ? previous : next);
          setError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted) { setError(String(reason instanceof Error ? reason.message : reason)); setProjection(undefined); }
      }
      if (!controller.signal.aborted) timer = setTimeout(update, 5000);
    }
    void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [base, pulse]);
  useEffect(() => {
    const requested = requestedLine === undefined ? undefined : projection?.diagrams.find((item) => item.line === requestedLine);
    if (requested) {
      setSelected(requested.id);
      const line = requested.line!;
      const owner = projection?.views?.filter((view) => view.line !== undefined && line > view.line && line <= (view.endLine ?? view.line))
        .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
      setActiveView(requested.view ?? owner?.id ?? "logical");
    }
  }, [requestedLine, projection?.revision]);
  const views = projection?.views ?? storyViewCoverage("");
  const ownerOf = (line?: number) => line === undefined ? undefined : views.filter((item) => item.line !== undefined && line > item.line && line <= (item.endLine ?? item.line))
    .sort((a, b) => (a.endLine! - a.line!) - (b.endLine! - b.line!))[0];
  const diagramView = (item: Projection["diagrams"][number]) => item.view ?? ownerOf(item.line)?.id ?? "logical";
  const availableViews = views.filter((item) => projection?.diagrams.some((diagram) => diagramView(diagram) === item.id));
  const view = availableViews.find((item) => item.id === activeView) ?? availableViews[0];
  const diagrams = view ? projection?.diagrams.filter((item) => diagramView(item) === view.id) ?? [] : [];
  const parentOf = (item: Projection["diagrams"][number]) => diagrams.find(root => root.id !== item.id && !root.overview_id && root.id === item.overview_id && root.nodes?.some(n => n.id === item.focus_node));
  const roots = diagrams.filter(item => !parentOf(item));
  const diagram = diagrams.find((item) => item.id === selected) ?? roots[0];
  const parent = diagram && parentOf(diagram);
  const overview = parent ?? diagram;
  const detailScope = `${base}/${projection?.revision}/${overview?.id}`;
  const [nodeSelection, setNodeSelection] = useState<{scope:string; id:string}>();
  const node = nodeSelection?.scope === detailScope ? overview?.nodes?.find(n => n.id === nodeSelection.id) : undefined;
  const related = node && diagrams.find(item => item.overview_id === overview?.id && item.focus_node === node.id);
  const key = `${base}/${projection?.revision}/${diagram?.id}/${pulse}`;
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // 沙箱图的 origin 是 null，只接受当前 iframe 的窗口，忽略其他页面/旧图。
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      if (event.data?.type === "mfc:archify-node" && typeof event.data.id === "string"
        && diagram?.nodes?.some(n => n.id === event.data.id)) {
        setNodeSelection({scope:detailScope, id:event.data.id});
      } else if (event.data?.type === "mfc:archify-presentation") setPresenting(event.data.active === true ? key : "");
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || presenting !== key) return;
      frame.current?.contentWindow?.postMessage({ type: "mfc:archify-exit" }, "*");
      setPresenting("");
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("keydown", onEscape);
    return () => { window.removeEventListener("message", onMessage); window.removeEventListener("keydown", onEscape); };
  }, [key, presenting, detailScope, diagram]);
  useEffect(() => {
    if (!diagram || !projection) return;
    const controller = new AbortController();
    void read<{ html?: string; error?: string; revision: string }>(
      `${base}/${diagram.id}?revision=${encodeURIComponent(projection.revision)}`, controller.signal,
    ).then((result) => {
      if (!controller.signal.aborted) setRendered({ key, ...result,
        error: result.error || (!result.html ? "渲染器未返回图像" : undefined),
        html: result.html ? withArchifyPresentation(result.html, !!diagram.nodes?.length) : undefined });
    }).catch((reason) => {
      if (!controller.signal.aborted) setRendered({ key, error: reason instanceof Error ? reason.message : String(reason) });
    });
    return () => controller.abort();
  }, [key, base, diagram, projection]);
  const current = rendered?.key === key ? rendered : undefined;
  // 皮(#233 收官):原 story-architecture.css 换装为工具类(按钮/错误盒配方见 btn/errbox)。
  // flush 是 chain 视图的贴边豁免:旧规则 .ws-doc.is-chain > .story-architecture
  // {padding:0;overflow:visible} 的直译——ws-doc 是唯一滚动层,本层不再
  // 自带 20px 留白和内嵌滚动,避免嵌套双滚动(#253)。
  const shell = flush
    ? "flex-1 min-w-0 min-h-0 overflow-visible p-0"
    : "flex-1 min-w-0 min-h-0 overflow-auto p-5 max-[600px]:p-3";
  const btn = "cursor-pointer rounded-[7px] border border-line bg-surface px-3 py-[7px] transition-colors hover:border-primary hover:text-primary";
  const errbox = "w-full rounded-lg border border-attention/30 bg-attention/5 p-2.5 text-left [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-attention [&_summary]:[overflow-wrap:anywhere] [&_pre]:mt-2.5 [&_pre]:max-h-60 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:[overflow-wrap:anywhere] [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-[1.65] [&_pre]:text-text";
  return <section className={shell} aria-label="Story 架构图">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><strong className="text-[18px]">架构图</strong><p className="text-xs leading-[1.7] text-muted-foreground">这里只展示已经生成的图；完整 4+1 设计与未涉及原因请阅读 Story</p></div>
      <div className="flex flex-wrap gap-2">
        {onAnnotate && <button type="button" className={btn} onClick={() => setCommentOpen(true)}>对架构设计提批注</button>}
        <button type="button" className={btn} onClick={onOpenStory}>阅读完整 Story ↗</button>
        {canUpdate && <button type="button" className={btn} onClick={() => void updateArchitecture()} disabled={submitting || job.busy}
          aria-label="更新架构图" title="根据当前 Story 生成或更新架构图">{submitting || job.busy ? "更新中…" : "↻"}</button>}
      </div>
    </header>
    {commentOpen && <form className="my-4 rounded-lg border border-line bg-surface p-4" onSubmit={event => {event.preventDefault(); void saveComment();}}>
      <label className="block text-sm font-semibold" htmlFor="architecture-comment">对整体模块划分、职责或协作关系的意见</label>
      <textarea id="architecture-comment" autoFocus className="mt-2 min-h-24 w-full rounded-md border border-line bg-surface p-3 text-[15px]" value={comment} onChange={event=>setComment(event.target.value)} disabled={commentBusy} />
      <p className="my-2 text-xs leading-relaxed text-muted-foreground">保存后进入检视意见，统一提交给 Agent。修改 Story 后需更新架构图；新版图与职责生成后页面会自动刷新。</p>
      {commentError && <p role="alert" className="my-2 text-sm text-danger">{commentError}</p>}
      <div className="flex gap-2"><button type="submit" className={btn} disabled={commentBusy || !comment.trim()}>{commentBusy ? "保存中…" : "保存批注"}</button><button type="button" className={btn} disabled={commentBusy} onClick={()=>setCommentOpen(false)}>取消</button></div>
    </form>}
    {job.busy && <p className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-[13px] text-muted-foreground" role="status" aria-live="polite">
      <span>{job.detail?.progress || (job.detail?.kind === "architecture" ? "Agent 正在更新架构图" : "Story 正在更新，请稍候")}</span>
      {job.detail?.started_at && Number.isFinite(Date.parse(job.detail.started_at)) && <small aria-live="off">
        已用时 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 60000)} 分 {Math.floor(Math.max(0, now - Date.parse(job.detail.started_at)) / 1000) % 60} 秒
      </small>}
    </p>}
    {job.errorKind === "architecture" && job.error && <details className={errbox}>
      <summary>上次架构图生成未完成 · 查看原因</summary><pre>{job.error}</pre>
    </details>}
    {error ? <Empty className="min-h-[280px]">
      <EmptyMedia className="text-3xl font-light text-muted-foreground">◇</EmptyMedia>
      <EmptyTitle>架构图暂时无法读取</EmptyTitle>
      <EmptyDescription>错误只影响架构图展示，可以稍后重试。</EmptyDescription>
      <EmptyContent><details className={errbox + " mt-3"}>
        <summary>查看失败详情</summary><pre>{error}</pre>
      </details></EmptyContent>
    </Empty> : !projection ? <p role="status">正在读取 Story…</p> : <>
      {requestedLine !== undefined && !projection.diagrams.some((item) => item.line === requestedLine) &&
        <p className="text-xs text-attention [overflow-wrap:anywhere]" role="status">原图位置已变化或图源无法读取，请选择下方图名，或返回 Story 查看。</p>}
      {availableViews.length > 0 ? <>
      <div className="my-4 flex flex-wrap items-center gap-3 text-sm">
        {availableViews.length > 1 && <label className="flex items-center gap-2">设计视角
          <select className={btn} aria-label="设计视角" value={view?.id} onChange={e => {setActiveView(e.target.value);setSelected("");}}>
            {availableViews.map(item=><option key={item.id} value={item.id}>{storyViewTitles[item.id]}</option>)}
          </select></label>}
        {roots.length > 1 && <label className="flex items-center gap-2">设计图
          <select className={btn} aria-label="设计图" value={overview?.id} onChange={e=>setSelected(e.target.value)}>
            {roots.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
          </select></label>}
        <span className="text-muted-foreground">{parent ? `当前范围：${diagram.title}及直接关联` : "当前范围：总览"}</span>
        {parent && <button className={btn} onClick={()=>setSelected(overview!.id)}>返回总览</button>}
        {!!overview?.nodes?.length && <label className="ml-auto flex items-center gap-2">查看职责
          <select className={btn} aria-label="选择节点查看职责" value={node?.id ?? ""} onChange={e=>setNodeSelection({scope:detailScope,id:e.target.value})}>
            <option value="">点击图中节点，或在此选择</option>
            {overview.nodes.map(n=><option key={n.id} value={n.id}>{n.name}</option>)}
          </select></label>}
      </div>
      <div className={node ? "grid grid-cols-[minmax(0,1fr)_320px] items-start gap-4" : "min-w-0"}>
        <div className="min-w-0">
          {current?.error ? <div className="rounded-[10px] border border-line p-4 leading-[1.7] [&_details]:mt-3 [&_summary]:cursor-pointer [&_summary]:text-muted-foreground [&_pre]:max-h-70 [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:text-xs [overflow-wrap:anywhere]">
            <p role="status">这张图暂时无法展示。请在完整 Story 中批注反馈；图源修订后会自动更新。</p>
            <button type="button" className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-xs text-primary hover:underline" onClick={onOpenStory}>打开 Story 提意见</button>
            <details><summary>查看失败详情</summary><pre>{current.error}</pre></details>
          </div> : current?.html ? <iframe key={key} ref={frame} title={diagram.title} srcDoc={current.html}
            className={presenting === key
              ? "fixed inset-0 z-(--z-modal) h-dvh w-screen max-w-none rounded-none border-0 bg-[#101620]"
              : "block h-[max(560px,65vh)] w-full rounded-[10px] border border-line bg-[#101620] max-[600px]:h-[65vh] max-[600px]:min-h-[460px]"}
            allow="fullscreen *" allowFullScreen sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer" />
            : <p className="grid min-h-80 place-items-center text-[13px] text-muted-foreground" role="status">正在生成架构图…</p>}
        </div>
        {node && <aside aria-label="节点职责详情" className="rounded-xl border border-line bg-surface p-4 text-[15px] leading-relaxed">
          <div className="flex items-start justify-between gap-3"><h3 className="text-lg font-semibold">{node.name}</h3><button className={btn} aria-label="关闭节点详情" onClick={()=>setNodeSelection(undefined)}>关闭</button></div>
          {node.summary && <p className="mt-3 text-primary">{node.summary}</p>}
          <h4 className="mt-5 font-semibold">具体职责</h4>
          <p className="mt-2 whitespace-pre-wrap break-words">{node.responsibility || "当前图源未提供详细职责，请查看 Story 中的设计说明。"}</p>
          {node.interfaces && <><h4 className="mt-5 font-semibold">输入与输出</h4><p className="mt-2 whitespace-pre-wrap break-words">{node.interfaces}</p></>}
          {!!node.relationships.length && <><h4 className="mt-5 font-semibold">与谁协作</h4><ul className="mt-2 space-y-2">{node.relationships.map((r,i)=><li key={i}>{r}</li>)}</ul></>}
          {related && <button className={btn + " mt-4"} onClick={()=>setSelected(related.id)}>只看相关关系</button>}
          {node.acceptance && <details className="mt-5 border-t border-line pt-3"><summary className="cursor-pointer">验收要求</summary><p className="mt-2 whitespace-pre-wrap break-words">{node.acceptance}</p></details>}
          {node.evidence && <details className="mt-4 border-t border-line pt-3"><summary className="cursor-pointer">设计依据</summary><p className="mt-2 whitespace-pre-wrap break-words">{node.evidence}</p></details>}
          <button className={btn + " mt-5"} onClick={()=>onOpenView && view ? onOpenView(view.id) : onOpenStory()}>查看 Story 设计 ↗</button>
        </aside>}
      </div>
      </> : <Empty className="min-h-[280px]">
        <EmptyMedia className="text-3xl font-light text-muted-foreground">◇</EmptyMedia>
        <EmptyTitle>尚无可展示的架构图</EmptyTitle>
        <EmptyDescription>平台尚未成功生成 Archify 图；完整 PlantUML 设计请在 Story 中查看。</EmptyDescription>
        <EmptyContent><button type="button" onClick={onOpenStory}>阅读完整 Story ↗</button></EmptyContent>
      </Empty>}
      {(projection.warnings.length > 0) && <details className="mt-3 text-[11px] text-muted-foreground [&_summary]:cursor-pointer"><summary>{projection.warnings.length} 条图源提示</summary>
        {projection.warnings.map((warning, i) => <p className="text-xs text-attention [overflow-wrap:anywhere]" key={i}>{warning}</p>)}
      </details>}
      <details className="mt-3 text-[11px] text-muted-foreground [&_summary]:cursor-pointer"><summary>版本信息</summary>
        <p>版本 {projection.revision.slice(0, 12)} · Archify {projection.renderer.slice(0, 8)}{diagram?.line && ` · Story 第 ${diagram.line} 行`}</p>
      </details>
    </>}
  </section>;
}
