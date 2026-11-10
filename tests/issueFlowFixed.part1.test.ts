/**
 * issue 流固定流程长轴 part 1/2(共 42 用例,约 67s)。
 * 共享夹具在 tests/issueFlowFixed.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { listAnalysisVersions } from "../src/issueFlow/analysisVersions.ts";
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

import {
  GIT_ENV,
  bareOrigin,
  MODULE_ID,
  seedModule,
  NO_TICKET_ENV,
  until,
  fastPoll,
  fakeOps,
  TICKET,
  BRANCH,
  LoopPlatform,
  fixedState,
  metaState,
  META_CREDENTIALS,
  seedMrGreenWatch,
  rearmMrGreenWatch,
  assertRepairDispatched,
  TRUNCATED_TOOL_BASH,
  seedGreenWatch,
  headSha,
} from "./issueFlowFixed.helpers.ts";

test("固定流程有单全链:拉单→分析闸→修改→UT→MR 红转绿收口→发现问题回退→二轮再收口", async () => {
  const dataDir = mfcTemp("mfc-issue-fixed-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform();
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    // 第 1 回合:阶段门禁探针(换库部署在拉单阶段必须被拒)→ 拉单 →
    // complete_stage 自报收口(拉单不再机械推进)→ AI 自己拉仓 →
    // complete_stage 收口(拉仓不再机械推进)→ 写报告 → 提交举闸。
    { tool: { name: "build_deploy", input: { include_lib: false } } },
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    // 第 2 回合(用户确认报告):提交修复 → UT 上报(只记账,仍在
    // 修复段)→ 自报修复完成(UT 并入本阶段)→ 推送 → 建 MR →
    // complete_stage 申报 MR 清单(在跑→受理等绿)。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "12/12 通过" } } },
    { tool: { name: "complete_stage", input: { note: "连接池超时回收已实现,UT 12/12 通过" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等待流水线。" },
    // 第 3 回合(流水线红了,平台携失败项开回合):修复 → 同分支再推 →
    // 再建 MR → 重新申报。
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 补充修复告警`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 重新申报", mrs: [origin] } } },
    { text: "已修复再推,等待流水线。" },
    // 第 4 回合(#246 绿灯切换):流水线全绿+已申报,监看器收口只发送
    // 全绿事实开回合——AI 经 raise_gate 举验证卡(平台不再代举)。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户在环境验证。" },
    // 第 5 回合(用户验证发现问题,回退问题分析):二轮分析 → 重新举闸。
    { tool: { name: "bash", input: { command:
      "printf '\\n## 第二轮\\n\\n根因修正:回收策略缺竞态保护。\\n' >> issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "二轮:回收策略缺竞态保护" } } },
    { text: "第二轮分析已提交。" },
    // 第 6 回合(二轮确认):改完 → UT 上报 → 自报修复完成 → 推 → MR → 申报。
    { tool: { name: "report_ut", input: { passed: true, summary: "15/15 通过" } } },
    { tool: { name: "complete_stage", input: { note: "竞态保护补丁,二轮 UT 15/15 通过" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 回收竞态保护`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "二轮 MR 已申报", mrs: [origin] } } },
    { text: "二轮修复已提交,等待流水线。" },
    // 第 7 回合(二轮流水线绿,#246):监看器收口发送全绿事实——AI 举卡。
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待验证。" },
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
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      baseline: "br_V100R026C10_release",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    assert.equal(created.scenario, "ticket", "有单登记烙 ticket 场景");
    assert.equal(created.stage, "dts_info");
    // 首阶段登记即 in_progress(进度条当前节点必须亮),其余 pending。
    assert.deepEqual(created.stage_states,
      FIXED_TICKET_STAGES.map((_, index) =>
        index === 0 ? "in_progress" : "pending"));

    // ① 报告确认闸:AI 提交分析后必须停下等用户。
    const gate1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "首轮分析确认闸");
    assert.ok(gate1.has_analysis, "submit_analysis 以报告在场为门票");
    assert.equal(gate1.stage, "analyze", "确认前必须停在分析阶段");
    // 门禁探针:换库部署在拉单阶段被拒,且说了人话。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const probe = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .find((event) => event.kind === "tool_finished"
        && event.payload?.name === "build_deploy");
    assert.ok(probe, "门禁探针调用应入事件账");
    assert.equal(probe.payload.is_error, true);
    assert.match(String(probe.payload.result), /阶段门禁/);

    // ② 确认报告 → 进问题修改;宿主在阶段2建好的分支应该在场。
    service.answer(created.id, {
      state_version: gate1.gate!.state_version,
      code: "confirm",
    });
    // 闸作答补记 human_decision 入事件账:CONTEXT 对"现场记录"的定义含
    // 用户决策,过程问答(事件投影)里固定流程的关键问答不能缺用户半句。
    const eventsAfterAnswer = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const gateDecision = eventsAfterAnswer.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "human_decision").at(-1);
    assert.ok(gateDecision, "闸作答应补记 human_decision 入事件账");
    assert.match(String(gateDecision.payload?.decision), /确认报告/);
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "修改+UT+推送+MR 回合收口");
    const fixing = service.get(created.id);
    assert.equal(fixing.stage_states?.[3], "done", "问题修复完成(UT 并入)");
    assert.equal(fixing.stage_states?.[4], "in_progress", "MR 跑绿进行中");
    assert.equal(fixing.pushes?.length, 1, "修复分支已推送(按仓记账)");
    assert.equal(fixing.pushes?.[0]?.repo, origin);
    assert.equal(fixing.mrs?.length, 1, "MR 已创建(按仓记账)");
    const firstMrUrl = fixing.mrs?.[0]?.url;
    const firstPushSha = fixing.pushes?.[0]?.sha;
    const branchNow = spawnSync("git",
      ["-C", join(dataDir, "issues", created.id, "repo", "origin"), "branch", "--show-current"],
      { encoding: "utf-8" });
    const fixBranch = loadState(join(dataDir, "issues", created.id))?.fix_branch;
    assert.match(fixBranch ?? "",
      new RegExp(`^br_V100R026C10_release_dev_${TICKET}_\\d{14}$`),
      "修复分支命名=基线_工号_单号_时间戳(ADR-0063)");
    assert.equal(branchNow.stdout.trim(), fixBranch,
      "pull_repo 时宿主切的就是会话定名的修复分支");

    // ③ 流水线红→AI 修→再推→绿:全由宿主监看驱动,绿了自动收口
    // (ADR-0013:流程终点=MR 跑绿,收口后等用户归档)。
    const closed1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "一轮:流水线红转绿后收口,举环境验证闸");
    assert.equal(closed1.stage, "mr_green", "收口在终点阶段");
    assert.match(closed1.stage_note ?? "", /环境验证/);
    assert.equal(closed1.pipelines?.[origin]?.status, "success", "监看账应记全绿");
    assert.equal(closed1.mrs?.[0]?.url, firstMrUrl,
      "流水线反馈修复后必须更新同一个 MR，不能另建一张");
    assert.deepEqual(closed1.feedback?.map((item) => ({
      source: item.source,
      status: item.status,
      observed_sha: item.observed_sha,
    })), [{
      source: "pipeline",
      status: "closed",
      observed_sha: firstPushSha,
    }], "Issue Flow 建 MR 后也用统一反馈索引，并由新 HEAD 流水线闭环");
    const failedRound = platform.seen.filter((entry) =>
      entry.method === "POST" && entry.url === "/pipeline/trigger").length;
    assert.ok(failedRound >= 2, "红过一轮就要有第二轮触发(同 MR 修复再推)");
    // MR 标题平台代笔(2026-09-07):每次建 MR 的标题都=DTS 单据标题,
    // 精确相等——登记标题("登录超时")与 [单号] 前缀都不许出现。
    for (const entry of platform.seen.filter((e) => e.url === "/mr")) {
      assert.equal(entry.body?.title,
        "【DEV·模拟】订单列表导出超时(数据量大时必现)");
    }
    // 红灯取证:平台失败产物已镜像进会话工作区 pipeline/,修复回合的
    // 指令里点名了它——AI 读全文修,不是只啃 1500 字摘要。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      "pipeline", "build.log")), "红灯产物应镜像到会话工作区");
    assert.match(JSON.stringify(model.requests), /失败产物全文已镜像/,
      "修复回合指令应指引 AI 读镜像产物");

    // ④ 验证发现问题(ADR-0043 后绿后返工的唯一入口——通过无需作答,
    // 合入即通过自动归档,「验证通过后再续聊返工」的重开路已退役):
    // 整体回退问题分析、轮次+1;二轮分析重新举闸,确认后修复重推,
    // 同 MR 更新后再申报再收口(再次举验证闸)。
    const shaBefore = closed1.pushes![0].sha;
    service.answer(created.id, {
      state_version: closed1.gate!.state_version, code: "fail",
      notes: "并发场景仍偶发超时",
    });
    // 打回也是报告重写的来源(ADR-0045):回退前旧报告先冻结成版本,
    // 二轮重写后 live 即新版,失败前后可对照。
    const snapshotsAfterFail = existsSync(join(dataDir, "issues", created.id, "reviews"))
      ? readdirSync(join(dataDir, "issues", created.id, "reviews"))
        .filter((name) => name.startsWith("issue-analysis@")).length
      : 0;
    assert.equal(snapshotsAfterFail, 1, "验证打回时应冻结打回前的报告快照");
    const secondAnalysis = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "发现问题回退,二轮分析举闸");
    assert.equal(secondAnalysis.stage, "analyze", "回退到问题分析");
    assert.equal(secondAnalysis.round, 2, "回退轮次+1");
    assert.equal(secondAnalysis.stage_states?.[4], "redo", "mr_green 标重做");
    assert.deepEqual(
      listAnalysisVersions(join(dataDir, "issues", created.id))
        .map((entry) => entry.name),
      ["初版", "修订1"],
      "二轮重写后版本页签=冻结的打回前版+重写版");
    service.answer(created.id, {
      state_version: secondAnalysis.gate!.state_version, code: "confirm",
    });
    const reopenedRound2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "二轮再申报后再次收口(再次举验证闸)");
    assert.equal(reopenedRound2.round, 2, "二轮收口轮次账不动");
    assert.equal(reopenedRound2.mrs?.[0]?.url, firstMrUrl,
      "二轮修复仍延用同一 MR");
    assert.ok(reopenedRound2.pushes![0].sha !== shaBefore,
      "二轮产生新推送(同分支追加)");

    // ⑤ 归档出口=合入即自动归档(ADR-0034):本桩无合入事实端点,
    // 全链的合入→自动归档结论由 issueMergeFact 覆盖;此处收在二轮
    // 验证卡在场的等待现场。登记元信息进上下文(ADR-0003):网管口令
    // 是现场公开默认值,明文随元信息块出现;平台凭据(git 令牌)的
    // 铁律不变。
    assert.equal(reopenedRound2.gate?.kind, "env_verify", "二轮验证卡在场");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /env-shared-secret/);
    assert.doesNotMatch(requestText, /git-token/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("固定流程无单闭环:结论是问题→直接归档出提单模板(ADR-0048);结论非问题→直接归档留报告", async () => {
  const dataDir = mfcTemp("mfc-issue-noticket-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(索引缺失导致全表扫描)。\\n## 置信度\\n高:执行计划直接指向。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论是问题,已提交等用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.equal(created.scenario, "no_ticket", "无单登记=无单三节点");
    assert.equal(created.stage, "prep_repo");
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸");
    assert.equal(gate.gate?.proposal?.conclusion, "issue");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "issue",
    });
    // ADR-0048:确认是问题直接闭环归档,不再挂起;报告与提单模板都
    // 留在会话目录(过程记录,永不回收)。
    const archived = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "archived" ? issue : undefined;
    }, "确认是问题直接归档");
    assert.equal(archived.stage_states?.[2], "done", "确定结论节点完成");
    assert.equal(archived.conclusion?.kind, "issue");
    assert.ok(existsSync(join(dataDir, "issues", created.id, "issue-analysis.md")),
      "非交付收口也要留分析报告");
    const template = readFileSync(
      join(dataDir, "issues", created.id, "issue-ticket-template.md"), "utf8");
    assert.match(template, /单据标题:列表导出超时/, "模板带单据标题");
    assert.match(template, /是问题\(索引缺失导致全表扫描\)/, "「参考:问题根因」抠自分析报告");
    assert.match(template, /补索引/, "「参考:修改方案」抠自分析报告");
    assert.match(template, /不应直接采信/, "防采信说明随模板走");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("固定流程无单闭环:结论非问题,用户确认后自动归档", async () => {
  const dataDir = mfcTemp("mfc-issue-nonissue-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n非问题(测试环境时钟漂移)。\\n## 置信度\\n高:偏差可复现。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "非问题:时钟漂移误报" } } },
    { text: "结论非问题,等用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "疑似黑屏", repoUrl: origin,
      moduleId: MODULE_ID,
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    assert.ok(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)),
      "登记即落环境凭据(闭环断言的前置)");
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "非问题结论闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "non_issue",
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "archived" ? issue : undefined;
    }, "非问题自动闭环");
    assert.equal(archived.conclusion?.kind, "non_issue");
    assert.equal(existsSync(
      join(dataDir, ".issue-environments", `${created.id}.json`)), false,
      "闭环即清理环境凭据");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("举卡裁决协议化:闸卡带决策码,按码分派文案可变;旧文案不再是匹配键", async () => {
  const dataDir = mfcTemp("mfc-issue-verdict-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 会话 A:拉仓 → 自报收口 → 报告 → 举结论闸(顺序创建,不与 B 并发抢剧本)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n## 问题现象\\n演示现象。\\n## 问题根因:非问题(时钟漂移误报)。\\n## 置信度\\n高。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "时钟漂移误报" } } },
    { text: "A 卡已举出。" },
    // 会话 B:同样举结论闸;答旧文案回流分析(续跑回合收口:补充意见
    // 回合未到出口,还有两次催办才落 idle)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n## 问题现象\\n演示现象。\\n## 问题根因:非问题(时钟漂移误报)。\\n## 置信度\\n高。\\n## 修改方案\\n校时后观察,建议归档。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", summary: "时钟漂移误报" } } },
    { text: "B 卡已举出。" },
    { text: "B 按补充意见继续查证。" },
    { text: "B 继续查证(催办一)。" },
    { text: "B 继续查证(催办二)。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    seedModule(dataDir, origin);
    const concludeGate = async (title: string) => {
      const created = service.create({
        account: "dev", title, repoUrl: origin,
        moduleId: MODULE_ID, environment: NO_TICKET_ENV,
      });
      return until(() => {
        const issue = service.get(created.id);
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
          ? issue : undefined;
      }, `${title} 结论闸`);
    };
    // 闸卡选项自带码+文案对:码表投影自 stageRegistry,举卡方不手写文案。
    const gateA = await concludeGate("文案可变");
    const options = gateA.gate!.question.questions[0].options;
    assert.deepEqual(options.map((option) => option.code),
      ["issue", "non_issue", "supplement"], "闸卡选项必须携带决策码");
    assert.ok(options.every((option) => option.label.length > 0),
      "每个码都要有给人看的文案");
    // 推荐协议(ADR-0004):结论闸的推荐从 AI 提案派生——本会话提交的
    // 结论是非问题,推荐就是「非问题」码(同一 wire 键,与 Agent 卡同形)。
    assert.equal(gateA.gate!.question.questions[0].recommended, "non_issue",
      "结论推荐应跟随 AI 提案(non_issue)");

    // 改文案零协议后果:decision 传任意字(显示文案本就来自 API),
    // 裁决只认 code——文案与裁决彻底解耦。
    service.answer(gateA.id, {
      state_version: gateA.gate!.state_version,
      decision: "文案被改成了任意话,裁决不该看它",
      code: "non_issue",
    });
    await until(() =>
      service.get(gateA.id).status === "archived" ? 1 : undefined, "按码闭环");
    assert.equal(service.get(gateA.id).conclusion?.kind, "non_issue");

    // 旧文案不再是匹配键:只交文案不交码 → 不闭环,按补充意见回流分析。
    const gateB = await concludeGate("旧文案失效");
    service.answer(gateB.id, {
      state_version: gateB.gate!.state_version,
      decision: "确认非问题,闭环归档",
    });
    await until(() =>
      service.get(gateB.id).status === "idle" ? 1 : undefined,
      "无码答复按补充意见回流分析,续跑回合收口");
    assert.notEqual(service.get(gateB.id).status, "archived",
      "文本不是匹配键——旧命令式文案不触发任何裁决");
    assert.match(JSON.stringify(model.requests), /确认非问题,闭环归档/,
      "人话答复仍原样进续聊提示词(显示语义保留)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("确认是问题即闭环出提单模板(ADR-0048):直接归档不挂起,转正退役", async () => {
  const dataDir = mfcTemp("mfc-issue-assoc-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 无单会话走到结论闸(先自己拉仓,自报收口后分析阶段才开门)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(死锁)。\\n## 置信度\\n高。\\n## 修改方案\\n调整加锁顺序。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:死锁" } } },
    { text: "等用户确认。" },
    // 转正新会话的首轮(直接在问题修改阶段干活)。停机白名单生效后,
    // 阶段未到出口的裸文本收轮会被催办——这里以问题卡合法停机。
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复死锁'` } } },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "修复已就位(继承的分析报告在案),继续跑 UT 验证?",
      options: ["继续跑 UT", "先停"],
      recommended: "继续跑 UT",
    }] } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    // 结论闸等人作答:显式三档对齐(缺省二档会代答纯选项卡)。
    interventionTier: () => "3",
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "偶发死锁", repoUrl: origin,
      moduleId: MODULE_ID,
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "无单结论闸");
    service.answer(created.id, {
      state_version: gate.gate!.state_version,
      code: "issue",
    });
    // ADR-0048:确认是问题直接闭环归档——不再挂起,当场产出提单模板。
    const closed = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "archived" ? issue : undefined;
    }, "确认是问题直接归档");
    assert.equal(closed.conclusion?.kind, "issue",
      "确认是问题按 issue 结论闭环(ADR-0048)");
    const template = readFileSync(
      join(dataDir, "issues", created.id, "issue-ticket-template.md"), "utf8");
    assert.match(template, /单据标题:偶发死锁/, "模板带单据标题");
    assert.match(template, /是问题\(死锁\)/, "「参考:问题根因」从分析报告抠出正文");
    assert.match(template, /调整加锁顺序/, "「参考:修改方案」从分析报告抠出正文");
    assert.match(template, /不应直接采信/, "防采信说明随模板走,接单 AI 不盲信");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("阶段门禁单点(免模型):工具只在所属阶段开放;UT 并入修复不挡建 MR", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "T1",
    repo_url: "/tmp/x.git", repo_urls: ["/tmp/x.git"],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "in_progress", "pending"],
    status: "idle", stage: "fix", stage_note: "", stage_at: new Date().toISOString(),
    pushes: [{ repo: "/tmp/x.git", branch: "master_dev_T1",
      sha: "a".repeat(40), at: new Date().toISOString() }],
  };
  const ctx: IssueToolContext = {
    state: base,
    workspace: "/tmp/ws",
    dataRoot: "/tmp/data",
    persist: () => undefined,
    platformUrl: "http://platform.test",
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const byName = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `固定流程应注册 ${name}`);
    return tool!;
  };
  // 固定流程不注册 report_stage(阶段真相在宿主)。
  assert.equal(tools.some((tool) => tool.name === "report_stage"), false);
  assert.equal(tools.some((tool) => tool.name === "submit_analysis"), true);
  // fix 阶段:交付类工具(建 MR/推送)被阶段门禁拒,拒绝回执按注册表
  // 自动指路下一阶段(#373,ADR-0050);report_ut 在本阶段开放,complete_stage 是出口。
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    (error: Error) => /阶段门禁:create_mr/.test(error.message)
      && error.message.includes("允许的阶段:提交 MR·跑绿"),
    "fix 阶段建 MR 被拒,回执指路「提交 MR·跑绿」");
  await assert.rejects(() => byName("push_branch").execute("x", { branch: "master_dev_T1" }),
    (error: Error) => /阶段门禁:push_branch/.test(error.message)
      && error.message.includes("允许的阶段:提交 MR·跑绿"),
    "fix 阶段推送同样被拒,回执指路「提交 MR·跑绿」");
  // mr_green 阶段:没有 UT 记录不再挡建 MR(UT 降级为事实上报)——
  // 门禁放行,卡在机械前置(平台未配置),而不是任何 UT/阶段闸。
  base.stage = "mr_green";
  ctx.platformUrl = undefined;
  await assert.rejects(() => byName("create_mr").execute("x", {}),
    (error: Error) => !/阶段门禁|UT 门禁/.test(error.message),
    "没有 UT 记录也能建 MR(此处失败应因平台未配置)");
  // 换库部署只在 deploy_verify 开放。
  base.stage = "fix";
  await assert.rejects(() => byName("build_deploy").execute("x", { include_lib: false }),
    /阶段门禁/);
  // 门禁无旁路(#99):无场景阶段的存量现场一律按注册表打回,不再有
  // "无场景即放行"的旁路;拒绝文案报出允许的阶段。
  const orphan = createIssueTools({
    ...ctx,
    state: { ...base, scenario: undefined },
  }) as Array<{ name: string; execute: (id: string, params: any) => Promise<unknown> }>;
  const orphanTool = (name: string) => {
    const tool = orphan.find((item) => item.name === name);
    assert.ok(tool, `工具 ${name} 应注册`);
    return tool!;
  };
  await assert.rejects(
    () => orphanTool("push_branch").execute("x", { branch: "master_dev_T1" }),
    (error: Error) => error.message.includes("阶段门禁:push_branch")
      && error.message.includes("无(本场景流程不含该工具)"),
    "无场景的会话过不了门禁,拒绝文案照常报出允许的阶段");
  await assert.rejects(
    () => orphanTool("create_mr").execute("x", {}),
    /阶段门禁:create_mr/,
    "出口轴工具同样逃不过无场景的打回(闸不再按模式旁路)");
});


test("create_mr 标题平台代笔(2026-09-07):标题=DTS 单据标题;拿不到如实打回,不拿登记标题顶替", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "登录超时", description: "", source: "dts", ticket: "DTS-2026-1001",
    repo_url: "/tmp/x.git", repo_urls: ["/tmp/x.git"],
    baseline: "br_V100R026C10_release",
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "",
    stage_at: new Date().toISOString(),
    pushes: [{ repo: "/tmp/x.git", branch: "master_dev_DTS-2026-1001",
      sha: "a".repeat(40), at: new Date().toISOString() }],
  };
  const platform = new LoopPlatform();
  await platform.start();
  const byName = (dts: DtsGateway = new MockDtsGateway()) => {
    const tools = createIssueTools({
      state: base,
      workspace: "/tmp/ws",
      dataRoot: "/tmp/data",
      persist: () => undefined,
      dts,
      platformUrl: platform.baseUrl,
      pullRepo: async (url) => ({
        dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
      }),
    }) as Array<{ name: string; execute: (id: string, params: any) => Promise<unknown> }>;
    const tool = tools.find((item) => item.name === "create_mr");
    assert.ok(tool, "mr_green 阶段应注册 create_mr");
    return tool!;
  };
  try {
    // AI 即便自拟 title 也被无视:标题=单据标题,与会话登记标题
    // ("登录超时")无关、无 [单号] 前缀(CodeHub 精确相等)。
    await byName().execute("x", { title: "AI 自拟标题" });
    const mrBody = platform.seen.find((entry) => entry.url === "/mr")?.body;
    assert.equal(mrBody?.title,
      "【DEV·模拟】订单列表导出超时(数据量大时必现)");
    assert.equal(base.mrs?.[0]?.title,
      "【DEV·模拟】订单列表导出超时(数据量大时必现)",
      "台账记实际使用的标题");

    // 权威标题取不到(网关异常/单据标题为空)如实打回,绝不降级顶替;
    // 打回发生在碰交付平台之前,/mr 不该有第二笔。
    const broken: DtsGateway = {
      listByOwner: async () => [],
      detail: async () => { throw new Error("DTS 网关超时"); },
      proxyFile: async () => ({ data: Buffer.alloc(0), contentType: "text/plain" }),
    };
    await assert.rejects(() => byName(broken).execute("x", {}),
      (error: Error) => /权威标题/.test(error.message)
        && /DTS 网关超时/.test(error.message));
    const blank: DtsGateway = {
      listByOwner: async () => [],
      detail: async (ticket) => ({ ticket, title: "   ", content: "stub" }),
      proxyFile: async () => ({ data: Buffer.alloc(0), contentType: "text/plain" }),
    };
    await assert.rejects(() => byName(blank).execute("x", {}),
      (error: Error) => /权威标题/.test(error.message)
        && /单据标题为空/.test(error.message));
    assert.equal(platform.seen.filter((entry) => entry.url === "/mr").length, 1,
      "打回的两次都不能建出 MR");
  } finally {
    await platform.stop();
  }
});

test("create_mr 目标分支缺省=会话基线(#441):登记产品版本映射的基线优先,无基线维持 master", async () => {
  const platform = new LoopPlatform();
  await platform.start();
  const build = (baseline?: string) => {
    const base: IssueSessionState = {
      id: "issue-1", account: "dev",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      title: "登录超时", description: "", source: "dts", ticket: "DTS-2026-1001",
      repo_url: "/tmp/x.git", repo_urls: ["/tmp/x.git"],
      ...(baseline ? { baseline } : {}),
      scenario: "ticket", round: 1,
      stage_states: ["done", "done", "done", "done", "in_progress"],
      status: "idle", stage: "mr_green", stage_note: "",
      stage_at: new Date().toISOString(),
      pushes: [{ repo: "/tmp/x.git", branch: "master_dev_DTS-2026-1001",
        sha: "a".repeat(40), at: new Date().toISOString() }],
    };
    const tools = createIssueTools({
      state: base,
      workspace: "/tmp/ws",
      dataRoot: "/tmp/data",
      persist: () => undefined,
      dts: new MockDtsGateway(),
      platformUrl: platform.baseUrl,
      pullRepo: async (url) => ({
        dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
      }),
    }) as Array<{ name: string; execute: (id: string, params: any) => Promise<unknown> }>;
    const tool = tools.find((item) => item.name === "create_mr");
    assert.ok(tool, "mr_green 阶段应注册 create_mr");
    return tool!;
  };
  try {
    // 有基线:AI 不传 target_branch 也打向基线,不再静默落 master
    // (2026-09-27 现场:26C10 会话的修复 MR 被默认打到 master)。
    await build("br_V100R026C10_release").execute("x", {});
    assert.equal(platform.seen.find((entry) => entry.url === "/mr")?.body?.target_branch,
      "br_V100R026C10_release",
      "缺省目标=会话基线");
    // 无基线(直连接口/存量会话)如实拒绝,不猜目标。
    await assert.rejects(() => build(undefined).execute("x", {}),
      /会话没有基线分支/,
      "无基线不传参被拒,不静默落 master");
    // 显式传参仍然赢过缺省链(多目标交付是 AI 的裁量权,2026-08-28)。
    await build("br_V100R026C10_release").execute("x",
      { target_branch: "br_V100R025C00_release" });
    assert.equal(
      platform.seen.filter((entry) => entry.url === "/mr").at(-1)?.body?.target_branch,
      "br_V100R025C00_release");
    assert.equal(platform.seen.filter((entry) => entry.url === "/mr").length, 2,
      "被拒的那次不该建出 MR");
  } finally {
    await platform.stop();
  }
});


test("工读类放宽(2026-08-28):request_env 全程可调,dts_get_ticket 重查不倒转阶段", async () => {
  const base: IssueSessionState = {
    id: "issue-1", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "DTS-2026-1001",
    repo_url: "/tmp/x.git", scenario: "ticket", round: 1,
    stage_states: ["pending", "pending", "done", "done", "in_progress"],
    status: "idle", stage: "dts_info", stage_note: "", stage_at: new Date().toISOString(),
  };
  const ctx: IssueToolContext = {
    state: base,
    workspace: "/tmp/ws",
    dataRoot: "/tmp/data",
    persist: () => undefined,
    dts: new MockDtsGateway(),
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const byName = (name: string) => {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, `应注册 ${name}`);
    return tool!;
  };
  // request_env 在第一阶段(dts_info)不被阶段门禁拦——举配置卡是
  // 成功收口(2026-09-08:发起请求本身完成了,不再借错误通道,现场
  // 回执画 ✓),文案是配置请求,不是阶段门禁。
  const raised = await byName("request_env").execute("x", {}) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.match(raised.content[0]?.text ?? "", /已向用户发起网管环境配置请求/,
    "request_env 应全程开放;此处是配置请求,不是阶段许可");
  // 闸已在场:重复发起幂等回报,不覆盖闸(gate id 换了,页面卡与手机
  // 通知按 waiting_id 对账就成第二张卡)。
  const gateId = base.gate?.id;
  const again = await byName("request_env").execute("x", {}) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.match(again.content[0]?.text ?? "", /已有一张.*配置卡在等用户填写/);
  assert.equal(base.gate?.id, gateId, "重复发起不得覆盖闸");
  // dts_get_ticket 在 fix 阶段重查:内容照回,阶段不倒转,转移账留痕。
  base.stage = "fix";
  await byName("dts_get_ticket").execute("x", { ticket: "DTS-2026-1001" });
  assert.equal(base.stage, "fix", "重查单据不得把阶段倒回 prep_repo");
  assert.ok(base.transitions?.some((entry) =>
    /详情已获取/.test(entry.note)), "重查要留转移账");
});


test("个人凭据前置门禁:发起无条件要令牌与邮箱(2026-09-08),回调缺席裸构造放行", async () => {
  const dataDir = mfcTemp("mfc-issue-credgate-");
  const origin = bareOrigin(dataDir);
  const httpsRepo = "https://codehub.test/some/repo.git";
  const script: Scene[] = [{ text: "ok" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const base = {
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  } as const;
  const withCred = (mode: "none" | "no-email" | "full") => ({
    ...base,
    ...(mode === "none"
      ? { gitCredential: () => undefined }
      : mode === "no-email"
        ? { gitCredential: () => ({ username: "dev", password: "tok" }) }
        : { gitCredential: () => ({ username: "dev", password: "tok", email: "dev@example.com" }) }),
  });
  let service: IssueFlowService | undefined;
  try {
    // 无单登记要模块+环境(#17);模块绑的是本地裸仓,不触发凭据门禁,
    // 这里钉的始终是 Git 身份这道门。
    seedModule(dataDir, origin);
    // 无凭据 + 免仓有单发起:照样拒——这是 2026-09-08 升格的回归锚,
    // 拉仓是硬阶段,免仓不再是登记期放行的理由(门在发起按钮上)。
    service = new IssueFlowService(withCred("none"));
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
    }), /Git 令牌未配置.*个人设置/);
    // 无凭据 + https 仓:登记直接拒,指路个人设置(门在发起前,不在克隆后)。
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo,
    }), /Git 令牌未配置.*个人设置/);
    // 无单登记同样拦:带远端仓的会话,克隆一样要用发起人身份。
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", repoUrl: httpsRepo,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    }), /Git 令牌未配置/);
    await service.shutdown();

    // 令牌在而邮箱缺:提交署名无主,同样拦。
    service = new IssueFlowService(withCred("no-email"));
    assert.throws(() => service!.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo,
    }), /个人邮箱未配置.*个人设置/);
    await service.shutdown();

    // 令牌+邮箱齐:登记放行(克隆成败是后面回合的事,门禁只管身份在场)。
    service = new IssueFlowService(withCred("full"));
    const created = service.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001",
      repoUrl: httpsRepo,
    });
    assert.equal(created.scenario, "ticket", "登记放行即带固定流程场景");

    // 回调缺席=裸构造(测试世界无身份体系),按缺席即放行的既有纪律
    // 处理;生产接线(serve)恒注入回调,门恒生效。
    await service.shutdown();
    service = new IssueFlowService(base);
    // file:///本地路径仓:不碰远端,拉仓期的 requireGitIdentity 也放行
    // (逐仓复查只拦 http),测试/裸仓形态不受影响。
    const local = service.create({
      account: "dev", title: "本地裸仓问题", ticket: "DTS-2026-1002",
      repoUrl: origin,
    });
    assert.ok(local.id);
    // 有单不带仓:裸构造放行(生产同形态已被无条件门拦,见最上用例)。
    const pure = service.create({
      account: "dev", title: "纯现象咨询", ticket: "DTS-2026-1003",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.ok(pure.id);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("MockDtsGateway:确定性单据集,已知单给罐头详情,未知单 fail-loud", async () => {
  const gateway = new MockDtsGateway();
  assert.equal(gateway.mock, true, "模拟网关必须自带 DEV 标记(列表 API 挂徽标用)");
  const list = await gateway.listByOwner("y00965296");
  assert.equal(list.length, 10, "十个确定性测试单");
  assert.ok(list.every((item) => item.title.startsWith("【DEV·模拟】")),
    "标题打 DEV 标,列表里一眼认出模拟单");
  assert.ok(list.every((item) => item.ticket.startsWith("DTS-2026-")));
  const detail = await gateway.detail("DTS-2026-1003");
  assert.match(detail.content, /MOCK 单据/);
  assert.ok(detail.title.length > 0);
  await assert.rejects(() => gateway.detail("DTS-0000"), /查无此单/);
  const flying = await gateway.detail("DTS-2026-1006");
  assert.match(flying.content, /开局飞跑/);
  assert.match(flying.content, /行军动画/, "自带现象描述的单子用原文,不走罐头模板");
  // 1007 号带内嵌截图(#42):描述与正文都含 img,proxyFile 按路径回
  // 罐头 PNG,dts_get_ticket 的下载改写全链在 --dts-mock 下可演示。
  const withImage = await gateway.detail("DTS-2026-1007");
  assert.match(withImage.description ?? "", /<img src="\/v1\/nfs\/mock\//);
  assert.match(withImage.content, /<img src="\/v1\/nfs\/mock\//,
    "正文同样带 img,改写才有 URL 可换");
  const png = await gateway.proxyFile("/v1/nfs/mock/2026-1007/topology.png");
  assert.equal(png.data.subarray(0, 4).toString("latin1"), "\x89PNG",
    "罐头图必须是真图片字节,落盘后才能被识图");
  await assert.rejects(() => gateway.proxyFile("/v1/nfs/mock/404.png"), /没有这个/);
});


test("pipelineClient 公共客户端:触发/查询/契约校验/checks 解析", async () => {
  const seen: Array<{ method: string; url: string; body?: any }> = [];
  // 可切模式的假件:normal=正常回形;bad-status=未知状态;bad-checks=坏 checks。
  let mode: "normal" | "bad-status" | "bad-checks" = "normal";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk as Buffer));
    request.on("end", () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;
      seen.push({ method: request.method ?? "", url: request.url ?? "", body });
      const send = (payload: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "POST" && request.url === "/pipeline/trigger") {
        send({ status: "running" });
      } else if (request.method === "GET"
          && request.url?.startsWith("/pipeline/status")) {
        if (mode === "bad-status") {
          send({ status: "weird" });
        } else if (mode === "bad-checks") {
          send({ runs: [{ status: "success",
            checks: [{ dimension: "??", status: "nope" }] }] });
        } else {
          send({
            runs: [
              { status: "running" },
              { status: "failed", log: "BUILD FAILURE",
                checks: [{ dimension: "COMPILE", status: "failed", job: "build" }] },
            ],
          });
        }
      } else {
        send({}, 500);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const run = await triggerPipeline({
      platformUrl: base, sha: "a".repeat(40),
      credential: { username: "dev", password: "tok" },
    });
    assert.equal(run.status, "running");
    const status = await getPipelineStatus({
      platformUrl: base, sha: "a".repeat(40),
    });
    assert.equal(status.runs.length, 2);
    assert.equal(status.status, "failed", "末位 run 是终态裁决");
    assert.equal(status.checks?.[0].dimension, "COMPILE");
    assert.equal(seen[0].body.sha, "a".repeat(40));
    // 契约状态不猜:未知状态直接报错。
    mode = "bad-status";
    await assert.rejects(
      () => getPipelineStatus({ platformUrl: base, sha: "x" }),
      /未知状态/,
    );
    // 坏 checks 整体按"没有证据"处理(不拿总体绿灯补猜)。
    mode = "bad-checks";
    const bad = await getPipelineStatus({ platformUrl: base, sha: "x" });
    assert.equal(bad.runs[0].checks, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});


test("恢复:监看中的流水线重启后重新挂表,绿了自动推进", async () => {
  const dataDir = mfcTemp("mfc-issue-watch-recover-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 全绿发送回合(#246 绿灯切换):监看器绿了收口只发送全绿事实开
  // 回合——AI 经 raise_gate 举验证卡,平台不再代举。
  const script: Scene[] = [
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户在环境验证。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 直接落一个"MR 跑绿监看中"的现场(不跑全链,聚焦恢复语义)。
  const sha = spawnSync("git", ["--git-dir", origin, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).stdout.trim();
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
    pushes: [{ repo: origin, branch: `master_dev_DTS-2026-1002`, sha, at: now }],
    mrs: [{ repo: origin, branch: `master_dev_DTS-2026-1002`,
      title: "[DTS-2026-1002] t", at: now }],
    // MR 验绿门:申报已受理(不变量——收口当且仅当已申报且全绿;
    // 监看器绿了凭它在场收口)。
    mr_gate: { mrs: [origin], at: now },
    pipelines: {
      [origin]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    // 构造即恢复:watching=true 的监看要重新挂表,预算沿用原 deadline。
    const done = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.stage === "mr_green" && issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify"
        && issue.stage_states?.[4] === "done"
        ? issue : undefined;
    }, "恢复监看并在跑绿后收口,举环境验证闸");
    assert.equal(done.pipelines?.[origin]?.status, "success");
    assert.equal(done.pipelines?.[origin]?.watching, false);
    assert.match(done.stage_note ?? "", /环境验证/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("监看器过期结果防御(#107):重推换 SHA 后旧账红灯拒绝背书,真绿才落终态", async () => {
  const dataDir = mfcTemp("mfc-issue-stale-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 五阶段流程下全绿+未申报会开「申报提醒」回合:剧本留一幕给收口提醒。
  const script: Scene[] = [
    { text: "收到,我补申报 MR 清单完成收口。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  // 用户实报(#107)的现场:声明#1 后 sha1 首轮红过,修复回合推送
  // sha2 并重挂监看;此刻平台上 sha2 的 run 还没注册,账面最新还是
  // sha1 的红灯(staleOldSha 打开影子)。过期结果防御钉的就是这个窗口期
  // ——裸取 runs.at(-1) 落终态会把新监看账定格 failed,真绿灯没人看。
  const staleSha = spawnSync("git", ["--git-dir", origin, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).stdout.trim();
  const tree = spawnSync("git", ["--git-dir", origin, "rev-parse", "HEAD^{tree}"],
    { encoding: "utf-8" }).stdout.trim();
  const newSha = spawnSync("git", ["--git-dir", origin, "commit-tree", tree,
    "-m", `[${TICKET}][fix] round2`], { env: GIT_ENV, encoding: "utf-8" })
    .stdout.trim();
  platform.staleOldSha = staleSha;
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "登录超时", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin], scenario: "ticket", round: 2,
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch: BRANCH, sha: newSha, at: now }],
    mrs: [{ repo: origin, branch: BRANCH,
      title: `[${TICKET}] 登录超时`, at: now }],
    // 无 mr_gate:修复回合还没重新申报——全绿后走「申报提醒」半边,
    // 不收口(不变量:收口当且仅当已申报且全绿)。
    pipelines: {
      [origin]: {
        sha: newSha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 2, reds: 1,
      },
    },
  }));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    // 窗口期(影子未放开):轮轮查询拿到的都是绑旧提交的终态红,
    // 监看账必须原地不动——不落 failed、watching 不翻 false、旧账
    // 红灯不计入新提交的修复轮账。
    await until(() =>
      platform.seen.filter((entry) =>
        entry.method === "GET" && entry.url.startsWith("/pipeline/status")
      ).length >= 3 ? true : undefined,
    "窗口期内至少三轮状态查询(影子未放开)", 20_000);
    const midWindow = service.get("issue-1");
    assert.equal(midWindow.pipelines?.[origin]?.status, "running",
      "过期结果窗口期不得把监看账落成 failed");
    assert.equal(midWindow.pipelines?.[origin]?.watching, true,
      "过期结果窗口期监看必须还活着,真绿灯才有人看");
    assert.equal(midWindow.pipelines?.[origin]?.reds, 1,
      "旧账红灯不计入新提交");
    // 放开影子:新提交的真 run 注册好了,平台回复真绿。
    platform.staleOldSha = undefined;
    const settled = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.pipelines?.[origin]?.status === "success"
        && issue.pipelines?.[origin]?.watching === false ? issue : undefined;
    }, "放开后按真绿灯落终态");
    assert.equal(settled.pipelines?.[origin]?.reds, 0, "真绿清红灯账");
    const notes = (settled.transitions ?? [])
      .filter((item) => item.source === "platform").map((item) => item.note);
    assert.ok(notes.some((note) => /流水线全绿/.test(note)),
      "转移账记的是全绿终态");
    assert.ok(!notes.some((note) => /流水线失败/.test(note)),
      "过期结果全程不得留下失败终态");
    // 全绿+未申报:开申报提醒回合,但不收口(申报半边还没过)。
    await until(() =>
      /全部 MR 流水线已跑绿/.test(JSON.stringify(model.requests))
        ? true : undefined, "全绿申报提醒回合");
    assert.equal(settled.stage, "mr_green", "未申报不收口");
    assert.equal(settled.stage_states?.[4], "in_progress", "收口等申报");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("场景派生:有单五阶段、无单三节点(创建恒为固定流程)", async () => {
  const dataDir = mfcTemp("mfc-issue-mode-");
  const script: Scene[] = [{ text: "ok" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const origin = bareOrigin(dataDir);
    seedModule(dataDir, origin);
    // 有单登记:有单五阶段场景。
    const ticketed = service.create({
      account: "dev", title: "默认固定", ticket: "T1", repoUrl: origin,
    });
    assert.equal(ticketed.scenario, "ticket");
    // 无单登记:场景由单号有无机械派生,三节点。
    const noTicket = service.create({
      account: "freebird", title: "无单也是固定",
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    assert.equal(noTicket.scenario, "no_ticket");
    assert.equal(noTicket.stage, "prep_repo");
    // 场景落盘(不只是回执投影)。
    const onDisk = loadState(join(dataDir, "issues", noTicket.id));
    assert.equal(onDisk?.scenario, "no_ticket", "盘上状态同样带场景");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("拉仓工具化(2026-08-28 v2):fixed DTS 无仓发起,AI 拉单后自己拉仓/自报跳过 + 同单查重", async () => {
  const dataDir = mfcTemp("mfc-issue-repogate-");
  const origin = bareOrigin(dataDir);
  // 线性剧本跨两个会话:每张单 = 拉单 → 自报收口 → AI 裁决(拉仓后
  // 再自报收口,或直接跳过)→ 分析。
  const script: Scene[] = [
    // 会话 A:拉单 → complete_stage 收口 → 自己拉仓 → complete_stage 收口
    // (拉单/拉仓都不再机械推进)。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n现象已核实。\n## 问题现象\n演示现象。\n## 问题根因\n连接池耗尽。\n## 置信度\n高。\n## 修改方案\n超时回收。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=连接池耗尽" } } },
    { text: "仓已拉好,分析已提交。" },
    // 会话 B:拉单 → 收口 → 无代码改动,complete_stage 自报跳过拉仓。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单为配置问题,无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n## 问题现象\n演示现象。\n## 问题根因\n配置项漂移(非代码问题)。\n## 置信度\n高。\n## 修改方案\n恢复配置。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "配置项漂移,非代码问题" } } },
    { text: "无仓跳过,分析已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  });
  try {
    // ① 无仓登记放行(repo_needed 闸已退役,缺仓不再举平台卡)。
    // 基线必填(ADR-0063 后修复分支以它为前缀;生产路由已硬保)。
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
      baseline: "br_V100R026C10_release",
    });
    assert.equal(created.repo_url, undefined);
    assert.equal(created.stage, "dts_info");

    // ② 同账号+同单号至多一个进行中的固定流程。
    assert.throws(() => service.create({
      account: "dev", title: "重复发起", ticket: TICKET, source: "dts",
    }), /已有进行中的问题会话/);

    // ③ 开场词要把"拉仓是你自己的事"讲清楚(工具化语义的引导层)。
    await until(() => model.requests.length ? 1 : undefined, "首回合请求到达模型");
    assert.match(JSON.stringify(model.requests[0]), /pull_repo/,
      "开场词要指引 pull_repo(找不到仓的 AI 会像 issue-10 一样瞎撞 git)");

    // ④ AI 拉仓路:自报收口进入分析,平台顺带切好修复分支。
    const analyzed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "拉仓后分析闸");
    assert.equal(analyzed.stage, "analyze");
    assert.equal(analyzed.stage_states?.[1], "done", "prep_repo 随自报收口完成");
    assert.equal(analyzed.stage_states?.[2], "in_progress", "分析进行中");
    assert.deepEqual(analyzed.repo_urls, [origin]);
    const root = join(dataDir, "issues", created.id);
    assert.ok(existsSync(join(root, "repo", "origin", ".git")),
      "克隆平铺在 repo/<仓名>/");
    const branch = spawnSync("git", ["-C", join(root, "repo", "origin"),
      "branch", "--show-current"], { encoding: "utf-8" });
    assert.equal(branch.stdout.trim(),
      loadState(root)?.fix_branch, "拉仓时宿主切好会话定名的修复分支");
    assert.match(loadState(root)?.fix_branch ?? "",
      new RegExp(`^br_V100R026C10_release_dev_${TICKET}_\\d{14}$`),
      "修复分支命名=基线_工号_单号_时间戳(ADR-0063)");
    assert.ok(analyzed.transitions?.some((entry) =>
      /代码仓已拉取/.test(entry.note)), "拉仓留转移账");
    // 会话 A 停在分析闸即可(拉仓路已证明);不再作答,把线性剧本让给会话 B。

    // ⑤ 跳过路:无代码改动是 AI 的合法自报,prep_repo 记 done,零克隆。
    const second = service.create({
      account: "dev", title: "纯配置问题", ticket: "DTS-2026-1002", source: "dts",
    });
    const gate2 = await until(() => {
      const issue = service.get(second.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "analysis_confirm" ? issue : undefined;
    }, "跳过路的分析闸");
    assert.equal(gate2.stage, "analyze", "complete_stage 跳过直达分析");
    assert.equal(gate2.repo_url, undefined, "跳过=无仓继续");
    assert.equal(gate2.stage_states?.[1], "done", "prep_repo 记 done(跳过)");
    assert.equal(existsSync(join(dataDir, "issues", second.id, "repo")), false,
      "跳过路径零克隆");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("模块开场即定局(ADR-0056):登记带模块与仓,AI 开场直拉;识别路工具退役", async () => {
  const dataDir = mfcTemp("mfc-issue-bindmod-");
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "media-core", name: "媒体核心", description: "播放与转码",
    owner: "dev", repositories: [origin],
  }, "tester");
  // 模块在发起时定局(ADR-0056):登记即带模块与仓,识别路
  // (lookup_modules/bind_module)退役,AI 开场直接逐仓 pull_repo。
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\n\n转码失败已定位。\n## 问题现象\n演示现象。\n## 问题根因\n转码线程泄漏。\n## 置信度\n高。\n## 修改方案\n释放泄漏线程。\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:转码线程泄漏" } } },
    { text: "模块已定、仓已拉,分析已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create({
      account: "dev", title: "转码失败",
      moduleId: "media-core",
      environment: {
        hosts: ["192.0.2.8"],
        backendPassword: "env-shared-secret",
      },
    });
    assert.equal(created.scenario, "no_ticket");
    const analyzed = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "conclude" ? issue : undefined;
    }, "拉仓后结论闸");
    assert.equal(analyzed.module_id, "media-core", "模块随登记落盘");
    assert.equal(analyzed.module, "媒体核心", "模块名由模块库派生");
    assert.deepEqual(analyzed.repo_urls, [origin], "模块仓随登记带出");
    assert.equal(analyzed.stage, "conclude", "无单场景分析结论即终点节点");
    assert.ok(existsSync(
      join(dataDir, "issues", created.id, "repo", "origin", ".git")),
      "克隆由 pull_repo 落地(repo/<仓名>/ 平铺)");

    // 工具直调(免模型):识别路工具不再注册;拉仓只落地不推进(出口
    // 是 complete_stage)。
    const state: IssueSessionState = {
      id: "issue-x", account: "dev",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      title: "t", description: "", source: "dts", ticket: TICKET,
      scenario: "ticket", round: 1,
      stage_states: FIXED_TICKET_STAGES.map(() => "pending"),
      status: "idle", stage: "prep_repo", stage_note: "", stage_at: new Date().toISOString(),
    };
    const pulled: string[] = [];
    const ctx: IssueToolContext = {
      state, workspace: "/tmp/ws", dataRoot: dataDir,
      persist: () => undefined,
      // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
      interventionTier: () => "3",
      pullRepo: async (url) => {
        pulled.push(url);
        return { dir: "repo/origin", cloned: true, head: "a".repeat(12) };
      },
    };
    const tools = createIssueTools(ctx) as Array<{
      name: string;
      execute: (id: string, params: any) => Promise<unknown>;
    }>;
    const byName = (name: string) => {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `应注册 ${name}`);
      return tool!;
    };
    const textOf = (result: unknown) =>
      (result as { content: Array<{ text: string }> }).content[0].text;
    assert.ok(!tools.some((item) => item.name === "bind_module"),
      "bind_module 已随识别路退役(ADR-0056)");
    assert.ok(!tools.some((item) => item.name === "lookup_modules"),
      "lookup_modules 已随识别路退役(ADR-0056)");
    // 首拉只落地不再机械推进;回执带注册表简报指路 complete_stage;
    // complete_stage 才把阶段推进 analyze。
    const pullReceipt = textOf(
      await byName("pull_repo").execute("x", { url: origin }));
    assert.equal(state.stage, "prep_repo", "拉仓只落地,不机械推进");
    assert.match(pullReceipt, /complete_stage 申报完成/, "拉仓回执要指路出口");
    assert.match(pullReceipt, /当前阶段「拉取代码仓·建分支」/, "回执带注册表简报");
    await byName("complete_stage").execute("x", { note: "仓已拉齐" });
    assert.equal(state.stage, "analyze", "complete_stage 自报才推进问题分析");
    assert.equal(state.stage_states?.[1], "done");
    state.stage = "fix";
    await byName("pull_repo").execute("x", { url: origin });
    assert.equal(state.stage, "fix", "后期补拉只做事,不倒转阶段");
    assert.equal(pulled.length, 2, "幂等重拉照常执行(工具不猜意图)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("网管环境闸(2026-08-28):request_env 缺环境举 env_needed(scope=logs);配置走 vault 不进 issue.json,配置后指路技能", async () => {
  // 直调:env 缺席 → 举 env_needed 闸 + 成功收口(2026-09-08:发起
  // 请求本身完成了,不再借错误通道;硬拒绝才是 fail)。
  const gateState: IssueSessionState = {
    id: "issue-g", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: new Date().toISOString(),
  };
  const directCtx: IssueToolContext = {
    state: gateState, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    ops: fakeOps,
    environmentPassword: () => undefined,
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const directTools = createIssueTools(directCtx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const requestEnv = directTools.find((tool) => tool.name === "request_env")!;
  assert.ok(requestEnv);
  const raised = await requestEnv.execute("x", {}) as {
    content: Array<{ type: string; text: string }>;
  };
  assert.match(raised.content[0]?.text ?? "", /已向用户发起网管环境配置请求/);
  assert.equal(gateState.gate?.kind, "env_needed");
  assert.equal(gateState.gate?.scope, "logs", "闸带用途面,决策卡据此给表单文案");

  // 端到端:无环境发起 → request_env 举闸 → attachEnvironment 配置
  // (密码只进 vault)→ 清闸开平台回合 → 重试指路技能。
  const dataDir = mfcTemp("mfc-issue-envgate-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { text: "等待用户配置网管环境。" },
    { tool: { name: "request_env", input: {} } },
    { text: "环境已配置,按技能 fetch-logs 抓取日志。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    opsTools: fakeOps,
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
  });
  try {
    // 无单登记必须带环境(#17):要测 env_needed 现场补配,登记只能走
    // 有单路(有单不带环境放行,环境缺在会话里补)。
    const created = service.create({
      account: "dev", title: "查服务日志", repoUrl: origin,
      ticket: "DTS-2026-1001", source: "dts",
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "env_needed 闸");
    assert.equal(waiting.gate?.scope, "logs");

    // 配置入口(POST /issues/:id/environment 的服务本体):密码进 vault,
    // 状态只有引用;闸清掉,平台开回合让 AI 重试。
    const configured = service.attachEnvironment(created.id, {
      hosts: ["192.0.2.8"], port: 22, backendPassword: "env-shared-secret",
    });
    assert.ok(configured.environment?.credential_ref, "状态里只有凭据引用");
    assert.equal(configured.gate, undefined, "配置即清闸");
    assert.ok(existsSync(join(dataDir, ".issue-environments", `${created.id}.json`)),
      "密码落在 vault 加密文件");
    const raw = readFileSync(join(dataDir, "issues", created.id, "issue.json"), "utf-8");
    assert.ok(!raw.includes("env-shared-secret"), "issue.json 永远没有密码明文");

    await until(() =>
      service.get(created.id).status === "idle" ? 1 : undefined,
    "配置后的平台回合收口");
    // 现场账:第一次 request_env 举卡是成功收口(2026-09-08,不借错误
    // 通道),第二次配置后重试指路技能。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const requests = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "tool_finished"
        && event.payload?.name === "request_env");
    assert.equal(requests.length, 2);
    assert.equal(requests[0].payload.is_error, false,
      "举配置卡是成功收口,回执不画 ✕");
    assert.notEqual(requests[1].payload.is_error, true, "配置后重试指路技能");
    // 环境是开场后才补配的:开场词渲染时元信息还没有环境,密码不借闸
    // 进上下文(ADR-0003 的明文只随登记元信息走,要查调 get_issue_meta)。
    assert.doesNotMatch(JSON.stringify(model.requests), /env-shared-secret/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("环境形态贯通:登记/配置卡选定入状态与转移账,非法值当场打回(2026-09-06)", async () => {
  const dataDir = mfcTemp("mfc-issue-envtype-");
  const origin = bareOrigin(dataDir);
  const model = new ScriptedModelServer(
    [{ text: "收到。" }, { text: "收到。" }], "scripted-v1");
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    opsTools: fakeOps,
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
  });
  try {
    // 登记路:环境四件套 + 形态(虚拟化)一并入状态。
    const registered = service.create({
      account: "dev", title: "登记带形态", repoUrl: origin,
      ticket: "DTS-2026-1001", source: "dts",
      environment: {
        hosts: ["192.0.2.8"], backendPassword: "env-shared-secret",
        envType: "virtualized",
      },
    });
    assert.equal(service.get(registered.id).environment?.env_type,
      "virtualized", "登记形态入状态");

    // 配置卡路:env_needed 现场补配带形态(容器化),转移账点名形态。
    const carded = service.create({
      account: "dev", title: "配置卡带形态", repoUrl: origin,
      ticket: "DTS-2026-1002", source: "dts",
    });
    const configured = service.attachEnvironment(carded.id, {
      hosts: ["71.26.146.142"], backendPassword: "env-shared-secret",
      envType: "k8s",
    });
    assert.equal(configured.environment?.env_type, "k8s", "配置卡形态入状态");
    assert.ok(configured.transitions?.some((entry) =>
      entry.note.includes("形态容器化(K8s)")), "转移账点名形态");

    // 非法值:归一当场打回,状态不被污染。
    assert.throws(
      () => service.attachEnvironment(carded.id, {
        hosts: ["71.26.146.142"], backendPassword: "env-shared-secret",
        envType: "vm" as never,
      }),
      /环境形态/,
    );
    assert.equal(service.get(carded.id).environment?.env_type, "k8s",
      "打回后形态保持原值");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("环境拒绝(票 93):拒绝=清闸回落 idle+转移账带理由+平台回合告知「用户已确认」,拒绝台账入册不上 wire", async () => {
  const dataDir = mfcTemp("mfc-issue-envdecline-");
  const origin = bareOrigin(dataDir);
  // 剧本:第 1 回合 request_env 举闸停机;拒绝后的平台回合里 AI 再调
  // request_env(防纠缠:不举闸、如实失败),然后基于现有证据收嘴。
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { text: "等用户配环境或拒绝。" },
    { tool: { name: "request_env", input: {} } },
    { text: "用户已裁定,基于现有证据继续。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    opsTools: fakeOps,
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
  });
  try {
    const created = service.create({
      account: "dev", title: "查服务日志", repoUrl: origin,
      ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "env_needed 闸");

    // 拒绝(带理由):闸当场清掉,状态交给平台回合。
    const declined = service.declineEnvironment(created.id, {
      note: "问题在页面侧即可复现",
    });
    assert.equal(declined.gate, undefined, "拒绝即清闸");
    // 拒绝台账落盘(wire 不投影——与 mr_gate 同罪同罚,前端镜像无此字段)。
    const persisted = loadState(
      join(dataDir, "issues", created.id))!;
    assert.deepEqual(persisted.env_declined?.scopes, ["logs"]);
    // 转移账:拒绝事实 + 人的理由逐字入账。
    assert.ok(persisted.transitions?.some((entry) =>
      /网管环境配置被用户拒绝/.test(entry.note)
      && /无需拉日志/.test(entry.note)
      && entry.note.includes("问题在页面侧即可复现")), "转移账要带拒绝与理由");

    // 拒绝后的平台回合:文案告知 AI「用户已确认」+理由+证据局限要求。
    // (请求 3=拒绝通知开的回合;固定流程的催办续跑可能在其后追加
    // 尾随回合——既有 env 闸用例同款,不在此数。)
    await until(() => service.get(created.id).status === "idle" ? 1 : undefined,
      "拒绝后的平台回合收口");
    assert.ok(model.requests.length >= 4, "拒绝通知要开一个新回合");
    const declineTurn = JSON.stringify(model.requests[2]);
    assert.match(declineTurn, /用户已确认无需拉日志/);
    assert.match(declineTurn, /不要再次请求网管环境/);
    assert.match(declineTurn, /如实说明证据局限/);
    assert.match(declineTurn, /问题在页面侧即可复现/, "理由要随通知转给 AI");
    // 防纠缠的端到端面:被拒后 request_env 如实失败,闸保持清空。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    const requests = events.split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, any>)
      .filter((event) => event.kind === "tool_finished"
        && event.payload?.name === "request_env");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].payload.is_error, true, "拒绝后再调如实失败");
    assert.equal(service.get(created.id).gate, undefined,
      "拒绝后不重复举卡");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("环境拒绝防纠缠(票 93):同 scope 已拒 → raiseEnvNeededGate 不举闸,工具失败文案含「用户已确认」", async () => {
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-decline", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "dts", ticket: TICKET,
    repo_url: "/tmp/x.git", scenario: "ticket", round: 1,
    stage_states: ["done", "done", "in_progress", "pending", "pending"],
    status: "running", stage: "analyze", stage_note: "", stage_at: now,
    env_declined: { scopes: ["logs"], at: now },
  };
  const ctx: IssueToolContext = {
    state, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    ops: fakeOps,
    environmentPassword: () => undefined,
    // 拒绝纠缠的守卫在档位旁路之前也成立:这里给三档让闸路径走到。
    interventionTier: () => "3",
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const requestEnv = tools.find((tool) => tool.name === "request_env")!;
  assert.ok(requestEnv);
  const before = state.transitions?.length ?? 0;
  await assert.rejects(
    () => requestEnv.execute("x", {}),
    /用户已确认无需此操作.*拉日志[\s\S]*证据局限[\s\S]*不要再次请求环境/);
  assert.equal(state.gate, undefined, "硬拒绝:不再举闸");
  assert.equal(state.transitions?.length ?? 0, before,
    "举闸会记转移账——不举闸就不该有任何新增");
});


test("环境拒绝解锢(票 93):拒绝后配置环境清除拒绝台账,request_env 恢复正常路径", async () => {
  const dataDir = mfcTemp("mfc-issue-envunlock-");
  const origin = bareOrigin(dataDir);
  // 剧本只负责举起 env_needed 闸(固定流程的催办续跑会在其后追加尾随
  // 回合,剧本耗尽后重复末幕文本——不依赖回合时序,解锢后的工具路径
  // 用直调缝按盘上真实状态验证)。
  const script: Scene[] = [
    { tool: { name: "request_env", input: {} } },
    { text: "等用户配环境或拒绝。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    opsTools: fakeOps,
    // 档位前置保持三档对齐(env 配置卡 2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
  });
  try {
    const created = service.create({
      account: "dev", title: "查服务日志", repoUrl: origin,
      ticket: TICKET, source: "dts",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "env_needed"
        ? issue : undefined;
    }, "env_needed 闸");
    // 先拒绝(不带理由):转移账按「未说明理由」留痕。
    service.declineEnvironment(created.id);
    let persisted = loadState(join(dataDir, "issues", created.id))!;
    assert.deepEqual(persisted.env_declined?.scopes, ["logs"]);
    assert.ok(persisted.transitions?.some((entry) =>
      /未说明理由/.test(entry.note)), "无理由的拒绝也要留痕");
    await until(() => service.get(created.id).status === "idle" ? 1 : undefined,
      "拒绝后的平台回合收口");

    // 解锢:配置环境成功即整册清除拒绝台账(闸已不在场,配置照常生效)。
    const configured = service.attachEnvironment(created.id, {
      hosts: ["192.0.2.8"], port: 22, backendPassword: "env-shared-secret",
    });
    assert.equal(configured.gate, undefined);
    await until(() => service.get(created.id).status === "idle" ? 1 : undefined,
      "配置后的平台回合收口");
    persisted = loadState(join(dataDir, "issues", created.id))!;
    assert.equal(persisted.env_declined, undefined,
      "配置成功即解锢:拒绝台账整册清除");

    // request_env 恢复正常路径:按盘上真实状态(拒绝台账已清+环境已在)
    // 直调工具——密码门前放行,返回「已配置」指路,不再是硬拒绝。
    const tools = createIssueTools({
      state: persisted,
      workspace: "/tmp/ws", dataRoot: dataDir,
      persist: () => undefined,
      ops: fakeOps,
      environmentPassword: () => "env-shared-secret",
      pullRepo: async (url) => ({
        dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
      }),
    }) as Array<{ name: string; execute: (id: string, params: any) => Promise<unknown> }>;
    const requestEnv = tools.find((tool) => tool.name === "request_env")!;
    assert.ok(requestEnv);
    const receipt = await requestEnv.execute("x", {});
    assert.match(String((receipt as any)?.content?.[0]?.text ?? ""), /网管环境已配置/,
      "解锢后 request_env 走正常指路");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("环境拒绝 deploy 对称(票 93):deploy 闸拒绝按「换库部署」记账与通知;闸不在场如实打回;工具侧同文案不举闸", async () => {
  // 服务侧:盘上预置一张 deploy scope 的 env_needed 等答卡(build_deploy
  // 被阶段门禁封存 ADR-0013,现实里举不出来——重启换库时本路即生效)。
  const dataDir = mfcTemp("mfc-issue-envdecline-deploy-");
  const now = "2026-09-03T00:00:00Z";
  mkdirSync(join(dataDir, "issues", "issue-d"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-d", "issue.json"), JSON.stringify({
    id: "issue-d", account: "dev",
    created_at: now, updated_at: now,
    title: "t", description: "", source: "manual",
    scenario: "no_ticket", status: "waiting_user", stage: "analyze",
    stage_note: "", stage_at: now,
    gate: {
      id: "gate-d", kind: "env_needed", state_version: 0,
      question: { questions: [{
        question: "获取日志/换库需要网管服务器地址与密码",
        options: [{ code: "fill", label: "填写并继续" }],
      }] },
      scope: "deploy",
      created_at: now,
    },
  }));
  const model = new ScriptedModelServer(
    [{ text: "收到,不换库部署。" }], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const declined = service.declineEnvironment("issue-d");
    assert.equal(declined.gate, undefined, "拒绝即清闸");
    const persisted = loadState(join(dataDir, "issues", "issue-d"))!;
    assert.deepEqual(persisted.env_declined?.scopes, ["deploy"]);
    assert.ok(persisted.transitions?.some((entry) =>
      /无需换库部署/.test(entry.note)), "转移账按 deploy 用途面留痕");
    await until(() => service.get("issue-d").status === "idle" ? 1 : undefined,
      "拒绝后的平台回合收口");
    assert.match(JSON.stringify(model.requests[0]), /用户已确认无需换库部署/);
    // 闸不在场如实打回:没有卡就无所谓拒绝。
    assert.throws(() => service.declineEnvironment("issue-d"),
      /当前没有网管环境配置卡/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }

});

// ---- 催办续跑(2026-08-28 拍板 A+B):提前收嘴被推回阶段 ----

/** 直调用最小固定会话状态。 */

