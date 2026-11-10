/**
 * 检视意见的"处理完成"闸(用户 2026-09-05 拍板):
 * - 中途提交的意见 Agent 要及时处理;最终"是否通过 / 确认推送"卡出现之前,
 *   所有已提交意见必须处理完成——只认当前版本的 fixed 回执,"收到了"
 *   "回了一句"、旧版本回执、not_fixed、needs_clarification 都不算;
 * - 确实缺信息可以单独追问(澄清卡),人答了继续处理;同一版正文最多追问
 *   两次,不许来回问;澄清卡不许夹带通过/推送选项,月光也不代答;
 * - 处理完成 ≠ 验收:提出人仍在最终卡上逐条确认,Agent 不能替人点通过。
 * 原来只在人点"通过"时拦——卡已经举出来了,人只剩"需要调整"可点,举卡
 * 时机太早。现在三道检查:举卡前(原会话继续)、回合收口(催原会话)、
 * 推送卡前(重新派单,同一批只派一次)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, renderAnnotations, type Annotation } from "../src/annotations.ts";
import { OVERALL_STORY_ARTIFACT } from "../src/overallStoryStore.ts";
import {
  agentReviewAnnotations,
  answeredClarificationReceipt,
  clarificationRoundsLeft,
  describeReviewProcessingGap,
  MAX_CLARIFICATION_ROUNDS,
  pendingReviewProcessing,
  reviewProcessingKey,
} from "../src/feedbackPolicy.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { withLiveReviewReceipts } from "../src/liveReviewReceipts.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { createRequirementAnalysisGateContract, TaskService } from "../src/taskService.ts";

function note(over: Partial<Annotation> = {}): Annotation {
  return {
    id: "an-1", author: "alice", created_at: "2026-09-05T00:00:00.000Z",
    artifact: "本任务变更", file: "src/a.ts", line: 3, anchor: "return x",
    note: "空值要处理", kind: "code", status: "sent", sent_via: "interrupt",
    ...over,
  };
}

const fixed = (revision = 0) => ({
  revision, outcome: "fixed" as const, summary: "改好了", evidence: [],
  responded_at: "2026-09-05T01:00:00.000Z",
});

test("Agent 的待办集:只有送到它眼前、没有当前版本 fixed 回执的意见", () => {
  const items: Annotation[] = [
    note({ id: "sent-no-receipt" }),
    note({ id: "sent-fixed", response: fixed() }),
    note({ id: "sent-not-fixed", response: { ...fixed(), outcome: "not_fixed" } }),
    note({ id: "sent-asking", response: { ...fixed(), outcome: "needs_clarification" } }),
    note({ id: "sent-old-fixed", rework: 1, response: fixed(0) }),
    note({ id: "decision-owner", route: "owner_decision", sent_via: "decision",
      owner_reply: { author: "owner", text: "按方案二", replied_at: "x" } }),
    note({ id: "draft", status: "draft", sent_via: undefined }),
    note({ id: "queued", sent_via: "queued_decision" }),
    note({ id: "pipeline", sent_via: "pipeline_evidence" }),
    note({ id: "owner-pending", route: "owner_reply", sent_via: "owner_pending" }),
    note({ id: "memory", route: "memory", status: "verified" }),
    note({ id: "verified", status: "verified" }),
    ...(["requirement_queue", "requirement_review", "overall_story_queue", "overall_story_processing", "overall_story"] as const)
      .map((sent_via) => note({ id: sent_via, sent_via })),
    note({ id: "analysis-story-decision", artifact: OVERALL_STORY_ARTIFACT, sent_via: "decision" }),
  ];
  assert.deepEqual(agentReviewAnnotations(items).map((item) => item.id), [
    "sent-no-receipt", "sent-fixed", "sent-not-fixed", "sent-asking",
    "sent-old-fixed", "decision-owner", "analysis-story-decision",
  ]);
  assert.deepEqual(pendingReviewProcessing(items).map((item) => item.id), [
    "sent-no-receipt", "sent-not-fixed", "sent-asking", "sent-old-fixed",
    "decision-owner", "analysis-story-decision",
  ], "收到了/回了一句都不算:not_fixed、needs_clarification、旧版本回执一律未完成");
  assert.equal(reviewProcessingKey(pendingReviewProcessing(items)),
    "analysis-story-decision:r0,decision-owner:r0,sent-asking:r0,sent-no-receipt:r0,sent-not-fixed:r0,sent-old-fixed:r1");
});

test("同文件坏回执不连坐有效项；重复 id 不取任意一条，重复 evidence 不反复写账", async () => {
  const { service, internal, first, store, receipts } = await serviceWithSentAnnotation();
  try {
    const extra = ["malformed", "duplicate"].map((name) => store.add({ author: "alice", artifact: "src/a.ts",
      file: "src/a.ts", line: 1, note: name, kind: "code", anchor: "x" }));
    store.markSent(extra.map((a) => a.id), "interrupt");
    const fixed = (id: string) => ({ annotation_id: id, revision: 0, outcome: "fixed",
      summary: "已补充空值检查与边界测试", evidence: ["src/a.ts:3", "src/a.ts:3"] });
    receipts([fixed(first.id), { ...fixed(extra[0].id), outcome: "invalid" },
      fixed(extra[1].id), { ...fixed(extra[1].id), outcome: "not_fixed" }]);
    const error = await (service as any).consumeReviewProcessingReceipts(internal);
    assert.match(error, /outcome 不合法/); assert.match(error, /重复回执/);
    const items = store.list();
    assert.deepEqual(items.find((a) => a.id === first.id)?.response?.evidence, ["src/a.ts:3"]);
    assert.ok(extra.every((a) => !items.find((b) => b.id === a.id)?.response));
    const log = join(internal.summary.workspace, "annotations.jsonl");
    const before = readFileSync(log, "utf8");
    await (service as any).consumeReviewProcessingReceipts(internal);
    assert.equal(readFileSync(log, "utf8"), before);
    assert.deepEqual(pendingReviewProcessing(store.list()).map((a) => a.id), extra.map((a) => a.id));
  } finally { await service.shutdown(); }
});

test("专项会话排队/处理中，主 Agent 不催办也不能用本地回执抢先登记", async () => {
  const { service, internal, first, store, receipts, before, confirmCard } = await serviceWithSentAnnotation();
  try {
    const auxiliary = (["requirement_queue", "requirement_review", "overall_story_queue", "overall_story_processing"] as const)
      .map((via) => {
        const a = store.add({ author: "alice", artifact: "requirement.md", file: "requirement.md",
          line: 1, note: "补充文档说明", kind: "doc", anchor: "x" });
        store.markSent([a.id], via); return a;
      });
    receipts([first, ...auxiliary].map((a) => ({ annotation_id: a.id, revision: 0, outcome: "fixed",
      summary: "已补充文档中的验收说明", evidence: ["requirement.md:1"] })));
    assert.equal(await (service as any).consumeReviewProcessingReceipts(internal), undefined);
    assert.ok(auxiliary.every((a) => !store.list().find((item) => item.id === a.id)?.response));
    assert.deepEqual(pendingReviewProcessing(store.list()), []);
    assert.equal(await before(confirmCard), undefined);
  } finally { await service.shutdown(); }
});

test("读取 Git 期间意见被改写或任务停止，旧回执不写回也不把正常改写报成会话失败", async () => {
  for (const change of ["edit", "cancel"] as const) {
    const { service, internal, first, store, receipts } = await serviceWithSentAnnotation();
    try {
      receipts([{ annotation_id: first.id, revision: 0, outcome: "fixed", summary: "已补充空值检查与边界测试", evidence: ["src/a.ts:3"] }]);
      internal.cwd = internal.summary.workspace;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      (service as any).prePushRevision = async () => { await waiting; return { sha: "a".repeat(40) }; };
      const consume = (service as any).consumeReviewProcessingReceipts(internal);
      if (change === "edit") store.edit(first.id, "请连同返回值空值也一并处理", "reviewer-a");
      else { internal.controlEpoch++; internal.summary.status = "canceled"; }
      release();
      assert.equal(await consume, undefined);
      assert.equal(store.list()[0].response, undefined);
    } finally { await service.shutdown(); }
  }
});

test("MR 意见在暂停或等人状态被拒绝时，不能先开内核批次再留下未发送草稿", async () => {
  const { service, internal, store } = await serviceWithSentAnnotation();
  try {
    const draft = store.add({ author: "alice", artifact: "src/a.ts", file: "src/a.ts", line: 1,
      note: "补充边界测试", kind: "code", anchor: "x" });
    internal.summary.delivery = { mr_url: "https://example.invalid/mr/1", mr_state: "验证中" };
    let opened = 0;
    (service as any).openFeedbackBatch = () => { opened++; };
    for (const status of ["paused", "pausing", "waiting_for_human"]) {
      internal.summary.status = status;
      await assert.rejects((service as any).sendMergeRequestReview(internal, [draft], draft.note), /暂停|等你回答/);
    }
    assert.equal(opened, 0);
    assert.equal(store.list().find((a) => a.id === draft.id)?.status, "draft");
  } finally { await service.shutdown(); }
});

test("最终回检只核对本批意见，不被同文件里其他批次或专项会话的回执卡住", async () => {
  const { service, internal, first, store, receipts } = await serviceWithSentAnnotation();
  try {
    const other = store.add({ author: "alice", artifact: "src/b.ts", file: "src/b.ts", line: 1,
      note: "另一个批次", kind: "code", anchor: "x" });
    store.markSent([other.id], "interrupt");
    internal.summary.delivery = { loop: { review_source: "workspace", workspace_review_annotation_ids: [first.id] } };
    receipts([first, other].map((a) => ({ annotation_id: a.id, revision: 0, outcome: "fixed",
      summary: "已补充空值检查与边界测试", evidence: ["src/a.ts:3"] })));
    assert.deepEqual(await (service as any).consumeWorkspaceReviewReceipts(internal), { ok: true });
    assert.equal(store.list().find((a) => a.id === other.id)?.response, undefined,
      "忽略其他批次不代表代它登记；主 Agent 实时消费者仍会负责它");
    internal.cwd = internal.summary.workspace;
    (service as any).prePushRevision = async () => {
      store.edit(first.id, "请修改另一处输入空值逻辑", "reviewer-a");
      return { sha: "b".repeat(40) };
    };
    const changed = await (service as any).consumeWorkspaceReviewReceipts(internal);
    assert.equal(changed.ok, false);
    assert.match(changed.detail, /已变化/);
    assert.equal(store.list().find((a) => a.id === first.id)?.response, undefined);
  } finally { await service.shutdown(); }
});

test("追问预算与已答复追问的识别", () => {
  const asked = note({ response: { ...fixed(), outcome: "needs_clarification",
    summary: "入参还是返回值?" } });
  assert.equal(clarificationRoundsLeft(asked), MAX_CLARIFICATION_ROUNDS);
  assert.match(describeReviewProcessingGap(asked), /尚未向人追问/);
  const answeredOnce = note({
    clarifications: [{ question: "入参还是返回值?", asked_at: "a", answered_at: "b",
      answer: "入参", answered_by: "alice", revision: 0 }],
  });
  assert.equal(clarificationRoundsLeft(answeredOnce), MAX_CLARIFICATION_ROUNDS - 1);
  assert.equal(answeredClarificationReceipt(answeredOnce,
    { revision: 0, outcome: "needs_clarification", summary: "入参还是返回值?" }), true,
    "Agent 把答过的追问原样再抄一遍,不能复活成又在等人");
  assert.equal(answeredClarificationReceipt(answeredOnce,
    { revision: 0, outcome: "needs_clarification", summary: "另一个问题" }), false);
  assert.match(describeReviewProcessingGap(answeredOnce), /缺当前版本.*已答复.*入参/);
  const exhausted = note({
    response: { ...fixed(), outcome: "needs_clarification", summary: "第三问" },
    clarifications: [
      { question: "一", asked_at: "a", answered_at: "b", answer: "A", revision: 0 },
      { question: "二", asked_at: "a", answered_at: "b", answer: "B", revision: 0 },
      { question: "旧版本的", asked_at: "a", answered_at: "b", answer: "C", revision: 1 },
    ],
  });
  assert.equal(clarificationRoundsLeft(exhausted), 0, "只数当前版本里答过的");
  assert.match(describeReviewProcessingGap(exhausted), /上限.*不能再问/);
  assert.match(describeReviewProcessingGap(note({
    response: { ...fixed(), outcome: "not_fixed", summary: "我觉得不该改" } })),
  /not_fixed.*不算处理完成/);
});

test("批注账:澄清卡答复留档并清空回执;改字换版本但不算返工", () => {
  const store = new AnnotationStore(
    join(mkdtempSync(join(tmpdir(), "mfc-gate-store-")), "annotations.jsonl"));
  const item = store.add({
    author: "alice", artifact: "本任务变更", file: "src/a.ts", line: 3,
    anchor: "return x", note: "空值要处理", kind: "code",
  });
  assert.throws(() => store.answerClarification(item.id, "入参", "alice"),
    /没有等待答复的追问/, "没在等补充说明就没有可答的追问");
  store.markSent([item.id], "interrupt");
  store.respond(item.id, { outcome: "needs_clarification", summary: "入参还是返回值?", evidence: [] });
  const answered = store.answerClarification(item.id, "指入参,为空返回空列表", "alice");
  assert.equal(answered.response, undefined, "答复后回执清空,Agent 要重新写");
  assert.equal(answered.status, "sent");
  assert.deepEqual(answered.clarifications?.map((row) =>
    [row.question, row.answer, row.answered_by, row.revision]),
  [["入参还是返回值?", "指入参,为空返回空列表", "alice", 0]]);
  const rendered = renderAnnotations([answered], "T-1");
  assert.match(rendered, /上一轮你问过:入参还是返回值\?/);
  assert.match(rendered, /alice 答复:指入参,为空返回空列表/);
  assert.match(rendered, /不要再问同一件事/);
  assert.doesNotMatch(rendered, /次提出/, "答复不是返工");

  // 作者改字重提:版本 +1(旧回执不能背书新文字),但"返工次数"不动。
  store.respond(item.id, { outcome: "fixed", summary: "已处理", evidence: [] });
  const edited = store.edit(item.id, "空值指入参,返回空列表并打日志", "alice");
  assert.equal(edited.rework, 1);
  assert.equal(edited.returned ?? 0, 0);
  assert.equal(edited.response, undefined);
  store.markSent([item.id], "interrupt");
  assert.throws(() => store.respond(item.id, { revision: 0, outcome: "fixed",
    summary: "旧的", evidence: [] }), /旧轮回应/);
  assert.doesNotMatch(renderAnnotations(store.list(), "T-1"), /次提出/,
    "改字重提不许说成上一轮改坏了");

  // 人点"仍需调整"才是返工:版本与返工次数都 +1,渲染点明是第 2 次提出。
  store.respond(item.id, { outcome: "fixed", summary: "已处理", evidence: [] });
  const reopened = store.reopen(item.id, "alice");
  assert.equal(reopened.rework, 2);
  assert.equal(reopened.returned, 1);
  assert.match(renderAnnotations(store.list(), "T-1"), /第 2 次提出/);
});

/** 模型收到的全部消息正文(含工具结果),跨请求。 */
function allSeen(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .map((message: any) => JSON.stringify(message.content ?? ""))
    .join("\n");
}

