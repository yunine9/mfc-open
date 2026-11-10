import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ReviewStore } from "../src/reviews.ts";
import { TaskService } from "../src/taskService.ts";
import { Notifier } from "../src/notifier.ts";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";

test("取消只关闭本任务待检视邀请，保留已完成历史且迟到通知不能复活邀请", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-review-cancel-store-")), "reviews.jsonl");
  const store = new ReviewStore(path);
  const add = (taskId: string, committer: string) => store.create({
    taskId, taskTitle: "任务", requester: "owner", committer,
  });
  const pending = add("task-1", "a");
  const done = add("task-1", "b");
  const other = add("task-2", "a");
  store.complete(done.id, "b");
  store.cancelTask("task-1");
  const before = readFileSync(path, "utf-8");
  store.cancelTask("task-1");
  assert.equal(readFileSync(path, "utf-8"), before, "重复取消不重复记账");
  assert.equal(store.delivery(pending.id, { delivered: true, attempts: 1 }).status, "canceled");
  assert.equal(store.complete(pending.id, "a").status, "canceled");
  const reloaded = new ReviewStore(path);
  const records = reloaded.list();
  assert.equal(records.find((item) => item.id === pending.id)?.completed_at, undefined);
  assert.ok(records.find((item) => item.id === pending.id)?.canceled_at);
  assert.equal(records.find((item) => item.id === done.id)?.status, "completed");
  assert.equal(records.find((item) => item.id === other.id)?.status, "pending");
});

