import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeWorkflowDefinition,
  workflowDigest,
} from "../src/workflowDefinition.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("工作流定义固定基线、真实资产版本和五种结构化编辑", () => {
  const definition = normalizeWorkflowDefinition({
    schema: "mae-flow-workflow-definition/1",
    base: {
      standard_id: "mae-flow.standard",
      standard_version: "2.0.0",
      catalog_digest: digest,
    },
    applicability: {
      business_module_ids: ["notify"],
      repositories: ["https://code.example/notify.git"],
      technologies: ["java"],
    },
    edits: [
      {
        edit_id: "add-notify-skill",
        stage_id: "platform.construction",
        op: "add",
        item: {
          id: "notify-diagnosis",
          kind: "skill",
          title: "通知模块问题定位",
          locked: false,
          editable: true,
          source: "workflow",
          asset_ref: {
            registry: "team_skill",
            id: "Notify-Diagnosis",
            version: "3",
            digest,
            nature: "engineering",
            form: "skill",
          },
          use: { mode: "before_item", anchor: "implementation" },
        },
      },
      { edit_id: "remove-example", stage_id: "platform.construction",
        op: "remove", target_id: "generic-example" },
      {
        edit_id: "replace-ut", stage_id: "platform.construction",
        op: "replace", target_id: "java-autout",
        item: {
          id: "notify-ut", kind: "skill", title: "通知服务测试",
          locked: false, editable: true, source: "workflow",
          asset_ref: { registry: "repository_skill", id: "notify-ut",
            version: "main", digest,
            repository: "https://code.example/notify.git",
            revision: "abc123", relative_path: ".agents/skills/notify-ut/SKILL.md" },
        },
      },
      { edit_id: "move-impact", stage_id: "platform.construction",
        op: "move", target_id: "impact-scan",
        position: { before: "implementation" } },
      { edit_id: "configure-build", stage_id: "platform.construction",
        op: "configure", target_id: "build-check",
        use: { mode: "on_stage_enter" } },
    ],
  });

  assert.equal(definition.edits.length, 5);
  assert.equal(definition.edits[0].op, "add");
  if (definition.edits[0].op === "add") {
    assert.equal(definition.edits[0].item.asset_ref?.id, "Notify-Diagnosis");
  }
  assert.match(workflowDigest(definition), /^sha256:[a-f0-9]{64}$/);
});

test("仓内 Skill 不接受短期目录令牌，必须固定仓库、版本、路径与摘要", () => {
  assert.throws(() => normalizeWorkflowDefinition({
    schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "mae-flow.standard", standard_version: "2",
      catalog_digest: digest },
    applicability: { business_module_ids: [], repositories: [], technologies: [] },
    edits: [{
      edit_id: "bad-repository-skill",
      stage_id: "platform.construction",
      op: "add",
      item: {
        id: "temporary-skill", kind: "skill", title: "临时扫描结果",
        locked: false, editable: true, source: "workflow",
        asset_ref: {
          registry: "repository_skill", id: "temporary-skill",
          version: "catalog-token", digest,
        },
      },
    }],
  }), /必须固定仓库、版本和相对路径/);
});

test("工作流定义拒绝重复 edit id 和模糊位置", () => {
  const base = {
    schema: "mae-flow-workflow-definition/1",
    base: { standard_id: "mae-flow.standard", standard_version: "2",
      catalog_digest: digest },
    applicability: { business_module_ids: [], repositories: [], technologies: [] },
  };
  assert.throws(() => normalizeWorkflowDefinition({ ...base, edits: [
    { edit_id: "same", stage_id: "platform.construction", op: "remove",
      target_id: "one" },
    { edit_id: "same", stage_id: "platform.construction", op: "remove",
      target_id: "two" },
  ] }), /编辑 ID 不能重复/);
  assert.throws(() => normalizeWorkflowDefinition({ ...base, edits: [{
    edit_id: "move", stage_id: "platform.construction", op: "move",
    target_id: "one", position: { before: "two", after: "three" },
  }] }), /必须且只能指定/);
});
