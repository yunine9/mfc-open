import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { crossRepositoryUpdateContext } from "../src/crossRepositoryUpdates.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";

function fixture(t: TestContext, models?: ScriptedModelServer) {
  const options = {
    dataDir: mkdtempSync(join(tmpdir(), "mfc-broadcast-")), maxConcurrent: 0,
    provider: models ? "maeflow" : "test", model: models?.modelId ?? "test",
    modelsJson: models?.modelsJson() ?? {},
  };
  const service = new TaskService(options);
  t.after(() => service.shutdown());
  const parent = service.create("同一需求");
  const child = (name: string, blockedBy?: string[]) => service.create(name, {
    parentTaskId: parent.id, blockedBy,
  });
  const source = child("接口服务");
  const queued = child("网页服务", [source.id]);
  const internal = (id: string) => (service as any).tasks.get(id);
  return { service, options, parent, source, queued, child, internal };
}

test("无依赖边也广播整个需求，任一子任务都能发，排队顺序和状态不变", async (t) => {
  const { service, parent, source, queued, child, internal } = fixture(t);
  const sibling = child("独立子图");
  const outsider = service.create("另一个需求");
  const beforeQueue = [...(service as any).queue];
  const first = await service.publishCrossRepositoryUpdate(source.id, "owner", "status 增加 2=运行");
  assert.deepEqual(first.target_task_ids, [queued.id, sibling.id]);
  for (const id of [parent.id, source.id, queued.id, sibling.id]) {
    assert.equal(service.get(id)!.cross_repository_updates?.[0].id, first.id);
  }
  assert.equal(service.get(outsider.id)!.cross_repository_updates, undefined);
  assert.equal(service.get(queued.id)!.status, "queued");
  assert.deepEqual(service.get(queued.id)!.blocked_by, [source.id]);
  assert.deepEqual((service as any).queue, beforeQueue);
  const second = await service.publishCrossRepositoryUpdate(sibling.id, "other", "createTime 改为 int64");
  assert.deepEqual(second.target_task_ids, [source.id, queued.id]);
  assert.equal(internal(source.id).driver, undefined);
});

test("运行中即时入队；暂停、等人、已结束只记录；一个通知发送失败不影响其他任务", async (t) => {
  const { service, parent, source, child, internal } = fixture(t);
  const calls: string[] = [];
  internal(parent.id).summary.status = "running";
  internal(parent.id).driver = { steer: async () => { calls.push("parent"); }, abort: async () => {}, dispose() {} };
  for (const status of ["running", "paused", "waiting_for_human", "completed", "canceled"]) {
    const task = internal(child(status).id);
    task.summary.status = status;
    task.driver = { steer: async (text: string) => {
      calls.push(status); assert.match(text, /无关就继续/);
    }, abort: async () => {}, dispose() {} };
  }
  const broken = internal(child("broken").id);
  broken.summary.status = "running";
  broken.driver = { steer: async () => { throw Error("offline"); }, abort: async () => {}, dispose() {} };
  const update = await service.publishCrossRepositoryUpdate(source.id, "owner", "移除 taskName");
  assert.deepEqual(calls, ["parent", "running"]);
  for (const id of update.target_task_ids) {
    assert.equal(service.get(id)!.cross_repository_updates?.at(-1)?.id, update.id);
  }
  assert.equal(broken.summary.status, "running");
});

test("通知不重建已丢失 clone；投影文件不可写时直接提供完整正文", async (t) => {
  const { service, source, queued, internal } = fixture(t);
  await service.publishCrossRepositoryUpdate(source.id, "owner", "必须保留的接口通知");
  const task = internal(queued.id);
  task.cwd = join(queued.workspace, "missing-clone");
  writeFileSync(join(queued.workspace, ".mae-flow-work"), "阻止建立投影目录");
  const context = crossRepositoryUpdateContext(task);
  assert.match(context, /必须保留的接口通知/);
  assert.equal(existsSync(task.cwd), false);
  assert.equal(task.summary.status, "queued");
});