test("催办续跑:模型提前收嘴被推回阶段,催办词带阶段目标与出口,举卡才准停", async () => {
  const dataDir = mfcTemp("mfc-issue-nudge-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 第 1 回合:拉仓 → 自报收口 → 写报告 → 提前收嘴(没举卡)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n现象已核实。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { text: "先研究到这,稍后继续。" },
    // 第 2 回合(平台催办):补交分析,举「结论确认」卡——合法停机。
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "根因=连接池耗尽" } } },
    { text: "分析已提交,等确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "催办后举结论卡");
    // 剧本 6 幕 = 6 个请求:第 5 个请求的用户消息就是催办词。
    assert.equal(model.requests.length, 6, "收嘴一次+催办一次,请求数要对得上");
    const nudgeRequest = JSON.stringify(model.requests[4]);
    assert.match(nudgeRequest, /平台催办\(第 1\/2 次\)/, "催办词要报次数");
    assert.match(nudgeRequest, /当前阶段「问题分析」/, "催办要带上阶段定位");
    assert.match(nudgeRequest, /怎么算完/, "催办要说清完成标准");
    assert.equal(waiting.nudges, 1, "催办计数要入账");
    assert.equal(waiting.stage, "conclude", "无单场景提交即推进结论节点");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("催办预算:连续收嘴只催 2 次,耗尽转人工(idle+备注),不再无限续跑", async () => {
  const dataDir = mfcTemp("mfc-issue-nudge-out-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { text: "先到这。" },
    { text: "又停了。" },
    { text: "还停。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const parked = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "催办耗尽落 idle");
    assert.equal(model.requests.length, 4, "首轮+两次催办,共 4 个请求");
    assert.match(JSON.stringify(model.requests[2]), /第 1\/2 次/);
    assert.match(JSON.stringify(model.requests[3]), /第 2\/2 次/);
    assert.equal(parked.nudges, 3, "第三次收嘴记账但不续跑");
    assert.match(parked.stage_note, /提前收嘴/, "转人工要说人话");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("催办预算不跨回合传染:耗尽转人工后续聊重新拿满预算,再耗尽仍走同一转人工路", async () => {
  const dataDir = mfcTemp("mfc-issue-nudge-round-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    // 第 1 轮:拉仓 → 连续三次收嘴,预算 2 次耗尽落 idle(先例场景)。
    { tool: { name: "pull_repo", input: { url: origin } } },
    { text: "先到这。" },
    { text: "又停了。" },
    { text: "还停。" },
    // 第 2 轮:用户「继续」重新启动回合——预算必须从头计,不能带着上轮的 3。
    { text: "又停了。" },
    { text: "还停。" },
    { text: "收工。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const parked1 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第一轮催办耗尽落 idle");
    assert.equal(model.requests.length, 4, "首轮+两次催办,共 4 个请求");
    assert.equal(parked1.nudges, 3, "第一轮耗尽记账停在 3(超预算那次也入账)");
    assert.match(parked1.stage_note, /提前收嘴/);

    // 续聊重新启动回合:预算清零只发生在回合入口——若预算跨回合传染,
    // 第一次收嘴就会直接落 idle,后面这些催办请求根本不会发生。
    const resumed = service.reply(created.id, "继续");
    assert.equal(resumed.status, "running");
    const parked2 = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "第二轮催办耗尽落 idle");
    assert.equal(model.requests.length, 7,
      "第二轮 = 续聊 1 次 + 催办 2 次;预算若传染,这里只会有 5 个请求");
    assert.match(JSON.stringify(model.requests[5]), /第 1\/2 次/,
      "新回合第一次催办从 1 起计,不带上一轮的账");
    assert.match(JSON.stringify(model.requests[6]), /第 2\/2 次/);
    assert.equal(parked2.nudges, 3, "第二轮耗尽同样记账到 3");
    assert.match(parked2.stage_note, /提前收嘴/,
      "耗尽转人工的出口与第一轮同一写法");
    assert.match(parked2.stage_note, /发送「继续」或补充指示/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("催办谓词:阶段未收口必催;阶段收口/流水线在途/已申报等绿豁免", () => {
  const now = new Date().toISOString();
  // 分析阶段进行中:必催。
  assert.equal(shouldNudgeFixed(fixedState()), true);
  // 没有场景阶段的存量现场,停机合法性无从机械判定,不催。
  assert.equal(
    shouldNudgeFixed(fixedState({ scenario: undefined })), false);
  // 当前阶段已收口(如 MR 跑绿收口待归档,ADR-0013):卡已举,不催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: FIXED_TICKET_STAGES.map(() => "done"),
    gate: { id: "gate-x", kind: "env_verify", state_version: 1,
      created_at: now,
      question: { questions: [{ question: "验证?", options: [] }] } },
  })), false);
  // 出口卡未清(#246,ADR-0024):mr_green 收口了但验证卡没举——催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: FIXED_TICKET_STAGES.map(() => "done"),
  })), true);
  // MR 已建、流水线在途:停等流水线是出口的一部分,不催。
  const mrGreenStates = FIXED_TICKET_STAGES.map((stage, index) =>
    index < FIXED_TICKET_STAGES.indexOf("mr_green") ? "done" : "in_progress");
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: mrGreenStates,
    mrs: [{ repo: "/tmp/x.git", branch: "master_dev_DTS1",
      title: "[DTS1][fix] 修复", at: now }],
    pipelines: { "/tmp/x.git": {
      sha: "0123456789abcdef", status: "running", watching: true,
      started_at: now, deadline: now, round: 1,
    } },
  })), false);
  // MR 验绿门已受理申报(在跑→受理等绿):合法停机,同停等流水线,不催。
  assert.equal(shouldNudgeFixed(fixedState({
    stage: "mr_green",
    stage_states: mrGreenStates,
    mrs: [{ repo: "/tmp/x.git", branch: "master_dev_DTS1",
      title: "[DTS1][fix] 修复", at: now }],
    mr_gate: { mrs: ["/tmp/x.git"], at: now },
  })), false);
});


