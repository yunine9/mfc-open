import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationItem } from "../web/src/api";
import { createTaskDemoSandbox } from "../web/src/taskDemoSandbox";
import { hasTaskDemoPhaseCard, suggestedDemoMessage, taskDemoConversation, taskDemoPhaseCard, type TaskDemoSnapshot } from "../web/src/taskDemoTypes";

const at = "2026-10-22T00:00:00Z";
const turn = (id: string): Extract<ConversationItem, { kind: "turn" }> => ({
  kind: "turn", id, ts: at, end_ts: at, open: false,
  texts: [{ text: id, ts: at, truncated: false, role: "handoff" }],
  steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] },
});
const card = (id: string, step = "story"): Extract<ConversationItem, { kind: "card" }> => ({
  kind: "card", id, ts: at, waiting_id: id, step, purpose: "confirmation",
  annotation_ids: [], questions: [{ question: id, options: ["确认", "调整"] }], status: "resolved",
});
const snapshot = (items: ConversationItem[]): TaskDemoSnapshot => ({
  schema: "mae-flow-demo-snapshot/1", captured_at: at, source_task_id: "source",
  task: { id: "source", requirement: "设计演示", created_at: at, status: "completed", luban_account: "owner",
    progress: { phases: ["写设计"], current_index: 0, current_phase: "写设计" } },
  phase_steps: { "写设计": ["story"] }, conversation: { items }, artifacts: [], annotations: { items: [] }, problems: [],
});

test("多轮设计确认：高亮回复与演示提问使用同一轮历史卡片", () => {
  const source = snapshot([turn("第一版方案"), card("第一轮确认"), turn("修改后的方案"), card("第二轮确认")]);
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
    conversation: source.conversation.items, fetchRead: async () => { throw new Error("此测试不应访问来源"); } });
  try {
    assert.equal(suggestedDemoMessage(source, "写设计"), "修改后的方案");
    assert.equal(demo.selectPhase("写设计").waiting?.question?.questions?.[0]?.question, "第二轮确认");
  } finally { demo.dispose(); }
});

test("最近卡片前没有相邻回复时定位原卡，不借用上一轮或其他阶段的回复", () => {
  assert.equal(suggestedDemoMessage(snapshot([turn("旧回复"), card("旧确认"), card("新确认")]), "写设计"), "新确认");
  assert.equal(suggestedDemoMessage(snapshot([turn("spec说明"), card("spec确认", "open")]), "写设计"), undefined);
});

test("定制流程按任务固定的阶段步骤匹配，与演示问题一致", () => {
  const source = snapshot([turn("定制设计说明"), card("定制确认", "custom_story")]);
  source.task.workflow_profile = { schema: "mae-flow-execution-profile/2", revision: "1",
    source: { kind: "task", id: "custom" }, edits: [], diagnostics: [], asset_manifest: [],
    final_snapshot: { standard_id: "custom", standard_version: "1", catalog_digest: "abc",
      stages: [{ id: "design", title: "设计", phase: "写设计", steps: ["custom_story"], slots: [], items: [] }] } };
  assert.equal(suggestedDemoMessage(source, "写设计"), "定制设计说明");
});


