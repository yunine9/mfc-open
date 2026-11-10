import { VisitedKnowledgePanel } from "./VisitedKnowledgePanel";
import { useResearchResource } from "./useResearchResource";
import { ResizableKnowledgePanes } from "./ResizableKnowledgePanes";
import { useKnowledgeStudio } from "./KnowledgeStudioContext";
import { KnowledgeReadingFrame } from "./KnowledgeReadingFrame";
import { KnowledgeResearchProgress } from "./KnowledgeResearchProgress";
import { KnowledgeSourceCleanup, type KnowledgeCleanupDraft } from "./KnowledgeSourceCleanup";
import { DomainKnowledgeArchiveTargets } from "./DomainKnowledgeArchiveTargets";
import { DomainKnowledgeFileTree } from "./DomainKnowledgeFileTree";
import { DomainKnowledgeConfirmation } from "./DomainKnowledgeConfirmation";
import { DomainKnowledgePublicationStatus } from "./DomainKnowledgePublicationStatus";
import type { ArchiveIssueInput } from "./knowledgeArchiveAction";
import { KnowledgeReviewNotes } from "./KnowledgeReviewNotes";
import { DomainKnowledgeInspectionBar, DomainKnowledgeInspectionContext, DomainKnowledgeInspectionStart, useDomainKnowledgeInspection } from "./DomainKnowledgeInspection";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeTaskReady, KnowledgeTaskTabs } from "./KnowledgeTaskNavigation";
import { domainDocumentHasChanges, domainProposalProblem, domainReviewDocument, domainReviewDocuments, latestDomainProposal } from "./domainKnowledgePublication";
import { KnowledgeMarkdown, type KnowledgeFocus } from "./KnowledgeMarkdown";
import { resolveKnowledgeReference } from "./knowledgeStructure";
import { getBusinessModules, type BusinessModule } from "./api";
import { useEffect, useRef, useState } from "react";
import { diffLines } from "diff";
import { MoreHorizontal, Send, FileText, RefreshCw } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { KnowledgeExtractionWorkspace } from "./KnowledgeExtractionWorkspace";
import { ExtractionSkillEditor, openExtractionSkill } from "./ExtractionSkillEditor";
import { KnowledgeMaterialUpload, type MaterialSummary } from "./KnowledgeMaterialUpload";
import { componentRequest } from "./componentResearchApi";
import { Markdown } from "./markdown";
import type { DomainKnowledgeJob, DomainDocument } from "../../src/domainKnowledgeTypes";

