/**
 * 领域与组件两条知识线共用的审阅规则契约（B5）。两条线各自的集成测试
 * （domainKnowledgeExtraction / componentResearch）走真实管理器；这里钉规则本身，
 * 任何一条线改写判断都必须先过这一组。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLatestReviewProposal, assertNoPendingReviewProposals, assertReviewRevision,
  continuingReviewProposal, type ReviewProposal } from "../src/knowledgeReviewCore.ts";

const proposal = (turn: string, doc: string, base: number, extra: Partial<ReviewProposal<string>> = {}): ReviewProposal<string> =>
  ({ turn_id: turn, document_id: doc, turn_status: "done", status: "pending", base_revision: base, value: `${turn}:${doc}`, ...extra });

test("B5审阅核心：修订接续只取本轮或此前完成、同基线的待确认建议", () => {
  const turns = ["t1", "t2", "t3"];
  const proposals = [proposal("t1", "a", 1), proposal("t2", "a", 1, { turn_status: "failed" }), proposal("t1", "b", 1)];
  assert.equal(continuingReviewProposal(proposals, "a", 1, "t3", turns)?.turn_id, "t1", "失败回合的建议不接续");
  assert.equal(continuingReviewProposal(proposals, "a", 2, "t3", turns), undefined, "正文基线变了就不接续旧建议");
  assert.equal(continuingReviewProposal([proposal("t3", "a", 1)], "a", 1, "t2", turns), undefined, "不接续未来回合");
  assert.equal(continuingReviewProposal([proposal("t2", "a", 1, { turn_status: "running" })], "a", 1, "t2", turns)?.turn_id, "t2", "本轮续跑接自己的候选");
  assert.equal(continuingReviewProposal([proposal("t1", "a", 1, { status: "discarded" })], "a", 1, "t2", turns), undefined, "已放弃的不接续");
});

test("B5审阅核心：只接受完成回合的最新建议，且正文基线未变", () => {
  const proposals = [proposal("t1", "a", 1), proposal("t2", "a", 1)];
  assert.throws(() => assertLatestReviewProposal(proposals, "t1", "a", 1), /已有更新的修改建议/);
  assert.equal(assertLatestReviewProposal(proposals, "t2", "a", 1).turn_id, "t2");
  assert.throws(() => assertLatestReviewProposal(proposals, "t2", "a", 2), /新版本/);
  assert.throws(() => assertLatestReviewProposal(proposals, "t2", "a", 1, true), /仍在进行/);
  assert.throws(() => assertLatestReviewProposal([proposal("t1", "a", 1, { turn_status: "running" })], "t1", "a", 1), /尚未完成/);
  assert.throws(() => assertLatestReviewProposal([proposal("t1", "a", 1, { status: "accepted" })], "t1", "a", 1), /已处理/);
  assert.throws(() => assertLatestReviewProposal(proposals, "t9", "a", 1), /不存在/);
});

test("B5审阅核心：发布前所选文稿不能留有未确认的修改建议；版本锁按原值比较", () => {
  assert.throws(() => assertNoPendingReviewProposals([proposal("t1", "a", 1)], ["a"]), /尚未确认的修改/);
  assert.doesNotThrow(() => assertNoPendingReviewProposals([proposal("t1", "a", 1)], ["b"]), "未选中的文稿不拦");
  assert.doesNotThrow(() => assertNoPendingReviewProposals([proposal("t1", "a", 1, { status: "discarded" })], ["a"]));
  assert.doesNotThrow(() => assertReviewRevision(3, 3));
  assert.throws(() => assertReviewRevision(3, 2, "自定义提示"), /自定义提示/);
});
