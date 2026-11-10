import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskService } from "../src/taskService.ts";
import { queueTaskHostOperation, finishTaskHostOperation, TaskHostLedger, createTaskHostTools } from "../src/taskHostTools.ts";
import { parsePipelineStatus, triggerPipeline } from "../src/pipelineClient.ts";
import { PlatformAdapter } from "../src/platformAdapter.ts";

const sha = "b".repeat(40), old = "a".repeat(40);
const mission = "责任人最新要求：虚拟化执行 queryENE.sh，继续修订代码和 UT";
async function until(check: () => boolean) {
  const end = Date.now() + 4000;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), "等待实际异步状态落盘");
}
async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), "early-pipeline-"));
  let payload: any = { runs: [] }, error = false, queries = 0, statusQueries = 0, triggers = 0;
  const bodies: any[] = [];
  let delay: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    if (req.method === "POST") { triggers++; bodies.push(JSON.parse(text)); }
    else {
      queries++;
      if (req.url?.startsWith("/pipeline/status")) statusQueries++;
    }
    const captured = JSON.stringify(payload), failed = error;
    await delay;
    res.statusCode = failed ? 502 : 200;
    res.setHeader("content-type", "application/json"); res.end(failed ? '{"error":"temporary outage"}' : captured);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const platformUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const options = { dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl, pollIntervalMs: 5 } };
  const service: any = new TaskService(options);
  const summary = service.create("等效数方案", { account: "owner" });
  const task = service.tasks.get(summary.id);
  task.cwd = join(summary.workspace, "repo"); mkdirSync(task.cwd, { recursive: true });
  execFileSync("git", ["init", "-q", task.cwd]);
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "build" }));
  task.summary.status = "running"; task.summary.waiting = undefined; service.queue = [];
  task.mission = mission;
  task.summary.delivery = { sha, git_push: { sha, remote: "origin", ref: "refs/heads/work" } };
  t.after(async () => { await service.shutdown(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { recursive: true, force: true }); });
  return { service, task, options, platformUrl, bodies,
    response: (value: any) => { payload = value; }, outage: (value: boolean) => { error = value; },
    delay: (value?: Promise<void>) => { delay = value; }, queries: () => queries,
    statusQueries: () => statusQueries, triggers: () => triggers };
}

test("显式空查询不接受顶层 running；旧单 run 响应仍兼容", () => {
  assert.deepEqual(parsePipelineStatus({ status: "running", runs: [] }), { status: "not_found", runs: [] });
  assert.equal(parsePipelineStatus({ status: "running" }).runs.length, 1);
});

