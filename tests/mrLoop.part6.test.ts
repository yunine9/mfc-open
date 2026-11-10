/**
 * MR 闭环 part 6/6:流水线持续监听与 MR 终态:绿后转红自修、下单表单选项、closed 重开、停修复不停监控、外部合入新 SHA。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { workflowChoices, workflowLabel } from "../src/kernelChoices.ts";
import {
  KERNEL_ROOT,
  makeSourceRepo,
  walkScript,
  feedbackReceiptCommand,
  buildService,
  git,
  mrModel,
  until,
} from "./mrLoop.helpers.ts";


test("流水线绿后仍持续监听：同一 MR 后续转红会自动修复并重验", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("success", "failed", "success");
  platform.nextPipelineLog = "BUILD FAILURE: late gate regression";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-green-watch-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `sleep 0.5; echo late-fix >> a.txt; ${
          feedbackReceiptCommand("后续流水线回红已修复")}` } } },
    { text: "后续流水线回红已修复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:绿灯后继续监听").id;
    await until(() => service.get(id)!.status === "await_merge", "第一条流水线绿灯");
    const firstSha = service.get(id)!.delivery!.sha!;

    const late = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST",
      body: JSON.stringify({ sha: firstSha }),
    });
    assert.equal(late.status, 201);

    await until(() => service.get(id)!.delivery?.loop?.kind === "ci"
      && service.get(id)!.status === "running", "绿后回红自动派发修复");
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery?.sha !== firstSha, "修复后重新绿灯");
    assert.equal(platform.pipelines.length, 3,
      "首绿、后续回红、新提交复验三条流水线都要被看见");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("下单表单不列 review,但修复环问得到它的选项原文", () => {
  // 两个调用方对同一份内核目录的取法必须分开:表单只能列新单可选的
  // (选 review 会跳过设计与定稿还不碰规格,必错),而修复环要的恰恰
  // 是被滤掉的那个。谁也不许在 TS 侧写死"处理评审意见"。
  const labels = workflowChoices(KERNEL_ROOT).map((item) => item.label);
  assert.ok(labels.includes("完整开发"), "表单要列新单可选的");
  assert.ok(!labels.includes("处理评审意见"), "表单不许列 review");
  assert.equal(workflowLabel(KERNEL_ROOT, "review"), "处理评审意见");
  assert.equal(workflowLabel(undefined, "review"), "",
    "问不到内核就回空串,调用方 fail-open 回本单原交付方式");
});

test("MR 被关闭不算任务结束：持续监听，重开后恢复，用户可主动停止", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-closed-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:被关单").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    platform.settleMr("master_bot_REQ9", "closed");
    await until(() => service.get(id)!.delivery?.mr_state === "已关闭", "识别关闭");
    assert.equal(service.get(id)!.status, "await_merge", "关闭不是任务终态");
    assert.match(service.get(id)!.detail ?? "", /继续监听/);

    platform.mergeRequests[0].merge_state = "opened";
    await until(() => service.get(id)!.delivery?.mr_state === "等待合入", "重开后恢复");
    assert.match(service.get(id)!.detail ?? "", /重新打开/);

    const stopped = await service.cancel(id, "tester");
    assert.equal(stopped.status, "canceled", "MR 合入前用户始终可以主动停止");
    assert.throws(() => service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "停止后不应再新增", kind: "code",
    }), /用户停止/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("自动修复关闭只停修复不停监控：人工处理后仍能识别合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-watch-only-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(), {
    repairRounds: 0,
  });
  try {
    const id = service.create("交付 REQ9:只监控不自动修").id;
    await until(() => service.get(id)!.status === "await_merge", "先到等待合入");
    platform.conflictGate = true;
    await until(() => (service.get(id)!.delivery?.waiting_on ?? "")
      .includes("自动修复已关闭"), "明确提示人工处理红门禁");
    assert.equal(service.get(id)!.status, "await_merge");

    platform.conflictGate = false;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed",
      "人工处理后监控仍在并识别合入");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

// 平台人工合入覆盖本地旧版本；保留验证记录而不是替新代码造 PASS。

// 平台人工合入覆盖本地旧版本；保留验证记录而不是替新代码造 PASS。
test("MR 外部合入新 SHA：可信收口且不改写旧验证", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-shaswap-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:换提交").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    const verified = service.get(id)!.delivery?.sha ?? "";
    assert.ok(verified, "前置:等待合入时必须已有验证 SHA");
    // 模拟平台侧真实改写：外部开发者在同一来源分支追加一笔可从远端
    // 取证的提交。不能只捏造 40 位字符串；远端事实对账会（也应该）
    // 拒绝一个仓库里根本不存在的对象。
    const externalRoot = mkdtempSync(join(tmpdir(), "mfc-mrl-external-"));
    const external = join(externalRoot, "repo");
    git(externalRoot, "clone", "--quiet", platform.barePath, external);
    git(external, "config", "user.email", "external@test");
    git(external, "config", "user.name", "external");
    git(external, "checkout", "--quiet", "master_bot_REQ9");
    appendFileSync(join(external, "a.txt"), "external change\n");
    git(external, "add", "a.txt");
    git(external, "commit", "--quiet", "-m", "[REQ9][fix]外部补充提交");
    const swapped = git(external, "rev-parse", "HEAD");
    git(external, "push", "--quiet", "origin",
      "HEAD:refs/heads/master_bot_REQ9");
    platform.mergeRequests[0].sha = swapped;
    await until(() => Boolean(service.get(id)!.delivery?.stalled), "外部推送后先暂停旧版交付");
    platform.mergeRequests[0].merge_state = "merged";
    await until(() => service.get(id)!.status === "completed", "外部合入可信收口");
    const summary = service.get(id)!;
    assert.equal(summary.delivery?.sha, verified);
    assert.equal(summary.delivery?.merged_sha, swapped);
    assert.equal(summary.delivery?.stalled, undefined);
    const internal = (service as any).tasks.get(id);
    const state = JSON.parse(readFileSync(join(internal.cwd, ".mae-flow.json"), "utf-8"));
    assert.equal(state.current, "end");
    assert.equal(state.quality.external_verification.sha, verified);
    assert.equal(state.delivery_loop.close_events.at(-1).sha, swapped);
    assert.equal((service as any).dependencyCompleted(internal), true,
      "下游解锁同样使用可信合入收据，不再要求旧流水线背书新 SHA");
    await service.shutdown();
    // 模拟 close 已落盘、任务投影仍是事故前的 verifying 时进程退出。
    const persisted = JSON.parse(readFileSync(join(summary.workspace, "task.json"), "utf-8"));
    persisted.summary.status = "verifying";
    persisted.summary.delivery.stalled = "old SHA mismatch";
    delete persisted.summary.delivery.merged_sha;
    writeFileSync(join(summary.workspace, "task.json"), JSON.stringify(persisted));
    const revived = buildService(platform, dataDir, model.modelsJson());
    try {
      revived.recover();
      assert.equal(revived.get(id)!.status, "completed", "重启使用可信 close 恢复终态");
      assert.equal(revived.get(id)!.delivery?.merged_sha, swapped);
      assert.equal(revived.get(id)!.delivery?.stalled, undefined);
      assert.equal(platform.mergeRequests.length, 1);
      assert.equal(platform.pipelines.length, 1);
    } finally { await revived.shutdown(); }
  } finally {
    await model.stop();
    await platform.stop();
  }
});
