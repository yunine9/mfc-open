/**
 * 主动拉取日志的意图递交(#268,POST /issues/:id/logs/fetch →
 * service.requestLogFetch)契约测试。
 *
 * 设计裁定(ADR-0026,Agent 主理第二例):按钮不执行任何事——端点只
 * 守卫+留痕+发送通知词,拉取由 Agent 按技能 fetch-logs 执行(缺环境走
 * 既有环境闸),平台不代拉。测试钉三面:
 * - 终态守卫:archived/canceled/failed 打回(终态不可续聊,发送只会
 *   写成永不送达的死信),打回零副作用(转移账不留痕);
 * - 发送通道:startPlatformTurn 三态——空闲=开回合直送(通知进模型
 *   上下文,不欠账),等人=落便签(parked_notices 全文,答卡注入即清),
 *   运行中=steer 送达(话进正在跑的回合,不抢方向盘)。
 *
 * 路由 own() 闸的 403 盘点在 issueViewMode 的 WRITE_ROUTES;路由/文案/
 * 页面形状由 issueUiContracts 源码契约钉住;这里只测服务层与发送语义。
 * 断言口径:marker 串(通知词独有短语)只存在于通知词里,它在模型请求
 * 里的出现次数就是注入次数(范式照 parkedNoticeDelivery/issueRepoChange)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 通知词独有的短语:种子里没有,只在 logs.fetch 文案里——它在模型
 * 请求里的出现即注入事实。 */
const MARKER = "拉取网管侧日志";

function seedIssue(dataDir: string, options: {
  id?: string;
  status?: string;
  /** 重启续跑形态(issueRepoChange 的 steer 先例):带场景与阶段账,
   * 服务构造后的自动续跑才有完整现场。 */
  resume?: boolean;
} = {}): string {
  const id = options.id ?? "issue-1";
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "拉取日志意图夹具", description: "", source: "dts",
    ticket: "DTS2026091400268",
    ...(options.resume ? {
      repo_url: "https://git.example.com/org/alpha.git",
      repo_urls: ["https://git.example.com/org/alpha.git"],
      scenario: "ticket", round: 1,
      stage_states: ["done", "pending", "pending", "pending", "pending"],
    } : {}),
    status: options.status ?? "idle",
    stage: "analyze", stage_note: "", stage_at: now,
  }));
  return id;
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

function baseOptions(dataDir: string, model: ScriptedModelServer):
  IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

/** 模型收到的全部用户消息文本(跨请求、跨回合;issueRepoChange 同款)。 */
function userTexts(model: ScriptedModelServer): string {
  return model.requests
    .flatMap((request) => (request as any).messages ?? [])
    .filter((message: any) => message?.role === "user")
    .map((message: any) => typeof message.content === "string"
      ? message.content
      : (message.content ?? [])
        .map((block: any) => block?.text ?? "").join(" "))
    .join("\n");
}

test("终态守卫:archived/canceled/failed 拒绝拉取意图(死信防线),打回零留痕", async () => {
  const dataDir = mfcTemp("mfc-issue-logfetch-terminal-");
  for (const status of ["archived", "canceled", "failed"]) {
    const id = seedIssue(dataDir, { id: `issue-${status}`, status });
    const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
    await model.start();
    const service = new IssueFlowService(baseOptions(dataDir, model));
    try {
      assert.throws(
        () => service.requestLogFetch(id),
        /已结束\(终态\)/,
        `${status} 会话应被终态守卫打回`);
      const state = readStateFile(dataDir, id);
      assert.ok(!(state.transitions ?? []).some((entry) =>
        /用户请求拉取网管日志/.test(entry.note ?? "")),
        `${status} 被拒提交不得留痕`);
    } finally {
      void service.shutdown().catch(() => undefined);
      void model.stop();
    }
  }
});

test("queued 守卫同构于 requestRepoChanges(终态守卫有测,queued 不单测):queued 在泵下是瞬态,服务侧造稳定夹具不可行——先例 issueRepoChange 同样只测终态,queued 分支由同构骨架保证", () => {
  const source = readFileSync(
    new URL("../src/issueFlow/service.ts", import.meta.url), "utf-8");
  const body = source.slice(
    source.indexOf("requestLogFetch(id: string)"),
    source.indexOf("// ---- 会话驱动 ----"));
  assert.match(body, /status === "queued"/, "queued 守卫必须在场");
});

