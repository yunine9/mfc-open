import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrePushCommands, unfinishedPrePushTools } from "../src/prepushAgent.ts";
import { TaskService } from "../src/taskService.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

test("turn 结束后等待正在执行的命令，失败也能结束等待", async () => {
  const commands = new PrePushCommands();
  let finish!: () => void;
  const execution = commands.run(() => new Promise<void>(resolve => { finish = resolve; }));
  let drained = false;
  const wait = commands.drain().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish();
  await Promise.all([execution, wait]);
  assert.equal(drained, true);
  const failed = commands.run(async () => { throw new Error("interrupted"); });
  await Promise.all([assert.rejects(failed, /interrupted/), commands.drain()]);
});

test("工具完成按会话和调用匹配，不能拿其他会话的结果冒充", () => {
  const event = (sessionId: string, kind: SemanticEvent["kind"]): SemanticEvent => ({
    eventId: 1, taskId: "task-15", sessionId, ts: "now", kind,
    payload: { call_id: "same", name: "Bash", input: {} },
  });
  const pending = event("build-fix", "tool_requested");
  assert.deepEqual(unfinishedPrePushTools([
    pending, event("main", "tool_finished"),
  ]), [pending]);
  assert.deepEqual(unfinishedPrePushTools([
    pending, event("build-fix", "tool_finished"),
  ]), []);
});

for (const failure of ["slot", "revision", "runner", "passed", "cancelled"] as const) {
  test(`Build-Fix ${failure} 正确收口，不留下 preparing`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prepush-completion-"));
    try {
      const service = Object.create(TaskService.prototype) as any;
      const task = { cwd, summary: { id: "task-15", workspace: cwd,
        status: "running", requirement: "UT", delivery: {} } } as any;
      let reads = 0;
      service.prePushRevision = async () => {
        if (++reads > 1 && ["revision", "runner"].includes(failure)) throw new Error("revision unavailable");
        return { sha: "a".repeat(40), workspace_fingerprint: "clean" };
      };
      service.options = { prepush: { runner: async () => {
        if (failure === "runner") throw new Error("runner crashed");
        return { status: "passed", sha: "a".repeat(40), message: "ok" };
      } } };
      service.current = () => failure !== "cancelled";
      service.persist = () => {};
      service.effectiveCommitConvention = () => "";
      let released = false;
      service.acquirePrePushBuildSlot = async () => {
        if (failure === "slot") throw new Error("slot unavailable");
        return () => { released = true; };
      };
      assert.equal(await service.performPrePush(task, "feature", "main", 1), failure === "passed");
      assert.equal(task.summary.delivery.prepush.active_attempt, undefined);
      assert.equal(task.summary.delivery.prepush.state,
        failure === "passed" ? "passed" : "environment_error");
      assert.equal(task.summary.status,
        ["passed", "cancelled"].includes(failure) ? "running" : "failed");
      if (failure !== "slot") assert.equal(released, true);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
