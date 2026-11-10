/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 5/6:流水线轮询(异步 running 收敛、只认最新 run、红灯留痕)与
 * 修复轮预算的三层覆盖(部署 < 设置 < 任务)。共享夹具在
 * tests/delivery.helpers.ts;断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { RuntimeSettings } from "../src/settings.ts";
import {
  makeSourceRepo,
  runTask,
  until,
} from "./delivery.helpers.ts";

test("流水线红(修复环关闭) → 验证中留痕,不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const { task } = await runTask(platform, true, { repairRounds: 0 });
    assert.equal(task.status, "verifying");
    assert.equal(task.delivery?.mr_state, "验证中");
    assert.equal(task.delivery?.pipeline, "failed");
  } finally {
    await platform.stop();
  }
});

test("运行时设置压过部署值:界面把修复轮改 0,红灯不再触发修复", async () => {
  // 管理页热改的消费证明:部署给 repairRounds=2,设置层写 0,
  // 生效在下一次红灯——结果应与"修复环关闭"的路径一字不差。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
    const settings = new RuntimeSettings(dataDir);
    settings.updateRuntime({ repair_rounds: 0 });
    const { task } = await runTask(
      platform, true, { repairRounds: 2 }, dataDir, [], settings);
    assert.equal(task.status, "verifying", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.loop, undefined,
      "设置层的 0 没压过部署的 2,修复环被触发了");
  } finally {
    await platform.stop();
  }
});

test("任务级修复轮压过部署值:下单填 0,这一单红灯不修", async () => {
  // 覆盖链的最上层:任务 > 设置 > 部署。部署 2 轮,这单点了 0。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "failed";
  await platform.start();
  try {
    const { task } = await runTask(
      platform, true, { repairRounds: 2 },
      mkdtempSync(join(tmpdir(), "mfc-deliver-")), [], undefined,
      { repairRounds: 0 });
    assert.equal(task.status, "verifying", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.loop, undefined,
      "任务级的 0 没压过部署的 2,修复环被触发了");
  } finally {
    await platform.stop();
  }
});

test("异步流水线:running 验证中,绿灯后轮询收敛到等待合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100 });
    assert.equal(task.status, "verifying");
    assert.equal(task.delivery?.pipeline, "running");
    platform.finishPipeline(task.delivery!.sha!, "success");
    await until(() =>
      service.get(task.id)!.status === "await_merge", "轮询收敛绿灯");
    const settled = service.get(task.id)!;
    assert.equal(settled.delivery?.pipeline, "success");
    assert.equal(settled.delivery?.mr_state, "等待合入");
  } finally {
    await platform.stop();
  }
});

test("需求交付轮询只认最新 run:历史成功后最新 running 不得提前放行", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 80 });
    const sha = task.delivery!.sha!;
    platform.pipelines.unshift({
      id: -1,
      sha,
      status: "success",
      checks: [
        { dimension: "COMPILE", status: "success" },
        { dimension: "UT", status: "success" },
        { dimension: "CODECHECK", status: "success" },
      ],
    });
    // 至少跨过两次轮询。旧实现会 findLast(终态) 选中历史 success，
    // 即刻把任务推进 await_merge；最新 run 尚未结束时必须原地等待。
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(service.get(task.id)!.status, "verifying");
    assert.equal(service.get(task.id)!.delivery?.pipeline, "running");
    platform.finishPipeline(sha, "success");
    await until(() => service.get(task.id)!.status === "await_merge",
      "最新 run 真正成功后再放行");
  } finally {
    await platform.stop();
  }
});

test("异步流水线:红灯留痕(修复环关闭),任务停在验证中不标完成", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100, repairRounds: 0 });
    platform.finishPipeline(task.delivery!.sha!, "failed");
    await until(() =>
      service.get(task.id)!.delivery?.pipeline === "failed", "轮询看到红灯");
    assert.equal(service.get(task.id)!.status, "verifying");
  } finally {
    await platform.stop();
  }
});
