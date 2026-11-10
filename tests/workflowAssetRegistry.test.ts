import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";
import { snapshotBusinessModules } from "../src/businessModuleRuntime.ts";
import { uploadHostSkill } from "../src/hostSkillLibrary.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import { listWorkflowAssetCatalog } from "../src/workflowAssetRegistry.ts";
import { resolveWorkflowAssets } from "../src/workflowAssetResolution.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

test("统一资产目录返回真实版本身份，任务解析只接受对拍成功的精确资产",
  async () => {
    const dataDir = mfcTemp("mfc-workflow-registry-");
    seedTechnologyStacks(dataDir, ["typescript"]);
    const workspace = mfcTemp("mfc-workflow-snapshot-");
    createBusinessModule(dataDir, {
      id: "order", name: "订单", description: "订单业务", owner: "alice",
      repositories: ["https://code.example/order.git"],
    }, "admin");
    const module = publishBusinessKnowledgeAsset(dataDir, "order", {
      id: "diagnosis", title: "订单问题定位", summary: "定位订单状态异常",
      when_to_use: "订单状态不一致时", form: "skill", content: "先核对状态机。",
    }, "alice");
    await uploadHostSkill(dataDir, "review-helper", [{
      path: "SKILL.md",
      content_base64: Buffer.from([
        "---", "name: review-helper", "description: Review helper",
        "knowledge_nature: engineering", "technologies: [typescript]", "---",
        "", "# Review", "", "Check the diff.",
      ].join("\n")).toString("base64"),
    }], "admin", { nature: "engineering", business_module_ids: [],
      repositories: [], technologies: ["typescript"] });

    const catalog = listWorkflowAssetCatalog({ dataDir });
    const business = catalog.items.find((item) =>
      item.ref.registry === "business_knowledge")!;
    const skill = catalog.items.find((item) =>
      item.ref.registry === "team_skill")!;
    assert.equal(business.ref.business_module_id, "order");
    assert.equal(business.ref.version, String(module.assets[0].version));
    assert.match(business.ref.digest, /^sha256:/);
    assert.equal(skill.ref.id, "review-helper");
    assert.equal("content" in business, false, "目录不能把正文灌给浏览器");

    const hostSkillSnapshotRoot = join(workspace, "host-skill-snapshot");
    materializeHostSkills({
      sourceRoot: join(dataDir, "skills"), workspaceRoot: workspace,
      snapshotRoot: hostSkillSnapshotRoot,
    });
    await uploadHostSkill(dataDir, "review-helper", [{
      path: "SKILL.md",
      content_base64: Buffer.from([
        "---", "name: review-helper", "description: Review helper v2",
        "knowledge_nature: engineering", "technologies: [typescript]", "---",
        "", "# Review v2", "", "New shelf content.",
      ].join("\n")).toString("base64"),
    }], "admin", { nature: "engineering", business_module_ids: [],
      repositories: [], technologies: ["typescript"] });

    const businessModules = snapshotBusinessModules({
      dataDir, taskWorkspace: workspace, moduleIds: ["order"], repositories: [],
    });
    const definition = {
      schema: "mae-flow-workflow-definition/1",
      base: { standard_id: "std", standard_version: "1",
        catalog_digest: `sha256:${"a".repeat(64)}` },
      applicability: { business_module_ids: ["order"], repositories: [],
        technologies: ["typescript"] },
      edits: [business, skill].map((asset, index) => ({
        edit_id: `asset-${index}`,
        stage_id: "stage",
        op: "add",
        item: {
          id: `item-${index}`,
          kind: asset.type === "skill" ? "skill" : "knowledge",
          title: asset.title,
          locked: false,
          editable: true,
          source: "workflow",
          asset_ref: asset.ref,
        },
      })),
    };
    const resolved = resolveWorkflowAssets({
      definition, dataDir, repositories: [], technologies: ["typescript"],
      businessModules, repositorySkills: [],
      hostSkillSnapshotRoot,
    });
    assert.deepEqual(resolved.map((item) => item.state),
      ["available", "available"]);
    assert.ok(resolved[0].snapshot_path,
      "知识正文只以任务快照路径进入 manifest");

    const changed = structuredClone(definition);
    changed.edits[0].item.asset_ref.digest = `sha256:${"f".repeat(64)}`;
    assert.equal(resolveWorkflowAssets({
      definition: changed, dataDir, repositories: [], technologies: ["typescript"],
      businessModules, repositorySkills: [],
      hostSkillSnapshotRoot,
    })[0].state, "unavailable", "摘要不符不能拿同名最新版冒充固定版本");
  });
