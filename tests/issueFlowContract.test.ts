/**
 * 前后端契约快照(票 #10):服务端真实投影与 web/src/api.ts 的手工
 * 镜像类型逐字段对账。实锤债务:repo_urls 与 pipeline checks 曾在
 * 服务端长期返回而前端类型缺失,后端改字段前端零报错。
 *
 * 机制(维护成本最低的双层钉法):
 * - 期望侧 = 按 web/src/api.ts 前端类型手写的样例字面量。字面量带
 *   类型注解:前端类型加/删/改字段而样例没跟上,tsc(typecheck 与
 *   `web && npx tsc -b` 都会带上这份镜像)直接红;
 * - 实际侧 = 真起最小 IssueFlowService 会话、走 handleIssueRoutes 拿
 *   到的过线 JSON(与浏览器看到的字节同源)。assertWireShape 递归
 *   对比:对象键集合必须一致(服务端加/删/改名字段→npm test 红);
 *   原始值 typeof 必须一致(改型→红);数组用样例首元素做逐元素模板。
 * - 值本身不比对:值是运行时数据;枚举值域由类型层与语义测试守,
 *   决策卡文案可自由改字(按码裁决,文案不是协议)。
 * - 样例里显式 `undefined` 的键 = 可选字段:实际侧可缺席,不设限;
 *   键集合仍受约束(实际侧多出的键一律红)。
 * - Record 形状(如 pipelines)用单键 "*":样例值即每个条目的模板。
 *
 * 覆盖:IssueSummary(闸卡/逐仓账/流水线账/环境)、IssueDetail、
 * IssueGateCard(conclude 与 pipeline_unfixable 等)、IssueWaitingCard
 * (Agent 卡+机械派码)、pipeline_unfixable 闸卡(票 03:带 pipeline
 * 定位字段的新形状)、DtsTicketBrief/DtsTicketDetail 与列表包装。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway, type DtsGateway } from "../src/issueFlow/gateways.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import {
  readDtsAutoClaimExclusions,
  setDtsAutoClaimExclusion,
} from "../src/dtsAutoClaimExclusions.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveProductVersion } from "../src/configurationCenter.ts";
import type {
  DtsTicketBrief,
  DtsTicketDetail,
  IssueDetail,
  IssueGateCard,
  IssueReview,
  IssueReviewCheck,
  IssueSummary,
  IssueWaitingCard,
} from "../web/src/api.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";

// ---- 契约对比器 ----

/** 递归形状断言:sample 是"前端类型的手写样例",actual 是服务端过线
 * 投影。服务端字段增/删/改名/改型都在这里红;前端类型漂移在 tsc 红。 */
function assertWireShape(sample: unknown, actual: unknown, path: string): void {
  if (sample === undefined) return; // 可选字段:缺席合法,不设限
  if (Array.isArray(sample)) {
    assert.ok(Array.isArray(actual), `${path}: 服务端投影应是数组`);
    if (sample.length === 0) return; // 空模板不校验元素形状
    for (const [index, element] of (actual as unknown[]).entries()) {
      assertWireShape(sample[0], element, `${path}[${index}]`);
    }
    return;
  }
  if (typeof sample === "object" && sample !== null) {
    assert.ok(typeof actual === "object" && actual !== null
      && !Array.isArray(actual), `${path}: 服务端投影应是对象`);
    const sampleKeys = Object.keys(sample as object).sort();
    const actualKeys = Object.keys(actual as object).sort();
    // Record 模板(单键 "*"):每个实际条目都按模板比形状。
    if (sampleKeys.length === 1 && sampleKeys[0] === "*") {
      for (const key of actualKeys) {
        assertWireShape((sample as Record<string, unknown>)["*"],
          (actual as Record<string, unknown>)[key], `${path}.${key}`);
      }
      return;
    }
    for (const key of actualKeys) {
      assert.ok(sampleKeys.includes(key),
        `${path}.${key}: 服务端投影多出的字段——web/src/api.ts 镜像缺它`
        + "(repo_urls/checks 缺席的旧剧本重演)。先补镜像与样例再转绿");
    }
    for (const key of sampleKeys) {
      const expected = (sample as Record<string, unknown>)[key];
      if (expected === undefined) continue; // 可选:实际可缺席
      assert.ok(key in (actual as object),
        `${path}.${key}: 服务端投影缺字段(前端类型声明了它)`);
      assertWireShape(expected, (actual as Record<string, unknown>)[key],
        `${path}.${key}`);
    }
    return;
  }
  assert.strictEqual(typeof actual, typeof sample,
    `${path}: 字段类型漂移(样例 ${typeof sample},服务端 ${typeof actual})`);
}

/** 走一遍真路由拿到过线 JSON——契约的"实际侧"永远取这条路径,
 * 不直调服务方法(直调绕过了 JSON 序列化边界,不算过线形状)。 */
function issueGet(
  parts: string[],
  service?: IssueFlowService,
  extraRouteOptions?: Record<string, unknown>,
  url?: string,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url } as any,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload?: string) => {
          try {
            resolve({ status, body: JSON.parse(payload ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false, ...extraRouteOptions },
    ).catch(reject);
  });
}

// ---- 会话fixture基建(与 issueFlowService/Fixed 测试同款假件) ----