test("举卡前核对:被拦的卡不生成待办、不通知,原会话拿着纠偏话继续;放行的才是待办", async () => {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "Diff 通过吗?", options: ["通过", "打回"], recommended: "通过" }] } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现在通过吗?", options: ["通过", "打回"], recommended: "通过" }] } } },
    { text: "完成。" },
  ]);
  await model.start();
  const dir = mkdtempSync(join(tmpdir(), "mfc-gate-driver-"));
  const agentDir = join(dir, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const humanGate = new HumanGate(join(dir, "waiting.json"));
  const eventLog = new EventLog(join(dir, "events.jsonl"));
  const asked: string[] = [];
  const session = await CloudSession.create({
    taskId: "T-gate", workspace: dir, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog,
    transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate,
    beforeHumanQuestion: async (input) => {
      asked.push(String((input.questions as any[])[0].question));
      return asked.length === 1
        ? "还有 1 条已提交的检视意见没有处理完成:不能举起整体确认卡" : undefined;
    },
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "waiting_for_human");
    assert.deepEqual(asked, ["Diff 通过吗?", "现在通过吗?"], "两次举卡都先问过宿主");
    assert.equal(humanGate.pending().length, 1, "被拦的那张没有变成待办");
    assert.equal(String(outcome.waiting?.question?.questions?.[0]?.question),
      "现在通过吗?");
    assert.match(allSeen(model), /没有处理完成:不能举起整体确认卡/,
      "纠偏话作为工具结果回到模型手里");
    const events = readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n")
      .map((line) => JSON.parse(line));
    const errored = events.filter((event) => event.kind === "tool_finished"
      && event.payload?.name === "AskUserQuestion" && event.payload?.is_error);
    assert.equal(errored.length, 1, "被拦的调用如实记成出错的工具结果");
  } finally {
    session.dispose();
    await model.stop();
  }
});

