/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 2/6:失败人话、执行契约证据核销与 typed check(含核销预算)。
 * 共享夹具在 tests/delivery.helpers.ts;断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { userFacingDeliveryFailure } from "../src/taskService.ts";
import { classifyDeliveryFailure } from "../src/deliveryFailure.ts";
import {
  makeSourceRepo,
  repairScenes,
  runTask,
  until,
} from "./delivery.helpers.ts";

test("交付连接与仓库权限异常只给人话，不泄露运行时类型和宿主路径", () => {
  assert.equal(userFacingDeliveryFailure(new TypeError("fetch failed")),
    "交付平台暂时连接不上，请检查平台地址或网络");
  assert.equal(userFacingDeliveryFailure(new Error(
    "平台返回里没有 MR 链接(url): {}")),
    "交付平台响应不完整，未返回 MR 链接");
  const push = userFacingDeliveryFailure(new Error(
    "宿主推送失败: error: remote unpack failed: unable to create temporary object directory\n"
    + "error: failed to push some refs to '/Users/alice/private/origin.git'"));
  assert.match(push, /远端代码仓暂时无法写入/);
  assert.doesNotMatch(push, /TypeError|\/Users\/alice/);
  assert.equal(classifyDeliveryFailure(
    "交付平台响应不完整，未返回 MR 链接").disposition, "stall");
  assert.equal(classifyDeliveryFailure(
    "流水线返回未知状态: (empty)").disposition, "stall");
  assert.equal(classifyDeliveryFailure(
    "交付平台暂时连接不上，请检查平台地址或网络").disposition, "retry",
  "网络瞬断仍应进入自动重试，不可被平台契约快停误伤");
});

test("总体绿且精确 SHA、无逐项 Job → 按 execution_contract 聚合核销", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.omitTypedChecks = true;
  await platform.start();
  try {
    const { task } = await runTask(platform, true);
    assert.equal(task.delivery?.pipeline, "success");
    assert.equal(task.status, "await_merge", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.checks, undefined, "没有伪造逐项 Job");
    assert.match(task.delivery?.attested ?? "", /^PASS@/);
  } finally {
    await platform.stop();
  }
});

test("typed check 暂未完成 → 纯宿主同 SHA 自动重试核销，不催 Agent/不重跑", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineChecks = [
    { dimension: "COMPILE", status: "success", job: "compile" },
    { dimension: "UT", status: "pending", job: "unit-test" },
    { dimension: "CODECHECK", status: "success", job: "codecheck" },
  ];
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 80 });
    assert.equal(task.status, "verifying");
    assert.match(task.delivery?.attested ?? "", /^INCOMPLETE@/);
    const sha = task.delivery!.sha!;
    const requestsBefore = platform.pipelines.length;
    platform.pipelines[0].checks = [
      { dimension: "COMPILE", status: "success", job: "compile" },
      { dimension: "UT", status: "success", job: "unit-test" },
      { dimension: "CODECHECK", status: "success", job: "codecheck" },
    ];
    await until(() => service.get(task.id)!.status === "await_merge",
      "宿主自动刷新证据并完成核销");
    const settled = service.get(task.id)!;
    assert.equal(settled.delivery?.sha, sha);
    assert.equal(platform.pipelines.length, requestsBefore,
      "同 SHA 证据重试不得重新触发流水线");
  } finally {
    await platform.stop();
  }
});

test("总体 success 但 typed UT 失败 → 按内核 RED 进入轻量修复处理", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineChecks = [
    { dimension: "COMPILE", status: "success", job: "compile" },
    { dimension: "UT", status: "failed", job: "unit-test" },
    { dimension: "CODECHECK", status: "success", job: "codecheck" },
  ];
  // 总体 success 的平台不会带 failure log；具体 UT 失败从 artifacts
  // 通道给出，正好验证宿主按维取证后才派发修复。
  platform.artifacts.push({
    name: "coverage_diff_notify.json",
    text: JSON.stringify({ failed_test: "NotifyServiceTest",
      message: "assertion failed, expected 2 but was 1" }),
  });
  await platform.start();
  try {
    const { task } = await runTask(
      platform, true, undefined,
      mkdtempSync(join(tmpdir(), "mfc-deliver-")), repairScenes(true),
      undefined, undefined, true);
    assert.equal(task.status, "await_merge", JSON.stringify(task));
    assert.equal(platform.pipelines.length, 2,
      "typed RED 应派一次轻量修复并以新 SHA 重跑流水线");
    assert.equal(platform.pipelines[0].status, "success",
      "反例刻意让总体状态为 success");
    assert.equal(platform.pipelines[0].checks?.find(
      (item) => item.dimension === "UT")?.status, "failed");
    assert.notEqual(platform.pipelines[0].sha, platform.pipelines[1].sha);
    assert.match(task.delivery?.attested ?? "", /^PASS@/);
  } finally {
    await platform.stop();
  }
});

test("某一项永远不给结果 → 核销重试也吃预算,不无限空转", async () => {
  // 实测过的另一潭死水:平台把 UT 报成 skipped(rules 跳过、或 manual
  // 没人点),内核判 INCOMPLETE,而宿主的证据重试没有预算——6 秒里
  // 登记了 16 次,每次拉一个内核子进程,永远不会收敛,retry 还被拒。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineChecks = [
    { dimension: "COMPILE", status: "success", job: "compile" },
    { dimension: "UT", status: "skipped", job: "unit-test" },
    { dimension: "CODECHECK", status: "success", job: "codecheck" },
  ];
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, true, { pollIntervalMs: 100, pollTimeoutMs: 1200 });
    assert.match(task.delivery?.attested ?? "", /^INCOMPLETE@/);
    await until(() => Boolean(service.get(task.id)!.delivery?.stalled),
      "核销预算耗尽后如实停摆");
    const stalled = service.get(task.id)!;
    assert.match(stalled.delivery!.stalled!, /UT|核销/);
    assert.match(stalled.detail ?? "", /自动验证已停/);
    // 停摆后不再空转:再等一会儿,登记次数不该继续涨。
    const before = platform.pipelines.length;
    await new Promise((tick) => setTimeout(tick, 600));
    assert.equal(platform.pipelines.length, before, "停摆后不许继续烧平台");
    assert.doesNotThrow(() => service.retry(task.id));
  } finally {
    await platform.stop();
  }
});
