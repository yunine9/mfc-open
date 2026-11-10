/**
 * delivery.part3 part b:修复环出口:红→专职修复→绿、轮数预算耗尽如实停下。
 * 共享夹具在 tests/delivery.part3.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import {
  KERNEL_ROOT,
  buildService,
  deliveryModel,
  makeSourceRepo,
  repairScenes,
  until,
  walkScript,
} from "./delivery.helpers.ts";


test("修复环:红→专职会话修复→推新提交→新流水线绿→等待合入", async () => {
  // "流水线直至全绿是最终目标"(用户拍板)。修复本身是纯提示词:
  // 专职会话拿失败日志干活;宿主只做等待(带预算)、事实(绑 SHA)、
  // 刹车(轮数/新提交)三件提示词干不了的事。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");        // 第一跑红,之后默认绿
  platform.nextPipelineLog = "BUILD FAILURE: NotifyServiceTest 断言失败";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 2 });
  try {
    const id = service.create("交付 REQ9:演练修复环").id;
    await until(() => service.get(id)!.status === "await_merge",
      "修复后收敛到等待合入");
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop?.round, 1, "用了一轮修复");
    assert.equal(task.delivery?.loop?.state, "green");
    assert.equal(task.delivery?.pipeline, "success");
    // 第二次流水线绑的是修复后的新提交,不是旧 SHA 的旧绿灯
    assert.equal(platform.pipelines.length, 2);
    assert.notEqual(platform.pipelines[1].sha, platform.pipelines[0].sha,
      "新流水线必须绑修复后的新 SHA");
    // 修复会话拿到的是使命 + 平台失败原文
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /当前目标是处理本轮流水线失败/);
    assert.match(seen, /NotifyServiceTest 断言失败/);
    // 反向守卫:短但真实的失败原文(平台就给这么多,没有链接)不许被
    // "无证据"判据误伤——那条判据是给"链接替内容站岗"准备的。
    assert.match(seen, /失败详情\(平台原文\)/,
      "有真内容时必须走正常分支");
    assert.ok(!seen.includes("没有给出"), "短原文不是无证据");
  } finally {
    await model.stop();
    await platform.stop();
  }
});



test("修复环:轮数预算耗尽 → 如实停下请人工", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 1 });
  try {
    const id = service.create("交付 REQ9:修复环预算").id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "exhausted", "预算耗尽落账");
    const task = service.get(id)!;
    assert.equal(task.status, "verifying");
    assert.match(task.delivery?.pipeline ?? "", /预算用完/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

