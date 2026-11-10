import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";

function fixture(versioned: boolean) {
  const service = new TaskService({ dataDir: mkdtempSync(join(tmpdir(), "decision-replay-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("核对接口", { account: "owner" });
  const state = (service as any).tasks.get(task.id);
  state.summary.status = "running";
  const store = (service as any).annotations(state) as AnnotationStore;
  const items = Array.from({ length: 4 }, (_, index) => store.add({ author: "owner",
    artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文", line: 1,
    anchor: "核对接口", note: `请修复第 ${index + 1} 项`, kind: "doc" }));
  const decide = (callId: string) => {
    const picked = store.drafts();
    const waiting = state.humanGate.createWaiting({ taskId: task.id, step: "review", callId,
      questionInput: { questions: [{ question: "是否继续", options: [{ label: "继续" }] }] } });
    return state.humanGate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version,
      decision: "继续", requestDigest: callId, continuation: {
        annotation_ids: picked.map((item) => item.id),
        ...(versioned ? { annotation_versions: picked.map((item) => ({
          id: item.id, revision: item.rework ?? 0, note: item.note,
        })) } : {}),
      } });
  };
  decide("first");
  return { service, task, state, store, items, decide };
}

for (const versioned of [false, true]) {
  const label = versioned ? "带版本决定" : "在途旧决定";
  test(`${label}：四条意见退回后，轮询不能重新 sent；新决定仍可送新版本`, async () => {
    const { service, task, store, items, decide } = fixture(versioned);
    service.listAnnotations(task.id); // 补齐决定落盘、sent 尚未落盘的崩溃窗口。
    assert.ok(store.list().every((item) => item.status === "sent"));
    for (const item of items) {
      // 已接手的意见先有 Agent 回执，责任人才可按现有规则重新处理。
      store.respond(item.id, { revision: 0, outcome: "fixed", summary: "本轮已修改", evidence: [] });
      await service.reopenAnnotation(task.id, item.id, "owner", 0);
      service.listAnnotations(task.id);
      await service.listAnnotationsAsync(task.id);
      assert.equal(store.list().find((one) => one.id === item.id)?.status, "draft");
    }
    const sentBefore = store.history().filter((op) => op.op === "sent").length;
    for (let index = 0; index < 4; index++) await service.listAnnotationsAsync(task.id);
    assert.equal(store.history().filter((op) => op.op === "sent").length, sentBefore);
    assert.ok(store.list().every((item) => item.rework === 1 && item.returned === 1));
    // 下一次真实决定可以授权新一轮；不得因防重放让合法重提也失效。
    if (versioned) {
      decide("second");
      service.listAnnotations(task.id);
      assert.ok(store.list().every((item) => item.status === "sent"));
    }
  });

  for (const mutation of ["edit", "reset", "draft-edit"] as const) {
    test(`${label}：${mutation} 后旧决定不能把新内容冒充已送达`, () => {
      const { service, task, store, items } = fixture(versioned);
      const item = items[0];
      if (mutation !== "draft-edit") service.listAnnotations(task.id);
      if (mutation === "reset") {
        store.markSent([item.id], "requirement_review");
        store.resetRequirementDelivery(item.id, "需求修订未完成");
      } else store.edit(item.id, "后来补充的新内容", "owner", true);
      service.listAnnotations(task.id);
      assert.equal(store.list().find((one) => one.id === item.id)?.status, "draft");
    });
  }
}
