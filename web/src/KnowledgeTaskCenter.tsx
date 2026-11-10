import { useEffect, useRef, useState } from "react";
import { CheckCircle2Icon, ChevronRightIcon, CircleDotIcon, Clock3Icon, LightbulbIcon, ListChecksIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { PersonName } from "./People";
import { formatLocalDateTime, relativeTime } from "./time";
import { getKnowledgeTasks, knowledgeTaskElapsed, knowledgeTaskAction, type KnowledgeTaskCenterData, type KnowledgeTaskGroup, type KnowledgeTaskKind, type KnowledgeTaskRow, type KnowledgeTaskSummary } from "./knowledgeTaskCenterApi";
import type { KnowledgeProductionAction } from "../../src/knowledgeProductionTypes";

export type { KnowledgeTaskCenterData, KnowledgeTaskKind, KnowledgeTaskSummary } from "./knowledgeTaskCenterApi";

const kindLabels: Record<KnowledgeTaskKind, string> = {
  domain: "领域萃取", component: "组件萃取", "skill-extraction": "Skill 制作", "skill-submission": "Skill 导入",
};
const taskKindLabel = (task: KnowledgeTaskRow) => task.kind === "domain" && task.task_kind === "inspection" ? "知识检视" : kindLabels[task.kind];
const tabs: Array<{ key: KnowledgeTaskGroup | "current"; label: string }> = [
  { key: "current", label: "当前任务" }, { key: "running", label: "进行中" },
  { key: "attention", label: "待处理" }, { key: "completed", label: "已完成" },
];

export function KnowledgeTaskCapsule({ summary, onClick, active = false }: {
  summary?: KnowledgeTaskSummary | null; onClick: () => void; active?: boolean;
}) {
  return <button type="button" className={`knowledge-task-capsule${summary?.running ? " is-running" : ""}${active ? " is-active" : ""}`} onClick={onClick} aria-pressed={active} aria-label={`知识任务中心${summary ? `，${summary.running} 项进行中，${summary.attention} 项待处理` : ""}`}>
    <span className="knowledge-task-emblem" aria-hidden="true"><span className="knowledge-task-orbit" /><ListChecksIcon size={18} /></span>
    <span className="knowledge-task-caption"><strong>知识任务</strong><span className="knowledge-task-summary">{summary ? <><span className="knowledge-task-capsule-running">进行中 <b>{summary.running}</b></span><span className={`knowledge-task-capsule-attention${summary.attention ? " has-attention" : ""}`}>待处理 <b>{summary.attention}</b></span></> : <span>查看研究与审查进度</span>}</span></span>
    <ChevronRightIcon size={16} className="knowledge-task-chevron" aria-hidden="true" />
  </button>;
}

/** 与知识任务卡同款：经验没有"进行中"，只报已采纳与待确认；读不到时只说入口用途，不显示 0 冒充事实。 */
export function KnowledgeExperienceCapsule({ counts, onClick, active = false }: {
  counts?: { pending: number; accepted: number } | null; onClick: () => void; active?: boolean;
}) {
  return <button type="button" className={`knowledge-task-capsule${active ? " is-active" : ""}`} onClick={onClick} aria-pressed={active} aria-label={`团队经验${counts ? `，${counts.accepted} 条已采纳，${counts.pending} 条待确认` : ""}`}>
    <span className="knowledge-task-emblem" aria-hidden="true"><span className="knowledge-task-orbit" /><LightbulbIcon size={18} /></span>
    <span className="knowledge-task-caption"><strong>团队经验</strong><span className="knowledge-task-summary">{counts ? <><span>已采纳 <b>{counts.accepted}</b></span><span className={`knowledge-task-capsule-attention${counts.pending ? " has-attention" : ""}`}>待确认 <b>{counts.pending}</b></span></> : <span>交付中沉淀的做法</span>}</span></span>
    <ChevronRightIcon size={16} className="knowledge-task-chevron" aria-hidden="true" />
  </button>;
}

function TaskRow({ task, now, onOpen }: { task: KnowledgeTaskRow; now: number; onOpen: (kind: KnowledgeTaskKind, id: string, action: KnowledgeProductionAction) => void }) {
  const elapsed = knowledgeTaskElapsed(task, now);
  const time = task.started_at;
  return <button type="button" className="knowledge-task-row" onClick={() => onOpen(task.kind, task.id, knowledgeTaskAction(task))} title={task.next_action.label} aria-label={`${task.next_action.label}，打开${taskKindLabel(task)}：${task.title}`}>
    <div className="knowledge-task-main">
      <div className="knowledge-task-title" title={task.title}>{task.title}</div>
      <div className="knowledge-task-meta"><span>{taskKindLabel(task)}</span>{task.scope && <span title={task.scope}>{task.scope}</span>}</div>
    </div>
    <div><span className={`knowledge-task-status is-${task.group}`}>{task.status_label}</span></div>
    <div className="knowledge-task-person"><PersonName account={task.operator} fallback="—" /></div>
    <div className="knowledge-task-time" title={task.created_at ? `创建于 ${formatLocalDateTime(task.created_at, { seconds: true, year: true })}` : undefined}>
      {time ? <time dateTime={time}>{formatLocalDateTime(time)}</time> : <span>—</span>}
      {task.created_at && <small>创建 {formatLocalDateTime(task.created_at)}</small>}
    </div>
    <div className="knowledge-task-duration" title={elapsed === "—" ? "未记录完整执行时间；不把排队和审核等待算作运行时长" : "从实际开始到结束的历时"}>{elapsed}</div>
    <div className="knowledge-task-note">
      {task.latest_note ? <>
        <p title={task.latest_note.text}>{task.latest_note.text}</p>
        <small>公开研究动态{task.latest_note.at && <> · <time dateTime={task.latest_note.at} title={formatLocalDateTime(task.latest_note.at, { seconds: true })}>{relativeTime(task.latest_note.at, now)}</time></>}</small>
      </> : <><p className="is-muted">暂无公开研究动态</p>{task.stage && <small title={task.stage}>{task.stage}</small>}</>}
      {task.error && <small className="knowledge-task-error" title={task.error}>{task.error}</small>}
    </div>
    <span className="knowledge-task-open">{task.next_action.label}<ChevronRightIcon size={14} aria-hidden /></span>
  </button>;
}

export function KnowledgeTaskCenter({ onOpen, onBack, data, onSummaryChange }: {
  onOpen: (kind: KnowledgeTaskKind, id: string, action: KnowledgeProductionAction) => void;
  onBack: () => void;
  /** 传入数据时由外层统一刷新；null 表示正在加载。 */
  data?: KnowledgeTaskCenterData | null;
  onSummaryChange?: (summary: KnowledgeTaskSummary) => void;
}) {
  const controlled = data !== undefined;
  const [loaded, setLoaded] = useState<KnowledgeTaskCenterData | null>(null);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [filter, setFilter] = useState<KnowledgeTaskGroup | "current">("current");
  const [query, setQuery] = useState("");
  const [pageIndex, setPageIndex] = useState(0);
  const [now, setNow] = useState(Date.now());
  const summaryCallback = useRef(onSummaryChange);
  summaryCallback.current = onSummaryChange;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (controlled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const load = async () => {
      try {
        const next = await getKnowledgeTasks(controller.signal);
        if (!stopped) { setLoaded(next); setError(""); }
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : "知识任务暂时无法加载");
      } finally {
        if (!stopped) timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [controlled, refresh]);
  const current = controlled ? data : loaded;
  useEffect(() => { if (current) summaryCallback.current?.(current.summary); }, [current]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = current?.tasks.filter(task => (filter === "current" ? task.group !== "completed" : task.group === filter)
    && (!needle || [task.title, task.operator, task.scope, taskKindLabel(task)].some(value => value?.toLocaleLowerCase().includes(needle)))) ?? [];
  const counts = { current: current ? current.summary.running + current.summary.attention : 0, running: current?.summary.running ?? 0,
    attention: current?.summary.attention ?? 0, completed: current?.tasks.filter(task => task.group === "completed").length ?? 0 };
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const shownPage = Math.min(pageIndex, pageCount - 1), pageTasks = visible.slice(shownPage * pageSize, (shownPage + 1) * pageSize);

  return <section className="knowledge-task-center" aria-label="知识任务中心">
    <header className="knowledge-task-heading"><div><div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} /><h2>知识任务中心</h2></div><p>跟进萃取、知识检视、Skill 制作和导入，打开任务继续研究或修改文稿。</p></div>
      <div className="knowledge-task-totals" aria-label="知识任务统计"><span className="is-running"><CircleDotIcon size={18} /><span>进行中</span><strong>{counts.running}</strong></span><span className="is-attention"><Clock3Icon size={18} /><span>待处理</span><strong>{counts.attention}</strong></span><span className="is-completed"><CheckCircle2Icon size={18} /><span>已完成</span><strong>{counts.completed}</strong></span></div>
    </header>
    <div className="knowledge-task-toolbar"><div className="knowledge-task-tabs" role="group" aria-label="按任务状态筛选">{tabs.map(tab => <button type="button" key={tab.key} onClick={() => { setFilter(tab.key); setPageIndex(0); }} className={filter === tab.key ? "is-active" : ""} aria-pressed={filter === tab.key}>{tab.label}<span>{counts[tab.key]}</span></button>)}</div>
      <label className="knowledge-task-search"><SearchIcon size={15} /><input aria-label="搜索知识任务" placeholder="搜索任务、归属或操作人" value={query} onChange={event => { setQuery(event.target.value); setPageIndex(0); }} /></label>
      {!controlled && <Button variant="ghost" size="sm" onClick={() => setRefresh(value => value + 1)} title="刷新任务"><RefreshCwIcon size={15} /></Button>}
    </div>
    {error && <div className="knowledge-task-warning" role="status">{error}{current ? "。当前保留上次加载的数据。" : ""}</div>}
    <div className="knowledge-task-table">
      <div className="knowledge-task-columns" aria-hidden="true"><span>任务 / 归属</span><span>状态</span><span>发起 / 操作人</span><span>开始时间</span><span>运行时长</span><span>最近公开研究动态</span><span /></div>
      {!current && !error ? <div className="knowledge-task-empty">正在加载知识任务…</div>
        : !visible.length ? <div className="knowledge-task-empty">{query || filter !== "current" ? "没有符合条件的任务" : counts.completed ? "当前没有需要跟进的任务，可在“已完成”中查看历史记录。" : "还没有知识任务。新建萃取或导入 Skill 后可在这里跟进。"}</div>
          : pageTasks.map(task => <TaskRow key={`${task.kind}:${task.id}`} task={task} now={now} onOpen={onOpen} />)}
    </div>
    {pageCount > 1 && <nav className="knowledge-task-pagination" aria-label="知识任务分页"><span>共 {visible.length} 项，每页 {pageSize} 项</span><div><Button variant="outline" disabled={shownPage === 0} onClick={() => setPageIndex(shownPage - 1)}>上一页</Button><span>{shownPage + 1} / {pageCount}</span><Button variant="outline" disabled={shownPage + 1 >= pageCount} onClick={() => setPageIndex(shownPage + 1)}>下一页</Button></div></nav>}
    <p className="knowledge-task-footnote">完成的任务自动收进“已完成”，文稿与 MR 记录继续保留。运行时长不含排队和审查等待。</p>
  </section>;
}
