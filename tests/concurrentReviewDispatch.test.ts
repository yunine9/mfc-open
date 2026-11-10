import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { reviewStore } from "../src/issueFlow/reviews.ts";
import { loadState } from "../src/issueFlow/state.ts";
import { TaskService } from "../src/taskService.ts";
import { AnnotationStore } from "../src/annotations.ts";
import { annotationSubmissionReceipt } from "../src/annotationSubmission.ts";
import { mfcTemp } from "./mfcTmp.ts";

function issue(status = "running", stage = "fix") {
  const root = mfcTemp("concurrent-review-");
  const messages: string[] = [];
  const state: any = { id: "issue-1", account: "dev", status, scenario: "ticket", stage,
    title: "保持现有工作", round: 3, stage_states: ["done", "done", "active", "pending"],
    transitions: [], pushes: [{ repo: "r", sha: "old-code" }], mrs: [{ id: "mr-1" }] };
  const live: any = { id: state.id, root, state,
    driver: { steer: async (text: string) => { messages.push(text); } } };
  const service: any = Object.create(IssueFlowService.prototype);
  service.require = () => live;
  service.turning = new Set(status === "running" ? [live.id] : []);
  service.log = () => {};
  service.continueTurn = (_live: unknown, text: string) => { messages.push(text); };
  return { service, live, messages, root };
}

function add(service: any, note: string) {
  return service.addReview("issue-1", { line: 1, anchor: "旧代码", note });
}

test("运行中连续批量交办：立即 steer，批次不混入未来草稿，不回退阶段或清除验证事实", () => {
  const { service, live, messages, root } = issue();
  const before = JSON.stringify({ stage: live.state.stage, round: live.state.round,
    states: live.state.stage_states, pushes: live.state.pushes, mrs: live.state.mrs });
  add(service, "第一批：修改两行代码");
  const result = service.submitReviews(live.id);
  assert.match(result.stage_note, /已接收 1 条/);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /修改两行代码/);
  // ADR-0035 检视分诊:意见递给 AI 时带分诊准则(回复型 respond、
  // 修改型申报),不再无条件按"结合当前工作修改"处理。
  assert.match(messages[0], /检视意见分诊/);
  assert.match(messages[0], /respond_review/);
  add(service, "第二批：补充一条 UT");
  assert.doesNotMatch(messages[0], /第二批/);
  service.submitReviews(live.id);
  assert.equal(messages.length, 2);
  assert.doesNotMatch(messages[1], /第一批/);
  assert.equal(reviewStore(root).drafts().length, 0);
  assert.equal(JSON.stringify({ stage: live.state.stage, round: live.state.round,
    states: live.state.stage_states, pushes: live.state.pushes, mrs: live.state.mrs }), before);
  assert.equal(live.state.status, "running");
  assert.throws(() => service.submitReviews(live.id), /没有待提交/);
});

test("闸挂起提交检视立即开分诊回合(#350):env_verify 卡不再停靠,闸保持原样", () => {
  const { service, live, messages, root } = issue("waiting_user");
  live.state.gate = { kind: "env_verify", id: "gate-1", state_version: 1,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "到目标环境验证修复效果", options: [] }] } };
  add(service, "验证等待中的检视意见:先看这条");
  const result = service.submitReviews(live.id);
  assert.equal(messages.length, 1,
    "env_verify 卡可能等很久,检视意见与验证互不相关,立即递给 AI 分诊");
  assert.match(messages[0], /检视意见分诊/);
  assert.match(result.stage_note, /逐条分诊/,
    "回执不再是「当前问题答复后一起送达」");
  assert.equal(live.state.gate.id, "gate-1", "闸保持原样:不作废、不清理");
  assert.equal(loadState(root)!.parked_notices, undefined, "不停靠便签");
});

