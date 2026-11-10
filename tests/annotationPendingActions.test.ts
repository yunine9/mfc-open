import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { annotationClosure } from "../src/feedbackPolicy.ts";
import { TaskService } from "../src/taskService.ts";

test("记下可修改，重新处理恢复修改与删除；已接手和旁观者不可删除", async () => {
  const dir = mkdtempSync(join(tmpdir(), "annotation-actions-"));
  try {
    const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
    const task = service.create("同步接口返回值");
    const state = (service as any).tasks.get(task.id);
    state.summary.luban_account = "owner";
    state.summary.status = "waiting_for_human";
    const store = (service as any).annotations(state) as AnnotationStore;
    const note = store.add({ author: "reviewer", artifact: TASK_REQUIREMENT_ARTIFACT,
      file: "需求原文", line: 1, anchor: "同步接口返回值", note: "说明超时", kind: "doc" });
    const closure = (username = "owner") => annotationClosure(store.list()[0], {
      task_status: "waiting_for_human", task_owner: "owner", owner_controlled: true,
      review_ready: true, review_annotation_ids: [], archival: false,
    }, { username, can_override: false, can_route_others: true });
    assert.equal(closure().can_edit, true);
    assert.equal(closure("reviewer").can_edit, false);
    service.editAnnotation(task.id, note.id, "说明超时及重试次数", "owner");
    assert.equal(store.list()[0].note, "说明超时及重试次数");
    assert.equal(store.list()[0].status, "draft", "修改不会自行发送");
    store.assignToAgent(note.id, "owner", "旧轮补充");
    store.markSent([note.id], "interrupt", "owner");
    assert.equal(closure().can_delete, false);
    assert.equal(closure().can_edit, false);
    assert.throws(() => service.editAnnotation(task.id, note.id, "不能修改已送出版本", "owner"), /等待答复/);
    assert.throws(() => service.dropAnnotation(task.id, note.id, "owner"), /不能删除/);
    store.respond(note.id, { outcome: "fixed", summary: "已补充", evidence: [] });
    store.resolveAsOwner(note.id, "owner", { revision: store.list()[0].rework ?? 0, outcome: "fixed", reason: "" });
    await service.reopenAnnotation(task.id, note.id, "owner", store.list()[0].rework ?? 0);
    const replayed = new AnnotationStore(store.path).list()[0];
    assert.equal(replayed.agent_assigned, undefined);
    assert.equal(replayed.agent_context, undefined);
    assert.equal(closure().can_edit, true);
    assert.equal(closure().can_delete, true);
    assert.equal(closure("reviewer").can_delete, false);
    assert.ok(store.history().some(op => op.op === "sent"), "上一轮送达历史保留");
    service.editAnnotation(task.id, note.id, "重新补充异常场景", "owner");
    assert.equal(service.dropAnnotation(task.id, note.id, "owner").status, "dropped");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
