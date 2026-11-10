/** 统一提交复用正式检视决定；澄清问题仍排队，不能代替用户回答。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

test("检视统一提交复用决定，澄清期间排队且不覆盖人的选择", () => {
  const panel = read("web/src/AnnotationPanel.tsx");
  assert.doesNotMatch(panel, /oneStepRework|await decide\(/,
    "抽屉不应再绕过当前决定卡自己代答");
  // 状态词已经收敛到服务端唯一判定处(feedbackPolicy),页面只渲染。
  assert.match(read("src/feedbackPolicy.ts"), /text: "已排队·等决定"/,
    "排队的意见不再冒充已提交");
  assert.match(panel, /提交修改意见/, "责任人使用统一提交入口");
  assert.match(read("src/reviewDecisionContract.ts"), /submitAnnotationReviewDecision/, "提交复用正式检视决定，澄清继续排队");
  const card = read("web/src/TaskCard.tsx");
  assert.match(card, /export function reworkChoiceOf/);
  assert.match(card, /const feedbackOption = reworkChoice\?\.option;/,
    "WaitingCard 与面板共用同一判据");
  assert.match(card, /const queuedKey = queuedAnnotationIds\.join\("\\0"\)/);
  assert.match(card, /setPicked\(current => Object\.values\(current\)\.some\(Boolean\) \? current/,
    "只在用户还没做选择时预选返工，不覆盖人的决定");
  const workspace = read("web/src/TaskWorkspace.tsx");
  assert.match(workspace, /queuedAnnotationIds=\{queuedIds\}/,
    "工作台要把已入队意见交给当前决定卡");
  assert.match(workspace, /pendingReviewAnnotationIds=\{pendingReviewIds\}/,
    "决定卡要展示本次会一并送达的意见");
  // 澄清期间保留排队，正式检视走已有决定处理链。
  const service = read("src/taskService.ts");
  assert.match(service, /markSentFor\(\s*picked, "queued_decision", sentBy\)/);
  // 回执登记前不再写"已提交/已被改动·请你确认":那时确认按钮根本不在。
  // 这些状态词现在只有服务端一份(feedbackPolicy),页面照抄。
  const policy = read("src/feedbackPolicy.ts");
  assert.match(policy, /text: viaRepair \? "等待 Agent 回执" : "已交给 Agent"/,
    "没回执时统一等回执,原文在不在只进提示不当进度");
  assert.doesNotMatch(policy, /text: "Agent 已改动这处/);
  assert.match(policy, /text: `Agent 回执：\$\{outcome\}·等复检`/,
    "有回执按回执结论显示");
  assert.match(service, /const reviewNode = await this\.workspaceReviewNodeAnswer\(task\);/,
    "修复轮中途举卡先读回执并由平台过内部节点");
  assert.match(policy, /text: "已被改动·等作者确认"/,
    "到点了但不是作者:说清裁决权在谁");
  assert.doesNotMatch(policy, /text: "已被改动·请你确认"/);
  // 收敛的硬约束:状态词只有服务端一份,页面里不许再出现。
  assert.doesNotMatch(panel, /"待你确认"|"等待 Agent 回执"|"已交给 Agent"/,
    "状态词只有服务端一份,页面不许再拼");
  assert.match(service, /pushConfirmCard \|\| item\.sent_via !== "review_repair"\)/,
    "修复轮意见只在最终推送卡上拦关闭");
  assert.match(service, /item\.status === "sent" && item\.sent_via === "queued_decision"/);
});
