/**
 * 问题处理页(问题流 v2 的唯一入口)。
 *
 * 与"我的需求"完全隔离:独立分包、独立轮询、独立 API 命名空间。
 * 本文件只剩列表与组装(spec #2 按域拆分):登记在 Registration.tsx,
 * 会话工作台在 SessionView.tsx,材料页签在 MaterialsPane.tsx,现场
 * 页签在 EventsPane.tsx,协作流在 IssueConversationStream.tsx,
 * 决策卡在 IssueDecisionCard.tsx。页面两块:上方登记(手工登记/DTS
 * 列表),下方「我的问题」单一列表(归属或登记人是自己,ADR-0031);
 * 点开卡片以新页签进入会话工作台(ADR-0040:多开是问题处理的常态,
 * 页内 overlay 通道退役,工作台只以 /issues/:id 深链形态存在——本
 * 组件在该 URL 下整页渲染工作台,studio 骨架:头部进度 + 左栏六标签
 * + 右栏协作对话框)。前端不推断状态:一切文案来自 /issues API 镜像。
 */
import { useEffect, useState } from "react";
import { IssueMrImport } from "../IssueMrImport";
import {
  ISSUE_STATUS_TEXT,
  controlIssue,
  getIssue,
  isIssueActive,
  issueStageText,
  issueStatusText,
  listIssues,
  listPipelineRepairs,
  type AuthUser,
  type IssueDetail,
  type IssueStatus,
  type IssueSummary,
} from "../api";
import { CancelSessionDialog, type CancelSessionInput } from "./CancelSessionDialog";
import { Spinner } from "@/components/Spinner";
import { startVisiblePolling } from "../visiblePolling";
import { formatLocalDateTime } from "../time";
import { repoName } from "./perRepo";
import { dtsTicketUrl } from "./dtsTicket";
import { issueSessionPath } from "./issueLink";
import { IssueRegistration } from "./Registration";
import { IssueStatusBadge } from "../StatusBadge";
import { IssueFixedProgress, IssueSessionView } from "./SessionView";
import { Card } from "../components/ui/card";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/Empty";
import { cn } from "cn";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

/** 列表状态筛选:默认"进行中"(只藏已归档/已取消两个收口终态——failed
 * 虽也是终态但属于"需介入",照常露面),另支持按单个状态标签过滤与全量。
 * idle 的展示已归一进「等你答复」(2026-09-08 拍板):不设独立筛选项,
 * 选「等你答复」时两者一起命中。 */
type IssueListFilter = "active" | IssueStatus | "all";
const ISSUE_FILTER_STORAGE_KEY = "mae-flow:issue-list-filter";
const ISSUE_FILTER_STATUSES: IssueStatus[] = [
  "waiting_user", "running", "queued", "failed",
  "archived", "canceled",
];

function readIssueListFilter(): IssueListFilter {
  try {
    const saved = localStorage.getItem(ISSUE_FILTER_STORAGE_KEY);
    if (saved === "idle") return "waiting_user";
    if (saved === "active" || saved === "all") return saved;
    if (saved && ISSUE_FILTER_STATUSES.includes(saved as IssueStatus)) {
      return saved as IssueStatus;
    }
  } catch { /* localStorage 不可用(隐私模式等)就回默认,不拦列表 */ }
  return "active";
}

/** 问题处理导航的子页签(2026-09-11 拍板,spec #171):问题会话是缺省
 * 落点、排导航首位;问题登记/DTS 列表是发起域的两个面板，流水线修复从已有 MR 进入同一工作台。App 侧边栏
 * 展开组持有选择,本组件按它承接右侧页面。 */
export type IssueChildTab = "sessions" | "register" | "dts" | "pipeline";