function kernelWithInspect(): string {
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-gate-kernel-"));
  mkdirSync(join(kernelRoot, "flow"));
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        confirmation_answers: ["修改范围无需再调整，确认进入编码"],
        next: "build",
      },
      build: { clear_hint: true },
    },
  }));
  return kernelRoot;
}

async function serviceWithSentAnnotation() {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-gate-service-"));
  const notified: Array<{ account: string; status: string; summary: string }> = [];
  const waitingNotices: Array<{ account: string; summary: string }> = [];
  const logs: string[] = [];
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: kernelWithInspect(), repoPath: "/unused" } as any,
    notifier: {
      notifyOutcome: async (input: any) => { notified.push(input); },
      notifyWaiting: async (input: any) => {
        waitingNotices.push(input);
        return { delivered: true, attempts: 1 };
      },
    } as any,
    log: (line: string) => logs.push(line),
  });
  const id = service.create("处理空值", { account: "owner" }).id;
  const internal = (service as any).tasks.get(id);
  const store = (service as any).annotations(internal) as AnnotationStore;
  const first = store.add({
    author: "reviewer-a", artifact: "本任务变更", file: "src/a.ts", line: 3,
    anchor: "return x", note: "空值要处理", kind: "code",
  });
  store.markSent([first.id], "interrupt");
  const reviews = join(internal.summary.workspace, "reviews");
  mkdirSync(reviews, { recursive: true });
  const receiptsPath = join(reviews, "local-receipts.json");
  const receipts = (rows: unknown[]) =>
    writeFileSync(receiptsPath, JSON.stringify({ receipts: rows }));
  const confirmCard = { questions: [{ question: "修改范围是否确认?",
    options: ["修改范围无需再调整，确认进入编码", "需要调整范围"],
    recommended: "修改范围无需再调整，确认进入编码" }] };
  const before = (input: Record<string, unknown>) =>
    (service as any).beforeReviewQuestion(internal, input) as Promise<string | undefined>;
  return { service, id, internal, store, first, receipts, receiptsPath, confirmCard,
    before, notified, waitingNotices, logs };
}

