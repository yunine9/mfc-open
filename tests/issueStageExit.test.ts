/**
 * 目标驱动阶段机(2026-08-28 拍板,issue #14)的出口回归:
 * - 拉单/拉仓不再机械推进,回执带注册表生成的阶段简报;
 * - 四阶段出口 = complete_stage 自报;三个举卡阶段没有它可绕;
 * - report_ut 降级为事实上报(不推进、不再是建 MR 前置);
 * - MR 验绿门三态(全绿当场放行 / 有红当场打回 / 在跑受理由监看器
 *   等绿放行)与"清单=台账"(少报/多报打回,空=空合法)。
 *
 * 范式与 issueFlowFixed.test.ts 同款:ScriptedModelServer 剧本 +
 * 本地裸仓 + 可编程假交付平台,只走公开 API 与工具回执/事件流断言;
 * 工具直调(免模型)仅用于门禁矩阵与回执文案(与既有"阶段门禁
 * 单点"测试同一形态)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import {
  fixedStages,
  loadState,
  type FixedStage,
  type IssueScenario,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  // 会话基线分支要在远端在架:pull_repo 按基线克隆(#441)。
  execFileSync("git", ["-C", seed, "branch", "br_V100R026C10_release"],
    { env: GIT_ENV });
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

/** 快速轮询的运行参数(流水线监看测试用:1s 一轮,预算 2 分钟)。 */
const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

/** 可编程验绿假件:MR 链接确定性(http://loop.test/mr/<n>);每个 SHA
 * 的流水线状态可配可改(status.get(sha) ?? defaultStatus)——中途改
 * defaultStatus 就演"在跑→绿",监看器下一轮询吃到新值。 */
class GatePlatform {
  readonly seen: Array<{ method: string; url: string }> = [];
  readonly status = new Map<string, "running" | "success" | "failed">();
  defaultStatus: "running" | "success" | "failed" = "running";
  /** 模拟同一 SHA 已有旧终态、随后重跑仍在进行的真实返回顺序。 */
  historicalStatus?: "success" | "failed";
  /** 过期结果窗口(#108):>0 时,对"非首查 SHA"的状态查询返回旧 SHA 的
   * 红灯 run(run 级 sha 标旧值,#106 已透传)——模拟修复重推新提交
   * 后、新 run 在平台注册前的窗口期。每命中一次自减,归零即视为
   * "新 run 已注册",后续查询回归正常路径。 */
  staleRedHitsLeft = 0;
  private firstStatusSha?: string;
  private mrCount = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        this.seen.push({ method: request.method ?? "", url: request.url ?? "" });
        const send = (payload: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method === "POST" && request.url === "/mr") {
          this.mrCount += 1;
          send({ url: `http://loop.test/mr/${this.mrCount}`, id: this.mrCount });
          return;
        }
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/status")) {
          const sha = new URL(request.url, "http://loop")
            .searchParams.get("sha") ?? "";
          this.firstStatusSha ??= sha;
          if (this.staleRedHitsLeft > 0 && sha !== this.firstStatusSha) {
            this.staleRedHitsLeft -= 1;
            send({
              runs: [{
                status: "failed",
                sha: this.firstStatusSha,
                log: "BUILD FAILURE: 模块 notify-service 编译失败",
              }],
            });
            return;
          }
          const run = this.status.get(sha) ?? this.defaultStatus;
          send({
            runs: [{ status: this.historicalStatus ?? "running" }, {
              status: run,
              ...(run === "failed"
                ? { log: "BUILD FAILURE: 模块 notify-service 编译失败" }
                : {}),
            }],
          });
          return;
        }
        response.writeHead(404);
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
    this.baseUrl =
      `http://127.0.0.1:${(this.server!.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    }
  }
}

const TICKET = "DTS-2026-1002";

/** 走到 mr_green 的最小剧本:确认前六幕 + 确认后的 修复(UT 并入)→自报→
 * 推送→建MR(刻意不跑 report_ut:没有 UT 记录也能建 MR)→逐次申报。
 * steps 的元素要么是申报清单(complete_stage 带 mrs,可含错报演出),
 * 要么是原样插进申报序列的整幕 Scene(如修复轮的重推/重建 MR)。 */
function chainScenes(origin: string, steps: Array<string[] | Scene>): Scene[] {
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  return [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n根因:演示。\\n## 置信度\\n高。\\n## 修改方案\\n修复演示路径。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示" } } },
    { text: "分析报告已提交,等待确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复`) } } },
    { tool: { name: "complete_stage", input: { note: "修复完成(UT 已跑绿)" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    ...steps.map((step): Scene =>
      Array.isArray(step)
        ? { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: step } } }
        : step),
    { text: "MR 已建,本回合到此。" },
    // 绿灯切换(#246)后的举卡幕,两组各司其职:
    // - 当场收口(complete_stage 即全绿):紧接着的第一组 raise_gate
    //   直接放行,闸落、收口等待;
    // - 受理等绿(申报时在跑):第一组 raise_gate 被拒(未全绿,前置
    //   校验按新契约打回),等监看器全绿后的发送回合消费第二组。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待验证。" },
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待验证。" },
  ];
}

