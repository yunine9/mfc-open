import { test } from "node:test";
import assert from "node:assert/strict";
import { executionPlanFeedbackDraft } from "../web/src/executionPlanFeedback.ts";

const plan = {
  plan_id: "platform.construction@1.0.0",
  plan_revision: "abc1234567890123",
  step: { id: "build", title: "编码", phase: "写代码", state_revision: 3 },
  strategy: {
    id: "platform.construction",
    version: "1.0.0",
    title: "完整实现与自查",
    summary: "完成实现和自查",
    source: "platform_default",
    selection_reason: "当前是编码阶段",
  },
};

test("执行方案反馈自动携带可追溯的方案与阶段快照", () => {
  const draft = executionPlanFeedbackDraft(plan);

  assert.equal(draft.title, "改进「完整实现与自查」阶段执行方案");
  assert.match(draft.detail, /关联方案：platform\.construction@1\.0\.0/);
  assert.match(draft.detail, /阶段\/步骤：写代码 \/ 编码/);
  assert.match(draft.detail, /方案快照：abc1234567890123/);
  assert.match(draft.detail, /我遇到的问题或建议：$/);
});
