/**
 * 问题流 v2 的契约测试:会话多轮闭环、非问题归档、单号门禁与宿主
 * 推送、重启续聊、MCP 网关客户端。真假件语义都在这里钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  execFileSync,
  spawnSync,
} from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import { EnvironmentRegistry } from "../src/environmentRegistry.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import {
  buildIssueTimeline,
} from "../src/issueFlow/sessionView.ts";
import {
  handleIssueRoutes,
} from "../src/issueFlow/routes.ts";
import { cloneFailureMessage, GIT_AUTH_ERROR_TAG, prepareSandbox } from "../src/issueFlow/issueGit.ts";
import { loadState, type IssueSessionState } from "../src/issueFlow/state.ts";
import type { DtsGateway } from "../src/issueFlow/gateways.ts";
import { buildWorksiteRecord } from "../src/issueFlow/worksiteExport.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

test("克隆认证失败说人话:引导去个人设置配令牌,其余保留 git 原文", () => {
  // 内网实测原文:沙箱拒绝 askpass → git 要不到用户名
  const realStderr = [
    "error: unable to read askpass response from",
    " '/home/y/code/mae-flow-cloud/.tasks/.runtime/issue-git/operation-x/reject-askpass.sh'",
    "fatal: could not read Username for 'https://codehub.example.com':",
    " terminal prompts disabled",
  ].join("\n");
  const missing = cloneFailureMessage(undefined, realStderr);
  assert.ok(missing.startsWith(GIT_AUTH_ERROR_TAG),
    "认证类失败必须以机器标记打头——这是前端跳转锚(协议),人话改字不动它");
  assert.match(missing, /Git 令牌/, "必须给出去哪配的引导");
  assert.match(missing, /个人设置/);
  assert.match(missing, /重新发起/, "failed 是终态,引导只能是重新发起");
  assert.match(missing, /could not read Username/, "关键事实不吞");
  assert.ok(!missing.includes("askpass"), "沙箱内部路径不该再吓人");

  // 已配凭据但被平台拒绝 → 引导核对,并报出实际认证账号
  const rejected = cloneFailureMessage(
    { username: "y00965296", password: "wrong" },
    "fatal: Authentication failed for 'https://codehub.example.com/a.git/'",
  );
  assert.ok(rejected.startsWith(GIT_AUTH_ERROR_TAG), "拒绝类同样带机器标记");
  assert.match(rejected, /拒绝/);
  assert.match(rejected, /y00965296/);
  assert.match(rejected, /Git 令牌/);

  // 非认证错误:保留 git 原文,不乱引导(也不带跳转锚)
  const other = cloneFailureMessage(undefined,
    "fatal: repository 'https://git/x.git/' not found");
  assert.match(other, /not found/);
  assert.ok(!other.includes("Git 令牌"));
  assert.ok(!other.includes(GIT_AUTH_ERROR_TAG));
});

test("git 沙箱按仓放行 safe.directory:混属主工作区(宿主 root/容器 1001)不再撞 dubious ownership", () => {
  const repoDir = "/tmp/mfc-issue-sandbox-shape/repo";
  const sandbox = prepareSandbox("/tmp/mfc-issue-sandbox-shape/data",
    undefined, repoDir);
  // 放行的是 resolve 后的精确路径,逐仓白名单——绝不能出现 *。
  assert.ok(sandbox.args.includes(`safe.directory=${resolve(repoDir)}`),
    "args 必须带精确路径的 safe.directory(放行口径与 safeGit/containerRuntime 一致)");
  assert.equal(sandbox.args.some((arg) => arg === "safe.directory=*"), false,
    "不能用 *(containerRuntime 复盘注释钉死的决定)");
  // 不传仓目录(不碰仓库的 git 动作)就不放行:白名单只给需要的。
  const bare = prepareSandbox("/tmp/mfc-issue-sandbox-shape/data", undefined);
  assert.equal(
    bare.args.some((arg) => arg.startsWith("safe.directory=")), false,
    "没传 repoDir 就不该有 safe.directory");
});

/** 走一遍真路由(/issues/*),拿到 {status, body}——视图旁路的端到端
 * 断言都用它,免得测试里养一个 HTTP 服务器。 */
function issueGet(
  parts: string[],
  service?: IssueFlowService,
  query = "",
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url: `/${parts.join("/")}${query}` } as any,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (payload?: string) => {
          try {
            resolve({
              status,
              body: JSON.parse(payload ?? "{}"),
            });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
  });
}

/** POST 版(带 JSON 体):readBody 在 request 上挂 data/end 监听,
 * 所以假请求得是个 EventEmitter。 */
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

test("问题时间线归纳(纯函数):AI 陈述→人开口配成等待段,连续 AI 消息并作一段", () => {
  const timeline = buildIssueTimeline({
    state: {
      created_at: "2026-08-26T08:00:00Z",
      updated_at: "2026-08-26T09:00:00Z",
      status: "idle",
      stage_note: "",
      transitions: [
        { at: "2026-08-26T08:10:00Z", source: "agent",
          stage: "analyze", note: "初步定位" },
        { at: "2026-08-26T08:40:00Z", source: "platform",
          stage: "mr_green", note: "推送成功" },
      ],
    },
    messages: [
      { role: "user", text: "播放器偶发黑屏", ts: "2026-08-26T08:00:00Z" },
      { role: "assistant", text: "先查日志与代码", ts: "2026-08-26T08:05:00Z" },
      { role: "assistant", text: "需要确认:现象必现还是偶发?",
        ts: "2026-08-26T08:06:00Z" },
      { role: "decision", text: "用户决定: 必现", ts: "2026-08-26T08:16:00Z" },
      { role: "assistant", text: "结论为非问题", ts: "2026-08-26T08:30:00Z" },
    ],
  });
  // 尾部 assistant 后没有回应,状态也不是 waiting_user:不算等待段。
  assert.equal(timeline.human_waits.length, 1);
  const wait = timeline.human_waits[0];
  assert.equal(wait.start, "2026-08-26T08:05:00Z",
    "等待起点取连续 AI 陈述的首条");
  assert.equal(wait.end, "2026-08-26T08:16:00Z");
  assert.equal(wait.ms, 11 * 60_000);
  assert.match(wait.question, /偶发\?$/,
    "问句节选取末条 AI 消息(人作答前看到的最后一句话)");
  assert.equal(wait.open_ended, undefined);

  assert.equal(timeline.decisions, 1, "decision 角色消息计一次决策");
  assert.equal(timeline.human_wait_ms, 11 * 60_000);
  assert.equal(timeline.longest_waits.length, 1);
  // 区间 = 开场 08:00 → 最近活动(updated_at 09:00);占比四舍五入
  assert.equal(timeline.span.ms, 60 * 60_000);
  assert.equal(timeline.human_wait_share, 18);

  // 关键事件 = 结论节选 + 决策 + 阶段切换(带来源标记),按时间正序
  assert.deepEqual(timeline.events.map((event) => event.kind),
    ["assistant", "assistant", "stage", "decision", "assistant", "stage"]);
  const stageAgent = timeline.events.find((event) =>
    event.kind === "stage")!;
  assert.equal(stageAgent.source, "agent");
  assert.equal(stageAgent.detail, "初步定位");
  const stagePlatform = timeline.events.at(-1)!;
  assert.equal(stagePlatform.source, "platform");
});

test("问题时间线归纳(纯函数):waiting_user 未决段以 now 封口;坏数据一律空表不炸", () => {
  const timeline = buildIssueTimeline({
    state: {
      status: "waiting_user",
      created_at: "2026-08-26T08:00:00Z",
      updated_at: "2026-08-26T08:20:00Z",
      stage_note: "等你确认换库方案",
    },
    messages: [{ role: "assistant", text: "是否同意切换数据库?",
      ts: "2026-08-26T08:15:00Z" }],
    waiting: { created_at: "2026-08-26T08:14:00Z" },
    now: "2026-08-26T08:24:00Z",
  });
  assert.equal(timeline.human_waits.length, 1);
  const wait = timeline.human_waits[0];
  assert.equal(wait.open_ended, true, "问题卡还开着就是此刻仍在等");
  assert.equal(wait.start, "2026-08-26T08:14:00Z",
    "卡片 created_at 是权威起点,不退回 AI 消息时间");
  assert.equal(wait.end, undefined);
  assert.equal(wait.ms, 10 * 60_000);
  assert.equal(timeline.human_wait_ms, 10 * 60_000);
  // 未决等待以 now 封口 → 区间同样延伸到 now(08:00→08:24)
  assert.equal(timeline.span.ms, 24 * 60_000);
  assert.ok(timeline.span.end.startsWith("2026-08-26T08:24"),
    "区间终点字符串与毫秒数同一口径(延伸到 now)");
  assert.equal(timeline.human_wait_share, 42);
  assert.match(timeline.blocker, /切换数据库/, "卡点=还在等的问句");
  assert.deepEqual(timeline.longest_waits, [wait]);
  // 无 stage 的转移账条目不上关键事件墙
  assert.deepEqual(timeline.events.map((event) => event.kind),
    ["assistant"]);

  // 极端输入:空对象 → 空形状,绝不抛错(fail-open 红线)
  assert.deepEqual(buildIssueTimeline({}), {
    span: { start: "", end: "", ms: 0 },
    human_waits: [],
    human_wait_ms: 0,
    human_wait_share: 0,
    longest_waits: [],
    decisions: 0,
    blocker: "",
    events: [],
  });

  // 坏时间戳:配不成对的等待放弃、坏时刻的事件缺席,区间归零
  const odd = buildIssueTimeline({
    state: { created_at: "不是时间", updated_at: "", status: "idle" },
    messages: [
      { role: "assistant", text: "", ts: "昨天" },
      { role: "user", text: "哦", ts: "明天吧" },
    ],
  });
  assert.equal(odd.human_waits.length, 0);
  assert.equal(odd.events.length, 0);
  assert.equal(odd.span.ms, 0);
});