test("运行中写回执后下一工具前即登记：三条 sent 接收、草稿不发送、不需举卡或收口", async () => {
  const { service, internal, first, store, receiptsPath } = await serviceWithSentAnnotation();
  const extra = [2, 3, 4].map((i) => store.add({ author: "reviewer", artifact: "story.md",
    file: "story.md", line: i, anchor: "场景", note: "补充验收口径", kind: "doc" }));
  store.markSent(extra.slice(0, 2).map((a) => a.id), "review_repair");
  const all = [first, ...extra];
  internal.summary.delivery = { loop: { review_source: "workspace",
    workspace_review_annotation_ids: all.map((a) => a.id) } };
  const content = JSON.stringify({ receipts: all.map((a) => ({ annotation_id: a.id,
    revision: 0, outcome: "fixed", summary: "已补充当前场景验收口径", evidence: ["story.md:3"] })) });
  const logs: string[] = [];
  let reads = 0;
  const hooks = withLiveReviewReceipts({ preTool: async (event) => {
    if (event.payload.name === "Read") {
      reads++;
      assert.equal(store.list().filter((a) => a.response?.outcome === "fixed").length, 3);
      assert.equal(store.list().find((a) => a.id === extra[2].id)?.status, "draft");
    }
    return undefined;
  } }, { current: () => true, list: () => store.list(),
    consume: () => (service as any).consumeReviewProcessingReceipts(internal),
    log: (message) => logs.push(message) });
  const model = new ScriptedModelServer([
    { tool: { name: "write", input: { path: receiptsPath, content } } },
    { tool: { name: "read", input: { path: receiptsPath } } },
    { tool: { name: "read", input: { path: receiptsPath } } },
    { text: "回执已登记，完成本轮。" },
  ]);
  let session: CloudSession | undefined;
  try {
    await model.start();
    const root = internal.summary.workspace;
    const agentDir = join(root, "live-agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    session = await CloudSession.create({ taskId: internal.summary.id, workspace: root, agentDir,
      provider: "maeflow", model: "scripted-v1", hostHooks: hooks,
      eventLog: new EventLog(join(agentDir, "events.jsonl")),
      transcript: new TranscriptStore(join(agentDir, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: root, cwd: root,
        contract: createRequirementAnalysisGateContract(root, root, undefined, receiptsPath) }),
      humanGate: new HumanGate(join(root, "live-waiting.json")),
    });
    await session.start("写入回执，再读两次核对。不要提问。");
    assert.deepEqual(session.takeUndeliveredSteers(), [], "普通回执提示不能变成收口后重新续跑的插话");
    assert.match(allSeen(model), /宿主已登记 3 条/);
    assert.ok(!new EventLog(join(agentDir, "events.jsonl")).replay().some((event) => event.kind === "user_message"
      && String(event.payload.text).startsWith("宿主已登记")), "进度说明必须是工具结果，不冒充用户指令");
    assert.equal(reads, 2);
    assert.equal(logs.filter((line) => line.includes("已登记 3 条")).length, 1);
    assert.equal(store.list().filter((a) => a.status === "verified").length, 0);
    const before = readFileSync(join(root, "annotations.jsonl"), "utf8");
    const resumed = withLiveReviewReceipts(undefined, { current: () => true,
      list: () => store.list(), consume: () => (service as any).consumeReviewProcessingReceipts(internal),
      log() {} });
    const event = { eventId: 20, taskId: internal.summary.id, sessionId: "main", ts: "",
      kind: "tool_requested" as const,
      payload: { name: "Bash", call_id: "current", input: { command: "python mae-flow.py current" } } };
    await resumed.preTool!(event);
    assert.equal(await resumed.postTool!({ ...event, kind: "tool_finished" }), undefined);
    const notice = await resumed.toolResultNote!({ name: "Bash", input: { command: "python mae-flow.py current" } });
    assert.match(String(notice), /保留原始意见和来源 SHA/);
    assert.equal(readFileSync(join(root, "annotations.jsonl"), "utf8"), before,
      "重启和重复 current 不重复登记，也不凭新 HEAD 重绑旧回执");
    assert.deepEqual(await (service as any).consumeWorkspaceReviewReceipts(internal), { ok: true },
      "最终严格消费也忽略已知草稿的多余回执");
    assert.equal(store.list().find((a) => a.id === extra[2].id)?.response, undefined);
    assert.deepEqual(internal.summary.delivery.loop.workspace_review_annotation_ids,
      [first.id, extra[0].id, extra[1].id], "未提交初稿不再混入本轮回检清单");
    store.reopen(first.id, "reviewer-a");
    await (service as any).consumeReviewProcessingReceipts(internal);
    assert.ok(internal.summary.delivery.loop.workspace_review_annotation_ids.includes(first.id),
      "作者返工后的草稿仍保留，不能借实时消费免除返工责任");
  } finally { session?.dispose(); await model.stop(); await service.shutdown(); }
});

