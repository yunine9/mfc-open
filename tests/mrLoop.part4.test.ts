/**
 * MR 闭环 part 4/6:单 writer 竞态:steer 撞派单并入、Build-Fix 中停净旧执行权、反馈批次排队重启恢复、合入先停写。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import {
  git,
  makeSourceRepo,
  walkScript,
  localReviewReceiptCommand,
  feedbackReceiptCommand,
  buildService,
  mrModel,
  until,
  closeWorkspaceReview,
} from "./mrLoop.helpers.ts";


test("单 writer 竞态：steer 与派单相撞时并入当前 Agent，不启动第二只", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed", "success");
  platform.artifacts.push({
    name: "build_log.txt",
    text: "BUILD FAILURE: src/a.cpp:12: error: expected null guard",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-local-ci-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        "sleep 1; echo ci-and-review >> a.txt; "
        + localReviewReceiptCommand("流水线与人工意见已合并处理") + "; "
        + feedbackReceiptCommand("流水线反馈已同步修复") } } },
    { text: "流水线问题与人的检视意见已合并处理。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:CI 与本地检视并发").id;
    await until(() => service.get(id)!.status === "running"
      && service.get(id)!.delivery?.loop?.kind === "ci", "CI Agent 已开跑");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "同时把空值返回改成明确错误", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);
    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.status === "await_merge", "合并修改后绿灯");

    assert.equal(service.listAnnotations(id).items[0].sent_via, "review_repair");
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(platform.pipelines.length, 2,
      "人的意见并入当前 CI 提交，只应为新 SHA 再跑一条流水线");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /空值返回改成明确错误/);
    assert.match(seen, /结合正在进行的修复处理/);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("单 writer 竞态：Build-Fix 中收到人工意见会停净旧执行权再派单", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-prepush-race-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:Build-Fix 抢占").id;
    await until(() => service.get(id)!.status === "await_merge", "先形成原 MR");
    const internal = (service as any).tasks.get(id);
    const requestsBeforeRace = model.requests.length;
    const abort = new AbortController();
    internal.summary.status = "running";
    internal.summary.detail = "Build-Fix 正在验证";
    internal.prepushAbort = abort;
    internal.prepushActive = new Promise<boolean>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve(false), { once: true });
    });
    // 聚焦竞态：让新修复留在队列，不真的消费下一幕模型剧本。
    (service as any).runningCount = 99;
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "人工意见必须先处理", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);

    assert.equal(abort.signal.aborted, true, "旧 Build-Fix 必须先收到中止信号");
    assert.equal(internal.prepushActive, undefined, "确认旧执行权释放后才能派新轮");
    assert.equal(service.get(id)!.status, "queued");
    // 会话交接(46ce8ad7 起保留 Pi 会话)会把"无未送达 steer"归一成 []，
    // 竞态前就已是 []；守的是"没有意见被停在无人消费的队列里"，不是字段形状。
    assert.deepEqual(internal.pendingMainSteers ?? [], [],
      "不能把意见交给已不存在的 Build-Fix driver 后无人消费");
    assert.ok(service.get(id)!.feedback?.some((item) =>
      item.source === "workspace" && item.status === "repairing"));
    assert.equal(model.requests.length, requestsBeforeRace,
      "竞态期间不能启动第二只代码 writer");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("单 writer 竞态：反馈批次排队后重启只恢复一轮且不重复 push", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-feedback-recover-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `echo recovered-review >> a.txt; ${localReviewReceiptCommand("重启后原批次已处理")}` } } },
    { text: "重启后继续原反馈批次。" },
  ], dataDir);
  await model.start();
  const first = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = first.create("交付 REQ9:反馈重启恢复").id;
    await until(() => first.get(id)!.status === "await_merge", "先形成原 MR");
    (first as any).runningCount = 99;
    const note = first.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "重启后也不能丢的意见", kind: "code",
    });
    await first.sendAnnotations(id, [note.id]);
    assert.equal(first.get(id)!.status, "queued", "反馈已持久化但尚未取得 writer");
    assert.equal(first.get(id)!.feedback?.length, 1);
    (first as any).shuttingDown = true; // 模拟旧进程退出，不再消费队列/监听。

    const revived = buildService(platform, dataDir, model.modelsJson());
    assert.equal(revived.recover().restored, 1);
    await closeWorkspaceReview(revived, id, [note]);
    await until(() => revived.get(id)!.status === "await_merge", "重启后原批次收敛");
    assert.equal(revived.get(id)!.feedback?.filter((item) =>
      item.source_id === note.id).length, 1, "batch_id 重放不能复制反馈");
    assert.equal(platform.mergeRequests.length, 1, "恢复不能重建 MR");
    assert.equal(platform.pipelines.length, 2, "只为反馈产生的新 HEAD 追加一次流水线");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("单 writer 竞态：修复 Agent 运行中旧 MR 合入会停写，但不能完成未推送的新提交", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("success", "failed");
  platform.nextPipelineLog = "BUILD FAILURE: late failure before merge";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-merge-race-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        "sleep 5; echo must-not-land >> a.txt" } } },
    { text: "这句不应越过合入终态。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:合入抢占修复").id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const verified = service.get(id)!.delivery!.sha!;
    await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha: verified }),
    });
    await until(() => service.get(id)!.status === "running"
      && service.get(id)!.delivery?.loop?.kind === "ci", "修复 writer 已启动");

    const workspace = service.get(id)!.workspace;
    const repo = readdirSync(workspace).map((name) => join(workspace, name))
      .find((path) => existsSync(join(path, ".mae-flow.json")))!;
    appendFileSync(join(repo, "a.txt"), "local-only\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-m", "[REQ9][fix] local-only before merge");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), verified,
      "事故注入必须先形成尚未 push 的干净本地提交");

    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => Boolean(service.get(id)!.delivery?.stalled),
      "旧合入不能完成未推送的新提交");
    const kernelState = JSON.parse(readFileSync(
      join(repo, ".mae-flow.json"), "utf-8"));
    assert.notEqual(service.get(id)!.status, "completed");
    assert.notEqual(kernelState.current, "end");
    assert.match(service.get(id)!.detail ?? "", /未确认包含当前本地提交/);
    assert.equal(platform.mergeRequests.length, 1);
    assert.match(readFileSync(join(repo, "a.txt"), "utf-8"), /local-only/,
      "未推送提交现场要保留给人核对");
    assert.doesNotMatch(readFileSync(join(repo, "a.txt"), "utf-8"),
      /must-not-land/, "被抢占的旧 writer 不得在完成后继续落代码");
  } finally {
    await model.stop();
    await platform.stop();
  }
});