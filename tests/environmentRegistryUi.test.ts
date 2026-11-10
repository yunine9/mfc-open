/**
 * 环境管理页签的 UI 契约(票 #149;先例:issueUiContracts.test.ts)。
 *
 * 只断言源码里外部可见的结构与交互锚点:导航入口、深链路由、列表列、
 * 表单字段、密码不回显语义、409 引导、删除二次确认、标签筛选与空态;
 * #151 追加探活半边:状态列三态与色语义、失败原因二分、弹层「测试连接」
 * 的调用分野(新增态 /test vs 编辑态 /:id/probe)、行内探活与 api 接线。
 * 不测样式实现细节;样式纪律(#146)由断言"全工具类、不 import css、
 * 不硬编码色值"表达,css 层不新增任何东西由 cssOverrideRatchet 兜底。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const app = readFileSync(resolve("web/src/App.tsx"), "utf-8");
const api = readFileSync(resolve("web/src/api.ts"), "utf-8");
const page = readFileSync(resolve("web/src/EnvironmentRegistry.tsx"), "utf-8");
// 列头筛选壳 2026-09-13 抽成共用件(DTS 列表筛选表头化时两页共用),
// 壳自身的锚点随组件走;选项清单(FilterOptions)仍只有台账在用。
const headerFilter = readFileSync(resolve("web/src/HeaderFilter.tsx"), "utf-8");
// 新增/编辑弹层 2026-09-10 抽成共用件(台账页签与环境快选的「找不到就
// 新建」共用),表单侧锚点随组件走。
const editor = readFileSync(resolve("web/src/EnvironmentEditorDialog.tsx"), "utf-8");

test("环境管理:侧栏导航入口存在,且按团队资源分组(不进 admin 专属系统管理)", () => {
  const nav = app.slice(app.indexOf('<SidebarContent aria-label="视图切换"'),
    app.indexOf("</SidebarContent>"));
  const adminNav = nav.slice(
    nav.indexOf('session.role === "admin" ? <>'), nav.indexOf("</> : <>"));
  const devNav = nav.slice(nav.indexOf("</> : <>"));
  for (const [branch, source] of [["admin", adminNav], ["developer", devNav]] as const) {
    assert.ok(source.includes('<NavButton view="environments"'),
      `${branch} 侧栏缺少环境管理入口`);
    assert.ok(source.includes('label="配置中心"'), `${branch} 入口文案缺失`);
  }
  // 台账是全局团队资源:admin 在「管理视角」组(与团队资产并列),
  // 排在 admin 专属的「系统管理」组之前;开发在「团队信息」组。
  // (锚随 2026-09-11 侧栏迁 shadcn Sidebar 更新:app-shell 的 admin-tools
  //  壳类退场,系统管理组现在以组标签「系统管理」锚定。)
  assert.ok(adminNav.indexOf("配置中心") > adminNav.indexOf("管理视角")
    && adminNav.indexOf("配置中心") < adminNav.indexOf("系统管理"),
    "admin 侧环境管理应在管理视角组、系统管理之前");
  assert.ok(devNav.indexOf("配置中心") > devNav.indexOf("团队信息"),
    "开发侧环境管理应归团队信息组");
});

test("环境管理:/environments 深链与视图接线(进可直达、后退真切页)", () => {
  assert.ok(app.includes('(?:environments|configuration)'), "新配置中心与旧环境深链均可直达");
  assert.match(app, /if \(readEnvironmentRoute\(\)\) return "environments";/,
    "深链未接入 initialView(登录/刷新后应直达页签)");
  assert.match(app,
    /history\.pushState\(appHistoryState\("environments"\), "", "\/configuration"\)/,
    "进页签应 pushState 换地址(可复制、可后退)");
  assert.match(app, /const syncEnvironmentRoute = \(event: PopStateEvent\) =>/,
    "浏览器前进/后退要真的切页(popstate 同步)");
  // 挂载点随 9445f52(#286/ADR-0033)传入 admin 角色态:配置中心新增的
  // 「知识仓」页签仅管理员可见,挂载处负责转交登录角色。钉的本义不变:
  // environments 视图下主区真的渲染配置中心。
  assert.match(app,
    /\{view === "environments" && <ConfigurationCenter admin=\{session\.role === "admin"\} \/>\}/,
    "主区缺少环境管理视图渲染");
  assert.match(app, /import \{ ConfigurationCenter \} from "\.\/ConfigurationCenter";/);
});

test("环境管理:页面是新 Tailwind 轨道——tw-root 归一、零 css import、零硬编码色值", () => {
  assert.match(page, /className="tw-root /, "页面根必须挂 .tw-root(scoped 归一)");
  assert.doesNotMatch(page, /from "[^"]*\.css"/, "组件不得 import css 文件");
  assert.doesNotMatch(page, /!important/);
  // 令牌纪律(#146 第 4 条):禁止 bg-[#fff] 式任意值绕过 @theme 令牌。
  assert.doesNotMatch(page, /(bg|text|border|ring|fill|stroke|from|to|via)-\[#/,
    "禁止硬编码色值,颜色一律走令牌工具类");
});

test("环境管理:列表列锚点(主 IP/形态/端口/标签/状态/更新人/更新时间)", () => {
  const header = page.slice(page.indexOf("<TableHeader>"), page.indexOf("</TableHeader>"));
  for (const column of ["主 IP", "形态", "端口", "标签", "状态", "更新人", "更新时间"]) {
    assert.ok(header.includes(column), `列表缺少「${column}」列`);
  }
  // 状态列本期只有未验证一态;三态码表就位,#151 探活点亮其余。
  assert.match(page, /PROBE_TEXT: Record<EnvironmentView\["probe"\]\["state"\], string>/);
  assert.match(page, /unverified: "未验证",\s*\n\s*ok: "正常",\s*\n\s*failed: "异常"/);
});

test("环境管理:表单字段锚点(形态下拉、root 密码 placeholder、标签回车成签)", () => {
  assert.match(editor, /虚拟化\(经网管节点\)/);
  assert.match(editor, /<SelectItem value="k8s">容器化\(经 OM 节点\)<\/SelectItem>/);
  // root 密码:placeholder 引导"留空时与后台密码相同"(数据层恒有有效值)。
  assert.match(editor,
    /root 密码\(可选\)[\s\S]*?placeholder="留空时与后台密码相同"/);
  // 标签:自由输入,回车成标签;输入法组词中的回车不算提交。
  assert.match(editor, /function commitTagDraft\(event: KeyboardEvent<HTMLInputElement>\)/);
  assert.match(editor, /if \(event\.key !== "Enter" \|\| event\.nativeEvent\.isComposing\) return;/);
});

test("环境管理:密码永不回显——编辑显示已配置占位,留空=不变(不进 payload)", () => {
  // 编辑态占位:只说"已配置",值永远不回填进表单。
  assert.match(editor, /placeholder=\{existing \? "已配置——留空表示不变" : "[^"]*"\}/);
  assert.match(editor, /后台密码[\s\S]*?type="password"/);
  // 留空 = 不变的 wire 语义:空串根本不进 PUT payload(缺席,而非空串)。
  assert.match(editor,
    /\.\.\.\(backendPassword \? \{ backend_password: backendPassword \} : \{\}\)/);
  assert.match(editor, /type="password"[\s\S]*?autoComplete="new-password"/);
  // api 镜像:patch 类型明确"缺席 = 不变"的可选形状。
  assert.match(api, /backend_password\?: string;/);
  assert.match(api, /root_password\?: string \| null;/);
  // 清显式 root 密码回落继承:PUT 送 null(缺席 = 不变,null = 清除)。
  assert.match(editor, /\.\.\.\(clearRoot \? \{ root_password: null \}/);
  assert.match(editor, /清除并回落继承/);
});

test("环境管理:视图零密码字段——机密只出两个非密布尔", () => {
  const viewIface = api.slice(
    api.indexOf("export interface EnvironmentView"),
    api.indexOf("export class EnvironmentIpConflictError"));
  assert.ok(viewIface.length > 0, "api.ts 缺少 EnvironmentView 镜像");
  assert.doesNotMatch(viewIface, /backend_password|backendPassword|root_password[^_]/,
    "台账视图不得携带任何密码字段");
  assert.match(viewIface, /root_password_inherited: boolean;/);
  assert.match(viewIface, /password_configured: boolean;/);
});

test("环境管理:IP 撞车 409 在表单内报「该 IP 已存在于台账」并引导编辑既有条目", () => {
  assert.match(editor, /该 IP 已经登记过/);
  assert.match(editor, /编辑既有条目\(\{conflict\.ip\}\)/);
  assert.match(editor, /cause instanceof EnvironmentIpConflictError/);
  assert.match(editor,
    /environments\.find\(\(entry\) => entry\.id === cause\.existingId\)/);
  // api:409 带 existing_id,映射成带既有条目 id 的类型化错误。
  assert.match(api, /export class EnvironmentIpConflictError extends Error/);
  assert.match(api, /typeof body\.existing_id === "string"/);
  assert.match(api, /new EnvironmentIpConflictError\(body\.existing_id\)/);
});

test("环境管理:删除走全站 confirmDialog 二次确认,并交代快照不受影响", () => {
  const removal = page.slice(
    page.indexOf("async function removeEnvironment"),
    page.indexOf("return <section"));
  assert.match(removal, /await confirmDialog\(\{/);
  assert.match(removal, /danger: true/);
  assert.match(removal, /删除环境 \$\{entry\.ip\}/);
  assert.match(removal, /正在进行的问题不受影响/);
  assert.match(removal, /await deleteEnvironment\(entry\.id\);/);
});

test("环境管理:标签筛选(列头漏斗 + 点行内标签徽标)与清除筛选", () => {
  // 标签筛选住在标签列头的漏斗弹层里(选项 = 全部标签 + 已有标签),
  // 与行内标签徽标共用同一个 activeTag 状态,点徽标即筛。
  assert.match(page,
    /<HeaderFilter label="标签" active=\{!!activeTag\}/);
  assert.match(page,
    /onPick=\{\(v\) => \{ setActiveTag\(v\); close\(\); \}\}/);
  assert.match(page,
    /onClick=\{\(\) => setActiveTag\(tag === activeTag \? "" : tag\)\}/);
  assert.match(page, /清除筛选/);
});

test("环境管理:列头排序(升/降/取消三态)与列头漏斗过滤(2026-09-10 走查追问)", () => {
  // 七个数据列全部可排(含标签:按排序后的标签串比);表头是按钮,
  // 带 aria-sort 与方向标记;点表头 升→降→取消。
  for (const key of ["ip", "form", "port", "tags", "state", "updated_by", "updated_at"]) {
    assert.match(page, new RegExp(`aria-sort=\\{ariaSortOf\\("${key}"\\)\\}`),
      `缺少 ${key} 列排序`);
    assert.match(page, new RegExp(`onClick=\\{\\(\\) => toggleSort\\("${key}"\\)\\}`),
      `缺少 ${key} 列排序点击`);
  }
  assert.match(page, /function toggleSort\(key: SortKey\)/);
  assert.match(page, /cur\.dir === 1 \? \{ key, dir: -1 \} : null/);
  // 方向标记随壳住在 HeaderFilter(两页共用),锚点随组件走(同下文壳纪律)。
  assert.match(headerFilter, /function SortMark/);
  assert.match(headerFilter, /<ChevronsUpDown aria-hidden/);
  // IP 按数值逐段比(192.0.2.9 排在 192.0.2.10 前),非 IPv4 退回字典序。
  assert.match(page, /function compareIp\(a: string, b: string\): number/);
  assert.match(page, /if \(av\[i\] !== bv\[i\]\) return av\[i\] - bv\[i\];/);
  // 标签排序:按排序后的标签串比,不搞多值魔法定序。
  assert.match(page, /const joined = \(e: EnvironmentView\) => \[\.\.\.e\.tags\]\.sort\(\)\.join\(" "\);/);
  // 状态列按三态档排序:升序异常最前(最需要处理的排最上)。
  assert.match(page, /const STATE_RANK: Record<EnvironmentView\["probe"\]\["state"\], number>/);
  assert.match(page, /failed: 0,/);
  // 过滤住列头漏斗里(壳自带 tw-root:弹层 portal 到 body):主 IP 文本
  // 包含、形态/标签/状态 单选清单;工具栏不再有筛选下拉。
  // 壳本体 2026-09-13 抽到 HeaderFilter.tsx 两页共用,壳锚点随组件走。
  assert.match(headerFilter, /function HeaderFilter/);
  assert.match(headerFilter, /aria-label=\{`筛选 \$\{label\}`\}/);
  assert.match(page, /function FilterOptions/);
  assert.match(page, /<HeaderFilter label="主 IP" active=\{!!ipFilter\.trim\(\)\}/);
  assert.match(page, /<HeaderFilter label="形态" active=\{!!formFilter\}/);
  assert.match(page, /<HeaderFilter label="状态" active=\{!!stateFilter\}/);
  assert.match(page, /aria-label="按 IP 过滤"/);
  assert.match(page, /formFilter && entry\.form !== formFilter/);
  assert.match(page, /stateFilter && entry\.probe\.state !== stateFilter/);
  assert.doesNotMatch(page, /aria-label="搜索环境"/, "全局搜索框已由列头筛选取代");
  // 清除筛选一键清空四路筛选(有任一激活才出现)。
  assert.match(page, /const filtersActive = Boolean\(activeTag \|\| formFilter \|\| stateFilter[\s\S]*?updaterFilter\);/);
  assert.match(page, /function clearFilters\(\)/);
  // 更新人列头漏斗:筛的是账号值,选项标签用显示名(usePersonName),
  // 与表格列的呈现一致——不出现「显示名搜不到」的坑。
  assert.match(page, /<HeaderFilter label="更新人" active=\{!!updaterFilter\}/);
  assert.match(page, /updaterFilter && entry\.updated_by !== updaterFilter/);
  assert.match(page, /value: account, label: nameOf\(account\),/);
  // 激活的漏斗有 accent 小底块(哪列在筛一眼可辨);每个漏斗都能就地
  // 「清除此列筛选」。(激活底块与清除项都在共用壳上)
  assert.match(headerFilter, /rounded-sm bg-accent px-0\.5 text-ink/);
  assert.match(headerFilter, /清除此列筛选/);
  // 过滤后空态换成整块空态卡(表不再渲染):列宽不随有无内容跳变。
  assert.match(page, /data-testid="environment-registry-filtered-empty"/);
  assert.doesNotMatch(page, /colSpan=\{8\}/);
});

test("环境管理:空态引导(还没有环境,点新增录入第一个)", () => {
  const empty = page.slice(
    page.indexOf('data-testid="environment-registry-empty"'),
    page.indexOf("<Table "));
  assert.match(empty, /还没有环境/);
  assert.match(empty, /新增环境/);
  assert.match(empty, /录入第一台网管环境/);
});

test("环境管理:数据加载沿视图自取惯例——挂载拉取,增改删后刷新台账", () => {
  assert.match(page, /useEffect\(\(\) => \{ void refreshEnvironments\(\); \}, \[\]\);/);
  assert.match(page, /setEnvironments\(await listEnvironments\(\)\);/);
  assert.match(page, /onSaved=\{\(\) => \{[\s\S]*?refreshEnvironments\(\)/);
  // 四个 API 函数都从 api.ts 取(api.ts 里存在类型化函数,形状由服务端测试兜底);
  // 增改在共用弹框里,页签只管列/删与刷新。
  for (const name of ["listEnvironments", "createEnvironment", "updateEnvironment", "deleteEnvironment"]) {
    assert.match(api, new RegExp(`export async function ${name}\\(`),
      `api.ts 缺少 ${name}`);
  }
  for (const name of ["listEnvironments", "deleteEnvironment"]) {
    assert.match(page, new RegExp(`\\b${name}\\(`), `页面未使用 ${name}`);
  }
  for (const name of ["createEnvironment", "updateEnvironment", "probeEnvironment", "testEnvironmentConnection"]) {
    assert.match(editor, new RegExp(`\\b${name}\\(`), `弹框未使用 ${name}`);
  }
});

test("环境管理:状态列三态点亮——正常绿/异常红/未验证中性灰,色语义走令牌桥", () => {
  // 三态码表已在既有锚点;这里钉 #151 的色语义:ok 用 success 系、failed 用
  // danger 系、unverified 保持中性灰——全部是 tailwind.css @theme 桥映射出的
  // 令牌工具类(--color-success/--color-danger 系),硬编码色值另有兜底断言。
  assert.match(page,
    /if \(state === "ok"\) return "border-success\/40 bg-success-soft text-success";/,
    "正常态缺 success 系令牌工具类");
  assert.match(page,
    /if \(state === "failed"\) return "border-danger\/40 bg-danger-soft text-danger";/,
    "异常态缺 danger 系令牌工具类");
  assert.match(page, /return "text-muted-foreground";/, "未验证态应保持中性灰");
  // 状态列单元格消费该色语义(三态徽标 + 原因 + 最近探活时间)。
  assert.match(page, /<ProbeStateCell probe=\{entry\.probe\} \/>/);
  assert.match(page, /<Badge variant="outline" className=\{probeToneClass\(probe\.state\)\}>/);
});

test("环境管理:异常原因二分文案(认证失败/不可达)与最近探活时间", () => {
  assert.match(editor, /auth: "认证失败",/);
  assert.match(editor, /unreachable: "不可达",/);
  // 异常条目才展示原因;探过的条目附最近探活时间(相对时间,项目现成工具)。
  assert.match(page, /probe\.state === "failed" && probe\.reason/);
  assert.match(page, /relativeTime\(probe\.at\)/);
});

test("环境管理:弹层「测试连接」调用分野——新增态 /test(表单值+密码已填),编辑态 /:id/probe", () => {
  assert.match(editor, /async function runTestConnection\(\)/);
  assert.match(editor, /探测中…/, "缺少探测中 loading 态");
  // 新增态:用表单当前值走 /environments/test,后台密码未填当场拦下。
  assert.match(editor, /testEnvironmentConnection\(\{/);
  assert.match(editor, /ip: ip\.trim\(\),/);
  assert.match(editor, /backend_password: backendPassword,/);
  assert.match(editor, /setTestError\("后台密码不能为空"\)/);
  // 编辑态:前端无密码,直接对已存条目探活(/:id/probe,结论持久化,
  // 状态列随 onProbed 就地刷新)。
  assert.match(editor, /probeEnvironment\(existing\.id\)/);
  assert.match(editor, /onProbed\?\.\(updated\)/);
  assert.match(page, /onProbed=\{applyProbeUpdate\}/);
  // api 接线:两个类型化函数与两条端点路径。
  assert.match(api, /export async function testEnvironmentConnection\(/);
  assert.match(api, /export async function probeEnvironment\(/);
  assert.match(api, /fetch\("\/environments\/test"/);
  assert.match(api,
    /fetch\(\s*`\/environments\/\$\{encodeURIComponent\(id\)\}\/probe`/);
});

test("环境管理:测试结果就地内联(连接正常/连接异常+原因),不关弹层", () => {
  assert.match(editor, /连接正常/);
  assert.match(editor, /连接异常:/);
  // 结论内联展示在按钮旁,测试路径不触碰弹层关闭(onClose 只由取消/保存走)。
  const handler = editor.slice(
    editor.indexOf("async function runTestConnection"),
    editor.indexOf("return <Dialog"));
  assert.ok(handler.length > 0, "缺少测试连接处理器");
  assert.doesNotMatch(handler, /onClose\(/);
});

test("环境管理:行内探活——操作列「探活」,行内 loading,完成后状态列就地刷新", () => {
  assert.match(page, /async function probeRow\(entry: EnvironmentView\)/);
  assert.match(page, /probeEnvironment\(entry\.id\)/);
  // 行内 loading 与禁用;完成后用返回视图就地合并进列表(不整页轮询,
  // 后台已有约 10 分钟一轮的定时探活)。
  assert.match(page, /probingId === entry\.id \? "探活中…" : "探活"/);
  assert.match(page, /setEnvironments\(\(prev\) =>/);
  assert.match(page,
    /prev\.map\(\(item\) => \(item\.id === updated\.id \? updated : item\)\)/);
});
