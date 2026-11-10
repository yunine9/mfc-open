import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTaskSupplements,
  normalizeTaskExecutionInstructions,
  resolveRepositorySupplement,
} from "../src/executionProfile.ts";
import {
  withWorkflowSupplements,
  workflowProfilePrompt,
} from "../src/workflowProfileRuntime.ts";

// v1 execution-profile 已退役(2026-08-29):文字建议层的唯一形态是
// workflow_profile.supplements。本文件测的是建议层构造与并档语义。

test("任务执行补充会规范化并落进 supplement-only 定格档", () => {
  const supplements = buildTaskSupplements(
    "task-12", "  先核对旧数据  \r\n不确定时明确说明  ");
  assert.equal(supplements.length, 1);
  assert.equal(supplements[0].instructions,
    "先核对旧数据\n不确定时明确说明");
  const profile = withWorkflowSupplements(undefined, supplements);
  assert.ok(profile);
  assert.equal(profile.final_snapshot, undefined,
    "supplement-only 不许伪造结构化定格");
  assert.equal(profile.source.kind, "platform");
  assert.match(profile.revision, /^sha256:[a-f0-9]{64}$/);
  // revision 盖住 supplements:同层内容不同,revision 必不同。
  const other = withWorkflowSupplements(
    undefined, buildTaskSupplements("task-12", "别的补充"));
  assert.notEqual(profile.revision, other!.revision);
});

test("执行补充有清晰容量边界，且提示明确低于平台兜底", () => {
  assert.equal(normalizeTaskExecutionInstructions(" \n "), undefined);
  assert.throws(() => normalizeTaskExecutionInstructions("x".repeat(2001)),
    /不能超过 2000/);
  const prompt = workflowProfilePrompt(withWorkflowSupplements(
    undefined, buildTaskSupplements("task-1", "优先检查兼容性")));
  assert.match(prompt, /优先检查兼容性/);
  assert.match(prompt, /冲突部分无效/);
  assert.match(prompt, /真实证据/);
});

test("团队默认在前、任务补充在后，形成稳定覆盖顺序", () => {
  const supplements = buildTaskSupplements(
    "task-2", "本单先查旧格式", "公共接口变更必须点名影响方");
  assert.deepEqual(supplements.map((item) => item.scope), ["team", "task"]);
  assert.deepEqual(supplements.map((item) => item.title),
    ["团队执行约定", "本任务补充"]);
  // 乱序传入也按 scope 排稳:并档时的顺序纪律在 withWorkflowSupplements。
  const profile = withWorkflowSupplements(
    undefined, [...supplements].reverse());
  assert.deepEqual(profile!.supplements!.map((item) => item.scope),
    ["team", "task"]);
});

test("代码仓执行约定首次 clone 后解析为 repository 层并入定格档", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-repo-"));
  writeFileSync(join(workspace, ".mae-flow-defaults.json"), JSON.stringify({
    执行补充: "修改公共接口前先扫描调用方",
  }));
  const resolved = resolveRepositorySupplement({
    workspace, repositoryId: "https://code.example/orders.git",
  });
  assert.equal(resolved.supplement?.scope, "repository");
  assert.equal(resolved.supplement?.instructions,
    "修改公共接口前先扫描调用方");
  const profile = withWorkflowSupplements(undefined, [
    ...buildTaskSupplements("task-3", "本单关注旧客户端", "团队要求明确影响方"),
    resolved.supplement!,
  ]);
  assert.deepEqual(profile!.supplements!.map((item) => item.scope),
    ["team", "repository", "task"]);
});

test("损坏的代码仓约定明确降级，不阻塞其他执行层", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-repo-bad-"));
  writeFileSync(join(workspace, ".mae-flow-defaults.json"), "{ bad");
  const resolved = resolveRepositorySupplement({
    workspace, repositoryId: "repo",
  });
  assert.equal(resolved.supplement, undefined);
  assert.match(resolved.warning ?? "", /未采用.*继续使用其余执行方案/);
});

test("空 supplements 不动原档;结构化定格并入补充后仍保留结构", () => {
  assert.equal(withWorkflowSupplements(undefined, []), undefined);
  const structural = withWorkflowSupplements(
    undefined, buildTaskSupplements("task-6", "先看兼容性"));
  const again = withWorkflowSupplements(structural, []);
  assert.equal(again, structural);
});