test("CodeHub 自动触发配置按真实状态查询，空结果不伪造运行、不执行触发命令", async t => {
  const dir = mkdtempSync(join(tmpdir(), "observe-only-adapter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync("deploy/adapter-config/adapter.codehub.json", "utf8"));
  delete config.token_file; delete config.token;
  const path = join(dir, "adapter.json"); writeFileSync(path, JSON.stringify(config));
  const adapter: any = new PlatformAdapter(path, () => {});
  let calls = 0;
  adapter.run = async (spec: any, values: any) => {
    assert.notEqual(spec, adapter.config.pipeline_trigger);
    assert.equal(values.sha, sha); assert.equal(values.mr, "3384"); calls++;
    return '[]';
  };
  const result = await adapter.handle("POST", "/pipeline/trigger", new URLSearchParams(), { sha, repo: "repo", mr: "3384" }, {});
  assert.equal(result.status, 201); assert.deepEqual(result.payload, { runs: [] }); assert.equal(calls, 1);
});

for (const ciLoop of [false, true]) test(`提前验证续接原目标和未送达插话，不受历史 CI 环影响（${ciLoop}）`, async t => {
  const f = await fixture(t), { task, service } = f;
  if (ciLoop) task.summary.delivery.loop = { kind: "ci", state: "repairing", last_sha: old, round: 1, failure: "旧告警" };
  task.driver = { isIdle: true, dispose() {}, takeUndeliveredSteers: () => ["不能直接返回 false"] };
  const host = service.taskHostRuntime(task);
  await queueTaskHostOperation(host, "early-check", { action: "trigger_pipeline", reason: "提前验证，然后继续编码" });
  await finishTaskHostOperation(host);
  assert.equal(task.summary.status, "queued"); assert.ok(service.queue.includes(task.summary.id));
  assert.match(task.mission, /queryENE.sh/); assert.deepEqual(task.pendingMainSteers, ["不能直接返回 false"]);
  assert.equal(task.summary.delivery.pipeline, "not_found"); assert.equal(task.summary.delivery.git_push.sha, sha);
  assert.equal(JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current, "build");
  assert.equal(task.summary.delivery.mr_url, undefined);
  assert.equal(new TaskHostLedger(task.summary).read().operations.at(-1)?.state, "succeeded");
  const before = f.queries(); await until(() => f.queries() > before);
  assert.equal(f.triggers(), 1);
  assert.equal(await finishTaskHostOperation(service.taskHostRuntime(task)), false, "下一回合不反复交接已完成操作");
});

test("提前查询失败继续原目标并重试观察，不重复触发；出现真实运行后更新状态", async t => {
  const f = await fixture(t), { task, service } = f;
  f.outage(true);
  const host = service.taskHostRuntime(task);
  await queueTaskHostOperation(host, "early-check", { action: "trigger_pipeline", reason: "提前检查" });
  await finishTaskHostOperation(host);
  assert.equal(task.summary.status, "queued"); assert.match(task.mission, /queryENE.sh/);
  assert.match(task.mission, /执行 done/);
  assert.equal(task.summary.delivery.pipeline, "查询失败，正在重试");
  f.outage(false); f.response({ runs: [{ sha, status: "running" }] });
  await until(() => task.summary.delivery.pipeline === "running");
  assert.equal(f.triggers(), 1);
});

for (const status of ["not_found", "running", "success", "failed"]) test(`build 提前验证 ${status} 后继续步骤，工具查询也说明 done 不等待流水线`, async t => {
  const f = await fixture(t), { task, service } = f;
  f.response({ runs: status === "not_found" ? [] : [{ sha, status }] });
  const host = service.taskHostRuntime(task);
  const tool = createTaskHostTools(host).find(tool => tool.name === "task_pipeline")!;
  const result = await (tool.execute as any)("query-before-done", { action: "status" });
  const reply = JSON.parse(result.content[0].text);
  assert.equal(reply.status, status);
  assert.match(reply.message, /流水线通过不是 build done 的前提/);
  assert.equal(task.summary.status, "running", "只读查询不结束工作或推进内核");
  await queueTaskHostOperation(host, "early-check", { action: "trigger_pipeline", reason: "提前验证" });
  await finishTaskHostOperation(host);
  assert.equal(task.summary.status, "queued");
  assert.match(task.mission, /queryENE.sh/);
  assert.match(task.mission, /执行 done/);
  assert.doesNotMatch(task.mission, /等待本次验证结果/);
  assert.equal(task.summary.delivery.pipeline, status);
  assert.equal(task.summary.delivery.mr_url, undefined);
  assert.equal(JSON.parse(readFileSync(join(task.cwd, ".mae-flow.json"), "utf8")).current, "build");
  assert.equal(f.triggers(), 1);
});

test("提前监听跨会话换代持续，红绿灯不打断编码；切换 SHA 后拒收迟到结果", async t => {
  const f = await fixture(t), { task, service } = f;
  const verdicts: unknown[] = []; service.pipelineVerdict = async (...args: any[]) => verdicts.push(args);
  await service.acceptPipelineRun(task, sha, undefined, task.controlEpoch, true);
  task.controlEpoch++; task.summary.status = "running";
  f.response({ runs: [{ sha, status: "failed", log: "当前提交失败" }] });
  await until(() => task.summary.delivery.pipeline === "failed");
  assert.equal(task.summary.status, "running"); assert.equal(task.mission, mission); assert.deepEqual(verdicts, []);
  f.response({ runs: [{ sha, status: "success" }] });
  await until(() => task.summary.delivery.pipeline === "success");
  let resolve!: () => void; f.delay(new Promise<void>(r => { resolve = r; }));
  f.response({ runs: [{ sha, status: "failed" }] });
  const before = f.queries(); await until(() => f.queries() > before);
  const newer = "c".repeat(40); task.summary.delivery = { sha: newer, git_push: { sha: newer, remote: "origin", ref: "refs/heads/work" } };
  resolve(); f.delay(); await new Promise(r => setTimeout(r, 30));
  assert.equal(task.summary.delivery.pipeline, undefined); assert.deepEqual(verdicts, []);
});

test("正式验证复用同一提交观察结果，只有交付接管后才裁决", async t => {
  const f = await fixture(t), { task, service } = f;
  const verdicts: any[] = []; service.pipelineVerdict = async (_task: any, sha: string, status: string) => verdicts.push({ sha, status });
  await service.acceptPipelineRun(task, sha, undefined, task.controlEpoch, true);
  task.mission = undefined; task.summary.status = "verifying"; task.summary.delivery.mr_url = "http://platform/mr/1";
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  f.response({ runs: [{ sha, status: "success" }] });
  await until(() => task.summary.delivery.pipeline === "success");
  assert.deepEqual(verdicts, [], "内核阶段变化本身不授权旁路跳过正式交付");
  void service.pollPipeline(task, task.controlEpoch); // 正式交付入口核对后接管同一监听槽。
  await until(() => verdicts.length === 1);
  assert.deepEqual(verdicts, [{ sha, status: "success" }]); assert.equal(f.triggers(), 0);
});

test("交付等待点推送后无 MR，宿主接续创建而不轮询裸分支", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  let deliveries = 0;
  service.tryDeliver = async () => { deliveries++; };
  assert.equal(service.taskHostRuntime(task).watchPush(), true);
  await until(() => deliveries === 1);
  assert.equal(task.summary.status, "verifying");
  assert.equal(f.queries(), 0);
  assert.equal(f.triggers(), 0);
  await service.pollPipeline(task, task.controlEpoch);
  assert.equal(deliveries, 2, "旧的正式轮询入口也应转到同一交付入口");
  assert.equal(f.queries(), 0);
});

test("没有 MR 的提前验证不能接管正式交付", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.status = "running";
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  assert.equal(service.pipelineCanTakeOver(task), false);
  const handedOff = await service.acceptPipelineRun(task, sha,
    { sha, status: "running" }, task.controlEpoch, !service.pipelineCanTakeOver(task));
  assert.equal(handedOff, false);
  assert.equal(task.summary.status, "running");
  assert.equal(task.summary.delivery.pipeline_background, true);
  assert.equal(f.statusQueries(), 0);
});

