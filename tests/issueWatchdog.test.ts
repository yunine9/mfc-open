/**
 * 守闸器(#248,ADR-0024):「应举的卡长时间缺席」的纯报警监视。
 * 机械判据=mr_green 已收口 + 会话空闲 + 无闸在等 + 收口超阈值
 * (stage_at 为收口时刻)→ 小鲁班喊人。waiting_user/running/接管/终态
 * 一律不喊(守闸器防静默漏卡,不打扰已知的等待)。纯报警:不改
 * 会话状态、不举卡、不开回合;通知 fail-open;幂等靠 outcome 通道
 * (taskId,status)去重,轮次入键——返工新一轮是新事件。
 *
 * 阈值旋钮 env_verify_watchdog_minutes(settings 同源):分钟值,
 * 缺省 120,0=关,允许小数(亚分钟窗口,测试用);节拍=阈值/5、
 * 下限 500ms,首扫在服务启动时立即执行一次。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import { MR_GREEN_ENV_VERIFY_NOTE,
  type IssueSessionState } from "../src/issueFlow/state.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 种一个 mr_green 已收口的空闲单(无 MR/无监看——守闸判据只看
 *  收口与卡,不看交付账)。stageAtMs 控制收口时刻。 */
function seedClosed(dataDir: string, id: string, stageAtMs: number,
  overrides: Partial<IssueSessionState> = {}): void {
  const now = new Date().toISOString();
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: `守闸夹具-${id}`, description: "", source: "dts",
    ticket: "DTS2026091300248",
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done"],
    status: "idle", stage: "mr_green",
    stage_note: MR_GREEN_ENV_VERIFY_NOTE,
    stage_at: new Date(stageAtMs).toISOString(),
    ...overrides,
  }));
}

function readState(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 等一个安静窗口:期间谓词恒不成立才算过。 */
async function quiesce(ms: number, forbidden: () => boolean): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  assert.equal(forbidden(), false, "安静窗口内不得触发");
}

function options(input: {
  dataDir: string;
  endpoint: string;
  watchdogMinutes?: number;
  backoffMs?: number[];
  notifierLog?: (message: string) => void;
}): IssueFlowOptions {
  return {
    dataDir: input.dataDir,
    provider: "maeflow",
    model: "test",
    modelsJson: {},
    settings: {
      models: () => ({}),
      runtime: () => ({
        ...(input.watchdogMinutes !== undefined
          ? { env_verify_watchdog_minutes: input.watchdogMinutes } : {}),
      }),
    },
    notifier: new Notifier({ endpoint: input.endpoint, fake: true,
      ...(input.backoffMs ? { backoffMs: input.backoffMs } : {}),
      ...(input.notifierLog ? { log: input.notifierLog } : {}) }),
    linkBase: "http://work.test",
  };
}

