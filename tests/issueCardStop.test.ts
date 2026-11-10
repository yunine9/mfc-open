/**
 * 举卡即收口的机械兜底契约测试(票 #573,ADR-0019 2026-10-31 增补·
 * 六卡一规则):
 * - 同回合举卡(平台闸或 Agent 问题卡)后,再调平台工具一律机械拦下,
 *   回执是纠偏文案(「这不是出错,是流程」),不是报错口吻;
 * - submit_analysis 在环境卡举起后被拦:报告卡顶掉环境卡从机制上不可能;
 * - bash/读文件等非平台工具不受拦(模型可安静收口);
 * - 「本回合已举卡」按回合清零:卡跨回合挂起时,#350 检视意见送达开的
 *   回合、收口后验证等待中的返工回合,平台工具照常可用;
 * - 标记是内存态:盘上不落字段(进程重启天然归零);
 * - skill_select 旧专支收编进通用分支:存量圈选闸挂起时平台工具照旧
 *   被拦,作答清闸后的新回合照常可用;
 * - 催办不死循环:被拦收口后闸在场即定格等待,不烧催办预算。
 *
 * 范式与 issuePushBranch / issueInterventionTiers 同款:ScriptedModelServer
 * 剧本 + IssueFlowService 公开 API + createIssueTools 直调,只测外部行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import type { IssueFlowOptions } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";

/** 分析报告四章节的最小合格正文(submit_analysis 的门票)。 */
const REPORT_BASH =
  "printf '# 问题分析\\n\\n一句话结论。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 修改方案\\n超时回收。\\n## 置信度\\n高。\\n' > issue-analysis.md";

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

function baseOptions(dataDir: string, model: ScriptedModelServer)
  : IssueFlowOptions {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 三档整卡等人:Agent 问题卡不被档位代答,剧本时序确定。
    interventionTier: () => "3",
  };
}

/** 盘上种子一个固定流程会话(必须在构造服务之前)。patch 覆写
 *  状态/闸等现场差异。缺省形态:analyze 进行中、running(构造即续跑)。 */
function seedIssue(
  dataDir: string,
  patch: Record<string, unknown> = {},
): { id: string } {
  const now = new Date().toISOString();
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev", created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts", ticket: TICKET,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
    ...patch,
  }));
  return { id: "issue-1" };
}

function readStateFile(dataDir: string, id: string): IssueSessionState {
  return JSON.parse(readFileSync(
    join(dataDir, "issues", id, "issue.json"), "utf-8")) as IssueSessionState;
}

/** 某工具的全部回执(事件账里的成败与原文)。 */
function receiptsOf(dataDir: string, id: string, tool: string): Array<{
  is_error?: boolean;
  result?: string;
}> {
  return readFileSync(join(dataDir, "issues", id, "events.jsonl"), "utf-8")
    .split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, any>)
    .filter((event) => event.kind === "tool_finished"
      && event.payload?.name === tool)
    .map((event) => event.payload);
}

/** 造一张挂起中的平台闸(种子现场用,形状对齐 raiseGate 的产物)。 */
function seededGate(kind: string, extra: Record<string, unknown> = {}) {
  return {
    id: `gate-seed-${kind}`, kind, state_version: 1,
    created_at: new Date().toISOString(),
    question: { questions: [{ question: "等待用户作答", options: [] }] },
    ...extra,
  };
}

// ---- 同回合机械拦 + 非平台工具不拦 + 催办有边界 ----