test("仅保存 MR 编号的旧任务也能正式验证", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.delivery.mr_id = 3384;
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  assert.equal(service.pipelineCanTakeOver(task), true);
  task.summary.delivery.loop = { kind: "ci", state: "repairing", last_sha: old, round: 1 };
  task.mission = `当前目标是处理本轮流水线失败(1)。分支上提交 ${old} 的权威流水线结果是 failed。[本轮流水线修复目标结束]`;
  assert.equal(service.taskHostRuntime(task).resumePipelineAfterPush(sha), true);
});

test("重启恢复无 MR 的已推送任务，接续创建 MR 而非空转轮询", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.status = "verifying";
  task.summary.delivery.pipeline = "not_found";
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  service.persist(task);
  await service.shutdown();
  const restored: any = new TaskService(f.options);
  t.after(() => restored.shutdown());
  let deliveries = 0;
  restored.tryDeliver = async () => { deliveries++; };
  restored.recover();
  await until(() => deliveries === 1);
  assert.equal(f.queries(), 0);
  assert.equal(restored.tasks.get(task.summary.id).summary.delivery.git_push.sha, sha);
});

test("旧任务还没推送却留下 not_found，恢复时仍先走交付入口", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.status = "verifying";
  task.summary.delivery.pipeline = "not_found";
  task.summary.delivery.git_push = undefined;
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  service.persist(task);
  await service.shutdown();
  const restored: any = new TaskService(f.options);
  t.after(() => restored.shutdown());
  let deliveries = 0;
  restored.tryDeliver = async () => { deliveries++; };
  restored.recover();
  await until(() => deliveries === 1);
  assert.equal(f.queries(), 0);
  assert.equal(f.triggers(), 0);
});

