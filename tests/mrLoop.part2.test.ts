import { requestBuildFixBeforeDelivery } from "./support/requestedBuildFix.ts";
/**
 * MR 闭环 part 2/6:回复入队与回执:部分失败续投、Build-Fix 后入队绑 SHA、台账跨批继承、漏回执补交与只催一次。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 外部意见自动派发修复用例已由 externalReviewInbox 与责任人交办场景替代；保留回复发送及人工交办回归。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import type { PrePushRunner } from "../src/prepushAgent.ts";
import {
  git,
  makeSourceRepo,
  walkScript,
  localReviewReceiptCommand,
  buildService,
  mrModel,
  until,
  closeWorkspaceReview,
} from "./mrLoop.helpers.ts";


test("本地检视首次漏回执时原会话自动补交，不直接停机", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-receipt-repair-"));
  const model = mrModel([
    ...walkScript(),
    // 第一回合模拟真实事故：代码已经按意见改好，但没有留下机器回执。
    { tool: { name: "bash", input: { command:
        "echo reviewed >> a.txt" } } },
    { text: "检视意见已修改完成。" },
    // 宿主必须续用同一会话窄催办；第二回合只补回执，不重烧代码修改。
    { tool: { name: "bash", input: { command:
        localReviewReceiptCommand("已复核当前代码，意见已经落实") } } },
    { text: "逐条回执已补齐。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:缺回执自动恢复", { lane: "完整开发" }).id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "补上边界处理", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);

    await until(() => Boolean(service.listAnnotations(id).items[0]?.response),
      "原会话补齐逐条回执");
    const duringReview = service.get(id)!;
    assert.notEqual(duringReview.delivery?.loop?.state, "halted",
      "第一次漏回执是可恢复的协议疏漏，不得直接停机");
    assert.match(
      service.listAnnotations(id).items[0]?.response?.summary ?? "",
      /意见已经落实/);

    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.status === "await_merge", "补回执后正常交付");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /现在只补回执，不要重新修改代码/,
      "自动恢复必须是窄使命，不能让 Agent 重做检视修改");
  } finally {
    await service.shutdown();
    await model.stop();
    await platform.stop();
  }
});

test("自动补回执仍失败时只催一次并保留现场", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-receipt-bounded-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command: "echo reviewed >> a.txt" } } },
    { text: "检视意见已修改，但忘了回执。" },
    // 第二回合仍不写，验证宿主不会无限 continueWith。
    { text: "本轮仍未写入回执。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:补回执有界", { lane: "完整开发" }).id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "补上边界处理", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);

    await until(() => service.get(id)!.delivery?.loop?.state === "halted",
      "自动补交一次后明确停下");
    const summary = service.get(id)!;
    assert.match(summary.detail ?? "", /自动补交逐条检视回执后仍未完成/);
    assert.match(summary.detail ?? "", new RegExp(note.id));
    const receiptNudges = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .filter((message: any) => JSON.stringify(message.content ?? "")
        .includes("现在只补回执，不要重新修改代码"));
    assert.equal(receiptNudges.length, 1, "同一批意见最多自动催补一次");
    assert.equal(existsSync(join(summary.workspace, "reviews",
      "local-annotations.json")), true, "停机后仍保留检视现场");
  } finally {
    await service.shutdown();
    await model.stop();
    await platform.stop();
  }
});