interface Chain {
  dataDir: string;
  origin: string;
  luban: FakeLubanServer;
  notifier: Notifier;
  platform: GatePlatform;
  model: ScriptedModelServer;
  service: IssueFlowService;
  id: string;
  events(): Array<Record<string, any>>;
  saved(): IssueSessionState;
  okReceipts(): string;
  errorReceipts(): string[];
  trail(): string;
}

async function stopChain(chain: Chain): Promise<void> {
  await chain.service.shutdown().catch(() => undefined);
  await chain.model.stop();
  await chain.platform.stop();
  await chain.luban.stop();
}

/** 登记有单会话,等分析闸并确认,把剧本推进到提交MR回合。
 * steps 回调在拿到 origin 后生成申报演出(申报清单或插在申报序列
 * 里的整幕 Scene)。 */
async function startChain(options: {
  platformStatus?: "running" | "success" | "failed";
  historicalStatus?: "success" | "failed";
  staleRedHits?: number;
  steps?: (origin: string) => Array<string[] | Scene>;
}): Promise<Chain> {
  const dataDir = mfcTemp("mfc-issue-exit-");
  const origin = bareOrigin(dataDir);
  const platform = new GatePlatform();
  platform.defaultStatus = options.platformStatus ?? "running";
  platform.historicalStatus = options.historicalStatus;
  platform.staleRedHitsLeft = options.staleRedHits ?? 0;
  await platform.start();
  const model = new ScriptedModelServer(
    chainScenes(origin, options.steps?.(origin) ?? []),
    "scripted-v1", { linear: true });
  await model.start();
  // 假小鲁班挂上收口通知:mr_green 全绿收口要点名用户待归档(ADR-0013)。
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({
    endpoint: luban.endpoint, backoffMs: [0],
  });
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier,
  });
  const created = service.create({
    account: "dev", title: "出口回归", ticket: TICKET, source: "dts",
    repoUrl: origin,
    baseline: "br_V100R026C10_release",
  });
  const gate = await until(() => {
    const issue = service.get(created.id);
    if (issue.status === "failed") throw new Error(issue.error ?? "failed");
    return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
      ? issue : undefined;
  }, "分析确认闸");
  service.answer(created.id, {
    state_version: gate.gate!.state_version,
    code: "confirm",
  });
  const eventsRoot = join(dataDir, "issues", created.id);
  const readEvents = () => readFileSync(join(eventsRoot, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>);
  const completeStage = () => readEvents().filter((event) =>
    event.kind === "tool_finished" && event.payload?.name === "complete_stage");
  return {
    dataDir,
    origin,
    platform,
    model,
    service,
    luban,
    notifier,
    id: created.id,
    events: readEvents,
    saved: () => loadState(eventsRoot)!,
    okReceipts: () => completeStage()
      .filter((event) => !event.payload.is_error)
      .map((event) => String(event.payload.result)).join("\n"),
    errorReceipts: () => completeStage()
      .filter((event) => event.payload.is_error)
      .map((event) => String(event.payload.result)),
    trail: () => (loadState(eventsRoot)!.transitions ?? [])
      .map((entry) => entry.note).join("\n"),
  };
}

