import { VisitedKnowledgePanel } from "./VisitedKnowledgePanel";
import { useTechnologyStacks } from "./useTechnologyStacks";
import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { MoreHorizontal, FileText, History, Settings2 } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { KnowledgeResearchProgress } from "./KnowledgeResearchProgress";
import { ComponentKnowledgeArchive } from "./ComponentKnowledgeArchive";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeTaskReady, KnowledgeTaskTabs } from "./KnowledgeTaskNavigation";
import { KnowledgeExtractionWorkspace, KnowledgeExtractionStages } from "./KnowledgeExtractionWorkspace";
import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import {
  componentRequest,
  componentResearchSources,
  publishComponentResearch,
  type ComponentResearchRecord,
} from "./componentResearchApi";
import { getBusinessModules, type BusinessModule } from "./api";
import { Markdown } from "./markdown";
import { ComponentResearchReview, latestComponentProposal } from "./ComponentResearchReview";
function Choice({
  label,
  value,
  items,
  onChange,
}: {
  label: string;
  value: string;
  items: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="grid gap-2">
      {label}
      <Select
        value={value}
        items={items}
        onValueChange={(v) => onChange(v ?? "")}
      >
        <SelectTrigger aria-label={label} className="w-full">
          <SelectValue placeholder="请选择" />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}
export function ComponentResearch({
  open,
  focused = false,
  compact = false,
  focusId,
  surface,
  onClose,
  backLabel = "知识文档",
  onAdopt,
}: {
  open: boolean;
  focused?: boolean;
  compact?: boolean;
  focusId?: string;
  surface?: "knowledge" | "workbench";
  onClose: () => void;
  backLabel?: string;
  onAdopt: (id: string) => void;
}) {
  useTechnologyStacks();
  const [records, setRecords] = useState<ComponentResearchRecord[]>([]),
    [modules, setModules] = useState<BusinessModule[]>([]);
  const [selected, setSelected] = useState(() => {
      const params = new URLSearchParams(location.search);
      return focusId && focusId !== "history" ? focusId : params.get("kbKind") === "component" ? params.get("kbTask") ?? "" : "";
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(""),
    [title, setTitle] = useState(""),
    [editing, setEditing] = useState(false),
    [scope, setScope] = useState("platform"),
    [module, setModule] = useState(""),
    [repos, setRepos] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [reviewBlocked, setReviewBlocked] = useState(false);
  const [archiveOpenRequest, setArchiveOpenRequest] = useState(0);
  const [publishSettingsOpen, setPublishSettingsOpen] = useState(false);
  const [workDocumentId, setWorkDocumentId] = useState("");
  const publishing = useRef(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const studio = useKnowledgeStudio();
  const [stage, setStage] = useState("review");
  useEffect(() => {
    const archiveStage = new URLSearchParams(location.search).get("kbStage");
    if (archiveStage === "publish") { setStage("review"); setArchiveOpenRequest(value => value + 1); }
    else { setArchiveOpenRequest(0); if (surface) setStage(surface === "knowledge" ? "review" : "progress"); }
  }, [surface, focusId]);
  const [detail, setDetail] = useState<ComponentResearchRecord>();
  const current = detail?.id === selected ? detail : undefined;
  const showList = !focused;
  const load = async () => {
    if (!showList) return;
    const result = await componentRequest<{
      records: ComponentResearchRecord[];
    }>("/component-research", undefined, AbortSignal.timeout(30_000));
    setRecords(result.records);
  };
  useEffect(() => {
    if (!open || !showList) return;
    let active = true;
    const refresh = async () => {
      try {
        const result = await componentRequest<{
          records: ComponentResearchRecord[];
        }>("/component-research");
        if (active) setRecords(result.records);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [open, showList]);
  useEffect(() => {
    if (!open || !showList && !publishSettingsOpen && stage !== "publish") return;
    let active = true;
    void getBusinessModules().then(result => { if (active) setModules(result.modules); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [open, showList, publishSettingsOpen, stage]);
  useEffect(() => {
    if (!open || !selected || selected === "history") return;
    let active = true, loading = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const result = await componentRequest<ComponentResearchRecord>(
          `/component-research/${encodeURIComponent(selected)}/reader`,
          undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        );
        if (active) setDetail(result);
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 4000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [open, selected]);
  useEffect(() => {
    setTitle(
      // 标题即归档文件名：默认取研究主题，发布前可按实际功能能力修改。
      current?.update_metadata?.title ?? current?.topic.slice(0, 160) ?? "",
    );
    setEditing(false);
    setScope(current?.update_metadata?.scope ?? "platform");
    setModule(current?.update_metadata?.module_ids[0] ?? "");
    setRepos(current?.update_metadata?.repositories.join("\n") ?? "");
    setWorkDocumentId("");
  }, [selected, current?.id, current?.update_document_revision]);
  useEffect(() => {
    if (!editing) setDraft(current?.draft ?? "");
  }, [current?.draft, editing]);
  function selectRecord(id: string) {
    const archiveStage = new URLSearchParams(location.search).get("kbStage");
    setSelected(id); setStage(archiveStage === "publish" ? "review" : surface === "workbench" ? "progress" : "review");
    const url = new URL(location.href);
    if (id === "history") {
      url.searchParams.set("kbPage", "tasks");
      url.searchParams.delete("kbKind"); url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview");
    } else {
      url.searchParams.set("kbPage", id ? "task" : "research");
      url.searchParams.set("kbKind", "component");
      if (id) url.searchParams.set("kbTask", id);
      else { url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview"); }
    }
    history.replaceState(history.state, "", url);
  }
  useEffect(() => { if (focusId) selectRecord(focusId); }, [focusId]);
  async function manage(action: "stop" | "delete" | "retry" | "begin-update" | "reextract") {
    if (!current || busy) return;
    setBusy(true); setError("");
    try {
      const result = await componentRequest<ComponentResearchRecord>(`/component-research/${current.id}/${action}`, {});
      if (action === "delete") { setDeleting(false); setDetail(undefined); selectRecord("history"); }
      else { setDetail(result); selectRecord(result.id); if (action === "begin-update") studio?.openResult("component", result.id);
        if (action === "reextract") { setReextracting(false); setStage("progress"); studio?.openExecution("component", result.id); } }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function publishKnowledge() {
    if (!current || publishing.current) return;
    publishing.current = true;
    setBusy(true); setError("");
    try {
      const result = await publishComponentResearch(current.id, {
        title, ...(current.document ? {} : { content: draft }), scope,
        module_ids: module ? [module] : [], repositories: repos.split("\n").map(s => s.trim()).filter(Boolean),
        sections: current.document?.sections.filter(section => section.selected).map(section => ({
          id: section.id, revision: section.revision, proposal_id: latestComponentProposal(current, section.id)?.id ?? null,
        })) ?? [],
        document_id: current.document_id ?? null,
        update_document_id: current.update_document_id ?? null,
        update_document_revision: current.update_document_revision,
      });
      setDetail(result);
      void load().catch(() => {});
    } catch (e) {
      setError((e as Error).message);
      try {
        setDetail(await componentRequest<ComponentResearchRecord>(`/component-research/${encodeURIComponent(current.id)}/reader`, undefined, AbortSignal.timeout(30_000)));
      } catch { /* 保留发布错误；下一次任务刷新仍会读取后台事实。 */ }
    }
    finally { publishing.current = false; setBusy(false); }
  }
  const switchTaskView = (next: "progress" | "review") => {
    setStage(next);
    if (current && studio) {
      if (next === "review") studio.openResult("component", current.id);
      else studio.openExecution("component", current.id);
    }
  };
  function workDocumentLinks() {
    if (!current?.work_documents?.length) return null;
    return <section aria-label="已生成的过程文稿" className="mb-4 rounded-lg border border-line p-3">
      <strong className="text-sm">已生成的过程文稿</strong>
      <div className="mt-2 flex flex-wrap gap-2">{current.work_documents.map(document => <Button key={document.id} size="sm" variant="outline" onClick={() => { setWorkDocumentId(document.id); switchTaskView("review"); }}>{document.title}</Button>)}</div>
    </section>;
  }
  const reextractDialog = <Dialog open={reextracting} onOpenChange={setReextracting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>重新萃取？</DialogTitle></DialogHeader><p>复用技术栈和参考仓范围，使用最新 Skill 创建新任务。原任务会停止并移除，原文稿不带入新任务；已发布知识和 MR 保留。</p>{error && <p role="alert" className="text-danger">{error}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setReextracting(false)}>取消</Button><Button disabled={busy} onClick={() => void manage("reextract")}>{busy ? "正在重新萃取…" : "确认重新萃取"}</Button></div></DialogContent></Dialog>;
  if (surface && current) return <section className="tw-root component-knowledge-review" aria-label="组件文稿审查" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden" }}>
    <header className="knowledge-reading-toolbar flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
      <KnowledgeBackButton onClick={onClose} destination={backLabel} />
      <div className="flex min-w-0 flex-1 items-center gap-3"><h2 className="truncate text-base font-semibold" title={current.topic}>{current.topic}</h2>
        <span className={`shrink-0 text-sm ${current.production?.group === "attention" ? "text-amber-700" : "text-muted-foreground"}`}>{current.production?.status_label}</span>
        <KnowledgeTaskTabs value={stage} onChange={switchTaskView} documentCount={(current.document?.sections.length || current.draft ? 1 : 0) + (current.work_documents?.length ?? 0)} view={current.production} disabled={busy} /></div>
      <ComponentKnowledgeArchive key={`archive:${current.id}`} record={current} openRequest={archiveOpenRequest} onArchiveAction={() => {
        void componentRequest<ComponentResearchRecord>(`/component-research/${encodeURIComponent(current.id)}/reader`, undefined, AbortSignal.timeout(30_000))
          .then(next => setDetail(previous => previous?.id === current.id ? next : previous)).catch(reason => setError(reason.message));
      }} />
      <div hidden={stage !== "review"} className="flex shrink-0 items-center gap-2">
        {current.production?.research_actions.filter(action => ["publish", "update"].includes(action.id)).map(action => action.id === "update"
          ? <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage("begin-update")}>{action.label}</Button>
          : <span key={action.id} className="flex items-center gap-2"><Button variant="ghost" onClick={() => setPublishSettingsOpen(true)}><Settings2 size={16} />发布设置</Button><Button disabled={busy || reviewBlocked || !title.trim() || (current.document ? !current.document.sections.some(s => s.selected) : !draft.trim()) || (scope === "module" && !module) || (scope === "repository" && !repos.trim())} onClick={() => void publishKnowledge()}>{busy ? "正在发布…" : action.label}</Button></span>)}
        {current.production?.knowledge_document_id && <Button onClick={() => onAdopt(current.production!.knowledge_document_id!)}>查看知识</Button>}
      </div>
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多组件萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem disabled={busy || editing} onClick={() => { setError(""); setReextracting(true); }}>重新萃取</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </header>
    {reextractDialog}
    <KnowledgeTaskReady value={stage} onChange={switchTaskView} view={current.production} disabled={busy} />
    {error && <p role="alert" className="shrink-0 px-4 py-2 text-danger">{error}</p>}
    <Dialog open={publishSettingsOpen} onOpenChange={setPublishSettingsOpen}><DialogContent className="tw-root max-h-[85dvh] overflow-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>发布设置</DialogTitle></DialogHeader>
      <div className="grid grid-cols-2 gap-4">
        <label className="col-span-2 grid gap-2">知识名称<Input value={title} onChange={e => setTitle(e.target.value)} /></label>
        <Choice label="适用范围" value={scope} onChange={setScope} items={[{value:"platform",label:"平台通用"},{value:"module",label:"业务模块"},{value:"repository",label:"特定代码仓"}]} />
        {scope === "module" && <Choice label="业务模块" value={module} onChange={setModule} items={modules.filter(m => m.status === "active").map(m => ({value:m.id,label:m.name}))} />}
        {scope === "repository" && <label className="grid gap-2">适用代码仓（每行一个）<Textarea value={repos} onChange={e => setRepos(e.target.value)} /></label>}
        <p className="col-span-2 text-sm text-muted-foreground">勾选的能力合成一篇知识。未选内容保留在本任务中；更新时以完整所选章节替换这篇知识。</p>
      </div>
      <Button className="justify-self-end" onClick={() => setPublishSettingsOpen(false)}>完成</Button>
    </DialogContent></Dialog>
    <VisitedKnowledgePanel key={`reader:${current.id}`} active={stage === "review"} className="min-h-0 flex-1" style={{ display: stage === "review" ? "flex" : "none", flexDirection: "column" }}>
      {current.production?.platform_message && <p className="shrink-0 border-b border-line px-4 py-1.5 text-sm text-muted-foreground">{current.production.platform_message}</p>}
      {current.document || current.work_documents?.length ? <ComponentResearchReview key={`review:${current.id}`} record={current} workDocumentId={workDocumentId} onWorkDocumentSelect={setWorkDocumentId} unified onBlockedChange={setReviewBlocked} onChanged={record => { setDetail(record); void load(); }} readerHeight="100%" />
        : current.draft ? <section className="min-h-0 flex-1 overflow-auto p-6"><div className="mb-3 flex justify-between"><strong>{current.production?.status_label}</strong>{!current.document_id && <Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? "预览文稿" : "编辑文稿"}</Button>}</div>{editing ? <Textarea aria-label="知识文稿" rows={16} value={draft} onChange={e => setDraft(e.target.value)} /> : <Markdown text={draft} />}</section>
        : <p className="p-6 text-muted-foreground">文稿生成后可在这里检视。</p>}
    </VisitedKnowledgePanel>
    {stage === "progress" && <div className="min-h-0 flex-1 overflow-auto p-5">
      <div className="mb-4 flex items-center gap-3 text-sm"><span className="mr-auto text-muted-foreground">{componentResearchSources(current).length} 个来源仓 · {knowledgeLanguageLabel(current.language)} · {current.operator}</span>
        {current.production?.research_actions.filter(action => ["stop", "resume"].includes(action.id)).map(action => <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage(action.id === "resume" ? "retry" : "stop")}>{action.label}</Button>)}
        <details className="relative"><summary className="cursor-pointer text-muted-foreground">来源范围</summary><div className="absolute right-0 z-10 mt-2 w-[480px] max-w-[80vw] rounded-lg border border-line bg-surface p-4 shadow-lg">{componentResearchSources(current).map(source => <p key={source.id} className="mb-2 break-all">{source.name} · {source.repository} · {source.branch} · {source.path || "根目录"}<br />读取版本：{current.revisions?.[source.id] ?? (!current.source_repositories && !current.components ? current.revision : undefined) ?? "尚未读取"}</p>)}</div></details>
      </div>
      {current.error && <p role="alert" className="mb-4 text-danger">{current.error}</p>}
      {current.pipeline && <p className="mb-4 text-sm text-muted-foreground">分项研究与独立评审：{current.pipeline.tasks.filter(task => task.status === "done").length}/{current.pipeline.tasks.length} 项通过</p>}
      {workDocumentLinks()}
      <KnowledgeResearchProgress key={`progress:${current.id}`} evidence={current.evidence} endpoint={current.deferred_details ? `/component-research/${current.id}/evidence` : undefined} />
    </div>}
  </section>;
  if (compact && current && (current.document || current.work_documents?.length) && stage === "review") return <section className="tw-root space-y-3" aria-label="萃取结果阅读页">
    <header className="flex items-center gap-3 pr-8">
      <KnowledgeBackButton onClick={() => selectRecord("history")} destination="萃取记录" />
      <h2 className="min-w-0 flex-1 truncate text-lg font-semibold" title={current.topic}>{current.document?.overview.match(/^#\s+(.+)$/m)?.[1] ?? current.topic}</h2>
      <ComponentKnowledgeArchive record={current} />
      <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" aria-label="萃取结果操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end" className="tw-root">
        <DropdownMenuItem onClick={() => setStage("progress")}>执行详情</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setStage("inputs")}>来源范围</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || editing} onClick={() => { setError(""); setReextracting(true); }}>重新萃取</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setStage("publish")}>入库与更新</DropdownMenuItem>
      </DropdownMenuContent></DropdownMenu>
      {current.document_id ? <Button onClick={() => onAdopt(current.document_id!)}>查看已采纳知识</Button> : <Button disabled={busy || !current.document?.sections.length || ["queued", "running"].includes(current.status)} onClick={() => setStage("publish")}>采纳知识</Button>}
    </header>
    {error && <p role="alert" className="text-danger">{error}</p>}
    {reextractDialog}
    <ComponentResearchReview key={`review:${current.id}`} record={current} workDocumentId={workDocumentId} onWorkDocumentSelect={setWorkDocumentId} onChanged={record => { setDetail(record); void load(); }} readerHeight="calc(96dvh - 110px)" />
  </section>;
  return (
    <KnowledgeExtractionWorkspace hideHeader={surface === "knowledge" && !!current} codeOnly title={focused ? "本篇文档的萃取过程" : "基础组件萃取"} onClose={onClose} backLabel={backLabel}
      sidebar={!focused && surface !== "knowledge" ? <div>
            <Choice label="任务状态" value={statusFilter} onChange={setStatusFilter} items={[{value:"all",label:"全部任务"},{value:"active",label:"进行中"},{value:"done",label:"已完成"},{value:"failed",label:"失败"},{value:"cancelled",label:"已停止"}]} />
            {records.filter(r => statusFilter === "all" || (statusFilter === "active" ? ["queued", "running"].includes(r.status) : r.status === statusFilter)).map((r) => (
              <button
                key={r.id}
                className={`mb-2 w-full rounded-lg border p-3 text-left ${selected === r.id ? "border-primary bg-primary/5" : "border-line"}`}
                onClick={() => {
                  setDetail(undefined);
                  selectRecord(r.id);
                  setError("");
                }}
              >
                <strong className="line-clamp-2" title={r.topic}>{r.topic}</strong>
                <span className="mt-2 block text-sm text-muted-foreground">
                  {knowledgeLanguageLabel(r.language)} · {componentResearchSources(r).length} 个来源仓
                </span>
                <span className="mt-1 block text-sm">{r.stage}</span><time className="mt-1 block text-xs text-muted-foreground">{new Date(r.created_at).toLocaleString()}</time>
              </button>
            ))}
            {!records.length && (
              <p className="text-muted-foreground">暂无萃取记录</p>
            )}
          </div> : undefined}>
          <main className="min-w-0 pr-2 text-base">
            {error && (
              <p role="alert" className="mb-3 text-danger">
                {error}
              </p>
            )}
            {!selected || selected === "history" ? <div className="p-8 text-muted-foreground">选择一条萃取记录查看进度与草稿，或发起新的萃取。</div> : !current ? <p className="p-8" role="status">正在加载萃取记录…</p> : (
              <>
                {surface === "knowledge" ? <header className="studio-result-toolbar">
                  <KnowledgeBackButton onClick={onClose} destination={backLabel} />
                  <FileText size={21} /><strong title={current.topic}>{current.topic}</strong><span className="studio-job-status">{current.production?.status_label}</span>
                  <div className="studio-result-actions"><Button variant="ghost" onClick={() => { studio?.openExecution("component", current.id); setStage("progress"); }}><History size={16} />萃取过程</Button>
                    {stage !== "review" && <Button variant="ghost" onClick={() => setStage("review")}>阅读成果</Button>}
                    <ComponentKnowledgeArchive record={current} />
                    <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多组件萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setStage("inputs")}>资料</DropdownMenuItem>
                      <DropdownMenuItem disabled={busy || editing} onClick={() => { setError(""); setReextracting(true); }}>重新萃取</DropdownMenuItem>
                      {!focused && <DropdownMenuItem disabled={busy} onClick={() => setDeleting(true)}>删除任务</DropdownMenuItem>}
                    </DropdownMenuContent></DropdownMenu>
                  </div>
                </header> : <div className="studio-run-toolbar"><header className="studio-execution-summary mb-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="line-clamp-2 flex-1 text-xl font-semibold" title={current.topic}>{current.topic}</h2>
                    {!focused && current.production?.research_actions.filter(action => ["stop", "resume"].includes(action.id)).map(action => <Button key={action.id} variant="outline" disabled={busy} onClick={() => void manage(action.id === "resume" ? "retry" : "stop")}>{action.label}</Button>)}
                    {!focused && <Button variant="outline" disabled={busy} onClick={() => setDeleting(true)}>删除任务</Button>}
                    <ComponentKnowledgeArchive record={current} />
                  </div>
                  <p className="mt-2 text-muted-foreground">
                    {componentResearchSources(current).length} 个来源仓 ·{" "}
                    {knowledgeLanguageLabel(current.language)} ·{" "}
                    {current.operator}
                  </p>
                  {current.pipeline && <p className="mt-2 text-sm text-muted-foreground">分项研究与独立评审：{current.pipeline.tasks.filter(t => t.status === "done").length}/{current.pipeline.tasks.length} 项通过</p>}
                  <p className="mt-3 font-medium text-primary">
                    {current.stage}
                  </p>
                  {current.error && (
                    <p role="alert" className="mt-3 text-danger">
                      {current.error}
                    </p>
                  )}
                </header>
                {surface === "workbench" ? <nav className="mb-4 flex gap-2" aria-label="组件研究详情">{([['progress','研究过程'],['inputs','来源范围']] as const).map(([value,label]) => <Button key={value} size="sm" variant={stage === value ? "secondary" : "ghost"} onClick={() => setStage(value)}>{label}</Button>)}<Button size="sm" variant="outline" disabled={!current.draft && !current.document && !current.work_documents?.length} onClick={() => studio ? studio.openResult("component", current.id) : setStage("review")}>文稿审查</Button></nav> : compact ? <label className="mb-4 flex items-center gap-3">查看<select className="rounded-md border border-line bg-surface px-3 py-2" aria-label="查看萃取内容" value={stage} onChange={e => setStage(e.target.value)}><option value="review">萃取结果</option><option value="progress">执行详情</option><option value="inputs">来源范围</option><option value="publish">采纳知识</option></select></label> : <KnowledgeExtractionStages codeOnly value={stage} onChange={setStage} label="组件萃取阶段" />}</div>}
                {(current.document || current.work_documents?.length) && <VisitedKnowledgePanel key={`reader:${current.id}`} active={stage === "review"}><ComponentResearchReview key={`review:${current.id}`} record={current} workDocumentId={workDocumentId} onWorkDocumentSelect={setWorkDocumentId} onChanged={record => { setDetail(record); void load(); }} /></VisitedKnowledgePanel>}
                {stage === "inputs" && <details open className="mb-5 rounded-lg border border-line p-4">
                  <summary className="cursor-pointer font-medium">
                    源码范围与调用来源
                  </summary>
                  {stage === "inputs" && componentResearchSources(current).map(c => <p key={c.id} className="mt-3 break-all text-sm">{c.name} · {c.repository} · {c.branch} · {c.path || "根目录"}<br/>读取版本：{current.revisions?.[c.id] ?? (!current.source_repositories && !current.components ? current.revision : undefined) ?? "尚未读取"}</p>)}
                  {stage === "inputs" && <p className="mt-3 text-sm">来源限定为基础仓固定版本代码与 everycode 真实调用。{current.material_ids?.length ? "此历史记录曾关联上传资料，重新研究须新建任务。" : ""}</p>}
                </details>}
                {stage === "progress" && <>{workDocumentLinks()}<KnowledgeResearchProgress key={`progress:${current.id}`} evidence={current.evidence} endpoint={current.deferred_details ? `/component-research/${current.id}/evidence` : undefined} /></>}
                {current.draft && ["review", "publish"].includes(stage) && (
                  <>
                    {stage === "review" && !current.document && <><div className="mb-3 flex items-center justify-between">
                      <h3 className="font-semibold">
                        {current.document_id
                          ? "原始萃取草稿"
                          : "知识草稿 · 待人工审查"}
                      </h3>
                      <Button
                        variant="outline"
                        disabled={!!current.document_id}
                        onClick={() => setEditing(!editing)}
                      >
                        {editing ? "预览" : "编辑草稿"}
                      </Button>
                    </div>
                    {editing ? (
                      <Textarea
                        aria-label="知识草稿"
                        className="min-h-[360px] font-mono text-sm"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                    ) : (
                      <Markdown text={draft} />
                    )}</>}
                    {stage === "publish" && (current.document_id ? (
                      <div className="mt-5 flex gap-3"><Button variant="outline" disabled={busy} onClick={() => void manage("begin-update")}>更新这篇文档</Button><Button
                        className="mt-5"
                        onClick={() => onAdopt(current.document_id!)}
                      >
                        查看已采纳知识
                      </Button></div>
                    ) : (
                      <section className="mt-5 grid gap-4 rounded-lg border border-line bg-surface-2 p-4">
                        <label className="grid gap-2">
                          知识名称
                          <Input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                          />
                        </label>
                        <Choice
                          label="采纳后的适用范围"
                          value={scope}
                          onChange={setScope}
                          items={[
                            { value: "platform", label: "平台通用" },
                            { value: "module", label: "业务模块" },
                            { value: "repository", label: "特定代码仓" },
                          ]}
                        />
                        {scope === "module" && (
                          <Choice
                            label="业务模块"
                            value={module}
                            onChange={setModule}
                            items={modules
                              .filter((m) => m.status === "active")
                              .map((m) => ({ value: m.id, label: m.name }))}
                          />
                        )}
                        {scope === "repository" && (
                          <label className="grid gap-2">
                            适用代码仓（每行一个地址）
                            <Textarea
                              value={repos}
                              onChange={(e) => setRepos(e.target.value)}
                            />
                          </label>
                        )}
                        <Button
                          disabled={
                            busy ||
                            !current.production?.research_actions.some(action => action.id === "publish") ||
                            (!!current.document && !current.document.sections.some(section => section.selected)) ||
                            !draft.trim() ||
                            !title.trim() ||
                            (scope === "module" && !module) ||
                            (scope === "repository" && !repos.trim())
                          }
                          onClick={() => void publishKnowledge()}
                        >
                          {current.document ? `确认采纳 ${current.document.sections.filter(section => section.selected).length} 项为一篇知识文档` : "确认采纳到知识库"}
                        </Button>
                      </section>
                    ))}
                  </>
                )}
              </>
            )}
          </main>

      {reextractDialog}
      <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除萃取任务？</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<p>正在执行的任务会停止。已经采纳的知识文档和来源记录会保留。</p><div className="flex justify-end gap-3"><Button variant="outline" onClick={() => setDeleting(false)}>取消</Button><Button disabled={busy} onClick={() => void manage("delete")}>确认删除</Button></div></DialogContent></Dialog>
    </KnowledgeExtractionWorkspace>
  );
}
