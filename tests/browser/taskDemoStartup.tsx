import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import TaskDemoWorkspace from "../../web/src/TaskDemoWorkspace";
import { createTaskDemoPreviewInput } from "../../web/src/TaskDemoPreview";
import kernelFlow from "../../kernel/flow/flow.json";
import type { ConversationItem } from "../../web/src/api";
import type { TaskDemoSnapshot } from "../../web/src/taskDemoTypes";

// 复用资料夹具，但通过正式 sourceTaskId 入口和真实组件读取快照。
// 补充服务永远不返回；同时验证真实结构的多轮历史、当前待确认卡与对应回复。
const fixture = createTaskDemoPreviewInput();
const snapshots = [fixture.snapshot, ...(fixture.relatedSnapshots ?? [])];
const titles = Object.fromEntries(Object.entries(kernelFlow.steps).map(([id, step]) => [id, step.title]));
const phaseNames = fixture.snapshot.task.progress!.phases;
const designPhase = "写设计";
const requests: Array<{ method: string; path: string }> = [];
const generationRequests: string[] = [];
const errors: string[] = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

for (const snapshot of snapshots) {
  const missingSteps = new Set([
    ...(snapshot.phase_steps?.[designPhase] ?? []),
    ...(snapshot.task.parent_task_id ? snapshot.phase_steps?.[phaseNames[0]] ?? [] : []),
  ]);
  snapshot.conversation.items = snapshot.conversation.items.filter(item => item.kind !== "card" || !missingSteps.has(item.step));
  snapshot.step_titles = titles;
  snapshot.card_contexts = {};
  for (const [index, item] of snapshot.conversation.items.entries()) {
    if (item.kind !== "card") continue;
    item.step = item.step === "requirement_analysis" ? "" : titles[item.step] ?? item.step;
    const previous = snapshot.conversation.items[index - 1];
    snapshot.card_contexts[item.waiting_id] = {
      context: `历史确认背景：${item.step || "需求拆分"}`,
      preface: previous?.kind === "turn" ? previous.texts.map(row => row.text).join("\n\n") : undefined,
    };
  }
  if (snapshot.task.waiting) {
    snapshot.task.waiting.step = snapshot.task.waiting.step === "requirement_analysis"
      ? "" : titles[snapshot.task.waiting.step ?? ""] ?? snapshot.task.waiting.step;
  }
}
const [currentChild, historicalChild, boundaryChild] = snapshots.slice(1);
const designStep = titles.story;
const roundText = {
  oldQuestion: "是否采用旧版同步释放方案？",
  oldReply: "旧轮设计采用同步调用库存服务，等待接口返回后再完成取消。",
  newQuestion: "是否确认异步释放和三次重试方案？",
  newReply: "本轮已改为异步释放，三次重试后告警；请确认延迟与告警处理安排。",
  newContext: "异步释放设计已完成检视，需要确认三次重试及告警责任人。",
  archivedQuestion: "是否确认归档交付轮中的幂等设计？",
  archivedReply: "归档交付轮已补充预占编号去重与失败重试，等待确认该版幂等设计。",
  boundaryQuestion: "是否确认恢复会话后的库存补偿方案？",
  boundaryReply: "本轮恢复后已补充库存补偿；异常订单进入人工处理列表。",
  boundaryContext: "请确认库存补偿与异常订单处理范围。",
};
const at = (minutes: number) => new Date(Date.parse("2026-10-22T02:00:00.000Z") + minutes * 60_000).toISOString();
function turn(id: string, text: string, minute: number): Extract<ConversationItem, { kind: "turn" }> {
  return { kind: "turn", id, ts: at(minute), end_ts: at(minute), open: false,
    texts: [{ ts: at(minute), text, truncated: false, role: "handoff" }],
    steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] } };
}
function historyRound(snapshot: TaskDemoSnapshot, id: string, question: string, reply: string, minute: number) {
  snapshot.conversation.items.push(turn(`reply-${id}`, reply, minute), {
    kind: "card", id: `card-${id}`, ts: at(minute + 1), waiting_id: id, step: designStep,
    purpose: "confirmation", annotation_ids: [], status: "resolved", questions: [{ question, options: ["确认", "调整"] }],
  });
  snapshot.card_contexts![id] = { context: `设计检视记录：${question}`, preface: reply };
}
function currentWaiting(snapshot: TaskDemoSnapshot, id: string, question: string, reply: string, context: string, minute: number) {
  snapshot.task.status = "waiting_for_human";
  snapshot.task.progress = { ...snapshot.task.progress!, current_index: phaseNames.indexOf(designPhase),
    current_phase: designPhase, step_id: "story", step: designStep };
  snapshot.task.waiting = { waiting_id: id, state_version: 3, created_at: at(minute), step: designStep,
    context, preface: reply, question: { purpose: "confirmation", questions: [{ question, options: ["确认", "调整"] }] } };
}
// 当前真实卡不在 conversation 中，而且同阶段已经有旧卡；必须展示更新的真实待确认问题。
historyRound(currentChild, "design-old", roundText.oldQuestion, roundText.oldReply, 0);
currentChild.conversation.items.push({ kind: "decision", id: "decision-design-old", ts: at(2),
  waiting_id: "design-old", decision: "adjust", notes: "改为异步释放后再确认", purpose: "confirmation", annotation_ids: [] },
turn("reply-design-current", roundText.newReply, 3));
currentWaiting(currentChild, "design-current", roundText.newQuestion, roundText.newReply, roundText.newContext, 4);
// 快照可能包含多个交付轮的历史卡，选中最新一轮并在长历史中直接定位。
historyRound(historicalChild, "design-archived-old", roundText.oldQuestion, roundText.oldReply, 0);
historicalChild.conversation.items.push({ kind: "decision", id: "decision-archived-old", ts: at(2),
  waiting_id: "design-archived-old", decision: "adjust", notes: "补充幂等设计", purpose: "confirmation", annotation_ids: [] });
