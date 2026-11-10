import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { confirmedPipelineRun, historicalPipelineFeedback, projectPushReceipt } from "../src/pipelineHandoff.ts";

test("推送结果晚于 MR 关闭返回：保留真实提交收据，不清除关闭原因", () => {
  const summary: any = { delivery: { sha: "old", mr_state: "已关闭", waiting_on: "MR 已关闭，请重新打开", pipeline: "failed" } };
  projectPushReceipt(summary, { sha: "new", ref: "refs/heads/work", remote: "origin" });
  assert.equal(summary.delivery.git_push.sha, "new");
  assert.equal(summary.delivery.waiting_on, "MR 已关闭，请重新打开");
  assert.equal(summary.delivery.pipeline, undefined);
});

test("新推送同步验证目标并清除旧绿灯；同 SHA 重试保留结果，上次派发修复锚不改", () => {
  const summary: any = { delivery: { sha: "old", pipeline: "success", checks: [{ dimension: "UT", status: "success" }],
    attested: "PASS@old", evidence_gap: { sha: "old" }, mr_url: "mr/1",
    loop: { kind: "ci", round: 2, last_sha: "old", failure: "旧失败" } } };
  const receipt = { sha: "new", ref: "work", remote: "origin" };
  projectPushReceipt(summary, receipt);
  assert.equal(summary.delivery.sha, "new");
  assert.equal(summary.delivery.pipeline, undefined);
  assert.equal(summary.delivery.checks, undefined);
  assert.equal(summary.delivery.attested, undefined);
  assert.equal(summary.delivery.evidence_gap, undefined);
  assert.equal(summary.delivery.mr_url, "mr/1");
  assert.deepEqual(summary.delivery.loop, { kind: "ci", round: 2, last_sha: "old", failure: "旧失败" });
  summary.delivery.pipeline = "success";
  projectPushReceipt(summary, receipt);
  assert.equal(summary.delivery.pipeline, "success");
});

test("推送增量起点随新推送前进，同版本重试及重启恢复不清空", () => {
  let summary: any = { delivery: {} };
  const push = (sha: string) => projectPushReceipt(summary, { sha, ref: "refs/heads/work", remote: "origin" });
  push("first");
  assert.equal(summary.delivery.last_push_base_sha, undefined);
  push("second");
  assert.equal(summary.delivery.last_push_base_sha, "first");
  summary = JSON.parse(JSON.stringify(summary));
  push("second");
  assert.equal(summary.delivery.last_push_base_sha, "first");
  push("third");
  assert.equal(summary.delivery.last_push_base_sha, "second");
});

test("绿灯后的旧流水线反馈不派会话，混合批次中的检视意见仍接续处理", async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "promoted-pipeline-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const task = service.create("检视与 CI");
  const state = service.tasks.get(task.id);
  state.summary.delivery = { sha: "new", pipeline: "success", git_push: { sha: "new", ref: "work", remote: "origin" } };
  const items: any[] = [{ id: "old-ci", source: "pipeline", source_id: "old:COMPILE", summary: "旧失败" }];
  service.activeKernelFeedback = () => ({ batchId: "batch", current: "feedback_triage", items });
  const missions: string[] = [];
  service.enqueueRepair = (_task: unknown, mission: string) => missions.push(mission);
  assert.equal(service.dispatchPromotedFeedback(state), false);
  items.push({ id: "review", source: "workspace", summary: "仍需修改接口" });
  assert.equal(service.dispatchPromotedFeedback(state), true);
  assert.match(missions[0], /仍需修改接口/);
  assert.doesNotMatch(missions[0], /旧失败/);
  state.summary.delivery.pipeline = undefined;
  items.pop();
  assert.equal(service.dispatchPromotedFeedback(state), false, "新推送尚未取到结果，先验证，不能继续派旧流水线反馈");
});

