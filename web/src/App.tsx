import { issueSessionPath } from "./issues/issueLink";
import { isReviewTaskEnded } from "../../src/reviewParticipation";
import { KnowledgeAnswerPage, openKnowledgeAnswer } from "./KnowledgeAnswerPage";
import { KnowledgeLibrary } from "./KnowledgeLibrary";
import { PeopleProvider, PersonName, usePersonName } from "./People";
import { DeliveryAnalytics } from "./DeliveryAnalytics";
/**
 * 管理员默认看团队全局，开发默认直达我的需求；
 * 登录身份决定任务归属与操作权限，任务事实仍来自服务端。
 */
import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuButton, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem,
  SidebarMenuItem, SidebarProvider,
} from "@/components/ui/sidebar";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ChevronDown } from "lucide-react";
import { cn } from "cn";
import { Spinner } from "@/components/Spinner";
import { BrandMark } from "./BrandMark";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyTitle, EmptyDescription } from "@/components/Empty";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  createUser, deleteUser, getBuildInfo, getIssueAutoClaimNextRun, getLaunchOptions, getSession, getTask, isIssueActive, listAllIssues, listIssues, listMyReviews, listTasks, listUsers,
  login, logout, putCommitter, putMyIssueAutoClaim, putUserDisplayName, resetUserPassword,
  type AuthUser, type IssueSummary, type TaskStatus, type TaskSummary,
  type ReviewRequest, type UserRole,
} from "./api";
import type { IssueChildTab } from "./issues/IssueBoard";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog";
import { TaskCard } from "./TaskCard";
import { TeamIssueArchive, TeamIssueWorld } from "./TeamIssueWorld";
import { HistoryBoard } from "./HistoryBoard";
import { LaunchWorkspace } from "./LaunchWorkspace";
import { TaskWorkspace } from "./TaskWorkspace";
import { SettingsBoard } from "./SettingsView";
import { GitTokenCard } from "./GitTokenCard";
import { LubanTokenCard } from "./LubanTokenCard";
import { PersonalModelsCard } from "./PersonalModelsCard";
import {
  getMoonlightPreview,
  putMoonlight,
  putPersonalPushConfirmation,
  putIssueInterventionTier,
} from "./api";
import { ConfigurationCenter } from "./ConfigurationCenter";
import { byNewest, byUrgency } from "./taskTime";
import { orderHierarchyBy, orderTaskHierarchy, keepFamiliesTogether } from "./taskHierarchy";
import {
  byTeamAttention,
  isBlocked,
  isCurrentTeamTask,
  matchesTeamScope,
  responsibleOf,
  teamDeliveryBreakdown,
  teamDeliveryStatusGroup,
  type TeamDeliveryBreakdown,
  type TeamScope,
  type TeamTask,
} from "./teamOps";
import { formatLocalDateTime } from "./time";
import { taskSyncCopy, type TaskSyncState } from "./taskSync";
import {
  launchGateCopy,
  type LaunchGateState,
} from "./launchGate";
import { startVisiblePolling } from "./visiblePolling";
import { KnowledgeAssetsWorkspace } from "./KnowledgeAssets";
import { WishWall, type WishWallDraft } from "./WishWall";
import { QuickWishButton } from "./WishQuickCreate";
import { userLabel } from "./UserPicker";
import { BusinessModuleLibrary } from "./BusinessModuleLibrary";
import {
  knowledgeAssetPath,
  readKnowledgeAssetFocus,
  type KnowledgeAssetFocus,
} from "./knowledgeNavigation";

// 问题处理页独立分包(懒加载):问题流与需求流互不拖累,改哪边都不
// 用动另一边的构建产物。
const IssueBoard = lazy(() =>
  import("./issues/IssueBoard").then((module) => ({ default: module.IssueBoard })));
// 帮助中心内容多、截图也多，但不是每次进工作台都要用。和问题处理页一样
// 独立加载，不能为了 FAQ 拖慢用户每天打开的首页。
const HelpCenter = lazy(() =>
  import("./HelpCenter").then((module) => ({ default: module.HelpCenter })));

// 两侧各退役一个视图,取并集:"business" 并入团队资产页签(modules,
// 本地);"history" 并入团队需求的档案页签(origin)。
// 2026-09-10 拍板:团队页按域拆成两条导航——团队需求(requirement,
// 只装需求)与团队问题(teamIssues,只装问题会话);页内领域切换器随
// 之退场,问题处理(issues)仍是个人操作台,与"我的需求"对位。
type View = "team" | "teamIssues" | "mine" | "issues" | "profile" | "users"
  | "settings" | "library" | "answers" | "knowledge" | "wishes" | "help" | "environments" | "deliveryAnalysis";
type Theme = "light" | "dark";
type Density = "comfortable" | "compact";
type MineScope = "all" | "waiting" | "intervention" | "active" | "delivered";
type TeamTaskTab = "current" | "archive";
/** 原"团队资产"视图 2026-10 已拆散（经验进知识库、工作流进配置中心、使用效能进交付分析）；
 * 只剩发起页知识清单深链的全文查看，随消费批次退役模块资产时一并删除。 */
type TeamAssetTab = "knowledge" | "modules";

const APP_VIEWS = new Set<View>([
  "team", "teamIssues", "mine", "issues", "profile", "users", "settings",
  "library", "answers", "knowledge", "wishes", "help", "environments", "deliveryAnalysis",
]);
const TEAM_ASSET_TABS = new Set<TeamAssetTab>(["knowledge", "modules"]);

function appHistoryState(view: View, teamAssetTab?: TeamAssetTab,
  issueChildTab?: IssueChildTab) {
  const current = history.state && typeof history.state === "object"
    ? history.state as Record<string, unknown> : {};
  return {
    ...current,
    maeFlowView: view,
    maeFlowTeamAssetTab: teamAssetTab,
    maeFlowIssueChildTab: issueChildTab,
  };
}

function viewFromHistoryState(state: unknown): View | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>).maeFlowView;
  return typeof candidate === "string" && APP_VIEWS.has(candidate as View)
    ? candidate as View : undefined;
}

function teamAssetTabFromHistoryState(
  state: unknown,
): TeamAssetTab | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>).maeFlowTeamAssetTab;
  return typeof candidate === "string"
      && TEAM_ASSET_TABS.has(candidate as TeamAssetTab)
    ? candidate as TeamAssetTab : undefined;
}

/** 问题处理子页签:问题会话、登记、DTS 列表与独立流水线修复。选择记住
 * localStorage + 浏览器历史快照,与团队需求页的现场/档案页签同口径;
 * admin 恒为问题会话(不发起,登记/DTS 入口对 admin 不渲染)。 */
const ISSUE_CHILD_TABS = new Set<IssueChildTab>([
  "register", "dts", "sessions", "pipeline",
]);
const ISSUE_CHILD_STORAGE_KEY = "mae-flow:issue-child-tab";

function readIssueChildTab(): IssueChildTab {
  if (/^\/pipeline-repairs(?:\/|$)/.test(location.pathname)) return "pipeline";
  try {
    const saved = localStorage.getItem(ISSUE_CHILD_STORAGE_KEY);
    if (saved && ISSUE_CHILD_TABS.has(saved as IssueChildTab)) {
      return saved as IssueChildTab;
    }
  } catch { /* localStorage 不可用(隐私模式等)就回默认,不拦导航 */ }
  return "sessions";
}

function issueChildTabFromHistoryState(state: unknown): IssueChildTab | undefined {
  if (!state || typeof state !== "object") return undefined;
  const candidate = (state as Record<string, unknown>).maeFlowIssueChildTab;
  return typeof candidate === "string"
      && ISSUE_CHILD_TABS.has(candidate as IssueChildTab)
    ? candidate as IssueChildTab : undefined;
}

interface WorkspaceRoute {
  taskId: string;
  reviewId: string;
}

function readWorkspaceRoute(): WorkspaceRoute {
  const match = location.pathname.match(
    /^\/work\/([^/]+)(?:\/review\/([^/]+))?\/?$/,
  );
  if (match) {
    try {
      return {
        taskId: decodeURIComponent(match[1]),
        reviewId: match[2] ? decodeURIComponent(match[2]) : "",
      };
    } catch { return { taskId: "", reviewId: "" }; }
  }
  // 兼容此前已经发送的根路径查询参数通知，进入后会规范成 /work/...。
  const params = new URLSearchParams(location.search);
  return {
    taskId: params.get("task")?.trim() ?? "",
    reviewId: params.get("review")?.trim() ?? "",
  };
}

function workspacePath(taskId: string, reviewId = ""): string {
  return `/work/${encodeURIComponent(taskId)}`
    + (reviewId ? `/review/${encodeURIComponent(reviewId)}` : "");
}

/** 问题会话工作台深链(/issues/:id,小鲁班通知的落点)。匹配返回会话
 * id,其余路径返回空串。 */
