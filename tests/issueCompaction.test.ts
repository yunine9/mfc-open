/** 问题会话也使用统一容量策略，阶段切换不再强制调用第二套压缩。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
} as NodeJS.ProcessEnv;

/** 带初始提交的裸仓远端(pull_repo 的拉取目标)。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
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

const TICKET = "DTS-2026-2001";

/** 压缩请求的识别:pi 的压缩不带工具表;回合内的模型调用都带。
 *  这些剧本里没有第二个无工具请求(无子会话/无视觉旁路)。 */
function compactionRequests(model: ScriptedModelServer) {
  return model.requests.filter((request) => !("tools" in request));
}

/** 首轮七幕；长排查记录用于验证下一次模型请求前的容量整理。 */
function firstRoundScenes(origin: string): Scene[] {
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收:web/src/auth/reclaim.ts 超时回调改双检。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "排查过程全记录(测试填充,替真实长日志):\n"
      + "排查日志行 x".repeat(14_000) },
  ];
}

/** 修复回合两幕:提交一笔修复→回合结束。 */
const fixScenes: Scene[] = [
  { tool: { name: "bash", input: { command: "echo fix-round" } } },
  { text: "修复回合完成。" },
];

/** 二轮修订三幕:补报告→重新提交→回合结束(闸再举)。 */
const revisionScenes: Scene[] = [
  { tool: { name: "bash", input: { command:
    "printf '\\n## 第二轮补充\\n\\n按补充意见修订。\\n' >> issue-analysis.md" } } },
  { tool: { name: "submit_analysis",
    input: { summary: "二轮:按补充意见修订" } } },
  { text: "二轮分析已提交。" },
];

const noKnob = () => ({});

interface Harness {
  service: IssueFlowService;
  model: ScriptedModelServer;
  id: string;
  gateVersion: number;
}

/** 走到首轮分析确认闸的公共现场:建服务→登记→等闸。 */
async function atAnalysisGate(
  dataDir: string,
  runtime: () => Record<string, number | undefined>,
  scriptOf: (origin: string) => Scene[],
): Promise<Harness> {
  const origin = bareOrigin(dataDir);
  const scenes = scriptOf(origin);
  let normalIndex = 0;
  const model = new ScriptedModelServer(Array.from({ length: 100 }, () => ({ text: "结束" })), "scripted-v1", {
    linear: true,
    beforeScene: ({ request, index }) => {
      model.script[index] = JSON.stringify(request.system).includes("你在整理 Coding Agent")
        ? { text: "目标：修复登录超时。用户已确认修改方案；分析报告在 issue-analysis.md。下一步按超时回调双检方案修复，不重复拉仓和提交分析。" }
        : scenes[Math.min(normalIndex++, scenes.length - 1)];
    },
  });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime },
    dts: new MockDtsGateway(),
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  const created = service.create({
    account: "dev",
    title: "登录超时",
    ticket: TICKET,
    source: "dts",
    repoUrl: origin,
    environment: { hosts: ["192.0.2.8"], backendPassword: "env-shared-secret" },
  });
  const gate = await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "首轮分析确认闸");
  assert.equal(gate.stage, "analyze");
  return { service, model, id: created.id, gateVersion: gate.gate!.state_version };
}

/** 等下一个分析确认闸(二轮),失败态如实抛。 */
async function nextAnalysisGate(h: Harness) {
  return until(() => {
    const issue = h.service.get(h.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      && issue.gate.state_version > h.gateVersion ? issue : undefined;
  }, "二轮分析确认闸");
}

test("分析确认后自动按容量整理，修复消息仍携带报告和修改方案", async () => {
  const h = await atAnalysisGate(mfcTemp("mfc-issue-budget-boundary-"), noKnob,
    (origin) => [...firstRoundScenes(origin), ...fixScenes]);
  try {
    h.service.answer(h.id, { state_version: h.gateVersion, code: "confirm" });
    await until(() => h.service.get(h.id).status === "idle" ? true : undefined, "修复收口");
    assert.equal(h.service.get(h.id).stage, "fix");
    assert.ok(compactionRequests(h.model).length >= 1);
    const requests = h.model.requests.filter((r) => "tools" in r);
    assert.match(JSON.stringify(requests.at(-1)), /issue-analysis\.md/);
    assert.match(JSON.stringify(requests.at(-1)), /超时回调.*双检/);
  } finally { await h.model.stop(); }
});

test("旧旋钮设为 0 也不关闭容量保护，长材料主动整理后继续分析", async () => {
  const h = await atAnalysisGate(mfcTemp("mfc-issue-budget-zero-"),
    () => ({ issue_compact_every_events: 0 }),
    (origin) => [...firstRoundScenes(origin), ...revisionScenes]);
  try {
    h.service.answer(h.id, { state_version: h.gateVersion, code: "supplement", notes: "核对连接池监控" });
    await nextAnalysisGate(h);
    assert.ok(compactionRequests(h.model).length >= 1);
    assert.equal(h.service.get(h.id).stage, "analyze");
  } finally { await h.model.stop(); }
});

test("短会话不会因事件数或阶段切换多调用摘要模型", async () => {
  const h = await atAnalysisGate(mfcTemp("mfc-issue-budget-small-"),
    () => ({ issue_compact_every_events: 1 }),
    (origin) => [...firstRoundScenes(origin).slice(0, -1), { text: "分析结束" }, ...fixScenes]);
  try {
    h.service.answer(h.id, { state_version: h.gateVersion, code: "confirm" });
    await until(() => h.service.get(h.id).status === "idle" ? true : undefined, "修复收口");
    assert.equal(compactionRequests(h.model).length, 0);
  } finally { await h.model.stop(); }
});

test("压缩模型失败：保留历史，问题流继续且不伪造成功压缩", async () => {
  const h = await atAnalysisGate(mfcTemp("mfc-issue-budget-failure-"), noKnob,
    (origin) => [...firstRoundScenes(origin), ...fixScenes]);
  try {
    h.model.failWith("compact gateway exploded", 1);
    h.service.answer(h.id, { state_version: h.gateVersion, code: "confirm" });
    await until(() => h.service.get(h.id).status === "idle" ? true : undefined, "失败后继续");
    assert.equal(h.service.get(h.id).stage, "fix");
    assert.equal(compactionRequests(h.model).length, 1);
    assert.match(JSON.stringify(h.model.requests.at(-1)), /排查过程全记录/);
  } finally { await h.model.stop(); }
});