test("视图旁路路由:过程文档缺失是 200 {unavailable};事件账本残行不拖垮视图", () => {
  const dataDir = mfcTemp("mfc-issue-view-");
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-26T08:00:00Z",
    updated_at: "2026-08-26T09:00:00Z",
    title: "t", description: "", source: "manual",
    status: "idle", stage: "analyze", stage_note: "",
    stage_at: "2026-08-26T09:00:00Z",
    // 没有 stage 的转移条目不上关键事件墙
    transitions: [{ at: "2026-08-26T08:30:00Z", source: "agent",
      note: "只是备注,不是阶段切换" }],
  }));
  // 半行 JSON(写入方还在写)必须被跳过,不能让视图接口 5xx(时间线
  // 等投影同账本,顺带守这条)。
  writeFileSync(join(dataDir, "issues", "issue-1", "events.jsonl"),
    '{"kind":"user_mess\n'
    + JSON.stringify({ kind: "user_message", ts: "2026-08-26T08:00:00Z",
      payload: { text: "开场" } }) + "\n");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return (async () => {
    try {
      const docs = await issueGet(["issues", "issue-1", "documents"], service);
      assert.equal(docs.status, 200, "清单 fail-open:没有 .md 给空清单,不报错");
      assert.deepEqual(docs.body.documents, []);

      const missing = await issueGet(
        ["issues", "issue-1", "documents", "read"], service,
        "?name=issue-analysis.md");
      assert.equal(missing.status, 200,
        "问题号存在但文档缺失=200 {unavailable},不是 404");
      assert.equal(missing.body.unavailable, "文档不存在");

      // (#260 起 /issues/:id/dialogue 已随「过程问答」页签退役,路由删除。)

      const timeline = await issueGet(
        ["issues", "issue-1", "timeline"], service);
      assert.equal(timeline.status, 200);
      assert.deepEqual(timeline.body.human_waits, []);
      assert.equal(timeline.body.decisions, 0);
      assert.deepEqual(timeline.body.events, [],
        "无 stage 的转移与残行都不上关键事件");
      assert.ok(timeline.body.span.start.includes("2026-08-26"));
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  })();
});
import { TaskService } from "../src/taskService.ts";
import { createGoOpsTools, type ContainerExec } from "../src/issueFlow/opsTools.ts";
import {
  McpGateway,
  UnconfiguredDtsGateway,
} from "../src/issueFlow/gateways.ts";
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
  // 会话基线分支要在远端在架:pull_repo 按基线克隆(#441,同 helpers)。
  execFileSync("git", ["-C", seed, "branch", "br_V100R026C10_release"],
    { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
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

test("问题会话多轮闭环:研究→提问卡→作答→非问题归档(无内核参与)", async () => {
  const dataDir = mfcTemp("mfc-issue-flow2-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "bash", input: { command:
      "printf '# 根因分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n非问题(测试环境时钟漂移导致的误报)。\\n## 置信度\\n高:偏差可复现。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "分析结论是非问题(误报),确认归档收口?",
      options: ["确认归档", "继续研究"],
      recommended: "确认归档",
    }] } } },
    { text: "研究完成:结论为非问题,证据已写入 issue-analysis.md,建议归档。" },
    { tool: { name: "submit_analysis", input: { conclusion: "non_issue",
      summary: "非问题:测试环境时钟漂移导致的误报。" } } },
    { text: "结论已提交:非问题,等待用户确认收口。" },
  ];
  // linear:剧本逐请求推进——text 场景后还有 submit_analysis 收口场景,
  // 非 linear 会停在最后一个场景反复早收嘴,收口场景永远得不到消费。
  const model = new ScriptedModelServer(script, "scripted-v1",
    { linear: true });
  await model.start();
  // 固定流程种子(无单三节点,分析阶段收口待命):恢复管线启动,
  // 测的是提问卡→作答→归档这条多轮闭环,不依赖创建回执。
  seedRecoverableIssue(dataDir, "issue-1", {
    title: "播放器偶发黑屏",
    description: "测试环境偶发黑屏,疑似新版本引入",
    repo_url: origin, repo_urls: [origin],
    status: "running",
  });
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 测的是提问卡→人工作答→归档闭环:钉三档对齐,卡等人不代答。
    interventionTier: () => "3",
  });
  // 种子会话没有创建回执:沿用 created.id 形状串起后续断言。
  const created = { id: "issue-1" };
  try {
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "根因确认问题卡", undefined, () => {
      const i = service.get(created.id);
      return JSON.stringify({ reqs: model.requests.length, served: model.served.join('+'), status: i.status, stage: i.stage,
        gate: i.gate?.kind, waiting: i.waiting ?? null,
        note: i.stage_note?.slice(0, 60), error: i.error });
    });
    assert.equal(waiting.stage, "analyze");
    assert.ok(waiting.waiting, "问题卡应来自 AskUserQuestion");
    assert.ok(waiting.has_analysis, "分析报告应已产出");

    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "确认归档",
    });
    const idle = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "作答后回合收口");
    assert.equal(idle.stage, "analyze", "作答回合收口,阶段不越权跳变");
    const thread = service.messages(created.id);
    // 种子现场的开场是重启平台通知(不是登记开场词),开场词入账断言
    // 在下方「创建恒为固定流程」的 create 路径钉住。
    assert.ok(thread.some((message) => message.role === "decision"),
    "用户决定应入账");

    // 续聊通道:idle 后用户还能继续说话。续聊轮消费 submit_analysis
    // 场景:结论 non_issue 举起 conclude 卡(ADR-0034,无单收口走
    // 结论卡,结论前手动归档已退役)。
    const resumed = service.reply(created.id, "补充:同类现象上周也出现过,那就收口吧");
    assert.equal(resumed.status, "running");
    const concludeCard = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      // 举卡在回合内落账,等状态落到 waiting_user 再作答。
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认卡", 10_000);

    // 视图旁路(真路由形状):多轮闭环完成后,「耗时与卡点」与过程文档
    // 都应能直接出结论——等待段配对、决策计数、issue-analysis.md 全文。
    const timelineResponse = await issueGet(
      ["issues", created.id, "timeline"], service);
    assert.equal(timelineResponse.status, 200);
    assert.ok(timelineResponse.body.human_waits.length >= 1,
      `研究→提问→作答的多轮应配出至少一段人等待(实际 ${
        JSON.stringify(timelineResponse.body.human_waits)})`);
    assert.ok(timelineResponse.body.decisions >= 1, "用户决定要计入决策次数");
    assert.ok((timelineResponse.body.events ?? []).some(
      (event: Record<string, unknown>) => event.kind === "decision"),
    "关键事件里要有用户决策条目");
    assert.ok(typeof timelineResponse.body.span?.ms === "number"
      && timelineResponse.body.span.ms >= 0,
    "耗时区间必须是有限的非负毫秒数");
    const docResponse = await issueGet(
      ["issues", created.id, "documents", "read"], service,
        "?name=issue-analysis.md");
    assert.equal(docResponse.status, 200,
      "文档存在时读取必须是 200,不是 404");
    assert.match(String(docResponse.body.content), /非问题/,
      "issue-analysis.md 的内容应原样可读");
    // 问题号未知才是 404;文档缺失的对照路在下方独立测试里钉死。
    assert.equal((await issueGet(
      ["issues", "issue-999", "documents"], service)).status, 404);

    // ADR-0034:作答结论卡即闭环归档。
    const archived = await service.answer(created.id, {
      state_version: concludeCard.gate!.state_version,
      code: "non_issue",
    });
    assert.equal(archived.status, "archived");
    assert.equal(archived.conclusion?.kind, "non_issue");
    // 阶段转移账:平台机械事实记账,归档是最后一条平台事实。
    const sources = archived.transitions?.map((entry) => entry.source) ?? [];
    assert.ok(sources.includes("platform"), "平台动作要入转移账");
    assert.equal(archived.transitions?.at(-1)?.source, "platform");
    assert.equal(archived.transitions?.at(-1)?.stage, "conclude",
      "归档收口落在场景路线自己的词表里");
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
    "归档后环境凭据必须清理");
    assert.throws(() => service.reply(created.id, "再看看"),
      /已归档/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("创建:固定流程登记回执、vault 与开场上下文照旧", async () => {
  const dataDir = mfcTemp("mfc-issue-create-fixed-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [{ text: "收到,先做初步排查。" }];
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
      account: "dev",
      title: "播放器偶发黑屏",
      description: "测试环境偶发黑屏,疑似新版本引入",
      repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    // 创建恒为固定流程:回执与盘上状态一致,无单登记烙 no_ticket 三节点。
    assert.equal(created.scenario, "no_ticket");
    assert.equal(created.stage, "prep_repo");
    assert.equal(loadState(join(dataDir, "issues", created.id))?.scenario,
      "no_ticket", "盘上 state.scenario 与回执一致");
    // create() 即刻排入首轮研究(并发额度内同步启动,状态直奔 running)。
    assert.equal(created.status, "running");
    assert.equal(created.ticket, undefined, "先研究后补单:创建时单号可空");
    // 页面凭据不回流的强断言在 issueFlowContract(真传页面凭据的打回
    // 用例);此处不重复弱版本。
    assert.ok(!existsSync(join(dataDir, "issues", created.id, "repo", ".mae-flow.json")),
      "问题会话不初始化内核(与需求流分属两个范式)");

    // vault 后台凭据自成组可解出:后台三账号同密码。
    const vault = new IssueEnvironmentVault(dataDir);
    assert.deepEqual(
      vault.credentials(created.id, created.environment!.credential_ref)
        .map((account) => account.username),
      ["operator", "serviceaccount", "administrator"]);
    assert.equal(vault.credential(created.id,
      created.environment!.credential_ref, "operator")?.password,
      "env-shared-secret");
    const stateFile = readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.doesNotMatch(stateFile, /env-shared-secret/);

    // 登记元信息进上下文(ADR-0003):网管口令明文随元信息块出现。
    await until(() => model.requests.length ? 1 : undefined, "首轮请求");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /env-shared-secret/);
    assert.match(requestText, /192\.0\.2\.8/, "环境地址是现场材料,应该可见");
    // 开场问题应作为用户消息入账(等首回合收口再查线程)。
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "首回合收口");
    const thread = service.messages(created.id);
    assert.ok(thread.some((message) =>
      message.role === "user" && message.text.includes("黑屏")),
    "开场问题应作为用户消息入账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("单号门禁:未绑定单号时 push_branch 被机械拒绝", async () => {
  const dataDir = mfcTemp("mfc-issue-gate-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "bash", input: { command:
      "cd repo/origin && git checkout -q -b master_dev_DTS1 && "
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS1][fix] 修复测试问题'" } } },
    { tool: { name: "push_branch", input: { branch: "master_dev_DTS1" } } },
    { text: "推送被单号门禁拒绝,已如实报告用户。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  // 单号门禁在阶段门禁之后把守:push_branch 自 #373(ADR-0050)起为
  // 「提交 MR·跑绿」独占,种子落在 mr_green(阶段已收口,不牵催办),
  // 单号缺席由机械门禁打回。
  seedRecoverableIssue(dataDir, "issue-1", {
    title: "无单号问题",
    repo_url: origin, repo_urls: [origin],
    baseline: "br_V100R026C10_release",
    scenario: "ticket", round: 1,
    stage: "mr_green", stage_states: ["done", "done", "done", "done", "done"],
    status: "running",
  });
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const created = { id: "issue-1" };
  try {
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "无单号回合收口");
    assert.equal(service.get(created.id).pushes, undefined,
      "没有单号就不该有任何推送记录");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const pushFinished = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((event) => event.kind === "tool_finished"
        && event.payload?.name === "push_branch");
    assert.ok(pushFinished, "push_branch 调用应入事件账");
    assert.equal(pushFinished.payload.is_error, true);
    assert.match(String(pushFinished.payload.result), /单号门禁/,
      "拒绝理由必须说人话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("宿主推送与提 MR:门禁、真推送、公共 mrClient(与需求交付同格式)", async () => {
  const dataDir = mfcTemp("mfc-issue-push-");
  const origin = bareOrigin(dataDir);
  // 会话修复分支(ADR-0063):基线_工号_单号_时间戳;夹具用定死的假
  // 时间戳代表"会话已定名",推送/MR 管道测试不关心时间戳本身。
  const branch = "br_V100R026C10_release_dev_DTS2026082001317_20261015090000";
  // 假交付平台:记录请求形状,回 MR 链接——与适配层 POST /mr 同构。
  const seen: Array<{ headers: Record<string, string>; body: any }> = [];
  const platform = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      seen.push({
        headers: request.headers as Record<string, string>,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        url: `http://codehub.test/mr/1024`, id: 1024,
      }));
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, "127.0.0.1", resolve));
  const platformUrl = `http://127.0.0.1:${(platform.address() as { port: number }).port}`;
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    // 修复分支由宿主在 pull_repo 时切好(AI 不自己起名),直接落提交。
    { tool: { name: "bash", input: { command:
      `cd repo/origin && `
      + "git -c user.name=test -c user.email=t@e commit -q --allow-empty "
      + "-m '[DTS2026082001317][fix] 修复登录超时'" } } },
    { tool: { name: "push_branch", input: { branch } } },
    { tool: { name: "create_mr", input: {} } },
    { text: "已推送并提 MR。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  // MR 标题平台代笔(2026-09-07):create_mr 现场查 DTS 取权威标题。
  // stub 给一个与会话登记标题("登录超时")不同、不带 [单号] 前缀的标题。
  const dts: DtsGateway = {
    listByOwner: async () => [],
    detail: async (ticket) => ({
      ticket, title: "登录超时(压测环境批量操作必现)", content: "stub",
    }),
    proxyFile: async () => ({ data: Buffer.alloc(0), contentType: "text/plain" }),
  };
  // 宿主推送/提 MR 的宿主管道回归钉在种子会话上:mr_green 阶段两工具
  // 都开放(阶段收口态的返工续推,不牵催办;固定流程推送/MR 全链另有
  // 契约快照覆盖)。
  seedRecoverableIssue(dataDir, "issue-1", {
    title: "登录超时",
    ticket: "DTS2026082001317",
    source: "dts",
    repo_url: origin, repo_urls: [origin],
    baseline: "br_V100R026C10_release",
    fix_branch: branch,
    scenario: "ticket", round: 1,
    stage: "mr_green",
    stage_states: ["done", "done", "done", "done", "done"],
    status: "running",
  });
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts,
    platformUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  const created = { id: "issue-1" };
  try {
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "推送+提MR回合收口");
    const final = service.get(created.id);
    const push = final.pushes?.[0];
    assert.ok(push, "推送应记录在案");
    assert.equal(push.branch, branch);
    // 远端真实状态(不信任务自述):裸仓里分支应指向同一 SHA。
    const remote = spawnSync("git",
      ["--git-dir", origin, "rev-parse", `refs/heads/${branch}`],
      { encoding: "utf-8" });
    assert.equal(remote.status, 0, remote.stderr);
    assert.equal(remote.stdout.trim(), push.sha);
    // Agent 侧推送被焊死:克隆的 pushurl 指向必失败地址。
    const pushurl = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo", "origin"),
        "config", "--get", "remote.origin.pushurl"],
      { encoding: "utf-8" });
    assert.match(pushurl.stdout, /\/dev\/null/);
    // MR:走公共客户端,单号关联与身份头同需求交付一个格式。
    assert.ok(final.mrs?.length, "MR 应记录在案");
    assert.equal(final.mrs![0].url, "http://codehub.test/mr/1024");
    assert.equal(final.mrs![0].iid, "1024");
    // 固定流程下 create_mr 会顺带启动流水线监看(轮询打同一假平台),
    // 对账只看 MR 建单的 POST。
    const mrCalls = seen.filter((call) => call.body?.source_branch !== undefined);
    assert.equal(mrCalls.length, 1);
    assert.equal(mrCalls[0].body.source_branch, branch);
    // 目标分支缺省=会话基线(#441):登记产品版本映射的分支,不再打 master。
    assert.equal(mrCalls[0].body.target_branch, "br_V100R026C10_release");
    assert.equal(mrCalls[0].body.dts_no, "DTS2026082001317", "单号要走 dts_no 关联");
    // MR 标题平台代笔(2026-09-07):标题=DTS 单据标题,精确相等、
    // 无 [单号] 前缀——登记标题("登录超时")不许顶替。
    assert.equal(mrCalls[0].body.title, "登录超时(压测环境批量操作必现)");
    assert.equal(final.mrs![0].title, "登录超时(压测环境批量操作必现)",
      "台账记实际使用的标题");
    assert.equal(mrCalls[0].headers["x-mfc-git-user"], "dev");
    assert.equal(mrCalls[0].headers["x-mfc-git-token"], "git-token");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await new Promise<void>((resolve) => platform.close(() => resolve()));
  }
});

