/**
 * 定向知识提取(用户拍板 2026-09-01):"参考那个仓某模块的做法"→
 * 一份可编辑的 SKILL.md 草稿。契约:
 * - 草稿必须显式带 ===SKILL===/===NOTES=== 标记,模型闲聊不许混进草稿;
 * - 克隆是真只读(git 配置层 pushurl 毒化),不是提示词嘱咐;
 * - 草稿过密钥扫描,命中整份作废;
 * - 与其他知识任务共用 50 个执行名额;克隆失败/重启中断都如实分类报错,不装完成。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService, TaskControlError } from "../src/taskService.ts";
import {
  buildExtractionMission,
  parseExtractionDraft,
  persistExtractionJob,
} from "../src/knowledgeExtraction.ts";

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** 本地裸参考仓:提取只读,内容有一个能被"提取"的重试实现文件。 */
function referenceRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-ke-ref-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "RetryPolicy.java"),
    "class RetryPolicy { int max = config.get(\"retry.max\"); }\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "baseline");
  return cwd;
}

function serviceWith(model: ScriptedModelServer): TaskService {
  return new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-ke-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
}

const GOOD_REPLY = [
  "===SKILL===",
  "---",
  "name: retry-policy-reference",
  "description: 参考仓的重试上限如何配置",
  "---",
  "我把你的问题理解为:重试上限怎么配。提取自参考仓。",
  "重试逻辑在 RetryPolicy.java,上限读配置项 retry.max。",
  "## 迁移注意",
  "依赖对方仓的 config 组件,搬走要换成本仓配置读取方式。",
  "===NOTES===",
  "读了 RetryPolicy.java;没找到测试,retry.max 默认值不确定。",
].join("\n");

test("parseExtractionDraft:必须显式带标记,闲聊不当草稿", () => {
  const parsed = parseExtractionDraft(
    `好的,我来提取。\n${GOOD_REPLY}`);
  assert.ok(parsed);
  assert.match(parsed.draft, /retry-policy-reference/);
  assert.match(parsed.draft, /迁移注意/);
  assert.match(parsed.notes, /默认值不确定/);
  assert.ok(!parsed.draft.includes("===NOTES==="));
  // 缺标记就是没有草稿，不能把闲聊当成待审查正文。
  assert.equal(parseExtractionDraft("这是一份没有标记的草稿"), undefined);
  assert.equal(parseExtractionDraft("===SKILL===\n只有一半"), undefined);
});

test("任务书:意图/路径提示/只读警告/内置纪律齐活", () => {
  const mission = buildExtractionMission({
    repoLabel: "git@example.com:demo/ref.git",
    intent: "重试上限怎么配",
    pathHint: "src/retry",
    timeoutMinutes: 10,
  });
  assert.match(mission, /提取意图:重试上限怎么配/);
  assert.match(mission, /路径提示.*src\/retry/);
  assert.match(mission, /只读克隆/);
  assert.match(mission, /第一句复述意图/);       // 内置 skill 正文确实注入了
  assert.match(mission, /迁移注意/);
  assert.match(mission, /绝对禁止抄入敏感值/);
});

test("端到端:剧本会话产草稿;克隆真只读;job 留档", async () => {
  const model = new ScriptedModelServer([{ text: GOOD_REPLY }]);
  await model.start();
  const service = serviceWith(model);
  try {
    const job = service.startSkillExtraction({
      repo: referenceRepo(),
      intent: "重试上限怎么配",
      pathHint: "src/retry",
      operator: "alice",
    });
    assert.equal(job.status, "running");
    const done = await until(() => {
      const current = service.skillExtractionJob(job.id);
      return current?.status !== "running" ? current : undefined;
    }, "提取收口");
    assert.equal(done.status, "done");
    assert.match(done.draft ?? "", /retry-policy-reference/);
    assert.match(done.notes ?? "", /默认值不确定/);
    assert.equal(done.operator, "alice");
    // 只读不是嘱咐是配置:pushurl 已被毒化,真 push 只会诚实失败。
    const root = join(
      (service as any).options.dataDir, "knowledge-extract", job.id);
    const pushUrl = execFileSync("git",
      ["-C", join(root, "source"), "remote", "get-url", "--push", "origin"],
      { encoding: "utf-8" }).trim();
    assert.match(pushUrl, /mae-flow-readonly/);
    // 留档 0600 且可回读(重启后回答"后来怎么样了"靠它)。
    const jobFile = join(root, "job.json");
    assert.equal(statSync(jobFile).mode & 0o777, 0o600);
  } finally {
    await model.stop();
  }
});

