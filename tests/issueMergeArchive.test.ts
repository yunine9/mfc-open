/**
 * 合入即归档收尾(工单 #318,ADR-0034):
 *  1. 存量卡死单自愈——全部 MR 合入在账、但「提交 MR·跑绿」阶段没收口
 *     还挂着未答的「流水线不可修」卡(issue-107 类现场):合入状态
 *     循环跑一轮后自动归档,结论「已交付」,未答的卡随终态作废。
 *  2. 已全部合入时答「已在平台处理,重新监看」:直接归档,不再对旧
 *     提交重新启动流水线监看(旧提交的流水线已被合入取消,重看必再红)。
 *  3. 回合在飞不抢:AI 回合进行中合入事实入账,归档等回合收口后下一轮
 *     再做(既有守卫的回归)。
 *  4. 未全部合入的单不受影响:合入循环不归档;答「重新监看」照原路
 *     重置监看账重看同一提交。
 *
 * 范式与 issueMergeFact 同款:种子现场直接写 issue.json(服务构造即走
 * 恢复路径续挂监看),FakeGitPlatform 假交付平台 + ScriptedModelServer
 * 剧本模型,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { GATE_OPTIONS } from "../src/issueFlow/stageRegistry.ts";
import { FIXED_TICKET_STAGES } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const BRANCH = `master_dev_${TICKET}`;
/** mr_green 在有单五阶段里的下标(前四个已完成、它没收口)。 */
const MR_GREEN = FIXED_TICKET_STAGES.indexOf("mr_green");

const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 未答的「流水线不可修」卡(票 03 形状,决策码表照注册表取)。 */
function unfixableGate(repo: string, sha: string) {
  return {
    id: "gate-unfix-1",
    kind: "pipeline_unfixable" as const,
    state_version: 1,
    question: {
      questions: [{
        question: "流水线失败项都是不可自动修复的工具告警,"
          + "是否已在交付平台处理/豁免?",
        options: GATE_OPTIONS.pipeline_unfixable.options,
      }],
    },
    pipeline: { repo, sha },
    created_at: new Date().toISOString(),
  };
}

interface StuckSeed {
  origin: string;
  sha: string;
  mr: { url: string; iid: string };
  /** 合入事实已入账(存量现场:循环早已记下,归档被旧前置挡住)。 */
  merged?: boolean;
  /** 挂未答的「流水线不可修」卡(waiting_user 现场)。 */
  gate?: boolean;
}

/** 直接落盘一张「mr_green 未收口 + 不可修卡/或空闲」的存量现场。 */
function seedStuckIssue(dataDir: string, seed: StuckSeed): void {
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "存量卡死单", description: "issue-107 类现场",
    source: "dts", ticket: TICKET,
    repo_url: seed.origin, repo_urls: [seed.origin],
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map((stage, index) =>
      index === MR_GREEN ? "in_progress"
      : index < MR_GREEN ? "done" : "pending"),
    status: seed.gate ? "waiting_user" : "idle",
    stage: "mr_green",
    stage_note: "流水线不可修,等人在平台处理",
    stage_at: now,
    pushes: [{ repo: seed.origin, branch: BRANCH, sha: seed.sha, at: now }],
    mrs: [{
      repo: seed.origin, branch: BRANCH, target: "master",
      title: `[${TICKET}] 存量卡死单`, url: seed.mr.url, iid: seed.mr.iid,
      at: now,
      ...(seed.merged ? { merged_at: now } : {}),
    }],
    pipelines: {
      [seed.origin]: {
        sha: seed.sha, status: "failed", watching: false,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1, reds: 2,
        last_error: "lint 告警:不可自动修复的工具告警",
      },
    },
    ...(seed.gate ? { gate: unfixableGate(seed.origin, seed.sha) } : {}),
  }));
}

