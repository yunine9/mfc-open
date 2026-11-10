import { ProductVersionPicker } from "../ProductVersionPicker";
import { RepositoryResourceNotice } from "../RepositoryResourceNotice";
/**
 * 登记域:发起问题会话的两个页签(登记问题 / DTS 列表)。
 *
 * 从 IssueBoard.tsx 原文搬移(spec #2 按域拆分,纯搬移零行为变化):
 * 两个子面板常驻(隐藏切换),表单/勾选/搜索状态跨页签驻留。
 * DTS 文本/版本/候选纯函数在 dtsText.ts,单据 HTML 的图片代理重写与
 * 白名单消毒在 dtsHtml.ts,这里只引用不重复。
 */
import {
  useEffect, useMemo, useRef, useState,
} from "react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Popover, PopoverContent, PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type Header,
  type VisibilityState,
} from "@tanstack/react-table";
import { Check, ChevronDown, Columns3, Copy, RotateCw } from "lucide-react";
import {
  createIssue,
  getBusinessModules,
  getDtsModuleBindings,
  getDtsTicketDetail,
  listAllIssues,
  listCollaborationAssignees,
  listDtsTickets,
  listPeople,
  putDtsAutoClaimExclusion,
  putDtsModuleBinding,
  uploadIssueImage,
  uploadIssueAttachment,
  type AuthUser,
  type BusinessModule,
  type CollaborationAssignee,
  type DtsModuleBindingEntry,
  type DtsTicketBrief,
  type DtsTicketDetail,
  type EnvironmentView,
  type IssueSummary,
  type PersonIdentity,
} from "../api";
import { userLabel, UserPicker, type UserOption } from "../UserPicker";
import { confirmDialog } from "../ConfirmDialog";
import { EnvironmentPicker } from "../EnvironmentPicker";
import { HeaderFilter } from "../HeaderFilter";
import { DescriptionEditor } from "./DescriptionEditor";
import { RichTextEditor } from "./RichTextEditor";
import { USE_RICH_TEXT_DESCRIPTION_EDITOR } from "./descriptionEditorChoice";import {
  ISSUE_DESCRIPTION_TEMPLATE, isUntouchedTemplate,
} from "./descriptionTemplate";
import { resolveAssignee } from "./assigneeDefault";
import { copyIssueDescription } from "./copyIssueDescription";
import {
  DTS_ACTIONABLE_STATUS,
  dtsNoCandidates,
  dtsVersionGroup,
  dtsVersionKey,
  isActionableDts,
  sortDtsVersionsDesc,
} from "./dtsText";
import { dtsTicketUrl } from "./dtsTicket";
import { issueSessionPath } from "./issueLink";
import { cn } from "cn";

/** #230 去 legacy:登记域皮肤类换工具类。字段行是全表单共用版式,先落
 *  成一处词典;窄屏单列由 max-[680px] 变体直译旧 @media(原 680px 块随
 *  家族退役)。(2026-09-18 拍板:登记表单不再分组卡——「问题信息/
 *  网管环境」两张内卡合并平铺进 section 网格,GROUP/GROUP_BODY 随之
 *  退役;字段顺序:标题、描述、模块|版本、责任人|环境。) */
const FIELD = "grid gap-[5px] text-[13px] text-muted-foreground max-[680px]:col-span-1 max-[680px]:min-w-0";

/** 发起前置门禁条(ADR-0031 起查**责任人**的凭据):这单会碰远端仓,
 *  克隆与推送都用责任人的身份——责任人没配齐就拦在表单上,服务端
 *  create 里机械拦(判定同源)。分两种说法:责任人=自己(自登记)
 *  指路个人设置,自己配完即解锁;责任人=他人(登记指派)点名责任人,
 *  登记人改选已配齐的责任人或让责任人先配好。 */
function CredentialGate({ viewer, needRepo, assignee, readyKnown, ready,
  missing, onNavigateProfile }: {
  viewer: AuthUser;
  needRepo: boolean;
  /** 当前生效的责任人(空=未指派,不出这个门)。 */
  assignee: string;
  /** 就绪状态是否已知:候选没加载完/拉取失败/所选人不在候选里,都是
   * 未知——未知不出这个门(不谎报"未配齐"),服务端门禁兜底。 */
  readyKnown: boolean;
  /** 责任人凭据是否配齐(仅在已知时有意义)。 */
  ready: boolean;
  missing: string[];
  onNavigateProfile?: () => void;
}) {
  if (!needRepo || !assignee || !readyKnown || ready) return null;
  const self = assignee === viewer.username;
  // 走到这 ready=false ⟺ missing 非空(flow=issue 口径),detail 必有内容。
  const missingText = missing.join(" 与 ");
  return <div className="col-span-full flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-attention/45 bg-[color-mix(in_srgb,var(--attention)_10%,var(--surface))] px-3.5 py-2.5 text-[13px] leading-normal text-attention" role="alert">
    {self
      ? <span>发起前先配置<b className="text-attention">{missingText}</b>(个人设置 → 个人接入):
          拉取代码仓与推送提交都用你的身份,配置完成即可发起。</span>
      : <span>责任人 <b className="text-attention">{assignee}</b>(缺 {missingText})的 Git 凭据未配齐——拉取代码仓与推送提交都用责任人的身份:
          改选已配齐的责任人,或让责任人配好后再登记。</span>}
    {self && onNavigateProfile && <Button type="button" size="sm" onClick={onNavigateProfile}>
      去个人设置配置
    </Button>}
  </div>;
}


/** 只读仓清单行的短名:剥协议取末段再去 .git(file:// 演示仓同样适用);
 * 全 URL 挂 title,悬停可见。 */
function repoLabel(url: string): string {
  const last = url.replace(/\/+$/, "").split(/[/:]/)
    .filter(Boolean).pop() ?? url;
  return last.replace(/\.git$/i, "") || url;
}

/** 描述一键复制(登记侧出站口):写剪贴板双格式(纯文本 markdown 原文
 * + 渲染 HTML,截图内联 data URL)——富文本框直贴得排版与截图,纯文本
 * 框得原文。状态自持:成功/失败各 2 秒回落,失败可直接重试。 */