test("停机规矩与完成标准进了提示词:开局契约/催办词两处", () => {
  const opening = issueFixedOpeningPrompt(fixedState());
  assert.match(opening, /只有三种情况可以停下来/, "开局契约要立停机规矩");
  assert.match(opening, /怎么算完/, "当前阶段要给出完成标准");
  assert.match(opening, /阶段性总结不算完成/);
  const nudge = fixedNudgeNotice(fixedState(), 1, 2);
  assert.match(nudge, /平台催办\(第 1\/2 次\)/);
  assert.match(nudge, /怎么算完/);
});

// ---- 登记元信息全量进上下文 + get_issue_meta(ADR-0003 裁定落地) ----

/** 登记元信息的完整夹具:模块带两仓 + 环境四件套(页面凭据在册)。 */

test("登记元信息块(ADR-0003):开场/续聊词渲染环境明文与模块/多仓;无环境会话整段缺席", () => {
  const fixed = issueFixedOpeningPrompt(metaState(), META_CREDENTIALS);
  // 凭据明文:密码字面量就出现在渲染结果里(不脱敏)。页面凭据已
  // 废弃(2026-09-10),渲染行不再出现。
  assert.match(fixed, /服务器地址: 10\.0\.0\.8, 10\.0\.0\.9/);
  assert.match(fixed, /环境形态: 虚拟化/);
  assert.match(fixed, /网管后台密码.*: env-shared-secret/);
  assert.doesNotMatch(fixed, /页面账号/);
  assert.doesNotMatch(fixed, /页面密码/);
  // 模块与多仓清单随登记渲染(仓走工作区相对路径)。
  assert.match(fixed, /业务模块: 支付核心\(id: pay-core\)/);
  assert.match(fixed, /repo\/x\//);
  assert.match(fixed, /repo\/y\//);
  // 续聊词(重启重建上下文)也不让元信息断档。
  const resume = issueResumePrompt(metaState(), "继续", META_CREDENTIALS);
  assert.match(resume, /网管后台密码/);
  assert.match(resume, /业务模块: 支付核心/);

  // DTS 页签发起的会话:无模块无环境,段落整段缺席,不渲染空壳。
  const bare = issueFixedOpeningPrompt(fixedState());
  assert.doesNotMatch(bare, /业务模块/);
  assert.doesNotMatch(bare, /网管环境「/);
  assert.doesNotMatch(bare, /服务器地址/);
  assert.doesNotMatch(bare, /page-secret/);

  // env_needed 闸补配的环境只有后台凭据组:后台密码在场。
  const gateOnly = issueFixedOpeningPrompt(metaState({
    environment: {
      credential_ref: "cred-1", name: "192.0.2.8",
      hosts: ["192.0.2.8"], port: 22,
    },
  }), { backend: "env-shared-secret" });
  assert.match(gateOnly, /网管后台密码.*: env-shared-secret/);
  assert.doesNotMatch(gateOnly, /页面账号/);
  assert.doesNotMatch(gateOnly, /页面密码/);
  // 形态没登记就不渲染(闸补配的存量环境),不造空壳。
  assert.doesNotMatch(gateOnly, /环境形态/);
});


test("get_issue_meta 工具(ADR-0003):元信息完整 JSON 与提示词同源、密码在返回值里;无环境缺省形", async () => {
  // 修复分支定名(ADR-0063)在场=会话已拉过仓的常态;repair_branch 渲染
  // 定名,未定名时整键缺席(不预写一个算不出的名字)。
  const FIX_BRANCH = "master_dev_DTS-2026-1001_20261015090000";
  const state = metaState({ fix_branch: FIX_BRANCH });
  const tools = createIssueTools({
    state, workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    environmentPassword: () => META_CREDENTIALS.backend,
    pullRepo: async (url) => ({ dir: url, cloned: false, head: "a".repeat(12) }),
  }) as Array<{
    name: string;
    description?: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const textOf = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0].text;
  const tool = tools.find((entry) => entry.name === "get_issue_meta")!;
  assert.ok(tool, "get_issue_meta 应注册在工具集里");
  assert.match(tool.description!, /dts_get_ticket/,
    "工具描述要写明与 dts_get_ticket 的分工");

  const receipt = textOf(await tool.execute("x", {}));
  // 密码在返回值里(不脱敏),且与提示词同源(issueRegistrationMeta);
  // 页面凭据已废弃,回执不再带页面字段。
  assert.match(receipt, /env-shared-secret/);
  assert.deepEqual(JSON.parse(receipt), issueRegistrationMeta(state, META_CREDENTIALS));
  assert.deepEqual(JSON.parse(receipt), {
    scenario: "ticket",
    title: "播放器偶发黑屏",
    description: "升级后偶发,重启恢复",
    account: "dev",
    module: { id: MODULE_ID, name: "支付核心" },
    repos: [
      { url: "/tmp/x.git", dir: "repo/x" },
      { url: "/tmp/y.git", dir: "repo/y" },
    ],
    ticket: "DTS-2026-1001",
    repair_branch: FIX_BRANCH,
    environment: {
      name: "192.0.2.8",
      hosts: ["192.0.2.8", "192.0.2.9"],
      env_type: "virtualized",
      backend_password: "env-shared-secret",
    },
  });
  // 只读:调完状态一个字没变。
  assert.equal(state.gate, undefined);
  assert.equal(state.stage, "analyze");

  // 无环境会话:environment/module/附件/版本等键整段缺席(与工具返回
  // 风格一致,缺席不造空壳)。
  const bareTools = createIssueTools({
    state: fixedState(), workspace: "/tmp/ws", dataRoot: "/tmp/data",
    persist: () => undefined,
    pullRepo: async (url) => ({ dir: url, cloned: false, head: "a".repeat(12) }),
  }) as typeof tools;
  const bare = JSON.parse(textOf(
    await bareTools.find((entry) => entry.name === "get_issue_meta")!
      .execute("x", {})));
  assert.equal("environment" in bare, false, "无环境不造空壳");
  assert.equal("module" in bare, false);
  assert.equal("attachments" in bare, false);
  assert.equal("product_version" in bare, false);
  assert.equal("baseline" in bare, false);
  assert.equal("knowledge_repo" in bare, false);
  assert.equal("repair_branch" in bare, false,
    "修复分支未定名(还没拉过仓)时整键缺席,不预写算不出的名字");
  assert.deepEqual(bare.repos, [{ url: "/tmp/x.git", dir: "repo/x" }]);
});

test("登记元信息扩展(2026-09-19):版本/基线/知识仓/转正来源/附件按实际在场,引用式给指针", () => {
  const state = metaState({
    product_version: "V5R1",
    baseline: "master_v5r1",
    knowledge_repo: {
      url: "/tmp/k.git", name: "team-knowledge",
      status: "ready", at: "2026-09-19T00:00:00Z",
    },
    converted_from: "issue-7",
    description: "升级后偶发,日志见 attachments/aaaaaaaaaaaaaaaa.log",
    remark: "先复现黑屏再查日志,别先动版本配置",
  });
  const meta = issueRegistrationMeta(state, {});
  assert.equal(meta.product_version, "V5R1");
  assert.equal(meta.baseline, "master_v5r1");
  assert.deepEqual(meta.knowledge_repo,
    { name: "team-knowledge", dir: "repo/team-knowledge/" });
  assert.equal(meta.inherited_issue, "issue-7");
  assert.deepEqual(meta.attachments, ["attachments/aaaaaaaaaaaaaaaa.log"]);
  assert.equal(meta.remark, "先复现黑屏再查日志,别先动版本配置");

  // 附件两源(2026-10-15 #502):DTS 发起随单上传的路径拼在附加信息
  // 尾部,同样进 meta.attachments;两源同引用去重,不重复列。
  const fromRemark = issueRegistrationMeta(metaState({
    description: "播放器升级后黑屏",
    remark: "先复现黑屏再查日志\n随单附件: attachments/bbbbbbbbbbbbbbbb.log",
  }), {});
  assert.deepEqual(fromRemark.attachments, ["attachments/bbbbbbbbbbbbbbbb.log"]);
  const deduped = issueRegistrationMeta(metaState({
    description: "日志见 attachments/bbbbbbbbbbbbbbbb.log",
    remark: "随单附件: attachments/bbbbbbbbbbbbbbbb.log",
  }), {});
  assert.deepEqual(deduped.attachments, ["attachments/bbbbbbbbbbbbbbbb.log"]);

  // skipped 的知识仓不在场:不指一个不存在的路径。
  const skipped = issueRegistrationMeta(metaState({
    knowledge_repo: {
      url: "/tmp/k.git", name: "team-knowledge",
      status: "skipped", at: "2026-09-19T00:00:00Z",
    },
  }), {});
  assert.equal("knowledge_repo" in skipped, false);
  assert.equal("attachments" in skipped, false);
  // 附加信息:没填整键缺席,不造空壳(2026-09-20)。
  assert.equal("remark" in skipped, false);
});

test("开场词/续聊词:登记附件单列一行(优先查看)与产品版本行;缺省整行缺席", () => {
  const withAll = issueFixedOpeningPrompt(metaState({
    product_version: "V5R1",
    baseline: "master_v5r1",
    description: "升级后偶发,日志见 attachments/aaaaaaaaaaaaaaaa.log",
  }));
  assert.match(withAll, /登记附件: attachments\/aaaaaaaaaaaaaaaa\.log/);
  assert.match(withAll, /优先查看附件再下结论/);
  assert.match(withAll, /产品版本: V5R1\(拉仓基线分支: master_v5r1\)/);

  // 附加信息单列一行(2026-09-20 拍板,2026-10-15 #502 更名):要求
  // 重点优先读;没填整行缺席。
  const withRemark = issueFixedOpeningPrompt(metaState({
    remark: "先复现黑屏再查日志",
  }));
  assert.match(withRemark, /附加信息: 先复现黑屏再查日志/);
  assert.match(withRemark, /重点优先读/);
  assert.doesNotMatch(issueFixedOpeningPrompt(metaState()), /附加信息/);

  // 无附件无版本:两行整段缺席,不渲染空壳。
  const plain = issueFixedOpeningPrompt(metaState());
  assert.doesNotMatch(plain, /登记附件/);
  assert.doesNotMatch(plain, /产品版本/);

  // 续聊词同样带(重启重建的上下文不流失登记材料)。
  const resume = issueResumePrompt(metaState({
    product_version: "V5R1",
    description: "见 attachments/aaaaaaaaaaaaaaaa.log",
    remark: "先复现黑屏再查日志",
  }), "继续");
  assert.match(resume, /登记附件: attachments\/aaaaaaaaaaaaaaaa\.log/);
  assert.match(resume, /产品版本: V5R1/);
  assert.match(resume, /附加信息: 先复现黑屏再查日志/);
  const plainResume = issueResumePrompt(metaState(), "继续");
  assert.doesNotMatch(plainResume, /登记附件/);
  assert.doesNotMatch(plainResume, /附加信息/);
});


test("登记元信息进开场上下文(service 接线):vault 解出的凭据明文进模型请求,get_issue_meta 回执同源", async () => {
  const dataDir = mfcTemp("mfc-issue-meta-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "get_issue_meta", input: {} } },
    { text: "登记信息已复核,开始研究。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "播放器偶发黑屏",
      remark: "先复现黑屏再查日志,别先动版本配置",
      repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口");
    // 开场词带着 vault 解出的凭据明文与模块行(ADR-0003)。
    const opening = JSON.stringify(model.requests[0]);
    assert.match(opening, /env-shared-secret/);
    assert.match(opening, /业务模块: 支付核心\(id: pay-core\)/);
    // 附加信息随登记进开场词(service 接线),要求 AI 重点优先读。
    assert.match(opening, /附加信息: 先复现黑屏再查日志,别先动版本配置/);
    assert.match(opening, /重点优先读/);
    // get_issue_meta 的回执进了第二个请求(工具结果回模型),密码在场。
    const followup = JSON.stringify(model.requests[1]);
    assert.match(followup, /get_issue_meta/);
    assert.match(followup, /backend_password.*env-shared-secret/);
    assert.match(followup, /module.*pay-core/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("红灯修复轮预算:0=关掉自动修复,红灯留痕请人工不再开回合", async () => {
  const dataDir = mfcTemp("mfc-issue-budget0-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  await platform.start();
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "bash", input: { command:
      `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '[${TICKET}][fix] 修复'` } } },
    { tool: { name: "report_ut", input: { passed: true, summary: "3/3" } } },
    { tool: { name: "complete_stage", input: { note: "修复完成(UT 3/3)" } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已创建并申报,等待流水线。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      // 预算 0 = 关掉自动修复:第一次红灯就留痕请人工(需求侧同语义)。
      runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120, repair_rounds: 0 }),
    },
    dts: new MockDtsGateway(),
    opsTools: fakeOps,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const created = service.create({
      account: "dev",
      title: "预算关断验收",
      ticket: TICKET,
      source: "dts",
      repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    // ① 分析确认闸放行 → 走到 MR 提交,回合收口(idle 等流水线)。
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "analysis_confirm"
        ? issue : undefined;
    }, "分析确认闸");
    service.answer(created.id, {
      state_version: service.get(created.id).gate!.state_version,
      code: "confirm",
    });
    await until(() => {
      const issue = service.get(created.id);
      return issue.stage === "mr_green" && issue.status === "idle" ? issue : undefined;
    }, "MR 提交回合收口");
    const requestsAfterMr = model.requests.length;

    // ② 流水线红按终态处理:预算 0 → 不开修复回合,留痕请人工。
    await until(() => {
      const issue = service.get(created.id);
      return issue.pipelines?.[origin]?.last_error?.includes("修复轮预算耗尽")
        ? issue : undefined;
    }, "红灯预算耗尽停表");
    const exhausted = service.get(created.id);
    assert.equal(exhausted.status, "idle", "不开回合,会话停机等人");
    assert.match(exhausted.stage_note ?? "", /修复轮预算/);
    assert.equal(exhausted.pipelines?.[origin]?.watching, false);
    assert.equal(exhausted.pipelines?.[origin]?.reds, 1, "红灯计数入账");
    assert.equal(exhausted.feedback?.at(-1)?.status, "repairing",
      "红灯仍要留痕(反馈账本 repairing),人工处理后可闭环");
    // 取证照做:产物镜像不因预算关断而缺席。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      "pipeline", "build.log")), "预算关断不影响取证镜像");
    assert.equal(model.requests.length, requestsAfterMr,
      "预算耗尽后不得再有平台回合");
    // ③ 用户人工介入后发消息仍能继续(闸门不锁死会话)。
    await service.reply(created.id, "我已在平台豁免告警,请重跑确认");
    assert.equal(service.get(created.id).status, "running");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

// ---- 红灯切换(#247,ADR-0024):平台不再分诊、不再代举卡——失败 ----
// ---- 事实(摘要/明细/镜像)三态发送给 AI,三路处置由它现场判断。 ----

/** 落一个「MR 已申报、流水线监看中」的最小现场:构造服务即恢复,
 *  监看器重挂表直奔红灯终态——发送/举卡/停机测试不用重走全链(拉单→
 *  分析→修→推→MR 三回合),聚焦终态判定本身。watch 覆盖项供停机
 *  通知类测试预置 reds/过期 deadline(票 81),缺省维持原演出。 */

test("红灯不可修:AI 在发送回合举 pipeline_unfixable 卡带事实,纯确认作答不开回合只重看同 SHA", async () => {
  const dataDir = mfcTemp("mfc-issue-unfixable-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck 阶段失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
        message: "规则 R1 命中" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  // 种子夹具是七阶段历史形状:mr_green 的现行索引(4)在旧数组里是
  // done,会被判"已收口"挡住申报提醒分支。对齐现行五阶段(mr_green
  // 进行中),重看跑绿才能走进「提醒重新申报」的既有终态路径。
  {
    const statePath = join(dataDir, "issues", "issue-1", "issue.json");
    const seededState = JSON.parse(readFileSync(statePath, "utf-8")) as {
      stage_states: string[];
    };
    seededState.stage_states = ["done", "done", "done", "done", "in_progress"];
    writeFileSync(statePath, JSON.stringify(seededState));
  }
  const luban = new FakeLubanServer();
  await luban.start();
  // 剧本(#247):红灯事实发送开回合,AI 判断红灯全部来自平台侧工具
  // 告警,当场举不可修卡(举卡幕+文本幕);作答重看跑绿后再吃申报
  // 提醒幕。平台只投事实;名单(unfixableTools)已不参与问题流,
  // 配置在场也不影响判定。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_unfixable", repo: origin,
      supplement: "红灯全部来自 SuperChecker 平台侧告警(规则 R1),"
        + "改代码解决不了,需人工在交付平台处理/豁免" } } },
    { text: "已举卡等待人工处理。" },
    { text: "收到,重新申报 MR 清单。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    // 名单在场也不影响:分诊已交 AI(回归锚——配置不再拦截问题流)。
    unfixableTools: ["SuperChecker"],
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    const sha = "c".repeat(40);
    // 发送回合先开:失败摘要/逐维度明细/镜像落点/三路处置指引进词。
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "红灯事实发送回合启动");
    assert.match(requestText, /流水线未通过/);
    assert.match(requestText, /CodeCheck 阶段失败/);
    assert.match(requestText, /CODECHECK\(tool=SuperChecker\)/,
      "逐维度明细带工具与缺陷条目");
    assert.match(requestText, /pipeline\/ 目录/, "镜像产物落点");
    assert.match(requestText, /raise_gate/, "三路处置指引带工具指路");
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_unfixable"
        ? issue : undefined;
    }, "AI 举出不可修人工卡");
    const gate = gated.gate!;
    // 卡面(#247):问题=注册表模板,context=AI 的事实补充(supplement),
    // 定位字段带仓与提交(作答重看按它重置监看账)。
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.equal(gate.pipeline?.sha, sha, "闸要带归属提交(作答重看同一 SHA)");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "resume", label: "已在平台处理/豁免,重新监看" }]);
    assert.equal(gate.question.questions[0].recommended, undefined,
      "人工事实卡不派推荐(宿主核验不了平台侧处理)");
    assert.match(gate.question.questions[0].question, /交付平台处理或豁免/,
      "卡面问题用注册表模板");
    assert.match(gate.context ?? "", /SuperChecker/, "AI 的事实补充随卡(context)");
    // 发送回合=修复回合:reds 已记一轮、刹车账已落;停表留痕照旧。
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, 1,
      "发送已记一轮预算(举卡发生在发送回合里)");
    assert.equal(gated.pipelines?.[origin]?.last_repair_sha, sha,
      "刹车账已记本轮提交");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing",
      "红灯反馈账本留痕(人在平台处理后由新绿灯闭环)");
    assert.ok(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")), "取证镜像照做(不因举卡缺席)");
    // 小鲁班等待卡通知:卡面问题与 AI 补充(context)到达。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "小鲁班通知");
    assert.match(JSON.stringify(messages), /交付平台/);
    assert.match(JSON.stringify(messages), /SuperChecker/);
    // 认不得的答复打回(状态未动,闸还在)。
    assert.throws(() =>
      service.answer("issue-1", { state_version: gate.state_version,
        code: "hold" }), /无法识别的验证答复/);
    assert.equal(service.get("issue-1").gate?.kind, "pipeline_unfixable",
      "打回后闸仍在场");
    // 作答(纯确认,无补充说明):重置监看账(deadline 重置、watching=true、
    // 红灯环账清零)并重新监看同一 SHA,不开回合——带话路径另测(ADR-0049)。
    const deadlineBefore = gated.pipelines?.[origin]?.deadline ?? "";
    service.answer("issue-1", {
      state_version: gate.state_version,
      code: "resume",
    });
    const rearmed = await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return issue.gate === undefined && issue.status === "idle"
        && watch?.watching && watch.status === "running"
        && watch.deadline > deadlineBefore
        ? issue : undefined;
    }, "作答后重置监看账重新挂表");
    assert.equal(rearmed.pipelines?.[origin]?.sha, sha, "同一 SHA 重新监看");
    assert.equal(rearmed.pipelines?.[origin]?.last_error, undefined,
      "上一轮红灯留痕清掉");
    assert.equal(rearmed.pipelines?.[origin]?.reds, 0,
      "预算账归零(重看是新一轮)");
    assert.equal(rearmed.pipelines?.[origin]?.last_repair_sha, undefined,
      "刹车账清掉(重看仍红不误判同提交刹车)");
    // 平台侧已处理(假件第二轮终态即 success):绿了走既有终态路径——
    // 提醒 AI 重新申报 MR 清单(申报账在红灯时已打回)。
    await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.status === "success" ? issue : undefined;
    }, "重新监看后跑绿");
    assert.equal(service.get("issue-1").pipelines?.[origin]?.reds, 0,
      "绿灯清零红灯计数");
    const reminderText = await until(() =>
      model.requests.length >= 3 ? JSON.stringify(model.requests) : undefined,
    "全绿后的申报提醒回合");
    assert.match(reminderText, /complete_stage/, "提醒重新申报 MR 清单");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

