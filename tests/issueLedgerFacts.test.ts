/**
 * 转移账与检视账共享事实投影(工单 #334,ADR-0044 前置):推送账逐笔、
 * 红灯三结局互斥、外部头观测、验证失败计数、检视批次送出、反馈事件
 * 归并——首次生成归属层的地基,与归档快照/一次率共用同一份判定键。
 * 重点覆盖生产记账文案(带轮次前缀的验证失败)与排除口径(随合入
 * 取消/随头变丢弃的红灯、人工回退轮不算反馈)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countVerifyFailures,
  externalHeadObservations,
  feedbackEvents,
  isRedLightCanceledByMerge,
  isRedLightDiscardedOnHeadMove,
  isRedLightRepaired,
  ledgerPushes,
  sentReviewOperations,
} from "../src/issueFlow/ledgerFacts.ts";

test("ledgerPushes:逐笔解析仓/分支/提交号/时刻,跳过非推送条目,保序", () => {
  const pushes = ledgerPushes([
    { note: "阶段推进:fix", at: "2026-09-20T01:00:00.000Z" },
    { note: "分支已推送 https://git/web.git fix/101 @ abc123def456", at: "2026-09-20T01:01:00.000Z" },
    { note: "流水线失败(web)@ abc123def456", at: "2026-09-20T01:02:00.000Z" },
    { note: "分支已推送 https://git/web.git fix/101 @ 789abcdef012", at: "2026-09-20T01:03:00.000Z" },
  ]);
  assert.deepEqual(pushes, [
    { repo: "https://git/web.git", branch: "fix/101", sha: "abc123def456", at: "2026-09-20T01:01:00.000Z" },
    { repo: "https://git/web.git", branch: "fix/101", sha: "789abcdef012", at: "2026-09-20T01:03:00.000Z" },
  ]);
});

test("ledgerPushes:同(仓,分支,提交号)回放推送只留首笔(#506);换分支/换仓不去重", () => {
  const pushes = ledgerPushes([
    { note: "分支已推送 https://git/web.git fix/101 @ abc123def456", at: "2026-09-20T01:01:00.000Z" },
    // 重启续跑回放:同仓同分支同提交强推,只留首笔(issue-176 场景)。
    { note: "分支已推送 https://git/web.git fix/101 @ abc123def456(强制覆盖远端同名分支)", at: "2026-09-20T02:00:00.000Z" },
    // 中间隔一笔新提交后再回放旧头:同样不进投影(不携带新提交)。
    { note: "分支已推送 https://git/web.git fix/101 @ 789abcdef012", at: "2026-09-20T02:30:00.000Z" },
    { note: "分支已推送 https://git/web.git fix/101 @ abc123def456", at: "2026-09-20T03:00:00.000Z" },
    // 同提交换分支是不同推送事实,照记。
    { note: "分支已推送 https://git/web.git fix/102 @ abc123def456", at: "2026-09-20T03:10:00.000Z" },
    // 同提交不同仓是不同推送事实,照记。
    { note: "分支已推送 https://git/api.git fix/101 @ abc123def456", at: "2026-09-20T03:20:00.000Z" },
  ]);
  assert.deepEqual(pushes, [
    { repo: "https://git/web.git", branch: "fix/101", sha: "abc123def456", at: "2026-09-20T01:01:00.000Z" },
    { repo: "https://git/web.git", branch: "fix/101", sha: "789abcdef012", at: "2026-09-20T02:30:00.000Z" },
    { repo: "https://git/web.git", branch: "fix/102", sha: "abc123def456", at: "2026-09-20T03:10:00.000Z" },
    { repo: "https://git/api.git", branch: "fix/101", sha: "abc123def456", at: "2026-09-20T03:20:00.000Z" },
  ]);
});

test("红灯三结局互斥:各文案只命中自己的档", () => {
  const repaired = "流水线失败(web)@ abc123def456";
  const canceled = "MR 已合入,旧提交 abc123def456 的红灯随合入取消,不作失败处理";
  const discarded = "旧提交 abc123def456 的流水线结果丢弃,不作失败处理,检查目标已跟随切换";
  const unrelated = "阶段推进:mr_green";

  assert.equal(isRedLightRepaired(repaired), true);
  assert.equal(isRedLightCanceledByMerge(repaired), false);
  assert.equal(isRedLightDiscardedOnHeadMove(repaired), false);

  assert.equal(isRedLightRepaired(canceled), false);
  assert.equal(isRedLightCanceledByMerge(canceled), true);
  // 「MR 已合入,旧提交…」不以「旧提交」开头,不会误命中随头变丢弃档。
  assert.equal(isRedLightDiscardedOnHeadMove(canceled), false);

  assert.equal(isRedLightRepaired(discarded), false);
  assert.equal(isRedLightCanceledByMerge(discarded), false);
  assert.equal(isRedLightDiscardedOnHeadMove(discarded), true);

  assert.equal(isRedLightRepaired(unrelated), false);
  assert.equal(isRedLightCanceledByMerge(unrelated), false);
  assert.equal(isRedLightDiscardedOnHeadMove(unrelated), false);
});

test("countVerifyFailures:生产记账带轮次前缀与历史裸前缀都计,无关条目不计", () => {
  const transitions = [
    { note: "第 2 轮:用户环境验证发现问题:页面仍然白屏" },
    { note: "用户环境验证发现问题:首次就崩" },
    { note: "第 1 轮:方向理解错了,回退重做" },
    { note: "分支已推送 https://git/web.git fix/101 @ abc123def456" },
  ];
  assert.equal(countVerifyFailures(transitions), 2);
});

test("externalHeadObservations:提取平台外提交短码与时刻", () => {
  const records = externalHeadObservations([
    { note: "分支头已被平台外提交 abc123def456 取代,检查目标跟随切换(web)", at: "2026-09-20T02:00:00.000Z" },
    { note: "分支已推送 https://git/web.git fix/101 @ 789abcdef012", at: "2026-09-20T02:01:00.000Z" },
    { note: "分支头已被平台外提交 0123456789ab 取代,检查目标跟随切换(web)", at: "2026-09-20T02:02:00.000Z" },
  ]);
  assert.deepEqual(records, [
    { sha: "abc123def456", at: "2026-09-20T02:00:00.000Z" },
    { sha: "0123456789ab", at: "2026-09-20T02:02:00.000Z" },
  ]);
});

test("sentReviewOperations:只认经检视通道送出的 sent,带时刻与意见号", () => {
  const operations = sentReviewOperations([
    { op: "add", at: "2026-09-20T01:00:00.000Z" },
    { op: "sent", via: "issue_review", ids: ["1", "2"], at: "2026-09-20T01:10:00.000Z" },
    { op: "sent", via: "mr_push", ids: ["3"], at: "2026-09-20T01:11:00.000Z" },
    { op: "sent", via: "issue_review", ids: [], at: "2026-09-20T01:12:00.000Z" },
  ]);
  assert.deepEqual(operations, [
    { at: "2026-09-20T01:10:00.000Z", ids: ["1", "2"] },
    { at: "2026-09-20T01:12:00.000Z", ids: [] },
  ]);
});

test("feedbackEvents:三触发源按时刻归并;取消/丢弃红灯、回退轮、推送与缺时刻批次不算", () => {
  const events = feedbackEvents({
    transitions: [
      { note: "分支已推送 https://git/web.git fix/101 @ abc123def456", at: "2026-09-20T01:00:00.000Z" },
      { note: "流水线失败(web)@ abc123def456", at: "2026-09-20T01:05:00.000Z" },
      { note: "MR 已合入,旧提交 abc123def456 的红灯随合入取消,不作失败处理", at: "2026-09-20T01:06:00.000Z" },
      { note: "旧提交 abc123def456 的流水线结果丢弃,不作失败处理,检查目标已跟随切换", at: "2026-09-20T01:06:30.000Z" },
      { note: "第 1 轮:方向理解错了,回退重做", at: "2026-09-20T01:07:00.000Z" },
      { note: "第 2 轮:用户环境验证发现问题:页面仍然白屏", at: "2026-09-20T01:20:00.000Z" },
    ],
    reviewOperations: [
      { at: "" },
      { at: "2026-09-20T01:10:00.000Z" },
    ],
  });
  assert.deepEqual(events, [
    { kind: "pipeline_repaired", at: "2026-09-20T01:05:00.000Z" },
    { kind: "review_sent", at: "2026-09-20T01:10:00.000Z" },
    { kind: "verify_fail", at: "2026-09-20T01:20:00.000Z" },
  ]);
});
