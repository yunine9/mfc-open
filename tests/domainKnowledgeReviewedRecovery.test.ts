import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";
import { ScriptedModelServer, type Scene, type ScriptedModelOptions } from "../src/scriptedModel.ts";
import type { SkillDocumentPlan, SkillWorkStep } from "../src/domainSkillWork.ts";

const tool = (name: string, input: Record<string, unknown>, text?: string): Scene => ({ tool: { name, input }, ...(text ? { text } : {}) });
const step = { id: "cancel", title: "取消规则", instructions: "按输入中的业务条件保存取消规则", depends_on: [], readonly: false,
  expected_document_ids: ["cancel"], review: { instructions: "独立回读文稿，核对已结算订单的取消前提和处理方式" } };
const document = (content: string) => ({ id: "cancel", title: "取消规则", target_id: "domain", path: "docs/取消规则/cancel.md", layer: "domain",
  content, sources: "本次研究范围原话：已结算订单取消须冲正，失败时人工核对" });
const save = (content: string, text?: string) => tool("knowledge_draft", { action: "save", document: document(content) }, text);
const read = () => tool("knowledge_draft", { action: "read", id: "cancel" });
const submit = () => tool("knowledge_work_result", { summary: "已保存取消规则候选文稿", document_ids: ["cancel"] });
const verdict = (pass: boolean, feedback: string) => tool("knowledge_work_result", { summary: feedback, document_ids: ["cancel"], review: { pass, feedback } });
const setupPlan = (): Scene[] => [tool("knowledge_work", { action: "save_document", document: { id: "full-plan", title: "完整文稿规划", content: "# 文稿规划\n\n- cancel：说明已结算订单取消的前提、冲正处理与失败时的人工核对。" } }),
  tool("knowledge_work", { action: "plan", document_ids: ["cancel"], work_document_id: "full-plan" })];
const PLAN_SETUP_SCENES = 2;
const plan = () => tool("knowledge_work", { action: "schedule", steps: [step] }, "COORDINATOR_PRIVATE_NOTE");
const run = () => tool("knowledge_work", { action: "run" });
const finish = () => tool("knowledge_work_result", { summary: "计划内文稿已生成并经独立评审", document_ids: ["cancel"] });
const text = (value = "本会话执行结束"): Scene => ({ text: value });
const raw = (request: unknown) => JSON.stringify(request);
const events = (path: string): Array<{ kind: string; payload: Record<string, any> }> => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));

async function until(check: () => boolean, context: () => string) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(`等待研究状态超时：${context()}`);
}

async function fixture(script: Scene[], options: ScriptedModelOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "domain-reviewed-recovery-"));
  const method = { "SKILL.md": "---\nname: reviewed-recovery\ndescription: 逐篇写作并独立评审。\nexecution: reviewed-document-plan\n---\n登记完整文稿计划，执行所有工作，明确报告完成与缺口。" };
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true, ...options });
  try { await model.start(); }
  catch (error) { await model.stop(); rmSync(dir, { recursive: true, force: true }); throw error; }
  const createService = () => new DomainKnowledgeExtraction(dir, input => runDomainKnowledgeFixture(method, input, { dataDir: dir,
    model: () => ({ provider: "maeflow", model: "scripted-v1", json: model.modelsJson() }),
    source: async () => { throw new Error("本用例只读取输入，不访问代码仓"); },
  }));
  let service = createService();
  const job = service.create({ title: "取消规则", scope: "已结算订单取消须冲正，失败时人工核对", issue_no: "REQ-review", repositories: [] }, "tester");
  const root = join(dir, "domain-extraction", job.id, "skill-runs", job.turns[0].id);
  const work = () => JSON.parse(readFileSync(join(root, "work.json"), "utf8")) as { steps: SkillWorkStep[]; plan?: SkillDocumentPlan; result?: { status?: string } };
  return { dir, model, job, root, work,
    service: () => service,
    restart: () => { service = createService(); },
    settled: async () => until(() => ["done", "failed", "paused"].includes(service.get(job.id).status), () => raw({ job: service.get(job.id), requests: model.requests.length })),
    close: async () => {
      try { await service.shutdown(); }
      finally { try { await model.stop(); } finally { rmSync(dir, { recursive: true, force: true }); } }
    },
  };
}

