/**
 * 红灯切换(#247,ADR-0024):流水线红灯后平台不再分诊(可不可修/
 * 证据够不够)、不再代举 pipeline_unfixable / pipeline_evidence——
 * 失败事实(摘要/逐维度明细/产物镜像落点)三态发送给 AI,三路处置
 * 由它现场判断:直接修复 / 举报错回灌卡 / 举不可修人工卡(后两路经
 * raise_gate,平台复核红灯在案)。平台保留机械三样:同提交刹车、
 * 修复轮预算(发送回合=修复回合,派了才 +1)、留痕。证据重试窗随
 * 分诊编排退场;human_evidence 回灌不再重复计数(发送已记)。
 *
 * 五幕:
 * 1. 事实发送:无闸、材料齐全(摘要/明细/镜像/指引)、reds=1;
 * 2. 证据缺口:AI 举回灌卡带 repo 定位,人贴原文注入回灌回合且
 *    reds 不重复计数;
 * 3. 不可修:AI 举人工卡,resume 作答重置监看(刹车/预算账清)重看
 *    同一提交;
 * 4. 预算耗尽:超限红灯停机不派回合,通知请人工;
 * 5. 同提交刹车:上轮发送的提交再红,停机带 AI 诊断,不再发送。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { MR_GREEN_ENV_VERIFY_NOTE } from "../src/issueFlow/state.ts";
import {
  LoopPlatform,
  bareOrigin,
  fastPoll,
  seedMrGreenWatch,
} from "./issueFlowFixed.helpers.ts";
import { mfcTemp } from "./mfcTmp.ts";

const SHA = "c".repeat(40);

function readStateFile(dataDir: string, id = "issue-1"): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function options(input: {
  dataDir: string;
  model: ScriptedModelServer;
  platformUrl: string;
  luban: FakeLubanServer;
  repairRounds?: number;
}): IssueFlowOptions {
  return {
    dataDir: input.dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: input.model.modelsJson(),
    settings: {
      models: () => ({}),
      runtime: () => ({
        poll_interval_s: 1, poll_timeout_s: 120,
        ...(input.repairRounds !== undefined
          ? { repair_rounds: input.repairRounds } : {}),
      }),
    },
    dts: new MockDtsGateway(),
    platformUrl: input.platformUrl,
    gitCredential: () => ({ username: "dev", password: "git-token",
      email: "dev@example.com" }),
    notifier: new Notifier({ endpoint: input.luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  };
}

test("红灯事实发送:不落闸,材料齐全进模型,发送即记一轮预算", async () => {
  const dataDir = mfcTemp("mfc-redcutover-deliver-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "BUILD FAILURE: 模块 notify-service 编译失败",
    checks: [{
      dimension: "COMPILE", status: "failed",
      details: [{ tool: "javac", file: "src/Notify.java", line: 42 }],
    }],
  };
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer(
    [{ text: "收到失败事实,开始修复。" }], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "红灯事实发送回合启动");
    // 材料齐全:摘要/逐维度明细/镜像产物/三路处置指引都在发送词里。
    assert.match(requestText, /流水线未通过/);
    assert.match(requestText, /BUILD FAILURE: 模块 notify-service/);
    assert.match(requestText, /逐维度明细/);
    assert.match(requestText, /pipeline\/ 目录/, "镜像产物落点");
    assert.match(requestText, /raise_gate/, "三路处置指引带工具指路");
    assert.match(requestText, /pipeline_evidence/);
    assert.match(requestText, /pipeline_unfixable/);
    // 平台不落闸:分诊交 AI,卡由它判断后自己举。
    const settled = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "发送回合收口");
    assert.equal(settled.gate, undefined, "平台不代举任何卡");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "发送回合=修复回合,派了记一轮");
    assert.equal(settled.pipelines?.[origin]?.last_repair_sha, SHA,
      "刹车账已记本轮提交");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("证据缺口:AI 举回灌卡带 repo 定位;人贴原文注入回灌回合且不重复计数", async () => {
  const dataDir = mfcTemp("mfc-redcutover-evidence-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  const platform = new LoopPlatform("failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_evidence", repo: origin,
      supplement: "镜像产物只有 build.log,UT 维度没有报错原文" } } },
    { text: "已举卡等待用户贴原文。" },
    { text: "按回灌的原文定位修复中。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "pipeline_evidence" ? issue : undefined;
    }, "AI 举出报错回灌卡");
    assert.deepEqual(gated.gate!.pipeline, { repo: origin, sha: SHA },
      "卡带仓与提交定位");
    assert.match(gated.gate!.context ?? "", /UT 维度没有报错原文/,
      "AI 的缺口说明随卡");

    // 人贴原文作答 → 回灌回合注入原文,reds 不重复计数。
    service.answer("issue-1", {
      state_version: gated.gate!.state_version,
      decision: "UT 失败原文: OrderMapperTest#testTimeout 断言超时,"
        + "堆栈指向 OrderMapper.xml:88(ORA-01722 无效数字)",
    });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "回灌回合收口");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /ORA-01722/, "人工原文进了回灌回合");
    assert.equal(readStateFile(dataDir).pipelines?.[origin]?.reds, 1,
      "发送已记一轮,回灌是同轮延续不重复计数");
    assert.match(
      readStateFile(dataDir).pipelines?.[origin]?.last_failure_summary ?? "",
      /人工回灌的报错原文/, "刹车账改记人工回灌摘要");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("不可修:AI 举人工处理卡;resume 作答重置监看账重看同一提交", async () => {
  const dataDir = mfcTemp("mfc-redcutover-unfixable-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  const platform = new LoopPlatform("failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_unfixable", repo: origin,
      supplement: "红灯全部来自 SuperChecker 平台侧告警" } } },
    { text: "已举卡等待人工处理。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "pipeline_unfixable" ? issue : undefined;
    }, "AI 举出不可修人工卡");
    assert.deepEqual(gated.gate!.pipeline, { repo: origin, sha: SHA });
    const before = gated.pipelines?.[origin]?.deadline ?? "";

    service.answer("issue-1", {
      state_version: gated.gate!.state_version,
      code: "resume",
      notes: "已在平台豁免规则 R1",
    });
    const rearmed = await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return issue.gate === undefined && issue.status === "idle"
        && watch?.watching && watch.status === "running"
        && watch.deadline > before ? issue : undefined;
    }, "作答后重置监看账重新挂表");
    assert.equal(rearmed.pipelines?.[origin]?.sha, SHA, "同一 SHA 重新监看");
    assert.equal(rearmed.pipelines?.[origin]?.reds, 0,
      "预算账归零(重看是新一轮)");
    assert.equal(rearmed.pipelines?.[origin]?.last_repair_sha, undefined,
      "刹车账清掉(重看仍红不误判同提交刹车)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});


test("预算耗尽:超限红灯停机不派回合,通知请人工", async () => {
  const dataDir = mfcTemp("mfc-redcutover-exhausted-");
  const origin = bareOrigin(dataDir);
  // 已记一轮(reds=1)+ 预算 1:下一次红灯记账 2>1,诚实停机。
  seedMrGreenWatch(dataDir, origin, { reds: 1 });
  const platform = new LoopPlatform("failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(options({
    dataDir, model, platformUrl: platform.baseUrl, luban, repairRounds: 1 }));
  try {
    const stopped = await until(() => {
      const state = readStateFile(dataDir);
      return /修复轮预算/.test(state.stage_note ?? "") ? state : undefined;
    }, "预算耗尽停机");
    assert.match(stopped.stage_note ?? "", /已耗尽/, "诚实停机留痕");
    assert.equal(stopped.pipelines?.[origin]?.reds, 2, "账记到 2");
    assert.equal(model.requests.length, 0, "不再派发送回合");
    await until(() => luban.messages.length ? luban.messages : undefined,
      "停机通知发出");
    assert.match(JSON.stringify(luban.messages), /修复轮预算/,
      "通知请人工接手");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("同提交刹车:上轮发送的提交再红——停机带诊断,不再发送", async () => {
  const dataDir = mfcTemp("mfc-redcutover-brake-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin, { last_repair_sha: SHA });
  const platform = new LoopPlatform("failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    const braked = await until(() => {
      const state = readStateFile(dataDir);
      return /同一提交/.test(state.stage_note ?? "") ? state : undefined;
    }, "同提交刹车停机");
    assert.match(braked.stage_note ?? "", /没有产出新提交/, "刹车留痕");
    assert.equal(braked.pipelines?.[origin]?.reds, undefined,
      "刹车不耗预算(reds 不动)");
    assert.equal(model.requests.length, 0, "同一份事实不再重复发送");
    await until(() => luban.messages.length ? luban.messages : undefined,
      "刹车停机通知发出");
    assert.match(JSON.stringify(luban.messages), /同一提交/,
      "通知把 AI 的诊断交给人");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

// ---- 撤卡(#374 流水线红灯未感知):卡是平台断言,断言被新事实推翻
// 就撤下——红灯事实不再停靠旧卡,失败送达不再被等人状态吞掉。 ----

/** 在 seedMrGreenWatch 的绿表上种一张在场卡:等人的验证卡(或带提交
 *  定位的人工卡),stage_note 保留收口常量(守闸器判据的回归锚)。 */
