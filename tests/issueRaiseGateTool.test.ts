/**
 * 举卡工具三卡种(#245,ADR-0024 expand 批):AI 在回合内经 raise_gate
 * 举 env_verify / pipeline_unfixable / pipeline_evidence,平台只做前置
 * 事实校验(可拒绝,判据只查平台可复核的事实,不查 AI 口供);卡面问题
 * 与选项出自注册表/常量模板,AI 只补事实性说明。单卡互斥:平台闸在场
 * 时 AskUserQuestion 拒答(beforeHumanQuestion),任一卡在场时 raise_gate
 * 拒举——两张卡并存自此在协议上不可能(issue-53 撞车类的土壤)。
 *
 * 两层打法:
 * - 校验器单测:直调 createIssueTools 产物(与 issuePushConfirm 的
 *   issue-14 直调同款),穷举前置事实的正反例与文案(文案带下一步指引);
 * - 端到端:剧本回合里 AI 举卡 → 落卡即返回 → 收口 settle 凭闸定格
 *   waiting_user;同回合再调 AskUserQuestion 被互斥拦下(工具错误,
 *   不建卡不通知)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import {
  createIssueTools,
  type IssueToolContext,
} from "../src/issueFlow/tools.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { mfcTemp } from "./mfcTmp.ts";

const ALPHA = "https://git.example.com/org/alpha.git";
const BETA = "https://git.example.com/org/beta.git";
const TICKET = "DTS2026091300245";
const SHA = "c".repeat(40);

/** 盘上种子一个「mr_green 已收口、全部流水线绿、无闸无卡」的空闲会话
 *  (env_verify 前置的全真态);流水线 watching=false,监看器不抢戏。 */
function seedGreenClosed(dataDir: string, id = "issue-1"): void {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "举卡工具夹具", description: "", source: "dts", ticket: TICKET,
    repo_url: ALPHA, repo_urls: [ALPHA],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: ALPHA, branch: `master_dev_${TICKET}`, sha: SHA, at: now }],
    mrs: [{ repo: ALPHA, branch: `master_dev_${TICKET}`,
      title: `[${TICKET}] 举卡工具夹具`, at: now }],
    pipelines: {
      [ALPHA]: {
        sha: SHA, status: "success", watching: false, started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(), round: 1,
      },
    },
  }));
}

/** 盘上种子一个「红灯在案」的会话(pipeline 卡前置的全真态)。 */
function seedRedLight(dataDir: string, id = "issue-1"): void {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "红灯举卡夹具", description: "", source: "dts", ticket: TICKET,
    repo_url: ALPHA, repo_urls: [ALPHA],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "pending", "pending"],
    status: "idle", stage: "fix", stage_note: "", stage_at: now,
    pushes: [{ repo: ALPHA, branch: `master_dev_${TICKET}`, sha: SHA, at: now }],
    pipelines: {
      [ALPHA]: {
        sha: SHA, status: "failed", watching: false, started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(), round: 1,
      },
    },
  }));
}

function baseOptions(dataDir: string, model: ScriptedModelServer):
  IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

function readEvents(dataDir: string, id: string):
  Array<{ kind: string; payload: Record<string, any> }> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .map((event) => ({ kind: String(event.kind),
      payload: (event.payload ?? {}) as Record<string, any> }));
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

// ---- 校验器单测:直调工具,穷举前置事实正反例 ----

interface DirectCtx {
  state: IssueSessionState;
  pendingAgentCard?: () => boolean;
}

/** 直调现场:免模型免落盘(persist 空转),工具打回只看抛错文案。 */
function directRaiseTool(input: DirectCtx): {
  execute: (id: string, params: any) => Promise<unknown>;
} {
  const dataDir = mfcTemp("mfc-raisegate-ws-");
  const ctx: IssueToolContext = {
    state: input.state,
    workspace: dataDir,
    dataRoot: dataDir,
    persist: () => undefined,
    ...(input.pendingAgentCard ? { pendingAgentCard: input.pendingAgentCard } : {}),
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: SHA,
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const tool = tools.find((item) => item.name === "raise_gate");
  assert.ok(tool, "应注册 raise_gate 工具");
  return { execute: tool!.execute };
}

function raiseState(overrides: Partial<IssueSessionState> = {},
  pipelines?: IssueSessionState["pipelines"]): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-raise", account: "dev", created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: ALPHA, repo_urls: [ALPHA],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done"],
    status: "running", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: ALPHA, branch: `master_dev_${TICKET}`, sha: SHA, at: now }],
    mrs: [{ repo: ALPHA, branch: `master_dev_${TICKET}`,
      title: `[${TICKET}] t`, at: now }],
    ...(pipelines ? { pipelines } : {}),
    ...overrides,
  };
}

