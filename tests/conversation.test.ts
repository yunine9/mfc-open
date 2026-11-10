/**
 * 会话流投影的契约:
 * - 流里只有回合:主会话的话按回合合并,工具步骤只折成计数,子会话不进流;
 * - 卡与决定来自 waiting.json(谁点的、答了什么),不靠事件账猜;
 * - 批注按落账操作还原:送出→回执(合批)→追问答复→确认/退回/改字重提,
 *   回执的"版本对得上"按落账那一刻的版本算;
 * - 外部意见按批次合成一条,工作台来源不重复;
 * - 容错:任一本账坏了只少那一类条目,problems 如实说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConversation, type ConversationItem } from "../src/conversation.ts";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { HumanGate } from "../src/humanGate.ts";

const BASE = Date.parse("2026-09-05T02:00:00Z");

test("代转失败只记系统恢复，不冒充原作者退回；重新提交后版本与真正退回次数各自正确", () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-reset-conversation-")), "annotations.jsonl"));
  const note = store.add({ author: "guest", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note: "补充验收", kind: "doc" });
  store.markSent([note.id], "requirement_review", "owner");
  store.resetRequirementDelivery(note.id, "模型响应超时");
  assert.equal(store.list()[0].returned ?? 0, 0);
  assert.equal(store.list()[0].rework, 1, "旧执行的回执必须失效");
  store.edit(note.id, "补充验收和异常", "guest");
  store.markSent([note.id], "requirement_review", "owner");
  assert.throws(() => store.respond(note.id, { revision: 0, outcome: "fixed", summary: "旧回执", evidence: [] }), /旧轮/);
  store.markSent([note.id], "interrupt", "owner");
  store.respond(note.id, { revision: 1, outcome: "fixed", summary: "已补充验收", evidence: ["requirement.md:1"] });
  store.reopen(note.id, "guest", { note: "仍缺异常场景" });
  const view = buildConversation({ events: [], waiting: [], annotations: store.list(),
    annotationHistory: store.history(), feedback: [] });
  const resets = view.items.filter((item) => item.kind === "delivery_reset");
  assert.equal(resets.length, 1);
  assert.equal(resets[0].reason, "模型响应超时");
  const reopened = view.items.filter((item) => item.kind === "reopened");
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].returned, 1, "只有作者主动要求再改才算一次退回");
  assert.equal(view.items.find((item) => item.kind === "annotations_sent")?.by, "owner");
});
function at(offsetSeconds: number): string {
  return new Date(BASE + offsetSeconds * 1000).toISOString();
}

let eventId = 0;
function event(kind: string, ts: string, payload: Record<string, unknown>,
  sessionId = "main"): Record<string, unknown> {
  eventId += 1;
  return { eventId, taskId: "t1", sessionId, ts, kind, payload };
}

function kinds(items: ConversationItem[]): string[] {
  return items.map((item) => item.kind);
}

test("每轮推送清单独立呈现，不受普通会话文字截断限制", () => {
  const files = Array.from({ length: 232 }, (_, i) => ({ path: `build/output-${i}.o`, label: "新增" }));
  const view = buildConversation({ events: [
    event("push_file_list", at(1), { branch: "feature", head_sha: "a".repeat(40), files }),
    event("push_file_list", at(2), { branch: "feature", head_sha: "b".repeat(40), base_sha: "a".repeat(40), files: [{ path: "src/a.ts", label: "修改" }] }),
  ], waiting: [], annotations: [], annotationHistory: [], feedback: [] });
  assert.equal(view.items.length, 2);
  assert.deepEqual((view.items[0] as Extract<ConversationItem, {kind:"push_file_list"}>).manifest.files, files);
  assert.equal((view.items[1] as Extract<ConversationItem, {kind:"push_file_list"}>).manifest.files?.length, 1);
});

test("主会话按回合合并,工具步骤折成计数,子会话与 AskUserQuestion 不进流", () => {
  const events = [
    event("session_started", at(0), { resume: false }),
    event("user_message", at(1), { text: "使命" }),
    event("assistant_message", at(2), { text: "我先看一眼现有实现。" }),
    event("tool_finished", at(3), { call_id: "c1", name: "Read", input: { file_path: "/repo/src/a.ts" }, is_error: false, result: "" }),
    event("tool_finished", at(4), { call_id: "c2", name: "Edit", input: { file_path: "/repo/src/a.ts" }, is_error: false, result: "" }),
    event("tool_finished", at(5), { call_id: "c3", name: "Bash", input: { command: "cd /repo && npm test" }, is_error: true, result: "1 failing" }),
    event("tool_finished", at(5), { call_id: "x", name: "Bash", input: { command: "ls" }, is_error: false, result: "" }, "child-1"),
    event("agent_spawned", at(6), { call_id: "c4", agent_type: "explore", description: "查调用点", prompt: "", child_session_id: "child-1" }),
    event("assistant_message", at(7), { text: "结论:只改一处即可,请确认。" }),
    event("tool_finished", at(8), { call_id: "c5", name: "AskUserQuestion", input: {}, is_error: false, result: "" }),
    event("human_decision", at(20), { waiting_id: "t1:c5", state_version: 2, decision: "确认", notes: "" }),
    event("assistant_message", at(21), { text: "收到,继续。" }),
    event("turn_finished", at(22), { reason: "end_turn" }),
  ];
  const view = buildConversation({
    events, waiting: [], annotations: [], annotationHistory: [], feedback: [],
  });
  assert.deepEqual(kinds(view.items), ["session", "turn", "turn"]);
  const [, first, second] = view.items as Array<Extract<ConversationItem, { kind: "turn" }>>;
  assert.equal(first.texts.length, 2);
  assert.equal(first.texts[0].text, "我先看一眼现有实现。");
  assert.deepEqual(first.texts.map((text) => text.role), ["narration", "handoff"],
    "说完去读文件的是过程话,说完举卡的是交接语");
  assert.equal(second.texts[0].role, "handoff", "说完回合结束的按交接语算");
  assert.deepEqual(
    { calls: first.steps.calls, errors: first.steps.errors, reads: first.steps.reads,
      edits: first.steps.edits, bash: first.steps.bash, agents: first.steps.agents },
    { calls: 3, errors: 1, reads: 1, edits: 1, bash: 1, agents: 1 });
  assert.deepEqual(first.steps.sample.map((entry) => entry.subject),
    ["…/src/a.ts", "npm test", "查调用点"]);
  assert.equal(first.open, false);
  assert.equal(second.texts[0].text, "收到,继续。");
  assert.equal(view.events_seen, events.length);
});

test("任务仍在跑时最后一个回合标记为未收尾;插话带送达事实", () => {
  const events = [
    event("user_message", at(1), { text: "要求:别动区号", via: "interrupt",
      display: "别动区号", references: ["团队 Skill/掩码"] }),
    event("assistant_message", at(2), { text: "好的。" }),
  ];
  const view = buildConversation({
    events, waiting: [], annotations: [], annotationHistory: [], feedback: [],
    interrupts: [{ text: "别动区号", at: at(1), delivered: false }],
    running: true,
  });
  assert.deepEqual(kinds(view.items), ["steer", "turn"]);
  assert.equal((view.items[1] as Extract<ConversationItem, { kind: "turn" }>).texts[0].role,
    "handoff", "任务还在跑、后面还没跟工具的话先按交接语算");
  const steer = view.items[0] as Extract<ConversationItem, { kind: "steer" }>;
  assert.equal(steer.text, "别动区号");
  assert.equal(steer.delivered, false);
  assert.deepEqual(steer.references, ["团队 Skill/掩码"]);
  assert.equal((view.items[1] as Extract<ConversationItem, { kind: "turn" }>).open, true);
});

test("卡与决定来自 waiting.json:谁点的、答了什么、澄清卡针对哪几条意见", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-gate-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const card = gate.createWaiting({
    taskId: "t1", step: "cloud_push_confirm", callId: "c1",
    questionInput: { questions: [{ question: "是否推送?", options: ["确认按清单推送", "需要调整代码"] }] },
  });
  gate.resolve(card.waiting_id, {
    stateVersion: card.state_version, decision: "需要调整代码",
    answers: { "是否推送?": "需要调整代码" }, notes: "第 9 行别暴露枚举",
    decidedBy: "lin",
  });
  const asking = gate.createWaiting({
    taskId: "t1", step: "cloud_push_confirm", callId: "c2",
    questionInput: {
      questions: [{ question: "长文按字数还是任务?" }],
      purpose: "clarification", annotation_ids: ["a-1"],
    },
  });
  // 真实举卡/决定隔着分钟级;测试里三步挤在同一毫秒,时刻按真实先后摆开。
  const records = gate.all();
  records[0].created_at = at(0);
  records[0].resolved_at = at(60);
  records[1].created_at = at(120);
  const view = buildConversation({
    events: [], waiting: records, annotations: [], annotationHistory: [], feedback: [],
  });
  assert.deepEqual(kinds(view.items), ["card", "decision", "card"]);
  const decision = view.items[1] as Extract<ConversationItem, { kind: "decision" }>;
  assert.equal(decision.by, "lin");
  assert.equal(decision.decision, "需要调整代码");
  assert.equal(decision.notes, "第 9 行别暴露枚举");
  assert.equal(decision.purpose, "confirmation");
  const clarification = view.items[2] as Extract<ConversationItem, { kind: "card" }>;
  assert.equal(clarification.waiting_id, asking.waiting_id);
  assert.equal(clarification.purpose, "clarification");
  assert.deepEqual(clarification.annotation_ids, ["a-1"]);
  assert.equal(clarification.status, "waiting");
  assert.equal(clarification.questions[0].question, "长文按字数还是任务?");
});

test("批注账还原成:送出→回执合批→追问答复→退回→旧版本回执不算数→确认", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-annot-"));
  const store = new AnnotationStore(join(dir, "annotations.jsonl"));
  const one = store.add({ author: "lin", artifact: "spec.md", file: "spec.md", line: 9,
    anchor: "状态标题", note: "保留业务语气", kind: "doc" });
  const two = store.add({ author: "zhou", artifact: "spec.md", file: "spec.md", line: 7,
    anchor: "长文", note: "多长算长文?", kind: "doc" });
  // 台账各步都用真实时刻落账(store 内部取 now);回执时刻也跟着取 now,
  // 否则和真实时钟比先后就乱了。
  store.markSent([one.id, two.id], "decision", "lin");
  store.respond(one.id, { revision: 0, outcome: "fixed", summary: "已改",
    evidence: ["spec.md:11"] });
  store.respond(two.id, { revision: 0, outcome: "needs_clarification",
    summary: "按字数还是按任务?", evidence: [] });
  store.answerClarification(two.id, "按信息任务分层", "zhou");
  store.reopen(one.id, "lin", { note: "语气还是太硬" });
  store.markSent([one.id], "decision", "lin");
  // 退回重送后一份旧版本回执晚到落账(respond() 会拒,这里模拟旧进程直接
  // 追加的账):回放不认它,流里也要标出"对不上当前版本"。
  writeFileSync(store.path, JSON.stringify({ op: "respond", id: one.id, response: {
    revision: 0, outcome: "fixed", summary: "旧回执", evidence: [],
    responded_at: new Date().toISOString() } }) + "\n", { flag: "a" });
  store.respond(one.id, { revision: 1, outcome: "fixed", summary: "换成建议语气",
    evidence: ["spec.md:11"] });
  store.verify(one.id, "lin");

  const view = buildConversation({
    events: [], waiting: [], annotations: store.list(),
    annotationHistory: store.history(), feedback: [],
  });
  assert.deepEqual(kinds(view.items), [
    "annotations_sent", "receipts", "clarified", "reopened",
    "annotations_sent", "receipts", "receipts", "verified",
  ]);
  const sent = view.items[0] as Extract<ConversationItem, { kind: "annotations_sent" }>;
  assert.equal(sent.by, "lin");
  assert.deepEqual(sent.items.map((item) => item.id), [one.id, two.id]);
  const receipts = view.items[1] as Extract<ConversationItem, { kind: "receipts" }>;
  assert.equal(receipts.items.length, 2, "同一批回执合成一条");
  assert.deepEqual(receipts.items.map((item) => [item.outcome, item.current]),
    [["fixed", true], ["needs_clarification", true]]);
  const clarified = view.items[2] as Extract<ConversationItem, { kind: "clarified" }>;
  assert.equal(clarified.annotation.id, two.id);
  assert.equal(clarified.by, "zhou");
  assert.equal(clarified.question, "按字数还是按任务?");
  assert.equal(clarified.answer, "按信息任务分层");
  const reopened = view.items[3] as Extract<ConversationItem, { kind: "reopened" }>;
  assert.equal(reopened.returned, 1);
  assert.equal(reopened.note, "语气还是太硬");
  const stale = view.items[5] as Extract<ConversationItem, { kind: "receipts" }>;
  assert.equal(stale.items[0].current, false, "退回后的旧版本回执不背书新文字");
  const fresh = view.items[6] as Extract<ConversationItem, { kind: "receipts" }>;
  assert.equal(fresh.items[0].current, true);
  assert.equal(fresh.items[0].revision, 1);
  assert.equal((view.items[7] as Extract<ConversationItem, { kind: "verified" }>).annotation.id, one.id);
});

test("改已送出的意见算改字重提(版本 +1);草稿改字不进流", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-edit-"));
  const store = new AnnotationStore(join(dir, "annotations.jsonl"));
  const draft = store.add({ author: "lin", artifact: "spec.md", file: "spec.md", line: 1,
    anchor: "x", note: "草稿", kind: "doc" });
  store.edit(draft.id, "草稿改字", "lin");
  store.markSent([draft.id], "decision", "lin");
  store.respond(draft.id, { revision: 0, outcome: "fixed", summary: "改了",
    evidence: [] });
  store.edit(draft.id, "重提:还要补一句", "lin");
  const view = buildConversation({
    events: [], waiting: [], annotations: store.list(),
    annotationHistory: store.history(), feedback: [],
  });
  assert.deepEqual(kinds(view.items), ["annotations_sent", "receipts", "revised"]);
  const revised = view.items[2] as Extract<ConversationItem, { kind: "revised" }>;
  assert.equal(revised.annotation.note, "重提:还要补一句");
});

test("外部意见按来源+批次合一条,工作台/推送确认来源不重复", () => {
  const view = buildConversation({
    events: [], waiting: [], annotations: [], annotationHistory: [],
    feedback: [
      { id: "f1", batch_id: "b1", source: "mr_discussion", source_id: "128-1",
        source_revision: 1, observed_sha: "abc", summary: "移动端入口别竖排",
        file: "a.css", line: 950, author: "周谨", verification: "", status: "open",
        updated_at: at(3) },
      { id: "f2", batch_id: "b1", source: "mr_discussion", source_id: "128-2",
        source_revision: 1, observed_sha: "abc", summary: "命名",
        author: "周谨", verification: "", status: "closed", resolution: "已改",
        updated_at: at(9) },
      { id: "f3", batch_id: "b2", source: "pipeline", source_id: "ut",
        source_revision: 1, observed_sha: "abc", summary: "UT 红灯",
        verification: "", status: "repairing", updated_at: at(5) },
      { id: "f4", batch_id: "b3", source: "workspace", source_id: "a-1",
        source_revision: 0, observed_sha: "abc", summary: "工作台批注镜像",
        verification: "", status: "open", updated_at: at(1) },
    ],
  });
  assert.deepEqual(kinds(view.items), ["external", "external"]);
  const codehub = view.items[0] as Extract<ConversationItem, { kind: "external" }>;
  assert.equal(codehub.source, "mr_discussion");
  assert.equal(codehub.author, "周谨");
  assert.equal(codehub.ts, at(3), "批次时刻取最早一条");
  assert.equal(codehub.items.length, 2);
  assert.equal(codehub.items[1].resolution, "已改");
  assert.equal((view.items[1] as Extract<ConversationItem, { kind: "external" }>).source, "pipeline");
});

test("旧账裸时间戳按 UTC 补全;同一毫秒的条目按来源顺序排(话→卡→决定)", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-order-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const card = gate.createWaiting({ taskId: "t1", step: "s", callId: "c1",
    questionInput: { questions: [{ question: "q", options: ["a"] }] } });
  gate.resolve(card.waiting_id, { stateVersion: 1, decision: "a" });
  const records = gate.all();
  const ts = records[0].created_at;
  records[0].resolved_at = ts;
  const bare = ts.replace("T", " ").replace(/\.\d+Z$/, "");
  const events = [event("assistant_message", bare, { text: "请确认" })];
  const view = buildConversation({
    events, waiting: records, annotations: [], annotationHistory: [], feedback: [],
  });
  assert.deepEqual(kinds(view.items), ["turn", "card", "decision"]);
  const turn = view.items[0] as Extract<ConversationItem, { kind: "turn" }>;
  assert.equal(new Date(turn.ts).getTime(), Math.floor(new Date(ts).getTime() / 1000) * 1000);
});

test("批注账坏行只丢它自己;problems 原样带出", () => {
  const dir = mkdtempSync(join(tmpdir(), "conv-broken-"));
  const path = join(dir, "annotations.jsonl");
  const store = new AnnotationStore(path);
  const item = store.add({ author: "lin", artifact: "a", file: "a", line: 1,
    anchor: "x", note: "n", kind: "doc" });
  writeFileSync(path, "{\"op\":\"sent\",\"ids\":[\"" + item.id + "\"],\"via\":\"decision\",\"at\":\"" + at(1) + "\"}\n{半行", { flag: "a" });
  const view = buildConversation({
    events: [], waiting: [], annotations: store.list(), annotationHistory: store.history(),
    feedback: [], problems: ["决定账读取失败:x"],
  });
  assert.deepEqual(kinds(view.items), ["annotations_sent"]);
  assert.deepEqual(view.problems, ["决定账读取失败:x"]);
});

test("跨仓同步进流:收到的标 received、自己发的标 published,按时间落位", () => {
  const view = buildConversation({
    events: [], waiting: [], annotations: [], annotationHistory: [], feedback: [],
    taskId: "task-b",
    crossRepositoryUpdates: [
      { id: "u1", source_task_id: "task-a", source_repository: "auth-service", author: "zhou",
        text: "登录接口多了 tenant 参数", target_task_ids: ["task-b"], created_at: at(10) },
      { id: "u2", source_task_id: "task-b", source_repository: "web", author: "lin",
        text: "前端已按 tenant 改", target_task_ids: ["task-a", "task-c"], created_at: at(20) },
    ],
  });
  const syncs = view.items.filter((item) => item.kind === "sync") as
    Array<Extract<ConversationItem, { kind: "sync" }>>;
  assert.equal(syncs.length, 2);
  assert.equal(syncs[0].direction, "received");
  assert.equal(syncs[0].repository, "auth-service");
  assert.equal(syncs[0].by, "zhou");
  assert.equal(syncs[1].direction, "published");
  assert.equal(syncs[1].targets, 2);
  assert.ok(syncs[0].ts < syncs[1].ts, "按时间先后");
});
