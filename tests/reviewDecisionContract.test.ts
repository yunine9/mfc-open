import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TaskService } from "../src/taskService.ts";
import { createPrePushVerification, beginPrePushAttempt } from "../src/prePushVerification.ts";
import { HumanGate } from "../src/humanGate.ts";
import { explicitlyRequestsReviewFeedback, pendingReviewAnnotation, isReviewAdjustmentAnswer, reviewDecisionContract, REVIEW_ADJUST, REVIEW_HOLD } from "../src/reviewDecisionContract.ts";
import { stepChoiceEffects } from "../src/kernelChoices.ts";
import { isPushConfirmation } from "../web/src/decisionSelection.ts";

const kernelRoot = join(process.cwd(), "kernel");
const effects = stepChoiceEffects(kernelRoot, "delivery_review");
const raw = { questions: [{ question: "是否按当前范围推送？", options: ["推送至远端 master_ABC 并发起 MR", "暂不推送,我先本地核对"], recommended: "推送至远端 master_ABC 并发起 MR" }] };

test("批注是否待处理只看状态，明确修改意见与暂缓答复分开", () => {
  for (const route of [undefined, "agent", "owner_reply", "owner_decision", "legacy"]) {
    assert.equal(pendingReviewAnnotation({ status: "draft", route }), true);
    assert.equal(pendingReviewAnnotation({ status: "draft", route, owner_reply: {} }), false);
    assert.equal(pendingReviewAnnotation({ status: "verified", route }), false);
  }
  for (const text of ["需要调整,按检视意见继续处理", "处理下当前的检视意见", "按当前检视意见修改"]) {
    assert.equal(explicitlyRequestsReviewFeedback(text), true);
  }
  for (const text of ["先调整", "不按检视意见修改", "暂不处理检视意见", "是否处理检视意见？", "稍后修改检视意见"]) {
    assert.equal(explicitlyRequestsReviewFeedback(text), false);
  }
});

test("模型自造正式检视选项归一为真实确认契约，暂缓没有返工或确认效果", () => {
  const contract = reviewDecisionContract(raw, effects);
  const options = (contract.question as typeof raw).questions[0].options;
  assert.deepEqual(options, [effects[0].answers[0], REVIEW_ADJUST, REVIEW_HOLD]);
  assert.equal(contract.effects.some(effect => effect.answers.includes(REVIEW_HOLD)), false);
  assert.equal(contract.effects.find(effect => effect.handlesFeedback)?.answers[0], REVIEW_ADJUST);
  assert.deepEqual(reviewDecisionContract(contract.question, effects), contract, "重复读取不会换选项或重复添加效果");
  assert.equal(raw.questions[0].options[0], "推送至远端 master_ABC 并发起 MR", "不得修改原始历史问题");
  assert.deepEqual(reviewDecisionContract({ ...raw, purpose: "clarification" }, effects).question, { ...raw, purpose: "clarification" });
  assert.equal(reviewDecisionContract({ questions: [...raw.questions, ...raw.questions] }, effects).effects, effects);
});

const specQuestion = "本地 Spec 是否确认？";
const specAdjust = "Spec仍需调整（按当前检视意见修改）";
const specRaw = { questions: [{ question: specQuestion, options: [
  "Spec 无需再调整，确认生成 Story", specAdjust,
] }] };
const specEffects = stepChoiceEffects(kernelRoot, "open");

test("Spec 原生调整文案直接取得处理检视意见效果", () => {
  const contract = reviewDecisionContract(specRaw, specEffects);
  assert.deepEqual(contract.question, specRaw, "内核原生卡不应被改写");
  assert.equal(contract.effects.some(effect => effect.handlesFeedback
    && effect.answers.includes(specAdjust)), true);
  assert.equal(isReviewAdjustmentAnswer(specAdjust), true);
  assert.equal(isReviewAdjustmentAnswer("暂不确认，我先核对"), false);
});