function readIssueRoute(): string {
  const match = location.pathname.match(/^\/(?:issues|pipeline-repairs)\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch { return ""; }
}

/** 环境管理深链(/environments):台账是全局团队资源,链接可以直接发给
 * 同事,登录后落到页签本身(台账没有单条详情页,整页即深链落点)。 */
function readEnvironmentRoute(): boolean {
  return /^\/(?:environments|configuration)\/?$/.test(location.pathname);
}

export type WorkspaceTargetResolution =
  | { kind: "pending" }
  | { kind: "missing" }
  | { kind: "ready"; task: TaskSummary };

/** 深链只能在任务目录完成一次权威读取后判失效。`tasks.length` 不能充当
 * “已加载”标记：一个完全没有任务的新账号，合法结果本来就是空数组。 */
export function resolveWorkspaceTarget(
  taskId: string,
  openedTaskId: string,
  tasks: TaskSummary[],
  taskListLoaded: boolean,
): WorkspaceTargetResolution {
  if (!taskId || openedTaskId === taskId || !taskListLoaded) {
    return { kind: "pending" };
  }
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task ? { kind: "ready", task } : { kind: "missing" };
}

function initialView(user: AuthUser): View {
  if (new URLSearchParams(location.search).get("kbPage") === "ask") return "answers";
  if (new URLSearchParams(location.search).has("deliveryAnalysis")) return "deliveryAnalysis";
  if (["kbPage"].some(key => new URLSearchParams(location.search).has(key))) return "library";
  if (/^\/help(?:\/|$)/.test(location.pathname)) return "help";
  if (readKnowledgeAssetFocus()) return "knowledge";
  // 环境管理深链:对全部角色生效(台账登录即可读写,ADR-0020)。
  if (readEnvironmentRoute()) return "environments";
  // 问题登记深链(裸 /issues):服务端/vite 判别式已把浏览器导航让给
  // SPA,这里把地址对上页签——落点与侧栏「问题处理」一致(子页签沿用
  // 持久化选择);会话工作台深链 /issues/:id 走下面的 readIssueRoute。
  if (/^\/(?:issues|pipeline-repairs)\/?$/.test(location.pathname)) return "issues";
  // 管理员没有"我的待办"(不下单的角色没有个人任务收件箱,用户拍板):
  // 深链也一律落到团队总览,从那里打开任意任务行使兜底控制。
  if (user.role === "admin") return "team";
  // 问题会话深链:通知点开就是那张卡,不再让人去"问题处理"列表里找。
  if (readIssueRoute()) return "issues";
  if (readWorkspaceRoute().reviewId) return "mine";
  return "mine";
}

/** 人工介入程度(用户拍板:一个旋钮说清,不做任务粒度设置)。
 * 两个正交轴合成四档:过程节点停不停,推送前给不给人看变更清单。
 * 2026-09 按流剥离:需求交付与问题处理各一对轴、独立取值互不带动,
 * 同一张四档卡在设置页各渲染一份。需求侧月光转开仍走预览/是否处理
 * 当前待办的既有流程(存量待办可一并清扫);问题侧闸卡现读现判,
 * 开闸不追溯,已在等待的卡仍等真人。MR 人工合入与流水线绑 SHA 不归
 * 此旋钮,始终生效。 */
const INTERVENTION_PRESETS = [
  { key: "full", moonlight: false, push: true, title: "全程把关", isDefault: true,
    detail: "过程问你 · 推送问你" },
  { key: "process", moonlight: false, push: false, title: "只问过程", isDefault: false,
    detail: "过程问你 · 推送直走" },
  { key: "delivery", moonlight: true, push: true, title: "只问推送", isDefault: false,
    detail: "过程自动 · 推送问你" },
  { key: "auto", moonlight: true, push: false, title: "全自动", isDefault: false,
    detail: "过程自动 · 推送直走" },
] as const;

/** 问题处理介入档位(ADR-0019):三档,与需求交付四档互不带动,
 * 缺省二档。 */
const ISSUE_INTERVENTION_TIERS = [
  { key: "1", title: "全自动", isDefault: false,
    detail: "零介入 · 缺网管环境仍举卡 · 一路跑到 MR 变绿才提醒" },
  { key: "2", title: "优先报告", isDefault: true,
    detail: "只在报告检视停一次 · 其余直达变绿" },
  { key: "3", title: "优先对齐", isDefault: false,
    detail: "主动对齐、结论确认" },
] as const;

// 介入档位卡(#228 工具类化):选中=accent 描边+soft 底,左 icon 盒反色;
// 两张设置卡(需求交付/问题处理)共用同一套配方。
const approvalCard = "grid min-h-[74px] grid-cols-[28px_minmax(0,1fr)] items-center gap-2.5 rounded-[11px] border p-3 text-left transition-colors disabled:cursor-wait disabled:opacity-65";
const approvalCardIcon = "grid size-7 place-items-center rounded-[8px] border text-sm not-italic [&_svg]:size-[15px]";
// 我的任务摘要分段筛选 chip(#228 工具类化):胶囊描边钮,选中=描边+底色;
// 计数色随语气(attention/danger),其余中性。
const pulseChip = "inline-flex h-7 items-center gap-1.5 rounded-[7px] border border-transparent px-2.5 text-sm font-medium text-(--muted) transition-colors hover:border-(--line) hover:bg-(--surface-2) hover:text-(--text-strong)";
const pulseChipSelected = "border-(--line) bg-(--surface) text-(--accent) shadow-sm";
const pulseChipCount = "text-sm font-semibold leading-none tabular-nums text-(--text-strong)";
// 账号表行内操作钮(#228 工具类化):描边小钮,危险态(删除)另着色。
const userActionButton = "rounded-[8px] border border-(--line) bg-(--surface) px-2.5 py-[7px] text-sm text-(--muted) transition-colors hover:border-(--line-strong) hover:text-(--text-strong) disabled:cursor-not-allowed disabled:opacity-45";

function InterventionSetting({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (patch: Partial<AuthUser>) => Promise<void>;
}) {
  const [moon, setMoon] = useState(!!session.moonlight);
  const [push, setPush] = useState(session.push_confirmation !== false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const current = INTERVENTION_PRESETS
    .find((preset) => preset.moonlight === moon && preset.push === push)!;
  async function select(preset: typeof INTERVENTION_PRESETS[number]) {
    if (busy || preset.key === current.key) return;
    setBusy(true);
    try {
      const notes: string[] = [];
      let nextMoon = moon;
      let nextPush = push;
      if (preset.moonlight !== moon) {
        let includeCurrent = false;
        let expectedEligible: number | undefined;
        if (preset.moonlight) {
          const preview = await getMoonlightPreview();
          expectedEligible = preview.eligible;
          if (preview.eligible > 0) {
            // 二选一不是真假确认:两个语义化按钮直接说清各自后果,
            // 不再借浏览器框的"确定/取消"让人读小字猜(spec #52/T3)。
            includeCurrent = await confirmDialog({
              title: "切换到「月光」档",
              message: <>过程自动放行默认仅对后续节点生效。当前有
                {" "}{preview.eligible} 项可自动处理
                {preview.blocked_annotations > 0
                  ? <>，另有 {preview.blocked_annotations}
                    项因存在检视意见不会自动放行</>
                  : null}。</>,
              cancelLabel: "仅对后续节点生效",
              confirmLabel: "连当前待办一起处理",
            });
          }
        }
        const result = await putMoonlight(
          preset.moonlight, includeCurrent, expectedEligible);
        nextMoon = result.moonlight;
        setMoon(result.moonlight);
        notes.push(result.moonlight
          ? (result.swept > 0
              ? `过程节点已自动放行，并处理 ${result.swept} 项当前待办`
              : result.blocked_annotations > 0
                ? `过程节点对后续生效；${result.blocked_annotations} 项含检视意见的待办仍需人工处理`
                : "过程节点对后续生效，当前待办保持不变")
          : "过程节点恢复等你拍板");
      }
      if (preset.push !== push) {
        const user = await putPersonalPushConfirmation(preset.push);
        nextPush = user.push_confirmation !== false;
        setPush(nextPush);
        notes.push(nextPush
          ? "后续每次推送前会先给你看变更清单,确认一次放行一次"
          : "后续推送不再等待清单确认;已在等确认的任务点一下确认即可");
      }
      setNote(notes.join("；"));
      await onChanged({ moonlight: nextMoon, push_confirmation: nextPush });
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className="rounded-[12px] border border-(--line) bg-[radial-gradient(circle_at_100%_0,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_42%),var(--surface)] p-[22px] shadow-sm max-[480px]:p-[17px]" aria-labelledby="approval-setting-title">
    <header className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 max-[480px]:grid-cols-[38px_minmax(0,1fr)]">
      <span className="grid size-[42px] place-items-center rounded-xl border border-(--accent)/20 bg-(--accent-soft) text-(--accent) [&_svg]:size-5 max-[480px]:size-[38px]" aria-hidden><svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg></span>
      <div><h2 id="approval-setting-title" className="m-0 text-[19px] tracking-[-0.025em] text-(--text-strong)">人工介入程度 · 需求交付</h2></div>
      <span className="rounded-full border border-(--accent)/20 bg-(--accent-soft) px-[9px] py-[5px] text-sm font-bold text-(--accent) max-[480px]:col-start-2 max-[480px]:justify-self-start">当前：{current.title}</span>
    </header>
    <p className="my-3.5 text-sm text-(--muted)">一处设定，需求交付的任务全程生效（问题处理在下方单独设定）。"过程"指分析报告确认、无单结论确认、网管环境补配这些等你拍板的卡；"推送"指每次 push 前先给你看变更清单（确认一次放行一次）。无论选哪档，MR 人工合入、流水线绑 SHA 等门禁始终生效；人工检视意见引发的修改一定回到意见作者复检。</p>
    <div className="grid grid-cols-2 gap-[9px] max-[760px]:grid-cols-1" role="group" aria-label="人工介入程度 · 需求交付">
      {INTERVENTION_PRESETS.map((preset) => <button type="button" key={preset.key}
        className={cn(approvalCard, current.key === preset.key
          ? "border-(--accent)/40 bg-(--accent-soft) text-(--text)"
          : "border-(--line) bg-(--surface-soft) text-(--muted) hover:border-(--accent)/35")}
        disabled={busy}
        onClick={() => void select(preset)}>
        <i aria-hidden className={cn(approvalCardIcon, current.key === preset.key
          ? "border-(--accent) bg-(--accent) text-(--accent-fg)"
          : "border-(--line) bg-(--surface) text-(--faint)")}>{preset.moonlight
          ? <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg>
          : "✓"}</i>
        <span className="grid min-w-0 gap-[3px]">
          <strong className="text-[13.5px] text-(--text-strong)">{preset.title}
            {preset.isDefault && <i className="ml-1.5 rounded-full bg-(--accent-soft) px-1.5 py-px align-[1px] text-xs font-medium not-italic text-(--accent)">默认</i>}
          </strong>
          <small className="text-sm leading-[1.45] text-(--muted)">{preset.detail}</small>
        </span>
      </button>)}
    </div>
    {note && <p className="mt-[11px] text-sm text-(--success)" role="status">{note}</p>}
  </section>;
}

function IssueInterventionSetting({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (patch: Partial<AuthUser>) => Promise<void>;
}) {
  const [tier, setTier] = useState(session.issue_intervention_tier ?? "2");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const current = ISSUE_INTERVENTION_TIERS
    .find((item) => item.key === tier)!;
  async function select(next: typeof ISSUE_INTERVENTION_TIERS[number]) {
    if (busy || next.key === tier) return;
    setBusy(true);
    try {
      // 现读现判:切档即刻生效,不追溯已挂起的卡(ADR-0019)。
      const user = await putIssueInterventionTier(next.key);
      const applied = user.issue_intervention_tier ?? "2";
      setTier(applied);
      setNote(applied === "1"
        ? "问题处理已切到全自动:不再向你提问,缺网管环境时仍会举配置卡等你补配或拒绝,一路跑到 MR 变绿(或办不了停下)才提醒你"
        : applied === "2"
          ? "问题处理只在分析报告检视时停一次,其余直达变绿"
          : "问题处理恢复优先对齐:现象对齐、结论确认");
      await onChanged({ issue_intervention_tier: applied });
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className="rounded-[12px] border border-(--line) bg-[radial-gradient(circle_at_100%_0,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_42%),var(--surface)] p-[22px] shadow-sm max-[480px]:p-[17px]" aria-labelledby="issue-intervention-title">
    <header className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 max-[480px]:grid-cols-[38px_minmax(0,1fr)]">
      <span className="grid size-[42px] place-items-center rounded-xl border border-(--accent)/20 bg-(--accent-soft) text-(--accent) [&_svg]:size-5 max-[480px]:size-[38px]" aria-hidden><svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg></span>
      <div><h2 id="issue-intervention-title" className="m-0 text-[19px] tracking-[-0.025em] text-(--text-strong)">人工介入程度 · 问题处理</h2></div>
      <span className="rounded-full border border-(--accent)/20 bg-(--accent-soft) px-[9px] py-[5px] text-sm font-bold text-(--accent) max-[480px]:col-start-2 max-[480px]:justify-self-start">当前：{current.title}</span>
    </header>
    <p className="my-3.5 text-sm text-(--muted)">一处设定，问题处理全程生效，与需求交付的档位互不影响。检视回合确认卡、流水线人工闸这些只有真人能答的卡不受档位影响，始终等你；切换只对之后的卡生效，已在等待的卡仍需你处理。需要个别单子用不同档位时，在 DTS 列表「介入档位」列按单特例（发起前选定，发起后定格，不再跟随这里）。</p>
    <div className="grid grid-cols-2 gap-[9px] max-[760px]:grid-cols-1" role="group" aria-label="人工介入程度 · 问题处理">
      {ISSUE_INTERVENTION_TIERS.map((item) => <button type="button" key={item.key}
        className={cn(approvalCard, current.key === item.key
          ? "border-(--accent)/40 bg-(--accent-soft) text-(--text)"
          : "border-(--line) bg-(--surface-soft) text-(--muted) hover:border-(--accent)/35")}
        disabled={busy}
        onClick={() => void select(item)}>
        <i aria-hidden className={cn(approvalCardIcon, current.key === item.key
          ? "border-(--accent) bg-(--accent) text-(--accent-fg)"
          : "border-(--line) bg-(--surface) text-(--faint)")}>{item.key === "3"
          ? <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg>
          : item.key === "1" ? <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 1 1 7.5 4.5a6.5 6.5 0 0 0 8 8Zm-6 .5 3.5 3.5L18 8" /></svg>
          : "✓"}</i>
        <span className="grid min-w-0 gap-[3px]">
          <strong className="text-[13.5px] text-(--text-strong)">{item.title}
            {item.isDefault && <i className="ml-1.5 rounded-full bg-(--accent-soft) px-1.5 py-px align-[1px] text-xs font-medium not-italic text-(--accent)">默认</i>}
          </strong>
          <small className="text-sm leading-[1.45] text-(--muted)">{item.detail}</small>
        </span>
      </button>)}
    </div>
    {note && <p className="mt-[11px] text-sm text-(--success)" role="status">{note}</p>}
  </section>;
}

/** 下次发起时刻的界面格式(本地时区,YYYY-MM-DD HH:mm:ss)。 */
function formatNextRunAt(iso: string): string {
  const at = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} `
    + `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** 自动接单(ADR-0061;2026-10-10 修订迁入个人设置):个人自助开关,
 *  缺省关闭。说明只留一句,「符合条件」的规则与下次发起时间收进问号
 *  悬停;管理员保留两根全局杠杆:扫描间隔(0=全停,悬停显示已暂停)
 *  与配置中心按版本组勾选「参与自动接单」。 */
function IssueAutoClaimSetting({
  session,
  onChanged,
}: {
  session: AuthUser;
  onChanged: (patch: Partial<AuthUser>) => Promise<void>;
}) {
  const [on, setOn] = useState(session.issue_auto_claim === true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [nextRunAt, setNextRunAt] = useState<string | null | undefined>(
    undefined);
  useEffect(() => {
    let alive = true;
    getIssueAutoClaimNextRun()
      .then((view) => { if (alive) setNextRunAt(view.next_run_at); })
      .catch(() => { /* 调度缺席(测试/旁路形态)时悬停卡显示已暂停 */ });
    return () => { alive = false; };
  }, []);
  async function toggle(next: boolean) {
    if (busy || next === on) return;
    setBusy(true);
    try {
      const user = await putMyIssueAutoClaim(next);
      const applied = user.issue_auto_claim === true;
      setOn(applied);
      setNote(applied
        ? "自动接单已开启:下一拍扫描起,名下符合条件的新问题单由平台代你发起"
        : "自动接单已关闭:不再自动发起名下新单,进行中的会话照常推进");
      await onChanged({ issue_auto_claim: applied });
    } catch (cause) {
      setNote(String((cause as Error).message ?? cause));
    } finally { setBusy(false); }
  }
  return <section className="rounded-[12px] border border-(--line) bg-[radial-gradient(circle_at_100%_0,color-mix(in_srgb,var(--accent)_10%,transparent),transparent_42%),var(--surface)] p-[22px] shadow-sm max-[480px]:p-[17px]" aria-labelledby="issue-auto-claim-title">
    <header className="grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 max-[480px]:grid-cols-[38px_minmax(0,1fr)]">
      <span className="grid size-[42px] place-items-center rounded-xl border border-(--accent)/20 bg-(--accent-soft) text-(--accent) [&_svg]:size-5 max-[480px]:size-[38px]" aria-hidden><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" /><path d="M10 5.5V10l3 1.8" /></svg></span>
      <div><h2 id="issue-auto-claim-title" className="m-0 text-[19px] tracking-[-0.025em] text-(--text-strong)">自动接单</h2></div>
      <label className="flex items-center gap-[9px] text-sm font-bold text-(--muted)">
        <Switch size="sm" checked={on} disabled={busy}
          onCheckedChange={(value) => void toggle(value === true)} />
        <span className={on ? "text-(--accent)" : undefined}>{on ? "已开启" : "已关闭"}</span>
      </label>
    </header>
    <p className="my-3.5 text-sm text-(--muted)">
      开启后,平台定时扫描你名下符合条件的新问题单并自动发起问题会话
      <Tooltip>
        <TooltipTrigger render={
          <button type="button" aria-label="什么单会被自动发起,下次发起是什么时候"
            className="ml-1.5 inline-grid size-[17px] place-items-center rounded-full border border-(--faint) text-[11px] font-bold leading-none text-(--faint) transition-colors hover:border-(--accent) hover:text-(--accent)">?</button>
        } />
        <TooltipContent side="bottom" align="start"
          className="block max-w-sm rounded-lg border border-(--line) bg-(--surface) p-3.5 text-left leading-[1.7] text-(--text) shadow-md">
          <span className="font-semibold">「符合条件」指同时满足:</span>
          <ul className="ml-4 list-disc text-(--muted)">
            <li>单据状态为「开发人员实施修改」</li>
            <li>单据版本所在版本组已在配置中心勾选「参与自动接单」</li>
            <li>单据特性名与某个业务模块完全匹配</li>
          </ul>
          {/* 读取完成才显示这一行:加载中不占位,读取失败不误显「已暂停」。 */}
          {nextRunAt !== undefined && <span
            className="mt-2 block border-t border-(--line-soft) pt-2 text-(--muted)">
            下次发起:{nextRunAt === null
              ? "已暂停(管理员关闭了扫描)"
              : formatNextRunAt(nextRunAt)}
          </span>}
        </TooltipContent>
      </Tooltip>
      。
    </p>
    {note && <p className="mt-[11px] text-sm text-(--success)" role="status">{note}</p>}
  </section>;
}

function ThemeSwitch({ theme, onChange }: {
  theme: Theme;
  onChange: (theme: Theme) => void;
}) {
  const light = theme === "light";
  // 手搓 track 换 Switch 原语:role=switch/aria-checked 交原语,
  // 受控状态(theme)与持久化逻辑原样;label 行工具类化(#228),
  // 窄屏态直译旧 760px 媒体查询(收文案留图标+开关)。
  return <label className="grid h-8 w-full grid-cols-[16px_minmax(0,1fr)_26px] items-center gap-[9px] rounded-[6px] px-2 text-left text-(--muted) transition-colors hover:bg-(--surface-3) hover:text-(--text-strong) max-[760px]:h-auto max-[760px]:w-auto max-[760px]:min-h-[36px] max-[760px]:rounded-[9px] max-[760px]:px-1.5 max-[760px]:py-[3px]"
    title={light ? "切换到深夜主题" : "切换到云昼主题"}>
    <span className="grid size-4 place-items-center [&_svg]:size-[15px] max-[760px]:size-7" aria-hidden>
      {light
        ? <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="3.2" /><path d="M10 2.2v1.5M10 16.3v1.5M2.2 10h1.5M16.3 10h1.5M4.5 4.5l1 1M14.5 14.5l1 1M4.5 15.5l1-1M14.5 5.5l1-1" /></svg>
        : <svg viewBox="0 0 20 20"><path d="M15.5 12.5A6.5 6.5 0 0 1 7.5 4.5a6.5 6.5 0 1 0 8 8Z" /></svg>}
    </span>
    <span className="flex min-w-0 items-baseline gap-1.5 max-[760px]:hidden"><strong className="text-sm font-medium">{light ? "云昼主题" : "深夜主题"}</strong><small className="hidden">{light ? "明亮 · 柔和" : "沉浸 · 专注"}</small></span>
    <Switch size="sm" checked={light}
      onCheckedChange={(checked) => onChange(checked ? "light" : "dark")}
      aria-label={light ? "当前为云昼主题，切换到深夜主题" : "当前为深夜主题，切换到云昼主题"} />
  </label>;
}

function DensitySwitch({ density, onChange }: {
  density: Density;
  onChange: (density: Density) => void;
}) {
  const compact = density === "compact";
  // 同 ThemeSwitch:开关态交 Switch 原语,受控状态原样;行壳工具类化(#228)。
  return <label className="inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-[6px] px-[5px] text-(--faint) transition-colors hover:bg-(--surface-3) hover:text-(--text-strong) max-[760px]:hidden"
    title={compact ? "切换到舒适密度" : "切换到紧凑密度"}>
    <span className="grid size-[15px] place-items-center [&_svg]:size-[15px]" aria-hidden>
      <svg viewBox="0 0 20 20"><path d={compact ? "M4 5.5h12M4 10h12M4 14.5h12" : "M4 4.5h12M4 10h12M4 15.5h12"} /></svg>
    </span>
    <Switch size="sm" checked={compact}
      onCheckedChange={(checked) => onChange(checked ? "compact" : "comfortable")}
      aria-label={compact ? "当前为紧凑密度，切换到舒适密度" : "当前为舒适密度，切换到紧凑密度"} />
  </label>;
}

function TaskSyncIndicator({
  state,
  onRetry,
}: {
  state: TaskSyncState;
  onRetry: () => Promise<void>;
}) {
  const copy = taskSyncCopy(state);
  const title = state.kind === "error"
    ? state.detail
    : state.last_success_at
      ? `最近同步：${formatLocalDateTime(state.last_success_at, { seconds: true })}`
      : copy.detail;
  // 同步状态(#228 工具类化):成功安静(绿点+灰字),失败变红可点重试;
  // loading 点沿用 1.25s 呼吸节奏(animate-pulse 直译 taskSyncPulse)。
  const shell = cn("inline-flex h-8 shrink-0 items-center gap-[7px] rounded-[6px] border px-2 text-left text-base",
    state.kind === "error"
      ? "cursor-pointer border-(--danger)/30 bg-(--danger-soft) text-(--danger)"
      : "border-transparent");
  const body = <>
    <i aria-hidden className={cn("size-1.5 shrink-0 rounded-full",
      state.kind === "error" ? "bg-(--danger)"
        : state.kind === "loading" ? "animate-pulse bg-(--active)"
          : "bg-(--success)")} />
    <span className="flex items-baseline gap-1.5"><strong className={cn("text-xs font-medium", state.kind === "error" ? "text-(--danger)" : "text-(--faint)")}>{copy.title}</strong><small className={state.kind === "error" ? "inline text-xs whitespace-nowrap text-(--danger)" : "hidden"}>{copy.detail}</small></span>
    {copy.retry && <svg viewBox="0 0 18 18" aria-hidden className="size-3.5">
      <path d="M14.5 6.5A5.75 5.75 0 1 0 15 11M14.5 3v3.5H11" />
    </svg>}
  </>;
  return copy.retry ? (
    <button type="button" className={shell} title={title}
      onClick={() => void onRetry()}>{body}</button>
  ) : (
    <span className={shell} title={title}>{body}</span>
  );
}

/** 导出供预览脚本 SSR 截图(组件统一化同款纪律:样式集中,不在
 * 组件里 import CSS,node 可导入)。 */
export function PersonalSettingsPage({
  session,
  onSessionPatch,
  onTasksChanged,
}: {
  session: AuthUser;
  onSessionPatch: (patch: Partial<AuthUser>) => void;
  onTasksChanged: () => Promise<void>;
}) {
  return <div className="grid gap-6">
    <InterventionSetting session={session} onChanged={async (patch) => {
      onSessionPatch(patch);
      await onTasksChanged();
    }} />
    <IssueInterventionSetting session={session} onChanged={async (patch) => {
      onSessionPatch(patch);
      await onTasksChanged();
    }} />
    {/* 自动接单是问题处理侧的个人开关:管理员不写问题会话,不给这张卡。 */}
    {session.role !== "admin" && <IssueAutoClaimSetting session={session}
      onChanged={async (patch) => { onSessionPatch(patch); }} />}
    <section aria-labelledby="personal-connections-title">
      <div className="mb-[11px] flex items-end justify-between gap-[18px] px-0.5 max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-[5px]">
        <div><h2 id="personal-connections-title" className="mt-[5px] text-[19px] leading-[1.2] tracking-[-0.025em] text-(--text-strong)">个人接入</h2></div>
        <p className="m-0 text-sm text-(--muted)">配置一次，后续任务自动使用你的代码身份、消息通知和模型接入。</p>
      </div>
      <div className="grid grid-cols-2 items-start gap-[11px] max-[760px]:grid-cols-1">
        <GitTokenCard session={session} onChanged={onSessionPatch} />
        <LubanTokenCard session={session} onChanged={onSessionPatch} />
        {/* 个人模型网关(ADR-0068):四字段表单比令牌卡宽,占满整行。
            配齐即名下任务主模型调用整体走本人接入,清空回落平台网关。 */}
        <PersonalModelsCard session={session} onChanged={onSessionPatch} />
      </div>
    </section>
  </div>;
}

function NavIcon({ name }: { name: View }) {
  if (name === "answers") return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4.75h14a1.5 1.5 0 0 1 1.5 1.5v10a1.5 1.5 0 0 1-1.5 1.5h-8l-5 3v-3H5a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 5 4.75Z" /><path d="M8 9h8M8 13h5" /></svg>;
  if (name === "deliveryAnalysis") return <svg viewBox="0 0 24 24" aria-hidden><path d="M4 19V5M4 19h16M8 15v-4M12 15V7M16 15v-6" /></svg>;
  if (name === "team") return <svg viewBox="0 0 24 24" aria-hidden><path d="M4.75 19.25V11.5h4v7.75h-4Zm5.75 0V4.75h4v14.5h-4Zm5.75 0V8h4v11.25h-4Z" /></svg>;
  if (name === "teamIssues") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="13.5" r="4.25" /><path d="M12 9.25V6.5M7 11 5.25 9.5M17 11l1.75-1.5M6.25 16.5H4M20 16.5h-2.25M8 18.5 6.5 20M16 18.5l1.5 1.5" /></svg>;
  if (name === "mine") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="8" r="3.25" /><path d="M5.5 19.25c.65-3.45 2.82-5.25 6.5-5.25s5.85 1.8 6.5 5.25" /></svg>;
  if (name === "issues") return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 4.75 20 18.5H4L12 4.75Z" /><path d="M12 10v4M12 16.4v.2" /></svg>;
  if (name === "profile") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75" /><circle cx="17.5" cy="15.5" r="2.25" /><path d="M17.5 11.75v1.5M17.5 17.75v1.5M13.75 15.5h1.5M19.75 15.5h1.5" /></svg>;
  if (name === "wishes") return <svg viewBox="0 0 24 24" aria-hidden><path d="M12 20.25s-7.25-4.1-7.25-10.1A4.4 4.4 0 0 1 12 6.8a4.4 4.4 0 0 1 7.25 3.35c0 6-7.25 10.1-7.25 10.1Z" /><path d="m17.5 3.75.45 1.3 1.3.45-1.3.45-.45 1.3-.45-1.3-1.3-.45 1.3-.45.45-1.3Z" /></svg>;
  if (name === "users") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="9" cy="8" r="3" /><path d="M3.75 18.5c.55-3.15 2.3-4.75 5.25-4.75s4.7 1.6 5.25 4.75M16.5 7.5h4M18.5 5.5v4" /></svg>;
  if (name === "settings") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="3" /><path d="M12 4.5v2M12 17.5v2M4.5 12h2M17.5 12h2M6.7 6.7l1.4 1.4M15.9 15.9l1.4 1.4M6.7 17.3l1.4-1.4M15.9 8.1l1.4-1.4" /></svg>;
  if (name === "environments") return <svg viewBox="0 0 24 24" aria-hidden><rect x="4.75" y="4.75" width="14.5" height="5.75" rx="1.25" /><rect x="4.75" y="13.5" width="14.5" height="5.75" rx="1.25" /><path d="M8.25 7.6h.01M8.25 16.4h.01" /></svg>;
  if (name === "help") return <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="8.25" /><path d="M9.7 9.1a2.5 2.5 0 0 1 4.8.9c0 1.8-2.5 2-2.5 3.7M12 17.3v.15" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden><path d="M5 4.75h14A1.25 1.25 0 0 1 20.25 6v12A1.25 1.25 0 0 1 19 19.25H5A1.25 1.25 0 0 1 3.75 18V6A1.25 1.25 0 0 1 5 4.75Z" /><path d="M8 9h8M8 13h5" /></svg>;
}

// MR 绿灯/待合入仍是活动任务：它继续监听门禁、流水线和人工检视，
// 但在“我的工作”里与已完成任务共用交付接力区，不混进自动推进列表。
const DELIVERY_HANDOFF_STATUSES: TaskStatus[] = ["await_merge", "completed"];

export interface PersonalActionItem {
  key: string;
  task?: TaskSummary;
  kicker: string;
  title: string;
  detail: ReactNode;
  action: string;
  href?: string;
}

/** 顶部行动清单与侧栏角标共用同一份事实。尤其 Committer 邀请可能来自
 * 别人归属的任务，关联时必须查全量可见任务，不能查“我的任务”子集。 */
export function buildPersonalActionItems({
  waiting,
  intervention,
  merges,
  reviews,
  tasks,
  discussions = [],
}: {
  waiting: TaskSummary[];
  intervention: TaskSummary[];
  merges: TaskSummary[];
  reviews: ReviewRequest[];
  tasks: TaskSummary[];
  /** 别人的分析单邀请我参与讨论、卡正等回答。 */
  discussions?: TaskSummary[];
}): PersonalActionItem[] {
  const seen = new Set<string>();
  const items: PersonalActionItem[] = [];
  for (const task of waiting) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `decision:${task.id}`,
      task,
      kicker: "等待你的决定",
      title: task.title ?? task.requirement,
      detail: task.focus?.next_action ?? "查看材料并完成当前确认",
      action: "立即处理",
    });
  }
  for (const task of discussions) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `discussion:${task.id}`,
      task,
      kicker: "受邀参与讨论",
      title: task.title ?? task.requirement,
      detail: `${responsibleOf(task) ?? "责任人"} 邀请你一起回答 Agent 的问题`,
      action: "去回答",
    });
  }
  for (const review of reviews) {
    const task = tasks.find((candidate) => candidate.id === review.task_id);
    if (review.status !== "pending" || isReviewTaskEnded(task?.status)) continue;
    items.push({
      key: `review:${review.id}`,
      task,
      kicker: "Committer 检视",
      title: review.task_title,
      detail: task
        ? <><PersonName account={review.requester} /> 邀请你检视代码与交付材料</>
        : <><PersonName account={review.requester} /> 邀请你检视；任务详情暂未同步，请稍后刷新</>,
      action: task ? "开始检视" : "任务暂不可用",
    });
  }
  for (const task of intervention) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    items.push({
      key: `intervention:${task.id}`,
      task,
      kicker: task.status === "paused" ? "任务已暂停" : "需要人工介入",
      title: task.title ?? task.requirement,
      detail: task.focus?.next_action ?? task.detail ?? "打开工作台并决定下一步",
      action: "打开工作台",
    });
  }
  for (const task of merges) {
    if (seen.has(task.id)) continue;
    seen.add(task.id);
    const final = task.delivery?.final_mr;
    const closed = final?.state === "closed";
    const mrUrl = final?.url ?? task.delivery?.mr_url;
    items.push({
      key: `merge:${task.id}`,
      task,
      kicker: closed ? "最终 MR 已关闭" : "等待你去合入",
      title: task.title ?? task.requirement,
      detail: final ? closed ? "最终 MR 已关闭，可在任务详情中更换。" : "正在等待最终 MR 合入。"
        : mrUrl ? `验证已通过，请到 CodeHub 完成检视与合入：${mrUrl}` : "验证已通过，请到 CodeHub 完成检视与合入",
      action: closed ? "打开工作台" : final ? "查看最终 MR" : "查看合入请求",
      href: closed ? undefined : mrUrl,
    });
  }
  return items;
}

