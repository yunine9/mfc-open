import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { StartupRecovery } from "../src/startupRecovery.ts";
import { concurrentTicketConflict } from "../src/dependencyScheduling.ts";

function fixture(t: any) {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-startup-recovery-"));
  const service: any = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => service.shutdown());
  return { service, dataDir };
}

async function http(t: any, service: TaskService, startup: StartupRecovery) {
  const server = createTaskServer(service, { startup });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("恢复尚未完成时已监听，禁止半份索引接单；完成后健康检查与任务 API 正常", async t => {
  const { service } = fixture(t), startup = new StartupRecovery();
  const base = await http(t, service, startup);
  let finish!: () => void;
  const restoring = startup.run(() => new Promise<void>(resolve => { finish = resolve; }), () => {});
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 503); assert.deepEqual(await health.json(), { status: "recovering" });
  const create = await fetch(`${base}/tasks`, { method: "POST", body: JSON.stringify({ requirement: "must not create" }) });
  assert.equal(create.status, 503); assert.equal(create.headers.get("retry-after"), "3");
  assert.equal(service.tasks.size, 0);
  finish(); assert.equal(await restoring, true);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/tasks`)).status, 200);
});

test("恢复顶层异常不关闭监听，也不把恢复失败伪装成 ready", async t => {
  const { service } = fixture(t), startup = new StartupRecovery(), logs: string[] = [];
  const base = await http(t, service, startup);
  assert.equal(await startup.run(async () => { throw Error("索引不可读"); }, line => logs.push(line)), false);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { status: "failed" });
  assert.match(logs[0], /索引不可读/);
  assert.equal((await fetch(`${base}/tasks`, { method: "POST" })).status, 503);
});

test("单个反馈同步异常不阻断后续任务，也不撤销已完成状态", async t => {
  const { service, dataDir } = fixture(t), logs: string[] = [];
  for (const id of ["task-19", "task-20"]) {
    const workspace = join(dataDir, id); mkdirSync(workspace);
    writeFileSync(join(workspace, "task.json"), JSON.stringify({ summary: {
      id, workspace, requirement: "历史任务", status: "completed", created_at: new Date().toISOString(),
    } }));
  }
  service.options.log = (line: string) => logs.push(line);
  service.syncFeedbackStoreFromKernel = (task: any) => {
    if (task.summary.id === "task-19") throw Error("内核持续检视生命周期缺少完整的 Cloud 宿主权威收据");
  };
  const result = service.recover();
  assert.equal(result.restored, 2);
  assert.equal(service.get("task-19").status, "completed");
  assert.equal(service.get("task-20").status, "completed");
  assert.ok(logs.some(line => line.includes("缺少完整")));
  assert.ok(logs.some(line => line.includes("开始恢复任务 task-20")));
});

test("已完成任务的反馈投影不调用缺收据的内核，保留原状态和反馈原件", async t => {
  const { service, dataDir } = fixture(t), logs: string[] = [];
  const cwd = join(dataDir, "repo"); mkdirSync(cwd);
  const state = JSON.stringify({ current: "feedback_triage", delivery_loop: { batches: [{ batch_id: "legacy" }] } });
  writeFileSync(join(cwd, ".mae-flow.json"), state);
  service.options.host = { kernelRoot: join(dataDir, "unavailable-kernel") };
  service.options.log = (line: string) => logs.push(line);
  service.continuousReviewTask = () => true;
  const task = { cwd, summary: { id: "task-19", status: "completed", workspace: dataDir } };
  service.syncFeedbackStoreFromKernel(task, true);
  assert.deepEqual(logs, []); assert.equal(task.summary.status, "completed");
  assert.equal(readFileSync(join(cwd, ".mae-flow.json"), "utf8"), state);
});

test("排队展示不触发内核收据核验，真正调度仍核验同仓同号任务", async t => {
  const { service } = fixture(t);
  const first = service.create("done");
  const second = service.create("queued");
  const a = service.tasks.get(first.id), b = service.tasks.get(second.id);
  a.summary.repo_url = b.summary.repo_url = "/test/repo";
  a.summary.ticket = b.summary.ticket = "AR1";
  a.summary.status = "completed";
  service.queue = [second.id];
  let calls = 0;
  service.taskCompletionAttestation = () => { calls++; return { complete: false }; };
  assert.equal(service.get(second.id).queue_position, 1);
  assert.equal(calls, 0, "只读投影不能同步启动 Python");
  assert.equal(concurrentTicketConflict(service.dependencyHost(), b, service.queue), a);
  assert.equal(calls, 1, "真正调度仍拒绝缺少完成事实的同仓同 AR 并行");
  const host = service.dependencyHost();
  host.completed(a); host.completed(a);
  assert.equal(calls, 2, "同一轮裁决复用结果，下一轮重新核验");
  a.summary.repo_url = "/test/other-repo";
  assert.equal(concurrentTicketConflict(service.dependencyHost(), b, service.queue), undefined);
  assert.equal(calls, 2, "先排除不同仓，不能再为无关历史任务核验收据");
});

test("正式启动入口先监听后恢复，回收不抢在监听之前", () => {
  const source = readFileSync(join(process.cwd(), "src/executionRuntime.ts"), "utf8");
  assert.ok(source.indexOf("server.listen(port") < source.indexOf("startup.run(restoreTasks"));
  assert.match(source, /const recovered = await trace\.phase\("task_recovery", async \(\) => service\.recover\(\)\)/);
  assert.ok(source.indexOf("startup.run(restoreTasks") < source.indexOf("setImmediate(() => void sweepStorage())"));
});