test("克隆失败如实分类,不吞成模型问题", async () => {
  const model = new ScriptedModelServer([{ text: GOOD_REPLY }]);
  await model.start();
  const service = serviceWith(model);
  try {
    const job = service.startSkillExtraction({
      repo: join(tmpdir(), "mfc-ke-definitely-missing"),
      intent: "随便提点什么",
      operator: "alice",
    });
    const done = await until(() => {
      const current = service.skillExtractionJob(job.id);
      return current?.status !== "running" ? current : undefined;
    }, "克隆失败收口");
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /参考仓克隆失败/);
  } finally {
    await model.stop();
  }
});

test("草稿含敏感值整份作废;报错不带明文", async () => {
  const leaky = GOOD_REPLY.replace("上限读配置项 retry.max",
    "调用时带上 api_key = \"sk1234abcd5678\"");
  const model = new ScriptedModelServer([
    { text: leaky }, { text: leaky }, { text: leaky }]);
  await model.start();
  const service = serviceWith(model);
  try {
    const job = service.startSkillExtraction({
      repo: referenceRepo(), intent: "重试上限怎么配", operator: "alice",
    });
    const done = await until(() => {
      const current = service.skillExtractionJob(job.id);
      return current?.status !== "running" ? current : undefined;
    }, "敏感值作废收口");
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /草稿含敏感值/);
    assert.ok(!done.error?.includes("sk1234abcd5678"));
    assert.equal(done.draft, undefined);
  } finally {
    await model.stop();
  }
});

test("模型一直不按格式:补交两次后如实判失败", async () => {
  const chatter = { text: "我觉得这个仓写得很好,就是没有草稿。" };
  const model = new ScriptedModelServer([chatter, chatter, chatter]);
  await model.start();
  const service = serviceWith(model);
  try {
    const job = service.startSkillExtraction({
      repo: referenceRepo(), intent: "重试上限怎么配", operator: "alice",
    });
    const done = await until(() => {
      const current = service.skillExtractionJob(job.id);
      return current?.status !== "running" ? current : undefined;
    }, "格式失败收口");
    assert.equal(done.status, "failed");
    assert.match(done.error ?? "", /未按格式/);
  } finally {
    await model.stop();
  }
});

test("重启把跑一半的 job 带走:查询如实报中断,不装完成", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ke-restart-"));
  const root = join(dataDir, "knowledge-extract", "ke-restart-1");
  persistExtractionJob(root, {
    id: "ke-restart-1",
    status: "running",
    repo: "/some/repo",
    intent: "x",
    operator: "alice",
    started_at: new Date().toISOString(),
  });
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: { providers: {} },
  });
  const job = service.skillExtractionJob("ke-restart-1");
  assert.equal(job?.status, "failed");
  assert.match(job?.error ?? "", /重启中断/);
  // 路径穿越防御:恶意 id 直接查不到,不去磁盘上拼路径。
  assert.equal(service.skillExtractionJob("../evil"), undefined);
});

test("入参闸:空意图/带空白的仓地址/越界路径提示都当场拒", async () => {
  const model = new ScriptedModelServer([{ text: GOOD_REPLY }]);
  await model.start();
  const service = serviceWith(model);
  try {
    assert.throws(() => service.startSkillExtraction({
      repo: "a b", intent: "x", operator: "u" }), TaskControlError);
    assert.throws(() => service.startSkillExtraction({
      repo: "/ok/repo", intent: "  ", operator: "u" }), TaskControlError);
    assert.throws(() => service.startSkillExtraction({
      repo: "/ok/repo", intent: "x", pathHint: "/etc", operator: "u" }),
      TaskControlError);
    assert.throws(() => service.startSkillExtraction({
      repo: "/ok/repo", intent: "x", pathHint: "a/../../b", operator: "u" }),
      TaskControlError);
  } finally {
    await model.stop();
  }
});
