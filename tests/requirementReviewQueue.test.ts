import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { submitRequirementReview, interruptRequirementReviews } from "../src/requirementReviewQueue.ts";
import { abortAuxiliarySessions } from "../src/auxiliarySessions.ts";

test("后台接收立即返回；两批分别执行失败才各自恢复为待提交", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-accept-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "guest", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let observed!: (error: unknown) => void;
  const failed = new Promise<unknown>((resolve) => { observed = resolve; });
  let calls = 0;
  const run = async () => { calls++; await held; throw new Error("模型网关超时"); };
  try {
    await submitRequirementReview(task, store, [a], run, observed, "owner");
    assert.equal(store.list()[0].sent_via, "requirement_review");
    assert.equal(store.list()[0].sent_by, "owner", "责任人代转应保留实际提交者");
    assert.equal(store.list()[0].author, "guest");
    await submitRequirementReview(task, store, [b], run, observed);
    assert.equal(store.list()[1].sent_via, "requirement_queue");
    assert.equal(calls, 1);
    release();
    assert.match(String(await failed), /模型网关超时/);
    assert.equal(calls, 2, "不能用第一批失败替尚未执行的第二批报失败");
    assert.deepEqual(store.list().map((item) => item.status), ["draft", "draft"]);
    assert.ok(store.list().every((item) => !item.returned), "系统失败不能增加作者退回次数");
    assert.ok(store.history().filter((item) => item.op === "delivery_reset").length === 2);
    assert.ok(!store.history().some((item) => item.op === "reopen"));
    await submitRequirementReview(task, store, store.drafts(), async (batch) => {
      store.markSent(batch.map((item) => item.id), "interrupt");
    });
    assert.ok(store.list().every((item) => item.sent_via === "interrupt"));
  } finally { release(); }
});

test("本批失败只恢复本批，排队意见继续串行执行且保留提交者", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner",
    artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
    anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const run = async (batch: typeof a[]) => {
    calls++;
    if (calls === 1) { await held; throw new Error("本轮模型失败"); }
    assert.equal(store.list()[0].status, "draft");
    assert.equal(store.list()[1].sent_via, "requirement_review");
    assert.equal(store.list()[1].sent_by, "owner");
    store.markSent(batch.map((item) => item.id), "interrupt");
  };
  const first = submitRequirementReview(task, store, [a], run);
  const failed = assert.rejects(first, /本轮模型失败/);
  await submitRequirementReview(task, store, [b], run, undefined, "owner");
  assert.equal(calls, 1);
  assert.equal(new AnnotationStore(store.path).list()[1].sent_via, "requirement_queue",
    "入队事实应已落盘，不能只存在内存里");
  release();
  await failed;
  assert.equal(calls, 2);
  assert.deepEqual(store.list().map((item) => item.status), ["draft", "sent"]);
  assert.deepEqual(store.history().filter((item) => item.op === "delivery_reset")
    .map((item) => item.id), [a.id]);
  assert.equal(store.list()[1].note, "第二批");
  await submitRequirementReview(task, store, store.drafts(), async (batch) => {
    store.markSent(batch.map((item) => item.id), "interrupt");
  });
  assert.ok(store.list().every((item) => item.sent_via === "interrupt"), "失败后锁已释放，可重提");
});

test("排队和执行都不设整轮计时，超过两小时仍可按序完成", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-idle-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("排队批次");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  const finish: Array<() => void> = [];
  let secondStarted!: () => void;
  const second = new Promise<void>((resolve) => { secondStarted = resolve; });
  const run = async (batch: typeof a[]) => {
    await new Promise<void>((resolve) => {
      finish.push(resolve);
      if (finish.length === 2) secondStarted();
    });
    store.markSent(batch.map((item) => item.id), "interrupt");
  };
  const processing = submitRequirementReview(task, store, [a], run);
  await submitRequirementReview(task, store, [b], run);
  for (let i = 0; i < 12; i++) {
    t.mock.timers.tick(10 * 60_000);
    assert.equal(store.list()[1].sent_via, "requirement_queue");
    assert.equal(finish.length, 1, "排队批次不能提前执行");
  }
  finish[0]();
  await second;
  t.mock.timers.tick(120 * 60_000);
  assert.equal(store.list()[1].sent_via, "requirement_review");
  finish[1]();
  await processing;
  assert.ok(store.list().every((item) => item.sent_via === "interrupt"));
  assert.equal(store.history().filter((item) => item.op === "delivery_reset").length, 0);
});

