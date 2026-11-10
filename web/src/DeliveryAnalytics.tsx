import { useTechnologyStacks } from "./useTechnologyStacks";
import { CompletionDateFilter, completionDateRange, type CompletionDates } from "./CompletionDateFilter";
import { completedInRange } from "../../src/completionRange";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { BarChart3, ChevronDown, ChevronRight, ExternalLink, HelpCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { knowledgeLanguageLabel } from "./KnowledgeLanguages";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import type { CodeOrigin, DeliveryAnalysisReport, DeliveryAnalysisRow, DeliveryTaskTokens } from "../../src/deliveryAnalyticsTypes";
import { KnowledgeInsightsPanel } from "./KnowledgeFlywheel";
import { aggregateDelivery, aggregateDeliveryModules, aggregateDeliveryTokens } from "../../src/deliveryAnalyticsSummary";
import { cn } from "cn";
import { getBusinessModules, getIssueOnceGenerated, listPeople, type BusinessModuleCatalog, type IssueOnceGenerated, type IssueOnceGeneratedSessionRow, type PersonIdentity } from "./api";
import { cancelReasonLabel, isNegativeCancelReason } from "./issues/cancelReasons";
import { getIssueRegistrationStats, type IssueRegistrationGroupRow, type IssueRegistrationSessionRow, type IssueRegistrationStats } from "./api";
import { TicketTemplateCard } from "./issues/TicketTemplateCard";
import { featureRepoTree, onceGeneratedFeatureRows, type FeatureRepoRow, type OnceGeneratedFeatureRow } from "./teamOps";
import { IssueCodeOriginPanel } from "./issues/CodeOriginPanel";
import { FinalMrComparison } from "./FinalMrComparison";
import { DeliveryImprovement, ImprovementPolicyControl } from "./DeliveryImprovement";
import { displayPersonName } from "./AnnotationPanel";
import { HeaderEnumFilter, HeaderFilter, SortMark } from "./HeaderFilter";
import { repoIdentity, repoShortName } from "./repoIdentity";

/** 表头排序状态:key=列键,dir=-1 降序优先(统计直觉:先看最大)。 */
type SortState = { key: string; dir: 1 | -1 } | null;

/** 三态循环:换列→降序;同列 降→升→取消(回到该表默认排序)。 */
const cycleSort = (current: SortState, key: string): SortState =>
  current?.key !== key ? { key, dir: -1 }
    : current.dir === -1 ? { key, dir: 1 }
      : null;

/** 通用比较:null(—)恒沉底;字符串按中文序;数值乘方向。 */
const compareBy = <T,>(value: (row: T) => string | number | null, dir: 1 | -1) =>
  (a: T, b: T): number => {
    const va = value(a);
    const vb = value(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    if (typeof va === "string" || typeof vb === "string") {
      return String(va).localeCompare(String(vb), "zh-Hans-CN") * dir;
    }
    return (Number(va) - Number(vb)) * dir;
  };

/** 可排序表头:文字+箭头可点(三态循环),filter 槽放列头漏斗;
 *  className 透传给 th(如给首列托底最小宽,防止被挤到一字一行)。 */
function SortableTh({ label, sortKey, sort, onCycle, filter, className }: {
  label: string;
  sortKey: string;
  sort: SortState;
  onCycle: (key: string) => void;
  filter?: ReactNode;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  return <th className={className}><span className="inline-flex items-center gap-1">
    <button type="button" title="点击排序(降→升→默认)"
      className="inline-flex items-center gap-1 hover:text-text-strong"
      onClick={() => onCycle(sortKey)}>
      {label}
      <SortMark active={active} dir={active ? sort!.dir : undefined} />
    </button>
    {filter}
  </span></th>;
}

/** 特性行排序取值:键=列键;率列空值(—)沉底。 */
const featureSortValue = (row: OnceGeneratedFeatureRow, key: string): string | number | null =>
  key === "name" ? row.module
  : key === "sessions" ? row.sessions
  : key === "lines" ? row.total_lines
  : key === "solved" ? row.solved_rate
  : key === "localization" ? row.localization_rate
  : key === "verify" ? row.verify_rate
  : row.share;

/** 仓行排序取值:三率的分母=该仓 ok 会话数(sessions)。 */
const repoSortValue = (entry: FeatureRepoRow, key: string): string | number | null =>
  key === "name" ? entry.repo
  : key === "sessions" ? entry.sessions
  : key === "lines" ? entry.total
  : key === "solved" || key === "localization" || key === "verify"
    ? (entry.sessions
      ? (key === "solved" ? entry.solved
        : key === "localization" ? entry.localization_passed
        : entry.verify_passed) / entry.sessions
      : null)
  : entry.share;

/** 按会话行排序取值:终止行无判定事实(定位/验证/占比/行数)以 — 沉底,
 *  一次解决照展示口径记失败(0)。 */
const sessionSortValue = (row: IssueOnceGeneratedSessionRow, key: string): string | number | null => {
  const canceled = row.state === "canceled";
  switch (key) {
    case "name": return row.id;
    case "module": return row.module;
    case "repo": return row.by_repo?.[0]?.repo ?? null;
    case "solved": return canceled || !row.solved_pass ? 0 : 1;
    case "localization": return canceled ? null : row.localization_pass ? 1 : 0;
    case "verify": return canceled ? null : row.verify_pass ? 1 : 0;
    case "share": return row.share ?? null;
    case "lines": return row.lines
      ? row.lines.first + row.lines.rework + row.lines.external
      : null;
    case "reporter": return row.reporter ?? null;
    case "concluded": return row.concluded_at;
    case "terminate": return row.cancel_reason ?? null;
    default: return null;
  }
};

/** 登记问题聚合行(按模块/按登记人同构)排序取值。 */
const regGroupSortValue = (row: IssueRegistrationGroupRow, key: string): string | number | null =>
  key === "name" ? row.key
  : key === "total" ? row.total
  : key === "non_issue" ? row.non_issue
  : key === "issue_confirmed" ? row.issue_confirmed
  : row.localization_rate;

/** 登记问题按会话行排序取值。 */
const regSessionSortValue = (row: IssueRegistrationSessionRow, key: string): string | number | null =>
  key === "name" ? row.id
  : key === "module" ? row.module
  : key === "reporter" ? row.reporter
  : key === "account" ? row.account
  : key === "conclusion" ? (row.conclusion === "issue" ? "确认是问题" : "非问题")
  : key === "versions" ? row.report_version_count
  : key === "localization" ? (row.localization_pass ? 1 : 0)
  : row.concluded_at;

/** 列头枚举漏斗的选项:去重 → 中文排序 → {value,label} 同形。 */
const enumOptions = (values: Iterable<string>) => [...new Set(values)]
  .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
  .map((name) => ({ value: name, label: name }));

/** 会话列头的关键字漏斗(两页签同款;激活与过滤同用 trim 值,纯空格
 *  不算激活也不吞行)。 */
function KeywordHeaderFilter({ label, placeholder, value, onChange }: {
  label: string; placeholder: string; value: string; onChange: (value: string) => void;
}) {
  return <HeaderFilter label={label} active={!!value.trim()} onClear={() => onChange("")}>
    {() => <Input autoFocus className="h-8 w-full rounded-md px-2 text-sm"
      placeholder={placeholder} aria-label={`按${label}过滤`} value={value}
      onChange={(event) => onChange(event.target.value)} />}
  </HeaderFilter>;
}

/** 首做/返工/平台外工作行三分类的贯穿色:需求交付(交付代码来源)与
 *  DTS(生成工作行来源)两环同色系,调色单点在这里。 */
const donutColors = { first: "#0d9488", rework: "#8b5cf6", external: "#d97706" } as const;
const categories: Array<{ key: CodeOrigin; label: string; color: string }> = [
  { key: "first", label: "首次实现", color: donutColors.first },
  { key: "pipeline", label: "流水线修复", color: donutColors.rework },
  { key: "review", label: "检视修改", color: donutColors.external },
];
/** DTS 生成工作行三分类环的切片(2026-10-20 指标收敛,见 IssueAnalyticsTab 注)。 */
const worklineSlices = (lines: { first: number; rework: number; external: number }) => [
  { label: "首轮", color: donutColors.first, value: lines.first },
  { label: "返工", color: donutColors.rework, value: lines.rework },
  { label: "平台外", color: donutColors.external, value: lines.external },
];
const num = (value: number) => value.toLocaleString("zh-CN");
const percent = (value: number | null) => value === null ? "—" : `${value.toFixed(1)}%`;
function AnalysisFilter({ label, value, onChange, items }: {
  label: string; value: string; onChange: (value: string) => void;
  items: Array<{ value: string; label: string }>;
}) {
  return <div className="flex min-w-0 items-center gap-2"><span>{label}</span>
    <Select value={value} onValueChange={next => { if (next !== null) onChange(next); }} items={items}>
      <SelectTrigger aria-label={label} className="min-w-36 max-w-72"><SelectValue /></SelectTrigger>
      <SelectContent>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

function sumLineKinds(stats: IssueOnceGenerated | undefined): { first: number; rework: number; external: number; total: number } {
  let first = 0, rework = 0, external = 0;
  for (const row of stats?.per_session ?? []) {
    first += row.lines?.first ?? 0;
    rework += row.lines?.rework ?? 0;
    external += row.lines?.external ?? 0;
  }
  return { first, rework, external, total: first + rework + external };
}
function weightedShare(stats: IssueOnceGenerated | undefined): number | null {
  const { first, total } = sumLineKinds(stats);
  return total ? Math.round((first / total) * 1000) / 10 : null;
}

function Donut({ slices, unit, centerValue, centerLabel, ariaLabel, known = true }: {
  slices: Array<{ label: string; color: string; value: number }>;
  unit: string; centerValue: string; centerLabel: string; ariaLabel: string; known?: boolean;
}) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  let offset = 0;
  return <div className="delivery-donut-wrap"><div className="delivery-donut">
    <svg viewBox="0 0 200 200" role="img" aria-label={ariaLabel}>
      <circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" strokeWidth="22" />
      {slices.map(s => { const size = total ? s.value / total * 100 : 0, start = offset; offset += size;
        return <circle key={s.label} cx="100" cy="100" r="78" fill="none" stroke={s.color} strokeWidth="22" pathLength="100"
          style={{ strokeLinecap: "butt" }} strokeDasharray={`${size} ${100 - size}`} strokeDashoffset={-start} transform="rotate(-90 100 100)"><title>{s.label}：{known ? `${num(s.value)} ${unit}` : "暂无数据"}</title></circle>; })}
    </svg><div className="delivery-donut-center"><strong>{centerValue}</strong><span>{centerLabel}</span></div>
  </div><div className="delivery-legend">{slices.map(s => <div key={s.label}><i style={{ background: s.color }} /><span>{s.label}</span><b>{known ? `${num(s.value)} ${unit}` : "—"}</b><small>{percent(total ? s.value / total * 100 : null)}</small></div>)}</div></div>;
}
type DeliverySummary = ReturnType<typeof aggregateDelivery>;
function deliveryLines(summary: DeliverySummary) {
  return summary.codeAvailable ? `${num(summary.codeLines)} 行` : "—";
}
function DeliverySources({ summary }: { summary: DeliverySummary }) {
  const share = percent(summary.firstPercent);
  const coverage = summary.total ? `占比按已追溯的 ${num(summary.total)} 行计算。`
    : summary.available ? "可追溯的交付为 0 行，无法计算占比。" : "来源暂不可统计。";
  return <section className="delivery-card" aria-label="交付代码来源">
    <h2>交付代码来源 <span>交付代码行数 {deliveryLines(summary)}</span></h2>
    <Donut unit="行" centerValue={share} centerLabel="首次实现占比" known={summary.available > 0}
      ariaLabel={summary.available ? `已追溯来源 ${num(summary.total)} 行，首次实现占比 ${share}` : "暂无可追溯的代码来源"}
      slices={categories.map(c => ({ label: c.label, color: c.color, value: summary.retained[c.key] }))} />
    <p className="delivery-muted">已统计行数 {summary.codeAvailable}/{summary.tasks} 次交付，已追溯来源 {summary.available}/{summary.tasks} 次交付。
      {coverage}<br />检视修改包括按意见修改和开发者自查后的调整。</p>
  </section>;
}
const collaborationNote = "这次交付有环节在平台外完成。代码行数和占比按整个最终版本统计，平台外修改的原因需结合提交记录判断。";
function ExternalCollaborationNote() {
  return <div className="flex items-start gap-3 text-sm text-muted-foreground">
    <Badge className="mt-0.5 shrink-0" variant="outline">平台外协作</Badge><span className="min-w-0 leading-relaxed">{collaborationNote}</span>
  </div>;
}
function TaskLanguages({ tasks }: { tasks: DeliveryAnalysisRow[] }) {
  useTechnologyStacks();
  const languages = [...new Set(tasks.flatMap(t => t.languages?.length ? t.languages : ["unknown"]))];
  return <span className="inline-flex flex-wrap gap-1.5" title="任务对应代码仓的技术栈">{languages.map(language =>
    <Badge key={language} variant="secondary" className="h-auto px-2 py-1 text-sm">{language === "unknown" ? "未标注" : knowledgeLanguageLabel(language)}</Badge>)}</span>;
}
function TaskMetricRow({ id, title, tasks, child, parent, onSelect, ledger }: { id: string; title: string; tasks: DeliveryAnalysisRow[]; child?: boolean; parent?: boolean; ledger?: DeliveryTaskTokens[]; onSelect: (id: string) => void }) {
  const values = aggregateDelivery(tasks);
  const tokens = aggregateDeliveryTokens(tasks.map(t => t.id), ledger, parent ? id : undefined);
  const external = parent ? 0 : tasks.filter(row => row.external_collaboration).length;
  return <tr className={child ? "delivery-child-row" : undefined}>
    <td><button className="delivery-task-link" onClick={() => onSelect(id)}><b>{id}</b><span>{title}</span></button></td>
    <td><TaskLanguages tasks={tasks} /></td>
    <td>{parent ? <>已合入交付 {tasks.filter(t => t.merged).length}/{tasks.length}{tasks.some(t => !t.merged) && <small>含未合入暂计</small>}</> : tasks.every(t => t.merged) ? "已合入" : "进行中 · 暂计"}
      {external > 0 && <div className="mt-1"><Badge variant="outline" title={collaborationNote}>{tasks.length > 1 ? `${external}/${tasks.length} 次` : ""}平台外协作</Badge></div>}
    </td>
    <td>{deliveryLines(values)}</td><td className="delivery-accent">{percent(values.firstPercent)}</td>
    <td title={tokens.available ? `已记录输入 ${num(tokens.input)} · 输出 ${num(tokens.output)}` : "没有模型用量记录"}><strong>{tokens.available ? num(tokens.total) : "—"}</strong>{tokens.available < tokens.tasks && <small>{tokens.available ? "部分用量已记录" : "暂无用量记录"}</small>}</td>
    <td>行数 {values.codeAvailable}/{values.tasks}<small>来源 {values.available}/{values.tasks}</small></td>
  </tr>;
}

/** 终止原因中文词表与负面判定(#540 复审)收口到 issues/cancelReasons:
 *  与终止确认框(CancelSessionDialog 下拉)同一份映射、同一个负面
 *  集合,不再各抄一份漂移;未知值 label 走安全回退。 */
function TerminateReasonBadge({ row }: { row: IssueOnceGeneratedSessionRow }) {
  const text = (row.cancel_reason_text ?? "").trim();
  if (!isNegativeCancelReason(row.cancel_reason)) {
    const label = text ? `其他 · ${text}` : "其他";
    return <span
      className="inline-block max-w-[240px] truncate align-bottom rounded-full bg-attention-soft px-2 py-0.5 text-xs font-medium text-attention"
      title={text || undefined}>{label}</span>;
  }
  return <span className="inline-block rounded-full bg-danger-soft px-2 py-0.5 text-xs font-medium text-danger">
    终止 · {cancelReasonLabel(row.cancel_reason)}</span>;
}
/** 终止行详情(#543):终止原因中文文案、「其他原因」完整原文与终止
 *  时刻的只读陈列。终止会话没有工作行事实,行归属证据面板不适用。 */
function TerminateReasonDetail({ row }: { row: IssueOnceGeneratedSessionRow }) {
  const text = (row.cancel_reason_text ?? "").trim();
  return <section className="delivery-card"><h2>终止原因
    <span>{new Date(row.concluded_at).toLocaleString("zh-CN")} 终止</span></h2>
    <p className="mt-3 text-sm">该会话由发起人主动终止,原因:
      <b className={row.cancel_reason === "other" ? "text-attention" : "text-danger"}>
        {cancelReasonLabel(row.cancel_reason)}</b></p>
    {row.cancel_reason === "other" && text
      ? <p className="delivery-muted">说明:{text}</p> : null}
    <p className="delivery-muted">终止会话没有工作行与定位/验证两轴事实,表中相关列以 — 占位;一次解决率分母计入并记未解决。</p>
  </section>;
}

/** DTS 页签(原「问题处理」,ADR-0044,工单 #340):首次生成占比的
 *  每会话明细与特性聚合——读侧与团队问题页统计瓦片同一端点、同一
 *  数字;行点击下钻行归属证据(伴生快照原样)。人群=有单交付会话;
 *  无单会话在「登记问题」页签(ADR-0048)。纯呈现层,不建第二套口径。
 *  2026-10-20 指标收敛(领导拍板):概览只留两图——一次解决率与首次
 *  生成占比(双环,样式与需求交付概览同款);90%AI生成达标率整档退场,
 *  一次定位/一次验证只在按会话表留 ✓/✗ 诊断列;后端端点零改动。
 *  2026-10-21 仓维度并入特性树(ADR-0065):观察维度剩 按特性/按会话
 *  两维,按特性是树状表格——外层特性,展开是该特性会话实际改过的仓
 *  (per_session.by_repo 前端聚合,绑定列表外的仓排序沉底);点特性/
 *  仓名跳按会话并带上对应过滤,跳转所见=刚才所看数字的构成会话;
 *  按会话列头过滤:会话关键字/特性与发起人枚举。
 *  #543:负面原因终止的会话以行进按会话表(一次解决 ✗、无事实列 —、
 *  末列终止原因徽标,点行看原因详情),发起人列显示姓名。
 *  2026-10-21 口径与角色粒度(ADR-0065 修订):特性行会话数/一次解决
 *  率改交付尝试口径(per_session 全部行,与一次解决率环同分母,终止
 *  记未解决);仓行与特性行新增一次定位/验证率(完成交付分母,仓行为
 *  特性∩仓 ok 会话);首轮/返工/平台外合并单列;普通用户=一次解决率
 *  单环 + 树表 3 列,admin=双环 + 7 列(前端按 session.role 判定,
 *  按会话视图不分角色)。
 *  导出仅供视觉走查场景脚本挂载(与需求侧同款做法)。 */

export function IssueAnalyticsTab({ role }: { role?: string }) {
  /** 角色粒度(ADR-0065 修订):普通用户=一次解决率单环 + 树表 3 列;
   *  admin=双环 + 7 列(多定位/验证两率与行数合并列)。按会话视图与
   *  行归属证据不分角色。 */
  const isAdmin = role === "admin";
  const [stats, setStats] = useState<IssueOnceGenerated>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" });
  const [dim, setDim] = useState<"feature" | "session">("feature");
  /** 按会话的过滤组:特性(module,"*"=全部)、代码仓(树点击落下,
   *  不设列头漏斗,以筛选条呈现)、会话关键字、发起人枚举。 */
  const [module, setModule] = useState("*");
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("");
  const [reporter, setReporter] = useState("");
  /** 特性树展开状态:特性名集合,默认全折叠,不记忆。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  /** 表头排序(ADR-0065 修订):三态 降→升→默认;树表内外两层同列
   *  各自排序,取消回到默认序(会话数降序+绑定外沉底/收口时间倒序)。 */
  const [featureSort, setFeatureSort] = useState<SortState>(null);
  const [sessionSort, setSessionSort] = useState<SortState>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // 发起人姓名映射(#543):只是显示增强;读取失败静默退回工号显示,
  // 不 setError、不 busy,不挡表格首屏(先例 TaskWorkspace 同纪律)。
  const [people, setPeople] = useState<PersonIdentity[]>([]);
  useEffect(() => {
    let live = true;
    void listPeople().then((roster) => { if (live) setPeople(roster); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  /** 模块目录只喂仓行排序(绑定外沉底):取不到就当全部绑内,
   *  不影响任何数字。 */
  const [catalog, setCatalog] = useState<BusinessModuleCatalog>();
  useEffect(() => {
    let live = true;
    getBusinessModules().then((value) => { if (live) setCatalog(value); })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    setStats(undefined); setError("");
    if (dates.from && dates.to && dates.from > dates.to) { setBusy(false); return; }
    setBusy(true);
    void getIssueOnceGenerated(undefined, completionDateRange(dates)).then(value => { if (live) setStats(value); })
      .catch(error => { if (live) setError(error instanceof Error ? error.message : "加载失败"); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [dates]);
  // 特性树永远展示全部特性(module 过滤只管按会话表):点特性行的
  // 语义是「跳过去看会话」,不是原地收窄树。
  const allRows = stats?.per_session ?? [];
  const okRows = useMemo(() => allRows
    .filter((row) => row.state === "ok"), [allRows]);
  const shareRows = useMemo(() => okRows.filter((row) => row.share !== undefined) as IssueOnceGeneratedSessionRow[], [okRows]);
  // 特性行=交付尝试口径(per_session 全部行,与一次解决率环同分母);
  // 仓行/行数/占比=ok 事实口径(shareRows)。
  // 「未分类」=ADR-0056 前发起的存量未标注会话,不进树面(按会话的
  // 特性漏斗仍可筛到);环分母含它们,存量流出前树加权与环略有出入。
  const features = useMemo(() => onceGeneratedFeatureRows(allRows)
    .filter((row) => row.module !== "未分类"), [allRows]);
  // 归一后比对(去 .git 尾缀/大小写差异),原样比对会误判绑定外。
  const bindings = useMemo(() => new Map((catalog?.modules ?? [])
    .map((entry) => [entry.name, new Set(entry.repositories.map(repoIdentity))])), [catalog]);
  const tree = useMemo(() => featureRepoTree(shareRows, (feature, repo) =>
    bindings.get(feature)?.has(repoIdentity(repo)) ?? true), [shareRows, bindings]);
  // 表格呈现完成交付会话与负面终止会话(#543);「问题已处理」取消与
  // 无原因历史取消服务端本就不下发行,前端不复判 cancel_reason(唯一
  // 口径在服务端);pending/unsupported/no_code 只计入范围计数,不进表。
  // 特性树/占比只认 ok 行(shareRows),终止行只进按会话表。
  const tableRows = useMemo(() => allRows
    .filter((row) => row.state === "ok" || row.state === "canceled"), [allRows]);
  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return tableRows.filter((row) =>
      (module === "*" || row.module === module)
      && (!repo || row.by_repo?.some((entry) => entry.repo === repo))
      && (!reporter || row.reporter === reporter)
      && (!keyword || `${row.id} ${row.title}`.toLowerCase().includes(keyword)));
  }, [tableRows, module, repo, reporter, query]);
  const moduleOptions = useMemo(() => enumOptions(tableRows.map((row) => row.module)), [tableRows]);
  const repoOptions = useMemo(() => enumOptions(tableRows
    .flatMap((row) => row.by_repo?.map((entry) => entry.repo) ?? []))
    .map((option) => ({ value: option.value, label: repoShortName(option.value) })), [tableRows]);
  const reporterOptions = useMemo(() => enumOptions(tableRows
    .map((row) => row.reporter)
    .filter((name): name is string => !!name)), [tableRows]);
  const selectedRow = rows.find((row) => row.id === selected);
  const sortedFeatures = useMemo(() => featureSort
    ? [...features].sort(compareBy((row) => featureSortValue(row, featureSort.key), featureSort.dir))
    : features, [features, featureSort]);
  const sortedRows = useMemo(() => sessionSort
    ? [...rows].sort(compareBy((row) => sessionSortValue(row, sessionSort.key), sessionSort.dir))
    : rows, [rows, sessionSort]);
  const cycleFeature = (key: string) => setFeatureSort((prev) => cycleSort(prev, key));
  const cycleSession = (key: string) => setSessionSort((prev) => cycleSort(prev, key));
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
  /** 计数比(分子/分母现算,一位小数);分母 0 → —。 */
  const countRate = (part: number, total: number) =>
    pct(total ? Math.round((part / total) * 1000) / 10 : null);
  const delivered = stats?.delivered ?? 0;
  const terminated = stats?.terminated ?? 0;
  const lines = sumLineKinds(stats);
  const solvedRate = pct(stats?.solved.rate);
  const shareRate = pct(weightedShare(stats));
  const help = (tip: string) =>
    <span className="help-tip" data-tip={tip}>
      <HelpCircle size={14} className="text-muted-foreground" />
    </span>;
  /** 树点击的统一落点:跳按会话、带上对应过滤、清掉其余过滤——
   *  跳转后看到的会话集=刚才所看数字的构成会话(ADR-0065 决定3)。 */
  const openSessions = (nextModule: string, nextRepo = "") => {
    setModule(nextModule); setRepo(nextRepo);
    setReporter(""); setQuery("");
    setDim("session");
  };  const toggleExpand = (feature: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(feature)) next.delete(feature); else next.add(feature);
    return next;
  });
  const solvedCard = <section className="delivery-card"><h2>一次解决率 <span>{stats?.solved.passed ?? 0} / {stats?.solved.total ?? 0} 会话</span>{help("报告一版过 且 验证不通过=0,两轴同时一次的会话占比。分母=完成交付会话+主动终止(负面原因)会话(自 2026-10-21 口径切换起),主动终止记一次失败;「问题已处理」「业务模块绑错」的终止不参与统计;按会话表的定位/验证✓✗是它的两个因子,两轴分母仍只含完成交付。")}</h2>
    <Donut unit="会话" centerValue={solvedRate} centerLabel="一次解决率"
      ariaLabel={`一次解决 ${stats?.solved.passed ?? 0} / ${stats?.solved.total ?? 0} 会话，占比 ${solvedRate}`}
      slices={[
        { label: "一次解决", color: "var(--success)", value: stats?.solved.passed ?? 0 },
        { label: "未一次解决", color: "var(--line-strong)", value: Math.max(0, (stats?.solved.total ?? 0) - (stats?.solved.passed ?? 0) - terminated) },
        { label: "用户终止（负面原因）", color: "var(--attention-strong)", value: terminated },
      ]} />
    <p className="mt-3 text-xs text-muted-foreground">口径标注：分母 = 完成交付会话 + 主动终止会话（自 2026-10-21 口径切换起）；选「问题已处理」或「业务模块绑错」的终止不参与统计。</p>
  </section>;
  const shareCard = <section className="delivery-card"><h2>首次生成占比 <span>交付代码行数：{num(lines.total)} 行</span>{help("首次生成占比=首轮提交变更行 ÷ 全部提交变更行(增删行均计为正向工作量,源码白名单内);平台外(人工)改动计入分母;被强制覆盖(force push)的平台推送按原分类计入。跨会话按工作行加权。")}</h2>
    <Donut unit="行" centerValue={shareRate} centerLabel="首次生成占比"
      ariaLabel={`生成工作行 ${num(lines.total)} 行，首次生成占比 ${shareRate}`}
      slices={worklineSlices(lines)} />
  </section>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />完成交付 {delivered}
        {stats && stats.pending + stats.no_code + stats.unsupported > 0 &&
          <span className="help-tip" data-tip={`待算 ${stats.pending} · 无源码交付 ${stats.no_code} · 早于 ${stats.supported_since} 起算日 ${stats.unsupported} 个,均不进统计`}><HelpCircle size={14} className="text-muted-foreground" /></span>}
      </span>
    </div>
    {isAdmin
      ? <div className="delivery-overview-grid">{solvedCard}{shareCard}</div>
      : solvedCard}
    <div className="inline-flex w-fit items-center gap-1 rounded-full border border-line bg-surface-2 p-1" role="tablist" aria-label="观察维度">
      {([["feature", "按特性"], ["session", "按会话"]] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={dim === key}
          className={cn("rounded-full px-4 py-1.5 text-sm transition-colors",
            dim === key ? "bg-canvas font-semibold text-text-strong shadow-sm" : "text-muted-foreground hover:text-text-strong")}
          onClick={() => setDim(key)}>{label}</button>)}
    </div>
    {dim === "feature" && <section className="delivery-card"><h2 className="flex items-center gap-2">按特性
      {help(isAdmin
        ? "三率同分母=交付尝试(完成交付+负面终止;终止记未解决/未定位/未验证);行数与占比只含有交付事实的会话;展开看该特性交付落到的各仓,点特性名/仓名跳按会话并带上过滤;绑定列表外的仓排在同特性仓行的末尾;仓行三率只含有交付事实的会话"
        : "会话数与一次解决率=交付尝试口径(完成交付+负面终止,终止记未解决,与一次解决率环同分母);展开看该特性交付落到的各仓,点特性名/仓名跳按会话并带上过滤;绑定列表外的仓排在同特性仓行的末尾")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <SortableTh label="特性 / 代码仓" sortKey="name" sort={featureSort} onCycle={cycleFeature} />
        <SortableTh label="会话数" sortKey="sessions" sort={featureSort} onCycle={cycleFeature} />
        <SortableTh label="一次解决率" sortKey="solved" sort={featureSort} onCycle={cycleFeature} />
        {isAdmin && <SortableTh label="一次定位率" sortKey="localization" sort={featureSort} onCycle={cycleFeature} />}
        {isAdmin && <SortableTh label="一次验证率" sortKey="verify" sort={featureSort} onCycle={cycleFeature} />}
        {isAdmin && <SortableTh label="首次生成占比" sortKey="share" sort={featureSort} onCycle={cycleFeature} />}
        {isAdmin && <SortableTh label="首轮/返工/平台外(行)" sortKey="lines" sort={featureSort} onCycle={cycleFeature} />}
      </tr></thead>
        <tbody>{sortedFeatures.map((feature: OnceGeneratedFeatureRow) => {
          const name = feature.module;
          const open = expanded.has(name);
          const inner = featureSort
            ? [...(tree.repos.get(name) ?? [])]
              .sort(compareBy((entry: FeatureRepoRow) => repoSortValue(entry, featureSort.key), featureSort.dir))
            : tree.repos.get(name) ?? [];
          const totals = tree.lines.get(name) ?? { first: 0, rework: 0, external: 0 };
          return <Fragment key={name}>
            <tr>
              <td><span className="flex items-center gap-1">
                <button type="button" aria-expanded={open}
                  aria-label={`${open ? "收起" : "展开"}${name}的代码仓`} disabled={!inner.length}
                  className="rounded-sm p-0.5 text-muted-foreground hover:text-text-strong disabled:opacity-40"
                  onClick={() => toggleExpand(name)}>
                  {open ? <ChevronDown aria-hidden size={14} /> : <ChevronRight aria-hidden size={14} />}
                </button>
                <button className="delivery-task-link" title="查看该特性的会话明细"
                  onClick={() => openSessions(name)}><b>{name}</b></button>
              </span></td>
              <td>{feature.sessions}</td>
              <td className="pct">{pct(feature.solved_rate)}</td>
              {isAdmin && <td className="pct">{pct(feature.localization_rate)}</td>}
              {isAdmin && <td className="pct">{pct(feature.verify_rate)}</td>}
              {isAdmin && <td className="delivery-accent pct">{pct(feature.share)}</td>}
              {isAdmin && <td className="pct">{num(totals.first)} / {num(totals.rework)} / {num(totals.external)}</td>}
            </tr>
            {open && inner.map((entry) => <tr key={entry.repo} className="delivery-child-row">
              <td className="wrap"><button className="delivery-task-link"
                title={`查看改过该仓(${entry.repo})的该特性会话`} onClick={() => openSessions(name, entry.repo)}>
                <b title={entry.repo}>{repoShortName(entry.repo)}</b>
              </button></td>
              <td>{entry.sessions}</td>
              <td className="pct">{countRate(entry.solved, entry.sessions)}</td>
              {isAdmin && <td className="pct">{countRate(entry.localization_passed, entry.sessions)}</td>}
              {isAdmin && <td className="pct">{countRate(entry.verify_passed, entry.sessions)}</td>}
              {isAdmin && <td className="delivery-accent pct">{pct(entry.share)}</td>}
              {isAdmin && <td className="pct">{num(entry.first)} / {num(entry.rework)} / {num(entry.external)}</td>}
            </tr>)}
          </Fragment>;
        })}</tbody></table></div>
      {!features.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有会话"}</p>}
    </section>}
    {dim === "session" && <section className="delivery-card"><h2 className="flex items-center gap-2">按会话
      {help("列头漏斗按会话关键字/特性/代码仓/发起人过滤,激活的漏斗带底色,点开可清除;点行查看该会话的行归属证据,终止行点行看终止原因与说明;一次定位/一次验证✓✗只对完成交付会话判轴,终止行相关列以 — 占位")}</h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <SortableTh label="会话" sortKey="name" sort={sessionSort} onCycle={cycleSession} className="min-w-[240px]"
          filter={<KeywordHeaderFilter label="会话" placeholder="包含 ID 或标题片段…"
            value={query} onChange={setQuery} />} />
        <SortableTh label="特性" sortKey="module" sort={sessionSort} onCycle={cycleSession}
          filter={<HeaderEnumFilter label="特性" value={module === "*" ? "" : module}
            options={moduleOptions} onPick={(value) => setModule(value || "*")} />} />
        <SortableTh label="代码仓" sortKey="repo" sort={sessionSort} onCycle={cycleSession}
          filter={<HeaderEnumFilter label="代码仓" value={repo}
            options={repoOptions} onPick={setRepo} />} />
        <SortableTh label="一次解决" sortKey="solved" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="一次定位" sortKey="localization" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="一次验证" sortKey="verify" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="首次生成占比" sortKey="share" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="首轮/返工/平台外(行)" sortKey="lines" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="发起人" sortKey="reporter" sort={sessionSort} onCycle={cycleSession}
          filter={<HeaderEnumFilter label="发起人" value={reporter}
            options={reporterOptions} onPick={setReporter} />} />
        <SortableTh label="收口时间" sortKey="concluded" sort={sessionSort} onCycle={cycleSession} />
        <SortableTh label="终止原因" sortKey="terminate" sort={sessionSort} onCycle={cycleSession} />
      </tr></thead>
        <tbody>{sortedRows.map((row: IssueOnceGeneratedSessionRow) => {
          const canceledRow = row.state === "canceled";
          return <tr key={row.id} style={{ cursor: "pointer" }}
            title={canceledRow ? "查看终止原因" : "查看行归属证据"} onClick={() => setSelected(row.id)}>
          <td><a className="delivery-task-link" style={{ cursor: "pointer" }}
            href={`/issues/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer"
            title="打开会话控制台"
            onClick={(event) => event.stopPropagation()}><b>{row.id}</b><span>{row.title}</span></a></td>
          <td>{row.module}</td>
          <td className="wrap">{row.by_repo?.length
            ? <span className="flex flex-col gap-0.5 text-xs">{[...new Set(row.by_repo.map((entry) => entry.repo))]
              .map((repo) => <span key={repo} className="max-w-[160px] truncate" title={repo}>{repoShortName(repo)}</span>)}</span>
            : "—"}</td>
          <td>{canceledRow
            ? <span className="font-semibold text-danger">✗</span>
            : row.solved_pass
              ? <span className="font-semibold text-success">✓</span>
              : <span className="font-semibold text-danger">✗</span>}</td>
          <td>{canceledRow ? "—" : row.localization_pass ? <span className="text-success">✓ 一版</span> : <span className="text-danger">✗ 多版</span>}</td>
          <td>{canceledRow ? "—" : row.verify_pass ? <span className="text-success">✓</span> : <span className="text-danger">✗</span>}</td>
          <td className="delivery-accent pct">{canceledRow ? "—" : pct(row.share)}</td>
          <td className="pct">{canceledRow ? "—" : `${num(row.lines?.first ?? 0)} / ${num(row.lines?.rework ?? 0)} / ${num(row.lines?.external ?? 0)}`}</td>
          <td>{row.reporter ? displayPersonName(row.reporter, people) : "—"}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
          <td>{canceledRow ? <TerminateReasonBadge row={row} /> : "—"}</td>
        </tr>;
        })}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有会话"}</p>}
    </section>}
    <details className="delivery-method" style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>统计口径</summary>
      <p>概览只看两个指标:一次解决率=一次定位(分析报告一版过)且一次验证(验证不通过 0 次,未答卡=通过),分母=完成交付会话+主动终止(负面原因)会话,主动终止记一次失败,一次定位/一次验证两轴的分母仍只含完成交付(负面终止无法判轴);终止时选「问题已处理」或「业务模块绑错」的会话与无原因取消(历史数据)不参与统计,无单会话不进任何率;首次生成占比=首轮提交变更行 ÷ 全部提交变更行(增删行均计,源码白名单内)。</p>
      <p>首次生成占比的返工边界=首个反馈事件(检视/红灯/验证失败)回应的推送;平台外改动计入分母;被强制覆盖(force push)的平台推送按原分类计入,证据表里标「已覆盖」;现场取不到标「不可得」。收口后后台计算,稍后刷新可见。</p>
    </details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]">
        <SheetHeader><SheetTitle>{selected} · {selectedRow?.state === "canceled" ? "终止详情" : "首次生成归属"}</SheetTitle>
          <SheetDescription>{selectedRow ? selectedRow.state === "canceled"
            ? `${selectedRow.title} · ${new Date(selectedRow.concluded_at).toLocaleDateString("zh-CN")} 终止`
            : `${selectedRow.title} · 占比 ${pct(selectedRow.share)}` : "行归属证据"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected
          && (selectedRow?.state === "canceled"
            ? <TerminateReasonDetail row={selectedRow} />
            : <IssueCodeOriginPanel id={selected} threshold={stats?.threshold_percent} />)}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
/** 登记问题页签(ADR-0048;口径 2026-10-16 由 ADR-0064 收紧):无单
 *  会话的结论漏斗与研究质量。人群=研究结论已出(非问题/确认是问题);
 *  取消是退场、不算研究结论,与研究进行中一样不进任何数字。
 *  纯呈现层,与登记问题统计端点同一数字;「确认是问题」行下钻
 *  报告版本账与提单模板卡。 */
export function RegistrationAnalyticsTab() {
  const [stats, setStats] = useState<IssueRegistrationStats>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" });
  const [dim, setDim] = useState<"module" | "reporter" | "session">("module");
  const [module, setModule] = useState("*");
  /** 按会话列头过滤(ADR-0065 与 DTS 按会话同款):会话关键字、
   *  模块/登记人/责任人枚举;时间沿用页签顶部日期范围,不设列头。 */
  const [query, setQuery] = useState("");
  const [reporter, setReporter] = useState("");
  const [account, setAccount] = useState("");
  /** 表头排序(ADR-0065 修订,与 DTS 同款三态)。聚合小表两视图列结构
   *  对齐,共用一个排序状态;按会话独立。 */
  const [groupSort, setGroupSort] = useState<SortState>(null);
  const [regSessionSort, setRegSessionSort] = useState<SortState>(null);
  const [selected, setSelected] = useState<IssueRegistrationSessionRow | null>(null);
  useEffect(() => {
    let live = true;
    setStats(undefined); setError("");
    if (dates.from && dates.to && dates.from > dates.to) { setBusy(false); return; }
    setBusy(true);
    void getIssueRegistrationStats(undefined, completionDateRange(dates)).then(value => { if (live) setStats(value); })
      .catch(error => { if (live) setError(error instanceof Error ? error.message : "加载失败"); })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [dates]);
  const rows = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (stats?.per_session ?? [])
      .filter((row) => module === "*" || row.module === module)
      .filter((row) => !reporter || row.reporter === reporter)
      .filter((row) => !account || row.account === account)
      .filter((row) => !keyword || `${row.id} ${row.title}`.toLowerCase().includes(keyword));
  }, [stats, module, reporter, account, query]);
  const moduleOptions = useMemo(() => enumOptions((stats?.per_session ?? []).map((row) => row.module)), [stats]);
  const reporterOptions = useMemo(() => enumOptions((stats?.per_session ?? [])
    .map((row) => row.reporter).filter(Boolean)), [stats]);
  const accountOptions = useMemo(() => enumOptions((stats?.per_session ?? [])
    .map((row) => row.account).filter(Boolean)), [stats]);
  const modules = stats?.by_module ?? [];
  const reporters = stats?.by_reporter ?? [];
  const sortedModules = useMemo(() => groupSort
    ? [...modules].sort(compareBy((row) => regGroupSortValue(row, groupSort.key), groupSort.dir))
    : modules, [modules, groupSort]);
  const sortedReporters = useMemo(() => groupSort
    ? [...reporters].sort(compareBy((row) => regGroupSortValue(row, groupSort.key), groupSort.dir))
    : reporters, [reporters, groupSort]);
  const sortedRegRows = useMemo(() => regSessionSort
    ? [...rows].sort(compareBy((row) => regSessionSortValue(row, regSessionSort.key), regSessionSort.dir))
    : rows, [rows, regSessionSort]);
  const cycleGroup = (key: string) => setGroupSort((prev) => cycleSort(prev, key));
  const cycleRegSession = (key: string) => setRegSessionSort((prev) => cycleSort(prev, key));
  const pct = (value: number | null | undefined) =>
    value === null || value === undefined ? "—" : `${value.toFixed(1)}%`;
  const help = (tip: string) =>
    <span className="help-tip" data-tip={tip}>
      <HelpCircle size={14} className="text-muted-foreground" />
    </span>;
  const tile = (label: string, value: string, sub: string, tip: string) =>
    <div className="rounded-[14px] border border-line bg-surface px-5 py-4">
      <small className="mb-1.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
        {label}{help(tip)}
      </small>
      <strong className="block text-[32px] leading-none tracking-[-0.02em] tabular-nums text-text-strong">
        {value}</strong>
      <span className="mt-2 block text-xs text-muted-foreground">{sub}</span>
    </div>;
  const badge = (conclusion: IssueRegistrationSessionRow["conclusion"]) =>
    conclusion === "issue"
      ? <span className="inline-flex items-center rounded-full bg-active-soft px-2 py-0.5 text-xs font-medium text-active">确认是问题</span>
      : <span className="inline-flex items-center rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground">非问题</span>;
  return <div className="grid gap-4">
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="flex flex-wrap items-center gap-3">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <BarChart3 size={15} />研究完成 {stats?.total ?? 0}
        {help("研究结论已出的无单会话:非问题 + 确认是问题。取消是退场不算研究结论,与研究进行中一样不进任何数字。")}
      </span>
    </div>
    <div className="grid grid-cols-[repeat(4,1fr)] gap-3.5">
      {tile("登记总数", String(stats?.total ?? 0),
        `非问题 ${stats?.non_issue ?? 0} · 确认是问题 ${stats?.issue_confirmed ?? 0}`,
        "研究结论已出的无单(自研)问题会话数:取消视为退场不计入;研究进行中的暂不进,结论落地后自动计入;有单会话在 DTS 页签,不在此处。")}
      {tile("非问题闭环率", pct(stats ? stats.total ? stats.non_issue / stats.total * 100 : null : null),
        `${stats?.non_issue ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「非问题」的占比。分母=研究完成(非问题+确认是问题);取消是退场不算研究结论,不进分母;进行中不进。")}
      {tile("确认是问题率", pct(stats ? stats.total ? stats.issue_confirmed / stats.total * 100 : null : null),
        `${stats?.issue_confirmed ?? 0}/${stats?.total ?? 0} 研究完成`,
        "研究结论为「确认是问题」的占比:会话闭环并产出提单模板,测试拿模板去 DTS 提单后,新单号从 DTS 列表发起有单会话。分母同左。")}
      {tile("一次定位率", pct(stats?.localization.rate),
        `${stats?.localization.passed ?? 0}/${stats?.localization.total ?? 0} 会话`,
        "分析报告一版就收口即一次定位;检视提出修改会生成新版本。分母=非问题+确认是问题。")}
    </div>
    <div className="inline-flex w-fit items-center gap-1 rounded-full border border-line bg-surface-2 p-1" role="tablist" aria-label="观察维度">
      {([["module", "按模块"], ["reporter", "按登记人"], ["session", "按会话"]] as const).map(([key, label]) =>
        <button key={key} type="button" aria-pressed={dim === key}
          className={cn("rounded-full px-4 py-1.5 text-sm transition-colors",
            dim === key ? "bg-canvas font-semibold text-text-strong shadow-sm" : "text-muted-foreground hover:text-text-strong")}
          onClick={() => setDim(key)}>{label}</button>)}
    </div>
    {dim === "module" && <section className="delivery-card"><h2 className="flex items-center gap-2">按模块
      {help("无单会话按登记时所选业务模块聚合;点模块名可筛选按会话明细")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <SortableTh label="模块" sortKey="name" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="登记数" sortKey="total" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="非问题" sortKey="non_issue" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="确认是问题" sortKey="issue_confirmed" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="一次定位率" sortKey="localization" sort={groupSort} onCycle={cycleGroup} />
      </tr></thead>
        <tbody>{sortedModules.map((entry) => <tr key={entry.key}>
          <td><button className="delivery-task-link" aria-pressed={module === entry.key}
            onClick={() => setModule(module === entry.key ? "*" : entry.key)}><b>{entry.key}</b></button></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
          <td className="delivery-accent pct">{pct(entry.localization_rate)}</td>
        </tr>)}</tbody></table></div>
      {!modules.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有登记问题"}</p>}
    </section>}
    {dim === "reporter" && <section className="delivery-card"><h2 className="flex items-center gap-2">按登记人
      {help("按登记时指派的登记人聚合;登记人缺席的老会话按归属兜底")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <SortableTh label="登记人" sortKey="name" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="登记数" sortKey="total" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="非问题" sortKey="non_issue" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="确认是问题" sortKey="issue_confirmed" sort={groupSort} onCycle={cycleGroup} />
        <SortableTh label="一次定位率" sortKey="localization" sort={groupSort} onCycle={cycleGroup} />
      </tr></thead>
        <tbody>{sortedReporters.map((entry) => <tr key={entry.key}>
          <td className="wrap"><b>{entry.key}</b></td>
          <td>{entry.total}</td>
          <td>{entry.non_issue}</td>
          <td>{entry.issue_confirmed}</td>
          <td className="delivery-accent pct">{pct(entry.localization_rate)}</td>
        </tr>)}</tbody></table></div>
      {!reporters.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内还没有登记问题"}</p>}
    </section>}
    {dim === "session" && <section className="delivery-card"><h2 className="flex items-center gap-2">按会话
      {help("列头漏斗按会话关键字/模块/登记人/责任人过滤;点「确认是问题」行查看报告版本账与提单模板卡")}
    </h2>
      <div className="delivery-table-scroll"><table><thead><tr>
        <SortableTh label="会话" sortKey="name" sort={regSessionSort} onCycle={cycleRegSession}
          filter={<KeywordHeaderFilter label="会话" placeholder="包含 ID 或标题片段…"
            value={query} onChange={setQuery} />} />
        <SortableTh label="模块" sortKey="module" sort={regSessionSort} onCycle={cycleRegSession}
          filter={<HeaderEnumFilter label="模块" value={module === "*" ? "" : module}
            options={moduleOptions} onPick={(value) => setModule(value || "*")} />} />
        <SortableTh label="登记人" sortKey="reporter" sort={regSessionSort} onCycle={cycleRegSession}
          filter={<HeaderEnumFilter label="登记人" value={reporter}
            options={reporterOptions} onPick={setReporter} />} />
        <SortableTh label="责任人" sortKey="account" sort={regSessionSort} onCycle={cycleRegSession}
          filter={<HeaderEnumFilter label="责任人" value={account}
            options={accountOptions} onPick={setAccount} />} />
        <SortableTh label="结论" sortKey="conclusion" sort={regSessionSort} onCycle={cycleRegSession} />
        <SortableTh label="报告版本" sortKey="versions" sort={regSessionSort} onCycle={cycleRegSession} />
        <SortableTh label="一次定位" sortKey="localization" sort={regSessionSort} onCycle={cycleRegSession} />
        <SortableTh label="收口时间" sortKey="concluded" sort={regSessionSort} onCycle={cycleRegSession} />
      </tr></thead>
        <tbody>{sortedRegRows.map((row) => <tr key={row.id}
          style={{ cursor: row.conclusion === "issue" ? "pointer" : undefined }}
          title={row.conclusion === "issue" ? "查看报告版本账与提单模板" : undefined}
          onClick={row.conclusion === "issue" ? () => setSelected(row) : undefined}>
          <td><a className="delivery-task-link"
            href={`/issues/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer"
            title="打开会话控制台"
            onClick={(event) => event.stopPropagation()}><b>{row.id}</b><span>{row.title}</span></a></td>
          <td>{row.module}</td>
          <td>{row.reporter}</td>
          <td>{row.account}</td>
          <td>{badge(row.conclusion)}</td>
          <td className="pct">{row.report_version_count} 版</td>
          <td>{row.localization_pass
            ? <span className="font-semibold text-success">✓ 一版</span>
            : <span className="font-semibold text-danger">✗ 多版</span>}</td>
          <td className="text-muted-foreground">{new Date(row.concluded_at).toLocaleDateString("zh-CN")}</td>
        </tr>)}</tbody></table></div>
      {!rows.length && <p className="delivery-empty">{busy ? "正在读取统计…" : "范围内没有登记问题"}</p>}
    </section>}
    <details className="delivery-method" style={{ marginTop: 4 }}><summary style={{ cursor: "pointer" }}>统计口径</summary>
      <p>本页只数研究结论已出的无单(自研)会话,人群=非问题+确认是问题:三块比率的分母都是它;取消是退场、不算研究结论,与研究进行中一样不进任何数字(ADR-0064)。</p>
      <p>一次定位率=分析报告一版过,检视提出修改会生成新版本。确认是问题即闭环归档并产出提单模板;提单在平台外完成(测试复制进 DTS 提单系统),新单号再从 DTS 列表发起有单会话完整重走。</p>
    </details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(560px,46vw)] data-[side=right]:sm:max-w-[min(560px,46vw)]">
        <SheetHeader><SheetTitle>{selected?.title}</SheetTitle>
          <SheetDescription>{selected ? `${selected.module} · ${selected.reporter} 登记 · 报告 ${selected.report_version_count} 版` : "报告版本账与提单模板"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{selected && <>
          <section className="delivery-card"><h2>报告版本账
            <span>{selected.localization_pass
              ? "分析报告一版过,一次定位 ✓"
              : "检视提出修改生成新版本,一次定位 ✗"}</span></h2>
            <p className="delivery-muted">结论「{selected.conclusion === "issue" ? "确认是问题" : "非问题"}」· 报告共 {selected.report_version_count} 版 · {new Date(selected.concluded_at).toLocaleDateString("zh-CN")} 收口</p>
          </section>
          {selected.conclusion === "issue" && <TicketTemplateCard issueId={selected.id} />}
        </>}</div>
      </SheetContent>
    </Sheet>
  </div>;
}
export function DeliveryAnalytics({ onOpenTask, initialTab, role }: {
  onOpenTask: (taskId: string) => void;
  /** 登录角色:喂给 DTS 页签的角色粒度("admin"=双环+7 列)。 */
  role?: string;
  /** 入场页签(页内跳转指定落点,如团队DTS档案的「交付统计」直达
   * 「DTS」;缺席=需求交付)。本组件按视图条件挂载,每次进场重取。 */
  initialTab?: "requirement" | "issue" | "registration" | "knowledge";
}) {
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState<"requirement" | "issue" | "registration" | "knowledge">(
    initialTab ?? "requirement");
  const [report, setReport] = useState<DeliveryAnalysisReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [repo, setRepo] = useState(""); const [module, setModule] = useState("*");
  const [page, setPage] = useState(0);
  const [dates, setDates] = useState<CompletionDates>({ from: "", to: "" }); const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(new URLSearchParams(location.search).get("deliveryTask"));
  async function refresh(retry = false) {
    setBusy(true); setError("");
    try { const response = await fetch(`/delivery-analytics${retry ? "?refresh=1" : ""}`); if (!response.ok) throw new Error(response.status === 401 ? "请先登录后查看交付分析" : "交付分析加载失败"); setReport(await response.json()); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, []);
  const rows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo) && (module === "*" || (row.business_module?.id ?? "") === module)
    && (!(dates.from && dates.to && dates.from > dates.to) && completedInRange(row.completed_at, completionDateRange(dates)))
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, module, dates, query]);
  const merged = rows.filter(row => row.merged), summary = aggregateDelivery(merged);
  const moduleRows = useMemo(() => (report?.rows ?? []).filter(row => (!repo || row.repo === repo)
    && (!(dates.from && dates.to && dates.from > dates.to) && completedInRange(row.completed_at, completionDateRange(dates)))
    && (!query || `${row.id} ${row.parent_id ?? ""} ${row.parent_title ?? ""} ${row.title}`.toLowerCase().includes(query.toLowerCase()))), [report, repo, dates, query]);
  const moduleGroups = aggregateDeliveryModules(moduleRows);
  const groupRows = useMemo(() => { const groups = new Map<string, DeliveryAnalysisRow[]>(); for (const row of rows) { const key = row.parent_id ?? row.id; groups.set(key, [...(groups.get(key) ?? []), row]); } return [...groups]; }, [rows]);
  useEffect(() => setPage(0), [repo, module, dates, query]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(groupRows.length / 10) - 1));
  const selectedParent = (report?.rows ?? []).some(row => row.parent_id === selected);
  const detailRows = rows.filter(row => row.id === selected || row.parent_id === selected);
  const detail = aggregateDelivery(detailRows);
  const detailTokens = aggregateDeliveryTokens(detailRows.map(r => r.id), report?.task_tokens, selectedParent ? selected ?? undefined : undefined);
  return <div className="delivery-analysis">
    <div className="delivery-toolbar"><div className="delivery-tabs">
      {([["requirement", "需求交付"], ["issue", "DTS"], ["registration", "登记问题"], ["knowledge", "知识使用效能"]] as const).map(([key, label]) =>
        tab === key
          ? <strong key={key}>{label}</strong>
          : <button key={key} type="button" className="text-sm text-muted-foreground transition-colors hover:text-text-strong" aria-pressed={false} onClick={() => setTab(key)}>{label}</button>)}
    </div>{tab !== "knowledge" && <Button variant="outline" onClick={() => void refresh(true)} disabled={busy}><RefreshCw className={busy ? "animate-spin" : ""} />{busy ? "正在读取" : "刷新数据"}</Button>}</div>
    {tab === "requirement" && <>
    <div className="delivery-filters">
      <CompletionDateFilter value={dates} onChange={setDates} />
      <AnalysisFilter label="代码仓" value={repo} onChange={setRepo} items={[{value:"",label:"全部代码仓"}, ...[...new Set(report?.rows.map(r => r.repo).filter(Boolean))].map(r => ({value:r!,label:r!}))]} />
      <AnalysisFilter label="业务模块" value={module} onChange={setModule} items={[{value:"*",label:"全部模块"}, ...[...new Map((report?.rows ?? []).map(row => [row.business_module?.id ?? "", row.business_module?.name ?? "未关联模块"])).entries()].map(([value,label]) => ({value,label}))]} />
      <Input aria-label="搜索任务" placeholder="搜索 task ID 或需求名称" value={query} onChange={e => setQuery(e.target.value)} />
    </div>
    {error && <p role="alert" className="delivery-error">{error}</p>}
    <div className="delivery-scope"><BarChart3 size={18} /><span>团队汇总仅计已合入的 {summary.tasks} 次交付 · 按任务完成时间筛选，同一任务可多次交付，主任务不重复计数</span></div>
    <div className="delivery-overview-grid"><DeliverySources summary={summary} />
    <section className="delivery-card"><h2>业务模块交付占比 <span>已合入需求的交付代码行数</span></h2>
      <div className="delivery-module-bars">{moduleGroups.map(group => <button key={group.id} className="delivery-module-row" aria-pressed={module === group.id}
        onClick={() => { setModule(module === group.id ? "*" : group.id); setPage(0); }}>
        <span className="delivery-module-name">{group.name}</span><strong>{percent(group.percent)}</strong>
        <span className="delivery-module-track"><span style={{ width: `${group.percent}%` }} /></span><span>{num(group.lines)} 行</span>
      </button>)}</div>
      {!moduleGroups.length && <p className="delivery-empty">{merged.length ? "当前已合入的需求尚无可统计的交付代码行数" : "暂无已合入交付数据"}</p>}
    </section></div>
    <section className="delivery-card"><h2>任务明细 <span>点击查看代码差异、来源与提交记录</span></h2><div className="delivery-table-scroll"><table><thead><tr><th>需求 / 任务</th><th>语言</th><th>状态</th><th>交付代码行数</th><th>首次实现占比</th><th>Token 消耗</th><th>统计覆盖</th></tr></thead><tbody>{groupRows.slice(currentPage * 10, currentPage * 10 + 10).map(([id, tasks]) => {
      const parent = tasks.some(t => t.parent_id === id);
      return <Fragment key={id}>{parent && <TaskMetricRow id={id} title={`${tasks[0].parent_title ?? "主任务"} · 主任务汇总`} tasks={tasks} ledger={report?.task_tokens} parent onSelect={setSelected} />}{[...new Set(tasks.map(row => row.id))].map(taskId => <TaskMetricRow key={taskId} id={taskId} title={tasks.find(row => row.id === taskId)!.title} tasks={tasks.filter(row => row.id === taskId)} ledger={report?.task_tokens} onSelect={setSelected} child={parent} />)}</Fragment>;
    })}</tbody></table></div>{groupRows.length > 10 && <div className="delivery-pagination"><span>第 {currentPage + 1} / {Math.ceil(groupRows.length / 10)} 页</span><Button variant="outline" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</Button><Button variant="outline" disabled={(currentPage + 1) * 10 >= groupRows.length} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>}{!rows.length && <p className="delivery-empty">{busy ? "正在读取交付记录…" : "当前条件下没有需求任务"}</p>}</section>
    {report?.improvement_policy && <ImprovementPolicyControl key={JSON.stringify(report.improvement_policy)} policy={report.improvement_policy} onSaved={policy => setReport(previous => previous ? { ...previous, improvement_policy: { ...policy, can_configure: previous.improvement_policy?.can_configure } } : previous)} />}
    <details className="delivery-method"><summary>统计口径与数据边界</summary><p>交付代码行数统计最终 MR 相对目标分支新增或修改的行。来源占比只纳入能追溯这些行的交付，按行数加权。仅能核实行数的交付仍计入行数和业务模块占比。{merged.some(row => row.final_deleted_lines !== undefined || row.metric) && `有删除记录的交付共删除 ${num(summary.deleted)} 行。`}</p><p>首次实现包含首次修复之前的提交。能追溯到平台初版 MR 或建 MR 前的推送版本时，此后的修改归入后两类。普通交付缺少修复线索时，暂按首次实现统计。统计范围包括源码、测试、脚本和配置，排除 Markdown、二进制、依赖目录、构建产物和平台运行文件。</p><p>后续修改根据实际修复记录和对应的提交范围分类，缺少记录时参考提交说明。有流水线修复依据的归入「流水线修复」，其余后续调整按「检视修改」统计，包括开发者在本地自查后的修改。每条提交的分类依据可在任务明细查看。</p><p>Token 使用已有模型用量台账，输入与输出相加；主任务汇总包含自身分析及当前筛选范围的子任务，每个任务只计一次。不要求已推送或已有代码统计；没有上报的历史消耗显示暂无记录。</p><p>这不是代码质量评分；不同任务规模与范围不同。覆盖不足时请结合任务明细解读统计。采集在推送后后台进行，稍后刷新可查看结果，不阻塞开发交付。</p></details>
    <Sheet open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <SheetContent initialFocus={detailTitle} className="delivery-detail-sheet bg-(--surface) gap-0 data-[side=right]:w-[min(760px,58vw)] data-[side=right]:sm:max-w-[min(760px,58vw)]">
        <SheetHeader><SheetTitle ref={detailTitle} tabIndex={-1}>{selected} · {selectedParent ? "主任务汇总" : "交付分析"}</SheetTitle><SheetDescription>{selectedParent ? `${detailRows[0]?.parent_title ?? "主任务"} · 当前筛选范围内 ${new Set(detailRows.map(row => row.id)).size} 个子任务` : detailRows[0]?.title ?? "交付记录"}</SheetDescription></SheetHeader>
        <div className="delivery-detail-body">{!detailRows.length ? <p>未找到该任务的交付记录。</p> : <>
          <TaskLanguages tasks={detailRows} />
          <p className="delivery-scope">{selectedParent ? `已合入交付 ${detailRows.filter(r => r.merged).length}/${detailRows.length}${detailRows.some(r => !r.merged) ? " · 含未合入暂计" : ""}` : detailRows.every(r => r.merged) ? "已合入" : "进行中，以下为最近推送版本的暂计数据"}</p>
          {!selectedParent && detailRows.length === 1 && detailRows[0].external_collaboration && <ExternalCollaborationNote />}
          {detailRows.length === 1 && detailRows[0].mr_comparison && <section className="delivery-card"><FinalMrComparison row={detailRows[0]} expandFirst /></section>}
          <DeliverySources summary={detail} />
          <section className="delivery-card"><h2>Token 消耗 <span>{selectedParent ? "含主任务自身及当前范围子任务" : "本任务累计用量"}</span></h2><div className="grid grid-cols-3 gap-4 py-4"><div>总计<strong className="block text-xl">{detailTokens.available ? num(detailTokens.total) : "—"}</strong></div><div>输入<strong className="block text-xl">{detailTokens.available ? num(detailTokens.input) : "—"}</strong></div><div>输出<strong className="block text-xl">{detailTokens.available ? num(detailTokens.output) : "—"}</strong></div></div>{detailTokens.available < detailTokens.tasks && <p className="delivery-muted">{detailTokens.available}/{detailTokens.tasks} 个任务有用量记录；未记录的历史消耗不估算。</p>}</section>
          {detailRows.map(row => <section className="delivery-card" key={`${row.id}:${row.delivery_id ?? "initial"}`}>
            <DeliveryImprovement row={row}><h2>{row.id} · {new Date(row.at).toLocaleString("zh-CN")} · {row.metric?.content_comparison ? "内容比较" : "提交记录"}</h2><a href={`/work/${encodeURIComponent(row.id)}`} target="_blank" rel="noreferrer">工作台 <ExternalLink size={14} /></a>{row.mr_url && !row.mr_comparison && <a href={row.mr_url} target="_blank" rel="noreferrer">MR <ExternalLink size={14} /></a>}</DeliveryImprovement>
            {(selectedParent || detailRows.length > 1) && row.external_collaboration && <ExternalCollaborationNote />}
            {detailRows.length > 1 && row.mr_comparison && <FinalMrComparison row={row} />}
            {row.unavailable && <p className="delivery-note">{row.unavailable}</p>}
            {row.metric?.content_comparison ? <p className="delivery-muted">按文件和行内容比较 · 基准：{row.metric.content_comparison.reference === "local_snapshot" ? "关联最终 MR 时的本地快照" : row.metric.content_comparison.reference === "platform_push" ? "平台已推送版本" : "初版 MR"}（{row.metric.content_comparison.head.slice(0, 8)}）{row.metric.content_comparison.captured_at ? ` · ${new Date(row.metric.content_comparison.captured_at).toLocaleString("zh-CN")}` : ""} · 相同行计首次实现，其余有明确流水线证据的计流水线修复，其余计检视修改。删除行不参与占比。</p> : row.metric && <><p className="delivery-muted">比较 {row.metric.base.slice(0, 8)} → {row.metric.head.slice(0, 8)} · 排除 {row.metric.excluded_files} 个非代码文本文件</p><ol className="delivery-timeline">{row.metric.commits.map(c => <li key={c.sha}><i style={{ background: categories.find(k => k.key === c.origin)?.color }} /><div><strong>{categories.find(k => k.key === c.origin)?.label}</strong><span className="delivery-commit-size">+{num(c.additions)} / −{num(c.deletions)}</span><p>{c.subject}</p>{c.origin_evidence?.length ? <details><summary>分类依据</summary>{c.origin_evidence.map((text, index) => <p key={index}>{text}</p>)}</details> : null}<small>{c.sha.slice(0, 10)} · {new Date(c.at).toLocaleString("zh-CN")}</small></div></li>)}</ol></>}</section>)}</>}</div>
      </SheetContent>
    </Sheet>
    </>}
    {tab === "issue" && <IssueAnalyticsTab role={role} />}
    {tab === "registration" && <RegistrationAnalyticsTab />}
    {tab === "knowledge" && <KnowledgeInsightsPanel onOpenTask={onOpenTask} />}
  </div>;
}
