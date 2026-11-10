import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudSession } from "../src/sessionDriver.ts";
import { TaskService } from "../src/taskService.ts";
import { TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";

test("需求修订实际服务链等待两小时也不取消；收到完整回执后才覆盖原文", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-review-lifetime-")),
    provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
  });
  const task = service.create("第一段旧口径", {
    account: "owner", requirementAnalysis: true, requirementAnalysisConfirmation: true,
  });
  const note = service.addAnnotation(task.id, {
    author: "owner", artifact: TASK_REQUIREMENT_ARTIFACT, file: "需求原文",
    line: 1, anchor: "第一段旧口径", note: "改成第一段新口径", kind: "doc",
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let aborts = 0;
  t.mock.method(CloudSession, "create", async (options: { workspace: string }) => ({
    start: async () => {
      started();
      await held;
      writeFileSync(join(options.workspace, "requirement.md"), "第一段新口径");
      writeFileSync(join(options.workspace, "receipts.json"), JSON.stringify([{
        annotation_id: note.id, outcome: "fixed", summary: "已修改指定段落",
        evidence: ["requirement.md:1"],
      }]));
      return { status: "turn_finished" };
    },
    abort: async () => { aborts++; },
    dispose: () => undefined,
  }));
  const pending = service.sendAnnotations(task.id, [note.id], "owner");
  await entered;
  t.mock.timers.tick(2 * 60 * 60_000);
  assert.equal(aborts, 0, "实际修订入口不能保留五分钟或其他整轮取消计时器");
  assert.equal(service.get(task.id)?.requirement, "第一段旧口径");
  assert.equal(service.get(task.id)?.requirement_revision?.state, "running");
  finish();
  await pending;
  assert.equal(service.get(task.id)?.requirement, "第一段新口径");
  assert.equal(service.listAnnotations(task.id).items[0].response?.outcome, "fixed");
});