test("守闸触发:收口超阈值仍无验证卡——喊人一次,会话状态一字不动", async () => {
  const dataDir = mfcTemp("mfc-watchdog-fire-");
  // 阈值 0.001 分钟=60ms;收口时刻取 10 分钟前,首扫即命中。
  seedClosed(dataDir, "issue-1", Date.now() - 10 * 60_000);
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new IssueFlowService(
    options({ dataDir, endpoint: luban.endpoint, watchdogMinutes: 0.001 }));
  try {
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "守闸报警发出");
    assert.match(JSON.stringify(messages), /仍没有环境验证卡/);
    assert.match(JSON.stringify(messages), /可能漏举/);
    assert.match(JSON.stringify(messages), /issue-1/);
    // 纯报警:状态/闸/stage_note 全部原样。
    const state = readState(dataDir, "issue-1");
    assert.equal(state.status, "idle");
    assert.equal(state.gate, undefined);
    assert.equal(state.stage_note, MR_GREEN_ENV_VERIFY_NOTE);
    // 幂等:再等三个节拍,同轮只喊一次。
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    assert.equal(luban.messages.length, 1, "同轮不重复轰炸");
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("守闸不误伤:闸在场/阶段未收口/等待中/接管中/未到阈值——一律不喊", async () => {
  const dataDir = mfcTemp("mfc-watchdog-quiet-");
  const old = Date.now() - 10 * 60_000;
  seedClosed(dataDir, "issue-gated", old, {
    gate: { id: "g1", kind: "env_verify", state_version: 1,
      created_at: new Date().toISOString(),
      question: { questions: [{ question: "验证?", options: [] }] } },
  });
  seedClosed(dataDir, "issue-open", old, {
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "waiting_user",
  });
  seedClosed(dataDir, "issue-takeover", old, {
    takeover: { at: new Date().toISOString(), by: "dev" },
  });
  seedClosed(dataDir, "issue-fresh", Date.now() - 1_000); // 未到阈值(30s 窗口)
  const luban = new FakeLubanServer();
  await luban.start();
  // 阈值 0.5 分钟=30s(节拍 6s,下限 500ms 不生效):排除项靠标志位
  // 压制,fresh 种子靠时间压制——安静窗口只须显著短于阈值。
  const service = new IssueFlowService(
    options({ dataDir, endpoint: luban.endpoint, watchdogMinutes: 0.5 }));
  try {
    // 安静窗口 1.8s(远小于 30s 阈值):全部安静。
    await quiesce(1_800, () => luban.messages.length > 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("守闸不误伤②:验证已通过待归档的会话不喊——照发会诱返工", async () => {
  const dataDir = mfcTemp("mfc-watchdog-passed-");
  // pass 裁决后的现场:idle + mr_green done + 无闸,但停机说明已换成
  // 「待归档」口径——守闸判据按收口说明常量精确区分,不把已验证的
  // 单子误报成漏卡(照发会诱使用户发「继续」推进返工)。
  seedClosed(dataDir, "issue-passed", Date.now() - 10 * 60_000, {
    stage_note: "环境验证通过——确认 MR 合入后可归档收口",
  });
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new IssueFlowService(
    options({ dataDir, endpoint: luban.endpoint, watchdogMinutes: 0.001 }));
  try {
    await quiesce(1_800, () => luban.messages.length > 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("守闸不误伤③:流水线在途监看不喊——修复环飞行中卡缺席是暂态", async () => {
  const dataDir = mfcTemp("mfc-watchdog-watching-");
  // #374 撤卡后的修复窗口:idle + 已收口 + 无闸,但新提交的流水线
  // 监看还在跑——跑完自见分晓(绿→真空再喊,红→修复回合接着来),
  // 飞行中喊人只会把人叫来打断正在跑的修复。
  seedClosed(dataDir, "issue-watching", Date.now() - 10 * 60_000, {
    pipelines: {
      "http://loop.test/repo.git": {
        sha: "c".repeat(40), status: "running", watching: true,
        started_at: new Date().toISOString(),
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  });
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new IssueFlowService(
    options({ dataDir, endpoint: luban.endpoint, watchdogMinutes: 0.001 }));
  try {
    await quiesce(1_800, () => luban.messages.length > 0);
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("守闸阈值热改:启动时关(0),后来开到非 0——下一拍生效不用重启", async () => {
  const dataDir = mfcTemp("mfc-watchdog-hotknob-");
  seedClosed(dataDir, "issue-1", Date.now() - 10 * 60_000);
  const luban = new FakeLubanServer();
  await luban.start();
  // 旋钮经可变闭包供给:模拟管理页改 settings 后的现读现判。
  let knobMinutes = 0;
  const service = new IssueFlowService(options({
    dataDir,
    endpoint: luban.endpoint,
    get watchdogMinutes() { return knobMinutes; },
  }));
  try {
    // 启动时关:三个节拍安静。
    await quiesce(1_800, () => luban.messages.length > 0);
    // 热改开到 60ms 阈值:下一拍(500ms)内触发。
    knobMinutes = 0.001;
    await until(() => luban.messages.length ? luban.messages : undefined,
      "热改后守闸触发");
  } finally {
    await service.shutdown().catch(() => undefined);
    await luban.stop();
  }
});

test("守闸 fail-open:通知发送失败只留痕——不炸服务、不动会话", async () => {
  const dataDir = mfcTemp("mfc-watchdog-failopen-");
  seedClosed(dataDir, "issue-1", Date.now() - 10 * 60_000);
  // 端点指向必然拒连的端口:Notifier 自身即 fail-open(deliver 从不
  // reject,失败只留痕§14.4),守闸器的 .catch 是第二道防线——两道
  // 都不许把失败变成会话状态变化或进程异常。
  const deliveryLogs: string[] = [];
  const service = new IssueFlowService({
    ...options({ dataDir, endpoint: "http://127.0.0.1:1/hook",
      watchdogMinutes: 0.001, backoffMs: [0],
      notifierLog: (message) => deliveryLogs.push(message) }),
  });
  try {
    // 等过首扫:无未捕获异常(进程不炸),发送失败在通知层留痕。
    await until(() => deliveryLogs.some((line) => /通知发送失败/.test(line))
      ? true : undefined, "通知层 fail-open 留痕");
    const state = readState(dataDir, "issue-1");
    assert.equal(state.status, "idle", "会话状态一字不动");
    assert.equal(state.gate, undefined, "不举卡");
    assert.equal(state.stage_note, MR_GREEN_ENV_VERIFY_NOTE, "不落便签");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