for (const [step, adjustment] of [
  ["open", "Spec 仍需调整（按当前检视意见修改）"],
  ["hf_open", "需要调整范围（按当前检视意见修改）"],
  ["tw_open", "需要调整范围（按当前检视意见修改）"],
  ["story", "Story 或实施附录仍需调整（按当前检视意见修改）"],
  ["delivery_review", "交付增量仍需调整（按当前检视意见修改）"],
] as const) test(`${step} 检视卡的真实调整文案会携带剩余意见`, () => {
  const stepEffects = stepChoiceEffects(kernelRoot, step);
  const confirm = stepEffects.find(effect => effect.closesFeedback)?.answers[0];
  assert.ok(confirm, `${step} 必须有内核确认契约`);
  const contract = reviewDecisionContract({ questions: [{ question: "是否确认？",
    options: [confirm, adjustment] }] }, stepEffects);
  assert.equal(contract.effects.some(effect => effect.handlesFeedback
    && effect.answers.includes(adjustment)), true);
});

function fixture(mr = false, cardRaw: Record<string, unknown> = raw, pulseStep = "delivery_review") {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-task19-review-"));
  const workspace = join(dataDir, "task-19"), cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
  writeFileSync(join(cwd, "a.ts"), "export const value = 1;\n"); git("add", "."); git("commit", "--quiet", "-m", "initial");
  const head = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, ".mae-flow-work"));
  writeFileSync(join(cwd, ".mae-flow-work", "panel-pulse.js"), JSON.stringify({ step: pulseStep, step_title: pulseStep === "open" ? "本地 Spec 确认" : "最终代码增量检视", revision: 2 }));
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ current: pulseStep, config: { "基线分支": "main" }, step_heads: { branch_create: head } }));
  const gate = new HumanGate(join(workspace, "waiting.json"));
  const waiting = gate.createWaiting({ taskId: "task-19", step: pulseStep === "open" ? "本地 Spec 确认" : "最终代码增量检视", callId: "ask", questionInput: cardRaw });
  const delivery = { sha: head, git_push: { sha: head }, ...(mr ? { mr_url: "https://example.test/mr/1", mr_id: 1 } : {}) };
  const selection = { paths: ["a.ts"], excluded_paths: [], observed_paths: ["a.ts"], status: "requested", head, waiting_id: "old", updated_at: new Date().toISOString() };
  writeFileSync(join(workspace, "task.json"), JSON.stringify({ cwd, summary: { id: "task-19", workspace, requirement: "检视交互", status: "waiting_for_human", created_at: new Date().toISOString(), luban_account: "owner", waiting, delivery, delivery_selection: selection } }));
  const service = new TaskService({ dataDir, provider: "unused", model: "unused", modelsJson: {}, maxConcurrent: 0, host: { kernelRoot, python: "python3", continuousReview: false } });
  service.recover();
  const api = service as any, task = api.tasks.get("task-19");
  return { service, api, task, gate, cwd, git, head, selection };
}

for (const prior of ["draft", "owner_pending"]) for (const answer of ["需要调整,按检视意见继续处理", "处理下当前的检视意见", "暂不处理检视意见"]) test(`无内核检视契约的自由举卡（${prior}）：${answer}`, async () => {
  const question = "Story 联合检视 CLEAR，是否进入编码？";
  const f = fixture(false, { questions: [{ question, options: ["进入编码", answer] }] }, "coding");
  const store = f.api.annotations(f.task);
  const ids: string[] = [];
  for (const [index, route] of ["owner_reply", "owner_decision", "agent", undefined].entries()) {
    const item = f.service.addAnnotation("task-19", { author: index % 2 ? "reviewer" : "owner",
      artifact: "story", file: "story.md", line: index + 1, anchor: "设计",
      kind: index % 2 ? "code" : "doc", route: route as any, note: `待处理意见${index}` });
    ids.push(item.id);
  }
  const answered = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "story", file: "story.md", line: 8, anchor: "约定", kind: "doc", note: "责任人已答复内容" });
  await f.service.replyToAnnotation("task-19", answered.id, "owner", "无需修改，等待逐条闭环");
  if (prior === "owner_pending") store.markSent(ids, "owner_pending");
  const beforeDecision = readFileSync(store.path, "utf8");
  const card = f.service.get("task-19")!.waiting!;
  await f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version,
    actor: "owner", selected_options: { [question]: answer } });
  const resolved = f.gate.get(card.waiting_id)!;
  const sends = !answer.startsWith("暂不");
  for (const [index, id] of ids.entries()) {
    assert.equal(String(resolved.notes ?? "").includes(`待处理意见${index}`), sends);
    assert.equal(store.list().find((item: any) => item.id === id).status, sends || prior === "owner_pending" ? "sent" : "draft");
    if (!sends) assert.equal(store.list().find((item: any) => item.id === id).sent_via, prior === "owner_pending" ? prior : undefined);
  }
  assert.doesNotMatch(resolved.notes ?? "", /责任人已答复内容/);
  if (sends) {
    const sentIds = resolved.continuation?.annotation_ids;
    assert.ok(Array.isArray(sentIds));
    assert.deepEqual(new Set(sentIds), new Set(ids));
    // 决定已落盘、批注尚未投影时进程中断：从真实旧队列重放送达，不能
    // 仅验证“新草稿已经成功发送后再重启”的正常路径。
    writeFileSync(store.path, beforeDecision);
    const recovered = new TaskService({ dataDir: f.api.options.dataDir, provider: "unused", model: "unused", modelsJson: {}, maxConcurrent: 0 });
    recovered.recover();
    const projection = await recovered.listAnnotationsAsync("task-19", { username: "owner", can_override: false, can_route_others: true });
    for (const id of ids) assert.equal(projection.closures.find(item => item.id === id)?.text, "等待 Agent 答复");
  }
});

