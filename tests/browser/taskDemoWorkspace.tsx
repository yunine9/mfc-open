import React from "../../web/node_modules/react";
import { createRoot } from "../../web/node_modules/react-dom/client";
import TaskDemoWorkspace from "../../web/src/TaskDemoWorkspace";
import TaskDemoDeliveryPreview from "../../web/src/TaskDemoDeliveryPreview";
import { TaskDemoFrame } from "../../web/src/TaskDemoFrame";
import { createTaskDemoPreviewInput } from "../../web/src/TaskDemoPreview";
import type { Annotation, MemoryInsights, MemoryRecord } from "../../web/src/api";
import type { TaskDemoSnapshot } from "../../web/src/taskDemoTypes";
import kernelFlow from "../../kernel/flow/flow.json";

const errors: string[] = [];
const realRequests: string[] = [];
const diagramRequests: string[] = [];
const nativeFetch = window.fetch.bind(window);
const diagramSource = '@startuml\ntitle 订单取消前后对比\nparticipant "订单服务" as Order\nparticipant "库存服务" as Stock\nOrder -> Stock: 释放库存（新增）\nStock --> Order: 幂等结果\n@enduml';
const sourceReads: Array<{ path: string; method: string }> = [];
const localWrites: Array<{ path: string; method: string; body: string }> = [];
window.addEventListener("error", event => errors.push(event.message));
window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
// Only the pure PlantUML renderer may reach the original transport; every task/API fallback remains a test failure.
window.fetch = async (input, init) => {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (method === "POST" && url.origin === location.origin && url.pathname === "/diagrams/plantuml") {
    diagramRequests.push(url.pathname);
    return nativeFetch(input, init);
  }
  realRequests.push(`${method} ${String(input)}`);
  throw new Error("The demo reached the original network transport");
};

const preview = createTaskDemoPreviewInput();
// 生产历史记录保存中文步骤标题；主分析确认没有内核步骤。复现该形态，避免只用步骤 ID 的样例漏检。
const stepTitles = Object.fromEntries(Object.entries(kernelFlow.steps).map(([id, step]) => [id, step.title]));
for (const snapshot of [preview.snapshot, ...(preview.relatedSnapshots ?? [])]) {
  snapshot.step_titles = { ...stepTitles };
  snapshot.card_contexts = {};
  // 通用测试材料在交付报告之前，演示不能因“报告”二字而选错前后对比来源。
  snapshot.artifacts.unshift({ name: "task-materials/单元测试报告.md", label: "单元测试报告.md",
    kind: "doc", bytes: 128, modified_at: snapshot.captured_at });
  const mainAnalysis = !snapshot.task.parent_task_id && Boolean(snapshot.task.requirement_graph);
  snapshot.conversation.items.forEach((item, index) => {
    if (item.kind !== "card") return;
    item.step = mainAnalysis && item.step === "requirement_analysis" ? "" : stepTitles[item.step] ?? item.step;
    const previous = snapshot.conversation.items[index - 1];
    snapshot.card_contexts![item.waiting_id] = {
      context: `原确认背景：${snapshot.task.title}，${item.step || "需求拆分"}阶段确认。`,
      preface: previous?.kind === "turn" ? previous.texts.map(text => text.text).join("\n\n") : undefined,
    };
  });
  // 真实完成任务可能有很长的后续记录。确认卡必须从首屏之外定位，不能只在短样例里碰巧可见。
  for (let index = 0; index < 75; index++) snapshot.conversation.items.push({
    kind: "turn", id: `late-history-${index}`, ts: "2026-10-22T09:00:00.000Z", end_ts: "2026-10-22T09:00:00.000Z",
    open: false, texts: [{ ts: "2026-10-22T09:00:00.000Z", truncated: false, role: "handoff", text: `后续检视记录 ${index + 1}：记录实际反馈和处理结果。` }],
    steps: { calls: 0, agents: 0, edits: 0, errors: 0, reads: 0, bash: 0, sample: [] },
  });
  if (snapshot.task.waiting?.step !== undefined) {
    snapshot.task.waiting.step = mainAnalysis && snapshot.task.waiting.step === "requirement_analysis"
      ? "" : stepTitles[snapshot.task.waiting.step] ?? snapshot.task.waiting.step;
  }
}
// 编码没有独立确认卡时，直接定位原任务最终代码检视，不补造编码卡。
const codingFixture = preview.relatedSnapshots![0];
const codingIndex = preview.snapshot.task.progress!.phases.indexOf("写代码");
const reviewIndex = preview.snapshot.task.progress!.phases.indexOf("检视与验证");
codingFixture.conversation.items = codingFixture.conversation.items.filter(item => item.id !== `example-card-${codingIndex}`);
const finalReviewCard = codingFixture.conversation.items.find(item => item.id === `example-card-${reviewIndex}`);
if (finalReviewCard?.kind === "card") finalReviewCard.step = "cloud_push_confirm";
// 主任务尚未生成交付报告；不能根据状态或“测试报告”名称展示空的前后对比入口。
const parentReportIndex = preview.snapshot.artifacts.findIndex(item => item.name === "task-materials/交付报告.md");
if (parentReportIndex >= 0) preview.snapshot.artifacts.splice(parentReportIndex, 1);
const sourceBefore = JSON.stringify(preview.snapshot);
const sourceReader = preview.fetchRead;
preview.fetchRead = async (input, init) => {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  sourceReads.push({ path: input instanceof Request ? input.url : String(input), method });
  if (decodeURIComponent(url.pathname).endsWith("/artifacts/task-materials/单元测试报告.md")) {
    return Response.json({ kind: "doc", content: "# 单元测试报告\n\n这份材料只有测试明细，不是本次交付的改动前后对比。" });
  }
  const response = await sourceReader(input, init);
  if (decodeURIComponent(url.pathname).endsWith("/artifacts/task-materials/交付报告.md")) {
    const body = await response.json();
    return Response.json({ ...body, content: body.content.replace("## 改动点 4+1",
      `## 改动点 4+1\n\n\`\`\`plantuml\n${diagramSource}\n\`\`\`\n`) });
  }
  return response;
};
const root = createRoot(document.getElementById("app")!);
const pause = (ms = 35) => new Promise(resolve => setTimeout(resolve, ms));
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const visible = (element: Element) => Boolean(element.getClientRects().length);
const button = (text: string, within: ParentNode = document) =>
  [...within.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => visible(element) && element.textContent?.trim() === text);
