import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearExecutionPlanCache,
  hasStructuralWorkflowProjectionMismatch,
  readCurrentExecutionPlan,
  readCurrentExecutionPlanReading,
  readCurrentExecutionPlanReadingAsync,
} from "../src/executionPlan.ts";

function fixture(valid = true): { kernelRoot: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), "mfc-execution-plan-kernel-"));
  const workspace = mkdtempSync(join(tmpdir(), "mfc-execution-plan-workspace-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, "flow"), { recursive: true });
  writeFileSync(join(root, "flow", "flow.json"), "{}\n");
  writeFileSync(join(root, "flow", "playbooks.json"), "{}\n");
  writeFileSync(join(workspace, ".mae-flow.json"), JSON.stringify({
    current: "build", revision: 3,
  }));
  const script = join(root, "scripts", "mae-flow.py");
  const response = valid ? {
    schema: "mae-flow-execution-plan/1",
    plan_id: "platform.construction@1.0.0",
    plan_revision: "abc1234567890123",
    step: { id: "build", title: "编码", phase: "写代码", state_revision: 3 },
    strategy: {
      id: "platform.construction", version: "1.0.0", title: "完整实现与自查",
      summary: "完成实现和自查", source: "platform_default",
      selection_reason: "当前是编码阶段",
    },
    contract: { human_decision: false, evidence: [], outputs: ["完整代码"] },
    activities: [{ title: "实现", description: "完成改动", required: true }],
    resources: [{ kind: "tool", name: "容器命令", usage: "when_needed" }],
    knowledge: { loading: "indexed_on_demand", explanation: "按需读取" },
    customization: {
      mode: "bounded", customizable: ["task_instructions"],
      locked: ["真实证据"], effective_source: "platform_default+overrides",
      profile_revision: "feed123456789012",
      layers: [{
        scope: "task", source_id: "task-1", title: "本任务补充",
        instructions: "先核对旧数据",
      }],
    },
  } : { schema: "unknown" };
  writeFileSync(script, [
    "#!/usr/bin/env python3",
    `print(${JSON.stringify(JSON.stringify(response))})`,
  ].join("\n"));
  chmodSync(script, 0o755);
  return { kernelRoot: root, workspace };
}

test("Cloud 只消费内核结构化执行方案，不在 TS 侧猜阶段做法", () => {
  clearExecutionPlanCache();
  const current = fixture();
  const plan = readCurrentExecutionPlan(current);
  assert.equal(plan?.strategy.title, "完整实现与自查");
  assert.equal(plan?.step.id, "build");
  assert.deepEqual(plan?.customization.locked, ["真实证据"]);
  assert.equal(plan?.customization.layers[0].instructions, "先核对旧数据");
});

test("任务详情的慢 Python 查询不阻塞事件循环，同版本并发只执行一次", async () => {
  clearExecutionPlanCache();
  const current = fixture();
  const script = join(current.kernelRoot, "scripts", "mae-flow.py");
  writeFileSync(script, "import time\nwith open('calls.txt', 'a') as f: f.write('1')\ntime.sleep(0.25)\n" + readFileSync(script, "utf8"));
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  const one = readCurrentExecutionPlanReadingAsync(current);
  const two = readCurrentExecutionPlanReadingAsync(current);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(ticked, true);
  const [a, b] = await Promise.all([one, two]); clearTimeout(timer);
  assert.equal(a.plan?.step.id, "build"); assert.deepEqual(a, b);
  assert.equal(readFileSync(join(current.workspace, "calls.txt"), "utf8"), "1");
});

test("补充型方案的 platform_default+overrides 是正常生效，不误报投影缺失", () => {
  clearExecutionPlanCache();
  const plan = readCurrentExecutionPlan(fixture());
  assert.ok(plan);
  assert.equal(plan.customization.effective_source,
    "platform_default+overrides");
  assert.equal(hasStructuralWorkflowProjectionMismatch({
    final_snapshot: undefined,
  }, plan), false,
  "supplement-only 没有结构化定格，本来就不该要求 compiled_final_plan");
});

test("结构化定格没有被内核采用时仍然告警，正常编译时不告警", () => {
  clearExecutionPlanCache();
  const fallbackPlan = readCurrentExecutionPlan(fixture());
  assert.ok(fallbackPlan);
  const structuralProfile = { final_snapshot: { stages: [] } };
  assert.equal(hasStructuralWorkflowProjectionMismatch(
    structuralProfile, fallbackPlan), true);
  assert.equal(hasStructuralWorkflowProjectionMismatch(structuralProfile, {
    ...fallbackPlan,
    customization: {
      ...fallbackPlan.customization,
      effective_source: "compiled_final_plan",
    },
  }), false);
});

test("内核 stderr 的 ⚠ 告警随方案一起上浮——定制退化不许静默", () => {
  // 审计 P0-1 实锤:stdio ignore 把"定格文件损坏已退平台默认"整段
  // 扔掉,界面展示定格副本、Agent 实跑默认,无人被通知。
  clearExecutionPlanCache();
  const current = fixture();
  const script = join(current.kernelRoot, "scripts", "mae-flow.py");
  const originalBody = readFileSync(script, "utf-8");
  writeFileSync(script, [
    "#!/usr/bin/env python3",
    "import sys",
    "print('⚠ 本任务工作流定制无效，已采用既有 Mae-Flow 方案：坏档',"
      + " file=sys.stderr)",
    "print('usage noise that must not surface', file=sys.stderr)",
    ...originalBody.split("\n").slice(1),
  ].join("\n"));
  const reading = readCurrentExecutionPlanReading(current);
  assert.equal(reading.plan?.step.id, "build");
  assert.deepEqual(reading.kernel_warnings,
    ["⚠ 本任务工作流定制无效，已采用既有 Mae-Flow 方案：坏档"]);
});

test("旧内核或损坏输出安全降级为无方案，不影响任务详情", () => {
  clearExecutionPlanCache();
  assert.equal(readCurrentExecutionPlan(fixture(false)), undefined);
  assert.equal(readCurrentExecutionPlan({
    kernelRoot: join(tmpdir(), "missing-kernel"),
    workspace: join(tmpdir(), "missing-workspace"),
  }), undefined);
});
