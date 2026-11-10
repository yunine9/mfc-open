import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { KnowledgeTrace, knowledgeUsageSnapshot } from "../src/knowledgeTrace.ts";
import {
  createBusinessModule,
  publishBusinessKnowledgeAsset,
} from "../src/businessModuleLibrary.ts";
import {
  copyBusinessModuleSnapshots,
  materializeBusinessModuleKnowledge,
  snapshotBusinessModules,
} from "../src/businessModuleRuntime.ts";

test("任务固定发布版本；上下文只注入目录，正文留给 Read/Grep 按需读取", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-business-runtime-"));
  const dataDir = join(root, "data");
  const taskWorkspace = join(dataDir, "task-1");
  const runtimeWorkspace = join(taskWorkspace, "repository");
  mkdirSync(taskWorkspace, { recursive: true });
  mkdirSync(runtimeWorkspace, { recursive: true });
  createBusinessModule(dataDir, {
    id: "orders", name: "订单域", description: "订单创建与履约边界",
    owner: "owner-a", repositories: ["https://code.example/orders.git"],
  }, "admin");
  publishBusinessKnowledgeAsset(dataDir, "orders", {
    id: "state-machine", title: "订单状态机",
    summary: "订单状态迁移与幂等约束",
    when_to_use: "新增状态、修改履约回调或补偿逻辑时",
    form: "rule", repositories: ["https://code.example/orders.git"],
    content: "# 订单状态机\n\nV1_ONLY_SECRET_BODY\n",
  }, "owner-a");
  const selected = snapshotBusinessModules({
    dataDir, taskWorkspace, moduleIds: ["orders"],
    repositories: ["https://code.example/orders.git"],
  });
  assert.equal(selected[0].assets[0].version, 1);
  assert.equal(selected[0].assets[0].form, "rule");
  assert.deepEqual(selected[0].assets[0].repositories,
    ["https://code.example/orders.git"]);

  publishBusinessKnowledgeAsset(dataDir, "orders", {
    id: "state-machine", title: "订单状态机",
    summary: "订单状态迁移与幂等约束",
    when_to_use: "新增状态、修改履约回调或补偿逻辑时",
    content: "# 订单状态机\n\nV2_NEW_BODY\n",
  }, "owner-a");
  const materialized = materializeBusinessModuleKnowledge({
    selected, taskWorkspace, runtimeWorkspace,
  });
  assert.deepEqual(materialized.warnings, []);
  assert.equal(materialized.entries.length, 1);
  assert.match(readFileSync(materialized.entries[0].path, "utf-8"),
    /V1_ONLY_SECRET_BODY/);
  const index = readFileSync(materialized.index_path!, "utf-8");
  assert.match(index, /订单状态机/);
  assert.match(index, /什么时候|何时读取|新增状态/);
  assert.match(index, /形态：rule/);
  assert.doesNotMatch(index, /V1_ONLY_SECRET_BODY|V2_NEW_BODY/,
    "索引不能偷渡知识正文进系统上下文");

  const childWorkspace = join(dataDir, "task-2");
  mkdirSync(childWorkspace, { recursive: true });
  const child = copyBusinessModuleSnapshots({ selected,
    sourceTaskWorkspace: taskWorkspace,
    targetTaskWorkspace: childWorkspace });
  assert.equal(child[0].assets[0].version, 1,
    "跨仓子任务必须沿用父任务版本，不能在拆单时漂到 v2");
  assert.match(readFileSync(join(childWorkspace,
    child[0].assets[0].snapshot_path), "utf-8"), /V1_ONLY_SECRET_BODY/);

  createBusinessModule(dataDir, {
    id: "inventory", name: "库存域", description: "库存履约边界",
    owner: "owner-b", repositories: ["https://code.example/inventory.git"],
  }, "admin");
  publishBusinessKnowledgeAsset(dataDir, "inventory", {
    id: "inventory-event", title: "库存事件",
    summary: "库存事件契约", when_to_use: "消费库存事件时",
    repositories: ["https://code.example/inventory.git"],
    content: "# 库存事件\n\nINVENTORY_ONLY\n",
  }, "owner-b");
  const inventory = snapshotBusinessModules({
    dataDir, taskWorkspace, moduleIds: ["inventory"],
    repositories: ["https://code.example/inventory.git"],
  });
  const filteredWorkspace = join(dataDir, "task-3");
  mkdirSync(filteredWorkspace, { recursive: true });
  const filtered = copyBusinessModuleSnapshots({
    selected: [...selected, ...inventory],
    sourceTaskWorkspace: taskWorkspace,
    targetTaskWorkspace: filteredWorkspace,
    repositories: ["https://code.example/orders.git"],
  });
  assert.deepEqual(filtered.map((module) => module.id), ["orders"],
    "子任务不能保留没有任何适用知识的业务模块空壳");

  const snapshotPath = join(
    taskWorkspace, selected[0].assets[0].snapshot_path);
  chmodSync(snapshotPath, 0o640);
  writeFileSync(snapshotPath, "被篡改");
  const tampered = materializeBusinessModuleKnowledge({
    selected, taskWorkspace, runtimeWorkspace,
  });
  assert.equal(tampered.entries.length, 0);
  assert.match(tampered.warnings.join("\n"), /指纹不一致/,
    "知识旁路 fail-open，但不能悄悄使用被篡改正文");
});