test("空闲发送=开回合直送:通知进模型上下文,不欠账不落便签", async () => {
  const dataDir = mfcTemp("mfc-issue-logfetch-idle-");
  const id = seedIssue(dataDir);
  const model = new ScriptedModelServer(
    [{ text: "收到,这就按 fetch-logs 技能拉取日志。" }], "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const summary = service.requestLogFetch(id);
    assert.equal(summary.status, "running", "空闲=开续聊回合");
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "发送回合收口");
    assert.ok(userTexts(model).includes(MARKER), "通知词直送模型");
    assert.equal(readStateFile(dataDir, id).parked_notices?.length ?? 0, 0,
      "直送不欠账");
    assert.equal(readStateFile(dataDir, id).stage_note ?? "", "",
      "直送不落便签");
    // 留痕:事件账带 via=logs 的用户消息,转移账记平台递交。
    assert.ok(readEvents(dataDir, id).some((event) =>
      event.kind === "user_message" && event.payload.via === "logs"
      && String(event.payload.text).includes("请求拉取网管日志")),
    "意图递交落事件账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("等人=落便签:全文进欠账队列,答卡原地续跑注入即清", async () => {
  const dataDir = mfcTemp("mfc-issue-logfetch-parked-");
  const id = seedIssue(dataDir);
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "请描述你在目标环境验证时看到的现象?" },
    ] } } },
    { text: "已收到现象描述。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 启动一幕举问题卡的回合,等到挂起(范式照 parkedNoticeDelivery)。
    service.reply(id, "请继续推进验证");
    const waiting = await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "Agent 问题卡挂起");

    // 平台通知到来(等人=park 便签)。
    service.requestLogFetch(id);
    const parked = readStateFile(dataDir, id);
    assert.ok((parked.stage_note ?? "").includes(MARKER),
      "显示摘要(首行)在场");
    assert.equal(parked.parked_notices?.length, 1, "全文欠账队列在场");

    // 答卡 → 原地续跑:便签注入模型上下文,送达即清账。
    service.answer(id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发,重启恢复",
    });
    await until(() => {
      const issue = service.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑回合收口");
    // 注入断言对整个请求串接做(含工具结果块/回执——注入走决定回执,
    // parkedNoticeDelivery 同款口径,不按角色过滤)。
    const seen = JSON.stringify(model.requests);
    assert.ok(seen.includes(MARKER), "便签全文应经续聊送达模型");
    assert.equal(
      readStateFile(dataDir, id).parked_notices?.length ?? 0, 0,
      "送达即清账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("运行中=steer 送达:通知递进正在跑的回合,不抢方向盘也不落便签", async () => {
  const dataDir = mfcTemp("mfc-issue-logfetch-steer-");
  // 种 running(重启续跑形态,带完整现场):第一幕故意跑慢命令,给
  // steer 留忙时窗口。
  const id = seedIssue(dataDir, { status: "running", resume: true });
  const script: Scene[] = [
    { tool: { name: "bash", input: { command: "sleep 5" } } },
    { text: "收到日志拉取请求,稍后执行。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 等模型真的开跑(请求已发出=现场 driver 必在)再递交意图。
    await until(() => model.requests.length >= 1 ? true : undefined,
      "重启续跑回合启动");
    const summary = service.requestLogFetch(id);
    assert.equal(summary.status, "running", "不打断正在跑的回合");
    // steer 送达事件(user_message via=interrupt,正文=通知词全文)。
    await until(() => readEvents(dataDir, id).some((event) =>
      event.kind === "user_message"
      && event.payload.via === "interrupt"
      && String(event.payload.text).includes(MARKER))
      ? true : undefined,
    "steer 送达事件落账");
    await until(() => userTexts(model).includes(MARKER) ? true : undefined,
      "通知正文进模型上下文");
    // 落的是 steer 不是便签:回合收口后 stage_note 不被 park 覆写。
    await until(() => {
      const state = readStateFile(dataDir, id);
      return state.status === "idle" ? state : undefined;
    }, "回合收口");
    assert.doesNotMatch(readStateFile(dataDir, id).stage_note ?? "",
      new RegExp(MARKER), "送达了就不落便签");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
