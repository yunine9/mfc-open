/**
 * 问题处理导航组的 UI 契约(票 #171;先例:environmentRegistryUi.test.ts)。
 *
 * 只断言源码里外部可见的结构与交互锚点:Beta 全摘(标签文字/悬停/读屏
 * +导航按钮的 beta 分支删除)、父行=可展开/收起开关(radix Collapsible,
 * 箭头旋转指示)、子页签三枚(问题登记/DTS列表/问题会话)且 admin 只见
 * 「问题会话」、右侧三页面常驻驻留(隐藏切换不卸载)、深链 /issues/:id
 * 自动展开并高亮「问题会话」。不测样式实现细节;子页签区走新 Tailwind
 * 轨道(tw-root 归一、零 css import、零硬编码色值)与台账页同一纪律。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const board = readFileSync(resolve("web/src/issues/IssueBoard.tsx"), "utf-8");
const registration = readFileSync(
  resolve("web/src/issues/Registration.tsx"), "utf-8");
const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
const css = readFileSync(resolve("web/src/tailwind.css"), "utf-8");
const legacyCss = readFileSync(resolve("web/src/tailwind.css"), "utf-8");

/** 侧边栏导航区(视图切换)整段,角色分支再切片。 */
function navSlices(): { nav: string; admin: string; developer: string } {
  const nav = app.slice(app.indexOf('<SidebarContent aria-label="视图切换"'),
    app.indexOf("</SidebarContent>"));
  const admin = nav.slice(
    nav.indexOf('session.role === "admin" ? <>'), nav.indexOf("</> : <>"));
  const developer = nav.slice(nav.indexOf("</> : <>"));
  return { nav, admin, developer };
}

