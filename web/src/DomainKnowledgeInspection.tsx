import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, ClipboardCheck, LoaderCircle, MessageSquare, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { componentRequest } from "./componentResearchApi";
import type { KnowledgeReviewNoteInput, KnowledgeReviewNotesResult } from "../../src/knowledgeReviewNoteTypes";

interface InspectionDraft { documentId: string; scope: "document" | "study"; message: string }
interface InspectionState { started: boolean; drafts: InspectionDraft[]; inspectionId?: string }
const emptyResult = (): KnowledgeReviewNotesResult => ({ notes: [], submissions: {} });
const storageKey = (jobId: string) => `mfc:domain-inspection:${jobId}`;
function newInspectionId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function restore(jobId: string): InspectionState {
  try {
    const value = JSON.parse(sessionStorage.getItem(storageKey(jobId)) ?? "null");
    if (value && typeof value.started === "boolean" && Array.isArray(value.drafts)) {
      const inspectionId = typeof value.inspectionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.inspectionId) ? value.inspectionId : undefined;
      return { started: value.started, inspectionId: value.started ? inspectionId ?? newInspectionId() : inspectionId,
        drafts: value.drafts.filter((item: InspectionDraft) => typeof item.documentId === "string" && (item.scope === "study" || item.scope === "document") && typeof item.message === "string") };
    }
  } catch { /* 浏览器禁止本地存储时，已保存到平台的意见仍可读取。 */ }
  return { started: false, drafts: [] };
}

