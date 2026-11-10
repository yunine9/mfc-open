import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { TaskService } from "../src/taskService.ts";

function fixture() {
  const store = new AnnotationStore(join(mkdtempSync(join(tmpdir(), "annotation-race-")), "annotations.jsonl"));
  const item = store.add({ author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "返回值", note: "请说明返回值的含义", kind: "doc" });
  return { store, item };
}

for (const action of ["edit-draft", "drop-draft", "reopen", "edit-sent", "resolve", "reset"]) {
  test(`旧发送完成不能覆盖 ${action}，新授权仍能提交当前版本`, () => {
    const { store, item } = fixture();
    if (!action.endsWith("draft")) store.markSent([item.id], "requirement_review");
    if (action === "drop-draft") store.drop(item.id, "reviewer");
    else if (action.startsWith("edit")) store.edit(item.id, "后来补充的要求", "reviewer", true);
    else if (action === "reopen") store.reopen(item.id, "owner", undefined, true);
    else if (action === "reset") store.resetRequirementDelivery(item.id, "执行未完成");
    else store.resolveAsOwner(item.id, "owner", { revision: 0, outcome: "not_adopted", reason: "约定已经覆盖" });
    const before = store.list()[0];
    const history = store.history().length;
    assert.deepEqual(store.markSentFor([item], "interrupt"), []);
    assert.deepEqual(new AnnotationStore(store.path).list()[0], before);
    assert.equal(store.history().length, history, "晚到请求不能增加一条假送达记录");
    if (before.status === "draft") {
      assert.deepEqual(store.markSentFor([before], "interrupt", "reviewer"), [item.id]);
      assert.equal(store.list()[0].status, "sent");
    }
  });
}

for (const action of ["edit", "delete"]) {
  test(`发送请求未返回时${action}已交接意见，API 保留正在送出的原版`, async t => {
    const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "annotation-send-race-")),
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
    t.after(() => service.shutdown());
    const task = service.create("说明返回值", { account: "owner" });
    const state = (service as any).tasks.get(task.id);
    state.summary.status = "running";
    const store = (service as any).annotations(state) as AnnotationStore;
    const item = store.add({ author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "返回值", note: "请说明返回值的含义", kind: "doc" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    service.interrupt = async () => { await held; return service.get(task.id)!; };
    const sending = service.sendAnnotations(task.id, [item.id], "owner");
    try {
      if (action === "edit") assert.throws(() => service.editAnnotation(task.id, item.id, "新要求：补充返回值示例", "owner"), /已交给 Agent/);
      else assert.throws(() => service.dropAnnotation(task.id, item.id, "owner"), /已交给 Agent/);
    } finally { release(); }
    const result = await sending;
    assert.deepEqual(result.sent, [item.id]);
    assert.equal(store.list()[0].note, item.note);
    assert.equal(store.list()[0].status, "sent");
    assert.equal(store.history().filter((op) => op.op === "sent").length, 1);
  });
}
