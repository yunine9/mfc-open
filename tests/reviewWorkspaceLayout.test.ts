import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const css = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf8");
const workspace = readFileSync(
  join(process.cwd(), "web/src/TaskWorkspace.tsx"), "utf8");
const userPicker = readFileSync(
  join(process.cwd(), "web/src/UserPicker.tsx"), "utf8");
const reviewPane = readFileSync(
  join(process.cwd(), "web/src/ResizableReviewPane.tsx"), "utf8");
const materialsPane = readFileSync(
  join(process.cwd(), "web/src/issues/MaterialsPane.tsx"), "utf8");

test("内容页签与阅读检视工具是独立区域，检视仍随时可开关", () => {
  // #207 页签迁 base-ui Tabs 后 role=tablist 归原语,.ws-source-switch
  // 皮肤类仍挂在 TabsList 上——锚点改钉现 DOM(justify-start 随左对齐
  // 换装加入,锚串跟随)。
  const tabsStart = workspace.indexOf('className="ws-source-switch h-auto justify-start"');
  const toolsStart = workspace.indexOf('className="ws-material-tools"');
  assert.ok(tabsStart > 0 && toolsStart > tabsStart);
  const tabs = workspace.slice(tabsStart, toolsStart);
  assert.doesNotMatch(tabs, /ws-review-launch|materials-fullscreen-toggle|material-search-toggle/);
  const tools = workspace.slice(toolsStart, workspace.indexOf('<div className="ws-material-stage"'));
  assert.match(tools, /aria-label="检视意见" aria-expanded=\{reviewPanelOpen\}/);
  assert.match(tools, /setReviewPanelOpen\(\(open\) => !open\)/);
  assert.match(tools, /materials-fullscreen-toggle/);
});

test("长批注在工作区侧栏滚动，材料持续挂载可见", () => {
  const studio = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf8");
  // 检视画布已抽成 ResizableReviewPane(可拖宽),类名与滚动语义随组件走。
  assert.match(workspace, /<ResizableReviewPane open=\{reviewPanelOpen\}>/);
  assert.match(reviewPane, /className="ws-review-canvas"/);
  assert.match(workspace, /className="ws-material-stage"/);
  assert.match(workspace, /className="ws-material-content">/);
  assert.match(studio, /\.ws-review-canvas \{[^}]*overflow: auto/s);
});

test("嵌入工作台的文件树和代码变更各自独立滚动", () => {
  const studio = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf8");
  assert.match(studio,
    /\.workspace-studio\.task-workspace-v2 \.ws-doc\.is-diff\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio :where\(\.ws-doc\.is-diff > \.annotatable\)\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s,
    "高度链使用低权重选择器，不再增加工作台覆盖债务");
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.git-change-browser\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.change-files\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/s,
    "左侧文件树应拥有自己的纵向滚动区域");
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.change-file-detail\s*\{[^}]*display:\s*flex[^}]*overflow:\s*hidden/s);
  assert.match(studio,
    /\.workspace-studio \.is-embedded \.diff-review\s*\{[^}]*flex:\s*1[^}]*min-height:\s*0[^}]*overflow:\s*auto/s,
    "右侧代码区应独立滚动，不再带动文件树");
});

test("Markdown 全屏使用宽画布，PlantUML 保留独立滚动视口", () => {
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.ws-doc \.md\s*\{[^}]*width:\s*min\(1600px, 100%\)/s);
  assert.doesNotMatch(css,
    /\.plantuml-figure[^{}]*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(css, /\.plantuml-viewport\s*\{[^}]*overflow:\s*auto/s);
  assert.match(css,
    /\.workspace-overlay\.materials-fullscreen \.puml-diagram,[^}]*width:\s*100%[^}]*max-width:\s*100%/s);
  // #230 改锚:问题流过程文档的全屏壳迁工具类,宽画布上限由
  // MaterialsPane 的 is-fullscreen 分支直译(max-w-[1760px]),
  // 不再走 style.css 的 .is-fullscreen 后代选择器。
  assert.match(materialsPane,
    /fullscreen && "mx-auto min-h-0 w-full max-w-\[1760px\] flex-1 overflow-auto/);
});

