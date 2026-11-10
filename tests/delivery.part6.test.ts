/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 6/6:重启恢复(recover 续轮、可信收据、老单/回收封存)与宿主
 * 推送门禁(硬闸、SHA 钉死、推送失败自愈停摆)。共享夹具在
 * tests/delivery.helpers.ts;断言与测试行为零变化。
 */

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
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import { closeKernelDelivery } from "../src/kernelDelivery.ts";
import {
  KERNEL_ROOT,
  buildService,
  git,
  makeSourceRepo,
  runTask,
  until,
} from "./delivery.helpers.ts";

test("进程可死轮询不死:重启 recover 后继续收敛流水线", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    // 第一进程:走到 verifying+running 后"死掉"(直接弃用实例)。
    const { task, dataDir } = await runTask(
      platform, true, { pollIntervalMs: 100_000 });
    assert.equal(task.delivery?.pipeline, "running");
    // 第二进程:recover 续轮,绿灯后收敛。
    const revived = buildService(
      platform, dataDir, {}, { pollIntervalMs: 100 });
    assert.equal(revived.recover().restored, 1);
    platform.finishPipeline(task.delivery!.sha!, "success");
    await until(() =>
      revived.get(task.id)!.status === "await_merge", "重启后轮询收敛");
  } finally {
    await platform.stop();
  }
});

test("内核 close 成功但 Cloud 完成投影未落盘：重启从可信收据恢复 completed", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task, service, dataDir } = await runTask(platform, true,
      { pollIntervalMs: 100_000 });
    assert.equal(task.status, "await_merge");
    await service.shutdown();
    const saved = JSON.parse(readFileSync(
      join(dataDir, task.id, "task.json"), "utf-8"));
    closeKernelDelivery({
      host: { kernelRoot: KERNEL_ROOT, python: "python3" },
      cwd: saved.cwd,
      workspace: task.workspace,
      taskId: task.id,
      sha: task.delivery!.sha!,
      eventId: `mr-merged:${task.id}:${task.delivery!.sha}`,
    });
    assert.equal(JSON.parse(readFileSync(
      join(dataDir, task.id, "task.json"), "utf-8")).summary.status,
    "await_merge", "模拟进程死在内核 close 后、Cloud persist 前");

    const revived = buildService(platform, dataDir, {}, { pollIntervalMs: 100 });
    assert.equal(revived.recover().restored, 1);
    const recovered = revived.get(task.id)!;
    assert.equal(recovered.status, "completed", JSON.stringify(recovered));
    assert.match(recovered.detail ?? "", /可信.*close.*恢复完成/);
    await revived.shutdown();
  } finally {
    await platform.stop();
  }
});

test("预算耗尽注记不挡续轮:重启只继续盯同 SHA,不重建 MR 不重触发", async () => {
  // 2026-08-29 部署审计实锤:轮询预算耗尽把 pipeline 写成
  // "running(轮询预算耗尽,请人工查看流水线)",recover 的全等匹配认不出
  // 它,任务跌进 tryDeliver 兜底——重建 MR + 同 SHA 重新触发流水线,
  // 每次重启白烧一条。前缀匹配 + tryDeliver 的 running 岔路挡住这条路。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  try {
    const { task, dataDir } = await runTask(
      platform, true, { pollIntervalMs: 100_000 });
    assert.equal(task.delivery?.pipeline, "running");
    const before = { mrs: platform.mergeRequests.length,
                     runs: platform.pipelines.length };
    // 伪造上一段进程的临终笔迹:预算耗尽留痕后死于重启。
    const statePath = join(dataDir, task.id, "task.json");
    const saved = JSON.parse(readFileSync(statePath, "utf-8"));
    saved.summary.delivery.pipeline = "running(轮询预算耗尽,请人工查看流水线)";
    writeFileSync(statePath, JSON.stringify(saved, null, 1));
    const revived = buildService(
      platform, dataDir, {}, { pollIntervalMs: 100 });
    assert.equal(revived.recover().restored, 1);
    platform.finishPipeline(task.delivery!.sha!, "success");
    await until(() =>
      revived.get(task.id)!.status === "await_merge", "耗尽注记后续轮收敛");
    assert.equal(platform.mergeRequests.length, before.mrs,
      "重启不许重建 MR");
    assert.equal(platform.pipelines.length, before.runs,
      "同 SHA 不许被重新触发");
  } finally {
    await platform.stop();
  }
});