test("重启续聊:等待问题卡期间服务重启,作答仍能续上现场", async () => {
  const dataDir = mfcTemp("mfc-issue-recover-");
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "现象是必现还是偶发?", options: ["必现", "偶发"],
      recommended: "偶发",
    }] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const first = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 等「等人卡」的管道测试:显式三档对齐(缺省二档会把纯选项卡代答)。
    interventionTier: () => "3",
  });
  let second: IssueFlowService | undefined;
  try {
    // 无单登记门禁要模块+环境(#17):夹具模块绑一个不存在的本地路径
    // 仓即可——本测试不拉仓,只要登记过门。
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = first.create({
      account: "dev", title: "重启续聊",
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = first.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "重启前问题卡");
    await first.shutdown();

    second = new IssueFlowService({
      dataDir, provider: "maeflow", model: "scripted-v1",
      modelsJson: model.modelsJson(),
      interventionTier: () => "3",
    });
    const recovered = second.get(created.id);
    assert.equal(recovered.status, "waiting_user",
      "重启不吞等待中的问题卡");
    second.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发",
    });
    await until(() => {
      const issue = second!.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "重启后作答复跑");
    assert.ok(second.messages(created.id).some((message) =>
      message.role === "decision" && message.text.includes("偶发")),
    "决定应作为消息入账");
  } finally {
    await first.shutdown().catch(() => undefined);
    await second?.shutdown().catch(() => undefined);
    await model.stop();
  }
});

/** 落一个最小可恢复的问题现场(固定流程种子:无单三节点、分析阶段
 * 已收口——恢复管线启动,收口态不牵催办/阶段机)。必须在构造服务
 * 之前调用。 */
function seedRecoverableIssue(
  dataDir: string,
  id: string,
  patch: Record<string, unknown>,
): void {
  const now = "2026-08-29T00:00:00Z";
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev", created_at: now, updated_at: now,
    title: `标题-${id}`, description: "", source: "manual",
    scenario: "no_ticket", round: 1,
    stage_states: ["done", "done", "done"],
    status: "idle",
    stage: "analyze", stage_note: "正在核对日志时序", stage_at: now,
    ...patch,
  }));
}