test("旧卡仍可查看 diff，但暂不确认不消费旧清单、不推送、不改提交", async () => {
  const f = fixture();
  const card = f.service.get("task-19")!.waiting!;
  assert.equal(card.recommended_view, "diff");
  assert.equal(isPushConfirmation(card), false);
  let pushes = 0; f.api.tryDeliver = async () => { pushes++; };
  await f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version, actor: "owner", selected_options: { [raw.questions[0].question]: REVIEW_HOLD }, delivery_paths: [] });
  assert.equal(pushes, 0);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  assert.deepEqual(f.task.summary.delivery_selection, f.selection);
  assert.equal(f.task.summary.delivery.sha, f.head);
  assert.equal(f.task.pendingResume.decision, REVIEW_HOLD);
  assert.equal(f.gate.get(card.waiting_id)!.decision, REVIEW_HOLD);
  assert.equal((f.gate.get(card.waiting_id)!.question as typeof raw).questions[0].options.includes(REVIEW_HOLD), true);
});

for (const mr of [false, true]) test(`意见排队与决定送达完整链路（已有 MR=${mr}），责任人附言不丢`, async () => {
  const f = fixture(mr, { purpose: "clarification", questions: [{ question: raw.questions[0].question, options: [effects[0].answers[0], REVIEW_ADJUST] }] });
  const first = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "diff", file: "a.ts", line: 1, anchor: "export const value = 1;", kind: "code", note: "补边界测试" });
  const second = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "diff", file: "a.ts", line: 1, anchor: "export const value = 1;", kind: "code", note: "补异常处理" });
  const sent = await f.service.sendAnnotations("task-19", [first.id], "owner", true, false, "保留接口兼容性");
  assert.match(sent.receipt!, /已排队，尚未送达/);
  const projection = await f.service.listAnnotationsAsync("task-19", { username: "owner", can_override: false, can_route_others: true });
  assert.equal(projection.closures.find(item => item.id === first.id)?.text, "已排队，等当前决定");
  assert.equal(projection.closures.find(item => item.id === first.id)?.receipt_missing, false);
  const card = f.service.get("task-19")!.waiting!;
  await assert.rejects(f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version, actor: "owner", selected_options: { [raw.questions[0].question]: effects[0].answers[0] } }), /未闭环/);
  await f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version, actor: "owner", selected_options: { [raw.questions[0].question]: REVIEW_ADJUST } });
  const resolved = f.gate.get(card.waiting_id)!;
  assert.match(resolved.notes, /补边界测试/); assert.match(resolved.notes, /保留接口兼容性/);
  assert.match(resolved.notes, /补异常处理/, "责任人选择按意见修复会统一提交另一条待处理意见");
  assert.equal(f.api.annotations(f.task).list().find((item: any) => item.id === first.id).sent_via, "decision");
  assert.equal(f.api.annotations(f.task).list().find((item: any) => item.id === second.id).sent_via, "decision");
  assert.equal(f.task.pendingResume.decision, REVIEW_ADJUST);
  const recovered = new TaskService({ dataDir: f.api.options.dataDir, provider: "unused", model: "unused", modelsJson: {}, maxConcurrent: 0 });
  recovered.recover();
  assert.match((recovered as any).tasks.get("task-19").pendingResume.notes, /保留接口兼容性/);
});

