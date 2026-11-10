import { useState, type ReactNode } from "react";
import { FileText, Search } from "lucide-react";
import { Input } from "@/components/ui/input";

export interface KnowledgeOutlineItem { id: string; title: string; content: string; selected?: boolean; status?: string }
export function KnowledgeOutline({ title, items, currentId, onNavigate, onSelection, disabled, selectionPrefix = "纳入", actions, label = "知识结构导航", itemLabel = "文档", itemUnit = "份" }: {
  title: string; items: KnowledgeOutlineItem[]; currentId?: string; onNavigate: (id: string, line?: number) => void;
  onSelection?: (id: string, selected: boolean) => void; disabled?: boolean; selectionPrefix?: string;
  actions?: ReactNode; label?: string;
  itemLabel?: string; itemUnit?: string;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase();
  const visible = items.filter(item => !needle || item.title.toLocaleLowerCase().includes(needle));
  return <aside className="research-capabilities knowledge-outline" aria-label={label}>
    <div className="research-capabilities-header"><strong>{itemLabel} <span>{items.length} {itemUnit}</span></strong><p className="knowledge-outline-root">{title}</p>
      <div className="research-capability-search"><Search size={16} /><Input aria-label={`搜索${itemLabel}`} placeholder={`搜索${itemLabel}`} value={query} onChange={e => setQuery(e.target.value)} /></div>
      {actions && <div className="research-selection-actions">{actions}</div>}
    </div>
    <nav className="research-capability-list" aria-label="知识文档列表"><ul className="knowledge-outline-topics">{visible.map(item => {
      return <li key={item.id} className={item.id === currentId ? "is-current" : ""}>
        <div className="knowledge-outline-topic"><FileText size={16} className="shrink-0 text-muted-foreground" />
          {onSelection && <input type="checkbox" aria-label={`${selectionPrefix} ${item.title}`} checked={item.selected} disabled={disabled} onChange={e => onSelection(item.id, e.target.checked)} />}
          <button className="knowledge-outline-title" aria-current={item.id === currentId ? "page" : undefined} onClick={() => onNavigate(item.id)}><strong>{item.title}</strong>{item.status && <small>{item.status}</small>}</button>
        </div>
      </li>;
    })}</ul>{!visible.length && <p className="p-3 text-sm text-muted-foreground">{items.length ? `没有匹配的${itemLabel}。` : "萃取结果会逐步出现在这里。"}</p>}</nav>
  </aside>;
}