// ---- 免模型直调:出口动作的门禁矩阵与回执文案 ----

function directTools(state: IssueToolContext["state"], dataDir: string): {
  byName: (name: string) => {
    execute: (id: string, params: any) => Promise<unknown>;
  };
  textOf: (result: unknown) => string;
} {
  const ctx: IssueToolContext = {
    state,
    workspace: dataDir,
    dataRoot: dataDir,
    persist: () => undefined,
    dts: new MockDtsGateway(),
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(40),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  return {
    byName: (name) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `应注册 ${name}`);
      return tool!;
    },
    textOf: (result) =>
      (result as { content: Array<{ text: string }> }).content[0].text,
  };
}

function directState(
  dataDir: string, scenario: IssueScenario, stage: FixedStage,
): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-exit", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    scenario, round: 1,
    stage_states: fixedStages(scenario).map(() => "pending"),
    status: "idle", stage, stage_note: "", stage_at: now,
  };
}

test("出口回归(免模型):拉单/拉仓不再机械推进,回执带注册表简报,complete_stage 才收口", async () => {
  const dataDir = mfcTemp("mfc-issue-exit-advance-");
  const origin = bareOrigin(dataDir);
  const state = directState(dataDir, "ticket", "dts_info");
  const { byName, textOf } = directTools(state, dataDir);
  // a. 拉单:阶段原地不动;回执提醒出口(2026-09-11 起不再预渲染下一
  // 阶段简报——交接简报归 complete_stage 收口回执,见下)。
  const ticketReceipt = textOf(await byName("dts_get_ticket").execute("x", {}));
  assert.equal(state.stage, "dts_info", "拉单成功不再机械推进");
  assert.match(ticketReceipt, /MOCK 单据/);
  assert.match(ticketReceipt, /通读单据后调 complete_stage 申报完成/,
    "回执提醒本阶段出口");
  // complete_stage 才进 prep_repo,收口回执同样出自注册表。
  const enterPrep = textOf(
    await byName("complete_stage").execute("x", { note: "单据已通读" }));
  assert.equal(state.stage, "prep_repo");
  assert.equal(state.stage_states?.[0], "done");
  assert.match(enterPrep, /当前阶段「拉取代码仓·建分支」/);

  // b. 拉仓:落地不推进,回执指路 complete_stage;收口才进 analyze。
  const pullReceipt = textOf(
    await byName("pull_repo").execute("x", { url: origin }));
  assert.equal(state.stage, "prep_repo", "拉仓落地不再机械推进");
  assert.match(pullReceipt, /代码仓就绪/);
  assert.match(pullReceipt, /要用的仓都 pull_repo 拉齐/,
    "拉齐的出口文案出自注册表简报");
  assert.match(pullReceipt, /当前阶段「拉取代码仓·建分支」/);
  const enterAnalyze = textOf(
    await byName("complete_stage").execute("x", { note: "仓已拉齐" }));
  assert.equal(state.stage, "analyze", "complete_stage 自报才进问题分析");
  assert.equal(state.stage_states?.[1], "done");
  assert.match(enterAnalyze, /当前阶段「问题分析」/);
});

test("出口回归(免模型):三个举卡阶段调 complete_stage 被门禁拒绝", async () => {
  const dataDir = mfcTemp("mfc-issue-exit-gate-");
  // 分析(有单)与结论(无单)的出口是 submit_analysis;换库验证已
  // 封存(ADR-0013)——build_deploy 无阶段开放,调用恒被阶段门禁拒。
  const analyze = directTools(directState(dataDir, "ticket", "analyze"), dataDir);
  await assert.rejects(
    () => analyze.byName("complete_stage").execute("x", { note: "n" }),
    /阶段门禁/, "分析阶段的出口是 submit_analysis,不是 complete_stage");
  const conclude = directTools(directState(dataDir, "no_ticket", "conclude"), dataDir);
  await assert.rejects(
    () => conclude.byName("complete_stage").execute("x", { note: "n" }),
    /阶段门禁/, "无单结论节点的出口是 submit_analysis(带结论)");
  const sealed = directTools(directState(dataDir, "ticket", "mr_green"), dataDir);
  await assert.rejects(
    () => sealed.byName("build_deploy").execute("x", { include_lib: false }),
    /阶段门禁/, "换库验证封存后 build_deploy 恒被阶段门禁拒绝");
});