function CopyDescriptionButton({ markdown, disabled, variant, size, className }: {
  markdown: string;
  disabled?: boolean;
  variant: "ghost" | "outline";
  size: "xs" | "sm";
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  useEffect(() => {
    if (state !== "done" && state !== "error") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  async function copy() {
    setState("busy");
    try {
      await copyIssueDescription(markdown);
      setState("done");
    } catch {
      setState("error");
    }
  }
  return <Button type="button" variant={variant} size={size}
    className={className}
    disabled={disabled || state === "busy"}
    title="复制描述:贴进飞书/Word 等富文本框保留排版与截图,贴进纯文本框是 Markdown 原文"
    onClick={() => void copy()}>
    {state === "done" ? <Check aria-hidden /> : <Copy aria-hidden />}
    {state === "busy" ? "复制中…" : state === "done" ? "已复制"
      : state === "error" ? "复制失败" : "复制"}
  </Button>;
}

/** 名下进行中会话按单查重的唯一口径(「已发起」词条,CONTEXT.md):
 * 同单号且会话未到终态(归档/取消/失败)。发起前查重与列表的发起
 * 状态列/勾选禁用/默认过滤全走这一处——列上说"已发起"当且仅当此刻
 * 点发起会被拦;只有终态旧会话的单不算,可再次发起(与服务端 create
 * 守卫同尺)。终态三元组只住 isLiveIssue 一处。 */
function isLiveIssue(item: IssueSummary): boolean {
  return !["archived", "canceled", "failed"].includes(item.status);
}

function liveIssueFor(issues: IssueSummary[], ticketNo: string):
  IssueSummary | undefined {
  return issues.find((item) => item.ticket === ticketNo && isLiveIssue(item));
}

/** 进行中会话按单索引:徽标/过滤/拦截共吃一份,免得各自全表扫。 */
function liveIssuesByTicket(rows: IssueSummary[]):
  Map<string, IssueSummary> {
  const map = new Map<string, IssueSummary>();
  rows.forEach((item) => {
    if (item.ticket && isLiveIssue(item) && !map.has(item.ticket)) {
      map.set(item.ticket, item);
    }
  });
  return map;
}

export function IssueRegistration({
  viewer,
  issues,
  onRegistered,
  onLaunched,
  onError,
  onNavigateProfile,
  panel,
  visible = true,
}: {
  viewer: AuthUser;
  /** 我的会话列表:DTS 批量发起的前端查重用(服务端同样机械拦);
   * 2026-09-14 起也是发起状态列/默认过滤的判定数据(liveIssueFor)。 */
  issues: IssueSummary[];
  /** 手工登记成功(ADR-0040):不自动跳工作台——成功横幅里给「打开
   * 问题会话」链接,父级只刷列表。 */
  onRegistered: () => void;
  /** DTS 发起(单张/批量同路)成功:父级刷列表、切「问题会话」子页签,
   * 并拿新会话挂成功横幅(单号可点直达工作台;ADR-0040:批量不开
   * N 个页签)。 */
  onLaunched: (created: IssueSummary[]) => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
  /** 面板受控态(必传):当前面板由导航子页签决定——「问题登记/DTS列表」
   * 两个子页签各接管一个面板,内部不再自持页签按钮。 */
  panel: "dts" | "manual";
  /** 整域显隐(默认可见):导航切到「问题会话」时隐藏但**不卸载**——
   * 表单、勾选与搜索状态跨子页签驻留。 */
  visible?: boolean;
}) {
  // 两个子面板常驻(隐藏切换):DTS 列表、勾选与表单状态跨页签驻留,
  // 首开「DTS 列表」自动拉取一次,之后靠「刷新」手动更新。
  // (#230:.issue-section 卡壳换工具类;IssueBoard 侧同名壳不动。)
  return <section className="rounded-[14px] border border-line bg-surface px-[18px] py-4 max-[680px]:px-3 max-[680px]:py-[13px]" aria-label="发起问题会话"
    hidden={!visible}>
    <div hidden={panel !== "manual"}>
      <ManualRegister viewer={viewer} onRegistered={onRegistered}
        onError={onError} onNavigateProfile={onNavigateProfile} />
    </div>
    <div hidden={panel !== "dts"}>
      <DtsRegister viewer={viewer} issues={issues} active={panel === "dts"}
        onLaunched={onLaunched} onError={onError} />
    </div>
  </section>;
}

function ManualRegister({
  viewer,
  onRegistered,
  onError,
  onNavigateProfile,
}: {
  viewer: AuthUser;
  onRegistered: () => void;
  onError: (message: string) => void;
  onNavigateProfile?: () => void;
}) {
  const [title, setTitle] = useState("");
  // 描述预填标准提单模板(#273):打开即照着填,格式合规靠阻力最小
  // 路径(ADR-0030);不想用模板整段删掉自由书写,必填校验照旧。
  const [description, setDescription] = useState(ISSUE_DESCRIPTION_TEMPLATE);
  // 业务模块必选(spec #15):仓的唯一来源是模块绑定——手填仓、自由
  // 文本模块与 DTS 单号一并废除,无单场景只有一个入口:选模块。
  const [productVersion, setProductVersion] = useState("");
  const [moduleId, setModuleId] = useState("");
  const [modules, setModules] = useState<BusinessModule[] | undefined>();
  const [moduleLoadError, setModuleLoadError] = useState("");
  const [moduleLoadAttempt, setModuleLoadAttempt] = useState(0);
  // 网管环境(2026-09-10 走查裁定「只选不手填」):唯一作答面是台账
  // 快选(EnvironmentPicker 可搜索下拉,搜不到弹框新建并自动选中),
  // 后台密码用台账已存值(前端永远拿不到)。页面凭据已整体废弃
  // (2026-09-10:流程不登录网管页面,登记不再收页面账号/密码)。
  // 从环境管理选(#150,ADR-0020):选中即定,提交只带 environment_id——
  // 服务端以选定时点的台账值快照进会话。
  const [pickedEnv, setPickedEnv] = useState<EnvironmentView | null>(null);
  // 责任人(ADR-0031):登记完成即移交——displayed 值由 resolveAssignee
  // 裁决:未选模块置空,选了模块且未手选自动填模块责任人(换模块跟随),
  // 手选即冻结。候选=全部普通用户(flow=issue 口径,管理员天然不在),
  // 模块责任人与维护者置顶带标记;登记人自己不用配 Git 凭据。
  const [assigneeManual, setAssigneeManual] = useState("");
  const [candidates, setCandidates] = useState<CollaborationAssignee[] | undefined>();
  const [busy, setBusy] = useState(false);
  /** 最近一次登记成功的会话(ADR-0040):登记不自动跳工作台——异步
   * 回调里 window.open 会被弹窗拦截器杀掉,成功横幅里放「打开问题
   * 会话」链接(新页签),登记完成即撒手,再登记一条会顶掉上一条。 */
  const [lastCreated, setLastCreated] = useState<IssueSummary | undefined>();
  const draftKey = `mae-flow:issue:draft:${viewer.username}`;
  // 下拉只收 active 且至少绑一个仓的模块:零仓存量模块发起必被服务端
  // 打回,不进下拉让它根本没有被选中的机会(spec #15)。
  const moduleCatalog = useMemo(() => (modules ?? []).filter((module) =>
    module.status === "active" && module.repositories.length > 0), [modules]);
  const selectedModule = moduleCatalog.find((module) => module.id === moduleId);
  // 指派候选(flow=issue 固定口径:只认 Git 令牌+邮箱,不问小鲁班
  // 令牌)。拉取失败置空表——必填校验拦住提交,服务端门禁兜底。
  useEffect(() => {
    let alive = true;
    listCollaborationAssignees("issue")
      .then((rows) => { if (alive) setCandidates(rows); })
      .catch(() => { if (alive) setCandidates([]); });
    return () => { alive = false; };
  }, []);
  const candidateRows = candidates ?? [];
  const candidateByUsername = useMemo(
    () => new Map(candidateRows.map((row) => [row.username, row])),
    [candidateRows]);
  const selectedOwner = selectedModule?.owner;
  const assignee = resolveAssignee({
    manualPick: assigneeManual,
    moduleOwner: selectedOwner,
    ownerAssignable: Boolean(selectedOwner
      && candidateByUsername.has(selectedOwner)),
  });
  // 模块责任人与维护者置顶带标记:模块相关的人一眼可见(不在候选的
  // 管理员/停用账号跳过——候选接口本就不给)。
  const assigneeOptions = useMemo<UserOption[]>(() => {
    const pinned: UserOption[] = [];
    const picked = new Set<string>();
    for (const name of [selectedOwner, ...(selectedModule?.maintainers ?? [])]) {
      if (!name || picked.has(name)) continue;
      const row = candidateByUsername.get(name);
      if (!row) continue;
      picked.add(name);
      pinned.push({
        username: row.username,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        detail: (name === selectedOwner ? "模块责任人" : "模块维护者")
          + (row.ready ? "" : "(未配 Git 凭据)"),
      });
    }
    return [...pinned, ...candidateRows
      .filter((row) => !picked.has(row.username))
      .map((row) => ({
        username: row.username,
        ...(row.display_name ? { display_name: row.display_name } : {}),
        ...(row.ready ? {} : { detail: "未配 Git 凭据" }),
      }))];
  }, [candidateRows, candidateByUsername, selectedOwner, selectedModule]);
  // 就绪三态:候选在册才谈配没配齐——候选没加载完/拉取失败/所选人
  // 不在册(管理员、目录失败)都是未知,门与提交拦截不出场,服务端
  // 门禁兜底,不谎报「未配齐」。
  const assigneeReadyKnown = Boolean(assignee && candidateByUsername.has(assignee));
  const assigneeReady = candidateByUsername.get(assignee)?.ready === true;
  /** 候选在册则「姓名(工号)」,不在册只显工号。 */
  const candidateLabel = (username: string): string => {
    const row = candidateByUsername.get(username);
    return userLabel({ username,
      ...(row?.display_name ? { display_name: row.display_name } : {}) });
  };
  useEffect(() => {
    let alive = true;
    setModules(undefined);
    setModuleLoadError("");
    // 加载失败和空目录是两种事实:前者给重试,后者指路配置中心。两种
    // 情况都不回退手填仓(spec #15:仓的唯一权威是模块绑定)。
    getBusinessModules()
      .then((catalog) => { if (alive) setModules(catalog.modules); })
      .catch((cause) => {
        if (!alive) return;
        setModuleLoadError(cause instanceof Error
          ? cause.message : "业务模块目录暂时无法读取");
      });
    return () => { alive = false; };
  }, [moduleLoadAttempt]);
  // 草稿纪律(spec #15):只存 标题/现象/模块;密码绝不进 localStorage
  // ——共机不残留凭据。
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(draftKey) ?? "null");
      if (saved) {
        setTitle(saved.title ?? "");
        // 清空过的草稿(存的是空串)回读时不回灌空串——描述框只以
        // 模板或用户内容呈现,不出现空框(#273)。
        setDescription(saved.description || ISSUE_DESCRIPTION_TEMPLATE);
        setModuleId(typeof saved.moduleId === "string" ? saved.moduleId : "");
      }
    } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }, [draftKey]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          title, description, moduleId,
        }));
      } catch { /* 同上 */ }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [draftKey, title, description, moduleId]);

  // 现象描述内嵌截图(#184 票2):粘贴/拖拽由所见即所得编辑器接管——
  // 上传钩子落 staging 后返回相对引用,编辑器在光标位置插入并原地渲染。
  // 图片本体不进 description,进的只有 issue-images/ 相对引用(与
  // ticketImages 同款架构红线)。
  async function uploadIssueFile(file: File): Promise<string> {
    try {
      const result = await uploadIssueImage(file);
      return result.path;
    } catch (reason) {
      const message = `图片上传失败:${
        String(reason instanceof Error ? reason.message : reason)}`;
      onError(message);
      throw reason;
    }
  }

  // 登记附件(2026-09-19 拍板,先做无单):日志等文件点选/粘贴/拖拽
  // 上传,落 staging 后把 attachments/ 相对路径以纯文本插进描述——登记
  // 提交时平台复制进会话工作区,开场词单列一行引导 AI 优先查看。
  async function uploadIssueAttachmentFile(file: File): Promise<string> {
    try {
      const result = await uploadIssueAttachment(file);
      return result.path;
    } catch (reason) {
      const message = `附件上传失败:${
        String(reason instanceof Error ? reason.message : reason)}`;
      onError(message);
      throw reason;
    }
  }

  // 个人凭据前置门禁(ADR-0031 起查责任人):模块带出的仓一般是
  // https 远端,克隆与推送都用责任人的身份——按模块绑定判断 needRepo;
  // 全本地仓(file:// 演示库)不拦。服务端 create 里机械拦(判定同源),
  // 这里把拦截面提前到表单。
  const touchRemoteRepo = (selectedModule?.repositories ?? [])
    .some((url) => /^https?:\/\//i.test(url));
  const credentialBlocked = Boolean(assignee) && touchRemoteRepo
    && assigneeReadyKnown && !assigneeReady;

  // 发起按钮的灰化口径(spec 验收):目录为空/未选模块/凭据缺失/提交中。
  // 字段缺内容不灰按钮——提交时逐项给友好指路文案,让人知道卡在哪。
  const catalogEmpty = modules !== undefined && !moduleLoadError
    && moduleCatalog.length === 0;
  const submitDisabled = busy || credentialBlocked
    || moduleCatalog.length === 0 || !selectedModule;

  // 从环境管理选(#150):选中即定,不再有手填回退——IP 即名字,
  // 搜不到走选择器内置的「新增环境」弹框(录完自动选中)。
  function pickEnv(entry: EnvironmentView) {
    setPickedEnv(entry);
  }

  function clearPickedEnv() {
    setPickedEnv(null);
  }

  // 发起即终止草稿(2026-10-15 拍板):草稿是未兑现的登记意图,发起成功
  // 或主动清空后意图已了——显式删本地草稿并整表重置(含产品版本),
  // 不再靠重置后的防抖写间接刷新:那笔写 400ms 内被刷新/关页取消时,
  // 旧草稿会原地存活到下次打开,整份旧内容回魂。
  function resetRegistration() {
    setTitle("");
    setDescription(ISSUE_DESCRIPTION_TEMPLATE);
    setModuleId("");
    setProductVersion("");
    setAssigneeManual("");
    clearPickedEnv();
    try { localStorage.removeItem(draftKey); } catch { /* 草稿是旁路,坏了就坏了吧 */ }
  }

  // 清空重填:填了一半想放弃重来的确定出口,不再逐栏手删。破坏性动作
  // 走全站 confirmDialog 二次确认(spec #52),不用裸 window.confirm。
  async function clearRegistration() {
    if (!await confirmDialog({
      title: "清空登记表单",
      message: "标题、描述、模块、版本、环境与责任人会一并清空,本地草稿同时删掉。",
      confirmLabel: "清空重填",
      danger: true,
    })) return;
    resetRegistration();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || submitDisabled) return;
    if (!title.trim()) {
      onError("问题标题必填——一句话说清现象");
      return;
    }
    if (!description.trim()) {
      onError("问题描述必填——发生条件、影响范围、复现步骤,写得越具体 AI 少走弯路");
      return;
    }
    // 模板原样拦截(#273):预填后描述永不为空,空模板会绕过必填校验、
    // 登记后白跑一轮首轮会话;字段缺内容不灰按钮的口径同样适用——提交
    // 时给指路文案,不靠灰化猜。
    if (isUntouchedTemplate(description)) {
      onError("描述还是模板原样——把问题描述、触发步骤、预期结果填一填再发起;不想用模板就整段删掉自己写");
      return;
    }
    if (!productVersion) {
      onError("请选择产品版本——版本是复现与修复的基线");
      return;
    }
    if (!pickedEnv) {
      onError("请从环境管理选择网管环境——搜不到就点下拉里的「新增环境」录一条");
      return;
    }
    if (!assignee) {
      onError("请选择责任人——登记完成后由责任人推进;选了业务模块会自动带上模块责任人");
      return;
    }
    if (touchRemoteRepo && assigneeReadyKnown && !assigneeReady) {
      onError(`责任人 ${candidateLabel(assignee)}` +
        " 的 Git 凭据未配齐——改选已配齐的责任人,或让责任人配好后再登记");
      return;
    }
    setBusy(true);
    try {
      const created = await createIssue({
        title: title.trim(),
        description: description.trim(),
        module_id: moduleId,
        product_version: productVersion,
        // 快选(#150):只带台账条目 id,值由服务端解密快照(前端零密码)。
        environment: { environment_id: pickedEnv.id },
        // 责任人(ADR-0031):登记完成即移交,归属与推进人。
        assignee,
      });
      // 重置回模板而非空串(#273):下一条登记仍从标准格式起步,两套
      // 空态不并存;发起即终止草稿,显式删本地存档(2026-10-15 拍板)。
      resetRegistration();
      setLastCreated(created);
      onRegistered();
    } catch (reason) {
      onError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }

  return <form className="grid grid-cols-2 gap-3 max-[680px]:grid-cols-1" onSubmit={submit}>
    {/* 资源屏蔽提示跨全列(2026-09-14 设计审查 04):组件保持布局中性,
        落位由本域网格决定——不再首行右半空格。 */}
    <div className="col-span-full">
      <RepositoryResourceNotice repositories={selectedModule?.repositories ?? []} />
    </div>
    <label className={cn(FIELD, "col-span-full")}>
      <span>问题标题 <i className="font-bold not-italic text-danger">*</i></span>
      <Input value={title} placeholder="一句话说清现象,如:播放器偶发黑屏"
        onChange={(event) => setTitle(event.target.value)} />
    </label>
    {/* 描述字段不用 label 包裹:label 的激活转发会把点进编辑区
        的动作转给区内第一个可激活元素,行为不可控(2026-09-11
        用户实测)。 */}
    <div className={cn(FIELD, "col-span-full")}>
      <span>问题描述 <i className="font-bold not-italic text-danger">*</i></span>
      {/* 选型在 descriptionEditorChoice:两壳同一 markdown 契约,
          翻转常量重新构建即回退,存储零迁移(#271)。 */}
      {USE_RICH_TEXT_DESCRIPTION_EDITOR
        ? <RichTextEditor value={description} onChange={setDescription}
          onUploadImage={uploadIssueFile}
          onUploadAttachment={uploadIssueAttachmentFile}
          onError={onError}
          placeholderText="不想用模板就整段删掉,从这里自由书写;粘贴或拖拽截图自动上传并原地显示,日志等附件拖进来或点下方按钮" />
        : <DescriptionEditor value={description} onChange={setDescription}
          onUploadImage={uploadIssueFile} onError={onError}
          placeholderText="不想用模板就整段删掉,从这里自由书写;粘贴或拖拽截图自动上传并原地显示" />}
      {/* 上传进行态指示住编辑器内右上角(DescriptionEditor 自持),
          页脚不再重复一份。 */}
      <div className="issue-desc-foot flex min-h-6 items-center justify-end gap-2.5">
        {/* 清空重填(2026-10-15 拍板):填一半放弃重来的确定出口,二次
            确认后整表+本地草稿一并清掉;置于页脚不显眼处防误触。 */}
        <Button type="button" variant="ghost" size="xs" onClick={() => void clearRegistration()}>
          清空重填
        </Button>
        {/* 一键复制:描述写完想带走(贴工单/飞书)都不用手选全选;
            空描述不可点。 */}
        <CopyDescriptionButton markdown={description}
          disabled={!description.trim()} variant="ghost" size="xs" />
      </div>
    </div>
    {/* 仓不占版面(拍板 2026-08-31):选中模块即带出绑定仓,清单
        收进悬停提示——悬停选择器或提示行就能看到将拉取哪些仓;
        要增删仓去「配置中心 → 模块与代码仓」维护绑定,登记页不改。 */}
    {/* 业务模块在前(决定代码仓与默认责任人),产品版本跟在其后
        同行成对:两枚半宽选择框等宽。 */}
    <label className={FIELD}>
      <span>业务模块 <i className="font-bold not-italic text-danger">*</i></span>
      <span className="issue-module-wrap group/mod relative grid gap-1.5">
        <Select value={moduleId}
          disabled={modules === undefined || !!moduleLoadError}
          items={[{ value: "", label: "选择业务模块——决定关联代码仓" },
            ...moduleCatalog.map((module) => ({
              value: module.id,
              label: `${module.name}(绑 ${module.repositories.length} 个仓)`,
            }))]}
          onValueChange={(value) => setModuleId(value ?? "")}>
          <SelectTrigger className="w-full" aria-label="业务模块">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="tw-root">
            <SelectGroup>
              <SelectItem value="" disabled>选择业务模块——决定关联代码仓</SelectItem>
              {moduleCatalog.map((module) => (
                <SelectItem key={module.id} value={module.id}>
                  {module.name}(绑 {module.repositories.length} 个仓)
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        {selectedModule && <>
          <small className="cursor-help text-muted-foreground">
            已带出 {selectedModule.repositories.length} 个代码仓,悬停查看
          </small>
          {/* 悬浮卡(#230 换工具类):悬停/键盘聚焦经 group 变体弹出,
              键盘可达性不变;短名一行放下,全地址挂 title 悬停可见。 */}
          <span className="issue-module-tip absolute left-0 top-[calc(100%+6px)] z-40 hidden min-w-[min(440px,100%)] gap-2 rounded-[10px] border border-line bg-surface p-3 shadow-(--shadow-md) group-hover/mod:grid group-focus-within/mod:grid" role="tooltip">
            <b className="text-text-strong">将拉取 {selectedModule.repositories.length} 个代码仓</b>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {selectedModule.repositories.map((url) => (
                <li className="truncate rounded-lg border border-line bg-surface-muted px-2.5 py-1.5 font-mono text-xs text-text-strong" key={url} title={url}>{repoLabel(url)}</li>
              ))}
            </ul>
          </span>
        </>}
      </span>
      {moduleLoadError && <small className="col-span-full flex items-center justify-between gap-2.5 rounded-lg border border-destructive/35 px-2.5 py-2 text-destructive max-[680px]:flex-col max-[680px]:items-stretch" role="alert">
        <span>业务模块加载失败:{moduleLoadError}</span>
        <Button type="button" variant="outline" size="sm" className="border-current text-inherit"
          onClick={() => setModuleLoadAttempt((value) => value + 1)}>
          重试加载
        </Button>
      </small>}
      {catalogEmpty && <small className="col-span-full" role="alert">
        模块目录为空——先到「配置中心 → 模块与代码仓」登记并绑定代码仓,再回来登记。
      </small>}
    </label>
    {/* 产品版本(2026-09-18 起必选):标签与行距经 className/labelClassName
        对齐 FIELD 版式,和旁边业务模块的字段头完全一致。 */}
    <ProductVersionPicker value={productVersion} className={FIELD} required
      labelClassName="text-[13px] font-normal"
      onChange={version => setProductVersion(version)} />
    {/* 责任人(ADR-0031):登记完成即移交——模块责任人+维护者置顶
        带标记,选模块自动带上,手选即冻结。不用 label 包裹:label
        的激活转发会把点开选人框的动作转给区内首个可激活元素
        (同描述字段的走查结论)。 */}
    <div className={FIELD}>
      <span>责任人 <i className="font-bold not-italic text-danger">*</i></span>
      <UserPicker value={assignee} options={assigneeOptions}
        onChange={setAssigneeManual} ariaLabel="责任人"
        emptyLabel="选择责任人——登记完成后由其推进" />
      {selectedModule?.owner && <small className="text-xs leading-normal text-faint">
        模块「{selectedModule.name}」的责任人是 {candidateLabel(selectedModule.owner)},
        未手选时自动带上
      </small>}
    </div>
    {/* 从环境管理选(#150,ADR-0020;2026-09-10 走查裁定「只选不
        手填」):可搜索下拉挑台账条目,搜不到点「新增环境」弹共用
        表单、录完自动选中;后台密码用台账已存值(前端拿不到)。
        与责任人并排等宽;label 包裹同款激活转发问题,故用 div。 */}
    <div className={FIELD}>
      <span>网管环境 <i className="font-bold not-italic text-danger">*</i></span>
      <EnvironmentPicker
        selectedId={pickedEnv?.id ?? null} onPick={pickEnv} />
    </div>
    {pickedEnv && <small className="col-span-full m-0 text-xs leading-normal text-faint max-[680px]:min-w-0" role="status">
      将使用「环境管理」里 <span className="font-mono">{pickedEnv.ip}</span> 的已存密码
      (以选定时为准),无需在此填写。密码不会出现在页面或事件流,
      但会在执行问题处理时明文进入当前 AI 上下文。
    </small>}
    <CredentialGate viewer={viewer} needRepo={touchRemoteRepo}
      assignee={assignee} readyKnown={assigneeReadyKnown} ready={assigneeReady}
      missing={assignee ? candidateByUsername.get(assignee)?.missing ?? [] : []}
      onNavigateProfile={onNavigateProfile} />
    <div className="col-span-full flex items-center gap-3.5 max-[680px]:flex-col max-[680px]:items-stretch">
      <Button type="submit" disabled={submitDisabled} className="max-[680px]:min-h-11 max-[680px]:w-full">
        {busy ? "登记中…" : "登记问题"}
      </Button>
    </div>
    {/* 登记成功提示(ADR-0040):不自动跳,工作台入口是链接(新页签)。
        曾是按钮旁一行小字灰提示,被当成"没发出去";升成成功横幅并点名
        已发起,链接即问题会话入口。再登记一条会顶掉上一条横幅。 */}
    {lastCreated && <div role="status"
      className="col-span-full flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-success/35 bg-success-soft px-3.5 py-2.5 text-sm text-success">
      <span>已登记并发起</span>
      <strong className="font-semibold" title={lastCreated.title}>「{lastCreated.title}」</strong>
      <span>,责任人 {lastCreated.account} 接手推进;点这里打开问题会话:</span>
      <a className="font-semibold underline underline-offset-2 hover:underline"
        href={issueSessionPath(lastCreated.id)}
        target="_blank" rel="noreferrer">打开问题会话 ↗</a>
    </div>}
  </form>;
}

/* ---------- DTS 列表列宽拖拽(2026-09-17) ---------- */

type DtsColKey =
  | "select" | "ticket" | "title"
  | "launch" | "remark" | "module" | "tier" | "autoClaim";

/** 默认列宽(px):初版沿用迁表时的现行宽度(w-28/w-64/w-24/w-56);
 * 2026-10-14 按使用观感调整——备注格是截断预览钮用不了 240 那么宽,
 * 模块下拉的模块名更长,加宽到 200。标题列不设默认——它是唯一弹性
 * 列,吃掉全部剩余宽度(拖其他列都是从它身上要地方,初览观感不变)。 */
const DTS_COL_DEFAULT: { [K in Exclude<DtsColKey, "title">]: number } = {
  select: 64, ticket: 150,
  launch: 96, remark: 180, module: 200, tier: 116, autoClaim: 116,
};
/** 拖动下限:再窄内容就互相打架(单号列要放得下完整单号)。 */
const DTS_COL_MIN: Record<DtsColKey, number> = {
  select: 48, ticket: 120, title: 160,
  launch: 88, remark: 140, module: 120, tier: 96, autoClaim: 96,
};
/** 拖动上限(2026-10-14 随引擎迁移补上):手写版只有下限,单列拖到
 * 几千像素表就横向滚不到头;上限封住跑飞,超宽内容格内自行滚动。 */
const DTS_COL_MAX: Record<DtsColKey, number> = {
  select: 96, ticket: 320, title: 1200,
  launch: 220, remark: 800, module: 400, tier: 240, autoClaim: 240,
};
/** 列头人话(把手 aria 用;列设置 popover 的可显隐清单另含业务释义)。 */
const DTS_COL_LABEL: Record<DtsColKey, string> = {
  select: "勾选", ticket: "单号", title: "标题",
  launch: "发起状态", remark: "附加信息", module: "所属模块", tier: "介入档位",
  autoClaim: "自动接单",
};
/** 单元格排版(表定宽后格内的裁剪策略,随列走不随格写)。 */
const DTS_CELL_CLASS: Partial<Record<DtsColKey, string>> = {
  ticket: "whitespace-nowrap overflow-hidden",
  title: "max-w-0",
  launch: "whitespace-nowrap",
};
/** 列宽记忆(全用户共用一份:列宽是屏幕偏好不是业务数据,不按人分)。
 * 2026-10-14 迁引擎时拍板不继承手写时代的旧键——旧值没有上限口径、
 * 可能带着超限大宽,新键新起(只经写边界落地,永远合法),旧键读盘
 * 即清,人人回到默认布局重拖。 */
const DTS_COL_WIDTHS_KEY = "mae-flow:dts-col-widths:v2";
const DTS_COL_WIDTHS_LEGACY_KEY = "mae-flow:dts-col-widths";

/** 可显隐的数据列(ADR-0056):勾选与单号两列常驻,其余数据列按人
 *  显隐;隐藏不消失义务——发起闸仍在勾选列禁用态上可见。 */
const DTS_HIDEABLE_COLS: Array<{ key: DtsColKey; label: string }> = [
  { key: "title", label: "标题" },
  { key: "module", label: "所属模块" },
  { key: "launch", label: "发起状态" },
  { key: "remark", label: "附加信息" },
  // 介入档位默认隐藏(2026-09-24 用户拍板):会话级特例是少数人的
  // 进阶需求,不占默认视野;要在列设置里自己打开。显隐极性与其余
  // 数据列相反(默认关,点名才开),单独存一份按人记忆。
  { key: "tier", label: "介入档位" },
  // 自动接单排除(ADR-0070)同极性:按单调「排除」是少数人的逃生门
  // 操作,默认不占视野,点名才开。
  { key: "autoClaim", label: "自动接单" },
];

/** 默认隐藏、点名才开的列(显隐极性反转表):tier(ADR-0058)与
 *  autoClaim(ADR-0070)两列默认关,与其余数据列「默认开、勾掉进
 *  hiddenCols」极性相反,逐列单独一份按人记忆,免得「缺席」一词
 *  两头解读。 */
const DTS_OPT_IN_COLS: ReadonlyArray<{ key: DtsColKey; storage: string }> = [
  { key: "tier", storage: "mae-flow:dts-tier-col" },
  { key: "autoClaim", storage: "mae-flow:dts-autoclaim-col" },
];

/** 介入档位三档(ADR-0057):与个人设置「人工介入程度 · 问题处理」
 *  同名同序;「跟随全局」是列上多出的第四个值=不落偏好。 */
const TIER_OPTIONS = [
  { value: "1", label: "全自动" },
  { value: "2", label: "优先报告" },
  { value: "3", label: "优先对齐" },
] as const;
type DtsTierPref = (typeof TIER_OPTIONS)[number]["value"];
const TIER_LABEL = new Map<string, string>(TIER_OPTIONS.map((tier) =>
  [tier.value, tier.label]));
const TIER_FOLLOW = "__follow";
// 介入档位下拉的 items 模块级常量(2026-10-16):与 moduleSelectItems
// 同理——内联数组每次渲染新标识,弹层开着撞上轮询重渲染就被收掉。
const TIER_SELECT_ITEMS = [
  { value: TIER_FOLLOW, label: "跟随全局" },
  ...TIER_OPTIONS,
] as const;

/** 自动接单两态(ADR-0070):「允许」=缺省(排除表无条目,照常参与
 *  定时自动接单),「排除」=扫描器跳过这张单,人工发起不受影响。
 *  items 模块级常量(同 TIER_SELECT_ITEMS:标识稳定,弹层开着撞上
 *  轮询重渲染不被收掉)。 */
const CLAIM_SELECT_ITEMS = [
  { value: "allow", label: "允许" },
  { value: "exclude", label: "排除" },
] as const;

/** 随单附件条目(#502):显示名留原始文件名给人看,path 是暂存引用
 * (attachments/<hash>.<ext>),发起时拼进附加信息文本随单落库。 */
type RemarkFileEntry = { name: string; path: string };

function loadDtsColWidths(): ColumnSizingState {
  try {
    // 旧键(手写时代,无上限口径)不兼容,读盘即清,不迁移。
    localStorage.removeItem(DTS_COL_WIDTHS_LEGACY_KEY);
  } catch { /* 隐私模式等存不了:清不掉也无害 */ }
  try {
    const raw = localStorage.getItem(DTS_COL_WIDTHS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    const out: ColumnSizingState = {};
    if (typeof parsed !== "object" || parsed === null) return out;
    for (const [key, value] of Object.entries(parsed)) {
      // 新键只经写边界落地(已按 MIN/MAX 钳制),这里只做形状校验。
      if (key in DTS_COL_MIN && typeof value === "number"
        && Number.isFinite(value)) {
        out[key] = value;
      }
    }
    return out;
  } catch { return {}; }
}

/** 列宽拖拽把手(2026-09-17 手写;2026-10-14 迁 TanStack Table 引擎):
 * 贴表头右缘的透明窄条。pointer/touch 拖动由 header.getResizeHandler()
 * 承担,宽度即 columnSizing 状态(写边界按列 min/max 钳制,见
 * DtsRegister 的 onColumnSizingChange)——拖动中引擎 onChange 模式
 * 逐帧改状态,单一真相源,5s 轮询的重渲染写的也是同一份,手写版
 * 「直写 DOM 被轮询打断回弹」的抖动就此消失。方向键微调(Shift 大步),
 * 双击/Enter 恢复默认(resetSize=从 sizing 状态摘键:标题列回弹性,
 * 定宽列回默认宽)。 */
function DtsColResizeHandle({ header, label }: {
  header: Header<DtsTicketBrief, unknown>;
  label: string;
}) {
  const column = header.column;
  const table = header.getContext().table;
  const stateWidth = table.getState().columnSizing[column.id];
  const clampPx = (px: number) =>
    Math.min(Math.max(Math.round(px),
      DTS_COL_MIN[column.id as DtsColKey]),
      DTS_COL_MAX[column.id as DtsColKey]);
  const headWidth = (current: EventTarget & Element) =>
    current.closest("th")?.getBoundingClientRect().width
      ?? column.getSize();
  // 写入口统一走 setColumnSizing,钳制收在 onColumnSizingChange 的写
  // 边界一处(见 DtsRegister):引擎拖动路径只收负值,min/max 在读侧
  // getSize() 才钳——我们渲染/持久化直接读状态,写边界必须自己收。
  // 拖动途经文字会起选区(引擎不管选区):按住期间全局禁选,引擎
  // 报告拖动结束(isResizing 翻 false 必经一次重渲染)再还原。
  const isResizing = column.getIsResizing();
  useEffect(() => {
    if (!isResizing) document.body.style.userSelect = "";
    return undefined;
  }, [isResizing]);
  return <span
    role="separator"
    aria-orientation="vertical"
    tabIndex={0}
    aria-label={`调整「${label}」列宽:拖动或按左右方向键,双击恢复默认`}
    {...(stateWidth !== undefined
      ? { "aria-valuenow": Math.round(column.getSize()) } : {})}
    data-dragging={column.getIsResizing() || undefined}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      // 只有弹性标题列需要落指种子:colgroup 对它不出宽,引擎拖动
      // 起点取 getSize()(状态缺席回列默认 160),不从实测起步会跳变
      // (862×(1+80/160)=1293→钳到上限,即「点一下突变」的机制)。
      // 受控列宽经 React 异步回流,引擎同一 tick 的 mousedown 读不到
      // setColWidths——种子必须 table.setOptions 同步改表实例状态,
      // 引擎当场读到实测宽;镜像随 setColWidths 同步落一份。
      if (column.id === "title" && stateWidth === undefined) {
        const measured = clampPx(headWidth(event.currentTarget));
        table.setOptions((old) => ({
          ...old,
          state: {
            ...old.state,
            columnSizing: {
              ...old.state.columnSizing, [column.id]: measured },
          },
        }));
      }
      document.body.style.userSelect = "none";
      header.getResizeHandler()(event);
    }}
    onDoubleClick={(event) => {
      event.preventDefault();
      column.resetSize();
    }}
    onKeyDown={(event) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = (event.key === "ArrowLeft" ? -1 : 1)
          * (event.shiftKey ? 48 : 16);
        table.setColumnSizing((old) => ({
          ...old, [column.id]:
            (stateWidth ?? headWidth(event.currentTarget)) + step }));
      } else if (event.key === "Enter" || event.key === "Home") {
        event.preventDefault();
        column.resetSize();
      }
    }}
    className={cn(
      "absolute inset-y-0 -right-1 z-10 w-2.5 cursor-col-resize touch-none",
      "outline-none",
      "after:absolute after:inset-y-0.5 after:left-1/2 after:w-px",
      "after:-translate-x-1/2 after:bg-primary after:opacity-0",
      "after:transition-opacity hover:after:opacity-60",
      "focus-visible:after:opacity-60 data-[dragging]:after:opacity-100",
    )}
  />;
}