test("嵌套分析目录：错误位置的回执不算闭环，原会话按绝对路径补写后即可举卡", async () => {
  const { service, internal, first, store, receiptsPath, confirmCard, before } =
    await serviceWithSentAnnotation();
  const cwd = join(internal.summary.workspace, "repositories", ".mae-flow-work", "task-2");
  mkdirSync(cwd, { recursive: true });
  internal.cwd = cwd;
  const content = JSON.stringify({ receipts: [{ annotation_id: first.id, revision: 0,
    outcome: "fixed", summary: "已补充空值判断并完成检验", evidence: ["src/a.ts:3"] }] });
  const wrong = join(cwd, "..", "reviews", "local-receipts.json");
  mkdirSync(join(cwd, "..", "reviews"), { recursive: true });
  writeFileSync(wrong, content);
  const blocked = await before(confirmCard);
  assert.ok(blocked?.includes(receiptsPath));
  assert.equal(store.list()[0].response, undefined);
  // 发单不能因工作目录在任务根、单仓、多仓或产物目录而换一个收件地址。
  for (const relative of ["", "repository", "repositories", "repositories/.mae-flow-work/task-2"]) {
    internal.cwd = join(internal.summary.workspace, relative);
    assert.ok((service as any).reviewReceiptInstructionsFor(internal, [first]).includes(receiptsPath));
  }
  internal.cwd = cwd;
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: confirmCard } },
    { tool: { name: "write", input: { path: receiptsPath, content } } },
    { tool: { name: "AskUserQuestion", input: confirmCard } },
    { text: "完成。" },
  ]);
  let session: CloudSession | undefined;
  try {
    await model.start();
    const agentDir = join(internal.summary.workspace, "pi-agent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    const humanGate = new HumanGate(join(internal.summary.workspace, "waiting-test.json"));
    session = await CloudSession.create({
      taskId: internal.summary.id, workspace: cwd, agentDir,
      provider: "maeflow", model: "scripted-v1",
      eventLog: new EventLog(join(agentDir, "events-test.jsonl")),
      transcript: new TranscriptStore(join(agentDir, "transcript-test.jsonl"), "main"),
      gate: new GateService({ workspace: internal.summary.workspace, cwd,
        contract: createRequirementAnalysisGateContract(cwd, cwd, undefined, receiptsPath) }),
      humanGate, beforeHumanQuestion: before,
    });
    const result = await session.start(blocked!);
    assert.equal(result.status, "waiting_for_human", allSeen(model));
    assert.equal(readFileSync(receiptsPath, "utf-8"), content);
    assert.equal(store.list()[0].response?.outcome, "fixed");
    assert.equal(store.list()[0].status, "sent", "作者仍保留最终验收权");
    assert.equal(humanGate.pending().length, 1, "第一次被拦的卡没有进入待办");
    // 工作台检视修复的另一条消费链也读同一份文件。
    internal.summary.delivery = { loop: { review_source: "workspace",
      workspace_review_annotation_ids: [first.id] } };
    (service as any).prePushRevision = async () => ({ sha: "a".repeat(40) });
    assert.deepEqual(await (service as any).consumeWorkspaceReviewReceipts(internal), { ok: true });
  } finally {
    session?.dispose();
    await model.stop();
    await service.shutdown();
  }
});