test("真实 Pi：候选提交后写作回复中断，服务重启只接续评审，不重复保存文稿", { timeout: 30_000 }, async () => {
  let held = false, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const script: Scene[] = [...setupPlan(), plan(), run(), save("# 取消规则\n已结算订单取消须冲正，失败时人工核对。", "AUTHOR_PRIVATE_NOTE"), submit(),
    text("此回复在服务关闭前不会完成"), run(), read(), verdict(true, "已回读正文，取消前提与输入相符"), text(), finish(), text()];
  const f = await fixture(script, { beforeScene: async ({ index }) => { if (index === 4 + PLAN_SETUP_SCENES) { held = true; await hold; } } });
  try {
    await until(() => held, () => raw({ status: f.service().get(f.job.id).status, requests: f.model.requests.length }));
    assert.equal(f.work().steps[0].status, "running");
    assert.equal(f.work().steps[0].candidate?.summary, "已保存取消规则候选文稿");
    assert.equal(f.work().steps[0].review_attempts ?? 0, 0);
    assert.deepEqual(f.work().plan, { document_ids: ["cancel"], work_document_id: "full-plan" });
    assert.equal(existsSync(join(f.root, "steps", "cancel", "writer", "result.json")), false, "候选先于写作最终回复独立落盘");
    await f.service().shutdown(); release();
    assert.equal(f.service().get(f.job.id).status, "queued");
    f.restart(); await f.settled();
    const done = f.service().get(f.job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.turns.length, 1); assert.equal(done.turns[0].id, f.job.turns[0].id);
    assert.equal(done.documents.length, 1); assert.equal(done.documents[0].revision, 1);
    assert.equal(f.work().steps[0].attempts, 1); assert.equal(f.work().steps[0].review_attempts, 1);
    assert.equal(f.work().steps[0].status, "done"); assert.equal(f.work().steps[0].result?.review?.pass, true);
    assert.deepEqual(f.work().plan, { document_ids: ["cancel"], work_document_id: "full-plan" }, "完整计划也沿原轮次恢复");
    const writer = events(join(f.root, "steps", "cancel", "writer", "events.jsonl"));
    assert.equal(writer.filter(event => event.kind === "session_started").length, 1, "恢复时没有重开写作会话");
    assert.equal(writer.filter(event => event.kind === "tool_requested" && event.payload.name === "knowledge_draft" && event.payload.input?.action === "save").length, 1);
    assert.ok(events(join(f.root, "coordinator", "events.jsonl")).some(event => event.kind === "session_started" && event.payload.context_restored === true));
    assert.doesNotMatch(raw(f.model.requests[6 + PLAN_SETUP_SCENES]), /AUTHOR_PRIVATE_NOTE|COORDINATOR_PRIVATE_NOTE/, "评审只接收工作说明和候选，不继承前面会话的私有回复");
    assert.equal(f.model.requests.length, script.length);
  } finally { release(); await f.close(); }
});

