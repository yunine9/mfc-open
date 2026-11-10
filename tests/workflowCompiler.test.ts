import assert from "node:assert/strict";
import test from "node:test";

import { compileWorkflow } from "../src/workflowCompiler.ts";
import type {
  WorkflowResolvedAsset,
  WorkflowStandardSnapshot,
} from "../src/workflowDefinition.ts";

const catalogDigest = `sha256:${"1".repeat(64)}`;
const assetDigest = `sha256:${"2".repeat(64)}`;

function base(): WorkflowStandardSnapshot {
  return {
    standard_id: "mae-flow.standard",
    standard_version: "2.0.0",
    catalog_digest: catalogDigest,
    stages: [{
      id: "platform.construction",
      title: "完整实现与自查",
      phase: "写代码",
      steps: ["build"],
      slots: [{ id: "test-method", cardinality: "one" }],
      items: [
        { id: "evidence-gate", kind: "activity", title: "真实证据",
          locked: true, editable: false, source: "platform" },
        { id: "implementation", kind: "activity", title: "实现",
          locked: false, editable: true, source: "platform" },
        { id: "generic-test", kind: "activity", title: "通用测试",
          slot: "test-method", locked: false, editable: true,
          source: "platform" },
      ],
    }],
  };
}

function definition(edits: unknown[]) {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "mae-flow.standard", standard_version: "2.0.0",
      catalog_digest: catalogDigest },
    applicability: { business_module_ids: [], repositories: [], technologies: [] },
    edits,
  };
}

function available(id: string): WorkflowResolvedAsset {
  return { registry: "team_skill", id, version: "1", digest: assetDigest,
    nature: "engineering", form: "skill", state: "available",
    snapshot_path: `.mae-flow-work/assets/${id}` };
}

test("五种编辑编译成唯一最终方案，标准方案保持不可变", () => {
  const standard = base();
  const result = compileWorkflow({
    baseSnapshot: standard,
    source: { kind: "workflow", id: "notify-flow", version: "v3" },
    resolvedAssets: [available("notify-test")],
    definition: definition([
      { edit_id: "move-implementation", stage_id: "platform.construction",
        op: "move", target_id: "implementation",
        position: { after: "evidence-gate" } },
      { edit_id: "replace-test", stage_id: "platform.construction",
        op: "replace", target_id: "generic-test",
        item: { id: "notify-test", kind: "skill", title: "通知模块测试",
          slot: "test-method", locked: true, editable: false, source: "platform",
          asset_ref: { registry: "team_skill", id: "notify-test", version: "1",
            digest: assetDigest, nature: "engineering", form: "skill" },
          use: { mode: "before_item", anchor: "implementation" } } },
      { edit_id: "configure-test", stage_id: "platform.construction",
        op: "configure", target_id: "notify-test",
        instructions: "先生成边界用例，再实现断言" },
      { edit_id: "remove-implementation", stage_id: "platform.construction",
        op: "remove", target_id: "implementation" },
      { edit_id: "add-impact", stage_id: "platform.construction", op: "add",
        position: { before: "notify-test" },
        item: { id: "impact", kind: "instruction", title: "影响面扫描",
          locked: false, editable: true, source: "workflow" } },
    ]),
  });

  assert.equal(result.schema, "mae-flow-execution-profile/2");
  assert.deepEqual(standard.stages[0].items.map((item) => item.id),
    ["evidence-gate", "implementation", "generic-test"]);
  assert.deepEqual(result.final_snapshot.stages[0].items.map((item) => item.id),
    ["evidence-gate", "implementation", "impact", "notify-test"]);
  const skill = result.final_snapshot.stages[0].items.at(-1)!;
  assert.equal(skill.locked, false, "用户资产不能自报成平台下限");
  assert.equal(skill.editable, true);
  assert.equal(skill.instructions, "先生成边界用例，再实现断言");
  assert.match(result.revision, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.diagnostics[0].fallback,
    "已保留被依赖项；请先调整依赖项的使用时机");
});

test("破坏平台下限的编辑逐项回退，其余定制继续生效", () => {
  const result = compileWorkflow({
    baseSnapshot: base(),
    source: { kind: "task", id: "task-8" },
    definition: definition([
      { edit_id: "remove-floor", stage_id: "platform.construction",
        op: "remove", target_id: "evidence-gate" },
      { edit_id: "remove-default", stage_id: "platform.construction",
        op: "remove", target_id: "generic-test" },
    ]),
  });
  assert.deepEqual(result.final_snapshot.stages[0].items.map((item) => item.id),
    ["evidence-gate", "implementation"]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].code, "base_item_restored");
});

test("单个资产失效只恢复对应标准项，不吞掉其他编辑", () => {
  const unavailable = { ...available("notify-test"), state: "unavailable" as const,
    diagnostic: "团队 Skill v1 已归档" };
  const result = compileWorkflow({
    baseSnapshot: base(),
    source: { kind: "workflow", id: "notify-flow", version: "v1" },
    resolvedAssets: [unavailable],
    definition: definition([
      { edit_id: "replace-test", stage_id: "platform.construction",
        op: "replace", target_id: "generic-test",
        item: { id: "notify-test", kind: "skill", title: "通知模块测试",
          slot: "test-method", locked: false, editable: true, source: "workflow",
          asset_ref: { registry: "team_skill", id: "notify-test", version: "1",
            digest: assetDigest, nature: "engineering", form: "skill" } } },
      { edit_id: "move-default", stage_id: "platform.construction",
        op: "move", target_id: "generic-test",
        position: { before: "implementation" } },
    ]),
  });
  assert.deepEqual(result.final_snapshot.stages[0].items.map((item) => item.id),
    ["evidence-gate", "generic-test", "implementation"]);
  assert.equal(result.diagnostics[0].code, "asset_unavailable");
  assert.equal(result.diagnostics[0].message, "团队 Skill v1 已归档");
  assert.equal(result.diagnostics[0].fallback, "已保留原方案项 generic-test");
});

test("损坏或漂移的定义明确采用平台标准方案", () => {
  const invalid = compileWorkflow({
    baseSnapshot: base(), source: { kind: "task", id: "task-9" },
    definition: { schema: "bad" },
  });
  assert.deepEqual(invalid.final_snapshot, base());
  assert.equal(invalid.diagnostics[0].code, "profile_invalid");

  const drift = compileWorkflow({
    baseSnapshot: base(), source: { kind: "workflow", id: "old", version: "v1" },
    definition: { ...definition([]), base: {
      standard_id: "mae-flow.standard", standard_version: "1.0.0",
      catalog_digest: catalogDigest,
    } },
  });
  assert.equal(drift.diagnostics[0].fallback,
    "已采用完整平台标准方案；请复制当前版本后重新定制");
});