test("澄清期间补充两条意见，答复时携带各自附言且不重复", async () => {
  const f = fixture(true, { purpose: "clarification", questions: [{ question: raw.questions[0].question, options: [effects[0].answers[0], REVIEW_ADJUST] }] });
  const ids: string[] = [];
  for (const [note, context] of [["第一条边界测试", "保留接口"], ["第二条异常处理", "覆盖失败分支"]]) {
    const item = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "diff", file: "a.ts", line: 1, anchor: "export const value = 1;", kind: "code", note });
    ids.push(item.id);
    await f.service.sendAnnotations("task-19", [item.id], "owner", true, false, context);
    assert.equal(f.service.get("task-19")!.status, "waiting_for_human");
  }
  const card = f.service.get("task-19")!.waiting!;
  await f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version, actor: "owner", selected_options: { [raw.questions[0].question]: REVIEW_ADJUST } });
  const notes = f.gate.get(card.waiting_id)!.notes!;
  for (const phrase of ["第一条边界测试", "第二条异常处理", "保留接口", "覆盖失败分支"]) {
    assert.equal(notes.split(phrase).length - 1, 1);
  }
  assert.equal(f.api.annotations(f.task).list().filter((item: any) => ids.includes(item.id) && item.sent_via === "decision").length, 2);
});


test("Spec 仍需调整会把未提前提交的意见送给 Agent，并在恢复后保持联动状态", async () => {
  const f = fixture(false, specRaw, "open");
  const item = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec", file: ".mae-flow-work/T/spec.md", line: 3, anchor: "验收条件", kind: "doc", route: "owner_reply", note: "补充空输入用例" });
  const answered = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec", file: ".mae-flow-work/T/spec.md", line: 4, anchor: "既有约定", kind: "doc", route: "owner_reply", note: "确认是否保持旧接口" });
  await f.service.replyToAnnotation("task-19", answered.id, "owner", "旧接口仍需兼容，无需修改代码");
  f.service.verifyAnnotation("task-19", answered.id, "owner");
  const obsolete = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec", file: ".mae-flow-work/T/spec.md", line: 5, anchor: "旧内容", kind: "doc", route: "owner_reply", note: "这条意见已经无效" });
  f.service.dropAnnotation("task-19", obsolete.id, "owner");
  const card = f.service.get("task-19")!.waiting!;
  await f.service.decide("task-19", { waiting_id: card.waiting_id, state_version: card.state_version, actor: "owner", selected_options: { [specQuestion]: specAdjust } });
  const decisionNotes = f.gate.get(card.waiting_id)!.notes!;
  assert.match(decisionNotes, /补充空输入用例/);
  assert.doesNotMatch(decisionNotes, /确认是否保持旧接口|这条意见已经无效/,
    "已自行答复闭环或删除的意见不能再夹带给 Agent");
  const sent = f.api.annotations(f.task).list().find((entry: any) => entry.id === item.id);
  assert.equal(sent.sent_via, "decision");
  assert.equal(sent.route, "agent");
  assert.equal(sent.agent_assigned, true);
  const projection = await f.service.listAnnotationsAsync("task-19", { username: "owner", can_override: false, can_route_others: true });
  assert.equal(projection.closures.find(entry => entry.id === item.id)?.text, "等待 Agent 答复");

  const recovered = new TaskService({ dataDir: f.api.options.dataDir, provider: "unused", model: "unused", modelsJson: {}, maxConcurrent: 0, host: { kernelRoot, python: "python3", continuousReview: false } });
  recovered.recover();
  const afterRestart = await recovered.listAnnotationsAsync("task-19", { username: "owner", can_override: false, can_route_others: true });
  assert.equal(afterRestart.closures.find(entry => entry.id === item.id)?.text, "等待 Agent 答复");
});