test("排队后撤回的意见不会被下一轮自动执行", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-drop-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner",
    artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
    anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human",
    waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const batches: string[][] = [];
  const run = async (batch: typeof a[]) => {
    batches.push(batch.map((item) => item.id));
    await held;
    store.markSent(batch.map((item) => item.id), "interrupt");
  };
  const first = submitRequirementReview(task, store, [a], run);
  await submitRequirementReview(task, store, [b], run);
  store.drop(b.id, "owner");
  release();
  await first;
  assert.deepEqual(batches, [[a.id]]);
  assert.equal(store.list()[1].status, "dropped");
});

test("关停后旧队列不改账、不消费下一批，也不回调后台失败通知", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-stop-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human", waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0, errors = 0;
  const run = async () => { calls++; await held; throw new Error("旧进程返回"); };
  await submitRequirementReview(task, store, [a], run, () => { errors++; });
  await submitRequirementReview(task, store, [b], run);
  await abortAuxiliarySessions(task);
  const before = JSON.stringify(store.history());
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(store.history()), before);
  assert.equal(calls, 1);
  assert.equal(errors, 0);
});

test("暂停恢复后，旧队列收尾不能解开新队列的串行锁或重置新意见", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-resume-")), "annotations.jsonl"));
  const add = (note: string) => store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note, kind: "doc" });
  const a = add("第一批"), b = add("第二批");
  const task = { summary: { status: "waiting_for_human", waiting: { step: "cloud_requirement_analysis_confirm" },
    requirement_revision: { state: "running" } } };
  let releaseOld!: () => void, releaseNew!: () => void;
  const oldHeld = new Promise<void>((resolve) => { releaseOld = resolve; });
  const newHeld = new Promise<void>((resolve) => { releaseNew = resolve; });
  const old = submitRequirementReview(task, store, [a], async () => { await oldHeld; throw new Error("旧轮中断"); });
  await abortAuxiliarySessions(task);
  interruptRequirementReviews(task, store);
  assert.equal(task.summary.requirement_revision.state, "failed");
  let calls = 0;
  const run = async (batch: typeof a[]) => {
    calls++; await newHeld; store.markSent(batch.map((item) => item.id), "interrupt");
  };
  const current = submitRequirementReview(task, store, store.drafts().filter((item) => item.id === a.id), run);
  releaseOld(); await old;
  await submitRequirementReview(task, store, [b], run);
  assert.equal(calls, 1, "新第二批应排队，不能与新第一批并行");
  releaseNew(); await current;
  assert.equal(calls, 2);
  assert.ok(store.list().every((item) => item.sent_via === "interrupt"));
});

test("同一条意见退回重提时按版本入队，旧轮失败不能吞掉新轮", async () => {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "mfc-rq-revision-")), "annotations.jsonl"));
  const note = store.add({ author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "原文", note: "第一版", kind: "doc" });
  const task = { summary: { status: "waiting_for_human", waiting: { step: "cloud_requirement_analysis_confirm" } } };
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const revisions: number[] = [];
  const run = async (batch: typeof note[]) => {
    revisions.push(batch[0].rework ?? 0);
    if (revisions.length === 1) { await hold; throw new Error("旧轮失败"); }
  };
  const first = submitRequirementReview(task, store, [note], run);
  const finished = assert.rejects(first, /旧轮失败/);
  try {
    store.reopen(note.id, "owner");
    await submitRequirementReview(task, store, store.drafts(), run);
    assert.equal(store.list()[0].sent_via, "requirement_queue", "新版本必须真正落盘排队，不能按相同 id 忽略");
  } finally { release(); await finished; }
  assert.deepEqual(revisions, [0, 1]);
  assert.equal(store.list()[0].rework, 1);
  assert.equal(store.list()[0].sent_via, "requirement_review");
});