for (const outage of [false, true]) test(`MR 已建但流水线始终不可得，按现有期限停下（查询故障：${outage}）`, async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.status = "verifying";
  task.summary.delivery.mr_url = "http://platform/mr/1";
  task.summary.delivery.verify_deadline = new Date(Date.now() - 1000).toISOString();
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  f.outage(outage);
  await service.pollPipeline(task, task.controlEpoch);
  assert.match(task.summary.delivery.stalled, outage ? /持续查询失败/ : /仍未找到.*有效流水线/);
  assert.equal(task.summary.delivery.stall_class, "infrastructure");
  assert.equal(f.queries(), 1);
  assert.equal(f.triggers(), 0);
  service.persist(task);
  await service.shutdown();
  const restored: any = new TaskService(f.options);
  t.after(() => restored.shutdown());
  restored.recover();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(f.statusQueries(), 1, "已停摆不能因服务重启再次开始无限轮询");
});

test("首次查不到流水线时落盘等待期限，真实运行出现后解除缺失期限", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = undefined;
  task.summary.status = "verifying";
  task.summary.delivery.mr_url = "http://platform/mr/1";
  writeFileSync(join(task.cwd, ".mae-flow.json"), JSON.stringify({ current: "external_verify" }));
  const polling = service.pollPipeline(task, task.controlEpoch);
  await until(() => Boolean(task.summary.delivery.verify_deadline));
  const saved = JSON.parse(readFileSync(join(task.summary.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.delivery.verify_deadline, task.summary.delivery.verify_deadline);
  f.response({ runs: [{ sha, status: "running" }] });
  await until(() => task.summary.delivery.pipeline === "running");
  assert.equal(task.summary.delivery.verify_deadline, undefined);
  task.summary.status = "completed";
  await polling;
  assert.equal(task.summary.delivery.stalled, undefined);
});

for (const state of ["verifying", "paused", "waiting_for_human"] as const) test(`重启恢复提前验证现场：${state} 保留收据和目标`, async t => {
  const f = await fixture(t), { task, service } = f;
  task.summary.status = state; task.summary.delivery.pipeline = "running";
  task.pendingMainSteers = ["最新补充"];
  service.persist(task); await service.shutdown();
  const recovered: any = new TaskService(f.options); t.after(() => recovered.shutdown());
  recovered.recover();
  const live = recovered.tasks.get(task.summary.id);
  assert.equal(live.summary.status, state === "verifying" ? "queued" : state);
  assert.equal(recovered.queue.filter((id: string) => id === task.summary.id).length, state === "verifying" ? 1 : 0);
  assert.match(live.mission, /queryENE.sh/); assert.deepEqual(live.pendingMainSteers, ["最新补充"]);
  assert.equal(live.summary.delivery.git_push.sha, sha);
  await until(() => live.summary.delivery.pipeline === "not_found"); assert.equal(f.triggers(), 0);
});

test("触发请求带 MR，自动触发查询可以按 MR 找到真实运行", async t => {
  const f = await fixture(t); await triggerPipeline({ platformUrl: f.platformUrl, sha, mr: "3384" });
  assert.equal(f.bodies[0].mr, "3384");
});

test("正式 CI 接棒已落盘后，重启只续观察，不误判成未完编码", async t => {
  const f = await fixture(t), { task, service } = f;
  task.summary.delivery.mr_url = "http://platform/mr/1";
  task.mission = "当前目标是处理本轮流水线失败(1)。分支上提交 " + old + " 的权威流水线结果是 failed。[本轮流水线修复目标结束]";
  task.summary.delivery.loop = { kind: "ci", state: "repairing", last_sha: old, round: 1 };
  await service.acceptPipelineRun(task, sha, { sha, status: "running" }, task.controlEpoch);
  assert.equal(task.mission, undefined); assert.equal(task.summary.delivery.pipeline_background, false);
  service.persist(task); await service.shutdown();
  const recovered: any = new TaskService(f.options); t.after(() => recovered.shutdown());
  recovered.recover();
  const live = recovered.tasks.get(task.summary.id);
  assert.equal(live.summary.status, "verifying"); assert.deepEqual(recovered.queue, []);
  await until(() => live.summary.delivery.pipeline === "not_found"); assert.equal(f.triggers(), 0);
});

test("提前验证返回途中有新插话，不能按旧 CI 判断丢掉续接", async t => {
  const f = await fixture(t), { task, service } = f;
  task.mission = "当前目标是处理本轮流水线失败(1)。分支上提交 " + old + " 的权威流水线结果是 failed。[本轮流水线修复目标结束]";
  task.summary.delivery.loop = { kind: "ci", state: "repairing", last_sha: old, round: 1 };
  let resolve!: () => void; f.delay(new Promise<void>(r => { resolve = r; }));
  const host = service.taskHostRuntime(task);
  await queueTaskHostOperation(host, "early-check", { action: "trigger_pipeline", reason: "验证修复" });
  const finishing = finishTaskHostOperation(host);
  await until(() => f.triggers() === 1);
  task.pendingMainSteers = [mission];
  resolve(); f.delay(); await finishing;
  assert.equal(task.summary.status, "queued"); assert.deepEqual(task.pendingMainSteers, [mission]);
  assert.doesNotMatch(task.mission, /当前目标是处理本轮流水线失败/);
  assert.equal(task.summary.delivery.pipeline_background, true);
});

test("同 SHA 重跑时不回退旧绿灯，畸形 runs 不能被顶层 success 背书", async () => {
  const { observedPipelineRun } = await import("../src/pipelineHandoff.ts");
  assert.equal(observedPipelineRun(sha, { status: "running", runs: [
    { sha, status: "success" }, { status: "running" },
  ] })?.status, "running");
  assert.equal(observedPipelineRun(sha, { status: "success", runs: [
    { sha, status: "success" }, { sha, status: "success", is_valid: false },
  ] }), undefined);
  assert.throws(() => parsePipelineStatus({ status: "success", runs: {} }), /必须是数组/);
});

test("推送已成功但 CI 查询失败，监听继续且不把有效推送记成失败", async t => {
  const f = await fixture(t), { task, service } = f;
  f.outage(true);
  task.summary.delivery.mr_url = "http://platform/mr/1";
  task.summary.delivery.loop = { kind: "ci", state: "repairing", last_sha: old, round: 1 };
  task.mission = "当前目标是处理本轮流水线失败(1)。分支上提交 " + old + " 的权威流水线结果是 failed。[本轮流水线修复目标结束]";
  new TaskHostLedger(task.summary).update({ id: "pushed", input: { action: "push", reason: "发布修复" },
    state: "succeeded", sha, push_receipt: task.summary.delivery.git_push, at: new Date().toISOString() });
  await finishTaskHostOperation(service.taskHostRuntime(task));
  assert.equal(task.summary.status, "verifying"); assert.equal(task.summary.delivery.pipeline, "查询失败，正在重试");
  assert.equal(new TaskHostLedger(task.summary).read().operations.at(-1)?.state, "succeeded");
  f.outage(false); f.response({ runs: [{ sha, status: "running" }] });
  await until(() => task.summary.delivery.pipeline === "running"); assert.equal(f.triggers(), 0);
});