test("老单不被新尺子重新量:恢复不翻状态、更不会把分支重新推回去", async () => {
  // 读代码逮住、第一次重启就会发生的事:恢复时对每个落盘 completed 的
  // 任务重做终态对账,而老单现场里没有 execution_contract,判据按"云端
  // 默认三项交流水线"取——老单永远拿不出逐项 PASS,一律被判伪终态:
  // 状态翻回验证中,接着 tryDeliver 真的 git push。已合入、远端分支早
  // 删掉的老单会被重新推回去,列表里一堆历史单变"验证中"。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-legacy-"));
    const workspace = join(dataDir, "task-1");
    const cwd = join(workspace, "repo");
    mkdirSync(cwd, { recursive: true });
    git(cwd, "init", "--quiet", "-b", "master_bot_REQ1");
    git(cwd, "config", "user.email", "bot@test");
    git(cwd, "config", "user.name", "bot");
    writeFileSync(join(cwd, "a.txt"), "old\n");
    git(cwd, "add", ".");
    git(cwd, "commit", "--quiet", "-m", "老单当时的交付");
    // origin 必须真接得上,否则"没推成"是因为推不动,断言就成了摆设
    // ——老行为在这里是**能推上去**的,这才是这条用例要挡的事。
    git(cwd, "remote", "add", "origin", platform.barePath);
    // 老现场:没有 execution_contract,也没有外部验证记录。
    writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
      schema_version: 2, current: "end", revision: 1,
      config: { 分支名: "master_bot_REQ1", 基线分支: "master", 单号: "REQ1" },
      choices: {}, history: [],
    }));
    writeFileSync(join(workspace, "task.json"), JSON.stringify({
      summary: {
        id: "task-1", requirement: "老单", status: "completed",
        created_at: new Date().toISOString(), workspace,
        delivery: { mr_state: "已合入", sha: git(cwd, "rev-parse", "HEAD") },
      },
      cwd,
    }));

    const revived = buildService(platform, dataDir, {});
    assert.equal(revived.recover().restored, 1);
    await new Promise((tick) => setTimeout(tick, 400));
    const task = revived.get("task-1")!;
    assert.equal(task.status, "completed", "老单不该被翻回验证中");
    assert.equal(task.delivery?.stalled, undefined);
    // 最要命的那一下:远端一次都不该被写(已合入的老单分支往往早删了,
    // 重推等于把它凭空复活)。
    assert.equal(
      git(platform.barePath, "branch", "--list", "master_bot_REQ1"), "",
      "老单的分支被重新推回了远端");
  } finally {
    await platform.stop();
  }
});