function DtsRegister({
  viewer,
  issues,
  active,
  onLaunched,
  onError,
}: {
  viewer: AuthUser;
  /** 我的会话列表:发起前按单查重(服务端 create 同样机械拦);
   * 发起状态列/默认过滤同尺共用(liveIssueFor)。 */
  issues: IssueSummary[];
  /** 页签是否激活:首次激活自动拉取一次名下问题单,之后手动刷新。 */
  active: boolean;
  /** 发起成功(单张/批量同路,ADR-0040):带新会话交父级——切「问题
   * 会话」子页签挂成功横幅,不在本页打开工作台。 */
  onLaunched: (created: IssueSummary[]) => void;
  onError: (message: string) => void;
}) {
  // 产品版本选择框已随分支匹配退役(ADR-0038):分支由每张单的版本号
  // 按配置中心映射推导(服务端单点匹配,列表逐单带 branch),不再有
  // 全局选择;手工登记表单(无单据版本可推导)仍保留自己的选择框。
  const [tickets, setTickets] = useState<DtsTicketBrief[] | undefined>();
  // 协助处理(2026-09-17):名下视角可切换——默认看自己,选人后看别人
  // 名下的单(工具栏人员选择框)。换的是读侧视角,不发所有权:发起后
  // 的会话归属仍是登录人(分支名 master_{发起人}_{单号} 各归各,与对方
  // 已发起的会话互不打架),接管对方单子就从这里发起。
  const [owner, setOwner] = useState(viewer.username);
  const assistMode = owner !== viewer.username;
  // 人员候选来自 /auth/people(全员只读身份字段);没加载到就只有自己
  // 可选(选择框退化为摆设但不挡用)。
  const [people, setPeople] = useState<PersonIdentity[]>();
  // 协助视角的「发起状态」要认全团队会话:自己的会话列表只含归属或
  // 登记人是自己的,对方发起过的单在里面对不上号。?scope=all 读侧
  // 全员开放;回到自己名下即弃,不多占一份状态。
  const [teamIssues, setTeamIssues] = useState<IssueSummary[]>();
  // 外部开发模式(--dts-mock):单据为模拟数据,页签挂 DEV 徽标防误认。
  const [dtsMock, setDtsMock] = useState(false);
  const [loading, setLoading] = useState(false);
  // 批量发起(2026-08-28):勾选多张,逐张独立发起工作流。
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // 附加信息列(原发起备注,2026-09-20 立;2026-09-24 弹窗化;2026-10-15
  // #502 扩随单附件并更名):格子里是预览,点击弹多行弹窗编辑(用户可能
  // 长篇输入,单行输入框不够)。按人持久化在 localStorage(无过期,刷新/
  // 重开浏览器都在),发起成功即清该单条目(已随会话落库,消费完毕)。
  // 上限 10000 字(2026-10-14 拍板,从 5000 放开):文本全额进 AI 开场
  // 与每次上下文重建的续聊词,不截断;后端不设闸(仅前端约束),超长
  // 材料仍走附件/知识仓。
  const remarksKey = `mae-flow:dts-remarks:${viewer.username}`;
  const [remarks, setRemarks] = useState<Record<string, string>>(() => {
    try {
      const parsed: unknown = JSON.parse(
        localStorage.getItem(remarksKey) ?? "{}");
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed)
        .filter((entry): entry is [string, string] =>
          typeof entry[1] === "string"));
    } catch { return {}; }
  });
  useEffect(() => {
    try {
      localStorage.setItem(remarksKey, JSON.stringify(remarks));
    } catch { /* 旁路:存不下就本次会话内有效 */ }
  }, [remarks, remarksKey]);
  // 随单附件(#502):单号→已传文件列表(显示名+暂存路径引用),与
  // 文本同款按人持久化。上传即落暂存、进列表——取消弹窗不清(文件已
  // 是暂存事实,清了也是孤儿),列表里可移除;发起成功即清该单条目
  // ——路径行已拼进附加信息随会话落库,消费完毕。
  const remarkFilesKey = `mae-flow:dts-remark-files:${viewer.username}`;
  const [remarkFiles, setRemarkFiles] =
    useState<Record<string, RemarkFileEntry[]>>(() => {
      try {
        const parsed: unknown = JSON.parse(
          localStorage.getItem(remarkFilesKey) ?? "{}");
        if (typeof parsed !== "object" || parsed === null) return {};
        return Object.fromEntries(Object.entries(parsed)
          .filter((entry): entry is [string, RemarkFileEntry[]] =>
            Array.isArray(entry[1]) && entry[1].every((file) =>
              typeof file?.name === "string"
              && typeof file?.path === "string")));
      } catch { return {}; }
    });
  useEffect(() => {
    try {
      localStorage.setItem(remarkFilesKey, JSON.stringify(remarkFiles));
    } catch { /* 旁路:存不下就本次会话内有效 */ }
  }, [remarkFiles, remarkFilesKey]);
  // 弹窗编辑态:remarkEditing=正在编辑的单号(null=关);草稿独立,
  // 保存才落 remarks,取消/X/点外部一律丢弃(附件不在此列,见上)。
  const [remarkEditing, setRemarkEditing] = useState<string | null>(null);
  const [remarkDraft, setRemarkDraft] = useState("");
  const REMARK_MAX = 10000;
  // 正在编辑的单的附件列表(弹窗与格子预览共用;关弹窗时空数组)。
  const editingFiles = remarkEditing !== null
    ? remarkFiles[remarkEditing] ?? [] : [];
  const [remarkDragActive, setRemarkDragActive] = useState(false);
  // 介入档位(ADR-0057):未发起行按单选初始档,存本地按人(同附加
  // 信息款,无过期);发起成功即清该单条目——已随会话定格落库,消费
  // 完毕。空(无条目)=跟随全局,发起请求不带字段。发起后不可改,
  // 进行中行只读显示,协助视角不显示(偏好只影响自己的发起)。
  const tiersKey = `mae-flow:dts-tiers:${viewer.username}`;
  const [tiers, setTiers] = useState<Partial<Record<string, DtsTierPref>>>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(tiersKey) ?? "{}");
      if (typeof parsed !== "object" || parsed === null) return {};
      return Object.fromEntries(Object.entries(parsed)
        .filter((entry): entry is [string, DtsTierPref] =>
          TIER_LABEL.has(entry[1])));
    } catch { return {}; }
  });
  useEffect(() => {
    try {
      localStorage.setItem(tiersKey, JSON.stringify(tiers));
    } catch { /* 旁路:存不下就本次会话内有效 */ }
  }, [tiers, tiersKey]);
  // 所属模块(ADR-0056):单号→模块团队共享映射只存人工改选;服务端
  // 强匹配的带出值不落账(显示=现算、执行=快照),展示=改选优先于
  // 带出,发起必带。选即存,PUT 失败回滚并把原因落在那一行。
  const [bindings, setBindings] = useState<Record<string, DtsModuleBindingEntry>>({});
  // 列显隐(ADR-0056):数据列(标题/版本/分支/所属模块/发起状态/
  // 附加信息)可按人显隐,勾选与单号常驻;隐藏不消失义务——发起闸
  // 仍在勾选列禁用态上可见。localStorage 按用户记忆。
  const hiddenColsKey = `mae-flow:dts-hidden-cols:${viewer.username}`;
  const [hiddenCols, setHiddenCols] = useState<Set<DtsColKey>>(() => {
    try {
      const raw = localStorage.getItem(hiddenColsKey);
      if (!raw) return new Set();
      const parsed: unknown = JSON.parse(raw);
      const keys = Array.isArray(parsed) ? parsed : [];
      return new Set(keys.filter((key): key is DtsColKey =>
        DTS_HIDEABLE_COLS.some((col) => col.key === key)));
    } catch { return new Set(); }
  });
  // 默认隐藏列的显隐记忆(介入档位 2026-09-24 用户拍板默认隐藏;自动
  // 接单 ADR-0070 同极性):其余数据列默认开、勾掉进 hiddenCols;这两
  // 列默认关、点名才开,极性相反不共用一份集合,免得「缺席」一词两头
  // 解读——DTS_OPT_IN_COLS 逐列单独一份按人记忆。
  const [optInColShown, setOptInColShown] = useState<Record<string, boolean>>(
    () => Object.fromEntries(DTS_OPT_IN_COLS.map((col) => {
      try {
        return [col.key,
          localStorage.getItem(`${col.storage}:${viewer.username}`) === "1"];
      } catch { return [col.key, false]; }
    })));
  useEffect(() => {
    for (const col of DTS_OPT_IN_COLS) {
      try {
        localStorage.setItem(`${col.storage}:${viewer.username}`,
          optInColShown[col.key] ? "1" : "0");
      } catch { /* 旁路:存不下就本次会话内有效 */ }
    }
  }, [optInColShown, viewer.username]);
  const colShown = (key: DtsColKey) =>
    DTS_OPT_IN_COLS.some((col) => col.key === key)
      ? optInColShown[key] === true
      : !hiddenCols.has(key);
  const toggleCol = (key: DtsColKey, shown: boolean) => {
    if (DTS_OPT_IN_COLS.some((col) => col.key === key)) {
      setOptInColShown((current) => ({ ...current, [key]: shown }));
      return;
    }
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (shown) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  useEffect(() => {
    try {
      localStorage.setItem(hiddenColsKey, JSON.stringify([...hiddenCols]));
    } catch { /* 旁路:存不下就本次会话内有效 */ }
  }, [hiddenCols, hiddenColsKey]);
  const [modules, setModules] = useState<BusinessModule[]>();
  // 行内保存反馈:哪张单正在存/哪张单存失败(失败显示原因,选择回滚)。
  const [bindingTicket, setBindingTicket] = useState("");
  const [bindFail, setBindFail] = useState<{ ticket: string; message: string }>();
  // 自动接单排除(ADR-0070):行字段 auto_claim_excluded 是服务端事实,
  // 选即存的乐观覆盖单独一份(改写失败回滚用);进行中保存与失败原因
  // 与所属模块列同款逐行反馈。所有行可改,不限发起状态。
  const [claimExcluded, setClaimExcluded] = useState<Record<string, boolean>>({});
  const [claimTicket, setClaimTicket] = useState("");
  const [claimFail, setClaimFail] = useState<{ ticket: string; message: string }>();
  // 下拉目录与登记页同一把尺:active 且至少绑一个仓——绑了也没用的
  // 模块不给选。
  const moduleCatalog = useMemo(() => (modules ?? [])
    .filter((module) => module.status === "active"
      && module.repositories.length > 0),
  [modules]);
  // 模块下拉 items 必须单源 memo(2026-10-16):内联重建的数组每次
  // 渲染都是新标识,弹层开着撞上轮询重渲染(任务同步 1.5s/会话列表
  // 5s)就被 Base UI 收掉——表现是「下拉一闪而过,要点两次」。占位
  // 项恒在(2026-09-24 弹回条款:值不在 items 里会触发空提交清绑定),
  // 渲染侧仍按带出态条件显示。
  const moduleSelectItems = useMemo(() => [
    { value: "__none", label: "未匹配,发起前必选" },
    ...moduleCatalog.map((module) => ({
      value: module.id, label: module.name,
    })),
  ], [moduleCatalog]);

  // 列宽拖拽(2026-09-17 手写;2026-10-14 迁 TanStack Table 引擎):
  // 宽度真相源=引擎内部 columnSizing 状态(非受控,见下方表实例),
  // 拖动中 onChange 模式逐帧同步更新,轮询重渲染写的也是同一份,不
  // 再有直写 DOM 被打断的回弹。这里的 colWidths 只是持久化镜像:引擎
  // 每次变更经 onColumnSizingChange(写边界钳制)落到它,再由 effect
  // 进 localStorage(v2 新键,旧键读盘即清不继承);标题列保持弹性
  // 吃剩余宽(状态缺席=弹性,双击把手摘键即回)。列显隐走引擎
  // columnVisibility,与列设置 popover 的既有按人记忆(colShown)对接。
  const [colWidths, setColWidths] = useState<ColumnSizingState>(
    loadDtsColWidths);
  useEffect(() => {
    try {
      if (Object.keys(colWidths).length > 0) {
        localStorage.setItem(DTS_COL_WIDTHS_KEY, JSON.stringify(colWidths));
      } else {
        localStorage.removeItem(DTS_COL_WIDTHS_KEY);
      }
    } catch { /* 隐私模式等存不了:会话内仍生效 */ }
  }, [colWidths]);

  // 表最小宽的计算挪到表实例之后(列宽真相源=引擎内部状态,见下)。

  // 模糊搜索:单号/标题/版本,大小写不敏感;列头过滤叠加其上。
  const [query, setQuery] = useState("");
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  // 列头包含式过滤(2026-09-13 表头化,单号/标题两枚漏斗;与工具栏
  // 搜索 AND 叠加,只作用于名下列表——远程补查单豁免)。版本过滤的
  // 入口同批迁进「版本」列表头漏斗,行为等价迁移。
  const [ticketFilter, setTicketFilter] = useState("");
  const [titleFilter, setTitleFilter] = useState("");
  // 发起过滤(2026-09-14 拍板):「发起状态」列表头漏斗,默认只看未
  // 发起的单——已发起(名下有进行中会话)的行默认滤掉且勾选禁用。
  // 两项全勾 = 全显 = 无过滤;打开/刷新回默认态,漏斗清空是全显。
  const [showUnlaunched, setShowUnlaunched] = useState(true);
  const [showLaunched, setShowLaunched] = useState(false);
  const launchFilterActive = !showUnlaunched || !showLaunched;
  // 进行中会话按单索引,两本名册各管一摊(口径都是 isLiveIssue 一处):
  // - 我的名册(issues):发起拦截与勾选禁用的唯一依据——同账号+同单号
  //   至多一个进行中(服务端 create 同尺兜底);
  // - 协助视角的名册(teamIssues):只喂徽标与发起过滤,不拦发起——
  //   对方已开了头正是接管的常见时机,分支按发起人隔离不冲突。
  const mineLiveByTicket = useMemo(() => liveIssuesByTicket(issues), [issues]);
  const teamLiveByTicket = useMemo(
    () => liveIssuesByTicket(teamIssues ?? []), [teamIssues]);
  // 徽标与发起过滤看展示口径:自己名下=我的会话;协助视角=全团队。
  const shownLiveByTicket = assistMode ? teamLiveByTicket : mineLiveByTicket;
  // 可发起的单 = 状态为"开发人员实施修改"的;其余状态不展示。
  const actionable = useMemo(() =>
    tickets?.filter(isActionableDts) ?? undefined, [tickets]);
  const fuzzyMatches = useMemo(() => {
    if (!actionable) return undefined;
    const q = query.trim().toLowerCase();
    if (!q) return actionable;
    return actionable.filter((t) =>
      t.ticket.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || (t.version && t.version.toLowerCase().includes(q))
    );
  }, [actionable, query]);

  // 版本过滤(2026-08-29 拍板):按 B 版之前的版本段分组汇总(如
  // V100R025C10SPC010B009 → V100R025C10SPC010),降序去重——B 版构建号
  // 非常多,按完整版本过滤要大量勾选;勾一个组,组内全部 B 版都命中。
  const versions = useMemo(() => {
    const set = new Set<string>();
    actionable?.forEach((t) => {
      if (t.version) set.add(dtsVersionGroup(t.version));
    });
    return sortDtsVersionsDesc([...set]);
  }, [actionable]);

  // 版本组内任一单未命中分支映射即标红(ADR-0038 两道闸不变,列已
  // 退役,信号收进过滤框):映射按前缀包含,组内通常整组一致,取
  // 保守侧——里面有发不了的单就该红。
  const unmappedGroups = useMemo(() => {
    const set = new Set<string>();
    actionable?.forEach((t) => {
      if (t.version && !t.branch) set.add(dtsVersionGroup(t.version));
    });
    return set;
  }, [actionable]);

  // 默认勾选最高 R/C 版本(列表已降序):R/C 相同的多个版本串视为
  // 并列最高,一并勾选;拉到单就先看最新一版,之后勾选/取消全由用户
  // 接管,这里不再插手。
  useEffect(() => {
    if (versions.length === 0) {
      setSelectedVersions([]);
      return;
    }
    const maxKey = dtsVersionKey(versions[0]);
    setSelectedVersions(maxKey
      ? versions.filter((version) => {
          const key = dtsVersionKey(version);
          return Boolean(key) && key![0] === maxKey[0] && key![1] === maxKey[1];
        })
      : [versions[0]]);
  }, [versions]);

  // 列头过滤谓词(单号/标题):包含匹配,大小写不敏感;与工具栏搜索
  // AND 叠加。只作用于名下列表,远程补查单不经这道筛。
  const columnFiltered = useMemo(() => {
    if (!fuzzyMatches) return undefined;
    const byTicket = ticketFilter.trim().toLowerCase();
    const byTitle = titleFilter.trim().toLowerCase();
    if (!byTicket && !byTitle) return fuzzyMatches;
    return fuzzyMatches.filter((t) =>
      (!byTicket || t.ticket.toLowerCase().includes(byTicket))
      && (!byTitle || t.title.toLowerCase().includes(byTitle)));
  }, [fuzzyMatches, ticketFilter, titleFilter]);

  const versionFiltered = useMemo(() => {
    const list = columnFiltered;
    if (!list) return undefined;
    if (selectedVersions.length === 0) return list;
    // 命中口径与汇总同尺:单据版本剥掉 B 段后落在勾选的组里即命中
    // (组内所有 B 版构建号一并带出)。
    return list.filter((t) => t.version
      && selectedVersions.includes(dtsVersionGroup(t.version)));
  }, [columnFiltered, selectedVersions]);

  // 远程查单:本地搜索为空且输入像 DTS 单号(字母开头+数字,长 >=5,
  // 支持逗号分隔多个)时,自动远程查详情并作为结果入列。防抖 500ms +
  // 序号守卫:慢响应回来时若输入已变则丢弃,不与本地搜索抢戏。
  const [remote, setRemote] = useState<{ loading: boolean; tickets: DtsTicketBrief[] }>(
    { loading: false, tickets: [] });
  const remoteSeq = useRef(0);
  const fuzzyEmpty = (fuzzyMatches?.length ?? 0) === 0;

  useEffect(() => {
    const q = query.trim();
    const candidates = dtsNoCandidates(q);
    if (!tickets || !q || candidates.length === 0 || !fuzzyEmpty) {
      setRemote({ loading: false, tickets: [] });
      return;
    }
    const seq = ++remoteSeq.current;
    setRemote({ loading: true, tickets: [] });
    const timer = setTimeout(async () => {
      const results = await Promise.all(candidates.map((no) =>
        getDtsTicketDetail(no)
          .then((detail) => ({ no, detail }) as const)
          .catch(() => undefined)));
      if (remoteSeq.current !== seq) return;
      const found = results.filter((item): item is { no: string; detail: DtsTicketDetail } =>
        Boolean(item));
      setRemote({ loading: false, tickets: found.map(({ no, detail }) => ({
        ticket: detail.ticket || no,
        title: detail.title,
        severity: detail.severity,
        version: detail.version,
        // 远程查单入列也带分支与模块匹配结果(服务端详情同源补齐),
        // 否则绕过列表的单子在两列上全员误报未配置/未匹配。
        branch: detail.branch,
        module_id: detail.module_id,
        url: detail.url,
        description: detail.description,
        // 状态不带入列,可拉取判定(isActionableDts)会把远程命中的单
        // 全部误判为"状态不可拉取"而不展示。
        status: detail.status,
      })) });
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, tickets, fuzzyEmpty]);

  // 列表 = 本地命中(版本过滤后) + 远程补查命中(去重),再过发起
  // 过滤(名下与远程补查单同尺适用)。清空搜索框时远程结果随 effect
  // 复位消失,恢复展示名下全部问题单。远程命中的单也只展示可发起状态;
  // 被状态挡下的汇总一条提示,不让用户以为单号不存在。
  const remoteTickets = remote.tickets;
  const hiddenRemote = remoteTickets.filter((t) => !isActionableDts(t));
  const display = useMemo(() => {
    const list = versionFiltered ?? [];
    const extra = remoteTickets.filter((r) =>
      isActionableDts(r) && !list.some((item) => item.ticket === r.ticket));
    const merged = [...list, ...extra];
    if (!launchFilterActive) return merged;
    return merged.filter((t) => shownLiveByTicket.has(t.ticket)
      ? showLaunched : showUnlaunched);
  }, [versionFiltered, remoteTickets, launchFilterActive, showUnlaunched,
    showLaunched, shownLiveByTicket]);
  // 展示中的单存在未配置分支映射时给提示条(2026-09-24,分支列退役
  // 后信号收拢到过滤框旁):提示跟着「当前看得见的单里有发不了的」
  // 这个事实走,不跟过滤动作走——选「全部」也看得见。
  const displayedUnmapped = useMemo(() => {
    const rows = display.filter((t) => !t.branch);
    const groups = new Set<string>();
    let versionless = false;
    rows.forEach((t) => {
      if (t.version) groups.add(dtsVersionGroup(t.version));
      else versionless = true;
    });
    return { count: rows.length, groups: [...groups], versionless };
  }, [display]);

  // 全选表头(三态):只作用于当前展示列表中**可勾**的行——搜索+版本
  // 过滤划范围,发起过滤里已发起的行、未配置分支的行(ADR-0038,禁
  // 发起)与未匹配业务模块的行(ADR-0056,禁发起)勾选禁用,不在全选
  // 之列。可勾行全中时点击整体取消,部分或全无时一键勾满。已勾选但
  // 被过滤掉的单不在展示列表里,保持原样,发起时照常带上。
  const selectableTickets = display
    .filter((t) => !mineLiveByTicket.has(t.ticket) && !!t.branch
      && !!(bindings[t.ticket]?.module_id ?? t.module_id))
    .map((t) => t.ticket);
  const displayedSelectedCount =
    selectableTickets.filter((no) => selected.includes(no)).length;
  const allDisplayedSelected = selectableTickets.length > 0
    && displayedSelectedCount === selectableTickets.length;
  function toggleSelectAll() {
    if (allDisplayedSelected) {
      const shown = new Set(selectableTickets);
      setSelected((current) => current.filter((no) => !shown.has(no)));
    } else {
      setSelected((current) =>
        [...new Set([...current, ...selectableTickets])]);
    }
  }

  // 表引擎(2026-10-14 迁 TanStack Table):列定义/表头/单元格全部
  // 走 columnDef,行与列显隐由引擎驱动;列宽 sizing 是受控状态(见上),
  // onChange 模式拖动中逐帧落状态。列闭包读 DtsRegister 的各路状态
  // (勾选/名册/备注/绑定/档位),组件重渲即新闭包,无陈旧读问题。
  const columnVisibility: VisibilityState = {
    title: colShown("title"),
    launch: colShown("launch"),
    remark: colShown("remark"),
    module: colShown("module"),
    tier: colShown("tier"),
    autoClaim: colShown("autoClaim"),
  };
  const columns: Array<ColumnDef<DtsTicketBrief, unknown>> = [
    {
      id: "select",
      size: DTS_COL_DEFAULT.select,
      minSize: DTS_COL_MIN.select, maxSize: DTS_COL_MAX.select,
      header: () => (
        // 只放全选框(2026-09-24 排版收拾):「已选 N 张」曾把首列撑到
        // 112px,挪进工具栏计数;勾选列回归纯勾选。
        <Checkbox aria-label="全选展示中的问题单"
          checked={selectableTickets.length > 0 && allDisplayedSelected}
          indeterminate={!allDisplayedSelected
            && displayedSelectedCount > 0}
          onCheckedChange={() => toggleSelectAll()} />
      ),
      cell: ({ row }) => {
        const ticket = row.original;
        const mineLive = mineLiveByTicket.get(ticket.ticket);
        const liveIssue = mineLive
          ?? shownLiveByTicket.get(ticket.ticket);
        const liveTip = liveIssue
          ? (liveIssue.account === viewer.username
            ? `已发起:会话 ${liveIssue.id} 进行中`
            : `已发起:${liveIssue.account} 的会话 ${liveIssue.id} 进行中`)
          : "";
        const resolvedModule =
          bindings[ticket.ticket]?.module_id ?? ticket.module_id;
        return <Checkbox checked={selected.includes(ticket.ticket)}
          disabled={!!mineLive || !ticket.branch || !resolvedModule}
          title={mineLive ? `${liveTip},不可重复发起`
            : !ticket.branch ? "单据版本未配置分支映射,不可发起——见版本过滤旁的红色提示前往配置"
            : !resolvedModule ? "未匹配到业务模块,不可发起——在所属模块列选择后再勾选"
            : undefined}
          aria-label={`选择 ${ticket.ticket}`}
          onCheckedChange={(checked) => setSelected((current) =>
            checked
              ? [...current, ticket.ticket]
              : current.filter((item) => item !== ticket.ticket))} />;
      },
    },
    {
      id: "ticket",
      size: DTS_COL_DEFAULT.ticket,
      minSize: DTS_COL_MIN.ticket, maxSize: DTS_COL_MAX.ticket,
      header: () => (
        <span className="inline-flex items-center gap-1">
          单号
          <HeaderFilter label="单号" active={!!ticketFilter.trim()}
            onClear={() => setTicketFilter("")}>
            {() => <Input autoFocus
              className="h-8 w-full rounded-md px-2 text-sm"
              placeholder="包含单号片段…" aria-label="按单号过滤"
              value={ticketFilter}
              onChange={(event) => setTicketFilter(event.target.value)} />}
          </HeaderFilter>
        </span>
      ),
      cell: ({ row }) => {
        const ticket = row.original;
        const isRemote = remoteTickets.some((item) =>
          item.ticket === ticket.ticket);
        return (
          // 单号独立成格(勾选在首格):拖选复制单号不会误勾选——单号
          // 是绑单/推送分支名的关键操作对象,复制是高频动作。直达 DTS
          // 门户(a { color: inherit } 全局兜底,新开页签不带走列表现场)。
          // overflow-hidden:列宽拖窄后「远程」徽标裁在格内,不横溢进
          // 标题列(table-fixed 格宽即硬宽)。
          <span className="flex min-w-0 items-center gap-1.5">
            <a className="issue-dts-ticket block min-w-0 truncate
              font-mono text-sm font-medium text-primary
              underline-offset-2 hover:underline"
              title={ticket.ticket}
              href={dtsTicketUrl(ticket.ticket)}
              target="_blank" rel="noreferrer">
              {ticket.ticket}
            </a>
            {isRemote && <Badge variant="outline"
              className="shrink-0">远程</Badge>}
          </span>);
      },
    },
    {
      id: "title",
      // 标题列不设默认宽:唯一弹性列,状态缺席(colgroup 不出宽)时
      // 吃掉剩余宽度——拖其他列都从它身上要地方,初览观感不变。
      minSize: DTS_COL_MIN.title, maxSize: DTS_COL_MAX.title,
      header: () => (
        <span className="inline-flex items-center gap-1">
          标题
          <HeaderFilter label="标题" active={!!titleFilter.trim()}
            onClear={() => setTitleFilter("")}>
            {() => <Input autoFocus
              className="h-8 w-full rounded-md px-2 text-sm"
              placeholder="包含标题片段…" aria-label="按标题过滤"
              value={titleFilter}
              onChange={(event) => setTitleFilter(event.target.value)} />}
          </HeaderFilter>
        </span>
      ),
      cell: ({ row }) => (
        <span className="block truncate"
          title={row.original.title || undefined}>
          {row.original.title || "(无标题)"}
        </span>
      ),
    },
    {
      // 发起状态列(2026-09-14):本平台有没有发起过——判定与发起拦截
      // 同尺(liveIssueFor 一处口径),漏斗默认只看未发起;徽标可点,
      // 跳进该单名下的进行中会话。
      id: "launch",
      size: DTS_COL_DEFAULT.launch,
      minSize: DTS_COL_MIN.launch, maxSize: DTS_COL_MAX.launch,
      header: () => (
        <span className="inline-flex items-center gap-1">
          发起状态
          <HeaderFilter label="发起状态" active={launchFilterActive}
            onClear={() => {
              setShowUnlaunched(true);
              setShowLaunched(true);
            }}>
            {() => <div className="flex flex-col">
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5
                rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={showUnlaunched}
                  onCheckedChange={(checked) => setShowUnlaunched(checked)} />
                未发起
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-2.5
                rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <Checkbox checked={showLaunched}
                  onCheckedChange={(checked) => setShowLaunched(checked)} />
                已发起(进行中)
              </label>
            </div>}
          </HeaderFilter>
        </span>
      ),
      cell: ({ row }) => {
        const ticket = row.original;
        const mineLive = mineLiveByTicket.get(ticket.ticket);
        const liveIssue = mineLive
          ?? shownLiveByTicket.get(ticket.ticket);
        const liveTip = liveIssue
          ? (liveIssue.account === viewer.username
            ? `已发起:会话 ${liveIssue.id} 进行中`
            : `已发起:${liveIssue.account} 的会话 ${liveIssue.id} 进行中`)
          : "";
        return liveIssue
          ? <a className="group/live inline-flex h-6 items-center
              rounded-[min(var(--radius-md),10px)] px-2 no-underline
              outline-none transition-colors hover:bg-muted
              focus-visible:ring-3 focus-visible:ring-ring/50"
              href={issueSessionPath(liveIssue.id)}
              target="_blank" rel="noreferrer"
              title={`${liveTip},${mineLive ? "点击打开" : "点击查看"}`}
              aria-label={`${mineLive ? "打开" : "查看"} ${ticket.ticket} 的进行中会话`}>
            <Badge>
              {/* 徽标本体是静态胶囊(2026-09-14 设计审查:悬停底色辨不出
                  可点),内层文字挂链接级下划线语言,与单号链接同款。 */}
              <span className="group-hover/live:underline group-focus-visible/live:underline">进行中</span>
            </Badge>
          </a>
          : <span className="text-muted-foreground"
              aria-label="未发起">—</span>;
      },
    },
    {
      // 附加信息列(原发起备注,2026-09-20;2026-10-15 #502 扩随单附件
      // 并更名):随单文本 + 附件,发起时进登记元信息并要求 AI 重点
      // 优先读——发起人指路的最短通道。
      id: "remark",
      size: DTS_COL_DEFAULT.remark,
      minSize: DTS_COL_MIN.remark, maxSize: DTS_COL_MAX.remark,
      header: () => (
        <span className="inline-flex items-center gap-1" title="发起时随单告知 AI 的文字与附件:AI 开场会重点优先读">
          附加信息
        </span>
      ),
      cell: ({ row }) => {
        const ticketNo = row.original.ticket;
        const fileCount = remarkFiles[ticketNo]?.length ?? 0;
        const preview = remarks[ticketNo];
        return (
          // 预览钮(2026-09-24 弹窗化):空时弱化「点击填写」,已填
          // 显示截断预览(悬停 title 全文),有附件追加 📎N 角标(路径
          // 不上格子,折叠成计数)。点击弹多行弹窗编辑。点击不触发行
          // 选中,勾选仍走首格 checkbox。
          <button type="button"
            className={`h-8 w-full truncate rounded-md border
              px-2 text-left text-xs transition-colors
              ${preview || fileCount
                ? "border-input bg-surface hover:bg-accent/40"
                : "border-dashed border-input bg-transparent text-muted-foreground hover:bg-accent/40"}`}
            title={[preview,
              fileCount ? `📎 ${fileCount} 个附件` : ""]
              .filter(Boolean).join("\n") || undefined}
            aria-label={`${ticketNo} 附加信息${
              preview || fileCount ? "(已填写,点击编辑)" : "(空,点击填写)"}`}
            onClick={() => {
              setRemarkDraft(remarks[ticketNo] ?? "");
              setRemarkEditing(ticketNo);
            }}>
            {preview || "点击填写"}
            {fileCount > 0 && ` 📎${fileCount}`}
          </button>);
      },
    },
    {
      // 所属模块格(ADR-0056):带出值或人工改选,发起必带;未匹配
      // (零命中/重名歧义)必填,勾选闸同尺拦。人工改选即存团队共享
      // 映射,带出值不落账。
      id: "module",
      size: DTS_COL_DEFAULT.module,
      minSize: DTS_COL_MIN.module, maxSize: DTS_COL_MAX.module,
      header: () => "所属模块",
      cell: ({ row }) => {
        const ticket = row.original;
        const boundModule = bindings[ticket.ticket]?.module_id;
        const resolvedModule = boundModule ?? ticket.module_id;
        return <>
          <Select
            value={resolvedModule ?? "__none"}
            disabled={bindingTicket === ticket.ticket}
            // 占位项恒在(2026-09-24):选中模块后乐观更新会改写行的
            // 匹配态,若此时把占位项从清单里动态摘除,Base UI 会在弹层
            // 收起的重渲染中对「当前值不在 items」补一次空提交,把刚选
            // 的绑定清掉——表现就是「选了又弹回未匹配」。判据用服务端
            // 带出值(静态)而非改选态(会翻转)。规则带出行不设占位项:
            // 人工改选是粘性的,想回带出值就像选普通模块一样重选它,
            // 没有「切回自动」的特权入口(自动匹配一词随启发式退役,
            // 见 CONTEXT.md)。items 标识稳定化见 moduleSelectItems
            //(2026-10-16:轮询重渲染收弹层的「一闪而过」)。
            items={moduleSelectItems}
            onValueChange={(value) =>
              void bindModule(ticket.ticket,
                value === "__none" || value == null ? "" : value)}>
            <SelectTrigger
              className={`h-8 w-full text-xs ${resolvedModule
                ? "" : "border-destructive/60 text-destructive"}`}
              aria-label={`${ticket.ticket} 所属业务模块`}
              title={`${moduleCatalog.find((module) =>
                module.id === resolvedModule)?.name
                ?? (resolvedModule ? resolvedModule : "未匹配到业务模块")}`
                + (resolvedModule
                  ? " · 发起时随单带出(可改选,选即存团队共享映射)"
                  : ":从下拉选择,发起前必填")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="tw-root">
              {!ticket.module_id && <SelectItem value="__none">
                未匹配,发起前必选
              </SelectItem>}
              {moduleCatalog.map((module) => (
                <SelectItem key={module.id} value={module.id}>
                  {module.name}
                </SelectItem>))}
            </SelectContent>
          </Select>
          {bindFail?.ticket === ticket.ticket
            && <p className="mt-1 text-xs text-destructive" role="alert">
              {bindFail.message}
            </p>}
        </>;
      },
    },
    {
      // 介入档位列(ADR-0057):发起前按单定档,发起时随请求定格进
      // 会话,发起后不可改;进行中行只读显示生效档;协助视角未发起行
      // 不设(偏好只影响自己的发起)。
      id: "tier",
      size: DTS_COL_DEFAULT.tier,
      minSize: DTS_COL_MIN.tier, maxSize: DTS_COL_MAX.tier,
      header: () => (
        <span className="inline-flex items-center gap-1"
          title="发起前按单选定介入档位:发起后定格,不再跟随个人设置的改动;不选=跟随全局">
          介入档位
        </span>
      ),
      cell: ({ row }) => {
        const ticket = row.original;
        const liveIssue = mineLiveByTicket.get(ticket.ticket)
          ?? shownLiveByTicket.get(ticket.ticket);
        return liveIssue
          ? <span className="block truncate text-xs text-muted-foreground"
              title={liveIssue.intervention_tier
                ? `${TIER_LABEL.get(liveIssue.intervention_tier)}(发起时定格,发起后不可改)`
                : liveIssue.account === viewer.username
                  ? `跟随全局 · 现·${TIER_LABEL.get(viewer.issue_intervention_tier ?? "2")}(随个人设置改动)`
                  : "跟随全局"}>
              {liveIssue.intervention_tier
                ? TIER_LABEL.get(liveIssue.intervention_tier)
                : "跟随全局"}
            </span>
          : assistMode
            ? <span className="text-muted-foreground"
                aria-label="协助视角不设置介入档位">—</span>
            : <Select
                value={tiers[ticket.ticket] ?? TIER_FOLLOW}
                items={TIER_SELECT_ITEMS}
                onValueChange={(value) => {
                  const tier = value === TIER_FOLLOW || value == null
                    ? undefined : value as DtsTierPref;
                  setTiers((current) => {
                    const next = { ...current };
                    if (tier) next[ticket.ticket] = tier;
                    else delete next[ticket.ticket];
                    return next;
                  });
                }}>
                <SelectTrigger className="h-8 w-full text-xs"
                  aria-label={`${ticket.ticket} 介入档位`}
                  title="发起前按单定档:发起后定格,不再跟随个人设置;跟随全局=用个人设置的档">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="tw-root">
                  <SelectItem value={TIER_FOLLOW}>跟随全局</SelectItem>
                  {TIER_OPTIONS.map((tier) => (
                    <SelectItem key={tier.value} value={tier.value}>
                      {tier.label}
                    </SelectItem>))}
                </SelectContent>
              </Select>;
      },
    },
    {
      // 自动接单列(ADR-0070):按单号把这张单挡在定时自动接单之外,
      // 只拦扫描器、人工发起不受影响。默认隐藏(照介入档位列极性),
      // 点名显示后每格两态下拉「允许/排除」,缺省「允许」(行字段
      // 缺席即允许);选即存、失败回滚(照所属模块列)。所有行可改,
      // 不限发起状态与视角——能看见这单就能改,与单号→模块映射同尺。
      id: "autoClaim",
      size: DTS_COL_DEFAULT.autoClaim,
      minSize: DTS_COL_MIN.autoClaim, maxSize: DTS_COL_MAX.autoClaim,
      header: () => (
        <span className="inline-flex items-center gap-1"
          title="把这张单挡在定时自动接单之外:排除=扫描器跳过(人工发起不受影响),允许=照常参与自动接单">
          自动接单
        </span>
      ),
      cell: ({ row }) => {
        const ticket = row.original;
        const excluded = claimExcluded[ticket.ticket]
          ?? ticket.auto_claim_excluded === true;
        return <>
          <Select
            value={excluded ? "exclude" : "allow"}
            items={CLAIM_SELECT_ITEMS}
            disabled={claimTicket === ticket.ticket}
            onValueChange={(value) =>
              void saveClaimExclusion(ticket.ticket, value === "exclude")}>
            <SelectTrigger className="h-8 w-full text-xs"
              aria-label={`${ticket.ticket} 自动接单`}
              title="排除=定时自动接单跳过这张单(选即存,失败回滚);允许=照常参与自动接单">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="tw-root">
              <SelectItem value="allow">允许</SelectItem>
              <SelectItem value="exclude">排除</SelectItem>
            </SelectContent>
          </Select>
          {claimFail?.ticket === ticket.ticket
            && <p className="mt-1 text-xs text-destructive" role="alert">
              {claimFail.message}
            </p>}
        </>;
      },
    },
  ];
  const table = useReactTable({
    data: display,
    columns,
    state: { columnSizing: colWidths, columnVisibility },
    // 列宽受控(必须受控:v8 的 setColumnSizing 只调 onColumnSizing
    // Change 回调,没有内部兜底状态——不回流引擎就永远看不到拖动,
    // 表现为「完全拖不动」)。写边界钳制:引擎的拖动数学只把负值收
    // 到 0,min/max 收口在读侧 getSize();镜像(colWidths)要进
    // localStorage,通知落地前逐列钳进 [DTS_COL_MIN, DTS_COL_MAX]。
    onColumnSizingChange: (updater) =>
      setColWidths((old) => {
        const next = typeof updater === "function" ? updater(old) : updater;
        return Object.fromEntries(Object.entries(next).map(([key, px]) => [
          key,
          Math.min(Math.max(Math.round(px),
            DTS_COL_MIN[key as DtsColKey]),
            DTS_COL_MAX[key as DtsColKey]),
        ]));
      }),
    // onChange:拖动中逐帧落 sizing 状态——状态即唯一真相源,5s 轮询
    // 的重渲染写的也是同一份(手写版直写 DOM 被打断的回弹就此消失)。
    columnResizeMode: "onChange",
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.ticket,
  });

  // 表最小宽(2026-09-24):标题列是唯一弹性列,table-fixed 下它的宽
  // = 表宽 − Σ(定宽列)。定宽合计吃满表宽(列被拖宽/窗口缩窄)时余量
  // 归零,标题列被挤没、列头互相叠字——给表 min-width = Σ可见定宽 +
  // 标题下限,空间不够就横向滚动,标题永远保住最小宽。
  const tableMinWidth = table.getVisibleLeafColumns().reduce((sum, column) => {
    const sized = table.getState().columnSizing[column.id];
    if (column.id === "title") return sum + (sized ?? DTS_COL_MIN.title);
    return sum + column.getSize();
  }, 0);

  async function load(target?: string) {
    // 换人发起的重拉带着新名下进同一函数:target 在场以它为准,绕开
    // setState 后旧闭包读不到新值的时序。
    const account = target ?? owner;
    setLoading(true);
    setNote("");
    setQuery("");
    setSelected([]);
    setSelectedVersions([]);
    setTicketFilter("");
    setTitleFilter("");
    setShowUnlaunched(true);
    setShowLaunched(false);
    try {
      const result = await listDtsTickets(account);
      setTickets(result.tickets);
      setDtsMock(result.mock);
    } catch (reason) {
      setTickets(undefined);
      setNote(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setLoading(false);
    }
    // 协助视角另拉全团队会话判「已发起」;自己名下用父层列表,不多拉。
    if (account !== viewer.username) {
      void listAllIssues().then(setTeamIssues)
        .catch(() => setTeamIssues([]));
    } else {
      setTeamIssues(undefined);
    }
  }

  /** 换视角:清空现场(勾选/搜索/过滤都在 load 里重置)再拉新名下。 */
  function pickOwner(next: string) {
    if (next === owner) return;
    setOwner(next);
    void load(next);
  }

  // 人员候选:全员名单没到就只剩自己可选(选择框退化为摆设不挡用)。
  // admin 不进候选(2026-10-14 拍板):admin 对问题域只读围观(#103),
  // 不发起也不该被挂成责任人——查他的名下只会得到空列表。
  const ownerOptions: UserOption[] = useMemo(() => {
    const rows = (people ?? [{
      username: viewer.username,
      ...(viewer.display_name ? { display_name: viewer.display_name } : {}),
    }]).filter((row) => row.username !== "admin");
    return rows.map(({ username, display_name }) =>
      ({ username, display_name }));
  }, [people, viewer.username, viewer.display_name]);
  const ownerLabel = userLabel(ownerOptions.find((option) =>
    option.username === owner) ?? { username: owner });

  // 首次激活自动拉取:点开「DTS 列表」直接见列表,不再多一次点击;
  // 之后列表靠「刷新」手动更新(面板常驻,换页签不清状态)。绑定映射
  // 与模块目录同一拍加载。
  const autoLoaded = useRef(false);
  useEffect(() => {
    if (!active || autoLoaded.current) return;
    autoLoaded.current = true;
    void load();
    void getDtsModuleBindings().then(setBindings).catch(() => undefined);
    void getBusinessModules()
      .then((catalog) => setModules(catalog.modules))
      .catch(() => setModules([]));
    void listPeople().then(setPeople).catch(() => setPeople(undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  /** 选即存:乐观更新本地映射,PUT 失败回滚并把原因落在那一行。 */
  async function bindModule(ticketNo: string, moduleId: string) {
    const previous = bindings[ticketNo];
    setBindingTicket(ticketNo);
    setBindFail(undefined);
    setBindings((current) => {
      const next = { ...current };
      if (moduleId) {
        next[ticketNo] = {
          module_id: moduleId,
          updated_by: viewer.username,
          updated_at: new Date().toISOString(),
        };
      } else {
        delete next[ticketNo];
      }
      return next;
    });
    try {
      await putDtsModuleBinding(ticketNo, moduleId || null);
    } catch (reason) {
      setBindings((current) => {
        const next = { ...current };
        if (previous) next[ticketNo] = previous;
        else delete next[ticketNo];
        return next;
      });
      setBindFail({
        ticket: ticketNo,
        message: String(reason instanceof Error ? reason.message : reason),
      });
    } finally {
      setBindingTicket("");
    }
  }

  /** 选即存(照所属模块列):乐观更新本地覆盖,改写失败回滚为原值
   *  并把原因落在那一行。排除落条目、允许删条目,幂等;所有行可改,
   *  不限发起状态——已发起的单同样能改(终态会话后防被重新接走的
   *  逃生门)。 */
  async function saveClaimExclusion(ticketNo: string, excluded: boolean) {
    const previous = claimExcluded[ticketNo];
    setClaimTicket(ticketNo);
    setClaimFail(undefined);
    setClaimExcluded((current) => ({ ...current, [ticketNo]: excluded }));
    try {
      await putDtsAutoClaimExclusion(ticketNo, excluded);
    } catch (reason) {
      setClaimExcluded((current) => {
        const next = { ...current };
        if (previous === undefined) delete next[ticketNo];
        else next[ticketNo] = previous;
        return next;
      });
      setClaimFail({
        ticket: ticketNo,
        message: String(reason instanceof Error ? reason.message : reason),
      });
    } finally {
      setClaimTicket("");
    }
  }

  /** 备注弹窗保存:草稿落 remarks(空串=清除该单条目),持久化由
   *  remarks 的 effect 统一写 localStorage;取消/X/点外部不经过这里,
   *  草稿直接丢弃。 */
  function saveRemarkDraft() {
    if (remarkEditing === null) return;
    const ticketNo = remarkEditing;
    const text = remarkDraft;
    setRemarks((current) => {
      const next = { ...current };
      if (text.trim()) next[ticketNo] = text;
      else delete next[ticketNo];
      return next;
    });
    setRemarkEditing(null);
  }

  /** 随单附件上传(#502):弹窗点选/拖入即传暂存,成功进该单列表,
   * 同路径去重;单个失败 onError 提示不拖垮其余。FileList 先收进局部
   * 数组再逐个传——异步循环不能直接踩视图所有物。 */
  async function uploadRemarkFiles(list: FileList | File[]): Promise<void> {
    const ticketNo = remarkEditing;
    if (ticketNo === null) return;
    const files = Array.from(list);
    for (const file of files) {
      try {
        const result = await uploadIssueAttachment(file);
        setRemarkFiles((current) => {
          const existing = current[ticketNo] ?? [];
          if (existing.some((entry) => entry.path === result.path)) {
            return current;
          }
          return {
            ...current,
            [ticketNo]: [...existing, { name: file.name, path: result.path }],
          };
        });
      } catch (reason) {
        onError(`附件上传失败:${
          String(reason instanceof Error ? reason.message : reason)}`);
      }
    }
  }

  /** 批量发起(2026-08-28):每单一个独立工作流;逐张串行 create,
   * 单张失败不拖垮整批。已有进行中会话的单跳过并计入失败(服务端
   * create 的同单查重也会兜一道)。有成功的把新会话交父级:切「问题
   * 会话」子页签挂成功横幅(ADR-0040:不在本页打开工作台,批量更不
   * 开 N 个页签)。payload 带单号、标题与所属模块(ADR-0056:发起
   * 必带,开场即有模块与仓,AI 不再识别模块)。 */
  async function launch() {
    if (!selected.length || busy) return;
    setBusy(true);
    const launched: IssueSummary[] = [];
    const failures: string[] = [];
    try {
      for (const ticketNo of selected) {
        // 查重与发起状态列同尺(liveIssueFor 一处口径):列上没标
        // 「进行中」的单,走到这里也不会被这条拦下。
        const clash = liveIssueFor(issues, ticketNo);
        if (clash) {
          failures.push(`${ticketNo} → 已有进行中的问题会话(${clash.id})`);
          continue;
        }
        // 远程补查的单也能发起:标题从远程详情里取。
        const ticket = tickets?.find((item) => item.ticket === ticketNo)
          ?? remote.tickets.find((item) => item.ticket === ticketNo);
        // 模块发起闸的前端半边(ADR-0056):改选优先于带出,都没有
        // 不发(勾选闸已拦,这里是纵深防御);带出值不落账,发起时
        // 现场解析——与列上所见同源。
        const moduleId = bindings[ticketNo]?.module_id ?? ticket?.module_id;
        if (!moduleId) {
          failures.push(`${ticketNo} → 未匹配到业务模块,发起被拦`);
          continue;
        }
        try {
          // 附加信息随单(#502):文本 + 随单附件路径行。路径行是给
          // 服务端提取附件引用的机器形态(与描述内引用同款正则),
          // 人读语义由「随单附件:」前缀承担。
          const files = remarkFiles[ticketNo] ?? [];
          const remark = [
            remarks[ticketNo]?.trim() ?? "",
            ...(files.length
              ? [`随单附件: ${files.map((file) => file.path).join("、")}`]
              : []),
          ].filter(Boolean).join("\n");
          const created = await createIssue({
            title: ticket?.title || ticketNo,
            source: "dts",
            // 分支不随请求携带(ADR-0038):服务端按单据版本包含匹配
            // 配置中心,未配置直接 400——前端勾选闸只是第一道。
            ticket: ticketNo,
            description: ticket?.title || undefined,
            // 附加信息(原发起备注):文本与附件路径行随单,进登记元
            // 信息(AI 开场重点优先读);全空不带字段。
            ...(remark ? { remark } : {}),
            // 介入档位(ADR-0057):发起前选了档才带,创建即定格,
            // 发起后不可改;没选=跟随全局,不带字段。
            ...(tiers[ticketNo]
              ? { intervention_tier: tiers[ticketNo] } : {}),
            module_id: moduleId,
          });
          launched.push(created);
          // 附加信息已随会话落库,清掉这一单的输入——已消费的指示
          // 不残留(文本与随单附件同清)。
          setRemarks((current) => {
            const next = { ...current };
            delete next[ticketNo];
            return next;
          });
          setRemarkFiles((current) => {
            if (!current[ticketNo]) return current;
            const next = { ...current };
            delete next[ticketNo];
            return next;
          });
          // 介入档位同理:已定格进会话,清掉本地偏好(重新发起走全局)。
          setTiers((current) => {
            if (!current[ticketNo]) return current;
            const next = { ...current };
            delete next[ticketNo];
            return next;
          });
        } catch (reason) {
          failures.push(`${ticketNo} → ${
            String(reason instanceof Error ? reason.message : reason)}`);
        }
      }
    } finally {
      setBusy(false);
    }
    if (launched.length) onLaunched(launched);
    if (failures.length) {
      onError(`成功 ${launched.length} 张${
        launched.length ? `:${launched.map((item) => item.id).join("、")}` : ""};`
        + `失败 ${failures.length} 张:${failures.join(";")}`);
    } else {
      setNote(`成功发起 ${launched.length} 张:${
        launched.map((item) => item.id).join("、")}`
        + (selected.length > 1 ? "(每单一个独立工作流)" : ""));
      setSelected([]);
    }
  }

  /** 发起钮文案与说明一处定义,顶部工具栏单点消费。浮动发起条(2026-09-14
   * 设计审查 03)与顶部钮双入口被判冗余,2026-09-15 退役:发起只留顶部
   * 一枚,未勾选时置灰但常驻——可发现性靠它常在,不靠浮现。 */
  const launchTitle = selected.length > 1
    ? `将逐张发起 ${selected.length} 个独立工作流` : undefined;
  const launchLabel = busy ? "发起中…"
    : selected.length > 1 ? `发起处理(${selected.length} 张)` : "发起处理";

  return <div className="tw-root flex flex-col gap-3 text-base text-foreground">
    {dtsMock && <p className="rounded-md border border-attention/40 bg-attention-soft px-3 py-2 text-sm text-ink" role="note">
      DEV 模拟 DTS:外部开发模式,单据为本地模拟数据(--dts-mock),
      不是真实问题单;流程与真实模式完全一致。
    </p>}
    {/* 工具栏:搜索居左,刷新/主操作居右;筛选住各列表头的漏斗
        (2026-09-13 表头化,与环境管理台账同范式,旧「版本过滤」
        按钮随迁移退役)。 */}
    <div className="flex flex-wrap items-center gap-2">
      {/* 名下视角切换(2026-09-17 协助处理):默认自己,选人看别人名下
          的单;几十人直接搜索(UserPicker 同款 combobox)。发起后的
          会话仍归属自己,提示条在工具栏下说清。 */}
      <div className="w-48">
        <UserPicker value={owner} options={ownerOptions} ariaLabel="查看谁名下的问题单"
          label="责任人" onChange={pickOwner} placeholder="搜索姓名或工号" />
      </div>
      <Input type="search" className="h-9 w-full min-w-40 flex-1 sm:max-w-80" value={query}
        aria-label="搜索问题单"
        placeholder="搜索单号、标题、版本;输入完整单号可远程查单"
        onChange={(e) => setQuery(e.target.value)} />
      {/* 版本过滤(2026-09-24 从版本列表头上移,列随分支列一并退役):
          下拉选择框形态——触发器显示当前选中(全部/单组/N 组),弹层
          复选清单按版本组多选,勾一组带全组 B 版,默认勾选并列最高
          R/C 组(2026-08-29 口径不变);组内任一单未命中分支映射标红
          ——分支闸(禁勾+后端 400)原样,提示条见工具栏下方。 */}
      <Popover>
        <PopoverTrigger render={<button type="button"
          className="inline-flex h-9 w-56 items-center gap-2 rounded-md
            border border-input bg-surface px-3 text-sm outline-none
            transition-colors hover:bg-accent/40 focus-visible:ring-3
            focus-visible:ring-ring/50"
          aria-label="按版本组过滤问题单"
          title="按版本组多选过滤:勾一组带全组 B 版;红色组内有单未配置分支映射">
          <span className="text-muted-foreground">版本</span>
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedVersions.length === 0 ? "全部版本"
              : selectedVersions.length === 1 ? selectedVersions[0]
              : `已选 ${selectedVersions.length} 个版本组`}
          </span>
          <ChevronDown aria-hidden className="size-4 shrink-0
            text-muted-foreground" />
        </button>} />
        <PopoverContent align="start" className="tw-root w-72 p-1">
          {versions.length === 0
            ? <p className="px-2 py-3 text-sm text-muted-foreground">
                名下没有带版本的问题单
              </p>
            : <div className="flex flex-col">
                {versions.map((version) => <label key={version}
                  className="flex min-h-11 cursor-pointer items-center gap-2.5
                    rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                  <Checkbox checked={selectedVersions.includes(version)}
                    onCheckedChange={(checked) => setSelectedVersions((prev) => checked
                      ? [...prev, version]
                      : prev.filter((item) => item !== version))} />
                  <span className={`font-mono text-xs ${unmappedGroups.has(version)
                    ? "text-destructive" : ""}`}>{version}</span>
                  {unmappedGroups.has(version) && <span
                    className="ml-auto text-xs text-destructive">未配置分支</span>}
                </label>)}
              </div>}
          <div className="mt-1 border-t border-line pt-1">
            <button type="button"
              className="w-full rounded-md px-2 py-1 text-left text-sm
                text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setSelectedVersions([])}>
              清除版本筛选(全显)
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {/* 列显示/隐藏(shadcn 惯用法):Data Table 的列选择器形态,
          Popover+Checkbox 承载全部数据列(ADR-0056);勾选与单号常驻
          不进清单,义务不随视图消失。localStorage 按用户记忆。
          工具栏控件统一 h-9 一族(2026-09-24 排版收拾):输入、过滤、
          列设置、动作钮同高同距,左侧过滤簇与右侧动作簇以弹力空隙分
          隔,计数随动作簇右对齐。 */}
      <Popover>
        <PopoverTrigger render={<Button type="button" variant="outline"
          aria-label="列设置"
          title="显示或隐藏数据列(勾选与单号常驻)">
          <Columns3 aria-hidden className="size-4" />列
        </Button>} />
        <PopoverContent align="start" className="w-48 p-1">
          {DTS_HIDEABLE_COLS.map((col) => (
            <label key={col.key} className="flex min-h-9 cursor-pointer
              items-center justify-between gap-2 rounded-md px-2 py-1.5
              text-sm hover:bg-accent">
              {col.label}
              <Checkbox checked={colShown(col.key)}
                onCheckedChange={(checked) =>
                  toggleCol(col.key, checked === true)} />
            </label>
          ))}
          {/* 重置列宽(2026-10-14):列宽是拖出来的屏幕偏好,验证/误拖
              之后逐列双击把手太费劲——一键清空引擎 sizing 状态与持久
              化镜像(标题列回弹性,定宽列回默认)。 */}
          <Button variant="outline" className="mt-1 w-full"
            onClick={() => {
              setColWidths({});
              table.setColumnSizing({});
            }}>
            重置列宽
          </Button>
        </PopoverContent>
      </Popover>
      <div className="grow" />
      {remote.loading
        ? <span className="text-sm text-muted-foreground" role="status">远程查单中…</span>
        : (query || ticketFilter.trim() || titleFilter.trim()
          || selectedVersions.length > 0 || launchFilterActive) && <span
            className="text-sm text-muted-foreground">
          {display.length} / {actionable?.length ?? 0} 条
          {selected.length > 0 && ` · 已选 ${selected.length}`}
        </span>}
      {note && <span className="text-sm text-muted-foreground" role="status">{note}</span>}
      <Button variant="outline" onClick={() => void load()} disabled={loading}
        title={`重新拉取 ${ownerLabel} 名下问题单(勾选与搜索会重置)`}>
        <RotateCw aria-hidden className={`size-4 ${loading ? "animate-spin" : ""}`} />
        {loading ? (tickets === undefined ? "拉取中…" : "刷新中…") : "刷新"}
      </Button>
      <Button disabled={!selected.length || busy}
        title={launchTitle} onClick={launch}>
        {launchLabel}
      </Button>
    </div>
    {assistMode && <p className="rounded-md border border-line bg-muted/40
      px-3 py-2 text-sm leading-normal text-muted-foreground" role="note">
      正在查看 <b className="font-medium text-foreground">{ownerLabel}</b>
      名下的单子。发起处理的会话归属你自己名下推进(分支按发起人隔离,
      不动对方已发起的会话);别人发起过的单标「进行中」,点开是查看模式。
    </p>}
    {tickets === undefined && loading && <p className="text-sm text-muted-foreground">
      正在拉取 {ownerLabel} 名下的问题单…
    </p>}
    {hiddenRemote.length > 0 && <p className="rounded-md border border-line
      bg-muted/40 px-3 py-2 text-sm text-muted-foreground" role="note">
      {hiddenRemote.map((t) => t.ticket).join("、")} 存在,但状态不是
      「{DTS_ACTIONABLE_STATUS}」,不在可拉取范围。
    </p>}
    {displayedUnmapped.count > 0 && <p className="rounded-md
      border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs
      text-destructive" role="note">
      {displayedUnmapped.groups.length
        ? `版本组 ${displayedUnmapped.groups.join("、")} 未配置分支映射,`
        : "部分单据版本未配置分支映射,"}
      相关单据暂不可发起——请先在
      <a className="mx-0.5 font-medium underline underline-offset-2 hover:underline"
        href="/configuration?tab=versions">配置中心「版本与分支」</a>
      补好映射再发起。
    </p>}
    {tickets && tickets.length > 0 && <>
      {/* 列表体:shadcn Table(2026-09-11 迁移,spec #171 评审后拍板——
          旧 div 行布局退役,样式允许变更)。单号独立成格:勾选 checkbox
          在首格,拖选复制单号不会误勾选。子树挂 tw-root 走新轨道。 */}
      {display.length === 0
        ? (remote.loading
          ? <p className="text-sm text-muted-foreground" role="status">远程查单中…</p>
          : <div className="flex flex-col items-center gap-2 rounded-lg border
              border-dashed border-line px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">没有匹配的问题单。</p>
            {/* 清空 = 全显(发起过滤两项全勾),与版本过滤现行行为一致
                ——回到默认态(只看未发起)只发生在打开/刷新。 */}
            <Button variant="outline" size="sm"
              onClick={() => {
                setQuery("");
                setTicketFilter("");
                setTitleFilter("");
                setSelectedVersions([]);
                setShowUnlaunched(true);
                setShowLaunched(true);
              }}>
              清空搜索与筛选</Button>
          </div>)
        : <div className="overflow-x-auto rounded-lg border border-line">
          {/* 列表体:shadcn Table 皮(2026-09-11 迁移)+ TanStack Table
              引擎(2026-10-14 迁移:列定义/列显隐/列宽全走引擎,见上)。
              底盘不变:table-fixed + colgroup,宽度来源=columnSizing
              状态——标题列状态缺席不出宽,吃掉剩余宽;表 min-width =
              Σ可见定宽 + 标题下限,空间不够横向滚动,标题保住最小宽。 */}
          <Table aria-label="名下问题单" className="table-fixed"
            style={{ minWidth: tableMinWidth }}>
            <colgroup>
              {table.getVisibleLeafColumns().map((column) => {
                // 非标题列恒出宽(读引擎 getSize():状态缺席回列默认,
                // 且自带 min/max 钳制);唯一例外=标题列状态缺席不出宽
                // (弹性吃剩余宽)——colgroup 有宽无宽必须与列语义一致,
                // 否则 fixed 布局均摊表宽,点把手种子一列就全表重摊
                // (2026-10-14 迁移首日的「点击跳变/拖不动」即此)。
                const sized = table.getState().columnSizing[column.id];
                if (column.id === "title" && sized === undefined) {
                  return <col key={column.id} />;
                }
                return <col key={column.id} style={{ width: column.getSize() }} />;
              })}
            </colgroup>
            <TableHeader className="bg-surface-2">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id} className="relative">
                      {flexRender(
                        header.column.columnDef.header, header.getContext())}
                      <DtsColResizeHandle header={header}
                        label={DTS_COL_LABEL[header.column.id as DtsColKey]} />
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}
                  data-state={selected.includes(row.original.ticket)
                    ? "selected" : undefined}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}
                      className={DTS_CELL_CLASS[cell.column.id as DtsColKey]
                        ?? ""}>
                      {/* 单元格不走 flexRender 而是直接调 cell 函数
                        (2026-10-16):columns 内联重建让 cell 函数每次
                        渲染都是新标识,flexRender 会把它当组件类型交给
                        React——类型一变整个格子子树重挂,格子里的 Select
                        弹层跟着被收(模块下拉「一闪而过,要点两次」)。
                        直接调用返回的是结构稳定的 JSX(Select 恒是
                        Select),React 按位调和不再重挂;闭包也因此每轮
                        都是新鲜的,无陈旧态风险。表头是纯文本,仍走
                        flexRender 无妨。 */}
                      {typeof cell.column.columnDef.cell === "function"
                        ? cell.column.columnDef.cell(cell.getContext())
                        : cell.column.columnDef.cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>}
    </>}
    {/* 附加信息编辑弹窗(2026-09-24 弹窗化;2026-10-15 #502 扩随单
        附件并更名):多行 Textarea + 附件上传区。文本草稿保存才生效
        (取消/X/点外部丢弃);附件上传即落暂存进列表、可移除,取消不
        清(已是暂存事实)。文本上限 10000 字带计数——直进 AI 开场与
        上下文重建的续聊词;日志等大文件走附件,发起时以路径引用随单。 */}
    <Dialog open={remarkEditing !== null} onOpenChange={(open) => {
      if (!open) setRemarkEditing(null);
    }}>
      <DialogContent className="tw-root sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>附加信息{remarkEditing ? ` · ${remarkEditing}` : ""}</DialogTitle>
          <DialogDescription>开始时 AI 会重点读这段话;日志等附件随单一并交给 AI。</DialogDescription>
        </DialogHeader>
        <Textarea value={remarkDraft} autoFocus
          maxLength={REMARK_MAX}
          aria-label="附加信息内容"
          placeholder="给 AI 的重点提示信息:已排除的方向、已明确的方案、清晰的问题描述等"
          className="h-64 [field-sizing:fixed] text-sm"
          onChange={(event) => setRemarkDraft(event.target.value)} />
        {/* 随单附件(#502):点击选或拖入,多文件,类型不限单个 500MB;
           不做粘贴分路——这里粘贴就是普通文本。 */}
        <label
          className={`flex h-9 shrink-0 cursor-pointer items-center justify-center
            gap-2 rounded-md border border-dashed text-xs text-muted-foreground
            transition-colors hover:bg-accent/40
            ${remarkDragActive ? "border-primary bg-accent/40" : "border-input"}`}
          onDragOver={(event) => {
            event.preventDefault();
            setRemarkDragActive(true);
          }}
          onDragLeave={() => setRemarkDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setRemarkDragActive(false);
            if (event.dataTransfer.files.length) {
              void uploadRemarkFiles(event.dataTransfer.files);
            }
          }}>
          <input type="file" multiple className="hidden"
            aria-label="选择要随单上传的附件"
            onChange={(event) => {
              const selection = event.target.files;
              if (selection?.length) {
                void uploadRemarkFiles(selection);
              }
              // 同名文件改内容重选:清 value 让 onChange 能再触发。
              event.target.value = "";
            }} />
          点击选择或拖入日志等附件(可多选,单个 ≤500MB)
        </label>
        {editingFiles.length > 0 && <ul className="flex flex-col gap-1">
          {editingFiles.map((file) => (
            <li key={file.path}
              className="flex items-center justify-between gap-2 rounded-md
                border border-input bg-surface px-2 py-1 text-xs">
              <span className="truncate" title={file.path}>{file.name}</span>
              <button type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`移除附件 ${file.name}`}
                onClick={() => {
                  if (remarkEditing === null) return;
                  const ticketNo = remarkEditing;
                  setRemarkFiles((current) => {
                    const remaining = (current[ticketNo] ?? [])
                      .filter((entry) => entry.path !== file.path);
                    const next = { ...current };
                    // 清空即删键:不留空数组条目(存了也是垃圾)。
                    if (remaining.length) next[ticketNo] = remaining;
                    else delete next[ticketNo];
                    return next;
                  });
                }}>移除</button>
            </li>
          ))}
        </ul>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {remarkDraft.length} / {REMARK_MAX} 字
            {editingFiles.length > 0 && ` · 📎 ${editingFiles.length}`}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline"
              onClick={() => setRemarkEditing(null)}>取消</Button>
            <Button type="button" onClick={saveRemarkDraft}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    {tickets && tickets.length === 0 && <div className="flex flex-col items-center
      gap-2 rounded-lg border border-dashed border-line px-6 py-12 text-center">
      <p className="text-base font-medium">
        {assistMode ? `${ownerLabel} 名下当前没有问题单` : "你的名下当前没有问题单"}
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        {assistMode
          ? "换回自己或选其他成员查看;发起处理会话归属你自己名下推进。"
          : "有新单落到你名下后,点「刷新」拉取;发起过的单在「问题会话」页签可见。"}
      </p>
    </div>}
    {tickets && tickets.length > 0 && (actionable?.length ?? 0) === 0
      && <div className="flex flex-col items-center gap-2 rounded-lg border
        border-dashed border-line px-6 py-10 text-center">
        <p className="text-sm text-muted-foreground">
          名下问题单里没有「{DTS_ACTIONABLE_STATUS}」状态的——只有该状态可发起,
          其他状态不可拉取。
        </p>
      </div>}
  </div>;
}
