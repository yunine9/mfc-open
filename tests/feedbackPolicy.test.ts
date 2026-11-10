import assert from "node:assert/strict";
import test from "node:test";
import type { Annotation } from "../src/annotations.ts";
import {
  blockingAnnotations,
  parseWorkspaceReviewReceipts,
  unansweredAnnotations,
} from "../src/feedbackPolicy.ts";

function annotation(id: string, author: string, status: Annotation["status"],
  rework = 0): Annotation {
  return {
    id, author, status, rework, created_at: "2026-08-30T00:00:00.000Z",
    artifact: "diff", file: "a.ts", line: 1, anchor: "before",
    note: "改好", kind: "code",
  };
}

test("反馈闸门:路人草稿不锁任务，责任人草稿提醒，已提交意见必须闭环", () => {
  const ownerDraft = annotation("owner-draft", "alice", "draft");
  const visitorDraft = annotation("visitor-draft", "bob", "draft");
  const submitted = annotation("sent", "bob", "sent");
  assert.deepEqual(
    blockingAnnotations([ownerDraft, visitorDraft, submitted], "alice")
      .map((item) => item.id),
    ["owner-draft", "sent"],
  );
  assert.deepEqual(blockingAnnotations([visitorDraft], undefined)
    .map((item) => item.id), ["visitor-draft"], "无账号旧任务保持单用户语义");
});

test("逐条回执按 id+revision 对拍，缺失/重复/旧轮都明确点名", () => {
  const first = annotation("A", "alice", "sent");
  const second = annotation("B", "bob", "sent", 1);
  const result = parseWorkspaceReviewReceipts({ receipts: [
    { annotation_id: "A", revision: 0, outcome: "fixed",
      summary: "已补空值判断", evidence: ["src/a.ts:12"] },
    { annotation_id: "B", revision: 0, outcome: "fixed", summary: "旧回执" },
    { annotation_id: "A", revision: 0, outcome: "fixed", summary: "重复" },
    { annotation_id: "C", revision: 0, outcome: "fixed", summary: "越界" },
  ] }, [first, second]);
  assert.deepEqual(result.receipts.map((item) => item.annotation_id), [], "重复 ID 不能任选一条冒充有效回执");
  assert.deepEqual(result.missing_ids, ["A", "B"]);
  assert.deepEqual(result.unexpected_ids, ["C"]);
  assert.ok(result.errors.some((line) => line.includes("revision")));
  assert.ok(result.errors.some((line) => line.includes("重复")));
});

test("回执必须说清怎么处理的:只写「已处理」不算说明,fixed 必须带改动位置", () => {
  // 用户实锤:面板显示"已处理",但完全不知道 Agent 干了什么。summary 是给提
  // 意见的人看的,一句话下限;fixed 没有 evidence 等于让人自己去翻 diff。
  const first = annotation("A", "alice", "sent");
  const second = annotation("B", "bob", "sent");
  const third = annotation("C", "carol", "sent");
  const fourth = annotation("D", "dan", "sent");
  const result = parseWorkspaceReviewReceipts({ receipts: [
    { annotation_id: "A", revision: 0, outcome: "fixed", summary: "已处理", evidence: ["src/a.ts:1"] },
    { annotation_id: "B", revision: 0, outcome: "fixed", summary: "已把空值分支改成返回空列表" },
    { annotation_id: "C", revision: 0, outcome: "not_fixed", summary: "这里的空值是协议约定,不该改" },
    { annotation_id: "D", revision: 0, outcome: "fixed", summary: "已把空值分支改成返回空列表", evidence: ["src/d.ts:7"] },
  ] }, [first, second, third, fourth]);
  assert.deepEqual(result.receipts.map((item) => item.annotation_id), ["C", "D"]);
  assert.ok(result.errors.some((line) => line.includes("A") && line.includes("只写了「已处理」")));
  assert.ok(result.errors.some((line) => line.includes("B") && line.includes("没有 evidence")));
  assert.deepEqual(result.missing_ids, ["A", "B"], "被退回的回执按缺失处理,Agent 得重写");
});

test("只有当前轮没有结构化回应的 sent 意见算未回应", () => {
  const answered = annotation("A", "alice", "sent");
  answered.response = {
    revision: 0, outcome: "fixed", summary: "完成", evidence: [],
    responded_at: "2026-08-30T00:01:00.000Z",
  };
  const old = annotation("B", "bob", "sent", 1);
  old.response = { ...answered.response, revision: 0 };
  assert.deepEqual(unansweredAnnotations([answered, old], ["A", "B"])
    .map((item) => item.id), ["B"]);
});