test("真实 Pi：独立评审须回读且只读，退回后作者恢复上下文修订，再由新评审通过", { timeout: 30_000 }, async () => {
  const feedback = "缺少已结算这一适用前提，并应补充失败时人工核对";
  const script: Scene[] = [...setupPlan(), plan(), run(), save("# 取消规则\n订单取消走冲正。", "AUTHOR_PRIVATE_NOTE"), submit(), text(),
    verdict(true, "未经回读就宣称通过"), read(), save("评审不应覆盖正文"), verdict(false, feedback), text("REVIEWER_PRIVATE_NOTE"),
    read(), save("# 取消规则\n已结算订单取消须冲正，失败时人工核对。"), submit(), text(),
    read(), verdict(true, "回读修订后正文，条件和失败处理都与输入相符"), text(), finish(), text()];
  const f = await fixture(script);
  try {
    await f.settled(); const done = f.service().get(f.job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.documents[0].revision, 2); assert.match(done.documents[0].content, /已结算.*失败时人工核对/);
    assert.equal(f.work().steps[0].attempts, 2); assert.equal(f.work().steps[0].review_attempts, 2);
    assert.equal(f.work().steps[0].result?.review?.pass, true);
    assert.match(raw(f.model.requests[6 + PLAN_SETUP_SCENES]), /当前完整正文/, "未回读的评审提交被工具拒绝");
    assert.match(raw(f.model.requests[8 + PLAN_SETUP_SCENES]), /当前会话只读/, "评审中的写入尝试被拒绝");
    assert.match(raw(f.model.requests[10 + PLAN_SETUP_SCENES]), /AUTHOR_PRIVATE_NOTE/, "作者修订恢复原写作上下文");
    assert.match(raw(f.model.requests[10 + PLAN_SETUP_SCENES]), new RegExp(feedback));
    assert.doesNotMatch(raw(f.model.requests[10 + PLAN_SETUP_SCENES]), /REVIEWER_PRIVATE_NOTE/, "作者只得到结构化反馈，不继承评审私有回复");
    assert.doesNotMatch(raw(f.model.requests[5 + PLAN_SETUP_SCENES]), /AUTHOR_PRIVATE_NOTE|COORDINATOR_PRIVATE_NOTE/);
    assert.doesNotMatch(raw(f.model.requests[14 + PLAN_SETUP_SCENES]), /AUTHOR_PRIVATE_NOTE|REVIEWER_PRIVATE_NOTE|COORDINATOR_PRIVATE_NOTE/, "重新评审也是独立会话");
    assert.doesNotMatch(raw(f.model.requests[17 + PLAN_SETUP_SCENES]), /AUTHOR_PRIVATE_NOTE|REVIEWER_PRIVATE_NOTE/, "主会话只接收已保存结果");
    const writerStarts = events(join(f.root, "steps", "cancel", "writer", "events.jsonl")).filter(event => event.kind === "session_started");
    assert.equal(writerStarts.length, 2); assert.equal(writerStarts[1].payload.context_restored, true);
    for (const attempt of [1, 2]) {
      const reviewer = events(join(f.root, "steps", "cancel", `review-${attempt}`, "events.jsonl"));
      assert.equal(reviewer.filter(event => event.kind === "session_started").length, 1);
      assert.ok(reviewer.some(event => event.kind === "tool_requested" && event.payload.name === "knowledge_draft" && event.payload.input?.action === "read"));
    }
    assert.equal(f.model.requests.length, script.length);
  } finally { await f.close(); }
});

test("真实 Pi：三次评审退回后再次执行也不补预算，任务明确保留失败项等待接续", { timeout: 30_000 }, async () => {
  const script: Scene[] = [...setupPlan(), plan(), run()];
  for (let attempt = 1; attempt <= 3; attempt++) script.push(save(`# 取消规则\n第 ${attempt} 次候选仍缺少依据。`), submit(), text(),
    read(), verdict(false, `第 ${attempt} 次评审：仍缺适用条件的可靠依据`), text());
  script.push(run(), tool("knowledge_work_result", { status: "paused", summary: "三次独立评审均未通过，草稿保留；请补充取消适用条件的业务依据后接续。", document_ids: ["cancel"] }), text());
  const f = await fixture(script);
  try {
    await f.settled(); const done = f.service().get(f.job.id), item = f.work().steps[0];
    assert.equal(done.status, "paused", done.error); assert.match(done.turns[0].waiting?.summary ?? "", /三次独立评审均未通过/);
    assert.equal(item.status, "failed"); assert.equal(item.attempts, 3); assert.equal(item.review_attempts, 3);
    assert.equal(item.result, undefined); assert.equal(item.candidate?.review?.pass, false);
    assert.match(item.error ?? "", /已尝试 3 次/); assert.equal(done.documents[0].revision, 3);
    assert.equal(events(join(f.root, "steps", "cancel", "writer", "events.jsonl")).filter(event => event.kind === "session_started").length, 3);
    assert.equal(existsSync(join(f.root, "steps", "cancel", "review-4")), false);
    assert.match(raw(f.model.requests.at(-2)), /已尝试 3 次/);
    assert.equal(f.model.requests.length, script.length, "再次run不会触发第四轮写作或评审");
  } finally { await f.close(); }
});