const workspaceTab = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
  .find(element => visible(element) && element.querySelector("span")?.textContent?.trim() === text);
async function until(condition: () => unknown, message: string) {
  for (let index = 0; index < 90 && !condition(); index++) await pause();
  check(condition(), message);
}
async function click(text: string, within: ParentNode = document) {
  const target = button(text, within);
  check(target && !target.disabled, `missing enabled button: ${text}`);
  target!.click(); await pause();
}
function fill(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
async function selectPhase(phase: string, mainTask = false) {
  const label = phase === "定规格" ? "写规格" : mainTask && phase === "澄清需求" ? "需求拆分" : phase;
  const target = [...document.querySelectorAll<HTMLElement>('.task-phase[role="button"]')]
    .find(item => item.textContent?.trim() === label);
  check(target, `phase control not found: ${phase}`);
  target!.click();
  await until(() => document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === phase,
    `stage guide not selected: ${phase}`);
}

async function assertFocusedRound(cardId: string, replyId: string, label: string) {
  let bounds = "";
  try { await until(() => {
    const container = document.querySelector<HTMLElement>(".ws-stream");
    const reply = document.getElementById(`conv-${replyId}`);
    const card = document.getElementById(`conv-${cardId}`);
    if (!container || !reply || !card || !card.querySelector(".conv-card.current")) return false;
    const viewport = container.getBoundingClientRect();
    const replyRect = reply.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    bounds = JSON.stringify({ viewport: [viewport.top, viewport.bottom], reply: [replyRect.top, replyRect.bottom], card: [cardRect.top, cardRect.bottom], scroll: container.scrollTop });
    return reply.classList.contains("task-demo-message-highlight") && card.classList.contains("task-demo-message-highlight")
      && replyRect.top >= viewport.top - 1 && replyRect.top < viewport.top + 35
      && cardRect.top >= replyRect.bottom - 1 && cardRect.top < viewport.bottom - 45;
  }, `${label}: historical reply and interactive confirmation card did not enter the conversation viewport together`);
  } catch (error) { throw new Error(`${String(error)} ${bounds}`); }
  check(document.querySelectorAll(".conv-card.current").length === 1, `${label}: rendered duplicate interactive cards`);
}

async function checkDeliveryKnowledgePanels(sourceTaskId: string) {
  const previousLocation = location.href;
  const analysisRoot = createRoot(document.getElementById("app")!);
  const reads: string[] = [];
  history.replaceState(null, "", `/?taskDemoPreview=1&deliveryAnalysis=1&deliveryTask=${encodeURIComponent(sourceTaskId)}&theme=light`);
  try {
    analysisRoot.render(<TaskDemoDeliveryPreview />);
    await until(() => document.querySelector('[data-demo-delivery-analysis="true"]')
      && document.querySelector(".delivery-detail-sheet")?.textContent?.includes("Token 消耗"),
    "delivery analysis preview did not load the selected task detail");
    check(document.querySelector(".delivery-detail-sheet")?.textContent?.includes(sourceTaskId),
      "delivery analysis opened a different source task");
    check(document.body.textContent?.includes("比例与用量均为样例"), "delivery preview omitted the sample-data disclosure");
    const sheet = document.querySelector<HTMLElement>(".delivery-detail-sheet")!;
    await click("Close", sheet);
    await until(() => !sheet.isConnected || sheet.hasAttribute("data-closed"), "delivery task detail could not be closed before changing tabs");
    const read = window.fetch;
    window.fetch = (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      check(method === "GET" || method === "HEAD", "read-only analysis UI attempted a mutation");
      reads.push(input instanceof Request ? input.url : String(input));
      return read(input, init);
    };
    await click("知识使用效能");
    await until(() => document.querySelector('[aria-label="知识效能摘要"]')
      && document.body.textContent?.includes("演示 · 重试策略 Skill"),
    "knowledge efficiency tab did not load sample consumption and improvement records");
    check(document.body.textContent?.includes("已装载，但没有读取记录"),
      "knowledge efficiency omitted the distinction between loading and actual use");
    check(!document.querySelector('[role="alert"]'), "knowledge efficiency displayed a read failure");
    const refresh = document.querySelector<HTMLButtonElement>('[aria-label="刷新知识效能"]');
    check(refresh && !refresh.disabled, "knowledge efficiency has no available refresh action");
    const readCount = reads.filter(path => path.startsWith("/knowledge-insights")).length;
    refresh!.click();
    await until(() => !refresh!.disabled
      && reads.filter(path => path.startsWith("/knowledge-insights")).length > readCount,
    "knowledge efficiency refresh did not complete through its isolated preview transport");
    await click("需求交付");
    await until(() => document.querySelector(".delivery-overview-grid"), "delivery view did not return after knowledge analysis");
    check(button("返回任务演示"), "analysis preview lost its task return action");
    check(realRequests.length === 0, "analysis preview fell back to the real network");
  } finally {
    analysisRoot.unmount();
    history.replaceState(null, "", previousLocation);
  }
}

async function checkProductionDemoFrame(sourceTaskId: string) {
  const frameRoot = createRoot(document.getElementById("app")!);
  try {
    frameRoot.render(<TaskDemoFrame taskId={sourceTaskId} onClose={() => {}} />);
    await until(() => document.querySelector('iframe[title="任务演示副本"]'),
      "production demo entry did not mount its isolated frame");
    const frame = document.querySelector<HTMLIFrameElement>('iframe[title="任务演示副本"]')!;
    const url = new URL(frame.src);
    check(url.origin === location.origin && url.pathname === "/"
      && url.searchParams.get("taskDemo") === sourceTaskId
      && !url.searchParams.has("taskDemoPreview"),
    "production frame does not open the authenticated source-task demo entry");
    check(url.searchParams.get("theme") === document.documentElement.dataset.theme,
      "production frame lost the current display theme");
    for (const permission of ["allow-scripts", "allow-same-origin", "allow-downloads", "allow-popups", "allow-popups-to-escape-sandbox"]) {
      check(frame.sandbox.contains(permission), `production demo frame lacks ${permission}`);
    }
  } finally {
    frameRoot.unmount();
  }
}

async function run() {
  check(preview.actor.role === "admin", "preview actor is not admin");
  check(preview.snapshot.task.luban_account !== preview.actor.username, "source owner must differ from admin");
  const phases = preview.snapshot.task.progress!.phases;
  check(phases.length === 7, "fixture does not exercise all seven kernel phases");
  const childSourceId = preview.snapshot.task.requirement_graph?.repositories[0]?.task_id;
  check(childSourceId, "decomposition has no existing child task to open");
  const childSnapshotPath = `/tasks/${childSourceId}/demo-snapshot`;
  const childSnapshot = await (await sourceReader(childSnapshotPath)).json() as TaskDemoSnapshot;
  const childSourceBefore = JSON.stringify(childSnapshot);
  check(childSnapshot.task.parent_task_id === preview.snapshot.source_task_id, "child fixture has lost its parent identity");
  check(childSnapshot.task.luban_account !== preview.actor.username, "child owner must differ from demo admin");
  function checkStageDirectory() {
    const mainTask = document.querySelector("#task-workspace-title")?.textContent === preview.snapshot.task.title;
    const actual = [...document.querySelectorAll<HTMLElement>('.task-phase[role="button"]')]
      .map(element => element.textContent?.trim());
    check(JSON.stringify(actual) === JSON.stringify(phases.map(phase => phase === "定规格" ? "写规格"
      : mainTask && phase === "澄清需求" ? "需求拆分" : phase)),
      `demo added or replaced a real workflow stage: ${actual.join(", ")}`);
  }
  function checkDeliveryAnalysisLink(sourceTaskId: string) {
    const link = document.querySelector<HTMLAnchorElement>(".ws-head .task-demo-delivery-analysis");
    check(link && visible(link) && link.textContent?.trim() === "交付分析",
      "completed demo phase did not expose its header delivery analysis link");
    const href = link!.getAttribute("href")!;
    const url = new URL(link!.href);
    check(url.origin === location.origin && url.pathname === "/"
      && url.searchParams.get("deliveryAnalysis") === "1"
      && url.searchParams.get("deliveryTask") === sourceTaskId,
    "delivery analysis link does not target the current source task");
    check(url.searchParams.get("taskDemoPreview") === "1" && link!.target === "_blank",
      "preview analysis link lost its isolated preview marker or new-window target");
    function clickWithoutOpening(): boolean | undefined {
      let preventedByDemo: boolean | undefined;
      const observe = (event: MouseEvent) => {
        if (!(event.target instanceof Element) || event.target.closest("a") !== link) return;
        // The demo capture listener has already run. Observe its decision, then
        // prevent the browser's default so the test never opens another window.
        preventedByDemo = event.defaultPrevented;
        event.preventDefault();
      };
      document.addEventListener("click", observe);
      try { link!.click(); }
      finally { document.removeEventListener("click", observe); }
      return preventedByDemo;
    }
    check(clickWithoutOpening() === false, "demo intercepted its own delivery analysis link");
    const unrelatedTask = new URL(url); unrelatedTask.searchParams.set("deliveryTask", `${sourceTaskId}-unrelated`);
    const outsideOrigin = new URL(url); outsideOrigin.hostname = "example.invalid";
    try {
      for (const blockedUrl of [unrelatedTask, outsideOrigin]) {
        link!.href = blockedUrl.href;
        check(clickWithoutOpening() === true, "delivery analysis exception allowed an unrelated or external destination");
      }
    } finally { link!.setAttribute("href", href); }
  }
  async function checkParentDiagramAccess() {
    await selectPhase("写设计", true);
    checkStageDirectory();
    check(button("需求拆分")?.getAttribute("role") === "tab", "design stage hid the main task decomposition tab");
    check(button("架构图")?.getAttribute("role") === "tab", "main task has no independent architecture tab");
    await click("架构图");
    await until(() => document.querySelector('[aria-label="Story 架构图"]'), "architecture tab did not open the actual architecture viewer");
    check(document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "写设计",
      "architecture material changed the selected workflow phase");
    check(button("需求拆分"), "opening architecture removed the decomposition entry");
    await click("需求拆分");
    await until(() => document.querySelector('[aria-label="需求拆分关系"]')
      && document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "澄清需求",
    "decomposition tab did not return from design to the real clarification stage and relationship graph");
    check(document.querySelector(".task-demo-guide")?.getAttribute("aria-label") === "需求拆分的人机协作",
      "decomposition tab did not restore its stage explanation");
    check(button("架构图")?.getAttribute("role") === "tab", "opening decomposition removed the architecture entry");
    checkStageDirectory();
    await click("架构图");
    await until(() => document.querySelector('[aria-label="Story 架构图"]'), "architecture could not be opened from the decomposition phase");
    check(document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "澄清需求",
      "architecture tab changed the clarification phase instead of switching material");
    await click("需求拆分");
    await until(() => document.querySelector('[aria-label="需求拆分关系"]'), "decomposition could not be reopened after architecture");
  }
  async function waitForChild() {
    await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(childSnapshot.task.title!),
      "opening a graph node did not load the child task");
    checkStageDirectory();
    check(!button("需求拆分"), "child task incorrectly exposes its parent's decomposition tab");
    check(document.querySelector(".ws-back-button")?.getAttribute("aria-label") === "返回上一任务",
      "child back action still uses the production task-list label");
    check([...document.querySelectorAll("button")].some(element => visible(element)
      && element.textContent?.includes("返回主任务") && element.textContent.includes(preview.snapshot.task.title!)),
    "child task omitted its parent return action");
  }
  async function openFirstChild() {
    const graph = document.querySelector('[aria-label="需求拆分关系"]');
    check(graph, "parent decomposition diagram is missing");
    await click("查看子任务", graph!);
    await waitForChild();
  }
  root.render(<TaskDemoWorkspace preview={preview} />);
  await until(() => document.querySelector(".task-demo-guide"), "demo workspace did not mount");
  const sandboxFetch = window.fetch;
  window.fetch = async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!["GET", "HEAD"].includes(method)) localWrites.push({
      path: input instanceof Request ? input.url : String(input), method, body: String(init?.body ?? ""),
    });
    return sandboxFetch(input, init);
  };

  await until(() => document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "澄清需求",
    "main task did not start in its real clarification phase");
  checkStageDirectory();
  check(document.querySelector(".ws-back-button")?.getAttribute("aria-label") === "退出演示",
    "main demo back action did not describe its exit behavior");
  check(!document.querySelector(".task-demo-delivery-analysis"), "analysis link appeared before the main task completed phase");
  await selectPhase("已合入", true);
  checkDeliveryAnalysisLink(preview.snapshot.source_task_id);
  await selectPhase("澄清需求", true);
  check(!document.querySelector(".task-demo-delivery-analysis"), "analysis link remained after leaving the main task completed phase");
  await checkParentDiagramAccess();
  await until(() => document.querySelector('[aria-label="需求拆分关系"]'),
    "requirement decomposition did not show its actual task relationship diagram");
  const decomposition = document.querySelector<HTMLElement>('[aria-label="需求拆分关系"]')!;
  check(visible(decomposition) && !decomposition.closest(".task-demo-guide"),
    "requirement relationship diagram replaced the guide instead of remaining actual task material");
  check(preview.snapshot.task.requirement_graph?.repositories.length === 3,
    "preview does not include parallel tasks and a dependent integration task");
  for (const repository of preview.snapshot.task.requirement_graph!.repositories) {
    check(decomposition.textContent?.includes(repository.name), `decomposition omitted task ${repository.name}`);
  }
  await until(() => (document.querySelector('[aria-label="选择本阶段展示回复"]') as HTMLSelectElement | null)?.value === "example-turn-decomposition",
    "main task clarification did not select its decomposition confirmation reply");
  await selectPhase("检视与验证", true);
  check(!workspaceTab("前后对比") && !document.querySelector(".task-demo-report-highlight"),
    "a task without the actual delivery report exposed a comparison report entry");
  await selectPhase("澄清需求", true);
  await until(() => document.querySelector('[aria-label="需求拆分关系"]'), "missing-report check did not restore parent decomposition");
  const splitCard = preview.snapshot.conversation.items.find(item => item.id === "example-card-decomposition");
  check(splitCard?.kind === "card" && splitCard.step === "", "main-task fixture did not exercise an empty historical step");
  // Fault injection stays inside the test fixture. A failed associated-task load
  // must leave the current task intact and allow the real retry action to recover.
  const liveChildSnapshot = preview.relatedSnapshots?.find(item => item.source_task_id === childSourceId);
  check(liveChildSnapshot, "child snapshot not available for navigation failure coverage");
  const validSchema = liveChildSnapshot!.schema;
  try {
    liveChildSnapshot!.schema = "invalid-test-snapshot" as TaskDemoSnapshot["schema"];
    await click("查看子任务", document.querySelector<HTMLElement>('[aria-label="需求拆分关系"]')!);
    await until(() => button("重试"), "failed child navigation did not provide a retry action");
    check(document.querySelector("#task-workspace-title")?.textContent?.includes(preview.snapshot.task.title!)
      && document.querySelector('[aria-label="需求拆分关系"]'), "failed navigation removed the current parent task");
    checkStageDirectory();
  } finally { liveChildSnapshot!.schema = validSchema; }
  await click("重试");
  await waitForChild();

  for (const phase of phases) {
    await selectPhase(phase);
    checkStageDirectory();
    const expectedRoundIndex = phase === "写代码" ? reviewIndex : phases.indexOf(phase);
    const originalCard = childSnapshot.conversation.items.find(item => item.kind === "card" && item.id === `example-card-${expectedRoundIndex}`);
    check(originalCard?.kind === "card", `${phase} fixture has no original confirmation card`);
    if (originalCard?.kind === "card") {
      check(Object.values(stepTitles).includes(originalCard.step) || originalCard.step === "cloud_push_confirm", `${phase} fixture retained an internal step ID`);
      const expected = childSnapshot.card_contexts?.[originalCard.waiting_id];
      await until(() => document.querySelector(".decision-card .waiting-context")?.textContent?.includes(expected!.context!),
        `${phase} did not restore the real card context from its Chinese step title`);
      check(document.querySelector(".decision-card .question-list")?.textContent?.includes(originalCard.questions[0].question),
        `${phase} replaced the real confirmation question`);
      check(document.querySelector(".decision-card .waiting-context")?.textContent?.includes(expected!.preface!),
        `${phase} dropped the Agent original explanation`);
      await assertFocusedRound(originalCard.id, `example-turn-${expectedRoundIndex}`, phase);
      const stream = document.querySelector<HTMLElement>(".ws-stream")!;
      check(stream.scrollHeight > stream.clientHeight * 4, `${phase}: fixture did not cover long history`);
      // 模拟演示者翻看后续记录，再点击当前阶段也应回到原确认轮次。
      stream.dispatchEvent(new WheelEvent("wheel", { deltaY: 500, bubbles: true }));
      stream.scrollTop = stream.scrollHeight;
      await pause();
      await selectPhase(phase);
      await assertFocusedRound(originalCard.id, `example-turn-${expectedRoundIndex}`, `${phase} repeated selection`);
      if (phase === "写设计") {
        await click("需要我的");
        await selectPhase(phase);
        await assertFocusedRound(originalCard.id, `example-turn-${expectedRoundIndex}`, `${phase} after filter`);
        const reply = document.getElementById(`conv-example-turn-${expectedRoundIndex}`)!;
        const earlier = reply.previousElementSibling as HTMLElement;
        const previousHeight = earlier.style.minHeight;
        earlier.style.minHeight = "240px";
        await pause(150);
        await assertFocusedRound(originalCard.id, reply.id.slice(5), `${phase} after delayed layout`);
        earlier.style.minHeight = previousHeight;
        await pause(150);
        await assertFocusedRound(originalCard.id, reply.id.slice(5), `${phase} after layout recovery`);
      }
    }
    check(!button("需求拆分"), `${phase} exposed the main task decomposition tab inside the child`);
    if (phase === "已合入") checkDeliveryAnalysisLink(childSourceId!);
    else check(!document.querySelector(".task-demo-delivery-analysis"), `${phase} showed the completed-phase analysis link too early`);
    const guide = document.querySelector<HTMLElement>(".task-demo-guide")!;
    check(!guide.closest(".ws-doc"), `${phase} guide replaced the material reader`);
    for (const label of ["Agent 的工作", "平台的作用与人机边界", "开发和需求 owner 的工作"]) {
      const section = guide.querySelector<HTMLElement>(`[aria-label="${label}"]`);
      check(section && visible(section) && section.textContent?.trim(), `${phase} omitted the illustrated ${label}`);
      check(section?.querySelector('[role="img"]'), `${phase} omitted its role pictogram: ${label}`);
    }
    for (const label of ["Agent 负责", "人和 Agent 的边界", "开发 / 需求 owner 负责"]) {
      check(![...guide.querySelectorAll("h3")].some(element => visible(element)
        && element.textContent?.trim() === label), `${phase} retained a visible role heading: ${label}`);
    }
    check(!guide.querySelector(".task-demo-guide-lead"), `${phase} retained the removed opening line`);
    check(!guide.querySelector(".task-demo-guide-header"), `${phase} retained the removed guide header`);
    check(!button("收起讲解") && !button("展开讲解"), `${phase} retained the removed guide toggle`);
    check(guide.querySelector('.task-demo-guide-platform-logo svg'), `${phase} omitted the platform brand image`);
    const materialSelector = phase === "已合入" ? ".ws-knowledge-view" : ".ws-doc";
    await until(() => {
      const material = document.querySelector<HTMLElement>(materialSelector);
      return material && material.dataset.loading !== "true" && material.textContent?.trim()
        && (phase === "已合入" || phase === "写代码" || material.querySelector("[data-l]"));
    }, `${phase} did not display its actual material beside the guide`);
    const material = document.querySelector<HTMLElement>(materialSelector)!;
    if (phase === "写代码") {
      check(material.classList.contains("is-diff") && material.textContent?.includes("outbox.enqueue"),
        "coding phase fell back to the original requirement instead of its actual code changes");
      check([...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
        .some(element => element.textContent?.startsWith("代码改动") && element.classList.contains("task-demo-artifact")),
      "coding phase did not highlight its code changes tab");
    }
    if (phase === "已合入") {
      check(material.textContent?.includes("知识"), "completed phase did not open knowledge reuse material");
      check(workspaceTab("用到的知识")?.classList.contains("task-demo-artifact"), "completed phase did not highlight knowledge reuse");
    }
    const materialRect = material.getBoundingClientRect();
    check(visible(material) && materialRect.height > 150 && materialRect.top < window.innerHeight - 150,
      `${phase} left no usable document reading area`);
    check(!button("查看材料 / 演示批注"), "demo still requires switching away from its guide to read material");
    if (phase === "写设计") {
      check(button("架构图")?.classList.contains("task-demo-artifact"), "design did not highlight its architecture diagram entry");
    }
    if (phase === "检视与验证") {
      check(!workspaceTab("前后对比"), "review added a duplicate comparison tab");
      check(workspaceTab("文档")?.getAttribute("aria-selected") === "true", "review did not retain the existing document tab");
      const report = [...document.querySelectorAll<HTMLButtonElement>(".ws-document-tabs .task-demo-artifact")]
        .find(element => /交付报告/.test(element.textContent ?? ""));
      check(report?.classList.contains("on"), "review did not automatically open the actual delivery report");
      await until(() => document.querySelector('.ws-doc.task-demo-report-highlight[data-artifact="task-materials/交付报告.md"]')?.textContent?.includes("改动前")
        && document.querySelector(".ws-doc.task-demo-report-highlight")?.textContent?.includes("改动后"),
      "review did not automatically frame its real before-and-after report");
      const reportBody = document.querySelector<HTMLElement>(".ws-doc.task-demo-report-highlight")!;
      await until(() => {
        const image = reportBody.querySelector<HTMLImageElement>('.plantuml-viewport img[alt="PlantUML 图"]');
        return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }, "demo transport prevented the actual PlantUML component from rendering its report diagram");
      check(!reportBody.querySelector(".plantuml-unsupported") && !reportBody.querySelector(".plantuml-figure.syntax-error"),
        "report diagram fell back to source or an error instead of the rendered graph");
      check(!reportBody.querySelector<HTMLDetailsElement>(".plantuml-source")?.open, "report diagram only displayed PlantUML source");
      check(diagramRequests.length === 1, "PlantUML rendering did not pass through the allowed original transport");
      await pause(200);
      const diagram = reportBody.querySelector<HTMLElement>(".plantuml-figure")!;
      await click("查看大图 ⛶", diagram);
      try { await until(() => diagram.classList.contains("is-presenting") && diagram.getBoundingClientRect().width >= window.innerWidth - 2,
        "demo report PlantUML diagram could not open in its full-screen viewer");
      } catch (error) { throw new Error(`${String(error)} ${JSON.stringify({ connected: diagram.isConnected, className: diagram.className, rect: diagram.getBoundingClientRect().toJSON(), currentClass: reportBody.querySelector(".plantuml-figure")?.className })}`); }
      await click("退出全屏", diagram);
      await until(() => !diagram.classList.contains("is-presenting"), "demo report diagram could not return to the document");
      check(getComputedStyle(reportBody).outlineWidth === "3px", "comparison report body has no visible highlight frame");
      check(parseFloat(getComputedStyle(reportBody).paddingLeft) >= 12, "comparison frame overlaps report text");
      check(![...document.querySelectorAll<HTMLElement>(".ws-document-tabs .task-demo-artifact")]
        .some(element => element.textContent?.includes("单元测试报告")), "review highlighted a generic test report as the comparison report");
      const otherDocument = [...document.querySelectorAll<HTMLButtonElement>(".ws-document-tabs .ws-tab")]
        .find(element => element.textContent?.includes("单元测试报告"));
      check(otherDocument, "existing document list has no other material");
      otherDocument!.click();
      await until(() => !document.querySelector(".task-demo-report-highlight"), "document list did not leave the comparison report");
      report!.click();
      await until(() => document.querySelector('.ws-doc.task-demo-report-highlight[data-artifact="task-materials/交付报告.md"]')
        && document.querySelector(".ws-doc")?.textContent?.includes("改动前"), "existing report file entry could not reopen the report");
    } else {
      check(!workspaceTab("前后对比") && !document.querySelector(".task-demo-report-highlight"),
        `${phase} retained the review-only comparison highlight`);
    }
    check(!document.querySelector('[aria-label$="阶段执行方案"]'), "demo phase opened the production plan dialog");
    await until(() => (document.querySelector('[aria-label="选择本阶段展示回复"]') as HTMLSelectElement | null)?.value === `example-turn-${expectedRoundIndex}`,
      `${phase} did not select the matching example turn`);
  }

  await selectPhase("写设计");
  check(!document.querySelector(".task-demo-delivery-analysis"), "analysis link remained after leaving the child completed phase");
  await until(() => document.querySelector('.ws-doc[data-artifact="DEMO-001/story.md"] .annotatable [data-l]')
    || document.querySelector('.ws-doc[data-artifact="DEMO-001/story.md"] [data-l]'),
  "design material did not open in the real annotatable reader");
  const reader = document.querySelector<HTMLElement>('.ws-doc[data-artifact="DEMO-001/story.md"]')!;
  const quoted = "采用异步释放，允许取消成功与库存可用之间存在短暂延迟。";
  const line = [...reader.querySelectorAll<HTMLElement>("[data-l]")]
    .find(element => element.textContent?.includes(quoted));
  check(line, "design line for selection is missing");
  line!.scrollIntoView({ block: "center" });
  const range = document.createRange(); range.selectNodeContents(line!);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  await until(() => button("批注选中内容", reader), "selecting design text did not expose annotation action");
  await click("批注选中内容", reader);
  await until(() => reader.querySelector('textarea[placeholder="写下检视意见…"]'), "annotation editor not available to admin");
  const note = "演示测试：请明确库存释放延迟上限和超过上限后的处理。";
  fill(reader.querySelector<HTMLTextAreaElement>('textarea[placeholder="写下检视意见…"]')!, note);
  await pause();
  await click("记下", reader);
  await until(() => localWrites.some(item => item.method === "POST" && /\/annotations$/.test(item.path)), "annotation was not saved through the real API component");
  const createWrite = localWrites.find(item => item.method === "POST" && /\/annotations$/.test(item.path))!;
  const payload = JSON.parse(createWrite.body);
  check(payload.note === note && payload.artifact === "DEMO-001/story.md", "annotation lost the real material target");
  check(payload.quote?.includes(quoted), "annotation lost the selected text");
  const copyBase = createWrite.path.replace(/\/annotations$/, "");
  check(new URL(copyBase, location.origin).pathname !== `/tasks/${preview.snapshot.source_task_id}`, "annotation targeted source task");
  check(new URL(copyBase, location.origin).pathname !== `/tasks/${childSourceId}`, "annotation targeted source child task");
  const annotations = async () => (await (await window.fetch(`${copyBase}/annotations`)).json()) as { items: Annotation[] };
  await until(() => document.body.textContent?.includes(note), "saved annotation not visible");
  let rows = await annotations();
  check(rows.items.length === 1 && rows.items[0].author === preview.actor.username, "admin annotation did not belong to disposable copy");
  check(rows.items[0].status === "draft", "saving annotation unexpectedly submitted it");

  // Open the existing review pane; do not replace it with a test-only editor.
  const reviewEntry = [...document.querySelectorAll<HTMLButtonElement>("button")].find(element =>
    visible(element) && (/批注/.test(element.textContent ?? "") || /检视/.test(element.textContent ?? ""))
      && (element.getAttribute("aria-controls") === "ws-review-canvas"
        || element.getAttribute("title")?.includes("批注") || element.textContent?.trim().startsWith("检视意见")));
  if (reviewEntry) { reviewEntry.click(); await pause(); }
  const panels = [...document.querySelectorAll<HTMLDetailsElement>("details.annot-panel")];
  for (const panel of panels) if (!panel.open) { panel.open = true; panel.dispatchEvent(new Event("toggle")); }
  await until(() => button("提交修改意见"), "admin cannot forward the saved annotation from the review panel");
  await click("提交修改意见");
  await until(() => button("确认闭环"), "simulated receipt did not expose owner confirmation");
  rows = await annotations();
  check(rows.items[0].response?.summary.includes("演示"), "response was not identified as simulated");
  check(rows.items[0].response?.evidence.some(item => item.includes("不是实际代码或验证证据")), "simulated response looks like real verification");
  await click("确认闭环");
  rows = await annotations();
  check(rows.items[0].status === "verified" && rows.items[0].verified_by === preview.actor.username,
    "admin did not complete the annotation as demo owner");

  const returnToParent = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(element => visible(element) && element.textContent?.includes("返回主任务"));
  check(returnToParent, "child task has no action to return to its parent");
  returnToParent!.click();
  await until(() => document.querySelector("#task-workspace-title")?.textContent?.includes(preview.snapshot.task.title!),
    "child did not return to the original parent demo");
  checkStageDirectory();
  check(document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "澄清需求",
    "returning from child lost the parent clarification stage");
  rows = await annotations();
  check(rows.items.length === 1 && rows.items[0].status === "verified",
    "reading the child copy while parent is active was routed to the wrong task");
  await until(() => document.querySelector('[aria-label="需求拆分关系"]'), "parent relation diagram did not return");
  await checkParentDiagramAccess();
  await openFirstChild();
  check(document.querySelector(".task-demo-guide")?.getAttribute("data-demo-phase") === "写设计",
    "reopening child lost its selected design stage");
  rows = await annotations();
  check(rows.items.length === 1 && rows.items[0].status === "verified" && rows.items[0].note === note,
    "navigating between parent and child lost the child annotation or confirmation");
  await until(() => document.querySelector('.ws-doc[data-artifact="DEMO-001/story.md"] [data-l]'),
    "reopening child lost its design document");

  const sourceDocumentBefore = await (await sourceReader(`/tasks/${childSourceId}/artifacts/${encodeURIComponent("DEMO-001/story.md")}`)).text();
  await click("重置演示");
  await until(() => document.body.textContent?.includes("已重置演示副本"), "reset did not finish");
  rows = await annotations();
  check(rows.items.length === 0, "reset retained demo annotations");
  const copyDocumentAfter = await (await window.fetch(`${copyBase}/artifacts/${encodeURIComponent("DEMO-001/story.md")}`)).text();
  check(copyDocumentAfter === sourceDocumentBefore, "reset changed the source design material");

  // Follow the actual task knowledge entry into the shared MemoryBoard editor.
  check(workspaceTab("用到的知识"), "knowledge tab is missing");
  workspaceTab("用到的知识")!.click();
  await until(() => document.querySelector('.ws-knowledge-view a[href*="kbPage=experience"]'),
    "task knowledge did not provide its experience review entry");
  const knowledgeLink = document.querySelector<HTMLAnchorElement>('.ws-knowledge-view a[href*="kbPage=experience"]')!;
  knowledgeLink.click();
  await until(() => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .some(element => element.textContent?.includes("演示副本 · 经验审查与复用")),
  "knowledge entry did not open MemoryBoard inside the demo");
  const memoryDialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find(element => element.textContent?.includes("演示副本 · 经验审查与复用"))!;
  await until(() => button("查看并审查", memoryDialog), "demo memory candidate cannot be reviewed");
  await click("查看并审查", memoryDialog);
  await until(() => button("采纳供 Agent 复用", memoryDialog), "real memory editor did not allow adoption");
  check(memoryDialog.textContent?.includes("采纳、修订和停用仅保存在演示副本"), "memory review omitted its demo-only disclosure");
  const memoryId = new URL(location.href).searchParams.get("memory_id");
  check(memoryId, "opening memory did not identify the selected candidate");
  const readMemory = async () => (await (await window.fetch(`/memory-insights/${encodeURIComponent(memoryId!)}`)).json()) as { record: MemoryRecord; content: string };
  await click("采纳供 Agent 复用", memoryDialog);
  await until(() => button("保存修改", memoryDialog), "adopted memory did not update the editor");
  let memory = await readMemory();
  check(memory.record.review?.status === "accepted" && memory.record.review.by === preview.actor.username,
    "admin adoption was not saved in the demo memory");
  check(memory.record.maintenance_note?.includes("未写入真实知识库"), "adoption looked like a real knowledge publication");
  await click("停用，保留历史", memoryDialog);
  await until(() => button("采纳供 Agent 复用", memoryDialog), "deactivated memory did not return to reviewable state");
  memory = await readMemory();
  check(memory.record.review?.status === "rejected", "memory deactivation was not saved");
  const memoryHistory = await (await window.fetch(`/memory-insights/${encodeURIComponent(memoryId!)}/history`)).json() as MemoryRecord[];
  check(memoryHistory.some(record => record.review?.status === "accepted")
    && memoryHistory.at(-1)?.review?.status === "rejected", "deactivation lost the adoption history");
  const closeMemory = button("Close", memoryDialog);
  check(closeMemory, "memory review has no close action");
  closeMemory!.click();
  await until(() => !memoryDialog.isConnected || memoryDialog.hasAttribute("data-closed"), "memory review did not close");
  await click("重置演示");
  await pause();
  const resetMemories = await (await window.fetch("/memory-insights")).json() as MemoryInsights;
  check(resetMemories.memories.every(record => record.review?.status === "pending"), "reset retained demo memory decisions");
  check(JSON.stringify(preview.snapshot) === sourceBefore, "demo mutated its source snapshot");
  check(JSON.stringify(await (await sourceReader(childSnapshotPath)).json()) === childSourceBefore,
    "demo mutated its child source snapshot");
  check(localWrites.some(item => /\/annotations\/send$/.test(item.path))
    && localWrites.some(item => /\/(resolve|verify)$/.test(item.path)), "test skipped forward or confirm operation");
  check(localWrites.filter(item => /\/tasks\//.test(item.path)).every(item => item.path.startsWith(`${copyBase}/`)),
    "task writes leaked into a different task while navigating parent and child");
  check(sourceReads.every(item => item.method === "GET" || item.method === "HEAD"), "mutation reached source read transport");
  const memoryWrites = localWrites.filter(item => /^\/memory-insights\/[^/]+\/review$/.test(item.path));
  check(memoryWrites.length === 2 && JSON.parse(memoryWrites[0].body).decision === "accepted"
    && JSON.parse(memoryWrites[1].body).decision === "rejected", "test skipped actual adoption or deactivation");
  check(realRequests.length === 0, `real network used: ${realRequests.join(", ")}`);
  check(errors.length === 0, errors.join("\n"));
  root.unmount();
  await checkDeliveryKnowledgePanels(childSourceId!);
  await checkProductionDemoFrame(childSourceId!);
  check(errors.length === 0, errors.join("\n"));
  return { passed: true, historicalCards: true, historicalRoundFocus: true, comparisonReportFocus: true, codingUsesActualFinalReview: true, plantUmlRendered: true, diagramRequests: diagramRequests.length, width: window.innerWidth, phases: phases.length, parentChildRoundTrip: true, navigationRetry: true, materialAlwaysVisible: true, directDocumentAnnotations: true, knowledgeAnalytics: true, productionFrame: true, localWrites: localWrites.length, memoryDecisions: memoryWrites.length, sourceWrites: 0, realRequests: 0 };
}

run().then(result => { document.getElementById("result")!.textContent = JSON.stringify(result); })
  .catch(error => { document.getElementById("result")!.textContent = JSON.stringify({ error: String(error), errors, localWrites, sourceReads, diagramRequests,
    material: [...document.querySelectorAll(".ws-doc")].map(element => ({ artifact: element.getAttribute("data-artifact"), loading: element.getAttribute("data-loading"), text: element.textContent?.slice(0, 1600) })),
    buttons: [...document.querySelectorAll("button")].filter(visible).map(element => element.textContent?.trim()).filter(Boolean),
  }); });
