/** 模型网关认证失败(401)的自愈与落点:瞬发退避重试原地续走,穷尽落
 *  「停机待恢复」不判死,发「继续」原地续推且会话上下文不丢。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import {
  looksLikeAuthFailure,
  looksLikeRateLimited,
} from "../src/sessionDriver.ts";
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

/** 网关 401 的真实形状(2026-09-22 实锤原文)。 */
const AUTH_401 = "401 Authentication failed";

const TICKET = "DTS-2026-3001";

/** 首轮六幕:读单→推阶段→拉仓→推阶段→写报告→提交分析,末幕收嘴。 */
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
    { text: "分析提交完毕。" },
  ];
}

interface Harness {
  service: IssueFlowService;
  model: ScriptedModelServer;
  id: string;
  logs: string[];
  scenes: Scene[];
}

/** 组一台快退避的问题流:401 判据的端到端演练场,剧本跨请求顺演,
 *  网关错误不消耗剧幕(与生产一致——失败的那次请求没有产出回合)。 */
async function harness(
  name: string,
  failures: { message: string; times: number },
): Promise<Harness> {
  const root = mfcTemp(name);
  const origin = bareOrigin(root);
  const scenes = firstRoundScenes(origin);
  let normalIndex = 0;
  const model = new ScriptedModelServer(
    Array.from({ length: 100 }, () => ({ text: "结束" })), "scripted-v1", {
      linear: true,
      beforeScene: ({ index }) => {
        model.script[index] =
          scenes[Math.min(normalIndex++, scenes.length - 1)];
      },
    });
  await model.start();
  model.failWith(failures.message, failures.times);
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir: root,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}) },
    authRetryDelaysMs: [20, 20],
    dts: new MockDtsGateway(),
    gitCredential: () => ({
      username: "dev", password: "git-token", email: "dev@example.com",
    }),
    log: (message) => logs.push(message),
  });
  const created = service.create({
    account: "dev",
    title: "登录超时",
    ticket: TICKET,
    source: "dts",
    repoUrl: origin,
    environment: { hosts: ["192.0.2.8"], backendPassword: "env-shared-secret" },
  });
  return { service, model, id: created.id, logs, scenes };
}

function atAnalysisGate(h: Harness) {
  return until(() => {
    const issue = h.service.get(h.id);
    if (issue.status === "failed") {
      throw new Error(issue.error ?? "会话不应判死");
    }
    return issue.status === "waiting_user"
      && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
  }, "分析确认闸");
}

test("401 判据:认网关认证错误原文,不吞限流与别的故障", () => {
  for (const detail of [
    AUTH_401,
    '401 {"type":"error","error":{"type":"authentication_error",'
      + '"message":"Authentication failed"}}',
    "Authentication failed",
    "Unauthorized",
    "invalid x-api-key",
    "Error: API key expired",
    "Incorrect API key provided",
  ]) {
    assert.equal(looksLikeAuthFailure(detail), true, detail);
  }
  for (const detail of [
    "429 Too Many Requests: rate limit exceeded",
    "500 internal server error",
    "terminated",
    "context_length_exceeded",
    "connect ECONNREFUSED 127.0.0.1:8080",
  ]) {
    assert.equal(looksLikeAuthFailure(detail), false, detail);
  }
  // 限流判据不认 401:settle 两个分支互斥,谁先谁后都不抢错。
  assert.equal(looksLikeRateLimited(AUTH_401), false);
});

test("瞬发 401:退避自动重试后原地续走,不判死", async () => {
  const h = await harness("mfc-issue-auth-transient-",
    { message: AUTH_401, times: 1 });
  try {
    const gate = await atAnalysisGate(h);
    assert.equal(gate.stage, "analyze");
    // 原投 1 次(被拒)+ 重试 1 次 + 六幕剧本各 1 次。
    assert.equal(h.model.requests.length, h.scenes.length + 1,
      `401 应只多花一次重试请求,实际 ${h.model.requests.length}`);
    assert.ok(h.logs.some((line) =>
      line.includes("模型网关认证失败") && line.includes("自动重试")),
    `没走退避重试路径,日志: ${h.logs.join(" | ")}`);
  } finally { await h.model.stop(); }
});

test("持续 401:重试穷尽落停机待恢复,发「继续」原地续推", async () => {
  const h = await harness("mfc-issue-auth-persistent-",
    { message: AUTH_401, times: 99 });
  try {
    const stopped = await until(() => {
      const issue = h.service.get(h.id);
      if (issue.status === "failed") {
        throw new Error(`401 不应判死: ${issue.error ?? ""}`);
      }
      return issue.status === "idle" ? issue : undefined;
    }, "停机待恢复");
    assert.match(stopped.stage_note ?? "", /模型网关认证失败/);
    assert.match(stopped.stage_note ?? "", /「继续」/);
    // 原投 + 预算内 2 次退避重试,穷尽即停,不多烧。
    assert.equal(h.model.requests.length, 3,
      `重试预算失控,发了 ${h.model.requests.length} 次请求`);
    // 上游恢复,发「继续」:同一会话原地续推,历史里带着重试通知。
    h.model.failWith("", 0);
    h.service.reply(h.id, "继续");
    const gate = await atAnalysisGate(h);
    assert.equal(gate.stage, "analyze");
    const lastRequest = JSON.stringify(h.model.requests.at(-1));
    assert.match(lastRequest, /平台重试/,
      "续推请求应延续同一会话上下文(重试通知仍在历史里)");
  } finally { await h.model.stop(); }
});
