import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FeedbackStore } from "../src/feedbackStore.ts";
import { join } from "node:path";
import { AnnotationStore, renderAnnotations } from "../src/annotations.ts";
import { importExternalReviews, importStoredExternalReviews, notifyExternalReviews } from "../src/externalReviewInbox.ts";
import { submitAnnotationSnapshot } from "../src/annotationSubmission.ts";
import { classifyGates } from "../src/mergeWatch.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { reviewStore } from "../src/issueFlow/reviews.ts";

function scene() {
  const root = mfcTemp("external-review-");
  const store = new AnnotationStore(join(root, "annotations.jsonl"), true);
  const base = { scope: "r:mr1", mrUrl: "https://example.test/mr/1", owner: "owner" };
  const sync = (items: any[]) => importExternalReviews(store, { ...base, items });
  return { root, store, base, sync };
}

test("外部报告只入待判断批注：原文完整；删除、答复、闭环及重复轮询不重新创建", () => {
  const { store, sync } = scene();
  const body = "非常长的报告\n".repeat(1500);
  const [first] = sync([{ id: "d1", body, file: "a.cpp", line: 5 }]);
  assert.equal(first.note, body.trim());
  assert.equal(first.route, "owner_reply");
  assert.equal(first.agent_assigned, undefined);
  assert.equal(sync([{ id: "d1", body, file: "a.cpp", line: 55, revision: 99, sha: "new" }]).length, 0);
  store.drop(first.id, "owner", true);
  assert.equal(sync([{ id: "d1", body, file: "a.cpp", line: 5 }]).length, 0);
  const [second] = sync([{ id: "d2", body: "请核对参数" }]);
  store.replyAsOwner(second.id, "owner", "已有兼容约束，暂不修改", true);
  assert.equal(sync([{ id: "d2", body: "请核对参数" }]).length, 0);
  const [third] = sync([{ id: "d3", body: "另一个建议" }]);
  store.resolveAsOwner(third.id, "owner", { revision: 0, outcome: "not_adopted", reason: "无须修改" });
  assert.equal(sync([{ id: "d3", body: "另一个建议" }]).length, 0);
  const reopened = sync([{ id: "d3", body: "检视人补充了新的证据" }]);
  assert.equal(reopened.length, 1);
  assert.equal(store.list().find(item => item.id === third.id)?.status, "verified");
});

test("新报告 ID 的完全重复内容去重，不合并不同代码位置的相同建议", () => {
  const { sync } = scene();
  assert.equal(sync([{ id: "a", body: "补空值检查", file: "a.cpp", line: 1 }]).length, 1);
  assert.equal(sync([{ id: "b", body: "补空值检查", file: "a.cpp", line: 1 }]).length, 0);
  assert.equal(sync([{ id: "c", body: "补空值检查", file: "a.cpp", line: 99 }]).length, 1);
});

test("先保存责任人要求再批量交办，原文与补充都送达；未选意见不混入", async () => {
  const { sync, store } = scene();
  const notes = sync([{ id: "d1", body: "删掉兼容函数" }, { id: "d2", body: "补充 UT" }, { id: "d3", body: "暂不交办" }]);
  store.saveAgentContext(notes[0].id, "owner", "保留兼容入口，补齐实现，不要删除");
  assert.equal(store.list()[0].agent_assigned, undefined);
  await submitAnnotationSnapshot(store, notes.slice(0, 2), "owner", "", async selected => {
    const prompt = renderAnnotations(selected, "REQ1");
    assert.match(prompt, /删掉兼容函数/);
    assert.match(prompt, /保留兼容入口/);
    assert.doesNotMatch(prompt, /暂不交办/);
  });
  assert.equal(store.list()[2].agent_assigned, undefined);
});

test("通知每五分钟只包含新增，重建 store 不重发，发送失败下轮重试", async () => {
  const { root, store, sync, base } = scene();
  const summaries: string[] = [];
  let success = true;
  const notifier: any = { notifyReviewReady: async (input: any) => { summaries.push(input.summary); return { delivered: success }; } };
  const send = (now: number) => notifyExternalReviews({ workspace: root, store: new AnnotationStore(store.path),
    scope: base.scope, owner: base.owner, taskId: "task-1", link: "https://example.test", notifier, now });
  sync([{ id: "a", body: "意见A" }]);
  await send(1_000_000); assert.equal(summaries.length, 1);
  sync([{ id: "b", body: "意见B" }]);
  await send(1_000_001); assert.equal(summaries.length, 1);
  await send(1_300_000); assert.equal(summaries.length, 2);
  assert.match(summaries[1], /意见B/); assert.doesNotMatch(summaries[1], /意见A/);
  await send(1_600_000); assert.equal(summaries.length, 2);
  sync([{ id: "c", body: "意见C" }]); success = false;
  await send(1_900_000); success = true;
  await send(2_200_000); assert.equal(summaries.length, 4);
  await send(2_500_000); assert.equal(summaries.length, 4);
});

test("MR 未解决讨论不派发修复且不挡 CI 修复；问题单显式交办只发送选中批次", () => {
  const gates = classifyGates([{ name: "resolve_discussion_passed", passed: false }, { name: "ci_state_passed", passed: false }]);
  assert.deepEqual(gates.repairs.map(item => item.kind), ["ci"]);
  assert.match(gates.waiting.join(), /责任人/);
  const root = mfcTemp("issue-external-");
  const store = reviewStore(root);
  const imported = importExternalReviews(store, { scope: "repo:mr1", owner: "owner", items: [{ id: "d1", body: "第一条" }, { id: "d2", body: "第二条" }] });
  store.saveAgentContext(imported[0].id, "owner", "只补一行判断");
  const live: any = { id: "issue-1", root, state: { id: "issue-1", title: "问题", account: "owner", scenario: "ticket", status: "running", stage: "mr_green", round: 2 } };
  const service: any = Object.create(IssueFlowService.prototype);
  service.require = () => live; service.appendSessionEvent = () => {};
  let text = ""; service.startPlatformTurn = (_live: unknown, message: string) => { text = message; };
  service.submitReviews(live.id, [imported[0].id]);
  assert.match(text, /只补一行判断/); assert.doesNotMatch(text, /第二条/);
  assert.equal(store.list()[1].status, "draft");
  assert.equal(live.state.stage, "mr_green");
});


test("升级导入完整报告后本地删除，旧摘要不会在观察列表清空后复活", () => {
  const { root, store } = scene();
  const url = "https://example.test/mr/1";
  mkdirSync(join(root, "reviews"), { recursive: true });
  const observed = join(root, "reviews", "observed-discussions.json");
  writeFileSync(observed, JSON.stringify([{ id: "legacy", body: "完整报告\n".repeat(500) }]));
  new FeedbackStore(join(root, "feedback", "index.jsonl")).upsert([{
    id: "old", batch_id: "batch", source: "mr_discussion", source_id: "legacy",
    source_revision: 0, observed_sha: "abc", summary: "旧摘要", verification: "author",
    status: "open", updated_at: new Date().toISOString(),
  }]);
  importStoredExternalReviews(store, root, url, "owner");
  assert.equal(store.list().length, 1);
  store.drop(store.list()[0].id, "owner", true);
  writeFileSync(observed, "[]");
  importStoredExternalReviews(new AnnotationStore(store.path), root, url, "owner");
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].status, "dropped");
});
