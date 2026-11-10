/**
 * issue 流固定流程长轴 part 2/2(共 13 用例)。
 * 共享夹具在 tests/issueFlowFixed.helpers.ts(拆分背景见其头注);
 * 证据重试窗系列已随红灯切换(#247)整体退场删除——机制退场后
 * 只保留「存量盘 retry 字段被 recover 清扫」的迁移钉。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { loadState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

import {
  GIT_ENV,
  bareOrigin,
  MODULE_ID,
  seedModule,
  NO_TICKET_ENV,
  until,
  fastPoll,
  BRANCH,
  LoopPlatform,
  seedMrGreenWatch,
  TRUNCATED_TOOL_BASH,
  seedGreenWatch,
  headSha,
} from "./issueFlowFixed.helpers.ts";

test("重试窗退场迁移:存量盘 evidence_retry_* 死账字段重启被 recover 清扫", async () => {
  const dataDir = mfcTemp("mfc-issue-retry-sweep-");
  const origin = bareOrigin(dataDir);
  // 证据重试窗已随红灯切换(#247)整体退场:存量盘上可能还留着旧机制
  // 落的 retry 字段(窗停机后升级/重启的现场)。recover() 顺手清账——
  // 不清的话它们就是永远没人读的死账,还会在 wire 上误导前端。
  seedMrGreenWatch(dataDir, origin, { watching: false });
  const statePath = join(dataDir, "issues", "issue-1", "issue.json");
  const seed = JSON.parse(readFileSync(statePath, "utf-8")) as {
    pipelines: Record<string, Record<string, unknown>>;
  };
  seed.pipelines[origin].evidence_retry_deadline =
    new Date(Date.now() - 60_000).toISOString();
  seed.pipelines[origin].evidence_retry_attempts = 2;
  seed.pipelines[origin].evidence_failure_log = "BUILD FAILURE(旧账)";
  writeFileSync(statePath, JSON.stringify(seed));
  // 无 platformUrl:清扫在 recover,与平台无关。
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: { scripted: {} },
    settings: fastPoll,
    dts: new MockDtsGateway(),
  });
  try {
    await until(() => {
      const after = JSON.parse(readFileSync(statePath, "utf-8")) as {
        pipelines: Record<string, Record<string, unknown>>;
      };
      return "evidence_retry_deadline" in after.pipelines[origin]
        ? undefined : after;
    }, "重启清扫 retry 死账字段");
    const after = JSON.parse(readFileSync(statePath, "utf-8")) as {
      pipelines: Record<string, Record<string, unknown>>;
    };
    assert.equal("evidence_retry_attempts" in after.pipelines[origin], false,
      "重试次数字段一并清扫");
    assert.equal("evidence_failure_log" in after.pipelines[origin], false,
      "窗内失败摘要字段一并清扫");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});


test("同提交刹车:修了没出新提交再红灯→停机带 AI 诊断+通知,reds 不变", async () => {
  const dataDir = mfcTemp("mfc-issue-brake-");
  const origin = bareOrigin(dataDir);
  // 红到底:第一轮派发修复后,同一提交再红(重推无新提交)触发刹车。
  const platform = new LoopPlatform("failed", "failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 工作区:真实克隆+交付分支(push_branch 要求克隆在场)。种子夹具的
  // sha 是假串,而 push_branch 会把台账更新为工作区真实 HEAD——把种子
  // 的提交统一改成真实 HEAD,"同 SHA 重推"才真的同 SHA。
  const clone = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone], { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", BRANCH],
    { env: GIT_ENV });
  execFileSync("git", ["-C", clone, "commit", "-q", "--allow-empty",
    "-m", "red commit"], { env: GIT_ENV });
  const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"])
    .toString().trim();
  seedMrGreenWatch(dataDir, origin, { sha: head });
  const statePath = join(dataDir, "issues", "issue-1", "issue.json");
  const seeded = JSON.parse(readFileSync(statePath, "utf-8")) as {
    pushes: Array<{ sha: string }>;
    pipelines: Record<string, { sha: string }>;
  };
  seeded.pushes[0].sha = head;
  seeded.pipelines[origin].sha = head;
  writeFileSync(statePath, JSON.stringify(seeded));
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = new Notifier({ endpoint: luban.endpoint, fake: true });
  // 第一轮派发修复的剧本:重推同一提交+重建 MR(没有新 commit),收口
  // 发言=诊断。
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { text: "对比了报错,这个编译告警改不动,需要平台侧处理。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
    notifier,
    linkBase: "http://work.test",
  });
  try {
    // 第一轮:照常派发修复并落刹车账。
    await until(() => model.requests.length ? model.requests : undefined,
      "第一轮派发修复");
    const dispatched = await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.last_repair_sha === head
        ? issue : undefined;
    }, "派发修复写入刹车账");
    assert.equal(dispatched.pipelines?.[origin]?.reds, 1);
    // 同 SHA 再红:刹车停机——不再派第二轮,reds 不变,诊断进留痕。
    const braked = await until(() => {
      const issue = service.get("issue-1");
      return issue.pipelines?.[origin]?.last_error?.includes("同一提交")
        ? issue : undefined;
    }, "同提交刹车停机");
    assert.equal(braked.pipelines?.[origin]?.reds, 1,
      "刹车不消耗修复轮预算(reds 不变)");
    assert.match(braked.stage_note ?? "", /AI 最后诊断/, "诊断写进留痕");
    assert.match(braked.stage_note ?? "", /改不动/, "诊断是会话原话");
    await until(() => luban.messages.length ? luban.messages : undefined,
      "刹车停机通知");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // 线性剧本按场景计请求(3 场景=3 请求):判"没有第二轮发送"要看
    // 请求里有没有第二轮红灯的发送词(#247:轮次词=「第 N/20 轮红灯」)。
    assert.doesNotMatch(JSON.stringify(model.requests), /第 2\/20 轮红灯/,
      "刹车后不再发送第二轮修复回合");
    assert.equal(luban.messages.length, 1, "同因只发一条");
    const text = JSON.stringify(luban.messages);
    assert.match(text, /红灯分诊夹具/, "问题标题入文案");
    assert.match(text, /DTS-2026-1002/, "单号入文案");
    assert.match(text, /同一提交/, "刹车原因入文案");
    assert.match(text, /改不动/, "AI 诊断入通知");
    assert.match(text, /请人工查看/, "建议动作入文案");
    const key = `issue-1:outcome:pipeline_repair_brake:${origin}:${head}`;
    assert.ok(notifier.list().some((record) => record.waiting_id === key),
      "幂等键=会话+刹车原因+仓+提交");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
    await luban.stop();
  }
});


test("同提交刹车对照:换新提交红灯照常派发修复,回合文案含上轮报错段与换思路纪律", async () => {
  const dataDir = mfcTemp("mfc-issue-brake-miss-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("failed");
  platform.firstFailure = {
    log: "流水线运行失败",
    checks: [{ dimension: "COMPILE", status: "failed",
      details: [{ file: "src/service/Order.java", line: 88,
        message: "cannot find symbol: orderCache" }] }],
  };
  await platform.start();
  // 上次派发修复的是另一个提交("d" 串):本次红灯=新提交,不刹车照常派;
  // 盘上预置上轮报错摘要,断言它拼进回合提示词。
  seedMrGreenWatch(dataDir, origin, {
    reds: 1,
    last_repair_sha: "d".repeat(40),
    last_failure_summary: "失败维度: 编译/构建;"
      + "BUILD FAILURE: 模块 notify-service 编译失败(上一轮原文)",
  });
  const model = new ScriptedModelServer([
    { text: "收到,先对比上轮报错再修。" },
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
    "换新提交照常发送派发修复");
    assert.match(requestText, /第 2\/20 轮红灯/, "reds 跨 SHA 累计,照常发送");
    assert.match(requestText, /逐维度明细/);
    assert.match(requestText,
      new RegExp(`上一轮\\(提交 ${"d".repeat(12)}\\)红灯的报错摘要`),
      "上轮报错段随回合下发");
    assert.match(requestText, /先对比是否同一处/);
    assert.match(requestText, /notify-service 编译失败/, "上轮摘要在场");
    assert.match(requestText, /同一处必须换思路/, "换思路纪律入文案");
    assert.match(requestText, /直说修不了/, "修不了出口入文案");
    assert.match(requestText, /不许重复同样的修改/, "反重复纪律入文案");
    const settled = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "idle" ? issue : undefined;
    }, "修复回合收口");
    const watch = settled.pipelines?.[origin];
    assert.equal(watch?.reds, 2, "新提交红灯照常 reds+1");
    assert.equal(watch?.last_repair_sha, "c".repeat(40),
      "刹车账更新为本轮提交");
    assert.match(watch?.last_failure_summary ?? "", /编译\/构建/,
      "本轮红灯摘要落账");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("环境预热:拉仓收口进 analyze 时后台启动,收据落台账不上 wire", async () => {
  const dataDir = mfcTemp("mfc-issue-warmup-");
  const origin = bareOrigin(dataDir);
  const warmupWorkspaces: string[] = [];
  let releaseWarmup: () => void = () => {};
  const warmupStarted = new Promise<void>((resolve) => {
    releaseWarmup = resolve;
  });
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n是问题(索引缺失)。\\n## 置信度\\n高。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论是问题,已提交等用户确认。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime: () => ({ issue_warmup_enabled: 1 }) },
    warmup: {
      enabled: true,
      runner: async (request) => {
        warmupWorkspaces.push(request.workspace);
        releaseWarmup();
        return {
          status: "passed", message: "基线全绿", build_command: "mvn compile",
        };
      },
    },
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    // complete_stage 推进进 analyze 时启动:预热与主 Agent 并行,主流程
    // 不等它——结论闸照常升起。
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸");
    await warmupStarted;
    assert.equal(warmupWorkspaces.length, 1, "预热恰好启动一次");
    assert.equal(warmupWorkspaces[0],
      join(dataDir, "issues", created.id), "workspace=会话工作区根");
    const receipt = await until(() => {
      const state = JSON.parse(readFileSync(
        join(dataDir, "issues", created.id, "issue.json"), "utf-8")) as {
        warmup?: { status: string; finished_at?: string; detail?: string;
          build_command?: string };
      };
      return state.warmup?.finished_at ? state.warmup : undefined;
    }, "预热收据");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.detail, "基线全绿");
    assert.equal(receipt.build_command, "mvn compile");
    // 收据上 wire(对齐清单⑤):前端判"预热在跑/结果"决定直播面板。
    assert.ok("warmup" in service.get(created.id));
    // 幂等:收过收据不再重跑(闸作答推进后计数不变)。
    service.answer(created.id, {
      state_version: gate.gate!.state_version, code: "issue",
    });
    assert.equal(service.get(created.id).status, "archived",
      "确认结论按 ADR-0048 直接归档，预热结果不改变终态");
    assert.equal(warmupWorkspaces.length, 1, "收过收据不重跑");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("环境预热 fail-open:执行器异常落基建收据,主流程照走", async () => {
  const dataDir = mfcTemp("mfc-issue-warmup-fail-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示。\\n## 问题根因\\n是问题。\\n## 置信度\\n高。\\n## 修改方案\\n修。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题" } } },
    { text: "结论是问题。" },
  ];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime: () => ({ issue_warmup_enabled: 1 }) },
    warmup: {
      enabled: true,
      runner: async () => { throw new Error("预热容器炸了"); },
    },
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸(fail-open:预热异常不拦主流程)");
    const receipt = await until(() => {
      const state = JSON.parse(readFileSync(
        join(dataDir, "issues", created.id, "issue.json"), "utf-8")) as {
        warmup?: { status: string; finished_at?: string; detail?: string };
      };
      return state.warmup?.finished_at ? state.warmup : undefined;
    }, "预热收据(不留 running 僵账)");
    assert.equal(receipt.status, "infrastructure_failure");
    assert.match(receipt.detail ?? "", /预热容器炸了/);
    service.answer(created.id, {
      state_version: gate.gate!.state_version, code: "issue",
    });
    assert.equal(service.get(created.id).status, "archived",
      "预热失败不阻止确认结论后直接归档");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("环境预热补跑(#358):基建失败收据不算终局,analyze 续聊回合自动补跑", async () => {
  const dataDir = mfcTemp("mfc-issue-warmup-retry-");
  const origin = bareOrigin(dataDir);
  const warmupWorkspaces: string[] = [];
  // 每个续聊回合 = 1 幕收嘴 + 催办预算 2 幕(平台自动续跑),全纯文本
  // 确定性地耗尽催办落 idle,不给剧本对账留变数。
  const script: Scene[] = Array.from({ length: 11 }, () => (
    { text: "继续研究。" }));
  script[0] = { tool: { name: "pull_repo", input: { url: origin } } };
  script[1] = { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } };
  const model = new ScriptedModelServer(script, "scripted-v1",
    { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: { models: () => ({}), runtime: () => ({ issue_warmup_enabled: 1 }) },
    warmup: {
      enabled: true,
      runner: async (request) => {
        warmupWorkspaces.push(request.workspace);
        // 首跑执行器异常(重启中断/容器故障一类)落基建收据;
        // 续聊回合补跑成功,之后终局收据拦住一切再跑。
        if (warmupWorkspaces.length === 1) {
          throw new Error("预热容器炸了");
        }
        return { status: "passed", message: "基线全绿" };
      },
    },
  });
  try {
    seedModule(dataDir, origin);
    const created = service.create({
      account: "dev", title: "导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const statePath = join(dataDir, "issues", created.id, "issue.json");
    const readState = () => JSON.parse(readFileSync(statePath, "utf-8")) as {
      warmup?: { status: string; finished_at?: string; detail?: string };
      stage?: string;
    };
    // 首跑失败落基建收据,主流程照走:analyze 中段催办耗尽落 idle。
    await until(() => {
      const state = readState();
      return state.warmup?.finished_at && state.stage === "analyze"
        ? state.warmup : undefined;
    }, "首跑基建收据");
    await until(() => service.get(created.id).status === "idle"
      ? service.get(created.id) : undefined, "analyze 中段落 idle");
    assert.equal(warmupWorkspaces.length, 1, "基建失败后尚未补跑");
    assert.match(readState().warmup!.detail ?? "", /预热容器炸了/);
    // analyze 里的续聊回合:容器就绪即补跑,收据翻成终局 passed。
    service.reply(created.id, "继续推进分析");
    await until(() => readState().warmup?.status === "passed"
      ? readState().warmup : undefined, "补跑收据翻终局");
    assert.equal(warmupWorkspaces.length, 2, "基建失败收据恰好补跑一次");
    await until(() => service.get(created.id).status === "idle"
      ? service.get(created.id) : undefined, "补跑回合收口");
    // 终局收据(passed)拦住后续续聊回合,不再重跑。
    service.reply(created.id, "再补一点细节");
    await until(() => service.get(created.id).status === "idle"
      ? service.get(created.id) : undefined, "第三回合收口");
    assert.equal(warmupWorkspaces.length, 2, "终局收据后不再重跑");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 催办延续的互斥与忙撞(issue-20 复盘,2026-09-09) ----

/** 模拟 pi 的截断工具错误:报错文本同时携带"output token limit"与
 *  "was not executed"两个判据,驱动 fatalToolExecutionError 的真实
 *  检测链路(tool_execution_end → turnTerminalError → 自愈)。 */

