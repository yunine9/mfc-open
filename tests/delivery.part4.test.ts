/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 4/6:部署形态(固定交付地址、归属人身份头)、Cloud 固有执行契约
 * 与停机后的回程票。共享夹具在 tests/delivery.helpers.ts;
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
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

test("交付服务是部署基础设施:固定地址跑通交付", async () => {
  // MR/流水线服务与验证形态都是部署事实，不在管理员页面暴露。
  // 仓不在此列(2026-08-18 改口径):**交付仓每单必填,没有默认仓**
  // ——一个部署服务很多个仓,默认值只会让人把单下错地方。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(walkScript(true), dataDir);
  await model.start();
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      python: "python3",
      continuousReview: true,
      // 刻意不给 repoPath:代码仓由本单明确填写
    },
    delivery: { platformUrl: platform.baseUrl },
  });
  try {
    const id = service.create("交付 REQ9:纯界面配置",
      // 仓与单号按单填(没有默认仓;单号必填与仓同口径)
      { repo: platform.barePath, ticket: "REQ9" }).id;
    await until(() => service.get(id)!.status === "await_merge",
      "界面配置驱动交付收轮");
    const task = service.get(id)!;
    assert.equal(task.delivery?.pipeline, "success");
    assert.equal(platform.mergeRequests.length, 1, "MR 打到了部署配置的平台");
    // Cloud 固有执行契约不依赖可选旗子。
    const opening = JSON.stringify(
      ((model.requests[0] as any).messages ?? [])
        .filter((m: any) => m.role === "user")[0]?.content ?? "");
    assert.match(opening, /Cloud 执行契约/);
    assert.match(opening, /权威流水线/);
    assert.match(opening, /task_control push\/create_mr.*无需先修完所有旧问题/,
      "真实开场应告知已开放阶段性发布，不能只注册工具而仍提示禁止推送");
    assert.doesNotMatch(opening, /也不要 push|真验收有三道|每次 push 前 Cloud 另起/);
    assert.match(opening, /\.claude.*\.cac.*本地忽略.*push 前复核/s,
      "主 Agent 开场必须知道平台注入目录不属于交付");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("交付请求带任务归属人身份头:MR 发起人=本人的原料到位", async () => {
  // 令牌走请求头不走请求体——体会被外部动作台账记进投影,头不会。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(walkScript(true), dataDir);
  await model.start();
  const service = new TaskService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
      continuousReview: true,
    },
    delivery: { platformUrl: platform.baseUrl },
    gitCredential: (account) => account === "zhang"
      ? { username: "zhang.san", password: "glpat-秘密-8888" } : undefined,
  });
  try {
    const id = service.create("交付 REQ9:身份头", { account: "zhang" }).id;
    await until(() => service.get(id)!.status === "await_merge", "交付收轮");
    const mrCall = platform.seenIdentity.find((c) => c.path === "/mr");
    assert.equal(mrCall?.user, "zhang.san");
    assert.equal(decodeURIComponent(mrCall?.token ?? ""), "glpat-秘密-8888",
      "非 ASCII 令牌经 percent 编码后原样到达");
    assert.ok(platform.seenIdentity.some((c) =>
      c.path === "/pipeline/trigger" && c.token), "触发流水线也带身份");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("停机后的回程票:人工办完外部事项,重跑续推到绿灯收口", async () => {
  // "需人工"不能是死胡同:halted 的任务点重跑=人工背书"外部的事
  // 办完了",清停机账,同 SHA 重新验证——外部配置修好后同一提交的
  // 流水线就该绿。在途验证(非停机)点重跑要被拒,别重复烧流水线。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  // 停机前一跑红,之后绿。旧机械同 SHA 修复失败要再烧一条流水线才判
  // halted,MR 闭环改造后不烧(同 SHA 直接按上次结果裁),队列只需一个红。
  platform.statusQueue.push("failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel([
    ...walkScript(true),
    { text: "诊断:需要在质量平台配 sonar.yaml,不是代码问题。" },
    { text: "外部配置已就绪,续推收口。" },        // 重跑的重建会话
  ], dataDir, { linear: true });
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:停机重跑").id;
    await until(() =>
      service.get(id)!.delivery?.loop?.state === "halted", "先停机");
    service.retry(id);
    await until(() => service.get(id)!.status === "await_merge",
      "重跑后绿灯收口");
    const task = service.get(id)!;
    assert.equal(task.delivery?.pipeline, "success");
    assert.equal(task.delivery?.loop?.state, "green",
      "停机态已清，但修复轮历史要保留给持续检视审计");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("Cloud 固有执行契约进每次会话开场,修复会话也不例外", async () => {
  // 重建/重启恢复的会话走 launch,每次开场重发最新执行契约(与请求 0
  // 同一路径),不能拿历史里旧开场冒充当前输入;进程内续用的原会话则
  // 契约已在本进程下发的开场里,修复使命作为最新输入送达。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(
    [...walkScript(true), ...repairScenes(true)],
    dataDir, { linear: true });
  await model.start();
  // 走共享夹具:它屏蔽首次 MR 旁路摘要(ec3011b0)。直接 new 时摘要会话
  // 领走线性剧本的修复幕,修复会话拿不到剧本、永远等不到绿灯(实测超时)。
  const service = buildService(platform, dataDir, model.modelsJson(),
    { repairRounds: 2 });
  try {
    const id = service.create("交付 REQ9:流水线代行").id;
    await until(() => service.get(id)!.status === "await_merge", "修复后全绿");
    const userTexts = (at: number): string[] =>
      ((model.requests[at] as any).messages ?? [])
        .filter((m: any) => m.role === "user" && (typeof m.content === "string"
          || m.content?.some((block: any) => block.type === "text")))
        .map((m: any) => JSON.stringify(m.content));
    const latestUser = (at: number) => userTexts(at).at(-1) ?? "";
    // 首跑会话(请求 0)开场带环境事实
    assert.match(latestUser(0), /Cloud 执行契约/);
    // 修复轮(请求 2):46ce8ad7 起宿主操作/首轮交付后在同一进程内续用原
    // Pi 会话(docs/issue-395-session-continuity.md),不再重建会话重发整份
    // 启动提示——契约就在这条会话本进程下发的开场里。守的是"修复时模型
    // 眼前有契约 + 本轮修复使命",所以契约查整段上下文,使命查最新输入。
    const repairContext = userTexts(2).join("\n");
    assert.match(userTexts(2)[0] ?? "", /Cloud 执行契约/,
      "修复轮续用原会话,本进程下发的开场契约仍在上下文");
    assert.match(repairContext, /分别如实记录.*不能互相冒充/);
    assert.match(repairContext, /无需先修完所有旧问题/);
    assert.doesNotMatch(repairContext, /也不要 push/);
    assert.match(repairContext, /不要编造命令、结果、数量或绿灯/);
    assert.match(latestUser(2), /当前目标是处理本轮流水线失败/, "修复使命作为最新输入下发");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
