import assert from "node:assert/strict";
import test from "node:test";
import { canHandoffReview, handoffReview, REVIEW_MISSION_END } from "../src/reviewHandoff.ts";
import { classifyDeliveryFailure } from "../src/deliveryFailure.ts";
import type { TaskSummary } from "../src/taskService.ts";
import { hostResumeMission } from "../src/taskHostTools.ts";

test("只接管完整系统检视目标，用户追加目标、工作台待处理意见都必须保留", () => {
  const summary = { delivery: { mr_url: "mr", loop: { kind: "review", review_source: "platform" } } } as TaskSummary;
  const mission = `MR 上有 2 条检视意见待处理\n${REVIEW_MISSION_END}`;
  assert.equal(canHandoffReview(mission, summary), true);
  assert.equal(canHandoffReview(mission + "\n用户：继续完成报表", summary), false);
  assert.equal(canHandoffReview(undefined, summary), false);
  const resumed = hostResumeMission(mission, "阶段性推送成功，继续剩余意见", undefined, undefined, summary);
  assert.equal(canHandoffReview(resumed, summary), true);
  assert.match(resumed, /阶段性推送成功/);
  assert.equal(canHandoffReview(hostResumeMission(mission + "\n用户：继续补报表", "推送成功", undefined, undefined, summary), summary), false);
  assert.equal(canHandoffReview(undefined, summary, true), true);
  summary.delivery!.loop!.workspace_review_pending = true;
  assert.equal(canHandoffReview(mission, summary), false);
  assert.equal(canHandoffReview(undefined, summary, true), false);
});

test("阶段性推送缺回复或还有本地工作时继续 Agent；完整回复发送失败也不让 Agent 重写", async () => {
  let failure: string | undefined = "MR 逐条回复缺少：d2";
  let ready = true, eligible = true, staged = 0, completed = 0, waited = 0;
  const host = {
    eligible: () => eligible, ready: async () => ready, canVerify: () => true, assertActive() {},
    record: () => failure, stage: async () => { staged++; return { ok: true }; },
    flush: async () => false,
    complete: () => { completed++; },
    wait: (healthy: boolean) => { assert.equal(healthy, false); waited++; },
  };
  assert.equal(await handoffReview(host), false); assert.equal(staged, 0);
  failure = undefined; ready = false;
  assert.equal(await handoffReview(host), false); assert.equal(staged, 0);
  ready = true;
  assert.equal(await handoffReview({ ...host, canVerify: () => false }), false);
  assert.equal(await handoffReview({ ...host, stage: async () => ({ ok: false }) }), false);
  assert.equal(await handoffReview({ ...host, ready: async () => { eligible = false; return true; } }), false);
  eligible = true;
  assert.equal(await handoffReview(host), true);
  assert.equal(staged, 1); assert.equal(completed, 1); assert.equal(waited, 1);
});

test("宿主权威收据失败不消费任务、不清空草稿，也不按 Agent 回执缺项补交", async () => {
  const failure = "反馈批次 fb 缺少 Cloud 宿主权威收据，已拒绝使用可篡改状态";
  assert.equal(classifyDeliveryFailure(failure, "receipt").stall_class, "safety");
  const unexpected = () => { throw new Error("不得执行后续步骤"); };
  await assert.rejects(handoffReview({ eligible: () => true, ready: async () => true, canVerify: () => true, assertActive() {},
    record: () => failure, stage: async () => unexpected(), flush: async () => unexpected(),
    complete: unexpected, wait: unexpected }), /缺少 Cloud 宿主权威收据/);
});