test("failed 会话的出路是取消或异常重跑:归档被拒绝,取消清理,重跑原地复活", async () => {
  // 2026-09-02 用户实锤:failed 曾是死胡同终态——不能续聊、按钮全灰,
  // 出错的会话永远占着"进行中"列表,出口先定为取消。2026-09-23 起
  // 增设异常重跑(ADR-0055):操作者确认异常已排除,原地复活续跑。
  const dataDir = mfcTemp("mfc-issue-failed-exit-");
  seedRecoverableIssue(dataDir, "issue-1", { status: "failed" });
  seedRecoverableIssue(dataDir, "issue-2", { status: "failed" });
  const script: Scene[] = [{ text: "收到,恢复推进。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    deferRecovery: true,
  });
  try {
    service.start();
    assert.equal(service.list().length, 2,
      "failed 不重新入队,但 live 句柄必须在(否则连出口都够不着)");
    assert.equal((await service.control("issue-2", { action: "cancel" })).status,
      "canceled", "failed 必须能取消——无路可走的终态就是列表里的永久噪音");
    await assert.rejects(
      service.control("issue-2", { action: "revive" }),
      /异常重跑只适用于已失败的会话/,
      "取消是纯终态,重跑必须拒绝(ADR-0055)");
    // 异常重跑:原地复活——阶段与轮次账不动,failed 冻结的终态快照
    // 失效删除,语义事件与审计账留痕,恢复回合以重跑通知开场。
    const root = join(dataDir, "issues", "issue-1");
    writeFileSync(join(root, "metrics.json"),
      JSON.stringify({ terminal_status: "failed" }));
    const revived = await service.control("issue-1", { action: "revive" });
    assert.ok(["idle", "running"].includes(revived.status),
      "重跑即复活:回合骨架可能在返回前已把运行位顶成 running,但不再是 failed");
    await assert.rejects(
      service.control("issue-1", { action: "revive" }),
      /异常重跑只适用于已失败的会话/, "重复重跑防重拒绝");
    const done = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "恢复回合收口");
    assert.equal(done.stage, "analyze", "阶段保持 failed 前原样");
    const persisted = loadState(root)!;
    assert.equal(persisted.round, 1, "轮次账不推高");
    assert.ok(!existsSync(join(root, "metrics.json")),
      "failed 冻结的终态快照随复活失效删除");
    const request = JSON.stringify(model.requests.at(-1));
    assert.ok(request.includes("异常重跑"), "恢复回合开场是重跑通知");
    assert.ok(request.includes("- 标题: 标题-issue-1"),
      "续聊提示词把登记现场重给重建的上下文");
    assert.ok(readFileSync(join(root, "events.jsonl"), "utf-8")
      .includes("\"issue_revived\""), "语义事件落协作账");
    assert.ok(readFileSync(join(root, "audit", "decisions.jsonl"), "utf-8")
      .includes("\"decision.revive\""), "审计账留痕");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("异常重跑:真 failed 现场复活后恢复回合接回原上下文,操作者说明原文送达", async () => {
  // 先真实跑一场(留底层 Pi 会话文件),注入网关错误落 failed,再重跑
  // ——接回的判据:恢复回合的模型请求里带得上一场的发言历史,不是
  // 降级开局;操作者说明原文随通知必达(补充说明不变量)。
  const dataDir = mfcTemp("mfc-issue-revive-real-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { text: "第一轮:已定位日志时序问题。" },
    { text: "恢复后继续推进。" },
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
      account: "dev", title: "异常重跑实链", repoUrl: origin,
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口");
    const before = loadState(join(dataDir, "issues", created.id))!;
    model.failWith("内部错误:测试注入的模型故障", 1);
    service.reply(created.id, "继续推进");
    await until(() =>
      service.get(created.id).status === "failed"
        ? service.get(created.id) : undefined,
    "注入故障落 failed");
    const root = join(dataDir, "issues", created.id);
    assert.ok(existsSync(join(root, "metrics.json")), "failed 冻结终态快照");
    await service.control(created.id,
      { action: "revive", note: "网关额度已恢复,继续" });
    const after = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "恢复回合收口");
    assert.equal(after.round, before.round, "轮次账不推高");
    assert.equal(after.stage, before.stage, "阶段保持原样");
    assert.ok(!existsSync(join(root, "metrics.json")),
      "终态快照随复活失效删除");
    const recovery = model.requests.map((request) => JSON.stringify(request))
      .find((request) => request.includes("原地接着当前阶段继续"));
    assert.ok(recovery, "恢复回合的模型请求可见");
    assert.ok(recovery.includes("网关额度已恢复,继续"), "操作者说明原文必达");
    assert.ok(recovery.includes("第一轮:已定位日志时序问题。"),
      "原会话上下文接回:上一轮发言在请求历史里,不是降级开局");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("异常重跑·降级开局:恢复请求带齐报告指针/意见恢复源/最近三条决定回放,告知语勿从头重做", async () => {
  // 底层 Pi 会话文件缺失时 sessionDriver 降级为全新会话(ADR-0055):
  // 上下文接不回来,工作区材料与人工决定就是续跑的全部依据——恢复
  // 回合的请求必须把它们投影齐全,而且明确告知勿从头重做。
  const dataDir = mfcTemp("mfc-issue-revive-degrade-");
  seedRecoverableIssue(dataDir, "issue-1", {
    status: "failed",
    pushes: [{ repo: "origin", branch: "master_dev_DTS-1",
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      at: "2026-08-29T00:00:00Z" }],
  });
  const root = join(dataDir, "issues", "issue-1");
  // 降级前提:底层 Pi 原生会话目录不留(缺失/损坏同路)。
  rmSync(join(root, "pi-agent"), { recursive: true, force: true });
  // 工作区材料:分析报告(带「修改方案」章节)+检视意见快照。
  writeFileSync(join(root, "issue-analysis.md"),
    "# 根因分析\n\n## 问题现象\n演示现象。\n## 问题根因\n环境时钟漂移。\n"
    + "## 修改方案\n校准节点时钟后复测。\n## 置信度\n高。\n");
  mkdirSync(join(root, "reviews"), { recursive: true });
  writeFileSync(join(root, "reviews", "review-notes.md"),
    "- 意见一:日志时序图坐标轴标注错误\n");
  // 事件账种四条人工决定:回放窗口是最近 3 条,最老一条必须出局。
  writeFileSync(join(root, "events.jsonl"),
    [1, 2, 3, 4].map((n) => JSON.stringify({
      eventId: n, taskId: "issue-1", sessionId: "issue-1",
      ts: `2026-08-29T00:0${n}:00Z`, kind: "human_decision",
      payload: { waiting_id: `issue-1:call-${n}`, state_version: 1,
        decision: `人工决定${n}号:按方案${n}执行`, notes: "" },
    })).join("\n") + "\n");
  const script: Scene[] = [{ text: "收到,按已有材料继续推进。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), deferRecovery: true,
  });
  try {
    service.start();
    await service.control("issue-1", { action: "revive" });
    const done = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "降级恢复回合收口");
    assert.equal(done.stage, "analyze", "阶段保持 failed 前原样");
    const request = JSON.stringify(model.requests.at(-1));
    assert.ok(request.includes("- 标题: 标题-issue-1"),
      "登记元信息随续聊提示词重给");
    assert.ok(request.includes("- 最近阶段:"),
      "最近阶段随续聊提示词重给");
    assert.ok(request.includes("issue-analysis.md") &&
      request.includes("校准节点时钟后复测。"),
      "报告路径+修改方案要点指针随请求");
    assert.ok(request.includes("reviews/review-notes.md"),
      "检视意见恢复源指针随请求");
    assert.ok(request.includes("- 已推送: master_dev_DTS-1"),
      "推送/MR 账随续聊提示词重给");
    assert.ok(request.includes("人工决定2号")
      && request.includes("人工决定3号") && request.includes("人工决定4号"),
      "最近三条人工决定原文回放");
    assert.ok(!request.includes("人工决定1号"),
      "窗口外的最老决定不回放");
    assert.ok(request.indexOf("人工决定2号") < request.indexOf("人工决定3号")
      && request.indexOf("人工决定3号") < request.indexOf("人工决定4号"),
      "决定按时间正序回放");
    assert.ok(request.includes("勿从头重做"),
      "降级告知语明确「勿从头重做」");
    // 事件账全程连续:种下的 1-4、issue_revived、恢复回合的过程事件
    // 一条账记到底,复活前后不另立账本。
    const ids = readFileSync(join(root, "events.jsonl"), "utf-8")
      .split("\n").filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { eventId: number }).eventId);
    assert.ok(ids.length > 5, "恢复回合有过程事件落账");
    assert.ok(ids.every((id, index) => index === 0 || id === ids[index - 1] + 1),
      "eventId 逐条连续,复活前后同账");
    const revivedCount = readFileSync(join(root, "events.jsonl"), "utf-8")
      .split("\n").filter((line) => line.includes("\"issue_revived\"")).length;
    assert.equal(revivedCount, 1, "issue_revived 恰一条");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("异常重跑:崩溃遗留的未定格 Agent 卡随复活作废,不再投影可答卡", async () => {
  // 幽灵卡形态:Agent 举了卡没等人答,回合先一步失败——卡留在
  // waiting.json 里永远等不到答案。重跑的清账与重启恢复同款:未定格
  // 卡作废留痕,不越过复活线带进恢复回合。(夹具在 start() 之后种卡:
  // 启动恢复管线对 failed 也会清扫,先种卡会被它抢走,测不到重跑侧。)
  const dataDir = mfcTemp("mfc-issue-revive-ghost-");
  seedRecoverableIssue(dataDir, "issue-1", { status: "failed" });
  const root = join(dataDir, "issues", "issue-1");
  const script: Scene[] = [{ text: "收到,恢复推进。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), deferRecovery: true,
  });
  try {
    service.start();
    writeFileSync(join(root, "waiting.json"), JSON.stringify({ records: {
      "issue-1:call-ghost": {
        waiting_id: "issue-1:call-ghost", task_id: "issue-1", step: "fix",
        call_id: "call-ghost",
        question: { questions: [{ question: "用哪个方案修复?",
          options: ["方案 A", "方案 B"], recommended: "方案 A" }] },
        state_version: 1, status: "waiting", decision: "", notes: "",
        created_at: "2026-08-29T00:00:00Z", resolved_at: "",
      },
    } }, null, 1));
    await service.control("issue-1", { action: "revive" });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "恢复回合收口");
    const store = JSON.parse(
      readFileSync(join(root, "waiting.json"), "utf-8")) as {
      records: Record<string, { status: string; notes: string }>;
    };
    const ghost = store.records["issue-1:call-ghost"];
    assert.equal(ghost.status, "superseded", "幽灵卡随复活作废");
    assert.match(ghost.notes, /异常重跑/, "作废备注标明异常重跑来路");
    const waitingCards = service.conversation("issue-1").items
      .filter((item) => item.kind === "card" && item.status === "waiting");
    assert.equal(waitingCards.length, 0, "协作流不再投影可答卡");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("异常重跑:失败前的 MR/流水线监看账随复活续挂与补挂,落后账对齐推送账", async () => {
  // 在途监看与重启恢复同一套判断(共用 rearmInFlightLedgers):在盯的
  // 仓续挂,监看账落后于推送账的仓按推送账补挂。日志行带「异常重跑」
  // 前缀——与启动恢复管线自己发的同款行区分得开。无 platformUrl:
  // 续挂/补挂的证据在日志与判断,不在平台轮询。
  const dataDir = mfcTemp("mfc-issue-revive-watch-");
  const repoA = join(dataDir, "repo-a.git");
  const repoB = join(dataDir, "repo-b.git");
  const watchSha = "c".repeat(40);
  const pushedSha = "4".repeat(40);
  const now = "2026-08-29T00:00:00Z";
  seedRecoverableIssue(dataDir, "issue-1", {
    status: "failed",
    pushes: [
      { repo: repoA, branch: "master_dev_DTS-1", sha: watchSha, at: now },
      { repo: repoB, branch: "master_dev_DTS-2", sha: pushedSha, at: now },
    ],
    mrs: [
      { repo: repoA, branch: "master_dev_DTS-1", title: "MR-A",
        url: "http://loop.test/mr/1", at: now },
      { repo: repoB, branch: "master_dev_DTS-2", title: "MR-B",
        url: "http://loop.test/mr/2", at: now },
    ],
    pipelines: {
      // A:在盯且与推送账同 SHA——续挂;retry 死账与重启恢复同款清扫
      // 在启动侧先清一次,重跑侧走同一助手(同函数覆盖)。
      [repoA]: { sha: watchSha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1, evidence_retry_deadline: now,
        evidence_retry_attempts: 2, evidence_failure_log: "旧账" },
      // B:死表停在旧提交(watching=false,SHA 落后推送账)——补挂。
      [repoB]: { sha: "9".repeat(40), status: "failed", watching: false,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1 },
    },
  });
  const script: Scene[] = [{ text: "收到,恢复推进。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), deferRecovery: true,
    log: (message) => logs.push(message),
  });
  try {
    service.start();
    const before = logs.length;
    await service.control("issue-1", { action: "revive" });
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "恢复回合收口");
    const reviveLogs = logs.slice(before).join("\n");
    assert.match(reviveLogs,
      new RegExp(`异常重跑:issue-1 恢复流水线监看\\(${repoA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
      "在盯的仓随复活续挂");
    assert.match(reviveLogs,
      new RegExp(`异常重跑:issue-1 监看账落后于推送账\\(${repoB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\),补挂`),
      "落后于推送账的死表按推送账补挂");
    // 盘面对账:启动恢复管线已把 retry 死账清掉(与重跑同一助手);
    // 监看账与推送账的判断不写盘(无 platformUrl,补挂只记账日志),
    // 盘上 A 仓的在盯账保持原样。
    const onDisk = JSON.parse(readFileSync(
      join(dataDir, "issues", "issue-1", "issue.json"), "utf-8")) as {
      pipelines: Record<string, Record<string, unknown>>;
    };
    assert.equal("evidence_retry_deadline" in onDisk.pipelines[repoA], false,
      "retry 死账字段被清扫(启动侧,与重跑同助手)");
    assert.equal(onDisk.pipelines[repoA].watching, true, "A 仓在盯账保持");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("重启恢复翻转:running/旧 interrupted 重新入队自动续跑,queued 原样开跑,waiting 不动;存量挂起读盘归取消", async () => {
  const dataDir = mfcTemp("mfc-issue-recover2-");
  // 五个现场直接落盘(状态各一,不跑全链,聚焦恢复语义)。旧版
  // interrupted 已不在词表里,夹具按盘上原样写(旧版本盖的戳)。
  seedRecoverableIssue(dataDir, "issue-1", { status: "running" });
  seedRecoverableIssue(dataDir, "issue-2", {
    status: "queued", stage: "prep_repo",
    stage_states: ["pending", "in_progress", "pending"],
    stage_note: "已登记,固定流程启动",
  });
  seedRecoverableIssue(dataDir, "issue-3", {
    status: "interrupted",
    stage_note: "问题分析讨论中",
  });
  seedRecoverableIssue(dataDir, "issue-4", { status: "waiting_user" });
  // 盘面写旧词 suspended:读盘归取消(ADR-0048/0057),终态不进恢复泵。
  seedRecoverableIssue(dataDir, "issue-5", { status: "suspended" });
  const script: Scene[] = [{ text: "收到,继续推进。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 本票钉"恢复受额度约束",与缺省值(现为 5)解耦:显式给部署额度 2。
    maxConcurrentTurns: 2,
    log: (message) => logs.push(message),
  });
  try {
    // 构造即恢复:重排队的在部署额度(2)内启动,剩下的坐额度队列;
    // 等家人的原样不动,存量挂起读盘即归取消。目录遍历序不定,按集合断言。
    const active = ["issue-1", "issue-2", "issue-3"]
      .map((id) => service.get(id).status).sort();
    assert.deepEqual(active, ["queued", "running", "running"],
      "running/旧 interrupted/queued 都进泵,但受并发额度约束");
    assert.equal(service.get("issue-4").status, "waiting_user");
    assert.equal(service.get("issue-5").status, "canceled",
      "存量挂起读盘归取消(ADR-0048/0057)");
    assert.ok(logs.some((line) => /重启恢复: 续跑 2 个、排队 1 个/.test(line)),
      "恢复台账行要报续跑/排队数");
    await until(() => {
      const statuses = ["issue-1", "issue-2", "issue-3"]
        .map((id) => service.get(id).status);
      if (statuses.some((s) => s === "failed")) {
        throw new Error(service.get("issue-1").error
          ?? service.get("issue-2").error ?? "failed");
      }
      return statuses.every((s) => s === "idle") ? statuses : undefined;
    }, "重排队的会话逐个续跑收口");
    assert.equal(service.get("issue-4").status, "waiting_user", "全程未动");
    assert.equal(service.get("issue-5").status, "canceled", "全程未动");
    // 按标题认领各会话的请求:重启续跑的收到平台通知开场;原样排队
    // 的是登记首轮,仍走开场词——两条入口不混。
    const requests = model.requests.map((request) => JSON.stringify(request));
    for (const id of ["issue-1", "issue-3"]) {
      assert.ok(requests.some((r) => r.includes(`标题-${id}`)
        && r.includes("服务重启,平台自动续跑")),
        `${id} 的续跑回合开场是平台通知口径`);
    }
    assert.ok(requests.some((r) => r.includes("标题-issue-2")
      && r.includes("## 问题事实")), "queued 原样走登记开场词");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("续跑启动:开场是重启平台通知,续聊提示词带当前阶段上下文,事件流留痕", async () => {
  const dataDir = mfcTemp("mfc-issue-resume-");
  seedRecoverableIssue(dataDir, "issue-1", {
    title: "登录超时", status: "running",
  });
  const script: Scene[] = [{ text: "收到,接着当前阶段继续排查。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const idle = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续跑回合收口");
    assert.equal(idle.stage, "analyze", "续跑不重置阶段");
    // 开场词:平台通知口径 + 续聊提示词的现场块(最近阶段/登记元信息)。
    const prompt = JSON.stringify(model.requests[0]);
    assert.ok(prompt.includes(
      "服务重启,平台自动续跑,接着当前阶段继续,不重复已完成的工作"));
    assert.ok(prompt.includes("服务重启/续聊后继续同一问题会话"));
    assert.ok(prompt.includes("最近阶段: 问题分析(正在核对日志时序)"),
      "阶段语境原样交给重建的上下文");
    assert.ok(prompt.includes("- 标题: 登录超时"), "登记元信息随现场重给");
    // 重启通知以用户消息落事件流,时间线可查。
    assert.ok(service.messages("issue-1").some((message) =>
      message.role === "user"
      && message.text.includes("服务重启,平台自动续跑")));
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("Agent 问题卡归码:投影派码(码+文案对),按码作答还原原文,AI 看到的仍是自己的措辞", async () => {
  const dataDir = mfcTemp("mfc-issue-agentcode-");
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
    // 归码/还原契约是「等人卡」的作答协议:显式三档对齐。
    interventionTier: () => "3",
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "归码还原",
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "Agent 问题卡");
    // 投影派码:选项是码+文案对,码按「题号-序号」机械派发(AskUserQuestion
    // 的选项措辞是 Agent 现场自由给的,没有领域码表)。
    const questions = (waiting.waiting!.question as {
      questions: Array<{ options: Array<{ code: string; label: string }> }>;
    }).questions;
    assert.deepEqual(questions[0].options.map((option) => option.code),
      ["opt-0-0", "opt-0-1"], "Agent 卡选项同样携带决策码");
    assert.deepEqual(questions[0].options.map((option) => option.label),
      ["必现", "偶发"], "文案仍是 Agent 的原话(只作显示)");

    // 按码作答:decision 是前端显示文案,answers 携带码;服务端按自己的
    // 码表还原原文再入账——协议与平台闸同构(码是裁决/传递的身份)。
    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      decision: "偶发",
      answers: { "0": "opt-0-1" },
    });
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "作答后收口");
    const replay = JSON.stringify(model.requests.at(-1));
    assert.match(replay, /偶发/, "AI 收到的是还原后的选项原文");
    assert.doesNotMatch(replay, /opt-0-1/, "决策码是平台协议,不得漏进模型上下文");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("Agent 卡推荐投影:推荐原文换算成命中选项的投影码,多题各自独立,开放题不带", async () => {
  const dataDir = mfcTemp("mfc-issue-recommend-");
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: { questions: [
      { question: "影响范围?", options: ["仅 SMS ", "全部渠道"],
        recommended: " 全部渠道" },
      { question: "复现步骤是什么?(自由作答)" },
      { question: "重试次数?", options: ["三次", "四次"],
        recommended: "三次" },
    ] } } },
    { text: "已收到答复,继续分析。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: ["/tmp/fixture.git"],
    }, "tester");
    const created = service.create({
      account: "dev", title: "推荐投影",
      moduleId: "pay-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "Agent 问题卡");
    // 推荐协议(ADR-0004):推荐原文换算成命中选项的投影码随 questions[]
    // 下发,前端按码标「AI 推荐」——与选项同一条码表,文案改字零协议后果。
    const questions = (waiting.waiting!.question as {
      questions: Array<{
        options?: Array<{ code: string; label: string }>;
        recommended?: string;
      }>;
    }).questions;
    assert.equal(questions[0].recommended, "opt-0-1",
      "推荐原文两侧的空白不参与比对(trim 语义),命中即换码");
    assert.equal("recommended" in questions[1], false,
      "自由作答题没有推荐,投影不带该键");
    assert.equal(questions[2].recommended, "opt-2-0",
      "多题各自独立:推荐码带各自题号");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("B1验收2：问题流专用部署(--issue-only)保留独立服务与需求禁用契约", () => {
  const dataDir = mfcTemp("mfc-issue-only-");
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {}, maxConcurrent: 1,
    requirementDisabled: true,
  });
  // 发起需求任务:API 层直接拒绝,文案指路问题处理。
  assert.throws(() => service.create("新需求", { account: "dev" }),
    /问题流专用.*需求流程未启用/);
  // 下单表单的 blockers 把停用状态摆在明面上(前端现有渲染复用它)。
  const blockers = service.launchOptions().blockers
    .map((item) => item.key);
  assert.ok(blockers.includes("requirement_disabled"));
  // 问题流服务自身零依赖 TaskService:同数据目录并行构造,互不拖累。
  const issueFlow = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  assert.deepEqual(issueFlow.list(), []);
});

test("ops 运维工具:真二进制冒烟,诚实失败且不泄密码", async (t) => {
  // fetch-logs 引擎已迁为平台技能 fetch-logs 的 bin(引擎未变,载体变了):
  // 它的执行面由技能正文承载、内网实测;这里只剩封存中的 build-deploy。
  const toolsDir = join(process.cwd(), "assets", "ops-tools");
  const binary = process.platform === "win32"
    ? "build-deploy.exe"
    : process.arch === "arm64"
      ? "build-deploy-linux-arm64" : "build-deploy-linux-amd64";
  // 仓里只带 Linux ELF(和 Windows exe),macOS 上文件在场也跑不起来——
  // spawn 直接 ENOEXEC。光查 existsSync 会让开发机上这条恒红,红着的
  // 用例等于没有用例(实测:macOS 上断言拿到的是 "spawn ENOEXEC")。
  const runnable = process.platform === "win32" || process.platform === "linux";
  if (!runnable) {
    // 纪律:没条件就显式 skip 并说清为什么。裸 return 在 node:test 里
    // 算 pass,那才是"假装测过"。
    t.skip(`${process.platform} 跑不了 ${binary}(Linux/Windows 专用二进制)`);
    return;
  }
  if (!existsSync(join(toolsDir, binary))) {
    t.skip(`裁剪部署未随带 ${binary}`);
    return;
  }
  const ops = createGoOpsTools({ toolsDir });
  // build-deploy 冒烟:无 deployment/pom.xml 的目录必被前置校验打回,
  // 不发起真构建,密码不出现在错误文本里。
  await assert.rejects(
    () => ops.buildDeploy({
      projectPath: tmpdir(),
      hosts: ["127.0.0.1"],
      password: "probe-pass",
      includeLib: false,
    }),
    (error: Error) => {
      assert.match(error.message, /deployment\/pom\.xml/);
      assert.ok(!error.message.includes("probe-pass"),
        "密码绝不能出现在错误文本里");
      return true;
    },
  );
});

test("ops 容器内执行:超时第一响应在容器内,不连坐会话容器", async () => {
  // 契约(2026-09-02 拍板):工具超时只了结工具进程组——命令必须由
  // 容器内 timeout 打头(独立进程组,TERM→KILL),TaskContainer.exec
  // 的兜底超时必须赛赢它(预算+余量);销毁容器只是 timeout 失效时
  // 的保险,不是常规手段。
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ops-wrap-"));
  mkdirSync(join(workspace, "deployment"), { recursive: true });
  writeFileSync(join(workspace, "deployment", "pom.xml"), "<project/>");
  const calls: Array<{ command: string; cwd: string; timeout?: number }> = [];
  // 按调用次序出牌:主命令→(失败时的诊断命令)。
  const scripted: Array<{ exitCode: number | null; stdout: string; stderr: string }> = [];
  // 2026-09-02:假执行器显式标注 ContainerExec——实现侧执行能力形状
  // 一旦漂移(参数增删、返回字段改名),这里编译期就炸,而不是运行时。
  const containerExec: ContainerExec = {
    exec: async (command, cwd, options) => {
      calls.push({ command, cwd, timeout: options.timeout });
      return scripted.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  const ops = createGoOpsTools({ toolsDir: "unused", containerExec, workspace });
  const request = {
    projectPath: workspace,
    hosts: ["192.0.2.1"],
    password: "probe-pass",
    includeLib: false,
  };

  // 超时(容器内 timeout 退出码固定 124):报错要说明容器没受影响,
  // 并把输出尾部带出来供排障;密码照旧不得出现。
  scripted.push({ exitCode: 124, stdout: "mvn 构建进行中…", stderr: "" });
  await assert.rejects(
    () => ops.buildDeploy(request),
    (error: Error) => {
      assert.match(error.message, /20 分钟预算/);
      assert.match(error.message, /容器与工作区不受影响/);
      assert.match(error.message, /构建进行中/);
      assert.ok(!error.message.includes("probe-pass"),
        "密码绝不能出现在错误文本里");
      return true;
    },
  );
  const wrapped = calls[0];
  assert.match(wrapped.command, /^timeout --kill-after=30 1200 /,
    "命令必须由容器内 timeout 打头,预算 1200s");
  assert.match(wrapped.command, /'\.ops-tools\/build-deploy-[^']+'/);
  assert.equal(wrapped.timeout, 1260,
    "兜底超时 = 预算 + 60s 余量,必须赛赢容器内 timeout");
  assert.equal(wrapped.cwd, workspace);

  // 反例(2026-09-02):退出码 124 但哨兵在场,说明工具其实跑完了,
  // 只是收尾晚于预算——超时判定必须"退出码 124 且哨兵缺席"同时成立,
  // 不能只看退出码。此路必须落回普通失败路径(构建部署失败 + 诊断),
  // 不能拿"超时、容器不受影响"的话术误导排查方向。
  calls.length = 0;
  scripted.push({ exitCode: 124, stdout: "[INFO] 部署完成", stderr: "" });
  scripted.push({ exitCode: 0, stdout: "settings:OK", stderr: "" });
  await assert.rejects(
    () => ops.buildDeploy(request),
    (error: Error) => {
      assert.match(error.message, /构建部署失败/);
      assert.ok(!error.message.includes("分钟预算"),
        "哨兵在场就绝不是超时错误,报错不能带超时话术");
      return true;
    },
  );
  assert.equal(calls.length, 2, "普通失败路径的诊断命令照发");

  // 成功路径(退出码 0 + 哨兵)不受包装影响。
  calls.length = 0;
  scripted.push({ exitCode: 0, stdout: "[INFO] 部署完成", stderr: "" });
  const done = await ops.buildDeploy(request);
  assert.match(done.summary, /部署输出/);
  assert.match(calls[0].command, /^timeout --kill-after=30 1200 /);

  // 普通失败(退出码 1)走原有错误路径,诊断命令照发。
  calls.length = 0;
  scripted.push({ exitCode: 1, stdout: "[ERROR] BUILD FAILURE", stderr: "" });
  scripted.push({ exitCode: 0, stdout: "settings:OK", stderr: "" });
  await assert.rejects(
    () => ops.buildDeploy(request),
    (error: Error) => {
      assert.match(error.message, /构建部署失败/);
      assert.match(error.message, /诊断/);
      return true;
    },
  );
  // (fetch-logs 曾在此验证同一条容器内 timeout 契约;引擎迁为平台技能
  // fetch-logs 的 bin 后,该执行面由技能正文承载、内网实测——契约本身
  // 已被上方 build-deploy 各例覆盖。)
});

test("MCP 网关客户端:握手、token 头、工具调用与未配置 fail-loud", async () => {
  const seen: Array<{ token?: string; session?: string; body: any }> = [];
  const fake = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      seen.push({
        token: String(request.headers["x-auth-token"] ?? ""),
        session: String(request.headers["mcp-session-id"] ?? ""),
        body,
      });
      const reply = body.method === "initialize"
        ? {
            jsonrpc: "2.0", id: body.id,
            result: { protocolVersion: "2025-03-26", capabilities: {} },
          }
        : body.method === "tools/call"
          ? {
              jsonrpc: "2.0", id: body.id,
              result: {
                content: [{ type: "text", text: JSON.stringify([
                  { ticket: "DTS1", title: "登录超时" },
                ]) }],
              },
            }
          : { jsonrpc: "2.0", id: body.id ?? null, result: {} };
      response.writeHead(200, {
        "content-type": "application/json",
        ...(body.method === "initialize"
          ? { "mcp-session-id": "sess-1" } : {}),
      });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const port = (fake.address() as { port: number }).port;
  try {
    const gateway = new McpGateway({
      url: `http://127.0.0.1:${port}/mcp`,
      token: "secret-token",
      toolNames: { list: "list_issues" },
    });
    const result = await gateway.call("list_issues", { owner: "dev" });
    const text = (result as any).content[0].text;
    assert.match(text, /DTS1/);
    assert.equal(seen[0].token, "secret-token", "token 只在头里");
    assert.ok(seen.length >= 2);
    assert.equal(seen[1].session, "sess-1", "会话头要回带");

    const unconfigured = new UnconfiguredDtsGateway();
    await assert.rejects(() => unconfigured.listByOwner("dev"),
      /未配置/);
  } finally {
    await new Promise<void>((resolve) => fake.close(() => resolve()));
  }
});

test("网管环境配置路由(2026-08-28):POST /issues/:id/environment 密码进 vault 不进 issue.json;缺地址/缺密码打回", async () => {
  const dataDir = mfcTemp("mfc-issue-envroute-");
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-28T00:00:00Z", updated_at: "2026-08-28T00:00:00Z",
    title: "t", description: "", source: "manual",
    scenario: "no_ticket", status: "idle", stage: "analyze",
    stage_note: "", stage_at: "2026-08-28T00:00:00Z",
  }));
  const script: Scene[] = [{ text: "环境已配置,重试日志。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 校验打回:缺地址 / 缺后台密码都是 409 带人话,不产生任何落盘。
    const noHosts = await issuePost(["issues", "issue-1", "environment"],
      { hosts: [], backend_password: "x" }, service);
    assert.equal(noHosts.status, 409);
    assert.match(noHosts.body.error, /至少要有一个服务器地址/);
    const noPassword = await issuePost(["issues", "issue-1", "environment"],
      { hosts: ["192.0.2.8"], backend_password: "   " }, service);
    assert.equal(noPassword.status, 409);
    assert.match(noPassword.body.error, /网管后台密码/);

    // 正常配置:状态只有 credential_ref,密码在 vault 加密文件里,
    // issue.json 原文永远搜不到明文;页面凭据已废弃(2026-09-10),
    // body 里即便递了也不收。
    const ok = await issuePost(["issues", "issue-1", "environment"],
      { hosts: ["192.0.2.8", "192.0.2.9"], port: 2222,
        backend_password: "env-shared-secret",
        page_password: "should-be-ignored" }, service);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.environment?.credential_ref, "状态里只有凭据引用");
    assert.equal(ok.body.gate ?? undefined, undefined, "没有闸在场就不凭空造闸");
    assert.deepEqual(ok.body.environment?.hosts, ["192.0.2.8", "192.0.2.9"]);
    assert.equal(ok.body.environment?.port, 2222);
    assert.ok(!("page_account" in (ok.body.environment ?? {})),
      "闸内补配没有页面凭据,消费面按缺席优雅处理");
    assert.ok(existsSync(join(dataDir, ".issue-environments", "issue-1.json")),
      "密码落在 vault 加密文件");
    const raw = readFileSync(join(dataDir, "issues", "issue-1", "issue.json"), "utf-8");
    assert.ok(!raw.includes("env-shared-secret"), "issue.json 永远没有密码明文");
    await until(() => service.get("issue-1").status === "idle"
      ? 1 : undefined, "配置后的平台回合收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("网管环境拒绝路由(票 93):POST /issues/:id/environment 的 decline 分支清闸回落;闸不在场 409 如实打回", async () => {
  const dataDir = mfcTemp("mfc-issue-envdecline-route-");
  const now = "2026-09-03T00:00:00Z";
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "manual",
    scenario: "no_ticket", status: "waiting_user", stage: "analyze",
    stage_note: "", stage_at: now,
    gate: {
      id: "gate-1", kind: "env_needed", state_version: 0,
      question: { questions: [{
        question: "获取日志/换库需要网管服务器地址与密码",
        options: [{ code: "fill", label: "填写并继续" }],
      }] },
      scope: "logs",
      created_at: now,
    },
  }));
  const script: Scene[] = [{ text: "收到,基于现有证据继续。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 拒绝(带理由):同一提交口,decline:true 走拒绝路——清闸、开平台
    // 回合;理由与「无需」事实进转移账。
    const declined = await issuePost(["issues", "issue-1", "environment"],
      { decline: true, note: "与后台日志无关" }, service);
    assert.equal(declined.status, 200);
    assert.equal(declined.body.gate, undefined, "拒绝即清闸");
    const persisted = loadState(join(dataDir, "issues", "issue-1"))!;
    assert.ok(persisted.transitions?.some((entry) =>
      /网管环境配置被用户拒绝/.test(entry.note)
      && entry.note.includes("与后台日志无关")), "转移账带拒绝与理由");
    await until(() => service.get("issue-1").status === "idle" ? 1 : undefined,
      "拒绝后的平台回合收口");
    assert.match(JSON.stringify(model.requests[0]), /用户已确认无需拉日志/);

    // 闸不在场如实打回:没有卡就无所谓拒绝。
    const again = await issuePost(["issues", "issue-1", "environment"],
      { decline: true }, service);
    assert.equal(again.status, 409);
    assert.match(again.body.error, /当前没有网管环境配置卡/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("现场记录导出·纯构建器:工具命令/结果/决策逐字保真,未知事件兜底", () => {
  const state = {
    id: "issue-9", account: "dev",
    created_at: "2026-08-28T08:00:00Z", updated_at: "2026-08-28T09:00:00Z",
    title: "超长标题验证", description: "", source: "manual",
    status: "idle", stage: "analyze", stage_note: "对照代码核对时序",
    stage_at: "2026-08-28T09:00:00Z", ticket: "DTS-2026-1006",
    transitions: [
      { at: "2026-08-28T08:10:00Z", source: "agent", stage: "analyze",
        note: "对齐现象" },
      { at: "2026-08-28T08:20:00Z", source: "platform", note: "单号已绑定" },
    ],
  } as unknown as IssueSessionState;
  const events = [
    { eventId: 1, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:00:00Z", kind: "session_started", payload: {} },
    { eventId: 2, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:01:00Z", kind: "user_message",
      payload: { text: "开场指令" } },
    { eventId: 3, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:02:00Z", kind: "tool_requested",
      payload: { call_id: "c1", name: "Bash",
        input: { command: "grep -rn 网元树 src/" } } },
    { eventId: 4, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:03:00Z", kind: "tool_finished",
      payload: { call_id: "c1", name: "Bash", is_error: true,
        result: "grep: no match" } },
    { eventId: 5, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:04:00Z", kind: "human_decision",
      payload: { decision: "确认根因", notes: "以日志为准" } },
    { eventId: 6, taskId: "issue-9", sessionId: "s",
      ts: "2026-08-28T08:05:00Z", kind: "mystery_kind", payload: { odd: 1 } },
  ] as unknown as SemanticEvent[];
  const record = buildWorksiteRecord(
    { state, events, now: "2026-08-28T10:00:00Z" });
  assert.match(record.filename, /^issue-9-现场记录-20260828\.md$/);
  assert.match(record.markdown, /# 现场记录:超长标题验证/);
  assert.match(record.markdown, /DTS-2026-1006/);
  assert.match(record.markdown, /grep -rn 网元树 src\//, "工具命令逐字");
  assert.match(record.markdown, /✗ 异常/, "失败工具要标异常");
  assert.match(record.markdown, /确认根因/, "用户决策逐字");
  assert.match(record.markdown, /mystery_kind/, "未知事件兜底不丢");
  assert.match(record.markdown, /\[AI 上报\] 问题分析/, "阶段转移入账");
  assert.match(record.markdown, /\[平台\]/, "平台事实入账");
});

test("现场记录导出·路由:markdown 直出、坏行跳过、未知问题 404", async () => {
  const dataDir = mfcTemp("mfc-issue-export-");
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-08-28T08:00:00Z", updated_at: "2026-08-28T09:00:00Z",
    title: "t", description: "", source: "manual",
    status: "idle", stage: "analyze", stage_note: "",
    stage_at: "2026-08-28T09:00:00Z",
  }));
  // 半行(写入方还在写)+ 好行:导出必须跳过坏行而不是 5xx。
  writeFileSync(join(dataDir, "issues", "issue-1", "events.jsonl"),
    '{"kind":"user_mess\n'
    + JSON.stringify({ eventId: 2, kind: "user_message",
      ts: "2026-08-28T08:00:00Z", payload: { text: "开场" } }) + "\n");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return (async () => {
    try {
      const captured = await new Promise<{
        status: number; headers: Record<string, string>; body: string;
      }>((resolve, reject) => {
        let status = 0;
        let headers: Record<string, string> = {};
        void handleIssueRoutes(
          { method: "GET" } as any,
          {
            writeHead: (code: number, heads: Record<string, string>) => {
              status = code; headers = heads;
            },
            end: (payload?: string) => {
              resolve({ status, headers, body: payload ?? "" });
            },
          } as any,
          ["issues", "issue-1", "export"],
          { issueFlow: service, authEnabled: false },
        ).catch(reject);
      });
      assert.equal(captured.status, 200);
      assert.match(captured.headers["content-type"] ?? "", /text\/markdown/);
      assert.match(captured.headers["content-disposition"] ?? "", /attachment/);
      assert.match(captured.body, /# 现场记录:t/);
      assert.match(captured.body, /开场/, "好行入账");
      assert.ok(!captured.body.includes("user_mess"), "坏行不入账");

      const missing = await new Promise<{ status: number }>((resolve, reject) => {
        let status = 0;
        void handleIssueRoutes(
          { method: "GET" } as any,
          {
            writeHead: (code: number) => { status = code; },
            end: () => resolve({ status }),
          } as any,
          ["issues", "issue-404", "export"],
          { issueFlow: service, authEnabled: false },
        ).catch(reject);
      });
      assert.equal(missing.status, 404);
    } finally {
      await service.shutdown().catch(() => undefined);
    }
  })();
});

test("问题单并发数走管理页旋钮:额度现读,排队会话在额度腾出后补位", async () => {
  const dataDir = mfcTemp("mfc-issue-budget-");
  // 纯文本剧本(非 linear 按工具回执数取幕):两个会话各自一轮收口。
  const model = new ScriptedModelServer([{ text: "收到,先做初步分析。" }]);
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      runtime: () => ({ issue_max_turns: 1 }),
    },
  });
  try {
    const first = service.create({
      account: "dev", title: "并发额度一", ticket: "DTS-B1",
    });
    const second = service.create({
      account: "dev", title: "并发额度二", ticket: "DTS-B2",
    });
    assert.equal(first.status, "running");
    assert.equal(second.status, "queued",
      "额度 1(管理页旋钮):第二个会话必须排队启动");
    await until(() =>
      service.get(first.id).status === "idle" ? first : undefined,
      "首个会话收口");
    // 收口腾出额度,泵自动补位排队的会话并跑到收口。
    await until(() =>
      service.get(second.id).status === "idle" ? second : undefined,
      "排队会话补位并收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 环境台账快照(票 #150,ADR-0020「选入即快照」):登记与
// ---- env_needed 闸都收 environment_id——前端永远没有密码,值由服务端
// ---- 从台账解密后走既有 storeEnvironment 路径进会话 vault;台账后续
// ---- 改/删不影响已拷贝的会话(测试钉死)。

test("环境台账快照(#150):登记收 environment_id——服务端解密快照进 vault,root 显式/继承两语义;台账改/删不影响已拷贝会话", async () => {
  const dataDir = mfcTemp("mfc-issue-envsnap-");
  const registry = new EnvironmentRegistry(dataDir);
  // 显式 root:快照把解析后的 root 密码一并带进会话(独立凭据组)。
  const explicit = registry.create({
    ip: "192.0.2.8", port: 2222, form: "k8s",
    backendPassword: "backend-explicit", rootPassword: "root-explicit",
    tags: ["v5"],
  }, "keeper");
  // 继承 root(留空):不落独立 root 凭据,会话与"只填后台密码"完全同构。
  const inherited = registry.create({
    ip: "192.0.2.9", form: "virtualized", backendPassword: "backend-inherit",
  }, "keeper");
  const script: Scene[] = [
    { text: "收到,先做初步排查。" },
    { text: "收到,继承态环境的会话也收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 无单登记必须指定业务模块(spec #15):给一个最小模块供两次创建。
    createBusinessModule(dataDir, {
      id: "pay-core", name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [`file://${join(dataDir, "seed")}`],
    }, "tester");
    // 快照与手填字段互斥:同给 400,不烧会话号(版本必填在它之前,
    // 夹具带上版本让断言仍落在互斥门上)。
    const mixed = await issuePost(["issues"], {
      account: "dev", title: "互斥打回", assignee: "dev",
      product_version: "V100R027C10B005",
      environment: { environment_id: explicit.id, hosts: ["192.0.2.9"] },
    }, service);
    assert.equal(mixed.status, 400);
    assert.match(mixed.body.error, /互斥/);

    // 显式 root 的快照登记:hosts 单台(现有 wire 格式)、端口/形态随
    // 台账条目,来源 IP 记录在案;回执与状态文件搜不到任何密码明文。
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏", moduleId: "pay-core",
      environment: {
        environmentId: explicit.id,
      },
    });
    assert.deepEqual(created.environment?.hosts, ["192.0.2.8"]);
    assert.equal(created.environment?.port, 2222);
    assert.equal(created.environment?.env_type, "k8s");
    assert.equal(created.environment?.environment_source_ip, "192.0.2.8",
      "快照来源(选定时点的台账主 IP)进会话状态");
    assert.ok(created.environment?.root_credential_ref,
      "台账显式设置 root 时,快照带独立 root 凭据组");
    assert.ok(!JSON.stringify(created).includes("backend-explicit"));
    const vault = new IssueEnvironmentVault(dataDir);
    assert.equal(vault.credential(created.id,
      created.environment!.credential_ref, "operator")?.password,
      "backend-explicit");
    assert.deepEqual(vault.credential(created.id,
      created.environment!.root_credential_ref!),
      { username: "root", password: "root-explicit" });
    const stateFile = readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.doesNotMatch(stateFile, /backend-explicit|root-explicit/);

    // 继承 root 的快照登记:没有独立 root 凭据组,后台密码即解析值。
    const second = service.create({
      account: "dev", title: "继承 root 的会话", moduleId: "pay-core",
      environment: { environmentId: inherited.id },
    });
    assert.equal(second.environment?.root_credential_ref, undefined,
      "继承态不落独立 root 凭据,会话行为与现状一致");
    assert.equal(second.environment?.environment_source_ip, "192.0.2.9");
    assert.equal(vault.credential(second.id,
      second.environment!.credential_ref, "operator")?.password,
      "backend-inherit");

    // 元信息出口(root_password 只在显式存在时):
    // 开场上下文带独立 root 明文行(ADR-0003)。
    await until(() => model.requests.length ? 1 : undefined, "首轮请求");
    assert.match(JSON.stringify(model.requests),
      /root 密码\(独立设置;与后台密码不同\): root-explicit/);

    // 快照语义钉死:台账改密/删条目后,已拷贝会话的读取结果不变。
    registry.update(explicit.id, { backendPassword: "rotated" }, "keeper");
    registry.remove(inherited.id);
    assert.equal(registry.secrets(explicit.id)?.backendPassword, "rotated",
      "台账自身确已改变(对照)");
    assert.equal(vault.credential(created.id,
      created.environment!.credential_ref, "operator")?.password,
      "backend-explicit", "会话快照不随台账轮换漂移");
    assert.equal(vault.credential(created.id,
      created.environment!.root_credential_ref!, "root")?.password,
      "root-explicit");
    assert.equal(vault.credential(second.id,
      second.environment!.credential_ref, "operator")?.password,
      "backend-inherit", "台账条目删除后,已拷贝会话照常解出");

    // 登记快照的未知条目:人话打回,不烧会话号。
    assert.throws(() => service.create({
      account: "dev", title: "条目不存在", moduleId: "pay-core",
      environment: { environmentId: "no-such-entry" },
    }), /不存在/);
    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined, "首回合收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("env_needed 闸快照与手动沉淀(#150):environment_id 作答即台账快照;互斥同给 400;save_to_registry 保守合并不覆盖已配置密码", async () => {
  const dataDir = mfcTemp("mfc-issue-envsnap-gate-");
  const registry = new EnvironmentRegistry(dataDir);
  const entry = registry.create({
    ip: "192.0.2.66", port: 2222, form: "k8s",
    backendPassword: "snapshot-secret", tags: ["闸快选"],
  }, "keeper");
  const now = "2026-09-09T00:00:00Z";
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "manual",
    scenario: "no_ticket", status: "waiting_user", stage: "analyze",
    stage_note: "", stage_at: now,
    gate: {
      id: "gate-1", kind: "env_needed", state_version: 0,
      question: { questions: [{
        question: "获取日志/换库需要网管服务器地址与密码",
        options: [{ code: "fill", label: "填写并继续" }],
      }] },
      scope: "logs",
      created_at: now,
    },
  }));
  const script: Scene[] = [
    { text: "快照已配,重试日志。" },
    { text: "手动沉淀一收口。" },
    { text: "手动沉淀二收口。" },
    { text: "手动沉淀三收口。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const vault = new IssueEnvironmentVault(dataDir);
  try {
    // 互斥一律 400:decline 与 environment_id 同给是最典型的互斥形态
    // (手填/沉淀两类变体与 create 端的互斥 400 钉的是同一校验分支,
    // 不重复;2026-09-18 去冗)。
    {
      const rejected = await issuePost(
        ["issues", "issue-1", "environment"],
        { environment_id: entry.id, decline: true }, service);
      assert.equal(rejected.status, 400);
      assert.match(rejected.body.error, /互斥/);
    }
    assert.equal(loadState(join(dataDir, "issues", "issue-1"))?.environment,
      undefined, "互斥打回不落任何盘");

    // 未知条目:按本端口的控制族 409 人话打回。
    const missing = await issuePost(["issues", "issue-1", "environment"],
      { environment_id: "no-such-entry" }, service);
    assert.equal(missing.status, 409);
    assert.match(missing.body.error, /不存在/);

    // 快照作答:200 清闸,值从台账进 vault,hosts 单台、来源 IP 在案。
    const ok = await issuePost(["issues", "issue-1", "environment"],
      { environment_id: entry.id }, service);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.gate ?? undefined, undefined, "快照作答即清闸");
    assert.deepEqual(ok.body.environment?.hosts, ["192.0.2.66"]);
    assert.equal(ok.body.environment?.port, 2222);
    assert.equal(ok.body.environment?.env_type, "k8s");
    assert.equal(ok.body.environment?.environment_source_ip, "192.0.2.66");
    assert.equal(vault.credential("issue-1",
      ok.body.environment.credential_ref, "operator")?.password,
      "snapshot-secret");
    await until(() => service.get("issue-1").status === "idle"
      ? 1 : undefined, "快照作答的平台回合收口");

    // 手动沉淀(ADR-0020 手动回退的沉淀出路):手填带 save_to_registry
    // 与可选 root——台账按保守合并创建(创建者=作答人),会话 root
    // 凭据显式落 vault。
    const manual = await issuePost(["issues", "issue-1", "environment"], {
      hosts: ["192.0.2.77"], port: 2223, env_type: "k8s",
      backend_password: "manual-secret", root_password: "manual-root",
      save_to_registry: true,
    }, service);
    assert.equal(manual.status, 200);
    const contributed = registry.findByIp("192.0.2.77");
    assert.ok(contributed, "手填沉淀进了台账");
    assert.equal(contributed!.created_by, "dev", "创建者=作答人");
    assert.equal(contributed!.port, 2223);
    assert.deepEqual(registry.secrets(contributed!.id), {
      backendPassword: "manual-secret",
      rootPassword: "manual-root",
    });
    assert.ok(manual.body.environment?.root_credential_ref);
    assert.equal(vault.credential("issue-1",
      manual.body.environment.root_credential_ref, "root")?.password,
      "manual-root");
    const raw = readFileSync(
      join(dataDir, "issues", "issue-1", "issue.json"), "utf-8");
    assert.ok(!raw.includes("manual-root"), "沉淀路径同样秘密止步 vault");

    // 合并语义钉死:同 IP 再沉淀——已显式配置的密码不被覆盖、显式
    // root 不被清掉;继承态条目只补显式 root(只补缺)。
    const inheritedEntry = registry.create({
      ip: "192.0.2.78", form: "k8s", backendPassword: "be-78",
    }, "keeper");
    const again = await issuePost(["issues", "issue-1", "environment"], {
      hosts: ["192.0.2.77"], port: 9999, env_type: "k8s",
      backend_password: "rotated-attempt", save_to_registry: true,
    }, service);
    assert.equal(again.status, 200);
    assert.deepEqual(registry.secrets(contributed!.id), {
      backendPassword: "manual-secret",
      rootPassword: "manual-root",
    }, "沉淀是旁路贡献:已显式配置的密码原样保留");
    const refill = await issuePost(["issues", "issue-1", "environment"], {
      hosts: ["192.0.2.78"], env_type: "k8s",
      backend_password: "be-78", root_password: "root-78",
      save_to_registry: true,
    }, service);
    assert.equal(refill.status, 200);
    assert.deepEqual(registry.secrets(inheritedEntry.id), {
      backendPassword: "be-78",
      rootPassword: "root-78",
    }, "继承态条目只补显式 root,后台密码不动");
    await until(() => service.get("issue-1").status === "idle"
      ? 1 : undefined, "沉淀作答的平台回合收口");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 崩溃一致性/可恢复停机(票 #158/#159 首批,2026-09-10) ----

test("容器基础设施瞬断不判死:Docker 起不来落 idle 留话,现场保留可重试", async () => {
  const dataDir = mfcTemp("mfc-issue-infra-idle-");
  seedRecoverableIssue(dataDir, "issue-1", { status: "idle" });
  let attempts = 0;
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: { providers: {} },
    isolation: {
      image: "unused", volumes: [], memory: "2g", cpus: "2",
      pidsLimit: 512, network: "none",
      containerFactory: () => {
        attempts += 1;
        throw new Error("Cannot connect to the Docker daemon at "
          + "unix:///var/run/docker.sock");
      },
    },
  });
  try {
    const replied = service.reply("issue-1", "继续推进");
    assert.equal(replied.status, "running");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" && /容器未能启动/.test(issue.stage_note ?? "")
        ? issue : undefined;
    }, "容器瞬断落 idle 留话");
    assert.notEqual(settled.status, "failed", "基础设施瞬断不是会话失败");
    assert.equal(settled.error, undefined, "不落错误账");
    assert.equal(attempts, 1);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("恢复单目录隔离:一个损坏的 issue.json 不砖死服务启动,邻居照常在册", async () => {
  const dataDir = mfcTemp("mfc-issue-recover-iso-");
  seedRecoverableIssue(dataDir, "issue-ok1", { status: "waiting_user" });
  seedRecoverableIssue(dataDir, "issue-ok2", { status: "idle" });
  // 损坏现场:硬断电留下的全零块形状(票 #158 的事故形状)。
  const corruptRoot = join(dataDir, "issues", "issue-corrupt");
  mkdirSync(corruptRoot, { recursive: true });
  writeFileSync(join(corruptRoot, "issue.json"), "\u0000".repeat(300));
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "unused", model: "unused", modelsJson: {},
    deferRecovery: true,
    log: (message) => logs.push(message),
  });
  try {
    service.start();
    assert.equal(service.list().length, 2, "坏邻居只隔离自己,不带走服务");
    assert.ok(service.get("issue-ok1").title, "完好会话在册可查");
    assert.ok(logs.some((line) => /issue-corrupt 恢复失败/.test(line)),
      "隔离要大声记账");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("限流/额度不判死:429 落 idle 留话,额度恢复后发「继续」可续推", async () => {
  const dataDir = mfcTemp("mfc-issue-ratelimit-");
  const origin = bareOrigin(dataDir);
  const model = new ScriptedModelServer([
    { text: "(被限流顶掉)" },
  ], "scripted-v1");
  await model.start();
  seedRecoverableIssue(dataDir, "issue-1", { status: "idle" });
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    // 配额给足 5(> pi 自动重试 3 次),让限流穿透成终态模型错误。
    model.failWith("HTTP 429 rate limit exceeded: 使用上限,限额将在 "
      + "2026-09-10 18:00:00 重置(request_id=xyz)", 5);
    const replied = service.reply("issue-1", "继续推进");
    assert.equal(replied.status, "running");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" && /额度|限流|429/.test(issue.stage_note ?? "")
        ? issue : undefined;
    }, "429 落 idle 留话");
    assert.notEqual(settled.status, "failed", "限流不是会话失败");
    assert.equal(settled.error, undefined, "不落错误账");
    assert.match(settled.stage_note ?? "", /发送「继续」/, "留话要给出路");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("取消带终止原因:原因与说明落会话状态,无原因取消向后兼容(#541)", async () => {
  // 终止原因(#540/#541):cancel 动作的独立入参(不复用 revive 的
  // note,ADR-0055 语义不动)。带原因取消落进状态文件并随回执过线;
  // 说明文本只跟 other 有意义;无原因取消(历史路径/脚本调用)与
  // 现状完全一致,状态不带原因字段。
  const dataDir = mfcTemp("mfc-issue-cancel-reason-");
  seedRecoverableIssue(dataDir, "issue-1", { status: "idle" });
  seedRecoverableIssue(dataDir, "issue-2", { status: "idle" });
  seedRecoverableIssue(dataDir, "issue-3", { status: "idle" });
  seedRecoverableIssue(dataDir, "issue-4", { status: "idle" });
  const service = new IssueFlowService({
    dataDir, provider: "unused", model: "unused", modelsJson: {},
  });
  try {
    // other + 说明:原因与说明落盘,回执同带(工作台/列表展示读这)。
    const withReason = await service.control("issue-1", {
      action: "cancel", reason: "other", reasonText: "等了二十分钟没有反应",
    });
    assert.equal(withReason.status, "canceled");
    assert.equal(withReason.cancel_reason, "other");
    assert.equal(withReason.cancel_reason_text, "等了二十分钟没有反应");
    const persisted = loadState(join(dataDir, "issues", "issue-1"))!;
    assert.equal(persisted.cancel_reason, "other", "原因随终态落状态文件");
    assert.equal(persisted.cancel_reason_text, "等了二十分钟没有反应",
      "说明随终态落状态文件");

    // 默认档(问题已处理):只有原因,不落说明。
    await service.control("issue-2", { action: "cancel", reason: "resolved" });
    const resolved = loadState(join(dataDir, "issues", "issue-2"))!;
    assert.equal(resolved.cancel_reason, "resolved");
    assert.equal(resolved.cancel_reason_text, undefined,
      "非 other 原因不落说明文本(说明只跟 other 有意义)");

    // 无原因取消(历史路径):行为与现状一致,状态不带原因字段。
    const plain = await service.control("issue-3", { action: "cancel" });
    assert.equal(plain.status, "canceled");
    const legacy = loadState(join(dataDir, "issues", "issue-3"))!;
    assert.equal(legacy.cancel_reason, undefined, "无原因取消不落原因");
    assert.equal(legacy.cancel_reason_text, undefined);

    // 非法原因 fail-loud:不静默吞成无原因取消。
    await assert.rejects(
      service.control("issue-4", {
        action: "cancel", reason: "bogus" as never,
      }),
      /未知终止原因/,
      "原因枚举外的值直接拒绝,落盘前就挡住");
    assert.equal(loadState(join(dataDir, "issues", "issue-4"))!.status,
      "idle", "被拒绝的取消不产生任何写入");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});;