test("红灯不可修作答带补充说明(#368,ADR-0049):开回合带话让 AI 先处置,监看照挂", async () => {
  const dataDir = mfcTemp("mfc-issue-unfixable-notes-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck 阶段失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
        message: "规则 R1 命中" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  {
    const statePath = join(dataDir, "issues", "issue-1", "issue.json");
    const seededState = JSON.parse(readFileSync(statePath, "utf-8")) as {
      stage_states: string[];
    };
    seededState.stage_states = ["done", "done", "done", "done", "in_progress"];
    writeFileSync(statePath, JSON.stringify(seededState));
  }
  const luban = new FakeLubanServer();
  await luban.start();
  // 剧本:红灯事实回合举卡(幕1/幕2),作答带补充说明→带话回合(幕3),
  // 重看跑绿后的申报提醒(幕4)。带话回合与提醒的先后不作保(监看与回
  // 合并行挂,忙时提醒走转投),断言只认请求内容、不认请求顺序。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_unfixable", repo: origin,
      supplement: "红灯全部来自 SuperChecker 平台侧告警(规则 R1),"
        + "改代码解决不了,需人工在交付平台处理/豁免" } } },
    { text: "已举卡等待人工处理。" },
    { text: "收到补充说明,这就回退 C++ 改用 JS 实现。" },
    { text: "收到,重新申报 MR 清单。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    const sha = "c".repeat(40);
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_unfixable"
        ? issue : undefined;
    }, "AI 举出不可修人工卡");
    const gate = gated.gate!;
    const deadlineBefore = gated.pipelines?.[origin]?.deadline ?? "";
    // 作答带指令型补充说明:开回合把话递给 AI(只进账本不开回合=用户没说)。
    service.answer("issue-1", {
      state_version: gate.state_version,
      code: "resume",
      notes: "能不能不改c++,直接js这边排序一下?把你的C++修改回退掉",
    });
    assert.match(service.get("issue-1").stage_note ?? "", /用户补充/,
      "状态行带补充标识(同步落盘,回合尚未覆盖)");
    // 带话回合:正文带补充说明全文与监看定位(仓与提交)。标记用
    // gate.resume.notes 独有短语——「用户补充说明」在工具 schema 里
    // 也出现,不能当检索标记。
    const notesTurn = await until(() =>
      model.requests.map((request) => JSON.stringify(request))
        .find((text) => text.includes("已按用户的作答重新监看流水线")),
    "补充说明作为回合正文送达 AI");
    assert.match(notesTurn, /把你的C\+\+修改回退掉/, "补充说明全文进词");
    assert.match(notesTurn, new RegExp(origin), "带话正文带监看仓");
    assert.match(notesTurn, /c{12}/, "带话正文带监看提交");
    // 监看账重置与纯确认同口径:同 SHA 重看、环账清零;状态不落 idle
    // (带话回合在飞,状态由回合体自管)。
    await until(() => {
      const issue = service.get("issue-1");
      const watch = issue.pipelines?.[origin];
      return issue.gate === undefined && watch?.watching
        && watch.status === "running"
        && watch.deadline > deadlineBefore ? issue : undefined;
    }, "作答后重置监看账重新挂表");
    const rearmed = service.get("issue-1");
    assert.equal(rearmed.pipelines?.[origin]?.sha, sha, "同一 SHA 重新监看");
    assert.equal(rearmed.pipelines?.[origin]?.reds, 0,
      "预算账归零(重看是新一轮)");
    assert.equal(rearmed.pipelines?.[origin]?.last_repair_sha, undefined,
      "刹车账清掉(重看仍红不误判同提交刹车)");
    // 重看跑绿,申报提醒照旧——带话不挡终态处理路径。
    const reminder = await until(() =>
      model.requests.length >= 4 ? JSON.stringify(model.requests) : undefined,
    "全绿后的申报提醒回合");
    assert.match(reminder, /complete_stage/, "提醒重新申报 MR 清单");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});