export function App() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [density, setDensity] = useState<Density>(() =>
    document.documentElement.dataset.density === "compact" ? "compact" : "comfortable");
  const [session, setSession] = useState<AuthUser | null>();
  const authGeneration = useRef(0);
  const authRequests = useRef(new Set<AbortController>());
  const signOutInFlight = useRef(false);
  const [sessionLoadFailed, setSessionLoadFailed] = useState(false);
  const [sessionChecking, setSessionChecking] = useState(true);
  const [sessionRetry, setSessionRetry] = useState(0);
  const [buildHash, setBuildHash] = useState<string | null>(null);
  const [view, setView] = useState<View>("team");
  const [mineScope, setMineScope] = useState<MineScope>("all");
  // 任务列表顺序:默认最新在上(用户实锤);切换记在本机,下次进来沿用。
  const [taskOrder, setTaskOrderState] = useState<"newest" | "attention">(() => {
    try {
      return localStorage.getItem("mae-flow-task-order") === "attention"
        ? "attention" : "newest";
    } catch { return "newest"; }
  });
  const setTaskOrder = (
    update: (current: "newest" | "attention") => "newest" | "attention",
  ) => setTaskOrderState((current) => {
    const next = update(current);
    try { localStorage.setItem("mae-flow-task-order", next); } catch { /* 仍保留本次选择 */ }
    return next;
  });
  const [teamTaskTab, setTeamTaskTab] = useState<TeamTaskTab>("current");
  /** 交付分析入场页签:团队DTS档案的「交付统计」跳转指定落「DTS」,
   * 侧栏与直连不经过它,恒为需求交付。 */
  const [deliveryAnalyticsTab, setDeliveryAnalyticsTab] = useState<
    "requirement" | "issue" | "registration" | "knowledge">("requirement");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [teamIssues, setTeamIssues] = useState<IssueSummary[]>([]);
  // 本人问题列表(GET /issues,服务端按「归属或登记人是自己」过滤,
  // ADR-0031):只喂侧栏「问题处理」父行徽章。admin 的同名请求返回的
  // 是全量(服务端只对非 admin 收窄),与 teamIssues 重复,故 admin 不拉。
  const [myIssues, setMyIssues] = useState<IssueSummary[]>([]);
  const [teamUsers, setTeamUsers] = useState<AuthUser[]>([]);
  const [teamAssetTab, setTeamAssetTab] = useState<TeamAssetTab>(() =>
    readKnowledgeAssetFocus()?.kind === "business" ? "modules" : "knowledge");
  const [knowledgeFocus, setKnowledgeFocus] = useState<KnowledgeAssetFocus | undefined>(
    readKnowledgeAssetFocus,
  );
  /** 下单选择器"查看方案"带过来的直达目标;资产库挂载时消费。 */
  const [helpArticleId, setHelpArticleId] = useState(() => {
    const match = location.pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
    if (!match?.[1]) return "getting-started";
    try { return decodeURIComponent(match[1]); }
    catch { return "getting-started"; }
  });
  const [myReviews, setMyReviews] = useState<ReviewRequest[]>([]);
  const [artifactTaskId, setArtifactTaskId] = useState("");
  const [artifactTaskSnapshot, setArtifactTaskSnapshot] = useState<TaskSummary>();
  const [launchOpen, setLaunchOpen] = useState(false);
  const [wishDraft, setWishDraft] = useState<WishWallDraft>();
  const [launchGate, setLaunchGate] = useState<LaunchGateState>({ kind: "checking" });
  const launchGateRequest = useRef(0);
  const [taskSync, setTaskSync] = useState<TaskSyncState>({ kind: "loading" });
  /** 深链指向的任务已不存在时的提示(空串=无提示)。 */
  const [missingTaskNotice, setMissingTaskNotice] = useState("");
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined);
  const sidebarRefreshInFlight = useRef<Promise<unknown> | undefined>(undefined);
  const [targetRoute, setTargetRoute] = useState(readWorkspaceRoute);
  const targetTaskId = targetRoute.taskId;
  const targetReviewId = targetRoute.reviewId;
  // 问题会话工作台路由(/issues/:id):App 层是唯一写入口(openIssueSession/
  // closeIssueSession/selectView 对表),快照与 URL 同生共死——不变量:
  // issueRouteId 非空 ⇔ 当前 URL 是 /issues/:id。
  const [issueRouteId, setIssueRouteId] = useState(readIssueRoute);
  /** 问题处理子页签选择(持久化见票 #171):默认问题会话;admin 强制。 */
  const [issueChildTab, setIssueChildTab] =
    useState<IssueChildTab>(readIssueChildTab);
  /** admin 强制「问题会话」后的生效值;issueChildTab 是持久化原值。 */
  const activeIssueChild = session?.role === "admin"
    ? "sessions" : issueChildTab;
  /** selectView 闭包里读子页签要最新值:setIssueChildTab 后同一 tick
   * 调 selectView 时,状态还没落地,快照会落后一次点击。 */
  const activeIssueChildRef = useRef(activeIssueChild);
  activeIssueChildRef.current = activeIssueChild;
  // 子页签选择持久化:localStorage(刷新还原)+ 浏览器历史快照
  // (前进/后退还原,写入点见各 pushState/replaceState)。
  useEffect(() => {
    try { localStorage.setItem(ISSUE_CHILD_STORAGE_KEY, issueChildTab); }
    catch { /* 存不进就算了,会话内仍然可用 */ }
  }, [issueChildTab]);

  useEffect(() => {
    const syncRoute = () => {
      const next = readWorkspaceRoute();
      setTargetRoute(next);
      const issueId = readIssueRoute();
      setIssueRouteId(issueId);
      // 浏览器在别的页签后退/前进到 /issues/X:除更新快照外还要真的切
      // 回问题处理页签(以前只改状态不切页,按后退像没反应)。admin 也进
      // 问题处理(#103,查看模式只读);/work 深链照旧只恢复任务。
      // 子页签随深链落「问题会话」——深链指的就是一个会话。
      if (issueId) {
        setView("issues");
        setIssueChildTab(readIssueRoute().startsWith("mr-repair-") ? "pipeline" : "sessions");
      } else if (/^\/(?:issues|pipeline-repairs)\/?$/.test(location.pathname)) {
        if (location.pathname.startsWith("/pipeline-repairs")) setIssueChildTab("pipeline");
        // 后退/前进到裸 /issues(问题登记入站深链):同款对表,落问题
        // 处理页签本身(子页签沿用持久化,与 initialView 同一口径)。
        setView("issues");
      }
      if (!next.taskId) {
        setArtifactTaskId("");
        setArtifactTaskSnapshot(undefined);
      }
    };
    addEventListener("popstate", syncRoute);
    return () => removeEventListener("popstate", syncRoute);
  }, [session?.role]);

  useEffect(() => {
    const syncKnowledgeRoute = (event: PopStateEvent) => {
      const focus = readKnowledgeAssetFocus();
      setKnowledgeFocus(focus);
      if (!focus) {
        const kbPage = new URLSearchParams(location.search).get("kbPage");
        const restoredView = kbPage ? (kbPage === "ask" ? "answers" : "library") : viewFromHistoryState(event.state);
        const restoredTab = teamAssetTabFromHistoryState(event.state);
        const restoredIssueChild = issueChildTabFromHistoryState(event.state);
        if (restoredView) setView(restoredView);
        if (restoredTab) setTeamAssetTab(restoredTab);
        // 后退/前进还原问题处理子页签;admin 的强制口径在渲染处兜底。
        if (restoredIssueChild) setIssueChildTab(restoredIssueChild);
        return;
      }
      setTeamAssetTab(focus.kind === "business" ? "modules" : "knowledge");
      setView("knowledge");
    };
    addEventListener("popstate", syncKnowledgeRoute);
    return () => removeEventListener("popstate", syncKnowledgeRoute);
  }, []);

  // FAQ 支持把具体文章链接直接发给别人；浏览器前进/后退也要真的切页，
  // 不能只改地址栏。离开 /help 后回到该角色的默认首页。
  useEffect(() => {
    if (!session) return;
    const syncHelpRoute = () => {
      const match = location.pathname.match(/^\/help(?:\/([^/]+))?\/?$/);
      if (match) {
        let articleId = "getting-started";
        try { articleId = match[1] ? decodeURIComponent(match[1]) : articleId; }
        catch { /* 坏地址由帮助中心回到第一篇 */ }
        setHelpArticleId(articleId);
        setView("help");
      } else {
        setView((current) => current === "help" ? initialView(session) : current);
      }
    };
    addEventListener("popstate", syncHelpRoute);
    return () => removeEventListener("popstate", syncHelpRoute);
  }, [session?.username, session?.role]);

  // 环境管理深链(/environments)与 FAQ 同一纪律:浏览器前进/后退要真的
  // 切页;离开 /environments 后回到该角色的默认首页(或历史项里记住的视图)。
  useEffect(() => {
    if (!session) return;
    const syncEnvironmentRoute = (event: PopStateEvent) => {
      if (readEnvironmentRoute()) {
        setView("environments");
        return;
      }
      const restoredView = viewFromHistoryState(event.state);
      setView((current) => current === "environments"
        ? restoredView ?? initialView(session) : current);
    };
    addEventListener("popstate", syncEnvironmentRoute);
    return () => removeEventListener("popstate", syncEnvironmentRoute);
  }, [session?.username, session?.role]);

  useEffect(() => () => {
    authGeneration.current += 1;
    for (const request of authRequests.current) request.abort();
  }, []);

  useEffect(() => {
    if (session !== undefined) return;
    const generation = authGeneration.current;
    let stopped = false;
    let inFlight = false;
    let request: AbortController | undefined;
    const load = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      setSessionChecking(true);
      request = new AbortController();
      try {
        const user = await readSession(request);
        if (stopped || authGeneration.current !== generation) return;
        authGeneration.current += 1;
        setSessionLoadFailed(false);
        setSession(user);
        if (user) {
          setView(initialView(user));
          if (readIssueRoute()) setIssueChildTab(readIssueRoute().startsWith("mr-repair-") ? "pipeline" : "sessions");
        }
      } catch {
        if (!stopped && authGeneration.current === generation) setSessionLoadFailed(true);
      } finally {
        inFlight = false;
        if (!stopped && authGeneration.current === generation) setSessionChecking(false);
      }
    };
    const stop = startVisiblePolling(() => void load(), 3000, document);
    return () => { stopped = true; stop(); request?.abort(); };
  }, [session === undefined, sessionRetry]);

  useEffect(() => {
    getBuildInfo().then((info) => setBuildHash(info.build_hash)).catch(() => {});
  }, []);

  function refreshLaunchGate(showChecking = true): Promise<void> {
    const account = session;
    if (!account || account.role === "admin") return Promise.resolve();
    const request = ++launchGateRequest.current;
    if (showChecking) setLaunchGate({ kind: "checking" });
    return getLaunchOptions().then((options) => {
      if (launchGateRequest.current !== request) return;
      setLaunchGate(options.blockers.length > 0
        ? { kind: "blocked", blockers: options.blockers }
        : { kind: "ready" });
    }).catch((cause) => {
      if (launchGateRequest.current !== request) return;
      setLaunchGate({
        kind: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  // 发起条件必须以服务端为准：部署形态决定是否需要 Git / 小鲁班，
  // 管理员配置也可能热更新。个人设置保存后 session hint 改变，会立即
  // 复查；不能再靠前端硬编码几个字段猜测。
  useEffect(() => {
    if (!session || session.role === "admin") return;
    void refreshLaunchGate(true);
  }, [
    session?.username,
    session?.role,
    session?.git_token_hint,
    session?.git_email,
    session?.luban_token_hint,
  ]);

  function refresh(): Promise<void> {
    if (!session || signOutInFlight.current) return Promise.resolve();
    const generation = authGeneration.current;
    const currentSession = () => authGeneration.current === generation;
    // 旁栏各自更新，慢请求或接口未启用都不能拖住任务列表和任务深链。
    if (!sidebarRefreshInFlight.current) {
      const sidebars = Promise.allSettled([
        listMyReviews().then((rows) => { if (currentSession()) setMyReviews(rows); }),
        listAllIssues().then((rows) => { if (currentSession()) setTeamIssues(rows); }),
        session?.role === "admin" ? Promise.resolve()
          : listIssues().then((rows) => { if (currentSession()) setMyIssues(rows); }),
      ]);
      sidebarRefreshInFlight.current = sidebars;
      void sidebars.finally(() => {
        if (sidebarRefreshInFlight.current === sidebars) sidebarRefreshInFlight.current = undefined;
      });
    }
    if (refreshInFlight.current) return refreshInFlight.current;
    // 等人的排最前、等最久的第一:这块屏幕先回答"谁在等我"。
    setTaskSync((current) => current.kind === "error"
      ? { kind: "loading", last_success_at: current.last_success_at }
      : current);
    const running = (async () => {
      try {
        const rows = await listTasks();
        if (!currentSession()) return;
        setTasks(rows.sort(byUrgency));
        setTaskSync({ kind: "live", last_success_at: new Date().toISOString() });
      } catch (cause) {
        if (!currentSession()) return;
        // 网络抖动不能把用户踢回登录页；只有 /auth/me 明确返回未登录才退出。
        let current: AuthUser | null | undefined;
        try { current = await readSession(); } catch { current = undefined; }
        if (!currentSession()) return;
        if (current === null) {
          invalidateSessionRequests();
          setSession(null);
          return;
        }
        setTaskSync((previous) => ({
          kind: "error",
          last_success_at: previous.last_success_at,
          detail: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    })();
    refreshInFlight.current = running;
    void running.finally(() => {
      if (refreshInFlight.current === running) refreshInFlight.current = undefined;
    });
    return running;
  }

  useEffect(() => {
    if (!session) return;
    setTaskSync({ kind: "loading" });
    return startVisiblePolling(() => void refresh(), 1500, document);
  }, [session?.username]);

  useEffect(() => {
    if (!session) return;
    const generation = authGeneration.current;
    let stopped = false;
    let inFlight = false;
    let request: AbortController | undefined;
    const check = async () => {
      if (stopped || inFlight || signOutInFlight.current) return;
      inFlight = true;
      request = new AbortController();
      try {
        const current = await readSession(request);
        if (!stopped && authGeneration.current === generation && current === null) {
          invalidateSessionRequests();
          setSession(null);
        }
      } catch { /* 临时连接故障保留当前身份，下次可见或定时检查时再试。 */ }
      finally { inFlight = false; }
    };
    const stop = startVisiblePolling(() => void check(), 60 * 60 * 1000, document, { runOnStart: false });
    return () => { stopped = true; stop(); request?.abort(); };
  }, [session?.username]);

  useEffect(() => {
    if (session?.role !== "admin" || view !== "team") return;
    const generation = authGeneration.current;
    let alive = true;
    void listUsers().then((rows) => {
      if (alive && authGeneration.current === generation) setTeamUsers(rows);
    }).catch(() => {
      if (alive && authGeneration.current === generation) setTeamUsers([]);
    });
    return () => { alive = false; };
  }, [session?.username, session?.role, view]);


  useEffect(() => {
    if (view !== "mine" || !targetTaskId || tasks.length === 0) return;
    const timer = window.setTimeout(() => document.getElementById(`task-${targetTaskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    return () => clearTimeout(timer);
  }, [view, targetTaskId, tasks.length]);

  // 通知/复制链接进入时直接打开指定任务工作台。Committer 不要求任务
  // 归属本人；能否操作仍由服务端和 canOperate 决定，URL 不授予权限。
  useEffect(() => {
    const resolution = resolveWorkspaceTarget(
      targetTaskId,
      artifactTaskId,
      tasks,
      taskSync.kind === "live",
    );
    if (resolution.kind === "pending") return;
    if (resolution.kind === "missing") {
      // 深链指向的任务不在列表里(已删除/链接过期):静默返回的话页面
      // 停在普通"我的工作",人只会怀疑自己点错或系统坏了(2026-08-30
      // 审计)。说破并把 URL 收回根路径。
      setMissingTaskNotice(targetTaskId);
      setTargetRoute({ taskId: "", reviewId: "" });
      history.replaceState({}, "", "/");
      return;
    }
    const target = resolution.task;
    setMissingTaskNotice("");
    setArtifactTaskSnapshot(target);
    setArtifactTaskId(target.id);
    const canonical = workspacePath(targetTaskId, targetReviewId);
    if (location.pathname + location.search !== canonical) {
      history.replaceState({}, "", canonical);
    }
  }, [targetReviewId, targetTaskId, tasks, artifactTaskId, taskSync.kind]);

  // 打开的工作台必须跨轮询稳定存在。任务在状态切换时可能有一拍没出现在
  // 列表响应里；若直接用 tasks.find 渲染,组件会被卸载再挂载,表现为
  // “一点专注审阅就闪退”,同时丢掉当前文件和展开状态。
  useEffect(() => {
    if (!artifactTaskId) return;
    const latest = tasks.find((task) => task.id === artifactTaskId);
    if (latest) setArtifactTaskSnapshot((current) => current?.id === latest.id
      ? {
          ...current,
          ...latest,
          // 易变字段必须以最新响应为准——包括"从有到无"。waiting 清掉
          // 后 JSON 里没有这个键,普通 spread 会让旧决策卡/勾选条永远
          // 残留在工作台上(MFC-009:await_merge 后仍显示"最终范围
          // 2/21")。undefined 覆盖即删除。
          waiting: latest.waiting,
          delivery: latest.delivery,
          delivery_selection: latest.delivery_selection,
          knowledge_usage: current.knowledge_usage,
        }
      : latest);
  }, [tasks, artifactTaskId]);

  // 列表轮询保持轻量；只有真正打开工作台时才读取知识足迹和完整收据。
  useEffect(() => {
    if (!artifactTaskId) return;
    let alive = true;
    void getTask(artifactTaskId).then((detail) => {
      if (alive) setArtifactTaskSnapshot(detail);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [artifactTaskId]);

  // 受邀参与讨论(协作者/逐仓责任人)的分析单也算我的活:卡等的是你的
  // 回答,只在团队列表亮个信号灯等于邀请了没喊人。分析确认后 stage
  // 变了自然退出。判据与服务端 canCollaborate 同口径。
  const invitedToDiscuss = (task: TaskSummary) => !!session
    && task.requirement_graph?.stage === "analysis"
    && responsibleOf(task) !== session.username
    && (task.collaborators?.includes(session.username) === true
      || task.requirement_graph.repositories.some((repository) =>
        repository.assignee === session.username));
  const assignedToMe = session
    ? tasks.filter((task) => responsibleOf(task) === session.username)
    : [];
  const discussingWithMe = tasks.filter(invitedToDiscuss);
  // 管理员不再有个人待办:归属人=下单人是硬规则,无主任务只可能来自
  // 无鉴权的老现场,团队总览里照常可见、可打开兜底处置。

  // 视图打标:问题处理(issues)用淡红主题,与需求流的淡紫视觉分区
  // (body 级 data-view,CSS 变量作用域覆盖,见 style.css 尾部)。
  useEffect(() => {
    document.body.dataset.view = view;
    return () => { delete document.body.dataset.view; };
  }, [view]);

  async function readSession(request = new AbortController()): Promise<AuthUser | null> {
    authRequests.current.add(request);
    // 服务重启或连接挂起时仍须结束本次查验，随后继续自动重试。
    const timeout = window.setTimeout(() => request.abort(), 10_000);
    try { return await getSession(request.signal); }
    finally { window.clearTimeout(timeout); authRequests.current.delete(request); }
  }

  function invalidateSessionRequests(): number {
    authGeneration.current += 1;
    for (const request of authRequests.current) request.abort();
    refreshInFlight.current = undefined;
    sidebarRefreshInFlight.current = undefined;
    launchGateRequest.current += 1;
    setTasks([]);
    setTeamIssues([]);
    setMyIssues([]);
    setMyReviews([]);
    setTeamUsers([]);
    setArtifactTaskId("");
    setArtifactTaskSnapshot(undefined);
    setTaskSync({ kind: "loading" });
    return authGeneration.current;
  }

  if (session === undefined) return sessionLoadFailed
    ? <SessionConnectionScreen checking={sessionChecking} onRetry={() => setSessionRetry((retry) => retry + 1)} />
    : <LoadingScreen />;
  if (session === null) return <LoginScreen onAuthenticated={(user) => {
    invalidateSessionRequests();
    setLaunchGate({ kind: "checking" });
    setSession(user); setMineScope("all");
    setView(initialView(user));
  }} />;

  async function signOut() {
    if (signOutInFlight.current) return;
    signOutInFlight.current = true;
    const generation = invalidateSessionRequests();
    try { await logout().catch(() => undefined); }
    finally { signOutInFlight.current = false; }
    if (authGeneration.current !== generation) return;
    setMineScope("all");
    setLaunchGate({ kind: "checking" });
    setSession(null);
  }

  function changeTheme(next: Theme) {
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem("mae-flow-theme", next); } catch { /* 仍保留本次选择 */ }
  }

  function changeDensity(next: Density) {
    document.documentElement.dataset.density = next;
    setDensity(next);
    try { localStorage.setItem("mae-flow-density", next); } catch { /* 仍保留本次选择 */ }
  }

  function patchSession(patch: Partial<AuthUser>) {
    setSession((current) => current ? { ...current, ...patch } : current);
  }

  const waitingCount = tasks.filter((task) => task.status === "waiting_for_human").length;
  // 团队问题徽章与「等你答复」同口径(idle 归一进待答复,与问题处理页一致)。
  const issueWaitingCount = teamIssues.filter((issue) =>
    issue.status === "waiting_user" || issue.status === "idle").length;
  // 「问题处理」父行徽章=名下进行中的问题数:归属或登记人是自己(GET
  // /issues 与列表页同一份数据),未收口(非归档/非取消),与页内默认
  // 筛选项「进行中」共用 isIssueActive 同一判定。admin 只读围观不推进
  // 问题,不挂徽章。
  const myActiveIssueCount = myIssues
    .filter((issue) => isIssueActive(issue.status)).length;
  const myTasks = [...assignedToMe, ...discussingWithMe];
  const myWaiting = myTasks.filter((task) => task.status === "waiting_for_human");
  const pendingReviews = myReviews.filter((review) => review.status === "pending"
    && !isReviewTaskEnded(tasks.find((task) => task.id === review.task_id)?.status));
  const myBlocked = myTasks.filter((task) =>
    task.status !== "waiting_for_human" && isBlocked(task));
  const myPaused = myTasks.filter((task) => task.status === "paused");
  const myIntervention = [...new Map(
    [...myBlocked, ...myPaused].map((task) => [task.id, task]),
  ).values()].sort(byTeamAttention);
  const myActive = myTasks.filter((task) =>
    task.status !== "waiting_for_human" && !isBlocked(task)
    && task.status !== "paused" && task.status !== "canceled"
    && !DELIVERY_HANDOFF_STATUSES.includes(task.status));
  // 子任务跟着父任务所在的桶走:先完成的子任务不从父任务下面消失。
  const myCurrent = keepFamiliesTogether(myTasks.filter((task) =>
    task.status !== "canceled" && !DELIVERY_HANDOFF_STATUSES.includes(task.status)), myTasks)
    .sort(byTeamAttention);
  const myDelivered = keepFamiliesTogether(myTasks.filter((task) =>
    DELIVERY_HANDOFF_STATUSES.includes(task.status)), myTasks);
  const myMerges = myTasks.filter((task) => task.status === "await_merge");
  const personalActionItems = buildPersonalActionItems({
    waiting: myWaiting.filter((task) => !invitedToDiscuss(task)),
    discussions: myWaiting.filter(invitedToDiscuss),
    intervention: myIntervention,
    merges: myMerges,
    reviews: pendingReviews,
    // Committer 可以检视别人归属的任务；这里必须用全量可见目录关联。
    tasks,
  });
  const scopedMyWork = mineScope === "waiting" ? myWaiting
    : mineScope === "intervention" ? myIntervention
      : mineScope === "active" ? myActive
        : mineScope === "delivered" ? myDelivered : myCurrent;
  // 列表顺序是个开关:默认最新在最上面(用户实锤);切到"待核对在前"时
  // 沿用各分组原有的关注度排序。只动展示顺序,分组与计数不受影响。
  const visibleMyWork = taskOrder === "newest"
    ? [...scopedMyWork].sort(byNewest) : scopedMyWork;
  const visibleMyDelivered = taskOrder === "newest"
    ? [...myDelivered].sort(byNewest) : myDelivered;
  const myWorkTitle = mineScope === "waiting" ? "待我核对"
    : mineScope === "intervention" ? "需要介入 / 已暂停"
      : mineScope === "active" ? "自动推进中"
        : mineScope === "delivered" ? "等待合入与最近完成" : "当前任务";
  const artifactTask = artifactTaskId
    ? artifactTaskSnapshot?.id === artifactTaskId
      ? artifactTaskSnapshot
      : tasks.find((task) => task.id === artifactTaskId)
    : undefined;
  const openArtifacts = (task: TaskSummary) => {
    setArtifactTaskSnapshot(task);
    setArtifactTaskId(task.id);
    const next = workspacePath(task.id);
    if (location.pathname + location.search !== next) {
      history.pushState({}, "", next);
      setTargetRoute({ taskId: task.id, reviewId: "" });
    }
  };
  /** 页内切会话的唯一写入口(ADR-0040):应用内卡片一律新页签打开
   * /issues/:id(链接自带 URL,不经这里),这里保留给工作台内的会话
   * 内换题(历史触发者「挂起转正」已随 ADR-0048 退役),当前页签
   * 直切不新开。App 层快照与
   * URL 一次写齐,守住不变量:issueRouteId 非空 ⇔ 当前 URL 是
   * /issues/:id。 */
  const openIssueSession = (id: string) => {
    setView("issues");
    setIssueRouteId(id);
    // 深链/点开都指向一个会话:子页签一并落「问题会话」。
    setIssueChildTab(id.startsWith("mr-repair-") ? "pipeline" : "sessions");
    const next = issueSessionPath(id);
    if (location.pathname !== next) {
      history.pushState(appHistoryState("issues", undefined, id.startsWith("mr-repair-") ? "pipeline" : "sessions"),
        "", next);
    }
  };
  /** 关工作台回列表(ADR-0040):pushState 到裸 /issues——问题处理
   * 列表的正典地址,浏览器后退可回到本工作台;不用脚本关页签
   * (脚本只能关自己开出的页签,URL 直开的页签关不掉,行为会不一致)。
   * 离开问题处理域的归位守门(normalizeIssueRoute)另走一路,见
   * leaveIssueRoute。 */
  const closeIssueSession = () => {
    const repair = issueRouteId.startsWith("mr-repair-");
    history.pushState(appHistoryState("issues", undefined, repair ? "pipeline" : "sessions"),
      "", repair ? "/pipeline-repairs" : "/issues");
    setIssueRouteId("");
  };
  /** 离开问题处理域的归位守门:URL 滞留在 /issues/X(工作台深链)或裸
   * /issues(问题登记入站深链)时,就地 replaceState 回根路径并清快照
   * (toState 记录归位后所在视图)——该地址只是别名,不与视图脱钩滞留
   * 地址栏。与 closeIssueSession(工作台内回列表,pushState 留历史)
   * 分工:这里管"点侧栏走了",那里管"从工作台回列表"。 */
  const normalizeIssueRoute = (target: View) => {
    if (!readIssueRoute() && !/^\/(?:issues|pipeline-repairs)\/?$/.test(location.pathname)) return;
    history.replaceState(appHistoryState(target,
      target === "knowledge" ? teamAssetTab : undefined), "", "/");
    setIssueRouteId("");
  };
  const openRelatedTask = (taskId: string) => {
    const related = tasks.find((task) => task.id === taskId);
    if (related) openArtifacts(related);
  };
  const closeArtifacts = () => {
    setArtifactTaskId("");
    setArtifactTaskSnapshot(undefined);
    history.replaceState({}, "", "/");
    setTargetRoute({ taskId: "", reviewId: "" });
  };
  // 谁能提交决定:管理员或任务归属人。工作台与列表共用这一个口径。
  const canOperate = (task: TaskSummary) =>
    session.role === "admin" || responsibleOf(task) === session.username;
  const canCollaborate = (task: TaskSummary) => canOperate(task)
    || invitedToDiscuss(task);
  const header = {
    team: { title: "团队需求", description: teamTaskTab === "current"
      ? (session.role === "admin"
        ? "查看团队需求当前推进、负责人和阻塞风险；需要时进入任务工作台兜底。"
        : "了解团队此刻正在推进哪些需求；你的操作仍留在个人工作台。")
      : "回看已经形成结果的成果档案、MR 和事件记录。" },
    teamIssues: { title: "团队DTS", description:
      "团队问题会话全景：概览看分布，现场看推进，成果档案看闭环；点开单个会话围观现场。" },
    mine: { title: "我的需求", description: "从发起到交付，集中推进你的每一项需求任务。" },
    issues: { title: "问题处理", description: session.role === "admin"
      ? "全员问题会话只读查看:进入单个会话围观现场,操作仍属归属人。"
      : "登记问题并指派责任人，或处理指派到你名下的问题：先定位，后补单，非问题也是合法结论。" },
    profile: { title: "个人设置", description: "集中管理任务审批方式、CodeHub 提交身份和小鲁班通知。" },
    library: { title: "知识库", description: "" },
    answers: { title: "知识问答", description: "" },
    knowledge: { title: "知识全文", description: "下单时匹配到的模块知识或 Skill 原文。" },
    wishes: { title: "许愿墙", description: "汇聚真实诉求和使用问题；每一个声音都应该被看见、被回应、被闭环。" },
    users: { title: "账号管理", description: "创建本地账号并分配管理员或开发权限。" },
    settings: { title: "服务设置", description: "集中管理模型网关和团队运行策略；部署链路在此只读自检。" },
    environments: { title: "配置中心", description: "统一维护环境、基础映射和团队工作流，供需求、问题单和知识库直接使用。" },
    deliveryAnalysis: { title: "交付分析", description: "从首次提交到最终合入，看清代码保留与后续返工。" },
    help: { title: "使用帮助", description: "用大白话讲清每个功能：什么时候用、点哪里、接下来会发生什么。" },
  }[view];
  // 问题处理域页头随子页签换文案(spec #171 评审拍板):整域的静态说明
  // 对子页签没有信息量,每个子页签讲自己真正有用的一句。
  const issueChildHeaders: Record<IssueChildTab, { title: string; description: string }> = {
    pipeline: { title: "流水线修复", description: "输入已有 MR，让 Agent 修复编译、测试和代码质量失败。" },
    register: { title: "问题登记",
      description: "手工登记一个问题:说清现象、选业务模块;要处理 DTS 单,去「DTS 列表」勾选发起。" },
    dts: { title: "DTS 列表",
      description: "拉取名下处于可实施状态的问题单;勾选多张可批量发起,每单一个独立工作流。" },
    sessions: { title: "问题会话", description: session.role === "admin"
      ? "全员问题会话只读查看:进入单个会话围观现场,操作仍属归属人。"
      : "你的问题会话进展一览;点开在新页签进入工作台,分析报告检视与返工都在这里,可同时开着多个问题。" },
  };
  const viewHeader = view === "issues"
    ? issueChildHeaders[activeIssueChild]
    : header;
  // DTS 列表子页签全宽:标题条与内容区一起放开书页宽,左边缘对齐。
  const dtsWide = view === "issues" && activeIssueChild === "dts";
  const relevantWaiting = view === "mine"
    ? personalActionItems.length
    : view === "team" && teamTaskTab === "current" ? waitingCount
    : view === "teamIssues" ? issueWaitingCount : 0;
  const launchEntry = launchGateCopy(launchGate);
  /** 离开问题处理页签的归位守门人:URL 若还挂在 /issues/X(工作台深链),
   * 归位到根路径(归一实现在 normalizeIssueRoute)。目标仍是问题处理
   * (重点当前页签)不算离开,原样返回。 */
  const leaveIssueRoute = (target: View) => {
    if (target === "issues") return;
    normalizeIssueRoute(target);
  };
  /** 子页签选择:写状态 + 切到问题处理(点子页签即进该页面;已在
   * 问题处理只换右侧内容,不重复推历史)。工作台开着时点子页签=离开
   * 工作台回到所选页面(导航与内容一一对应);已在问题处理时以
   * replaceState 原地改写快照,前进/后退还原到最新选择。 */
  const selectIssueChild = (tab: IssueChildTab) => {
    activeIssueChildRef.current = tab;
    setIssueChildTab(tab);
    if (issueRouteId) {
      setIssueRouteId("");
      history.pushState(appHistoryState("issues", undefined, tab), "", tab === "pipeline" ? "/pipeline-repairs" : "/issues");
    }
    if (view !== "issues") {
      selectView("issues");
    } else if (location.pathname === "/" || location.pathname === "/issues" || location.pathname === "/pipeline-repairs") {
      // 根路径或裸 /issues(工作台回列表/登记入站深链后的落点):原地
      // 改写快照,前进/后退还原到最新选择——/issues 不再推新历史项。
      history.replaceState(appHistoryState("issues", undefined, tab), "",
        location.pathname + location.search);
    }
  };
  /** 离开环境管理页签的归位人:URL 若还挂在 /environments(深链直达后
   * 又点了别的页签),带回根路径并记住目标视图——与 leaveIssueRoute 同
   * 职责,两条深链路径互不重叠,各管各的归位。 */
  const leaveEnvironmentRoute = (target: View) => {
    if (!readEnvironmentRoute()) return;
    history.pushState(appHistoryState(target,
      target === "knowledge" ? teamAssetTab : undefined), "", "/");
  };
  const selectView = (next: View) => {
    const leavingKnowledgeFocus = readKnowledgeAssetFocus();
    if (leavingKnowledgeFocus) setKnowledgeFocus(undefined);
    if (next === "answers") { openKnowledgeAnswer(); setIssueRouteId(""); setView("answers"); return; }
    if (next === "library") {
      history.pushState(appHistoryState("library"), "", "/?kbPage=home"); setIssueRouteId(""); setView("library"); return;
    }
    if (next === "help") {
      const nextPath = `/help/${encodeURIComponent(helpArticleId)}`;
      if (location.pathname !== nextPath) {
        history.replaceState(appHistoryState(view,
          view === "knowledge" ? teamAssetTab : undefined), "",
          location.pathname + location.search);
        history.pushState(appHistoryState("help"), "", nextPath);
      }
    } else if (next === "environments") {
      // 台账深链:进页签就换地址(可复制、可后退),后退回上一视图;
      // 已在 /environments(刷新/直连)不重复压栈。
      if (location.pathname !== "/configuration") {
        history.pushState(appHistoryState("environments"), "", "/configuration");
      }
    } else if (/^\/help(?:\/|$)/.test(location.pathname)) {
      history.pushState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined,
        next === "issues" ? activeIssueChildRef.current : undefined), "", "/");
    } else if (leavingKnowledgeFocus) {
      history.pushState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined,
        next === "issues" ? activeIssueChildRef.current : undefined), "", "/");
    } else if (location.pathname === "/") {
      history.replaceState(appHistoryState(next,
        next === "knowledge" ? teamAssetTab : undefined,
        next === "issues" ? activeIssueChildRef.current : undefined), "",
        location.pathname + location.search);
    } else {
      leaveIssueRoute(next);
      leaveEnvironmentRoute(next);
    }
    // 不变量对表:进出页签、history 同步写完后按当前 URL 重读快照——
    // 进入问题处理拿到深链 id(有则直达工作台),离开则随归位清成空串。
    // Board 重挂时的 initialOpenId 从此与地址栏一致。
    if (["kbPage"].some(key => new URLSearchParams(location.search).has(key))) {
      const url = new URL(location.href);
      for (const key of ["kbPage", "kbAsk", "kbModule", "kbKind", "kbTask", "kbReview", "knowledgeDocument", "source_task", "memory_id"]) url.searchParams.delete(key);
      history.replaceState(appHistoryState(next, next === "knowledge" ? teamAssetTab : undefined), "", url);
    }
    setIssueRouteId(readIssueRoute());
    setView(next);
  };
  return <PeopleProvider key={session.username} known={[...teamUsers, session]}><SidebarProvider
    style={{ "--sidebar-width": "228px" } as React.CSSProperties}>
    {/* 侧栏(shadcn Sidebar 族,base-nova 皮,2026-09-11 迁移):列宽对齐
        旧 app-shell 的 228px,桌面观感延续;brand/主题/密度/会话脚沿用
        本站件,导航按钮换 nova 菜单语言。 */}
    <Sidebar collapsible="none" className="sticky top-0 h-svh">
      <SidebarHeader>
        <div className="mb-6 flex h-8 items-center gap-[9px] px-2"><BrandMark /><span className="flex min-w-0 items-baseline gap-2 leading-none max-[620px]:hidden"><strong className="text-[15px] font-semibold tracking-[-0.025em] text-(--text-strong)">Mae-Flow</strong></span></div>
      </SidebarHeader>
      <SidebarContent aria-label="视图切换" className="sidebar-reset">
        {session.role === "admin" ? <>
          <SidebarGroup>
            <SidebarGroupLabel>管理视角</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavButton view="team" current={view} onSelect={selectView} label="团队需求" />
                <NavButton view="teamIssues" current={view} onSelect={selectView} label="团队DTS" badge={issueWaitingCount} />
                {/* 问题处理对 admin 只读开放(#103):子页签只留「问题会话」,
                    登记入口不渲染;会话工作台自动落查看模式(写口仅归属人)。 */}
                <IssueNavGroup view="issues" current={view} admin
                  childTab={activeIssueChild} onSelectChild={selectIssueChild}
                  onSelect={selectView} />
                <NavButton view="wishes" current={view} onSelect={selectView} label="许愿墙" />
                <NavButton view="library" current={view} onSelect={selectView} label="知识库" />
                <NavButton view="answers" current={view} onSelect={selectView} label="知识问答" />

                <NavButton view="deliveryAnalysis" current={view} onSelect={selectView} label="交付分析" />
                {/* 台账对 admin 同样是团队资源而非系统工具(ADR-0020:admin 可
                    管理),与团队资产同进「管理视角」组。 */}
                <NavButton view="environments" current={view} onSelect={selectView} label="配置中心" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>系统管理</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavButton view="users" current={view} onSelect={selectView} label="账号管理" />
                <NavButton view="settings" current={view} onSelect={selectView} label="服务设置" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </> : <>
          <SidebarGroup>
            <SidebarGroupLabel>个人工作台</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavButton view="mine" current={view} onSelect={selectView} label="我的需求" badge={personalActionItems.length} />
                <IssueNavGroup view="issues" current={view} badge={myActiveIssueCount}
                  childTab={activeIssueChild} onSelectChild={selectIssueChild}
                  onSelect={selectView} />
                <NavButton view="profile" current={view} onSelect={selectView} label="个人设置" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>团队信息</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <NavButton view="team" current={view} onSelect={selectView} label="团队需求" />
                <NavButton view="teamIssues" current={view} onSelect={selectView} label="团队DTS" badge={issueWaitingCount} />
                <NavButton view="wishes" current={view} onSelect={selectView} label="许愿墙" />
                <NavButton view="library" current={view} onSelect={selectView} label="知识库" />
                <NavButton view="answers" current={view} onSelect={selectView} label="知识问答" />

                <NavButton view="deliveryAnalysis" current={view} onSelect={selectView} label="交付分析" />
                {/* 环境台账是全局团队资源(登录即可读写,ADR-0020):与团队资产
                    同组,不进 admin 专属的「系统管理」——那组是管理员工具。 */}
                <NavButton view="environments" current={view} onSelect={selectView} label="配置中心" />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </>}
      </SidebarContent>
      <SidebarFooter>
        <div className="sidebar-reset">
          <SidebarMenu>
            <NavButton view="help" current={view} onSelect={selectView} label="使用帮助" />
          </SidebarMenu>
        </div>
        <ThemeSwitch theme={theme} onChange={changeTheme} />
        <div className="flex items-center gap-2 border-t border-(--line) pl-1 pr-0 pt-3.5 text-sm text-(--muted) max-[760px]:hidden"><Avatar size="sm" aria-hidden className="after:hidden"><AvatarFallback className="bg-(--surface-3) text-xs font-semibold text-(--text-strong)">{(session.display_name ?? session.username).slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="flex min-w-0 flex-1 flex-col leading-[1.25]"><strong className="truncate text-sm font-medium text-(--text-strong)">{session.display_name ?? session.username}</strong><small className="mt-px text-xs text-(--faint)">{session.display_name ? session.username : session.role === "admin" ? "管理员" : "开发成员"}</small></span><DensitySwitch density={density} onChange={changeDensity} /><Button type="button" variant="ghost" size="icon-sm" className="text-(--faint) hover:bg-(--surface-3) hover:text-(--text-strong) [&_svg]:size-[15px]" onClick={signOut} title="退出登录" aria-label="退出登录"><svg viewBox="0 0 20 20"><path d="M8 4H4.75A1.25 1.25 0 0 0 3.5 5.25v9.5A1.25 1.25 0 0 0 4.75 16H8M12.5 6.5 16 10l-3.5 3.5M7 10h9" /></svg></Button></div>
        {buildHash && <div className="select-text pb-1 pt-0.5 text-center font-mono text-xs text-(--faint) max-[760px]:hidden" title="部署版本号(服务启动时间)——确认代码已生效">{buildHash}</div>}
      </SidebarFooter>
    </Sidebar>
    <SidebarInset>
    {/* 工作台壳(#228 工具类化):书页宽由 max-w 条件直译,DTS 全宽时
        与主区一起放开(不再有 is-wide 修饰类与 legacy 全宽规则)。 */}
    <div className="min-h-screen min-w-0 bg-(--canvas)">
      {view !== "library" && view !== "answers" && <header className={cn("mx-auto flex w-full items-end justify-between gap-6 px-10 pb-[26px] pt-8",
        // 与主区同一判据（标题条只在非 library 视图渲染）：783431e2 把 knowledge 移出主区
        // 全宽时漏了这里，宽屏上标题条与内容左边缘错开。
        dtsWide ? "max-w-none" : "max-w-(--page-width)",
        "max-[1080px]:px-7 max-[760px]:flex-col max-[760px]:items-start max-[760px]:gap-3.5 max-[760px]:px-[18px] max-[760px]:pt-[26px] max-[480px]:px-[13px]")}>
        <div className={view === "knowledge" ? "team-assets-heading" : undefined}>
          <h1 className="mb-2 text-[28px] font-[650] leading-[1.25] tracking-[-0.035em] text-(--text-strong) max-[760px]:text-xl">{viewHeader.title}</h1>
          {<p className={cn("m-0 text-sm text-(--muted)", view === "mine" && "flex flex-wrap items-center gap-2")}>{view === "mine" && <span className="font-mono text-sm font-medium leading-[1.4] text-(--muted) after:ml-2 after:content-['·'] after:text-(--faint)"><PersonName account={session.username} /></span>}<span>{viewHeader.description}</span></p>}

        </div>
        <div className="flex items-center justify-end gap-3 max-[1080px]:flex-wrap max-[760px]:w-full max-[760px]:justify-start">
          {(view === "mine" || view === "team") && <TaskSyncIndicator state={taskSync} onRetry={refresh} />}
          {relevantWaiting > 0 && view !== "users" && view !== "settings" && (
            <div className="flex h-8 items-center gap-2 whitespace-nowrap rounded-[8px] border border-(--attention)/10 bg-(--attention-soft) pl-[9px] pr-2.5 text-sm font-medium text-(--attention)">
              <span className="size-[7px] rounded-full bg-(--attention)" aria-hidden />
              <span><strong className="font-semibold tabular-nums">{relevantWaiting}</strong>{view === "mine" ? " 项需要我处理" : view === "teamIssues" ? " 项问题等你答复" : " 项工作等待决策"}</span>
            </div>
          )}
          {view === "mine" && session.role !== "admin" && (
            <div className="grid justify-items-end gap-1 max-[760px]:justify-items-center">
              <button type="button" title={launchEntry.title} aria-label={launchEntry.ariaLabel} onClick={() => setLaunchOpen(true)}
                className="inline-flex h-9 shrink-0 items-center justify-center gap-[7px] rounded-[8px] border border-[color-mix(in_srgb,var(--ink)_90%,black)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--ink)_90%,white),var(--ink))] px-3.5 pl-3 text-base font-medium text-(--ink-fg) shadow-[var(--shadow-primary)] transition-colors hover:bg-(--ink-hover) disabled:cursor-not-allowed disabled:border-(--surface-3) disabled:bg-(--surface-3) disabled:text-(--faint) disabled:shadow-none [&_svg]:size-[15px] [&_svg]:stroke-2">
                <svg viewBox="0 0 20 20" aria-hidden>{launchEntry.enabled ? <path d="M10 4v12M4 10h12" /> : <><rect x="5" y="8.5" width="10" height="8" rx="1.5" /><path d="M7.5 8.5V6.75a2.5 2.5 0 0 1 5 0V8.5" /></>}</svg><span>发起新任务</span>
              </button>
              {launchEntry.helper && (launchEntry.action ? (
                <button type="button" title={launchEntry.title} onClick={() => launchEntry.action === "profile" ? setView("profile") : void refreshLaunchGate(true)}
                  className="inline-flex items-center gap-[3px] p-0 text-xs font-medium text-(--muted) hover:text-(--text-strong) hover:underline [&_svg]:size-3">
                  {launchEntry.helper}<svg viewBox="0 0 16 16" aria-hidden><path d="m6 3 5 5-5 5" /></svg>
                </button>
              ) : (
                <span className="inline-flex cursor-default items-center gap-[3px] p-0 text-xs font-medium text-(--faint)" title={launchEntry.title}>{launchEntry.helper}</span>
              ))}
            </div>
          )}
        </div>
      </header>}
      {/* 全宽时标题条与内容区同步放开,左边缘对齐(不再悬在书页宽)。 */}
      <main className={cn("mx-auto w-full px-10 pb-[72px]",
        (dtsWide || view === "library" || view === "answers") ? "max-w-none" : "max-w-(--page-width)",
        "max-[1080px]:px-7 max-[760px]:px-[18px] max-[760px]:pb-[52px] max-[480px]:px-[13px]", view === "library" && "knowledge-app-main", view === "answers" && "ka-app-main")}>
        {view === "team" && <section className="min-w-0">
          <TeamWorldTabs domain="requirement" tab={teamTaskTab}
            onSelect={setTeamTaskTab}>
            {/* (#210)两块手绘面板换 TabsPanel(keepMounted 默认 false,
                卸载语义与原三目条件渲染一致);手写 id/aria-controls/
                aria-labelledby 关联交由原语接管。 */}
            {teamTaskTab === "current" ? <TabsContent value="current" className="contents">
              <TeamDashboard
                tasks={tasks}
                users={teamUsers}
                onChanged={refresh}
                onOpenArtifacts={openArtifacts}
              />
            </TabsContent> : <TabsContent value="archive" className="contents">
              <HistoryBoard
                tasks={tasks}
                viewer={session}
                onChanged={refresh}
                onOpenTask={openArtifacts}
              />
            </TabsContent>}
          </TeamWorldTabs>
        </section>}

        {/* 团队问题(2026-09-10 拆分拍板):问题会话的团队全景;页签骨架
            与团队需求同构(2026-09-11 排版对齐),操作台仍在「问题处理」。 */}
        {view === "teamIssues" && <section className="min-w-0">
          <TeamWorldTabs domain="issue" tab={teamTaskTab}
            onSelect={setTeamTaskTab}>
            {teamTaskTab === "current" ? <TabsContent value="current" className="contents">
              <TeamIssueWorld issues={teamIssues} />
            </TabsContent> : <TabsContent value="archive" className="contents">
              <TeamIssueArchive issues={teamIssues}
                onOpenDeliveryAnalytics={() => {
                  setDeliveryAnalyticsTab("issue");
                  selectView("deliveryAnalysis");
                }} />
            </TabsContent>}
          </TeamWorldTabs>
        </section>}

        {view === "answers" && <KnowledgeAnswerPage />}
        {view === "library" && <KnowledgeLibrary
          onOpenTask={id => { const target = tasks.find(task => task.id === id); if (target) openArtifacts(target); else location.assign(`/work/${encodeURIComponent(id)}`); }}
 />}

        {view === "knowledge" && <section className="team-assets-workspace">
          <Button variant="outline" className="self-start" onClick={() => selectView("mine")}>← 返回我的需求</Button>
          {teamAssetTab === "knowledge" ? <KnowledgeAssetsWorkspace
            admin={session.role === "admin"}
            initialAsset={knowledgeFocus}
            onOpenTask={(taskId) => {
              const target = tasks.find((task) => task.id === taskId);
              if (target) openArtifacts(target);
            }}
          /> : <BusinessModuleLibrary
            initialAsset={knowledgeFocus?.kind === "business"
              ? knowledgeFocus : undefined} />}
        </section>}

        {view === "wishes" && <WishWall viewer={session} draft={wishDraft}
          onDraftConsumed={() => setWishDraft(undefined)} />}

        {view === "mine" && <>
          {missingTaskNotice && <div className="mb-4 flex items-center justify-between gap-3 rounded-r-[6px] border-l-2 border-l-(--attention) bg-(--attention-soft) px-3 py-2.5 text-sm text-(--text-strong)" role="alert">
            <span>任务 {missingTaskNotice} 不存在或已被删除,已返回「我的需求」。
              链接可能已过期。</span>
            <button type="button" className="h-7 shrink-0 rounded-[6px] border border-(--line-strong) bg-(--surface) px-2.5 text-xs text-(--text) transition-colors hover:border-(--text-strong)" onClick={() => setMissingTaskNotice("")}>知道了</button>
          </div>}
          <PersonalActionInbox
            items={personalActionItems}
            hasOwnTasks={myTasks.length > 0}
            onOpen={openArtifacts}
          />
          {/* 任务摘要分段筛选(#228 工具类化):零值段不渲染,选中段描边。 */}
          <section className="mb-2.5 flex flex-wrap gap-1" aria-label="我的任务摘要">
            <button type="button" className={cn(pulseChip, mineScope === "all" && pulseChipSelected)} aria-pressed={mineScope === "all"} onClick={() => setMineScope("all")}><span>全部</span><strong className={pulseChipCount}>{myTasks.length}</strong></button>
            {([
              ["waiting", "待我核对", myWaiting.length, "text-(--attention)"],
              ["intervention", "需要介入 / 已暂停", myIntervention.length, "text-(--danger)"],
              ["active", "自动推进中", myActive.length, ""],
              ["delivered", "待合入 / 完成", myDelivered.length, ""],
            ] as Array<[MineScope, string, number, string]>).filter(([, , count]) => count > 0).map(([scope, label, count, tone]) => (
              <button type="button" key={scope} className={cn(pulseChip, mineScope === scope && pulseChipSelected)} aria-pressed={mineScope === scope} onClick={() => setMineScope((current) => current === scope ? "all" : scope)}><span>{label}</span><strong className={cn(pulseChipCount, tone)}>{count}</strong></button>
            ))}
          </section>
          {(session.committer || myReviews.length > 0) && <CommitterInbox
            reviews={pendingReviews}
            tasks={tasks}
            onOpen={openArtifacts}
          />}
          <section className="mt-0 mb-8" aria-labelledby="current-work-title">
            <div className="mb-3 flex items-baseline justify-between gap-4"><div><h2 id="current-work-title">{myWorkTitle}</h2></div><div className="current-work-counts">{mineScope === "all" && myWaiting.length > 0 && <span className="text-[13px] font-medium tabular-nums text-attention">{myWaiting.length} 项待核对</span>}{mineScope === "all" && myIntervention.length > 0 && <span className="text-[13px] font-medium tabular-nums text-danger">{myIntervention.length} 项需介入</span>}<span className="text-[13px] font-medium tabular-nums text-muted-foreground">{mineScope === "all" ? `共 ${visibleMyWork.length} 项` : `筛选出 ${visibleMyWork.length} 项`}</span><button type="button" className="inline-flex h-7 items-center gap-[5px] rounded-full border border-(--line) px-2.5 text-xs font-medium text-(--muted) shadow-[var(--shadow-control)] transition-colors hover:border-(--line-strong) hover:text-(--text-strong)" title={taskOrder === "newest" ? "当前按创建时间，最新在上；点击改为待核对的排最前" : "当前待核对的排最前；点击改为按创建时间，最新在上"} aria-pressed={taskOrder === "newest"} onClick={() => setTaskOrder((current) => current === "newest" ? "attention" : "newest")}>{taskOrder === "newest" ? "最新在上" : "待核对在前"}<i aria-hidden className="not-italic text-(--faint)">⇅</i></button></div></div>
            {visibleMyWork.length === 0 && <div className="flex items-center gap-2.5 border-b border-(--line) px-1 py-3.5"><span aria-hidden className="text-base font-semibold text-(--success)">✓</span><div><strong className="text-base font-medium text-(--text)">{mineScope === "all" ? "当前没有进行中的任务" : `没有${myWorkTitle}的任务`}</strong><p className="mt-px text-sm text-(--muted)">{mineScope === "all" ? "新任务启动后会出现在这里；需要你核对的任务会自动排在最前。" : "再次点击上方已选中的摘要卡，可恢复查看全部当前任务。"}</p></div></div>}
            <div className="grid gap-2">{orderTaskHierarchy(visibleMyWork).map((task) => <TaskCard compact relatedTasks={tasks} key={task.id} task={task} onChanged={refresh} focused={task.id === targetTaskId} canOperate={canOperate(task)} canDecide={canCollaborate(task)} decisionMode={artifactTaskId === task.id ? "signal" : "form"} onOpenArtifacts={() => openArtifacts(task)} onOpenRelatedTask={openRelatedTask} />)}</div>
          </section>
          {mineScope === "all" && myDelivered.length > 0 && <TaskGroup kicker="DELIVERY" title="等待合入与最近完成" tasks={visibleMyDelivered} allTasks={tasks} onChanged={refresh} onOpenArtifacts={openArtifacts} targetTaskId={targetTaskId} />}
        </>}
        {view === "issues" && <Suspense fallback={<div className="p-10 text-(--muted)">问题处理页加载中…</div>}><IssueBoard viewer={session} initialOpenId={issueRouteId} onOpenIssue={openIssueSession} onCloseIssue={closeIssueSession} onNavigateProfile={session.role !== "admin" ? () => { leaveIssueRoute("profile"); setView("profile"); } : undefined} childTab={activeIssueChild} onChildTabChange={selectIssueChild} /></Suspense>}
        {view === "profile" && session.role !== "admin" && <PersonalSettingsPage
          session={session}
          onSessionPatch={patchSession}
          onTasksChanged={refresh}
        />}
        {view === "users" && session.role === "admin"
          && <UsersBoard me={session.username} />}
        {view === "settings" && session.role === "admin" && <SettingsBoard />}
        {view === "environments" && <ConfigurationCenter admin={session.role === "admin"} />}
        {view === "deliveryAnalysis" && <DeliveryAnalytics initialTab={deliveryAnalyticsTab} role={session?.role} onOpenTask={(taskId) => {
          const target = tasks.find((task) => task.id === taskId);
          if (target) openArtifacts(target);
          else location.assign(`/work/${encodeURIComponent(taskId)}`);
        }} />}
        {view === "help" && <Suspense fallback={<div className="help-loading">使用帮助加载中…</div>}>
          <HelpCenter viewer={session}
            initialArticleId={helpArticleId}
            onArticleChange={(articleId) => {
              setHelpArticleId(articleId);
              history.pushState({}, "", `/help/${encodeURIComponent(articleId)}`);
            }} />
        </Suspense>}
      </main>
    </div>
    {launchOpen && <LaunchWorkspace session={session}
      onCreated={(created) => {
        void refresh();
        // 下单成功当场打开新任务工作台:比"弹窗一关、任务沉进列表中段"
        // 直接得多——人立刻看到"已创建,排队中"(2026-08-30 审计)。
        openArtifacts(created);
      }} onClose={() => setLaunchOpen(false)}
      onOpenKnowledgeAsset={(target) => {
        // 当前历史项记住打开全文前所在视图；返回根路径时 popstate 才能
        // 恢复“我的需求”，而不是只去掉高亮却仍滞留在团队资产。
        history.replaceState(appHistoryState(view,
          view === "knowledge" ? teamAssetTab : undefined), "",
          location.pathname + location.search);
        setLaunchOpen(false);
        if (target.kind === "business" && /^kg-[a-f0-9]{64}$/.test(target.assetId)) {
          setKnowledgeFocus(undefined);
          history.pushState(appHistoryState("library"), "", knowledgeAssetPath(target));
          setView("library");
          return;
        }
        setKnowledgeFocus(target);
        setTeamAssetTab(target.kind === "business" ? "modules" : "knowledge");
        setView("knowledge");
        const next = knowledgeAssetPath(target);
        if (location.pathname + location.search !== next) {
          history.pushState(appHistoryState("knowledge",
            target.kind === "business" ? "modules" : "knowledge"), "", next);
        }
      }}
      onOpenWorkflowAssets={(workflowId) => {
        // 团队工作流只在配置中心维护（团队资产视图已拆散），带 id 直达该方案。
        setLaunchOpen(false);
        setKnowledgeFocus(undefined);
        history.pushState(appHistoryState("environments"), "",
          `/configuration?tab=workflows${workflowId ? `&workflow=${encodeURIComponent(workflowId)}` : ""}`);
        setView("environments");
      }} />}
    <QuickWishButton onOpenWall={() => {
      // 快速许愿的「查看许愿墙」也可能从 /issues/X 工作台点出,同样
      // 先归位(不变量守门),再切页签。
      leaveIssueRoute("wishes");
      setView("wishes");
      setLaunchOpen(false);
      closeArtifacts();
    }} />
    {artifactTask && <TaskWorkspace
      onOpenFeedbackWall={() => {
        leaveIssueRoute("wishes");
        setView("wishes");
        setLaunchOpen(false);
        closeArtifacts();
      }}
      task={artifactTask}
      viewerUsername={session.username}
      viewerDisplayName={session.display_name}
      canOverride={session.role === "admin"}
      canPresent={session.role === "admin"}
      canOperate={canOperate(artifactTask)}
      canCollaborate={canCollaborate(artifactTask)}
      canRequestReview={responsibleOf(artifactTask) === session.username
        && !isReviewTaskEnded(artifactTask.status)}
      reviewAssignment={pendingReviews.find((review) => review.task_id === artifactTask.id)}
      onChanged={refresh}
      onClose={closeArtifacts}
      onOpenTask={(taskId) => {
        const related = tasks.find((task) => task.id === taskId);
        if (related) openArtifacts(related);
      }}
      onExecutionPlanFeedback={(draft) => {
        setWishDraft({
          key: `${artifactTask.id}:${artifactTask.execution_plan?.plan_revision ?? "plan"}:${Date.now()}`,
          kind: "wish",
          ...draft,
        });
        closeArtifacts();
        setView("wishes");
      }}
    />}
    {/* 页内确认弹框宿主:全站 confirmDialog 的唯一渲染点(spec #52)。 */}
    <ConfirmDialogHost />
    </SidebarInset>
    </SidebarProvider></PeopleProvider>;
}

function PersonalActionInbox({
  items,
  hasOwnTasks,
  onOpen,
}: {
  items: PersonalActionItem[];
  hasOwnTasks: boolean;
  onOpen: (task: TaskSummary) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, 3);
  // 行动清单(#228 工具类化,含 surface-finish 终态:抬升面板+渐变头,
  // 行内 small 摘要右置;首行=墨色渐变主钮+accent 编号盒)。
  const primaryButton = "rounded-[8px] border border-[color-mix(in_srgb,var(--ink)_90%,black)] bg-[linear-gradient(180deg,color-mix(in_srgb,var(--ink)_90%,white),var(--ink))] text-(--ink-fg) shadow-[var(--shadow-primary)] hover:bg-(--ink-hover)";
  const outlineButton = "border-(--line) bg-(--surface) text-(--text-strong) shadow-[var(--shadow-control)] hover:border-(--text-strong)";
  const rankBox = "grid size-[26px] place-items-center rounded-[8px] border font-mono text-[11px] leading-none tabular-nums";
  return <section className="mb-[26px] mt-0 overflow-hidden rounded-[12px] border border-(--line) bg-(--surface) shadow-[var(--shadow-panel)]" aria-labelledby="personal-action-title">
    <div className="flex items-baseline justify-between gap-4 border-b border-(--line) bg-linear-[110deg,var(--surface),var(--surface-2)] px-5 py-4">
      <div>
        <h2 id="personal-action-title" className="m-0 text-[15px] font-[650] tracking-[-0.01em] text-(--text-strong)">我现在最应该做什么</h2></div>
      <span className="text-sm tabular-nums text-(--muted)">{items.length ? `${items.length} 项待处理` : "当前已清空"}</span>
    </div>
    {shown.length ? <div className="grid">{shown.map((item, index) => (
      <article key={item.key} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 border-b border-(--line) px-5 py-[13px]">
        <span aria-hidden className={cn(rankBox, index === 0
          ? "border-(--accent)/20 bg-(--accent-soft) text-(--accent)"
          : "border-(--line) bg-(--surface-2) text-(--faint)")}>{String(index + 1).padStart(2, "0")}</span>
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5"><small className="col-start-2 row-start-1 inline-flex items-center gap-1.5 self-center text-[11px] font-medium text-(--attention) before:inline-block before:size-1.5 before:rounded-full before:bg-current">{item.kicker}</small><strong className="col-start-1 row-start-1 truncate text-sm text-(--text-strong)">{item.title}</strong><p className="col-span-full m-0 truncate text-xs text-(--muted)">{item.detail}</p></div>
        {item.href ? (
          <a className={cn("inline-flex h-8 min-w-0 items-center justify-center rounded-[6px] border px-3 text-sm font-medium transition-colors", index === 0 ? primaryButton : outlineButton)}
            href={item.href}
            target="_blank" rel="noreferrer">{item.action} ↗</a>
        ) : (
          <button type="button" disabled={!item.task}
            className={cn("inline-flex h-8 min-w-0 items-center justify-center rounded-[6px] border px-3 text-sm font-medium transition-colors", index === 0 ? primaryButton : outlineButton)}
            onClick={() => item.task && onOpen(item.task)}>{item.action}</button>
        )}
      </article>
    ))}</div> : <div className="flex items-center gap-2.5 p-5 text-(--muted)">
      <span aria-hidden className="text-base font-semibold text-(--success)">✓</span><div><strong className="text-base font-medium text-(--text)">当前没有需要你处理的事项</strong>
        {/* 零任务的新用户看到"Agent 正在推进"会以为后台有活在跑,
            白等半天(2026-08-30 审计)。 */}
        <p className="mt-px text-sm">{hasOwnTasks
          ? "Agent 正在继续推进；新的确认、检视或异常会优先出现在这里。"
          : "你还没有任务——点右上角「发起新任务」开始;需要人工处理的事项会优先出现在这里。"}</p></div>
    </div>}
    {items.length > 3 && <button type="button" className="w-full bg-(--surface-2) px-5 py-2.5 text-left text-xs text-(--muted) transition-colors hover:text-(--text-strong)"
      onClick={() => setExpanded((current) => !current)}>
      {expanded ? "收起" : `还有 ${items.length - 3} 项 →`}</button>}
  </section>;
}

function CommitterInbox({
  reviews,
  tasks,
  onOpen,
}: {
  reviews: ReviewRequest[];
  tasks: TaskSummary[];
  onOpen: (task: TaskSummary) => void;
}) {
  return <section className="rounded-[14px] border border-(--accent)/25 bg-[color-mix(in_srgb,var(--accent-soft)_18%,var(--surface))] p-5" aria-labelledby="committer-inbox-title">
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <div><h2 id="committer-inbox-title">待我检视</h2></div>
      <span className="text-[13px] font-medium tabular-nums text-attention">{reviews.length} 项</span>
    </div>
    {reviews.length === 0
      ? <div className="flex items-center gap-2.5 px-1 py-3.5"><span aria-hidden className="text-base font-semibold text-(--success)">✓</span><div><strong className="text-base font-medium text-(--text)">当前没有待检视任务</strong><p className="mt-px text-sm text-(--muted)">责任人主动邀请后会出现在这里。</p></div></div>
      : <div className="mt-3 grid gap-[7px]">{reviews.map((review) => {
          const task = tasks.find((item) => item.id === review.task_id);
          return <button type="button" key={review.id} disabled={!task}
            className="grid w-full min-w-0 grid-cols-[34px_minmax(0,1fr)_auto_16px] items-center gap-[11px] rounded-[10px] border border-(--line) bg-(--surface) p-3 text-left transition-colors hover:border-(--accent) disabled:cursor-not-allowed disabled:opacity-55"
            onClick={() => task && onOpen(task)}>
            <span className="grid size-[34px] place-items-center rounded-[9px] bg-(--accent-soft) text-base font-extrabold text-(--accent)" aria-hidden>审</span>
            <span className="grid min-w-0 gap-1"><strong className="truncate text-base text-(--text-strong)">{review.task_title}</strong><small className="text-sm text-(--muted)"><PersonName account={review.requester} /> 邀请 · {formatLocalDateTime(review.created_at)}</small></span>
            <span className={cn("text-sm", review.delivered ? "text-(--success)" : "text-(--danger)")}>{review.delivered ? "通知已送达" : "通知未送达"}</span>
            <svg viewBox="0 0 16 16" aria-hidden className="size-[15px] fill-none stroke-(--faint) stroke-[1.5]"><path d="m6 3 5 5-5 5" /></svg>
          </button>;
        })}</div>}
  </section>;
}

/** 问题处理导航组(spec #171):父行=展开/收起开关(受控状态,点击不跳
 * 页;首次展开而右侧不在问题处理时落默认子页签),子行=问题会话、登记、
 * DTS 列表与独立流水线修复;admin 只见问题会话。沿用 Sidebar 菜单
 * 语言:父行 SidebarMenuButton,子行 SidebarMenuSub/SubButton——nova 皮
 * 与令牌桥自动生效,不再依赖 nav-item 家族与手工缩进类。进入问题处理
 * 视图自动展开(深链同理)。徽章只属开发侧:名下进行中的问题数,口径见
 * myActiveIssueCount;admin 只读围观不挂。导出供 SSR 视觉验收渲染真件
 * (先例:buildPersonalActionItems 为测试导出)。 */
export function IssueNavGroup({ view, current, admin = false, childTab, onSelectChild, onSelect, badge = 0 }: {
  view: View;
  current: View;
  /** admin 只见「问题会话」子页签(不发起,登记入口不渲染)。 */
  admin?: boolean;
  childTab: IssueChildTab;
  onSelectChild: (tab: IssueChildTab) => void;
  onSelect: (view: View) => void;
  badge?: number;
}) {
  const [open, setOpen] = useState(current === view);
  useEffect(() => {
    if (current === view) setOpen(true);
  }, [current, view]);
  // 默认子页签排第一(2026-09-11 拍板):问题会话既是缺省落点,
  // 就该在子页签区首位,与选择直觉一致;发起两兄弟跟在后面。
  const children: Array<{ tab: IssueChildTab; label: string }> = admin
    ? [{ tab: "sessions", label: "问题会话" }]
    : [{ tab: "sessions", label: "问题会话" },
      { tab: "register", label: "问题登记" },
      { tab: "dts", label: "DTS 列表" },
      { tab: "pipeline", label: "流水线修复" }];
  return <SidebarMenuItem>
    <SidebarMenuButton isActive={current === view} aria-label="问题处理"
      aria-expanded={open}
      onClick={() => {
        const next = !open;
        setOpen(next);
        if (next && current !== view) onSelect(view);
      }}>
      <NavIcon name={view} /><span>问题处理</span>
      {/* 徽章珠与展开箭头编成一组靠行尾(ml-auto 落在组上):有徽章时珠
          贴在箭头左侧,右缘与 NavButton 的行尾珠基本对齐;无徽章时组里
          只剩箭头,行为与从前一致。珠样式与 NavButton 同款。 */}
      <span className="ml-auto flex items-center gap-1.5">
        {badge > 0
          && <span className="inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-(--attention-soft) px-[5px] text-xs font-semibold leading-none tabular-nums text-(--attention)">{badge}</span>}
        <ChevronDown aria-hidden
          className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </span>
    </SidebarMenuButton>
    {open && <SidebarMenuSub>
      {children.map((child) => {
        const active = current === view && childTab === child.tab;
        return <SidebarMenuSubItem key={child.tab}>
          <SidebarMenuSubButton isActive={active} render={
            <button type="button" aria-current={active ? "true" : undefined}
              onClick={() => onSelectChild(child.tab)} />
          }>
            {child.label}
          </SidebarMenuSubButton>
        </SidebarMenuSubItem>;
      })}
    </SidebarMenuSub>}
  </SidebarMenuItem>;
}

function NavButton({ view, current, onSelect, label, badge = 0 }: { view: View; current: View; onSelect: (view: View) => void; label: string; badge?: number }) {
  return <SidebarMenuItem>
    <SidebarMenuButton isActive={current === view} aria-label={label} title={label}
      onClick={() => onSelect(view)}>
      <NavIcon name={view} /><span>{label}</span>{badge > 0
        && <span className="ml-auto inline-grid h-[18px] min-w-[18px] place-items-center rounded-full bg-(--attention-soft) px-[5px] text-xs font-semibold leading-none tabular-nums text-(--attention)">{badge}</span>}
    </SidebarMenuButton>
  </SidebarMenuItem>;
}

function LoginScreen({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError("");
    try { onAuthenticated(await login(username.trim(), password)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "登录失败，请重试"); }
    finally { setBusy(false); }
  }
  return <main className="grid min-h-screen grid-cols-[minmax(0,380px)] content-center justify-center bg-(--canvas) px-6 py-10 max-[760px]:grid-cols-[minmax(0,500px)] max-[760px]:p-[18px] max-[480px]:grid-cols-1 max-[480px]:p-0"><section className="flex min-h-0 flex-col rounded-xl border border-(--line) bg-(--surface) px-9 pb-7 pt-9 shadow-md max-[760px]:min-h-[calc(100vh-36px)] max-[760px]:rounded-[18px] max-[760px]:p-[38px] max-[480px]:min-h-screen max-[480px]:rounded-none max-[480px]:px-[22px] max-[480px]:py-[30px]" aria-labelledby="login-title"><div className="mb-9 flex items-center gap-2.5 max-[760px]:mb-[52px]"><BrandMark /><span className="flex items-baseline gap-2 leading-none"><strong className="text-[15px] text-(--text-strong)">Mae-Flow</strong></span></div><div><h1 id="login-title" className="mb-1.5 text-2xl leading-[1.25] tracking-[-0.02em] text-(--text-strong) max-[480px]:text-[30px]">登录 Mae-Flow</h1><p className="m-0 max-w-[40ch] text-base text-(--muted)">管理员掌握团队全局，开发成员直达自己的任务与待核对事项。</p></div><form className="mt-7 grid gap-4" onSubmit={submit}><label className="grid gap-1.5"><span className="text-sm font-medium text-(--muted)">账号</span><Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoFocus required /></label><label className="grid gap-1.5"><span className="text-sm font-medium text-(--muted)">密码</span><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></label>{error && <div className="rounded-[6px] bg-(--danger-soft) px-2.5 py-2 text-sm text-(--danger)" role="alert">{error}</div>}<button type="submit" disabled={busy} className="inline-flex h-10 items-center justify-center gap-2 rounded-[6px] border border-(--ink) bg-(--ink) px-4 text-base font-medium text-(--ink-fg) transition-colors hover:border-(--ink-hover) hover:bg-(--ink-hover) disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4">{busy ? "正在登录…" : "登录"}<svg viewBox="0 0 20 20"><path d="M4 10h11M11 6l4 4-4 4" /></svg></button></form><p className="mb-0 mt-5 text-xs text-(--faint)">账号由团队管理员在控制台内创建。</p></section></main>;
}

function LoadingScreen() {
  {/* #218:整屏结构与文案保留,加载动效统一走 Spinner(原先内部无动画)。 */}
  return <main className="flex min-h-screen items-center justify-center gap-2.5 bg-(--canvas) text-base text-(--muted)"><BrandMark /><Spinner aria-hidden className="size-4 shrink-0" /><span>正在进入工作台…</span></main>;
}

function SessionConnectionScreen({ checking, onRetry }: { checking: boolean; onRetry: () => void }) {
  return <main className="flex min-h-screen items-center justify-center bg-(--canvas) px-6">
    <section className="grid max-w-md gap-4 rounded-xl border border-(--line) bg-(--surface) p-8" aria-labelledby="session-connection-title">
      <BrandMark />
      <div role="alert"><h1 id="session-connection-title" className="mb-2 text-xl font-semibold text-(--text-strong)">暂时无法连接服务</h1>
        <p className="m-0 text-base text-(--muted)">正在自动重试，连接恢复后会继续进入工作台。</p></div>
      <Button type="button" onClick={onRetry} disabled={checking}>{checking ? "正在重新连接…" : "重新连接"}</Button>
    </section>
  </main>;
}

function UsersBoard({ me }: { me: string }) {
  const [users, setUsers] = useState<AuthUser[]>([]); const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState(""); const [role, setRole] = useState<UserRole>("developer");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  // 行内操作(内部平台的管理员特权:重置密码不验旧密码,删号即物理
  // 删除)。resetFor=正在给谁改密码;deleteArm=删除按钮二次确认锁,
  // 点第一下只上膛,再点才执行——不用 window.confirm 打断浏览器。
  const [resetFor, setResetFor] = useState(""); const [resetPassword, setResetPassword] = useState("");
  const [nameFor, setNameFor] = useState(""); const [nameDraft, setNameDraft] = useState("");
  const [deleteArm, setDeleteArm] = useState("");
  async function refreshUsers() { try { setUsers(await listUsers()); } catch (reason) { setError(reason instanceof Error ? reason.message : "账号列表加载失败"); } }
  useEffect(() => { void refreshUsers(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError(""); setMessage("");
    try { const created = await createUser(username.trim(), password, role, displayName); setUsername(""); setDisplayName(""); setPassword(""); setMessage(`已创建账号 ${userLabel(created)}`); await refreshUsers(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "账号创建失败"); }
    finally { setBusy(false); }
  }
  async function saveDisplayName(event: React.FormEvent) {
    event.preventDefault(); if (!nameFor || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const updated = await putUserDisplayName(nameFor, nameDraft);
      setMessage(`已更新 ${userLabel(updated)} 的显示姓名`);
      setNameFor(""); setNameDraft(""); await refreshUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "姓名更新失败");
    } finally { setBusy(false); }
  }
  async function toggleCommitter(user: AuthUser) {
    setError(""); setMessage("");
    try {
      await putCommitter(user.username, !user.committer);
      setMessage(`${user.username} 已${user.committer ? "移出" : "加入"} Committer 名单`);
      await refreshUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Committer 名单更新失败");
    }
  }
  async function submitReset(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await resetUserPassword(resetFor, resetPassword);
      // 重置会作废对方所有活会话;改的是自己则本会话也没了,页面下一次
      // 请求会 401 回登录页——这是诚实结果,不是故障。
      setMessage(`已重置 ${resetFor} 的密码,其登录会话已全部下线`
        + (resetFor === me ? "(包括当前会话,请重新登录)" : ""));
      setResetFor(""); setResetPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "密码重置失败");
    } finally { setBusy(false); }
  }
  async function removeUser(user: AuthUser) {
    if (deleteArm !== user.username) {
      setDeleteArm(user.username); setMessage(""); setError(""); return;
    }
    setDeleteArm(""); setError(""); setMessage("");
    try {
      await deleteUser(user.username);
      setMessage(`已删除账号 ${user.username}(历史任务记录保留)`);
      await refreshUsers();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "账号删除失败");
    }
  }
  return <section className="grid gap-6">
    <div className="grid overflow-hidden rounded-xl border border-line bg-surface shadow-sm lg:grid-cols-[minmax(220px,0.75fr)_minmax(0,1.4fr)]">
      <div className="bg-surface-2 p-7 text-muted-foreground">

        <h2>添加团队成员</h2>
        <p>开发账号可以查看全部任务，但只能处理分配给自己的任务；管理员维护账号与系统配置，Committer 另行标记。</p>
      </div>
      <form className="grid content-start items-end gap-[15px] p-[26px] sm:grid-cols-2" onSubmit={submit}>
        <label className="grid gap-1.5"><span className="text-[13px] font-medium text-muted-foreground">登录账号</span><Input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="例如 zhangsan" required /></label>
        <label className="grid gap-1.5"><span className="text-[13px] font-medium text-muted-foreground">姓名</span><Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="例如 张三" maxLength={40} /></label>
        <label className="grid gap-1.5"><span className="text-[13px] font-medium text-muted-foreground">初始密码</span><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="至少 10 个字符" minLength={10} autoComplete="new-password" required /></label>
        <label className="grid gap-1.5"><span className="text-[13px] font-medium text-muted-foreground">账号角色</span><Select value={role}
          items={[{ value: "developer", label: "开发成员" }, { value: "admin", label: "管理员" }]}
          onValueChange={(value) => setRole((value ?? "developer") as UserRole)}>
          <SelectTrigger className="w-full" aria-label="账号角色"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="developer">开发成员</SelectItem>
              <SelectItem value="admin">管理员</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select></label>
        <button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建账号"}</button>
        {message && <div className="rounded-lg bg-success/10 px-[11px] py-[9px] text-[13.5px] text-success">{message}</div>}
        {error && <div className="rounded-lg bg-danger/10 px-2.5 py-2 text-[13px] text-danger">{error}</div>}
      </form>
    </div>
    <section className="rounded-[12px] border border-(--line) bg-(--surface) p-6 shadow-xs" aria-labelledby="user-list-title">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div><h2 id="user-list-title" className="mt-1.5 text-[21px] text-(--text-strong)">现有账号</h2><p className="mb-0 mt-1.5 text-sm text-(--muted)">Committer 只在开发主动邀请检视时收到通知。</p></div>
        <span className="text-[13px] font-medium tabular-nums text-muted-foreground">{users.length} 人</span>
      </div>
      {/* #220 手搓 div 网格表换 Table 原语:表头/行/单元格语义归 table,
          列结构(成员/角色/默认入口/Committer/操作)与行内操作、角色徽标
          原样;行外重置/改名表单落成 colSpan 扩展行。 */}
      {/* #220 表体是 Table 原语;#228 外框工具类化(legacy .user-table 退役)。 */}
      <div className="overflow-hidden rounded-[10px] border border-(--line)">
        <Table>
          <TableHeader>
            <TableRow className="border-(--line)">
              <TableHead className="h-11 bg-(--surface-soft) px-4 text-xs font-bold text-(--muted)">成员</TableHead>
              <TableHead className="h-11 bg-(--surface-soft) px-4 text-xs font-bold text-(--muted)">角色</TableHead>
              <TableHead className="h-11 bg-(--surface-soft) px-4 text-xs font-bold text-(--muted)">默认入口</TableHead>
              <TableHead className="h-11 bg-(--surface-soft) px-4 text-xs font-bold text-(--muted)">Committer</TableHead>
              <TableHead className="h-11 bg-(--surface-soft) px-4 text-xs font-bold text-(--muted)">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((user) => <Fragment key={user.username}>
              <TableRow className="h-[58px] border-(--line)">
                <TableCell className="px-4 py-3">
                  <span className="flex items-center gap-2.5">
                    <Avatar aria-hidden className="after:hidden">
                      <AvatarFallback className="size-[30px] rounded-[8px] bg-(--accent-soft) text-[13px] font-bold text-(--accent)">{(user.display_name ?? user.username).slice(0, 1).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <strong className="grid gap-0.5 text-[14.5px] text-(--text-strong)">{user.display_name ?? user.username}<small className="text-xs font-medium text-(--faint)">{user.display_name ? user.username : "未填写姓名"}</small></strong>
                  </span>
                </TableCell>
                <TableCell className="px-4 py-3"><Badge variant={user.role === "admin" ? "merge" : "info"}>{user.role === "admin" ? "管理员" : "开发成员"}</Badge></TableCell>
                <TableCell className="px-4 py-3 text-[13.5px] text-(--muted)">{user.role === "admin" ? "团队需求" : "我的需求"}</TableCell>
                {/* 手搓 toggle 换 Switch 原语:开关态(role=switch/aria-checked)
                    交原语,on 态 pill 底色由 .on 类保留,文案与受控请求原样。 */}
                <TableCell className="px-4 py-3"><label className={cn("inline-flex min-w-[92px] items-center justify-center gap-[7px] rounded-[8px] border px-[9px] py-[7px] text-sm transition-colors", user.committer ? "border-(--success)/30 bg-(--success-soft) text-(--success)" : "border-(--line) bg-(--surface) text-(--muted)")}><Switch size="sm" checked={!!user.committer} onCheckedChange={() => void toggleCommitter(user)} />{user.committer ? "已加入" : "加入名单"}</label></TableCell>
                <TableCell className="px-4 py-3"><span className="inline-flex gap-2">
                  <button type="button" className={userActionButton} onClick={() => {
                    setResetFor(resetFor === user.username ? "" : user.username);
                    setResetPassword(""); setDeleteArm(""); setMessage(""); setError("");
                  }}>{resetFor === user.username ? "收起" : "重置密码"}</button>
                  <button type="button" className={userActionButton} onClick={() => {
                    setNameFor(nameFor === user.username ? "" : user.username);
                    setNameDraft(user.display_name ?? ""); setResetFor("");
                    setDeleteArm(""); setMessage(""); setError("");
                  }}>{nameFor === user.username ? "收起" : "编辑姓名"}</button>
                  {user.username === me
                    ? <button type="button" className={userActionButton} disabled title="不能删除自己——请让另一位管理员操作">删除</button>
                    : <button type="button" className={cn(userActionButton, deleteArm === user.username ? "border-(--danger) bg-(--danger) text-white" : "border-(--danger)/30 text-(--danger)")} onClick={() => void removeUser(user)}>{deleteArm === user.username ? "确认删除?" : "删除"}</button>}
                </span></TableCell>
              </TableRow>
              {resetFor === user.username && <TableRow className="border-(--line)">
                <TableCell colSpan={5} className="px-4 pb-3">
                  <form className="flex items-center gap-2.5 px-4 pb-3 max-[480px]:flex-wrap" onSubmit={submitReset}>
                    <Input type="password" value={resetPassword} placeholder="新密码,至少 10 个字符" minLength={10} autoComplete="new-password" autoFocus required
                      onChange={(event) => setResetPassword(event.target.value)} />
                    <button type="submit" disabled={busy || resetPassword.length < 10} className="rounded-[8px] bg-(--accent) px-3 py-2 text-sm text-(--accent-fg) transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "重置中…" : "确认重置"}</button>
                    <small className="text-sm text-(--muted)">不需要旧密码;重置后该账号的登录会话全部下线。</small>
                  </form>
                </TableCell>
              </TableRow>}
              {nameFor === user.username && <TableRow className="border-(--line)">
                <TableCell colSpan={5} className="px-4 pb-3">
                  <form className="flex items-center gap-2.5 px-4 pb-3 max-[480px]:flex-wrap" onSubmit={saveDisplayName}>
                    <Input value={nameDraft} placeholder="姓名，例如 张三（清空则只显示工号）"
                      maxLength={40} autoFocus onChange={(event) => setNameDraft(event.target.value)} />
                    <button type="submit" disabled={busy} className="rounded-[8px] bg-(--accent) px-3 py-2 text-sm text-(--accent-fg) transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">{busy ? "保存中…" : "保存姓名"}</button>
                    <small className="text-sm text-(--muted)">登录、权限与历史记录仍使用工号 {user.username}。</small>
                  </form>
                </TableCell>
              </TableRow>}
            </Fragment>)}
          </TableBody>
        </Table>
      </div>
    </section>
  </section>;
}

/** 团队需求与问题共用页签；键盘切换和面板关联由 Tabs 原语维护。 */
function TeamWorldTabs({ domain, tab, onSelect, children }: {
  domain: "requirement" | "issue";
  tab: TeamTaskTab;
  onSelect: (tab: TeamTaskTab) => void;
  children?: ReactNode;
}) {
  const copy = domain === "requirement"
    ? { label: "团队需求视图", currentSmall: "谁在推进、哪里卡住、谁需要行动",
        archiveSmall: "待合入、完成、失败与取消记录" }
    : { label: "团队问题视图", currentSmall: "哪个问题在推进、谁需要答复",
        archiveSmall: "闭环结论与取消记录" };
  return <Tabs value={tab} className="block"
    onValueChange={(value) => onSelect(value as TeamTaskTab)}>
    <TabsList variant="line" aria-label={copy.label} className="page-tabs mb-6">
      <TabsTrigger value="current" title={copy.currentSmall}>当前现场</TabsTrigger>
      <TabsTrigger value="archive" title={copy.archiveSmall}>成果档案</TabsTrigger>
    </TabsList>
    {children}
  </Tabs>;
}

/** 团队看板列表项:TeamTask 稳定字段投影 + 原始任务对象。
 * teamTask 用于过滤/排序(纯函数 isCurrentTeamTask/matchesTeamScope/
 * byTeamAttention 只读稳定字段);task 用于渲染。 */
interface TeamListItem {
  teamTask: TeamTask;
  task?: TaskSummary;
}

function TeamDashboard({
  tasks,
  users,
  onChanged,
  onOpenArtifacts,
}: {
  tasks: TaskSummary[];
  users: AuthUser[];
  onChanged: () => void;
  onOpenArtifacts: (task: TaskSummary) => void;
}) {
  const nameOf = usePersonName();
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<TeamScope>("all");
  const [responsible, setResponsible] = useState("");
  const [phase, setPhase] = useState("");
  const [taskStatus, setTaskStatus] = useState("");
  const queueRef = useRef<HTMLElement>(null);
  const now = Date.now();

  // 2026-09-10 拆分拍板:本板只装需求任务;问题会话的团队全景在
  // 「团队问题」(TeamIssueWorld),不再适配混进需求队列。
  const items = useMemo<TeamListItem[]>(() => tasks.map((task) => ({
    teamTask: task as TeamTask, task,
  })), [tasks]);
  // 子任务跟着父任务走:父任务还在现场,先完成的子任务也留在它下面。
  const currentItems = useMemo(() => {
    const current = items.filter((item) => isCurrentTeamTask(item.teamTask));
    const keep = new Set(keepFamiliesTogether(
      current.map((item) => item.teamTask), items.map((item) => item.teamTask)).map((task) => task.id));
    return items.filter((item) => keep.has(item.teamTask.id));
  }, [items]);
  const deliveryStats = useMemo(() => teamDeliveryBreakdown(tasks), [tasks]);
  const openRelatedTask = (taskId: string) => {
    const related = tasks.find((task) => task.id === taskId);
    if (related) onOpenArtifacts(related);
  };
  const visible = useMemo(() => currentItems.filter((item) => {
    const tt = item.teamTask;
    const words = `${tt.id} ${item.task?.title ?? ""} ${tt.requirement} ${responsibleOf(tt) ?? ""} ${nameOf(responsibleOf(tt))}`
      .toLowerCase();
    if (query.trim() && !words.includes(query.trim().toLowerCase())) return false;
    if (responsible === "__unassigned" && responsibleOf(tt)) return false;
    if (responsible && responsible !== "__unassigned"
        && responsibleOf(tt) !== responsible) return false;
    if (!matchesTeamScope(tt, scope, now)) return false;
    if (phase === "尚未进入阶段" && item.task?.progress?.current_phase) return false;
    if (phase && phase !== "尚未进入阶段"
        && item.task?.progress?.current_phase !== phase) return false;
    if (taskStatus && item.task
        && teamDeliveryStatusGroup(item.task.status) !== taskStatus) return false;
    return true;
  }).sort((a, b) => byTeamAttention(a.teamTask, b.teamTask)),
    [currentItems, query, scope, responsible, phase, taskStatus, nameOf]);

  function selectPhase(next: string) {
    setPhase((current) => current === next ? "" : next);
    setTaskStatus("");
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  function selectTaskStatus(next: string) {
    setTaskStatus((current) => current === next ? "" : next);
    setPhase("");
    requestAnimationFrame(() => queueRef.current?.scrollIntoView({
      behavior: "smooth", block: "start",
    }));
  }

  return <>
    <TeamDeliveryOverview stats={deliveryStats} selectedPhase={phase}
      selectedStatus={taskStatus} onSelectPhase={selectPhase}
      onSelectStatus={selectTaskStatus} />

    <section id="team-queue" ref={queueRef} aria-labelledby="team-queue-title">
      <div className="mb-3 flex items-baseline justify-between gap-4"><div><h2 id="team-queue-title">{phase ? `${phase}现场` : taskStatus ? `${deliveryStats.statuses.find((entry) => entry.key === taskStatus)?.label ?? taskStatus}任务` : "当前现场"}</h2></div><span className={cn("text-[13px] font-medium tabular-nums", phase || taskStatus ? "text-primary" : "text-muted-foreground")}>{phase ? `阶段 · ${phase}　` : taskStatus ? `状态 · ${deliveryStats.statuses.find((entry) => entry.key === taskStatus)?.label ?? taskStatus}　` : ""}{visible.length} / {currentItems.length} 项</span></div>
      <div className="my-[13px] mb-[11px] flex items-center gap-[7px] rounded-[11px] border border-line bg-surface/90 p-2" aria-label="筛选当前现场">
        <label className="flex min-w-[220px] flex-1 items-center gap-2 px-[9px]"><svg viewBox="0 0 18 18" aria-hidden className="size-[15px] fill-none stroke-faint stroke-[1.5]"><circle cx="8" cy="8" r="4.5" /><path d="m11.5 11.5 3 3" /></svg><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务、需求或负责人" className="border-0 bg-transparent" /></label>
        <Select value={scope}
          items={[{ value: "all", label: "全部现场" }, { value: "action", label: "需要处理" }, { value: "stale", label: "停滞任务" }, { value: "wip", label: "正在推进" }, { value: "waiting", label: "等待决策" }]}
          onValueChange={(value) => setScope((value ?? "all") as TeamScope)}>
          <SelectTrigger className="min-w-28" aria-label="现场范围"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">全部现场</SelectItem>
              <SelectItem value="action">需要处理</SelectItem>
              <SelectItem value="stale">停滞任务</SelectItem>
              <SelectItem value="wip">正在推进</SelectItem>
              <SelectItem value="waiting">等待决策</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select value={responsible}
          items={[{ value: "", label: "全部责任人" }, { value: "__unassigned", label: "未指定" },
            ...users.map((user) => ({ value: user.username, label: userLabel(user) }))]}
          onValueChange={(value) => setResponsible(value ?? "")}>
          <SelectTrigger className="min-w-28" aria-label="责任人"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="">全部责任人</SelectItem>
              <SelectItem value="__unassigned">未指定</SelectItem>
              {users.map((user) => <SelectItem value={user.username} key={user.username}>{userLabel(user)}</SelectItem>)}
            </SelectGroup>
          </SelectContent>
        </Select>
        {(query || scope !== "all" || responsible || phase || taskStatus) && <button type="button" className="h-[34px] cursor-pointer rounded-[7px] border-0 bg-primary/10 px-[11px] text-[13px] font-bold text-primary" onClick={() => { setQuery(""); setScope("all"); setResponsible(""); setPhase(""); setTaskStatus(""); }}>清除筛选</button>}
      </div>
      {visible.length === 0 && <TaskEmpty personal={false} />}
      <div className="grid gap-2">{orderHierarchyBy(visible,
        (item) => item.teamTask.id,
        (item) => item.task?.parent_task_id,
      ).map((item) => <TaskCard compact relatedTasks={tasks} key={item.teamTask.id} task={item.task!} onChanged={onChanged} canOperate={false} decisionMode="signal" onOpenArtifacts={() => onOpenArtifacts(item.task!)} onOpenRelatedTask={openRelatedTask} showChildLinks={false} />)}</div>
    </section>
  </>;
}

function TaskGroup({
  kicker,
  title,
  tasks,
  allTasks,
  onChanged,
  onOpenArtifacts,
  targetTaskId,
  empty,
  tone,
}: {
  kicker: string;
  title: string;
  tasks: TaskSummary[];
  allTasks: TaskSummary[];
  onChanged: () => void;
  onOpenArtifacts: (task: TaskSummary) => void;
  targetTaskId: string;
  empty?: string;
  tone?: string;
}) {
  return <section>
    <div className="mb-3 flex items-baseline justify-between gap-4"><div><h2>{title}</h2></div><span className={cn("text-[13px] font-medium tabular-nums text-muted-foreground", tone === "attention" && "text-attention", tone === "danger" && "text-danger", tone === "active" && "text-active")}>{tasks.length} 项</span></div>
    {tasks.length === 0 && <div className="flex items-center gap-2.5 border-b border-(--line) px-1 py-3.5"><span aria-hidden className="text-base font-semibold text-(--success)">✓</span><div><strong className="text-base font-medium text-(--text)">{empty ?? "当前没有任务"}</strong></div></div>}
    <div className="grid gap-2">{orderTaskHierarchy(tasks).map((task) => <TaskCard compact relatedTasks={allTasks} key={task.id} task={task} onChanged={onChanged} focused={task.id === targetTaskId} canOperate onOpenArtifacts={() => onOpenArtifacts(task)} showChildLinks={false} onOpenRelatedTask={(taskId) => {
      const related = allTasks.find((item) => item.id === taskId);
      if (related) onOpenArtifacts(related);
    }} />)}</div>
  </section>;
}

/** 总览只保留一层规模摘要；阶段与状态作为轻量筛选项呈现。
 * 规模数字、两组筛选都来自 teamDeliveryBreakdown，避免口径漂移。 */
/** 概览格按钮配方(原 .delivery-breakdown-cells button 家族,与问题侧同款)。 */
const CELL_BASE = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-line bg-surface px-[11px] py-1.5 text-left text-text transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:cursor-default disabled:opacity-55";
const CELL_SELECTED = "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-2 rounded-lg border border-primary/60 bg-primary/10 px-[11px] py-1.5 text-left text-primary transition-colors";

function TeamDeliveryOverview({
  stats,
  selectedPhase,
  selectedStatus,
  onSelectPhase,
  onSelectStatus,
}: {
  stats: TeamDeliveryBreakdown;
  selectedPhase: string;
  selectedStatus: string;
  onSelectPhase: (phase: string) => void;
  onSelectStatus: (status: string) => void;
}) {
  return <section className="mb-[22px] overflow-hidden rounded-[14px] border border-line bg-surface shadow-xs" aria-label="团队需求统计">
    <header className="flex items-center justify-between gap-8 px-5 py-[18px]">
      <div className="grid min-w-0 gap-[3px]">

        <h2 className="m-0 text-lg text-text-strong">交付概览</h2>

      </div>
      <div className="flex flex-none items-center gap-[18px]"
        aria-label={`需求总数 ${stats.requirements} 项（仅主任务），全部任务 ${stats.total} 项，交付中 ${stats.delivering} 项，已交付 ${stats.delivered} 项`}>
        <span className="grid min-w-[62px] justify-items-end gap-0.5" title="主任务数量，不含子任务和已取消任务"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-text-strong">{stats.requirements}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">需求总数</small></span>
        <i aria-hidden />
        <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-text-strong">{stats.total}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">全部任务</small></span>
        <i aria-hidden />
        <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-active">{stats.delivering}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">交付中</small></span>
        <i aria-hidden />
        <span className="grid min-w-[62px] justify-items-end gap-0.5"><strong className="text-[25px] leading-none tracking-[-0.035em] tabular-nums text-success">{stats.delivered}</strong><small className="whitespace-nowrap text-xs font-semibold text-muted-foreground">已交付</small></span>
      </div>
    </header>
    {stats.delivering > 0 && <div className="grid gap-3 border-t border-line bg-surface-2/70 px-5 pt-[15px] pb-[18px]">
      <section aria-labelledby="delivery-stage-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
        <div className="grid gap-0.5"><strong id="delivery-stage-title" className="text-[13.5px] text-text-strong">阶段</strong>
          <small className="text-[13px] text-muted-foreground">当前所处流程</small></div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
          {stats.stages.map((entry) => <button type="button" key={entry.key}
            className={selectedPhase === entry.key ? CELL_SELECTED : CELL_BASE}
            disabled={entry.count === 0} aria-pressed={selectedPhase === entry.key}
            aria-controls="team-queue" onClick={() => onSelectPhase(entry.key)}>
            <span>{entry.key}</span><strong>{entry.count}</strong>
          </button>)}
          {!stats.stages.length && <div className="col-span-full text-[13px] text-faint">暂无交付中任务</div>}
        </div>
      </section>
      <section aria-labelledby="delivery-status-title" className="grid min-w-0 grid-cols-[102px_minmax(0,1fr)] items-center gap-3">
        <div className="grid gap-0.5"><strong id="delivery-status-title" className="text-[13.5px] text-text-strong">任务状态</strong>
          <small className="text-[13px] text-muted-foreground">当前运行情况</small></div>
        <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(118px,1fr))] gap-[7px]">
          {stats.statuses.filter((entry) => entry.count > 0 || selectedStatus === entry.key).map((entry) => <button type="button" key={entry.key}
            className={selectedStatus === entry.key ? CELL_SELECTED : CELL_BASE}
            disabled={entry.count === 0}
            aria-pressed={selectedStatus === entry.key} aria-controls="team-queue"
            onClick={() => onSelectStatus(entry.key)}>
            <span>{entry.label}</span>
            <strong>{entry.count}</strong>
          </button>)}
          {!stats.statuses.length && <div className="col-span-full text-[13px] text-faint">暂无交付中任务</div>}
        </div>
      </section>
    </div>}
  </section>;
}

function TaskEmpty({ personal, title, detail }: {
  personal: boolean;
  /** 问题域等复用时给的自定文案;缺省仍是两角色默认话术。 */
  title?: string;
  detail?: string;
}) {
  /* #217 空态收编:原 empty-state 本就是"两行字、无虚线框、图标隐藏"
     的极简空态,Empty + 标题/描述即可,legacy 的 empty-visual 不再带出。 */
  return <Empty className="py-11"><EmptyTitle>{title ?? (personal ? "还没有分配给你的其他任务" : "还没有当前任务")}</EmptyTitle><EmptyDescription>{detail ?? (personal ? "你发起的任务会自动归入这里，管理员也可以直接分配给你。" : "任务发起后，团队整体进展会出现在这里。")}</EmptyDescription></Empty>;
}
