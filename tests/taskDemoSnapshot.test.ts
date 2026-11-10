import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT, type Annotation } from "../src/annotations.ts";
import { LocalAuth } from "../src/auth.ts";
import { HumanGate } from "../src/humanGate.ts";
import { PIPELINE_EVIDENCE_GAP_FILE } from "../src/artifacts.ts";
import { createTaskServer } from "../src/server.ts";
import { readTaskDemoSnapshot, type TaskDemoSnapshot } from "../src/taskDemoSnapshot.ts";
import { archiveContinuationRuntime, snapshotContinuation } from "../src/taskContinuation.ts";
import { TaskService } from "../src/taskService.ts";
import type { MemoryRecord } from "../src/taskMemory.ts";

function contents(root: string): Record<string, string> {
  return Object.fromEntries(readdirSync(root, { recursive: true }).map(String)
    .filter(path => statSync(join(root, path)).isFile())
    .sort().map(path => [path, readFileSync(join(root, path)).toString("base64")]));
}

test("演示批注快照复用当前状态计算，坏尾和缺少换行都不改原文件", t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-annotations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "annotations.jsonl");
  const store = new AnnotationStore(path, true);
  const note = store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note: "原意见", kind: "doc" });
  const original = readFileSync(path, "utf-8");
  const edit = JSON.stringify({ op: "edit", id: note.id, note: "修改后的意见", at: "2026-10-22T01:00:00Z" });
  for (const suffix of [edit, edit + '\n{"op":']) {
    writeFileSync(path, original + suffix);
    const before = readFileSync(path);
    const snapshot = store.snapshot();
    assert.equal(snapshot.items[0].note, "修改后的意见");
    assert.equal((snapshot.history[0] as { record: Annotation }).record.note, "原意见");
    assert.equal(snapshot.skipped, suffix.endsWith(':') ? 1 : 0);
    assert.deepEqual(readFileSync(path), before);
  }
});