test("全绿但 AI 停在 fix 阶段没推进(#357):全绿兜底开回合指路推进+申报,不静默定格", async () => {
  const dataDir = mfcTemp("mfc-issue-fix-stage-green-");
  const origin = bareOrigin(dataDir);
  // 首个终态即 success:种子会话停在 fix 阶段、MR 已建、监看在表——
  // 复现"AI 推完代码没调 complete_stage 就收嘴,在 fix 阶段等绿"。
  const platform = new LoopPlatform("success");
  await platform.start();
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  const sha = "c".repeat(40);
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "fix 阶段等绿夹具", description: "", source: "dts",
    ticket: "DTS-2026-1002",
    repo_url: origin, repo_urls: [origin], scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "in_progress", "pending",
      "pending", "pending"],
    status: "idle", stage: "fix", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch: "master_dev_DTS-2026-1002",
      sha, at: now }],
    mrs: [{ repo: origin, branch: "master_dev_DTS-2026-1002",
      title: "[DTS-2026-1002] fix 阶段等绿夹具",
      url: "http://loop.test/mr/1", at: now }],
    pipelines: {
      [origin]: {
        sha, status: "running", watching: true,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  const model = new ScriptedModelServer([
    { text: "收到,先调 complete_stage 推进阶段,再申报 MR 清单。" },
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
    const reminderText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "全绿后的 fix 阶段推进提醒回合");
    assert.match(reminderText, /全部 MR 流水线已跑绿/);
    assert.match(reminderText, /还停在「问题修复」阶段/,
      "提醒要点破会话停在 fix 阶段");
    assert.match(reminderText, /complete_stage/, "指路推进与申报");
    // 不收口:阶段推进是 AI 的事,平台只指路。
    assert.equal(service.get("issue-1").stage, "fix", "阶段不代推进");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "提醒回合收口落 idle");
    assert.equal(settled.stage, "fix");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("名单不参与问题流:unfixableTools 配置在场也不拦截——照常发送事实派发修复", async () => {
  const dataDir = mfcTemp("mfc-issue-unfixable-miss-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/Order.java", line: 88,
        message: "命名不规范[1002]" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "收到,按证据修。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    // 名单配的是别的工具(#247 后名单整体退场):配置在场也不影响——
    // 平台只投事实,可不可修由 AI 现场判断。
    unfixableTools: ["OtherChecker"],
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "红灯事实发送回合派出");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /第 1\/20 轮红灯/, "照常发送,文案带红灯轮次");
    assert.match(requestText, /逐维度明细/, "事实明细给全");
    assert.match(requestText, /CODECHECK\(tool=SuperChecker\)/,
      "明细点名维度与工具");
    assert.match(requestText, /raise_gate/, "三路处置指引在场");
    assert.doesNotMatch(requestText, /照常修复/,
      "宿主侧分级文案已退场(处置由 AI 判断)");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "发送回合派出即记一轮预算");
    assert.equal(settled.feedback?.at(-1)?.status, "repairing");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("红灯不分级:部分维度缺定位→事实照全量发送,明细按维度给全,reds 记一轮", async () => {
  const dataDir = mfcTemp("mfc-issue-evidence-partial-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    // 编译有结构化明细(可修),CodeCheck 只有汇总没定位——平台不再
    // 区分"有证据/缺口":两边的明细都原样进发送词,判断交 AI。
    log: "流水线运行失败",
    checks: [
      { dimension: "COMPILE", status: "failed",
        details: [{ file: "src/service/Order.java", line: 88,
          message: "cannot find symbol: orderCache" }] },
      { dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
        details: [{ tool: "SuperChecker", message: "规则 1002:方法超长" }] },
    ],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "先修有证据的维度。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
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
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "部分缺定位的红灯事实发送回合派出");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /流水线未通过/);
    assert.match(requestText, /逐维度明细/);
    assert.match(requestText, /src\/service\/Order\.java:88/,
      "编译维的可定位明细原样下发");
    assert.match(requestText, /CODECHECK\(tool=SuperChecker\)/,
      "汇总维也在明细里(定位缺不缺由 AI 判断)");
    assert.match(requestText, /规则 1002:方法超长/);
    assert.match(requestText, /pipeline_evidence/,
      "指引带证据缺口路(raise_gate 指路)");
    assert.doesNotMatch(requestText, /照常修复/,
      "不再按维度拆「照常修复/不许猜改」两半");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "发送即记一轮,预算照记");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("红灯证据全缺:AI 举回灌卡请人贴原文,作答回灌原文且不重复计数", async () => {
  const dataDir = mfcTemp("mfc-issue-evidence-none-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    // 只有总体失败:checks 无明细——平台只投事实,缺口由 AI 在发送
    // 回合里判断并自己举回灌卡(#247)。
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed" }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_evidence", repo: origin,
      supplement: "编译/构建 红灯但平台只给了状态,"
        + "没有可定位的报错原文,需要人从平台复制" } } },
    { text: "已举卡等待用户贴原文。" },
    { text: "收到,按回灌的原文修。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // #578：这里验证到期后的举卡与回灌，重试恢复由专门用例覆盖。
    settings: { ...fastPoll, runtime: () => ({ ...fastPoll.runtime(), poll_timeout_s: 0 }) },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "pipeline_evidence"
        ? issue : undefined;
    }, "AI 举出报错回灌卡");
    const gate = gated.gate!;
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "supply", label: "已粘贴报错原文,继续修复" }]);
    assert.match(gate.question.questions[0].question, /粘贴/,
      "卡面问题用注册表模板,指引人把原文贴进作答");
    assert.match(gate.context ?? "", /没有可定位的报错原文/,
      "AI 的缺口说明随卡(context)");
    assert.equal(gated.status, "waiting_user", "举闸即等作答");
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, 1,
      "发送回合已记一轮预算(回灌是同轮延续)");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing", "留痕照记");
    assert.ok(model.requests.length >= 1,
      "发送回合在场(卡由 AI 在发送回合里举)");
    // 镜像产物在场(build.log)也保留；采证评估与缺失原因一起交给 AI。
    assert.ok(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")), "取证镜像照做");
    // 空答复打回:码到了但原文没贴,选项标签不能冒充证据。
    assert.throws(() =>
      service.answer("issue-1", { state_version: gate.state_version,
        code: "supply" }), /报错原文/);
    assert.equal(service.get("issue-1").gate?.kind, "pipeline_evidence",
      "打回后闸仍在场");
    // 作答(自由文本主通道,只给文本不带码也受理——码从文本在场归码):
    // 原文作为人工证据注入回灌回合;发送已记一轮,回灌不重复计数。
    const pasted = "BUILD FAILURE: src/service/Order.java:88 "
      + "cannot find symbol: orderCache(人工从平台复制的原文)";
    service.answer("issue-1", { state_version: gate.state_version,
      decision: pasted });
    const requestText = await until(() =>
      model.requests.length >= 3 ? JSON.stringify(model.requests) : undefined,
    "带着回灌证据的修复回合派出");
    assert.match(requestText, /人工贴进来的报错原文/,
      "回合文案带人工证据段");
    assert.match(requestText, /Order\.java:88/, "粘贴的原文随回合下发");
    assert.match(requestText, /不许猜改/,
      "回灌回合保留猜改纪律(gate.evidence 文案)");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.gate, undefined, "闸随作答清场");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "回灌回合不重复计数(发送已记)");
    assert.match(settled.pipelines?.[origin]?.last_failure_summary ?? "",
      /人工回灌的报错原文/, "刹车账改记人工回灌摘要");
    assert.equal(settled.feedback?.at(-1)?.status, "repairing");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("红灯不分级:UT 红灯+镜像日志有 Jest 失败原文→事实照发送指路镜像,不举卡", async () => {
  const dataDir = mfcTemp("mfc-issue-ut-jest-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "UT", status: "failed", tool: "build2.0" }],
  };
  // 镜像产物是前端测试失败原文:平台把产物全文镜像进 pipeline/,发送
  // 词指路读全文——修不修得了由 AI 凭现场事实判断,不再做内容背书。
  platform.firstFailureArtifacts = [{
    name: "build_log_ut-1.txt",
    text: JEST_LOG,
  }];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按 UT 原文修。" },
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
    "UT 红灯事实发送回合派出");
    assert.match(requestText, /第 1\/20 轮红灯/);
    assert.match(requestText, /UT\(tool=build2\.0\)/,
      "UT 维在逐维度明细里点名");
    assert.match(requestText, /失败产物全文已镜像/,
      "镜像产物指路(AI 自己读全文)");
    assert.match(requestText, /build_log_ut-1/);
    assert.match(requestText, /raise_gate/, "三路处置指引在场");
    assert.equal(service.get("issue-1").gate, undefined,
      "平台不代举任何卡(举不举由 AI 判断)");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "发送回合派出即记一轮预算");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("红灯 issue-28 形态:维度错配的质量门红灯照常发送,摘要与镜像产物都给全", async () => {
  const dataDir = mfcTemp("mfc-issue-issue28-");
  const origin = bareOrigin(dataDir);
  // 真实脱敏样例:构建 record 全 SUCCESS(errorInfo 拒答),红的是质量门
  // 指标(js pass rate 99.78%<100、DT 缺陷 1),Jest 原文在 build_log 里;
  // 平台把失败维度报成 CODECHECK,缺陷归属工具 build2.0 被归类到编译维。
  // #247 后平台不做内容背书/兜底评估:摘要(log)、维度明细与镜像清单
  // 原样发送,错配怎么认、按什么修由 AI 读镜像全文现场判断。
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck2.0 质量门未达标: js pass rate 99.7778 < 100, DT 缺陷 1",
    checks: [{ dimension: "CODECHECK", status: "failed",
      tool: "CodeCheck2.0" }],
  };
  platform.firstFailureArtifacts = issue28Artifacts();
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const model = new ScriptedModelServer([
    { text: "收到,按 Jest 原文修。" },
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
    "维度错配红灯照常发送(不再举卡)");
    assert.match(requestText, /流水线未通过/);
    assert.match(requestText, /CodeCheck2\.0 质量门未达标/,
      "质量门摘要(log)原样下发");
    assert.match(requestText, /CODECHECK\(tool=CodeCheck2\.0\)/,
      "平台报的维度原样点名");
    assert.match(requestText, /失败产物全文已镜像/);
    assert.match(requestText, /build_log_/,
      "镜像清单点名产物,修复侧按日志原文定位");
    assert.equal(service.get("issue-1").gate, undefined,
      "平台不代举任何卡(处置由 AI 判断)");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1,
      "发送回合照常计预算");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("名单未配置→照常发送事实派发修复(名单已整体退出问题流)", async () => {
  const dataDir = mfcTemp("mfc-issue-unfixable-none-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "CodeCheck 阶段失败",
    checks: [{
      dimension: "CODECHECK", status: "failed", tool: "SuperChecker",
      details: [{ tool: "SuperChecker", file: "src/A.java", line: 0,
        message: "规则 R1 命中" }],
    }],
  };
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const script: Scene[] = [{ text: "收到,按证据修。" }];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    // 不配置名单(#247 后名单整体退场):平台只投事实,分诊交 AI。
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return model.requests.length ? issue : undefined;
    }, "红灯事实发送回合派出");
    assert.equal(service.get("issue-1").gate, undefined,
      "平台不代举卡");
    const requestText = JSON.stringify(model.requests);
    assert.match(requestText, /第 1\/20 轮红灯/, "照常发送,文案带红灯轮次");
    assert.match(requestText, /逐维度明细/);
    assert.match(requestText, /CODECHECK\(tool=SuperChecker\)/);
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    assert.equal(settled.pipelines?.[origin]?.reds, 1);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

// ---- 停机通知 + 盲输入闸(票 81):放弃点主动喊人(需求侧 ----
// ---- notifyRepairStopped 同语义),盲输入并入证据回灌举卡路。 ----


test("红灯修复轮预算耗尽→小鲁班停机通知(标题/单号/原因/轮次/建议动作);同因恢复重放不重发", async () => {
  const dataDir = mfcTemp("mfc-issue-budget-notify-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed", "failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 预算 1、reds 已 1:第一次红灯记账就到顶——停机喊人,不派回合。
  seedMrGreenWatch(dataDir, origin, { reds: 1 });
  const luban = new FakeLubanServer();
  await luban.start();
  // 幂等键在通知器实例内记账:两次构造服务共用同一实例(与 serve
  // 同形——通知器是进程级单例),恢复重放才验的是真幂等。
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const buildService = () => new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: {
      models: () => ({}),
      runtime: () => ({ poll_interval_s: 1, poll_timeout_s: 120, repair_rounds: 1 }),
    },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier,
    linkBase: "http://work.test",
  });
  const service = buildService();
  try {
    const stopped = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.pipelines?.[origin]?.last_error?.includes("修复轮预算耗尽")
        ? issue : undefined;
    }, "红灯预算耗尽停机");
    assert.equal(stopped.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(stopped.pipelines?.[origin]?.reds, 2, "停机前记了一轮");
    assert.equal(model.requests.length, 0, "预算耗尽不开平台回合");
    // 通知到达:问题标题/单号、放弃原因、轮次(x/max)、建议动作。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "停机通知到达");
    assert.equal(messages.length, 1, "同因只发一条");
    const text = JSON.stringify(messages);
    assert.match(text, /红灯分诊夹具/, "问题标题入文案");
    assert.match(text, /DTS-2026-1002/, "单号入文案");
    assert.match(text, /连续 2 次红灯/, "轮次(x)入文案");
    assert.match(text, /1 轮\)已耗尽,自动修复已放弃/, "轮次(max)与放弃原因入文案");
    assert.match(text, /请人工查看 MR\/流水线/, "建议动作入文案");
    assert.match(text, /发消息继续/, "建议动作含续跑指引");
    // 幂等键落在 outcome 通道既有机制:会话:原因:仓:提交。
    const key = `issue-1:outcome:pipeline_repair_exhausted:${origin}:`
      + "c".repeat(40);
    assert.ok(notifier.list().some((record) => record.waiting_id === key),
      "幂等键=会话 id+原因+提交(outcome 通道 waiting_id)");
    // 同因再停机不重发:恢复重放(监看账重挂同一提交)再次停机,
    // outcome 通道凭同键幂等,用户只收一条。
    await service.shutdown().catch(() => undefined);
    rearmMrGreenWatch(dataDir, origin);
    const revived = buildService();
    try {
      await until(() => {
        const issue = revived.get("issue-1");
        return issue.pipelines?.[origin]?.watching === false ? issue : undefined;
      }, "恢复重放后再次停机");
      // 第二次停机的通知调用在停表同一同步段内完成,留一拍再对账。
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(luban.messages.length, 1, "同因恢复重放不重发");
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});