test("出口回归(免模型):report_ut 降级为事实上报——只记账不推进", async () => {
  const dataDir = mfcTemp("mfc-issue-exit-ut-");
  const state = directState(dataDir, "ticket", "fix");
  const { byName, textOf } = directTools(state, dataDir);
  const receipt = textOf(await byName("report_ut").execute("x", {
    passed: true, summary: "12/12 通过",
  }));
  assert.equal(state.stage, "fix", "report_ut 不推进阶段,UT 属修复段");
  assert.equal(state.ut?.passed, true, "结果照常记账(现场记录可查)");
  assert.match(receipt, /只记录结果、不推进阶段/);
  assert.match(receipt, /complete_stage/);
  const failReceipt = textOf(await byName("report_ut").execute("x", {
    passed: false, summary: "2 个用例失败",
  }));
  assert.equal(state.stage, "fix", "未通过同样原地不动");
  assert.match(failReceipt, /已记录/);
});

// ---- MR 验绿门三态(service 驱动,假交付平台) ----

test("环境验证卡·自定义答复是等待中的插话:递 AI 一回合,闸保持原样继续等", async () => {
  const chain = await startChain({
    platformStatus: "success",
    steps: (origin) => [[origin]],
  });
  try {
    const raised = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "举环境验证闸");
    const version = raised.gate!.state_version;
    // 自定义答复(带文本、不带码,与页面上「自定义答复」提交同形):
    // 不是「发现问题」的回退——现场照旧、轮次不动,话递给 AI。
    chain.service.answer(chain.id, {
      state_version: version,
      decision: "MR 冒出合并冲突,先处理冲突",
    });
    const answered = chain.service.get(chain.id);
    assert.equal(answered.stage, "mr_green", "插话不回退阶段");
    assert.equal(answered.round ?? 1, 1, "插话不涨轮次");
    assert.equal(answered.status, "running", "插话开了一回合");
    // 回合收口时闸在场仍定格等待:同一张卡、原 state_version 还能作答。
    const settled = await until(() => {
      const issue = chain.service.get(chain.id);
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "插话回合收口,闸定格等待");
    assert.equal(settled.gate!.state_version, version, "同一张卡继续等");
    assert.match(chain.trail(), /用户插话\(验证等待中\)/, "插话进转移账");
    assert.ok(chain.events().find((event) =>
      event.kind === "human_decision"
      && /合并冲突/.test(String(event.payload?.decision ?? ""))),
      "插话进 human_decision 事件账");
    // 卡还能照常答「发现问题」:回退重修语义不受插话影响。
    chain.service.answer(chain.id, {
      state_version: settled.gate!.state_version,
      code: "fail", decision: "验证发现问题:数据没变化",
    });
    const rolled = await until(() => {
      const snapshot = chain.service.get(chain.id);
      return snapshot.stage === "analyze" && snapshot.round === 2
        ? snapshot : undefined;
    }, "插话后再答发现问题,照常回退");
    assert.ok(rolled);
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·全绿当场收口:申报即核验,全绿即流程终点待归档", async () => {
  const chain = await startChain({
    platformStatus: "success",
    steps: (origin) => [[origin]],
  });
  try {
    const done = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "mr_green" && issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "全绿当场收口,举环境验证闸");
    assert.equal(done.mrs?.length, 1, "MR 台账在场");
    assert.equal(done.ut, undefined, "没有 UT 记录也能建 MR(UT 已降级)");
    assert.match(done.stage_note ?? "", /环境验证/);
    // 当场收口没有停等:受理账不在场。
    assert.equal(chain.saved().mr_gate, undefined);
    // 回执与台账:验绿通过 + 收口话术进现场。
    assert.match(chain.okReceipts(), /MR 核验通过/);
    assert.match(chain.okReceipts(), /阶段已收口/);
    // 收口回执自带举卡指引(原 issueGreenCutover「当场收口」用例的
    // 独有断言,该用例与本条重复已于 2026-09-18 删除)。
    assert.match(chain.okReceipts(), /环境验证卡交给用户/);
    assert.match(chain.trail(), /MR 核验通过/, "核验裁决要进台账");
    // 收口要点名用户:小鲁班通知"全部跑绿,待归档"(ADR-0013)。
    // (等待闸卡也发通知,按内容取收口那条。)
    const notice = await until(() =>
      chain.notifier.list().find((record) => /归档/.test(record.summary ?? "")),
      "收口通知");
    assert.match(notice.summary ?? "", /MR 流水线均已通过/);
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·有红当场打回:fail 带失败项详情与处置指引", async () => {
  const chain = await startChain({
    platformStatus: "failed",
    steps: (origin) => [[origin]],
  });
  try {
    // 与台账一致的清单申报,但平台流水线是红的:当场打回带失败项。
    const errors = await until(() => {
      const list = chain.errorReceipts();
      return list.length >= 1 ? list : undefined;
    }, "申报被打回");
    assert.match(errors[0], /MR 核验不通过/);
    assert.match(errors[0], /BUILD FAILURE/, "失败项详情要带回现场");
    assert.match(errors[0], /push_branch/);
    assert.match(errors[0], /重新申报/);
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    const issue = chain.service.get(chain.id);
    assert.equal(issue.stage, "mr_green", "有红打回,阶段不动");
    assert.equal(issue.stage_states?.[4], "in_progress");
    assert.equal(chain.saved().mr_gate, undefined, "打回不记申报账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·在跑受理:记申报账停等,监看器绿后自动放行", async () => {
  const chain = await startChain({
    platformStatus: "running",
    steps: (origin) => [[origin]],
  });
  try {
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    // 受理:阶段不动、申报账在场(仓地址申报,验绿门归一接受)、
    // 回执与台账都留痕。
    const saved = chain.saved();
    assert.equal(saved.stage, "mr_green", "在跑受理,阶段不动");
    assert.deepEqual(saved.mr_gate?.mrs, [chain.origin], "受理要记申报账");
    assert.match(chain.okReceipts(), /已受理/);
    assert.match(chain.trail(), /MR 清单已申报/, "申报要进台账");
    // 平台转绿:监看器等绿后凭申报账收口(不变量:收口当且仅当
    // 已申报且全绿)。
    chain.platform.defaultStatus = "success";
    const done = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "mr_green" && issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done" ? issue : undefined;
    }, "监看器等绿后收口,举环境验证闸");
    assert.equal(chain.saved().mr_gate, undefined, "收口即清申报账");
    const notice = await until(() =>
      chain.notifier.list().find((record) => /归档/.test(record.summary ?? "")),
      "滞后收口通知");
    assert.match(notice.summary ?? "", /MR 流水线均已通过/);
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·只认最新 run:历史绿/红后最新 running 均不得提前裁决", async () => {
  for (const historicalStatus of ["success", "failed"] as const) {
    const chain = await startChain({
      platformStatus: "running",
      historicalStatus,
      steps: (origin) => [[origin]],
    });
    try {
      await until(() =>
        chain.service.get(chain.id).status === "idle" ? 1 : undefined,
      `历史 ${historicalStatus} + 最新 running 的申报回合收口`);
      const saved = chain.saved();
      assert.equal(saved.stage, "mr_green",
        `历史 ${historicalStatus} 不能越过最新 running 推进或打回`);
      assert.deepEqual(saved.mr_gate?.mrs, [chain.origin],
        "最新 run 仍在跑时应按受理停等处理");
      assert.equal(chain.errorReceipts().length, 0,
        "历史红灯不能让最新重跑被误判失败");

      // 再等一次监看轮询，监看器也必须保持相同的“最新 run”口径。
      await until(() => chain.platform.seen.filter((item) =>
        item.method === "GET" && item.url.startsWith("/pipeline/status"))
        .length >= 2 ? 1 : undefined, "监看器再次读取流水线");
      assert.equal(chain.service.get(chain.id).stage, "mr_green");
      assert.equal(chain.saved().pipelines?.[chain.origin]?.status, "running");
    } finally {
      await stopChain(chain);
    }
  }
});

test("MR 验绿门·过期结果防御:窗口期旧 SHA 红灯不冤枉重推的申报,受理停等到真绿", async () => {
  const chain = await startChain({
    platformStatus: "failed",
    // 真实事故形态(#108):AI 修复重推新提交(换 SHA)后立即 complete_stage
    // 重新申报,而平台按 MR 维度返回流水线历史——新 run 注册前的窗口期
    // 内,对新 SHA 的状态查询拿到的还是旧 SHA 的红灯 run。staleRedHits=1
    // 演的正是这个窗口:第一次"非首查 SHA"的查询返回旧 SHA 红灯
    // (run 级 sha 标旧值),其后即视为新 run 已注册。
    staleRedHits: 1,
    steps: (origin) => [
      // 首报:查询 SHA 与 run 归属一致的真红灯,照旧当场打回——修复轮
      // 由此而来,也守住了"真红灯当场打回"的原行为。
      [origin],
      // 修复轮:新提交(换 SHA)→重推→重建 MR(监看器随新提交重挂表)
      // →立即重申报,正落在窗口期里。
      { tool: { name: "bash", input: { command:
        `cd repo/origin && git -c user.name=test -c user.email=t@e`
          + ` commit -q --allow-empty -m '[${TICKET}][fix] 修复陈灯误伤'` } } },
      { tool: { name: "push_branch", input: {} } },
      { tool: { name: "create_mr", input: {} } },
      // 窗口期重申报:必须按在跑受理停等,不许拿旧红打回清申报账。
      [origin],
    ],
  });
  try {
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    // 打回只许发生一次(首报的真红):窗口期重申报被旧红冤枉打回正是
    // 要防的回归——修复后这里若多出第二条错误回执即说明防御失效。
    const errors = chain.errorReceipts();
    assert.equal(errors.length, 1, "只有首报的真红被打回,重申报不得被打回");
    assert.match(errors[0], /BUILD FAILURE/);
    // 受理停等:申报账在场、回执「已受理」、台账点名过期结果已拒。
    const saved = chain.saved();
    assert.equal(saved.stage, "mr_green", "受理停等,阶段不动");
    assert.deepEqual(saved.mr_gate?.mrs, [chain.origin], "窗口期重申报记了申报账");
    assert.match(chain.okReceipts(), /已受理/);
    assert.match(chain.trail(), /过期结果已拒/, "过期结果已拒要进台账留痕");
    // 平台放开返回真绿(新 run 注册并跑绿):监看器收口,全链走完。
    chain.platform.defaultStatus = "success";
    const done = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "mr_green" && issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done" ? issue : undefined;
    }, "监看器等真绿后收口,举环境验证闸");
    assert.equal(chain.saved().mr_gate, undefined, "收口即清申报账");
    assert.equal(chain.saved().pipelines?.[chain.origin]?.status, "success");
    const notice = await until(() =>
      chain.notifier.list().find((record) => /归档/.test(record.summary ?? "")),
      "滞后收口通知");
    assert.match(notice.summary ?? "", /MR 流水线均已通过/);
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·清单=台账:少报/多报都打回且点名差异", async () => {
  const chain = await startChain({
    platformStatus: "running",
    steps: (origin) => [
      [],                                        // 少报:台账 1 个,清单空。
      ["https://code.test/ghost.git"],           // 多报:编造不存在的 MR。
      [origin],                                  // 正确申报:在跑受理。
    ],
  });
  try {
    const errors = await until(() => {
      const list = chain.errorReceipts();
      return list.length >= 2 ? list : undefined;
    }, "少报与多报两次打回");
    assert.ok(errors[0].includes("少报"), "第一错=少报");
    assert.ok(errors[0].includes(chain.origin), "少报点名台账里的 MR");
    assert.ok(errors[1].includes("多报"), "第二错=多报");
    assert.ok(errors[1].includes("ghost"), "多报点名不存在的 MR");
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    const saved = chain.saved();
    assert.equal(saved.stage, "mr_green", "错报都不得收口");
    assert.deepEqual(saved.mr_gate?.mrs, [chain.origin],
      "第三次(正确)申报在跑受理,记申报账");
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·空=空合法通过:无码修改路径零 MR 进换库验证", async () => {
  const dataDir = mfcTemp("mfc-issue-exit-empty-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 跳过拉仓:研究结论不涉及代码改动(complete_stage 两跳)。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单为配置问题,无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n配置项漂移(非代码问题)。\\n## 置信度\\n高。\\n## 修改方案\\n恢复配置。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "配置项漂移" } } },
    { text: "分析已提交。" },
    // 确认后:修改 → UT → 提交MR 段零 MR,空清单=空台账直接放行。
    { tool: { name: "complete_stage", input: { note: "无需改码" } } },
    { tool: { name: "complete_stage", input: { note: "无需 UT" } } },
    { tool: { name: "complete_stage", input: { note: "无 MR 交付", mrs: [] } } },
    { text: "收口完成。" },
    // 绿灯切换(#246):收口回执指路举卡,若本回合没举,欠卡催办续跑
    // 会消费这一组把验证卡补上。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待验证。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 刻意不配 platformUrl:空=空路径不需要交付平台。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  });
  try {
    const created = service.create({
      account: "dev", title: "配置漂移", ticket: TICKET, source: "dts",
      repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "分析确认闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "confirm",
    });
    const done = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "mr_green" && issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "空=空收口,举环境验证闸");
    assert.equal(done.mrs, undefined, "零 MR 交付");
    assert.equal(done.stage, "mr_green", "收口在终点阶段");
    const saved = loadState(join(dataDir, "issues", created.id))!;
    const trail = (saved.transitions ?? []).map((entry) => entry.note).join("\n");
    assert.match(trail, /空清单=空台账/);
    const receipts = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8")
      .split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "tool_finished"
        && event.payload?.name === "complete_stage" && !event.payload.is_error)
      .map((event) => String(event.payload.result)).join("\n");
    assert.match(receipts, /没有改动、无需 MR/);
    assert.match(receipts, /阶段已收口/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("MR 验绿门·未申报不放行:监看器全绿只提醒申报,阶段原地", async () => {
  const chain = await startChain({ platformStatus: "success" });
  try {
    // 建完 MR 不申报:监看器看到全绿,但只开"请申报"回合,不推进。
    // (匹配串取平台回合独有开头——complete_stage 的工具描述每条请求
    // 都在,不能当匹配键。)
    await until(() =>
      chain.model.requests.some((request) =>
        JSON.stringify(request).includes("请调 complete_stage(带 mrs 参数"))
        ? 1 : undefined, "申报提醒回合抵达模型");
    const issue = chain.service.get(chain.id);
    assert.equal(issue.stage, "mr_green", "未申报不推进");
    assert.equal(issue.pipelines?.[chain.origin]?.status, "success",
      "流水线确实全绿");
    assert.equal(issue.stage_states?.[4], "in_progress");
    assert.equal(chain.saved().mr_gate, undefined);
  } finally {
    await stopChain(chain);
  }
});

test("MR 验绿门·状态查询带 mr:验绿门与监看器两路都不让模板空转", async () => {
  const chain = await startChain({
    platformStatus: "running",
    steps: (origin) => [[origin]],
  });
  try {
    await until(() =>
      chain.service.get(chain.id).status === "idle" ? 1 : undefined, "回合收口");
    chain.platform.defaultStatus = "success";
    await until(() =>
      chain.service.get(chain.id).stage_states?.[4] === "done" ? 1 : undefined,
      "监看器等绿后收口");
    // 真实环境事故:适配层状态命令模板引用 {mr},缺参渲染失败 502——
    // 验绿门当场查与监看器轮询两路都必须带上台账里的 iid。
    const statusUrls = chain.platform.seen
      .filter((entry) => entry.url.startsWith("/pipeline/status"))
      .map((entry) => entry.url);
    assert.ok(statusUrls.length >= 2, "验绿门 + 监看器都应查询过状态");
    for (const url of statusUrls) {
      assert.match(url, /[?&]mr=1(&|$)/, `状态查询缺 mr 参数: ${url}`);
    }
  } finally {
    await stopChain(chain);
  }
});

test("push_branch 阶段性交付:脏工作区拒推(ADR-0071),提交后放行推新 SHA", async () => {
  const dataDir = mfcTemp("mfc-issue-exit-dirty-");
  const origin = bareOrigin(dataDir);
  const repoDir = join(dataDir, "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, repoDir], { env: GIT_ENV });
  // 会话修复分支(ADR-0063):基线_工号_单号_时间戳;夹具用定死的假
  // 时间戳代表"会话已定名"。
  const branch = `master_dev_${TICKET}_20261015090000`;
  execFileSync("git", ["-C", repoDir, "checkout", "-q", "-b", branch],
    { env: GIT_ENV });
  const state = directState(dataDir, "ticket", "mr_green");
  state.baseline = "master";
  state.fix_branch = branch;
  state.repo_urls = [origin];
  state.repo_url = origin;
  const { byName, textOf } = directTools(state, dataDir);
  // ADR-0071 脏工作区熔断:已跟踪文件有未提交改动即拒推——带脏推只会
  // 推出旧 HEAD,基线合并也要求干净的树;未跟踪过程产物不拦。
  writeFileSync(join(repoDir, "fix.txt"), "tracked", "utf-8");
  execFileSync("git", ["-C", repoDir, "add", "fix.txt"], { env: GIT_ENV });
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-m", "seed tracked"],
    { env: GIT_ENV });
  writeFileSync(join(repoDir, "fix.txt"), "changed", "utf-8");
  await assert.rejects(byName("push_branch").execute("x", {}), /未提交改动/,
    "已跟踪文件的脏改动必须拒推而不是带脏推旧 HEAD");
  assert.equal((state.pushes ?? []).length, 0);
  // 提交放行;未跟踪过程产物在场也不拦:真推到裸仓远端,推送账落位。
  execFileSync("git", ["-C", repoDir, "commit", "-q", "-am", "[T] fix"],
    { env: GIT_ENV });
  writeFileSync(join(repoDir, "untracked.log"), "process artifact", "utf-8");
  const receipt = textOf(await byName("push_branch").execute("x", {}));
  assert.match(receipt, /已推送/);
  assert.equal(state.pushes?.length, 1);
});

test("验证发现问题:整体回退问题分析,申报账清空可重走;通知不重复轰炸", async () => {
  const chain = await startChain({
    platformStatus: "success",
    steps: (origin) => [[origin]],
  });
  try {
    // 第一轮:全绿即时收口(申报即验绿),举环境验证闸等用户。
    const verifyGate = await until(() => {
      const issue = chain.service.get(chain.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "第一轮收口,举环境验证闸");
    const closed = chain.service.get(chain.id);
    assert.equal(closed.stage, "mr_green", "收口在终点阶段");
    await until(() =>
      chain.notifier.list().find((record) => /归档|验证/.test(record.summary ?? "")),
      "第一轮收口通知");
    // 验证发现问题:整体回退问题分析重新处理——ADR-0043 后绿后返工
    // 的唯一入口(通过无需作答、合入即通过;「验证通过后再续聊说没
    // 修好」的重开路已随 pass 选项退役)。
    const rolled = chain.service.answer(chain.id, {
      state_version: verifyGate.gate!.state_version, code: "fail",
      notes: "还是超时,继续修",
    });
    assert.equal(rolled.stage, "analyze", "发现问题回退问题分析");
    assert.equal(rolled.round, 2, "回退轮次+1,不是轮次不动的重开");
    assert.equal(rolled.stage_states?.[4], "redo", "mr_green 标重做");
    assert.match(chain.trail(), /验证发现问题/, "回退要进转移账");

    // 第二轮走到 mr_green 时重新申报:回退已清掉验绿门申报账,不残留。
    assert.equal(chain.service.get(chain.id).mr_gate, undefined);
  } finally {
    await stopChain(chain);
  }
});