export function useDomainKnowledgeInspection({ jobId, refreshToken, working, blockedReason, initiallyStarted = false, independent = false, onSubmitted, onStarted, onEnded }: { jobId?: string; refreshToken?: unknown; working: boolean; blockedReason?: string; initiallyStarted?: boolean; independent?: boolean; onSubmitted: () => void; onStarted?: () => void; onEnded?: () => void }) {
  const [state, setState] = useState<InspectionState>(() => jobId ? restore(jobId) : { started: false, drafts: [] });
  const [stateJob, setStateJob] = useState(jobId);
  const [result, setResult] = useState(emptyResult);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [loaded, setLoaded] = useState(false), [inlineEditing, setInlineEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(""), [readAttempt, setReadAttempt] = useState(0);
  const owner = useRef({ jobId }), requestVersion = useRef(0), resultVersion = useRef(0), operation = useRef<object | undefined>(undefined), mounted = useRef(true);
  const pendingSaves = useRef(new Set<object>()), stateRef = useRef(state), resultRef = useRef(result); stateRef.current = state; resultRef.current = result;
  const readRequest = useRef<{ task: object; controller: AbortController } | undefined>(undefined);
  if (owner.current.jobId !== jobId) owner.current = { jobId };
  const task = owner.current;
  const isCurrent = () => mounted.current && owner.current === task;
  const isCurrentInspection = (inspectionId: string) => isCurrent() && stateJob === jobId && stateRef.current.started && stateRef.current.inspectionId === inspectionId;
  const receiveResult = (next: KnowledgeReviewNotesResult) => { resultRef.current = next; setResult(next); };
  const setTaskInlineEditing = useCallback((editing: boolean) => { if (mounted.current && owner.current === task) setInlineEditing(editing); }, [task]);
  const draftsRef = useRef(state.drafts); draftsRef.current = state.drafts;
  const path = `/knowledge-review/domain/${encodeURIComponent(jobId ?? "")}`;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    setStateJob(jobId); requestVersion.current++; resultVersion.current++; operation.current = undefined; pendingSaves.current.clear();
    setState(jobId ? restore(jobId) : { started: false, drafts: [] }); receiveResult(emptyResult()); setLoaded(false);
    setError(""); setLoadError(""); setLoading(false); setBusy(false); setSaving(false); setInlineEditing(false);
  }, [jobId]);
  useEffect(() => {
    if (jobId && initiallyStarted) setState(current => ({ ...current, started: true, inspectionId: current.inspectionId ?? newInspectionId() }));
  }, [jobId, initiallyStarted]);
  useEffect(() => {
    if (!jobId) return;
    // 先恢复对应任务再写回，避免任务切换时把前一个任务的检视状态写入新任务。
    if (stateJob !== jobId) return;
    try { sessionStorage.setItem(storageKey(jobId), JSON.stringify(state)); } catch { /* 平台保存不依赖本地存储。 */ }
  }, [jobId, stateJob, state]);
  const readNotes = useCallback(() => {
    if (!jobId || !mounted.current || owner.current !== task || readRequest.current?.task === task) return;
    const request = { task, controller: new AbortController() }, version = resultVersion.current;
    readRequest.current = request;
    const acceptsResult = () => mounted.current && owner.current === task && readRequest.current === request;
    setLoading(true); setLoadError("");
    void componentRequest<KnowledgeReviewNotesResult>(path, undefined, AbortSignal.any([request.controller.signal, AbortSignal.timeout(30_000)]))
      .then(next => { if (acceptsResult() && version === resultVersion.current) { receiveResult(next); setLoaded(true); setLoadError(""); } })
      .catch(reason => {
        if (acceptsResult() && version === resultVersion.current) {
          setLoaded(false);
          setLoadError(reason instanceof Error && reason.name === "TimeoutError" ? "读取超时，请重试。" : reason instanceof Error ? reason.message : "暂时无法读取，请重试。");
        }
      })
      .finally(() => { if (acceptsResult()) { readRequest.current = undefined; setLoading(false); } });
  }, [jobId, path, task]);
  useEffect(() => () => {
    const request = readRequest.current;
    if (request?.task === task) { readRequest.current = undefined; request.controller.abort(); }
  }, [task]);
  // 任务信息会定期刷新；同一任务的慢请求继续等待，只在切换任务或离开时取消。
  useEffect(() => { readNotes(); }, [readNotes, refreshToken, readAttempt]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (inlineEditing) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [inlineEditing]);
  function updateDraft(documentId: string, scope: "document" | "study", message: string) {
    if (!isCurrent() || stateJob !== jobId) return;
    setState(current => ({ ...current, drafts: [...current.drafts.filter(item => item.documentId !== documentId || item.scope !== scope), ...(message ? [{ documentId, scope, message }] : [])] }));
  }
  async function saveNote(input: KnowledgeReviewNoteInput, currentOperation?: object) {
    if (!jobId || !isCurrent()) throw new Error("任务已切换，请在当前任务中保存意见。");
    const inspectionId = stateRef.current.inspectionId;
    if (!inspectionId || !isCurrentInspection(inspectionId)) throw new Error("请先开始检视，再保存本轮意见。");
    if (operation.current && operation.current !== currentOperation) throw new Error("意见正在提交，请等待完成后继续保存。");
    const pending = {}; pendingSaves.current.add(pending); setSaving(true);
    const version = ++requestVersion.current;
    try {
      const next = await componentRequest<KnowledgeReviewNotesResult>(path, { ...input, inspection_id: inspectionId });
      if (isCurrentInspection(inspectionId) && version === requestVersion.current) { resultVersion.current++; receiveResult(next); setLoaded(true); setLoadError(""); }
      if (isCurrentInspection(inspectionId) && input.scope !== "line") setState(current => current.inspectionId !== inspectionId ? current : { ...current, drafts: current.drafts.filter(item => item.documentId !== input.document_id || item.scope !== input.scope || item.message !== input.note) });
      return next;
    } finally { pendingSaves.current.delete(pending); if (isCurrent()) setSaving(pendingSaves.current.size > 0); }
  }
  const save = (input: KnowledgeReviewNoteInput) => saveNote(input);
  async function resolve(id: string) {
    if (!jobId || !isCurrent()) throw new Error("任务已切换，请在当前任务中处理意见。");
    const version = ++requestVersion.current;
    const next = await componentRequest<KnowledgeReviewNotesResult>(`${path}/resolve`, { note_ids: [id] });
    if (isCurrent() && version === requestVersion.current) { resultVersion.current++; receiveResult(next); setLoaded(true); setLoadError(""); }
    return next;
  }
  const submission = Object.values(result.submissions).find(item => item.working);
  const modifying = working || !!submission;
  const hasWorkingSubmission = () => working || Object.values(resultRef.current.submissions).some(item => item.working);
  function endInspection(inspectionId: string) {
    stateRef.current = { ...stateRef.current, started: false, inspectionId: undefined };
    // 保存期间又编辑的文本不随结束操作清空，留待下一轮继续处理。
    setState(current => current.inspectionId === inspectionId ? { started: false, drafts: current.drafts } : current);
    onEnded?.(); onSubmitted();
  }
  async function finish() {
    const inspectionId = stateRef.current.inspectionId;
    if (!jobId || !inspectionId || !isCurrentInspection(inspectionId) || operation.current || pendingSaves.current.size || hasWorkingSubmission() || blockedReason || inlineEditing || !loaded || loadError) return;
    const currentOperation = {}; operation.current = currentOperation; setBusy(true); setError(""); requestVersion.current++;
    try {
      // 关闭弹窗不会丢掉输入；结束检视时先保存所有文稿中尚未点击保存的整篇/整体意见。
      for (const draft of [...draftsRef.current]) {
        if (!isCurrentInspection(inspectionId)) return;
        if (draft.message.trim()) await saveNote({ document_id: draft.documentId, scope: draft.scope, note: draft.message }, currentOperation);
      }
      if (!isCurrentInspection(inspectionId)) return;
      const latest = await componentRequest<KnowledgeReviewNotesResult>(path, undefined, AbortSignal.timeout(30_000));
      if (!isCurrentInspection(inspectionId)) return;
      const noteIds = latest.notes.filter(note => note.inspection_id === inspectionId && note.status === "open" && !note.turn_id).map(note => note.id);
      if (noteIds.length) {
        const next = await componentRequest<KnowledgeReviewNotesResult>(`${path}/apply`, { note_ids: noteIds, inspection_id: inspectionId });
        if (!isCurrentInspection(inspectionId)) return;
        requestVersion.current++; resultVersion.current++; receiveResult(next); endInspection(inspectionId);
      } else {
        if (independent) await componentRequest(`/domain-extraction/${encodeURIComponent(jobId)}/inspection/finish`, {});
        if (!isCurrentInspection(inspectionId)) return;
        resultVersion.current++; receiveResult(latest); endInspection(inspectionId);
      }
    } catch (reason) { if (isCurrent()) setError((reason as Error).message); }
    finally { if (operation.current === currentOperation) operation.current = undefined; if (isCurrent()) setBusy(false); }
  }
  async function retry(noteIds: string[]) {
    const ids = [...new Set(noteIds)];
    if (!ids.length) throw new Error("请选择需要重试的历史意见。");
    if (!jobId || !isCurrent() || stateJob !== jobId) throw new Error("任务已切换，请在当前任务中重试意见。");
    if (operation.current || pendingSaves.current.size) throw new Error("意见正在保存或提交，请等待完成后重试。");
    if (hasWorkingSubmission()) throw new Error("任务正在处理，完成后再重试历史意见。");
    if (blockedReason) throw new Error(blockedReason);
    if (inlineEditing) throw new Error("请先记下或取消正在编辑的行意见。");
    if (!loaded || loadError) throw new Error("检视意见尚未加载完成，请先重试读取。");
    const currentOperation = {}; operation.current = currentOperation; setBusy(true); setError("");
    const version = ++requestVersion.current;
    try {
      const next = await componentRequest<KnowledgeReviewNotesResult>(`${path}/apply`, { note_ids: ids, retry: true });
      if (!isCurrent()) return;
      if (version === requestVersion.current) { resultVersion.current++; receiveResult(next); setLoaded(true); setLoadError(""); }
      onSubmitted();
    } catch (reason) { if (isCurrent()) setError((reason as Error).message); throw reason; }
    finally { if (operation.current === currentOperation) operation.current = undefined; if (isCurrent()) setBusy(false); }
  }
  const currentState = stateJob === jobId;
  return { jobId, inspectionId: currentState ? state.inspectionId : undefined, started: currentState && state.started, drafts: currentState ? state.drafts : [], result: currentState ? result : emptyResult(),
    loaded: currentState && loaded, loading: !!jobId && (!currentState || loading), loadError: currentState ? loadError : "", busy: currentState && (busy || saving),
    error: currentState ? error : "", inlineEditing, modifying, blockedReason,
    pendingCount: currentState && state.started && state.inspectionId ? result.notes.filter(note => note.inspection_id === state.inspectionId && note.status === "open" && !note.turn_id).length : 0,
    retryLoad: () => { if (jobId && isCurrent() && !busy && !loading) setReadAttempt(attempt => attempt + 1); },
    start: () => { if (!jobId || !isCurrent() || !currentState || !loaded || loadError || busy || operation.current || pendingSaves.current.size || stateRef.current.started) return;
      setError(""); const next = { ...stateRef.current, started: true, inspectionId: newInspectionId() }; stateRef.current = next; setState(next); onStarted?.(); },
    updateDraft, save, resolve, finish, retry, setInlineEditing: setTaskInlineEditing };
}
export type DomainKnowledgeInspection = ReturnType<typeof useDomainKnowledgeInspection>;
export const DomainKnowledgeInspectionContext = createContext<DomainKnowledgeInspection | undefined>(undefined);
export const useKnowledgeInspection = () => useContext(DomainKnowledgeInspectionContext);

