/**
 * 历史破坏性操作：
 * - 责任人可原位清空真终态任务并从第一步重跑；
 * - 责任人可删除自己的真终态，管理员可兜底，其他人和在途任务被拒绝；
 * - 删除最高编号后重启也不得复用旧 task-N。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { Notifier } from "../src/notifier.ts";
import { TaskService } from "../src/taskService.ts";

test("从头重跑原位覆盖；责任人删除受归属与真终态双重约束", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-history-actions-"));
  const dataDir = join(root, "tasks");
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const notifier = new Notifier({
    endpoint: "http://127.0.0.1:1/notify",
    fake: true,
    backoffMs: [],
  });
  const service = new TaskService({
    dataDir,
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
    notifier,
  });
  const original = service.create("完整需求正文", {
    title: "需要重新做的任务",
    account: "alice",
    repairRounds: 3,
    requirementDocumentName: "原始需求.md",
  });
  writeFileSync(join(original.workspace, "old-result.txt"), "旧结果");
  const internal = (service as any).tasks.get(original.id);
  internal.summary.detail = "旧任务的失败现场";
  internal.summary.delivery = { pipeline: "failed", mr_url: "https://old/mr/1" };
  (service as any).reviews.create({
    taskId: original.id,
    taskTitle: original.title,
    requester: "alice",
    committer: "bob",
  });
  await notifier.notifyOutcome({
    taskId: original.id,
    account: "alice",
    status: "failed",
    summary: "旧任务失败",
    link: "",
  });
  (service as any).persist(internal);

  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function login(username: string, password: string): Promise<string> {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  }

  try {
    const [admin, alice, bob] = await Promise.all([
      login("admin", "administrator-pass"),
      login("alice", "alice-password-1"),
      login("bob", "bob-password-123"),
    ]);

    const activeDelete = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(activeDelete.status, 409, "排队中的任务不能伪装成历史被删除");
    const ownerActiveDelete = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: alice },
    });
    assert.equal(ownerActiveDelete.status, 409,
      "责任人也不能删除仍在执行的任务");

    internal.summary.status = "completed";
    internal.summary.completed_at = new Date().toISOString();
    (service as any).persist(internal);

    const foreignDelete = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: bob },
    });
    assert.equal(foreignDelete.status, 403, "不能删除别人的任务");

    const foreignRerun = await fetch(`${base}/tasks/${original.id}/rerun`, {
      method: "POST", headers: { cookie: bob },
    });
    assert.equal(foreignRerun.status, 403, "不能清空别人的任务");
    const adminRerun = await fetch(`${base}/tasks/${original.id}/rerun`, {
      method: "POST", headers: { cookie: admin },
    });
    assert.equal(adminRerun.status, 403, "管理员不能冒用开发者身份重跑");

    const rerun = await fetch(`${base}/tasks/${original.id}/rerun`, {
      method: "POST", headers: { cookie: alice },
    });
    assert.equal(rerun.status, 200, await rerun.text());
    const replacement = service.get(original.id)!;
    assert.equal(replacement.id, original.id, "同一任务编号必须原位覆盖");
    assert.equal(replacement.status, "queued");
    assert.equal(replacement.title, "需要重新做的任务");
    assert.equal(replacement.requirement, "完整需求正文");
    assert.equal(replacement.luban_account, "alice");
    assert.equal(replacement.repair_rounds, 3);
    assert.equal(replacement.requirement_document?.name, "原始需求.md");
    assert.equal(replacement.detail, undefined);
    assert.equal(replacement.delivery, undefined);
    assert.equal(existsSync(join(replacement.workspace, "old-result.txt")), false,
      "旧工作区内容不得混入新一轮");
    assert.equal((service as any).reviews.forTask(original.id).length, 0,
      "旧检视记录必须清掉");
    assert.equal(notifier.list().filter((item) =>
      item.task_id === original.id).length, 0,
    "旧通知幂等键必须清掉，不能吞掉新一轮通知");

    const queuedDelete = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(queuedDelete.status, 409);
    const replacementState = (service as any).tasks.get(original.id);
    replacementState.summary.status = "failed";
    (service as any).persist(replacementState);
    const dependent = service.create("仍引用旧任务的后续工作", {
      parentTaskId: original.id,
      blockedBy: [original.id],
    });
    await notifier.notifyOutcome({
      taskId: original.id,
      account: "alice",
      status: "failed",
      summary: "新一轮失败",
      link: "",
    });

    const referencedDelete = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: admin },
    });
    assert.equal(referencedDelete.status, 409,
      "不能因删除依赖任务而把仍在途的下游任务意外放行");
    const dependentState = (service as any).tasks.get(dependent.id);
    dependentState.summary.status = "completed";
    (service as any).persist(dependentState);

    const deleted = await fetch(`${base}/tasks/${original.id}`, {
      method: "DELETE", headers: { cookie: alice },
    });
    assert.equal(deleted.status, 200);
    const deletedBody = await deleted.json() as {
      deleted: boolean;
      notifications_removed: number;
    };
    assert.equal(deletedBody.deleted, true);
    assert.equal(deletedBody.notifications_removed, 1);
    assert.equal(service.get(original.id), undefined);
    assert.equal(existsSync(original.workspace), false);
    assert.equal(service.get(dependent.id)?.parent_task_id, undefined);
    assert.equal(service.get(dependent.id)?.blocked_by, undefined,
      "删除历史后其余任务不能留下悬空结构引用");
    assert.doesNotMatch(
      existsSync(join(dataDir, "reviews.jsonl"))
        ? readFileSync(join(dataDir, "reviews.jsonl"), "utf-8") : "",
      new RegExp(`"task_id":"${original.id}"`),
    );

    const restored = new TaskService({
      dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    });
    assert.deepEqual(restored.recover(), { restored: 1, requeued: 0 });
    assert.equal(restored.create("删除后的新任务").id, "task-3",
      "永久链接用过的编号在删除和重启后也不能复用");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("已拆出子任务的跨仓父单拒绝原位重跑，避免重复拆单", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-rerun-chain-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("跨仓需求");
  const internal = (service as any).tasks.get(created.id);
  internal.summary.status = "completed";
  internal.summary.requirement_graph = {
    stage: "confirmed",
    repositories: [
      { id: "repo-1", name: "A", url: "https://git/A.git", task_id: "task-8" },
      { id: "repo-2", name: "B", url: "https://git/B.git", task_id: "task-9" },
    ],
    dependencies: [],
  };
  (service as any).persist(internal);
  await assert.rejects(service.rerunFromStart(created.id), /重复拆单/);
  assert.equal(service.get(created.id)?.status, "completed");
});

test("同一任务的两个破坏性请求互斥，不能拿旧引用覆盖新现场", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-rerun-race-"));
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const created = service.create("并发重跑测试");
  const internal = (service as any).tasks.get(created.id);
  internal.summary.status = "failed";
  (service as any).persist(internal);

  const first = service.rerunFromStart(created.id);
  await assert.rejects(
    service.hardDeleteHistory(created.id),
    /正在准备继续修改、清空重跑或删除/,
  );
  const replacement = await first;
  assert.equal(replacement.id, created.id);
  assert.equal(service.get(created.id)?.status, "queued");
});
