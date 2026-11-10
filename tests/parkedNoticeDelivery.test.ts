/**
 * 停靠通知注入——发送必达(#244,ADR-0024 前置)。
 *
 * 平台事实通知的三态发送里,「等人=落便签」这一态今天只写 stage_note
 * (首行 120 字的显示摘要),问题卡原地续跑的上下文里模型根本看不到它
 * ——今天被平台代举掩盖,代举停掉后就是主路径上的静默断链。本票补齐:
 * 便签全文进欠账队列(parked_notices,不上 wire),续跑(答卡原地续跑/
 * 重启重建续聊)时随注入词送达模型,送达即清账。
 *
 * 断言口径:marker 串(beta/gamma 仓地址)只存在于通知词里,种子里没有
 * ——它在模型请求里的出现次数就是注入次数(0=没注入,>1=没清账)。
 * 注入走决定回执/续聊词,断言对整个请求串接做(stringify 含工具结果块)。
 *
 * 种子不带 scenario:催办谓词对存量现场不催(shouldNudgeFixed 首判),
 * 剧本回合正常落 idle,不被催办续跑搅局。
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

const ALPHA = "https://git.example.com/org/alpha.git";
const BETA = "https://git.example.com/org/beta.git";
const GAMMA = "https://git.example.com/org/gamma.git";

function seedIssue(dataDir: string, id = "issue-1"): void {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: "停靠通知注入夹具", description: "", source: "dts",
    ticket: "DTS2026091300244",
    repo_url: ALPHA, repo_urls: [ALPHA],
    status: "idle", stage: "analyze", stage_note: "", stage_at: now,
  }));
}

function readStateFile(dataDir: string, id: string): IssueSessionState {
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

function baseOptions(dataDir: string, model: ScriptedModelServer):
  IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  };
}

/** 模型收到的全部请求串接(含工具结果块——注入词走的正是决定回执)。 */
function transcript(model: ScriptedModelServer): string {
  return JSON.stringify(model.requests);
}

/** 启动一幕举问题卡的回合,等到挂起。 */
async function parkAgentCard(
  service: IssueFlowService,
  model: ScriptedModelServer,
  dataDir: string,
): Promise<{ state_version: number }> {
  service.reply("issue-1", "请继续推进验证");
  const waiting = await until(() => {
    const issue = service.get("issue-1");
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
  }, "Agent 问题卡挂起");
  assert.ok(model.requests.length >= 1, "启动回合已发出模型请求");
  return { state_version: waiting.waiting!.state_version };
}

function askScene(): Scene[] {
  return [
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "请描述你在目标环境验证时看到的现象?" },
    ] } } },
    { text: "已收到现象描述。" },
  ];
}