test("责任人通过 HTTP 取消后，多人检视收件箱清空；旧完成按钮不受未闭环批注阻塞", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mfc-review-cancel-http-"));
  const notifier = new Notifier({ endpoint: "http://127.0.0.1:1" });
  t.mock.method(notifier, "notifyReview", async () => ({ delivered: true, attempts: 1 }));
  const outcome = t.mock.method(notifier, "notifyOutcome", async () => ({ delivered: true, attempts: 1 }));
  const service = new TaskService({ dataDir: join(root, "tasks"),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, notifier });
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  for (const username of ["owner", "bob", "carol"]) {
    auth.createUser(username, "password-for-test", "developer");
    if (username !== "owner") auth.setCommitter(username, true);
  }
  const task = service.create("检视后取消", { account: "owner" });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string) => {
    const response = await fetch(`${base}/auth/login`, { method: "POST",
      body: JSON.stringify({ username, password: "password-for-test" }) });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    const owner = await login("owner"), bob = await login("bob"), carol = await login("carol");
    const ids: string[] = [];
    for (const committer of ["bob", "carol"]) {
      const invited = await fetch(`${base}/tasks/${task.id}/review-request`, {
        method: "POST", headers: { cookie: owner }, body: JSON.stringify({ committer }),
      });
      assert.equal(invited.status, 200);
      ids.push((await invited.json() as { id: string }).id);
      service.addAnnotation(task.id, { author: committer, artifact: "spec.md", file: "spec.md",
        line: 1, anchor: "原文", note: "未完成的意见", kind: "doc" });
    }
    const canceled = await fetch(`${base}/tasks/${task.id}/cancel`, {
      method: "POST", headers: { cookie: owner }, body: "{}",
    });
    assert.equal(canceled.status, 200);
    assert.equal(new ReviewStore(join(root, "tasks", "reviews.jsonl")).list()
      .filter((item) => item.status === "pending").length, 0, "取消时即落盘，无需等待刷新");
    const notifications = outcome.mock.callCount();
    for (const [index, cookie] of [bob, carol].entries()) {
      const inbox = await fetch(`${base}/reviews/mine`, { headers: { cookie } });
      const records = await inbox.json() as Array<{ status: string }>;
      assert.deepEqual(records.map((item) => item.status), ["canceled"]);
      const completed = await fetch(`${base}/reviews/${ids[index]}/complete`, {
        method: "POST", headers: { cookie },
      });
      assert.equal(completed.status, 200);
      assert.equal((await completed.json() as { status: string }).status, "canceled");
    }
    assert.equal(outcome.mock.callCount(), notifications, "取消不能发送虚假的检视完成通知");
    const forbidden = await fetch(`${base}/reviews/${ids[0]}/complete`, {
      method: "POST", headers: { cookie: carol },
    });
    assert.equal(forbidden.status, 403);
    const reinvite = await fetch(`${base}/tasks/${task.id}/review-request`, {
      method: "POST", headers: { cookie: owner }, body: JSON.stringify({ committer: "bob" }),
    });
    assert.equal(reinvite.status, 409);
    assert.match(await reinvite.text(), /任务已取消/);

    // 模拟旧版本的遗留邀请，更新服务后正常读取即修复并持久化，无需删库。
    const legacy = new ReviewStore(join(root, "tasks", "reviews.jsonl")).create({
      taskId: task.id, taskTitle: "旧邀请", requester: "owner", committer: "bob",
    });
    const restored = new TaskService({ ...service.options, notifier: undefined });
    restored.recover();
    assert.equal(restored.listTaskReviews(task.id).find((item) => item.id === legacy.id)?.status, "canceled");
    assert.ok(restored.listReviewsFor("bob").every((item) => item.status === "canceled"));
    assert.equal(new ReviewStore(join(root, "tasks", "reviews.jsonl")).list()
      .find((item) => item.id === legacy.id)?.status, "canceled");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

for (const status of ["completed", "canceled"] as const) test(`邀请通知尚未返回时任务变为 ${status}，迟到的发送回执仍返回已关闭`, async (t) => {
  const notifier = new Notifier({ endpoint: "http://127.0.0.1:1" });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(notifier, "notifyReview", async () => {
    await held;
    return { delivered: true, attempts: 1 };
  });
  t.mock.method(notifier, "notifyOutcome", async () => ({ delivered: true, attempts: 1 }));
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "mfc-review-cancel-race-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0, notifier });
  const task = service.create("通知在途", { account: "owner" });
  const pending = service.requestReview(task.id, "owner", "bob");
  try {
    if (status === "canceled") await service.cancel(task.id, "owner");
    else {
      const internal = (service as any).tasks.get(task.id);
      internal.summary.status = status;
      (service as any).persist(internal);
    }
  } finally { release(); }
  assert.equal((await pending).status, "canceled");
  assert.equal(service.listReviewsFor("bob")[0].status, "canceled");
});

test("重启读取已完成任务的遗留邀请会持久关闭，失败和暂停任务仍可检视", async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-review-completed-recover-"));
  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const path = join(dataDir, "reviews.jsonl");
  const reviews = new ReviewStore(path);
  const ids: Record<string, string> = {};
  for (const status of ["completed", "failed", "paused"]) {
    const task = service.create(status);
    ids[status] = task.id;
    const taskPath = join(task.workspace, "task.json");
    const stored = JSON.parse(readFileSync(taskPath, "utf8"));
    stored.summary.status = status;
    writeFileSync(taskPath, JSON.stringify(stored));
    reviews.create({ taskId: task.id, taskTitle: status, requester: "owner", committer: "bob" });
  }
  const restored = new TaskService(service.options);
  t.after(async () => { await restored.shutdown(); await service.shutdown(); rmSync(dataDir, { recursive: true, force: true }); });
  restored.recover();
  const records = restored.listReviewsFor("bob");
  assert.equal(records.find(row => row.task_id === ids.completed)?.status, "canceled");
  assert.equal(records.find(row => row.task_id === ids.completed)?.completed_at, undefined);
  assert.equal(records.find(row => row.task_id === ids.failed)?.status, "pending");
  assert.equal(records.find(row => row.task_id === ids.paused)?.status, "pending");
  const saved = readFileSync(path, "utf8");
  restored.listReviewsFor("bob");
  assert.equal(readFileSync(path, "utf8"), saved, "旧记录只关闭一次");
  assert.equal(new ReviewStore(path).forTask(ids.completed)[0].status, "canceled");
});