test("排队等待：十批长意见完整持久化，恢复不丢最早一批", async () => {
  const { service, live, root } = issue("queued");
  for (let i = 0; i < 10; i++) {
    add(service, `批次${i}：${"完整原文".repeat(700)}尾部${i}`);
    service.submitReviews(live.id);
  }
  assert.equal(live.state.status, "queued");
  live.state = loadState(root)!;
  assert.equal(live.state.parked_notices.length, 10);
  assert.match(live.state.parked_notices[0], /尾部0/);
  await assert.rejects(service.withParkedNotices(live, async () => { throw new Error("断线"); }), /断线/);
  assert.equal(loadState(root)!.parked_notices!.length, 10);
  let received = "";
  await service.withParkedNotices(live, async (text: string) => { received = text; });
  assert.match(received, /尾部0/);
  assert.match(received, /尾部9/);
  assert.equal(loadState(root)!.parked_notices, undefined);
});

test("启动空档/发送失败：批注完整等待补送，接管和终态不启动 Agent", async () => {
  const { service, live, root } = issue();
  live.driver = undefined;
  add(service, "启动时追加");
  service.submitReviews(live.id);
  assert.match(loadState(root)!.parked_notices![0], /启动时追加/);
  live.driver = { steer: async () => { throw new Error("会话退出"); } };
  add(service, "发送失败追加");
  service.submitReviews(live.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loadState(root)!.parked_notices!.length, 2);
  add(service, "等待交还");
  live.state.takeover = { active: true };
  assert.throws(() => service.submitReviews(live.id), /接管/);
  assert.equal(reviewStore(root).drafts().length, 1);
  live.state.status = "canceled";
  assert.throws(() => service.submitReviews(live.id), /已结束/);
});

test("需求 MR 会话尚未就绪：提交直接保存，不空等十秒，也不启动第二个 writer", async () => {
  const root = mfcTemp("concurrent-task-review-");
  const store = new AnnotationStore(join(root, "annotations.jsonl"));
  const note = store.add({ author: "owner", artifact: "main.ts", file: "main.ts", line: 1,
    anchor: "old", note: "追加明确的小修改", kind: "code" });
  const service: any = Object.create(TaskService.prototype);
  service.reviewReceiptInstructionsFor = () => "逐条回应";
  service.openFeedbackBatch = () => {};
  service.rememberWorkspaceReview = () => {};
  service.persist = () => {};
  service.annotations = () => store;
  service.dispatchWorkspaceReviewRepair = () => assert.fail("不得新起 writer");
  const task: any = { summary: { id: "task-1", workspace: root, status: "running",
    delivery: { mr_url: "https://example.test/mr/1" } } };
  const started = Date.now();
  const result = await service.sendMergeRequestReview(task, [note], note.note, "owner");
  assert.ok(Date.now() - started < 1000, "启动空档不应让提交请求空等");
  assert.equal(result.sent.length, 1);
  assert.match(task.pendingMainSteers[0], /追加明确的小修改/);
  assert.match(annotationSubmissionReceipt(store.list(), result.sent, 1, "running")!, /已接收/);
  assert.doesNotMatch(annotationSubmissionReceipt(store.list(), result.sent, 1, "running")!, /已经开始|已完成/);
  const snapshot = JSON.parse(readFileSync(join(root, "reviews/local-annotations.json"), "utf8"));
  assert.equal(snapshot.annotations[0].id, note.id);
});

test("排队任务追加意见不绕过并发额度；已在修订分析时仍能交办下一批", () => {
  const queued = issue("queued");
  add(queued.service, "启动后一起处理");
  const result = queued.service.submitReviews(queued.live.id);
  assert.equal(queued.messages.length, 0);
  assert.equal(queued.live.state.status, "queued");
  assert.match(result.stage_note, /随任务启动/);
  assert.match(loadState(queued.root)!.parked_notices![0], /启动后一起处理/);

  const running = issue("running", "analyze");
  running.live.state.review_active = true;
  add(running.service, "继续补充分析结论");
  running.service.submitReviews(running.live.id);
  assert.equal(running.messages.length, 1);
  assert.equal(running.live.state.stage, "analyze");
  assert.equal(running.live.state.round, 3);
});