test("真实 Pi 请求只含模块索引，不含未读取的模块正文", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-business-prompt-"));
  const agentDir = join(workspace, "pi-agent");
  const moduleDir = join(workspace, ".mae-flow-work", "business-modules", "orders");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(moduleDir, { recursive: true });
  const bodyPath = join(moduleDir, "state.md");
  const indexPath = join(workspace, ".mae-flow-work", "business-modules", "INDEX.md");
  writeFileSync(bodyPath, "MODULE_BODY_MUST_BE_READ_EXPLICITLY");
  writeFileSync(indexPath, "# INDEX_ONLY_MARKER\n\n订单状态机：需要时读取 orders/state.md\n");
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const trace = new KnowledgeTrace(join(workspace, "knowledge-events.jsonl"),
    "task-module-prompt", workspace);
  const session = await CloudSession.create({
    taskId: "task-module-prompt", workspace, agentDir,
    provider: "maeflow", model: "scripted-v1",
    eventLog: new EventLog(join(workspace, "events.jsonl")),
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    knowledgeTrace: trace,
    businessModuleKnowledge: {
      index_path: indexPath, skill_paths: [], warnings: [], entries: [{
        id: "module:orders:state:v1", module_id: "orders",
        module_name: "订单域", module_owner: "owner-a", title: "订单状态机",
        summary: "状态迁移约束", when_to_use: "修改订单状态时",
        form: "rule", repositories: ["https://code.example/orders.git"], version: 1,
        digest: "digest", relative_path: ".mae-flow-work/business-modules/orders/state.md",
        path: bodyPath,
      }],
    },
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    const request = JSON.stringify(model.requests);
    assert.match(request, /本任务知识索引/);
    assert.match(request, /状态迁移约束/);
    assert.match(request, /\.mae-flow-work\/business-modules\/orders\/state\.md/);
    assert.doesNotMatch(request, /INDEX_ONLY_MARKER/,
      "会话只使用统一索引，不再注入模块运行时生成的旧索引文件");
    assert.doesNotMatch(request, /MODULE_BODY_MUST_BE_READ_EXPLICITLY/);
    const usage = knowledgeUsageSnapshot({ workspace })!;
    const module = usage.resources.find((item) =>
      item.id === "module:orders:state:v1")!;
    assert.equal(module.state, "available");
    assert.equal(module.scope, "module");
  } finally {
    session.dispose();
    await model.stop();
  }
});