test("催办延续握住回合互斥:催办进行中归档被 409,平台通知 steer 进当拍回合而非另开回合", async () => {
  const dataDir = mfcTemp("mfc-issue-nudge-mutex-");
  const origin = bareOrigin(dataDir);
  let releaseNudge!: () => void;
  const nudgeGated = new Promise<void>((resolve) => { releaseNudge = resolve; });
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { text: "先研究到这,稍后继续。" },
    { text: "收到,继续推进。" },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n现象已核实。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "根因=连接池耗尽" } } },
    { text: "分析已提交,等确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", {
    linear: true,
    beforeScene: async ({ requestNumber }) => {
      if (requestNumber === 4) await nudgeGated;
    },
  });
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
    await until(() => model.requests.length >= 4 ? true : undefined,
      "催办回合已发出并被扣住");
    service.attachEnvironment(created.id, NO_TICKET_ENV);
    assert.equal(service.get(created.id).status, "running",
      "催办进行中,通知不得改变运行状态");
    releaseNudge();
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "催办+插话送达后举结论卡");
    assert.equal(waiting.nudges, 1, "催办计数入账");
    assert.equal(model.requests.length, 7,
      "通知要在催办回合内送达,不得另开回合");
    const delivered = JSON.stringify(model.requests[4]);
    assert.match(delivered, /网管环境已配置/, "steer 的通知要进模型上下文");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("忙撞不炸单:催办撞上会话收尾窗口,重投一次仍忙则留话落 idle,会话还能继续", async () => {
  const dataDir = mfcTemp("mfc-issue-busy-collision-");
  const origin = bareOrigin(dataDir);
  const BUSY = "Agent is already processing. Specify streamingBehavior"
    + " ('steer' or 'followUp') to queue the message.";
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { text: "先研究到这,稍后继续。" },
    { text: "(占位,被网关错误顶掉)" },
    { text: "(占位,被网关错误顶掉)" },
    { tool: { name: "bash", input: { command:
      "printf '# 分析\\n\\n现象已核实。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "根因=连接池耗尽" } } },
    { text: "分析已提交,等确认。" },
  ];
  // 武装时机钉在钩子里(轮询武装会 flake):第 3 请求(收嘴幕)应答前
  // 生效,接下来两次(催办首投+让拍重投)都以 issue-20 的原文忙拒。
  const model = new ScriptedModelServer(script, "scripted-v1", {
    linear: true,
    beforeScene: ({ requestNumber }) => {
      if (requestNumber === 3) model.failWith(BUSY, 2);
    },
  });
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
    const settled = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle" && /相撞/.test(issue.stage_note ?? "")
        ? issue : undefined;
    }, "重投仍忙,留话落 idle");
    assert.notEqual(settled.status, "failed", "忙撞不是会话失败");
    assert.equal(settled.error, undefined, "不落错误账");
    assert.equal(model.requests.length, 5,
      "开场三幕+催办首投+让一拍重投,只补一次");
    const replied = service.reply(created.id, "继续,把分析做完");
    assert.equal(replied.status, "running");
    const waiting = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "忙撞后续聊照常举卡");
    assert.equal(model.requests.length, 8, "续聊恰好一个新回合");
    assert.match(JSON.stringify(model.requests[5]), /继续,把分析做完/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 输出超限截断的自愈(issue-12 复盘,2026-09-10) ----


test("输出超限自愈:截断后纠偏重试,模型精简重发举卡成功,会话不判死", async () => {
  const dataDir = mfcTemp("mfc-issue-truncation-heal-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "bash", input: { command: TRUNCATED_TOOL_BASH } } },
    { text: "我想一次性说明两个阻塞,但调用太长被截断了。" },
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "远端旧分支挡住推送:删除后重推,还是换分支名?",
    }] } } },
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
      return issue.status === "waiting_user" && issue.waiting ? issue : undefined;
    }, "纠偏后精简重发举卡");
    assert.ok(waiting.waiting, "问题卡在场");
    assert.equal(model.requests.length, 3, "纠偏恰好一次");
    assert.match(JSON.stringify(model.requests[2]), /平台纠偏\(第 1\/2 次\)/,
      "纠偏词要进模型上下文");
    assert.match(JSON.stringify(model.requests[2]), /大幅精简/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});


