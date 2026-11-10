import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationItem } from "../web/src/api";
import { prepareTaskDemoCards } from "../web/src/taskDemoCards";
import { createTaskDemoSandbox } from "../web/src/taskDemoSandbox";
import { suggestedDemoMessage, type TaskDemoSnapshot } from "../web/src/taskDemoTypes";

const at = "2026-10-22T00:00:00Z";
const card = (id: string, step: string): ConversationItem => ({
  kind: "card", id, ts: at, waiting_id: `${id}-waiting`, step, purpose: "confirmation",
  annotation_ids: [], questions: [{ question: "订单支付需要保留兼容接口吗？", options: ["保留", "调整"] }], status: "resolved",
});
const snapshot = (phases = ["写设计"]): TaskDemoSnapshot => ({
  schema: "mae-flow-demo-snapshot/1", captured_at: at, source_task_id: "source-task",
  task: { id: "source-task", requirement: "订单支付兼容旧接口", created_at: at, status: "completed", luban_account: "owner",
    progress: { phases, current_index: phases.length - 1, current_phase: phases.at(-1)! } },
  conversation: { items: [] }, artifacts: [], annotations: { items: [] }, problems: [],
});
const supplement = (phase = "写设计") => ({ source_task_id: "source-task", phase,
  context: "设计文档规定旧接口保持兼容，新增字段可选。", source_ids: ["artifact:story.md"],
  questions: [{ question: "是否接受文档中的兼容方案？", options: ["接受", "调整"] }] });
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});

test("中文标题和固定流程已有真实确认卡时，不请求 Agent 生成", async () => {
  const source = snapshot();
  source.phase_steps = { "写设计": ["story"] };
  source.step_titles = { custom_story: "Story 与实施附录生成及一次设计检视" };
  source.task.workflow_profile = { schema: "mae-flow-execution-profile/2", revision: "1",
    source: { kind: "task", id: "custom" }, edits: [], diagnostics: [], asset_manifest: [],
    final_snapshot: { standard_id: "custom", standard_version: "1", catalog_digest: "abc",
      stages: [{ id: "design", title: "设计", phase: "写设计", steps: ["custom_story"], slots: [], items: [] }] } };
  source.conversation.items.push(card("original-card", "Story 与实施附录生成及一次设计检视"));
  source.card_contexts = { "original-card-waiting": { context: "原始设计依据", preface: "原始 Agent 的确认说明" } };
  const prepared = await prepareTaskDemoCards(source, async () => { throw new Error("已有真实卡不应请求补充"); },
    new AbortController().signal, () => { throw new Error("已有真实卡不应进入补充进度"); });
  assert.deepEqual(prepared, source);
  assert.notEqual(prepared, source);
  assert.equal(prepared.supplemental_cards, undefined);
  const demo = createTaskDemoSandbox({ task: prepared.task, actor: "admin", phaseSteps: prepared.phase_steps,
    stepTitles: prepared.step_titles, cardContexts: prepared.card_contexts, conversation: prepared.conversation.items,
    fetchRead: async () => { throw new Error("只展示原卡不应访问网络"); } });
  try {
    const current = demo.selectPhase("写设计");
    assert.equal(current.waiting?.context, "原始设计依据");
    assert.equal(current.waiting?.preface, "原始 Agent 的确认说明");
    assert.equal(current.waiting?.question?.questions?.[0]?.question, "订单支付需要保留兼容接口吗？");
  } finally { demo.dispose(); }
});

test("当前真实等待卡也可直接使用，无需历史卡或补充请求", async () => {
  const source = snapshot();
  source.step_titles = { story: "Story 与实施附录生成及一次设计检视" };
  source.task.waiting = { waiting_id: "live-wait", step: source.step_titles.story, state_version: 1,
    context: "真实等待的上下文", question: { questions: [{ question: "是否采用现有方案？", options: ["采用", "调整"] }] } };
  const prepared = await prepareTaskDemoCards(source, async () => { throw new Error("当前真实等待卡不应生成"); },
    new AbortController().signal, () => {});
  assert.deepEqual(prepared, source);
});