test("举卡前:意见没处理完不许举确认卡;回执读盘即登记;旧版本回执是历史不背书新文字", async () => {
  const { service, first, store, receipts, receiptsPath, confirmCard, before } =
    await serviceWithSentAnnotation();
  try {
    const blocked = await before(confirmCard);
    assert.ok(blocked, "没有回执就不能举确认卡");
    assert.match(blocked!, /1 条已提交的检视意见没有处理完成/);
    assert.match(blocked!, new RegExp(`${first.id}:缺当前版本\\(revision 0\\)的回执`));
    assert.match(blocked!, /reviews\/local-receipts\.json/, "回执路径锚定任务根目录");
    assert.match(blocked!, /空值要处理/, "把意见原文再给一遍,不用它回翻");
    assert.match(blocked!, /不能替他们点通过/);

    receipts([{ annotation_id: first.id, revision: 0, outcome: "not_fixed",
      summary: "我觉得不该改", evidence: [] }]);
    const notFixed = await before(confirmCard);
    assert.match(notFixed ?? "", /not_fixed.*不算处理完成/, "回了一句不算处理完成");
    assert.equal(store.list()[0].response?.outcome, "not_fixed", "但回执照登记,面板看得到");

    receipts([{ annotation_id: first.id, revision: 0, outcome: "fixed",
      summary: "已补空值判断", evidence: ["src/a.ts:3"] }]);
    assert.equal(await before(confirmCard), undefined, "fixed 回执齐了才放行");
    assert.equal(store.list()[0].response?.outcome, "fixed");
    assert.equal(store.list()[0].status, "sent", "处理完成 ≠ 验收:仍等作者确认");

    // 作者改字重提:盘上那条 fixed 是旧版本,忽略(不算错),但也不背书新文字。
    store.edit(first.id, "空值指入参,返回空列表", "reviewer-a");
    store.markSent([first.id], "interrupt");
    const stale = await before(confirmCard);
    assert.match(stale ?? "", /缺当前版本\(revision 1\)的回执/);
    assert.doesNotMatch(stale ?? "", /回执文件有问题/, "旧版本回执是历史,不是格式错");
    receipts([{ annotation_id: first.id, revision: 1, outcome: "fixed",
      summary: "按新要求改成返回空列表", evidence: ["src/a.ts:3"] }]);
    assert.equal(await before(confirmCard), undefined);

    // 文件坏了:有待处理意见时把原因告诉 Agent 让它修。
    store.edit(first.id, "再改一版", "reviewer-a");
    store.markSent([first.id], "interrupt");
    writeFileSync(receiptsPath, "{not json");
    const broken = await before(confirmCard);
    assert.match(broken ?? "", /回执文件有问题.*JSON/);
  } finally {
    await service.shutdown();
  }
});

