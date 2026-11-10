import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { DomainKnowledgeJob, DomainDocument } from "../../src/domainKnowledgeTypes";
import { domainDocumentHasChanges, domainReviewDocuments } from "./domainKnowledgePublication";

export function DomainKnowledgeFileTree({ job, currentId, currentWorkId, onWorkNavigate, disabled, onNavigate, onSelection, onSelections }: {
  job: DomainKnowledgeJob; currentId?: string; disabled?: boolean;
  currentWorkId?: string; onWorkNavigate?: (turnId: string, id: string) => void;
  onNavigate: (id: string) => void; onSelection: (id: string, selected: boolean) => void;
  onSelections?: (ids: string[], selected: boolean) => void;
}) {
  const [query, setQuery] = useState(""), [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const needle = query.trim().toLocaleLowerCase();
  const targets = [job.knowledge_target, ...job.repositories];
  function toggle(key: string) { setCollapsed(old => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; }); }
  function selection(docs: DomainDocument[], label: string) {
    const eligible = docs.filter(doc => domainDocumentHasChanges(job, doc));
    if (!onSelections) return null;
    return <input type="checkbox" aria-label={`批量选择发布 ${label}`} disabled={disabled || !eligible.length}
      checked={!!eligible.length && eligible.every(doc => doc.selected)} ref={node => { if (node) node.indeterminate = eligible.some(doc => doc.selected) && !eligible.every(doc => doc.selected); }}
      onChange={event => onSelections(eligible.map(doc => doc.id), event.target.checked)} />;
  }
  function directory(key: string, label: string, docs: DomainDocument[], children: () => ReactNode): ReactNode {
    const open = !!needle || !collapsed.has(key);
    return <li key={key} className="list-none"><div className="flex items-center gap-1">{selection(docs, label)}<button className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted" aria-expanded={open} title={label} onClick={() => toggle(key)}>
      {open ? <ChevronDown size={14} className="shrink-0" /> : <ChevronRight size={14} className="shrink-0" />}<Folder size={15} className="shrink-0" /><span className="truncate font-medium">{label}</span><small className="ml-auto text-muted-foreground">{docs.length}</small>
    </button></div>{open && <ul className="m-0 ml-3 list-none border-l border-line p-0 pl-2">{children()}</ul>}</li>;
  }
  function tree(docs: DomainDocument[], depth: number, parent: string): ReactNode {
    // 所有文件共用的目录前缀不重复占用一层缩进，完整路径保留在文件提示中。
    while (docs.length && docs.every(d=>d.path.split("/").length>depth+1) && new Set(docs.map(d=>d.path.split("/")[depth])).size===1) depth++;
    const folders = [...new Set(docs.filter(d => d.path.split("/").length > depth + 1).map(d => d.path.split("/")[depth]))].sort();
    return <>{folders.map(folder => directory(`${parent}/${folder}`, folder, docs.filter(d => d.path.split("/")[depth] === folder), () => tree(docs.filter(d => d.path.split("/")[depth] === folder), depth + 1, `${parent}/${folder}`)))}
      {docs.filter(d => d.path.split("/").length === depth + 1).map(doc => <li key={doc.id} className="flex min-w-0 list-none items-center gap-1 py-1">
        <input type="checkbox" aria-label={`${doc.deleted ? "确认删除" : "发布"} ${doc.path}`} checked={doc.selected && domainDocumentHasChanges(job, doc)} disabled={disabled || !domainDocumentHasChanges(job, doc)} onChange={e => onSelection(doc.id, e.target.checked)} />
        <button className={`flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-2 text-left text-sm ${currentId === doc.id ? "bg-primary/10 text-primary" : "hover:bg-muted"}`} title={`${doc.path} · ${doc.title}`} aria-current={currentId === doc.id ? "page" : undefined} onClick={() => onNavigate(doc.id)}><FileText size={15} className="shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate">{doc.path.split("/").at(-1)}</span><small className={`block text-xs ${domainDocumentHasChanges(job, doc) ? "text-amber-700" : "text-muted-foreground"}`}>{job.production?.documents.find(item => item.id === doc.id)?.status_label}</small></span></button>
      </li>)}</>;
  }
  const visible = domainReviewDocuments(job).filter(doc => !needle || `${targets.find(t => t.id === doc.target_id)?.name} ${doc.path} ${doc.title}`.toLocaleLowerCase().includes(needle)).sort((a, b) => a.path.localeCompare(b.path));
  const workDocuments = (job.work_documents ?? []).filter(document => !needle || document.title.toLocaleLowerCase().includes(needle));
  return <aside className="research-capabilities" aria-label="领域知识文件导航">
    <div className="research-capabilities-header"><strong>文件 <span>{job.documents.length + (job.work_documents?.length ?? 0)}</span></strong>
      {!!job.documents.length && <label className="my-2 flex items-center gap-2 text-xs text-muted-foreground">{selection(job.documents, "全部变化文稿")}选择全部变化文稿 <span>{job.documents.filter(doc => domainDocumentHasChanges(job, doc)).length}</span></label>}
      <div className="research-capability-search"><Search size={16} /><Input aria-label="搜索知识文件" placeholder="搜索文件…" value={query} onChange={e => setQuery(e.target.value)} /></div>
    </div>
    <nav className="research-capability-list" aria-label="知识仓库与文件">{!!workDocuments.length && <div className="p-2"><strong className="px-2 text-xs text-muted-foreground">过程文稿</strong><ul className="m-0 list-none p-0">{workDocuments.map(document => <li key={`${document.turn_id}:${document.id}`}><button className={`flex w-full min-w-0 items-center gap-2 rounded px-2 py-2 text-left text-sm ${currentWorkId === `${document.turn_id}:${document.id}` ? "bg-primary/10 text-primary" : "hover:bg-muted"}`} aria-current={currentWorkId === `${document.turn_id}:${document.id}` ? "page" : undefined} onClick={() => onWorkNavigate?.(document.turn_id, document.id)}><FileText size={15} className="shrink-0" /><span className="min-w-0 break-words">{document.title}</span></button></li>)}</ul></div>}<ul className="m-0 list-none space-y-2 p-2">{targets.map(target => {
      const docs = visible.filter(doc => doc.target_id === target.id);
      return docs.length ? directory(target.id, target.name || "知识仓", docs, () => tree(docs, 0, target.id)) : null;
    })}</ul>{!visible.length && !workDocuments.length && <p className="p-3 text-sm text-muted-foreground">{needle ? "没有匹配的文件" : "生成的文件会显示在这里"}</p>}</nav>
  </aside>;
}