test("env_verify 前置:mr_green 未收口一律拒绝(文案指路申报),收口即放行依据", async () => {
  // 未收口:流水线还在跑、申报没过验绿门——拒绝文案指路 complete_stage。
  // (前置只查收口不查监看账 status:那份账异步刷新,当场收口窗口期
  // 它还停在 running,查它会把刚收口的合法举卡误拒。)
  const running = raiseState({
    stage_states: ["done", "done", "done", "done", "in_progress"],
    mr_gate: { mrs: [ALPHA], at: new Date().toISOString() },
  }, {
    [ALPHA]: { sha: SHA, status: "running", watching: true,
      started_at: "", deadline: "", round: 1 },
  });
  await assert.rejects(
    directRaiseTool({ state: running }).execute("a",
      { kind: "env_verify" }),
    /收口|申报/, "未收口要拒且文案指路申报");
  assert.equal(running.gate, undefined, "拒绝不落闸");

  // 绿了但 mr_green 没收口(申报是出口的一半)——拒绝文案指路 complete_stage。
  const unclosed = raiseState({
    stage_states: ["done", "done", "done", "done", "in_progress"],
    mr_gate: { mrs: [ALPHA], at: new Date().toISOString() },
  }, {
    [ALPHA]: { sha: SHA, status: "success", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  await assert.rejects(
    directRaiseTool({ state: unclosed }).execute("a", { kind: "env_verify" }),
    /收口|申报/, "未收口要拒且文案指路申报");
  assert.equal(unclosed.gate, undefined, "拒绝不落闸");
});

test("env_verify 放行:全绿+收口——卡面出自模板,补充说明随卡,落卡即返回", async () => {
  const state = raiseState({}, {
    [ALPHA]: { sha: SHA, status: "success", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  const result = await directRaiseTool({ state }).execute("a",
    { kind: "env_verify", supplement: "换库部署输出核对无误",
      // 决策码与选项是作答协议,AI 不可注入:多余的键即使带上来,
      // 卡面选项仍出自注册表模板。
      options: ["自定义选项"] }) as
    { content: Array<{ text: string }> };
  assert.match(result.content[0].text, /验证卡/, "回执说明已举卡");
  assert.equal(state.gate?.kind, "env_verify", "闸已落");
  assert.match(state.gate!.question.questions[0].question, /目标环境验证/,
    "卡面问题出自模板");
  assert.doesNotMatch(
    JSON.stringify(state.gate!.question), /自定义选项/,
    "AI 注入的选项不落到卡面");
  assert.match(state.gate!.context ?? "", /换库部署输出核对无误/,
    "AI 的事实性补充随卡");
});

test("pipeline 卡:红灯事实在案才放行(带仓与提交定位),无事实凭印象拒绝", async () => {
  const red = raiseState({
    stage: "fix",
    stage_states: ["done", "done", "pending", "pending", "pending"],
  }, {
    [ALPHA]: { sha: SHA, status: "failed", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  const tool = directRaiseTool({ state: red });
  const ok = await tool.execute("a",
    { kind: "pipeline_evidence", repo: ALPHA,
      supplement: "镜像产物只有 build.log,缺 UT 报错" }) as
    { content: Array<{ text: string }> };
  assert.match(ok.content[0].text, /举出|已举/, "回执说明已举卡");
  assert.equal(red.gate?.kind, "pipeline_evidence");
  assert.deepEqual(red.gate!.pipeline, { repo: ALPHA, sha: SHA },
    "卡带仓与提交定位(resume_watch 重看同一提交靠它)");
  delete red.gate;

  // unfixable 同款放行:卡面模板 + 仓与提交定位都在。
  // (独立状态:上面的闸刚被 delete,TS 属性收窄会把再赋值读成 never。)
  const red2 = raiseState({
    stage: "fix",
    stage_states: ["done", "done", "pending", "pending", "pending"],
  }, {
    [ALPHA]: { sha: SHA, status: "failed", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  const unfixable = await directRaiseTool({ state: red2 }).execute("a",
    { kind: "pipeline_unfixable", repo: ALPHA,
      supplement: "红灯全部来自 SuperChecker 平台侧告警" }) as
    { content: Array<{ text: string }> };
  assert.match(unfixable.content[0].text, /人工处理卡/);
  assert.equal(red2.gate?.kind, "pipeline_unfixable");
  assert.deepEqual(red2.gate!.pipeline, { repo: ALPHA, sha: SHA });

  // 没有 pipeline 账的仓:凭印象拒绝,文案带下一步(先确认真红灯)。
  await assert.rejects(
    tool.execute("a", { kind: "pipeline_unfixable",
      repo: "https://git.example.com/org/ghost.git" }),
    /红灯/, "无红灯事实要拒");
  assert.equal(red.gate, undefined, "拒绝不落闸");

  // 缺 repo:pipeline 卡必须带定位。
  await assert.rejects(
    tool.execute("a", { kind: "pipeline_unfixable" }),
    /repo/, "缺 repo 要拒");
});

test("单卡互斥:平台闸或 Agent 卡在场,raise_gate 一律拒绝不叠加", async () => {
  const gated = raiseState({}, {
    [ALPHA]: { sha: SHA, status: "success", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  gated.gate = {
    id: "gate-x", kind: "analysis_confirm", state_version: 1,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "确认分析报告?", options: [] }] },
  } as IssueSessionState["gate"];
  await assert.rejects(
    directRaiseTool({ state: gated }).execute("a", { kind: "env_verify" }),
    /平台闸.*作答|作答.*平台闸/s, "闸在场不许再举");
  assert.equal(gated.gate!.kind, "analysis_confirm", "原闸不被顶掉");

  const carded = raiseState({}, {
    [ALPHA]: { sha: SHA, status: "success", watching: false,
      started_at: "", deadline: "", round: 1 },
  });
  await assert.rejects(
    directRaiseTool({ state: carded, pendingAgentCard: () => true })
      .execute("a", { kind: "env_verify" }),
    /问题卡.*作答|作答.*问题卡/s, "Agent 卡在场不许再举");
  assert.equal(carded.gate, undefined, "拒绝不落闸");
});

test("kind 白名单:注册表外的卡种直接打回", async () => {
  const state = raiseState();
  await assert.rejects(
    directRaiseTool({ state }).execute("a", { kind: "conclude" }),
    /env_verify|只允许|卡种/, "白名单外打回");
  assert.equal(state.gate, undefined, "拒绝不落闸");
});

// ---- 端到端:剧本回合里举卡 → 落卡即返回 → 收口定格 waiting_user;
//      闸在场时同回合 AskUserQuestion 被互斥拦下(不建卡不通知)。 ----

test("端到端:AI 举验证卡落卡即返回收口等待;闸在场 AskUserQuestion 被拦", async () => {
  const dataDir = mfcTemp("mfc-raisegate-e2e-");
  seedGreenClosed(dataDir);
  const script: Scene[] = [
    { tool: { name: "raise_gate",
      input: { kind: "env_verify", supplement: "部署输出核对无误" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "还要确认什么?", options: ["甲", "乙"], recommended: "甲",
    }] } } },
    { text: "已举卡等待用户。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1",
    { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    // 空闲会话经真实发送入口启动(开回合);剧本 AI 举卡、再试图追问。
    service.requestRepoChanges("issue-1", { add: [BETA], remove: [] });
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "举卡后收口定格 waiting_user");
    assert.equal(gated.gate!.kind, "env_verify");
    // 单卡互斥:AskUserQuestion 没有建成卡(不叠加)。
    assert.equal(gated.waiting, undefined, "闸在场不许 Agent 卡并存");
    const receipts = readEvents(dataDir, "issue-1")
      .filter((event) => event.kind === "tool_finished");
    const raised = receipts.find((event) =>
      event.payload.name === "raise_gate");
    assert.equal(raised?.payload.is_error, false, "raise_gate 成功");
    const asked = receipts.find((event) =>
      event.payload.name === "AskUserQuestion");
    assert.equal(asked?.payload.is_error, true, "追问被互斥拦下(工具错误)");
    assert.match(String(asked?.payload.result ?? ""), /平台闸/,
      "打回文案指路先等闸裁决");
    assert.match(JSON.stringify(model.requests), /平台闸/,
      "互斥文案进模型上下文");
    // 落卡即返回的另一半:等待通知发出(小鲁班喊人验环境)。
    await until(() => luban.messages.length ? luban.messages : undefined,
      "等待卡通知发出");
    assert.match(JSON.stringify(luban.messages), /验证/,
      "通知引导用户到卡上作答");

    // 作答链路回归:新举的卡走既有 answer() 单点分派——「验证发现
    // 问题」整体回退重新分析;通过没有码(ADR-0043:合入即通过,
    // 不再有 pass 裁决,部署在途旧卡补点 pass 走认不得的打回路)。
    // (answer 对认不得的码同步抛错,断言要异步包裹成拒绝。)
    await assert.rejects(async () => service.answer("issue-1", {
      state_version: gated.gate!.state_version, code: "pass",
    }), /无法识别的验证答复/, "pass 码已随选项退役");
    const rolled = service.answer("issue-1", {
      state_version: gated.gate!.state_version, code: "fail",
      notes: "环境验证仍偶现超时",
    });
    assert.equal(rolled.stage, "analyze", "发现问题回退问题分析");
    assert.equal(rolled.round, 2, "回退轮次+1");
    assert.equal(rolled.gate, undefined, "闸随作答消失");
    assert.equal(rolled.stage_states?.[4], "redo", "mr_green 标重做");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});