function seedGateOnWatch(
  dataDir: string,
  repo: string,
  gate: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): void {
  const path = join(dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as
    & { gate?: unknown; status?: string; stage_note?: string }
    & Record<string, unknown>;
  state.gate = gate;
  state.status = "waiting_user";
  state.stage_note = MR_GREEN_ENV_VERIFY_NOTE;
  Object.assign(state, extra);
  writeFileSync(path, JSON.stringify(state));
}

test("374 回归:验证卡在场遇红灯——撤卡回落,红灯事实照常送达不停靠", async () => {
  const dataDir = mfcTemp("mfc-redcutover-stalegate-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  // 374 现场:全绿收口后 AI 举的验证卡没答,监看账在恢复直挂续表
  // (不经 armPipelineWatch)——红灯必须撤卡送达,不再 park 进便签。
  seedGateOnWatch(dataDir, origin, {
    id: "gate-stale", kind: "env_verify", state_version: 0,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "验证?", options: [] }] },
  });
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "BUILD FAILURE: 模块 notify-service 编译失败",
  };
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer(
    [{ text: "收到失败事实,开始修复。" }], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    // 全部断言取终态可观测的不变量(2026-09-22 CI 修正):脚本模型
    // 响应极快,「回合在飞」是抓不住的瞬态——装作能抓住只会赛跑。
    // 撤卡+送达的组合本身已构成回归锚:修复前红灯永远 park、
    // status 定格 waiting_user、模型收不到任何请求。
    // 完成信号=idle 且模型请求已发生(2026-09-22 二次修正):撤卡置
    // idle 与红灯回合真正开跑之间隔着产物镜像的网络往返,窗口里
    // status 已是 idle 而请求还是空——只看 idle 会在窗口里假绿。
    const settled = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && model.requests.length ? issue : undefined;
    }, "红灯事实送达并收口");
    assert.match(JSON.stringify(model.requests), /流水线未通过/,
      "红灯事实开回合送达 AI,不是落便签等人");
    assert.equal(settled.gate, undefined, "旧验证卡已撤下");
    const state = readStateFile(dataDir);
    assert.equal(state.status, "idle", "等人回落空闲(撤卡解锁回合)");
    assert.deepEqual(state.parked_notices, undefined,
      "失败事实不进欠账队列");
    assert.match(JSON.stringify(state.transitions),
      /环境验证卡过期撤下/, "撤卡落转移账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("374 撤卡范围:同仓新提交使旧人工卡作废(推送路,恢复补挂触发)", async () => {
  const dataDir = mfcTemp("mfc-redcutover-stalegate-push-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  // 监看账落后于推送账(旧提交 d… 的不可修卡在场,推送账已是新提交
  // c…):重启补挂走 armPipelineWatch,换 SHA 分支撤卡。
  const OLD_SHA = "d".repeat(40);
  seedGateOnWatch(dataDir, origin, {
    id: "gate-old", kind: "pipeline_unfixable", state_version: 0,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "人工处理?", options: [] }] },
    pipeline: { repo: origin, sha: OLD_SHA },
  }, {
    pipelines: {
      [origin]: {
        sha: OLD_SHA, status: "failed", watching: false,
        started_at: new Date().toISOString(),
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  });
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer(
    [{ text: "空闲,无回合。" }], "scripted-v1", { linear: true });
  await model.start();
  const platform = new LoopPlatform("failed");
  await platform.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    const rearmed = await until(() => {
      const state = readStateFile(dataDir);
      return state.pipelines?.[origin]?.sha === SHA && state.gate === undefined
        ? state : undefined;
    }, "补挂换新提交并撤卡");
    assert.equal(rearmed.status, "idle", "等人回落空闲");
    assert.match(JSON.stringify(rearmed.transitions),
      /流水线不可修告警卡过期撤下/, "撤卡落转移账(推送动因)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("374 撤卡范围:跨仓红灯不推翻人工卡——卡照常等人,红灯停靠随卡送达", async () => {
  const dataDir = mfcTemp("mfc-redcutover-stalegate-keep-");
  const origin = bareOrigin(dataDir);
  seedMrGreenWatch(dataDir, origin);
  // 卡定位的是另一个仓的提交:本仓红灯不推翻它,卡保持在场,
  // 红灯事实落便签随卡答完的续跑送达(不撤、不代答)。
  seedGateOnWatch(dataDir, origin, {
    id: "gate-other", kind: "pipeline_unfixable", state_version: 0,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "人工处理?", options: [] }] },
    pipeline: { repo: "http://other.test/repo.git", sha: "e".repeat(40) },
  });
  const platform = new LoopPlatform("failed");
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(
    options({ dataDir, model, platformUrl: platform.baseUrl, luban }));
  try {
    await until(() => {
      const state = readStateFile(dataDir);
      return state.parked_notices?.some((item) => /流水线未通过/.test(item))
        ? state : undefined;
    }, "红灯事实停靠进欠账便签");
    const state = readStateFile(dataDir);
    assert.equal(state.gate?.kind, "pipeline_unfixable", "卡原样在场");
    assert.equal(state.status, "waiting_user", "等人状态不变");
    assert.equal(state.stage_note, MR_GREEN_ENV_VERIFY_NOTE,
      "卡在场不动 stage_note");
    assert.equal(model.requests.length, 0, "不趁卡在开回合");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});
