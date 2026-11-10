import test from "node:test";
import assert from "node:assert/strict";
import { annotationSubmissionView } from "../src/annotationSubmissionView.ts";
import { annotationSubmissionReceipt } from "../src/annotationSubmission.ts";

const facts = { status: "running", openMr: false, evidenceAwaiting: false,
  publishedStory: false, reviewDecision: false, requirementReview: false };

test("统一提交展示：检视即修改，澄清等答复，暂停等恢复，终态不启动代码修改", () => {
  for (const [status, extra, enabled, hint] of [
    ["running", {}, true, /当前工作/], ["queued", {}, true, /待启动/],
    ["waiting_for_human", { reviewDecision: true }, true, /无需再点/],
    ["waiting_for_human", {}, true, /先回答当前问题/],
    ["waiting_for_human", { requirementReview: true }, true, /修改需求文档/],
    ["paused", {}, true, /不会自动恢复/], ["pausing", {}, true, /不会自动恢复/],
    ["verifying", { openMr: true }, true, /当前任务/],
    ["await_merge", { openMr: true }, true, /当前任务/],
    ["failed", {}, false, /先恢复或重跑/],
    ["completed", {}, false, /已交付/], ["canceled", {}, false, /已停止/],
  ] as const) {
    const view = annotationSubmissionView({ ...facts, status, ...extra });
    assert.equal(view.ordinary.enabled, enabled, status);
    assert.match(view.ordinary.hint, hint);
    assert.deepEqual(view.story, view.ordinary, "没有发布版本不能误走独立 Story 修订");
  }
  assert.equal(annotationSubmissionView({ ...facts, status: "completed", publishedStory: true }).story.enabled, true);
  assert.equal(annotationSubmissionView({ ...facts, status: "canceled", publishedStory: true }).story.enabled, false);
});

test("所有成功提交分支都有回执，排队不冒充已经处理", () => {
  for (const status of ["running", "queued", "verifying", "waiting_for_human", "completed"]) {
    assert.match(annotationSubmissionReceipt([], ["one"], 1, status), /已接收 1 条/);
  }
  assert.match(annotationSubmissionReceipt([], [], 1, "running"), /部分意见已更新或已闭环/);
});