test("演示来源快照保留真实材料和会话，读取不修复、不推进或修改源任务", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-snapshot-"));
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const task = service.create("展示需求澄清", { account: "owner", requirementAnalysisConfirmation: true });
  const note = service.addAnnotation(task.id, { author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "展示需求澄清", note: "补充验收条件", kind: "doc" });
  const annotationPath = join(task.workspace, "annotations.jsonl");
  writeFileSync(annotationPath, readFileSync(annotationPath, "utf-8") + '{"op":');
  const review = { id: "review-demo-source", task_id: task.id, task_title: "来源需求",
    requester: "owner", committer: "reviewer", status: "pending", created_at: "2026-10-22T01:00:00Z",
    delivered: true, attempts: 1 };
  writeFileSync(join(root, "reviews.jsonl"), JSON.stringify(review) + '\n{"id":');
  const event = { eventId: 1, taskId: task.id, sessionId: "main", ts: "2026-10-22T01:00:00Z",
    kind: "assistant_message", payload: { text: "已核对现有实现，请确认兼容范围。" } };
  writeFileSync(service.eventLogPath(task.id), JSON.stringify(event) + '\n{"eventId":');
  const gate = new HumanGate(join(task.workspace, "waiting.json"));
  const historicalCard = gate.createWaiting({ taskId: task.id, step: "本地 Spec 确认",
    callId: "historical-spec-confirmation",
    questionInput: { questions: [{ question: "是否确认兼容旧接口？", options: ["确认", "补充要求"] }] },
    context: "已核对旧接口，原有调用方式保持兼容。\n请确认验收条件。",
    preface: "| 场景 | 预期 |\n| --- | --- |\n| 旧接口 | 保持兼容 |",
  });
  gate.resolve(historicalCard.waiting_id, { stateVersion: historicalCard.state_version,
    decision: "确认", notes: "保留旧接口" });
  mkdirSync(join(task.workspace, "pipeline"), { recursive: true });
  writeFileSync(join(task.workspace, "pipeline", PIPELINE_EVIDENCE_GAP_FILE), "# 待补验证\n实际文档正文");
  const memory: MemoryRecord = { id: "c-demo-candidate", task: task.id, file: "candidate.md",
    at: "2026-10-22T01:00:00Z", source: "user_note", judged_by: "human", scope: "local",
    repo: "demo", paths: [], evidence: `annotation:${note.id}`, author: "owner",
    trigger: "验收条件", conclusion: "确认兼容范围", revision: 1, review: { status: "pending" } };
  const reused: MemoryRecord = { ...memory, id: "c-demo-reused", task: "prior-task", file: "reused.md" };
  const traversal: MemoryRecord = { ...memory, id: "c-demo-invalid-path", file: "../reviews.jsonl" };
  mkdirSync(join(root, "corpus", "_archive"), { recursive: true });
  writeFileSync(join(root, "corpus", "index.jsonl"), [memory, { ...memory, revision: 2 }, reused, traversal]
    .map(record => JSON.stringify(record)).join("\n") + '\n{"id":');
  writeFileSync(join(root, "corpus", "candidate.md"), "# 待采纳经验\n确认兼容范围");
  writeFileSync(join(root, "corpus", "_archive", "reused.md"), "# 已有经验\n真实正文");
  writeFileSync(join(root, "corpus", "ledger.jsonl"), JSON.stringify({
    at: memory.at, kind: "archive", id: reused.id, note: "测试归档",
  }) + '\n{"kind":');
  const usage = { ts: memory.at, moment: "launch", ids: [reused.id] };
  writeFileSync(join(task.workspace, "memory-usage.jsonl"), JSON.stringify(usage) + '\n{"ts":');
  const before = contents(root);
  const beforeSummary = structuredClone(service.storedTaskSummary(task.id));
  t.mock.method(service, "getAsync", async () => { throw new Error("不得调用可能刷新源任务的详情投影"); });
  t.mock.method(service, "listAnnotationsAsync", async () => { throw new Error("不得调用自动对账的批注读取"); });
  t.mock.method(service, "conversationAsync", async () => { throw new Error("不得调用会修复日志的会话读取"); });
  t.mock.method(service, "listTaskReviews", () => { throw new Error("不得调用可能取消邀请的读取"); });

  const snapshot = await readTaskDemoSnapshot(service, task.id);
  assert.equal(snapshot.schema, "mae-flow-demo-snapshot/1");
  assert.equal(snapshot.source_task_id, task.id);
  assert.equal(snapshot.task.luban_account, "owner");
  assert.equal(snapshot.task.progress?.phases.length, 7);
  assert.equal(snapshot.task.progress?.current_index, -1, "没有来源阶段时不虚构当前阶段");
  assert.equal(snapshot.annotations.items[0].id, note.id);
  assert.equal(snapshot.reviews[0].id, review.id);
  assert.deepEqual(snapshot.memoryUsage, [usage]);
  assert.equal(snapshot.memories.find(item => item.record.id === memory.id)?.record.revision, 2);
  assert.equal(snapshot.memories.find(item => item.record.id === memory.id)?.content, "# 待采纳经验\n确认兼容范围");
  assert.equal(snapshot.memories.find(item => item.record.id === reused.id)?.record.archived, true);
  assert.equal(snapshot.memories.find(item => item.record.id === reused.id)?.content, "# 已有经验\n真实正文");
  assert.equal(snapshot.memories.find(item => item.record.id === traversal.id)?.content, "", "不能通过经验索引读取目录之外的文件");
  assert.ok(snapshot.artifacts.some(item => item.name.endsWith(PIPELINE_EVIDENCE_GAP_FILE)));
  assert.ok(snapshot.artifacts.every(item => !("content" in item)), "正文留给按需读取");
  assert.ok(snapshot.conversation.items.some(item => item.kind === "turn"
    && item.texts.some(text => text.text === event.payload.text)));
  const sourceCard = snapshot.conversation.items.find(item => item.kind === "card"
    && item.waiting_id === historicalCard.waiting_id);
  assert.ok(sourceCard?.kind === "card");
  assert.equal(sourceCard.step, "本地 Spec 确认");
  assert.equal(sourceCard.status, "resolved");
  assert.deepEqual(sourceCard.questions, historicalCard.question.questions);
  assert.deepEqual(snapshot.card_contexts?.[historicalCard.waiting_id], {
    context: historicalCard.context, preface: historicalCard.preface,
  });
  assert.ok(snapshot.problems.some(problem => problem.includes("批注中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("检视邀请中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("经验候选中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("经验归档记录中有 1 行")));
  assert.ok(snapshot.problems.some(problem => problem.includes("知识使用记录中有 1 行")));
  assert.deepEqual(contents(root), before, "快照前后来源全部文件字节一致");
  snapshot.task.requirement = "只改副本";
  snapshot.annotations.items[0].note = "只改副本意见";
  assert.deepEqual(service.storedTaskSummary(task.id), beforeSummary, "快照与来源内存断开引用");

  const withPhases = await readTaskDemoSnapshot({
    options: { ...service.options, host: { kernelRoot: resolve("kernel") } as NonNullable<TaskService["options"]["host"]> },
    storedTaskSummary: id => service.storedTaskSummary(id),
    artifactRoot: id => service.artifactRoot(id),
    panelFile: (id, name) => service.panelFile(id, name),
    readDisplayEvents: id => service.readDisplayEvents(id),
  }, task.id);
  const vocabulary = JSON.parse(readFileSync(resolve("kernel/flow/phases.json"), "utf-8"));
  assert.deepEqual(withPhases.phase_steps,
    Object.fromEntries(vocabulary.phases.map((phase: { name: string; steps: string[] }) => [phase.name, phase.steps])));

  const flow = JSON.parse(readFileSync(resolve("kernel/flow/flow.json"), "utf-8"));
  assert.deepEqual(withPhases.step_titles, Object.fromEntries(Object.entries(flow.steps)
    .map(([id, step]) => [id, (step as { title: string }).title])));
  assert.equal(withPhases.step_titles?.open, historicalCard.step);
  assert.deepEqual(withPhases.card_contexts?.[historicalCard.waiting_id], {
    context: historicalCard.context, preface: historicalCard.preface,
  });
  withPhases.card_contexts![historicalCard.waiting_id].context = "副本修改";
  assert.deepEqual(contents(root), before, "历史卡正文读取和副本修改均不影响来源文件");

  const pulsePath = join(task.workspace, "demo-source-panel-pulse.js");
  const sourcePhase = vocabulary.phases[3];
  for (const phase of [sourcePhase.name, "旧版本阶段"]) {
    writeFileSync(pulsePath, `window.MAE_FLOW_PULSE = ${JSON.stringify({
      phase, step: sourcePhase.steps[0], step_title: "正在设计", revision: 11,
    })};`);
    const sourceBefore = contents(root);
    const fromPulse = await readTaskDemoSnapshot({
      options: service.options,
      storedTaskSummary: id => service.storedTaskSummary(id),
      artifactRoot: id => service.artifactRoot(id),
      panelFile: () => pulsePath,
      readDisplayEvents: id => service.readDisplayEvents(id),
    }, task.id);
    assert.deepEqual(fromPulse.task.progress?.phases, vocabulary.phases.map((entry: { name: string }) => entry.name));
    assert.equal(fromPulse.task.progress?.current_index, phase === sourcePhase.name ? 3 : -1);
    assert.equal(fromPulse.task.progress?.step_id, sourcePhase.steps[0]);
    assert.deepEqual(contents(root), sourceBefore, "旧阶段也不能触发脉冲重写");
  }
});

test("继续修改后的演示恢复归档真实卡和上下文，当前记录优先且不读取越界历史", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-archived-cards-"));
  const service = new TaskService({ dataDir: join(root, "tasks"), provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  t.after(async () => { await service.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const task = service.create("演示已完成任务的原设计", { account: "owner", requirementAnalysisConfirmation: true });
  const gate = new HumanGate(join(task.workspace, "waiting.json"));
  const design = gate.createWaiting({ taskId: task.id, step: "Story 与实施附录生成及一次设计检视",
    callId: "original-design", questionInput: { questions: [{ question: "是否确认原设计？", options: ["确认"] }] },
    context: "原设计确认背景", preface: "原 Agent 的设计检视回复" });
  gate.resolve(design.waiting_id, { stateVersion: 1, decision: "确认", notes: "采用原设计" });
  const duplicate = gate.createWaiting({ taskId: task.id, step: "本地 Spec 确认", callId: "shared-card",
    questionInput: { questions: [{ question: "归档版本", options: ["确认"] }] }, context: "归档上下文" });
  snapshotContinuation(task, undefined, "continued-123");
  archiveContinuationRuntime(task.workspace, "continued-123", join(task.workspace, "host-operations.json"));
  const current = new HumanGate(join(task.workspace, "waiting.json"));
  current.createWaiting({ taskId: task.id, step: "本地 Spec 确认", callId: "shared-card",
    questionInput: { questions: [{ question: "当前版本", options: ["确认"] }] }, context: "当前上下文" });
  const foreign = new HumanGate(join(task.workspace, "delivery-history", "continued-123", "waiting.json"));
  foreign.createWaiting({ taskId: "another-task", step: design.step, callId: "unrelated",
    questionInput: { questions: [{ question: "其他任务", options: ["确认"] }] } });
  const outside = join(root, "outside");
  const outsideGate = new HumanGate(join(outside, "waiting.json"));
  const secret = outsideGate.createWaiting({ taskId: task.id, step: design.step, callId: "outside",
    questionInput: { questions: [{ question: "目录外记录", options: ["确认"] }] } });
  symlinkSync(outside, join(task.workspace, "delivery-history", "linked-archive"));
  const summary = { ...structuredClone(service.storedTaskSummary(task.id)!),
    delivery_history: ["continued-123", "../outside", "linked-archive"].map(archive => ({
      id: archive, archive, started_at: task.created_at, completed_at: task.created_at, delivery: undefined,
    })),
  };
  const event = { eventId: 1, taskId: task.id, sessionId: "main", ts: task.created_at,
    kind: "assistant_message", payload: { text: design.preface } };
  writeFileSync(service.eventLogPath(task.id), JSON.stringify(event) + "\n");
  const before = contents(root);
  const snapshot = await readTaskDemoSnapshot({
    options: service.options, storedTaskSummary: () => summary,
    artifactRoot: id => service.artifactRoot(id), panelFile: (id, name) => service.panelFile(id, name),
    readDisplayEvents: id => service.readDisplayEvents(id),
  }, task.id);
  const cards = snapshot.conversation.items.filter(item => item.kind === "card");
  assert.equal(cards.find(item => item.waiting_id === design.waiting_id)?.questions[0]?.question, "是否确认原设计？");
  assert.deepEqual(snapshot.card_contexts?.[design.waiting_id], { context: design.context, preface: design.preface });
  assert.ok(snapshot.conversation.items.some(item => item.kind === "turn" && item.texts.some(text => text.text === design.preface)));
  assert.ok(snapshot.conversation.items.some(item => item.kind === "decision" && item.waiting_id === design.waiting_id && item.decision === "确认"));
  assert.equal(cards.filter(item => item.waiting_id === duplicate.waiting_id).length, 1);
  assert.equal(cards.find(item => item.waiting_id === duplicate.waiting_id)?.questions[0]?.question, "当前版本");
  assert.deepEqual(snapshot.card_contexts?.[duplicate.waiting_id], { context: "当前上下文" });
  assert.ok(!cards.some(item => item.waiting_id === secret.waiting_id || item.waiting_id.startsWith("another-task:")));
  assert.ok(snapshot.problems.some(problem => problem.includes("编号无效")));
  assert.ok(snapshot.problems.some(problem => problem.includes("历史确认记录暂时无法读取")));
  assert.deepEqual(contents(root), before, "归档、当前记录、原对话和目录外文件均不修改");
});

test("演示来源端点仅允许登录 admin，未启用认证也不提供入口", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-demo-auth-"));
  const service = new TaskService({ dataDir: join(root, "tasks"), provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("只读演示来源", { account: "developer", requirementAnalysisConfirmation: true });
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "demo-admin-fixture");
  auth.createUser("developer", "demo-developer-fixture", "developer");
  const adminCookie = `mae_flow_session=${auth.createSession({ username: "admin", role: "admin" })}`;
  const developerCookie = `mae_flow_session=${auth.createSession({ username: "developer", role: "developer" })}`;
  const servers = [createTaskServer(service, { auth }), createTaskServer(service)];
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await service.shutdown(); rmSync(root, { recursive: true, force: true });
  });
  const bases: string[] = [];
  for (const server of servers) {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    bases.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  }
  const path = `/tasks/${task.id}/demo-snapshot`;
  const missing = await fetch(bases[0] + path);
  assert.equal(missing.status, 401); await missing.text();
  const forbidden = await fetch(bases[0] + path, { headers: { cookie: developerCookie } });
  assert.equal(forbidden.status, 403); await forbidden.text();
  const unauthenticated = await fetch(bases[1] + path, { headers: { cookie: adminCookie } });
  assert.equal(unauthenticated.status, 401); await unauthenticated.text();
  const allowed = await fetch(bases[0] + path, { headers: { cookie: adminCookie } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await allowed.json() as TaskDemoSnapshot).source_task_id, task.id);
  const cardPath = `/tasks/${task.id}/demo-card`;
  for (const [base, cookie, expected] of [[bases[0], "", 401], [bases[0], developerCookie, 403], [bases[1], adminCookie, 401]] as const) {
    const rejected = await fetch(base + cardPath, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ phase: "启动" }) });
    assert.equal(rejected.status, expected); await rejected.text();
  }
  const wrongMethod = await fetch(bases[0] + cardPath, { headers: { cookie: adminCookie } });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "POST"); await wrongMethod.text();
  const invalidCard = await fetch(bases[0] + cardPath, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ phase: "不存在的阶段" }) });
  assert.equal(invalidCard.status, 400); await invalidCard.text();
  const beforeCard = contents(service.options.dataDir);
  t.mock.method(ModelRuntime, "create", async () => ({
    getModel: () => ({ id: "fixture", api: "openai-completions", maxTokens: 4096, contextWindow: 128_000 }),
    streamSimple: () => ({ async *[Symbol.asyncIterator]() {}, result: async () => ({
      role: "assistant", content: [{ type: "text", text: JSON.stringify({
        context: "当前仅有需求原文，设计方案和验证资料尚未提供。",
        questions: [{ question: "需要补充哪些设计材料？", options: ["补充方案"] }], source_ids: [`task:${task.id}`],
      }) }], stopReason: "stop", usage: {},
    }) }),
  }) as any);
  const generated = await fetch(bases[0] + cardPath, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify({ phase: "写设计" }) });
  assert.equal(generated.status, 200); assert.equal(generated.headers.get("cache-control"), "no-store");
  const generatedCard = await generated.json() as { source_task_id: string; phase: string; context: string };
  assert.equal(generatedCard.source_task_id, task.id); assert.equal(generatedCard.phase, "写设计");
  assert.match(generatedCard.context, /尚未提供/);
  assert.deepEqual(contents(service.options.dataDir), beforeCard, "管理员生成补卡也不改源任务");
  const post = await fetch(bases[0] + path, { method: "POST", headers: { cookie: adminCookie } });
  assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), "GET"); await post.text();
  const absent = await fetch(bases[0] + "/tasks/missing/demo-snapshot", { headers: { cookie: adminCookie } });
  assert.equal(absent.status, 404); await absent.text();
});