function InspectionReadStatus({ inspection }: { inspection: DomainKnowledgeInspection }) {
  if (inspection.loading && !inspection.loaded) return <span role="status" className="domain-inspection-read-status"><LoaderCircle size={14} className="animate-spin" />正在读取检视意见…</span>;
  if (!inspection.loadError) return null;
  return <div role="alert" className="domain-inspection-read-status is-error">
    <span>检视意见读取失败：{inspection.loadError}</span>
    <Button size="sm" variant="ghost" disabled={inspection.busy} onClick={inspection.retryLoad}><RefreshCw size={14} />重试读取</Button>
  </div>;
}

export function DomainKnowledgeInspectionBar({ inspection, onOverall, onProgress }: { inspection: DomainKnowledgeInspection; onOverall: () => void; onProgress: () => void }) {
  if (!inspection.started) return null;
  const drafts = inspection.drafts.filter(item => item.message.trim()).length;
  const reason = inspection.inlineEditing ? "请先记下或取消正在编辑的行意见。" : inspection.blockedReason ?? (inspection.modifying ? "任务正在处理，可继续保存意见，完成后再结束检视。" : undefined);
  return <section aria-label="文稿检视" className="domain-inspection-bar">
    <div className="domain-inspection-label"><span className="domain-inspection-icon"><ClipboardCheck size={18} /></span><div><strong>正在检视</strong><span>{inspection.loaded || inspection.result.notes.length ? `${inspection.pendingCount} 条已保存` : "已保存意见待加载"}{drafts ? ` · ${drafts} 条待保存` : ""}<span className="domain-inspection-hint"> · 可切换文稿继续提意见</span></span></div></div>
    <div className="domain-inspection-actions"><Button size="sm" variant="ghost" disabled={inspection.busy} onClick={onOverall}><MessageSquare size={15} />整体意见</Button><Button size="sm" disabled={!inspection.loaded || !!inspection.loadError || inspection.busy || inspection.modifying || !!reason} title={reason} onClick={() => void inspection.finish()}>{inspection.busy ? <LoaderCircle size={15} className="animate-spin" /> : <Check size={15} />}{inspection.busy ? "正在提交…" : inspection.pendingCount || drafts ? "结束检视并修改" : "结束检视"}</Button></div>
    <InspectionReadStatus inspection={inspection} />
    {(reason || inspection.error) && <p role={inspection.error ? "alert" : "status"} className={inspection.error ? "text-danger" : "text-muted-foreground"}>{inspection.error || reason}{inspection.modifying && <button className="ml-2 text-primary underline-offset-4 hover:underline" onClick={onProgress}>查看研究过程</button>}</p>}
  </section>;
}
export function DomainKnowledgeInspectionStart({ inspection, disabled }: { inspection: DomainKnowledgeInspection; disabled?: boolean }) {
  if (inspection.started) return null;
  return <div className="domain-inspection-entry"><Button size="sm" variant="outline" disabled={disabled || inspection.busy || !inspection.loaded || !!inspection.loadError} onClick={inspection.start}><Play size={14} />开始检视{inspection.pendingCount ? <span className="domain-inspection-count">{inspection.pendingCount}</span> : null}</Button><InspectionReadStatus inspection={inspection} /></div>;
}
