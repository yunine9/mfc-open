/**
 * 流水线监看启动跟随推送事实(issue-72 死锁的修复验收):
 * ①修复环只 push_branch 不 create_mr——推送即按新 SHA 重挂监看,
 *   绿了发申报提醒,不再无人盯表卡死;
 * ②重启续表补挂"监看账落后于推送账"的死表现场(issue-72 形态),
 *   同 SHA 已按终态处理的不重放;
 * ③收口点已过(归档前返工)的跟进提交跑绿:账定格即毕,不误报
 *   "其他仓红灯"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { mfcTemp } from "./mfcTmp.ts";

import {
  GIT_ENV,
  bareOrigin,
  until,
  fastPoll,
  LoopPlatform,
  seedMrGreenWatch,
} from "./issueFlowFixed.helpers.ts";

/** issue-72 现场的最小复现骨架:五阶段现行形状,mr_green 进行中。 */
function seedLaggingState(input: {
  dataDir: string;
  origin: string;
  pushedSha: string;
  watchSha: string;
  watch?: Record<string, unknown>;
  mrGate?: boolean;
}): void {
  seedMrGreenWatch(input.dataDir, input.origin, {
    sha: input.watchSha,
    ...input.watch,
  });
  const path = join(input.dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
  // 种子夹具还是七阶段历史形状:换成现行五阶段(mr_green=索引 4,
  // in_progress),绿灯收口才走"提醒申报"分支而不是已被收口的分支。
  state.stage_states = ["done", "done", "done", "done", "in_progress"];
  state.pushes[0].sha = input.pushedSha;
  state.pipelines[input.origin].sha = input.watchSha;
  if (input.mrGate) state.mr_gate = { mrs: [input.origin], at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(state));
}

function gitCred() {
  return { username: "dev", password: "git-token", email: "dev@example.com" };
}

test("修复环只推不建 MR:push_branch 即按新 SHA 重挂监看,绿灯收口发申报提醒", async () => {
  const dataDir = mfcTemp("mfc-issue-push-ignition-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  await platform.start();
  // 工作区克隆:期望分支(账号 dev+单号)+两个提交——首提交对应已判红
  // 的旧监看,修复提交是 push_branch 要推的新 SHA。
  const clone = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b",
    "master_dev_DTS-2026-1002"], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", "red commit"], { env: GIT_ENV });
  const oldSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"])
    .toString().trim();
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", "fix"], { env: GIT_ENV });
  const newSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"])
    .toString().trim();
  seedLaggingState({ dataDir, origin, pushedSha: oldSha, watchSha: oldSha });
  // 修复回合剧本:只 push_branch(不 create_mr——同一 MR 自动跟新提交)
  // 再收嘴;申报提醒回合答一句话收嘴。
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { text: "已同分支推送修复,MR 会自动跟新提交。" },
    { text: "收到,稍后申报。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    // 旧 SHA 判红 → 派发修复回合(第一请求)→ 剧本推送新 SHA。
    await until(() => model.requests.length ? model.requests : undefined,
      "红灯修复回合派出");
    // 核心断言:推送事实本身触发重挂——监看账换到新 SHA 且在盯,
    // 不依赖 create_mr 再启动(修复前这里永久停在旧 SHA 死表)。
    const rearm = await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return watch?.sha === newSha && watch.watching ? watch : undefined;
    }, "推送即重挂新 SHA 监看");
    assert.equal(rearm.reds, 1, "红灯账跨 SHA 结转");
    // 新 SHA 流水线跑绿:监看器按终态处理并派申报提醒(而非无人收口)。
    await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return watch?.status === "success" && !watch.watching ? issue : undefined;
    }, "新 SHA 绿灯收口");
    const requestText = await until(() => {
      const text = JSON.stringify(model.requests);
      return /已跑绿/.test(text) ? text : undefined;
    }, "申报提醒回合派出");
    assert.match(requestText, /已跑绿/, "绿灯收口后提醒申报");
    assert.match(requestText, /complete_stage/, "提醒带申报动作");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "提醒回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 0, "绿灯清红灯账");
    assert.equal(settled.stage, "mr_green", "等申报推进,不抢跑");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("重启补挂:监看账落后于推送账的死表现场(issue-72 形态)自愈派发修复", async () => {
  const dataDir = mfcTemp("mfc-issue-restart-heal-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = { log: "BUILD FAILURE: 修复提交编译失败" };
  await platform.start();
  const oldSha = "9".repeat(40);
  const newSha = "4".repeat(40);
  seedLaggingState({
    dataDir, origin, pushedSha: newSha, watchSha: oldSha,
    // 旧 SHA 的红灯已派发修复过一轮(last_repair_sha=旧提交),死表停在
    // failed/watching=false;申报受理账在——issue-72 卡死时的现场。
    watch: { status: "failed", watching: false, reds: 1,
      last_repair_sha: oldSha },
    mrGate: true,
  });
  const model = new ScriptedModelServer([
    { text: "收到,按新报错修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    // 恢复即补挂新 SHA → 新流水线判红 → 修复回合照常派出。
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "补挂后新 SHA 红灯派发修复");
    assert.match(requestText, /第 2\/20 轮红灯/, "红灯账跨 SHA 结转后照常发送");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines?.[origin];
    assert.equal(watch?.sha, newSha, "监看账已对齐推送账");
    assert.equal(watch?.last_repair_sha, newSha, "派发修复记账到新提交");
    assert.equal(watch?.reds, 2, "新提交红灯 reds+1");
    // mr_gate 不上 wire(流程机制状态),受理账清没清从盘上读。
    const onDisk = JSON.parse(readFileSync(
      join(dataDir, "issues", "issue-1", "issue.json"), "utf-8")) as {
        mr_gate?: unknown;
      };
    assert.equal(onDisk.mr_gate, undefined, "红灯=申报打回,受理账清掉");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("重启补挂·监看缺席:回退轮清表(fixedRollback)后的现场同样自愈", async () => {
  const dataDir = mfcTemp("mfc-issue-restart-absent-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = { log: "BUILD FAILURE: 回退轮重推编译失败" };
  await platform.start();
  const sha = "7".repeat(40);
  // fixedRollback 整表删 state.pipelines、延用 MR 记录:现场只剩
  // 推送账与 MR,监看缺席。重启后按推送账 SHA 补挂,红灯照常派发修复。
  seedLaggingState({ dataDir, origin, pushedSha: sha, watchSha: sha });
  const path = join(dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
  delete state.pipelines;
  writeFileSync(path, JSON.stringify(state));
  const model = new ScriptedModelServer([
    { text: "收到,按报错修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "监看缺席现场补挂后红灯派发修复");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines?.[origin];
    assert.equal(watch?.sha, sha, "按推送账补挂起表");
    assert.equal(watch?.reds, 1, "缺席起表从干净红灯账起算");
    assert.equal(watch?.last_repair_sha, sha, "派发修复记账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("重启不重放:同 SHA 已按终态处理的死表不补挂、不轮询(不扰动刹车账)", async () => {
  const dataDir = mfcTemp("mfc-issue-restart-idle-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed", "failed");
  await platform.start();
  const sha = "c".repeat(40);
  seedLaggingState({
    dataDir, origin, pushedSha: sha, watchSha: sha,
    // 同提交刹车停机后的现场:watching=false 且 SHA 与推送账一致。
    watch: { status: "failed", watching: false, reds: 3,
      last_repair_sha: sha, last_error: "同一提交停机" },
  });
  const model = new ScriptedModelServer([
    { text: "不该被叫醒。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(model.requests.length, 0, "已按终态处理的死表不派回合");
    assert.equal(platform.seen.filter((entry) =>
      entry.url.startsWith("/pipeline/status")).length, 0,
    "已按终态处理的死表不轮询流水线");
    const issue = service.get("issue-1");
    assert.equal(issue.pipelines?.[origin]?.watching, false, "监看账原样");
    assert.equal(issue.pipelines?.[origin]?.reds, 3, "刹车账不被重放扰动");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("收口点已过的跟进提交跑绿:账定格即毕,不误报其他仓红灯", async () => {
  const dataDir = mfcTemp("mfc-issue-late-green-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  const sha = "a".repeat(40);
  seedMrGreenWatch(dataDir, origin, { sha });
  const path = join(dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
  // 收口点已过:五阶段全 done(归档前返工现场),跟进提交的监看
  // 跑绿后不该再发申报提醒,更不该掉进"其他仓红灯"的误报分支。
  state.stage_states = ["done", "done", "done", "done", "done"];
  state.pushes[0].sha = sha;
  state.pipelines[origin].sha = sha;
  writeFileSync(path, JSON.stringify(state));
  const model = new ScriptedModelServer([
    { text: "不该被叫醒。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    const settled = await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return watch?.status === "success" && !watch.watching ? issue : undefined;
    }, "跟进提交绿灯收口");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(model.requests.length, 0,
      "收口点已过:绿灯收口不开回合(不误报其他仓红灯)");
    assert.equal(settled.stage, "mr_green", "阶段不被回拨");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
