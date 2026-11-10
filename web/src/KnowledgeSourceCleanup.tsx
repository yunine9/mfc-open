import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { componentRequest } from "./componentResearchApi";
import type { DomainKnowledgeJob } from "../../src/domainKnowledgeTypes";
import { mrParticipantsMessage } from "../../src/mrParticipants";

export interface KnowledgeCleanupDraft { planKey: string; paths: Record<string, string>; selected: Record<string, string[]>; editing: boolean }

export function KnowledgeSourceCleanup({ task, draft, onDraftChange, onChange, onBusy }: { task: DomainKnowledgeJob; draft?: KnowledgeCleanupDraft; onDraftChange?: (draft: KnowledgeCleanupDraft) => void; onChange: (task: DomainKnowledgeJob) => void; onBusy?: (busy: boolean) => void }) {
  const state = task.source_cleanup!;
  const planKey = state.plans.map(plan => plan.id).join(",");
  const initial = draft?.planKey === planKey ? draft : undefined;
  const [paths, setPaths] = useState<Record<string, string>>(() => initial?.paths ?? Object.fromEntries(state.repositories.map(repo => [repo.id,
    state.plans.find(plan => plan.target_id === repo.id)?.paths.join("\n") ?? ((task.knowledge_layout === "repository-v1" || task.knowledge_layout === "directory-v1") ? "" : task.knowledge_layout === "module-v1" ? repo.docs_path : `${repo.docs_path}\nAGENTS.md`)])));
  const [selected, setSelected] = useState<Record<string, string[]>>(() => initial?.selected ?? Object.fromEntries(state.plans.map(plan => [plan.target_id, plan.selected_paths ?? plan.entries.map(entry => entry.path)])));
  const [editing, setEditing] = useState(initial?.editing ?? !state.plans.length), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const submitting = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const previousPlan = useRef(planKey);
  // 普通任务刷新不能重置尚未提交的文件选择；只有新预览才重新选中清单。
  useEffect(() => { if (previousPlan.current !== planKey) { previousPlan.current = planKey; setSelected(Object.fromEntries(state.plans.map(plan => [plan.target_id, plan.selected_paths ?? plan.entries.map(entry => entry.path)]))); } }, [planKey]);
  // 草稿留在知识库页面，查看方法或返回任务中心后再进来仍保留人工选择。
  useEffect(() => { onDraftChange?.({ planKey, paths, selected, editing }); }, [planKey, paths, selected, editing]);
  const locked = state.publications.some(publication => publication.revision || publication.url || publication.mr_attempted);
  const total = state.plans.reduce((sum, plan) => sum + plan.entries.length, 0);
  const selectedCount = Object.values(selected).reduce((sum, paths) => sum + paths.length, 0);
  const pending = state.repositories.filter(repo => selected[repo.id]?.length && !state.publications.some(publication => publication.target_id === repo.id && publication.url));
  const pendingFiles = pending.reduce((sum, repo) => sum + (selected[repo.id]?.length ?? 0), 0);
  const failed = state.publications.some(publication => publication.state === "failed");
  async function request(action: "preview" | "publish" | "start") {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); onBusy?.(true); setError("");
    const body = action === "preview" ? { paths_by_target: Object.fromEntries(state.repositories.map(repo => [repo.id,
      (paths[repo.id] ?? "").split("\n").map(path => path.trim()).filter(Boolean)])) }
      : action === "publish" ? { selected_paths_by_target: Object.fromEntries(state.repositories.map(repo => [repo.id, selected[repo.id] ?? []])) } : {};
    try {
      const next = await componentRequest<DomainKnowledgeJob>(`/domain-extraction/${task.id}/source-cleanup/${action}`, body, AbortSignal.timeout(5 * 60_000));
      if (alive.current) { onChange(next); if (action === "preview") setEditing(false); }
    } catch (reason) { if (alive.current) setError((reason as Error).name === "TimeoutError" ? "请求超过 5 分钟，请重新打开任务查看实际结果后重试。" : (reason as Error).message); }
    finally { submitting.current = false; if (alive.current) { setBusy(false); onBusy?.(false); } }
  }
  return <section aria-label="萃取前清理旧知识" className="space-y-4">
    <div><h2 className="text-lg font-semibold">先清理旧知识</h2><p className="mt-1 text-sm text-muted-foreground">清理只删除你选中的仓内文件。创建清理 MR 后，请在仓库审查、合入，再手动开始萃取；开始时读取基准分支最新代码。</p></div>
    {error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{error}</p>}
    {state.repositories.map(repo => {
      const plan = state.plans.find(plan => plan.target_id === repo.id), publication = state.publications.find(item => item.target_id === repo.id);
      const chosen = selected[repo.id] ?? [], immutable = !!(publication?.revision || publication?.url || publication?.mr_attempted);
      return <section key={repo.id} className="space-y-3 rounded-lg border border-line p-4" aria-label={`${repo.name}清理`}>
        <div className="flex items-center justify-between gap-3"><h3 className="font-semibold">{repo.name}</h3><span className="text-sm text-muted-foreground">{publication?.url ? "清理 MR 已创建" : publication?.state === "failed" ? "创建失败" : editing ? "填写清理范围" : `${chosen.length} 个待删 · ${(plan?.entries.length ?? 0) - chosen.length} 个保留`}</span></div>
        <p className="break-all text-xs text-muted-foreground">{repo.repository} · {repo.branch}</p>
        {editing ? <label className="grid gap-2 text-sm">待删除的目录或文件（每行一个）<Textarea aria-label={`${repo.name}清理路径`} rows={3} disabled={busy} value={paths[repo.id] ?? ""} onChange={event => setPaths(current => ({ ...current, [repo.id]: event.target.value }))} /><span className="text-xs text-muted-foreground">逐行填写仓内相对目录或文件路径，预览后勾选待删除文件；可清理旧目录，不受新归档目录限制。留空会跳过此仓。</span></label>
          : <><details open={publication?.url ? undefined : true}><summary className={publication?.url ? "cursor-pointer text-sm text-muted-foreground" : "hidden"}>查看已提交的删除清单（{chosen.length} 个文件）</summary>{!!plan?.entries.length && <div className="flex items-center gap-3 text-sm"><Button type="button" size="sm" variant="ghost" disabled={busy || immutable} onClick={() => setSelected(current => ({ ...current, [repo.id]: plan.entries.map(entry => entry.path) }))}>全选</Button><Button type="button" size="sm" variant="ghost" disabled={busy || immutable} onClick={() => setSelected(current => ({ ...current, [repo.id]: [] }))}>全部保留</Button></div>}
            {!!plan?.entries.length ? <ul className="m-0 max-h-60 list-none overflow-auto p-0">{plan.entries.map(entry => <li key={entry.path}><label className="flex cursor-pointer items-start gap-3 rounded px-2 py-2 text-sm hover:bg-surface-2"><input type="checkbox" className="mt-1 shrink-0" aria-label={`删除 ${repo.name} ${entry.path}`} disabled={busy || immutable} checked={chosen.includes(entry.path)} onChange={event => setSelected(current => ({ ...current, [repo.id]: event.target.checked ? [...chosen, entry.path] : chosen.filter(path => path !== entry.path) }))} /><code className="min-w-0 break-all">{entry.path}</code></label></li>)}</ul> : <p className="text-sm text-muted-foreground">指定范围内没有匹配文件，不会创建空 MR。</p>}
          </details></>}
        {publication?.error && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-danger">{publication.error}</p>}
        {publication?.url && <a className="text-sm font-medium text-primary underline" href={publication.url} target="_blank" rel="noreferrer">查看清理 MR ↗</a>}
        {mrParticipantsMessage(publication?.mr_participants) && <p role="status" className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {mrParticipantsMessage(publication?.mr_participants)}</p>}
      </section>;
    })}
    <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-4 border-t border-line bg-surface px-4 py-3">
      <div className="text-sm text-muted-foreground">{busy ? <span role="status" className="flex items-center gap-2"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" />正在处理，请稍候…</span> : editing ? "先预览文件，再决定删除哪些。" : pending.length ? `本次将删除 ${pendingFiles} 个文件，共保留 ${total - selectedCount} 个。` : selectedCount ? "请先审查、合入上面的清理 MR。" : "没有选择待删文件，可直接开始萃取。"}</div>
      <div className="flex shrink-0 items-center gap-3">
        {!busy && (editing || pending.length > 0) && <Button type="button" variant="ghost" onClick={() => void request("start")}>跳过清理并开始</Button>}
        {!editing && !locked && <Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(true)}>修改范围</Button>}
        <Button type="button" disabled={busy} onClick={() => void request(editing ? "preview" : pending.length ? "publish" : "start")}>{editing ? "预览待删文件" : pending.length ? `${failed ? "重试" : "创建"} ${pending.length} 个清理 MR` : "开始萃取"}</Button>
      </div>
    </div>
  </section>;
}