test("快速提问题常驻右下角且使用横向小按钮", () => {
  // #233 收官:原 .wish-quick-trigger 皮肤类换装为 WishQuickCreate 工具类,
  // 布局契约(fixed 右下、胶囊、横排小按钮)钉在工具类串上。
  // 锚点随 2656b4e(#225 收尾)从 18px 让到 24px(right-6/bottom-6):
  // 浮标贴缘压卡裁字,窄屏再收一号避让底部栏。
  const fab = readFileSync(join(process.cwd(), "web/src/WishQuickCreate.tsx"), "utf8");
  assert.match(fab, /wish-quick-fab fixed right-6 bottom-6 z-\[650\] inline-flex/);
  assert.match(fab, /rounded-full border-0 bg-primary px-3\.5 text-primary-foreground shadow-lg max-\[760px\]:bottom-\[76px\] max-\[760px\]:right-4/);
  assert.match(fab, /<strong className="text-xs">提问题<\/strong>/);
});

test("邀请他人检视在任务头独立可见，不依赖打开批注面板", () => {
  const controls = workspace.slice(workspace.indexOf('className="ws-head-controls"'),
    workspace.indexOf('{task.feedback_error &&'));
  // #227 换装:邀请入口换 shadcn Button,锚点从裸 <button> 与皮肤类改钉
  // 组件与文案;可见性条件仍钉在头部权限上。
  assert.match(controls, /canRequestReview && !task\.delivery\?\.final_mr && !isReviewTaskEnded\(task\.status\) && <Button/,
    "邀请入口只对有权限者可见，已结束或进入最终 MR 交付的任务不再提供");
  assert.match(controls, /邀请他人检视/);
  assert.match(controls, /aria-haspopup="dialog" aria-expanded=\{reviewInviteOpen\}/);
  assert.match(controls, /setReviewInviteOpen\(true\)/);
  assert.doesNotMatch(controls, /reviewPanelOpen/);
  const panel = workspace.slice(workspace.indexOf('<ResizableReviewPane open={reviewPanelOpen}>'),
    workspace.indexOf('<div className="ws-material-content"'));
  assert.doesNotMatch(panel, /邀请他人检视/);
  // #207 邀请弹层迁 shadcn Dialog(portal 到 body,role=dialog/Esc/焦点
  // 归原语):锚点从手搓 workspace-invite-dialog 改钉现 Dialog DOM,
  // 入口条件仍钉在头部权限上。
  assert.match(workspace, /!isReviewTaskEnded\(task\.status\) && <Dialog open/);
  assert.match(workspace, /<DialogContent className="tw-root sm:max-w-\[460px\]">/);
  assert.match(workspace, /<DialogTitle>邀请 Committer 检视<\/DialogTitle>/);
  assert.match(workspace, /<UserPicker multiple ariaLabel="选择 Committer"/);
  assert.match(workspace, /发送邀请（\$\{reviewers.length\} 人）/);
});

test("人员下拉保持紧凑并悬浮展开，宽度跟随触发器", () => {
  assert.match(userPicker, /const searchable = options\.length > 6/,
    "成员很少时不应再用搜索框占掉一整行");
  assert.match(userPicker,
    /<CommandList[^>]*className="max-h-44"/,
    "选项列表换 CommandList 后仍钉住紧凑高度(176px),不整页撑开");
  assert.match(userPicker,
    /<PopoverContent[^>]*w-\(--anchor-width\)/,
    "弹层随 Popover portal 悬浮展开,宽度锚定触发器而非写死 260px");
  assert.match(css,
    /\.workspace-review-invite-action\s*\{[^}]*grid-template-columns:\s*minmax\(180px, 260px\) auto/s,
    "Committer 选择框不应横向吞满整个邀请弹层");
});

