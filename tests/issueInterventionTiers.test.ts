/**
 * 问题流 × 介入档位(ADR-0019,个人设置按流剥离)的契约测试:
 * - 机械层:一档「全自动」代答 analysis_confirm 全量、conclude 仅
 *   non_issue+高置信(闭环无下游闸,分级保守);二档的停靠点恰是这些
 *   闸,永不代答;缺省(回调缺席)=二档;
 * - Agent 卡(AskUserQuestion):一/二档自动 + 纯选项题卡按推荐项整卡
 *   代答,开放题/混卡/检视回合/三档对齐整卡等人(ADR-0006 口径);
 * - 作答走 answer() 同一裁决通道:现场账、阶段推进与真人作答同款;
 * - 提示层:开场词/续聊词按介入档位渲染三种「介入节奏」。
 *
 * 范式与 issueFlowNotify.test.ts 同款:ScriptedModelServer 剧本,
 * 只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import {
  issueFixedOpeningPrompt,
  issueResumePrompt,
} from "../src/issueFlow/prompt.ts";
import { promptCopy } from "../src/issueFlow/promptCopy.ts";
import { askToolDescription } from "../src/sessionDriver.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import {
  createIssueTools,
  type IssueToolContext,
} from "../src/issueFlow/tools.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const MODULE_ID = "pay-core";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(拉仓目标),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

function seedModule(dataDir: string, repoUrl: string): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [repoUrl],
  }, "tester");
}

const NO_TICKET_ENV = {
  hosts: ["192.0.2.8"],
  pagePassword: "page-secret",
  backendPassword: "env-shared-secret",
};

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

function baseOptions(dataDir: string, model: ScriptedModelServer) {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  };
}

/** 四要素合规的分析报告(门票校验过得了)。 */
const REPORT = "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n"
  + "非问题(测试环境时钟漂移)。\\n## 置信度\\n"
  + "高:偏差可复现。\\n## 修改方案\\n校时后观察,建议归档。\\n"
  + "' > issue-analysis.md";

test("一档全自动:有单分析闸全量代答,自动确认进问题修改", async () => {
  const dataDir = mfcTemp("mfc-issue-tier-ticket-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { summary: "非问题:时钟漂移" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      repoUrl: origin,
    });
    // 自动确认后推进到「问题修改」;脚本耗尽的修改回合催办耗尽转
    // idle,最终停在 fix 阶段——从没等过人。
    const advanced = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "fix" ? issue : undefined;
    }, "一档自动确认推进到问题修改");
    assert.equal(advanced.gate ?? undefined, undefined,
      "确认闸已被代答清掉,不再等用户");
    await until(() => service.get(created.id).status === "idle"
      ? true : undefined, "修改回合收口");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.ok(events.includes("介入档位免审批自动确认"),
      "现场账必须记录这是系统代答,不是用户作答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("代答竞速守卫:一档不发可行动卡通知(通知服务只见已代答),二档照发等卡", async () => {
  // 用户实锤:通知先飞、代答紧随——用户按通知 /mfc 回复时卡已被平台
  // 答掉,待办一查空。守卫=willAutoAnswer:会代答的卡不发等待卡通知,
  // 告知由「已代答」收口通知承担;二档(闸是停靠点)照发等真人。
  const scene = (dataDir: string, origin: string): Scene[] => [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { summary: "非问题:时钟漂移" } } },
    { text: "报告已提交。" },
  ];
  const CARD_MARK = "请查阅 issue-analysis.md 后确认";
  const AUTO_MARK = "介入档位免审批:分析结论已自动确认";

  // 一档:闸被代答,通知服务只有「已代答」通知,没有邀人回复的卡通知。
  {
    const dataDir = mfcTemp("mfc-issue-tier-card-suppressed-");
    const origin = bareOrigin(dataDir);
    const luban = new FakeLubanServer();
    await luban.start();
    const model = new ScriptedModelServer(scene(dataDir, origin),
      "scripted-v1", { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      interventionTier: () => "1",
      notifier: makeNotifier(luban),
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
        repoUrl: origin,
      });
      await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.stage === "fix" ? issue : undefined;
      }, "一档自动确认推进到问题修改");
      const texts = () => luban.messages.map((message) =>
        String(message.text ?? ""));
      await until(() => texts().some((text) => text.includes(AUTO_MARK))
        ? true : undefined, "已代答通知落袋");
      assert.ok(texts().some((text) => text.includes(AUTO_MARK)),
        "代答必须自带「已代答」收口通知");
      assert.ok(!texts().some((text) => text.includes(CARD_MARK)),
        "会被代答的卡不发等待卡通知——发了就是邀人回复一张已消失的卡");
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
      await luban.stop();
    }
  }

  // 二档:分析闸是停靠点,照发等待卡通知等真人,没有代答通知。
  {
    const dataDir = mfcTemp("mfc-issue-tier-card-kept-");
    const origin = bareOrigin(dataDir);
    const luban = new FakeLubanServer();
    await luban.start();
    const model = new ScriptedModelServer(scene(dataDir, origin),
      "scripted-v1", { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      interventionTier: () => "2",
      notifier: makeNotifier(luban),
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
        repoUrl: origin,
      });
      await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.status === "waiting_user"
          && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
      }, "二档分析闸等真人");
      const texts = () => luban.messages.map((message) =>
        String(message.text ?? ""));
      await until(() => texts().some((text) => text.includes(CARD_MARK))
        ? true : undefined, "等待卡通知落袋");
      assert.ok(texts().some((text) => text.includes(CARD_MARK)),
        "二档不发代答,等待卡通知必须照发");
      assert.ok(!texts().some((text) => text.includes(AUTO_MARK)),
        "二档没有代答,不该有已代答通知");
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
      await luban.stop();
    }
  }
});