test("恢复已绿任务先核销流水线，不能抢先派反馈或重跑交付", async t => {
  const options = { dataDir: mkdtempSync(join(tmpdir(), "green-recover-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 };
  const before: any = new TaskService(options);
  const task = before.create("已绿待核销");
  const state = before.tasks.get(task.id);
  state.summary.status = "verifying";
  state.summary.delivery = { sha: "new", pipeline: "success", git_push: { sha: "new", ref: "work", remote: "origin" } };
  before.persist(state);
  await before.shutdown();
  const after: any = new TaskService(options);
  t.after(() => after.shutdown());
  const calls: string[] = [];
  after.dispatchPromotedFeedback = () => { calls.push("dispatch"); return true; };
  after.tryDeliver = async () => calls.push("deliver");
  after.pipelineVerdict = async (_task: unknown, sha: string, status: string) => calls.push(`${sha}:${status}`);
  after.recover();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ["new:success"]);
});

test("新 SHA 首次失败正常派发修复并更新 last_sha，同 SHA 再失败刹车，迟到旧结果不影响新版本", async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "ci-anchor-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const task = service.create("CI 修复");
  const state = service.tasks.get(task.id);
  state.summary.status = "verifying";
  state.summary.delivery = { sha: "old", pipeline: "failed",
    loop: { kind: "ci", round: 1, last_sha: "old", state: "repairing", failure: "旧失败" } };
  projectPushReceipt(state.summary, { sha: "new", ref: "work", remote: "origin" });
  state.summary.delivery.pipeline = "failed";
  state.summary.delivery.checks = [{ dimension: "COMPILE", status: "failed", details: [
    { message: "构建失败=1 [超限]", rule: "quality_metric", severity: "error" },
    { message: "DT=2 [超限]", rule: "quality_metric", severity: "error" },
    { message: "cannot find symbol Widget", file: "src/main.ts", line: 10 },
  ] }];
  service.mirrorPipelineArtifacts = async () => [];
  const opened: string[] = [];
  service.openFeedbackBatch = (_task: unknown, _source: string, items: Array<{ source_id: string }>) => opened.push(items[0].source_id);
  await service.dispatchCiRepair(state, "new", "Compile error at main.ts:10", 20, state.controlEpoch);
  assert.equal(state.summary.delivery.loop.last_sha, "new");
  assert.equal(state.summary.delivery.loop.round, 2);
  assert.match(opened[0], /^new:/);
  assert.equal(state.summary.delivery.loop.state, "repairing");
  assert.match(state.mission, /DT=2 \[超限\]/);
  assert.match(state.mission, /报告生成成功、测试执行通过、覆盖率达标是三件事/);
  assert.match(state.mission, /未知含义保留原名与数值/);
  await service.dispatchCiRepair(state, "new", "same failure", 20, state.controlEpoch);
  assert.equal(state.summary.delivery.loop.state, "repairing");
  assert.equal(state.summary.delivery.loop.round, 3);
  assert.match(state.mission, /先检查 git status/);
  projectPushReceipt(state.summary, { sha: "newer", ref: "work", remote: "origin" });
  const before = JSON.stringify(state.summary.delivery);
  await service.dispatchCiRepair(state, "new", "late failure", 20, state.controlEpoch);
  await service.pipelineVerdict(state, "new", "success", "late success", undefined, state.controlEpoch);
  assert.equal(JSON.stringify(state.summary.delivery), before);
});

test("流水线触发和恢复查询只采信指定 SHA，拒绝过期结果及空查询", () => {
  assert.equal(confirmedPipelineRun("new", { status: "failed", runs: [
    { sha: "new", status: "running" }, { sha: "old", status: "failed" },
  ] }).status, "running");
  for (const result of [ { status: "failed", sha: "old" }, { status: "success", sha: "new", is_valid: false }, { status: "running", runs: [] } ] as const) {
    assert.throws(() => confirmedPipelineRun("new", result as any), /有效流水线/);
  }
});

for (const status of ["running", "success", "failed"] as const) test(`宿主接收新 SHA ${status}：旧使命退出，事实保留，交给现有验证裁决`, async () => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-handoff-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("验证新修复", { account: "owner" });
  const state = service.tasks.get(task.id);
  state.mission = "当前目标是处理本轮流水线失败(1)。分支上提交 old 的权威流水线结果是 failed。[本轮流水线修复目标结束]";
  state.summary.status = "running";
  state.summary.delivery = { sha: "old", pipeline: "failed", checks: [{ dimension: "COMPILE", status: "failed" }],
    loop: { kind: "ci", round: 1, state: "repairing", last_sha: "old", failure: "旧失败原文" },
    git_push: { sha: "new", ref: "refs/heads/work", remote: "origin" } };
  const routed: unknown[] = [];
  service.ensureMergeWatch = () => {};
  service.pollPipeline = async (_task: unknown, epoch: number) => { routed.push(["poll", epoch]); };
  service.pipelineVerdict = async (_task: unknown, sha: string, status: string, log: string) => { routed.push([sha, status, log]); };
  await service.acceptPipelineRun(state, "new", { status, log: "新运行记录" }, state.controlEpoch);
  assert.equal(state.mission, undefined);
  assert.equal(state.summary.delivery.sha, "new");
  assert.equal(state.summary.delivery.pipeline, status);
  assert.equal(state.summary.delivery.checks, undefined, "不能把旧检查结果挂到新 SHA");
  assert.equal(state.summary.delivery.loop.last_sha, "old");
  assert.equal(state.summary.delivery.loop.failure, "旧失败原文");
  assert.equal(state.summary.delivery.loop.state, "verifying");
  assert.deepEqual(routed, status === "running" ? [["poll", state.controlEpoch]] : [["new", status, "新运行记录"]]);
  assert.equal(JSON.parse(readFileSync(join(task.workspace, "task.json"), "utf8")).mission, undefined);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "pipeline", observed_sha: "old" }), true);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "pipeline", observed_sha: "new" }), false);
  assert.equal(historicalPipelineFeedback(state.summary, { source: "workspace", observed_sha: "old" }), false);
});