test("真实会话举卡与回注：模型自由文案变成流程选项，用户所选原文交回模型和内核钩子", async () => {
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { EventLog } = await import("../src/semanticEvents.ts");
  const { TranscriptStore } = await import("../src/transcriptStore.ts");
  const { GateService } = await import("../src/gateService.ts");
  const model = new ScriptedModelServer([{ tool: { name: "AskUserQuestion", input: raw } }, { text: "已收到，继续处理。" }]);
  await model.start();
  const dir = mkdtempSync(join(tmpdir(), "mfc-review-card-session-")), agentDir = join(dir, "agent");
  mkdirSync(agentDir); writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const hookAnswers: unknown[] = [];
  const session = await CloudSession.create({ taskId: "T-review", workspace: dir, agentDir,
    provider: "maeflow", model: "scripted-v1", humanGate: gate,
    gate: new GateService(), eventLog: new EventLog(join(dir, "events.jsonl")),
    transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"),
    currentStep: () => "最终代码增量检视",
    prepareHumanQuestion: question => reviewDecisionContract(question, effects).question,
    hostHooks: { postTool: async event => { if ((event.payload as any)?.answers) hookAnswers.push((event.payload as any).answers); } },
  });
  try {
    const outcome = await session.start("开始检视");
    assert.equal(outcome.status, "waiting_for_human");
    const waiting = outcome.waiting!;
    assert.deepEqual((waiting.question as typeof raw).questions[0].options, [effects[0].answers[0], REVIEW_ADJUST, REVIEW_HOLD]);
    const resolved = gate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version, decision: effects[0].answers[0], answers: { [raw.questions[0].question]: effects[0].answers[0] }, notes: "按当前确认范围执行" });
    await session.resumeWithDecision(resolved);
    assert.equal(hookAnswers.some(value => JSON.stringify(value).includes(effects[0].answers[0])), true);
    assert.match(JSON.stringify(model.requests), /按当前确认范围执行/);
  } finally { session.dispose(); await model.stop(); }
});

for (const paused of [false, true]) test(`统一提交修改意见消费当前 Spec 检视卡${paused ? "（暂停后恢复）" : ""}`, async t => {
  const f = fixture(false, specRaw, "open");
  t.after(() => f.service.shutdown());
  const note = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec",
    file: "spec.md", line: 1, anchor: "行为", note: "补充失败分支", kind: "doc" });
  const card = f.service.get("task-19")!.waiting!;
  if (paused) {
    f.task.summary.status = "paused";
    f.task.summary.control = { paused_from: "waiting_for_human" };
    f.task.summary.delivery = { prepush: beginPrePushAttempt(createPrePushVerification(
      { sha: f.head, workspace_fingerprint: "clean" }, new Date().toISOString()), new Date().toISOString(), "paused-attempt") };
  }
  const before = await f.service.listAnnotationsAsync("task-19");
  assert.equal(before.submission.ordinary.enabled, true);
  assert.match(before.submission.ordinary.hint, paused ? /恢复任务后/ : /无需再点/);
  const submission = await f.service.sendAnnotations("task-19", [note.id], "owner");
  assert.match(submission.receipt!, paused ? /恢复任务后/ : /已接收/);
  if (paused) {
    assert.equal(f.task.summary.status, "paused", "提交意见不得擅自恢复任务");
    assert.equal(f.api.annotations(f.task).list()[0].sent_via, "queued_decision");
    f.service.resume("task-19", "owner");
    for (let i = 0; i < 100 && f.gate.get(card.waiting_id)?.status !== "resolved"; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const resolved = f.gate.get(card.waiting_id)!;
  if (paused) {
    assert.equal(f.task.summary.delivery.prepush.active_attempt, undefined);
    assert.equal(f.task.summary.delivery.prepush.state, "environment_error", "旧验证中断必须如实记录，不能再次恢复抢占新意见");
  }
  assert.equal(resolved.status, "resolved");
  assert.match(resolved.decision ?? "", /Spec.*调整/);
  assert.match(resolved.notes ?? "", /补充失败分支/);
  assert.equal(f.api.annotations(f.task).list()[0].status, "sent");
});

