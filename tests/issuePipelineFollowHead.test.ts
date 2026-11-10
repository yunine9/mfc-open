/**
 * 流水线检查跟随分支最新提交(工单 #320,ADR-0041):
 *  1. issue-107 全链:监看自己提交 → 平台外推新提交(sourceSha 变)→
 *     检查目标切到新提交(external_head 置位、旧账清零)→ 新提交跑绿 →
 *     阶段正常收口 → 合入后自动归档(依赖 #318 的归档语义)。
 *  2. 平台外推送、未合入:切到新提交 → 新提交红灯 → 失败材料含
 *     「不是本会话推的/平台外」线索与新提交编号。
 *  3. 切换清账:失败计数与上轮报错清零、查询时限重置;同 sourceSha
 *     重复感知不重复切换(幂等)。
 *  4. 自己推送回归:自己推新提交照旧切到新提交但 external_head 清除;
 *     重启补挂对带平台外标记的检查账让路(落后的推送账不是正确目标)。
 *
 * 范式与 issueMergeArchive 同款:种子现场直接写 issue.json(服务构造即
 * 走恢复路径续挂监看),FakeGitPlatform 假交付平台 + ScriptedModelServer
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
import {
  FIXED_TICKET_STAGES,
  type IssuePipelineWatch,
} from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1002";
const BRANCH = `master_dev_${TICKET}`;
/** mr_green 在有单五阶段里的下标(前四个已完成、它进行中)。 */
const MR_GREEN = FIXED_TICKET_STAGES.indexOf("mr_green");

const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) assert.fail(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 裸远端 + 平台上登记在途的 MR(分支已推到位,平台侧可感知分支头)。 */
async function registerBranchMr(dataDir: string, platform: FakeGitPlatform): Promise<{
  origin: string; sha: string; branch: string;
  mr: { url: string; iid: string };
}> {
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", "-b", "master", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  execFileSync("git", ["-C", sourceDir, "checkout", "-q", "-b", BRANCH]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 会话内修复`]);
  const origin = platform.initBare(sourceDir, dataDir);
  const response = await fetch(`${platform.baseUrl}/mr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: origin, source_branch: BRANCH, target_branch: "master",
      title: `[${TICKET}] 跟随分支头`,
    }),
  });
  assert.equal(response.status, 201, "假平台登记 MR");
  const mr = await response.json() as { url: string; id: number; sha: string };
  return { origin, sha: mr.sha, branch: BRANCH,
    mr: { url: mr.url, iid: String(mr.id) } };
}

interface FollowSeed {
  origin: string;
  sha: string;
  mr: { url: string; iid: string };
  /** AI 已申报 MR 清单(验绿门受理账):跑绿即收口用。 */
  mrGate?: boolean;
  /** 流水线检查账覆写(缺省:盯自己提交 A、在途)。 */
  watch?: Partial<IssuePipelineWatch>;
  /** 会话工作区已就位的克隆(测试 4 自己推送用):路径=repo/origin。 */
  workspaceClone?: string;
}

/** 直接落盘一张「提交MR·跑绿进行中」的现场(自己提交 A 已在检查账上)。 */
function seedFollowIssue(dataDir: string, seed: FollowSeed): void {
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "流水线跟随分支头", description: "", source: "dts", ticket: TICKET,
    repo_url: seed.origin, repo_urls: [seed.origin],
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map((stage, index) =>
      index === MR_GREEN ? "in_progress"
      : index < MR_GREEN ? "done" : "pending"),
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: seed.origin, branch: BRANCH, sha: seed.sha, at: now }],
    mrs: [{
      repo: seed.origin, branch: BRANCH, target: "master",
      title: `[${TICKET}] 流水线跟随分支头`,
      url: seed.mr.url, iid: seed.mr.iid, at: now,
    }],
    ...(seed.mrGate ? { mr_gate: { mrs: [seed.origin], at: now } } : {}),
    pipelines: {
      [seed.origin]: {
        sha: seed.sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
        ...seed.watch,
      },
    },
  }));
}

/** 平台外推送:从裸仓克隆、在分支上追加一个提交推回去,返回新头。
 *  再幂等 POST /mr 让平台侧 MR 头对齐分支最新——真平台 MR 自动跟分支
 *  走,假件经幂等重建对齐(FakeGitPlatform.createMergeRequest 的既定
 *  行为,见其注释)。 */
async function externalPush(input: {
  platform: FakeGitPlatform; origin: string; dataDir: string;
  message: string;
}): Promise<string> {
  const clone = join(input.dataDir, "external");
  execFileSync("git", ["clone", "-q", input.origin, clone]);
  execFileSync("git", ["-C", clone, "checkout", "-q", BRANCH]);
  execFileSync("git", ["-C", clone, "-c", "user.name=ext", "-c",
    "user.email=ext@e", "commit", "-q", "--allow-empty", "-m", input.message]);
  const sha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  execFileSync("git", ["-C", clone, "push", "-q", input.origin, BRANCH]);
  const response = await fetch(`${input.platform.baseUrl}/mr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: input.origin, source_branch: BRANCH, target_branch: "master",
      title: `[${TICKET}] 跟随分支头`,
    }),
  });
  assert.equal(response.status, 201, "假平台 MR 幂等对齐分支最新提交");
  return sha;
}