test("一档全自动:无单 non_issue 且自报高置信,自动闭环归档", async () => {
  const dataDir = mfcTemp("mfc-issue-tier-close-");
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:时钟漂移" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "archived" ? issue : undefined;
    }, "一档自动闭环归档");
    assert.equal(archived.conclusion?.kind, "non_issue");
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.ok(events.includes("介入档位免审批自动确认"), "现场账记录代答");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("一档分级不满足(是问题/缺置信度)与三档对齐,结论闸一律等真人", async () => {
  const dataDir = mfcTemp("mfc-issue-tier-guard-");
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  // 三种都不代答:是问题(挂起后果重)/没自报置信度(宁人工勿猜)/
  // 三档对齐(停靠点就在结论)。
  const cases: Array<{ label: string; tier?: "1" | "3"; conclusion:
    "issue" | "non_issue"; confidence?: "high" | "medium" | "low" }> = [
    { label: "是问题必人工", tier: "1", conclusion: "issue",
      confidence: "high" },
    { label: "缺置信度不代答", tier: "1", conclusion: "non_issue" },
    { label: "三档对齐不代答", tier: "3", conclusion: "non_issue",
      confidence: "high" },
  ];
  for (const item of cases) {
    const script: Scene[] = [
      { tool: { name: "pull_repo", input: { url: origin } } },
      { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
      { tool: { name: "bash", input: { command: REPORT } } },
      { tool: { name: "submit_analysis",
        input: { conclusion: item.conclusion, summary: "结论:演示",
          ...(item.confidence ? { confidence: item.confidence } : {}) } } },
      { text: "结论已提交。" },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      interventionTier: () => item.tier ?? "2",
    });
    try {
      const created = service.create({
        account: "dev", title: "列表导出超时", repoUrl: origin,
        moduleId: MODULE_ID, environment: NO_TICKET_ENV,
      });
      const gate = await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") {
          throw new Error(issue.error ?? "failed");
        }
        return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
          ? issue : undefined;
      }, `结论闸等真人(${item.label})`);
      assert.equal(gate.gate?.proposal?.conclusion, item.conclusion);
      assert.equal(gate.status, "waiting_user", item.label);
      await new Promise((resolve) => setTimeout(resolve, 200),
      );
      assert.equal(service.get(created.id).status, "waiting_user",
        `${item.label}: settled 后仍必须等真人,不被代答`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("提示层:开场词与续聊词按介入档位渲染三种节奏", () => {
  const state = {
    id: "issue-1", scenario: "ticket", stage: "analyze",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
  } as unknown as IssueSessionState;
  const full = issueFixedOpeningPrompt(state, {}, { tier: "1" });
  const report = issueFixedOpeningPrompt(state, {}, { tier: "2" });
  const guard = issueFixedOpeningPrompt(state, {}, { tier: "3" });
  assert.match(full, /介入节奏\(全自动档\)/,
    "一档:不问、不简报、报告会被自动确认");
  assert.match(full, /无需补充即可执行/);
  assert.match(report, /介入节奏\(优先报告档\)/,
    "二档:报告是唯一停靠点");
  assert.match(report, /等用户检视/);
  assert.match(guard, /介入节奏\(优先对齐档\)/, "三档:主动问与对齐");
  assert.doesNotMatch(guard, /自动确认/);
  const resumeFull = issueResumePrompt(state, "继续", {}, { tier: "1" });
  const resumeReport = issueResumePrompt(state, "继续", {}, { tier: "2" });
  const resumeGuard = issueResumePrompt(state, "继续", {}, { tier: "3" });
  assert.match(resumeFull, /介入节奏:全自动档/);
  assert.match(resumeReport, /介入节奏:优先报告档/);
  assert.match(resumeGuard, /介入节奏:优先对齐档/);
});

test("grilling 触发链:对齐档节奏文本常驻点名方法,简报反问条款让位档位", () => {
  // 病根(2026-09-11 诊断):vendor grilling 的索引描述是"用户发起"
  // 口径,AI 自发对齐匹配不到渐进发现;常驻触发位只剩介入节奏文本与
  // AskUserQuestion 工具描述(模型决定问的那一刻必读)。
  const state = {
    id: "issue-1", scenario: "ticket", stage: "analyze",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
  } as unknown as IssueSessionState;
  const guard = issueFixedOpeningPrompt(state, {}, { tier: "3" });
  assert.match(guard, /grilling/, "对齐档节奏文本要点名 grilling(常驻触发位)");
  assert.match(guard, /skills\/grilling\/SKILL\.md/, "点名要带可达路径");
  assert.match(issueResumePrompt(state, "继续", {}, { tier: "3" }),
    /grilling/, "续聊重建的上下文同样要点名");
  assert.doesNotMatch(issueFixedOpeningPrompt(state, {}, { tier: "1" }),
    /skills\/grilling\/SKILL\.md/, "不问的档位不给方法路径——方法论地图的裸点名可留,方法骨架与路径归对齐档");
  assert.doesNotMatch(issueFixedOpeningPrompt(state, {}, { tier: "2" }),
    /skills\/grilling\/SKILL\.md/);
  // 简报是无档公共文案:反问条款必须让位给档位,不得与对齐档顶牛。
  const analyzeBrief = promptCopy("briefs", "stage.analyze");
  assert.doesNotMatch(analyzeBrief, /能自行推断的不要问/,
    "tier 无关的'不要问'是对齐档的对立面");
  assert.match(analyzeBrief, /介入节奏/, "问不问交给档位文本裁决");
  // 次级拦截点:问题会话的 AskUserQuestion 描述带 grilling 指路,
  // 任务会话不带(该技能不在任务工作区物化)。
  assert.match(askToolDescription("issue"), /grilling/);
  assert.doesNotMatch(askToolDescription("task"), /grilling/);
});

// ---- Agent 卡代答(T2,ADR-0006 口径扩展) ----

const LINK_BASE = "https://mfc.example.com";

function makeNotifier(luban: FakeLubanServer): Notifier {
  return new Notifier({
    endpoint: luban.endpoint,
    backoffMs: [0],
  });
}

/** waiting.json 原始记录(磁盘态:选项是字符串原文,无投影码)。 */
function waitingRecords(
  dataDir: string,
  issueId: string,
): Array<Record<string, unknown>> {
  const raw = JSON.parse(readFileSync(
    join(dataDir, "issues", issueId, "waiting.json"), "utf-8")) as {
    records: Record<string, Record<string, unknown>>;
  };
  return Object.values(raw.records);
}

function eventsFile(dataDir: string, issueId: string): string {
  return readFileSync(
    join(dataDir, "issues", issueId, "events.jsonl"), "utf-8");
}

test("自动档(一/二档):纯选项题 Agent 卡按推荐项整卡代答,续跑+留痕+通知照发", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      context: "已对齐两个候选修复方案",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }, {
        question: "是否同步更新运行手册?",
        options: ["更新", "暂不更新"],
        recommended: "暂不更新",
      }],
    } } },
    { text: "两题都按推荐处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  const dataDir = mfcTemp("mfc-issue-tier-card-");
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    notifier,
    linkBase: LINK_BASE,
    // 固定流程同享:有单登记不拦,开场即举 Agent 卡,代答牙齿照硬。
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    // 卡落地即被代答:两题各按推荐项的决策码作答,续跑收口 idle——
    // 从没等过人。
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "自动档代答 Agent 卡后续跑收口");
    assert.equal(service.get(created.id).waiting ?? undefined, undefined,
      "卡已被 resolve,不再等用户");
    // 入账与真人页面作答同形:决策码还原成选项原文(decision),
    // 机器代答留痕在 notes——现场导出投影它。
    const records = waitingRecords(dataDir, created.id);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.status, "resolved");
    assert.equal(record.decision, "方案A:超时回收\n暂不更新",
      "决策码还原成选项原文,与真人作答时代一致");
    assert.equal(
      record.notes,
      "介入档位免审批自动作答(推荐项:方案A:超时回收、暂不更新)");
    const events = eventsFile(dataDir, created.id);
    assert.ok(events.includes("介入档位免审批自动作答"),
      "现场账必须记录这是系统代答,不是用户作答");
    assert.ok(events.includes("两题都按推荐处理完毕"),
      "作答后走 resumeWithDecision 续跑,剧本下一幕真的执行了");
    // 通知服务 outcome 通知照发:台账记录人话摘要,通知载荷带工作台链接。
    const outcome = await until(() =>
      notifier.list().find((item) => item.summary.includes("介入档位免审批")),
      "代答 outcome 通知落台账");
    assert.ok(outcome.summary.includes("按推荐项自动作答"));
    assert.equal(outcome.link, `${LINK_BASE}/issues/${created.id}`);
    const delivered = await until(() =>
      luban.messages.find((message) =>
        String(message.link ?? "") === `${LINK_BASE}/issues/${created.id}`
        && String(message.text ?? "").includes("介入档位免审批")),
      "代答 outcome 通知送达假通知服务");
    assert.ok(delivered, "通知载荷带链接与代答说明");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("自动档:开放题卡与混卡整卡等人,不做半卡代答;三档对齐同样等人", async () => {
  const cases: Array<{
    label: string;
    tier?: "1" | "3";
    questions: Array<Record<string, unknown>>;
  }> = [
    {
      label: "开放题卡(一档)",
      tier: "1",
      questions: [{ question: "复现步骤具体是什么?" }],
    },
    {
      label: "混卡(选项题+开放题,一档)",
      tier: "1",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }, { question: "补充说明?" }],
    },
    {
      label: "三档对齐",
      tier: "3",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    },
  ];
  for (const item of cases) {
    const script: Scene[] = [
      { tool: { name: "AskUserQuestion", input: {
        questions: item.questions,
      } } },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const dataDir = mfcTemp("mfc-issue-tier-hold-");
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      interventionTier: () => item.tier ?? "2",
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      });
      const issue = await until(() => {
        const current = service.get(created.id);
        if (current.status === "failed") {
          throw new Error(current.error ?? "failed");
        }
        return current.status === "waiting_user" && current.waiting
          ? current : undefined;
      }, `卡落地等真人(${item.label})`);
      assert.ok(issue.waiting, item.label);
      // 代答是收口后的 setTimeout 旁路:等过这个窗口还在等,就是真等人。
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(service.get(created.id).status, "waiting_user",
        `${item.label}:整卡等人,不被代答`);
      const [record] = waitingRecords(dataDir, created.id);
      assert.equal(record.status, "waiting", `${item.label}:卡未被碰`);
      assert.equal(record.decision, "", `${item.label}:没有任何代答入账`);
      assert.doesNotMatch(
        eventsFile(dataDir, created.id), /介入档位免审批自动作答/,
        `${item.label}:不落代答留痕`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("自动档:检视重写窗口中的 Agent 卡永不代答(ADR-0007 口径延伸;ADR-0035 起窗口=修改型申报之后)", async () => {
  const dataDir = mfcTemp("mfc-issue-tier-review-");
  const origin = bareOrigin(dataDir);
  seedModule(dataDir, origin);
  // 线性剧本按请求数推进幕:cardA(代答续跑)→ 三幕文本(两次催办耗尽
  // 转 idle)→ 第 5 个请求落在分诊回合上,申报修改置 review_active;
  // 第 6 个请求在重写窗口里举出 cardB。
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "先查登录网关还是先查会话服务?",
        options: ["先查登录网关", "先查会话服务"],
        recommended: "先查登录网关",
      }],
    } } },
    { text: "第一轮按推荐项处理。" },
    { text: "继续推进。" },
    { text: "第一轮收尾。" },
    { tool: { name: "declare_review_rework", input: {
      reviews: [{ seq: 1 }],
      reason: "意见要求补证据并改方向,须整份重写",
    } } },
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "检视重写:修订按哪个方向落?",
        options: ["方向一:收紧超时阈值", "方向二:改用重试"],
        recommended: "方向一:收紧超时阈值",
      }],
    } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第一轮卡被代答后催办耗尽转 idle");
    const [firstCard] = waitingRecords(dataDir, created.id);
    assert.equal(firstCard.status, "resolved",
      "前置事实:检视前的纯选项题卡确实被自动档代答了");
    // 提交检视 = 分诊递词(不回退、不置 review_active);AI 申报修改
    // (declare_review_rework)才置 review_active 并回退——重写窗口里
    // 的 Agent 卡永不代答。
    service.addReview(created.id, {
      line: 1, anchor: "第一轮按推荐项处理。",
      note: "请补充日志时间窗的证据,并修订方向",
    });
    service.submitReviews(created.id);
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "analyze" && issue.round === 2 ? issue : undefined;
    }, "修改型申报触发回退重写(轮次+1)");
    const reviewCard = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "检视重写回合的 Agent 卡落地等真人");
    assert.ok(
      JSON.stringify(reviewCard.waiting?.question ?? "").includes("检视重写"),
      "在场的是检视重写回合举的新卡");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.get(created.id).status, "waiting_user",
      "检视重写回合的卡整段跳过代答");
    const records = waitingRecords(dataDir, created.id);
    const secondCard = records.find((record) =>
      String((record.question as { questions?: Array<{ question?: string }> })
        ?.questions?.[0]?.question ?? "").includes("检视重写"));
    assert.ok(secondCard, "检视重写回合的卡在场");
    assert.equal(secondCard!.status, "waiting", "卡未被代答");
    assert.equal(
      records.filter((record) =>
        String(record.notes ?? "").includes("介入档位免审批自动作答")).length,
      1,
      "全程只有检视前那一卡被代答,重写窗口的卡不追溯");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("三档对齐:平台闸在场,Agent 问题卡被单卡互斥拒落,只有闸等真人", async () => {
  const dataDir = mfcTemp("mfc-issue-tier-gate-");
  // 同一回合先举 env_needed 闸(拉日志缺网管环境,request_env 如实失败),
  // 再调 AskUserQuestion:ADR-0024 单卡互斥——闸在场时问题卡被宿主拦下
  // (纠偏文字作工具错误回给模型,不建卡不通知),模型收嘴结束回合,
  // 收口时只有闸等真人。两卡并存自 ADR-0024 起协议上不可能。
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "先按哪个思路排查?",
        options: ["先看线程池", "先看连接池"],
        recommended: "先看连接池",
      }],
    } } },
    { text: "闸已在等用户作答,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    // opsTools 在场才会走到「缺网管环境举 env_needed 闸」这一步;
    // env 配置卡三档同举(2026-10-31 起,ADR-0019 增补),此处沿用
    // 该测试原有的三档前置。
    opsTools: {
      async buildDeploy() { return { summary: "测试假件" }; },
    },
    interventionTier: () => "3",
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "闸拒落问题卡后收口等真人");
    // 通知与人话口径:只有闸卡等真人(env 闸三档照举);Agent 卡没建、
    // 自然无人代答——现读现判。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(service.get(created.id).gate?.kind, "env_needed",
      "env 闸原地等人(三档对齐照举)");
    assert.ok(!existsSync(join(dataDir, "issues", created.id, "waiting.json")),
      "Agent 问题卡未落盘(单卡互斥,闸优先)");
    assert.doesNotMatch(
      eventsFile(dataDir, created.id), /介入档位免审批自动作答/,
      "Agent 卡没有落代答留痕");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 环境配置卡三档同举(2026-10-31,ADR-0019 增补:环境地址与密码是
// 只有人拿得到的事实,归入「办不到」而非「询问」,任何档位都举卡) ----

/** 直调工具用的最小会话状态(未配网管环境,analyze 阶段)。 */
function envGateState(): IssueSessionState {
  return {
    id: "issue-env", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "",
    stage_at: new Date().toISOString(),
  } as unknown as IssueSessionState;
}

/** 直调上下文:档位可指定,环境恒未配置。 */
function envGateCtx(
  tier: "1" | "2" | "3",
  state: IssueSessionState,
): IssueToolContext {
  return {
    state, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    environmentPassword: () => undefined,
    interventionTier: () => tier,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
}

test("环境配置卡三档同举:一/二/三档同剧本缺环境举卡等真人,旧降级回执退役", async () => {
  // 同一份剧本跑三档:未配环境调 request_env → env_needed 卡举起,
  // 会话定格 waiting_user。一/二档「缺口写进报告继续」的降级路径
  // (回执+转移账留痕)整支退役;回执统一「请立即结束本回合等待」,
  // 不再有「等待期间可继续不需要环境的工作」的例外。
  for (const tier of ["1", "2", "3"] as const) {
    const dataDir = mfcTemp(`mfc-issue-tier-env-${tier}-`);
    const script: Scene[] = [
      { tool: { name: "request_env", input: {} } },
      { text: "已举配置卡,本回合到此。" },
    ];
    const model = new ScriptedModelServer(script, "scripted-v1",
      { linear: true });
    await model.start();
    const service = new IssueFlowService({
      ...baseOptions(dataDir, model),
      interventionTier: () => tier,
    });
    try {
      const created = service.create({
        account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      });
      const waiting = await until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") {
          throw new Error(issue.error ?? "failed");
        }
        return issue.status === "waiting_user"
          && issue.gate?.kind === "env_needed" ? issue : undefined;
      }, `${tier} 档缺环境举环境配置卡`);
      assert.equal(waiting.gate?.scope, "logs");
      // 回执措辞(events 的 tool_finished 带工具回执原文)。
      const events = eventsFile(dataDir, created.id);
      assert.match(events, /请立即结束本回合,等待用户补配或拒绝/,
        `${tier} 档:举卡回执统一收口措辞`);
      assert.ok(!events.includes("等待期间可继续"),
        `${tier} 档:「等待期间可继续」例外退役`);
      assert.ok(!events.includes("介入档位不向用户索取环境"),
        `${tier} 档:一/二档降级回执与转移账留痕退役`);
      // 永不代答守卫不回归:环境配置卡任何档位不等代答,收口后原地
      // 等真人(代答是收口后的旁路,睡过窗口还在等就是真等人)。
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(service.get(created.id).status, "waiting_user",
        `${tier} 档:环境配置卡永不代答`);
      assert.ok(!eventsFile(dataDir, created.id)
        .includes("介入档位免审批"), `${tier} 档:无代答留痕`);
    } finally {
      await service.shutdown().catch(() => undefined);
      await model.stop();
    }
  }
});