test("仅为缺失阶段请求基于原任务资料的补充卡，明确标注且不修改原快照", async () => {
  const source = snapshot(["写设计", "写代码", "检视与验证"]);
  source.conversation.items.push(card("design-card", "story"), card("push-card", "host_push_confirm"));
  const before = structuredClone(source);
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const progress: string[] = [];
  const prepared = await prepareTaskDemoCards(source, async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: JSON.parse(String(init?.body)) });
    assert.ok(init?.signal);
    return response(supplement("写代码"));
  }, new AbortController().signal, phase => progress.push(phase));
  assert.deepEqual(calls, [{ url: "/tasks/source-task/demo-card", method: "POST", body: { phase: "写代码" } }]);
  assert.deepEqual(progress, ["写代码"]);
  assert.deepEqual(source, before);
  assert.deepEqual(prepared.conversation.items.slice(0, 2), source.conversation.items);
  const added = prepared.conversation.items.at(-1)!;
  assert.equal(added.kind, "card");
  if (added.kind !== "card") throw new Error("缺少补充卡");
  assert.equal(added.step, "build");
  assert.deepEqual(added.questions, supplement("写代码").questions);
  assert.deepEqual(prepared.supplemental_cards?.[added.id], ["artifact:story.md"]);
  assert.match(prepared.card_contexts?.[added.waiting_id]?.context ?? "", /依据原任务资料补充生成，非历史原话/);
  assert.equal(suggestedDemoMessage(prepared, "写代码"), added.id);
  const demo = createTaskDemoSandbox({ task: prepared.task, actor: "admin", conversation: prepared.conversation.items,
    cardContexts: prepared.card_contexts, fetchRead: async () => { throw new Error("补充卡准备后不应再请求"); } });
  try {
    const shown = demo.selectPhase("写代码");
    assert.equal(shown.status_label, "依据原任务资料补充");
    assert.match(shown.waiting?.context ?? "", /非历史原话/);
    assert.deepEqual(shown.waiting?.question?.questions, supplement("写代码").questions);
  } finally { demo.dispose(); }
});

test("补充接口失败、来源或阶段不一致、缺少资料时拒绝进入演示，不替换通用示例", async () => {
  const invalid = [
    { status: 503, data: { error: "Agent 暂不可用" }, message: /Agent 暂不可用/ },
    { data: { ...supplement(), source_task_id: "other-task" }, message: /资料不完整/ },
    { data: { ...supplement(), phase: "定规格" }, message: /资料不完整/ },
    { data: { ...supplement(), source_ids: [] }, message: /资料不完整/ },
    { data: { ...supplement(), questions: [] }, message: /资料不完整/ },
    { data: { ...supplement(), questions: [{ question: 42, options: ["确认"] }] }, message: /资料不完整/ },
    { data: { ...supplement(), questions: [{ question: "确认？", options: [42] }] }, message: /资料不完整/ },
    { data: { ...supplement(), context: null }, message: /资料不完整/ },
  ];
  for (const row of invalid) {
    const source = snapshot();
    const before = structuredClone(source);
    await assert.rejects(prepareTaskDemoCards(source, async () => response(row.data, row.status ?? 200),
      new AbortController().signal, () => {}), row.message);
    assert.deepEqual(source, before);
  }
  const source = snapshot();
  const demo = createTaskDemoSandbox({ task: source.task, actor: "admin", conversation: [],
    fetchRead: async () => { throw new Error("副本不得静默请求生成或采用通用示例"); } });
  try {
    const shown = demo.selectPhase("写设计");
    assert.equal(shown.waiting, undefined);
    assert.equal(shown.status, "paused");
    const history = await (await demo.fetch(`/tasks/${demo.taskId}/conversation`)).json() as { items: ConversationItem[] };
    assert.equal(history.items.some((item: ConversationItem) => item.kind === "card"), false);
  } finally { demo.dispose(); }
});