test("历史中文步骤标题匹配固定流程，真实问题、上下文和开场说明保留到副本", async () => {
  const source = snapshot([turn("设计检视回复"), { ...card("中文确认", "Story 与实施附录生成及一次设计检视"), waiting_id: "原确认记录" }]);
  source.task.workflow_profile = { schema: "mae-flow-execution-profile/2", revision: "1",
    source: { kind: "task", id: "custom" }, edits: [], diagnostics: [], asset_manifest: [],
    final_snapshot: { standard_id: "custom", standard_version: "1", catalog_digest: "abc",
      stages: [{ id: "design", title: "设计", phase: "写设计", steps: ["custom_story"], slots: [], items: [] }] } };
  source.step_titles = { custom_story: "Story 与实施附录生成及一次设计检视" };
  source.card_contexts = { "原确认记录": { context: "订单服务沿用现有幂等键，支付接口不变。", preface: "检视发现重试存在重复扣款风险，已补充去重。" } };
  assert.equal(hasTaskDemoPhaseCard(source, "写设计"), true);
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "中文确认");
  assert.equal(suggestedDemoMessage(source, "写设计"), "设计检视回复");
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
    stepTitles: source.step_titles, cardContexts: source.card_contexts, conversation: source.conversation.items,
    fetchRead: async () => { throw new Error("真实历史无需生成或读取其他资料"); } });
  try {
    const shown = demo.selectPhase("写设计");
    assert.equal(shown.waiting?.question?.questions?.[0]?.question, "中文确认");
    assert.equal(shown.waiting?.context, source.card_contexts["原确认记录"].context);
    assert.equal(shown.waiting?.preface, source.card_contexts["原确认记录"].preface);
    const history = await (await demo.fetch(`/tasks/${demo.taskId}/conversation`)).json() as { items: ConversationItem[] };
    assert.ok(history.items.some((item: ConversationItem) => item.id === "设计检视回复"));
  } finally { demo.dispose(); }
});

test("主任务分析的空步骤历史卡可匹配，子任务不能借用空步骤卡", () => {
  const source = snapshot([turn("拆分结果"), card("拆分确认", "")]);
  source.task.progress = { phases: ["澄清需求"], current_index: 0, current_phase: "澄清需求" };
  source.task.requirement_graph = { stage: "confirmed", repositories: [], dependencies: [] };
  assert.equal(taskDemoPhaseCard(source, "澄清需求")?.id, "拆分确认");
  assert.equal(suggestedDemoMessage(source, "澄清需求"), "拆分结果");
  source.task.parent_task_id = "主任务";
  assert.equal(taskDemoPhaseCard(source, "澄清需求"), undefined);
  assert.equal(hasTaskDemoPhaseCard(source, "澄清需求"), false);
  assert.equal(suggestedDemoMessage(source, "澄清需求"), undefined);
});

test("检视与验证包含宿主推送和 MR 说明确认，使用真实历史卡", () => {
  for (const step of ["host_push_confirm", "cloud_push_confirm", "cloud_mr_description"]) {
    const source = snapshot([turn("交付检视结果"), card("推送确认", step)]);
    assert.equal(taskDemoPhaseCard(source, "检视与验证")?.id, "推送确认", step);
    assert.equal(suggestedDemoMessage(source, "检视与验证"), "交付检视结果", step);
    assert.equal(hasTaskDemoPhaseCard(source, "写设计"), false, step);
  }
});


test("同阶段更新的当前卡使用原 id 和时间，不再被旧历史卡覆盖", async () => {
  const source = snapshot([turn("旧方案回复"), card("旧确认"),
    { ...turn("新方案回复"), ts: "2026-10-22T01:00:00Z", end_ts: "2026-10-22T01:00:00Z" },
    { ...turn("之后的无关回复"), ts: "2026-10-22T03:00:00Z", end_ts: "2026-10-22T03:00:00Z" }]);
  source.task.waiting = { waiting_id: "最新等待", state_version: 3, step: "story", created_at: "2026-10-22T02:00:00Z",
    question: { questions: [{ question: "新方案是否确认？", options: ["确认", "修改"] }] },
    context: "新方案的原始依据", preface: "新方案回复" };
  const before = structuredClone(source);
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "card-最新等待");
  assert.equal(suggestedDemoMessage(source, "写设计"), "新方案回复");
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
    conversation: source.conversation.items, fetchRead: async () => { throw new Error("不得读取或修改真实任务"); } });
  try {
    const current = demo.selectPhase("写设计");
    assert.equal(current.waiting?.question?.questions?.[0]?.question, "新方案是否确认？");
    assert.equal(current.waiting?.context, "新方案的原始依据");
    assert.equal(current.waiting?.preface, "新方案回复");
    const history = await (await demo.fetch(`/tasks/${demo.taskId}/conversation`)).json() as { items: ConversationItem[] };
    const currentIndex = history.items.findIndex(item => item.id === "card-最新等待");
    assert.equal(history.items[currentIndex].ts, "2026-10-22T02:00:00Z");
    assert.equal(history.items[currentIndex - 1].id, "新方案回复");
    assert.equal(history.items[currentIndex + 1].id, "之后的无关回复");
    assert.deepEqual(source, before);
  } finally { demo.dispose(); }
});

