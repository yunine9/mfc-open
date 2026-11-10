import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getSkillExtraction, approveSkillSubmission, rejectSkillSubmission, type SkillExtractionJob, type SkillSubmissionRecord } from "./api";
import { componentRequest } from "./componentResearchApi";
import { KnowledgeSkillImport } from "./KnowledgeSkillImport";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { KnowledgeContentSearch } from "./KnowledgeContentSearch";
import { Markdown } from "./markdown";
import type { KnowledgeProductionView } from "../../src/knowledgeProductionTypes";

type Package = { record: SkillSubmissionRecord; files: Array<{ path: string; bytes: number; content?: string }>; production?: KnowledgeProductionView };
export function KnowledgeSkillTask({ kind, id, onBack, onSubmitted }: { kind: "skill-extraction" | "skill-submission"; id: string; onBack: () => void; onSubmitted: (id: string) => void }) {
  const [job, setJob] = useState<SkillExtractionJob & {knowledge_scope?: {nature:string;business_module_ids:string[];technologies:string[]}}>(), [pack, setPack] = useState<Package>(), [file, setFile] = useState("SKILL.md"), [review, setReview] = useState(false);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [reason, setReason] = useState(""), [returnOpen, setReturnOpen] = useState(false), [resubmitting, setResubmitting] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  async function refresh() {
    if (kind === "skill-extraction") setJob(await getSkillExtraction(id));
    else { const [directory, submission] = id.split("/"); setPack(await componentRequest<Package>(`/skills/${encodeURIComponent(directory)}/submissions/${encodeURIComponent(submission)}`)); }
  }
  useEffect(() => { let live = true; const load = async () => { try { if (kind === "skill-extraction") { const next = await getSkillExtraction(id); if (live) setJob(next); } else { const [directory, submission] = id.split("/"); const next = await componentRequest<Package>(`/skills/${encodeURIComponent(directory)}/submissions/${encodeURIComponent(submission)}`); if (live) setPack(next); } } catch(e) { if (live) setError((e as Error).message); } }; void load(); const timer = setInterval(load,4000); return () => {live=false;clearInterval(timer);}; },[kind,id]);
  async function decide(approve: boolean) {
    if (!pack?.production || pack.production.review.readonly || !pack.production.research_actions.some(action => action.id === (approve ? "publish" : "reject"))) return;
    setBusy(true);setError(""); try { if (approve) await approveSkillSubmission(pack.record.directory,pack.record.id); else await rejectSkillSubmission(pack.record.directory,pack.record.id,reason); await refresh(); } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  const reviewAction = job?.production?.research_actions.find(action => action.id === "review");
  const rejectAction = pack?.production?.research_actions.find(action => action.id === "reject");
  if (review && reviewAction && job?.draft) return <KnowledgeSkillImport moduleKey={job.knowledge_scope?.nature === "business" ? `business:${job.knowledge_scope.business_module_ids[0]}` : job.knowledge_scope?.technologies[0] ? `engineering:${job.knowledge_scope.technologies[0]}` : ""} initialText={job.draft} onBack={() => setReview(false)}
    onCreated={async submissionId => { await componentRequest(`/knowledge/skill-extract/${encodeURIComponent(job.id)}/submitted`, { submission_id: submissionId }); onSubmitted(submissionId); }} />;
  const resubmitAction = pack?.production?.research_actions.find(action => action.id === "resubmit");
  // 被退回的包带回导入页修改后重新提交；只能带回文本文件，二进制附件需要重新选择目录。
  if (resubmitting && resubmitAction && pack) {
    // 含二进制附件时不预填（只带文本会悄悄丢附件），请人重新选择整个目录。
    const record = pack.record, hasBinary = pack.files.some(file => file.content === undefined);
    return <KnowledgeSkillImport title="修改后重新提交" initialFiles={hasBinary ? undefined : pack.files.map(file => ({ path: file.path, text: file.content! }))}
      moduleKey={record.nature === "business" && record.business_module_ids?.[0] ? `business:${record.business_module_ids[0]}` : record.technologies?.[0] ? `engineering:${record.technologies[0]}` : ""}
      onBack={() => setResubmitting(false)} onCreated={submissionId => { setResubmitting(false); onSubmitted(submissionId); }} />;
  }
  const current = pack?.files.find(f => f.path === file) ?? pack?.files[0];
  return <section className="knowledge-skill-task rounded-xl border border-line bg-surface p-6" aria-label="Skill 知识任务">
    {error && <p role="alert" className="text-danger mb-4">{error}</p>}
    {kind === "skill-extraction" ? <><header className="flex items-center justify-between gap-5"><div className="knowledge-page-title"><KnowledgeBackButton destination="任务中心" onClick={onBack} /><h2 className="text-2xl font-semibold">制作 Skill</h2></div>{reviewAction && <Button onClick={() => setReview(true)}>{reviewAction.label}</Button>}{job?.submission_id && <Button variant="outline" onClick={() => onSubmitted(job.submission_id!)}>查看提交</Button>}</header>
      <div className="knowledge-skill-content"><p className="text-muted-foreground">{job?.intent || "正在读取任务…"}</p>
      <p className="my-4 text-sm text-muted-foreground">{job?.operator} · {job?.started_at && new Date(job.started_at).toLocaleString()} · <span className={`knowledge-task-status is-${job?.production?.group ?? ""}`}>{job?.production?.status_label}</span></p>
      {job?.error && <p className="text-danger">{job.error}</p>}{job?.notes && <Markdown text={job.notes} />}{job?.draft && <Markdown text={job.draft} />}
      </div>
    </> : pack ? <><header className="flex items-center justify-between gap-5 mb-5"><div className="knowledge-page-title"><KnowledgeBackButton destination="任务中心" onClick={onBack} /><h2 className="text-2xl font-semibold">文稿审查</h2><span className="truncate text-sm text-muted-foreground" title={`${pack.files.length} 个文件 · ${pack.record.operator}`}>{pack.record.directory}</span></div><div className="flex shrink-0 items-center gap-2"><KnowledgeContentSearch contentRef={contentRef} contentKey={`${id}:${current?.path}`} disabled={current?.content === undefined} /><span className={`knowledge-task-status is-${pack.production?.group ?? ""}`}>{pack.production?.status_label}</span>{resubmitAction && <Button onClick={() => setResubmitting(true)}>{resubmitAction.label}</Button>}{pack.production && !pack.production.review.readonly && <div className="flex shrink-0 items-center gap-2">{pack.production.research_actions.map(action => <Button key={action.id} variant={action.id === "reject" ? "ghost" : "default"} disabled={busy} onClick={() => { if (action.id === "reject") setReturnOpen(true); else if (action.id === "publish") void decide(true); }}>{action.label}</Button>)}</div>}</div></header>
      {pack.record.status === "rejected" && <p className="mb-4 text-sm text-muted-foreground">已退回{pack.record.reject_reason ? `：${pack.record.reject_reason}` : ""}。请点「{resubmitAction?.label ?? "修改后重新提交"}」修改后再提交，原包与当前生效版本都保留。{pack.files.some(file => file.content === undefined) ? "包内有二进制附件，重新提交时请重新选择整个目录。" : ""}</p>}
      <div className="knowledge-skill-panes grid grid-cols-[260px_minmax(0,1fr)] gap-6 h-[calc(100dvh-300px)] min-h-[420px]"><nav className="overflow-y-auto overscroll-contain border-r border-line pr-4" aria-label="Skill 包文件">{pack.files.map(f => <button key={f.path} type="button" onClick={() => setFile(f.path)} aria-current={current?.path===f.path?"page":undefined} className={`block w-full break-all rounded-md px-3 py-2 text-left text-sm ${current?.path===f.path?"bg-primary/10 text-primary":"hover:bg-muted"}`}>{f.path}</button>)}</nav><article className="overflow-y-auto overscroll-contain pr-3"><h3 className="font-semibold mb-4">{current?.path}</h3><div ref={contentRef}>{current?.content !== undefined ? /\.md$/i.test(current.path) ? <Markdown text={current.content} /> : <pre className="whitespace-pre-wrap break-words text-sm">{current.content}</pre> : <p className="text-muted-foreground">此附件保留在完整包中，暂不提供文本预览。</p>}</div></article></div>
      {rejectAction && !pack.production?.review.readonly && <Dialog open={returnOpen} onOpenChange={setReturnOpen}><DialogContent className="tw-root sm:max-w-lg"><DialogHeader><DialogTitle>{rejectAction.label}</DialogTitle></DialogHeader><Textarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="说明需要调整的内容" /><Button disabled={busy || !reason.trim()} onClick={() => void decide(false)}>{rejectAction.label}</Button></DialogContent></Dialog>}
    </> : <><div className="knowledge-page-title"><KnowledgeBackButton destination="任务中心" onClick={onBack} /><h2 className="text-2xl font-semibold">文稿审查</h2></div><p className="mt-4 text-muted-foreground">正在读取 Skill 包…</p></>}
  </section>;
}