test("流水线轮询预算到点→终查+自动延期一次(#372)→延期也耗尽停表喊人(带延期留痕);同因恢复重放不重发", async () => {
  const dataDir = mfcTemp("mfc-issue-watch-notify-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  await platform.start();
  // deadline 已过期:恢复重挂表后循环条件立刻为假,先终查(假件前两次
  // 状态查询回 running)再走延期路(#372)——首耗尽不再直落停表。
  seedMrGreenWatch(dataDir, origin, {
    deadline: new Date(Date.now() - 60_000).toISOString(),
  });
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  await model.start();
  const readWatch = (): IssuePipelineWatch => {
    const state = JSON.parse(readFileSync(
      join(dataDir, "issues", "issue-1", "issue.json"), "utf-8")) as {
      pipelines: Record<string, IssuePipelineWatch>;
    };
    return state.pipelines[origin];
  };
  const buildService = (platformUrl: string) => new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier,
    linkBase: "http://work.test",
  });
  const service = buildService(platform.baseUrl);
  try {
    // 第一拍到点:终查仍在跑→自动延期一次——继续监看、deadline 改写、
    // 落盘留痕,不停表、不喊人、不开平台回合。
    const extended = await until(() => {
      const watch = readWatch();
      return (watch.deadline_extensions ?? 0) >= 1 ? watch : undefined;
    }, "到期自动延期一次");
    assert.equal(extended.watching, true, "延期后继续监看");
    assert.ok(Date.parse(extended.deadline) > Date.now(),
      "deadline 改写到未来(一个完整预算)");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(luban.messages.length, 0, "延期不喊人");
    assert.equal(model.requests.length, 0, "延期不开平台回合");
    await service.shutdown().catch(() => undefined);
    // 第二拍到点(延期额度已尽):停表喊人,停表路文案与通知都带
    // 「已自动延期一次」留痕。
    rearmMrGreenWatch(dataDir, origin, {
      deadline: new Date(Date.now() - 60_000).toISOString(),
    });
    const revived = buildService(platform.baseUrl);
    try {
      const stopped = await until(() => {
        const issue = revived.get("issue-1");
        if (issue.status === "failed") throw new Error(issue.error ?? "failed");
        return issue.pipelines?.[origin]?.watching === false ? issue : undefined;
      }, "延期耗尽后停表");
      assert.match(stopped.pipelines?.[origin]?.last_error ?? "",
        /轮询预算耗尽\(已自动延期一次\)/);
      assert.match(stopped.stage_note ?? "", /已自动延期一次/);
      assert.equal(model.requests.length, 0, "停表不开平台回合");
      // 通知到达:标题/单号、放弃原因(含延期留痕)、轮次、建议动作。
      const messages = await until(() =>
        luban.messages.length ? luban.messages : undefined, "停机通知到达");
      assert.equal(messages.length, 1, "同因只发一条");
      const text = JSON.stringify(messages);
      assert.match(text, /红灯分诊夹具/, "问题标题入文案");
      assert.match(text, /DTS-2026-1002/, "单号入文案");
      assert.match(text, /已自动延期一次/, "延期留痕入通知文案");
      assert.match(text, /第 1 轮验证/, "监看轮次入文案");
      assert.match(text, /请人工查看 MR\/流水线/, "建议动作入文案");
      assert.match(text, /发消息继续/, "建议动作含续跑指引");
      const key = `issue-1:outcome:pipeline_watch_timeout:${origin}:`
        + "c".repeat(40);
      assert.ok(notifier.list().some((record) => record.waiting_id === key),
        "幂等键=会话 id+原因+提交(outcome 通道 waiting_id)");
      // 同因再停机不重发:换一块没出过终态的平台假件(避免重放的终查
      // 恰好吃到「第三次查询出终态」的剧本),deadline 依旧过期,延期
      // 计数保持 1——恢复重放再次停表,同键幂等不重发。
      await revived.shutdown().catch(() => undefined);
      const platform2 = new LoopPlatform("failed");
      await platform2.start();
      try {
        rearmMrGreenWatch(dataDir, origin, {
          deadline: new Date(Date.now() - 60_000).toISOString(),
        });
        const again = buildService(platform2.baseUrl);
        try {
          await until(() => {
            const issue = again.get("issue-1");
            return issue.pipelines?.[origin]?.watching === false
              ? issue : undefined;
          }, "恢复重放后再次停表");
          await new Promise((resolve) => setTimeout(resolve, 500));
          assert.equal(luban.messages.length, 1, "同因恢复重放不重发");
        } finally {
          await again.shutdown().catch(() => undefined);
        }
      } finally {
        await platform2.stop();
      }
    } finally {
      await revived.shutdown().catch(() => undefined);
    }
  } finally {
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});