test("当前等待已经在历史内时保持原卡，不重复物化", () => {
  const source = snapshot([turn("当前方案"), { ...card("自定义原卡id"), waiting_id: "current" }]);
  source.task.waiting = { waiting_id: "current", state_version: 1, step: "story", created_at: at,
    question: { questions: [{ question: "当前方案？", options: ["确认"] }] } };
  const items = taskDemoConversation(source.task, source.conversation.items);
  assert.deepEqual(items, source.conversation.items);
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "自定义原卡id");
  assert.equal(items.filter(item => item.kind === "card").length, 1);
});

test("较旧的当前等待快照不覆盖更新的历史卡", () => {
  const source = snapshot([{ ...card("较新的确认"), ts: "2026-10-22T02:00:00Z" }]);
  source.task.waiting = { waiting_id: "旧等待", state_version: 1, step: "story", created_at: at,
    question: { questions: [{ question: "旧方案？", options: ["确认"] }] } };
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "较新的确认");
});

test("当前卡没有步骤标记时按真实当前阶段定位，不借其他阶段", () => {
  const source = snapshot([]);
  source.task.waiting = { waiting_id: "无步骤等待", state_version: 1, created_at: at,
    question: { questions: [{ question: "是否确认？", options: ["确认"] }] } };
  assert.equal(taskDemoPhaseCard(source, "写设计")?.id, "card-无步骤等待");
  assert.equal(taskDemoPhaseCard(source, "澄清需求"), undefined);
  assert.equal(suggestedDemoMessage(source, "写设计"), "card-无步骤等待");
});

test("回复定位不跨越会话、人工决定或补充要求，保留该卡原文", async () => {
  const boundaries: ConversationItem[] = [
    { kind: "session", id: "新会话", ts: at, phase: "started" },
    { kind: "session", id: "结束会话", ts: at, phase: "ended" },
    { kind: "decision", id: "人工决定", ts: at, waiting_id: "前轮", decision: "确认", notes: "", purpose: "confirmation", annotation_ids: [] },
    { kind: "steer", id: "新要求", ts: at, text: "重新设计", delivered: true },
  ];
  for (const boundary of boundaries) {
    const source = snapshot([turn("前轮回复"), boundary, card("本轮确认")]);
    source.card_contexts = { "本轮确认": { preface: "前轮回复", context: "本轮确认依据" } };
    assert.equal(suggestedDemoMessage(source, "写设计"), "本轮确认", boundary.id);
    const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
      cardContexts: source.card_contexts, conversation: source.conversation.items,
      fetchRead: async () => { throw new Error("不得生成回复"); } });
    try {
      assert.equal(demo.selectPhase("写设计").waiting?.context, "本轮确认依据");
    } finally { demo.dispose(); }
  }
});

test("同轮原始开场说明优先于上下文和紧邻回复，不能匹配上一轮同文", () => {
  const source = snapshot([turn("上一轮同文"), card("上一轮确认"), turn("当时的开场说明"), turn("显式上下文"), turn("后续补充"), card("本轮确认")]);
  source.card_contexts = { "本轮确认": { preface: "当时的开场说明", context: "显式上下文" } };
  assert.equal(suggestedDemoMessage(source, "写设计"), "当时的开场说明");
  source.card_contexts["本轮确认"] = { context: "显式上下文" };
  assert.equal(suggestedDemoMessage(source, "写设计"), "显式上下文");
  source.card_contexts["本轮确认"] = { preface: "上一轮同文" };
  assert.equal(suggestedDemoMessage(source, "写设计"), "后续补充");
});


