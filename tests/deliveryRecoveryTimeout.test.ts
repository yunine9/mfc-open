import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { reconcileRemoteDelivery } from "../src/remoteDeliveryReconcile.ts";
import { fetchMrGates } from "../src/mrGateClient.ts";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => unknown) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await pause(5);
  assert.ok(check(), "恢复或停摆未按预算完成");
}
async function fixture(t: TestContext, handler: RequestListener, budget = 1000) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "mfc-554-"));
  const service: any = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pollIntervalMs: 50, pollTimeoutMs: budget } });
  const task = service.tasks.get(service.create("挂起核验仍能恢复").id);
  task.summary.status = "verifying";
  task.summary.delivery = { mr_id: 42, mr_url: "https://example.test/repo/merge_requests/42", source_branch: "feature", target_branch: "main", sha: "head" };
  const notices: string[] = [];
  service.notifyVerificationStalled = (_task: unknown, reason: string) => notices.push(reason);
  t.after(async () => { await service.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return { service, task, notices };
}

test("#554：502 后单次查询挂起，超时释放锁后恢复原交付", async t => {
  let calls = 0;
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", ms => timeout(Math.min(Number(ms), 50)));
  const { service, task, notices } = await fixture(t, (_req, res) => {
    calls++;
    if (calls === 2) return;
    res.writeHead(calls === 1 ? 502 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mr_state: "merged", sha: "head", gates: [] }));
  });
  await service.tryDeliver(task, task.controlEpoch);
  await until(() => task.summary.status === "completed");
  assert.equal(calls, 3);
  assert.equal(task.deliveryActive, false);
  assert.equal(task.summary.delivery.stalled, undefined);
  assert.deepEqual(notices, []);
});

test("#554：重试本身永不返回，总预算仍独立停摆并通知一次", async t => {
  const { service, task, notices } = await fixture(t, () => {}, 120);
  service.tryDeliver = async () => new Promise(() => {});
  service.holdWithRecovery(task, "HTTP 502；系统正在自动重试", task.controlEpoch);
  await until(() => task.summary.delivery.stalled);
  assert.equal(task.summary.delivery.stall_class, "infrastructure");
  assert.equal(notices.length, 1);
  await pause(100);
  assert.equal(notices.length, 1);
});

test("#554：真实 HTTP 请求挂起到预算截止后终止，迟到结果不能覆盖停摆", async t => {
  let calls = 0;
  const { service, task, notices } = await fixture(t, (_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(502); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.write('{"mr_state":'); }
  }, 180);
  await service.tryDeliver(task, task.controlEpoch);
  await until(() => task.summary.delivery.stalled && !task.deliveryActive);
  assert.equal(notices.length, 1);
  assert.equal(task.summary.delivery.stall_class, "infrastructure");
  assert.doesNotMatch(task.summary.detail, /系统正在自动重试/);
  const count = calls;
  await pause(100);
  assert.equal(calls, count);
  assert.equal(notices.length, 1);
});

test("#554：过期预算回调不能改变已取消任务", async t => {
  const { service, task, notices } = await fixture(t, () => {}, 100);
  service.holdWithRecovery(task, "HTTP 502", task.controlEpoch);
  task.summary.status = "canceled"; task.controlEpoch++;
  await pause(180);
  assert.equal(task.summary.status, "canceled");
  assert.deepEqual(notices, []);
});

test("#554：下游忽略超时信号仍释放核验单飞锁，迟到查询不能应用", async () => {
  const summary: any = { status: "verifying", delivery: { mr_id: 42 }, workspace: "/tmp" };
  let finish!: (value: any) => void;
  let persisted = 0;
  const host = { summary, repo: "repo", headers: {}, readTimeoutMs: 30, current: () => true,
    persist() { persisted++; }, watch() {}, published() {}, settle: async () => {}, retirePushQuestion() {},
    observe: async () => ({ head: "head", url: "https://example.test" }),
    gates: () => new Promise<any>(resolve => { finish = resolve; }) };
  // 让测试有活动句柄；AbortSignal.timeout 自身不保持进程存活。
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(reconcileRemoteDelivery(host), /timeout/i);
    const next = await reconcileRemoteDelivery({ ...host, gates: async () => ({ mrState: "opened" as const, gates: [] }) });
    assert.equal(next.proceed, true);
    finish({ mrState: "merged", gates: [] }); await pause(10);
    assert.equal(persisted, 0);
    assert.equal(summary.status, "verifying");
  } finally { clearTimeout(keepAlive); }
});

test("#554：响应头已到但 JSON 永不返回且忽略 signal，MR 客户端仍结束查询", async t => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", () => timeout(30));
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: () => new Promise(() => {}) }) as any);
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    let failure = "";
    const result = await fetchMrGates({ platformUrl: "http://example.test", repo: "repo", headers: {}, delivery: { mr_id: 42 }, requireExisting: true, onFailure: reason => { failure = reason; } });
    assert.equal(result, undefined);
    assert.match(failure, /timeout/i);
  } finally { clearTimeout(keepAlive); }
});
