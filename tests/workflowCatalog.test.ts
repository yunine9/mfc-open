import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { workflowStandardSnapshotFromCatalog } from "../src/workflowCatalog.ts";

const kernelRoot = join(import.meta.dirname, "..", "kernel");

test("现有 Playbook 被固定成标准方案，默认动作与平台下限不再混为一谈", () => {
  const snapshot = workflowStandardSnapshotFromCatalog(JSON.parse(readFileSync(
    join(kernelRoot, "flow", "playbooks.json"), "utf-8")));
  assert.equal(snapshot.standard_id, "mae-flow.standard");
  assert.equal(snapshot.standard_version, "2.0.0");
  assert.match(snapshot.catalog_digest, /^sha256:[a-f0-9]{64}$/);

  const construction = snapshot.stages.find((item) =>
    item.id === "platform.construction")!;
  const implementation = construction.items.find((item) =>
    item.id === "risk-first-implementation")!;
  const codeStandard = construction.items.find((item) =>
    item.id === "code-taste-standard")!;
  assert.equal(implementation.locked, false,
    "旧 required 只表示标准方案默认启用，不应冒充平台下限");
  assert.equal(codeStandard.editable, true);

  const delivery = snapshot.stages.find((item) =>
    item.id === "platform.delivery")!;
  assert.equal(delivery.items.find((item) => item.id === "host-git-push")?.locked,
    true, "真实宿主权限必须显式锁定");
});

test("目录损坏时拒绝生成半份标准方案", () => {
  assert.throws(() => workflowStandardSnapshotFromCatalog({
    schema: "mae-flow-playbook-catalog/1",
    standard: { id: "mae-flow.standard", version: "2" },
    playbooks: [{ id: "bad", title: "坏阶段", phase: "测试", steps: ["x"],
      activities: [{ id: "a", required: true }], resources: [] }],
  }), /动作标题不能为空/);
});
