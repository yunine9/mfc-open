import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectKernelPosition,
  inspectKernelCompletion,
  inspectKernelDeliveryReady,
  inspectKernelTaskCompletion,
} from "../src/terminalAttestation.ts";
import { TaskService } from "../src/taskService.ts";
import { KERNEL_UNAVAILABLE, createKernelHostProof } from "../src/kernelDelivery.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

function fixture(current: string, external = false): {
  root: string; cwd: string; kernelRoot: string; head: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mfc-terminal-"));
  const cwd = join(root, "repo");
  const kernelRoot = join(root, "kernel");
  mkdirSync(cwd);
  mkdirSync(join(kernelRoot, "flow"), { recursive: true });
  // 收据裁决已收口进内核 `delivery attest`(2026-09-02),Cloud 只问不判——
  // 假内核也得能被拉起:把真实内核的 CLI 入口与 core 链进来,状态仍是夹具的。
  const realKernel = discoverKernelRoot(process.cwd());
  if (realKernel) {
    mkdirSync(join(kernelRoot, "scripts"));
    symlinkSync(join(realKernel, "scripts", "mae-flow.py"),
      join(kernelRoot, "scripts", "mae-flow.py"));
    symlinkSync(join(realKernel, "scripts", "mae_flow_core"),
      join(kernelRoot, "scripts", "mae_flow_core"), "dir");
  }
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      grill: { terminal: false },
      build: { terminal: false },
      external_verify: { terminal: false },
      delivery_watch: { terminal: false },
      end: { terminal: true },
    },
  }));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "bot@test"], { cwd });
  execFileSync("git", ["config", "user.name", "bot"], { cwd });
  writeFileSync(join(cwd, "README.md"), "fixture\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd, encoding: "utf-8",
  }).trim();
  const state: any = {
    current,
    execution_contract: external ? {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent",
      ut_run: "pipeline", codecheck: "pipeline",
    } : {
      schema: "mae-flow-execution/1", host: "local",
      compile: "local", ut_write: "agent",
      ut_run: "local", codecheck: "local",
    },
  };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  return { root, cwd, kernelRoot, head };
}

function serviceFor(root: string, kernelRoot: string, maxConcurrent = 0): TaskService {
  const dataDir = join(root, "tasks");
  mkdirSync(dataDir, { recursive: true });
  return new TaskService({
    dataDir,
    provider: "unused",
    model: "unused",
    modelsJson: {},
    maxConcurrent,
    host: { kernelRoot },
  });
}

function taskState(root: string, cwd: string, id = "task-1"): any {
  const workspace = join(root, "tasks", id);
  mkdirSync(workspace, { recursive: true });
  return {
    summary: {
      id,
      requirement: "终态不变式反例",
      status: "running",
      created_at: new Date().toISOString(),
      workspace,
    },
    cwd,
    humanGate: {},
    controlEpoch: 0,
    driver: undefined,
  };
}

test("非终态步骤永远不能为 completed 背书", () => {
  for (const current of ["grill", "build", "external_verify"]) {
    const { cwd, kernelRoot } = fixture(current, true);
    const result = inspectKernelCompletion(cwd, kernelRoot);
    assert.equal(result.complete, false, current);
    assert.equal(result.terminal, false, current);
    assert.equal(result.kind,
      current === "external_verify" ? "external_verify" : "active");
  }
});

test("本地执行契约只需 flow terminal", () => {
  const { cwd, kernelRoot } = fixture("end");
  const result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, true, result.reason);
  assert.equal(result.external_required, false);
});

test("流水线契约:总体 end 也必须逐项 PASS 且绑定当前 HEAD", () => {
  const { cwd, kernelRoot, head } = fixture("end", true);
  let result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false, "缺核销不能完成");

  const statePath = join(cwd, ".mae-flow.json");
  const checks = Object.fromEntries(["COMPILE", "UT", "CODECHECK"].map(
    (dimension) => [dimension, { status: "passed", sha: head }],
  ));
  writeFileSync(statePath, JSON.stringify({
    current: "end",
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent",
      ut_run: "pipeline", codecheck: "pipeline",
    },
    quality: { external_verification: {
      verdict: "PASS", sha: head,
      required: ["COMPILE", "UT", "CODECHECK"], checks,
    } },
  }));
  result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, true, result.reason);

  execFileSync("git", ["commit", "--allow-empty", "-qm", "new head"], { cwd });
  result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false, "旧 SHA 的绿灯不能背书新 HEAD");
});