test("真实 Pi：作者、独立评审和主协调仅文字结束后，按当前进度补交结果且正文只保存一次", { timeout: 30_000 }, async () => {
  const content = "# 取消规则\n已结算订单取消须冲正，失败时人工核对。";
  const script: Scene[] = [...setupPlan(), plan(), run(), save(content), text("作者已写好文稿，但忘记提交候选")];
  const writerResume = script.length;
  script.push(submit(), text(), read(), text("已独立核对正文，但忘记保存评审判断"));
  const reviewResume = script.length;
  script.push(verdict(true, "已回读正文，结算前提和失败处理与来源一致"), text(), text("所有文稿已完成，但主协调尚未提交结果"));
  const coordinatorResume = script.length;
  script.push(finish(), text());
  const f = await fixture(script);
  try {
    await f.settled(); const done = f.service().get(f.job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.turns.length, 1); assert.equal(done.turns[0].id, f.job.turns[0].id);
    assert.equal(done.documents.length, 1); assert.equal(done.documents[0].content, content); assert.equal(done.documents[0].revision, 1);
    assert.equal(f.work().steps[0].attempts, 1); assert.equal(f.work().steps[0].review_attempts, 1);
    assert.equal(f.work().steps[0].result?.review?.pass, true);
    for (const [index, role] of [[writerResume, "子步骤"], [reviewResume, "独立评审"], [coordinatorResume, "主协调"]] as const) {
      const request = raw(f.model.requests[index]);
      assert.match(request, new RegExp(`你是${role}`));
      assert.match(request, /当前已保存进度/); assert.match(request, /knowledge_work_result/);
      assert.match(request, /cancel/);
    }
    for (const path of ["steps/cancel/writer", "steps/cancel/review-1", "coordinator"]) {
      const recorded = events(join(f.root, path, "events.jsonl"));
      assert.equal(recorded.filter(event => event.kind === "session_started").length, 2, `${path} 只补交一次`);
      assert.ok(recorded.some(event => event.kind === "turn_finished" && event.payload.reason === "end_turn"));
    }
    const writer = events(join(f.root, "steps", "cancel", "writer", "events.jsonl"));
    assert.equal(writer.filter(event => event.kind === "tool_requested" && event.payload.name === "knowledge_draft" && event.payload.input?.action === "save").length, 1);
    assert.equal(f.model.requests.length, script.length);
  } finally { await f.close(); }
});

test("真实 Pi：连续无进展后重建一次干净对话，从持久记录补交而不重做任务", { timeout: 30_000 }, async () => {
  let held = false, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const content = "# 取消规则\n已结算订单取消须冲正，失败时人工核对。";
  const script: Scene[] = [...setupPlan(), plan(), run(), save(content, "AUTHOR_PRIVATE_NOTE"), submit(), text(),
    read(), verdict(true, "已回读正文与来源，通过"), text(), text("COORDINATOR_STALLED_PRIVATE_NOTE")];
  // 第一次正常结束前已有工具进展；其后三次只重复回复才重建对话。
  script.push(text("重复结束一"), text("重复结束二"), text("重复结束三"));
  const freshRequest = script.length;
  script.push(tool("knowledge_work", { action: "read", id: "cancel" }, "FRESH_COORDINATOR_PRIVATE_NOTE"),
    tool("knowledge_work", { action: "read_document", id: "full-plan" }), read());
  const interruptedFreshReply = script.length;
  script.push(text("干净会话已回读原记录，最后回复尚未返回"));
  const restoredRequest = script.length;
  script.push(finish(), text());
  const f = await fixture(script, { beforeScene: async ({ index }) => { if (index === interruptedFreshReply) { held = true; await hold; } } });
  try {
    await until(() => held, () => raw({ status: f.service().get(f.job.id).status, requests: f.model.requests.length }));
    await f.service().shutdown(); release();
    assert.equal(f.service().get(f.job.id).status, "queued");
    f.restart(); await f.settled(); const done = f.service().get(f.job.id);
    assert.equal(done.status, "done", done.error); assert.equal(done.turns.length, 1); assert.equal(done.turns[0].id, f.job.turns[0].id);
    assert.equal(done.documents.length, 1); assert.equal(done.documents[0].revision, 1); assert.equal(done.documents[0].content, content);
    assert.equal(f.work().steps[0].attempts, 1); assert.equal(f.work().steps[0].review_attempts, 1);
    assert.deepEqual(f.work().plan, { document_ids: ["cancel"], work_document_id: "full-plan" });
    assert.match(raw(f.model.requests[freshRequest - 1]), /COORDINATOR_STALLED_PRIVATE_NOTE/, "重建前原对话仍有私有回复");
    const fresh = raw(f.model.requests[freshRequest]);
    assert.doesNotMatch(fresh, /COORDINATOR_PRIVATE_NOTE|COORDINATOR_STALLED_PRIVATE_NOTE|AUTHOR_PRIVATE_NOTE/, "新对话不继承旧对话私有内容");
    assert.match(fresh, /当前已保存进度/); assert.match(fresh, /full-plan/);
    const restored = raw(f.model.requests[restoredRequest]);
    assert.match(restored, /FRESH_COORDINATOR_PRIVATE_NOTE/, "重启恢复已经重建的干净会话及其新进度");
    assert.doesNotMatch(restored, /COORDINATOR_STALLED_PRIVATE_NOTE|AUTHOR_PRIVATE_NOTE|"COORDINATOR_PRIVATE_NOTE"/, "重启不能倒回重建前的旧会话");
    const originalDigest = raw(f.model.requests[0]).match(/方法版本：reviewed-recovery@([a-f0-9]+)/)?.[1];
    assert.ok(originalDigest); assert.match(fresh, new RegExp(`方法版本：reviewed-recovery@${originalDigest}`));
    assert.equal(done.turns[0].skill?.digest, originalDigest);
    const coordinator = events(join(f.root, "coordinator", "events.jsonl"));
    assert.equal(coordinator.filter(event => event.kind === "session_started" && event.payload.resume === false).length, 2, "只有原开局和一次干净重建");
    assert.equal(coordinator.filter(event => event.kind === "tool_requested" && event.payload.name === "knowledge_work" && event.payload.input?.action === "schedule").length, 1);
    assert.ok(coordinator.some(event => event.kind === "tool_requested" && event.payload.name === "knowledge_work" && event.payload.input?.action === "read" && event.payload.input?.id === "cancel"));
    const writer = events(join(f.root, "steps", "cancel", "writer", "events.jsonl"));
    assert.equal(writer.filter(event => event.kind === "tool_requested" && event.payload.name === "knowledge_draft" && event.payload.input?.action === "save").length, 1);
    assert.equal(events(join(f.root, "steps", "cancel", "review-1", "events.jsonl")).filter(event => event.kind === "session_started").length, 1);
    assert.equal(done.evidence.filter(event => String(event.preview).includes("正在依据已保存进度恢复会话")).length, 1);
    assert.equal(f.model.requests.length, script.length);
  } finally { release(); await f.close(); }
});