test("同 SHA 会话换代后新轮询接棒，旧轮询退出不能清掉新标记", async t => {
  const { createServer } = await import("node:http");
  let queries = 0;
  const server = createServer((_req, res) => { queries++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ runs: [{ sha: "new", status: "running" }] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-epoch-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: `http://127.0.0.1:${(server.address() as any).port}`, pollIntervalMs: 5 } });
  const task = service.create("验证", { account: "owner" });
  const state = service.tasks.get(task.id);
  state.summary.status = "verifying"; state.summary.delivery = {
    sha: "new", mr_url: "http://platform/mr/1", pipeline: "running",
  };
  const oldPoll = service.pollPipeline(state, state.controlEpoch);
  state.controlEpoch++;
  const newPoll = service.pollPipeline(state, state.controlEpoch);
  await oldPoll;
  assert.equal(state.pipelinePollEpoch, state.controlEpoch);
  const deadline = Date.now() + 2000;
  while (!queries && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(queries > 0);
  state.summary.status = "completed";
  await newPoll;
  assert.equal(state.pipelinePollSha, undefined);
});

test("新验证接棒后，旧流水线批次不再生成回执补交任务；历史原文不改写", async () => {
  const { writeFileSync } = await import("node:fs");
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "pipeline-history-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("处理补充要求");
  const state = service.tasks.get(summary.id);
  state.cwd = summary.workspace;
  service.options.host = { continuousReview: true };
  state.summary.delivery = { sha: "new", pipeline: "running", git_push: { sha: "new", ref: "work", remote: "origin" } };
  const file = join(summary.workspace, ".mae-flow.json");
  const original = JSON.stringify({ delivery_loop: { active_batch_id: "old-batch", batches: [{ batch_id: "old-batch", base_sha: "old", items: [{ id: "pipeline:old:COMPILE", source: "pipeline", source_id: "old:COMPILE", summary: "旧告警" }] }] } });
  writeFileSync(file, original);
  assert.equal(service.activeFeedbackResult(state), undefined);
  assert.equal(service.recordActiveFeedbackResult(state), undefined);
  assert.equal(readFileSync(file, "utf8"), original);
});