test("等人便签全文进欠账队列;答卡原地续跑注入模型上下文,送达即清账", async () => {
  const dataDir = mfcTemp("mfc-issue-parkednotice-");
  seedIssue(dataDir);
  const model = new ScriptedModelServer(askScene(), "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const card = await parkAgentCard(service, model, dataDir);

    // 平台通知到来(等人=park 便签)——真入口走发送三态。
    service.requestRepoChanges("issue-1", { add: [BETA], remove: [] });
    const parked = readStateFile(dataDir, "issue-1");
    assert.match(parked.stage_note ?? "", /代码仓/, "显示摘要(首行)照旧");
    assert.equal(parked.parked_notices?.length, 1, "全文欠账队列在场");
    assert.match(parked.parked_notices![0], /beta\.git/, "队列存通知全文(非 120 字摘要)");

    // 答卡 → 原地续跑:便签注入模型上下文(决定回执随行)。
    service.answer("issue-1", {
      state_version: card.state_version,
      decision: "偶发,重启恢复",
    });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑回合收口");
    const seen = transcript(model).split("org/beta.git").length - 1;
    assert.equal(seen, 1, `便签应恰好注入一次(实际 ${seen} 次)`);
    assert.equal(
      readStateFile(dataDir, "issue-1").parked_notices?.length ?? 0, 0,
      "送达即清账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("多张便签合并注入:两条都到模型上下文,一次清账", async () => {
  const dataDir = mfcTemp("mfc-issue-parkednotice-multi-");
  seedIssue(dataDir);
  const model = new ScriptedModelServer(askScene(), "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const card = await parkAgentCard(service, model, dataDir);
    service.requestRepoChanges("issue-1", { add: [BETA], remove: [] });
    service.requestRepoChanges("issue-1", { add: [GAMMA], remove: [] });
    assert.equal(readStateFile(dataDir, "issue-1").parked_notices?.length, 2,
      "两张便签都在欠账队列");

    service.answer("issue-1",
      { state_version: card.state_version, decision: "偶发" });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑回合收口");
    const seen = transcript(model);
    assert.equal(seen.split("org/beta.git").length - 1, 1, "第一条注入一次");
    assert.equal(seen.split("org/gamma.git").length - 1, 1, "第二条注入一次");
    assert.equal(
      readStateFile(dataDir, "issue-1").parked_notices?.length ?? 0, 0,
      "注入后清账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("重启重建:欠账便签随续聊提示词送达模型(不依赖 stage_note 首行)", async () => {
  const dataDir = mfcTemp("mfc-issue-parkednotice-restart-");
  seedIssue(dataDir);
  const model = new ScriptedModelServer(askScene(), "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    await parkAgentCard(service, model, dataDir);
    // 落两张便签后重启:stage_note 只剩最后一张的首行,第一张全文
    // 只有欠账队列还记得——重启后必须经续聊提示词全部送达。
    service.requestRepoChanges("issue-1", { add: [BETA], remove: [] });
    service.requestRepoChanges("issue-1", { add: [GAMMA], remove: [] });
    await service.shutdown();
  } finally {
    await model.stop();
  }

  const model2 = new ScriptedModelServer(
    [{ text: "已带现场继续。" }], "scripted-v1", { linear: true });
  await model2.start();
  const service2 = new IssueFlowService(baseOptions(dataDir, model2));
  try {
    // 重启后问题卡仍挂起:作答走「进程重启后的作答」重建路——
    // 开新现场、决定补登记、以续聊提示词把答案交给重建的上下文。
    // 欠着的便签必须随这份提示词一并送达。
    const restarted = await until(() => {
      const issue = service2.get("issue-1");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "重启后问题卡仍在等待");
    service2.answer("issue-1", {
      state_version: restarted.waiting!.state_version,
      decision: "偶发,重启恢复",
    });
    await until(() => {
      const issue = service2.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "重启后作答回合收口");
    const seen = transcript(model2);
    assert.ok(seen.includes("org/beta.git"),
      "第一张便签(stage_note 已装不下的)必须经欠账队列送达");
    assert.ok(seen.includes("org/gamma.git"), "最后一张便签也要到");
    assert.equal(
      readStateFile(dataDir, "issue-1").parked_notices?.length ?? 0, 0,
      "送达即清账");
  } finally {
    await service2.shutdown().catch(() => undefined);
    await model2.stop();
  }
});

test("空闲发送=开回合直送:通知进模型上下文,不欠账不落便签", async () => {
  const dataDir = mfcTemp("mfc-issue-parkednotice-idle-");
  seedIssue(dataDir);
  const model = new ScriptedModelServer(
    [{ text: "已拉取新仓。" }], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.requestRepoChanges("issue-1", { add: [BETA], remove: [] });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "空闲发送回合收口");
    assert.ok(transcript(model).includes("org/beta.git"), "通知直送模型");
    assert.equal(
      readStateFile(dataDir, "issue-1").parked_notices?.length ?? 0, 0,
      "直送不欠账");
    assert.equal(readStateFile(dataDir, "issue-1").stage_note ?? "", "",
      "直送不落便签");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