test("现场回收过的单封存台账,不再重新裁决——更不许重新推回远端", async () => {
  // 上一条挡的是"老单没有 execution_contract 被新尺子量";这条挡的是
  // 同一个坑的另一种成因:**尺子是我们自己弄丢的**。现场回收把克隆连同
  // .mae-flow.json 一起删了,恢复时再对账必然读不到证据 → 收好口的单被翻
  // 成验证中 → tryDeliver 真的 git push,把两周前早已合入、分支早删的
  // 老单凭空复活。所以回收 = 台账封存,recover 不许再量它。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaimed-"));
    const workspace = join(dataDir, "task-1");
    const cwd = join(workspace, "notify-service");   // 已被回收,不存在
    mkdirSync(workspace, { recursive: true });
    // 台账还在(交付历史一个字节都没动),现场没了。
    // 注意 delivery 里**没有** mr_state:"已合入"——那条捷径会让
    // settledBeforeContract 直接放行,断言就成了摆设,挡不住真正的坑。
    writeFileSync(join(workspace, "task.json"), JSON.stringify({
      summary: {
        id: "task-1", requirement: "两周前那单", status: "completed",
        created_at: new Date(Date.now() - 30 * 86400_000).toISOString(),
        completed_at: new Date(Date.now() - 28 * 86400_000).toISOString(),
        workspace,
        workspace_reclaimed_at: new Date().toISOString(),
        delivery: { mr_url: "https://内网/mr/42", sha: "abc123" },
      },
      cwd,
    }));
    writeFileSync(join(workspace, "events.jsonl"), "");

    const revived = buildService(platform, dataDir, {});
    assert.equal(revived.recover().restored, 1, "回收过的单仍要出现在历史里");
    await new Promise((tick) => setTimeout(tick, 400));
    const task = revived.get("task-1")!;
    assert.equal(task.status, "completed", "回收过的单被翻回验证中了");
    assert.equal(task.delivery?.mr_url, "https://内网/mr/42",
      "交付账本必须原样活下来");
    assert.equal(task.workspace_reclaimed_at !== undefined, true,
      "回收标记要能被前端读到,页面才说得出「现场已回收」");
    // 最要命的那一下:远端一次都不该被写。
    assert.equal(
      git(platform.barePath, "branch", "--list", "master_bot_REQ1"), "",
      "回收过的老单分支被重新推回了远端");
  } finally {
    await platform.stop();
  }
});

test("交付传输失败 → 不硬造 MR,停在验证中并说明原因", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task } = await runTask(platform, false);
    assert.equal(task.status, "verifying");
    const failure = [task.delivery?.skipped, task.delivery?.waiting_on,
      task.detail].filter(Boolean).join("\n");
    assert.match(failure, /远端交付核验未完成|宿主推送失败|冲突修复准备失败\(fetch/);
    assert.match(task.delivery?.waiting_on ?? "", /自动重试|权威流水线/);
    assert.equal(platform.mergeRequests.length, 0);
  } finally {
    await platform.stop();
  }
});

