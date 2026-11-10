import { useEffect, useRef, useState } from "react";
import { componentRequest } from "./componentResearchApi";
import { useResearchResource } from "./useResearchResource";
import type { ResearchEvidencePage } from "../../src/knowledgeResearchEvidence";
import { Button } from "@/components/ui/button";
import { Markdown } from "./markdown";

type Evidence = Record<string, unknown>;
const actions: Record<string, string> = { list: "浏览目录", tree: "浏览目录", read: "读取文件", search: "搜索源码", kw: "搜索跨仓调用", nls: "查找相关代码", knowledge_search: "查询无线豆包" };
const failed = (event: Evidence) => !!event.error || ["failed", "error"].includes(String(event.status));
const text = (value: unknown) => value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
function summary(event: Evidence) {
  const query = event.query && typeof event.query === "object" ? (event.query as Evidence).question : event.query;
  const context = text(query || (Array.isArray(event.keywords) ? event.keywords.join("、") : "") || event.path || (event.action === "list" ? "仓库根目录" : event.preview));
  return text(event.error || context || "查看详细记录").replace(/[#*`]/g, "").replace(/\s+/g, " ").slice(0, 180);
}

function ResearchProgressEntry({ event: summaryEvent, endpoint }: { event: Evidence; endpoint?: string }) {
  const [expanded, setExpanded] = useState(false), [rawExpanded, setRawExpanded] = useState(false);
  const detail = useResearchResource<Evidence>(expanded ? endpoint : undefined);
  const event = endpoint ? detail.value ?? summaryEvent : summaryEvent;
  const error = failed(event), timestamp = typeof event.at === "string" ? new Date(event.at) : undefined;
  const action = event.tool === "research_note" ? "分析与整理" : event.tool === "knowledge_source_changes" ? "核对来源变化" : actions[String(event.action)] ?? "研究进展";
  return <details className="knowledge-progress-entry" onToggle={e => { if (e.target === e.currentTarget) { setExpanded(e.currentTarget.open); if (!e.currentTarget.open) setRawExpanded(false); } }}><summary>
    {timestamp && !Number.isNaN(timestamp.getTime()) && <time dateTime={String(event.at)}>{timestamp.toLocaleTimeString("zh-CN", { hour12: false })}</time>}
    <span className={`knowledge-progress-dot${error ? " is-error" : ""}`} /><span className="knowledge-progress-action">{action}</span><span className="knowledge-progress-summary" title={summary(event)}>{summary(event)}</span>
    {error ? <span className="knowledge-progress-error">异常</span> : event.status === "empty" ? <span className="text-muted-foreground">无结果</span> : null}
  </summary>{expanded && <div className="knowledge-progress-detail">
    {endpoint && !detail.value && <p role="status">{detail.error ?? "正在读取记录…"}</p>}
    {event.path != null && <p className="break-all text-muted-foreground">文件：{text(event.path)}</p>}{event.repository != null && <p className="break-all text-muted-foreground">仓库：{text(event.repository)}</p>}{event.error != null && <p className="text-danger whitespace-pre-wrap">{text(event.error)}</p>}
    {(!endpoint || detail.value) && event.preview != null && (event.tool === "research_note" ? <Markdown text={text(event.preview)} /> : <pre>{text(event.preview)}</pre>)}
    {event.result != null && <pre>{text(event.result)}</pre>}
    {(!endpoint || detail.value) && <details className="mt-3 text-sm text-muted-foreground" onToggle={e => { if (e.target === e.currentTarget) setRawExpanded(e.currentTarget.open); }}><summary className="cursor-pointer">完整记录</summary>{rawExpanded && <pre>{JSON.stringify(event, null, 2)}</pre>}</details>}
  </div>}</details>;
}

export function KnowledgeResearchProgress({ evidence, endpoint }: { evidence: Evidence[]; endpoint?: string }) {
  return endpoint ? <RemoteResearchProgress key={endpoint} endpoint={endpoint} /> : <ResearchProgress evidence={evidence} />;
}

function RemoteResearchProgress({ endpoint }: { endpoint: string }) {
  const [page, setPage] = useState<ResearchEvidencePage>(), [error, setError] = useState("");
  const loading = useRef(false);
  const visibleCount = useRef(40);
  const controller = useRef<AbortController | null>(null);
  async function load(before?: number) {
    if (loading.current || !controller.current) return;
    const signal = controller.current.signal;
    loading.current = true;
    try {
      const next = await componentRequest<ResearchEvidencePage>(endpoint + (before === undefined ? "" : `?before=${before}`), undefined,
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
      if (signal.aborted) return;
      if (before !== undefined) visibleCount.current += next.entries.length;
      setPage(previous => {
        if (!previous || before === undefined && (next.entries.at(-1)?.index ?? -1) > (previous.entries[0]?.index ?? -1) + 1) return next;
        const entries = [...new Map([...previous.entries, ...next.entries].map(entry => [entry.index, entry])).values()]
          .sort((a, b) => b.index - a.index).slice(0, visibleCount.current);
        return { total: next.total, errors: next.errors, entries, before: entries.at(-1)?.index || undefined };
      });
      setError("");
    } catch (error) { if (!signal.aborted) setError((error as Error).message); }
    finally { loading.current = false; }
  }
  useEffect(() => {
    controller.current = new AbortController(); void load();
    const timer = setInterval(() => void load(), 4000);
    return () => { controller.current?.abort(); clearInterval(timer); };
  }, [endpoint]);
  if (!page) return <p role="status">{error || "正在读取研究动态…"}</p>;
  return <>{error && <p role="alert" className="text-danger">{error}</p>}<ResearchProgress evidence={[]} remote={{ page, endpoint, earlier: () => void load(page.before) }} /></>;
}

function ResearchProgress({ evidence, remote }: { evidence: Evidence[]; remote?: { page: ResearchEvidencePage; endpoint: string; earlier: () => void } }) {
  const root = useRef<HTMLElement>(null);
  const [limit, setLimit] = useState(40);
  // 后台按发生顺序追加；无时间戳的旧记录也保留在原来的位置。
  const entries = remote?.page.entries ?? evidence.map((event, index) => ({ event, index }));
  const visible = remote ? entries : entries.slice(-limit).reverse(), errors = remote?.page.errors ?? evidence.filter(failed).length;
  const total = remote?.page.total ?? evidence.length;
  return <section ref={root} className="knowledge-progress" aria-label="研究过程记录">
    <header className="knowledge-progress-toolbar"><div><strong>研究动态 <span className="text-muted-foreground font-normal">· {total} 条</span></strong><p className="mt-1 text-sm text-muted-foreground">最新动态在前，展开查看详情{errors > 0 && <span className="knowledge-progress-error"> · {errors} 条异常</span>}</p></div>
      {total > 0 && <Button variant="ghost" size="sm" onClick={() => root.current?.querySelectorAll("details[open]").forEach(node => { (node as HTMLDetailsElement).open = false; })}>全部折叠</Button>}
    </header>
    {!total ? <p className="knowledge-progress-empty">还没有研究动态；Agent 每读一份源码或资料、每完成一步，都会在这里记一条。</p> : <div className="knowledge-progress-entries">
      <ol>{visible.map(({ event, index }) => <li key={index}><ResearchProgressEntry event={event} endpoint={remote && `${remote.endpoint}/${index}`} /></li>)}</ol>
      {(remote ? remote.page.before !== undefined : entries.length > limit) && <Button variant="ghost" size="sm" className="m-3" onClick={remote ? remote.earlier : () => setLimit(current => current + 40)}>查看更早的 {Math.min(40, remote ? remote.page.before! : entries.length - limit)} 条动态</Button>}
    </div>}
  </section>;
}