test("澄清卡:只放行形状合规的追问;答复落账后回执清空、旧追问不复活、限两次", async () => {
  const { service, id, internal, first, store, receipts, receiptsPath, before,
    waitingNotices } = await serviceWithSentAnnotation();
  try {
    const ask = (question: string, over: Record<string, unknown> = {}) => ({
      purpose: "clarification", annotation_ids: [first.id],
      questions: [{ question }], ...over,
    });
    assert.match(await before(ask("入参还是返回值?")) ?? "",
      /还没有当前版本的 needs_clarification 回执/, "先把疑问写进回执,再问人");
    receipts([{ annotation_id: first.id, revision: 0, outcome: "needs_clarification",
      summary: "入参还是返回值?", evidence: [] }]);
    assert.match(await before({ ...ask("入参还是返回值?"), annotation_ids: ["an-nope"] }) ?? "",
      /不在待处理清单里/);
    assert.match(await before(ask("入参还是返回值?", { questions: [{
      question: "顺便确认?", options: ["确认按清单推送", "再看看"], recommended: "再看看" }] })) ?? "",
    /不能带「确认按清单推送」/, "追问不许夹带验收");
    assert.match(await before({ questions: [{ question: "都处理好了,通过吗?",
      options: ["通过", "打回"], recommended: "通过" }] }) ?? "",
    /尚未向人追问.*purpose=clarification/, "需要补充说明时确认卡照拦,提示它去追问");
    assert.equal(await before(ask("入参还是返回值?")), undefined, "合规追问放行");

    // 举出澄清卡并由意见作者答复(不是责任人)。
    const record = internal.humanGate.createWaiting({
      taskId: id, step: "inspect", callId: "c-clarify",
      questionInput: { questions: [{ question: "入参还是返回值?" }],
        purpose: "clarification", annotation_ids: [first.id] },
    });
    internal.summary.waiting = record;
    internal.summary.status = "waiting_for_human";
    assert.equal(service.canAnswerClarification(id, "reviewer-a"), true, "被追问的作者能答");
    assert.equal(service.canAnswerClarification(id, "stranger"), false);
    // 月光/内部节点自动交卷都绕不过澄清卡:缺的信息只有人给得出。
    internal.summary.approval_mode = "moonlight";
    assert.equal((service as any).autoAnswerFor(internal), undefined, "月光不代答澄清卡");
    internal.summary.delivery = { loop: { round: 0, max: 3, state: "repairing",
      kind: "review", review_source: "workspace",
      workspace_review_recheck_required: true,
      workspace_review_annotation_ids: [first.id] } };
    assert.equal(await (service as any).workspaceReviewNodeAnswer(internal), undefined,
      "修复轮内部节点的自动交卷也不碰澄清卡");
    internal.summary.delivery = undefined;
    internal.summary.approval_mode = undefined;
    (service as any).notifyWaiting(internal);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(waitingNotices.map((row) => [row.account, /缺少信息/.test(row.summary)]),
      [["owner", true], ["reviewer-a", true]], "责任人与被追问的作者都收到,措辞说清是追问");
    await service.decide(id, {
      waiting_id: record.waiting_id, state_version: record.state_version,
      free_responses: { "入参还是返回值?": "指入参:为空时返回空列表" },
      actor: "reviewer-a",
    });
    const answered = store.list().find((item) => item.id === first.id)!;
    assert.equal(answered.response, undefined, "答复后回执清空,Agent 要重新写");
    assert.deepEqual(answered.clarifications?.map((row) => [row.answer, row.answered_by]),
      [["指入参:为空时返回空列表", "reviewer-a"]]);
    assert.equal(JSON.parse(readFileSync(receiptsPath, "utf-8")).receipts.length, 0,
      "盘上那条旧追问回执被剪掉");

    // Agent 若把答过的追问原样再抄一遍:不复活;再问同一条也被拦。
    receipts([{ annotation_id: first.id, revision: 0, outcome: "needs_clarification",
      summary: "入参还是返回值?", evidence: [] }]);
    const again = await before(ask("入参还是返回值?"));
    assert.match(again ?? "", /还没有当前版本的 needs_clarification 回执/);
    assert.match(again ?? "", /已答复.*入参还是返回值\?.*指入参/, "把已有答复再摆给它看");
    assert.equal(store.list().find((item) => item.id === first.id)!.response, undefined);

    // 真有第二个问题可以再问一次;第三次就到上限。
    receipts([{ annotation_id: first.id, revision: 0, outcome: "needs_clarification",
      summary: "空列表要不要打日志?", evidence: [] }]);
    assert.equal(await before(ask("空列表要不要打日志?")), undefined);
    const second = internal.humanGate.createWaiting({
      taskId: id, step: "inspect", callId: "c-clarify-2",
      questionInput: { questions: [{ question: "空列表要不要打日志?" }],
        purpose: "clarification", annotation_ids: [first.id] },
    });
    internal.summary.waiting = second;
    internal.summary.status = "waiting_for_human";
    await service.decide(id, {
      waiting_id: second.waiting_id, state_version: second.state_version,
      free_responses: { "空列表要不要打日志?": "要,warn 级别" },
      actor: "owner",
    });
    receipts([{ annotation_id: first.id, revision: 0, outcome: "needs_clarification",
      summary: "第三个问题?", evidence: [] }]);
    assert.match(await before(ask("第三个问题?")) ?? "",
      new RegExp(`追问已达 ${MAX_CLARIFICATION_ROUNDS} 次上限`));
    assert.match(await before({ questions: [{ question: "通过吗?",
      options: ["通过", "打回"], recommended: "通过" }] }) ?? "",
    /上限,不能再问——按最合理理解处理/);
    receipts([{ annotation_id: first.id, revision: 0, outcome: "fixed",
      summary: "按两次答复处理:入参为空返回空列表并打 warn 日志", evidence: ["src/a.ts:3"] }]);
    assert.equal(await before({ questions: [{ question: "通过吗?",
      options: ["通过", "打回"], recommended: "通过" }] }), undefined);
    const done = store.list().find((item) => item.id === first.id)!;
    assert.equal(done.response?.outcome, "fixed");
    assert.equal(done.status, "sent", "处理完成 ≠ 验收:作者仍要在最终卡上确认");
  } finally {
    await service.shutdown();
  }
});