export function IssueBoard({ viewer, onNavigateProfile, initialOpenId = "",
  onOpenIssue, onCloseIssue, childTab, onChildTabChange }: {
  viewer: AuthUser;
  onNavigateProfile?: () => void;
  /** 深链 /issues/:id 带进来的会话(通知点开、新页签打开即达):作
   * openId 唯一来源,浏览器后退/前进时也同步过来。App 层按当前 URL
   * 对表后下发;列表点卡不再走这里——卡片是纯链接,新页签自己带 URL。 */
  initialOpenId?: string;
  /** 页内切会话(ADR-0040):App 层统一写 issueRouteId + URL,
   * 本组件不直接操作 history。(历史触发者「挂起转正」已随 ADR-0048
   * 退役,管道保留给会话内换题。) */
  onOpenIssue: (id: string) => void;
  /** 返回列表(Esc/返回钮):URL 归位交给 App 层统一写。 */
  onCloseIssue: () => void;
  /** 当前子页签(App 持有并持久化;admin 恒为 sessions)。 */
  childTab: IssueChildTab;
  /** 子页签选择上报(App 写状态/持久化/历史快照)。 */
  onChildTabChange?: (tab: IssueChildTab) => void;
}) {
  const [issues, setIssues] = useState<IssueSummary[]>([]);
  /** DTS 发起成功的新会话(ADR-0040):「问题会话」子页签顶部的成功
   * 横幅内容——切换子页签后用户不至对着列表猜哪张是新发起的,单号
   * 可点直达工作台。再发起一批整体顶掉,「知道了」撤下。 */
  const [launchedNotice, setLaunchedNotice] = useState<IssueSummary[]>([]);
  const [openId, setOpenId] = useState(initialOpenId);
  // App 快照是工作台开关的唯一真相:URL 侧变化(浏览器后退/前进)
  // 同步过来,导航与右侧内容不错位。
  useEffect(() => { setOpenId(initialOpenId); }, [initialOpenId]);
  const [detail, setDetail] = useState<IssueDetail | undefined>();
  /** 详情拉取是否失败过(当前 openId):失败页给重试入口,加载指示
   * 停转;重试由 detailRetry 强制重跑。 */
  const [detailFailed, setDetailFailed] = useState(false);
  /** 详情强制重试计数:重试钮 +1 并入详情 effect 依赖——effect 只靠
   * [openId] 时同 id 重试不会重跑。 */
  const [detailRetry, setDetailRetry] = useState(0);
  const [error, setError] = useState("");
  const [statusFilter, setStatusFilter] = useState<IssueListFilter>(readIssueListFilter);

  const changeStatusFilter = (next: IssueListFilter) => {
    setStatusFilter(next);
    try { localStorage.setItem(ISSUE_FILTER_STORAGE_KEY, next); } catch { /* 同上,存不进就算了 */ }
  };

  const scopedIssues = childTab === "pipeline"
    ? issues.filter(issue => issue.scenario === "mr_repair") : issues;

  // 聚合徽章(与任务侧"当前任务"同款语义):待答复置前,需介入报警。
  // 按全量算,不跟着筛选走——告警不该因为翻历史就消失。
  const waitingCount = scopedIssues.filter((issue) =>
    issue.status === "waiting_user" || issue.status === "idle").length;
  const interventionCount = scopedIssues.filter((issue) =>
    issue.status === "failed").length;

  const statusCounts = new Map<IssueStatus, number>();
  for (const issue of scopedIssues) {
    statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  }
  // 「进行中」计数走 api 的 isIssueActive 单份口径,与侧栏父行徽章同源。
  const activeCount = scopedIssues.filter((issue) => isIssueActive(issue.status)).length;
  // 「等你答复」选项的计数含 idle(展示归一,计数同步归一)。
  const filterOptionCount = (status: IssueStatus) =>
    status === "waiting_user"
      ? (statusCounts.get("waiting_user") ?? 0) + (statusCounts.get("idle") ?? 0)
      : statusCounts.get(status) ?? 0;
  const visibleIssues = childTab === "pipeline" || statusFilter === "all" ? scopedIssues
    : statusFilter === "active"
      ? scopedIssues.filter((issue) => isIssueActive(issue.status))
      : scopedIssues.filter((issue) => statusFilter === "waiting_user"
          ? issue.status === "waiting_user" || issue.status === "idle"
          : issue.status === statusFilter);

  const refreshList = () => {
    // 单一列表(ADR-0031,2026-09-16 修订):服务端按「归属或登记人是
    // 自己」过滤,名下要推进的与登记给他人要跟踪的同列。
    void (childTab === "pipeline" ? listPipelineRepairs() : listIssues()).then(setIssues).catch(() => undefined);
  };
  useEffect(() => startVisiblePolling(refreshList, 5000, document), [childTab]);

  // URL 指向工作台时跟读详情;列表照常低频轮询。openId 变化即清旧
  // detail(上一会话的内容不许顶在新 URL 下),detailRetry 并入依赖
  // ——失败页的重试钮也靠它强制重拉。失败置 detailFailed 停转加载
  // 指示,错误面在工作台门内自渲染。
  useEffect(() => {
    if (!openId) {
      setDetail(undefined);
      setDetailFailed(false);
      return;
    }
    let alive = true;
    setDetail(undefined);
    setDetailFailed(false);
    void getIssue(openId).then((next) => {
      if (alive) setDetail(next);
    }).catch((reason) => {
      if (alive) {
        setError(String(reason instanceof Error ? reason.message : reason));
        setDetailFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [openId, detailRetry]);

  // 状态/阶段/待办卡的低频刷新;执行过程的实时跟随在现场页签自己订 SSE。
  useEffect(() => startVisiblePolling(() => {
    if (!openId) return;
    void getIssue(openId).then(setDetail).catch(() => undefined);
  }, 10000, document), [openId]);

  /** 返回列表:清本地 state,URL 归位交给 onCloseIssue 统一写。 */
  const backToList = () => {
    setOpenId("");
    setDetail(undefined);
    setError("");
    onCloseIssue();
  };

  // 渲染门(ADR-0040:工作台是 /issues/:id 的页面形态,不再叠在列表上):
  // URL 指向一个会话时整页只有工作台——内容匹配才渲染(根绝"URL 是 Y、
  // 页面渲染的是 X"的错位),详情在路上给加载态,拉取失败给重试与返回。
  if (openId) {
    if (detail?.id === openId) {
      return <IssueSessionView
        detail={detail}
        viewerUsername={viewer.username}
        onBack={backToList}
        onChanged={(next) => setDetail(next)}
        onListRefresh={refreshList}
        onError={setError}
        onNavigateProfile={onNavigateProfile}
        onOpenIssue={onOpenIssue}
      />;
    }
    if (detailFailed) {
      return <section role="alert"
        className="flex min-h-[70vh] flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="max-w-xl text-sm text-danger">
          打不开这个会话:{error || "会话不存在或已被删除"}。链接可能已过期。
        </p>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm"
            onClick={() => setDetailRetry((count) => count + 1)}>重试</Button>
          <Button type="button" variant="outline" size="sm"
            onClick={backToList}>返回问题列表</Button>
        </div>
      </section>;
    }
    return <section role="status"
      className="flex min-h-[70vh] items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner aria-hidden className="size-3 shrink-0" />
      <span>正在打开问题工作台…</span>
    </section>;
  }

  return <div className="grid gap-[18px]">
    {viewer.role !== "admin" && <IssueMrImport visible={childTab === "pipeline"} onCreated={issue => {
      refreshList(); onOpenIssue(issue.id);
    }} />}
    {/* #231 换装:看板壳(.issue-board/.issue-error 等 issue-board 家族)
        退役,直译成令牌工具类。 */}
    {error && childTab !== "pipeline" && <div role="alert"
      className="flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-danger/35 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
      <span>{error}</span>
      <span className="flex items-center gap-3">
        {onNavigateProfile && /未配置/.test(error)
          && <Button type="button" variant="link"
            className="h-auto px-0 font-normal text-danger underline underline-offset-2 hover:text-danger"
            onClick={onNavigateProfile}>
            去个人设置配置
          </Button>}
        <Button type="button" variant="link"
          className="h-auto px-0 font-normal text-danger underline underline-offset-2 hover:text-danger"
          onClick={() => setError("")}>知道了</Button>
      </span>
    </div>}
    {/* 发起入口仅开发者:管理员不发起问题会话(服务端对 admin POST 直接
        403),管理视角的这块板只读——列表全员可见,会话点开落查看模式。
        两面板常驻(visible 隐藏切换):「问题会话」子页签下也不卸载,
        表单/勾选/搜索状态跨子页签驻留(spec #171)。 */}
    {viewer.role !== "admin" && childTab !== "pipeline" && <IssueRegistration
      viewer={viewer}
      issues={issues}
      visible={childTab === "register" || childTab === "dts"}
      panel={childTab === "dts" ? "dts" : "manual"}
      // 登记成功后的进台方式分两路(ADR-0040):手工登记不自动跳
      // (成功横幅里给「打开问题会话」链接,登记完成即撒手),只刷
      // 列表;DTS 发起(单张/批量同路)当前页切到「问题会话」子页签,
      // 顶部横幅列出新会话、单号可点直达工作台。
      onRegistered={refreshList}
      onLaunched={(created) => {
        refreshList();
        setLaunchedNotice(created);
        onChildTabChange?.("sessions");
      }}
      onError={setError}
      onNavigateProfile={onNavigateProfile}
    />}
    <section aria-labelledby="issue-mine-title"
      hidden={childTab !== "sessions" && childTab !== "pipeline"}
      className="rounded-[14px] border border-line bg-surface px-[18px] py-4 max-[680px]:px-3 max-[680px]:py-3">
      {/* 发起成功横幅(ADR-0040):DTS 发起切过来后第一眼就能确认
          "发起成了",单号链接新页签直达对应工作台(与卡片同款通道)。 */}
      {launchedNotice.length > 0 && <div role="status"
        className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-success/35 bg-success-soft px-3.5 py-2.5 text-sm text-success">
        <span>已发起 {launchedNotice.length} 个问题会话,点单号打开:</span>
        {launchedNotice.map((item) => <a key={item.id}
          className="font-semibold underline underline-offset-2 hover:underline"
          href={issueSessionPath(item.id)} target="_blank" rel="noreferrer"
          title={`打开问题工作台:${item.title}`}>
          {item.ticket || item.id} ↗
        </a>)}
        <Button type="button" variant="link"
          className="ml-auto h-auto px-0 font-normal text-success underline underline-offset-2 hover:text-success"
          onClick={() => setLaunchedNotice([])}>知道了</Button>
      </div>}
      <div className="mb-3 flex items-baseline justify-between gap-4 max-[680px]:flex-col max-[680px]:items-stretch">
        <div>
          {/* kicker 不再重复页首大标题「问题处理」;列表区自己只有标题。
              单一列表(ADR-0031,2026-09-16 修订):归属或登记人是自己,
              名下的与登记给别人的同列,卡上两端标注可辨。 */}
          <h2 id="issue-mine-title">{childTab === "pipeline" ? "我的流水线修复记录" : viewer.role === "admin" ? "全部问题" : "我的问题"}</h2>
        </div>
        {/* 聚合徽章与任务侧"当前任务"同款语义:待答复置前,需介入报警。 */}
        <span className="flex flex-wrap items-center justify-end gap-3">
          {childTab !== "pipeline" && <><label className="inline-flex items-center gap-1.5">
            <span className="text-[13px] font-bold text-muted-foreground">状态</span>
            <Select value={statusFilter}
              items={[{ value: "active", label: `进行中(${activeCount})` },
                ...ISSUE_FILTER_STATUSES.map((status) => ({
                  value: status, label: `${ISSUE_STATUS_TEXT[status]}(${filterOptionCount(status)})`,
                })),
                { value: "all", label: `全部(${scopedIssues.length})` }]}
              onValueChange={(value) =>
                changeStatusFilter((value ?? "active") as IssueListFilter)}>
              <SelectTrigger aria-label="按状态筛选问题会话"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="active">
                    进行中({activeCount})
                  </SelectItem>
                  {ISSUE_FILTER_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {ISSUE_STATUS_TEXT[status]}({filterOptionCount(status)})
                    </SelectItem>
                  ))}
                  <SelectItem value="all">全部({scopedIssues.length})</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </label>
          {waitingCount > 0 && <span className="text-[13px] font-medium tabular-nums text-attention">
            {waitingCount} 项待答复</span>}
          {interventionCount > 0 && <span className="text-[13px] font-medium tabular-nums text-danger">
            {interventionCount} 项需介入</span>}
          </>}<span className="text-[13px] font-medium tabular-nums text-muted-foreground">共 {visibleIssues.length} 个</span>
          {childTab !== "pipeline" && statusFilter === "active" && scopedIssues.length > visibleIssues.length
            && <span className="text-[13px] font-medium tabular-nums text-muted-foreground"
              title="已归档/已取消默认收起,把状态切到对应标签或「全部」可查看">
              已收起 {scopedIssues.length - visibleIssues.length} 个</span>}
        </span>
      </div>
      {/* 打开过渡态已随页内 overlay 通道退役(ADR-0040):点卡开新页签,
          加载/失败态由 /issues/:id 页面形态自己承担(见上方渲染门)。 */}
      {scopedIssues.length === 0
        ? <Empty className="min-h-40 border">
            <EmptyMedia className="text-2xl font-light text-muted-foreground" aria-hidden>✓</EmptyMedia>
            <EmptyTitle>{childTab === "pipeline" ? "还没有流水线修复记录" : viewer.role === "admin" ? "团队还没有问题会话" : "还没有问题会话"}</EmptyTitle>
            <EmptyDescription>{childTab === "pipeline" ? "粘贴上方 MR 链接，即可在这里修复流水线，记录不计入 DTS 交付数据。" : viewer.role === "admin"
              ? "开发成员从各自的问题处理页登记后,这里会汇总全员会话供查看。"
              : "从上方「问题登记」登记问题并指派责任人,或从 DTS 拉取问题单发起处理;自己登记给别人的和名下推进的都在这里,研究结论是非问题也可以直接归档收口。"}</EmptyDescription>
          </Empty>
        : visibleIssues.length === 0
          ? <Empty className="min-h-40 border">
              <EmptyMedia className="text-2xl font-light text-muted-foreground" aria-hidden>✓</EmptyMedia>
              <EmptyTitle>{statusFilter === "active"
                ? "没有进行中的问题会话" : "这个状态下没有问题会话"}</EmptyTitle>
              <EmptyDescription>{statusFilter === "active"
                ? "已归档与已取消默认收起;要翻历史,把上方状态切到对应标签或「全部」。"
                : "可以切回「全部」继续查看,会话没有丢。"}</EmptyDescription>
            </Empty>
          : <div className="grid gap-2">
            {visibleIssues.map((issue) => <IssueCard
              key={issue.id}
              issue={issue}
              onSettled={refreshList}
            />)}
          </div>}
    </section>
  </div>;
}

/** 问题列表卡(2026-09-11 拍板整卡直达;ADR-0040 起直达改为新页签):
 * 整卡是一枚拉伸锚点(absolute inset-0 盖满卡面,target="_blank" 打开
 * /issues/:id)——列表不再就地展开(现场直播/耗时卡点随展开移除,现场
 * 只在工作台看),右侧无展开箭头,meta 行只留直达终止(2026-09-08)与
 * MR/推送事实。卡内的 DTS 单号链接与终止/MR 动作以 relative z-10 浮在
 * 拉伸锚点上方:兄弟不嵌套(锚点嵌锚点是非法 HTML),点击各走各的门。
 * 皮肤换 shadcn Card + Tailwind 令牌工具类,与需求侧 task-card 骨架
 * 分道(混合列表口子一并撤销);内部行(overline/焦点行/阶段条)沿用
 * 既有独立类,issue-card-large 类保留作问题域胶囊配色与等待光效的
 * 锚点。焦点行只复述 API 字段(stage/round/stage_note),前端不推断状态。 */
function IssueCard({ issue, onSettled }: {
  issue: IssueSummary;
  /** 终止成功后通知列表刷新(2026-09-08:列表卡直达终止,不再进工作台)。 */
  onSettled?: () => void;
}) {
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState("");
  // 终止确认框(#541):与工作台头部同一份 CancelSessionDialog(下拉式
  // 原因必选);「返回」无副作用,确认才发 cancel 并带原因。
  const [stopOpen, setStopOpen] = useState(false);
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note} ` : "",
  ].join("");
  // 终态(已归档/已取消)没有可终止的东西,按钮不渲染;failed 仍可终止
  // 清理——与工作台头部「终止会话」同一口径。
  const terminatable = issue.status !== "archived" && issue.status !== "canceled";

  function terminate() {
    if (issue.scenario === "mr_repair") { void terminateWithReason({} as CancelSessionInput); return; }
    setStopOpen(true);
  }

  async function terminateWithReason(input: CancelSessionInput) {
    setStopOpen(false);
    setStopping(true); setStopError("");
    try {
      await controlIssue(issue.id, {
        action: "cancel",
        reason: input.reason,
        ...(input.reasonText ? { reason_text: input.reasonText } : {}),
      });
      onSettled?.();
    } catch (cause) {
      setStopError(String((cause as Error).message ?? cause));
    } finally { setStopping(false); }
  }

  // 状态轨颜色:问题域状态 → 令牌工具类(旧 .status-* rail 规则随
  // task-card 皮退役;queued/archived/canceled 无轨,与旧规则一致)。
  const railClass = {
    running: "bg-active",
    waiting_user: "bg-attention",
    idle: "bg-ink",
    failed: "bg-danger",
  }[issue.status as "running" | "waiting_user" | "idle" | "failed"]
    ?? "bg-transparent";

  return <Card id={`issue-${issue.id}`}
    className={cn(
      "issue-card-large",
      `status-${issue.status}`,
      "relative overflow-hidden rounded-lg",
      "transition-colors hover:border-line-strong",
      "border-line",
    )}>
    {/* 拉伸锚点(ADR-0040):整卡去问题工作台,新页签打开;排在卡内
        第一个,Tab 序先于单号/终止/MR 等卡内动作。 */}
    <a className="absolute inset-0 z-[1]"
      href={issueSessionPath(issue.id)}
      target="_blank" rel="noreferrer"
      aria-label={`在新页签打开问题工作台:${issue.title}`}
      title="在新页签打开问题工作台" />
    <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px]", railClass)} />
    <div className="task-summary">
      <span className="task-summary-body">
        <span className="task-overline">
          {/* 单号直达 DTS 门户:relative z-10 浮在拉伸锚点上方(兄弟
              关系,各点各的,无需拦事件);链接皮(主色+
              悬停下划线)与登记页 DTS 列表同款——纯文字外观看不出能点。 */}
          {issue.ticket
            ? <a className="task-ticket relative z-10 text-primary
                underline-offset-2 hover:underline" href={dtsTicketUrl(issue.ticket)}
                target="_blank" rel="noreferrer"
                title={`在 DTS 门户打开 ${issue.ticket}`}>
              {issue.ticket}
            </a>
            : <span className="task-ticket empty">未绑单</span>}
          <span className="task-id" title="会话编号">{issue.id}</span>
          <IssueStatusBadge status={issue.status}>
            {issueStatusText(issue)}
          </IssueStatusBadge>
          <span className="task-created">{formatLocalDateTime(issue.updated_at)}</span>
        </span>
        <strong className="task-title line-clamp-1">{issue.title}</strong>
        <span className="task-ownership">
          {/* 责任人(ADR-0031):归属=推进人;登记人≠责任人时并列展示
              ——推进与跟踪两个视角都能一眼看到问题的两端。 */}
          <span>责任人 · {issue.account}</span>
          {issue.reporter && issue.reporter !== issue.account
            && <span>登记人 · {issue.reporter}</span>}
          <span>{issue.source === "dts" ? "DTS 单" : "自研问题"}</span>
        </span>
        {/* 焦点行:旧焦点行 CSS 家族随 style.css 退役后此处断供(#256
            清扫确凿丢失),版式按二期口径在 markup 直译 utilities——三列
            网格:6px 状态点(--active)/阶段强字/结论省略。旧阶段变体
            (human_action/blocked 等)是任务域词表,从未命中问题域 stage,
            不搬;旧类名一并退役。 */}
        <span className="mt-2 grid min-w-0 grid-cols-[7px_max-content_minmax(0,1fr)] items-center gap-[7px] text-sm text-muted-foreground">
          <i aria-hidden className="size-1.5 rounded-full bg-active" />
          <strong className="text-sm font-bold text-text-strong">{stageLine}</strong>
          {issue.conclusion && <span className="truncate">结论 · {issueConclusionText(issue)}</span>}
        </span>
        <IssueFixedProgress issue={issue} />
      </span>
    </div>

    {/* meta 行整体浮在拉伸锚点上方:终止钮与 MR 链接可点,信息文字
        吞掉点击(与旧形态一致——点 meta 文字不开工作台)。 */}
    <div className="task-meta relative z-10">
      {/* 列表直达终止(2026-09-08):不必进工作台再点;确认框(#541)与
          工作台头部同用一份 CancelSessionDialog。终态卡不渲染。 */}
      {terminatable && <Button type="button" variant="ghost" size="sm"
        className="h-auto px-0 font-semibold text-destructive underline-offset-2 hover:bg-transparent hover:underline"
        disabled={stopping} onClick={() => void terminate()}>
        {stopping ? "终止中…" : issue.scenario === "mr_repair" ? "停止" : "终止"}</Button>}
      {stopError && <span className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{stopError}</span>}
      {/* 多 MR 摘要:一仓一 MR,每个仓的 MR 各占一个链接(仓名 + iid),
          不再只显首个;没拿到 url 的(创建中途)如实落回文本。 */}
      {issue.mrs?.map((mr) => {
        const label = `${repoName(mr.repo)}${mr.iid ? ` !${mr.iid}` : ""}`;
        return mr.url
          ? <a key={mr.repo} href={mr.url} target="_blank" rel="noreferrer"
              title={`${mr.title}(分支 ${mr.branch})`}>
              <span>MR · {label}</span>
              <svg viewBox="0 0 16 16" aria-hidden>
                <path d="M6 3.5h6.5V10M12.25 3.75 5 11" />
              </svg>
            </a>
          : <span key={mr.repo} className="meta-fact"
              title={mr.title}>MR · {label}(分支 {mr.branch})</span>;
      })}
      {(issue.pushes?.length ?? 0) > 0 && <span className="meta-fact">
        {issue.pushes!.length === 1
          ? `已推送 · ${issue.pushes![0].branch}@${issue.pushes![0].sha.slice(0, 10)}`
          : `已推送 · ${issue.pushes!.length} 个仓`}</span>}
      {issue.error && <span className="meta-fact">{issue.error.slice(0, 80)}</span>}
    </div>

    {/* 终止会话确认框(#541):与工作台头部同一份下拉式弹窗;终止发起中
        禁开合防重。联动提示(ADR-0072)的单号与已排除旗标来自卡片摘要。 */}
    <CancelSessionDialog open={stopOpen} busy={stopping}
      ticket={issue.ticket} autoClaimExcluded={issue.auto_claim_excluded}
      onOpenChange={setStopOpen} onConfirm={(input) => void terminateWithReason(input)} />
  </Card>;
}

function issueConclusionText(issue: IssueSummary): string {
  // 词表收敛后只有三档(ADR-0037):修复完成即 delivered,合入与否
  // 看 mrs 账,不再有"已修复未合入"细分。
  const kind = issue.conclusion?.kind;
  return kind === "non_issue" ? "非问题"
    : kind === "issue" ? "问题成立"
    : "已交付";
}