test("持续检视就绪与任务完成均拒绝仅靠 Agent 可写状态伪造", () => {
  const { cwd, kernelRoot, head } = fixture("delivery_watch", true);
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  const checks = Object.fromEntries(["COMPILE", "UT", "CODECHECK"].map(
    (dimension) => [dimension, { status: "passed", sha: head }],
  ));
  state.execution_contract.continuous_review = true;
  state.quality = { external_verification: {
    verdict: "PASS", sha: head,
    required: ["COMPILE", "UT", "CODECHECK"], checks,
  } };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  let result = inspectKernelDeliveryReady(cwd, kernelRoot);
  assert.equal(result.complete, false,
    "即使状态自称流水线 PASS，没有 Cloud 宿主收据也不能等待合入");
  assert.match(result.reason, /宿主(?:任务绑定|权威收据)|无法核对宿主收据/);
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, false,
    "MR 未合入、内核未 close 时绝不能 completed");
  state.current = "end";
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  assert.equal(inspectKernelDeliveryReady(cwd, kernelRoot).complete, false);
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, false,
    "持续检视任务不能拿旧 end 冒充 MR 已合入");
  state.delivery_loop = { close_events: [{
    event_id: "merge-1", reason: "merged", sha: head, local_head: head,
  }] };
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify(state));
  result = inspectKernelTaskCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false,
    "Agent 在状态里手写 merged close 不能把任务伪造成已完成");
  assert.match(result.reason, /宿主收据/);

  execFileSync("git", ["commit", "--allow-empty", "-qm", "local after merge"], { cwd });
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot).complete, false,
    "改变本地 HEAD 也不能让伪造的 close 获得宿主背书");
});

test("宿主外绑定不可被 false 降级，真 PASS 收据也不能拼接假 delivery_watch", () => {
  const { cwd, kernelRoot, head } = fixture("build", true);
  const commandKernelRoot = discoverKernelRoot(process.cwd());
  assert.ok(commandKernelRoot, "测试必须找到同步后的真实内核");
  const taskId = "task-bound-attack";
  const facts = {
    sha: head,
    status: "success",
    source: "attack-regression",
    git_push: { sha: head, ref: "refs/heads/test", remote: "origin" },
  };
  const factsPath = join(cwd, "pipeline-facts.json");
  writeFileSync(factsPath, JSON.stringify(facts));
  const proof = createKernelHostProof({
    cwd, workspace: cwd, taskId, action: "pipeline-record", payload: facts,
  });
  try {
    execFileSync("python3", [
      join(commandKernelRoot, "scripts", "mae-flow.py"),
      "pipeline", "record", "--file", factsPath,
      "--host-proof", proof.path,
    ], { cwd, encoding: "utf-8" });
  } finally {
    proof.cleanup();
  }

  const statePath = join(cwd, ".mae-flow.json");
  const tampered = JSON.parse(readFileSync(statePath, "utf-8"));
  tampered.current = "delivery_watch";
  tampered.execution_contract.continuous_review = false;
  delete tampered.execution_contract.host_authority;
  writeFileSync(statePath, JSON.stringify(tampered));

  const result = inspectKernelDeliveryReady(cwd, kernelRoot, true, {
    workspace: cwd, taskId,
  });
  assert.equal(result.complete, false,
    "外置 capability 仍应强制验签，且 build 时的真 PASS 不能拼成假就绪态");
  assert.match(result.reason, /宿主(?:任务绑定|权威收据)|无法核对宿主收据/);
});

test("flow 未声明 terminal 时，状态文件自称 end 也不能绕过", () => {
  const { cwd, kernelRoot } = fixture("end");
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: { end: { terminal: false } },
  }));
  const result = inspectKernelCompletion(cwd, kernelRoot);
  assert.equal(result.complete, false);
  assert.equal(result.terminal, false);
});

test("grill/build 多次 end_turn 只会停机，绝不能强行完成或交付", async () => {
  for (const current of ["grill", "build"]) {
    const { root, cwd, kernelRoot } = fixture(current, false);
    const service = serviceFor(root, kernelRoot);
    const task = taskState(root, cwd);
    (service as any).tasks.set(task.summary.id, task);
    let continues = 0;
    task.driver = {
      takeUndeliveredSteers: () => [],
      continueWith: async () => {
        continues += 1;
        return { status: "turn_finished", reason: "end_turn" };
      },
      finalReply: () => "我先停在这里",
      dispose: () => undefined,
    };
    await (service as any).settleTurn(
      task,
      Promise.resolve({ status: "turn_finished", reason: "end_turn" }),
      0,
    );
    assert.equal(continues, 5, `${current} 只有有界催办`);
    assert.equal(task.summary.status, "failed", current);
    assert.match(task.summary.detail, new RegExp(current));
    assert.equal(task.summary.delivery, undefined, "不得触发交付旁路");
  }
});

