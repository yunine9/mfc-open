/**
 * 终止会话确认框的 UI 契约(票 #541;先例:issueReviveUi.test.ts)。
 *
 * 只断言 web/src 源码里外部可见的结构与交互锚点:工作台与列表卡片两个
 * 终止入口弹同一份 CancelSessionDialog(共享组件,各持开关);原因下拉
 * 五项必选不可跳过、默认「问题已处理」;选「其他原因」展开选填说明;
 * 「返回」无副作用;框内不出现任何指标、考核字眼;确认走既有 control
 * 客户端发 cancel 并携带 reason/reason_text(不复用 revive 的 note)。
 * 不测样式实现细节。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const sessionView = readFileSync(
  resolve("web/src/issues/SessionView.tsx"), "utf-8");
const issueBoard = readFileSync(
  resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
const dialogSource = readFileSync(
  resolve("web/src/issues/CancelSessionDialog.tsx"), "utf-8");
const api = readFileSync(resolve("web/src/api.ts"), "utf-8");

/** 工作台头部控件区(终止/重跑同位的那一段)。 */
function headControls(): string {
  return sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
}

test("两个终止入口弹同一份确认框:工作台与列表卡片都渲染 CancelSessionDialog", () => {
  // 共享组件是唯一实现:两处各自持有开关状态,交互与文案只此一份,
  // 不存在第二套确认框。
  assert.match(dialogSource,
    /export function CancelSessionDialog\(/,
    "共享确认框组件应存在并导出");
  assert.match(sessionView, /<CancelSessionDialog open=\{cancelOpen\}/,
    "工作台头部终止入口应渲染共享确认框");
  assert.match(issueBoard, /<CancelSessionDialog open=\{stopOpen\}/,
    "列表卡片终止入口应渲染同一份共享确认框");
  // 入口仍在原位:工作台头部 onClick={cancelSession}(与异常重跑并排,
  // revive 契约的锚点不破);列表卡片 onClick={terminate}。
  assert.match(headControls(), /onClick=\{cancelSession\}/,
    "工作台头部终止按钮应接 cancelSession(开框,不发请求)");
  assert.match(issueBoard, /onClick=\{\(\) => void terminate\(\)\}/,
    "列表卡片终止按钮应接 terminate(开框,不发请求)");
});

test("原因下拉八项必选:默认「问题已处理」,稳定英文值与界面中文成对", () => {
  // 词表唯一份(#540 复审)在 issues/cancelReasons.ts:八项,排除类在
 // 前,顺序即
  // 下拉顺序(Record 键序),与服务端词表(ISSUE_CANCEL_REASONS)同源
  // 同序;确认框只 import 共享选项,不再自抄一份。
  const cancelReasons = readFileSync(
    resolve("web/src/issues/cancelReasons.ts"), "utf-8");
  const labels = cancelReasons.slice(
    cancelReasons.indexOf("CANCEL_REASON_LABELS"),
    cancelReasons.indexOf("};"));
  assert.deepEqual(
    [...labels.matchAll(/(resolved|accidental|wrong_module|inaccurate|slow|disobedient|unclear_plan|other):/g)]
      .map((match) => match[1]),
    ["resolved", "accidental", "wrong_module", "inaccurate", "slow",
     "disobedient", "unclear_plan", "other"],
    "八个稳定英文值必须齐且按词表顺序");
  for (const label of ["问题已处理", "无需处理", "业务模块绑错", "分析不准确", "速度太慢", "指令不遵从", "方案未明确", "其他原因"]) {
    assert.ok(labels.includes(label), `下拉必须有中文项「${label}」`);
  }
  assert.match(dialogSource,
    /import \{ CANCEL_REASON_OPTIONS, EXCLUSION_LINK_CANCEL_REASONS \} from "\.\/cancelReasons";/,
    "确认框下拉与联动提示词表必须消费共享词表");
  assert.match(dialogSource, /items=\{CANCEL_REASON_OPTIONS\}/);
  // 必选不可跳过:状态初值就是默认档,每次打开重置(没有"不选"的路)。
  assert.match(dialogSource,
    /const \[reason, setReason\] = useState<IssueCancelReason>\("resolved"\)/,
    "原因状态初值必须是默认档 resolved(问题已处理)");
  assert.match(dialogSource, /setReason\("resolved"\)/,
    "每次打开都要重置回默认档,上一次的选择不残留");
});

test("「其他原因」展开选填说明:条件渲染文本框,提交才携带且仅 other 携带", () => {
  assert.match(dialogSource,
    /\{reason === "other" && <Textarea/,
    "选中「其他原因」时才展开说明文本框(条件渲染)");
  assert.match(dialogSource,
    /placeholder="想具体说说吗？（选填）"/,
    "说明文本框要标明选填");
  // 提交:说明 trim 后仅 other 且非空才带 reasonText(条件展开)。
  assert.match(dialogSource, /const text = reasonText\.trim\(\);/,
    "说明提交前要去首尾空白");
  assert.match(dialogSource,
    /\.\.\.\(reason === "other" && text \? \{ reasonText: text \} : \{\}\),/,
    "非 other 或空说明不携带 reasonText");
});

test("终止联动事前提示(ADR-0072):有单+完结类原因+未排除才显示,两入口都传单号与旗标", () => {
  // 联动提示是事前告知不是事后弹窗:确认前用户已知道「将同时把该单
  // 自动接单改为排除」。条件=有单号(ticket)且未已排除
  // (autoClaimExcluded)且选中原因属完结类(词表集合,镜像服务端
  // ISSUE_CANCEL_EXCLUSION_LINK_REASONS);不加勾选框、不做事后二次弹窗
  // (拍板见 ADR-0072 曾考虑段)。
  assert.match(dialogSource,
    /\{ticket && !autoClaimExcluded[\s\S]*?EXCLUSION_LINK_CANCEL_REASONS\.has\(reason\)[\s\S]*?&& <p/,
    "提示行必须三条件齐备才渲染:有单、未排除、完结类原因(词表集合判定)");
  assert.match(dialogSource,
    /终止后将同时把该单的自动接单改为「排除」，见DTS列表自动接单列/,
    "提示文案是拍板原句,指路 DTS 列表自动接单列");
  // 完结类词表镜像:两端各自显式列举,不在条件式里散写字面量。
  const cancelReasons = readFileSync(
    resolve("web/src/issues/cancelReasons.ts"), "utf-8");
  assert.match(cancelReasons,
    /EXCLUSION_LINK_CANCEL_REASONS[^\n]*\n[^\n]*new Set\(\["resolved", "accidental"\]\)/,
    "前端完结类词表要显式列举 resolved/accidental(镜像服务端联动词表)");
  // 两个入口都把单号与已排除旗标传进共享确认框(摘要/详情投影的
  // auto_claim_excluded 稀疏字段,服务端 ADR-0072 富集)。
  assert.match(issueBoard,
    /ticket=\{issue\.ticket\} autoClaimExcluded=\{issue\.auto_claim_excluded\}/,
    "列表卡片入口要传单号与已排除旗标");
  assert.match(sessionView,
    /ticket=\{detail\.ticket\} autoClaimExcluded=\{detail\.auto_claim_excluded\}/,
    "工作台头部入口要传单号与已排除旗标");
  // 镜像:IssueSummary 要有稀疏旗标字段(服务端已排除才在场)。
  const summary = api.slice(api.indexOf("export interface IssueSummary"),
    api.indexOf("export interface IssueWaitingCard"));
  assert.match(summary, /auto_claim_excluded\?: true;/,
    "IssueSummary 镜像要有 auto_claim_excluded 稀疏字段");
});

test("「返回」无副作用:关框不发请求,只有确认才发 cancel", () => {
  // 返回按钮只调 onOpenChange(false);Esc/点背板走 Dialog onOpenChange
  // 同路,也不产生任何写入。
  const footer = dialogSource.slice(dialogSource.indexOf("<DialogFooter>"));
  const backButton = footer.slice(
    footer.indexOf("<Button"), footer.indexOf("</Button>") + 9);
  assert.ok(backButton.includes("返回"), "取消钮文案必须是「返回」");
  assert.match(backButton, /onClick=\{\(\) => onOpenChange\(false\)\}/,
    "返回只能关框,不得触发任何请求");
  // 防重与 sent 闸:busy 全禁,一次打开只发一次。
  assert.match(dialogSource, /const sentRef = useRef\(false\);/,
    "要有 sent 闸防回车与按钮双路重复提交");
  assert.match(dialogSource, /if \(!busy\) onOpenChange\(next\); \}/,
    "发起中不许关确认框再开第二次(busy 闸)");
});

test("框内不出现任何指标、考核字眼", () => {
  // 原因只是人话选择:弹窗文案(标题/说明/选项/按钮/占位)不得漏出
  // 统计口径与考核语义(#540 拍板:指标不挂钩考核,UI 不出现考核语义)。
  // 只扫字符串字面量所在的非注释行——注释里复述纪律不受限。
  const visible = dialogSource.split("\n")
    .filter((line) => !/^\s*(\/\*|\*|\/\/)/.test(line))
    .join("\n");
  for (const banned of ["一次解决", "一次定位", "一次验证", "成功率", "指标", "考核", "统计"]) {
    assert.ok(!visible.includes(banned),
      `确认框界面文案不得出现「${banned}」`);
  }
});

test("确认提交:两入口都走既有 control 客户端发 cancel 并携带原因", () => {
  // 工作台:perform 包裹的既有 controlIssue,action=cancel + reason,
  // 说明经 reason_text 独立字段(不复用 revive 的 note,ADR-0055 不动)。
  assert.match(sessionView,
    /void perform\(\(\) => controlIssue\(detail\.id, \{\s*\n\s*action: "cancel",\s*\n\s*reason: input\.reason,/,
    "工作台确认必须走 perform 包裹的 controlIssue 发 cancel 并带 reason");
  assert.match(sessionView,
    /\.\.\.\(input\.reasonText \? \{ reason_text: input\.reasonText \} : \{\}\),/,
    "工作台说明走独立的 reason_text 字段(选填,条件携带)");
  // 列表卡片:同样的请求形状(await 直调 + 既有 stopError 通道)。
  assert.match(issueBoard,
    /await controlIssue\(issue\.id, \{\s*\n\s*action: "cancel",\s*\n\s*reason: input\.reason,/,
    "列表卡片确认必须走 controlIssue 发 cancel 并带 reason");
  assert.match(issueBoard,
    /\.\.\.\(input\.reasonText \? \{ reason_text: input\.reasonText \} : \{\}\),/,
    "列表卡片说明走独立的 reason_text 字段(选填,条件携带)");
  // 两入口都不得再给 cancel 递 note(note 是 revive 专用,ADR-0055)。
  for (const [name, source] of [["工作台", sessionView], ["列表", issueBoard]] as const) {
    const cancelCall = source.slice(
      source.indexOf('action: "cancel",'),
      source.indexOf('action: "cancel",') + 200);
    assert.ok(!/note:/.test(cancelCall),
      `${name}的 cancel 请求不得携带 note 字段`);
  }
});

test("回车即按当前选中项确认:焦点初落确认钮,文本框与下拉触发钮不劫", () => {
  assert.match(dialogSource, /initialFocus=\{confirmRef\}/,
    "打开时焦点初落确认钮:回车即按默认档(问题已处理)确认");
  assert.match(dialogSource, /target\.tagName === "TEXTAREA"/,
    "说明文本框里回车是换行,不触发确认");
  assert.match(dialogSource, /target\.closest\('\[data-slot="select-trigger"\]'\)/,
    "下拉触发钮上回车是展开选项,不触发确认");
});

test("api 客户端:control 请求侧有 reason 与 reason_text,镜像有终止原因字段", () => {
  const control = api.slice(api.indexOf("export function controlIssue"),
    api.indexOf("issueFetch(`/issues/", api.indexOf("export function controlIssue")));
  assert.match(control, /reason\?: IssueCancelReason;/,
    "请求侧要有可选 reason 字段(终止原因枚举)");
  assert.match(control, /reason_text\?: string;/,
    "请求侧要有可选 reason_text 字段(说明,仅 other 有意义)");
  // IssueSummary 镜像:服务端投影带 cancel_reason/cancel_reason_text,
  // 契约对账(issueFlowContract)要求镜像有同名字段。
  const summary = api.slice(api.indexOf("export interface IssueSummary"),
    api.indexOf("export interface IssueWaitingCard"));
  assert.match(summary, /cancel_reason\?: IssueCancelReason;/,
    "IssueSummary 镜像要有 cancel_reason 字段");
  assert.match(summary, /cancel_reason_text\?: string;/,
    "IssueSummary 镜像要有 cancel_reason_text 字段");
  assert.match(api,
    /export type IssueCancelReason =[\s\S]*?"resolved"[\s\S]*?"accidental"[\s\S]*?"wrong_module"[\s\S]*?"inaccurate"[\s\S]*?"slow"[\s\S]*?"disobedient"[\s\S]*?"unclear_plan"[\s\S]*?"other";/,
    "终止原因枚举类型要在 api.ts 导出(协议词表)");
});
