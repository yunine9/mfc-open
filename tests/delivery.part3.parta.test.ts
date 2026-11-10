/**
 * delivery.part3 part a:修复环长轮:20 轮兜底修到绿、会话没新提交带诊断喊人。
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


test("修复环默认 20 轮兜底:三连红仍一路修到绿", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed", "failed");
  platform.nextPipelineLog = "BUILD FAILURE: 覆盖率 62% 未达标";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true),
     ...repairScenes(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:默认预算修复").id;
    await until(() => service.get(id)!.status === "await_merge",
      "三轮修复后全绿", 120_000);
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop?.round, 3, "第三轮才绿,老默认早断头了");
    assert.equal(task.delivery?.loop?.max, 20, "默认预算必须真实进入修复账");
    assert.equal(task.delivery?.loop?.state, "green");
    // 使命升级在场:分诊、专职分派、诊断出口;第 2 轮起带上一轮失败对比
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /先分诊再动手/);
    assert.match(seen, /定位先于修改/, "定位这一步必须写死在使命里");
    assert.match(seen, /定位依据/, "定位要交依据,不许凭猜改");
    assert.match(seen, /专职质量子 agent/);
    assert.match(seen, /诊断出口/);
    assert.match(seen, /上一轮修复后流水线仍红/);
    // 本夹具只有 README/a.txt，没有可提取符号的源码；
    // 空地图按产品契约不上桌，不能用这条交付测试强造一张假地图。
  } finally {
    await model.stop();
    await platform.stop();
  }
});



test("修复环:明确预算耗尽 → 保留会话记录并通知人工", async () => {
  // 停机依据是显式预算，不是 SHA 未变；到预算时保留最后的会话记录。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel([
    ...walkScript(true),
    { text: "诊断:流水线要求 sonar.yaml,需在质量平台为本仓开通配置;"
        + "配好后重跑即可。这不是本仓代码能修的,我不做无关改动。" },
  ], dataDir, { linear: true });
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
    },
    delivery: { platformUrl: platform.baseUrl, repairRounds: 1 },
    notifier: new Notifier({ endpoint: luban.endpoint }),
  });
  try {
    const id = service.create("交付 REQ9:修复环刹车",
      { account: "developer" }).id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "exhausted", "刹车落账");
    const task = service.get(id)!;
    assert.equal(task.status, "verifying", "如实停在验证中,不假装有结论");
    assert.match(task.delivery?.pipeline ?? "", /预算用完/);
    assert.equal(task.delivery?.loop?.round, 1, "只烧了一轮");
    // 诊断原文上浮:环账、任务详情都有"缺什么、去哪配"
    assert.match(task.delivery?.loop?.diagnosis ?? "", /sonar\.yaml/);
    assert.match(task.detail ?? "", /质量平台/);
    // 而且主动喊了人,不是等人来看页面
    await until(() => luban.messages.some((message) =>
      String(message.text ?? "").includes("需要你介入")), "停机通知送达");
    assert.ok(luban.messages.some((message) =>
      String(message.text ?? "").includes("sonar.yaml")),
      "通知里没带诊断,人还得自己猜");
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