/** POST 版(带 JSON 体):与浏览器同一 readBody 协议过线,登记 wire 的
 * 契约测试用——直调 service.create 绕过了 JSON 序列化边界。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service?: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

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
  dump?: () => string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nextDump = Date.now() + 10_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (dump && Date.now() >= nextDump) {
      nextDump = Date.now() + 10_000;
      console.error(`[diag ${what}] ${dump()}`);
    }
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const fastPoll = {
  models: () => ({}),
  runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120 }),
};

const fakeOps = {
  async buildDeploy() {
    return { summary: "[INFO] 部署完成(测试假件)\n备份已写入 /backup" };
  },
};

const TICKET = "DTS-2026-1001";

/** 交付假件:首轮流水线即绿(带 checks 终态)——契约 fixture 只需要
 * "走到账齐"的最短路径,不演红转绿。 */
class GreenPlatform {
  private mrCount = 0;
  private statusCalls = new Map<string, number>();
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
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
        if (request.method === "GET" && request.url?.startsWith("/pipeline/status")) {
          const sha = new URL(request.url, "http://loop").searchParams.get("sha") ?? "";
          const calls = (this.statusCalls.get(sha) ?? 0) + 1;
          this.statusCalls.set(sha, calls);
          if (calls <= 2) {
            send({ runs: [{ status: "running" }] });
            return;
          }
          send({
            runs: [{ status: "running" }, {
              status: "success",
              checks: [
                { dimension: "COMPILE", status: "success" },
                { dimension: "UT", status: "success" },
                { dimension: "CODECHECK", status: "success" },
              ],
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

// ---- 期望侧样例:每个字段都对照 web/src/api.ts 手写(漂移 tsc 红) ----

test("契约快照:固定流程全链的 IssueSummary/IssueDetail(终点=MR 跑绿收口)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract-");
  const origin = bareOrigin(dataDir);
  const platform = new GreenPlatform();
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "超时回收已实现,UT 12/12 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等流水线跑绿后平台收口。" },
    // 全绿发送回合(#246 绿灯切换):监看器收口只发送全绿事实开回合
    // ——AI 经 raise_gate 举验证卡,平台不再代举。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户在环境验证。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    opsTools: fakeOps,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      description: "压测环境登录超时,疑似连接池耗尽",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      baseline: "br_V100R026C10_release",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    // 中途闸照实走:报告确认后平台才继续修(UT 在修复段)→推→MR→申报→
    // 全绿收口(ADR-0013:流程终点=MR 跑绿,归档等用户)。
    const analysisGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "首轮分析确认闸");
    // 推荐协议(ADR-0004):分析确认闸的推荐在码表里定死为放行码。
    assert.equal(analysisGate.gate!.question.questions[0].recommended,
      "confirm", "分析确认卡必须携带码表定死的推荐码");
    service.answer(created.id, {
      state_version: analysisGate.gate!.state_version,
      code: "confirm",
    });
    const verifyGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage === "mr_green"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "全链跑到 MR 跑绿收口,举环境验证闸");
    // 快照取"环境验证卡在场"的收口等待态(waiting_user+闸):ADR-0043
    // 后通过无需作答(合入即通过、自动归档),不再有「答 pass 落 idle
    // 待合入」的中间态,收口后的唯一等待现场就是这张卡。

    // 期望侧:按 web/src/api.ts 的 IssueSummary 手写,undefined 键 = 可选;
    // 环境对象也直接写成镜像类型的字面量——页面凭据两键让 tsc 的多属性
    // 检查与 assertWireShape 的逐键对账都全量生效。
    const summarySample: IssueSummary = {
      id: created.id,
      account: "dev",
      // 网关通道标记(ADR-0039):platform=平台网关,主会话启动即报到;
      // 老会话/未启动缺席。
      model_lane: "platform",
      // 登记人(ADR-0031):自登记=归属,始终过线。
      reporter: "dev",
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
      title: "登录超时",
      description: "压测环境登录超时,疑似连接池耗尽",
      // 附加信息(DTS 列表随单填写):本会话没带,可选不设限。
      remark: undefined,
      source: "dts",
      ticket: TICKET,
      repo_url: origin,
      repo_urls: [origin],
      // 参考仓台账与知识仓装载账(#425,ADR-0054):本会话都没装,
      // 显式 undefined = 可选键,镜像已补(web/src/api.ts)。
      public_repos: undefined,
      knowledge_repo: undefined,
      assigned_repos: undefined,
      module: undefined,
      module_id: undefined,
      baseline: "br_V100R026C10_release",
      environment: {
        credential_ref: "vault-ref",
        name: "192.0.2.8",
        hosts: ["192.0.2.8"],
        port: 22,
      },
      scenario: "ticket",
      stage_states: ["done", "done", "done", "done", "done"],
      round: 1,
      review_active: undefined,
      // 圈选闸未举未答(skill 圈选缺席);业务知识在进 analyze 时定格,
      // 本会话没绑模块 → 空台账(字段在场=已定格,entries 空=无资产)。
      skill_selection: undefined,
      business_knowledge: { at: "2026-08-28T00:00:00Z", entries: [] },
      // 收口等待态闸在场:环境验证卡(env_verify)——ADR-0043 起只有
      // 「验证发现问题」一个选项(通过无需作答,合入即通过)。
      gate: {
        id: "gate-x",
        kind: "env_verify",
        state_version: 1,
        question: { questions: [{
          question: "MR 流水线均已通过。请到目标环境验证修复效果:…",
          options: [
            { code: "fail", label: "验证发现问题(填写补充说明)" },
          ],
          recommended: undefined,
        }] },
        context: undefined,
        scope: undefined,
        skills: undefined,
        pipeline: undefined,
        proposal: undefined,
        created_at: "2026-08-28T00:00:00Z",
      },
      ut: {
        passed: true, summary: "12/12 通过",
        log_path: undefined, round: 1, at: "2026-08-28T00:00:00Z",
      },
      pipelines: {
        "*": {
          sha: "a".repeat(40),
          status: "success",
          watching: false,
          started_at: "2026-08-28T00:00:00Z",
          deadline: "2026-08-28T00:10:00Z",
          deadline_extensions: undefined,
          checks: [{ dimension: "UT", status: "success", job: undefined, url: undefined }],
          last_error: undefined,
          round: 1,
          reds: 1,
        },
      },
      feedback: undefined,
      converted_from: undefined,
      converted_to: undefined,
      inherited_accounts: undefined,
      status: "waiting_user",
      stage: "mr_green",
      stage_note: "MR 已全绿——待环境验证:通过可归档,发现问题回退重新分析",
      stage_at: "2026-08-28T00:00:00Z",
      has_environment: true,
      nudges: undefined,
      conclusion: undefined,
      pushes: [{ repo: origin, branch: `master_dev_${TICKET}`, sha: "a".repeat(40), at: "2026-08-28T00:00:00Z" }],
      mrs: [{
        repo: origin, branch: `master_dev_${TICKET}`, title: `[${TICKET}] 修复登录超时`,
        url: "http://loop.test/mr/1", iid: "1", at: "2026-08-28T00:00:00Z",
        // 合入事实(ADR-0022)可选字段:显式报到,实际可缺席。
        target: undefined, merged_at: undefined,
        merged_sha: undefined, closed_at: undefined,
      }],
      transitions: [{
        at: "2026-08-28T00:00:00Z", source: "platform",
        // stage 可选(fixedComplete 带、其余转移不带),模板按缺席对账。
        stage: undefined, note: "MR 验绿通过(1 个 MR 全绿):MR 已申报",
      }],
      error: undefined,
      last_reply: undefined,
      // 终止原因(#541):非取消会话不出场,可选键钉镜像字段在位。
      cancel_reason: undefined,
      cancel_reason_text: undefined,
    };

    const list = await issueGet(["issues"], service);
    assert.equal(list.status, 200);
    assert.ok(list.body.issues.length >= 1);
    assertWireShape(summarySample, list.body.issues[0], "GET /issues [].issues[0]");

    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);
    // 闸在场、Agent 等待卡不在场:waiting 是 Agent 问题卡的投影,
    // 平台闸走 .gate(has_analysis:报告已出)。
    const detailSample: IssueDetail = { ...summarySample, waiting: undefined, has_analysis: true };
    assertWireShape(detailSample, detail.body, "GET /issues/:id");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("返工轮全绿再通知:验证卡走等待卡通道,同卡只发一次,二轮新卡是新事件", async () => {
  // #246/ADR-0024 绿灯切换:旧「待环境验证(第 N 轮)」outcome 通道已删
  // ——每轮全绿收口后平台只发送事实,AI 经 raise_gate 举验证卡,用户
  // 通知改由等待卡通道(notifyWaitingCard)承担:同卡按 waiting_id
  // 幂等只发一次,二轮的新卡是新事件,不撞一轮的已发送记录。
  const dataDir = mfcTemp("mfc-issue-green-renotify-");
  const origin = bareOrigin(dataDir);
  const platform = new GreenPlatform();
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  // 通知器实例提出来:waiting_id 幂等账(notifier.list)要对它核对。
  const greenNotifier = new Notifier({
    endpoint: luban.endpoint, backoffMs: [0],
  });
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const report = (summary: string) =>
    `printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n${summary}.\\n## 置信度\\n高。\\n## 修改方案\\n演示修复。\\n' > issue-analysis.md`;
  const raiseVerifyCard: Scene[] = [
    // 全绿发送回合(#246):监看器收口发送事实,AI 经 raise_gate 举卡。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户验证。" },
  ];
  const script: Scene[] = [
    // 一轮:拉单→拉仓→分析→确认→修复→推→MR→申报(全绿由平台假件按终态处理)。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: report("连接池耗尽") } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "UT 12/12 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "一轮 MR 已申报,等跑绿收口。" },
    ...raiseVerifyCard,
    // 二轮:验证发现问题回退→重写报告→确认→修复→推→MR→再申报。
    { tool: { name: "bash", input: { command: report("连接池回收缺竞态保护") } } },
    { tool: { name: "submit_analysis", input: { summary: "二轮:回收竞态保护" } } },
    { text: "二轮分析已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 回收竞态保护`) } } },
    { tool: { name: "complete_stage", input: { note: "二轮修复完成" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "二轮 MR 已申报", mrs: [origin] } } },
    { text: "二轮 MR 已申报,等跑绿再收口。" },
    ...raiseVerifyCard,
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    opsTools: fakeOps,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier: greenNotifier,
  });
  try {
    const created = service.create({
      account: "dev",
      title: "登录超时",
      description: "压测环境登录超时,疑似连接池耗尽",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    const analysisGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "一轮分析确认闸");
    service.answer(created.id, {
      state_version: analysisGate.gate!.state_version, code: "confirm",
    });
    const firstGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "一轮全绿举环境验证闸");
    // 用户通知走等待卡通道(#246:旧 outcome 通道已删):AI 举卡即通知,
    // 卡面问题随通知到达,人不用开网页就知道要去环境验证。通知是异步
    // 旁路,断言前等它落袋。
    const verifyCards = () => luban.messages.filter((message) =>
      JSON.stringify(message).includes("请到目标环境验证修复效果"));
    await until(() => verifyCards().length >= 1 ? true : undefined,
      "一轮验证卡通知落袋");
    assert.equal(verifyCards().length, 1, "一轮恰一条验证卡通知");
    // 验证发现问题 → 回退分析(轮次+1)。
    service.answer(created.id, {
      state_version: firstGate.gate!.state_version, code: "fail",
      notes: "订单导出仍然超时",
    });
    const secondAnalysis = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "二轮分析确认闸");
    service.answer(created.id, {
      state_version: secondAnalysis.gate!.state_version, code: "confirm",
    });
    const secondGate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_verify"
        ? issue : undefined;
    }, "二轮全绿再举环境验证闸");
    // 回归点:二轮的新卡是新事件——再发一条等待卡通知;同卡只发一次
    // 的幂等不变(notifier 按 waiting_id 记账,每张验证卡恰一条记录,
    // 二轮的 waiting_id 随新卡新生,不撞一轮的已发送记录)。
    await until(() => verifyCards().length >= 2 ? true : undefined,
      "二轮验证卡通知落袋");
    assert.equal(verifyCards().length, 2, "二轮新卡必须再发一条等待卡通知");
    const verifyRecords = greenNotifier.list().filter((record) =>
      JSON.stringify(record).includes("请到目标环境验证修复效果"));
    assert.equal(verifyRecords.length, 2, "每张验证卡恰一条通知记录(同卡只发一次)");
    assert.notEqual(verifyRecords[0]!.waiting_id, verifyRecords[1]!.waiting_id,
      "二轮新卡是新事件(waiting_id 随卡新生)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("契约快照:无单结论闸带机器可读提案(conclude 卡的 proposal)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract2-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(索引缺失导致全表扫描)。\\n## 置信度\\n高:执行计划直接指向。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论已提交,等待用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸");
    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);

    const gateSample: IssueGateCard = {
      id: "gate-x",
      kind: "conclude",
      state_version: 1,
      question: { questions: [{
        question: "分析结论:是问题——是问题:索引缺失",
        options: [
          { code: "issue", label: "确认是问题,闭环归档出提单模板" },
          { code: "non_issue", label: "确认非问题,闭环归档" },
          { code: "supplement", label: "有补充意见(填写补充说明)" },
        ],
        // 结论闸的推荐从 AI 提案派生(提案是问题→推荐「是问题」码)。
        recommended: "issue",
      }] },
      context: undefined,
      scope: undefined,
      skills: undefined,
      pipeline: undefined,
      proposal: {
        conclusion: "issue",
        summary: "是问题:索引缺失",
        report: join(dataDir, "issues", created.id, "issue-analysis.md"),
      },
      created_at: "2026-08-28T00:00:00Z",
    };
    assertWireShape(gateSample, detail.body.gate, "conclude 闸 .gate");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("契约快照:流水线不可修闸卡(pipeline_unfixable,带 pipeline 定位字段)", async () => {
  /** 红灯假件:状态查询首轮即终态 failed(带不可修工具的 checks 明细),
   *  产物端点回空清单——红灯按终态处理只投事实,举卡由 AI 在发送回合里经
   *  raise_gate 完成(#247),走最短路径触达这张卡的 wire 投影。 */
  class RedPlatform {
    private server: ReturnType<typeof createServer> | undefined;
    baseUrl = "";
    async start(): Promise<void> {
      this.server = createServer((request, response) => {
        const send = (payload: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        };
        if (request.method === "POST" && request.url === "/pipeline/trigger") {
          send({ status: "running" });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/artifacts")) {
          send({ files: [] });
          return;
        }
        if (request.method === "GET"
            && request.url?.startsWith("/pipeline/status")) {
          send({ runs: [{
            status: "failed",
            log: "CodeCheck 阶段失败",
            checks: [{
              dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
              details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
                message: "规则 R1 命中" }],
            }],
          }] });
          return;
        }
        response.writeHead(404);
        response.end("{}");
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
  const dataDir = mfcTemp("mfc-issue-contract-gate-");
  const origin = bareOrigin(dataDir);
  const platform = new RedPlatform();
  await platform.start();
  // 「MR 已申报、流水线监看中」的最小现场:构造服务即恢复,监看器重挂
  // 表直奔红灯事实发送回合(与 issueFlowFixed 的夹具同款)。
  const repo = origin;
  const sha = "c".repeat(40);
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "不可修闸卡契约夹具", description: "", source: "dts",
    ticket: "DTS-2026-1003",
    repo_url: repo, repo_urls: [repo],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "done", "pending"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo, branch: "master_dev_DTS-2026-1003", sha, at: now }],
    mrs: [{ repo, branch: "master_dev_DTS-2026-1003",
      title: "[DTS-2026-1003] 不可修闸卡契约夹具",
      url: "http://loop.test/mr/1", at: now,
      target: undefined, merged_at: undefined,
      merged_sha: undefined, closed_at: undefined }],
    pipelines: {
      [repo]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  // 剧本(#247):发送回合里 AI 判断红灯全部来自平台侧工具告警,经
  // raise_gate 举不可修卡——平台不再代举,红灯事实在案是唯一前置。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_unfixable", repo: origin,
      supplement: "红灯全部来自 SuperChecker 平台侧告警(规则 R1),"
        + "改代码解决不了" } } },
    { text: "已举卡等待人工处理。" },
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
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_unfixable"
        ? issue : undefined;
    }, "AI 举出不可修闸卡");
    const detail = await issueGet(["issues", "issue-1"], service);
    assert.equal(detail.status, 200);

    const gateSample: IssueGateCard = {
      id: gated.gate!.id,
      kind: "pipeline_unfixable",
      state_version: gated.gate!.state_version,
      question: { questions: [{
        // 卡面问题=注册表模板(#247):AI 只能带事实性补充(context),
        // 不能自创问题或选项。
        question: "流水线红灯需要人工在交付平台处理或豁免(改代码解决不了)"
          + "——请在交付平台处理/豁免后,在本卡作答「已在平台处理/豁免,"
          + "重新监看」,平台会重新监看同一提交。",
        options: [{ code: "resume", label: "已在平台处理/豁免,重新监看" }],
        // 人工事实卡不派推荐:宿主核验不了平台侧是否真的处理过。
        recommended: undefined,
      }] },
      context: "AI 的 supplement(事实说明:失败摘要/现场观察)",
      scope: undefined,
      skills: undefined,
      // 票 03 新形状:闸归属的仓与提交(作答续跑按它重置监看账)。
      pipeline: { repo: origin, sha },
      proposal: undefined,
      created_at: gated.gate!.created_at,
    };
    assertWireShape(gateSample, detail.body.gate, "pipeline_unfixable 闸 .gate");
    assert.equal(detail.body.gate.pipeline.repo, origin);
    assert.equal(detail.body.gate.pipeline.sha, sha);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("契约快照:取消带终止原因过线,镜像同字段(#541)", async () => {
  // 终止原因(#541)走 control cancel 的独立入参(reason/reason_text,
  // 不复用 revive 的 note):路由白名单 fail-loud,过线投影随终态带
  // 原因与说明,前端 IssueSummary 镜像必须有同名字段(样例带类型注解,
  // 镜像缺字段 tsc 红)。
  const dataDir = mfcTemp("mfc-issue-contract-cancel-reason-");
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = "2026-08-28T00:00:00Z";
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", reporter: "dev",
    created_at: now, updated_at: now,
    title: "取消原因契约夹具", description: "", source: "manual",
    scenario: "no_ticket", round: 1,
    stage_states: ["done", "done", "done"],
    status: "idle", stage: "analyze", stage_note: "", stage_at: now,
  }));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 非法原因 fail-loud:400 打回,不静默落成无原因取消。
    const bad = await issuePost(["issues", "issue-1", "control"],
      { action: "cancel", reason: "bogus" }, service);
    assert.equal(bad.status, 400);

    // 说明与原因的组合同样 fail-loud(#540 复审):说明只跟「其他原因」
    // 有意义,缺席原因或搭配其他原因递说明与词表外原因同款 400——
    // 不静默丢弃,组合错误与单词表错误一个待遇。
    const textAlone = await issuePost(["issues", "issue-1", "control"],
      { action: "cancel", reason_text: "等了二十分钟没有反应" }, service);
    assert.equal(textAlone.status, 400,
      "只递说明不选原因:400 打回");
    const textWithResolved = await issuePost(["issues", "issue-1", "control"],
      { action: "cancel", reason: "resolved", reason_text: "说明" }, service);
    assert.equal(textWithResolved.status, 400,
      "「问题已处理」搭配说明:同样 400,不静默丢说明");

    const canceled = await issuePost(["issues", "issue-1", "control"],
      { action: "cancel", reason: "other", reason_text: "等了二十分钟没有反应" },
      service);
    assert.equal(canceled.status, 200);
    assert.equal(canceled.body.status, "canceled");
    assert.equal(canceled.body.cancel_reason, "other", "原因随回执过线");
    assert.equal(canceled.body.cancel_reason_text, "等了二十分钟没有反应",
      "说明随回执过线");

    const detail = await issueGet(["issues", "issue-1"], service);
    assert.equal(detail.status, 200);
    // 期望侧按 web/src/api.ts 的 IssueDetail 手写(canceled 无单三节点
    // 的过线实况):undefined 键=可选可缺席;cancel_reason 在场必须过线。
    const summarySample: IssueSummary = {
      id: "issue-1",
      account: "dev",
      model_lane: undefined,
      reporter: "dev",
      created_at: now,
      updated_at: now,
      title: "取消原因契约夹具",
      description: "",
      remark: undefined,
      auto_claim: undefined,
      intervention_tier: undefined,
      source: "manual",
      ticket: undefined,
      repo_url: undefined,
      repo_urls: undefined,
      public_repos: undefined,
      knowledge_repo: undefined,
      assigned_repos: undefined,
      module: undefined,
      module_id: undefined,
      baseline: undefined,
      environment: undefined,
      scenario: "no_ticket",
      stage_states: ["done", "done", "done"],
      round: 1,
      review_active: undefined,
      skill_selection: undefined,
      gate: undefined,
      ut: undefined,
      pipelines: undefined,
      feedback: undefined,
      converted_from: undefined,
      converted_to: undefined,
      inherited_accounts: undefined,
      status: "canceled",
      stage: "analyze",
      stage_note: "",
      stage_at: now,
      has_environment: false,
      nudges: undefined,
      conclusion: undefined,
      pushes: undefined,
      mrs: undefined,
      transitions: undefined,
      error: undefined,
      last_reply: undefined,
      repo_reclaimed_at: undefined,
      build_products_reclaimed_at: undefined,
      cancel_reason: "other",
      cancel_reason_text: "等了二十分钟没有反应",
    };
    const detailSample: IssueDetail = {
      ...summarySample, waiting: undefined, has_analysis: false,
    };
    assertWireShape(detailSample, detail.body, "GET /issues/:id 取消终态");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约快照:完结原因终止联动单级排除,其余原因不写(ADR-0072)", async () => {
  // 终止联动:「问题已处理」(resolved)与「无需处理」(accidental,原文案
  // 「误发起」)终止的有单会话,服务端取消收口时把该单写进自动接单单级
  // 排除(ADR-0070 的 dts-auto-claim-exclusions.json,操作人=归属账号——
  // 路由只允许归属人取消);负面原因、无单会话不写。回执摘要带
  // auto_claim_excluded:true(稀疏字段,终止确认框据此抑制事前提示)。
  const dataDir = mfcTemp("mfc-issue-contract-cancel-linkage-");
  const now = "2026-11-03T00:00:00Z";
  const sessions: Array<{ id: string; ticket?: string }> = [
    { id: "issue-11", ticket: "DTS-7201" },
    { id: "issue-12", ticket: "DTS-7202" },
    { id: "issue-13", ticket: "DTS-7203" },
    { id: "issue-14" },
    { id: "issue-15", ticket: "DTS-7204" },
  ];
  for (const { id, ticket } of sessions) {
    const root = join(dataDir, "issues", id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "issue.json"), JSON.stringify({
      id, account: "dev", reporter: "dev",
      created_at: now, updated_at: now,
      title: `联动夹具 ${id}`, description: "", source: "manual",
      ...(ticket ? { ticket, scenario: "ticket" } : { scenario: "no_ticket" }),
      round: 1, stage_states: ["done", "done", "done"],
      status: "idle", stage: "analyze", stage_note: "", stage_at: now,
    }));
  }
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 完结类两项:排除表落条目,操作人=归属账号。
    for (const [id, reason] of [["issue-11", "resolved"],
      ["issue-12", "accidental"]] as const) {
      const res = await issuePost(["issues", id, "control"],
        { action: "cancel", reason }, service);
      assert.equal(res.status, 200, `${id} 完结原因终止应成功`);
      assert.equal(res.body.cancel_reason, reason);
      assert.equal(res.body.auto_claim_excluded, true,
        `${id} 回执摘要应带已排除旗标(终止确认框据此抑制提示)`);
    }
    // 负面原因与无单:不写排除。
    const slow = await issuePost(["issues", "issue-13", "control"],
      { action: "cancel", reason: "slow" }, service);
    assert.equal(slow.status, 200);
    const noTicket = await issuePost(["issues", "issue-14", "control"],
      { action: "cancel", reason: "resolved" }, service);
    assert.equal(noTicket.status, 200,
      "无单会话取消本身不受联动影响");

    // 幂等:已在排除表的单再以完结原因终止,不报错、条目仍在(覆盖写,
    // 操作人更新为本次取消的归属人)。
    setDtsAutoClaimExclusion(dataDir, "DTS-7204", true, "reviewer");
    const again = await issuePost(["issues", "issue-15", "control"],
      { action: "cancel", reason: "resolved" }, service);
    assert.equal(again.status, 200, "已排除的单终止不因联动报错");

    const exclusions = readDtsAutoClaimExclusions(dataDir);
    assert.deepEqual(
      Object.keys(exclusions).sort(), ["DTS-7201", "DTS-7202", "DTS-7204"],
      "只有完结原因的有单终止落排除,负面原因与无单不写");
    assert.equal(exclusions["DTS-7201"].updated_by, "dev",
      "操作人取归属账号(路由只允许归属人取消)");
    assert.equal(exclusions["DTS-7204"].updated_by, "dev",
      "幂等覆盖写把操作人更新为本次取消的归属人");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约快照:Agent 问题卡 waiting 投影(整卡形状+机械派码+推荐码)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract3-");
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现象是必现还是偶发?", options: ["必现", "偶发"],
      recommended: "偶发",
    }] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 契约快照的是"等人"的问题卡形状:钉三档对齐,卡不被档位代答。
    interventionTier: () => "3",
  });
  try {
    // 无单登记门禁(#17):要模块+环境;夹具仓不参与本测试的断言,
    // 绑个占位本地路径即可。
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "偶发黑屏",
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "Agent 问题卡", undefined, () => {
      const i = service.get(created.id);
      return JSON.stringify({ reqs: model.requests.length, served: model.served.join('+'), status: i.status, stage: i.stage,
        gate: i.gate?.kind, waiting: i.waiting ?? null,
        note: i.stage_note?.slice(0, 60), error: i.error });
    });
    const detail = await issueGet(["issues", created.id], service);
    assert.equal(detail.status, 200);

    const waitingSample: IssueWaitingCard = {
      waiting_id: `${created.id}:call-1`,
      state_version: 1,
      question: { questions: [{
        question: "现象是必现还是偶发?",
        options: [
          { code: "opt-0-0", label: "必现" },
          { code: "opt-0-1", label: "偶发" },
        ],
        // 推荐原文「偶发」投影成命中选项的码(Agent 卡推荐随卡下发)。
        recommended: "opt-0-1",
      }] },
      context: undefined,
      created_at: "2026-08-28T00:00:00Z",
      // gate_kind/gate_scope 是前端从 detail.gate 拼装的字段,服务端
      // waiting 投影永不携带——样例按过线实况不写这两个键。
      task_id: created.id,
      step: "AskUserQuestion",
      call_id: "call-1",
      status: "waiting",
      decision: "",
      answers: undefined,
      notes: "",
      resolved_at: "",
    };
    assertWireShape(waitingSample, detail.body.waiting, "Agent 卡 .waiting");

    // 固定流程(无单三节点)的 summary 形状,登记转移账带首阶段。
    const summarySample: IssueSummary = {
      id: created.id,
      account: "dev",
      // 网关通道标记(ADR-0039):platform=平台网关,主会话启动即报到;
      // 老会话/未启动缺席。
      model_lane: "platform",
      // 登记人(ADR-0031):自登记=归属,始终过线。
      reporter: "dev",
      created_at: "2026-08-28T00:00:00Z",
      updated_at: "2026-08-28T00:00:00Z",
      title: "偶发黑屏",
      description: "",
      // 附加信息(DTS 列表随单填写):发起时不带即缺席,可选不设限。
      remark: undefined,
      source: "manual",
      ticket: undefined,
      repo_url: undefined,
      repo_urls: undefined,
      module: undefined,
      module_id: undefined,
      baseline: undefined,
      environment: undefined,
      scenario: "no_ticket",
      stage_states: ["in_progress", "pending", "pending"],
      round: 1,
      review_active: undefined,
      gate: undefined,
      ut: undefined,
      pipelines: undefined,
      feedback: undefined,
      converted_from: undefined,
      converted_to: undefined,
      inherited_accounts: undefined,
      status: "waiting_user",
      stage: "prep_repo",
      stage_note: "已登记,固定流程启动",
      stage_at: "2026-08-28T00:00:00Z",
      has_environment: false,
      nudges: undefined,
      conclusion: undefined,
      pushes: undefined,
      mrs: undefined,
      transitions: [{
        at: "2026-08-28T00:00:00Z", source: "platform",
        stage: "prep_repo", note: "固定流程会话已登记(无单三节点)",
      }],
      error: undefined,
      last_reply: undefined,
      // 终止原因(#541):非取消会话不出场,可选键钉镜像字段在位。
      cancel_reason: undefined,
      cancel_reason_text: undefined,
    };
    const detailSample: IssueDetail = { ...summarySample, waiting: waitingSample, has_analysis: false };
    assertWireShape(detailSample, detail.body, "固定流程 GET /issues/:id");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("契约快照:DTS 列表与单据详情投影(全字段假网关)", async () => {
  /** MockDtsGateway 的罐头单缺大部分 optional 字段,钉不全契约形状;
   * 契约要的是"服务端会投影出的字段全集",假网关直接给满字段。 */
  class FullFieldDtsGateway implements DtsGateway {
    readonly mock = true;
    async listByOwner() {
      return [{
        ticket: "DTS-2026-2001",
        title: "订单列表导出超时",
        status: "开发人员实施修改",
        version: "R25C10",
        severity: "严重",
        submitter: "zhang3",
        url: "https://dts.test/t/2001",
        description: "数据量大时导出必现超时",
      }];
    }
    async detail() {
      return {
        ticket: "DTS-2026-2001",
        title: "订单列表导出超时",
        content: "【单据原文】mcpResultText 兜底展示",
        description: "<p>完整描述(detailDesc 全文)</p>",
        severity: "严重",
        version: "R25C10",
        url: "https://dts.test/t/2001",
        submitter: "zhang3",
      };
    }
    async proxyFile(): Promise<{ data: Buffer; contentType: string }> {
      throw new Error("契约测试用不到文件代理");
    }
  }
  const service = new IssueFlowService({
    dataDir: mfcTemp("mfc-issue-contract4-"),
    provider: "p", model: "m", modelsJson: {},
  });
  const briefSample: DtsTicketBrief = {
    ticket: "DTS-2026-2001",
    title: "订单列表导出超时",
    status: "开发人员实施修改",
    version: "R25C10",
    severity: "严重",
    submitter: "zhang3",
    url: "https://dts.test/t/2001",
    description: "数据量大时导出必现超时",
  };
  const detailSample: DtsTicketDetail = {
    ticket: "DTS-2026-2001",
    title: "订单列表导出超时",
    content: "【单据原文】mcpResultText 兜底展示",
    description: "<p>完整描述(detailDesc 全文)</p>",
    severity: "严重",
    version: "R25C10",
    url: "https://dts.test/t/2001",
    submitter: "zhang3",
  };
  try {
    const list = await issueGet(["issues", "dts"],
      service, { dts: new FullFieldDtsGateway() });
    assert.equal(list.status, 200);
    assertWireShape({ tickets: [briefSample], mock: true },
      list.body, "GET /issues/dts");

    const detail = await issueGet(["issues", "dts", "DTS-2026-2001"],
      service, { dts: new FullFieldDtsGateway() });
    assert.equal(detail.status, 200);
    assertWireShape(detailSample, detail.body, "GET /issues/dts/:ticket");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("DTS 列表 ?owner=:协助视角指名拉单,缺省/空参回落登录人", async () => {
  // 只看路由把哪个账号递给网关(协助处理 2026-09-17):?owner= 原样
  // 透传,读侧换视角不发所有权;403 仍只留给管理员。
  const seen: string[] = [];
  const capturing: DtsGateway = {
    listByOwner: async (account) => {
      seen.push(account);
      return [];
    },
    detail: async () => {
      throw new Error("本测试只看拉单路由");
    },
    proxyFile: async () => {
      throw new Error("本测试只看拉单路由");
    },
  };
  const service = new IssueFlowService({
    dataDir: mfcTemp("mfc-issue-dts-owner-"),
    provider: "p", model: "m", modelsJson: {},
  });
  const viewer = { username: "alice", role: "developer" };
  try {
    await issueGet(["issues", "dts"], service,
      { dts: capturing, viewer }, "/issues/dts");
    await issueGet(["issues", "dts"], service,
      { dts: capturing, viewer }, "/issues/dts?owner=bob");
    await issueGet(["issues", "dts"], service,
      { dts: capturing, viewer }, "/issues/dts?owner=");
    await issueGet(["issues", "dts"], service,
      { dts: capturing, viewer }, "/issues/dts?owner=%20%20");
    assert.deepEqual(seen, ["alice", "bob", "alice", "alice"],
      "?owner= 必须透传给网关,缺省与空白值回落登录人");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约快照:润色端点已退役,POST /issues/polish-description 按未知路由 404(#272,ADR-0030)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract-polish-gone-");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const gone = await issuePost(["issues", "polish-description"], {
      title: "t", description: "d",
    }, service);
    assert.equal(gone.status, 404,
      "退役路由不得复活成任何兜底应答——按未知路由 404 出码");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("契约快照:POST /issues 登记新 wire 形(环境过线、密码只进 vault;页面凭据字段不收)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract5-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  // 版本必填(2026-09-18)且须为配置中心在册版本,夹具给目录。
  saveProductVersion(dataDir, { version: "V100R027C10B005",
    branch: "release/V100R027C10B005" });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    // 门禁过线:无单缺模块 / 缺后台密码,409 带人话直出。
    // 版本必填(2026-09-18)在路由层先于服务端模块门,夹具带版本让
    // 断言仍落在各自要验的门上。
    const noModule = await issuePost(
      ["issues"], { account: "dev", title: "下单超时", assignee: "dev",
        product_version: "V100R027C10B005" }, service);
    assert.equal(noModule.status, 409);
    assert.match(noModule.body.error, /必须指定业务模块/);
    const noVersion = await issuePost(["issues"], {
      account: "dev", title: "下单超时", assignee: "dev", module_id: "pay-core",
    }, service);
    assert.equal(noVersion.status, 409);
    assert.match(noVersion.body.error, /必须选择产品版本/);
    const noBackend = await issuePost(["issues"], {
      account: "dev", title: "下单超时", assignee: "dev", module_id: "pay-core",
      product_version: "V100R027C10B005",
      environment: {
        hosts: ["192.0.2.8"],
        backend_password: "",
      },
    }, service);
    assert.equal(noBackend.status, 409);
    assert.match(noBackend.body.error, /网管后台密码/);

    // 全量过线:环境回执只有引用与非密元信息,密码本体永不过线;
    // 页面凭据已废弃(2026-09-10)——递了也不收,回执不出。
    const created = await issuePost(["issues"], {
      account: "dev", title: "下单超时", assignee: "dev", module_id: "pay-core",
      product_version: "V100R027C10B005",
      environment: {
        hosts: ["192.0.2.8"],
        page_account: "ops",
        page_password: "page-pw",
        backend_password: "backend-pw",
      },
    }, service);
    assert.equal(created.status, 201);
    assert.equal(created.body.module_id, "pay-core", "模块留痕上投影");
    assert.equal(created.body.module, "支付核心", "模块名由服务端派生");
    assert.equal(created.body.environment?.page_account, undefined,
      "页面账号不再入回执");
    assertWireShape({
      credential_ref: "vault-ref",
      name: "192.0.2.8",
      hosts: ["192.0.2.8"],
      port: 22,
    }, created.body.environment, "POST /issues .environment");
    const receipt = JSON.stringify(created.body);
    assert.ok(!receipt.includes("page-pw"), "页面密码本体不过线");
    assert.ok(!receipt.includes("backend-pw"), "后台密码本体不过线");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 检视意见 wire(#261):GET /issues/:id/reviews 投出的 Annotation
// ---- 与 web/src/api.ts 的 IssueReview 逐键对账;意见号(seq)过线。

test("契约快照:检视意见投影(意见号 seq 过线;reviews+checks 全形状)", async () => {
  const dataDir = mfcTemp("mfc-issue-contract6-");
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: ["/tmp/fixture.git"],
  }, "tester");
  saveProductVersion(dataDir, { version: "V100R027C10B005",
    branch: "release/V100R027C10B005" });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const created = await issuePost(["issues"], {
      account: "dev", title: "下单超时", assignee: "dev", module_id: "pay-core",
      product_version: "V100R027C10B005",
      environment: { hosts: ["192.0.2.8"], backend_password: "backend-pw" },
    }, service);
    assert.equal(created.status, 201);
    const id = created.body.id as string;

    const added = await issuePost(["issues", id, "reviews"], {
      line: 3, anchor: "根因:重试无上限", note: "加重试上限",
      quote: "根因:重试无上限。", line_end: 4,
    }, service);
    assert.equal(added.status, 200);
    assert.equal(added.body.seq, 1, "意见号在落账口分配并过线(#261)");

    // 期望侧按 web/src/api.ts 的 IssueReview 手写;undefined 键 = 可选。
    const sample: IssueReview = {
      quote: "根因:重试无上限。",
      line_end: 4,
      id: "an-x",
      seq: 1,
      author: "dev",
      created_at: "2026-09-13T00:00:00.000Z",
      artifact: "issue-analysis.md",
      file: "issue-analysis.md",
      line: 3,
      anchor: "根因:重试无上限",
      context_before: undefined,
      context_after: undefined,
      note: "加重试上限",
      kind: "doc",
      status: "draft",
      sent_at: undefined,
      sent_via: undefined,
      edited_at: undefined,
    };
    // 报告还没生成:锚点检测按 fail-open 全 hit(位置未验证)。
    const checkSample: IssueReviewCheck = {
      location_verified: false,
      id: "an-x",
      state: "hit",
      line: 3,
      now: undefined,
    };
    const list = await issueGet(["issues", id, "reviews"], service);
    assert.equal(list.status, 200);
    assert.equal(list.body.review_active, false);
    assertWireShape({ reviews: [sample], checks: [checkSample], review_active: false },
      list.body, "GET /issues/:id/reviews");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