test("同回合举环境卡后平台工具机械拦下,回执纠偏;bash 不拦;收口定格等待不烧催办", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-env-");
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { tool: { name: "report_ut", input: { passed: true, summary: "强行上报" } } },
    { tool: { name: "bash", input: { command: "echo 整理结论" } } },
    { tool: { name: "complete_stage", input: { note: "强行推进" } } },
    { text: "已知悉,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_needed" ? issue : undefined;
    }, "举卡后收口定格等待");
    assert.equal(waiting.gate?.scope, "logs");
    // report_ut:阶段开放的工具,被标记拦下——回执是纠偏,不是阶段门禁。
    const ut = receiptsOf(dataDir, created.id, "report_ut")[0];
    assert.equal(ut.is_error, true, "举卡后同回合平台工具被拦");
    assert.match(String(ut.result), /已举起一张卡/, "回执说明卡在等");
    assert.match(String(ut.result), /不是出错/, "回执是纠偏口吻,不是报错");
    assert.match(String(ut.result), /结束本回合/, "回执指路:结束回合等待");
    // complete_stage:守卫在阶段门禁之前——拦的是卡,不是阶段。
    const complete = receiptsOf(dataDir, created.id, "complete_stage")[0];
    assert.equal(complete.is_error, true);
    assert.match(String(complete.result), /已举起一张卡/);
    assert.doesNotMatch(String(complete.result), /不开放/,
      "先拦卡,不落到阶段门禁文案");
    // bash 等非平台工具不走平台咽喉:照常执行,模型可安静收口。
    // (事件账里内核工具名是大写开头:模型侧叫 bash,账上叫 Bash。)
    const bash = receiptsOf(dataDir, created.id, "Bash")[0];
    assert.ok(bash, "bash 回执在场");
    assert.equal(bash.is_error, false, "非平台工具不受拦");
    // 催办边界:闸在场,收口定格等待,不进催办续跑。
    await new Promise((resolve) => setTimeout(resolve, 400));
    const settled = service.get(created.id);
    assert.equal(settled.status, "waiting_user", "闸在场定格等待,不死循环");
    const onDisk = readStateFile(dataDir, created.id);
    assert.ok(!onDisk.nudges, "没有烧催办预算");
    // 标记是内存态:盘上不落字段。
    assert.ok(!JSON.stringify(onDisk).includes("cardRaisedInTurn"),
      "回合标记不落盘(进程重启天然归零)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("submit_analysis 在环境卡举起后被拦:报告卡顶掉环境卡机制上不可能", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-crown-");
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { tool: { name: "bash", input: { command: REPORT_BASH } } },
    { tool: { name: "submit_analysis",
      input: { summary: "缺环境也要强行出报告" } } },
    { text: "被拦,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "回合收口");
    // 核心验收:环境卡原地等人,报告卡没有顶掉它(哪怕报告四章节齐全)。
    const issue = service.get(created.id);
    assert.equal(issue.gate?.kind, "env_needed", "环境卡不被顶掉");
    const submit = receiptsOf(dataDir, created.id, "submit_analysis")[0];
    assert.equal(submit.is_error, true, "submit_analysis 被机械拦下");
    assert.match(String(submit.result), /已举起一张卡/);
    const onDisk = readStateFile(dataDir, created.id);
    assert.equal(onDisk.gate?.kind, "env_needed");
    assert.ok(!(onDisk.transitions ?? []).some((entry) =>
      /平台举闸:问题分析报告/.test(entry.note ?? "")),
      "没有落「报告确认」举闸账——顶卡动作从未发生");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 标记按回合清零:两个既有拍板不误伤 ----

test("#350 检视意见送达回合不误伤:环境卡跨回合挂起,分诊回合平台工具照常可用", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-triage-");
  const script: Scene[] = [
    { tool: { name: "report_ut", input: { passed: true, summary: "分诊回合里照常用平台工具" } } },
    { text: "意见已处理,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 种子现场:环境卡挂起等真人(上一回合举的),检视意见此时送达。
  const created = seedIssue(dataDir, {
    status: "waiting_user",
    gate: seededGate("env_needed", { scope: "logs" }),
  });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.addReview(created.id, {
      line: 1, anchor: "旧结论", note: "验证等待中的检视意见:先看这条",
    });
    service.submitReviews(created.id);
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "分诊回合收口");
    // 平台工具在新回合照常可用(标记按回合清零,不按闸在场跨回合拦)。
    const ut = receiptsOf(dataDir, created.id, "report_ut")[0];
    assert.equal(ut.is_error, false, "分诊回合平台工具可用(#350 不误伤)");
    assert.match(String(ut.result), /UT 结果已记录/);
    const issue = service.get(created.id);
    assert.equal(issue.gate?.kind, "env_needed", "环境卡保持原样继续等真人");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("收口后返工回合不误伤:验证等待中用户插话开的回合,平台工具照常可用", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-rework-");
  const script: Scene[] = [
    { tool: { name: "report_ut", input: { passed: true, summary: "返工回合里照常用平台工具" } } },
    { text: "冲突已处理,继续等验证。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 种子现场:mr_green 已收口、验证卡挂起(任何人档位都举的出口卡)。
  const created = seedIssue(dataDir, {
    stage_states: ["done", "done", "done", "done", "done"],
    stage: "mr_green", status: "waiting_user",
    gate: seededGate("env_verify"),
    mrs: [],
  });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 用户在验证卡上自定义答复(归「插话」):闸保持原样,开回合把话递给 AI。
    service.answer(created.id, {
      state_version: 1,
      decision: "MR 冒出合并冲突,先处理一下再等合入",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" ? issue : undefined;
    }, "插话回合收口");
    const ut = receiptsOf(dataDir, created.id, "report_ut")[0];
    assert.equal(ut.is_error, false, "返工回合平台工具可用(不误伤)");
    const issue = service.get(created.id);
    assert.equal(issue.gate?.kind, "env_verify", "验证卡保持原样继续等真人");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- skill_select 旧专支收编:存量圈选闸的跨回合拦截原样保留 ----

test("存量 skill_select 圈选闸挂起:分诊回合平台工具照旧被拦,作答清闸后新回合照常可用", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-skill-");
  const script: Scene[] = [
    // 分诊回合:圈选闸挂起,complete_stage 照旧被拦(收编前由 gateStage
    // 专支拦,收编后由「本回合已举卡」的存量种子拦,行为等价)。
    { tool: { name: "complete_stage", input: { note: "想强行推进" } } },
    { text: "被拦,先等圈选。" },
    // 作答清闸后的新回合:平台工具照常可用,报告照常提交。
    { tool: { name: "bash", input: { command: REPORT_BASH } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir, {
    status: "waiting_user",
    gate: seededGate("skill_select", {
      skills: [{
        path: "repo/origin/.cac/skills/login-triage/SKILL.md",
        repo: "/tmp/origin.git", name: "login-triage", description: "登录链路排障",
      }],
    }),
  });
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    service.addReview(created.id, {
      line: 1, anchor: "旧结论", note: "圈选等待中的检视意见",
    });
    service.submitReviews(created.id);
    // ① 分诊回合:平台工具被拦,阶段不动,闸原样。
    await until(() => {
      const issue = service.get(created.id);
      return issue.status === "waiting_user" ? issue : undefined;
    }, "分诊回合收口");
    const blocked = receiptsOf(dataDir, created.id, "complete_stage")[0];
    assert.equal(blocked.is_error, true, "存量圈选闸挂起:平台工具照旧被拦");
    assert.match(String(blocked.result), /已举起一张卡/, "走统一纠偏文案");
    const triaged = readStateFile(dataDir, created.id);
    assert.equal(triaged.stage, "analyze", "被拦回合没有推进阶段");
    assert.equal(triaged.gate?.kind, "skill_select", "闸保持原样");
    // ② 作答清闸:新回合平台工具照常可用(种子只在闸在场时置位)。
    service.answer(created.id, { state_version: 1, selection: [] });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "作答后新回合照常提交报告");
    const submit = receiptsOf(dataDir, created.id, "submit_analysis")[0];
    assert.equal(submit.is_error, false, "清闸后的新回合平台工具可用");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- Agent 问题卡:落卡即置标记,作答开新回合标记清零 ----

test("Agent 问题卡落地后作答开新回合:平台工具照常可用(标记不跨回合)", async () => {
  const dataDir = mfcTemp("mfc-issue-cardstop-agent-");
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "先按哪个思路排查?",
        options: ["先看线程池", "先看连接池"],
        recommended: "先看连接池",
      }],
    } } },
    { tool: { name: "bash", input: { command: REPORT_BASH } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "报告已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const created = seedIssue(dataDir);
  const service = new IssueFlowService(baseOptions(dataDir, model));
  try {
    // 卡落地:回合停在问题上(卡即收口),单卡互斥照旧。
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "Agent 问题卡落地");
    // 作答:answer() 开新回合(标记清零),平台工具照常可用。
    service.answer(created.id, {
      state_version: waiting.waiting!.state_version,
      answers: { "0": "opt-0-0" },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "作答后的新回合照常提交报告");
    const submit = receiptsOf(dataDir, created.id, "submit_analysis")[0];
    assert.equal(submit.is_error, false,
      "作答开的新回合里平台工具不被上一回合的卡误伤");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 直调矩阵:标记置位后所有平台工具一律拦;缺席(裸构造)不拦 ----

/** 直调现场:mr_green 阶段(交付工具最全),标记可指定。 */
function directTools(raised: { value: boolean }): {
  state: IssueSessionState;
  find: (name: string) => {
    execute: (id: string, params: any) => Promise<unknown>;
  };
} {
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-direct", account: "dev", created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/origin.git", repo_urls: ["/tmp/origin.git"],
    baseline: "master", fix_branch: `master_dev_${TICKET}_20261030090000`,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "running", stage: "mr_green", stage_note: "", stage_at: now,
  } as unknown as IssueSessionState;
  const ctx: IssueToolContext = {
    state,
    workspace: "/tmp/ws-cardstop", dataRoot: "/tmp/data-cardstop",
    persist: () => undefined,
    environmentPassword: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
    // 服务侧同款接线:平台闸举起由工具层置位,Agent 问题卡落卡由
    // service 的 beforeHumanQuestion 置位——直调用同一对回调。
    turnCardRaised: () => raised.value,
    markTurnCardRaised: () => { raised.value = true; },
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  return { state, find: (name) => tools.find((tool) => tool.name === name)! };
}

test("直调矩阵:举卡置位后所有平台工具一律拦(回执统一纠偏);raise_gate 走既有互斥", async () => {
  const raised = { value: false };
  const { state, find } = directTools(raised);
  // 举卡:request_env 落环境卡并置位本回合标记。
  await find("request_env").execute("c0", {});
  assert.equal(state.gate?.kind, "env_needed", "卡已举起");
  assert.equal(raised.value, true, "举卡即置位(平台闸路径)");
  // 平台工具(走阶段门禁咽喉的全部 + 不走阶段门禁的 request_env):
  // 一律机械拦下,回执统一纠偏文案。
  const platformTools: Array<[string, Record<string, unknown>]> = [
    ["complete_stage", { note: "强行推进" }],
    ["submit_analysis", { summary: "强行出报告" }],
    ["push_branch", {}],
    ["create_mr", {}],
    ["build_deploy", { include_lib: false }],
    ["pull_repo", { url: "/tmp/origin.git" }],
    ["remove_repo", { repo: "/tmp/origin.git" }],
    ["report_ut", { passed: true, summary: "强行上报" }],
    ["request_env", {}],
  ];
  for (const [name, params] of platformTools) {
    await assert.rejects(
      () => find(name).execute("c1", params),
      (error: Error) => {
        assert.match(error.message, /已举起一张卡/,
          `${name}:统一纠偏文案`);
        assert.match(error.message, /不是出错/, `${name}:纠偏不是报错口吻`);
        return true;
      },
      `${name}:举卡后被机械拦下`);
  }
  // raise_gate 不进通用拦截,但既有单卡互斥照旧拒举(平台闸在场)。
  await assert.rejects(
    () => find("raise_gate").execute("c2", { kind: "env_verify" }),
    /已有一张平台闸/,
    "raise_gate 走既有单卡互斥,不叠卡");
});

test("直调兼容:标记回调缺席(裸构造)不拦——举卡后工具行为与收编前一致", async () => {
  // 裸构造(不带标记回调,与 pendingAgentCard 缺席同款兼容口径)。
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-bare", account: "dev", created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
  } as unknown as IssueSessionState;
  const ctx: IssueToolContext = {
    state,
    workspace: "/tmp/ws-bare", dataRoot: "/tmp/data-bare",
    persist: () => undefined,
    environmentPassword: () => undefined,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const find = (name: string) => tools.find((tool) => tool.name === name)!;
  const receipt = await find("request_env").execute("c0", {}) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.equal(state.gate?.kind, "env_needed");
  assert.match(receipt.content[0]?.text ?? "", /请立即结束本回合/);
  // 无标记回调=平台无从知晓「本回合已举卡」:不拦(与改造前一致)。
  const ut = await find("report_ut").execute("c1",
    { passed: true, summary: "裸构造照常" }) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.match(ut.content[0]?.text ?? "", /UT 结果已记录/,
    "回调缺席不拦,裸构造兼容");
});
