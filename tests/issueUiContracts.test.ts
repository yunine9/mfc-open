import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const registration = readFileSync(
  resolve("web/src/issues/Registration.tsx"), "utf-8");
const descriptionEditor = readFileSync(
  resolve("web/src/issues/DescriptionEditor.tsx"), "utf-8");
const imagePaste = readFileSync(
  resolve("web/src/issues/useIssueImagePaste.ts"), "utf-8");
const richTextEditor = readFileSync(
  resolve("web/src/issues/RichTextEditor.tsx"), "utf-8");
const editorChoice = readFileSync(
  resolve("web/src/issues/descriptionEditorChoice.ts"), "utf-8");
const issueRoutes = readFileSync(
  resolve("src/issueFlow/routes.ts"), "utf-8");
const notice = readFileSync(
  resolve("web/src/RepositoryResourceNotice.tsx"), "utf-8");
const editor = readFileSync(
  resolve("web/src/EnvironmentEditorDialog.tsx"), "utf-8");
const environmentPicker = readFileSync(
  resolve("web/src/EnvironmentPicker.tsx"), "utf-8");
const decisions = readFileSync(
  resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
const annotations = readFileSync(
  resolve("web/src/AnnotationPanel.tsx"), "utf-8");
const launch = readFileSync(
  resolve("web/src/LaunchWorkspace.tsx"), "utf-8");
const issueFlowDoc = resolve("docs/issue-flow.md");
const issueFlow = existsSync(issueFlowDoc) ? readFileSync(issueFlowDoc, "utf-8") : "";
const environmentVault = readFileSync(resolve("src/issueEnvironment.ts"), "utf-8");
const issueService = readFileSync(resolve("src/issueFlow/service.ts"), "utf-8");
const issuePrompt = readFileSync(resolve("src/issueFlow/prompt.ts"), "utf-8");
const issueTools = readFileSync(resolve("src/issueFlow/tools.ts"), "utf-8");
const appSource = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const issueBoard = readFileSync(
  resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
const materials = readFileSync(
  resolve("web/src/issues/MaterialsPane.tsx"), "utf-8");
// #233 改锚:手写样式收敛为唯一 tailwind.css,原 web/src/style.css 已退役
// (存量:本文件曾仍指向旧路径,整文件在模块载入即 ENOENT 全红)。
const css = readFileSync(resolve("web/src/tailwind.css"), "utf-8");

test("混合问题卡必须逐题完整作答", () => {
  // 手动输入选项:选了它后要求填了自定义文本才算答完(不再强制选给定选项)。
  assert.match(decisions,
    /return questions\.length > 0 && questions\.every\(\(item, index\) => \{/);
  assert.match(decisions,
    /if \(pick === MANUAL_CODE\) return !!custom\[index\]\?\.trim\(\)/);
  assert.match(decisions,
    /const ready = areIssueQuestionsComplete\(questions, picked, custom\)/);
  assert.doesNotMatch(decisions, /optionsAllPicked\s*\|\|\s*freeAnswered/);
});

test("B1验收3：保留的知识全文链接只接管普通点击，保留浏览器修饰键行为", () => {
  assert.match(launch,
    /return !\(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\)/);
  assert.equal((launch.match(/if \(!isPlainKnowledgeActivation\(event\)\) return;/g)
    ?? []).length, 3, "完整清单、业务知识和 Skill 快捷入口都必须保留修饰键");
});

test("手工登记区分目录失败与空目录，并提供重试和真实必填口径", () => {
  assert.match(registration, /setModuleLoadError\(cause instanceof Error/);
  assert.match(registration, /业务模块加载失败:\{moduleLoadError\}/);
  assert.match(registration, /重试加载/);
  assert.doesNotMatch(registration,
    /\.catch\(\(\) => \{ if \(alive\) setModules\(\[\]\); \}\)/);
  // 环境侧(2026-09-10 走查裁定「只选不手填」;#230 改锚):页面凭据
  // 整体废弃,登记页不再有页面账号/页面密码采集面,未选台账条目就在
  // 提交时给指路文案。
  assert.match(registration, /请从环境管理选择网管环境/);
  assert.doesNotMatch(registration, /页面账号 <i|页面密码 <i|envPageAccount/);
  assert.match(registration, /配置中心 → 模块与代码仓/);
  // 模块带仓不占版面(2026-08-31 拍板):常驻仓清单移除,选中后悬停
  // 弹悬浮卡列出将拉取的仓(键盘聚焦同样弹出);要增删仓去团队资产。
  assert.doesNotMatch(registration, /将拉取的代码仓/);
  assert.match(registration, /issue-module-wrap/);
  assert.match(registration, /已带出 \{selectedModule\.repositories\.length\} 个代码仓,悬停查看/);
  assert.match(registration, /issue-module-tip[^>]*role="tooltip"/);
  // #230 改锚:悬浮卡的悬停/键盘聚焦弹出由 group 变体直译(旧
  // .issue-module-wrap:hover/:focus-within 规则随家族退役)。
  assert.match(registration,
    /issue-module-tip[^"]*group-hover\/mod:grid group-focus-within\/mod:grid/);
});

test("登记表单窄屏单列,旧口令菜单不得回流(#230 改锚)", () => {
  // 页面凭据(口令选择器)随「只选不手填」整体废弃:键盘纪律归
  // base-ui Select/Popover 原语,页面不再自带键盘表;旧 .issue-password-menu
  // 与 680px 静态规则随 #230 迁移退役,窄屏单列由 max-[680px] 变体直译。
  assert.doesNotMatch(registration, /issue-password-menu/);
  assert.doesNotMatch(css, /^\s*\.issue-password-menu/m);
  assert.match(registration,
    /className="grid grid-cols-2 gap-3 max-\[680px\]:grid-cols-1"/);
  assert.match(registration, /max-\[680px\]:grid-cols-1/);
});

test("环境选择器可用键盘操作，清单在自身视口滚动", () => {
  // 方向键/Home/End/Enter 由 Command(cmdk) 统一接管，Esc 由 Popover
  // 收口；业务组件不重复实现一套容易漂移的 roving focus。
  assert.match(environmentPicker, /<Popover open=\{open\} onOpenChange=\{toggleOpen\}>/);
  assert.match(environmentPicker, /<Command shouldFilter=\{false\}/);
  assert.match(environmentPicker, /<CommandInput[\s\S]*?<CommandList className="max-h-60"/);
  assert.match(environmentPicker, /<CommandItem[\s\S]*?onSelect=\{\(\) => pick\(entry\)\}/);
  assert.match(readFileSync(resolve("web/src/components/ui/command.tsx"), "utf-8"),
    /CommandPrimitive\.List[\s\S]*overflow-y-auto/,
    "环境清单应在 CommandList 自己的视口滚动");
  assert.match(environmentPicker, /PopoverContent align="start"/);
});

test("DTS 列表:行尾展开详情与列头版本漏斗退役,版本过滤住工具栏(ADR-0056)", () => {
  // shadcn 表格化(2026-09-11)后:勾选 Checkbox 独占首格。行尾展开
  // 详情整体退役(ADR-0056):单号直达 DTS 门户已是详情出口,展开钮、
  // detailId 折叠面与 size-9 触控钮一并退役,不得回流。
  assert.doesNotMatch(registration, /<label className="issue-dts-row-main">/,
    "旧勾选 label 行应已退役(勾选改 Checkbox 独立格)");
  assert.doesNotMatch(registration, /aria-controls=\{detailId\}|isExpanded\b/,
    "行尾展开详情已退役(单号直达 DTS 门户)");
  // 版本过滤住工具栏下拉(2026-09-24 从版本列表头迁出,版本/分支列
  // 随 ADR-0038 修订一并退役):多选版本组 + 清除入口;单号/标题漏斗
  // 照旧住列头。
  assert.doesNotMatch(registration, /<HeaderFilter label="版本"/,
    "版本列头漏斗已退役(过滤迁工具栏下拉)");
  assert.match(registration, /aria-label="按版本组过滤问题单"/);
  assert.match(registration, /清除版本筛选\(全显\)/);
  assert.match(registration, /<HeaderFilter label="单号" active=\{!!ticketFilter\.trim\(\)\}/);
  assert.match(registration, /<HeaderFilter label="标题" active=\{!!titleFilter\.trim\(\)\}/);
  assert.match(registration, /aria-label="按单号过滤"/);
  assert.match(registration, /aria-label="按标题过滤"/);
  // 44px 触控目标由漏斗选项行 min-h-11 保留在组件上,不再依赖页面 css。
  assert.match(registration, /min-h-11 cursor-pointer items-center gap-2\.5/);
  assert.doesNotMatch(registration, /issue-dts-version-menu|issue-dts-version-trigger/);
  assert.doesNotMatch(registration, /"版本过滤"/, "工具栏旧版本过滤按钮应已退役");
});

test("DTS 发起状态列:判定与拦截同尺单源,默认只看未发起(2026-09-14)", () => {
  // 判定唯一口径 liveIssueFor:「已发起」= 同单号 + 名下会话非终态。
  // 终态三元组在登记页只许住在这一处——发起查重、状态列、勾选禁用、
  // 默认过滤全走它,结构性保证"列上标已发起 ⇔ 此刻发起会被拦"。
  assert.match(registration,
    /function liveIssueFor\(issues: IssueSummary\[\], ticketNo: string\)/);
  assert.match(registration,
    /!\["archived", "canceled", "failed"\]\.includes\(item\.status\)/);
  assert.equal(
    (registration.match(/"archived", "canceled", "failed"/g) ?? []).length, 1,
    "终态三元组只许住在 liveIssueFor 一处(第二处即同尺漂移)");
  assert.match(registration, /const clash = liveIssueFor\(issues, ticketNo\)/,
    "发起前查重必须走同一口径函数");
  // 列头漏斗:默认只勾「未发起」;两项全勾(或漏斗清空)才是全显,
  // 计数条随发起过滤生效亮出 N/M。
  assert.match(registration,
    /<HeaderFilter label="发起状态" active=\{launchFilterActive\}/);
  assert.match(registration,
    /const \[showUnlaunched, setShowUnlaunched\] = useState\(true\)/);
  assert.match(registration,
    /const \[showLaunched, setShowLaunched\] = useState\(false\)/);
  assert.match(registration, /已发起\(进行中\)/);
  assert.match(registration,
    /selectedVersions\.length > 0 \|\| launchFilterActive/);
  // 已发起的行:我名下的勾选禁用(悬停说明);未配置分支(ADR-0038)
  // 与未匹配模块(ADR-0056)的行同样禁——发起三闸的前端一侧。徽标是
  // 新页签链接(ADR-0040),直接开该单名下的进行中会话;全选只作用于
  // 可勾行。刷新回默认态(打开/刷新 = 只看未发起)。
  assert.match(registration,
    /disabled=\{!!mineLive \|\| !ticket\.branch \|\| !resolvedModule\}/);
  assert.match(registration,
    /href=\{issueSessionPath\(liveIssue\.id\)\}\s*\n?\s*target="_blank" rel="noreferrer"/);
  assert.match(registration,
    /const selectableTickets = display\s*\n\s*\.filter\(\(t\) => !mineLiveByTicket\.has\(t\.ticket\) && !!t\.branch/,
    "可勾行 = 未发起 + 有分支 + 有模块,与勾选禁用同尺");
  assert.match(registration,
    /setShowUnlaunched\(true\);\s*\n\s*setShowLaunched\(false\);/);
  // 判定索引化:进行中会话按单建一份 Map,过滤/全选/逐行同吃;裸
  // button 不许回流(徽标是等价复刻 ghost/xs 盒感的锚点,ADR-0040
  // 新页签链接,不再是按钮)。
  assert.match(registration, /function isLiveIssue\(/);
  assert.match(registration, /const mineLiveByTicket = useMemo/);
  assert.doesNotMatch(registration, /hover:opacity-75/);
  assert.match(registration,
    /className="group\/live inline-flex h-6 items-center[\s\S]{0,400}title=\{`\$\{liveTip\},\$\{mineLive \? "点击打开" : "点击查看"\}`\}/);
  // 协助处理(2026-09-17):名下视角可切换——默认自己,?owner= 指名
  // 看别人名下;发起后归属仍是登录人。徽标/过滤认展示名册(协助视角
  // =全团队,?scope=all 读侧同尺开放),拦截仍只认我的名册(接管正是
  // 协助的用法,分支按发起人隔离)。
  assert.match(registration,
    /const \[owner, setOwner\] = useState\(viewer\.username\)/);
  assert.match(registration, /const assistMode = owner !== viewer\.username/);
  assert.match(registration, /ariaLabel="查看谁名下的问题单"/);
  assert.match(registration, /listDtsTickets\(account\)/,
    "拉单必须带当前视角的名下账号(?owner= 透传)");
  assert.match(registration,
    /const shownLiveByTicket = assistMode \? teamLiveByTicket : mineLiveByTicket/);
  // IssueBoard 贯通(ADR-0040):登记成功两路回调——手工登记只刷列表
  // (成功横幅里给「打开问题会话」链接),DTS 发起刷列表、切「问题会话」
  // 子页签并挂新会话横幅;onOpenIssue 深链机制不再服务徽标/点卡(卡片
  // 即链接)。
  assert.match(issueBoard,
    /<IssueRegistration[\s\S]{0,600}onRegistered=\{refreshList\}/);
  assert.match(issueBoard, /onChildTabChange\?\.\("sessions"\)/);
});

test("问题卡单选组支持读屏分组和方向键 roving focus", () => {
  assert.match(decisions, /role="radiogroup"/);
  assert.match(decisions, /role="radio"[\s\S]*aria-checked=\{chosen\}/);
  assert.match(decisions,
    /tabIndex=\{chosen \|\| \(!picked\[index\] && optionIndex === 0\) \? 0 : -1\}/);
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
    assert.ok(decisions.includes(`\"${key}\"`), `缺少 ${key} 单选导航`);
  }
  assert.match(decisions, /radioRefs\.current\[questionIndex\]\?\.\[next\]\?\.focus\(\)/);
  assert.match(decisions,
    /const choices = \[\.\.\.options\.map\(\(option\) => option\.code\), MANUAL_CODE\]/,
    "自定义答复也必须能通过方向键到达");
  assert.match(decisions,
    /moveRadio\(index, manualIndex, event\.key\)/,
    "焦点到达自定义答复后也必须能继续用方向键离开");
});

test("问题决策卡的给定选项和自定义答复都能再次点击取消", () => {
  assert.match(decisions,
    /toggleDecisionChoice\(current, index, option\.code\)/);
  assert.match(decisions,
    /toggleDecisionChoice\(current, index, MANUAL_CODE\)/);
  assert.match(decisions, /自定义答复/);
});

test("隐私说明如实覆盖 AI 上下文，管理员旁路有明确入口", () => {
  // #230 改锚:页面凭据废弃(2026-09-10)后,登记页不再有密码明文的
  // 采集面——隐私承诺由「台账已存密码、页面无需填写」的快照说明承载,
  // 契约全文在 docs/issue-flow.md(由下方 issueFlow 断言钉住)。
  assert.doesNotMatch(registration, /page_password|页面密码/);
  assert.match(registration, /的已存密码[\s\S]{0,80}无需在此填写/);
  // 闸卡(2026-09-10 只选不手填)不再有密码输入面:以"台账快照、凭据
  // 无需在此填写"的说明替代;密码的唯一输入处是共用新建/编辑弹框。
  assert.match(decisions, /密码以选定时为准[\s\S]*密码无需在此填写/);
  assert.match(editor, /密码加密保存在服务端[\s\S]*明文提供给当前 AI 会话/);
  if (issueFlow) {
    assert.match(issueFlow, /网管环境口令的契约[\s\S]*AI 上下文[\s\S]*事件流/);
    assert.doesNotMatch(issueFlow, /网管环境密码[\s\S]{0,120}不进模型上下文/);
  }
  // 管理员旁路的开关由服务端下发(feedbackPolicy 唯一判定处),页面按
  // 结论开按钮;入口本身仍必须在面板上明确存在。(#230 改锚:旁路已
  // 统一成两段式「管理员代办」流程,代删口并入同一入口。)
  assert.match(annotations, /closureOf\(item\)\.can_override_drop/);
  assert.match(annotations, /closure\.can_override_verify/);
  assert.match(annotations, /管理员代办/);
  assert.match(annotations, /管理员代确认/);
  assert.match(annotations, /完整内容见“执行现场”/);
});

test("环境保险箱注释与真实 AI 口令契约一致", () => {
  assert.match(environmentVault, /解密到当前问题的 AI 上下文/);
  assert.match(environmentVault, /列表\/状态\/事件只给引用/);
  assert.doesNotMatch(environmentVault, /不(?:进|进入).*Agent 上下文/);
  assert.match(issueService,
    /environmentCredentials 会按 ADR-0003 解密到当前问题的 AI 上下文/);
  assert.match(issueService, /issue\.json\/公开 API\/事件只有引用/);
  assert.doesNotMatch(issueService, /提示词永远只有引用|无消费方,为页面自动化/);
});


test("决策卡壳:决策背景块与 AI 推荐徽标(闸种无关的渲染契约)", () => {
  // #231 改锚:决策背景壳换 DecisionContext 工具类组件(家族 CSS 退役)。
  assert.match(decisions, /<DecisionContext label=\{contextLabel\}/);
  assert.match(decisions,
    /suggested && <Badge variant="warning" className="ml-1\.5 align-middle">AI 推荐<\/Badge>/);
  // 推送过目闸已整体退役(2026-09-17,ADR-0009 增补):前端闸种镜像
  // 不再认 push_confirm——再出现就是镜像回潮。
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.doesNotMatch(apiTypes, /\|\s*"push_confirm"/,
    "web/src/api.ts 的 IssueGateKind 不应再有 push_confirm");
});

test("流水线红灯人工闸(pipeline_unfixable/pipeline_evidence):卡面、作答协议与查看模式收闸", () => {
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const stageRegistry = readFileSync(
    resolve("src/issueFlow/stageRegistry.ts"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const facts = readFileSync(
    resolve("web/src/issues/IssueWaitingFacts.tsx"), "utf-8");
  // 前端闸种镜像:两种新闸都要进 IssueGateKind,pipeline 定位字段随卡
  // 上线(镜像不同步=契约对账当场红的同一教训)。
  assert.match(apiTypes, /\|\s*"pipeline_unfixable"/,
    "web/src/api.ts 的 IssueGateKind 缺 pipeline_unfixable 镜像");
  assert.match(apiTypes, /\|\s*"pipeline_evidence"/,
    "web/src/api.ts 的 IssueGateKind 缺 pipeline_evidence 镜像");
  assert.match(apiTypes, /pipeline\?: \{ repo: string; sha: string \}/);
  assert.match(apiTypes, /gate_pipeline\?: \{ repo: string; sha: string \}/);
  // 码表:服务端注册表的作答码(release=重新监看 / supply=回灌原文),
  // 两卡都无推荐码(人工事实,月光永不代答的同一理由)。
  assert.match(stageRegistry,
    /pipeline_unfixable:\s*\{[\s\S]*?code:\s*"resume",\s*label:\s*"已在平台处理\/豁免,重新监看"/);
  assert.match(stageRegistry,
    /pipeline_evidence:\s*\{[\s\S]*?code:\s*"supply",\s*label:\s*"已粘贴报错原文,继续修复"/);
  // 月光守卫落在月光判定之前(任何介入档位都只等真人)。
  assert.match(issueService,
    /if \(gate\.kind === "skill_select"\) return;[\s\S]*?if \(gate\.kind === "pipeline_unfixable"\) return;[\s\S]*?if \(gate\.kind === "pipeline_evidence"\) return;/);
  // 决策卡:两种新闸各有一条卡面分支(共用 PipelineGateCard 组件),
  // 证据卡是自由文本主通道(空文本不可提交),作答提交按码走协议。
  assert.match(decisions, /gate_kind === "pipeline_unfixable"/);
  assert.match(decisions, /gate_kind === "pipeline_evidence"/);
  assert.match(decisions, /evidence \? "supply" : "resume"/);
  assert.match(decisions, /const ready = evidence \? !!text\.trim\(\) : true;/);
  assert.match(decisions, /报错原文粘贴到这里/);
  // 会话视图:闸的 pipeline 定位随卡下传(卡面陈列仓与提交)。
  assert.match(sessionView, /gate_pipeline: detail\.gate\.pipeline/);
  // 查看模式:作答卡只在归属分支,新闸与所有等待卡走同一个
  // canOperate 分派(事实卡照看题面,零作答控件)——既有收闸语义
  // 对新闸天然成立,这里钉住分派没被绕开(#127 起分派在会话视图的
  // currentCard 组装处)。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 事实卡按闸种点名"等归属人做什么"(不可修=平台处理,证据=贴回原文)。
  assert.match(facts, /等归属人在交付平台处理\/豁免流水线告警/);
  assert.match(facts, /等归属人贴回流水线报错原文/);
});

test("页内确认弹框:共享 confirmDialog 取代原生框,键盘与危险档纪律在位", () => {
  const confirmDialog = readFileSync(
    resolve("web/src/ConfirmDialog.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const cancelDialog = readFileSync(
    resolve("web/src/issues/CancelSessionDialog.tsx"), "utf-8");
  const materialsPane = readFileSync(
    resolve("web/src/issues/MaterialsPane.tsx"), "utf-8");
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  // 组件本体:promise 单例宿主 + FIFO 排队 + 无障碍 + 键盘纪律。
  assert.match(confirmDialog, /export function confirmDialog\(/);
  assert.match(confirmDialog, /export function ConfirmDialogHost\(\)/);
  // 视觉壳与键盘纪律(#219 收尾)走 shadcn AlertDialog(base-ui 原语):
  // role=alertdialog/aria-modal/aria-labelledby、Esc=取消、Tab 困笼、
  // 点背板=取消、关闭归还焦点全由原语接管;页面只留 promise 单例、
  // FIFO 队列、危险档焦点落位与取消汇流(onOpenChange(false))。
  assert.match(confirmDialog,
    /<AlertDialog open=\{current != null\}\s*\n\s*onOpenChange=\{\(open\) => \{ if \(!open\) settle\(false\); \}\}>/);
  assert.match(confirmDialog, /queue\[0\]/, "FIFO 排队:同一时刻只渲染队首");
  assert.match(confirmDialog, /options\.danger \? cancelRef : confirmRef/,
    "危险档默认焦点落「取消」,普通档落「确认」");
  assert.match(confirmDialog,
    /initialFocus=\{current\.options\.danger \? cancelRef : confirmRef\}/,
    "首卡打开由 initialFocus 落位危险档口径");
  // 问题流接入:终止会话确认框(#541)改走下拉式 CancelSessionDialog
  // (原因五选一必选,confirmDialog 没有选择位),SessionView 不再经
  // 共享 confirmDialog 发取消;原生框清零纪律照旧。
  for (const [name, source] of [["SessionView", sessionView],
    ["MaterialsPane", materialsPane]] as const) {
    assert.doesNotMatch(source, /window\.confirm\(/,
      `${name} 不得再用浏览器原生确认框`);
  }
  assert.match(sessionView,
    /import \{ CancelSessionDialog, type CancelSessionInput \} from "\.\/CancelSessionDialog"/,
    "终止确认框必须走下拉式共享组件(#541)");
  assert.match(sessionView, /<CancelSessionDialog open=\{cancelOpen\}/,
    "终止入口要渲染下拉式确认框");
  assert.match(cancelDialog, /variant="destructive"\s+ref=\{confirmRef\}/,
    "确认框的终止钮必须是 destructive 危险档(红色 affordance 不丢)");
  assert.doesNotMatch(materialsPane, /条检视意见并重跑分析|disabled=\{busy \|\| !reviewEnabled \|\| detail.status === "running"\}/);
  // 宿主挂在 App 根部;App 自己的月光调用点允许暂时保留原生框
  // (T3 换双语义按钮),故这里只查宿主不查 App 的 confirm。
  assert.match(app,
    /import \{[^}]*ConfirmDialogHost[^}]*\} from "\.\/ConfirmDialog"/);
  assert.match(app, /<ConfirmDialogHost \/>/);
});

test("月光档位切换二选一:双语义按钮替换确定/取消绕口令", () => {
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  assert.doesNotMatch(app, /window\.confirm\(/,
    "月光切换不得再借原生框的确定/取消表达业务二选一");
  assert.doesNotMatch(app, /选择“确定”|选择“取消”/);
  assert.match(app, /title: "切换到「月光」档"/);
  assert.match(app, /cancelLabel: "仅对后续节点生效"/);
  assert.match(app, /confirmLabel: "连当前待办一起处理"/);
  // 两条分支的布尔语义不变:前者=includeCurrent,后者=仅后续。
  assert.match(app,
    /includeCurrent = await confirmDialog\(\{[\s\S]*?confirmLabel: "连当前待办一起处理"/);
  // 预览数字(可自动处理/检视拦截)必须完整出现在卡上。
  assert.match(app, /\{preview\.eligible\}/);
  assert.match(app, /\{preview\.blocked_annotations\}/);
});

test("全站 window.confirm 清零:原生确认框一律走共享 confirmDialog", () => {
  const files = readdirSync(resolve("web/src"), { recursive: true })
    .map(String).filter((file) => /\.(tsx|ts)$/.test(file));
  assert.ok(files.length > 20, "web/src 源码清单不应为空");
  const offenders = files.filter((file) => readFileSync(
    resolve("web/src", file), "utf-8").includes("window.confirm("));
  assert.deepEqual(offenders, [], "仍有调用点残留浏览器原生确认框");
  // T2 的七个机械替换点全部挂上共享弹框(危险三处红档)。
  const historyBoard = readFileSync(resolve("web/src/HistoryBoard.tsx"), "utf-8");
  const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
  const settings = readFileSync(resolve("web/src/SettingsView.tsx"), "utf-8");
  const wishWall = readFileSync(resolve("web/src/WishWall.tsx"), "utf-8");
  const modules = readFileSync(resolve("web/src/BusinessModuleLibrary.tsx"), "utf-8");
  const workflows = readFileSync(
    resolve("web/src/workflows/WorkflowAssetWorkspace.tsx"), "utf-8");
  for (const [name, source] of [["HistoryBoard", historyBoard],
    ["TaskCard", taskCard], ["SettingsView", settings], ["WishWall", wishWall],
    ["BusinessModuleLibrary", modules],
    ["WorkflowAssetWorkspace", workflows]] as const) {
    assert.match(source, /confirmDialog\(\{/, `${name} 应改用 confirmDialog`);
  }
  for (const source of [historyBoard, taskCard]) {
    assert.match(source, /danger: true/);
  }
});

test("分析报告可原位全屏(#260 起子页签退役,报告即本页签全部内容)", () => {
  assert.match(materials, /issue-doc\$\{fullscreen \? " is-fullscreen fixed/);
  assert.match(materials, /fullscreen \? "退出全屏" : "全屏查看"/);
  assert.match(materials, /if \(event\.key === "Escape"\) setFullscreen\(false\)/);
  // #230 改锚:全屏壳换工具类——定底盘(固定定位/层高/滚动)由
  // is-fullscreen 分支的变体直译,旧 .is-fullscreen 规则随家族退役。
  assert.match(materials,
    /is-fullscreen fixed inset-\[14px\] z-\[720\] flex flex-col/);
});

test("环境形态字段:唯一落点是共用新建弹框,登记与闸卡只选不手填(AI 不试错)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const decisionCard = readFileSync(
    resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 形态下拉(虚拟化/容器化)只在共用弹框(EnvironmentEditorDialog):
  // 形态随新建录入台账;登记页与 env 卡不再有手填面。
  assert.match(editor, /<SelectItem value="virtualized">虚拟化\(经网管节点\)<\/SelectItem>/);
  assert.match(editor, /<SelectItem value="k8s">容器化\(经 OM 节点\)<\/SelectItem>/);
  assert.doesNotMatch(registration, /环境形态/);
  assert.doesNotMatch(registration, /env_type/);
  assert.match(registration, /environment_id: pickedEnv\.id/);
  // env_needed 卡:同样只选,提交 wire 只带 environment_id。
  assert.doesNotMatch(decisionCard, /env_type/);
  assert.doesNotMatch(decisionCard, /<option value="k8s">/);
  assert.match(decisionCard, /environment_id: picked\.id/);
  // 拒绝口(票 93)文案直说拒绝;两段式:第一段展开理由框,第二段确认。
  assert.match(decisionCard, /拒绝填写,继续分析/);
  assert.match(decisionCard, /拒绝填写,继续/);
  assert.match(decisionCard, /确认拒绝,继续分析/);
  // 环境卡中途即显(2026-09-08):闸在场即出卡,不等 waiting_user——
  // 模型收口后继续不需要环境的工作,用户填卡与它并行。
  assert.match(sessionView, /const envGateLive = detail\.gate\?\.kind === "env_needed"/);
  // wire 类型:形态字段仍在册(台账/弹框消费,服务端契约不变)。
  assert.match(apiTypes, /env_type\?: "virtualized" \| "k8s"/);
});

test("DTS 列表所属模块列:强匹配带出/人工改选/显隐记忆/发起必带(ADR-0056)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // API 面:全量拉取 + 单条写(空=解绑),走 /issues/dts-bindings。
  assert.match(apiTypes, /getDtsModuleBindings/);
  assert.match(apiTypes, /putDtsModuleBinding/);
  assert.match(apiTypes, /"\/issues\/dts-bindings"/);
  assert.match(apiTypes, /dts-bindings\/\$\{encodeURIComponent\(ticket\)\}/);
  // 列渲染:改选优先于带出,都没有 = 未匹配必填(占位项只给服务端
  // 没带出的行,且恒在——Base UI 对「当前值不在 items」会补空提交,
  // 动态摘占位会把刚选的清掉);占位文案点名发起前必选。
  assert.match(registration,
    /<Select[\s\S]{0,80}value=\{resolvedModule \?\? "__none"\}/);
  assert.match(registration, /未匹配,发起前必选/);
  assert.match(registration, /aria-label=\{\`\$\{ticket\.ticket\} 所属业务模块\`\}/);
  // 改选即存:乐观更新失败回滚,反馈落在行内。
  assert.match(registration, /async function bindModule\(/);
  assert.match(registration, /putDtsModuleBinding\(ticketNo, moduleId \|\| null\)/);
  assert.match(registration, /text-destructive" role="alert"/);
  // 显隐(ADR-0056 列显隐系统化):统一「列」Popover + localStorage
  // 按用户记忆;介入档位列单独一份默认关的开关(ADR-0058)。
  assert.match(registration, /aria-label="列设置"/);
  assert.match(registration,
    /mae-flow:dts-hidden-cols:\$\{viewer\.username\}/);
  assert.match(registration, /localStorage\.setItem\(hiddenColsKey/);
  // 发起携带:改选/带出现场解析恒带(ADR-0056 双闸纵深防御的一半);
  // 列上没有就不发,没有「不带的」路径。
  assert.match(registration, /module_id: moduleId,/);
  // 模块目录与登记页同尺:active 且有仓。
  assert.match(registration,
    /module\.status === "active"\s*&&\s*module\.repositories\.length > 0/);
});

test("DTS 列表自动接单列:默认隐藏点名才开,两态「允许/排除」选即存失败回滚(ADR-0070)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // API 面:行字段镜像(在场=排除,缺席=允许)+ 单条改写——排除走 PUT
  // 落条目、允许走 DELETE 删条目;接口在登录闸后,操作人取登录身份,
  // 客户端改写不传账号。
  assert.match(apiTypes, /auto_claim_excluded\?: boolean;/);
  assert.match(apiTypes, /putDtsAutoClaimExclusion\(/);
  assert.match(apiTypes,
    /dts-auto-claim-exclusions\/\$\{encodeURIComponent\(ticket\)\}/);
  assert.match(apiTypes, /method: excluded \? "PUT" : "DELETE"/);
  // 列注册:进可显隐清单与列宽常量族(紧跟介入档位列收尾,少一列或
  // 多一列即这里红)。
  assert.match(registration,
    /\{ key: "autoClaim", label: "自动接单" \}/);
  assert.match(registration, /tier: 116, autoClaim: 116,/);
  assert.match(registration,
    /minSize: DTS_COL_MIN\.autoClaim, maxSize: DTS_COL_MAX\.autoClaim/);
  assert.match(registration, /autoClaim: colShown\("autoClaim"\)/,
    "新列必须接进引擎 columnVisibility");
  // 显隐极性照介入档位列(ADR-0058):默认关、点名才开,tier 与
  // autoClaim 同一张默认关的表、逐列单独一份按人记忆,不与其余数据列
  // 「勾掉进集合」的极性混存。
  assert.match(registration,
    /\{ key: "tier", storage: "mae-flow:dts-tier-col" \}/);
  assert.match(registration,
    /\{ key: "autoClaim", storage: "mae-flow:dts-autoclaim-col" \}/);
  assert.match(registration,
    /localStorage\.getItem\(`\$\{col\.storage\}:\$\{viewer\.username\}`\) === "1"/);
  // 格子:ui/ Select 两态「允许/排除」,值=乐观覆盖 ?? 行字段(缺席=
  // 允许);所有行可改,不限发起状态与视角——格子不看进行中会话,也不
  // 看协助视角(终态后防被重新接走的逃生门对谁都在)。
  const claimColStart = registration.indexOf('id: "autoClaim"');
  assert.ok(claimColStart > -1, "自动接单列 def 应在表列数组里");
  const claimCol = registration.slice(
    claimColStart, registration.indexOf("const table = useReactTable"));
  assert.match(claimCol, /value=\{excluded \? "exclude" : "allow"\}/);
  assert.match(claimCol, /\?\? ticket\.auto_claim_excluded === true/,
    "字段缺席必须落到「允许」,不是空值");
  assert.match(claimCol, /items=\{CLAIM_SELECT_ITEMS\}/);
  assert.match(claimCol, /<SelectItem value="allow">允许<\/SelectItem>/);
  assert.match(claimCol, /<SelectItem value="exclude">排除<\/SelectItem>/);
  assert.match(claimCol, /aria-label=\{`\$\{ticket\.ticket\} 自动接单`\}/);
  assert.doesNotMatch(claimCol, /assistMode|liveIssue|mineLive/,
    "格子不得按发起状态或视角收闸——所有行可改(ADR-0070)");
  // 选即存、失败回滚(照所属模块列):乐观更新,改写失败回滚为原值,
  // 原因落在那一行。
  assert.match(registration, /async function saveClaimExclusion\(/);
  assert.match(registration, /putDtsAutoClaimExclusion\(ticketNo, excluded\)/);
  assert.match(registration,
    /if \(previous === undefined\) delete next\[ticketNo\];/,
    "失败回滚必须能退回行字段事实(覆盖条目缺席)");
  assert.match(claimCol,
    /claimFail\?\.ticket === ticket\.ticket[\s\S]*?role="alert"/);
});

// ---- 问题会话查看模式(docs/issue-session-view-mode.md):非归属人只读
// ---- 围观(四信息面完整、零操作控件),归属人照常操作;团队看板入口
// ---- 行为不变。

test("问题会话查看模式:标识上屏可读,判定按登录用户与会话归属人比对", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
  const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
  // viewer 下传链:App(登录用户)→ IssueBoard → 会话视图,断链即红。
  assert.match(app, /<IssueBoard viewer=\{session\}/);
  assert.match(board, /viewerUsername=\{viewer\.username\}/);
  // 判定口径:viewer 缺席(auth 关闭的演示形态)按可操作处理;
  // 非归属人一律查看模式(管理员不例外——管理员不处理问题单)。
  assert.match(sessionView,
    /const canOperate = !viewerUsername \|\| viewerUsername === detail\.account;/);
  // 标识:文案用词表词「查看模式」、归属人名上屏,只在非归属人分支
  // 渲染;role 保证读屏能听到这条状态。
  // #231 改锚:查看模式徽标换 Badge warning 软皮(琥珀只提示不告警),
  // 原 .issue-view-mode 手搓皮随家族退役。
  assert.match(sessionView,
    /\{!canOperate && <Badge variant="warning" role="status"/);
  assert.match(sessionView, /查看模式:归属人 \{detail\.account\} 的会话/);
  assert.doesNotMatch(css, /\.issue-view-mode/);
});

test("问题会话查看模式:操作控件逐处收进归属分支,信息面不收", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 工作台头部:「无单场景」是状态说明不是控件,查看模式照常示人。
  // #98 单路径化后一切会话都是固定流程,自由分支的绑单输入已整体删除,
  // 不得再以任何形式回流。
  // #231 改锚:单号徽标换工具类胶囊(绑单/无单两态),user-select 由
  // span 上的 select-text 承担。
  assert.match(sessionView,
    /\? <span className="select-text rounded-full bg-primary\/10 px-\[7px\] py-px font-mono text-xs font-bold text-primary">\{detail\.ticket\}<\/span>\s*: <span className="select-text rounded-full border border-dashed px-\[7px\] py-px font-mono text-xs font-bold text-faint">\{detail\.scenario === "mr_repair" \? "已有 MR" : "无单场景"\}<\/span>/);
  assert.doesNotMatch(sessionView, /className="issue-bind"/);
  assert.doesNotMatch(sessionView, /bindIssueTicket/);
  // 认证报错的「去个人设置配置令牌」修的是归属人的凭据,查看模式不渲染。
  assert.match(sessionView,
    /canOperate && onNavigateProfile\s*&& detail\.error\.includes\(GIT_AUTH_ERROR_TAG\)/);
  // 双栏下传:右栏协作流与左栏材料内容都必须拿到 canOperate,
  // 面板内部的写控件由各自文件的断言钉住(#127 起右栏是协作流)。
  assert.match(sessionView, /<IssueConversationStream[\s\S]*?canOperate=\{canOperate\}/);
  assert.match(sessionView, /<IssueMaterialsPane[\s\S]*?canOperate=\{canOperate\}/);
  // 信息面不收:现场直播(SSE)不带任何归属条件。耗时卡点已随走查
  // 反馈移出工作台(2026-09-07),又随列表卡展开态退役整个删除
  // (2026-09-11);逐仓交付页签已随 ADR-0027 退役,交付事实融入
  // 元信息关联仓行。
  assert.match(sessionView,
    /\{tab === "events" && <TabsContent value="events" className="contents">[\s\S]*?<IssueEventsPane id=\{detail\.id\} active \/>/);
  assert.doesNotMatch(sessionView, /IssueWorkspaceRepos/,
    "逐仓交付页签与组件已退役(ADR-0027,融合进元信息关联仓行)");
  assert.doesNotMatch(sessionView,
    /<IssueCostPanel id=\{detail\.id\} \/>/,
    "耗时卡点不再占工作台纵向空间(面板已整个退役)");
  // 右栏:作答卡(问题卡+平台闸+env 表单)只在归属分支,查看模式渲染
  // 无作答控件的事实卡(题面/选项/背景照看,替归属人判断卡在哪)。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 挂起槽位与说明卡整体退役(ADR-0048/0057 收尾,2026-10-13):存量
  // 挂起读盘归取消,会话视图与协作流不得再挂任何挂起卡/槽位。
  assert.doesNotMatch(sessionView, /suspendedCard|IssueSuspendedCard/);
  assert.doesNotMatch(stream, /suspendedCard|IssueSuspendedCard/);
  // 输入区(#127 起发言唯一入口):查看者整段只读,插话/续聊收进归属分支。
  assert.match(stream, /!canOperate \? \{ kind: "readonly" \}/);
  // 头部控件区:终止(归档已退役,ADR-0057)整组收进归属分支
  // (#127 自侧栏栏脚迁入),与「导出现场记录」并列;确认语义由
  // 下拉式 CancelSessionDialog(#541)的断言钉住。
  const headControls = sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
  assert.ok(headControls.includes("canOperate && <>"), "终止必须挂在 canOperate 分支下");
  assert.ok(headControls.includes("终止会话"), "头部控件区缺终止");
  assert.doesNotMatch(headControls, /归档收口|onClick=\{archive\}/,
    "手动归档已退役,头部不得再有归档入口(ADR-0057)");
  assert.ok(headControls.includes('onClick={cancelSession}'), "终止必须接 cancelSession(开下拉确认框)");
  // 材料页签:人工修改整链(快速修改编辑器、请 AI 复核、人工修改记录)
  // 已整体退役(ADR-0028)——问题流的人工写口清零,代码层面意见走右栏
  // 插话/续聊;检视(行尾圈注写口与正文下方的检视区)照旧收闸。
  // (钉活代码标识符:头注释里的退役说明不算违例。)
  assert.doesNotMatch(materials,
    /issue-materials-editor|saveIssueWorkspaceFile|getIssueWorkspaceFile|manual_edits|SelectGroup/);
  // #267 改锚:压缩包解压写口随拉取日志页签整体退役(ADR-0026)——
  // 日志不再是人在线翻阅的面,归属写口不复存在,下载是纯读。
  // #260 改锚:检视不再是独立页签,草稿清单+提交链路常驻报告正文下方。
  // (#259 story 23 修正:已提交意见清单是纯读面,登录只读访问者也可见
  // ——面板不再整块挂 canOperate;服务端本就登录可读,这是纯前端展示
  // 面放宽,写边界不变。)行尾圈注写口仍在,同样收闸(reviewEnabled+
  // canOperate 才给 Annotatable)。
  assert.match(materials,
    /<IssueReviewPanel detail=\{detail\} reviews=\{reviews\.filter\(item => !item\.external_review\)\}[\s\S]*?canOperate=\{canOperate\}/);
  assert.match(materials,
    /reviewEnabled && canOperate\s*\?\s*<Annotatable/);
});

// ---- 检视区可见性分两层(#259 story 23,ADR-0025):已提交清单纯读、
// ---- 登录访问者都可看;草稿编辑/移除/提交写口仍收在 canOperate。

test("检视区草稿写口收闸、已提交清单对只读访问者可见(#259 story 23)", () => {
  const reviewPanel = materials.slice(
    materials.indexOf("function IssueReviewPanel"),
    materials.indexOf("export function IssueMaterialsPane"));
  // 写口(草稿清单/空态指引)必须挂在 canOperate 分支下。
  assert.match(reviewPanel, /canOperate && drafts\.length === 0 && sent\.length === 0 && <Empty/,
    "空态里的圈注指引是写口导引,只读访问者不看");
  assert.match(reviewPanel, /canOperate && drafts\.length > 0 && <section>/,
    "草稿编辑与提交按钮仍收在 canOperate");
  // 已提交清单不挂任何归属条件:纯读,spec #259 story 23 的验收面。
  assert.match(reviewPanel, /sent\.length > 0 && <section>/,
    "已提交意见清单对登录只读访问者可见");
  assert.doesNotMatch(reviewPanel, /canOperate && sent\.length > 0/);
});

// ---- 意见号(#261,ADR-0025):检视区以「意见N」为主键标识,台账
// ---- an- id 不出面;行号与原文照旧。

test("检视区以意见号为主键展示(#261):「意见N」在卡面,an- id 不出面", () => {
  // 行卡首格 = 意见号:意见号是落账硬要求(ADR-0025),恒显「意见N」
  // ——无号降级显示已拆,系统未上线不存在无号意见。
  assert.match(materials, /意见\{item\.seq\}/);
  assert.doesNotMatch(materials, /item\.seq === undefined \? "意见"/);
  // 行号/原文照旧:查看原文与锚定原文的既有呈现不动。
  assert.match(materials, />查看原文<\/Button>/);
  assert.match(materials, /针对 \{item\.anchor\}/);
  // 台账 id 不再作为 UI 标识:意见卡本体不渲染 item.id(an- id 只准
  // 留在 React key/勾稽里,不上屏)。
  const reviewCard = materials.slice(
    materials.indexOf("function IssueReviewItem"),
    materials.indexOf("function IssueReviewPanel"));
  assert.doesNotMatch(reviewCard, /item\.id/);
});

// ---- 检视分诊(ADR-0035):AI 的逐条回复落账后在该意见下只读呈现,
// ---- 需求侧批注回复同款体验;纯读面,不挂归属条件。

test("检视意见面板呈现 AI 回复(ADR-0035):回复环按序铺开,结果词与回复原文在", () => {
  const reviewCard = materials.slice(
    materials.indexOf("function reviewOutcomeLabel"),
    materials.indexOf("function IssueReviewPanel"));
  // 回复环(2026-09 回复环改版):被回复取代的旧回执随 author_replies
  // 留档,最新回应在 response——按序铺开「Agent 回复 → 你的回复 → …」;
  // 回复原文(不是"已处理"三字糊弄)是主内容,evidence 只作补充行。
  assert.match(reviewCard,
    /rounds\.map\(\(round, index\) => round\.who === "agent"/);
  assert.match(reviewCard, /Agent 的回复/);
  assert.match(reviewCard, /\{round\.text\}/);
  assert.match(reviewCard, /依据 \{round\.evidence\.join\("；"\)\}/);
  // 结果词与需求侧同话术(response 是机器事实,不是验收)。
  assert.match(reviewCard, /"已处理"/);
  assert.match(reviewCard, /"没有修改"/);
  assert.match(reviewCard, /"需要你补充说明"/);
  // wire 镜像带 response 字段(ADR-0035 起问题域随回复型意见出)。
  const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.match(api, /response\?: Annotation\["response"\]/);
});

// ---- 新版干净纸面(ADR-0025):漂移检测与徽标只服务草稿;sent 意见
// ---- 锚在自己批次的冻结版上,冻结文本永不漂移,不再带漂移徽标。

test("锚点徽标只服务草稿(ADR-0025):sent 意见卡不再渲染漂移徽标", () => {
  // 服务端:anchorChecks 只扫草稿(reviews.ts,不碰 sent)。
  const reviewLedger = readFileSync(
    resolve("src/issueFlow/reviews.ts"), "utf-8");
  assert.match(reviewLedger, /reanchor\(drafts/);
  assert.doesNotMatch(reviewLedger, /reanchor\(reviews/);
  // 前端:徽标挂 draft 态;sent 态徽标渲染不得回流。
  assert.match(materials,
    /item\.status === "draft" && check && <IssueReviewBadge/);
  assert.doesNotMatch(materials,
    /item\.status === "sent" && <IssueReviewBadge/);
});

// ---- 问题会话单路径化(#98):前端不再感知"模式"概念,任意会话一律
// ---- 按固定流程渲染;自由旅程线与模式徽标整体退场。后端仍会在会话
// ---- 数据里带 mode:"fixed"(#99 删字段),前端不再读它。

test("工作台单路径化(#98):mode 缺席也画固定计划线,自由旅程线不得回流", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const teamCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 会话工作台无条件画固定流程计划线——契约上不再容忍自由形状:对
  // mode 缺席的会话数据(后端删字段后)照样输出固定进度条,不存在
  // 任何条件分支;旅程线组件与 mode 读取一并禁止回流。
  // ADR-0018 骨架对齐后,工作台头部用的是 task-progress 视觉的
  // IssueWorkspaceProgress(数据仍是 stage_states);IssueFixedProgress
  // 保留给列表卡,工作台不得回流自由旅程线。
  assert.match(sessionView, /<IssueWorkspaceProgress issue=\{detail\} \/>/);
  assert.match(sessionView, /<div className="ws-progress">/);
  assert.match(sessionView, /export function IssueFixedProgress/);
  assert.doesNotMatch(sessionView, /IssueJourneyTrail|issue-journey|issue-jnode/);
  assert.doesNotMatch(sessionView, /detail\.mode/);
  // 列表卡与团队卡:轮次标注、进度条无条件渲染(原 mode 恒真判断删除,
  // 固定流程会话的渲染结果不变)。
  assert.match(board, /^        <IssueFixedProgress issue=\{issue\} \/>$/m);
  assert.doesNotMatch(board, /issue\.mode/);
  assert.doesNotMatch(teamCard, /issue\.mode/);
  // 终局(归档/取消/失败)只按状态收口:输入区给只读原因说明,不问
  // 模式(rail 拆除后 #127 起终局说明由输入区承载)。
  assert.match(stream,
    /const ended = \["archived", "canceled", "failed"\]\.includes\(status\);/);
  // 前端类型面不再携带模式:IssueFlowMode 与会话上的 mode 字段删除。
  assert.doesNotMatch(apiTypes, /IssueFlowMode/);
  assert.doesNotMatch(apiTypes, /\bmode\?:/);
  // LEGACY_STAGE_TEXT(ut/deploy_verify)是固定流程自己的旧阶段展示
  // 兼容,与自由探索无关,必须原样保留。
  assert.match(apiTypes, /LEGACY_STAGE_TEXT/);
  assert.match(apiTypes, /ut: "单元测试验证"/);
});

test("帮助中心单一流程化(#98):设置页契约无探索方式卡片", () => {
  const helpCenter = readFileSync(resolve("web/src/HelpCenter.tsx"), "utf-8");
  // 任何角落不得再出现"两种探索方式"与自由探索表述;个人设置文章的
  // 步骤与截图说明不再描述探索方式卡片(区域编号已顺号修正)。
  assert.doesNotMatch(helpCenter, /自由探索|探索方式|两种探索/);
  // 旅程线与模式徽标样式随分支一并退场;查看模式徽标的手搓皮也随
  // #231 换装退役(Badge warning 承接)。
  assert.doesNotMatch(css, /\.issue-journey|\.issue-jnode|\.issue-mode[ .:{]/);
  assert.doesNotMatch(css, /\.issue-view-mode/);
});

test("团队看板问题卡片入口行为不变:点击即进,不含归属判断", () => {
  const teamCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  const overviewRow = readFileSync(
    resolve("web/src/TaskOverviewRow.tsx"), "utf-8");
  // 入口语义(spec 拍板;ADR-0040 起新页签直达):卡片自带链接,文案与
  // 行为不因身份变化;非归属人点开即达,查看模式在会话工作台内部呈现,
  // 卡片不做归属裁剪。卡片已收敛为 TaskOverviewRow 单形态(与任务行
  // 同款版式;问题行是 href 锚点、任务行仍是 onOpen 按钮)。
  assert.match(teamCard, /<TaskOverviewRow issue /);
  assert.match(teamCard, /href=\{issueSessionPath\(issue\.id\)\} \/>/);
  assert.match(overviewRow, /onClick: onOpen/, "任务行仍走按钮页内打开");
  assert.match(overviewRow,
    /const openLabel = `打开\$\{issue \? "问题" : "任务"\}工作台：\$\{title\}`;/);
  // 固化现状:卡片不出现任何身份/归属判断(陈列 issue.account 不算判断)。
  assert.doesNotMatch(teamCard, /canOperate|isOwner|viewerUsername|viewer\.|username/);
});

test("admin 只读可见问题处理(#103):角色门拆除,发起入口仅开发者", () => {
  // App 层:问题视图不再按角色拒绝渲染(admin 点团队问题卡不再白屏);
  // 深链 /issues/:id 对 admin 也切视图;「去个人设置配置」跳转仅开发者。
  assert.doesNotMatch(appSource,
    /view === "issues" && session\.role !== "admin"/);
  assert.doesNotMatch(appSource,
    /issueId && session\?\.role !== "admin"/);
  assert.match(appSource,
    /onNavigateProfile=\{session\.role !== "admin" \? /);
  // admin 侧栏常驻问题处理入口(管理视角分组内)。
  const adminNav = appSource.slice(
    appSource.indexOf('session.role === "admin" ? <>'),
    appSource.indexOf("</> : <>"));
  assert.ok(adminNav.includes('view="issues"'), "admin 侧栏缺问题处理入口");
  // 问题板:发起界面(登记/DTS)仅开发者渲染;列表标题「全部/我的」
  // (ADR-0031,2026-09-16 修订:单一列表,归属或登记人是自己)。
  assert.match(issueBoard,
    /viewer\.role !== "admin" && childTab !== "pipeline" && <IssueRegistration/);
  assert.match(issueBoard,
    /viewer\.role === "admin" \? "全部问题" : "我的问题"/);
  // 会话工作台的查看模式边界不变:写口仍按归属人判定(admin 旁观不写)。
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  assert.match(sessionView,
    /const canOperate = !viewerUsername \|\| viewerUsername === detail\.account/);
});

test("单号处处可选中复制:DTS 表格单号独立成格,user-select 强制放开", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 单号是绑单/推送分支名的关键操作对象,复制是高频动作;button(会话
  // 卡片)内的拖选被浏览器默认禁掉,CSS 强制放开。
  // #231 改锚:.issue-ticket 摘出(会话头部单号徽标换 select-text 工具类)。
  assert.match(css,
    /\.task-ticket,\s*\.issue-dts-ticket\s*\{[^}]*user-select:\s*text/);
  assert.match(sessionView, /select-text rounded-full bg-primary\/10 px-\[7px\]/);
  // shadcn 表格化后(2026-10-14 迁 TanStack 引擎):勾选 Checkbox 在
  // select 列的 cell,单号在 ticket 列的 cell——列定义分离即独立成格,
  // 拖选复制不会误勾选。
  const rowTemplate = registration.slice(
    registration.indexOf("id: \"select\""),
    registration.indexOf("issue-dts-ticket")
      + "issue-dts-ticket".length);
  const checkboxCell = rowTemplate.indexOf("<Checkbox");
  const ticketCell = rowTemplate.indexOf("issue-dts-ticket");
  assert.ok(checkboxCell > -1, "行模板应有勾选 Checkbox");
  assert.ok(ticketCell > checkboxCell, "勾选在前,单号在后");
  assert.ok(rowTemplate.slice(checkboxCell, ticketCell).includes("id: \"ticket\""),
    "单号必须独立列(与勾选不同列)——拖选复制不误勾选");
});

test("现场页签挂载与切回时贴底:程序滚动回声不参与人上翻判定", () => {
  const events = readFileSync(resolve("web/src/issues/EventsPane.tsx"), "utf-8");
  const sticky = readFileSync(resolve("web/src/stickyBottom.ts"), "utf-8");
  // 挂载/激活即无条件回底(用户第一眼看最新);人上翻才撒手是既有语义。
  assert.match(events, /if \(active\) follow\.resync\(\)/);
  // 回声守卫:位置停在程序滚动落点上的 scroll 事件不能松开跟随——
  // 没有它,历史分批装载期间贴底会被竞态打成「已暂停跟随」。
  assert.match(sticky, /Math\.abs\(node\.scrollTop - setTop\.current\) < 2/);
  assert.match(sticky, /setTop\.current = node\.scrollHeight/);
});

test("按需本地验证由技能统一指导,push_branch 只管平台事实校验", () => {
  // 简报只指路,验证范围交给主 Agent 按修改风险判断,不另加编译前置。
  const briefs = readFileSync(resolve("assets/issue-prompts/briefs.md"), "utf-8");
  const pushBranchDesc = issueTools.match(
    /name: "push_branch"[\s\S]*?parameters: Type\.Object/)?.[0] ?? "";
  assert.ok(pushBranchDesc, "push_branch 工具定义必须存在");
  assert.doesNotMatch(pushBranchDesc, /UT|全量回归|测试/,
    "push_branch 描述不得重复验证方法");
  const fixBrief = briefs.match(/## stage\.fix\n([\s\S]*?)\n## stage\.mr_green/)?.[1] ?? "";
  assert.ok(fixBrief, "briefs.md 缺 stage.fix 锚点");
  assert.match(fixBrief, /issue-delivery.*按需本地验证/);
  assert.match(fixBrief, /简单明确的修改可直接提交推送/);
  assert.match(fixBrief, /如实说明验证范围/);
  assert.doesNotMatch(fixBrief, /本阶段不推送、不建 MR/);
  const mrGreenBrief = briefs.match(/## stage\.mr_green\n([\s\S]*?)\n## stage\.conclude/)?.[1] ?? "";
  assert.match(mrGreenBrief, /issue-delivery/, "mr_green 简报应接住交付教学");
});

// ---- 左栏六标签(#123 拍平 + 2026-09-07 走查反馈:逐仓交付收编为末签;
// ---- 2026-09-17 ADR-0027 修订:「MR 检视」收编上方批注面板成第六签)
// ---- 材料拍平 + 对话现场升格(ADR-0018 左栏对齐)----

test("左栏六标签:顺序固定、元信息默认、DTS 无单隐藏、MR 检视有批注才现身,旧顶层引用清零", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 六标签一次成表(ADR-0027 五签定局 + 2026-09-17 修订增「MR 检视」),
  // 顺序即规格:元信息(会话名片,兼默认签)在首位,DTS 单据第二,
  // 对话现场降末位、MR 检视垫后——一签一名,不得改名换序。
  const table = sessionView.match(
    /const ISSUE_MAIN_TABS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  assert.deepEqual(
    [...table.matchAll(/key: "([a-z]+)", label: "([^"]+)"/g)]
      .map(([, key, label]) => `${key}:${label}`),
    ["meta:元信息", "dts:DTS单据", "doc:分析报告",
      "changes:工作区变更", "events:对话现场", "reviews:MR 检视"]);
  // DTS 签条件渲染:无单场景整个隐藏(从禁用+tooltip 升级,屏蔽即诚实);
  // 「MR 检视」签有批注才现身(正被看着时即便清空也留)。
  assert.match(sessionView,
    /filter\(\(\{ key \}\) => \(key !== "dts" \|\| detail\.ticket\)/);
  assert.match(sessionView,
    /&& \(key !== "reviews" \|\| showReviewsTab\)/);
  // 页签条是任务侧左栏同款:ws-pane-head > ws-source-switch(皮肤类
  // 原样挂 base-ui TabsList),激活签走 data-active + " on" 皮肤类。
  // (#210)手搓 role=tablist 换原语:键盘箭头、roving tabindex 归原语。
  assert.match(sessionView,
    /className="ws-pane-head" aria-label="问题工作台视图">[\s\S]*?className="ws-source-switch h-auto justify-start"/);
  assert.match(sessionView,
    /<TabsTrigger key=\{key\} value=\{key\}[\s\S]*?tab === key \? " on" : ""/);
  // 默认口与重置:元信息是会话名片(右栏协作流常驻直播兜住「看现场」
  // 的刚需);换会话丢弃手选,回到默认入口。
  assert.match(sessionView, /useState<IssueMainTab>\("meta"\)/);
  assert.match(sessionView, /setTab\("meta"\);\s*\n\s*\}, \[detail\.id\]\);/);
  // 分析报告在库的脉冲点挂「分析报告」页签(报告是主交付物,入口要
  // 找得到;#260 起页签即报告本身,旧右栏"分析报告已产出"CTA 已随
  // #127 侧栏拆除一并退场)。「MR 检视」签同款引导:有待判断批注就挂点
  // (轮询在会话层常驻,页签没开也数得出)。
  assert.match(sessionView, /key === "doc" && detail\.has_analysis/);
  assert.match(sessionView, /key === "reviews" && reviewsPending > 0/);
  // 持续检视面板退役(2026-09-17):问题流反馈账只写流水线与 MR 讨论,
  // 流水线不再上屏(要看去 CodeHub)、MR 讨论本就不进面板,面板恒空。
  assert.doesNotMatch(sessionView, /FeedbackPanel/);
  // 拆除项引用清零:旧顶层页签组件、"materials"页签值与材料子视图状态。
  assert.doesNotMatch(sessionView, /IssuePaneTabs/);
  assert.doesNotMatch(sessionView, /"materials"/);
  assert.doesNotMatch(sessionView, /materialsView/);
});

test("左栏六标签(#123):材料面板免壳直渲,页签一签一色走问题域变量", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 面板壳(ws-pane-head + ws-source-switch)随拍平拆除:MaterialsPane
  // 只按会话层下发的 view 直渲内容,四个子视图原样(#260 起分析报告
  // 视图不再有二级页签,见下方收敛断言)。
  assert.doesNotMatch(materials, /ws-pane-head/);
  assert.doesNotMatch(materials, /ws-source-switch/);
  // 词边界防误伤:SessionView 一词里就藏着 "onView" 子串。
  assert.doesNotMatch(materials, /\bonView\b/);
  assert.match(materials, /\{view === "dts" && /);
  assert.match(materials, /\{view === "doc" && /);
  assert.match(materials, /\{view === "changes" && /);
  // 拉取日志视图(#267,ADR-0026)随页签退役:日志树/在线查看器/解压
  // 的分支与组件引用清零,日志的人读出口是元信息页签的「下载日志」。
  assert.doesNotMatch(materials, /view === "logs"/);
  assert.doesNotMatch(materials, /LogTreeRows|buildLogTree|extractIssueLog|getIssueMaterialLog/);
  // (#260 页签收敛)过程文档子页签整体退役:doc 视图只剩分析报告正文
  // 直渲(过程问答/检视/动态 md 页签全删,报告按 ANALYSIS_DOC 常量直取),
  // 面板内不再有二级页签条。
  assert.doesNotMatch(materials, /<TabsList/);
  assert.match(materials, /const ANALYSIS_DOC = "issue-analysis\.md";/);
  assert.match(materials, /function IssueAnalysisReport\(/);
  assert.doesNotMatch(materials,
    /function (IssueDialogue|IssueProcessDocs)|const (REVIEW_TAB|DIALOGUE_TAB)/);
  // 页签一签一色(#231 改锚):发色原住 issue-workspace 的 nth-child
  // 规则,随家族退役后色值直译成 ISSUE_MAIN_TABS 各签自带的变量工具类,
  // 激活态边/底/字仍走该变量(TabsTrigger 的 data-active: 工具类)。
  assert.ok(
    (sessionView.match(/--workspace-tab-color:#/g) ?? []).length >= 6,
    "六个页签各需一枚 --workspace-tab-color");
  assert.doesNotMatch(css, /\.issue-workspace/);
});

test("DTS 单据单号直取会话账本:现场回收不挡外部查询,兜底三态诚实(2026-10-14)", () => {
  // 归档单的代码现场被清扫器回收后材料清单不加载,DTS 详情若以清单
  // 里的 ticket 为前提就永不发请求,页签永远停在"正在读取"。单号是
  // 会话账本字段,直取 detail.ticket(外部单据系统查询,与本地现场
  // 无关);读取失败给失败文案,不再拿加载态充数。
  assert.match(materials, /getDtsTicketDetail\(detail\.ticket\)/);
  assert.doesNotMatch(materials, /getDtsTicketDetail\(data/,
    "单号不得再绕材料清单——现场回收后清单不加载,请求会永不发出");
  assert.match(materials,
    /dtsError \? "单据详情读取失败" : "正在读取单据详情…"/);
  assert.match(materials, /"\(无关联 DTS 单\)"/);
});

// ---- 右栏协作对话框(#124):ws-side 从 IssueRail 占位换成「与 Agent
// ---- 协作」——会话流接 GET /issues/:id/conversation 聚合接口(可见
// ---- 轮询,任务侧同款节奏),当前等待卡钉在流末尾的 Agent 气泡内
// ---- (#125 卡座);IssueRail 折叠已于 #127 拆除,引用清零。

test("右栏协作对话框(#124):协作头/聚合接口接线/轮询/当前卡上移", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // ws-side 协作头:流组件自带「与 Agent 协作」栏头(ws-collaboration-head,
  // 与任务侧同一结构类),挂在会话视图的 ws-side(aria 同名)里。
  assert.match(sessionView,
    // #231 改锚:皮肤类保留,min-width 与窄屏单列直译成工具类。
    /<section aria-label="与 Agent 协作"\s*\n\s*className="ws-side min-w-0 max-\[1100px\]:order-first max-\[1100px\]:max-h-\[46vh\]">/);
  assert.match(stream, /<header className="ws-collaboration-head">/);
  assert.match(stream, /<strong>与 Agent 协作<\/strong>/);
  assert.match(sessionView, /<IssueConversationStream/);
  // 聚合接口接线:api.ts 出 getIssueConversation → GET /issues/:id/conversation,
  // 成员形状镜像服务端 IssueConversationItem 的六类成员(session/turn/
  // card/decision/steer/review/receipts);流组件消费它,不自己拼装。
  assert.match(apiTypes,
    /export function getIssueConversation\(\s*\n\s*id: string,\s*\n\): Promise<IssueConversationView>/);
  assert.match(apiTypes,
    /issueFetch\(`\/issues\/\$\{encodeURIComponent\(id\)\}\/conversation`\)/);
  for (const kind of ["session", "turn", "card", "decision", "steer", "review",
    "receipts"]) {
    assert.match(apiTypes, new RegExp(`kind: "${kind}"`),
      `api.ts 协作流类型缺 ${kind} 成员`);
  }
  assert.match(stream, /getIssueConversation\(id\)/);
  // 轮询:会话视图可见时每 4 秒拉一次(任务侧同款节奏,visiblePolling),
  // 换会话重置(流清空 + 序号作废半拍旧响应)。
  assert.match(stream, /startVisiblePolling\(\(\) => load\(issueId\), 4000, document\)/);
  assert.match(stream,
    /useEffect\(\(\) => \{[\s\S]*setView\(\{ items: \[\], truncated: false, loaded: false \}\);[\s\S]*\}, \[issueId, load\]\)/);
  // 当前等待卡已入流(#125 卡座):卡由会话视图组装下传(决策卡/查看
  // 模式事实卡),钉在流末尾的 Agent 气泡内——卡座/dock 的契约为文末
  // #125 测试块钉住。
  assert.match(sessionView,
    /currentCard=\{waiting \? \(canOperate\s*\n\s*\? <IssueDecisionCard[\s\S]*?: <IssueWaitingFacts waiting=\{waiting\} \/>\)\s*\n\s*: undefined\}/);
  // 输入区分派:运行中=插话(steerIssue)、其余=续聊(replyIssue),
  // 查看者只读(ws-composer-readonly);回调沿用 SessionView 既有口。
  assert.match(sessionView, /onSteer=\{sendSteer\}/);
  assert.match(sessionView, /onReply=\{sendReply\}/);
  assert.match(stream, /status === "running" \? \{ kind: "steer" \}/);
  assert.match(stream, /ws-composer-readonly/);
  // 侧栏拆除(#127):ws-side 再无 rail 挂载与「更多操作」details;
  // 查看模式事实卡自 IssueWaitingFacts.tsx 独立文件导出(组件零变化)。
  assert.doesNotMatch(sessionView, /IssueRail/);
  assert.doesNotMatch(sessionView, /issue-side-more/);
  assert.doesNotMatch(sessionView, /更多操作/);
  const facts = readFileSync(
    resolve("web/src/issues/IssueWaitingFacts.tsx"), "utf-8");
  assert.match(facts, /export function IssueWaitingFacts/);
  // 样式落点(#231 改锚;#233 再改锚:conversation.css 并入唯一
  // tailwind.css):右栏皮肤走共享 ws-* 皮;流上方临时容器
  // (issue-conv-now)的死规则已随 #125 卡座拆除清零。
  const conversationCss = readFileSync(
    resolve("web/src/tailwind.css"), "utf-8");
  assert.match(conversationCss,
    /\.task-workspace-v2 \.ws-stream-shell > \.ws-collaboration-head/);
  assert.doesNotMatch(css, /issue-conv-now/);
});

// ---- 右栏侧栏拆除(#127,#120 收尾):IssueRail 六态侧栏整体退场——
// ---- 状态说明由头部徽标/阶段行与协作流承载,归档/终止入头部控件区;
// ---- 拆除项引用清零、死样式清理(挂起转正卡及其后继说明卡亦整体退役)。

test("侧栏拆除(#127):rail 源码删除引用清零,归档/终止入头部,状态说明不丢", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 拆除项源码清零:IssueRail.tsx 文件不存在,问题工作台源码再无
  // rail 组件/类名/「更多操作」details 的引用(死样式一并清零)。
  assert.equal(
    readdirSync(resolve("web/src/issues")).includes("IssueRail.tsx"), false,
    "IssueRail.tsx 应随 #127 删除");
  assert.doesNotMatch(sessionView, /IssueRail|issue-rail(?!-card)|issue-side-more/);
  assert.doesNotMatch(stream, /IssueRail|issue-side-more/);
  assert.doesNotMatch(css, /issue-side-more|issue-rail-input|issue-rail-foot|issue-rail-actions|issue-analysis-cta/);
  // 终止入头部控件区(与导出并列;归档已退役 ADR-0057),确认语义
  // 升级(#541):下拉式 CancelSessionDialog 接入在 SessionView。
  const headControls = sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
  assert.ok(headControls.includes("导出现场记录"));
  assert.ok(headControls.includes("终止会话"));
  assert.doesNotMatch(headControls, /归档收口/, "归档入口已退役(ADR-0057)");
  assert.match(sessionView, /<CancelSessionDialog open=\{cancelOpen\}/,
    "终止确认框是下拉式共享组件(#541)");
  // 头部危险档(#231 改锚):终止钮换 Button destructive 软皮,红色
  // 危险 affordance 保留(手搓 .danger 皮随 issue-workspace 家族退役)。
  assert.ok(headControls.includes('variant="destructive"'), "终止会话必须走 destructive 档");
  // 状态信息不丢:六态说明由头部状态徽标(词表派生——issueStatusText
  // 按在场卡把环境验证等待显示为「待验证」,ADR-0043)+ 阶段行承载,
  // 不依赖已拆的侧栏状态卡。
  // #231 改锚:状态徽标换 IssueStatusBadge(#216 词典)、阶段行换工具类。
  assert.match(sessionView,
    /<IssueStatusBadge status=\{detail\.status\}>\s*\n\s*\{issueStatusText\(detail\)\}\s*\n\s*<\/IssueStatusBadge>/);
  assert.match(sessionView, /<span className="text-xs text-muted-foreground">\s*\n\s*\{issueStageText\(detail\)\}/);
  assert.match(stream, /kind: "blocked", title: "会话已结束"/,
    "终局说明由输入区承载(终局无侧栏卡后不断档)");
});

test("挂起说明卡整体退役(ADR-0048/0057 收尾):槽位与组件不得回流", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 挂起状态已从词表摘除,存量读盘归取消:协作流顶部不再有挂起槽位,
  // 说明卡组件已删;两段式转正卡同样不得回流(#434 起退役)。
  assert.doesNotMatch(sessionView, /suspendedCard|IssueSuspendedCard/);
  assert.doesNotMatch(stream, /suspendedCard|IssueSuspendedCard/);
  assert.doesNotMatch(sessionView, /IssueAssociateCard|IssueAssociateFacts/,
    "转正卡已退役(#434),会话视图不得再引用");
  assert.equal(existsSync(resolve("web/src/issues/IssueSuspendedCard.tsx")),
    false, "说明卡组件文件已删,不得还魂");
});

// ---- 举卡入流(#125,ADR-0018 决策三):当前等待卡钉在协作流末尾的
// ---- Agent 气泡内(卡座),提交区(附言+提交/拒绝按钮)经 portal 挂进
// ---- 输入区 dock;查看模式卡只读不出 dock,无卡时输入区恢复普通输入。
// ---- 模式要素(挂载点/dock 接线/回放去重)供 #126 其余三类卡复制。

test("卡座(#125):当前卡钉在流末尾 Agent 气泡内,按 waiting_id 去重,issue-conv-now 拆除", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡座挂载点:waiting + currentCard 同时在场即钉;气泡是 Agent 身份
  // (conv-msg agent 由 message() 统一给),卡体住 conv-card current,
  // 排在 rows(全部回放条目)之后——新条目到达它也不挪窝。
  assert.match(stream, /const pinnedCard = Boolean\(waiting && currentCard\);/);
  assert.match(stream,
    /\{rows\}[\s\S]*\{pinnedCard && message\(\{[\s\S]*key: `card-\$\{waitingId/);
  // #231 改锚:卡座气泡换本页 CONV 词典(conv-* 皮留给任务侧)。
  assert.match(stream,
    /children: <div className=\{cn\(CONV\.card, "border-line-strong"\)\}>\{currentCard\}<\/div>/);
  // 去重键:流内同 waiting_id 的投影副本摘除防双卡;其余 waiting 投影
  // (历史卡)不再整类过滤,照常只读回放——旧的整类过滤形状必须消失。
  assert.match(stream,
    /view\.items\.filter\(\(item\) =>\s*\n\s*!\(item\.kind === "card" && item\.waiting_id === waitingId\)\)/);
  assert.doesNotMatch(stream,
    /filter\(\(item\) => !\(item\.kind === "card" && item\.status === "waiting"\)\)/,
    "流内 waiting 投影不得再按状态整类过滤(按 waiting_id 去重)");
  // 去重键来自会话视图下传的当前卡身份,不是流内推断。
  assert.match(sessionView, /waitingId=\{waiting\?\.waiting_id\}/);
  // 拆除:流上方临时容器「当前待你处理」(issue-conv-now)引用清零。
  assert.doesNotMatch(stream, /issue-conv-now/);
  assert.doesNotMatch(stream, /当前待你处理/);
});

test("卡座(#125):dock portal 接线——提交区挂输入区 dock,表单状态仍归卡组件", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡侧:提交区经 DecisionFooterMount 同款挂载器 createPortal 进 dock;
  // 目标缺席(首帧/未接线)时原位渲染,portal 只搬 DOM 不搬状态。
  assert.match(decisions,
    /function IssueDecisionFooterMount\(\{ target, children \}/);
  assert.match(decisions, /return target \? createPortal\(children, target\) : children;/);
  assert.match(decisions, /footerTarget\?: HTMLElement \| null/);
  // env 卡(本票走通的卡):拒绝理由(两段式展开)+错误提示+提交/拒绝
  // 按钮整块进 dock(挂载器包住 dock-foot);未选环境不得提交、拒绝
  // wire 复用 /environment(decline:true + note)。
  assert.match(decisions,
    /<IssueDecisionFooterMount target=\{footerTarget\}>[\s\S]*?<DecisionDockFoot docked=\{Boolean\(footerTarget\)\}>[\s\S]*?<\/IssueDecisionFooterMount>/);
  assert.match(decisions, /busy \|\| !picked/, "未选环境不得提交");
  assert.match(decisions, /decline: true,/);
  // 输入区侧:dock 容器(与任务侧同一 ws-reply-dock 形状,aria 同名)
  // 只在等卡分支预留,由 dock=waiting && canOperate 门控。
  assert.match(stream,
    /\{dock && <div className="ws-reply-dock" ref=\{dockRef\} role="region"\s*\n\s*aria-label="决定的附言与提交" \/>\}/);
  assert.match(stream, /dock=\{waiting && canOperate\}/);
  // 会话视图:dock 节点回调与卡的 footerTarget 同源一线
  // (dockRef setState → footerTarget → 卡 → portal)。
  assert.match(sessionView, /dockRef=\{setDecisionFooterTarget\}/);
  assert.match(sessionView, /footerTarget=\{decisionFooterTarget\}/);
  // 样式落点(#231 改锚):#125 追加块随 issue-workspace 家族退役,
  // dock/原位双上下文的铺陈由 DecisionDockFoot 按 docked 条件收放
  // (原位=卡内留白,dock=收平让输入区自带留白)。
  assert.match(decisions, /function DecisionDockFoot/);
  assert.match(decisions, /!docked && \(className \?\? "px-3\.5 pb-3\.5 pt-3"\)/);
  assert.doesNotMatch(css, /issue-decision-dock-foot/);
});

test("卡座(#125):无卡时输入区恢复普通输入,查看模式只读不出 dock", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  // 只读分支(查看模式):整段没有 dock 容器——事实卡只读钉在流末尾,
  // 写口一个不出(与 canOperate 门语义一致)。
  const readonlyStart = stream.indexOf('mode.kind === "readonly"');
  const blockedStart = stream.indexOf('mode.kind === "blocked"');
  const readonlySlice = stream.slice(readonlyStart, blockedStart);
  assert.ok(readonlySlice.includes("ws-composer-readonly"));
  assert.doesNotMatch(readonlySlice, /ws-reply-dock/, "查看模式不得出 dock");
  // 无卡分支:插话/续聊的普通输入(steer-input)段没有 dock——dock 只
  // 在等卡的 blocked 分支;无卡时 dock 容器不渲染,输入区恢复普通输入。
  const steerBranch = stream.slice(stream.indexOf('const steer = mode.kind === "steer"'));
  // 旧 textarea.steer-input 换 shadcn Textarea:插话/续聊共用同一输入
  // 组件,由 steer 布尔切换文案;无卡时 dock 容器不渲染。
  assert.ok(steerBranch.includes("<Textarea"), "插话/续聊输入在场");
  assert.doesNotMatch(steerBranch, /ws-reply-dock/, "无卡时不得出 dock");
  // dock 门:归属人 + 有卡才为真;查看者(waiting 也在场)拿不到 dock。
  assert.match(stream, /dock=\{waiting && canOperate\}/);
});

// ---- 举卡入流·三类卡换壳(#126):通用决策/skill 圈选/流水线两闸照
// ---- #125 卡座模式把附言/提交按钮区搬进输入区 dock(同一挂载器),
// ---- 字段、校验、选项与提交语义零变化;流内历史卡只读回放不受影响。

test("卡座(#126):三类卡的提交区进 dock——footerTarget 透传链与挂载器包法", () => {
  // 透传链(#125 同一条):IssueDecisionCard 把 footerTarget 原样交给
  // 三类卡;rail 直挂不传目标,挂载器原位渲染的兜底仍在。
  assert.match(decisions,
    /<SkillSelectForm busy=\{busy\} skills=\{waiting\.gate_skills \?\? \[\]\}\s*\n\s*footerTarget=\{footerTarget\}/);
  assert.match(decisions,
    /<PipelineGateCard waiting=\{waiting\} busy=\{busy\}\s*\n\s*footerTarget=\{footerTarget\} onAnswer=\{onAnswer\} \/>/);
  assert.match(decisions,
    /<GenericDecisionCard waiting=\{waiting\} busy=\{busy\}\s*\n\s*footerTarget=\{footerTarget\} onAnswer=\{onAnswer\} \/>/);
  // 换壳标记(#231 改锚):四类卡(env+三类)共用 DecisionShell,
  // docked=Boolean(footerTarget) 同一写法。
  assert.equal(
    (decisions.match(/<DecisionShell docked=\{Boolean\(footerTarget\)\}/g) ?? []).length,
    4, "四类卡必须用同一 docked 条件标记");
  const skillForm = decisions.slice(decisions.indexOf("function SkillSelectForm"));
  const pipelineCard = decisions.slice(decisions.indexOf("function PipelineGateCard"));
  const genericCard = decisions.slice(decisions.indexOf("function GenericDecisionCard"));
  // 三张卡的提交区整块进挂载器(附言/错误提示+按钮排住 dock-foot)。
  for (const [name, body] of [["skill", skillForm], ["pipeline", pipelineCard],
    ["generic", genericCard]] as const) {
    assert.match(body,
      /<IssueDecisionFooterMount target=\{footerTarget\}>[\s\S]*?<DecisionDockFoot docked=\{Boolean\(footerTarget\)\}>[\s\S]*?<\/IssueDecisionFooterMount>/,
      `${name} 卡的提交区必须包进挂载器`);
  }
  // skill 圈选卡:勾选清单留在卡上,提交语义零变化——至少勾一项才可点
  // 确认;「都不用」提交空选(两条路同口)。
  assert.match(skillForm, /disabled=\{!picked\.size \|\| busy\}/);
  assert.match(skillForm, /确认勾选\(\$\{picked\.size\}\)/);
  // #231 改锚:「都不用」换 outline 次档钮(手搓 skill-skip 皮退役)。
  assert.match(skillForm, /variant="outline" size="sm"[\s\S]{0,120}都不用,AI 按取用次序自主/);
  assert.match(skillForm, /onClick=\{\(\) => void submit\(\[\]\)\}/);
  // 流水线卡:证据卡的主字段(报错原文)留在卡上、空文本不可提交;
  // 码与文案仍按服务端 options 镜像(缺省字面量兜底);不可修卡的补充
  // 说明是附言,随提交钮进 dock。
  // #231 改锚:证据卡主字段的 env 段换工具类(原 issue-decision-env 皮退役)。
  assert.match(pipelineCard, /\{evidence && <div className=\{cn\("grid gap-2\.5 px-3\.5 pt-3",/);
  assert.match(pipelineCard, /const ready = evidence \? !!text\.trim\(\) : true;/);
  assert.match(pipelineCard, /evidence \? "supply" : "resume"/);
  assert.match(pipelineCard, /报错原文粘贴到这里/);
  assert.match(pipelineCard, /\{!evidence && <div className="grid gap-2\.5">/);
  // 通用决策卡:推荐徽标与逐题作答留在卡上,ready 口径零变化(逐题全
  // 答完才可提交);附言(补充说明)与提交答复钮进 dock。
  assert.match(genericCard,
    /const ready = areIssueQuestionsComplete\(questions, picked, custom\)/);
  assert.match(genericCard,
    /suggested && <Badge variant="warning" className="ml-1\.5 align-middle">AI 推荐<\/Badge>/);
  // #231 改锚:附言开关换 ghost 文字钮(手搓 toggle 皮退役)。
  assert.match(genericCard, /variant="ghost" size="sm"[\s\S]{0,160}\+ 补充说明\(可选\)/);
  assert.match(genericCard, /提交答复/);
});

test("卡座(#126):三类卡换壳不碰会话流——历史卡只读回放与 waiting_id 去重原样", () => {
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 卡座与去重(#125 的形状原样):当前卡钉在流末尾,流内同 waiting_id
  // 投影摘除防双卡,其余历史卡(含三类卡的已决定投影)照常只读回放。
  assert.match(stream, /const pinnedCard = Boolean\(waiting && currentCard\);/);
  assert.match(stream,
    /view\.items\.filter\(\(item\) =>\s*\n\s*!\(item\.kind === "card" && item\.waiting_id === waitingId\)\)/);
  // #231 改锚:卡座气泡换本页 CONV 词典(conv-* 皮留给任务侧)。
  assert.match(stream,
    /children: <div className=\{cn\(CONV\.card, "border-line-strong"\)\}>\{currentCard\}<\/div>/);
  // 流内卡的回放按 status 给词签(waiting=等待决定/superseded=已作废/
  // 其余=已决定),答案逐题对齐:decision 按题序换行拼接,本题行等于
  // 选项原文即出勾,不等于任何选项=自定义答复回填题面(2026-09-08:
  // 自定义回答只按行找选项,卡上无影无踪)。
  assert.match(stream,
    /item\.status === "waiting" \? "等待决定"\s*\n\s*: item\.status === "superseded" \? "已作废" : "已决定"/);
  assert.match(stream, /conversationCardTitle\(item\)/);
  assert.match(stream, /const answerLines = decision \? decision\.decision\.split\("\\n"\) : \[\]/);
  assert.match(stream, /const custom = line !== "" && !question\.options\.includes\(line\)/);
  assert.match(stream, /自定义答复:\$\{line\}/,
    "选项题的自定义答复带前缀回填题面");
  assert.match(stream, /\? `自定义答复:\$\{line\}` : line\}/,
    "开放题的答案直出,不加自定义前缀");
  // 会话视图:dockRef setState → footerTarget → 当前卡一线到底,dock 门
  // 仍是 waiting && canOperate(查看模式不出 dock)。
  assert.match(sessionView, /footerTarget=\{decisionFooterTarget\}/);
  assert.match(sessionView, /dockRef=\{setDecisionFooterTarget\}/);
  assert.match(stream, /dock=\{waiting && canOperate\}/);
  // 样式落点(#231 改锚):#126 追加块随 issue-workspace 家族退役,
  // dock 内附言段收平由 DecisionDockFoot 统一铺陈;foot-docked 卡的
  // 收尾留白直译成 context/note 上的条件 mb-3.5 工具类。
  assert.match(decisions, /footerTarget && "mb-3\.5"/);
  assert.doesNotMatch(css, /foot-docked/);
});

// ---- 人工接管(2026-09-07 走查拍板):接管=打断 AI;期间人工记录;
// ---- 交还时 AI 带着记录继续。头部紫金徽标 + 输入区 takeover 模式
// ---- (记录到现场/交还给 AI 两钮),api 镜像与 CSS 追加落点对账。

test("人工接管:徽标/下传 takeover/三回调接线/composer 记录+交还两钮/CSS 追加落点", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 头部徽标:detail.takeover 在场即挂「人工接管中」,排在状态徽标之后
  // (横幅态独立于六态;#231 改锚:紫金横幅收进 Badge merge 软皮)。
  assert.match(sessionView,
    /\{detail\.takeover\s*\n\s*&& <Badge variant="merge">人工接管中<\/Badge>\}/);
  assert.doesNotMatch(css, /status-takingover/);
  // 下传与三回调接线:takeover 布尔 + 接管/记录/交还各走各的通道——
  // 接管/交还经 perform(成功带新详情回来,徽标与输入区模式随之翻转),
  // 记录不走 perform(免吞错,失败原样抛回输入区报错)。
  assert.match(sessionView, /takeover=\{Boolean\(detail\.takeover\)\}/);
  assert.match(sessionView,
    /const takeoverNow = \(\) => perform\(\(\) => takeoverIssue\(detail\.id\)\);/);
  assert.match(sessionView,
    /const sendTakeoverNote = \(text: string\) =>\s*\n\s*addIssueTakeoverNote\(detail\.id, text\)\.then\(\(\) => undefined\);/);
  assert.match(sessionView,
    /const resumeTakeover = \(note\?: string\) =>\s*\n\s*perform\(\(\) => resumeIssueTakeover\(detail\.id, note\)\);/);
  assert.match(sessionView, /onTakeover=\{takeoverNow\}/);
  assert.match(sessionView, /onTakeoverNote=\{sendTakeoverNote\}/);
  assert.match(sessionView, /onResumeTakeover=\{resumeTakeover\}/);
  // api 镜像:takeover 字段(与服务端 summarize 同形)+ 三个 POST。
  assert.match(api, /takeover\?: \{ at: string; by: string \};/);
  assert.match(api, /export function takeoverIssue\(/);
  assert.match(api, /export function addIssueTakeoverNote\(/);
  assert.match(api, /export function resumeIssueTakeover\(/);
  // composer:takeover 模式分派在插话/续聊之前(接管=true 一票定音),
  // ctx/占位符口径一致,「记录到现场」「交还给 AI 继续」两钮都在。
  assert.match(stream, /\| \{ kind: "takeover" \}/);
  assert.match(stream, /takeover === true \? \{ kind: "takeover" \}/);
  assert.match(stream, /人工驾驶中——AI 已暂停/);
  assert.match(stream, /placeholder="记录你的人工操作,交还时 AI 会看到这些记录"/);
  assert.match(stream, /记录到现场/);
  assert.match(stream, /交还给 AI 继续/);
  // 样式落点(#231 改锚):手搓 takeover 皮(徽标/双钮)随 issue-workspace
  // 家族退役——「记录到现场」次档描边钮、「交还给 AI 继续」主档实心钮,
  // 语义与排序原样。
  assert.match(stream, /variant="outline" size="sm"[\s\S]{0,200}记录到现场/);
  assert.match(stream, /title="把当前输入作交还说明[\s\S]{0,200}交还给 AI 继续/);
  assert.doesNotMatch(css, /issue-takeover/);
});

// ---- 协作流对齐任务侧会话流(2026-09-08 走查拍板四点):长文量高折叠
// ---- (ClampedText 两域共用一份)、工具步骤 conv-act 按钮切「对话现场」、
// ---- 栏头「全部/需要我的」筛选、检视提交 conv-lead 批次卡。

test("协作流对齐(2026-09-08):量高折叠共用/步骤查看过程/流内筛选/批次卡", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const stream = readFileSync(
    resolve("web/src/issues/IssueConversationStream.tsx"), "utf-8");
  const taskStream = readFileSync(
    resolve("web/src/ConversationStream.tsx"), "utf-8");
  const clamped = readFileSync(resolve("web/src/ClampedText.tsx"), "utf-8");
  // 长文折叠:量高版抽成 ClampedText.tsx,两域同用一份;按字数的旧
  // TurnText 已删(残字数阈值=两域折叠观感漂移的根源)。
  assert.match(clamped, /ResizeObserver/);
  assert.match(taskStream, /import \{ ClampedText \} from "\.\/ClampedText";/);
  assert.match(stream, /import \{ ClampedText \} from "\.\.\/ClampedText";/);
  assert.match(stream, /\{last && <ClampedText text=\{last\.text\} \/\>\}/);
  assert.doesNotMatch(stream, /text\.length <= 1200/,
    "按字数收折的旧 TurnText 必须删干净");
  // 工具步骤:conv-act 按钮(任务侧同款)点开切「对话现场」;只读计数
  // 行(issue-conv-steps)连同样式已删。
  assert.match(stream,
    // #231 改锚:工具步骤按钮换本页 CONV 词典(conv-* 皮留给任务侧)。
    /<button type="button" className=\{CONV\.act\} onClick=\{onOpenEvents\}/);
  assert.match(sessionView, /onOpenEvents=\{\(\) => setTab\("events"\)\}/);
  assert.doesNotMatch(stream, /issue-conv-steps/);
  assert.doesNotMatch(readFileSync(resolve("web/src/tailwind.css"), "utf-8"),
    /\.issue-conv-steps \{/);
  // 流内筛选:栏头「全部/需要我的」(任务侧同款 ws-stream-filters),
  // 「需要我的」口径=还开着的卡;钉在流末的当前卡不受筛选影响。
  // (#210)手搓 role=tablist 换 base-ui Tabs 原语,ws-stream-filters
  // 皮肤类挂在 TabsList 上,键盘箭头归原语,视觉原样。
  assert.match(stream,
    /<TabsList variant="line" aria-label="会话流筛选" className="ws-stream-filters h-auto">/);
  assert.match(stream, /\["all", "全部"\], \["mine", "需要我的"\]/);
  assert.match(stream,
    /filter === "mine"\s*\n\s*\? limited\.filter\(\(item\) => item\.kind === "card" && item\.status === "waiting"\)/);
  // 检视提交:conv-lead 批次卡导语(任务侧 annotations_sent 同款视觉),
  // 不再是无导语的裸正文。
  assert.match(stream,
    // #231 改锚:批次导语换 CONV.lead 词典条目。
    /<p className=\{CONV\.lead\}>提交了 \{item\.count\} 条检视意见给 Agent<\/p>/);
});

test("现场页签对齐(2026-09-08):长内容/结构化内容右侧查看,不再就地展开", () => {
  const events = readFileSync(resolve("web/src/issues/EventsPane.tsx"), "utf-8");
  const eventView = readFileSync(resolve("web/src/eventView.ts"), "utf-8");
  // 预览按钮模式(任务侧 EventValue 同款):>480 字与结构化内容行内只给
  // 预览+「右侧查看 →」,点开在 event-workspace 旁的详情面板看全文。
  assert.match(events, /className="event-value-preview"/);
  assert.match(events, /右侧查看 <i aria-hidden>→<\/i>/);
  assert.match(events, /<div className=\{`event-workspace\$\{detail \? " has-detail" : ""\}`\}>/);
  assert.match(events, /<aside className="event-detail" aria-label="事件完整内容">/);
  assert.doesNotMatch(events, /event-value-expand/,
    "就地 <details> 展开是旧形态,必须删干净");
  // 选中类型两域共用一份(eventView.ts),任务侧 EventTail 同接口。
  assert.match(eventView, /export interface EventDetailSelection/);
  const taskCard = readFileSync(resolve("web/src/TaskCard.tsx"), "utf-8");
  assert.match(taskCard, /type EventDetailSelection,\n\s*\} from "\.\/eventView";|type EventDetailSelection,[^]*from "\.\/eventView";/,
    "任务侧应从 eventView 导入共享选中类型");
});

// ---- 环境快选接入(票 #150,ADR-0020;2026-09-10 走查重铸):闸卡与
// ---- 登记页「只选不手填」——可搜索下拉挑台账条目,搜不到弹共用表单
// ---- 新建并自动选中;选中提交 environment_id,服务端以选定时点快照进
// ---- 会话 vault(前端永远没有密码)。被触碰的区块按 #146 迁 Tailwind。

test("环境闸卡台账快选(#150;只选不手填):可搜索下拉+新建弹框+两段式拒绝;触迁 Tailwind", () => {
  const decisionCard = readFileSync(
    resolve("web/src/issues/IssueDecisionCard.tsx"), "utf-8");
  const picker = readFileSync(
    resolve("web/src/EnvironmentPicker.tsx"), "utf-8");
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 唯一作答面=可搜索下拉:EnvironmentPicker 进场,选中提交
  // environment_id(服务端从台账解密快照,前端零密码),卡面给
  // 「将使用「环境管理」中的 x.x.x.x」的快照说明;手动表单整体退役。
  assert.match(decisionCard,
    /<EnvironmentPicker selectedId=\{picked\?\.id \?\? null\}/);
  assert.match(decisionCard, /environment_id: picked\.id/);
  assert.match(decisionCard, /「环境管理」中的 \{picked\.ip\}/);
  assert.doesNotMatch(decisionCard, /"picker" \| "manual"/);
  assert.doesNotMatch(decisionCard, /存入环境管理/);
  assert.doesNotMatch(decisionCard, /backend_password: backendPassword/);
  // 拒绝两段式(票 93):第一段展开理由框,第二段「确认拒绝」才提交
  //(硬拒绝:同 scope 工具再调不再举卡,值得一步确认)。
  assert.match(decisionCard, /declineOpen/);
  assert.match(decisionCard, /确认拒绝,继续分析/);
  assert.match(decisionCard, /decline: true,/);
  // #146 触碰即迁:表单区块根挂 .tw-root 走工具类;提交区容器
  // (DecisionDockFoot,#231 起工具类化)是四类卡共用的卡座/dock 双上下文铺陈,
  // 按 #146 例外保留 legacy(迁移块内有注释说明)。
  assert.match(decisionCard,
    /tw-root grid gap-\[10px\] px-\[15px\] pt-\[13px\]/);
  assert.match(decisionCard, /<DecisionDockFoot docked=\{Boolean\(footerTarget\)\}/);
  // 共用选择器:可搜索下拉(listbox/option + 搜索框,方向键+回车),
  // 「找不到就新建」弹共用表单,保存回传新条目自动选中(onPick)。
  assert.match(picker, /listEnvironments/);
  assert.match(picker, /onPick: \(entry: EnvironmentView\) => void/);
  // #212 起内层清单换 Command(cmdk):listbox/option 语义、方向键高亮、
  // 高亮行滚入视口与行 hover 底色全归原语;页面保留搜索过滤与选中
  // 标记(onSelect → onPick,data-checked 勾选态)。
  assert.match(picker, /<CommandList className="max-h-60" aria-label="环境清单">/);
  assert.match(picker, /<CommandItem key=\{entry\.id\} value=\{entry\.id\}/);
  assert.match(picker, /data-checked=\{picked \|\| undefined\}/);
  assert.match(picker, /onSelect=\{\(\) => pick\(entry\)\}/);
  assert.match(picker, /EnvironmentEditorDialog/);
  assert.match(picker, /onPick\(entry\)/);
  assert.match(picker, /tw-root/);
  assert.match(picker, /entry\.ip/);
  assert.doesNotMatch(picker, /password/i, "台账视图零密码字段");
  // wire 镜像(#150 新键仍在册;root_password/save_to_registry 只服务
  // 登记弹框,服务端契约不变)。
  assert.match(apiTypes, /environment_id\?: string/);
});

test("登记页从环境管理选(#150;只选不手填):常驻快选/提交 environment_id/页面凭据已废弃(#230 改锚)", () => {
  const registration = readFileSync(
    resolve("web/src/issues/Registration.tsx"), "utf-8");
  // 常驻快选(可搜索下拉,自带「找不到就新建」弹框):不再有展开/收起
  // 开关,更没有手填回退。
  assert.match(registration,
    /<EnvironmentPicker\s*\n\s*selectedId=\{pickedEnv\?\.id \?\? null\} onPick=\{pickEnv\} \/>/);
  assert.doesNotMatch(registration, /收起环境列表/);
  assert.doesNotMatch(registration, /清除,改用手动填写/);
  // 选中给台账快照说明(已存后台密码),提交只带 environment_id;
  // 页面账号/页面密码整体废弃(2026-09-10),登记页不得回流采集面。
  assert.match(registration, /将使用「环境管理」里/);
  assert.match(registration, /environment_id: pickedEnv\.id/);
  assert.doesNotMatch(registration, /page_password:|页面账号 <i|页面密码 <i/);
  // 未选环境提交被拦,文案指路下拉里的「新增环境」。
  assert.match(registration, /请从环境管理选择网管环境/);
});

test("问题列表卡:整卡新页签直达工作台(ADR-0040),展开态与逐卡轮询退役", () => {
  const ui = readFileSync(resolve("web/src/components/ui/card.tsx"), "utf-8");
  // 整卡=拉伸锚点(absolute inset-0 盖满卡面,新页签打开 /issues/:id):
  // 路径单源 issueLink.ts;task-summary 退为布局容器,不再承载点击。
  // 展开体/展开箭头/展开状态机清零。
  assert.match(issueBoard,
    /<a className="absolute inset-0 z-\[1\]"\s*\r?\n\s*href=\{issueSessionPath\(issue\.id\)\}/);
  assert.match(issueBoard, /title="在新页签打开问题工作台"/);
  assert.match(issueBoard, /import \{ issueSessionPath \} from "\.\/issueLink";/);
  assert.match(issueBoard, /<div className="task-summary">/);
  assert.doesNotMatch(issueBoard,
    /aria-expanded|setExpanded|task-detail-body|task-chevron/);
  // 卡内动作与拉伸锚点是兄弟关系(锚点嵌锚点是非法 HTML):单号链接
  // 与 meta 行以 z-10 浮在锚点上方,stopPropagation 随按钮壳退役。
  assert.match(issueBoard, /task-ticket relative z-10/);
  assert.match(issueBoard, /className="task-meta relative z-10"/);
  assert.doesNotMatch(issueBoard, /stopPropagation/);
  // 文字入口「进入问题工作台」删除——点击即达,不留第二入口;
  // 直达终止(2026-09-08)保留,终态卡不渲染终止钮的口径不变。
  assert.doesNotMatch(issueBoard, /panel-link/);
  // #219 终止钮随 ui.css 退役换 shadcn Button:ghost 皮 + 危险字色 +
  // hover 下划线,零盒感混排 task-meta 的形态原样保留。
  assert.match(issueBoard,
    /terminatable && <Button type="button" variant="ghost" size="sm"\s*\r?\n\s*className="h-auto px-0 font-semibold text-destructive/);
  assert.match(issueBoard, /action: "cancel"/);
  // 皮肤换 shadcn Card;现场直播(SSE)与耗时卡点(时间线拉取)不再被
  // 列表引用——这两类请求只属于工作台,列表不得回流。
  assert.match(issueBoard, /import \{ Card \} from "\.\.\/components\/ui\/card";/);
  assert.doesNotMatch(issueBoard, /IssueEventsPane|IssueCostPanel/);
  // 轮询边界:列表 5s 可见轮询保留(列表活性唯一来源),工作台内 10s
  // 详情跟随保留;除此之外没有别的循环请求。
  assert.match(issueBoard, /startVisiblePolling\(refreshList, 5000, document\)/);
  assert.match(issueBoard, /if \(!openId\) return;/);
  // 状态轨走令牌工具类(挂起状态已退役,轨映射不再有 suspended 键;
  // 令牌 --suspended 留给工作流归档弱底等色板消费,#233 改锚:令牌
  // 定义并入 tailwind.css)。卡片轨道与状态胶囊不得再写裸色值(工作台
  // 页签等处的同名存量字面量另有专项,不在本契约)。
  assert.doesNotMatch(issueBoard, /suspended: "bg-suspended"/);
  const tokens = readFileSync(resolve("web/src/tailwind.css"), "utf-8");
  assert.match(tokens, /--suspended: #3b83d5/);
  assert.doesNotMatch(css, /status-suspended \.task-status-rail/);
  assert.doesNotMatch(css, /\.pill\.suspended \{ color: #3b83d5/);
  // 等待/闲置光效必须住在非分层附录(层序里只有非分层规则能压过卡片皮
  // 的 bg-card/border-* 工具类);在 legacy 层会被静默压掉,不许回流。
  const annex = css.indexOf("非分层附录");
  const halo = css.indexOf(".issue-card-large.status-waiting_user {");
  assert.ok(annex > -1, "非分层附录标记缺失");
  assert.ok(halo > annex, "光效应住在附录里");
  // Card 基座显式 border-solid:legacy DOM 没有 .tw-root 归一,
  // border-width 不带 style 会落到初始值 none。
  assert.match(ui, /rounded-lg border border-solid/);
});

test("问题工作台独立页签(ADR-0040):入口一律新页签,页内 overlay 退役", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const issueLink = readFileSync(
    resolve("web/src/issues/issueLink.ts"), "utf-8");
  const teamIssueCard = readFileSync(
    resolve("web/src/issues/TeamIssueCard.tsx"), "utf-8");
  // 深链路径单源:issueLink.ts 是前端唯一拼写处(卡片/徽标/团队卡同吃)。
  assert.match(issueLink,
    /\/issues\/\$\{encodeURIComponent\(id\)\}/);
  // 工作台是页面不再是弹层:dialog/aria-modal 语义退役;页签标题钉成
  // 会话标题(2026-09-18 修订:不带单号——记不住,辨识靠标题),多开
  // 页签可辨识。
  assert.doesNotMatch(sessionView, /role="dialog"|aria-modal/);
  assert.match(sessionView, /document\.title = detail\.title;/);
  // App 层:openIssueSession 是页内切会话的写入口(历史触发者「挂起
  // 转正」已退役,管道保留),closeIssueSession
  // pushState 裸 /issues 留历史(浏览器后退回工作台),不依赖 window.close。
  assert.match(appSource,
    /const closeIssueSession = \(\) => \{\s*const repair = issueRouteId\.startsWith\("mr-repair-"\);\s*history\.pushState\(appHistoryState\("issues", undefined, repair \? "pipeline" : "sessions"\),\s*"", repair \? "\/pipeline-repairs" : "\/issues"\);/);
  assert.doesNotMatch(appSource, /window\.close\(\)/);
  // 团队问题卡:整行即新页签链接,不再回调跳转。
  assert.match(teamIssueCard,
    /href=\{issueSessionPath\(issue\.id\)\} \/>/);
  assert.doesNotMatch(teamIssueCard, /onOpen/);
  // 渲染门页面形态:URL 指向会话时整页只有工作台——加载态/失败态
  // (重试 + 返回)自渲染,列表不再叠在底下当背景。
  assert.match(issueBoard, /if \(openId\) \{/);
  assert.match(issueBoard, /正在打开问题工作台…/);
  assert.match(issueBoard, /onClick=\{\(\) => setDetailRetry\(\(count\) => count \+ 1\)\}>重试/);
  // 登记成功不自动跳(异步回调 window.open 会被弹窗拦截器杀掉):
  // 手工登记成功横幅给「打开问题会话」链接(新页签,2026-09-21 起小字
  // 提示升横幅,防"以为没发起")。
  assert.match(registration,
    /href=\{issueSessionPath\(lastCreated\.id\)\}/);
  assert.match(registration, /打开问题会话 ↗/);
});

test("DTS 单号在两个列表里都是门户超链接", () => {
  // URL 构造器单源:dtsTicket.ts 是前端唯一拼写处;示例即用户给的
  // 真实门户地址形态,拼错一个字符就该红。
  const dtsTicket = readFileSync(
    resolve("web/src/issues/dtsTicket.ts"), "utf-8");
  assert.match(dtsTicket, /dts\.example\.com/);
  assert.match(dtsTicket, /\/DTSPortal\/ticket\/\$\{encodeURIComponent\(ticket\)\}/);
  // DTS 列表:单号格是真锚点(新开页签),不再是纯文字 span。
  assert.match(registration,
    /href=\{dtsTicketUrl\(ticket\.ticket\)\}\s*target="_blank" rel="noreferrer"/);
  assert.match(registration, /import \{ dtsTicketUrl \} from "\.\/dtsTicket";/);
  // 问题会话列表卡:单号链接与整卡拉伸锚点是兄弟(ADR-0040),单号
  // relative z-10 浮在锚点上方——点单号开 DTS,拉伸锚点不接事件,
  // 无需也不再有 stopPropagation。
  assert.match(issueBoard,
    /task-ticket relative z-10[\s\S]{0,120}href=\{dtsTicketUrl\(issue\.ticket\)\}/);
  assert.match(issueBoard, /import \{ dtsTicketUrl \} from "\.\/dtsTicket";/);
});

// ---- 元信息首签(#239 只读版):登记信息 + 关联仓清单,编辑器在 #241 ----

test("元信息页签居首(#239):登记四项只读、绑定标、终态只读、回收标注", () => {
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  const metaPane = readFileSync(
    resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  // 页签首位:meta 占 ISSUE_MAIN_TABS 第 0 位(label「元信息」,一签一色
  // 照旧自带 --workspace-tab-color 变量工具类);默认选中是元信息
  // (ADR-0027:对话现场降末位,右栏直播兜住看现场的刚需)。
  const table = sessionView.match(
    /const ISSUE_MAIN_TABS = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
  const tabs = [...table.matchAll(/key: "([a-z]+)", label: "([^"]+)"/g)]
    .map(([, key, label]) => `${key}:${label}`);
  assert.equal(tabs[0], "meta:元信息", "元信息必须在页签条首位");
  assert.match(sessionView, /useState<IssueMainTab>\("meta"\)/);
  // 面板映射:meta 有自己的 TabsContent 分支(canOperate 随行——拉取
  // 日志的意图递交是写口,查看模式不渲染),材料兜底分支不再吃 meta 值。
  assert.match(sessionView,
    /\{tab === "meta" && <TabsContent value="meta" className="contents">\s*\n\s*<IssueMetaPane detail=\{detail\} canOperate=\{canOperate\} \/>/);
  assert.match(sessionView,
    /tab !== "events" && tab !== "meta"/);
  // 元信息字段(只读平铺,ADR-0026):「登记信息」壳已退役,四类字段
  // 直接平铺;标题/问题描述挂 detail.ticket 门——有单会话不渲染(单据
  // 页签是唯一权威出处,DTS 发起时描述只是单据标题的抄本),业务模块/
  // 网管环境两场景都显。
  assert.doesNotMatch(metaPane, /aria-label="登记信息"/);
  assert.match(metaPane,
    /\{!detail\.ticket && <>\s*\n\s*<MetaField label="标题">/);
  for (const label of ["标题", "问题描述", "业务模块", "网管环境"]) {
    assert.ok(metaPane.includes(`>{label}</span>`), `元信息缺「${label}」行`);
  }
  // 网管环境给名称+IP+端口+形态,形态中文与编辑弹框同源(import
  // ENVIRONMENT_FORM_TEXT,不重抄);未配置如实示「尚未配置」加引导
  // (等 AI 举卡回填),不设第二编辑入口;空值如实降级(「(未填)」),
  // 凭据类字段零出现(含注释也不带字面量,防止将来顺手渲染)。
  assert.match(metaPane, /import \{ ENVIRONMENT_FORM_TEXT \} from "\.\.\/EnvironmentEditorDialog"/);
  assert.match(metaPane, /ENVIRONMENT_FORM_TEXT\[envType\]/);
  assert.match(metaPane, /尚未配置/);
  assert.match(metaPane, /\(未填\)/);
  // 日志的人读出口(#267,ADR-0026):「下载日志」挂在网管环境区,
  // 判定信号 = 材料清单里的日志文件数(无独立状态位),整包 zip;
  // 下载是纯读,查看模式不收闸。
  assert.match(metaPane, /materials\.logs\.entries/);
  assert.match(metaPane, /materials\/logs\/archive/);
  assert.match(metaPane, /"下载日志"/);
  // 清单撞条数帽必须如实披露(打包以清单为界,旧日志页签同款诚实原则)。
  assert.match(metaPane, /可能不完整/);
  assert.doesNotMatch(metaPane, /credential_ref|password/i,
    "元信息面板不得出现凭据类字段");
  // 关联仓清单区(ADR-0027 融合交付事实):模块绑定仓带「模块绑定」
  // 标识,绑定集合组件内经 getBusinessModules 按 module_id 解析;绑定
  // 比对与后端门禁同一把归一尺(repoIdentity),不原样字符串比对。
  assert.match(metaPane, /aria-label="关联仓清单"/);
  assert.match(metaPane, />模块绑定<\/Badge>/);
  assert.match(metaPane, /getBusinessModules\(\)/);
  assert.match(metaPane,
    /repoIdentity\(item\) === repoIdentity\(row\.repo\)/);
  // 回收标注:repo_reclaimed_at 在场即如实标注「现场已回收」,不冒充在场。
  assert.match(metaPane,
    /detail\.repo_reclaimed_at && <div className="utility-note"/);
  assert.match(metaPane, /现场已回收/);
  // 终态只读:#241 编辑区挂载点受终态闸门控制,终态会话(与协作流
  // ended 同口径的 archived/canceled/failed)永远不渲染编辑入口;
  // 非终态时挂载点内是关联仓编辑器(#241,形状见下一 test)。
  assert.match(metaPane,
    /const isTerminal =\s*\n\s*\(TERMINAL_STATUSES as readonly string\[\]\)\.includes\(detail\.status\);/);
  assert.match(metaPane,
    /\{!isTerminal && detail\.scenario !== "mr_repair" && <section aria-label="调整关联仓"/);
});

// ---- 主动拉取日志(#268,ADR-0026):按钮=意图递交,Agent 主理第二例 ----

test("拉取日志意图递交(#268):按钮只递意图,端点守卫+留痕+发送,平台不代拉", () => {
  const metaPane = readFileSync(
    resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");
  const routesSource = readFileSync(resolve("src/issueFlow/routes.ts"), "utf-8");
  const serviceSource = readFileSync(resolve("src/issueFlow/service.ts"), "utf-8");
  const notices = readFileSync(resolve("assets/issue-prompts/notices.md"), "utf-8");
  // 端点契约:POST /issues/:id/logs/fetch,写闸仅归属人(管理员不写,
  // 与调整关联仓同款)。
  assert.match(apiSource, /export function requestIssueLogFetch\(/);
  assert.match(apiSource,
    /issueFetch\(`\/issues\/\$\{encodeURIComponent\(id\)\}\/logs\/fetch`/);
  assert.match(routesSource,
    /parts\[2\] === "logs"\s*\n\s*&& parts\[3\] === "fetch"/);
  assert.match(routesSource, /只能请求拉取自己会话的日志/);
  // 服务面:终态/queued 守卫 + 留痕 + startPlatformTurn 同一咽喉
  // (忙=steer/等人=便签/空闲=开回合)。
  assert.match(serviceSource, /requestLogFetch\(id: string\)/);
  assert.match(serviceSource, /promptCopy\("notices", "logs\.fetch"\)/);
  // 通知词是协议:执行者指引(fetch-logs 技能 + 缺环境举卡)与重复拉取
  // 护栏(已拉取过先向用户确认)必须在场——护栏在文案不在门禁。
  assert.match(notices, /## logs\.fetch/);
  assert.match(notices, /fetch-logs/);
  assert.match(notices, /已拉取过/);
  // 页面:无日志的非终态会话才出钮(有日志后由「下载日志」替代),
  // 写口收 canOperate(意图递交是写);点击后就地「已通知 Agent」管理
  // 时延预期(排队+SSH 拉取分钟级,清单靠 updated_at 轮询自刷)。
  assert.match(metaPane, /!isTerminal && canOperate && logFileCount === 0/);
  assert.match(metaPane, /requestIssueLogFetch\(detail\.id\)/);
  assert.match(metaPane, /已通知 Agent 拉取/);
});

// ---- 工作台页签收敛(ADR-0027):逐仓交付融合进元信息,拉取钮环境门 ----

test("交付事实融入关联仓行(ADR-0027):perRepo 纯函数原样复用,零新数据源", () => {
  const metaPane = readFileSync(
    resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  // 呈现派生复用 perRepo 的三个纯函数(有推送记录=变更仓;流水线徽标
  // 只认 pipelines 该仓 status);数据全部来自会话详情,零新数据源。
  assert.match(metaPane, /repoDeliveryRows\(/);
  assert.match(metaPane, /repoPipelineBadge\(/);
  assert.match(metaPane, /repoRole\(/);
  // 转正前账只读引用随迁(inherited_accounts → 旧会话账)。
  assert.match(metaPane, /useInheritedLedger\(/);
  // 逐仓交付的组件族在 SessionView 整体退役(融合,不留死代码)。
  assert.doesNotMatch(sessionView,
    /RepoDeliveryCard|IssueRepoDelivery|IssueWorkspaceRepos|useInheritedLedger/);
  // 区块名保持「关联仓清单」,副标题退役(从简)。
  assert.match(metaPane, /关联仓清单/);
  assert.doesNotMatch(metaPane, /发起时登记的全部代码仓/);
});

test("拉取钮环境门(ADR-0026 翻案):环境未配置不渲染,空态文案从简", () => {
  const metaPane = readFileSync(
    resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  // 拉取意图递交的前置是环境在场——早期会话常在等卡作答,此时点击
  // 只落一张等卡答完才被看到的便签(issue-10 实锤),按钮近似白点。
  assert.match(metaPane, /logFileCount === 0 && detail\.environment/);
  assert.match(metaPane, /尚未配置——AI按需配置/);
});

// ---- 关联仓清单编辑器(#241):缓冲 diff 门禁 + 端点契约,不乐观更新 ----

test("关联仓编辑器(#241):绑定仓零按钮、确定 diff 门禁、https 即时校验、不乐观更新", () => {
  const metaPane = readFileSync(
    resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  const apiSource = readFileSync(resolve("web/src/api.ts"), "utf-8");
  // 端点契约(与后端钉死):POST /issues/:id/repos,body { add, remove }
  // (至少一边非空由服务端校验);成功 = HTTP 2xx 会话概要(与 reply 类
  // 端点同款),失败经 issueFetch 抛服务端人话中文 message。
  assert.match(apiSource, /export function requestIssueRepoChanges\(/);
  assert.match(apiSource,
    /issueFetch\(`\/issues\/\$\{encodeURIComponent\(id\)\}\/repos`/);
  assert.match(apiSource, /input: \{ add: string\[\]; remove: string\[\] \}/);
  // 删除按钮规则:移除/撤销移除按钮挂在 `!isTerminal && registered && !bound`
  // 一道门后——模块绑定仓是团队资产、账外仓不在登记清单,行内连按钮都
  // 不渲染(不是置灰)。
  assert.match(metaPane,
    /\{!isTerminal && detail\.scenario !== "mr_repair" && registered && !bound && \(queued\s*\n\s*\? <Button variant="outline"/);
  assert.equal(
    (metaPane.match(/variant="destructive" size="xs"/g) ?? []).length, 1,
    "移除按钮唯一(非绑定仓清单行),不给绑定仓另配删除口");
  // 移除入缓冲,不就地改清单:按钮只把仓地址(ADR-0027 起为交付行的
  // row.repo)挪进 pendingRepoRemove。
  assert.match(metaPane,
    /setPendingRepoRemove\(\s*\n\s*\[\.\.\.pendingRepoRemove, row\.repo\]\)/);
  // 确定门禁:缓冲 diff 为空禁用(缓冲非空才可点),提交中同样禁用。
  assert.match(metaPane,
    /const repoDiffEmpty =\s*\n\s*pendingRepoAdd\.length === 0 && pendingRepoRemove\.length === 0;/);
  assert.match(metaPane, /disabled=\{repoDiffEmpty \|\| repoSubmitting\}/);
  // https 即时校验(与后端同款口径前置,别等服务端打回):https:// 前缀
  // /不与现清单重复;数量上限已废除(ADR-0054),前端不得再有同尺预判;
  // 错误就地小字(role=alert)。
  assert.match(metaPane, /startsWith\("https:\/\/"\)/);
  assert.match(metaPane, /该仓已在关联仓清单里,不重复添加/);
  assert.doesNotMatch(metaPane, /MAX_ISSUE_REPOS|最多拉取/);
  // 不乐观更新(项目原则:UI 只做状态显示):清单数据源仍是 detail,
  // MetaPane 无任何改写 detail 的回调/状态;提交成功只清缓冲 + 如实状态
  // 提示(「已通知 Agent 处理」),绝不写「删除成功」。
  assert.match(metaPane, /const repos = detail\.repo_urls\?\.length/);
  assert.doesNotMatch(metaPane, /onChanged|setDetail\(/);
  assert.match(metaPane, /已通知 Agent 处理,清单将在 Agent 执行后更新/);
  assert.doesNotMatch(metaPane, /删除成功|移除成功/);
});

test("只读参考件入卡(#425,ADR-0054):四类身份徽标同 pane 分组陈列", () => {
  const metaPane = readFileSync(resolve("web/src/issues/MetaPane.tsx"), "utf-8");
  // 元信息页签的关联仓清单即仓卡面:模块绑定/用户指派徽标打在登记
  // 仓行上;参考仓与知识仓是只读参考件,独立分组「装了才出」。
  assert.match(metaPane, /title="运行中经元信息页签指派的仓\(ADR-0023 通道\)">用户指派<\/Badge>/);
  // 用户指派的权威口径 = 指派台账(assigned_repos):登记自带仓不误标。
  assert.match(metaPane, /\(detail\.assigned_repos \?\? \[\]\)\.some\(\(item\) =>/);
  assert.match(metaPane, /aria-label="关联仓清单"/);
  assert.match(metaPane, /只读参考件/);
  assert.match(metaPane, /detail\.public_repos\?\.\s*length/);
  assert.match(metaPane, />参考仓·只读<\/Badge>/);
  assert.match(metaPane, /detail\.knowledge_repo\?\.status === "ready"/);
  assert.match(metaPane, />知识仓·只读<\/Badge>/);
  // 知识仓此前只在过程记录里露面;上 wire 后镜像已补(api.ts),服务端
  // summarize 不再剥离该键(契约对账样例同步补 undefined)。
  const apiMirror = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.match(apiMirror, /public_repos\?: Array<\{ url: string; name: string; at: string \}>/);
  assert.match(apiMirror, /knowledge_repo\?: \{/);
});

// ---- #256 扫尾:焦点行断供回场、裸钮收编 ----

test("列表卡焦点行:task-focus 家族 utilities 直译(#256),版式与状态点回场", () => {
  // 旧 .task-focus 网格(7px 点轨/阶段强字/结论省略)随 style.css 退役后,
  // IssueBoard 的类名引用成了断供(清扫确凿丢失 #1)——按二期口径在
  // markup 直译 utilities,不经 tailwind.css;vestigial 类名一并退役。
  // 阶段变体(human_action/blocked/external/done/inactive)是任务域词表,
  // 从未命中问题域 stage,不搬。
  assert.doesNotMatch(issueBoard, /task-focus/);
  assert.match(issueBoard,
    /grid-cols-\[7px_max-content_minmax\(0,1fr\)\] items-center gap-\[7px\]/);
  assert.match(issueBoard, /<i aria-hidden className="size-1\.5 rounded-full bg-active" \/>/);
  assert.match(issueBoard,
    /<strong className="text-sm font-bold text-text-strong">\{stageLine\}<\/strong>/);
  assert.match(issueBoard, /<span className="truncate">结论 · /);
});

test("裸 button 收编(#256):常规动作钮走 shadcn Button,领域件不动", () => {
  // 看板错误横幅的两枚文字动作(跳设置/关提示)换 link 皮;发起成功
  // 横幅的关提示同款收编(2026-09-21)。换装后看板裸钮只剩整卡进工作台
  // 的 task-summary(契约另锚,机构保留)。
  assert.match(issueBoard, /variant="link"/);
  assert.equal((issueBoard.match(/variant="link"/g) ?? []).length, 3,
    "横幅三枚文字动作各一枚 link,不多收");
  assert.doesNotMatch(issueBoard,
    /className="cursor-pointer underline underline-offset-2"/);
  // 会话页认证报错的补救入口同款 link 皮(修归属人凭据,查看模式不渲染)。
  const sessionView = readFileSync(
    resolve("web/src/issues/SessionView.tsx"), "utf-8");
  assert.match(sessionView,
    /<Button type="button" variant="link"[\s\S]{0,220}去个人设置配置令牌\s*<\/Button>/);
  // 关联卡(校验/转正两枚动作钮)已随 #434 转正退役整体删除,文件不
  // 在即契约满足;若以新形态回流,按 shadcn Button 收编纪律另立新锚。
  assert.ok(!existsSync(resolve("web/src/issues/IssueAssociateCard.tsx")),
    "转正关联卡应已退役删除(#434)");
});

test("会话列表单一口径(ADR-0031,2026-09-16 修订):归属或登记人是自己,卡片并列两端", () => {
  // 两范围切换已撤(对测试是空列表落地、对自登记是两处重复):
  // 列表回到「我的问题」单一口径,两端标注靠卡片不靠范围。
  assert.doesNotMatch(issueBoard, /listScope|我负责的|我登记的|issue-list-scope/);
  assert.match(issueBoard,
    /viewer\.role === "admin" \? "全部问题" : "我的问题"/);
  assert.match(issueBoard, /责任人 · \{issue\.account\}/);
  assert.match(issueBoard, /登记人 · \{issue\.reporter\}/);
});

test("登记页责任人指派接线(ADR-0031):选人框进表单、缺省纯函数唯一裁决、凭据门查责任人", () => {
  // 选人搜索框进登记表单(复用 UserPicker,不手搓);缺省/冻结规则
  // 不在组件里散写——唯一裁决在 resolveAssignee 纯函数。
  assert.match(registration, /import \{ userLabel, UserPicker, type UserOption \} from "\.\.\/UserPicker";/);
  assert.match(registration, /import \{ resolveAssignee \} from "\.\/assigneeDefault";/);
  assert.match(registration, /resolveAssignee\(\{\s*manualPick: assigneeManual,/);
  assert.match(registration,
    /<UserPicker value=\{assignee\} options=\{assigneeOptions\}\s*onChange=\{setAssigneeManual\} ariaLabel="责任人"/);
  // 候选走 flow=issue 固定口径(只认 Git 凭据,不问通知服务令牌);
  // 模块责任人+维护者置顶带标记。
  assert.match(registration, /listCollaborationAssignees\("issue"\)/);
  assert.match(registration, /"模块责任人"/);
  assert.match(registration, /"模块维护者"/);
  // 凭据门查的是责任人不是登记人:提交拦截文案点名责任人。
  assert.match(registration, /credentialBlocked = Boolean\(assignee\)/);
  assert.match(registration, /的 Git 凭据未配齐——改选已配齐的责任人/);
  // 登记请求带责任人;成功后重置回缺省(手选清空,下一条重新跟模块)。
  assert.match(registration, /assignee,\s*\}\);/);
  assert.match(registration, /setAssigneeManual\(""\)/);
});

test("资源屏蔽提示条跨全列、样式走工具类轨道(2026-09-14 设计审查 04)", () => {
  // 组件布局中性(登记页/发起页网格各自落位),登记侧包 col-span-full
  // 落位,首行不再右半空格;inline style 硬编码字号随提示条退役。
  assert.match(registration,
    /<div className="col-span-full">\s*<RepositoryResourceNotice/);
  assert.doesNotMatch(notice, /style=\{\{/);
  assert.match(notice,
    /rounded-\[10px\] border border-line bg-surface-muted px-3\.5 py-2\.5 text-\[13px\]/);
  assert.match(notice, /border-current text-inherit"\s*onClick=\{\(\) => setOpen\(true\)\}\s*>\s*查看详情/);
});

test("DTS「进行中」入口链接级可供性;进行态读屏可达;详情长链断行(2026-09-14 设计审查 02)", () => {
  // 徽标是静态胶囊,悬停底色辨不出可点:内层文字挂与单号链接同款的
  // hover 下划线,键盘聚焦同款(focus-visible);下划线挂行内文字盒,
  // 不依赖穿透 inline-flex。ADR-0040 起徽标整体是新页签锚点(等价复刻
  // ghost/xs 盒感 + 自带 focus-visible:ring 锚点类),group/live 结构
  // 钩子防脱落。
  assert.match(registration,
    /className="group\/live inline-flex h-6 items-center/);
  assert.match(registration, /focus-visible:ring-3 focus-visible:ring-ring\/50/);
  assert.match(registration,
    /group-hover\/live:underline group-focus-visible\/live:underline/);
  // 上传进行态挂 role=status,与其余进行态一致;指示住编辑器内右上角
  // (DescriptionEditor 自持),登记页脚不再重复一份。
  assert.match(descriptionEditor,
    /<span role="status"\s+className="absolute right-2 top-2[^"]*">/);
  assert.match(descriptionEditor, /截图上传中…/);
  // 列设置触发钮是弹层出口,不是切换钮:aria-pressed 撤下,开合语义
  // 归 Popover 原语自带的 aria-haspopup/aria-expanded。
  assert.doesNotMatch(registration, /aria-pressed=\{moduleCol\}/);
  // 展开详情随 ADR-0056 退役(详情长链断行随行尾格一并退场):单号
  // 直达 DTS 门户,格内截断 + title 全文,长链不撑破表格。
  assert.match(registration,
    /issue-dts-ticket block min-w-0 truncate/);
});

test("外部图片粘贴按 src 协议三路转存,Clipboard 死路不回潮(#276)", () => {
  // 生产是 HTTP(非安全上下文),异步 Clipboard API 不可用——拦截
  // 成功等于吞掉整段粘贴的死路已删;data: 字节就在 src 里,本地转
  // Blob 即可,不再舍近求远。登记编辑器与会话粘贴钩子同款红线。
  for (const source of [descriptionEditor, imagePaste]) {
    assert.doesNotMatch(source, /navigator\.clipboard/);
    assert.doesNotMatch(source,
      /htmlIsImageOnly|readClipboardImageFile|FALLBACK_HINT/);
    assert.match(source, /proxyIssueImage/);
    assert.match(source, /classifyExternalImageSrc|isHostedImageSrc/);
  }
  // 三路协议分类只住 useIssueImagePaste 一处,防两份实现漂移。
  assert.match(imagePaste, /\^data:image\\\//);
  assert.match(imagePaste, /\^https\?:\\\/\\\//);
  // 路由层协议白名单兜一道:file:/// 前端拦了,后端再拒一次。
  assert.match(issueRoutes, /proxy-image/);
  assert.match(issueRoutes, /\^https\?:\\\/\\\//);
  // 非图片 content-type 拒收(需认证上游典型回 HTML 登录页),不落垃圾。
  assert.match(issueRoutes, /startsWith\("image\/"\)/);
  // 外链转存(data: 直传与 http(s) 代理)也计入上传进行态浮层。
  assert.match(descriptionEditor, /trackPending/);
  assert.match(descriptionEditor, /trackUpload\(pasteImageFile\(blob\)\)/);
});

test("登记描述编辑器选型:Quill 壳 + 恒 markdown 存储,可回退(#271)", () => {
  // 选型常量单点:翻转即回退 milkdown,存储零迁移——两壳同一契约。
  assert.match(editorChoice, /USE_RICH_TEXT_DESCRIPTION_EDITOR = true/);
  assert.match(registration, /USE_RICH_TEXT_DESCRIPTION_EDITOR\s*\n?\s*\? <RichTextEditor/);
  // Quill 只是输入壳:进出各一次 md↔HTML 转换,粘贴拦截随行(#276)。
  assert.match(richTextEditor, /markdownToEditorHtml/);
  assert.match(richTextEditor, /editorHtmlToMarkdown/);
  assert.match(richTextEditor, /dangerouslyPasteHTML/);
  assert.doesNotMatch(richTextEditor, /navigator\.clipboard/);
  assert.match(richTextEditor, /classifyExternalImageSrc|isHostedImageSrc/);
  assert.match(richTextEditor, /proxyIssueImage/);
  // 上传进行态浮层契约随壳迁移(role=status + 截图上传中…)。
  assert.match(richTextEditor, /role="status"/);
  assert.match(richTextEditor, /截图上传中…/);
});

test("DTS 发起单入口唯一:顶部一枚发起钮,浮动发起条退役(2026-09-15)", () => {
  // 浮动发起条(设计审查 03)与顶部钮双入口被判冗余退役:发起只留
  // 顶部一枚,未勾选时置灰但常驻——可发现性靠它常在,不靠浮现。
  assert.doesNotMatch(registration, /sticky bottom-3/);
  assert.doesNotMatch(registration, /清空选择/);
  // 文案与说明一处定义、单点消费:发起钮全页仅一枚,锚计数防双入口回潮。
  assert.match(registration, /const launchTitle = selected\.length > 1/);
  assert.equal((registration.match(/title=\{launchTitle\}/g) ?? []).length, 1,
    "发起钮仅顶部一枚");
  assert.equal((registration.match(/\{launchLabel\}/g) ?? []).length, 1,
    "发起钮文案仅顶部一处");
});

test("描述预填模板:打开即模板,原样拦截,提交后回模板(#273,ADR-0030)", () => {
  // 润色退役后格式合规靠预填:模板住独立常量模块,登记页三处消费——
  // 初始态预填、提交原样拦截、提交成功重置回模板(不再重置空串)。
  assert.match(registration, /from "\.\/descriptionTemplate"/);
  assert.match(registration, /useState\(ISSUE_DESCRIPTION_TEMPLATE\)/);
  assert.match(registration, /isUntouchedTemplate\(description\)/);
  assert.match(registration, /描述还是模板原样/);
  assert.match(registration, /setDescription\(ISSUE_DESCRIPTION_TEMPLATE\)/);
  // 空串重置不回流:描述框只以模板或用户内容呈现。
  assert.doesNotMatch(registration, /setDescription\(""\)/);
});

test("发起即终止草稿+清空重填(2026-10-15 拍板)", () => {
  // 草稿=未兑现的登记意图:发起成功显式删本地草稿并整表重置(含产品
  // 版本),不靠 400ms 防抖写间接刷新——那笔写被刷新/关页取消时旧草稿
  // 原地存活,下次打开整份旧内容回魂。清空重填是填一半放弃重来的确定
  // 出口,破坏性动作走全站 confirmDialog 二次确认(spec #52)。
  assert.match(registration, /function resetRegistration/);
  assert.match(registration, /localStorage\.removeItem\(draftKey\)/);
  assert.match(registration, /setProductVersion\(""\)/);
  assert.match(registration, /resetRegistration\(\);/);
  assert.match(registration, /清空重填/);
  assert.match(registration, /confirmDialog\(\{/);
});

test("AI 润色退役反钉(#272,ADR-0030):入口与通路不回潮", () => {
  assert.doesNotMatch(registration, /润色|polish/i);
  if (issueFlow) assert.doesNotMatch(issueFlow, /AI 润色|polish-description/);
});

test("工作区变更聚合视图按仓分段:服务端标记切片,聚焦视图不分段(ADR-0032)", () => {
  const pane = readFileSync(resolve("web/src/issues/MaterialsPane.tsx"), "utf-8");
  // 多仓默认视图按仓分段展示(用户拍板"工作区变更按代码仓分开显示"):
  // 切片用 perRepo 的 splitDiffByRepo(服务端分段标记唯一权威),仓头
  // 落段、标记行不进 diff 正文;单仓与药丸聚焦视图保持单块渲染。
  assert.match(pane, /!diffRepo && diffRepos\.length > 1/);
  assert.match(pane, /splitDiffByRepo\(activeDiff\)\.map/);
  assert.match(pane, /from "\.\/perRepo"/);
  // 空态口径单一来源:常量一处定义、分段与聚焦两处消费。
  assert.match(pane, /const EMPTY_REPO_DIFF_NOTE = "该仓当前没有可展示的改动。"/);
  assert.equal((pane.match(/EMPTY_REPO_DIFF_NOTE/g) ?? []).length, 3,
    "常量定义+两处消费,空态文案不得再写第三份字面量");
});

test("DTS 列表列宽拖拽:TanStack 引擎,columnSizing 单一宽度源,记忆在 localStorage(2026-10-14 迁移)", () => {
  // 布局底盘:定宽布局 + colgroup 不变,宽度来源=引擎 columnSizing
  // 状态(拖动中逐帧落状态,轮询重渲染写的也是同一份——手写版直写
  // DOM 被轮询打断的回弹就此消失);标题列状态缺席不出宽,弹性吃剩余
  // 宽。表最小宽 = Σ可见定宽 + 标题下限(2026-09-24),空间不够横向滚动。
  assert.match(registration, /<Table aria-label="名下问题单" className="table-fixed"\s*\n\s*style=\{\{ minWidth: tableMinWidth \}\}>/);
  assert.match(registration, /columnResizeMode: "onChange"/);
  // colgroup 从引擎可见列渲染;非标题列恒出宽读 getSize()(含默认宽
  // 与 min/max 钳制),标题列状态缺席不出宽=弹性吃剩余宽。colgroup
  // 有宽无宽必须与列语义一致,否则 fixed 布局均摊表宽,点把手种子
  // 一列就全表重摊(2026-10-14 迁移首日的点击跳变即此)。
  assert.match(registration, /table\.getVisibleLeafColumns\(\)\.map\(\(column\) => \{/);
  assert.match(registration, /style=\{\{ width: column\.getSize\(\) \}\}/);
  assert.match(registration, /column\.id === "title" && sized === undefined/);
  assert.doesNotMatch(registration, /col\.style\.width/,
    "宽度只走 columnSizing 状态,不许再直写 DOM(轮询打断回弹的根源)");
  assert.doesNotMatch(registration, /<TableHead className="w-\d+"/,
    "列宽收口 colgroup,表头不得再挂 w-* 定宽");
  // 把手:role=separator 可聚焦,拖动交给 header.getResizeHandler(),
  // 双击/Enter 回默认(resetSize=从 sizing 状态摘键,标题列回弹性),
  // 方向键微调;上限 DTS_COL_MAX 封住单列拖飞。
  assert.match(registration, /function DtsColResizeHandle\(/);
  assert.match(registration, /role="separator"/);
  assert.match(registration, /header\.getResizeHandler\(\)\(event\)/);
  assert.match(registration, /column\.resetSize\(\)/);
  // 上下限收口在 onColumnSizingChange 写边界(引擎拖动数学只收负值,
  // min/max 在读侧 getSize() 才钳;渲染/持久化直读状态,写边界必须
  // 自己收),状态里永远只有合法宽度。且必须先 min 后 max 两层钳——
  // 三参一层的 Math.max(px, MIN, MAX) 会把上限当下限,任何宽度都钳
  // 成最大值(2026-10-14 迁移首日「一拖就顶到最宽」即此)。
  assert.match(registration,
    /Math\.min\(Math\.max\(Math\.round\(px\),\s*DTS_COL_MIN\[key as DtsColKey\]\),\s*DTS_COL_MAX\[key as DtsColKey\]\)/);
  // 弹性标题列的种子必须 table.setOptions 同步进引擎:受控列宽经
  // React 异步回流,同一 tick 的 mousedown 读不到 setColWidths,
  // 拖动起点会落到列默认 160 而非实测宽(点击跳变即此)。
  assert.match(registration, /table\.setOptions\(\(old\) => \(\{/);
  assert.match(registration,
    /columnSizing: \{\s*\n?\s*\.\.\.old\.state\.columnSizing, \[column\.id\]: measured \}/);
  // 记忆:全用户共用一份,新键 mae-flow:dts-col-widths:v2(2026-10-14
  // 迁引擎拍板不继承旧键:旧值无上限口径,读盘即清),空表回删 key。
  assert.match(registration, /mae-flow:dts-col-widths:v2/);
  assert.match(registration, /localStorage\.removeItem\(DTS_COL_WIDTHS_LEGACY_KEY\)/);
  assert.match(registration, /localStorage\.setItem\(DTS_COL_WIDTHS_KEY/);
  assert.match(registration, /localStorage\.removeItem\(DTS_COL_WIDTHS_KEY\)/);
  // 列存在性与默认/下限/上限宽由 DTS_COL_DEFAULT/DTS_COL_MIN/
  // DTS_COL_MAX 收口:版本/分支列随 ADR-0038 修订退役,介入档位列入
  // 列(ADR-0058,默认隐藏),少一列或多一列即这里红。
  assert.match(registration,
    /select: 64, ticket: 150,\s*\n\s*launch: 96, remark: 180, module: 200, tier: 116,/);
  assert.match(registration,
    /select: 48, ticket: 120, title: 160,\s*\n\s*launch: 88, remark: 140, module: 120, tier: 96,/);
  assert.match(registration,
    /select: 96, ticket: 320, title: 1200,\s*\n\s*launch: 220, remark: 800, module: 400, tier: 240,/);
});

// ---- DTS 概览:一次解决率环图第三片与口径标注(#542) ----

const deliveryAnalytics = readFileSync(
  resolve("web/src/DeliveryAnalytics.tsx"), "utf-8");

test("DTS 概览一次解决率环图第三片「用户终止(负面原因)」琥珀色,两图格局不动(#542)", () => {
  // 第三片:琥珀 CSS 变量(#540 复审收口 var(--attention-strong),亮暗
  // 同值 #d97706),与工作行环的「平台外」同源色;不再内联裸 hex。
  assert.match(deliveryAnalytics, /label: "用户终止（负面原因）"/);
  assert.match(deliveryAnalytics,
    /\{ label: "用户终止（负面原因）", color: "var\(--attention-strong\)", value: terminated \}/);
  assert.match(
    readFileSync(resolve("web/src/tailwind.css"), "utf-8"),
    /--attention-strong: #d97706;/,
    "变量在主题里落值,亮暗同值");
  // 「未一次解决」片只数完成交付里的失败:分母减去一次解决与终止。
  assert.match(deliveryAnalytics,
    /value: Math\.max\(0, \(stats\?\.solved\.total \?\? 0\) - \(stats\?\.solved\.passed \?\? 0\) - terminated\)/);
  // 概览不显示原因分布明细:原因词表不进概览(按会话页签的事,不越界)。
  // (#543 起「终止原因」词表住按会话表,本断言收窄到概览区段;全文件
  // 匹配会误伤按会话页签的正当用词。)
  const overview = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf('className="delivery-overview-grid"'),
    deliveryAnalytics.indexOf('role="tablist" aria-label="观察维度"'));
  assert.doesNotMatch(overview, /分析不准确|速度太慢|指令不遵从/);
  // 2026-10-20 拍板的两图格局:概览网格两处(需求交付+DTS),不加第三张卡。
  assert.equal(
    deliveryAnalytics.match(/delivery-overview-grid/g)?.length, 2);
});

test("DTS 概览口径标注与页底统计口径文案:分母含主动终止,绝对日起算(#542,#540 复审)", () => {
  // 卡片口径标注一行:起算日写绝对日期(与 ADR-0066 的 2026-10-21 一致),
  // 相对措辞「上线起」不许回潮。
  assert.match(deliveryAnalytics, /分母 = 完成交付会话 \+ 主动终止会话/);
  assert.match(deliveryAnalytics, /自 2026-10-21 口径切换起/);
  assert.doesNotMatch(deliveryAnalytics, /自终止原因收集上线起/);
  assert.match(deliveryAnalytics, /选「问题已处理」或「业务模块绑错」的终止不参与统计/);
  // help tooltip 同步:绝对日 + 主动终止记一次失败,两轴分母仍只含完成交付。
  assert.match(deliveryAnalytics,
    /主动终止\(负面原因\)会话\(自 2026-10-21 口径切换起\),主动终止记一次失败/);
  assert.match(deliveryAnalytics, /两轴分母仍只含完成交付/);
  // 页底「统计口径」details 同步改写。
  assert.match(deliveryAnalytics,
    /分母=完成交付会话\+主动终止\(负面原因\)会话,主动终止记一次失败/);
  assert.match(deliveryAnalytics,
    /终止时选「问题已处理」或「业务模块绑错」的会话与无原因取消\(历史数据\)不参与统计/);
});

// ---- DTS 按会话表:负面终止行进表与终止原因列(#543) ----

test("DTS 按会话表纳入负面终止行:照单渲染 canceled,不复判原因(#543)", () => {
  // 「问题已处理」取消与无原因取消不产生行是服务端唯一口径
  // (issueOnceGenerated 服务层测试钉住,#542);前端把 canceled 行纳入
  // 渲染即可,行过滤里不得再读 cancel_reason 复判(第二套口径即漂移)。
  const rowsMemo = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf("const tableRows = useMemo"),
    deliveryAnalytics.indexOf("const moduleOptions = useMemo"));
  assert.match(rowsMemo, /row\.state === "ok" \|\| row\.state === "canceled"/);
  assert.doesNotMatch(rowsMemo, /cancel_reason/, "行过滤不得复判终止原因");
  // 数据侧镜像(#542 已带):canceled 是行状态的合法值,原因字段随行可选。
  const apiTypes = readFileSync(resolve("web/src/api.ts"), "utf-8");
  assert.match(apiTypes,
    /"ok" \| "no_code" \| "pending" \| "unsupported" \| "canceled"/);
  assert.match(apiTypes, /cancel_reason\?: IssueCancelReason;/);
});

test("DTS 按会话表终止行语义:一次解决✗照旧、四列 — 占位、末列徽标或 —(#543)", () => {
  const table = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf('dim === "session"'),
    deliveryAnalytics.indexOf('details className="delivery-method"'));
  // 表头末列新增「终止原因」;ADR-0065 三率修订后表头换 SortableTh
  // (排序+漏斗一体),终止原因列仍收尾。
  assert.match(table, /<SortableTh label="终止原因" sortKey="terminate"/);
  assert.ok(table.indexOf('label="收口时间"') < table.indexOf('label="终止原因"'),
    "终止原因列在收口时间之后收尾");
  // 一次解决列:终止行显式红 ✗(#540 复审——终止行 solved_pass 已缺席,
  // 不再靠假值隐式落 ✗);交付行按 solved_pass ✓/✗。
  assert.match(table,
    /\{canceledRow\s+\? <span className="font-semibold text-danger">✗<\/span>\s+: row\.solved_pass\s+\? <span className="font-semibold text-success">✓<\/span>\s+: <span className="font-semibold text-danger">✗<\/span>\}/);
  // 终止行 — 占位恰好四处:一次定位/一次验证/首次生成占比/工作行
  // (终止会话没有工作行事实,两轴不可判)。
  assert.equal((table.match(/canceledRow \? "—" :/g) ?? []).length, 4,
    "终止行的 — 占位应恰好四处");
  // 交付行的终止原因格 — 占位(没有终止这回事);终止行悬停即点行看原因。
  assert.match(table, /\{canceledRow \? <TerminateReasonBadge row=\{row\} \/> : "—"\}/);
  assert.match(table, /title=\{canceledRow \? "查看终止原因" : "查看行归属证据"\}/);
  // 时间列复用 concluded_at 同一格式:终止行即取消时刻,交付行即收口时刻。
  assert.match(table, /new Date\(row\.concluded_at\)\.toLocaleDateString\("zh-CN"\)/);
});

test("DTS 按会话表终止原因徽标:已定类红色系,其他琥珀系截断悬停全文(#543)", () => {
  // 词表(#540 复审)唯一份在 issues/cancelReasons.ts:稳定英文值→界面
  // 中文,与 CancelSessionDialog 下拉同源;页面只 import,不再各抄一份。
  const cancelReasons = readFileSync(
    resolve("web/src/issues/cancelReasons.ts"), "utf-8");
  const labels = cancelReasons.slice(
    cancelReasons.indexOf("CANCEL_REASON_LABELS"),
    cancelReasons.indexOf("};"));
  for (const label of ["分析不准确", "速度太慢", "指令不遵从", "其他原因"]) {
    assert.ok(labels.includes(label), `词表缺「${label}」`);
  }
  assert.match(deliveryAnalytics, /from "\.\/issues\/cancelReasons"/);
  const badge = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf("function TerminateReasonBadge"),
    deliveryAnalytics.indexOf("function TerminateReasonDetail"));
  // 负面判定走共享集合(镜像服务端语义),不前端复判枚举值;未知值
  // label 走安全回退,不渲染 undefined。
  assert.match(badge, /!isNegativeCancelReason\(row\.cancel_reason\)/);
  assert.match(badge, /bg-danger-soft[^"]*text-danger/);
  assert.match(badge, /终止 · \{cancelReasonLabel\(row\.cancel_reason\)\}/);
  // other 与缺席/未知(字段纪律缺省处理)琥珀色系:「其他 · <说明>」,
  // max-width+truncate 省略号截断,title 悬停看全文。
  assert.match(badge, /bg-attention-soft[^"]*text-attention/);
  assert.match(badge, /max-w-\[\d+px\] truncate/);
  assert.match(badge, /title=\{text \|\| undefined\}/);
  assert.match(badge, /const label = text \? `其他 · \$\{text\}` : "其他";/);
});

test("DTS 按会话表点行:终止行开原因详情,交付行维持行归属证据(#543)", () => {
  // Sheet 壳分叉:标题按行状态换面。
  assert.match(deliveryAnalytics,
    /selectedRow\?\.state === "canceled" \? "终止详情" : "首次生成归属"/);
  // 内容分叉:交付行原样(行归属证据面板),终止行原因详情。
  assert.match(deliveryAnalytics,
    /<IssueCodeOriginPanel id=\{selected\} threshold=\{stats\?\.threshold_percent\} \/>/);
  const detail = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf("function TerminateReasonDetail"),
    deliveryAnalytics.indexOf("/** 登记问题页签"));
  assert.match(detail, /<h2>终止原因/);
  assert.match(detail, /说明:\{text\}/, "其他原因完整原文要在详情侧栏可读");
  assert.match(detail, /toLocaleString\("zh-CN"\)/, "终止时刻带时分");
});

test("DTS 按会话表发起人列显示姓名:映射增强,失败退回工号不阻塞(#543)", () => {
  assert.match(deliveryAnalytics, /displayPersonName\(row\.reporter, people\)/);
  assert.match(deliveryAnalytics, /listPeople\(\)/);
  // 姓名只是显示增强(先例 TaskWorkspace):读取失败静默退回工号,
  // 不 setError、不 busy,不挡表格首屏。(切片到本 effect 为止,
  // 紧随其后的统计加载 effect 里有正当的 setError,别捞进来。)
  const load = deliveryAnalytics.slice(
    deliveryAnalytics.indexOf("const [people, setPeople]"),
    deliveryAnalytics.indexOf("}, []);"));
  assert.match(load, /\.catch\(\(\) => \{\s*\}\)/);
  assert.doesNotMatch(load, /setError/);
});
