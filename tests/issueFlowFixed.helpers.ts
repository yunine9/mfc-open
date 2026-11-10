/**
 * issue 流固定流程(四阶段)的长轴集成:拆分后的共享夹具与辅助函数
 * (原 tests/issueFlowFixed.test.ts 逐字搬移;2026-09-11 拆成 part1/2
 * 做负载均衡——node:test 按文件并行、文件内串行,单文件 129s 曾是
 * 全量墙钟地板之一)。不带 .test.ts 后缀,测试运行器不会执行本文件;
 * 各 part 按需 import,断言与测试行为零变化。
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import { MockDtsGateway, type DtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { JEST_LOG, issue28Artifacts } from "./pipelineSamples.ts";
import {
  FIXED_TICKET_STAGES,
  loadState,
  shouldNudgeFixed,
  type IssuePipelineWatch,
  type IssueSessionState,
} from "../src/issueFlow/state.ts";
import {
  fixedNudgeNotice,
  issueFixedOpeningPrompt,
  issueRegistrationMeta,
  issueResumePrompt,
} from "../src/issueFlow/prompt.ts";
import {
  getPipelineStatus,
  triggerPipeline,
} from "../src/pipelineClient.ts";
import { mfcTemp } from "./mfcTmp.ts";


export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(推送目标),返回其路径。 */

export function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  // 登记必选产品版本(2026-09-18)后 pull_repo 按会话基线克隆(#441):
  // 裸仓得真有这个分支,镜像生产「版本映射的分支在远端在架」。
  execFileSync("git", ["-C", seed, "branch", "br_V100R026C10_release"],
    { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

/** 无单登记门禁(#17)要求模块+环境,各用例只关心流程本身——模块与
 * 网管环境四件套从这两个夹具取,别在每个测试里各写一遍。 */

export const MODULE_ID = "pay-core";


export function seedModule(dataDir: string, repoUrl: string): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [repoUrl],
  }, "tester");
}


export const NO_TICKET_ENV = {
  hosts: ["192.0.2.8"],
  backendPassword: "env-shared-secret",
};


export async function until<T>(
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

export const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 120,
  }),
};


export const fakeOps = {
  async buildDeploy() {
    return { summary: "[INFO] 部署完成(测试假件)\n备份已写入 /backup" };
  },
};


export const TICKET = "DTS-2026-1001";

export const BRANCH = `master_dev_${TICKET}`;

/** 可剧本化的交付假件:/mr 建 MR;/pipeline/trigger 永远 running;
 * /pipeline/status 每 SHA 前两次查询 running,之后按轮次出终态
 * (firstTerminal 之后恒 success)——默认演出"红一轮修好再绿",
 * 恢复类测试可直接给 success。 */

export class LoopPlatform {
  readonly seen: Array<{ method: string; url: string; body?: any }> = [];
  private terminalRound = 0;
  private readonly statusCalls = new Map<string, number>();
  private readonly mergeRequests = new Map<string, { url: string; id: number }>();
  private mrCount = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";
  /** 首个终态为 failed 时的剧本覆盖(红灯分诊/证据分级测试用):
   *  给出 failed run 的 log 与 checks。缺省 undefined 维持原演出
   *  (log=BUILD FAILURE,无 checks——盲修复路径的回归锚)。 */
  firstFailure: { log?: string; checks?: unknown } | undefined;
  /** /pipeline/artifacts 的剧本覆盖(证据评估测试用):红灯修复链会
   *  把它镜像进会话工作区 pipeline/。缺省演一份编译失败的 build.log。 */
  firstFailureArtifacts: Array<{ name: string; text: string }> | undefined;
  /** 过期结果影子(#107 回归):置为旧提交 SHA 时,状态查询一律回一条绑
   *  旧提交的终态红 run(复现"重推换 SHA 后、新 run 注册前"的窗口
   *  期);置回 undefined 放开,恢复常规演出(新提交的真绿)。 */
  staleOldSha: string | undefined;

