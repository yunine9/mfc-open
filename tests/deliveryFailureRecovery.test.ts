import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { TaskService } from "../src/taskService.ts";
import { projectPipelineRun } from "../src/pipelineHandoff.ts";

const error = "交付动作失败: 流水线查询失败（HTTP 502）";

function fixture(t: { after(fn: () => Promise<void>): void }, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "delivery-recovery-384-"));
  const service: any = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, ...options });
  t.after(async () => { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const summary = service.create("恢复交付错误");
  const task = service.tasks.get(summary.id);
  task.summary.status = "verifying";
  task.summary.delivery = { sha: "head", mr_url: "http://platform/mr/1",
    git_push: { sha: "head", ref: "refs/heads/work", remote: "origin" }, skipped: error };
  return { service, task, dir };
}

test("正式验证接棒清除旧交付错误；后台验证不清除正在处理的交付阻塞", () => {
  for (const background of [false, true]) {
    const task: any = { summary: { status: "verifying", delivery: { skipped: error, git_push: { sha: "head" } } } };
    projectPipelineRun(task, "head", { sha: "head", status: "running" }, background);
    assert.equal(task.summary.delivery.skipped, background ? error : undefined);
  }
});

test("新停摆原因替代旧 502，重复观察同一原因不重复通知", async t => {
  const { service, task } = fixture(t);
  const notices: string[] = [];
  service.notifyVerificationStalled = (_task: unknown, reason: string) => notices.push(reason);
  service.markVerificationStalled(task, "平台连接失败", "infrastructure");
  service.markVerificationStalled(task, "MR 源分支已经变化", "safety");
  service.markVerificationStalled(task, "MR 源分支已经变化", "safety");
  assert.equal(task.summary.delivery.skipped, undefined);
  assert.equal(task.summary.delivery.stalled, "MR 源分支已经变化");
  assert.equal(task.summary.delivery.waiting_on, "MR 源分支已经变化");
  assert.equal(task.summary.delivery.stall_class, "safety");
  assert.deepEqual(notices, ["平台连接失败", "MR 源分支已经变化"]);
});

test("502 后常规轮询恢复即可清除旧错误，不必再次推送", async t => {
  let calls = 0;
  const server = createServer((_req, res) => {
    calls++;
    res.setHeader("content-type", "application/json");
    res.statusCode = calls === 1 ? 502 : 200;
    res.end(JSON.stringify(calls === 1 ? { error: "temporary" } : { runs: [{ sha: "head", status: "success" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const { service, task } = fixture(t, { delivery: { platformUrl: `http://127.0.0.1:${(server.address() as any).port}`, pollIntervalMs: 5 } });
  service.pipelineVerdict = async () => {
    assert.equal(task.summary.delivery.skipped, undefined);
    assert.equal(task.summary.delivery.pipeline, "success");
  };
  await service.pollPipeline(task, task.controlEpoch);
  assert.equal(calls, 2);
  const saved = JSON.parse(readFileSync(join(task.summary.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.delivery.skipped, undefined);
});

test("核销成功后不再展示旧错误，迟到旧版本结果不能清除当前错误", async t => {
  const { service, task } = fixture(t);
  service.recordPipelineEvidence = async () => ({ verdict: "PASS" });
  service.syncFeedbackStoreFromKernel = () => {};
  service.deliveryReadyAttestation = () => ({ complete: true });
  service.ensureMergeWatch = () => {};
  await service.pipelineVerdict(task, "old", "success", "", undefined, task.controlEpoch);
  assert.equal(task.summary.delivery.skipped, error);
  await service.pipelineVerdict(task, "head", "success", "", undefined, task.controlEpoch);
  assert.equal(task.summary.status, "await_merge");
  assert.equal(task.summary.delivery.skipped, undefined);
});

for (const status of ["await_merge", "completed", "verifying"] as const) test(`重启清理旧任务残留错误（${status}），保留真实停摆`, async t => {
  const { service, task, dir } = fixture(t);
  task.summary.status = status;
  task.summary.delivery.stalled = status === "verifying" ? "源分支变化" : undefined;
  task.summary.delivery.stall_class = status === "verifying" ? "safety" : undefined;
  service.persist(task);
  await service.shutdown();
  const restored: any = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  t.after(() => restored.shutdown());
  restored.recover();
  const delivery = restored.get(task.summary.id).delivery;
  assert.equal(delivery.skipped, undefined);
  assert.equal(delivery.stalled, status === "verifying" ? "源分支变化" : undefined);
  const saved = JSON.parse(readFileSync(join(task.summary.workspace, "task.json"), "utf8"));
  assert.equal(saved.summary.delivery.skipped, undefined);
});
