/**
 * 检视闭环的回执契约(2026-08-30 审计补):
 * - 邀请侧本来就通知 committer(notifyReview);
 * - 收口侧曾静默——committer 点完"完成检视",发起人只能反复刷页面
 *   或线下问。现在 completeReview 给发起人一条回执。
 * - 决定落账记操作人(decided_by),重启后仍可追责。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { HumanGate } from "../src/humanGate.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 40));
  }
}

test("检视完成回执:committer 点完成,发起人收到通知", async () => {
  const luban = new FakeLubanServer();
  await luban.start();
  try {
    const notifier = new Notifier({ endpoint: luban.endpoint });
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-review-receipt-")),
      provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
      notifier,
    });
    const id = service.create("回执演练").id;
    const review = await service.requestReview(id, "alice", "bob");
    await until(() => luban.messages.length >= 1, "邀请通知送达");
    const invites = luban.messages.length;
    const draft = service.addAnnotation(id, {
      author: "bob", artifact: "spec.md", file: "spec.md", line: 1,
      anchor: "原文", note: "这里需要补边界说明", kind: "doc",
    });
    assert.throws(() => service.completeReview(review.id, "bob"),
      /草稿尚未提交或删除/,
      "不能一边留着自己的未提交意见，一边声称检视已经完成");
    const internal = (service as any).tasks.get(id);
    (service as any).annotations(internal).markSent([draft.id], "review_repair");
    assert.throws(() => service.completeReview(review.id, "bob"),
      /已提交意见尚未确认闭环/,
      "意见交给 Agent 后也不能直接把检视邀请点完成");
    (service as any).annotations(internal).respond(draft.id, {
      outcome: "not_fixed", summary: "已核对，本轮暂缓", evidence: [],
    });
    service.verifyAnnotation(id, draft.id, "本地用户", false, { revision: 0, outcome: "deferred", reason: "下次迭代补充" });
    service.completeReview(review.id, "bob");
    await until(() => luban.messages.length > invites, "完成回执送达");
    const receipt = luban.messages[luban.messages.length - 1] as
      Record<string, unknown>;
    assert.equal(receipt.account, "alice", "回执发给发起人,不是自己");
    assert.match(String(receipt.text ?? ""), /bob 已完成/,
      "回执要说清是谁完成的检视");
  } finally {
    await luban.stop();
  }
});

test("决定落账记操作人:decided_by 持久化,重启后仍可追责", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-gate-actor-")),
    "waiting.json");
  const gate = new HumanGate(path);
  const record = gate.createWaiting({
    taskId: "task-1", step: "cloud_push_confirm", callId: "c1",
    questionInput: { questions: [{ question: "推送?", options: ["确认"] }] },
  });
  gate.resolve(record.waiting_id, {
    stateVersion: record.state_version, decision: "确认",
    decidedBy: "admin-li",
  });
  const reloaded = new HumanGate(path).get(record.waiting_id)!;
  assert.equal(reloaded.status, "resolved");
  assert.equal(reloaded.decided_by, "admin-li");
});