test("external_verify 的 end_turn 是宿主等待，不催 Agent 也不 completed", async () => {
  const { root, cwd, kernelRoot } = fixture("external_verify", true);
  const service = serviceFor(root, kernelRoot);
  const task = taskState(root, cwd);
  (service as any).tasks.set(task.summary.id, task);
  let continues = 0;
  task.driver = {
    takeUndeliveredSteers: () => [],
    continueWith: async () => {
      continues += 1;
      return { status: "turn_finished", reason: "end_turn" };
    },
    finalReply: () => "代码侧已完成",
    dispose: () => undefined,
  };
  await (service as any).settleTurn(
    task,
    Promise.resolve({ status: "turn_finished", reason: "end_turn" }),
    0,
  );
  assert.equal(continues, 0, "宿主等待点不许催 Agent 本地跑质量动作");
  assert.equal(task.summary.status, "verifying");
  assert.match(task.summary.detail, /权威流水线|尚未到 terminal/);
});

test("blocked_by 不信伪 completed：前置内核未终态时下游不能出队", async () => {
  const { root, cwd, kernelRoot } = fixture("build", false);
  const service = serviceFor(root, kernelRoot, 1);
  const upstream = taskState(root, cwd, "task-1");
  upstream.summary.status = "completed";
  const downstream = taskState(root, undefined as any, "task-2");
  downstream.cwd = undefined;
  downstream.summary.status = "queued";
  downstream.summary.blocked_by = ["task-1"];
  (service as any).tasks.set("task-1", upstream);
  (service as any).tasks.set("task-2", downstream);
  (service as any).queue.push("task-2");

  await (service as any).pump();

  assert.equal(downstream.summary.status, "queued");
  assert.deepEqual((service as any).queue, ["task-2"]);
  assert.match(downstream.summary.detail, /等待前置任务 task-1/);
});

test("恢复会对账伪 completed，并从内核 current 重新排队", () => {
  const { root, cwd, kernelRoot } = fixture("build", false);
  const service = serviceFor(root, kernelRoot, 0);
  const saved = taskState(root, cwd);
  saved.summary.status = "completed";
  saved.summary.completed_at = new Date().toISOString();
  writeFileSync(join(saved.summary.workspace, "task.json"), JSON.stringify({
    summary: saved.summary,
    cwd,
  }));

  const result = service.recover();

  assert.equal(result.restored, 1);
  assert.equal(result.requeued, 1);
  const restored = service.get("task-1")!;
  assert.equal(restored.status, "queued");
  assert.equal(restored.completed_at, undefined);
  assert.match(restored.detail ?? "", /伪终态.*build/);
});

test("执行位置读取无需内核进程，位置不是交付通过证明", () => {
  const { cwd, kernelRoot } = fixture("delivery_watch", true);
  const position = inspectKernelPosition(cwd, kernelRoot);
  assert.equal(position.kind, "delivery_watch");
  assert.equal("complete" in position, false, "位置接口不能被当作通过核验的结果");
  assert.equal(inspectKernelDeliveryReady(cwd, kernelRoot, true,
    { workspace: cwd, taskId: "untrusted", python: "/missing-python" }).complete, false,
    "真正就绪判定仍不能越过收据核验");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ current: "end" }));
  assert.equal(inspectKernelPosition(cwd, kernelRoot).kind, "terminal");
  assert.equal(inspectKernelTaskCompletion(cwd, kernelRoot, true,
    { workspace: cwd, taskId: "untrusted", python: "/missing-python" }).complete, false,
    "自称 end 也不能证明可信完成");
  writeFileSync(join(cwd, ".mae-flow.json"), "broken");
  assert.equal(inspectKernelPosition(cwd, kernelRoot).kind, "invalid");
  assert.equal(inspectKernelPosition(undefined, kernelRoot).kind, "invalid");
});

for (const failure of [undefined, `${KERNEL_UNAVAILABLE}：测试故障`]) {
  test(`收口${failure ? "遇内核故障" : "成功"}不查询无用批次，故障直接进入原有恢复`, async () => {
    const { root, cwd, kernelRoot } = fixture("external_verify", true);
    const service: any = serviceFor(root, kernelRoot);
    const task = taskState(root, cwd);
    (service as any).tasks.set(task.summary.id, task);
    task.summary.delivery = { loop: { kind: "ci", review_source: "platform" } };
    task.driver = { takeUndeliveredSteers: () => [], finalReply: () => "已完成",
      dispose: () => {}, continueWith: () => { assert.fail("不能因基础设施故障叫 Agent 补回执"); } };
    service.recordActiveFeedbackResult = () => failure;
    service.activeKernelFeedback = () => { assert.fail("不需要补交就不应再次启动核验"); };
    let recovery: string | undefined;
    service.holdWithRecovery = (_task: unknown, reason: string) => { recovery = reason; };
    await service.settleTurn(task,
      Promise.resolve({ status: "turn_finished", reason: "end_turn" }), 0);
    if (failure) assert.equal(recovery, failure, "保留原有故障恢复分类");
    assert.notEqual(task.summary.status, "completed", "不能把省略无用查询当成任务完成");
  });
}