test("直调三档:request_env 回执同款收口措辞;硬拒绝(票 93)优先级不变", async () => {
  for (const tier of ["1", "2", "3"] as const) {
    const state = envGateState();
    const tools = createIssueTools(envGateCtx(tier, state)) as Array<{
      name: string;
      execute: (id: string, params: any) => Promise<unknown>;
    }>;
    const requestEnv = tools.find((tool) => tool.name === "request_env")!;
    const raised = await requestEnv.execute("x", {}) as {
      content: Array<{ type: string; text: string }>;
    };
    const receipt = raised.content[0]?.text ?? "";
    assert.equal(state.gate?.kind, "env_needed", `${tier} 档:卡已举起`);
    assert.match(receipt, /请立即结束本回合,等待用户补配或拒绝/,
      `${tier} 档:回执统一收口措辞`);
    assert.doesNotMatch(receipt, /等待期间可继续|介入档位不向用户索取环境/,
      `${tier} 档:旧措辞退役`);
    assert.ok(!(state.transitions ?? []).some((entry) =>
      entry.note.includes("介入档位不向用户索取环境")),
    `${tier} 档:降级转移账留痕退役`);
    // 幂等分支保留:卡已在场时再调不覆盖闸、不换 gate id。
    const again = await requestEnv.execute("y", {}) as {
      content: Array<{ type: string; text: string }>;
    };
    assert.match(again.content[0]?.text ?? "", /已有一张网管环境配置卡/,
      `${tier} 档:幂等回报保留`);
    assert.equal(state.gate?.kind, "env_needed");
  }
  // 硬拒绝在先(票 93):拒绝台账在场,任何档位照旧如实失败不举卡。
  for (const tier of ["1", "2", "3"] as const) {
    const state = envGateState();
    state.env_declined = { scopes: ["logs"], at: new Date().toISOString() };
    const tools = createIssueTools(envGateCtx(tier, state)) as Array<{
      name: string;
      execute: (id: string, params: any) => Promise<unknown>;
    }>;
    const requestEnv = tools.find((tool) => tool.name === "request_env")!;
    await assert.rejects(
      () => requestEnv.execute("x", {}),
      /用户已确认无需此操作/,
      `${tier} 档:硬拒绝赢过档位,不再举卡纠缠`);
    assert.equal(state.gate, undefined, `${tier} 档:拒绝在场不举卡`);
  }
});