const body = (doc: { content: string; sources: string }) => doc.content;
function inspectionImage(job: DomainKnowledgeJob, documentId: string, href: string): string | undefined {
  if (!job.git_resources?.[documentId] || /^[a-z][a-z\d+.-]*:|^\/|^#/i.test(href)) return undefined;
  return `/domain-extraction/${encodeURIComponent(job.id)}/resources/${encodeURIComponent(documentId)}?path=${encodeURIComponent(href)}`;
}
export function DomainKnowledgePathChange({ originalPath, proposedPath }: { originalPath: string; proposedPath: string }) {
  if (originalPath === proposedPath) return null;
  return <section aria-label="文档路径修改建议" className="mb-4 grid gap-2 rounded-lg border border-line bg-surface-2 p-3 text-sm">
    <strong className="font-medium">文档路径修改建议</strong>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0">原路径：<code className="break-all">{originalPath}</code></span>
      <span aria-hidden="true">→</span>
      <span className="min-w-0">建议路径：<code className="break-all">{proposedPath}</code></span>
    </div>
  </section>;
}
export function DomainKnowledgeDeletionNotice({ deleted, pending }: { deleted?: boolean; pending: boolean }) {
  if (!deleted) return null;
  return <section aria-label="文稿删除状态" className="mb-4 grid gap-1 rounded-lg border border-line bg-surface-2 p-3 text-sm">
    <strong className="font-medium">{pending ? "知识文稿待删除" : "知识文稿已删除"}</strong>
    <p className="m-0">{pending ? "MR 合入并同步后从正式知识库移除这份文稿，下方保留原正文供检视。" : "删除已提交，下方保留原正文供追溯。"}</p>
  </section>;
}
export function DomainKnowledgeExtraction({ focusId, surface, onViewKnowledge, onBack, focused = false, cleanupDraft, onCleanupDraftChange }: { focusId?: string; surface?: "knowledge" | "workbench"; onViewKnowledge?: (documentId: string) => void; onBack?: () => void; focused?: boolean; cleanupDraft?: KnowledgeCleanupDraft; onCleanupDraftChange?: (draft: KnowledgeCleanupDraft) => void }) {
  const studio = useKnowledgeStudio();
  const [instructions, setInstructions] = useState("");
  const [records, setRecords] = useState<DomainKnowledgeJob[]>([]), [job, setJob] = useState<DomainKnowledgeJob>(), [selected, setSelected] = useState(() => {
    const params = new URLSearchParams(location.search);
    return focusId && focusId !== "new" ? focusId : params.get("kbKind") === "domain" ? params.get("kbTask") ?? "" : "";
  });
  const selectedRef = useRef(selected);
  const searchableContent = useRef<HTMLDivElement>(null);
  const [notesToolbar, setNotesToolbar] = useState<HTMLSpanElement | null>(null);
  const [overallNotesOpenRequest, setOverallNotesOpenRequest] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [reextracting, setReextracting] = useState(false);
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [modules, setModules] = useState<BusinessModule[]>([]), [moduleId, setModuleId] = useState("");
  const [issueNo, setIssueNo] = useState(""), [issueDescription, setIssueDescription] = useState("");
  const [baselineBranch, setBaselineBranch] = useState("master");
  const module = modules.find(item => item.id === moduleId);
  const [materials, setMaterials] = useState<MaterialSummary[]>([]), [uploading, setUploading] = useState(false);
  const [extraMaterials, setExtraMaterials] = useState<MaterialSummary[]>([]);
  const materialsBlocked = materials.some(material => material.state !== "ready");
  const extraMaterialsBlocked = extraMaterials.some(material => material.state !== "ready");
  const [archiveOpenRequest, setArchiveOpenRequest] = useState(0);
  const [archiveSettingsOpen, setArchiveSettingsOpen] = useState(false);
  const [archiveSettingsSaving, setArchiveSettingsSaving] = useState(false);
  const [archiveReplaceExisting, setArchiveReplaceExisting] = useState(false);
  const [archiveIssue, setArchiveIssue] = useState<ArchiveIssueInput & { job_id: string }>();
  const confirmedArchiveIssue = archiveIssue?.job_id === job?.id ? archiveIssue : undefined;
  function openArchiveSettings(replaceExisting = false, issue?: ArchiveIssueInput) {
    if (!job) return;
    setArchiveIssue({ job_id: job.id, ...(issue ?? { issue_no: job.issue_no ?? "", issue_description: job.issue_description ?? "" }) });
    setArchiveReplaceExisting(replaceExisting); setArchiveSettingsOpen(true);
  }
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeFocus>();
  const [related, setRelated] = useState(false), [showDiscussion, setShowDiscussion] = useState(false);
  const [documentId, setDocumentId] = useState(() => new URLSearchParams(location.search).get("knowledgeDocument") ?? ""), [tab, setTab] = useState<"content" | "diff" | "history" | "sources">("content"), [stage, setStage] = useState("review");
  const [message, setMessage] = useState(""), [latest, setLatest] = useState(false), [edit, setEdit] = useState<DomainDocument>();
  const [workDocumentId, setWorkDocumentId] = useState("");
  const waiting = job?.status === "paused" ? job.turns.at(-1)?.waiting : undefined;
  const preparingCleanup = !!job?.source_cleanup && !job.source_cleanup.started;
  const currentStage = preparingCleanup ? "progress" : stage;
  useEffect(() => { if (new URLSearchParams(location.search).get("kbStage") === "publish") setArchiveSettingsOpen(true); setArchiveOpenRequest(0); if (surface) setStage(surface === "knowledge" ? "review" : "progress"); }, [surface, focusId]);
  const active = job?.production?.working, document = job?.documents.find(d => d.id === documentId) ?? job?.documents[0];
  const readOnly = job?.production?.review.readonly === true;
  const inspection = useDomainKnowledgeInspection({ jobId: job?.id, refreshToken: job, working: !!active, independent: job?.task_kind === "inspection", initiallyStarted: job?.task_kind === "inspection" && job.status === "idle" && !job.inspection_source?.finished_at, blockedReason: readOnly ? "MR 已合入，请从正式知识库开始新的检视。" : waiting ? "请先答复任务上方的待确认内容，再结束检视。" : undefined, onStarted: () => setShowDiscussion(false), onSubmitted: () => { refreshArchiveStatus(); changeView("progress"); } });
  const workDocument = job?.work_documents?.find(item => `${item.turn_id}:${item.id}` === workDocumentId) ?? (!document ? job?.work_documents?.[0] : undefined);
  useEffect(() => {
    const first = job?.work_documents?.[0];
    if (!workDocumentId && !document && first) setWorkDocumentId(`${first.turn_id}:${first.id}`);
  }, [job?.id, job?.work_documents, document, workDocumentId]);
  const workBody = useResearchResource<{ content: string }>(job?.deferred_details && currentStage === "review" && workDocument
    ? `/domain-extraction/${job.id}/work-document/${workDocument.turn_id}/${workDocument.id}` : undefined, undefined, true);
  const historyBody = useResearchResource<DomainDocument["history"]>(job?.deferred_details && currentStage === "review" && tab === "history" && document
    ? `/domain-extraction/${job.id}/history/${document.id}` : undefined, document?.revision);
  const versions = job?.deferred_details ? historyBody.value : document?.history;
  const turns = job?.turns.filter(t => t.document_ids.includes(document?.id ?? "")) ?? [];
  const pending = job && document ? latestDomainProposal(job, document.id) : undefined;
  const proposalTurn = pending?.turn, proposal = pending?.proposal;
  const reviewDocuments = job ? domainReviewDocuments(job) : [];
  const reviewDocument = job && document ? domainReviewDocument(job, document) : undefined;
  const proposalProblem = job && document ? domainProposalProblem(job, document) : undefined;
  const publicationProblem = job?.documents.filter(doc => doc.selected).map(doc => domainProposalProblem(job, doc)).find(Boolean);
  const publishedRevision = job && document ? job.production?.documents.find(item => item.id === document.id)?.published_revision : undefined;
  const changed = !!job && !!document && domainDocumentHasChanges(job, document);
  const lifecycle = job?.production?.status_label ?? "";
  function navigateKnowledge(id: string, line?: number, anchor?: string) {
    if (inspection.inlineEditing) { setError("请先记下或取消正在编辑的行意见，再切换文稿。"); return; }
    if (edit?.id === id && (line !== undefined || !!anchor)) { setError("请先保存或取消当前编辑，再跳转章节。"); return; }
    setWorkDocumentId(""); setDocumentId(id); setTab("content"); setMessage(""); setError("");
    setKnowledgeFocus(old => ({ line, anchor, token: (old?.token ?? 0) + 1 }));
  }
  function changeView(next: "progress" | "review") {
    if (inspection.inlineEditing) { setError("请先记下或取消正在编辑的行意见，再切换视图。"); return; }
    if (edit) { setError("请先保存或取消正文编辑，再切换视图。"); return; }
    setStage(next);
    if (job && studio) next === "review" ? studio.openResult("domain", job.id) : studio.openExecution("domain", job.id);
  }
  function readWorkDocument(turnId: string, id: string) {
    if (inspection.inlineEditing) { setError("请先记下或取消正在编辑的行意见，再切换文稿。"); return; }
    if (edit) { setError("请先保存或取消当前编辑，再查看过程文稿。"); return; }
    setWorkDocumentId(`${turnId}:${id}`); setShowDiscussion(false); setTab("content"); changeView("review");
  }
  const showList = !focused && surface !== "knowledge";
  async function refreshList() { if (!showList) return; const result = await componentRequest<{ records: DomainKnowledgeJob[] }>("/domain-extraction"); setRecords(result.records); }
  useEffect(() => { if (showList) void refreshList().catch(e => setError(e.message)); }, [showList]);
  useEffect(() => { if (open) void getBusinessModules().then(result => setModules(result.modules.filter(m => m.status === "active"))).catch(e => setError(e.message)); }, [open]);
  useEffect(() => {
    if (!selected || busy) return; let live = true, loading = false;
    const controller = new AbortController();
    const load = async () => { if (loading) return; loading = true; try { const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${selected}/reader`, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])); if (live && selectedRef.current === selected) setJob(next); } catch (e) { if (live && selectedRef.current === selected) setError((e as Error).message); } finally { loading = false; } };
    void load(); const timer = setInterval(() => void load(), 4000); return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [selected, busy]);
  const checkedArchive = useRef("");
  useEffect(() => {
    if (!job || !job.publications.some(publication => !!publication.url) || checkedArchive.current === job.id) return;
    checkedArchive.current = job.id;
    const id = job.id;
    void componentRequest<DomainKnowledgeJob>(`/domain-extraction/${id}/archive/refresh`, {}, AbortSignal.timeout(45_000)).then(next => { if (selectedRef.current === id) setJob(next); }).catch(reason => { if (selectedRef.current === id) setError(`MR 状态刷新失败：${reason.message}`); });
  }, [job?.id, job?.publications.length]);
  function select(id: string) {
    const url = new URL(location.href);
    selectedRef.current = id; setDeleting(false); setArchiveSettingsOpen(false); setArchiveOpenRequest(0); setArchiveReplaceExisting(false); setSelected(id); setJob(undefined); setDocumentId(url.searchParams.get("kbTask") === id ? url.searchParams.get("knowledgeDocument") ?? "" : ""); setWorkDocumentId(""); setEdit(undefined); setMessage(""); setExtraMaterials([]);
    url.searchParams.set("kbPage", id ? "task" : "research");
    url.searchParams.set("kbKind", "domain");
    if (id) url.searchParams.set("kbTask", id);
    else { url.searchParams.delete("kbTask"); url.searchParams.delete("kbReview"); }
    history.replaceState(history.state, "", url);
  }
  useEffect(() => { if (focusId === "new") { if (surface === "workbench") setOpen(true); } else if (focusId) { if (focusId !== selectedRef.current) select(focusId); setOpen(false); } }, [focusId, surface]);
  async function action(name: string, input: unknown = {}) {
    if (!job) return false; setBusy(true); setError("");
    try { setJob(await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/${name}`, input)); await refreshList(); return true; }
    catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  }
  function refreshArchiveStatus() {
    if (!job) return;
    void componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/reader`, undefined, AbortSignal.timeout(30_000))
      .then(next => { if (selectedRef.current === job.id) setJob(next); }).catch(reason => { if (selectedRef.current === job.id) setError(reason.message); });
  }
  async function remove() {
    if (!job) return;
    const id = job.id; setBusy(true); setError("");
    try {
      await componentRequest<{ deleted: boolean }>(`/domain-extraction/${id}/delete`, {});
      if (selectedRef.current === id) select("");
      setRecords(current => current.filter(record => record.id !== id));
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function reextract() {
    if (!job || busy || edit) return;
    setBusy(true); setError("");
    try {
      const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/reextract`, {});
      setReextracting(false); select(next.id); setJob(next); setStage("progress");
      studio?.openExecution("domain", next.id);
      await refreshList();
    } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  async function run(mode: "discuss" | "revise" | "update") {
    if (document && await action("run", { mode, document_ids: related ? job!.documents.filter(d => d.selected).map(d => d.id) : [document.id], message, use_latest_skill: latest })) setMessage("");
  }
  return <DomainKnowledgeInspectionContext.Provider value={inspection}><KnowledgeExtractionWorkspace hideHeader={!!job} title="领域知识萃取" onNew={() => setOpen(true)} onClose={onBack} backLabel="任务中心" actions={<ExtractionSkillEditor kind="domain" />}
    sidebar={focused || surface === "knowledge" ? undefined : <div className="space-y-2">{records.map(record => <button key={record.id} className={`w-full rounded-lg border p-3 text-left ${selected === record.id ? "border-primary bg-primary/5" : "border-line"}`} onClick={() => select(record.id)}><strong className="block">{record.title}</strong><span className="mt-2 block text-sm text-muted-foreground">{record.repositories.length} 个业务仓 · {record.stage}</span></button>)}{!records.length && <p className="text-muted-foreground">暂无领域萃取记录</p>}</div>}>
    {!job && error && <p role="alert" className="mb-3 text-danger">{error}</p>}
    {job ? <><header className={`studio-result-toolbar${focused ? " domain-focused-toolbar" : ""}`}>
      {onBack && <KnowledgeBackButton onClick={onBack} destination="任务中心" />}
      <FileText size={21} /><strong title={job.title}>{job.title}</strong><span className={`studio-job-status ${active ? "is-active" : ""}`}>{lifecycle}</span>
      {!preparingCleanup && <KnowledgeTaskTabs value={currentStage} onChange={changeView} documentCount={job.documents.length + (job.work_documents?.length ?? 0)} view={job.production} disabled={!!edit} />}
      <div className="studio-result-actions">
        <DomainKnowledgePublicationStatus compact job={job} disabled={busy || !!edit || archiveSettingsSaving} openRequest={archiveOpenRequest} replaceExistingOnOpen={archiveReplaceExisting} confirmedIssue={confirmedArchiveIssue} onConfigure={openArchiveSettings} onReview={() => changeView("review")} onChanged={refreshArchiveStatus} />
        {job.production?.research_actions.filter(item => !["archive", "review", "publish", "update"].includes(item.id)).map(item => item.id === "stop" ? <Button key={item.id} variant="outline" disabled={busy} onClick={() => void action("stop")}>{item.label}</Button> : item.id === "resume" ? <Button key={item.id} disabled={busy || readOnly} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>{item.label}</Button> : item.id === "knowledge" && item.href ? <a key={item.id} href={item.href} className="text-sm text-primary underline">{item.label}</a> : null)}
        {!!job.publications.length && <Button size="sm" variant="ghost" aria-label="刷新 MR 状态" disabled={busy} onClick={() => void action("archive/refresh")}><RefreshCw size={15} />刷新 MR</Button>}
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多萃取操作" />}><MoreHorizontal size={20} /></DropdownMenuTrigger><DropdownMenuContent align="end">
          {!preparingCleanup && <DropdownMenuItem onClick={() => setStage("inputs")}>资料</DropdownMenuItem>}
          {!active && job.status === "done" && job.turns.at(-1)?.mode === "extract" && <DropdownMenuItem disabled={busy || readOnly} onClick={() => { void action("resume", { use_latest_skill: latest || !job.turns.at(-1)?.research }); changeView("progress"); }}>继续深入研究</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => openExtractionSkill("domain")}>查看 Skill</DropdownMenuItem>
          <DropdownMenuItem disabled={busy || !!edit || readOnly} onClick={() => { setError(""); setReextracting(true); }}>重新萃取</DropdownMenuItem>
          <DropdownMenuItem onClick={() => { studio?.openExecution("domain"); setOpen(true); }}>新建萃取任务</DropdownMenuItem>
          <DropdownMenuItem disabled={busy} onClick={() => { setError(""); setDeleting(true); }}>删除任务</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>
    </header>
      {!preparingCleanup && <KnowledgeTaskReady value={currentStage} onChange={changeView} view={job.production} disabled={!!edit} />}
      {!preparingCleanup && waiting && <DomainKnowledgeConfirmation key={`${job.id}:${waiting.id}`} job={job} waiting={waiting} compact={currentStage !== "progress"} disabled={busy || !!edit} onRead={id => { navigateKnowledge(id); changeView("review"); }} onReadWork={readWorkDocument} onShow={() => changeView("progress")} onReply={reply => action("resume", { request_id: waiting.id, message: reply })} />}
      {readOnly && <p role="status" className="shrink-0 border-b border-line bg-primary/5 px-4 py-3 text-sm">已有 MR 合入，当前任务文稿仅用于追溯。其余 MR 可继续处理；后续修改请<a className="ml-1 text-primary underline" href={`?kbPage=module&kbModule=${encodeURIComponent(`business:${job.module_id ?? ""}`)}`}>查看正式知识并开始新的检视</a>。</p>}
      {error && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-danger">{error}</p>}
      {!preparingCleanup && job.production?.platform_message && <p className="shrink-0 px-4 py-2 text-xs text-muted-foreground">{job.production.platform_message}</p>}
      {currentStage === "review" && publicationProblem && <p role="alert" className="shrink-0 px-4 py-2 text-sm text-amber-700">{publicationProblem}</p>}
      {job.error && <p className="mb-3 text-danger">{job.error}</p>}
      {currentStage === "inputs" && <div className="knowledge-task-progress space-y-4"><p>{job.scope}</p>{job.instructions && <div><h4 className="font-medium">本次要求</h4><p className="mt-2 whitespace-pre-wrap break-words">{job.instructions}</p></div>}{(job.source_repositories ?? job.repositories).map(repo => <div key={repo.id} className="rounded border border-line p-3 text-sm"><strong>{repo.name}</strong><p className="break-all">{repo.repository} · {repo.branch} · {repo.path || "全仓"}</p><p>读取版本：{job.revisions[repo.id]?.slice(0, 12) ?? "未读取"}</p></div>)}<p>已关联 {job.material_ids.length} 份上传资料</p><KnowledgeMaterialUpload materials={extraMaterials} onChange={setExtraMaterials} onBusy={setUploading} disabled={busy || !!active} /><Button disabled={busy || uploading || extraMaterialsBlocked || active || !document || readOnly} onClick={() => void action("run", { mode: "update", document_ids: job.documents.map(d => d.id), message: "核对补充资料与当前来源，更新受影响文档；未变化内容保留", material_ids: [...new Set([...job.material_ids, ...extraMaterials.map(m => m.id)])], use_latest_skill: latest })}>用补充资料生成更新建议</Button></div>}
      {currentStage === "progress" && <div className="knowledge-task-progress space-y-4">{preparingCleanup ? <KnowledgeSourceCleanup key={job.id} task={job} draft={cleanupDraft} onDraftChange={onCleanupDraftChange} onBusy={value => { if (selectedRef.current === job.id) setBusy(value); }} onChange={next => { if (selectedRef.current === next.id) setJob(next); }} /> : <>{!!job.turns.at(-1)?.research?.capabilities.length && <details className="rounded border border-line p-3"><summary className="cursor-pointer text-sm">{job.production?.review.progress_message}</summary><ul className="mt-3 list-none space-y-2 p-0 text-sm">{job.turns.at(-1)!.research!.capabilities.map(c => <li key={c.id}><strong>{c.title}</strong> · {job.production?.review.capabilities.find(item => item.id === c.id)?.status_label}{c.findings && <p className="whitespace-pre-wrap text-muted-foreground">{c.findings}</p>}</li>)}</ul></details>}{!!job.work_documents?.length && <section aria-label="已生成的过程文稿" className="rounded border border-line p-3"><strong className="text-sm">已生成的过程文稿</strong><div className="mt-2 flex flex-wrap gap-2">{job.work_documents.map(item => <Button key={`${item.turn_id}:${item.id}`} size="sm" variant="outline" onClick={() => readWorkDocument(item.turn_id, item.id)}>{item.title}</Button>)}</div></section>}{!!job.turns.at(-1)?.human_replies?.length && <details className="rounded border border-line p-3"><summary className="text-sm">已提交的答复</summary>{job.turns.at(-1)!.human_replies!.map(item => <article key={item.request_id} className="mt-3 text-sm"><p className="text-muted-foreground">{item.operator} · {new Date(item.at).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{item.message}</p></article>)}</details>}<KnowledgeResearchProgress key={job.id} evidence={job.evidence} endpoint={job.deferred_details ? `/domain-extraction/${job.id}/evidence` : undefined} /></>}</div>}
      <VisitedKnowledgePanel key={`reader:${job.id}`} active={currentStage === "review"} className="knowledge-task-review" style={currentStage === "review" ? { display: "flex", flex: "1 1 0", minHeight: 0, flexDirection: "column", overflow: "hidden" } : undefined}><KnowledgeReadingFrame focused={focused} inspectionMode={inspection.started && !readOnly} sidePanelOpen={showDiscussion} documentActions={workDocument ? <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${job.id}:${workDocument.turn_id}:${workDocument.id}:${workBody.value?.content ?? workDocument.content}`} contentSelector=".md" /> : <><span ref={setNotesToolbar} className="flex items-center" />{document && tab === "content" && edit?.id !== document.id && <KnowledgeContentSearch contentRef={searchableContent} contentKey={`${job.id}:${document.id}:${document.revision}:${proposalTurn?.id ?? ""}:${reviewDocument?.content ?? ""}`} contentSelector=".md" />}<Button size="sm" variant="ghost" onClick={() => setTab("content")}>正文</Button><Button size="sm" variant="ghost" disabled={!document || busy || active || inspection.started || !!proposal || readOnly} title={proposal ? "当前修改待确认，可提意见继续调整，或放弃修改后人工编辑。" : undefined} onClick={() => { setEdit(structuredClone(document)); setTab("content"); }}>{document?.knowledge_document_id ? "修改为新稿" : "编辑"}</Button><DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" aria-label="更多领域文档操作" />}><MoreHorizontal size={18} /></DropdownMenuTrigger><DropdownMenuContent align="end">{([["diff", "修订差异"], ["sources", "来源"], ["history", "历史版本"]] as const).map(([value, label]) => <DropdownMenuItem key={value} onClick={() => setTab(value)}>{label}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></>} title={workDocument?.title ?? reviewDocument?.path.split("/").at(-1) ?? "知识文档"} actions={<>{!readOnly && <DomainKnowledgeInspectionStart inspection={inspection} disabled={!!edit || !job.documents.length} />}{!readOnly && <KnowledgeReviewNotes refreshToken={job} kind="domain" jobId={job.id} documentId="" scope="study" toolbarTarget={null} openRequest={overallNotesOpenRequest} working={!!active} />}{workDocument ? <Button size="sm" variant="ghost" onClick={() => changeView("progress")}>返回研究过程</Button> : <Button size="sm" variant="ghost" disabled={inspection.started || readOnly} onClick={() => setShowDiscussion(!showDiscussion)}>{showDiscussion ? "收起讨论" : "讨论与修订"}</Button>}</>}>{!readOnly && <DomainKnowledgeInspectionBar inspection={inspection} onOverall={() => setOverallNotesOpenRequest(value => value + 1)} onProgress={() => changeView("progress")} />}<ResizableKnowledgePanes className="research-review-panes">
        <DomainKnowledgeFileTree job={job} currentId={workDocument ? undefined : document?.id} currentWorkId={workDocument ? `${workDocument.turn_id}:${workDocument.id}` : undefined} onWorkNavigate={readWorkDocument} onNavigate={navigateKnowledge} disabled={busy || active || readOnly} onSelection={(id, selected) => void action("selection", { ids: [id], selected })} onSelections={(ids, selected) => void action("selection", { ids, selected })} />
        <div className="research-reader" style={{ gridTemplateColumns: showDiscussion ? "minmax(0, 1fr) 300px" : "minmax(0, 1fr)" }}>{workDocument ? <div className="research-document-content studio-paper"><p className="mb-3 text-sm text-muted-foreground">过程文稿</p><div ref={searchableContent}>{job.deferred_details && !workBody.value ? <p role="status">{workBody.error ?? "正在读取文稿…"}</p> : <KnowledgeMarkdown text={workBody.value?.content ?? workDocument.content} />}</div></div> : document ? <><div className="research-document-content studio-paper">
          <div className={focused ? "domain-review-document-meta flex items-center gap-2 text-xs text-muted-foreground" : "mb-4 flex flex-wrap items-center gap-2 border-b border-line pb-3 text-xs text-muted-foreground"} title={reviewDocument?.path ?? document.path}>
            {!focused && <span className="break-all">{reviewDocument?.path ?? document.path}</span>}<span>{proposal && !proposalProblem ? "修改结果" : `草稿 v${document.revision}`}</span>{publishedRevision !== undefined && <span>· 原任务基线 v{publishedRevision}</span>}<strong className={changed ? "text-amber-700" : "text-emerald-700"} title={document.knowledge_document_id && changed ? "当前修订只保存在任务中，MR 合入并同步后才会更新正式知识。" : undefined}>{job.production?.documents.find(item => item.id === document.id)?.status_label}</strong>{document.knowledge_document_id && (!document.deleted || changed) && onViewKnowledge && <Button size="sm" variant="link" onClick={() => onViewKnowledge(document.knowledge_document_id!)}>查看正式知识</Button>}
          </div>
          {proposal && <DomainKnowledgePathChange originalPath={document.path} proposedPath={proposal.document.path} />}
          <DomainKnowledgeDeletionNotice deleted={reviewDocument?.deleted} pending={changed} />
          {!focused && document.knowledge_document_id && changed && <p className="mb-3 text-xs text-muted-foreground">当前修订只保存在任务中，MR 合入并同步后才会更新正式知识。</p>}
          {tab === "content" && (edit?.id === document.id ? <div className="space-y-3"><Input aria-label="文档标题" value={edit.title} onChange={e => setEdit({ ...edit, title: e.target.value })} /><Textarea aria-label="编辑领域文档" rows={20} value={edit.content} onChange={e => setEdit({ ...edit, content: e.target.value })} /><Textarea aria-label="编辑文档来源" rows={5} value={edit.sources} onChange={e => setEdit({ ...edit, sources: e.target.value })} /><Button disabled={busy || readOnly} onClick={async () => { if (await action("edit", { document: edit, base_revision: edit.revision })) setEdit(undefined); }}>保存人工版本</Button><Button variant="outline" onClick={() => setEdit(undefined)}>取消</Button></div> : readOnly ? <div ref={searchableContent}><KnowledgeMarkdown text={reviewDocument?.content ?? document.content} focus={knowledgeFocus} resolveImage={href => inspectionImage(job, document.id, href)} onReference={href => {
            const found = resolveKnowledgeReference(reviewDocuments, reviewDocument ?? document, href);
            if (!found) return false; navigateKnowledge(found.item.id, undefined, found.anchor); return true;
          }} /></div> : <KnowledgeReviewNotes refreshToken={job} kind="domain" jobId={job.id} documentId={document.id} toolbarTarget={notesToolbar} working={!!active} blockedReason={waiting ? "请先答复任务上方的待确认内容，再发送意见。" : undefined}><div ref={searchableContent}><KnowledgeMarkdown text={reviewDocument?.content ?? document.content} focus={knowledgeFocus} resolveImage={href => inspectionImage(job, document.id, href)} onReference={href => {
            const found = resolveKnowledgeReference(reviewDocuments, reviewDocument ?? document, href);
            if (!found) return false; navigateKnowledge(found.item.id, undefined, found.anchor); return true;
          }} /></div></KnowledgeReviewNotes>)}
          {tab === "sources" && <Markdown text={reviewDocument?.sources ?? document.sources} />}
          {tab === "diff" && (proposal ? <><p className={`mb-3 text-sm ${proposalProblem ? "text-amber-700" : "text-muted-foreground"}`}>{proposalProblem ?? "正文已展示修改结果，可继续检视或直接创建 MR。"}</p>{proposal.document.path !== document.path && body(document) === body(proposal.document) ? <p className="text-sm text-muted-foreground">正文未变化，路径修改见上方。</p> : <pre className="whitespace-pre-wrap break-words text-sm">{diffLines(body(document), body(proposal.document)).map((part, i) => <span key={i} className={part.added ? "bg-green-500/15" : part.removed ? "bg-red-500/15 line-through" : ""}>{part.value}</span>)}</pre>}<div className="mt-4 flex gap-2"><Button variant="outline" disabled={busy || active || readOnly} onClick={() => void action("proposal", { turn_id: proposalTurn!.id, document_id: document.id, decision: "discard" })}>放弃本次修改</Button></div></> : <p>没有待确认的修改。</p>)}
          {tab === "history" && <div className="space-y-3">{versions && [...versions].reverse().map(h => <details key={h.revision}><summary>v{h.revision} · {h.operator} · {new Date(h.at).toLocaleString()}</summary>{h.path && <p className="my-2 break-all text-sm text-muted-foreground">文件路径：<code>{h.path}</code></p>}<Markdown text={body(h)} /><Button disabled={busy || readOnly} onClick={() => void action("restore", { document_id: document.id, revision: h.revision, base_revision: document.revision })}>恢复为新版本</Button></details>)}{!versions ? <p role="status">{historyBody.error ?? "正在读取历史版本…"}</p> : !versions.length && <p>尚无历史版本。</p>}</div>}
        </div>{showDiscussion && !readOnly && <section className="research-discussion"><h4 className="font-semibold">与 AI 讨论 · {document.title}</h4><p className="mt-2 text-sm text-muted-foreground">讨论保留原稿。修改完成后可继续检视，MR 合入并同步后生效。</p><div className="my-4 space-y-4">{turns.map(turn => <article key={turn.id} className="border-b border-line pb-3 text-sm"><p className="mb-1 text-xs text-muted-foreground">{turn.operator} · {({ discuss: "讨论", revise: "生成修订建议", update: "核对来源更新", extract: "研究" } as Record<string, string>)[turn.mode] ?? turn.mode} · {new Date(turn.created_at).toLocaleString()}{turn.skill && ` · Skill ${turn.skill.digest.slice(0, 8)}`}</p><p className="whitespace-pre-wrap">{turn.message}</p>{turn.reply && <Markdown text={turn.reply} />}{turn.error && <p className="text-danger">{turn.error}</p>}<p className="text-muted-foreground">{job.production?.review.turns.find(item => item.id === turn.id)?.status_label}</p>{turn.proposals.some(p => p.document.id === document.id && p.status === "pending") && <Button variant="link" onClick={() => setTab("diff")}>查看修改差异</Button>}</article>)}</div><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={latest} onChange={e => setLatest(e.target.checked)} />下一轮用最新领域 Skill</label><label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={related} onChange={e => setRelated(e.target.checked)} />同时处理已勾选的关联文档</label><Textarea aria-label="领域知识修订意见" rows={5} value={message} onChange={e => setMessage(e.target.value)} placeholder="补充问题、纠正业务规则或说明更新范围…" /><div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("discuss")}>仅讨论</Button><Button disabled={busy || active || !message.trim()} onClick={() => void run("revise")}>生成建议</Button><Button variant="outline" disabled={busy || active || !message.trim()} onClick={() => void run("update")}>核对来源更新</Button></div></section>}</> : <p className="p-5">研究完成的文档会逐步显示在这里。</p>}</div>
      </ResizableKnowledgePanes>{!focused && !readOnly && document && !showDiscussion && !inspection.started && <form className="studio-refine-bar" onSubmit={event => { event.preventDefault(); if (!busy && !active && message.trim()) { void run("revise"); setShowDiscussion(true); } }}>
        <Textarea aria-label="快速修订知识" rows={1} value={message} onChange={event => setMessage(event.target.value)} placeholder="补充或修改这份知识…" />
        <Button type="submit" size="icon" aria-label="生成修订建议" disabled={busy || active || !message.trim()}><Send size={18} /></Button>
      </form>}</KnowledgeReadingFrame></VisitedKnowledgePanel>
      {currentStage === "publish" && <div className="knowledge-task-progress space-y-4"><div className="flex items-start justify-between gap-4"><h3 className="font-semibold">Git 归档</h3><KnowledgeBackButton onClick={() => changeView("review")} destination="文稿" /></div><DomainKnowledgePublicationStatus job={job} disabled={busy || !!edit || archiveSettingsSaving} confirmedIssue={confirmedArchiveIssue} onConfigure={openArchiveSettings} onReview={() => changeView("review")} onChanged={refreshArchiveStatus} /></div>}
    </> : <p className="p-8 text-muted-foreground">{selected ? "正在加载任务…" : "选择历史任务，或新建领域萃取。"}</p>}
    <Dialog open={archiveSettingsOpen} onOpenChange={next => { if (!archiveSettingsSaving) setArchiveSettingsOpen(next); }}><DialogContent className="tw-root sm:max-w-[850px] max-h-[88vh] overflow-auto"><DialogHeader><DialogTitle>确认归档目录并创建 MR</DialogTitle></DialogHeader>{job && <><DomainKnowledgeArchiveTargets key={job.id} job={job} initialIssue={confirmedArchiveIssue} disabled={busy || active || !!edit || job.production?.archive.state === "running"} onChange={setJob} onBusy={setArchiveSettingsSaving} replaceExisting={archiveReplaceExisting} onConfirmArchive={(next, issue) => { setArchiveIssue({ job_id: next.id, ...issue }); setArchiveSettingsSaving(false); setArchiveReplaceExisting(value => value || next.production?.archive.state === "opened"); setArchiveSettingsOpen(false); setArchiveOpenRequest(value => value + 1); }} />{active && <p className="text-sm text-muted-foreground">研究进行中，可查看归档位置；研究结束后可保存调整。</p>}{edit && <p className="text-sm text-muted-foreground">请先保存或取消正文编辑，再调整归档位置。</p>}</>}</DialogContent></Dialog>
    <Dialog open={reextracting} onOpenChange={setReextracting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>重新萃取？</DialogTitle></DialogHeader><p>复用单号、上传资料和研究配置，使用最新 Skill 创建新任务。原任务会停止并移除，原文稿不带入新任务；已发布知识和 MR 保留。</p>{error && <p role="alert" className="text-danger">{error}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setReextracting(false)}>取消</Button><Button disabled={busy} onClick={() => void reextract()}>{busy ? "正在重新萃取…" : "确认重新萃取"}</Button></div></DialogContent></Dialog>
    <Dialog open={deleting} onOpenChange={setDeleting}><DialogContent className="tw-root sm:max-w-[480px]"><DialogHeader><DialogTitle>删除领域萃取任务？</DialogTitle></DialogHeader><p className="font-medium">{job?.title}</p><p className="text-sm text-muted-foreground">{job?.deletion?.message}</p>{job?.deletion?.archive_batches.map(batch => <div key={batch.id} className="rounded border border-line p-3 text-sm"><strong>{batch.id}</strong>{batch.error && <p className="text-danger">{batch.error}</p>}<ul>{batch.documents.map(document => <li key={document.id}>{document.title} · {document.path}</li>)}</ul>{batch.publications.map(publication => <p key={`${publication.target_id}:${publication.branch}`}>{publication.error}{publication.url && <a className="ml-2 text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看 MR</a>}</p>)}</div>)}{error && <p role="alert" className="text-danger">{error}</p>}<div className="flex justify-end gap-3"><Button variant="outline" disabled={busy} onClick={() => setDeleting(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>确认删除</Button></div></DialogContent></Dialog>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="tw-root sm:max-w-[850px] max-h-[90vh] overflow-auto"><DialogHeader><DialogTitle>新建领域知识萃取</DialogTitle></DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<div className="space-y-5"><label className="grid gap-2">业务模块<select aria-label="萃取业务模块" className="rounded border border-line bg-surface p-2" value={moduleId} onChange={e => setModuleId(e.target.value)}><option value="">请选择业务模块</option>{modules.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>{module && <div className="rounded-lg border border-line bg-muted/30 p-3 text-sm"><p>{module.name} · 已关联 {module.repositories.length} 个代码仓</p>{module.knowledge_location ? <p className="mt-2 break-all text-muted-foreground">领域目录：{module.knowledge_location.docs_path}/ · {module.knowledge_location.branch}</p> : <p className="mt-2 text-attention">平台领域知识仓尚未配置，请联系管理员。</p>}</div>}<label className="grid gap-2">统一基准分支<Input aria-label="统一基准分支" value={baselineBranch} onChange={e => setBaselineBranch(e.target.value)} placeholder="master" /><span className="text-sm text-muted-foreground">本次关联仓库统一读取此分支。</span></label><><div className="grid grid-cols-[240px_minmax(0,1fr)] gap-3"><label className="grid gap-2">关联单号（必填）<Input aria-label="领域萃取关联单号" required maxLength={120} value={issueNo} onChange={e => setIssueNo(e.target.value)} placeholder="填写本次知识归档关联的需求或问题单号" /><span className="text-sm text-muted-foreground">本任务创建的所有 MR 关联此单号。</span></label><label className="grid gap-2">单号描述（必填）<Input aria-label="领域萃取单号描述" required maxLength={2000} value={issueDescription} onChange={e => setIssueDescription(e.target.value)} placeholder="从关联单据复制准确描述" /><span className="text-sm text-muted-foreground">从关联单据复制准确描述，将原样用作 MR 标题</span></label></div><p className="text-sm text-muted-foreground">点击「创建归档 MR」时会主动弹出目录和文档路径预览，确认后自动创建 MR。</p></><label className="grid gap-2">本次要求（可选）<Textarea aria-label="本次萃取要求" rows={4} maxLength={20000} value={instructions} onChange={e => setInstructions(e.target.value)} placeholder={"例如：只萃取订单模块的退款流程；不要读取 docs/ 和 legacy/payment.ts；用业务人员能看懂的语言说明规则。"} /></label><KnowledgeMaterialUpload materials={materials} onChange={setMaterials} onBusy={setUploading} disabled={busy} /><Button disabled={busy || uploading || materialsBlocked || !issueNo.trim() || !issueDescription.trim() || !module || !module.knowledge_location || (!!module.repositories.length && !baselineBranch.trim())} onClick={async () => { setBusy(true); setError(""); try { const next = await componentRequest<DomainKnowledgeJob>("/domain-extraction", { issue_no: issueNo, issue_description: issueDescription, module_id: moduleId, instructions: instructions.trim() || undefined, baseline_branch: baselineBranch, material_ids: materials.map(m => m.id) }); select(next.id); setJob(next); setStage("progress"); setOpen(false); setInstructions(""); await refreshList(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>开始萃取</Button></div></DialogContent></Dialog>
  </KnowledgeExtractionWorkspace></DomainKnowledgeInspectionContext.Provider>;
}