/** 裸远端 + 平台上登记在途的 MR(分支已推到位,平台侧可裁定合入)。 */
async function registerMr(dataDir: string, platform: FakeGitPlatform): Promise<{
  origin: string; sha: string; mr: { url: string; iid: string };
}> {
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", "-b", "master", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  execFileSync("git", ["-C", sourceDir, "checkout", "-q", "-b", BRANCH]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "fix"]);
  const origin = platform.initBare(sourceDir, dataDir);
  const response = await fetch(`${platform.baseUrl}/mr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: origin, source_branch: BRANCH, target_branch: "master",
      title: `[${TICKET}] 存量卡死单`,
    }),
  });
  assert.equal(response.status, 201, "假平台登记 MR");
  const mr = await response.json() as { url: string; id: number; sha: string };
  return { origin, sha: mr.sha, mr: { url: mr.url, iid: String(mr.id) } };
}

function makeService(input: {
  dataDir: string;
  model: ScriptedModelServer;
  platformUrl?: string;
}): IssueFlowService {
  return new IssueFlowService({
    dataDir: input.dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: input.model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    ...(input.platformUrl ? { platformUrl: input.platformUrl } : {}),
    gitCredential: () =>
      ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
}

test("存量卡死单自愈:全合入+阶段未收口+未答卡,合入循环一轮内归档", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-archive-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerMr(dataDir, platform);
  platform.settleMr(BRANCH, "merged");
  const model = new ScriptedModelServer([{ text: "收到。" }], "scripted-v1",
    { linear: true });
  await model.start();
  // 全部 MR 的 merged_at 已在账(issue-107 现场:循环早记下了,
  // 归档一直被「阶段收口/验证绿」的内部前置挡住)。
  seedStuckIssue(dataDir, { ...registered, merged: true, gate: true });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    await until(() => service.get("issue-1").status === "archived",
      "合入循环下一轮自动归档存量卡死单");
    const final = service.get("issue-1");
    assert.equal(final.conclusion?.kind, "delivered", "结论=已交付");
    assert.equal(final.gate, undefined, "未答的不可修卡随终态作废");
    assert.equal(final.stage_states?.[MR_GREEN], "done", "mr_green 随归档收口");
    assert.throws(() => service.answer("issue-1",
      { state_version: 1, code: "resume" }),
    /没有等待中的问题卡/, "作废后的卡不再可答");
    assert.equal(model.requests.length, 0, "归档不派 AI 回合");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("已全部合入时答「重新监看」:直接归档,不对旧提交重启监看(带补充说明也短路)", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-archive-");
  const model = new ScriptedModelServer([{ text: "收到。" }], "scripted-v1",
    { linear: true });
  await model.start();
  // 不给交付平台地址:合入事实循环不挂,「全部合入」完全由账面承担
  // ——考的就是作答那一刻的短路判定,不让循环抢跑归档。
  seedStuckIssue(dataDir, {
    origin: "/tmp/origin.git", sha: "c".repeat(40),
    mr: { url: "http://platform.test/mr/1", iid: "1" },
    merged: true, gate: true,
  });
  const service = makeService({ dataDir, model });
  try {
    const before = service.get("issue-1").pipelines!["/tmp/origin.git"];
    const gateVersion = service.get("issue-1").gate!.state_version;
    const summary = service.answer("issue-1",
      { state_version: gateVersion, code: "resume",
        notes: "已经在平台合入了,不用再重看" });
    assert.equal(summary.status, "archived", "作答回执即归档(直接收口)");
    assert.equal(summary.conclusion?.kind, "delivered");
    const after = service.get("issue-1");
    const watch = after.pipelines!["/tmp/origin.git"];
    assert.equal(watch.watching, false, "不对旧提交重新挂监看");
    assert.equal(watch.started_at, before.started_at, "监看账未动");
    assert.ok(!after.stage_note.includes("重新监看"),
      "不再走重看路径的文案");
    assert.equal(model.requests.length, 0,
      "归档不派 AI 回合(合入短路优先于带话,ADR-0049)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("回合在飞不抢:合入事实入账但归档等回合收口后下一轮再做", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-archive-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerMr(dataDir, platform);
  let releaseTurn = () => {};
  const hold = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const model = new ScriptedModelServer([{ text: "收到,继续跟进。" }],
    "scripted-v1", {
      linear: true,
      // 模型回合发起到应答落回之间是「回合在飞」窗口:窗口里平台侧
      // 完成合入,合入事实循环下一拍就能入账——但归档必须让路。
      beforeScene: () => {
        platform.settleMr(BRANCH, "merged");
        return hold;
      },
    });
  await model.start();
  seedStuckIssue(dataDir, { ...registered });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    service.reply("issue-1", "平台那边我已经处理了,请继续跟进");
    await until(() => model.requests.length > 0, "模型回合已在飞");
    await until(() =>
      Boolean(service.get("issue-1").mrs?.[0]?.merged_at),
    "回合在飞期间合入事实已入账");
    // 再等超过一个轮询周期:事实在账、回合未收口,归档不许抢。
    await sleep(1_500);
    const mid = service.get("issue-1");
    assert.notEqual(mid.status, "archived", "回合在飞期间不归档");
    assert.equal(mid.conclusion, undefined, "未抢跑结论");
    releaseTurn();
    await until(() => service.get("issue-1").status === "archived",
      "回合收口后下一轮归档");
    assert.equal(service.get("issue-1").conclusion?.kind, "delivered");
  } finally {
    releaseTurn();
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("未全部合入的单不受影响:循环不归档,答「重新监看」照原路重看", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-archive-");
  const platform = new FakeGitPlatform();
  // 流水线停在跑着:重看路径只挂监看不出终态,回归断言不被绿灯收口链扰动。
  platform.nextPipelineStatus = "running";
  await platform.start();
  const registered = await registerMr(dataDir, platform);
  const model = new ScriptedModelServer([{ text: "收到。" }], "scripted-v1",
    { linear: true });
  await model.start();
  seedStuckIssue(dataDir, { ...registered, gate: true });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    // MR 在途:合入事实循环跑了多轮也不归档。
    await sleep(2_500);
    const idle = service.get("issue-1");
    assert.equal(idle.status, "waiting_user", "未全合入不归档,卡照常等答");
    assert.equal(idle.conclusion, undefined);
    const gateVersion = idle.gate!.state_version;
    const summary = service.answer("issue-1",
      { state_version: gateVersion, code: "resume" });
    assert.equal(summary.status, "idle", "照原路:重置监看账等结果");
    assert.equal(summary.pipelines?.[registered.origin]?.watching, true,
      "重新挂上同一提交的流水线监看");
    assert.ok(summary.stage_note.includes("重新监看"), "重看文案在");
    await sleep(2_500);
    const after = service.get("issue-1");
    assert.equal(after.status, "idle", "监看跑着,单据不受影响");
    assert.notEqual(after.status, "archived");
    assert.equal(after.conclusion, undefined, "没有抢跑结论");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