test("提示层四段:一/二档开场与续聊改为举配置卡即停,三档文案不动", () => {
  const state = {
    id: "issue-1", scenario: "ticket", stage: "analyze",
    title: "登录超时", description: "", account: "dev", ticket: TICKET,
  } as unknown as IssueSessionState;
  for (const tier of ["1", "2"] as const) {
    const opening = issueFixedOpeningPrompt(state, {}, { tier });
    assert.match(opening, /缺网管环境时调 request_env 举环境配置卡/,
      `${tier} 档开场:举配置卡口径在场`);
    assert.match(opening, /结束本回合等待用户补配或拒绝/,
      `${tier} 档开场:举卡即停`);
    assert.doesNotMatch(opening,
      /环境缺口写进报告|不发起环境配置请求|不发起配置请求/,
      `${tier} 档开场:旧劝阻口径退役`);
    const resume = issueResumePrompt(state, "继续", {}, { tier });
    assert.match(resume, /缺网管环境时调 request_env 举环境配置卡/,
      `${tier} 档续聊:举配置卡口径在场`);
    assert.match(resume, /结束本回合等待/,
      `${tier} 档续聊:举卡即停`);
    assert.doesNotMatch(resume,
      /环境缺口写进报告|不发起环境配置请求|不发起配置请求/,
      `${tier} 档续聊:旧劝阻口径退役`);
  }
  // 三档文案不动:对齐档的介入节奏不举配置卡口径(阶段简报的工具
  // 清单与本断言无关——那里本来就列 request_env)。
  assert.doesNotMatch(issueFixedOpeningPrompt(state, {}, { tier: "3" }),
    /缺网管环境时调 request_env|环境配置卡/, "三档开场不受影响");
  assert.doesNotMatch(issueResumePrompt(state, "继续", {}, { tier: "3" }),
    /缺网管环境时调 request_env|环境配置卡/, "三档续聊不受影响");
});

test("档位中途切换:已挂起的卡不追溯代答(只在卡落地时判定)", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    } } },
    { text: "按推荐处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const dataDir = mfcTemp("mfc-issue-tier-retro-");
  // 档位做成可翻转的:卡落地时三档对齐,落地后切一档——追溯与否看这张测试。
  let tier: "1" | "3" = "3";
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => tier,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "三档对齐:卡落地等真人");
    // 现读现判的边界:档位切换只对后续到达的卡生效,已挂起的卡不追溯
    // 代答(与需求流同口径——代答只发生在卡到达的那一刻)。
    tier = "1";
    await new Promise((resolve) => setTimeout(resolve, 400));
    const [record] = waitingRecords(dataDir, created.id);
    assert.equal(record.status, "waiting", "已挂起的卡不被追溯代答");
    assert.equal(record.decision, "", "没有任何答案被冒名提交");
    assert.doesNotMatch(
      eventsFile(dataDir, created.id), /介入档位免审批自动作答/,
      "追溯代答会留痕,现场账必须干净");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