test("盲输入形态:零 checks+链接式摘要+零产物→事实照发送,AI 举回灌卡请人贴原文", async () => {
  const dataDir = mfcTemp("mfc-issue-blind-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  // 内网实锤形态:摘要=标签+链接(会话没登录态打不开),checks 缺席,
  // 产物零镜像。#578 在有限重试到期后发送缺口，
  // 由 AI 判断并举 pipeline_evidence 卡请人贴原文。
  platform.firstFailure = {
    log: "FAILED stage=CodeCheck2.0 job=CodeCheck2.0  detail: "
      + "https://loop.test/pipeline/1",
  };
  platform.firstFailureArtifacts = [];
  await platform.start();
  seedMrGreenWatch(dataDir, origin);
  const luban = new FakeLubanServer();
  await luban.start();
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: {
      kind: "pipeline_evidence", repo: origin,
      supplement: "失败摘要只有链接且无产物,会话打不开链接,"
        + "没有可定位的报错原文" } } },
    { text: "已举卡等待用户贴原文。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // #578：这里验证到期后的举卡与回灌，重试恢复由专门用例覆盖。
    settings: { ...fastPoll, runtime: () => ({ ...fastPoll.runtime(), poll_timeout_s: 0 }) },
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier: new Notifier({ endpoint: luban.endpoint, fake: true }),
    linkBase: "http://work.test",
  });
  try {
    // 发送回合先开:盲形态如实说明——逐维度明细缺席、零产物不造假。
    const requestText = await until(() =>
      model.requests.length ? JSON.stringify(model.requests) : undefined,
    "盲输入形态的红灯事实发送回合启动");
    assert.match(requestText, /流水线未通过/);
    assert.match(requestText, /FAILED stage=CodeCheck2\.0/,
      "链接式摘要原样下发");
    assert.match(requestText, /\(平台未返回逐维度明细\)/,
      "checks 缺席如实说明");
    assert.match(requestText, /平台未返回本次失败产物/, "零产物如实说明");
    const gated = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "pipeline_evidence" ? issue : undefined;
    }, "AI 举出报错回灌卡");
    const gate = gated.gate!;
    assert.equal(gate.pipeline?.repo, origin, "闸要带归属仓");
    assert.equal(gate.pipeline?.sha, "c".repeat(40), "闸要带归属提交");
    assert.deepEqual(gate.question.questions[0].options,
      [{ code: "supply", label: "已粘贴报错原文,继续修复" }],
      "与证据全缺同一条回灌卡路");
    assert.match(gate.question.questions[0].question, /粘贴/,
      "卡面问题用注册表模板,指引人把报错原文贴进作答");
    assert.match(gate.context ?? "", /摘要只有链接且无产物/,
      "AI 的盲因说明随卡(context)");
    assert.equal(gated.status, "waiting_user", "举闸即等作答");
    assert.equal(gated.pipelines?.[origin]?.watching, false, "监看停表");
    assert.equal(gated.pipelines?.[origin]?.reds, 1,
      "发送回合已记一轮预算(举卡发生在发送回合里)");
    assert.equal(gated.feedback?.at(-1)?.status, "repairing", "留痕照记");
    assert.equal(existsSync(join(dataDir, "issues", "issue-1",
      "pipeline", "build.log")), false, "零产物前提成立");
    // 小鲁班等待卡通知也带盲因(context),人不用开网页就知道要贴原文。
    const messages = await until(() =>
      luban.messages.length ? luban.messages : undefined, "等待卡通知");
    assert.match(JSON.stringify(messages), /摘要只有链接且无产物/);
    assert.match(JSON.stringify(messages), /粘贴/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});