historyRound(historicalChild, "design-archived-new", roundText.archivedQuestion, roundText.archivedReply, 3);
for (let index = 0; index < 55; index++) historicalChild.conversation.items.push(
  turn(`later-${index}`, `后续交付记录 ${index + 1}，不属于设计确认轮。`, 5 + index));
// 历史没有本阶段卡，也没有本轮独立回复：只能使用当前真实卡随附的原文，不能跨会话借用旧回复。
boundaryChild.conversation.items.push(turn("reply-previous-session", roundText.oldReply, 0),
  { kind: "session", id: "session-resumed", ts: at(2), phase: "started", resume: true });
currentWaiting(boundaryChild, "design-resumed", roundText.boundaryQuestion, roundText.boundaryReply, roundText.boundaryContext, 3);
const originals = snapshots.map(snapshot => JSON.stringify(snapshot));
window.fetch = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  requests.push({ method, path });
  if (path.endsWith("/demo-card")) {
    generationRequests.push(path);
    return new Promise<Response>(() => {});
  }
  if (!["GET", "HEAD"].includes(method)) throw new Error(`正式演示访问了源写接口：${method} ${path}`);
  return fixture.fetchRead(input, init);
};

const root = createRoot(document.getElementById("app")!);
const pause = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const visible = (element: Element) => Boolean(element.getClientRects().length);
async function until(condition: () => unknown, message: string) {
  for (let index = 0; index < 90 && !condition(); index++) await pause();
  check(condition(), message);
}
function assertReady() {
  check(!document.querySelector(".task-demo-loading"), "切换后仍停留在准备演示副本");
  check(!document.body.textContent?.includes("无法打开演示副本"), "缺卡阻止了演示打开");
  check(!document.body.textContent?.includes("正在根据原任务资料补充"), "阶段切换仍等待补充卡片");
  check(generationRequests.length === 0, "进入或切换演示调用了模型补卡接口");
}
async function selectPhase(phase: string, mainTask: boolean) {
  const label = phase === "定规格" ? "写规格" : mainTask && phase === "澄清需求" ? "需求拆分" : phase;
  const control = [...document.querySelectorAll<HTMLElement>('.task-phase[role="button"]')]
    .find(element => visible(element) && element.textContent?.trim() === label);
  check(control, `缺少阶段入口：${label}`);
  control!.click();
  await until(() => document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === phase,
    `无法切换到${label}`);
  assertReady();
}

async function assertFocusedCard(cardId: string, question: string, reply: string, replyId?: string) {
  let bounds = "";
  try { await until(() => {
    const container = document.querySelector<HTMLElement>(".ws-stream");
    const card = document.getElementById(`conv-${cardId}`);
    const message = replyId ? document.getElementById(`conv-${replyId}`) : card;
    if (!container || !card || !message) { bounds = JSON.stringify({ container: !!container, card: !!card, message: !!message, highlighted: [...document.querySelectorAll(".task-demo-message-highlight")].map(element => element.id) }); return false; }
    const viewport = container.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const messageRect = message.getBoundingClientRect();
    const questionElement = [...card.querySelectorAll<HTMLElement>(".question-text")].find(element => element.textContent?.includes(question));
    const questionRect = questionElement?.getBoundingClientRect();
    bounds = JSON.stringify({ viewport: [viewport.top, viewport.bottom], card: [cardRect.top, cardRect.bottom],
      reply: [messageRect.top, messageRect.bottom], questionBounds: questionRect?.toJSON(), question: card.textContent });
    return card.classList.contains("task-demo-message-highlight")
      && message.classList.contains("task-demo-message-highlight")
      && Boolean(card.querySelector(".conv-card.current")) && card.textContent?.includes(question)
      && card.textContent?.includes(reply) && !card.textContent?.includes(roundText.oldQuestion)
      && messageRect.top >= viewport.top - 1 && messageRect.top < viewport.bottom - 45
      && cardRect.top >= messageRect.top && cardRect.top < viewport.bottom - 45
      && Boolean(questionRect && questionRect.top >= viewport.top && questionRect.bottom <= viewport.bottom + 1);
  }, `没有自动定位正确的真实问题及同轮回复：${cardId}`);
  } catch (error) { throw new Error(`${String(error)} ${bounds}`); }
  check(document.querySelectorAll(".conv-card.current").length === 1, "重复展示了当前确认卡");
  check(!document.getElementById("conv-card-design-old")?.classList.contains("task-demo-message-highlight"), "错误定位旧轮确认卡");
  check(!document.getElementById("conv-reply-previous-session")?.classList.contains("task-demo-message-highlight"), "跨会话借用了旧轮 Agent 回复");
}
async function openSource(snapshot: TaskDemoSnapshot) {
  root.render(null);
  await until(() => !document.querySelector(".task-demo-guide"), "未退出上一个演示副本");
  root.render(<TaskDemoWorkspace sourceTaskId={snapshot.source_task_id} />);
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(snapshot.task.title!)
    && document.querySelector(".task-demo-guide"), `正式入口未打开${snapshot.source_task_id}`);
  assertReady();
}