async function until(probe: () => boolean, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("回合收口:意见没处理完就催原会话接着处理(不另起会话);补上回执后才收口", async () => {
  // 第一幕故意跑慢命令,给"会话跑动中送意见"留窗口;第二幕直接收嘴,
  // 宿主该在收口时发现意见没处理完、催原会话;第三幕再跑慢命令,给测试
  // 写回执留窗口;第四幕收嘴,这次回执齐了,任务正常收口。
  const script: Scene[] = [
    { text: "先看现场", tool: { name: "bash", input: { command: "sleep 2; echo LOOKED" } } },
    { text: "改完了。" },
    { text: "补回执", tool: { name: "bash", input: { command: "sleep 2; echo WROTE" } } },
    { text: "完成。" },
  ];
  // 顺演:每个请求推进一幕。默认的"按对话深度选幕"在催办回合会跳幕,
  // 时序对不上剧本。
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-gate-turn-")),
    provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    log: (line) => logs.push(line),
  });
  try {
    const id = service.create("回合收口演练").id;
    const internal = (service as any).tasks.get(id);
    await until(() => internal.summary.status === "running" && !!internal.driver, "会话起来");
    const store = (service as any).annotations(internal) as AnnotationStore;
    const item = store.add({
      author: "reviewer-a", artifact: "本任务变更", file: "src/a.ts", line: 3,
      anchor: "return x", note: "空值要处理", kind: "code",
    });
    store.markSent([item.id], "interrupt");
    const nudged = () => allSeen(model).includes("没有处理完成:不能举起整体确认卡");
    await until(nudged, "宿主催原会话继续处理");
    assert.equal(internal.reviewProcessingNudge?.count, 1, logs.join("\n"));
    assert.match(String(service.get(id)!.detail), /未处理完成,Agent 正在继续处理/);
    const reviews = join(internal.summary.workspace, "reviews");
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, "local-receipts.json"), JSON.stringify({ receipts: [
      { annotation_id: item.id, revision: 0, outcome: "fixed",
        summary: "已补空值判断", evidence: ["src/a.ts:3"] },
    ] }));
    await until(() => ["completed", "failed"].includes(internal.summary.status), "任务收口");
    assert.equal(internal.summary.status, "completed", logs.join("\n"));
    assert.equal(store.list()[0].response?.outcome, "fixed", "收口时读到回执并登记");
    const events = readFileSync(join(internal.summary.workspace, "events.jsonl"), "utf-8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.filter((event) => event.kind === "session_started").length, 1,
      "催办发生在同一会话里,没有另起第二个 Agent");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});