test("编码阶段更名前的真实确认卡仍能按原步骤定位，不混入其他阶段", () => {
  const source = snapshot([turn("编码结果原文"), card("旧标题编码确认", "编码实现")]);
  source.phase_steps = { "写代码": ["build"], "写设计": ["story"] };
  source.step_titles = { build: "自由实现与定稿", story: "Story 与实施附录生成及一次设计检视" };
  assert.equal(taskDemoPhaseCard(source, "写代码")?.id, "旧标题编码确认");
  assert.equal(suggestedDemoMessage(source, "写代码"), "编码结果原文");
  assert.equal(taskDemoPhaseCard(source, "写设计"), undefined);
});


test("写代码优先本阶段真实卡，不被之后的最终检视卡替换", () => {
  const source = snapshot([turn("编码问题说明"), card("编码确认", "build"),
    turn("最终检视说明"), card("最终检视", "cloud_push_confirm")]);
  assert.equal(taskDemoPhaseCard(source, "写代码")?.id, "编码确认");
  assert.equal(suggestedDemoMessage(source, "写代码"), "编码问题说明");
});

test("写代码无独立卡时展示真实最终代码检视及原回复，保留原阶段与原文", async () => {
  for (const step of ["delivery_review", "cloud_push_confirm", "最终代码检视标题"]) {
    const source = snapshot([turn("代码实现与验证结果"), card("真实代码检视", step)]);
    source.task.progress = { phases: ["写代码", "检视与验证"], current_index: 1, current_phase: "检视与验证" };
    source.step_titles = { delivery_review: "最终代码检视标题" };
    source.card_contexts = { "真实代码检视": { preface: "代码实现与验证结果", context: "代码及验证的原始记录" } };
    const before = structuredClone(source);
    assert.equal(taskDemoPhaseCard(source, "写代码")?.id, "真实代码检视", step);
    assert.equal(taskDemoPhaseCard(source, "写代码")?.step, step);
    assert.equal(suggestedDemoMessage(source, "写代码"), "代码实现与验证结果", step);
    const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", phaseSteps: source.phase_steps,
      stepTitles: source.step_titles, cardContexts: source.card_contexts, conversation: source.conversation.items,
      fetchRead: async () => { throw new Error("不得请求生成卡片"); } });
    try {
      const shown = demo.selectPhase("写代码");
      assert.equal(shown.waiting?.step, step);
      assert.equal(shown.waiting?.created_at, at);
      assert.equal(shown.waiting?.question?.questions?.[0]?.question, "真实代码检视");
      assert.equal(shown.waiting?.preface, "代码实现与验证结果");
      assert.equal(shown.waiting?.context, "代码及验证的原始记录");
      assert.deepEqual(source, before);
    } finally { demo.dispose(); }
  }
});

test("写代码展示最新的真实代码检视，后续 MR 或早期推送不能替代", () => {
  const source = snapshot([turn("第一次代码检视说明"), card("第一次代码检视", "delivery_review"),
    turn("修订后的代码检视说明"), card("最新代码检视", "cloud_push_confirm"),
    turn("MR描述"), card("MR确认", "cloud_mr_description"),
    turn("阶段推送说明"), card("阶段推送", "host_push_confirm")]);
  assert.equal(taskDemoPhaseCard(source, "写代码")?.id, "最新代码检视");
  assert.equal(suggestedDemoMessage(source, "写代码"), "修订后的代码检视说明");
});

test("写代码没有代码检视卡时不借用 MR、早期推送或知识归档卡", () => {
  for (const step of ["cloud_mr_description", "host_push_confirm", "archive_confirm", "domain_archive"]) {
    const source = snapshot([turn("其他阶段说明"), card("其他阶段确认", step)]);
    assert.equal(taskDemoPhaseCard(source, "写代码"), undefined, step);
    assert.equal(suggestedDemoMessage(source, "写代码"), undefined, step);
  }
  assert.equal(taskDemoPhaseCard(snapshot([]), "写代码"), undefined);
});
