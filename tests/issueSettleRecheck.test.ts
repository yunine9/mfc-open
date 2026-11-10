/**
 * 最终结果动手前复核 MR 状态(工单 #321,父单 #317,承接 #320 的
 * 检查目标跟随):
 *  1. 赛跑拦截(复核路定格):旧提交的取消红到达时分支头已变——复核
 *     发现后不派发修复回合、不举卡、红灯计数不涨,只记转移账。
 *  2. 赛跑结局(自然时序):头已变的取消红无论复核路还是跟随切换路
 *     先看到,结局一致——检查目标切换接管,不派发修复、计数不涨。
 *  3. 已合入:红灯不作失败处理,合入状态循环下一拍自动归档(ADR-0034
 *     归档路接管,issue-107 类现场)。
 *  4. 已合入(复核路定格):绿灯照常收口——合入事实不拦收口,申报账
 *     随收口清掉,验证卡交由 AI 举出。
 *  5. 绿灯但头已变:不收口当前阶段、不引出验证卡,「头已变」事实作为
 *     一轮消息交给 AI。
 *  6. 验绿门同口径:头已变时旧头的绿灯不满足申报放行(按分支最新
 *     提交验绿、受理停等);新头绿灯才收口放行。
 *  7. 回归:头未变时红灯照常派出修复回合,与既有行为全等。
 *
 * 范式与 issuePipelineFollowHead 同款:种子现场直接写 issue.json(服务
 * 构造即走恢复路径续挂监看),FakeGitPlatform 假交付平台 +
 * ScriptedModelServer 剧本模型,只走公开 API 断言。用例 1/4/5 把阶段
 * 停在「问题修改」是刻意安排:合入状态循环只在「提交MR·跑绿」阶段跑,
 * 且与终态复核共享同一个 /mr/gates 查询——自然时序下谁先看到头变化
 * 是掷硬币;把循环请出场,旧提交的终态结果只剩「动手前复核」一条路,
 * 赛跑窗口得以定格成单一时序来断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FIXED_TICKET_STAGES } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1003";
const BRANCH = `master_dev_${TICKET}`;
/** mr_green 在有单五阶段里的下标。 */
const MR_GREEN = FIXED_TICKET_STAGES.indexOf("mr_green");
/** fix(问题修改)的下标——定格复核路用的非 mr_green 阶段。 */
const FIX = FIXED_TICKET_STAGES.indexOf("fix");

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 裸远端 + 平台上登记在途的 MR。缺省分支头=会话提交 A;extraCommit
 *  在场时分支再追加一个提交 B(平台回报的 MR 头=分支最新提交 B,
 *  会话推送账/检查账停在 A——赛跑现场);merged 在场时平台直接裁定
 *  MR 已合入。 */