test("输出超限自愈穷尽:连续三次截断后落 idle 留话,不标 failed 不杀会话", async () => {
  const dataDir = mfcTemp("mfc-issue-truncation-exhaust-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "bash", input: { command: TRUNCATED_TOOL_BASH } } },
    { text: "(第一次截断后的文本说明)" },
    { tool: { name: "bash", input: { command: TRUNCATED_TOOL_BASH } } },
    { text: "(第二次截断后的文本说明)" },
    { tool: { name: "bash", input: { command: TRUNCATED_TOOL_BASH } } },
    { text: "(第三次截断后的文本说明)" },
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
    const settled = await until(() => {
      const issue = service.get(created.id);
      return issue.status === "idle" && /输出超限/.test(issue.stage_note ?? "")
        ? issue : undefined;
    }, "纠偏穷尽后落 idle 留话");
    assert.notEqual(settled.status, "failed", "截断不是会话失败");
    assert.equal(settled.error, undefined, "不落错误账");
    assert.equal(model.requests.length, 6, "首投+纠偏两次,不多不少");
    assert.match(JSON.stringify(model.requests[2]), /平台纠偏\(第 1\/2 次\)/);
    assert.match(JSON.stringify(model.requests[4]), /平台纠偏\(第 2\/2 次\)/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

// ---- 环境验证闸(2026-09-10 A 方案拍板):全绿≠修好,验证的是用户 ----

/** 直播一个"MR 跑绿监看中"的现场(恢复监看同款夹具,聚焦验证闸)。 */

test("环境验证闸·在场:通过无需作答(合入即通过),卡只收「发现问题」", async () => {
  const dataDir = mfcTemp("mfc-issue-verify-pass-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 全绿发送回合(#246):监看器收口发送事实,AI 经 raise_gate 举验证卡。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedGreenWatch(dataDir, origin, headSha(origin));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "g", email: "d@e" }),
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "全绿举验证闸");
    // ADR-0043:通过没有选项——沉默到合入即通过,自动归档由合入监看
    // 接管、结论按合入事实记 delivered(合入全链见 issueMergeFact);
    // 卡上只剩「验证发现问题」一个人工事实出口(回退路见下一测)。
    assert.deepEqual(
      gated.gate!.question.questions[0]!.options.map((option) => option.code),
      ["fail"], "通过无码,卡只收「验证发现问题」");
    assert.equal(gated.status, "waiting_user", "等待现场=验证卡在场");
    assert.match(gated.stage_note ?? "", /待环境验证/,
      "停机说明保持「待环境验证」口径");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("环境验证闸·不通过:回退问题分析,轮次+1,后续阶段标 redo,回退回合先对齐再重写", async () => {
  const dataDir = mfcTemp("mfc-issue-verify-fail-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 全绿发送回合举卡(#246)+回退回合与两次催办吃文本幕(线性钳到末幕)。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户验证。" },
    { text: "收到,先与用户对齐问题理解。" },
    { text: "(催办一)继续对齐中。" },
    { text: "(催办二)仍在推进。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedGreenWatch(dataDir, origin, headSha(origin));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "g", email: "d@e" }),
  });
  try {
    const gated = await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "全绿举验证闸");
    service.answer("issue-1", {
      state_version: gated.gate!.state_version, code: "fail",
      notes: "环境里订单导出仍然超时,截图 issue-images/0123456789abcdef.png",
    });
    // 回退回合收口后:预算内催办再跑,最终落 idle(停机交还人工)。
    const settled = await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" && issue.stage === "analyze"
        ? issue : undefined;
    }, "回退分析并停机等对齐");
    assert.equal(settled.round, 2, "回退轮次+1");
    assert.deepEqual(
      settled.stage_states?.slice(0, 5),
      ["done", "done", "in_progress", "redo", "redo"],
      "分析重开,修复与交付标 redo");
    assert.equal(settled.gate, undefined, "验证闸已随作答清面");
    // 回退回合是全绿发送举卡之后的第三个请求(#246:发送+举卡在前)。
    const rollbackTurn = JSON.stringify(model.requests[2]);
    assert.match(rollbackTurn, /环境验证发现问题/, "回退事实要带给 AI");
    assert.match(rollbackTurn, /订单导出仍然超时/, "用户描述要带给 AI");
    assert.match(rollbackTurn, /对齐/, "回退指令要求先对齐再重写");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("环境验证闸·不锁死:未作答也可直接取消(闸随终态清面)", async () => {
  const dataDir = mfcTemp("mfc-issue-verify-escape-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 全绿发送回合(#246):监看器收口发送事实,AI 经 raise_gate 举验证卡。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedGreenWatch(dataDir, origin, headSha(origin));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl,
    gitCredential: () => ({ username: "dev", password: "g", email: "d@e" }),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "全绿举验证闸");
    // 手动归档已随 ADR-0034 退役(交付出口=合入自动归档),未答卡的
    // 「不锁死」出口是取消——放弃这单,闸随终态清面;合入路的未答卡
    // 清面由 issueMergeFact 覆盖。
    const canceled = await service.control("issue-1", { action: "cancel" });
    assert.equal(canceled.status, "canceled", "未答验证也能取消(不锁死)");
    const saved = loadState(join(dataDir, "issues", "issue-1"))!;
    assert.equal(saved.gate, undefined, "终态不携闸");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});


test("环境验证闸·月光不代答:一档全自动下验证卡仍只等真人", async () => {
  const dataDir = mfcTemp("mfc-issue-verify-moonlight-");
  const origin = bareOrigin(dataDir);
  const platform = new LoopPlatform("success");
  await platform.start();
  // 全绿发送回合(#246):监看器收口发送事实,AI 经 raise_gate 举验证卡。
  const model = new ScriptedModelServer([
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "已举卡等待用户验证。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  seedGreenWatch(dataDir, origin, headSha(origin));
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), settings: fastPoll,
    platformUrl: platform.baseUrl,
    interventionTier: () => "1",
    gitCredential: () => ({ username: "dev", password: "g", email: "d@e" }),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      return issue.status === "waiting_user"
        && issue.gate?.kind === "env_verify" ? issue : undefined;
    }, "全绿举验证闸");
    // 直接驱动代答入口(一档全自动):env_verify 必须原地不动。
    const live = (service as any).live.get("issue-1");
    (service as any).maybeAutoAnswerGate(live);
    const after = service.get("issue-1");
    assert.equal(after.status, "waiting_user", "验证卡不被代答");
    assert.equal(after.gate?.kind, "env_verify", "闸仍在场");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
