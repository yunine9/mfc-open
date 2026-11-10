import { issueApiUrl } from "./issueLink";
import { IssueExternalReviewPanel, externalReviewDone, useIssueReviews } from "./IssueExternalReviewPanel";
/**
 * 会话域:会话工作台全屏视图(头部 / 阶段线 / 逐仓交付 / 耗时卡点 / 双栏)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 工作台无条件画固定流程计划线(IssueFixedProgress,列表卡也复用;
 * #98 单路径化:不再感知"模式",自由旅程线已删)。左栏(#123 拍平)
 * 是六个一级标签直排——页签条在本文件,材料子视图内容免壳直渲自
 * MaterialsPane.tsx、现场直播在 EventsPane.tsx、MR 检视批注在
 * IssueExternalReviewPanel.tsx(2026-09-17 收编第六签,ADR-0027 修订)。
 * 右栏旧 NEXT ACTION 侧栏已随 #127 整体拆除:归档/终止入头部控件区、
 * 状态说明由头部徽标与协作流承载。
 *
 * 查看模式(docs/issue-session-view-mode.md):登录用户 ≠ 会话归属人
 * 即只读围观——四个信息面(概要+时间线、材料只读浏览、事件流直播、
 * 耗时卡点——已随 2026-09-11 拍板退役,见文件尾注释)完整保留,全部
 * 操作控件不渲染(不是点了报错),顶部一条
 * 「查看模式」标识。归属人打开自己的会话零行为变化。
 */
import { useEffect, useState } from "react";
import {
  GIT_AUTH_ERROR_TAG,
  addIssueTakeoverNote,
  answerIssue,
  attachIssueEnvironment,
  controlIssue,
  fixedStageList,
  getIssue,
  isIssueActive,
  issueStatusText,
  issueStageText,
  replyIssue,
  resumeIssueTakeover,
  steerIssue,
  takeoverIssue,
  type IssueDetail,
  type IssueEnvironmentForm,
  type IssueStageState,
  type IssueSummary,
} from "../api";
import { IssueWaitingFacts } from "./IssueWaitingFacts";
import { IssueCodeOriginPanel } from "./CodeOriginPanel";
import { IssueWarmupLive } from "./IssueWarmupLive";
import { TicketTemplateCard } from "./TicketTemplateCard";
import { IssueDecisionCard } from "./IssueDecisionCard";
import { IssueConversationStream } from "./IssueConversationStream";
import { IssueMaterialsPane } from "./MaterialsPane";
import { IssueEventsPane } from "./EventsPane";
import { IssueMetaPane } from "./MetaPane";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IssueStatusBadge } from "../StatusBadge";
import { CancelSessionDialog, type CancelSessionInput } from "./CancelSessionDialog";
import { cn } from "cn";

/** 左栏六个一级标签(ADR-0027 五签定局,2026-09-17 修订增第六签):
 * 「MR 检视」收编原页签容器上方的 MR 检视批注面板(挤占首屏,走查拍板
 * 下场),有批注才现身、有待判断挂脉冲点——持续检视面板随流水线显示面
 * 撤除同步退役(问题流反馈账只写流水线与 MR 讨论,前者不再上屏、后者
 * 本就不在面板里,面板恒空);流水线本身要看去 CodeHub。其余五签与
 * ADR-0027 定局一致:对话现场降末位、默认签改元信息——右栏协作流常驻
 * 直播兜住「看现场」的刚需,右栏工具步骤的「对话现场」跳转按钮是完整
 * 事件流的唯一入口;DTS 单据签无单整体隐藏,#239 起「元信息」居首)。
 * 页签条复用任务侧 ws-pane-head > ws-source-switch 同构,一签一色走
 * --workspace-tab-color(#231 换装:色值直译成各签自带的变量工具类,
 * 字面量在此便于 Tailwind 拾取)。 */
const ISSUE_MAIN_TABS = [
  { key: "meta", label: "元信息", tone: "[--workspace-tab-color:#2f8a5f]" },
  { key: "dts", label: "DTS单据", tone: "[--workspace-tab-color:#d28a31]" },
  { key: "doc", label: "分析报告", tone: "[--workspace-tab-color:#20a28f]" },
  { key: "changes", label: "工作区变更", tone: "[--workspace-tab-color:#3b83d5]" },
  { key: "events", label: "对话现场", tone: "[--workspace-tab-color:#7566df]" },
  { key: "reviews", label: "MR 检视", tone: "[--workspace-tab-color:#c2554f]" },
] as const;
type IssueMainTab = (typeof ISSUE_MAIN_TABS)[number]["key"];

/** 轮次徽标(#231 换装,原 .issue-round-badge 琥珀 pill 直译):列表卡
 * 计划线与工作台头部进度共用。 */
const ROUND_BADGE = "rounded-full border border-attention/40 bg-attention/10 px-2 py-0.5 text-xs font-bold text-attention";