async function seedBranchHead(input: {
  dataDir: string;
  platform: FakeGitPlatform;
  extraCommit?: string;
  merged?: boolean;
}): Promise<{
  origin: string;
  /** 会话推送账上的提交(分支第一个提交)。 */
  shaA: string;
  /** 分支最新提交(extraCommit 在场时≠shaA)。 */
  shaB?: string;
  mr: { url: string; iid: string };
}> {
  const sourceDir = join(input.dataDir, "source");
  execFileSync("git", ["init", "-q", "-b", "master", sourceDir]);
  const git = (args: string[]) => execFileSync(
    "git", ["-C", sourceDir, ...args], { encoding: "utf-8" });
  const commit = (message: string) =>
    git(["-c", "user.name=t", "-c", "user.email=t@e",
      "commit", "-q", "--allow-empty", "-m", message]);
  commit("seed");
  git(["checkout", "-q", "-b", BRANCH]);
  commit(`[${TICKET}][fix] 会话内修复`);
  const shaA = git(["rev-parse", "HEAD"]).trim();
  let shaB: string | undefined;
  if (input.extraCommit) {
    commit(input.extraCommit);
    shaB = git(["rev-parse", "HEAD"]).trim();
  }
  const origin = input.platform.initBare(sourceDir, input.dataDir);
  const response = await fetch(`${input.platform.baseUrl}/mr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: origin, source_branch: BRANCH, target_branch: "master",
      title: `[${TICKET}] 最终结果复核`,
    }),
  });
  assert.equal(response.status, 201, "假平台登记 MR");
  const mr = await response.json() as { url: string; id: number };
  if (input.merged) input.platform.settleMr(BRANCH, "merged");
  return { origin, shaA, shaB, mr: { url: mr.url, iid: String(mr.id) } };
}

interface RecheckSeed {
  origin: string;
  sha: string;
  mr: { url: string; iid: string };
  /** 检查账/推送账所在的阶段;缺省 mr_green,给 "fix" 把合入状态循环
   *  请出场(定格复核路,见文件头说明)。 */
  stage?: "fix" | "mr_green";
  /** AI 已申报 MR 清单(验绿门受理账):验绿即收口用。 */
  mrGate?: boolean;
}

/** 直接落盘一张「检查账盯 seed.sha、在途」的现场(服务构造即恢复续挂)。 */
function seedRecheckIssue(dataDir: string, seed: RecheckSeed): void {
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const stage = seed.stage ?? "mr_green";
  const stageIndex = FIXED_TICKET_STAGES.indexOf(stage);
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "最终结果复核", description: "", source: "dts", ticket: TICKET,
    repo_url: seed.origin, repo_urls: [seed.origin],
    scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map((name, index) =>
      index < stageIndex ? "done"
        : index === stageIndex ? "in_progress" : "pending"),
    status: "idle", stage, stage_note: "", stage_at: now,
    pushes: [{ repo: seed.origin, branch: BRANCH, sha: seed.sha, at: now }],
    mrs: [{
      repo: seed.origin, branch: BRANCH, target: "master",
      title: `[${TICKET}] 最终结果复核`,
      url: seed.mr.url, iid: seed.mr.iid, at: now,
    }],
    ...(seed.mrGate ? { mr_gate: { mrs: [seed.origin], at: now } } : {}),
    pipelines: {
      [seed.origin]: {
        sha: seed.sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
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

/** 从盘上读原始现场(mr_gate 等内部受理账不上服务投影,断言它们要读盘)。 */
function readState(dataDir: string) {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", "issue-1", "issue.json"), "utf-8")) as {
      mr_gate?: { mrs: string[]; at: string };
      transitions?: Array<{ note: string }>;
      [key: string]: unknown;
    };
}

test("赛跑拦截(复核路):取消红到达时头已变——复核发现,不派发修复、不举卡、计数不涨", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-race-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform,
    extraCommit: `[${TICKET}][fix] 分支上的后续提交` });
  // 旧提交 A 触发即出取消红(平台取消了它的流水线)。
  platform.statusQueue.push("failed");
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir,
    { ...registered, sha: registered.shaA, stage: "fix" });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const notes = await until(() => {
      const text = (service.get("issue-1").transitions ?? [])
        .map((item) => item.note).join("\n");
      return text.includes("不作失败处理") ? text : undefined;
    }, "复核记账:结果丢弃、不作失败处理");
    assert.match(notes, /丢弃/, "转移账写明结果丢弃");
    assert.ok(notes.includes(registered.shaB!.slice(0, 12)),
      "转移账带分支最新提交编号");
    const after = service.get("issue-1");
    const watch = after.pipelines![registered.origin];
    assert.equal(model.requests.length, 0, "不派发修复回合");
    assert.equal(after.gate, undefined, "不举卡");
    assert.equal(watch.reds ?? 0, 0, "红灯计数不涨");
    assert.equal(watch.last_repair_sha, undefined, "不进修复账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("赛跑结局(自然时序):头已变的取消红不派发修复,检查目标切换接管", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-takeover-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform,
    extraCommit: `[${TICKET}][fix] 分支上的后续提交` });
  // 新旧提交的流水线都先跑着(触发不出终态),取消红事后才落进平台。
  platform.nextPipelineStatus = "running";
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir, { ...registered, sha: registered.shaA });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    // 等旧提交的流水线先挂上跑着,再裁定它被取消(触发请求在途时裁定
    // 会赶不上号,先等 run 在案)。
    await until(() => platform.pipelines.some((run) =>
      run.sha === registered.shaA && run.status === "running")
      ? true : undefined, "旧提交的流水线已触发(在跑)");
    platform.finishPipeline(registered.shaA, "failed");
    const switched = await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch && watch.sha === registered.shaB && watch.watching
        ? watch : undefined;
    }, "检查目标切换到分支最新提交");
    assert.equal(switched.reds ?? 0, 0, "取消红没有进计数");
    assert.equal(switched.last_repair_sha, undefined, "没有进修复账");
    assert.equal(model.requests.length, 0, "没有派出修复回合");
    assert.equal(service.get("issue-1").gate, undefined, "不举卡");
    assert.ok(platform.pipelines.some((run) =>
      run.sha === registered.shaA && run.status === "failed"),
      "前提:旧提交的取消红在平台上在案");
    // 浸泡:新头流水线一直跑着,取消红始终没人处理,不冒出修复回合。
    await sleep(2_500);
    const after = service.get("issue-1");
    assert.equal(after.pipelines![registered.origin].reds ?? 0, 0,
      "浸泡后红灯计数仍不涨");
    assert.equal(model.requests.length, 0, "浸泡后仍无修复回合");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("已合入:取消红不作失败处理,合入状态循环下一拍自动归档", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-merged-red-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform, merged: true });
  platform.statusQueue.push("failed");
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir, { ...registered, sha: registered.shaA });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const final = await until(() =>
      service.get("issue-1").status === "archived"
        ? service.get("issue-1") : undefined, "合入状态循环自动归档");
    assert.equal(final.conclusion?.kind, "delivered", "结论=已交付");
    assert.equal(final.stage_states?.[MR_GREEN], "done",
      "未收口的阶段随归档一并收口");
    assert.equal(model.requests.length, 0, "取消红没有派出修复回合");
    assert.equal(final.pipelines?.[registered.origin]?.reds ?? 0, 0,
      "红灯计数不涨");
    assert.equal(final.gate, undefined, "不举卡");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("已合入(复核路):绿灯照常收口——合入事实不拦收口,验证卡指引随收口发出", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-merged-green-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform, merged: true });
  platform.statusQueue.push("success");
  const model = new ScriptedModelServer([{ text: "收到,等用户验证。" }],
    "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir,
    { ...registered, sha: registered.shaA, stage: "fix", mrGate: true });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
      "收口后的全绿事实发送回合启动");
    assert.match(requestText, /全部 MR 流水线已跑绿/,
      "收口照常:全绿事实发送给 AI");
    const after = await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "idle" ? snapshot : undefined;
    }, "收口回合收口");
    // 收口发生了:申报账清掉、阶段标 done(定格现场里收的是 fix)、
    // 检查账定格绿。
    assert.equal(readState(dataDir).mr_gate, undefined, "申报账随收口清掉");
    assert.equal(after.stage_states?.[FIX], "done", "当前阶段照常收口");
    assert.equal(after.pipelines?.[registered.origin]?.status, "success",
      "检查账定格绿");
    assert.equal(after.gate, undefined, "平台不代举验证卡(交 AI 举)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("绿灯但头已变:不收口当前阶段、不引出验证卡,「头已变」事实交给 AI", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-green-moved-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform,
    extraCommit: `[${TICKET}][fix] 分支上的后续提交` });
  platform.statusQueue.push("success");
  const model = new ScriptedModelServer(
    [{ text: "收到,等新提交的流水线结果。" }], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir,
    { ...registered, sha: registered.shaA, stage: "fix", mrGate: true });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
      "「头已变」事实消息送达 AI");
    assert.match(requestText, /分支的最新提交已变为/, "事实说清头已变");
    assert.ok(requestText.includes(registered.shaB!.slice(0, 12)),
      "消息带分支最新提交编号");
    assert.match(requestText, /不作阶段收口/, "消息说明本次不收口");
    const after = await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "idle" ? snapshot : undefined;
    }, "事实消息回合收口");
    // 不收口:阶段保持未完成、申报账保留、检查账不定格绿;不引出
    // 验证卡(没有闸、也没有收口指引之外的卡)。
    assert.equal(after.stage_states?.[FIX], "in_progress", "阶段未收口");
    assert.equal(after.stage_states?.[MR_GREEN], "pending", "mr_green 未动");
    assert.ok(readState(dataDir).mr_gate, "申报账保留(收口没有发生)");
    assert.equal(after.pipelines?.[registered.origin]?.status, "running",
      "绿灯没有记进检查账");
    assert.equal(after.gate, undefined, "不引出验证卡");
    const notes = (after.transitions ?? []).map((item) => item.note).join("\n");
    assert.match(notes, /绿灯不作收口/, "转移账记录绿灯不作收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("验绿门同口径:头已变时旧头绿灯不放行,新头绿灯才收口", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-gate-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform,
    extraCommit: `[${TICKET}][fix] 分支上的后续提交` });
  // 旧头 A 的绿灯先在平台上在案(历史终态),分支头已是 B——申报时
  // 验绿门必须按 B 验,不能拿 A 的绿灯放行。
  platform.statusQueue.push("success");
  const preTrigger = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sha: registered.shaA, repo: registered.origin }),
  });
  assert.equal(preTrigger.status, 201, "旧头的绿灯 run 已在平台在案");
  platform.nextPipelineStatus = "running";
  const model = new ScriptedModelServer([
    { tool: { name: "complete_stage",
      input: { note: "MR 已建好", mrs: [registered.origin] } } },
    { text: "已申报,等流水线结果。" },
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举验证卡,等用户验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir, { ...registered, sha: registered.shaA });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    // 跟随切换先把检查目标对到分支最新提交 B(其流水线跑着不出终态)。
    await until(() => {
      const watch = service.get("issue-1").pipelines?.[registered.origin];
      return watch && watch.sha === registered.shaB && watch.watching
        ? watch : undefined;
    }, "检查目标已切到分支最新提交");
    assert.ok(platform.pipelines.some((run) =>
      run.sha === registered.shaA && run.status === "success"),
      "前提:旧头的绿灯在平台上在案");
    // AI 申报:验绿门按分支最新提交 B 验——B 还在跑,受理停等,
    // 不放行(A 的绿灯作不了数)。
    service.reply("issue-1", "MR 建好了,请申报收口。");
    await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "idle" ? snapshot : undefined;
    }, "申报回合收口");
    const declared = service.get("issue-1");
    assert.ok(readState(dataDir).mr_gate, "申报受理(没有放行)");
    assert.equal(declared.stage_states?.[MR_GREEN], "in_progress",
      "旧头绿灯不放行:阶段未收口");
    const notes = (declared.transitions ?? [])
      .map((item) => item.note).join("\n");
    assert.match(notes, /分支头已变/, "转移账记录按分支最新提交验绿");
    assert.match(JSON.stringify(model.requests), /分支的最新提交已变为/,
      "回执向 AI 说清头已变");
    // 新头绿灯才收口:B 跑绿 → 监看收口 → 验证卡可举(出口后半截)。
    platform.finishPipeline(registered.shaB!, "success");
    const closed = await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.stage_states?.[MR_GREEN] === "done"
        && snapshot.gate?.kind === "env_verify" ? snapshot : undefined;
    }, "新头绿灯收口并举出环境验证卡");
    assert.equal(readState(dataDir).mr_gate, undefined, "申报账随收口清掉");
    assert.equal(closed.pipelines?.[registered.origin]?.status, "success",
      "检查账定格绿(分支最新提交)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("回归:头未变时红灯照常派出修复回合(与既有行为全等)", async () => {
  const dataDir = mfcTemp("mfc-issue-recheck-regression-");
  const platform = new FakeGitPlatform();
  await platform.start();
  const registered = await seedBranchHead({ dataDir, platform });
  platform.statusQueue.push("failed");
  const model = new ScriptedModelServer(
    [{ text: "收到失败事实,开始修复。" }], "scripted-v1", { linear: true });
  await model.start();
  seedRecheckIssue(dataDir, { ...registered, sha: registered.shaA });
  const service = makeService({ dataDir, model, platformUrl: platform.baseUrl });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
      "红灯失败材料已派出");
    assert.match(requestText, /流水线未通过/, "失败事实照常发送");
    const settled = await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "idle" ? snapshot : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines![registered.origin];
    assert.equal(watch.reds, 1, "发送回合=修复回合,派了记一轮");
    assert.equal(watch.last_repair_sha, registered.shaA, "刹车账已记本轮提交");
    assert.equal(settled.gate, undefined, "平台不代举卡");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