test("宿主 push 等待远端 Hook 时不阻塞 Node 事件循环", async () => {
  const cwd = makeSourceRepo();
  git(cwd, "commit", "--amend", "--quiet", "-m",
    "[TASK_ASYNC_PUSH][fix]初始化异步推送测试仓");
  const remote = mkdtempSync(join(tmpdir(), "mfc-async-push-remote-"));
  git(remote, "init", "--bare", "--quiet");
  const hook = join(remote, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\nsleep 0.2\nexit 0\n");
  chmodSync(hook, 0o700);
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-async-push-data-")),
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
  });
  let timerFired = false;
  const pushing = (service as any).pushFromHost({
    cwd,
    summary: { id: "task-async-push", repo_url: remote },
  }, "async-push-test");
  setTimeout(() => { timerFired = true; }, 30);
  try {
    const receipt = await pushing;
    assert.match(receipt.sha, /^[a-f0-9]{40}$/);
    assert.equal(timerFired, true,
      "远端 Hook 很慢时定时器、HTTP 和 SSE 回调必须仍能执行");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("宿主 push 硬拒本任务新提交的 Agent 平台注入目录", async () => {
  const cwd = makeSourceRepo();
  const baseline = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  mkdirSync(join(cwd, ".claude", "skills", "central"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "central", "SKILL.md"),
    "center injected\n");
  git(cwd, "add", "-f", ".claude/skills/central/SKILL.md");
  git(cwd, "commit", "--quiet", "-m", "accidentally add injected skill");
  const remote = mkdtempSync(join(tmpdir(), "mfc-platform-path-remote-"));
  git(remote, "init", "--bare", "--quiet");
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-platform-path-data-")),
    provider: "fixture", model: "fixture", modelsJson: {},
  });
  try {
    await assert.rejects(() => (service as any).pushFromHost({
      cwd,
      summary: { id: "task-platform-path", repo_url: remote },
    }, "must-not-exist"), /Agent 平台本地目录.*\.claude/s);
    assert.equal(git(remote, "branch", "--list", "must-not-exist"), "",
      "硬闸命中后远端不能出现分支");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("宿主 push 核对已确认 SHA，HEAD 变化时不发送且保留文件范围确认", async () => {
  const cwd = makeSourceRepo();
  const approved = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "after-review.txt"), "not reviewed\n");
  git(cwd, "add", "after-review.txt");
  git(cwd, "commit", "--quiet", "-m", "change after review");
  const current = git(cwd, "rev-parse", "HEAD");
  assert.notEqual(current, approved);
  const remote = mkdtempSync(join(tmpdir(), "mfc-toctou-remote-"));
  git(remote, "init", "--bare", "--quiet");
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-toctou-data-")),
    provider: "fixture", model: "fixture", modelsJson: {},
  });
  try {
    await assert.rejects(() => (service as any).pushFromHost({
      cwd,
      summary: { id: "task-toctou", repo_url: remote },
    }, "must-not-exist", approved),
    /传输准备后 HEAD 从 .* 变为 .*本次未发送.*已有文件范围确认保留/);
    assert.equal(git(remote, "branch", "--list", "must-not-exist"), "",
      "SHA 不一致时远端不能出现分支");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("交付失败先自愈、预算耗尽如实停摆,人拿得回控制权", async () => {
  // 实测过的死水:推送失败(内网 504 是已知风险)后任务永久停在
  // verifying——没有定时器盯、重启不复活、retry 还拿"验证还在进行中"
  // 顶回来,而根本没有任何东西在跑。唯一出路是取消整单。
  // 现在的语义:先带预算自己再试(504 多半是一阵子的事),预算烧完
  // 就如实停下写清原因并喊人,人办完外部的事点重跑接着干。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task, service } = await runTask(
      platform, false, { pollIntervalMs: 120, pollTimeoutMs: 1500 });
    // 自愈期内不许判停摆,也不许放人重跑(那会重复烧流水线)。
    assert.equal(task.delivery?.stalled, undefined);
    assert.throws(() => service.retry(task.id), /还在进行中/);

    await until(() => Boolean(service.get(task.id)!.delivery?.stalled),
      "自愈预算耗尽后如实停摆");
    const stalled = service.get(task.id)!;
    assert.equal(stalled.status, "verifying"); // 代码确实提交了,不假装 failed
    assert.match(stalled.delivery!.stalled!,
      /远端交付核验未完成|宿主推送失败|冲突修复准备失败\(fetch/);
    assert.match(stalled.detail ?? "", /自动验证已停,需要你介入/);
    // 停摆后在途的交付尝试迟到，也不能把“需要你介入”盖成普通失败。
    const state = (service as any).tasks.get(task.id);
    (service as any).holdWithRecovery(state,
      "等待权威流水线：迟到的交付尝试失败", state.controlEpoch);
    assert.match(service.get(task.id)!.detail ?? "", /自动验证已停,需要你介入/,
      "停摆原因必须由人点重跑才清除");
    // 绕过 holdWithRecovery 的流水线观察同样不能覆盖停摆原因。
    (service as any).holdExternalVerification(state, "等待流水线证据核销：迟到观察");
    assert.match(service.get(task.id)!.detail ?? "", /自动验证已停,需要你介入/,
      "停摆原因不受迟到观察影响");
    // 回程票:停摆之后人点得动「重跑续推」,且账本被清干净重新开表。
    const again = service.retry(task.id);
    // 外部交付停机只重试宿主侧动作，不应再叫醒主 Agent 白跑一轮。
    assert.equal(again.status, "verifying");
    assert.match(again.detail ?? "", /重新尝试交付/);
    assert.equal(again.delivery?.stalled, undefined);
    assert.equal(again.delivery?.verify_deadline, undefined);
    assert.equal(again.delivery?.skipped, undefined,
      "新一轮已受理后不应继续显示上一轮交付已阻止");
    assert.equal(again.delivery?.waiting_on, undefined,
      "上一轮失败的等待原因不能冒充新一轮当前状态");
  } finally {
    await platform.stop();
  }
});