export function IssueSessionView({
  detail,
  viewerUsername,
  onBack,
  onChanged,
  onListRefresh,
  onError,
  onNavigateProfile,
  onOpenIssue,
}: {
  detail: IssueDetail;
  /** 当前登录用户名:与会话归属人(detail.account)比对出查看模式。
   * 缺席(auth 关闭的演示形态)按可操作处理,保持既有行为。 */
  viewerUsername?: string;
  onBack: () => void;
  onChanged: (detail: IssueDetail) => void;
  onListRefresh: () => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
  /** 页内切会话(ADR-0040):会话内换题时当前页签直切不新开
   * (历史触发者「挂起转正」已随 ADR-0048 退役)。 */
  onOpenIssue: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  // 卡座 dock(#125):输入区 ws-reply-dock 容器的节点。dockRef 交给右栏
  // 协作区,节转成 footerTarget 发给当前卡——卡的提交区(附言+提交/
  // 拒绝按钮)经 portal 挂进输入区;无卡/查看模式时它保持 null,提交区
  // 原位渲染或干脆不出(查看模式事实卡无提交区)。
  const [decisionFooterTarget, setDecisionFooterTarget] =
    useState<HTMLDivElement | null>(null);
  // 左栏页签(ADR-0027 五签):默认「元信息」(会话名片,首屏回答
  // "这是什么会话、到哪一步了"),用户手选优先;换会话重置。看 AI 干活
  // 有两条常驻路:右栏协作流的直播,和「对话现场」末签(右栏工具步骤
  // 的跳转按钮直达)。
  const [tab, setTab] = useState<IssueMainTab>("meta");

  useEffect(() => {
    // 换一个会话就丢弃手选页签,回到默认入口(元信息)。
    setTab("meta");
  }, [detail.id]);

  // 页签标题(ADR-0040):工作台独占浏览器页签,标题钉成会话标题——
  // 不带单号(2026-09-18 修订:单号记不住,多开辨识靠标题),卸载还原
  // 默认标题。
  useEffect(() => {
    const previous = document.title;
    document.title = detail.title;
    return () => { document.title = previous; };
  }, [detail.title]);

  useEffect(() => {
    // 工作台是 /issues/:id 的页面形态(ADR-0040,workspace-overlay 全屏
    // 骨架原样):锁页面滚动,Escape 直接回到列表——现场面积优先,
    // 少一次瞄准返回钮。
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  // 查看模式判定:登录用户 ≠ 会话归属人即只读围观。口径是问题域自己的
  // 「人人可看、归属人操作」(CONTEXT.md「查看模式」),管理员不例外——
  // 「管理员不处理问题单」的边界不因可见性放开而变(与任务侧 canOperate
  // 的差异:那边管理员可操作,这边明说不写)。viewer 缺席(auth 关闭的
  // 演示形态)按可操作处理,保持既有行为。
  const canOperate = !viewerUsername || viewerUsername === detail.account;

  // MR 检视批注的账(5s 可见轮询)在会话层常驻:「MR 检视」页签的
  // 在场与脉冲点靠它,页签没开也要轮(ADR-0027 修订,2026-09-17)。
  const reviews = useIssueReviews(detail.id);
  const reviewsPending = reviews.items
    .filter(item => !externalReviewDone(item)
      && item.status === "draft" && !item.agent_assigned).length;
  // 「MR 检视」签有批注才现身;正被看着时即便批注清空也留(空态自己说)。
  const showReviewsTab = reviews.items.length > 0 || tab === "reviews";

  async function perform(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    try {
      await action();
      const next = await getIssue(detail.id);
      onChanged(next);
      onListRefresh();
      return true;
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // 等待卡两源:平台闸(固定流程的人工硬闸)优先,Agent 问题卡兜底;
  // 决策卡在卡在场时画。闸卡的分寸(2026-09-08):env_needed 在工具
  // 举起闸的瞬间就出卡,不等回合收口的状态翻转——模型收口后仍可继续
  // 不需要环境的工作,用户填卡/拒绝与它并行;其余闸都在阶段边界举起、
  // 状态随即翻转,照旧只在 waiting_user 画。终态不出现卡。
  // gate_kind/scope 随卡带给决策卡:env_needed 换专用环境表单,
  // skill_select 换多选圈选卡(ADR-0011),pipeline_unfixable/
  // pipeline_evidence 换流水线红灯人工卡(票 03),gate_pipeline 带
  // 闸归属的仓与提交。
  const envGateLive = detail.gate?.kind === "env_needed"
    && ["running", "idle", "waiting_user"].includes(detail.status);
  const gateCard = (detail.status === "waiting_user" || envGateLive)
    && detail.gate
    ? {
        waiting_id: detail.gate.id,
        state_version: detail.gate.state_version,
        question: detail.gate.question,
        context: detail.gate.context,
        created_at: detail.gate.created_at,
        gate_kind: detail.gate.kind,
        gate_scope: detail.gate.scope,
        gate_skills: detail.gate.skills,
        gate_pipeline: detail.gate.pipeline,
      }
    : undefined;
  const waiting = gateCard
    ?? (detail.status === "waiting_user" ? detail.waiting : undefined);

  /** 问题卡作答:decision=人话文本;code=平台闸决策码(裁决协议);
   * answers=Agent 卡逐题作答(码或自由文本);selection=skill 圈选闸
   * 的勾选清单(ADR-0011)。统一经 answerIssue 提交。 */
  async function answer(
    decision: string,
    code?: string,
    answers?: Record<string, string>,
    notes?: string,
    selection?: string[],
  ): Promise<boolean> {
    if (!waiting) return false;
    return perform(() => answerIssue(detail.id, {
      state_version: waiting.state_version,
      decision,
      ...(code ? { code } : {}),
      ...(answers ? { answers } : {}),
      ...(notes ? { notes } : {}),
      ...(selection ? { selection } : {}),
    }));
  }
  /** env_needed 闸的专用提交口(POST /issues/:id/environment):密码只在
   * 这一次请求里过网、只进服务端 vault,成功后 perform 会带新详情回来。 */
  const attachEnvironment = (input: IssueEnvironmentForm) =>
    perform(() => attachIssueEnvironment(detail.id, input));
  const sendReply = (text: string) => perform(() => replyIssue(detail.id, text));
  const sendSteer = (text: string) => perform(() => steerIssue(detail.id, text));
  /** 人工接管三回调(2026-09-07 走查拍板)。接管/交还走 perform:成功
   * 后带新详情回来(徽标与输入区模式随之翻转);人工记录不走 perform
   * ——perform 会吞错,记录失败要让输入区当场报错保字。 */
  const takeoverNow = () => perform(() => takeoverIssue(detail.id));
  const sendTakeoverNote = (text: string) =>
    addIssueTakeoverNote(detail.id, text).then(() => undefined);
  const resumeTakeover = (note?: string) =>
    perform(() => resumeIssueTakeover(detail.id, note));
  // 终止会话(#541):确认框改下拉式(原因五选一必选,选「其他原因」
  // 展开选填说明),不再用 confirmDialog(它没有选择位)。弹窗本体是
  // CancelSessionDialog,与列表卡片入口共用同一份;「返回」无副作用,
  // 确认才发 cancel 并带原因。防重沿用既有 busy 闸;后端拒绝经
  // perform 落 onError 既有通道。
  const [cancelOpen, setCancelOpen] = useState(false);
  function cancelSession() {
    if (detail.scenario === "mr_repair") { void perform(() => controlIssue(detail.id, { action: "cancel" })); return; }
    setCancelOpen(true);
  }
  function cancelWithReason(input: CancelSessionInput) {
    setCancelOpen(false);
    void perform(() => controlIssue(detail.id, {
      action: "cancel",
      reason: input.reason,
      ...(input.reasonText ? { reason_text: input.reasonText } : {}),
    }));
  }

  // 异常重跑(ADR-0055,#430):failed 会话的第二出口——原地复活续跑,
  // 不取消、不动问题单目录,分析报告/检视意见/人工决定/代码现场全在,
  // AI 接回原上下文继续推进。与「重新发起」是两条路:重新发起会新开
  // 问题单目录、现场断代;工作台没有重新发起入口,差别讲在确认框正文,
  // 防止想重做的人误以为只有丢现场一条路。说明可留空,空则服务端用
  // 默认词「操作者确认异常已排除,继续推进」;确认框不用 confirmDialog
  // (它没有输入位),走 Dialog 自带说明输入。防重沿用既有 busy 闸
  // (发起中按钮禁用);后端拒绝(状态已变等)经 perform 落 onError
  // 既有通道,不在框内另造报错面。
  const [reviveOpen, setReviveOpen] = useState(false);
  const [reviveNote, setReviveNote] = useState("");
  function reviveSession() {
    const note = reviveNote.trim();
    setReviveOpen(false);
    void perform(() => controlIssue(detail.id, {
      action: "revive",
      ...(note ? { note } : {}),
    }));
  }

  // 全屏工作台(ADR-0018 骨架对齐):复用任务侧 studio 骨架——ws-head
  // 头部(返回/身份/进度/操作)+ ws-body 两栏(左 ws-evidence 工作区、
  // 右 ws-side 协作)。ADR-0040 起是 /issues/:id 的页面形态(不再是叠在
  // 列表上的弹层):模态语义退役,视觉骨架(全屏 fixed)原样——同构
  // 不再依赖跨页皮肤。
  // 左栏已按 #123 拍平成六个一级标签,右栏是 #124 的协作对话框(会话
  // 流+输入区);旧 NEXT ACTION 侧栏已按 #127 拆除。
  return <section
    className={cn(
      "workspace-overlay task-workspace-v2 workspace-studio px-4",
      // 问题域主题:studio 组件在问题工作台内一律取问题域变量,同构不同色。
      "[--studio-accent:var(--accent)] [--studio-tint:var(--accent-soft)] [--workspace-tab-color:var(--accent)]",
    )}
    aria-label={`${detail.scenario === "mr_repair" ? "流水线修复" : "问题会话"}:${detail.title}`}>
    <header className={cn("ws-head", detail.scenario === "mr_repair" && "[grid-template-columns:auto_minmax(0,1fr)_auto]! [grid-template-areas:'back_identity_controls']!")}>
      <button type="button" className="ws-back" onClick={onBack}
        title={detail.scenario === "mr_repair" ? "返回流水线修复(Esc)" : "返回问题列表(Esc)"} aria-label={detail.scenario === "mr_repair" ? "返回流水线修复(Esc)" : "返回问题列表(Esc)"}>←</button>
      <div className="ws-identity">
        <strong>{detail.title}</strong>
        <div className="ws-identity-line">
          {detail.scenario === "mr_repair" && <Badge variant="info" title="从已有 MR 直接进入修复；拉单、分析和问题修改等前置阶段不适用">流水线修复工具 · 独立记录</Badge>}
          {/* 查看模式标识(非归属人围观):徽标走 Badge warning 软皮
              (中性琥珀,只提示不告警),文本即 aria 信息(读屏直读)。 */}
          {!canOperate && <Badge variant="warning" role="status"
            title="你正在查看归属人的问题会话:操作控件已隐藏,信息面完整可看">
            查看模式:归属人 {detail.account} 的会话
          </Badge>}
          {/* 自动接单徽标(ADR-0061):发起方式=自动的展示标记——流程
              语义与人工发起完全一致,徽标只回答"这单是谁发起的"。 */}
          {detail.auto_claim
            && <Badge variant="info" title="平台定时扫描自动发起(自动接单):校验链与人工发起同尺,推进仍按责任人介入档位">自动接单</Badge>}
          <IssueStatusBadge status={detail.status}>
            {issueStatusText(detail)}
          </IssueStatusBadge>
          {/* 人工接管徽标(2026-09-07 走查拍板):横幅态独立于六态——
              在场即「AI 已暂停、人工作业中」,排在状态徽标之后;紫金
              横幅语义收进 Badge merge 软皮。 */}
          {detail.takeover
            && <Badge variant="merge">人工接管中</Badge>}
          {/* 一次结果章(仅修复完成归档的会话有,服务端按两轴同口径
              判定后下发):定位=报告一版过,修复=验证零失败;绿章=一次
              过,红章=经过返工。无单/非交付会话不带字段,自然不渲染。 */}
          {detail.once_outcome && <>
            <Badge variant={detail.once_outcome.localization_pass
              ? "success" : "destructive"}
              title="一次定位:分析报告一版过(与团队页一次定位成功率同口径)">
              一次定位{detail.once_outcome.localization_pass ? "✓" : "✗"}
            </Badge>
            <Badge variant={detail.once_outcome.repair_pass
              ? "success" : "destructive"}
              title="一次验证:验证不通过次数=0 即一次验证;未答卡=通过(合入即通过)">
              一次验证{detail.once_outcome.repair_pass ? "✓" : "✗"}
            </Badge>
          </>}
          <span className="text-xs text-muted-foreground">
            {issueStageText(detail)}
            {detail.round && detail.round > 1 ? `(第 ${detail.round} 轮)` : ""}
            {detail.stage_note ? ` · ${detail.stage_note}` : ""}
          </span>
          {/* 登记元信息的网管环境常驻上屏(问"问题发生在哪个网管"不用翻
              现场;密码本体只在 vault)。 */}
          {detail.environment && <span className="text-xs text-muted-foreground"
            title={detail.environment.environment_source_ip
              ? "来自环境管理台账的选定时点快照(密码在平台加密保管,不上屏)"
              : "登记元信息里的网管环境(密码在平台加密保管,不上屏)"}>
            {detail.environment.environment_source_ip ? "来自环境管理" : "网管环境"}
            {` ${detail.environment.hosts.join("、")}`}
            {` · 端口 ${detail.environment.port}`}
          </span>}
          {/* 单号是同事间要抄的关键对象:select-text 强制放开拖选
              (原 .issue-ticket 的 user-select 规则随家族退役)。 */}
          {detail.ticket
            ? <span className="select-text rounded-full bg-primary/10 px-[7px] py-px font-mono text-xs font-bold text-primary">{detail.ticket}</span>
            : <span className="select-text rounded-full border border-dashed px-[7px] py-px font-mono text-xs font-bold text-faint">{detail.scenario === "mr_repair" ? "已有 MR" : "无单场景"}</span>}
        </div>
      </div>
      {detail.scenario !== "mr_repair" && <div className="ws-progress">
        <IssueWorkspaceProgress issue={detail} />
      </div>}
      <div className="ws-head-controls">
        <Button type="button" variant="outline" size="sm" disabled={busy}
          title="导出现场记录(Markdown:人粗读 + AI 精读复盘)"
          onClick={() => {
            // 同源 GET 自带 cookie,download 属性强制落盘;文件名本地拼,
            // 服务端 disposition 只对 curl/直连生效。
            const anchor = document.createElement("a");
            anchor.href = issueApiUrl(`/issues/${detail.id}/export`);
            anchor.download = `${detail.id}-现场记录-`
              + `${new Date().toISOString().slice(0, 10)}.md`;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
          }}>导出现场记录</Button>
        {/* 终止/异常重跑(#127 自右栏侧栏栏脚迁入,与导出并列):确认弹窗
            语义(#541 起终止走下拉式 CancelSessionDialog);手动归档已退役
            (ADR-0034/0057)——交付出口是合入自动归档,无单结论在 conclude
            卡当场闭环;终止都是写操作,查看模式整组不渲染。 */}
        {canOperate && <>
          {/* 异常重跑(#430,ADR-0055):仅异常(失败)会话出现,与终止
              并排——failed 状态下的两个出口:原地续跑 or 放弃终止。
              发起中(busy)禁用防重;确认框与说明输入见 header 之后。 */}
          {detail.status === "failed" && <Button type="button" size="sm"
            disabled={busy}
            title="原地续跑:分析报告、检视意见、人工决定、代码现场全在,AI 接回原上下文继续推进"
            onClick={() => { setReviveNote(""); setReviveOpen(true); }}>异常重跑</Button>}
          <Button type="button" variant="destructive" size="sm" disabled={busy
            || ["archived", "canceled"].includes(detail.status)}
            onClick={cancelSession}>{detail.scenario === "mr_repair" ? "停止修复" : "终止会话"}</Button>
        </>}
      </div>
    </header>

    {/* 终止会话确认框(#541):下拉式原因必选,与列表卡片入口同一份
        CancelSessionDialog;「返回」无副作用,确认才发 cancel。联动提示
        (ADR-0072)的单号与已排除旗标来自详情投影。 */}
    <CancelSessionDialog open={cancelOpen} busy={busy}
      ticket={detail.ticket} autoClaimExcluded={detail.auto_claim_excluded}
      onOpenChange={setCancelOpen} onConfirm={cancelWithReason} />

    {/* 异常重跑确认框(#430,ADR-0055):一句话说明可留空;确认即调
        control revive。正文讲清与「重新发起」的差别(原地续跑全现场
        vs 新开目录现场断代)——工作台没有重新发起入口,这里是唯一
        讲差别的地方。busy 时确认钮禁用,防状态在途重复发起。 */}
    <Dialog open={reviveOpen}
      onOpenChange={(open) => { if (!busy) setReviveOpen(open); }}>
      <DialogContent aria-label="异常重跑确认">
        <DialogHeader>
          <DialogTitle>异常重跑</DialogTitle>
          <DialogDescription>
            确认异常已排除后原地续跑：不取消会话、不动问题单目录，分析报告、检视意见、人工决定、代码现场全部保留，AI 接回原上下文继续推进。这与「重新发起」不同——重新发起会新开问题单目录、现场断代；本会话的恢复路只有异常重跑这一条。
          </DialogDescription>
        </DialogHeader>
        <Input value={reviveNote}
          onChange={(event) => setReviveNote(event.target.value)}
          placeholder="可附一句话说明，随恢复回合送达 AI（可留空）"
          aria-label="重跑说明（可留空）" />
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy}
            onClick={() => setReviveOpen(false)}>取消</Button>
          <Button type="button" disabled={busy}
            onClick={reviveSession}>确认重跑</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <div className="ws-body max-[1100px]:grid-cols-[minmax(0,1fr)]">
      {/* ws-evidence 是滚动主区(#231 换装:共享 studio 皮肤类保留,
          原 issue-workspace 家族的拉伸/留白直译成工具类,工具类层压过
          皮肤基线);窄屏单列时协作区回到内容之上(与旧断点同语义)。 */}
      <section aria-label="会话工作区" className={cn(
        "ws-evidence",
        "flex min-w-0 flex-col gap-3.5 overflow-y-auto px-[22px] pb-7",
      )}>
        {/* 错误横幅:认证类报错带一键跳转(查看模式不渲染)。 */}
        {detail.error && <div role="alert"
          className="flex flex-wrap items-baseline gap-3 rounded-lg bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
          <span>{detail.error}</span>
          {/* 认证类报错带机器标记(issueGit.ts 的 GIT_AUTH_ERROR_TAG,常量
              镜像在 api.ts):命中即给一键跳转;人话改字不影响识别。
              跳转修的是归属人的凭据,查看模式不渲染这条补救入口。 */}
          {canOperate && onNavigateProfile
            && detail.error.includes(GIT_AUTH_ERROR_TAG)
            && <Button type="button" variant="link"
              className="h-auto px-0 font-bold text-danger underline underline-offset-2 hover:text-danger"
              onClick={onNavigateProfile}>去个人设置配置令牌</Button>}
        </div>}
        {/* 首次生成归属(ADR-0044,#339):收口会话的证据面——最终留存
            源码行的三分类(首轮/返工/平台外)、每仓明细与逐提交行归属;
            伴生缺席(未算完/早于起算日)由面板如实说明,收口前不渲染。
            默认折叠:证据面是复盘时下钻看的,不占首屏。 */}
        {!isIssueActive(detail.status) && (
          <details className="rounded-lg border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm font-semibold text-text-strong">
              首次生成归属(收口会话的代码来源统计)
            </summary>
            <div className="mt-3">
              <IssueCodeOriginPanel id={detail.id} />
            </div>
          </details>
        )}
        {/* 逐仓交付已收编页签(ADR-0027)、MR 检视批注已收编「MR 检视」
            页签、持续检视面板已退役(2026-09-17 走查拍板:上方不再放大
            卡区,流水线要看去 CodeHub)——横幅之下直达页签区。 */}

        {/* 左栏内容(#123 拍平 + ADR-0027 五签定局 + 2026-09-17 修订
            第六签):一级标签直排,元信息(默认入口)居首、MR 检视垫后。
            页签条是
            任务侧左栏同款 ws-pane-head > ws-source-switch(role=tablist),
            页签一签一色走各签自带的 --workspace-tab-color(#231 换装)。
            #231 换装:左栏拉伸契约(issueWorkspaceLayout)原住在
            issue-workspace 家族,现直译成本节的工具类——面板吃满
            ws-evidence 余量、现场面板体/流壳/流三层吃满、跟随横幅
            浮层胶囊、窄屏恢复 62vh 流帽。 */}
        <section aria-label="会话内容" className={cn(
          "flex min-h-80 min-w-0 flex-1 flex-col gap-2.5",
          "min-[1101px]:max-h-[calc(100dvh-150px)]",
          "[&_.event-panel-body]:relative [&_.event-panel-body]:flex [&_.event-panel-body]:min-h-0 [&_.event-panel-body]:flex-1 [&_.event-panel-body]:flex-col",
          "[&_.event-panel-body>.event-stream]:min-h-0 [&_.event-panel-body>.event-stream]:flex-1 [&_.event-panel-body>.event-stream]:max-h-none",
          "max-[1100px]:[&_.event-panel-body>.event-stream]:max-h-[62vh]",
          "[&_.event-workspace]:min-h-0 [&_.event-workspace]:flex-1",
          "[&_.event-workspace>.event-stream]:h-full [&_.event-workspace>.event-stream]:max-h-none",
          "[&_.event-follow]:absolute [&_.event-follow]:inset-x-3 [&_.event-follow]:bottom-3 [&_.event-follow]:z-30 [&_.event-follow]:rounded-full [&_.event-follow]:border [&_.event-follow]:border-line [&_.event-follow]:bg-surface [&_.event-follow]:shadow-(--shadow-md)",
        )}>
          {/* (#210)Tabs root 以 display:contents 作透明壳:同时罩住
              ws-pane-head(页签条)与面板,DOM 盒子不变。 */}
          <Tabs value={tab} className="contents"
            onValueChange={(value) => setTab(value as IssueMainTab)}>
            <div className="ws-pane-head" aria-label="问题工作台视图">
              <div><strong>{
                ISSUE_MAIN_TABS.find((item) => item.key === tab)?.label
              }</strong></div>
              {/* 手搓 role=tablist 换 base-ui Tabs 原语:键盘箭头、
                  roving tabindex 归原语;激活态边/底/字走各签自带的
                  --workspace-tab-color(#231 换装:发色由 nth-child
                  规则改为 ISSUE_MAIN_TABS 自带变量工具类)。 */}
              <TabsList variant="line" aria-label="会话工作区内容"
                className="ws-source-switch h-auto justify-start">
                {/* DTS 单据签无单整体隐藏(ADR-0027:屏蔽即诚实,原
                    禁用+tooltip 的死钮退役);「MR 检视」签有批注才现身
                    (正被看着时即便清空也留,免得脚下视图塌掉);其余各签恒在。 */}
                {ISSUE_MAIN_TABS
                  .filter(({ key }) => (key !== "dts" || detail.ticket)
                    && (key !== "reviews" || showReviewsTab))
                  .map(({ key, label, tone }) => (
                  <TabsTrigger key={key} value={key}
                    className={`h-auto flex-none ${tone} data-active:text-[color:color-mix(in_srgb,var(--workspace-tab-color)_62%,var(--text-strong))] data-active:border-[color:color-mix(in_srgb,var(--workspace-tab-color)_34%,var(--line))] data-active:bg-[color:color-mix(in_srgb,var(--workspace-tab-color)_9%,var(--surface))]${tab === key ? " on" : ""}`}>
                    <span>{label}</span>
                    {/* 分析报告在库:「分析报告」页签挂脉冲点——报告是主
                        交付物,入口要找得到(原材料页签的同一引导,随升格
                        迁来);「MR 检视」签同款引导,有待判断批注就挂点
                        (#231 换装:原 issue-workspace 的圆点定尺/染色列
                        直译成点上的工具类,动画仍由共享 .ws-tab-dot 承担)。 */}
                    {(key === "doc" && detail.has_analysis
                      || key === "reviews" && reviewsPending > 0)
                      && <i aria-hidden
                        className="ws-tab-dot size-[7px] min-w-0 rounded-full bg-(--workspace-tab-color) p-0" />}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
            {/* 面板映射(#210):原条件渲染改 TabsPanel(keepMounted 默认
                false,卸载语义与原实现一致);doc/dts/changes 共用的兜底
                分支用「值跟随当前签」的单面板承接,切签时元素位置稳定,
                IssueMaterialsPane 内部状态不被重挂载清掉。 */}
            {tab === "events" && <TabsContent value="events" className="contents">
              <IssueWarmupLive id={detail.id} warmup={detail.warmup} />
              <IssueEventsPane id={detail.id} active />
            </TabsContent>}
            {tab === "meta" && <TabsContent value="meta" className="contents">
              <IssueMetaPane detail={detail} canOperate={canOperate} />
            </TabsContent>}
            {tab === "reviews" && <TabsContent value="reviews" className="contents">
              <IssueExternalReviewPanel issueId={detail.id}
                items={reviews.items} pollError={reviews.pollError}
                refresh={reviews.refresh} canOperate={canOperate} />
            </TabsContent>}
            {tab !== "events" && tab !== "meta" && tab !== "reviews"
              && <TabsContent value={tab} className="contents">
              <IssueMaterialsPane detail={detail} view={tab}
                canOperate={canOperate} />
            </TabsContent>}
          </Tabs>
        </section>
      </section>
      {/* 右栏协作(#231 换装):皮肤类(ws-side,conversation.css 共享)
          保留,原 issue-workspace 的 min-width 与窄屏单列(协作区回到
          内容之上、限高 46vh)直译成工具类。 */}
      <section aria-label="与 Agent 协作"
        className="ws-side min-w-0 max-[1100px]:order-first max-[1100px]:max-h-[46vh]">
        {/* #125 右栏协作对话框:协作头 + 会话流(聚合接口
            GET /issues/:id/conversation + 可见轮询)+ 输入区。当前等待卡
            由卡座钉在流末尾的 Agent 气泡内(waitingId 供流内同卡投影
            去重),提交区经 portal 挂进输入区 dock(dockRef→footerTarget);
            查看模式渲染只读事实卡、不出 dock。确认是问题归档的会话在
            协作头之下、流之上挂提单模板卡。 */}
        {detail.status === "archived" && detail.conclusion?.kind === "issue" &&
          <div className="mb-3">
            <TicketTemplateCard issueId={detail.id} />
          </div>}
        <IssueConversationStream
          key={detail.id}
          issueId={detail.id}
          status={detail.status}
          waiting={Boolean(waiting)}
          waitingId={waiting?.waiting_id}
          waitingTs={waiting?.created_at}
          waitingKind={waiting?.gate_kind}
          canOperate={canOperate}
          busy={busy}
          owner={detail.account}
          viewerUsername={viewerUsername}
          takeover={Boolean(detail.takeover)}
          currentCard={waiting ? (canOperate
            ? <IssueDecisionCard waiting={waiting} busy={busy}
                footerTarget={decisionFooterTarget}
                onAnswer={answer} onEnvironment={attachEnvironment} />
            : <IssueWaitingFacts waiting={waiting} />)
            : undefined}
          dockRef={setDecisionFooterTarget}
          onSteer={sendSteer}
          onReply={sendReply}
          onTakeover={takeoverNow}
          onTakeoverNote={sendTakeoverNote}
          onResumeTakeover={resumeTakeover}
          onOpenEvents={() => setTab("events")}
        />
      </section>
    </div>
  </section>;
}

/** 固定流程的阶段管道(计划线):视觉对齐需求工作台的 task-phase-track
 * ——节点在上、词签在下、细连线串成一条管;走过的亮,当前阶段节点
 * 放大呼吸。stage_states 决定形态(pending 空心/in_progress 亮/done 实
 * /redo 警示/inherited 弱化+标"继承");轮次>1 加轮次徽标。
 * #231 换装:原 .issue-fixed-* 家族(#230 保留给本票)整族退役,直译成
 * 令牌工具类;当前节点的呼吸走共享 animate-pulse(#216 同款降级)。 */
const FIXED_STEP = "relative flex min-w-0 flex-col items-center gap-[5px] text-center text-xs leading-[1.2] not-last:before:absolute not-last:before:top-[3.5px] not-last:before:left-1/2 not-last:before:z-[1] not-last:before:h-[1.5px] not-last:before:w-full";
const FIXED_STEP_TONE: Record<IssueStageState, string> = {
  pending: "text-faint before:bg-line-strong",
  done: "text-text-strong before:bg-success",
  in_progress: "font-bold text-primary before:bg-line-strong",
  inherited: "text-muted-foreground before:bg-muted-foreground/55",
  redo: "text-attention before:bg-line-strong",
};
const FIXED_DOT_TONE: Record<IssueStageState, string> = {
  pending: "border-line-strong bg-surface",
  done: "border-success bg-success",
  in_progress: "mt-[-1.5px] size-[11px] border-2 border-surface bg-primary shadow-[0_0_0_3px_color-mix(in_srgb,var(--primary)_22%,transparent)] motion-safe:animate-pulse motion-reduce:animate-none",
  inherited: "border-muted-foreground bg-transparent",
  redo: "border-attention bg-attention",
};

export function IssueFixedProgress({ issue }: { issue: IssueSummary }) {
  const stages = fixedStageList(issue.scenario);
  const states = issue.stage_states ?? [];
  const labels: Record<IssueStageState, string> = {
    pending: "未开始",
    in_progress: "进行中",
    done: "已完成",
    inherited: "已继承",
    redo: "待重做",
  };
  return <nav aria-label="固定流程阶段"
    className="grid gap-1.5 rounded-xl border border-border bg-surface px-4 pt-3 pb-2.5">
    {(issue.round ?? 1) > 1
      && <div className="flex min-h-[1em] items-center gap-2">
        <span className={ROUND_BADGE}>第 {issue.round} 轮</span>
      </div>}
    <span className="grid [grid-template-columns:repeat(auto-fit,minmax(64px,1fr))]">
      {stages.map((stage, index) => {
        const state = states[index] ?? "pending";
        const current = state === "in_progress";
        const label = issueStageText({ scenario: issue.scenario, stage });
        return <span key={stage}
          className={cn(FIXED_STEP, FIXED_STEP_TONE[state])}
          title={`${label} · ${labels[state]}${current ? "(当前)" : ""}`}>
          <i aria-hidden className={cn(
            "relative z-[2] size-2 rounded-full border-[1.5px]",
            FIXED_DOT_TONE[state])} />
          <span className="max-w-full truncate">{label}</span>
          {(state === "inherited" || state === "redo")
            && <em className="rounded-[5px] bg-current/12 px-[5px] py-0.5 text-xs not-italic leading-none">
              {state === "inherited" ? "继承" : "重做"}
            </em>}
        </span>;
      })}
    </span>
  </nav>;
}

/** 工作台头部进度(ADR-0018 骨架对齐):视觉复用任务侧 task-progress
 * (caption+phase-track,节点上词签下、当前脉冲),数据仍是问题域
 * stage_states;不做任务侧的"点阶段弹方案"——问题侧没有阶段计划。
 * 无单三节点与有单五阶段同一条渲染路;inherited 弱化、redo 警示、
 * 轮次>1 带轮次徽标。列表卡仍用 IssueFixedProgress,两份并存。 */
function IssueWorkspaceProgress({ issue }: { issue: IssueSummary }) {
  const stages = fixedStageList(issue.scenario);
  const states = issue.stage_states ?? [];
  const currentIndex = Math.max(0, stages.findIndex((_, index) =>
    (states[index] ?? "pending") === "in_progress"));
  const done = stages.every((_, index) =>
    (states[index] ?? "pending") === "done"
    || (states[index] ?? "pending") === "inherited");
  return <span className="task-progress"
    aria-label={`当前阶段:${issueStageText(issue)}`}>
    <span className="task-progress-caption">
      <span>当前进度</span>
      <strong>{issueStageText(issue)}</strong>
      <em className="task-progress-count">
        {done ? stages.length : currentIndex + 1}/{stages.length}
      </em>
      {(issue.round ?? 1) > 1
        && <em className={ROUND_BADGE}>第 {issue.round} 轮</em>}
    </span>
    <span className="task-phase-track">
      {stages.map((stage, index) => {
        const state = states[index] ?? "pending";
        const phaseClass = state === "in_progress" ? "current"
          : state === "redo" ? "attention"
          : state === "done" || state === "inherited" ? "past is-done"
          : index < currentIndex ? "past" : "future";
        const label = issueStageText({ scenario: issue.scenario, stage });
        return <span key={stage} className={`task-phase ${phaseClass}`}
          title={`${label} · ${state === "inherited" ? "已继承"
            : state === "redo" ? "待重做" : state === "done" ? "已完成"
            : state === "in_progress" ? "进行中(当前)" : "未开始"}`}>
          <i aria-hidden />
          <span>{label}</span>
        </span>;
      })}
    </span>
  </span>;
}

/** 耗时与卡点面板(2026-09-11 退役):原是工作台的耗时仪表,2026-09-07
 * 走查反馈迁到列表卡展开态;展开交互随「点击直达工作台」拍板移除后,
 * 它失去最后一个使用点,连面板一起删。数据面 timeline 接口(服务端投影)
 * 仍在,api.getIssueTimeline 是它的客户端镜像;以后要在工作台补看耗时,
 * 接回它即可。 */
