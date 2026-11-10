/**
 * 检视意见"需要补充说明"的闭环(内网实锤:同事提了两条意见,Agent 来回问了
 * 几轮重复的问题,最后停在"自动补交逐条检视回执后仍未完成"的报错上)。
 *
 * 根因两处:①needs_clarification 被当成回执失败——先催 Agent"只补回执"
 * (它只能把同一个问题再写一遍),两次后判 halted 通知责任人;②下一轮仍把
 * 这条算作"欠回执",Agent 被迫再答一遍。现在:它是合法结论,回执齐了、球
 * 在作者脚下;作者补充重提前不再向 Agent 要它的回执,Agent 多写一条也不算
 * 多出;作者改字重提时它问过什么留档并渲染给模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";

test("需要补充说明:是结论不是失败;作者重提前不再要它的回执,多写一条也不算多出", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-review-clarify-"));
  const notified: Array<{ account: string; status: string; summary: string }> = [];
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    notifier: {
      notifyOutcome: async (input: any) => { notified.push(input); },
    } as any,
  });
  try {
    const id = service.create("处理空值").id;
    const internal = (service as any).tasks.get(id);
    const store = (service as any).annotations(internal);
    const first = store.add({
      author: "reviewer-a", artifact: "本任务变更", file: "src/a.ts", line: 3,
      anchor: "return x", note: "空值要处理", kind: "code",
    });
    const second = store.add({
      author: "reviewer-b", artifact: "本任务变更", file: "src/b.ts", line: 9,
      anchor: "loop", note: "补边界测试", kind: "code",
    });
    store.markSent([first.id, second.id], "review_repair");
    internal.summary.delivery = { loop: {
      round: 0, max: 3, state: "repairing", kind: "review",
      review_source: "workspace", workspace_review_recheck_required: true,
      workspace_review_annotation_ids: [first.id, second.id],
    } };
    const reviews = join(internal.summary.workspace, "reviews");
    mkdirSync(reviews, { recursive: true });
    const receipts = (rows: unknown[]) => writeFileSync(
      join(reviews, "local-receipts.json"), JSON.stringify({ receipts: rows }));

    receipts([
      { annotation_id: first.id, revision: 0, outcome: "needs_clarification",
        summary: "空值指的是入参还是返回值？", evidence: [] },
      { annotation_id: second.id, revision: 0, outcome: "fixed",
        summary: "已补边界测试", evidence: ["src/b.ts:9"] },
    ]);
    const round1 = await (service as any).consumeWorkspaceReviewReceipts(internal);
    assert.equal(round1.ok, true, "需要补充说明是合法结论,不是回执失败");
    assert.deepEqual(round1.clarifications, [
      { annotation_id: first.id, summary: "空值指的是入参还是返回值？" }]);
    assert.deepEqual(notified.map((row) => [row.account, row.status]),
      [["reviewer-a", "review_clarification"]], "通知的是意见作者,不是责任人");
    assert.match(notified[0].summary, /空值指的是入参还是返回值/);

    // reviewer-b 确认通过;reviewer-a 还没补充。此时又送一条新意见:
    // 欠回执的只有新意见,Agent 不该再被要求答 first;它多写一条也不算多出。
    service.verifyAnnotation(id, second.id, service.get(id)?.luban_account ?? "本地用户");
    const third = store.add({
      author: "reviewer-b", artifact: "本任务变更", file: "src/c.ts", line: 1,
      anchor: "init", note: "初始化顺序", kind: "code",
    });
    store.markSent([third.id], "review_repair");
    internal.summary.delivery.loop.workspace_review_annotation_ids.push(third.id);
    assert.equal((service as any).awaitingAgentReceipt(store.list()
      .find((item: any) => item.id === first.id)), false);
    receipts([
      { annotation_id: first.id, revision: 0, outcome: "needs_clarification",
        summary: "空值指的是入参还是返回值？", evidence: [] },
      { annotation_id: third.id, revision: 0, outcome: "fixed",
        summary: "已把校验挪到入库之前", evidence: ["src/c.ts:1"] },
    ]);
    const round2 = await (service as any).consumeWorkspaceReviewReceipts(internal);
    assert.equal(round2.ok, true, round2.detail);
    assert.equal(round2.clarifications, undefined,
      "旧追问不再重复上报,也不再重复通知");
    assert.equal(notified.length, 1);
    receipts([
      { annotation_id: third.id, revision: 0, outcome: "fixed",
        summary: "已把校验挪到入库之前", evidence: ["src/c.ts:1"] },
    ]);
    assert.equal((await (service as any).consumeWorkspaceReviewReceipts(internal)).ok,
      true, "不写 first 的回执也齐");

    // 作者补充说明:改字退回待提交,追问留档;重提后才重新欠回执。
    const answered = store.edit(first.id, "空值指入参:为空时返回空列表", "reviewer-a");
    assert.equal(answered.status, "draft");
    assert.deepEqual(answered.clarifications?.map((row: any) => row.question),
      ["空值指的是入参还是返回值？"]);
    store.markSent([first.id], "review_repair");
    assert.equal((service as any).awaitingAgentReceipt(store.list()
      .find((item: any) => item.id === first.id)), true);
    const round3 = await (service as any).consumeWorkspaceReviewReceipts(internal);
    assert.equal(round3.ok, false);
    assert.match(round3.detail, new RegExp(`缺少 ${first.id}`), "重提后要它的回执");
  } finally {
    await service.shutdown();
  }
});
