/** Cloud 对人工分支只读内核契约，不维护步骤名或按钮文案表。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  matchesStepChoice,
  stepChoiceEffects,
  stepReviewSurface,
} from "../src/kernelChoices.ts";
import { KERNEL_ROOT } from "./kernelFixture.ts";

function kernelFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-choice-contract-"));
  mkdirSync(join(root, "flow"));
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({
    steps: {
      arbitrary_human_check: {
        approval_subject: { kind: "worktree" },
        choices: ["continue", "revise"],
        choice_answers: {
          continue: ["代码无需调整，继续提交", "旧版继续"],
          revise: ["需要调整代码（按检视意见返工）", "需要调整代码"],
        },
        next: { continue: "commit_it", revise: "repair_it" },
      },
      commit_it: {},
      repair_it: { allow_source_edit: true },
    },
  }));
  return root;
}

test("检视选项效果由 next 目标的 allow_source_edit 推导", () => {
  const effects = stepChoiceEffects(kernelFixture(), "arbitrary_human_check");
  assert.equal(effects.length, 2);
  assert.equal(effects.find((item) => item.key === "continue")?.allowsSourceEdit,
    false);
  const revise = effects.find((item) => item.key === "revise")!;
  assert.equal(revise.nextStep, "repair_it");
  assert.equal(revise.allowsSourceEdit, true);
  assert.equal(revise.handlesFeedback, true);
  assert.equal(revise.closesFeedback, false);
  assert.equal(effects.find((item) => item.key === "continue")?.closesFeedback,
    true);
  assert.ok(matchesStepChoice(revise, "需要调整代码（按检视意见返工）"));
  assert.ok(matchesStepChoice(revise, "需要调整代码"), "旧任务卡仍要能返工");
  assert.ok(matchesStepChoice(revise, "revise"));
  assert.equal(matchesStepChoice(revise, "代码无需调整，继续提交"), false);
});

test("原步骤内调整的材料检视以 confirmation_answers 识别关闭答案", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-confirm-contract-"));
  mkdirSync(join(root, "flow"));
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({
    steps: {
      artifact_review: {
        approval_subject: { kind: "artifacts" },
        confirmation_answers: ["材料无需再调整，确认继续", "旧版确认"],
        next: "code",
      },
      code: { allow_source_edit: true },
    },
  }));
  const effects = stepChoiceEffects(root, "artifact_review");
  assert.equal(effects.length, 1);
  assert.equal(effects[0].closesFeedback, true);
  assert.equal(effects[0].handlesFeedback, false,
    "下一步能写源码，不等于当前意见已经处理");
  assert.ok(matchesStepChoice(effects[0], "旧版确认"));
});

test("步骤契约缺失时返回空，不由 Cloud 猜返工分支", () => {
  assert.deepEqual(stepChoiceEffects(kernelFixture(), "unknown_step"), []);
  assert.deepEqual(stepChoiceEffects(undefined, "arbitrary_human_check"), []);
});

test("推荐证据面只读 approval_subject 类型，不维护步骤名表", () => {
  const root = kernelFixture();
  assert.equal(stepReviewSurface(root, "arbitrary_human_check"), "diff");

  const flowPath = join(root, "flow", "flow.json");
  const flow = JSON.parse(readFileSync(flowPath, "utf-8"));
  flow.steps.some_new_review = {
    approval_subject: { kind: "artifacts", artifacts: ["spec"] },
  };
  writeFileSync(flowPath, JSON.stringify(flow));
  assert.equal(stepReviewSurface(root, "some_new_review"), "doc");
  assert.equal(stepReviewSurface(root, "unknown_step"), undefined);
  assert.equal(stepReviewSurface(KERNEL_ROOT, "delivery_review"), "diff",
    "最终交付清单应直接把用户带到工作区变更");
});

test("收编内核的人工材料检视点都有统一关闭语义", () => {
  const flow = JSON.parse(readFileSync(
    join(KERNEL_ROOT, "flow", "flow.json"), "utf-8"));
  const reviewed = Object.entries(flow.steps as Record<string, any>)
    // delivery_review 在 Cloud 是自动确认清单，approval_subject 只负责把
    // 偶发的模型追问定位到 Diff；user_ack 才是内核规定的人工闸。
    .filter(([, step]) => step.approval_subject && step.user_ack);
  // 2026-08-25 编排瘦身:编码/质量段的中途检视点已整体退役,材料检视
  // (需求、Story、hotfix/tweak 开卡)仍必须齐全且语义统一。
  assert.ok(reviewed.length >= 4, "需求、Story、轻量开卡的材料检视不能漏");
  for (const [stepId, step] of reviewed) {
    const effects = stepChoiceEffects(KERNEL_ROOT, stepId);
    assert.ok(effects.some((effect) => effect.closesFeedback),
      `${stepId} 缺少可识别的关闭答案`);
    if (Array.isArray(step.choices)) {
      assert.ok(effects.some((effect) => effect.handlesFeedback),
        `${stepId} 的结构化检视缺少返工分支`);
    }
  }
});