test("真实 Pi：独立评审已提交后服务重启，直接复用评审而不重复写作或核查", { timeout: 30_000 }, async () => {
  let held = false, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const script: Scene[] = [...setupPlan(), plan(), run(), save("# 取消规则\n已结算订单取消须冲正，失败时人工核对。"), submit(), text(),
    read(), verdict(true, "已回读当前正文及来源，通过")];
  const interruptedReply = script.length;
  script.push(text("评审结果已提交，但最终回复尚未返回"), run(), finish(), text());
  const f = await fixture(script, { beforeScene: async ({ index }) => { if (index === interruptedReply) { held = true; await hold; } } });
  try {
    await until(() => held, () => raw({ status: f.service().get(f.job.id).status, requests: f.model.requests.length }));
    const submitted = f.work().steps[0];
    assert.equal(submitted.review_submission?.result.review?.pass, true);
    assert.equal(submitted.review_attempts, 1); assert.equal(submitted.status, "running"); assert.equal(submitted.result, undefined);
    assert.equal(existsSync(join(f.root, "steps", "cancel", "review-1", "result.json")), false, "评审结果先于最后回复持久化");
    const skill = f.service().get(f.job.id).turns[0].skill;
    await f.service().shutdown(); release();
    assert.equal(f.service().get(f.job.id).status, "queued");
    f.restart(); await f.settled();
    const done = f.service().get(f.job.id), step = f.work().steps[0];
    assert.equal(done.status, "done", done.error); assert.equal(done.turns.length, 1); assert.equal(done.turns[0].id, f.job.turns[0].id);
    assert.deepEqual(done.turns[0].skill, skill); assert.equal(done.documents[0].revision, 1);
    assert.equal(step.attempts, 1); assert.equal(step.review_attempts, 1); assert.equal(step.result?.review?.pass, true);
    assert.equal(step.reviewed_fingerprint, submitted.review_submission?.fingerprint);
    assert.equal(events(join(f.root, "steps", "cancel", "writer", "events.jsonl")).filter(event => event.kind === "session_started").length, 1);
    assert.equal(events(join(f.root, "steps", "cancel", "review-1", "events.jsonl")).filter(event => event.kind === "session_started").length, 1);
    assert.equal(existsSync(join(f.root, "steps", "cancel", "review-2")), false);
    assert.equal(f.model.requests.length, script.length);
  } finally { release(); await f.close(); }
});