/** 盲输入形态的"能修"对照组(票 81 红线的延续):三种情形必须照常
 *  发送事实并派发修复,零影响。各起一个独立现场,断言回合派出、无闸、reds 记一轮。 */

test("盲输入形态不误伤:摘要有真实内容/产物在场/checks 明细三种情形照常发送派发修复", async () => {
  // ① checks 缺席但摘要有真实内容(零产物):既有默认路径,显式钉死。
  await assertRepairDispatched({
    what: "checks 缺席但摘要有真实内容",
    firstFailure: { log: "BUILD FAILURE: 模块 notify-service 编译失败" },
    artifacts: [],
    expect: [/流水线未通过/, /BUILD FAILURE: 模块 notify-service/,
      /\(平台未返回逐维度明细\)/],
  });
  // ② 产物在场(哪怕摘要只是链接):镜像产物比链接可信,放行派发修复。
  await assertRepairDispatched({
    what: "产物在场(摘要只是链接)",
    firstFailure: { log: "流水线失败详情: https://loop.test/pipeline/1" },
    expect: [/流水线未通过/, /失败产物全文已镜像/],
  });
  // ③ checks 有结构化明细:失败维度在场,逐维度明细给全。
  await assertRepairDispatched({
    what: "checks 有结构化明细",
    firstFailure: {
      log: "流水线运行失败",
      checks: [{ dimension: "COMPILE", status: "failed",
        details: [{ file: "src/service/Order.java", line: 88,
          message: "cannot find symbol: orderCache" }] }],
    },
    expect: [/流水线未通过/, /逐维度明细/, /src\/service\/Order\.java:88/],
  });
});

// ---- 同提交刹车(票 82,part2):防原地打转——红灯还是上次派发修复 ----
// ---- 的同一提交即停机。证据重试窗已随红灯切换(#247)整体退场。   ----

