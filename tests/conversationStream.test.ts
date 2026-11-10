/**
 * 右栏会话流的页面契约(纯渲染,不起服务):
 * - 筛选:全部 / 需要我的 / 检视意见;线程视图只留牵涉这条批注的条目;
 * - 回合:最后一段话摊开、此前的折叠、工具步骤折成一行计数并可跳工作过程;
 * - 卡:历史卡是只读摘要并标出选了哪项;当前卡由父级传入渲在流末尾;
 * - 回执:逐条带结论,旧版本回执明说"不算数";
 * - 锚条:等你决定 / N 条意见等你确认 / 否则说当前在干嘛。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { ConversationItem, TaskSummary } from "../web/src/api.ts";

// 前端模块带 CSS import,走 Vite 的 SSR loader(与 workspaceUiLogic 同款);
// 本仓刻意不为前端测试引入 jsdom,只验证静态渲染出来的事实。
const vite = await createServer({
  root: "web",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
// 只按用到的形状标类型,不 typeof import 前端源码:根 tsconfig 没有 DOM lib,
// 把组件源码拉进根程序会冒出一堆"找不到 window"的假错。
type StreamModule = {
  ConversationStream: (props: Record<string, unknown>) => unknown;
  conversationCardTitle: (item: ConversationItem) => string;
  itemAnnotationIds: (item: ConversationItem) => string[];
  visibleConversationItems: (
    items: readonly ConversationItem[],
    options: { filter: "all" | "mine"; thread?: string; viewer: string; settled?: ReadonlySet<string>; owner?: string },
  ) => ConversationItem[];
};
const {
  ConversationStream, conversationCardTitle, itemAnnotationIds, visibleConversationItems,
} = await vite.ssrLoadModule("/src/ConversationStream.tsx") as StreamModule;
const { TaskWaitingFacts } = await vite.ssrLoadModule("/src/TaskWaitingFacts.tsx");
after(() => vite.close());

const T0 = "2026-09-05T02:00:00.000Z";
const T1 = "2026-09-05T02:05:00.000Z";
const T2 = "2026-09-05T02:10:00.000Z";
const T3 = "2026-09-05T02:15:00.000Z";

const ref = { id: "a-1", author: "zhou", kind: "doc", file: "docs/spec.md", line: 7, note: "多长算长文?" };

test("系统恢复意见显示原因，不署名为原作者退回", () => {
  const reset: ConversationItem = { kind: "delivery_reset", id: "reset-1", ts: T1,
    annotation: ref, reason: "模型响应超时" };
  const html = render({ items: [reset] });
  assert.match(html, /系统/);
  assert.match(html, /处理未完成 · 待重新提交/);
  assert.match(html, /模型响应超时/);
  assert.doesNotMatch(html, /退回 1 条意见|第 1 次要求再改/);
  assert.deepEqual(itemAnnotationIds(reset), [ref.id]);
});

const items: ConversationItem[] = [
  { kind: "session", id: "s1", ts: T0, phase: "started", resume: false },
  { kind: "turn", id: "turn-1", ts: T0, end_ts: T1, open: false,
    texts: [
      { ts: T0, text: "我先核对现有实现。", truncated: false, role: "narration" },
      { ts: T0, text: "现在去跑一遍测试。", truncated: false, role: "narration" },
      { ts: T1, text: "结论:只改一处,请确认。", truncated: false, role: "handoff" },
    ],
    steps: { calls: 12, errors: 1, reads: 8, edits: 2, bash: 2, agents: 0,
      sample: [{ kind: "edit", subject: "…/src/a.ts" }, { kind: "bash", subject: "npm test" }] } },
  { kind: "card", id: "card-w1", ts: T1, waiting_id: "w1", step: "cloud_push_confirm",
    purpose: "confirmation", annotation_ids: [],
    questions: [{ question: "是否推送?", options: ["确认按清单推送", "需要调整代码"] }],
    status: "resolved" },
  { kind: "decision", id: "decision-w1", ts: T2, waiting_id: "w1", by: "lin",
    decision: "需要调整代码", answers: { "是否推送?": "需要调整代码" },
    notes: "第 9 行别暴露枚举", purpose: "confirmation", annotation_ids: [] },
  { kind: "annotations_sent", id: "sent-1", ts: T2, by: "zhou", via: "decision", items: [ref] },
  { kind: "receipts", id: "receipts-1", ts: T3, items: [
    { ...ref, outcome: "needs_clarification", summary: "按字数还是按任务?", revision: 0, current: true },
    { ...ref, id: "a-2", author: "lin", note: "保留业务语气", outcome: "fixed",
      summary: "旧回执", revision: 0, current: false },
  ] },
  { kind: "steer", id: "steer-1", ts: T3, text: "别动区号", delivered: false, deferred: "decision" },
  { kind: "external", id: "ext-1", ts: T3, source: "mr_discussion", author: "周谨",
    items: [{ id: "f1", summary: "移动端入口别竖排", file: "a.css", line: 950, status: "open" }] },
];

const task = {
  id: "task-8", status: "running", luban_account: "lin",
  focus: { headline: "Agent 正在写代码", next_action: "写完后会举卡请你检视" },
} as unknown as TaskSummary;

function render(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(React.createElement(
    ConversationStream as unknown as React.FunctionComponent<Record<string, unknown>>, {
    task, items, problems: [], loaded: true, viewerUsername: "zhou",
    people: [{ username: "lin", display_name: "林知远" }],
    filter: "all", onFilterChange: () => undefined, onThreadChange: () => undefined,
    annotations: [], decides: false, awaitingYou: 0,
    fallbackHeadline: "当前无待办", fallbackDetail: "无需处理",
    takeover: false, onLocateAnnotation: () => undefined,
    onOpenReview: () => undefined, onOpenSteps: () => undefined,
    ...overrides,
  }));
}

test("自动推送清单在协作流里可读，没有文件勾选或新的确认按钮", () => {
  const manifest: ConversationItem = { kind: "push_file_list", id: "push-1", ts: T3,
    manifest: { branch: "feature", head_sha: "b".repeat(40), base_sha: "a".repeat(40), comparison: "remote_branch",
      files: [{ path: "src/repeated.ts", label: "修改" }] } };
  const html = render({ items: [manifest] });
  assert.match(html, /本次推送清单/);
  assert.match(html, /相对远端任务分支/);
  assert.match(html, /repeated\.ts/);
  assert.doesNotMatch(html, /type="checkbox"|确认推送|确认清单/);
});

test("筛选与线程:只剩全部 / 需要我的;线程只留牵涉这条批注的", () => {
  // 2026-09-06 用户:"右边的检视意见和左边的抽屉是不是重复"——第三档筛选去掉,
  // 意见类条目在流里只留一行摘要,详情只在抽屉。
  // 「需要我的」只留此刻还等我动手的:开着的卡、我提的意见收到的当前回执、
  // 收到的上下游通知。历史(已答的卡、决定、插话、我提过的意见)不算。
  const mine = visibleConversationItems(items, { filter: "mine", viewer: "zhou" });
  assert.deepEqual(mine.map((item) => item.id), ["receipts-1"],
    "zhou 的意见 a-1 有当前版本的回执在等她;已答复的卡、决定、插话都不算");
  const settled = visibleConversationItems(items,
    { filter: "mine", viewer: "zhou", settled: new Set(["a-1"]) });
  assert.deepEqual(settled, [], "意见闭环后回执不再需要我");
  const lin = visibleConversationItems(items, { filter: "mine", viewer: "lin" });
  assert.deepEqual(lin, [], "a-2 的回执是旧版本,不算 lin 的待办");
  const thread = visibleConversationItems(items, { filter: "all", thread: "a-1", viewer: "zhou" });
  assert.deepEqual(thread.map((item) => item.id), ["sent-1", "receipts-1"]);
  assert.deepEqual(itemAnnotationIds(items[5]), ["a-1", "a-2"]);
  assert.equal(conversationCardTitle(items[2] as Extract<ConversationItem, { kind: "card" }>),
    "最终检视：确认这版代码可直接推送");
});

test("回合摊开最后一段、折叠此前的,工具步骤折成一行;历史卡标出选了哪项", () => {
  const html = render();
  assert.match(html, /2 段过程说明/, "过程话折成一行");
  assert.match(html, /结论:只改一处,请确认。/, "交接语摊开");
  assert.match(html, /编辑 …\/src\/a\.ts · 运行 npm test · 共 12 步 · 1 步失败/);
  assert.match(html, /最终检视：确认这版代码可直接推送/);
  // #232 改锚:选项高亮换本页 CONV 词典,选中项由勾标伪元素承担(类值
  // 经 renderToStaticMarkup 转义,只认到文本为止)。
  assert.match(html, /✓[^"]*">需要调整代码/);
  assert.match(html, /林知远/, "决定人按显示名");
  assert.match(html, /第 9 行别暴露枚举/);
  // 非线程视图:意见类条目一行摘要 + 打开检视意见,不摊开正文(抽屉里有)
  assert.match(html, /提交了 1 条意见给 Agent/);
  assert.match(html, /回了 1 条意见的处理结果：1 条需要补充说明/);
  assert.match(html, /另 1 条是旧版本回执，不算数/);
  assert.doesNotMatch(html, /按字数还是按任务\?/, "回执正文不在流里重复");
  assert.doesNotMatch(html, /class="conv-receipts"/, "逐条回执列表只在线程视图");
  assert.match(html, /CodeHub 检视/);
  assert.match(html, /提了 1 条代码检视意见，1 条待闭环/);
  assert.doesNotMatch(html, /移动端入口别竖排/, "外部意见正文也只在抽屉");
  assert.ok((html.match(/打开检视意见/g) ?? []).length >= 3);
  assert.doesNotMatch(html, /看这条的处理记录/, "非线程视图不再逐条给入口");
  assert.match(html, /data-annotation-ids="a-1 a-2"/);
  assert.match(html, /随下一次决定送达/);
  assert.match(html, /Agent 正在写代码/, "没有待办时锚条说当前在干嘛");
  assert.doesNotMatch(html, /role="tab"[^>]*>检视意见/, "第三档筛选已去掉");
  // 线程视图:同一批条目逐条完整
  const threaded = render({ thread: "a-1" });
  assert.match(threaded, /2 条意见的处理回执/);
  assert.match(threaded, /按字数还是按任务\?/);
  assert.match(threaded, /需要补充信息/);
  assert.match(threaded, /看这条的处理记录/);
});

test("流水线人工反馈默认展示完整原因与方案，代码检视仍单独呈现", () => {
  const resolution = "DT增量覆盖率0.00%，UT未部署到流水线采集位置且需核对产品链接库。\n\n"
    + "方案A：调整UT部署位置及CMakeLists链接库配置，推送后使用绑定SHA的流水线验证。\n\n"
    + "容器缺少DEVELOPENV_ROOT，无法本地编译，需要责任人确认该处理方案。\n\n"
    + "已核对实际报告和构建配置。".repeat(50) + "回执末尾仍完整可见。";
  for (const source of ["pipeline", "build_fix"] as const) {
    const external: ConversationItem = { kind: "external", id: `ext-${source}`, ts: T3, source,
      items: [{ id: "dt-coverage", summary: "DT覆盖率0%，流水线验证未通过", status: "needs_human", resolution }] };
    const html = render({ items: [external, items.at(-1)!] });
    assert.match(html, /aria-label="流水线人工处理回执"/);
    assert.match(html, /有 1 项需要人工判断/);
    assert.match(html, /DT覆盖率0%，流水线验证未通过/);
    assert.match(html, /方案A：调整UT部署位置及CMakeLists链接库配置/);
    assert.match(html, /容器缺少DEVELOPENV_ROOT/);
    assert.match(html, /回执末尾仍完整可见。/);
    assert.doesNotMatch(html, /展开完整报告|line-clamp|<details/);
    assert.match(html, /查看流水线反馈/);
    assert.match(html, /提了 1 条代码检视意见，1 条待闭环/);
    assert.doesNotMatch(html, /移动端入口别竖排/);
  }
});

test("栏头一行放标题与筛选,锚条一行并入状态与责任,不再各占一行", () => {
  const html = render({ statusText: "执行中", actor: "由你负责" });
  // #210 起筛选交给 base-ui Tabs 原语:栏头里是 Tabs 包装层 + TabsList
  // (皮肤类 ws-stream-filters 仍挂在签条上)。
  assert.match(html, /<header class="ws-collaboration-head"><strong>与 Agent 协作<\/strong><div[^>]*data-slot="tabs"/,
    "筛选进栏头,不再单独一行");
  assert.match(html, /role="tablist"[^>]*class="[^"]*ws-stream-filters/);
  assert.match(html, /<small>执行中 · 由你负责 · 写完后会举卡请你检视<\/small>/,
    "状态、责任、下一步并成锚条的一行小字");
  assert.doesNotMatch(html, /ws-focus-status/);
  const waitingTask = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w2", state_version: 1, created_at: T3,
      question: { questions: [{ question: "确认?" }] } } } as unknown as TaskSummary;
  const attention = render({ task: waitingTask, decides: true, actor: "由你负责" });
  assert.match(attention, /<strong>等你决定<\/strong><small>等你 [^<]* · 由你负责<\/small>/);
});

test("锚条:等你决定 / N 条意见待你处理;当前卡由父级传入渲在流末尾", () => {
  const waitingTask = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w2", state_version: 1, created_at: T3,
      question: { questions: [{ question: "确认?" }] } } } as unknown as TaskSummary;
  const html = render({ task: waitingTask, decides: true,
    currentCard: React.createElement("div", { className: "probe-card" }, "决定卡本体") });
  assert.match(html, /等你决定/);
  assert.match(html, /跳到卡片/);
  assert.match(html, /conv-card current"><div class="probe-card">决定卡本体/);
  const confirm = render({ awaitingYou: 3 });
  // 口径演进后的现文案:「需要我的」锚条只说"待你处理"(阅读筛选,不是权限)。
  assert.match(confirm, /3 条意见待你处理/);
  assert.match(confirm, /转交 Agent 或核对答复后闭环/);
  // #255 去重:锚条不再自带「打开检视意见」——它和紧随其后的流内意见
  // 摘要行(每行已有带批注 id 的定向入口)加上材料栏常驻的「检视意见」
  // launcher 三重入口重复,摘掉锚条上的通用一颗。锚条退为纯状态行。
  const anchorBlock = /<div class="ws-anchor attention"[^]*?<\/div>/.exec(confirm)?.[0] ?? "";
  assert.ok(anchorBlock, "待你处理态锚条必须在场");
  assert.doesNotMatch(anchorBlock, /<button/, "锚条不得再带「打开检视意见」入口(流内行已有定向入口)");
  // 线程视图里当前卡照样钉在末尾:它的提交区经 portal 挂在输入框里,卡一不渲
  // 输入框就空了(用户点「看处理记录」后实锤"说给 Agent 栏没了")。
  const threaded = render({ task: waitingTask, decides: true, thread: "a-1",
    currentCard: React.createElement("div", { className: "probe-card" }, "决定卡本体") });
  assert.match(threaded, /只看这条意见的处理记录/);
  assert.match(threaded, /conv-card current"><div class="probe-card">决定卡本体/,
    "线程视图不丢当前卡");
});

test("超过一屏的历史默认折叠,给出「显示更早的 N 条」", () => {
  const many: ConversationItem[] = Array.from({ length: 60 }, (_, index) => ({
    kind: "turn", id: `turn-${index}`, ts: new Date(Date.parse(T0) + index * 60_000).toISOString(),
    end_ts: T0, open: false, texts: [{ ts: T0, text: `第 ${index} 段`, truncated: false, role: "handoff" }],
    steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
  }));
  const html = render({ items: many });
  assert.match(html, /显示更早的 10 条/);
  assert.doesNotMatch(html, /第 3 段/);
  assert.match(html, /第 59 段/);
});


test("举卡前那段话与当前卡的决策背景重复时,流里只留卡里那份;回合全是过程话时摊开最后一段", () => {
  const speech = "三条意见逐条处理如下,一条需要你补充信息:长文的边界按信息任务还是按字数?";
  const withCard = { ...task, status: "waiting_for_human",
    waiting: { waiting_id: "w3", state_version: 1, created_at: T3, context: speech,
      question: { questions: [{ question: "按哪种?" }] } } } as unknown as TaskSummary;
  const echoed: ConversationItem[] = [
    { kind: "turn", id: "turn-echo", ts: T2, end_ts: T3, open: false,
      texts: [{ ts: T2, text: "我先看一眼 spec。", truncated: false, role: "narration" },
        { ts: T3, text: speech, truncated: false, role: "handoff" }],
      steps: { calls: 1, errors: 0, reads: 1, edits: 0, bash: 0, agents: 0, sample: [] } },
  ];
  const html = render({ task: withCard, items: echoed, decides: true,
    currentCard: React.createElement("div", { className: "probe-card" }, "卡") });
  assert.doesNotMatch(html, /长文的边界按信息任务还是按字数/, "同一段字不读两遍");
  assert.match(html, /1 段过程说明/);
  const narrationOnly: ConversationItem[] = [
    { kind: "turn", id: "turn-n", ts: T2, end_ts: T3, open: true,
      texts: [{ ts: T2, text: "先读调用点。", truncated: false, role: "narration" },
        { ts: T3, text: "现在补一个条目再跑测试。", truncated: false, role: "narration" }],
      steps: { calls: 2, errors: 0, reads: 2, edits: 0, bash: 0, agents: 0, sample: [] } },
  ];
  const running = render({ items: narrationOnly });
  assert.match(running, /现在补一个条目再跑测试。/, "没有交接语时最后一段过程话摊开");
  assert.match(running, /1 段过程说明/);
  assert.match(running, /正在进行/);
});

test("责任人回答前，查看者能读当前题目/选项/背景，但没有代答控件", () => {
  const waitingTask = { ...task, status: "waiting_for_human", waiting: {
    waiting_id: "w-readonly", state_version: 1, created_at: T3,
    context: "需要确认接口兼容策略", question: { questions: [
      { question: "是否保留旧接口？", options: ["保留兼容", "直接替换"] },
      { question: "补充约束", options: [] },
    ] },
  } } as unknown as TaskSummary;
  const card = React.createElement(TaskWaitingFacts, { task: waitingTask });
  const facts = renderToStaticMarkup(card);
  for (const text of ["是否保留旧接口？", "保留兼容", "直接替换", "补充约束", "需要确认接口兼容策略", "只读查看"]) {
    assert.ok(facts.includes(text), `查看者必须能读：${text}`);
  }
  assert.doesNotMatch(facts, /<(?:input|textarea|button|form)\b|role="radio"/);
  const html = render({ task: waitingTask, decides: false, currentCard: card, filter: "mine", thread: "a-1" });
  assert.match(html, /是否保留旧接口？/);
  assert.match(html, /等待答复/);
  assert.doesNotMatch(html, /<em class="conv-tag att">等你决定<\/em>/);
});


test("责任人接收所有当前回执待办，检视人不能被提示承担最终处置", () => {
  assert.deepEqual(visibleConversationItems(items, { filter: "mine", viewer: "zhou", owner: "lin" }), []);
  assert.deepEqual(visibleConversationItems(items, { filter: "mine", viewer: "lin", owner: "lin" }).map((row) => row.id), ["receipts-1"]);
  const html = render({ items: [{ kind: "verified", id: "resolution", ts: T3, annotation: ref,
    by: "lin", resolution: { revision: 0, outcome: "accepted_risk", reason: "外部环境缺失，后续补验", by: "lin", at: T3 } }] });
  assert.match(html, /责任人接受风险继续/);
  assert.match(html, /外部环境缺失，后续补验/);
  assert.doesNotMatch(html, /确认 1 条意见已修好/);
});
