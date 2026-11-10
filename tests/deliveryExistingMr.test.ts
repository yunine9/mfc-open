import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";

async function fixture(t: TestContext, state: string, status: number | number[] = 200) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const code = Array.isArray(status) ? status[Math.min(requests.length - 1, status.length - 1)] : status;
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ mr_state: state, sha: "abc123", gates: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-existing-mr-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, pollIntervalMs: 50, pollTimeoutMs: 2000 },
  });
  t.after(async () => {
    await service.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const id = service.create("task-40：旧 MR 已合入后重跑续推").id;
  const internal = (service as any).tasks.get(id);
  internal.summary.status = "verifying";
  internal.summary.delivery = {
    mr_url: "https://codehub.test/repo/merge_requests/420", mr_id: 420,
    source_branch: "feature", target_branch: "master", sha: "abc123",
    mr_state: "验证中", stalled: "宿主推送失败: remote rejected",
  };
  const work: string[] = [];
  (service as any).absorbForeignRemoteCommits = async () => {
    work.push("rebase");
    return "blocked";
  };
  return { service, internal, id, requests, work };
}

test("重跑续推先查旧 MR：远端已合入直接完成，无 push/MR/流水线写请求", async (t) => {
  const { service, internal, id, requests, work } = await fixture(t, "merged");
  service.retry(id);
  const deadline = Date.now() + 5_000;
  while (internal.summary.status !== "completed" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(internal.summary.status, "completed");
  assert.equal(internal.summary.delivery.mr_state, "已合入");
  assert.equal(internal.summary.delivery.mr_id, 420);
  assert.equal(internal.summary.delivery.stalled, undefined);
  assert.deepEqual(work, [], "合入检测必须早于本地 rebase 和 Build-Fix");
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^GET \/mr\/gates\?.*mr=420/);
});

test("只有 MR URL 也查询指定旧 MR，不依赖已删除的远端分支", async (t) => {
  const { service, internal, requests } = await fixture(t, "merged");
  delete internal.summary.delivery.mr_id;
  delete internal.summary.delivery.source_branch;
  delete internal.summary.delivery.target_branch;
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.equal(internal.summary.status, "completed");
  const query = new URL(requests[0].slice(4), "http://test").searchParams;
  assert.equal(query.get("mr"), "420", "标准 MR URL 优先提取项目内编号");
});

test("旧 MR 仍打开才继续原交付链", async (t) => {
  const { service, internal, requests, work } = await fixture(t, "opened");
  internal.cwd = join(internal.summary.workspace, "repo");
  mkdirSync(internal.cwd);
  writeFileSync(join(internal.cwd, ".mae-flow.json"), JSON.stringify({
    config: { "分支名": "feature", "基线分支": "master" },
  }));
  (service as any).options.host = { kernelRoot: "unused", python: "python3" };
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.deepEqual(work, ["rebase"]);
  assert.equal(requests.length, 1);
  assert.notEqual(internal.summary.status, "completed");
});

for (const [name, state, status] of [
  ["凭据失效", "opened", 401],
  ["没有权限", "opened", 403],
  ["端点未配置", "opened", 404],
  ["生命周期未知", "unknown", 200],
] as const) {
  test(`${name}不能当作旧 MR 仍打开而重新交付`, async (t) => {
    const { service, internal, requests, work } = await fixture(t, state, status);
    internal.summary.delivery.stalled = undefined; // retry 入口先清掉上次事故
    await (service as any).tryDeliver(internal, internal.controlEpoch);
    assert.equal(internal.summary.status, "verifying");
    assert.match(internal.summary.delivery.stalled, /无法确认已有 MR.*停止续推/);
    assert.deepEqual(work, []);
    assert.notEqual(internal.deliveryRecoveryActive, true);
    assert.equal(requests.length, 1);
  });
}

test("远端关闭的 MR 进入等待处理，不能自动新建", async (t) => {
  const { service, internal, requests, work } = await fixture(t, "closed");
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.equal(internal.summary.delivery.mr_state, "已关闭");
  assert.equal(internal.summary.status, "await_merge");
  assert.deepEqual(work, []);
  assert.equal(requests.length, 1);
});

test("外部合入新 SHA 直接完成，保留旧验证而不重推或新建 MR", async (t) => {
  const { service, internal, requests, work } = await fixture(t, "merged");
  internal.summary.delivery.sha = "different";
  internal.summary.delivery.stalled = undefined;
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.equal(internal.summary.status, "completed");
  assert.equal(internal.summary.delivery.sha, "different");
  assert.equal(internal.summary.delivery.merged_sha, "abc123");
  assert.equal(internal.summary.delivery.stalled, undefined);
  assert.equal(internal.summary.delivery.mr_id, 420);
  assert.deepEqual(work, []);
  assert.equal(requests.length, 1);
});


test("回执发布失败不能挡住外部合入监听及 writer 停止", async (t) => {
  const { service, internal, work } = await fixture(t, "merged");
  const stopped: string[] = [];
  internal.summary.delivery.loop = { round: 1, state: "repairing" };
  internal.driver = { abort: async () => { stopped.push("agent"); }, dispose() {} };
  internal.container = { stop: async () => { stopped.push("container"); } };
  internal.prepushAbort = { abort: () => { stopped.push("build-fix"); } };
  (service as any).flushReviewReplyOutbox = async () => false;
  await (service as any).watchMerge(internal, internal.controlEpoch);
  assert.equal(internal.summary.status, "completed");
  assert.deepEqual(stopped.sort(), ["agent", "build-fix", "container"]);
  assert.equal(internal.summary.delivery.loop.state, "merged");
  assert.deepEqual(work, []);
});


for (const status of [408, 429, 503]) {
  test(`MR 查询 HTTP ${status} 后自动重查，已合入则收口且不产生写请求`, async t => {
    const { service, internal, requests, work } = await fixture(t, "merged", [status, 200]);
    internal.summary.delivery.stalled = undefined;
    // Push receipt and old pipeline result must survive a read-side failure.
    internal.summary.delivery.git_push = { sha: "already-pushed", ref: "feature" };
    internal.summary.delivery.pipeline = "failed";
    await (service as any).tryDeliver(internal, internal.controlEpoch);
    assert.equal(internal.summary.delivery.stalled, undefined);
    assert.match(internal.summary.delivery.waiting_on, /自动重试/);
    assert.equal(internal.deliveryRecoveryActive, true);
    const deadline = Date.now() + 3000;
    while (internal.summary.status !== "completed" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(internal.summary.status, "completed");
    assert.equal(internal.summary.delivery.git_push.sha, "already-pushed");
    assert.equal(internal.summary.delivery.pipeline, "failed", "不能伪造流水线 PASS");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.startsWith("GET /mr/gates?") && r.includes("mr=420")));
    assert.deepEqual(work, []);
  });
}