test("新建子任务补收全部历史，超过旧 5/10/30/100 条限制仍有完整文件", async (t) => {
  const { service, parent, source, child, internal } = fixture(t);
  const history = Array.from({ length: 105 }, (_, i) => ({
    id: `old-${i}`, parent_task_id: parent.id, source_task_id: source.id,
    author: "owner", text: `通知 ${i}：字段修订`, target_task_ids: [],
    created_at: new Date(1_700_000_000_000 + i).toISOString(),
  }));
  internal(parent.id).summary.cross_repository_updates = history;
  const late = child("后创建的子任务");
  assert.equal(late.cross_repository_updates?.length, 105);
  const context = crossRepositoryUpdateContext(internal(late.id));
  assert.match(context, /105 条/);
  const content = readFileSync(join(late.workspace, ".mae-flow-work", "cross-repository-updates.md"), "utf-8");
  assert.match(content, /通知 0：/);
  assert.match(content, /通知 104：/);
  assert.ok(service.get(parent.id)!.cross_repository_updates!.every((update) => update.target_task_ids.includes(late.id)));
  (service as any).syncCrossRepositoryUpdates(internal(late.id));
  assert.equal(service.get(late.id)!.cross_repository_updates?.length, 105, "补收按 ID 幂等");
});

test("重启补齐旧空目标及部分落盘，不丢子任务独有的历史，不激活排队任务", async (t) => {
  const { service, options, parent, source, queued } = fixture(t);
  await service.publishCrossRepositoryUpdate(source.id, "owner", "旧通知");
  await service.shutdown();
  // 模拟旧版父台账尚在，目标子任务没有收到；另一条仅剩子任务副本。
  const targetPath = join(queued.workspace, "task.json");
  const target = JSON.parse(readFileSync(targetPath, "utf-8"));
  target.summary.cross_repository_updates = [];
  writeFileSync(targetPath, JSON.stringify(target));
  const sourcePath = join(source.workspace, "task.json");
  const sourceDisk = JSON.parse(readFileSync(sourcePath, "utf-8"));
  sourceDisk.summary.cross_repository_updates.push({
    id: "child-only", parent_task_id: parent.id, source_task_id: source.id,
    author: "owner", text: "父账本已被旧版截断的通知", target_task_ids: [], created_at: "2026-09-09T00:00:00Z",
  });
  writeFileSync(sourcePath, JSON.stringify(sourceDisk));
  const restored = new TaskService(options);
  t.after(() => restored.shutdown());
  restored.recover();
  assert.equal(restored.get(queued.id)!.status, "queued");
  assert.equal(restored.get(queued.id)!.cross_repository_updates?.length, 2);
  assert.equal(restored.get(parent.id)!.cross_repository_updates?.length, 2);
});

test("真实排队启动：依赖未完成不运行，启动后的模型能读取最早与最新通知", async (t) => {
  const model = new ScriptedModelServer([
    { tool: { name: "read", input: { path: ".mae-flow-work/cross-repository-updates.md" } } },
    { text: "已核对所有协作通知。" },
  ]);
  await model.start();
  t.after(() => model.stop());
  const { service, options, source, queued, internal } = fixture(t, model);
  for (let i = 0; i < 12; i++) {
    await service.publishCrossRepositoryUpdate(source.id, "owner", `排队期间通知 ${i}：必须核对`);
  }
  options.maxConcurrent = 1;
  (service as any).queue = [queued.id];
  await (service as any).pump();
  assert.equal(model.requests.length, 0);
  assert.equal(service.get(queued.id)!.status, "queued");
  internal(source.id).summary.status = "completed";
  await (service as any).pump();
  const deadline = Date.now() + 10_000;
  while (model.requests.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(model.requests.length >= 2, service.get(queued.id)!.detail);
  assert.match(JSON.stringify(model.requests[0]), /cross-repository-updates\.md/);
  const readResult = JSON.stringify(model.requests[1]);
  assert.match(readResult, /排队期间通知 0/);
  assert.match(readResult, /排队期间通知 11/);
});
