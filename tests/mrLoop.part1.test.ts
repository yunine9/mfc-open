/**
 * MR 闭环 part 1/6:检视回复闭环:讨论接口重试、显式代 resolve、答复等待检视人、outbox 恢复对 SHA。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 外部意见自动派发修复用例已由 externalReviewInbox 与责任人交办场景替代；保留回复发送及人工交办回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { DeliveryOutbox } from "../src/deliveryOutbox.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import {
  KERNEL_ROOT,
  makeSourceRepo,
  walkScript,
  feedbackReceiptCommand,
  localReviewReceiptCommand,
  closeWorkspaceReview,
  buildService,
  mrModel,
  until,
} from "./mrLoop.helpers.ts";


test("MR 讨论接口失败时明确显示自动重试，不能误报门禁全绿", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-unavailable", file: "a.txt", line: 1,
    author: "检视人", body: "这条意见必须处理",
  });
  platform.discussionListFailures = 100;
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-unavailable-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson());
    const id = service.create("交付 REQ9:讨论服务故障").id;
    await until(() => service.get(id)?.delivery?.waiting_on
      ?.includes("检视意见查询失败") ?? false,
    "讨论接口故障进入明确重试态");
    const task = service.get(id)!;
    assert.equal(task.status, "await_merge");
    assert.match(task.detail ?? "", /检视意见查询失败.*重试/);
    assert.doesNotMatch(task.detail ?? "", /门禁全绿/);
    assert.equal(platform.discussions[0].replies.length, 0,
      "拉取失败不能拿空列表冒充没有意见并生成回复");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("outbox 恢复发送强制匹配 push 收据 SHA，旧版回复不能借新分支发出", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({
    id: "d-recovery-sha", file: "a.txt", line: 1, severity: "major",
    author: "乙", body: "恢复场景意见",
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-recovery-sha-"));
  const service = new TaskService({
    dataDir, provider: "fixture", model: "fixture", maxConcurrent: 0,
    modelsJson: { providers: { fixture: { models: [{ id: "fixture" }] } } },
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3" },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 50 },
  });
  try {
    const id = service.create("outbox SHA 恢复", { ticket: "REQ_OUTBOX_SHA" }).id;
    const internal = (service as any).tasks.get(id);
    const expectedSha = "a".repeat(40);
    const otherSha = "b".repeat(40);
    internal.summary.delivery = { git_push: { sha: otherSha } };
    const outbox = new DeliveryOutbox(join(
      internal.summary.workspace, "delivery-outbox.jsonl"));
    const item = outbox.enqueueReviewReply({
      discussion_id: "d-recovery-sha", body: "已修复", repo: platform.barePath,
      resolve: false, expected_sha: expectedSha,
    });

    await (service as any).flushReviewReplyOutbox(internal);
    assert.equal(platform.discussions[0].replies.length, 0,
      "当前 push 是另一 SHA 时必须零网络副作用");
    const blocked = outbox.list().find((one) => one.id === item.id)!;
    assert.equal(blocked.state, "pending");
    assert.equal(blocked.attempts, 0, "SHA 拒绝不是一次远端 attempt");
    assert.match(blocked.last_error ?? "", /当前远端推送收据/);

    // 模拟重启对账恢复出这条动作真正对应的 push 收据；同一 pending
    // 此时才允许发送，并正常落 delivered。
    internal.summary.delivery.git_push.sha = expectedSha;
    await (service as any).flushReviewReplyOutbox(internal);
    assert.deepEqual(platform.discussions[0].replies, ["已修复"]);
    assert.equal(outbox.list().find((one) => one.id === item.id)?.state,
      "delivered");

    // 启动恢复与合入 watcher 可能同拍请求 flush；单飞必须保证同一动作
    // 只产生一次 attempt / 网络副作用，不能由本地竞态制造假 stalled。
    const concurrent = outbox.enqueueReviewReply({
      discussion_id: "d-recovery-sha", body: "并发恢复", repo: platform.barePath,
      resolve: false, expected_sha: expectedSha,
    });
    await Promise.all([
      (service as any).flushReviewReplyOutbox(internal),
      (service as any).flushReviewReplyOutbox(internal),
    ]);
    const concurrentState = outbox.list().find(
      (one) => one.id === concurrent.id)!;
    assert.equal(concurrentState.state, "delivered");
    assert.equal(concurrentState.attempts, 1);
    assert.deepEqual(platform.discussions[0].replies,
      ["已修复", "并发恢复"]);

    // 合法发送事实后出现完整坏行时必须 fail-closed 且把阻塞投影给人，
    // 不能只在后台 watcher 里反复抛错，让 await_merge 表面继续等合入。
    appendFileSync(outbox.path, "这不是 JSON\n", "utf-8");
    internal.summary.status = "await_merge";
    assert.equal(await (service as any).flushReviewReplyOutbox(internal), false);
    assert.match(internal.summary.detail, /检视回复发送账不可读/);
    assert.match(internal.summary.delivery.stalled, /delivery-outbox\.jsonl/);

    writeFileSync(outbox.path,
      readFileSync(outbox.path, "utf-8").replace("这不是 JSON\n", ""),
      "utf-8");
    let resumed = 0;
    (service as any).tryDeliver = async () => { resumed += 1; };
    internal.summary.status = "verifying";
    (service as any).scheduleDeliveryRecovery(
      internal, internal.controlEpoch);
    await until(() => internal.summary.delivery.stalled === undefined
      && resumed === 1, "修复发送账后在同一进程自动续接交付", 5_000);
    assert.equal(internal.summary.delivery.stalled, undefined);
    assert.match(internal.summary.detail, /发送账已恢复/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await platform.stop();
  }
});


test("外部新报告先待责任人判断，批量交办后才修，同一 MR 不自动回复或 resolve", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.seedDiscussion({ id: "owner-1", file: "a.txt", line: 1, author: "数字人", body: "建议删除兼容入口" });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-owner-review-"));
  const model = mrModel([...walkScript(),
    { tool: { name: "bash", input: { command: "echo guard >> a.txt; " + localReviewReceiptCommand("按责任人要求保留入口并补判断") } } },
    { text: "已按责任人要求修改。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:外部检视由责任人判断").id;
    await until(() => service.listAnnotations(id).items.some(item => item.external_review), "外部报告同步为批注");
    const note = service.listAnnotations(id).items.find(item => item.external_review)!;
    assert.equal(note.status, "draft");
    assert.equal(note.agent_assigned, undefined);
    assert.notEqual(service.get(id)!.delivery?.loop?.kind, "review");
    assert.equal(platform.discussions[0].replies.length, 0);
    service.supplementAnnotation(id, note.id, "保留入口，只补判断", "本地用户");
    await service.sendAnnotations(id, [note.id]);
    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.status === "await_merge", "人工交办已完成");
    assert.match(JSON.stringify(model.requests), /保留入口，只补判断/);
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(platform.discussions[0].resolved, false, "本地处理不伪造远端解决");
    assert.equal(platform.discussions[0].replies.length, 0);
    platform.seedDiscussion({ id: "owner-2", file: "a.txt", line: 1, author: "数字人", body: "新提交又产生一份报告" });
    await until(() => service.listAnnotations(id).items.filter(item => item.external_review).length === 2, "新报告只新增待判断批注");
    assert.equal(service.listAnnotations(id).items.find(item => item.external_review?.discussion_id === "owner-2")!.agent_assigned, undefined);
  } finally { await model.stop(); await platform.stop(); }
});