test("统一提交不回答 Agent 的澄清问题，只排队附带意见", async t => {
  const f = fixture(false, { purpose: "clarification", questions: [{ question: "失败时重试几次？",
    options: ["一次", "三次"] }] }, "open");
  t.after(() => f.service.shutdown());
  const note = f.service.addAnnotation("task-19", { author: "owner", artifact: "spec",
    file: "spec.md", line: 1, anchor: "失败", note: "增加日志", kind: "doc" });
  const card = f.service.get("task-19")!.waiting!;
  const before = await f.service.listAnnotationsAsync("task-19");
  assert.match(before.submission.ordinary.hint, /先回答当前问题/);
  const submission = await f.service.sendAnnotations("task-19", [note.id], "owner");
  assert.match(submission.receipt!, /尚未送达/);
  assert.equal(f.gate.get(card.waiting_id)!.status, "waiting");
  assert.equal(f.api.annotations(f.task).list()[0].sent_via, "queued_decision");
});


test("单独提交一份材料的意见不夹带其他未提交草稿，且只消费一次检视卡", async t => {
  const f = fixture(false, specRaw, "open");
  t.after(() => f.service.shutdown());
  const add = (note: string) => f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec",
    file: "spec.md", line: 1, anchor: "行为", note, kind: "doc" });
  const selected = add("本次要求补充异常场景"), later = add("下一批才讨论性能要求");
  const card = f.service.get("task-19")!.waiting!;
  const result = await f.service.sendAnnotations("task-19", [selected.id], "owner");
  assert.deepEqual(result.sent, [selected.id]);
  assert.match(result.receipt!, /已接收 1 条/);
  assert.match(f.gate.get(card.waiting_id)!.notes!, /本次要求补充异常场景/);
  assert.doesNotMatch(f.gate.get(card.waiting_id)!.notes!, /下一批才讨论性能要求/);
  assert.equal(f.service.listAnnotations("task-19").items.find(item => item.id === later.id)?.status, "draft");
  await assert.rejects(f.service.sendAnnotations("task-19", [selected.id], "owner"), /已经送出/);
});

test("HTTP 提交入口：服务端说明与实际返工一致，检视人不能替责任人提交", async t => {
  const { createTaskServer } = await import("../src/server.ts");
  const { LocalAuth } = await import("../src/auth.ts");
  const f = fixture(false, specRaw, "open");
  const auth = new LocalAuth(join(f.api.options.dataDir, "auth.json"));
  auth.bootstrapAdmin("owner", "owner-password");
  auth.createUser("reviewer", "reviewer-password", "developer");
  const server = createTaskServer(f.service, { auth });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await f.service.shutdown(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const login = async (username: string) => (await fetch(`${base}/auth/login`, {
    method: "POST", body: JSON.stringify({ username, password: `${username}-password` }),
  })).headers.get("set-cookie")!.split(";")[0];
  const owner = await login("owner"), reviewer = await login("reviewer");
  const note = f.service.addAnnotation("task-19", { author: "reviewer", artifact: "spec",
    file: "spec.md", line: 1, anchor: "行为", note: "补充业务失败时的反馈", kind: "doc" });
  const url = `${base}/tasks/task-19/annotations`;
  const before = await (await fetch(url, { headers: { cookie: owner } })).json() as { submission: { ordinary: { enabled: boolean; hint: string } } };
  assert.equal(before.submission.ordinary.enabled, true);
  assert.match(before.submission.ordinary.hint, /无需再点/);
  const send = (cookie: string) => fetch(`${url}/send`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ ids: [note.id] }) });
  assert.equal((await send(reviewer)).status, 403);
  assert.equal(f.service.listAnnotations("task-19").items[0].status, "draft");
  const response = await send(owner);
  const result = await response.json() as { sent: string[]; receipt: string };
  assert.equal(response.status, 200);
  assert.deepEqual(result.sent, [note.id]);
  assert.match(result.receipt, /已接收 1 条/);
  assert.equal(f.task.summary.status, "queued", "直接继续修改，不再等责任人重复答卡");
  assert.match(f.task.pendingResume.notes, /补充业务失败时的反馈/);
});