function makeService(input: {
  dataDir: string;
  model: ScriptedModelServer;
  platformUrl: string;
}): IssueFlowService {
  return new IssueFlowService({
    dataDir: input.dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: input.model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: input.platformUrl,
    gitCredential: () =>
      ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
}

test("issue-107 全链:平台外推新提交→检查目标切换→新提交跑绿→阶段收口→合入自动归档", async () => {
  const dataDir = mfcTemp("mfc-issue-follow-full-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerBranchMr(dataDir, platform);
  // 自己提交的流水线先跑着不出终态:现场定格在「监看自己提交 A」。
  platform.nextPipelineStatus = "running";
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举环境验证卡,等待用户在环境验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedFollowIssue(dataDir, { ...registered, mrGate: true });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const shaB = await externalPush({ platform, dataDir,
      origin: registered.origin,
      message: `[${TICKET}][fix] 平台外修复` });
    // 合入状态循环感知分支头变化:检查目标切到平台外提交。
    const switched = await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch?.sha === shaB && watch.external_head === true
        && watch.watching === true ? watch : undefined;
    }, "检查目标切到平台外提交");
    assert.equal(switched.reds, 0, "切换清掉失败计数");
    assert.ok(!switched.last_repair_sha && !switched.last_failure_summary,
      "切换清掉上轮报错账");
    const notes = (service.get("issue-1").transitions ?? [])
      .map((item) => item.note).join("\n");
    assert.ok(notes.includes("平台外") && notes.includes(shaB.slice(0, 12)),
      "转移账记录检查目标跟随切换");
    // 新提交的流水线跑绿:阶段正常收口,验证卡交给用户。
    await until(() => platform.pipelines.some((run) =>
      run.sha === shaB && run.status === "running") ? true : undefined,
      "平台外提交的流水线已触发");
    platform.finishPipeline(shaB, "success");
    await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "waiting_user"
        && snapshot.gate?.kind === "env_verify" ? snapshot : undefined;
    }, "跑绿后阶段收口并举出环境验证卡");
    assert.equal(service.get("issue-1").pipelines?.[registered.origin]?.status,
      "success", "检查账定格绿");
    // 合入:合入状态循环记账,#318 的自动归档收口。
    platform.settleMr(BRANCH, "merged");
    const final = await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "archived" ? snapshot : undefined;
    }, "合入后自动归档");
    assert.equal(final.conclusion?.kind, "delivered");
    assert.equal(final.mrs?.[0]?.merged_sha, shaB, "合入头照平台返回记");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("平台外推送未合入:新提交红灯,失败材料带平台外线索与新提交编号", async () => {
  const dataDir = mfcTemp("mfc-issue-follow-red-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerBranchMr(dataDir, platform);
  const model = new ScriptedModelServer([
    { text: "收到,先拉最新代码看差异再修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  // 现场带脏账:旧提交已红 3 次、带刹车账与上轮报错——切换应整体清零
  //(清账细节在幂等用例里定格断言,这里的红灯终态会写入新账)。
  seedFollowIssue(dataDir, { ...registered,
    watch: {
      status: "failed", watching: false, round: 2, reds: 3,
      last_repair_sha: registered.sha,
      last_failure_summary: "编译失败:旧提交的报错",
      last_error: "旧提交遗留的停机报错",
      checks: [{ dimension: "COMPILE", status: "failed", job: "compile" }],
      deadline: new Date(Date.now() + 1_000).toISOString(),
    } });
  // 新提交触发即红(状态查询出一枪终态红)。
  platform.statusQueue.push("failed");
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const shaB = await externalPush({ platform, dataDir,
      origin: registered.origin,
      message: `[${TICKET}][fix] 平台外改动` });
    await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch?.sha === shaB && watch.external_head === true
        ? watch : undefined;
    }, "检查目标切到平台外提交");
    // 红灯材料:平台外线索 + 新提交编号。
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
      "红灯失败材料已派出");
    assert.match(requestText, /不是本会话推的/,
      "材料写明分支头不是会话推的");
    assert.match(requestText, /平台外/, "材料带平台外线索");
    assert.ok(requestText.includes(shaB.slice(0, 12)),
      "材料带新提交编号");
    // 旧账红灯 3 次,新提交红灯从 1 起计=失败计数随切换清零。
    await until(() =>
      service.get("issue-1").pipelines?.[registered.origin]?.reds === 1
        ? true : undefined, "新提交红灯从 1 起计(旧账 3 次已清零)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("切换清账+同一 sourceSha 重复感知不重复切换(幂等)", async () => {
  const dataDir = mfcTemp("mfc-issue-follow-idem-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerBranchMr(dataDir, platform);
  // 新提交的流水线一直跑着:不出终态,考的就是感知轮询本身(切换后的
  // 清账定格可见,不被终态处理覆写)。
  platform.nextPipelineStatus = "running";
  const model = new ScriptedModelServer([{ text: "收到。" }],
    "scripted-v1", { linear: true });
  await model.start();
  seedFollowIssue(dataDir, { ...registered,
    watch: {
      status: "failed", watching: false, round: 2, reds: 3,
      last_repair_sha: registered.sha,
      last_failure_summary: "编译失败:旧提交的报错",
      last_error: "旧提交遗留的停机报错",
      checks: [{ dimension: "COMPILE", status: "failed", job: "compile" }],
      deadline: new Date(Date.now() + 1_000).toISOString(),
    } });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const shaB = await externalPush({ platform, dataDir,
      origin: registered.origin,
      message: `[${TICKET}][fix] 平台外修复` });
    const switched = await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch?.sha === shaB && watch.external_head === true
        ? watch : undefined;
    }, "检查目标切到平台外提交");
    // 切换清账:失败计数、刹车账、上轮报错、遗留停机报错与旧检查项
    // 全作废,查询时限重置,轮次 +1。
    assert.equal(switched.reds, 0, "失败计数清零");
    assert.equal(switched.last_repair_sha, undefined, "刹车账清零");
    assert.equal(switched.last_failure_summary, undefined, "上轮报错清零");
    assert.equal(switched.last_error, undefined, "遗留报错清零");
    assert.equal(switched.checks, undefined, "旧检查项清零");
    assert.ok(Date.parse(switched.deadline) > Date.now() + 60_000,
      "查询时限重置(fastPoll 预算 120s)");
    assert.equal(switched.round, 3, "轮次 +1");
    // 浸泡三个轮询周期:合入状态循环反复带回同一 sourceSha,账面不动。
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const after = service.get("issue-1").pipelines![registered.origin];
    assert.equal(after.started_at, switched.started_at, "不重复切换(时限起点不动)");
    assert.equal(after.round, switched.round, "轮次不重复 +1");
    const notes = (service.get("issue-1").transitions ?? [])
      .filter((item) => item.note.includes("取代"));
    assert.equal(notes.length, 1, "转移账只记一笔跟随切换");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("自己推新提交:照旧切到新提交但 external_head 清除;补挂不跟平台外账打架", async () => {
  const dataDir = mfcTemp("mfc-issue-follow-own-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await registerBranchMr(dataDir, platform);
  // 平台外推 B:现场定格成「检查账盯平台外提交 B、推送账还停在自己
  // 的旧提交 A」——正是重启补挂路径眼里的"监看账落后于推送账"。
  const shaB = await externalPush({ platform, dataDir,
    origin: registered.origin,
    message: `[${TICKET}][fix] 平台外修复` });
  // 会话工作区:基于平台外提交 B 之后再补一个自己的提交 C(先拉最新
  // 代码再修,正是外部头指引的工作方法)。
  const workspace = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", registered.origin, workspace]);
  execFileSync("git", ["-C", workspace, "checkout", "-q", BRANCH]);
  execFileSync("git", ["-C", workspace, "-c", "user.name=dev", "-c",
    "user.email=dev@e", "commit", "-q", "--allow-empty",
    "-m", `[${TICKET}][fix] 会话内跟进修复`]);
  const shaC = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  // 检查账不带 watching(定格过的现场),external_head 在账上。
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { text: "跟进修复已推送,等平台重新监看。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedFollowIssue(dataDir, { ...registered,
    watch: { sha: shaB, status: "failed", watching: false,
      external_head: true, reds: 2 } });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    // 恢复期浸泡:重启补挂不把平台外检查账拉回落后的推送账。
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    const held = service.get("issue-1").pipelines![registered.origin];
    assert.equal(held.sha, shaB, "补挂让路:检查目标仍在平台外提交");
    assert.equal(held.external_head, true, "补挂让路:平台外标记仍在");
    // 自己推 C:按推送账重挂,external_head 自然清除。
    platform.nextPipelineStatus = "running";
    service.reply("issue-1", "平台外那笔我看了,跟进修了一版,请推送。");
    const reArmed = await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch?.sha === shaC && watch.watching ? watch : undefined;
    }, "自己推送后照旧重挂到新提交");
    assert.equal(reArmed.external_head, undefined,
      "自己的推送天然不是平台外的,标记清除");
    await until(() => service.get("issue-1").status === "idle"
      ? true : undefined, "推送回合收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
