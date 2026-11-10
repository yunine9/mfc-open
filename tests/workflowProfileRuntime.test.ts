import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileWorkflow } from "../src/workflowCompiler.ts";
import {
  materializeWorkflowProfile,
  reconcileWorkflowProfileAssets,
  workflowProfilePrompt,
} from "../src/workflowProfileRuntime.ts";

const digest = `sha256:${"a".repeat(64)}`;
const base = {
  standard_id: "mae-flow.standard", standard_version: "2",
  catalog_digest: digest,
  stages: [{ id: "platform.build", title: "实现", phase: "写代码",
    steps: ["build"], slots: [], items: [
      { id: "implement", kind: "activity" as const, title: "完成实现",
        locked: false, editable: true, source: "platform" as const },
    ] }],
};

test("最终方案以只读原子快照落地，fallback 只展示索引和明确降级", () => {
  const profile = compileWorkflow({
    baseSnapshot: base, source: { kind: "task", id: "task-3" },
    definition: { schema: "mae-flow-workflow-definition/1",
      base: { standard_id: "mae-flow.standard", standard_version: "2",
        catalog_digest: digest },
      applicability: { business_module_ids: [], repositories: [], technologies: [] },
      edits: [{ edit_id: "configure", stage_id: "platform.build",
        op: "configure", target_id: "implement", instructions: "先验证高风险接缝" }],
    },
  });
  const workspace = mkdtempSync(join(tmpdir(), "mfc-workflow-profile-"));
  const path = materializeWorkflowProfile(workspace, profile)!;
  assert.equal(JSON.parse(readFileSync(path, "utf-8")).revision, profile.revision);
  const prompt = workflowProfilePrompt(profile);
  assert.match(prompt, /先验证高风险接缝/);
  assert.doesNotMatch(prompt, /asset_manifest/);
  assert.match(prompt, /阶段、退出条件、真实证据/);
});

test("运行时单篇知识投影失败只撤销对应定制并恢复标准项", () => {
  const assetDigest = `sha256:${"b".repeat(64)}`;
  const ref = {
    registry: "business_knowledge" as const,
    id: "diagnosis", business_module_id: "notify", version: "3",
    digest: assetDigest, nature: "business" as const, form: "document" as const,
  };
  const profile = compileWorkflow({
    baseSnapshot: base, source: { kind: "workflow", id: "notify", version: "v3" },
    definition: { schema: "mae-flow-workflow-definition/1",
      base: { standard_id: "mae-flow.standard", standard_version: "2",
        catalog_digest: digest },
      applicability: { business_module_ids: ["notify"], repositories: [],
        technologies: [] },
      edits: [{ edit_id: "replace", stage_id: "platform.build", op: "replace",
        target_id: "implement", item: {
          id: "notify-diagnosis", kind: "knowledge", title: "通知问题定位",
          locked: false, editable: true, source: "workflow", asset_ref: ref,
          use: { mode: "when_needed" },
        } }],
    },
    resolvedAssets: [{ ...ref, state: "available",
      snapshot_path: ".mae-flow-work/business-modules/notify/diagnosis.md" }],
  });
  assert.equal(profile.final_snapshot.stages[0].items[0].id, "notify-diagnosis");
  assert.match(workflowProfilePrompt(profile),
    /正文按需读取：\.mae-flow-work\/business-modules\/notify\/diagnosis\.md/);

  const runtime = reconcileWorkflowProfileAssets(profile, [])!;
  assert.equal(runtime.final_snapshot!.stages[0].items[0].id, "implement");
  assert.ok(runtime.diagnostics.some((item) => item.code === "asset_unavailable"
    && item.fallback?.includes("implement")));
  assert.match(runtime.diagnostics.map((item) => item.message).join("\n"),
    /任务固定正文未能投影/);
});