test("Beta 全摘:标签文字、悬停/读屏提示、导航按钮 beta 分支一并删除", () => {
  assert.doesNotMatch(app, /问题处理（Beta）/, "标签文字不得再带 Beta");
  assert.doesNotMatch(app, /能力建设中/, "悬停/读屏的 Beta 提示语应删除");
  assert.doesNotMatch(app, /beta\s*=\s*false|beta\?:\s*boolean|\bbeta\b\s*\?\s*`/,
    "NavButton 的 beta 分支应删净(唯一使用方已退役)");
  // 问题处理入口仍在两侧导航(admin 管理视角组/开发个人工作台组)。
  const { admin, developer } = navSlices();
  assert.ok(admin.includes('view="issues"'), "admin 侧栏缺问题处理入口");
  assert.ok(developer.includes('view="issues"'), "开发侧栏缺问题处理入口");
});

test("父行=展开/收起开关:本地 open 态承载,箭头旋转指示,点击不跳页", () => {
  // #233 收官前改锚:折叠不再借 radix Collapsible,由 IssueNavGroup 本地
  // open 状态承担(shadcn SidebarMenuButton + aria-expanded),语义不变。
  assert.match(app, /const \[open, setOpen\] = useState\(current === view\)/,
    "父行开关是本地展开态");
  assert.match(app, /aria-expanded=\{open\}/, "展开态进 aria");
  assert.match(app, /ChevronDown/, "展开指示箭头(lucide)");
  assert.match(app, /<SidebarMenuButton[^>]*aria-label="问题处理"/,
    "父行是可读屏的 Sidebar 按钮");
  assert.match(app, /\{open && <SidebarMenuSub>/, "子页签只在展开时显示");
  assert.match(app, /rotate-180/, "展开态箭头旋转 180°");
  // 父行沿用存量 nav-item 家族(视觉零跳变),但不再走 onSelect 跳页。
  const { nav } = navSlices();
  const parentRow = nav.slice(nav.indexOf("IssueNavGroup"),
    nav.indexOf("</> : <>"));
  assert.ok(parentRow.length > 0, "问题处理导航组应作为独立组件挂两侧");
  assert.doesNotMatch(nav, /<NavButton view="issues"/,
    "问题处理不再是普通 NavButton(它现在是开关,不是直跳页签)");
});

test("子页签:开发含独立流水线修复,admin 只见问题会话", () => {
  const { admin, developer } = navSlices();
  for (const [name, branch] of [["admin", admin], ["开发", developer]] as const) {
    assert.ok(branch.includes("<IssueNavGroup"), `${name}侧导航应挂问题处理组`);
  }
  // 子页签集在组件内按角色裁剪:admin 条目只有「问题会话」;开发侧三枚。
  const group = app.slice(app.indexOf("function IssueNavGroup"),
    app.indexOf("function NavButton"));
  assert.match(group,
    /admin\s*\?\s*\[\{ tab: "sessions", label: "问题会话" \}\]/,
    "admin 分支只应有问题会话一个子页签");
  for (const [tab, label] of [
    ["register", "问题登记"], ["dts", "DTS 列表"], ["sessions", "问题会话"], ["pipeline", "流水线修复"],
  ] as const) {
    assert.ok(group.includes(`{ tab: "${tab}", label: "${label}" }`),
      `开发侧子页签缺「${label}」`);
  }
  // 默认子页签排第一(拍板:缺省落点在首位,与选择直觉一致)。
  assert.ok(group.indexOf('{ tab: "sessions"') < group.indexOf('{ tab: "register"')
    && group.indexOf('{ tab: "register"') < group.indexOf('{ tab: "dts"')
    && group.indexOf('{ tab: "dts"') < group.indexOf('{ tab: "pipeline"'),
    "子页签顺序应为 问题会话 → 问题登记 → DTS 列表 → 流水线修复");
  // 子页签行走 shadcn SidebarMenuSubButton 轨道(原 tw-root scoped 归一随
  // preflight 全局化退役,见 tailwind.css base 层)。
  assert.match(group, /SidebarMenuSubButton/, "子页签是 shadcn Sidebar 子按钮");
});

test("子页签状态:默认落问题会话,选择经父层驱动右侧页面", () => {
  assert.match(app, /"sessions"/, "默认子页签=问题会话");
  assert.match(app, /IssueChildTab/, "子页签是具名联合类型,不是散字符串");
  assert.match(board, /childTab/, "问题板按子页签承接右侧页面");
});

test("右侧三页面常驻驻留:登记/DTS/会话列表都是隐藏切换,不卸载", () => {
  // 登记域仅开发者渲染(服务端拒 admin 发起,入口语义不变),面板由
  // 子页签受控;可见性走 hidden,不得条件卸载(卸载即丢表单驻留)。
  // 例外只在「流水线修复」独立工具页签(587a1264:与 DTS 交付数据隔离),
  // 登记/DTS/会话三个问题页签之间仍全程常驻。
  assert.match(board, /viewer\.role !== "admin" && childTab !== "pipeline" && <IssueRegistration/);
  assert.match(board, /visible=\{/, "登记域显隐经 visible 属性驱动");
  assert.doesNotMatch(board,
    /childTab === "sessions" && <IssueRegistration/,
    "登记域不得随子页签条件卸载");
  // 会话列表段同样 hidden 切换(保留既有 admin 全部问题标题口径)。
  assert.match(board, /hidden=/, "页面区块显隐走 hidden(状态驻留)");
  // 登记域组件:内部页签按钮退役,两面板由受控属性决定可见性。
  assert.doesNotMatch(registration, /issue-register-tabs/,
    "内部页签按钮已由导航子页签接管");
  assert.match(registration, /hidden=\{/, "两面板仍常驻(hidden 切换)");
});

test("深链 /issues/:id:进入即子页签落问题会话(通知点开直达工作台)", () => {
  // 打开会话(点列表/团队任务联动)与浏览器前进后退两条路都要落。
  // 流水线修复会话(mr-repair-)走独立工具页签:两路都落「流水线修复」,
  // 普通问题会话仍落「问题会话」(587a1264 隔离流水线修复与 DTS 数据)。
  const hits = app.match(
    /setIssueChildTab\((?:readIssueRoute\(\)|id)\.startsWith\("mr-repair-"\) \? "pipeline" : "sessions"\)/g) ?? [];
  assert.ok(hits.length >= 2,
    `深链两路(打开会话/前进后退)都应落问题会话,实际 ${hits.length} 处`);
});

test("子页签选择持久化:localStorage 与历史快照双轨,前进/后退可还原", () => {
  assert.match(app, /mae-flow:issue-child-tab/, "localStorage 存储键");
  assert.match(app, /localStorage\.setItem\(ISSUE_CHILD_STORAGE_KEY/,
    "选择变化要写回 localStorage(刷新还原)");
  assert.match(app, /maeFlowIssueChildTab/, "历史快照要带子页签字段");
  assert.match(app, /issueChildTabFromHistoryState\(event\.state\)/,
    "popstate 后退/前进要还原子页签");
  // 已在问题处理时点子页签:不推新历史条目,但必须原地改写快照——
  // 否则快照落后一次点击,前进/后退还原到过期子页签。
  assert.match(app,
    /replaceState\(appHistoryState\("issues", undefined, tab\)/,
    "子页签选择要写进历史快照(经 selectIssueChild 的 replaceState)");
  // selectView 的闭包读不到同 tick 的新状态:子页签当前值必须走 ref。
  assert.match(app, /activeIssueChildRef\.current = tab;/,
    "选择要同步进 ref(selectView 快照不落后)");
});

test("DTS 列表子页签全宽:页面平铺屏幕,标题条同步对齐,其余子页签维持书页宽", () => {
  // 表格横向信息密(spec #171 评审后追加):DTS 子页签下主区与标题条
  // 一起放开 max-width——标题条不随内容全宽就会悬在书页宽上错位。
  assert.match(app, /const dtsWide = view === "issues" && activeIssueChild === "dts";/,
    "全宽判据只认 DTS 子页签");
  // #228 换装:is-wide 修饰类退役,全宽改由条件工具类直译(max-w 二选一)。
  // 知识域各页的全宽判据随知识库改版几经变化(3db3fe9b/783431e2),
  // 这里只钉问题域不变量:标题条与主区都以 dtsWide 打头放开。
  assert.match(app,
    /<header className=\{cn\("mx-auto flex w-full[^"]*",\s*\n(?:\s*\/\/[^\n]*\n)*\s*dtsWide \? "max-w-none" : "max-w-\(--page-width\)"/,
    "标题条随全宽切换(左边缘与内容对齐)");
  assert.match(app,
    /<main className=\{cn\("mx-auto w-full px-10 pb-\[72px\]",\s*\n\s*\(dtsWide \|\| [^?]*\) \? "max-w-none" : "max-w-\(--page-width\)"/,
    "主区随 DTS 子页签切换");
  // 页头随子页签换文案:整域静态说明对子页签无信息量。
  assert.match(app, /issueChildHeaders/,
    "问题处理域页头文案按子页签取");
  // 任务同步指示器是需求域的:问题处理页头不显示(张冠李戴)。
  assert.doesNotMatch(app,
    /view !== "wishes" && view !== "help" && <TaskSyncIndicator/,
    "旧的全视图条件应退役");
  assert.match(app, /\(view === "mine" \|\| view === "team"\) && <TaskSyncIndicator/,
    "任务同步指示器只在需求域视图显示");
});

test("子页签区零硬编码色值:色彩一律走令牌桥(theme inline 映射存量变量)", () => {
  // 新 Tailwind 轨道的样式纪律:hex/rgb 色值不进 className,统一用
  // text-faint/bg-surface-3 这类令牌工具类(定义见 tailwind.css 桥)。
  // 前瞻要求含字母位:#103 这种纯数字票号引用不算色值。
  const { nav } = navSlices();
  assert.ok(!/#[0-9a-fA-F]*(?:[a-fA-F][0-9a-fA-F]*){1,4}\b/.test(nav),
    "导航区不得硬编码 hex 色值");
  assert.match(css, /--color-faint: var\(--faint\)/, "令牌桥供给 faint 色工具类");
});

test("父行徽章:开发侧挂名下进行中的问题数,与页内「进行中」同口径;admin 不挂", () => {
  // 徽章只属开发个人工作台:admin 对问题处理只读围观(#103),不推进
  // 问题,注意力入口是「团队DTS」的等你答复珠,父行不重复挂数。
  const { admin, developer } = navSlices();
  assert.match(developer,
    /<IssueNavGroup view="issues" current=\{view\} badge=\{myActiveIssueCount\}/,
    "开发侧父行应挂进行中计数");
  assert.doesNotMatch(admin, /<IssueNavGroup[^>]*badge=/,
    "admin 侧父行不挂徽章");
  // 口径同源:「进行中」判定收口在 api.ts(isIssueActive),徽章与页内
  // 默认筛选项共用,收口状态增减时两处不许各写各的减法。
  assert.match(api, /export const isIssueActive/,
    "「进行中」判定应在 api.ts 单份导出");
  assert.match(app, /myActiveIssueCount = myIssues\s*\n?\s*\.filter\(\(issue\) => isIssueActive\(issue\.status\)\)/,
    "徽章计数=本人问题列表过 isIssueActive");
  assert.match(board, /isIssueActive\(issue\.status\)/,
    "列表页「进行中」筛选与计数同用 isIssueActive");
  // 数据同源:徽章列表走 GET /issues(归属或登记人是自己,ADR-0031),
  // 不许前端从 scope=all 里自筛(服务端收窄规则一变两处就漂)。
  // a874049c 起旁栏各路各自 then 落状态(慢请求不拖任务列表)。
  assert.match(app, /session\?\.role === "admin" \? Promise\.resolve\(\)\s*\n?\s*: listIssues\(\)\.then\(\(rows\) => \{ if \(currentSession\(\)\) setMyIssues\(rows\); \}\)/,
    "本人问题列表走 listIssues,admin 不拉(其 GET /issues 是全量)");
});