async function run() {
  check([fixture.snapshot, boundaryChild].every(snapshot => !snapshot.conversation.items.some(item => item.kind === "card"
    && (snapshot.phase_steps?.[designPhase] ?? []).map(step => titles[step] ?? step).includes(item.step))),
  "无历史卡的测试资料包含设计确认卡");
  root.render(<TaskDemoWorkspace sourceTaskId={fixture.snapshot.source_task_id} />);
  await until(() => document.querySelector(".task-demo-guide"), "正式演示入口被缺卡或模型调用阻塞");
  assertReady();
  check(requests.some(row => row.path === "/auth/me"), "未经过正式管理员校验入口");
  check(requests.some(row => row.path === `/tasks/${fixture.snapshot.source_task_id}/demo-snapshot`), "未读取源任务快照");
  for (const phase of phaseNames) await selectPhase(phase, true);
  await selectPhase("澄清需求", true);
  await until(() => document.querySelector('[aria-label="需求拆分关系"]'), "主任务拆分图没有恢复");
  const childButton = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="需求拆分关系"] button')]
    .find(element => visible(element) && element.textContent?.trim() === "查看子任务");
  check(childButton && !childButton.disabled, "缺少进入子任务的操作");
  childButton!.click();
  const child = snapshots.find(snapshot => snapshot.source_task_id === fixture.snapshot.task.requirement_graph!.repositories[0].task_id)!;
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(child.task.title!),
    "缺少启动卡导致子任务无法打开");
  assertReady();
  check(requests.some(row => row.path === `/tasks/${child.source_task_id}/demo-snapshot`), "子任务未从正式快照接口读取");
  for (const phase of phaseNames) await selectPhase(phase, false);
  await selectPhase(designPhase, false);
  await assertFocusedCard("card-design-current", roundText.newQuestion, roundText.newReply, "reply-design-current");
  await until(() => document.querySelector('.ws-doc[data-artifact="DEMO-001/story.md"]')?.textContent?.includes("模块职责"),
    "当前设计卡没有配合展示已有设计文档");
  const returnButton = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => visible(element) && element.textContent?.includes("返回主任务"));
  check(returnButton, "子任务缺少返回主任务操作");
  returnButton!.click();
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(fixture.snapshot.task.title!),
    "无法返回主任务演示");
  assertReady();
  await openSource(historicalChild);
  await selectPhase(designPhase, false);
  await assertFocusedCard("card-design-archived-new", roundText.archivedQuestion, roundText.archivedReply, "reply-design-archived-new");
  check(!document.getElementById("conv-card-design-archived-old")?.classList.contains("task-demo-message-highlight"), "多轮历史选中了旧轮");
  await openSource(boundaryChild);
  await selectPhase(designPhase, false);
  await assertFocusedCard("card-design-resumed", roundText.boundaryQuestion, roundText.boundaryReply);
  check(document.getElementById("conv-card-design-resumed")?.textContent?.includes(roundText.boundaryContext), "当前真实卡缺少原始确认背景");
  assertReady();
  check(requests.every(row => ["GET", "HEAD"].includes(row.method)), "演示读取期间发生了源任务写入");
  check(snapshots.every((snapshot, index) => JSON.stringify(snapshot) === originals[index]), "演示修改了原始快照");
  check(errors.length === 0, errors.join("\n"));
  return {
    passed: true, formalEntry: true, phases: phaseNames.length, parentChildRoundTrip: true,
    currentCardOverridesOlderHistory: true, latestHistoricalRoundFocused: true, currentCardWithoutHistoryFocused: true,
    previousSessionReplyNotBorrowed: true, generationRequests: generationRequests.length,
    sourceWrites: requests.filter(row => !["GET", "HEAD"].includes(row.method)).length,
    snapshotReads: requests.filter(row => row.path.endsWith("/demo-snapshot")).length,
  };
}
void run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), errors, requests }); })
  .finally(() => root.unmount());