test("检视意见使用整幅宽画布，人的意见与 Agent 回应横向对应", () => {
  assert.match(workspace, /className="workspace-review-notes"/);
  assert.match(workspace, /className="workspace-review-opinions"/);
  assert.match(css, /\.workspace-review-notes\s*\{[^}]*width:\s*min\(1220px, 100%\)/s);
  const annotate = readFileSync(join(process.cwd(), "web/src/tailwind.css"), "utf8");
  assert.match(annotate,
    /\.workspace-review-notes \.annot-item:has\(\.annot-response\)[^{]*\{[^}]*grid-template-columns:/s);
});

test("chain 架构图贴边豁免(#253):flush 态去 padding 交出滚动,滚动归 ws-doc", () => {
  // 旧皮 .ws-doc.is-chain > .story-architecture{padding:0;overflow:visible}
  // 在 #233 换装时流失——StoryArchitecture 硬编码 p-5 overflow-auto 后,
  // chain 视图多了 20px 内边距 + ws-doc 内嵌套第二层滚动。这里钉组件侧
  // 条件类直译:chain 挂载点传 flush,flush 态去 padding、裁内部滚动。
  const storyArch = readFileSync(
    join(process.cwd(), "web/src/StoryArchitecture.tsx"), "utf8");
  assert.match(workspace, /<StoryArchitecture [^>]*flush/);
  assert.match(storyArch, /flush\s*\?\s*"flex-1 min-w-0 min-h-0 overflow-visible p-0"/);
  // 非 flush(独立挂载)仍保留自滚动与留白。
  assert.match(storyArch, /"flex-1 min-w-0 min-h-0 overflow-auto p-5 max-\[600px\]:p-3"/);
});

test("检视抽屉挤窄时双栏 diff 保住最小可读宽度(#253):canvas 回 760px 下限,横向滚动兜底", () => {
  // 嵌入态曾把 canvas 压到 min-width:100%,抽屉一开左栏只剩 ~110px,
  // 代码逐字符硬换行。撤掉该覆盖,基础 .diff-review-canvas 的 760px
  // 下限重新生效,.diff-review(overflow:auto)出横向滚动。
  assert.doesNotMatch(css,
    /\.workspace-studio \.is-embedded \.diff-review-canvas[^{]*\{[^}]*min-width:\s*100%/s,
    "嵌入态 canvas 不得再被压到 100%:抽屉挤窄时左栏会逐字符换行");
  assert.match(css, /\.workspace-studio \.is-embedded \.diff-fold\s*\{[^}]*min-width:\s*100%/s);
  assert.match(css, /\.diff-review-canvas\s*\{[^}]*min-width:\s*760px/s);
});

test("diff 分隔线拖拽手柄静默,悬停/聚焦才现身(#253 残影修复)", () => {
  // 常驻的深色 5x36 手柄胶囊悬在两栏分隔线上,看着像渲染残影
  // (#251 P2-2 审计点位)。分隔细线保留,手柄只在悬停/键盘聚焦时显形。
  assert.match(css, /\.diff-column-resizer span\s*\{[^}]*opacity:\s*0/s);
  assert.match(css,
    /\.diff-column-resizer:hover span,[^{]*\{[^}]*opacity:\s*1/s,
    "悬停/聚焦必须把手柄亮回来,否则拖拽能力不可发现");
});

test("批注层接管行号区起拖的圈选,窄屏编辑框自动滚入材料卡(#253)", () => {
  const annotatable = readFileSync(
    join(process.cwd(), "web/src/Annotatable.tsx"), "utf8");
  // 行号/正负号是 user-select:none,原生手势从那里起拖得到空选区;
  // 批注层接管这类死区起点的拖选,手工维护选区到落点光标。
  assert.match(annotatable, /userSelect/);
  assert.match(annotatable, /caretRangeFromPoint|caretPositionFromPoint/);
  // 800 窄屏:编辑框底部(取消/记下)落在材料卡视口外,挂载后滚到可见。
  assert.match(annotatable, /scrollIntoView/);
});

test("检视抽屉筛选 chips 窄幅折行完整展示,不撑破面板格轨(#253)", () => {
  // workspace-review-notes 是网格容器,TabsList 作为网格项 min-width:auto
  // 以内容宽(374px)托底:chips 被画布裁字、意见卡连带超宽。钉四条:
  // 轨道 minmax(0,1fr)(auto 轨会被最宽意见的 min-content 撑出画布)+
  // 网格项 min-width 归零 + chips 折行完整展示 + 横向滚动兜底。
  assert.match(css,
    /\.workspace-review-notes\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css,
    /\.workspace-review-notes > \*\s*\{[^}]*min-width:\s*0/s);
  assert.match(css,
    /\.workspace-review-notes \[data-slot="tabs-list"\]\s*\{[^}]*min-width:\s*0[^}]*flex-wrap:\s*wrap[^}]*overflow-x:\s*auto/s);
  // 意见列不能靠 auto 外边距 shrink-to-fit(margin auto 关掉 stretch 后
  // fit-content 会被 max-content 撑出轨道):宽度显式 min(1100px,100%)。
  assert.match(css,
    /\.ws-review-canvas \.workspace-review-opinions\s*\{[^}]*width:\s*min\(1100px, 100%\)/s);
});

test("交付失败长文本在右侧行动栏内换行，不横向冲出工作台", () => {
  // #227 换装:.ws-verify-focus/.ws-verify-focus-waiting 皮肤类退役,断行
  // 契约改由工具类直接钉在元素上。
  assert.match(workspace, /交付验证进行中/);
  assert.match(workspace, /<p className="min-w-0 max-w-full whitespace-pre-wrap \[overflow-wrap:anywhere\] break-words text-sm text-text">/,
    "远端 Hook 正则、commit SHA 和英文错误都必须在卡片内断行");
});