for (const status of ["success", "failed"] as const) test(`HEAD 已前进时旧 ${status} 只重验，不派旧代码修复`, async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "stale-verdict-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const task = service.create("旧结果不重复派修");
  const state = service.tasks.get(task.id);
  state.summary.status = "verifying";
  state.summary.delivery = { sha: "old", pipeline: status, git_push: { sha: "old", ref: "work", remote: "origin" } };
  service.recordPipelineEvidence = async () => ({ verdict: "STALE", reason: "HEAD 已变" });
  service.syncFeedbackStoreFromKernel = () => {};
  const retries: boolean[] = [];
  service.schedulePipelineEvidenceRetry = (_task: unknown, _sha: string, _epoch: number, stale: boolean) => retries.push(stale);
  service.handlePipelineRed = async () => assert.fail("不应派发修复旧 SHA");
  await service.pipelineVerdict(state, "old", status, "旧编译错误", undefined, state.controlEpoch);
  assert.deepEqual(retries, [true]);
  assert.equal(state.summary.status, "verifying");
});

for (const status of ["success", "failed"] as const) test(`登记 ${status} 期间新推送接棒，迟到返回不派发修复或推进新版本`, async t => {
  const service: any = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "late-attestation-")), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  const task = service.create("核销期间新推送");
  const state = service.tasks.get(task.id);
  state.summary.status = "verifying";
  state.summary.delivery = { sha: "old", pipeline: status };
  service.recordPipelineEvidence = async () => {
    await Promise.resolve();
    projectPushReceipt(state.summary, { sha: "new", ref: "work", remote: "origin" });
    return { verdict: status === "success" ? "PASS" : "RED" };
  };
  service.syncFeedbackStoreFromKernel = () => assert.fail("不能核销旧提交");
  service.handlePipelineRed = async () => assert.fail("不能派发修复旧提交");
  await service.pipelineVerdict(state, "old", status, "旧结果", undefined, state.controlEpoch);
  assert.equal(state.summary.delivery.sha, "new");
  assert.equal(state.summary.status, "verifying");
  assert.equal(state.summary.delivery.pipeline, undefined);
});

for (const dirty of [false, true]) test(`交付 SHA 不变且工作区${dirty ? "有" : "无"}改动：按预算续跑而非推断放弃`, async t => {
  const {writeFileSync} = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "ci-unfinished-"));
  const service: any = new TaskService({dataDir:dir,provider:"test",model:"test",modelsJson:{},maxConcurrent:0});
  t.after(() => service.shutdown());
  const summary = service.create("补 UT 未完成");
  const state = service.tasks.get(summary.id);
  state.cwd = summary.workspace;
  if(dirty) writeFileSync(join(state.cwd,"UnfinishedTest.java"), "class UnfinishedTest {}\n");
  state.summary.status = "verifying";
  state.summary.delivery = {sha:"same",loop:{kind:"ci",last_sha:"same",state:"verifying",round:1,max:2}};
  state.lastReply = "现在继续补测试";
  service.mirrorPipelineArtifacts = async () => [];
  service.openFeedbackBatch = () => {};
  await service.dispatchCiRepair(state,"same","UT coverage 68.25% expected 75%",2,state.controlEpoch);
  assert.equal(state.summary.status,"queued");
  assert.equal(state.summary.delivery.loop.state,"repairing");
  assert.match(state.mission,/未推送提交/);
  assert.match(state.mission,/AskUserQuestion/);
  if(dirty) assert.equal(readFileSync(join(state.cwd,"UnfinishedTest.java"),"utf8"),"class UnfinishedTest {}\n");
  await service.dispatchCiRepair(state,"same","UT coverage 68.25% expected 75%",2,state.controlEpoch);
  assert.equal(state.summary.delivery.loop.state,"exhausted", "既有预算仍能终止反复空转");
});