  constructor(
    private readonly firstTerminal: "failed" | "success" = "failed",
    /** firstTerminal 之后的终态:缺省 success(红一轮修好再绿);
     *  "failed" = 红到底(修复轮预算耗尽类测试用)。 */
    private readonly subsequentTerminal: "failed" | "success" = "success") {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const body = chunks.length
          ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
        this.seen.push({ method: request.method ?? "", url: request.url ?? "", body });
        const send = (payload: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method === "POST" && request.url === "/mr") {
          const key = JSON.stringify({
            repo: body?.repo,
            source_branch: body?.source_branch,
            target_branch: body?.target_branch,
          });
          let receipt = this.mergeRequests.get(key);
          if (!receipt) {
            this.mrCount += 1;
            receipt = { url: `http://loop.test/mr/${this.mrCount}`, id: this.mrCount };
            this.mergeRequests.set(key, receipt);
          }
          send(receipt);
          return;
        }
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET" && request.url?.startsWith("/pipeline/artifacts")) {
          // 失败产物假件:红灯修复链会把它镜像进会话工作区 pipeline/。
          send({ files: this.firstFailureArtifacts ?? [{
            name: "build.log",
            text: "BUILD FAILURE: 模块 notify-service 编译失败(全文堆栈省略)",
          }] });
          return;
        }
        if (request.method === "GET" && request.url?.startsWith("/pipeline/status")) {
          const sha = new URL(request.url, "http://loop").searchParams.get("sha") ?? "";
          // 过期结果影子先于常规计数:窗口期的查询不烧"前两轮 running"
          // 的预算,放开后新 run 照常先跑两轮再出终态。
          if (this.staleOldSha) {
            send({ runs: [{ status: "failed", sha: this.staleOldSha,
              log: "BUILD FAILURE: 旧提交的陈灯" }] });
            return;
          }
          const calls = (this.statusCalls.get(sha) ?? 0) + 1;
          this.statusCalls.set(sha, calls);
          if (calls <= 2) {
            send({ runs: [{ status: "running" }] });
            return;
          }
          this.terminalRound += 1;
          const status = this.terminalRound === 1
            ? this.firstTerminal : this.subsequentTerminal;
          send({
            runs: [{ status: "running" }, {
              status,
              ...(status === "failed"
                ? (this.firstFailure ?? {
                    log: "BUILD FAILURE: 模块 notify-service 编译失败",
                  })
                : { checks: [
                    { dimension: "COMPILE", status: "success" },
                    { dimension: "UT", status: "success" },
                    { dimension: "CODECHECK", status: "success" },
                  ] }),
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


export function fixedState(overrides: Partial<IssueSessionState> = {}): IssueSessionState {
  const now = new Date().toISOString();
  return {
    id: "issue-nudge", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", scenario: "ticket", round: 1,
    stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
    ...overrides,
  };
}


export function metaState(overrides: Partial<IssueSessionState> = {}): IssueSessionState {
  return fixedState({
    title: "播放器偶发黑屏",
    description: "升级后偶发,重启恢复",
    module_id: MODULE_ID,
    module: "支付核心",
    repo_url: "/tmp/x.git",
    repo_urls: ["/tmp/x.git", "/tmp/y.git"],
    environment: {
      credential_ref: "cred-1",
      name: "192.0.2.8",
      hosts: ["192.0.2.8", "192.0.2.9"],
      port: 22,
      env_type: "virtualized",
    },
    ...overrides,
  });
}


export const META_CREDENTIALS = { backend: "env-shared-secret" };


export function seedMrGreenWatch(
  dataDir: string,
  repo: string,
  watch: Partial<IssuePipelineWatch> = {},
): void {
  const sha = "c".repeat(40);
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "红灯分诊夹具", description: "", source: "dts",
    ticket: "DTS-2026-1002",
    repo_url: repo, repo_urls: [repo],
    baseline: "br_V100R026C10_release",
    scenario: "ticket", round: 1,
    stage_states: [
      "done", "done", "done", "done", "done", "in_progress", "pending",
    ],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo, branch: "master_dev_DTS-2026-1002", sha, at: now }],
    mrs: [{ repo, branch: "master_dev_DTS-2026-1002",
      title: "[DTS-2026-1002] 红灯分诊夹具",
      url: "http://loop.test/mr/1", at: now }],
    pipelines: {
      [repo]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
        ...watch,
      },
    },
  }));
}

/** 停机通知幂等测试用:把已停表的监看账重挂(watching=true),再构造
 *  服务即走恢复路径重看同一提交——模拟"恢复重放再停机"的场景。
 *  patch 可选追加字段改写(如把 deadline 拨回过去、保留延期计数)。 */

export function rearmMrGreenWatch(
  dataDir: string,
  repo: string,
  patch: Partial<IssuePipelineWatch> = {},
): void {
  const path = join(dataDir, "issues", "issue-1", "issue.json");
  const state = JSON.parse(readFileSync(path, "utf-8")) as {
    pipelines: Record<string, IssuePipelineWatch>;
  };
  state.pipelines[repo].watching = true;
  Object.assign(state.pipelines[repo], patch);
  writeFileSync(path, JSON.stringify(state));
}


export async function assertRepairDispatched(input: {
  what: string;
  firstFailure: { log?: string; checks?: unknown };
  /** undefined=默认演 build.log 产物在场;[]=平台零产物。 */
  artifacts?: Array<{ name: string; text: string }>;
  expect?: RegExp[];
}): Promise<void> {
  const dataDir = mfcTemp("mfc-issue-dispatch-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = input.firstFailure;
  if (input.artifacts) platform.firstFailureArtifacts = input.artifacts;
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按证据修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    `${input.what}:红灯修复回合派出`);
    for (const pattern of input.expect ?? []) {
      assert.match(requestText, pattern);
    }
    assert.equal(service.get("issue-1").gate, undefined,
      `${input.what}:不得举卡`);
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, `${input.what}:修复回合收口`);
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      `${input.what}:派出即记一轮预算`);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
}


export const TRUNCATED_TOOL_BASH = "echo 'Tool call was not executed: "
  + "the response hit the output token limit' >&2; "
  + "echo 'Tool call was not executed: "
  + "the response hit the output token limit'; exit 1";


export function seedGreenWatch(dataDir: string, origin: string, sha: string): void {
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: "DTS-2026-1002",
    repo_url: origin, repo_urls: [origin], scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch: "master_dev_DTS-2026-1002", sha, at: now }],
    mrs: [{ repo: origin, branch: "master_dev_DTS-2026-1002",
      title: "[DTS-2026-1002] t", at: now }],
    mr_gate: { mrs: [origin], at: now },
    pipelines: {
      [origin]: {
        sha, status: "running", watching: true, started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(), round: 1,
      },
    },
  }));
}

/** 绿表头:与恢复监看测试同款取法。 */

export function headSha(origin: string): string {
  return spawnSync("git", ["--git-dir", origin, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).stdout.trim();
}

