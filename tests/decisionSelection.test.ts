import assert from "node:assert/strict";
import test from "node:test";
import {
  clearDecisionChoice,
  queuedDecisionAnnotationIds,
  isDecisionTextDrag,
  unifiedDecisionReply,
  toggleDecisionChoice,
} from "../web/src/decisionSelection";

test("决策选项再次点击会取消，改点其他项会切换", () => {
  const first = toggleDecisionChoice({}, "问题一", "方案 A");
  assert.deepEqual(first, { "问题一": "方案 A" });

  const cleared = toggleDecisionChoice(first, "问题一", "方案 A");
  assert.deepEqual(cleared, {});
  assert.deepEqual(first, { "问题一": "方案 A" }, "不得改写上一份状态");

  const switched = toggleDecisionChoice(first, "问题一", "方案 B");
  assert.deepEqual(switched, { "问题一": "方案 B" });
});

test("数字题号与字符串题号使用同一套取消语义", () => {
  const picked = toggleDecisionChoice({}, 0, "accept");
  assert.equal(picked[0], "accept");
  assert.deepEqual(toggleDecisionChoice(picked, 0, "accept"), {});
});

test("选择自定义答复时可以清掉已有分支", () => {
  const current = { "怎么处理": "直接继续", untouched: "保留" };
  assert.deepEqual(clearDecisionChoice(current, "怎么处理"), {
    untouched: "保留",
  });
  assert.strictEqual(clearDecisionChoice(current, "不存在"), current);
});

test("统一回复保留显式决定分支，补充意见不会替换所选答案", () => {
  assert.deepEqual(unifiedDecisionReply("需要调整代码", "  修复空状态  "), {
    freeResponse: "", notes: "修复空状态",
  });
  assert.deepEqual(unifiedDecisionReply("确认按清单推送", ""), {
    freeResponse: "", notes: "",
  });
});
test("取消选项后意见成为自由答复，不会丢失或重复附带", () => {
  assert.deepEqual(unifiedDecisionReply(undefined, "  先补验证再检视  "), {
    freeResponse: "先补验证再检视", notes: "",
  });
  assert.deepEqual(unifiedDecisionReply(undefined, "  "), {
    freeResponse: "", notes: "",
  });
});


test("推送调整选项不能落入推送按钮分支", async () => {
  const { isAdjustmentAnswer } = await import("../web/src/decisionSelection.ts");
  for (const answer of ["先调整", "需要调整代码（按清单返工）", "需要修改"]) {
    assert.equal(isAdjustmentAnswer(answer), true);
  }
  assert.equal(isAdjustmentAnswer("确认按清单推送"), false);
});

test("旧 API 错投 diff 时宿主推送仍不启用文件清单，内核 diff 也不消费清单", async () => {
  const { isPushConfirmation } = await import("../web/src/decisionSelection.ts");
  assert.equal(isPushConfirmation({ step: "host_push_confirm", recommended_view: "diff" }), true);
  assert.equal(isPushConfirmation({ step: "cloud_push_confirm", recommended_view: "diff" }), true);
  assert.equal(isPushConfirmation({ step: "delivery_review", recommended_view: "diff" }), false);
  assert.equal(isPushConfirmation(undefined), false);
});


test("文字选区残留不阻止取消；真实拖选仍不触发选择", () => {
  assert.equal(isDecisionTextDrag({ x: 10, y: 10 }, { x: 10, y: 10 }, true), false);
  assert.equal(isDecisionTextDrag({ x: 10, y: 10 }, { x: 70, y: 10 }, true), true);
  assert.equal(isDecisionTextDrag(undefined, { x: 10, y: 10 }, true), false);
  assert.equal(isDecisionTextDrag({ x: 10, y: 10 }, { x: 70, y: 10 }, false), false);
});

test("误选后转自定义保留文字，只提交自由答复而不夹带旧选项", () => {
  const selected = toggleDecisionChoice({}, "问题", "方案 A");
  const changed = clearDecisionChoice(selected, "问题");
  assert.deepEqual(changed, {});
  assert.deepEqual(unifiedDecisionReply(changed["问题"], "改用另一种处理方式"), {
    freeResponse: "改用另一种处理方式", notes: "",
  });
});


test("决定卡待发送清单只统计真实排队项，包含责任人转交的他人意见", () => {
  assert.deepEqual(queuedDecisionAnnotationIds([
    { id: "draft", status: "draft" },
    { id: "queued-1", status: "sent", sent_via: "queued_decision" },
    { id: "queued-2", status: "sent", sent_via: "queued_decision", rework: 2, response: { revision: 1 } },
    { id: "delivered", status: "sent", sent_via: "decision" },
    { id: "answered", status: "sent", sent_via: "queued_decision", response: { revision: 0 } },
  ]), ["queued-1", "queued-2"]);
});