test("MR 查询持续失败沿用同一恢复预算，耗尽后明确停摆", async t => {
  const { service, internal, requests, work } = await fixture(t, "opened", 503);
  internal.summary.delivery.stalled = undefined;
  internal.summary.delivery.verify_deadline = new Date(Date.now() - 1000).toISOString();
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.equal(internal.summary.delivery.stall_class, "infrastructure");
  assert.match(internal.summary.delivery.stalled, /HTTP 503/);
  assert.notEqual(internal.deliveryRecoveryActive, true);
  assert.deepEqual(work, []);
  assert.equal(requests.length, 1);
});

test("MR 重查排队期间取消任务，旧恢复回调不能继续交付", async t => {
  const { service, internal, requests, work } = await fixture(t, "opened", 503);
  internal.summary.delivery.stalled = undefined;
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  internal.controlEpoch += 1;
  internal.summary.status = "canceled";
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests.length, 1);
  assert.deepEqual(work, []);
  assert.equal(internal.summary.status, "canceled");
});


test("MR 瞬时失败后仍为 opened，自动回到原交付链", async t => {
  const { service, internal, requests, work } = await fixture(t, "opened", [503, 200]);
  internal.summary.delivery.stalled = undefined;
  internal.cwd = join(internal.summary.workspace, "repo");
  mkdirSync(internal.cwd);
  writeFileSync(join(internal.cwd, ".mae-flow.json"), JSON.stringify({
    config: { "分支名": "feature", "基线分支": "master" },
  }));
  (service as any).options.host = { kernelRoot: "unused", python: "python3" };
  await (service as any).tryDeliver(internal, internal.controlEpoch);
  assert.deepEqual(work, [], "查询失败期间不能写仓");
  const deadline = Date.now() + 3000;
  while (!work.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(work, ["rebase"]);
  assert.equal(requests.length, 2);
  assert.equal(internal.summary.delivery.stalled, undefined);
});
