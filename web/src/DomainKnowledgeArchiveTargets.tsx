import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob, KnowledgeRepository, DomainArchiveTargetsPreview } from "../../src/domainKnowledgeTypes";
import { directoryKnowledgeDirectory, hasOpaqueModuleDirectory } from "../../src/domainKnowledgeLayout";
import type { ArchiveIssueInput } from "./knowledgeArchiveAction";
import { knowledgeLocationSettingsUrl } from "./KnowledgeModuleLocation";
import { businessModuleKnowledgeRequest, type BusinessModuleKnowledgeLocation } from "./api";

const targetsOf = (job: DomainKnowledgeJob) => [job.knowledge_target, ...job.repositories];
const confirmedDeletion = (document: DomainKnowledgeJob["documents"][number]) => !!document.deleted && !!document.knowledge_document_id && document.published_document_revision === document.revision;
function initialTargets(job: DomainKnowledgeJob) {
  const title = job.module_name || job.title;
  return targetsOf(job).map(target => {
    if (job.component_research_id || job.documents.length > 0 && job.documents.every(confirmedDeletion)) return { ...target };
    const isDomain = target.id === job.knowledge_target.id;
    if (isDomain && job.module_id && !job.component_research_id) return { ...target };
    if (job.knowledge_layout === "directory-v1" && target.docs_path && target.docs_path !== "." && !hasOpaqueModuleDirectory(target.docs_path)
      && (isDomain || target.docs_path.startsWith("docs/"))) return { ...target };
    return { ...target, docs_path: directoryKnowledgeDirectory(target.docs_path, title, job.module_id, isDomain) };
  });
}
export function DomainKnowledgeArchivePathPreview({ preview, deletedDocumentIds = [] }: { preview: DomainArchiveTargetsPreview; deletedDocumentIds?: string[] }) {
  const deletingOnly = preview.documents.length > 0 && preview.documents.every(document => deletedDocumentIds.includes(document.id));
  return <section aria-label="文档路径预览" className="space-y-3">
    <h3 className="text-sm font-semibold">文档路径预览</h3>
    {preview.targets.filter(target => preview.documents.some(document => document.target_id === target.id)).map(target => <div key={target.id} className="space-y-2 rounded border border-line p-3">
      <h4 className="text-sm font-medium">{target.id === "domain" ? "领域知识仓" : target.name}</h4>
      {!deletingOnly && <p className="break-all text-xs text-muted-foreground">平台维护入口：<code>{target.id === "domain" ? `${target.docs_path}/AGENTS.md` : "AGENTS.md"}</code></p>}
      <ul className="m-0 list-none space-y-2 p-0">{preview.documents.filter(document => document.target_id === target.id).map(document => <li key={document.id} className="text-sm">
        <span className="text-muted-foreground">{document.title}{deletedDocumentIds.includes(document.id) ? " · 删除原文件" : ""}</span>
        <code className="block break-all">{document.path}</code>
      </li>)}</ul>
    </div>)}
  </section>;
}
export function DomainKnowledgeArchiveTargets({ job, disabled, onChange, onBusy, onConfirmArchive, replaceExisting = false, initialIssue }: {
  job: DomainKnowledgeJob; disabled?: boolean; onChange: (job: DomainKnowledgeJob) => void; onBusy?: (busy: boolean) => void;
  onConfirmArchive?: (job: DomainKnowledgeJob, issue: ArchiveIssueInput) => void | Promise<void>; replaceExisting?: boolean; initialIssue?: ArchiveIssueInput;
}) {
  const [targets, setTargets] = useState(() => initialTargets(job));
  const [issue, setIssue] = useState(initialIssue?.issue_no ?? job.issue_no ?? ""), [description, setDescription] = useState(initialIssue?.issue_description ?? job.issue_description ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [preview, setPreview] = useState<{ key: string; data: DomainArchiveTargetsPreview }>();
  const [previewing, setPreviewing] = useState(true);
  const [previewRetry, setPreviewRetry] = useState(0);
  const [moduleLocation, setModuleLocation] = useState<BusinessModuleKnowledgeLocation>();
  useEffect(() => {
    let live = true; setModuleLocation(undefined);
    if (job.module_id && !job.component_research_id) void businessModuleKnowledgeRequest(job.module_id).then(value => { if (live) setModuleLocation(value.location); }).catch(reason => { if (live) setError((reason as Error).message); });
    return () => { live = false; };
  }, [job.id, job.module_id]);
  useEffect(() => { setTargets(initialTargets(job)); setError(""); }, [job.id, job.archive_revision]);
  useEffect(() => { setIssue(initialIssue?.issue_no ?? job.issue_no ?? ""); setDescription(initialIssue?.issue_description ?? job.issue_description ?? ""); }, [job.id, initialIssue?.issue_no, initialIssue?.issue_description]);
  const deletingOnly = job.documents.length > 0 && job.documents.every(confirmedDeletion);
  const invalid = targets.some(target => !target.branch.trim() || !target.docs_path.trim()
    || job.documents.some(document => document.target_id === target.id) && !target.repository.trim());
  const input = { targets: targets.filter(target => !!target.repository.trim() || job.documents.some(document => document.target_id === target.id)),
    documents: [], use_directory_layout: !job.component_research_id, base_revision: job.archive_revision ?? 0 };
  const previewKey = JSON.stringify({ input, revisions: job.documents.map(document => [document.id, document.revision, document.published_revision]),
    proposals: job.turns.flatMap(turn => turn.proposals.map(proposal => [proposal.document.id, proposal.status, proposal.base_revision])) });
  const domainTarget = targets.find(target => target.id === job.knowledge_target.id);
  const canAdoptModuleLocation = moduleLocation && domainTarget && !job.publications.length && !(job.archive_batches ?? []).some(batch => batch.publications.some(publication => !!publication.url))
    && (moduleLocation.repository !== domainTarget.repository || moduleLocation.branch !== domainTarget.branch || moduleLocation.docs_path !== domainTarget.docs_path);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(undefined); setError(""); setPreviewing(!invalid && !disabled);
    if (invalid || disabled) return () => controller.abort();
    const timer = setTimeout(() => {
      void componentRequest<DomainArchiveTargetsPreview>(`/domain-extraction/${job.id}/archive-targets/preview`, input,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]))
        .then(candidate => { if (!controller.signal.aborted) setPreview({ key: previewKey, data: candidate }); })
        .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).name === "TimeoutError" ? "计算文档路径超时，请调整目录后重试。" : (reason as Error).message); })
        .finally(() => { if (!controller.signal.aborted) setPreviewing(false); });
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [job.id, previewKey, invalid, disabled, previewRetry]);
  function change(id: string, patch: Partial<KnowledgeRepository>) { setTargets(previous => previous.map(target => target.id === id ? { ...target, ...patch } : target)); }
  async function confirm() {
    if (preview?.key !== previewKey || previewing) return;
    setBusy(true); onBusy?.(true); setError("");
    try {
      const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${job.id}/archive-targets`, input, AbortSignal.timeout(30_000));
      onChange(next);
      await onConfirmArchive?.(next, { issue_no: issue.trim(), issue_description: description.trim() });
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); onBusy?.(false); }
  }
  return <section className="space-y-4" aria-label="确认 Git 归档路径">
    <p className="text-sm text-muted-foreground">下方预览本次 MR 的文档路径。领域知识使用任务创建时保存的模块目录；代码仓知识放在 docs 下的业务目录。确认后自动创建或更新 MR。</p>
    {job.module_id && !job.component_research_id && <p className="text-xs text-muted-foreground">本模块后续任务的默认目录在<a className="mx-1 text-primary underline" href={knowledgeLocationSettingsUrl(job.module_id)}>配置中心 · 领域知识目录</a>维护；当前任务保留原目录。</p>}
    {canAdoptModuleLocation && <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm"><div><strong className="font-medium">模块已保存新的领域目录</strong><p className="mt-1 break-all text-muted-foreground">{moduleLocation.docs_path}/ · {moduleLocation.branch}</p><p className="mt-1 text-xs text-muted-foreground">当前任务尚未创建 MR，可直接沿用新目录，已有文稿会自动调整路径。</p></div><Button variant="outline" size="sm" disabled={busy || disabled || deletingOnly} onClick={() => change(job.knowledge_target.id, moduleLocation)}>本次使用模块目录</Button></div>}
    {onConfirmArchive && <div className="grid grid-cols-2 gap-3">
      <label className="grid gap-1 text-sm">本次归档单号（必填）<Input aria-label="本次归档单号" maxLength={120} disabled={busy || disabled} value={issue} onChange={event => setIssue(event.target.value)} /></label>
      <label className="grid gap-1 text-sm">本次归档单号描述<Input aria-label="本次归档单号描述" maxLength={2000} disabled={busy || disabled} value={description} onChange={event => setDescription(event.target.value)} /></label>
    </div>}
    {deletingOnly && <p className="text-sm text-muted-foreground">删除沿用原归档位置。</p>}
    {targets.map(target => <fieldset key={target.id} className="grid grid-cols-2 gap-3 rounded border border-line p-3" disabled={busy || disabled || deletingOnly || target.id === job.knowledge_target.id && !!job.module_id && !job.component_research_id}>
      <legend className="px-1 font-medium">{target.id === job.knowledge_target.id ? "领域知识仓" : `代码仓 · ${target.name}`}</legend>
      <label className="col-span-2 grid gap-1 text-sm">归档仓地址<Input aria-label={`${target.id} 归档仓地址`} value={target.repository} onChange={event => change(target.id, { repository: event.target.value })} placeholder="https://…/knowledge.git" /></label>
      <label className="grid gap-1 text-sm">归档分支<Input aria-label={`${target.id} 归档分支`} value={target.branch} onChange={event => change(target.id, { branch: event.target.value })} /></label>
      <label className="grid gap-1 text-sm">仓内相对目录<Input aria-label={`${target.id} 归档文档目录`} value={target.docs_path} onChange={event => change(target.id, { docs_path: event.target.value })} placeholder="docs/业务目录" /></label>
    </fieldset>)}
    {previewing && <p role="status" className="text-sm text-muted-foreground">正在计算各文档的最终路径…</p>}
    {preview?.key === previewKey && <DomainKnowledgeArchivePathPreview preview={preview.data} deletedDocumentIds={job.documents.filter(confirmedDeletion).map(document => document.id)} />}
    {error && <p role="alert" className="whitespace-pre-wrap text-sm text-danger">{error}</p>}
    {error && !preview && <Button size="sm" variant="outline" disabled={busy || disabled} onClick={() => setPreviewRetry(value => value + 1)}>重新预览路径</Button>}
    <div className="sticky -bottom-4 -mx-4 -mb-4 flex justify-end border-t border-line bg-popover px-4 py-3">
      <Button disabled={busy || disabled || invalid || previewing || preview?.key !== previewKey || !targets.length || !!onConfirmArchive && !issue.trim()} onClick={() => void confirm()}>{busy ? "正在准备 MR…" : replaceExisting ? "确认并重新创建 MR" : "确认并创建 MR"}</Button>
    </div>
  </section>;
}
