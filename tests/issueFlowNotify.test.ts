/**
 * 问题流接入小鲁班通知的契约测试(对齐需求侧公共能力):
 * - Agent 举卡(AskUserQuestion)与平台闸卡转 waiting_user 时,通知
 *   归属用户,载荷钉死(waiting_id/账号/questions/link/state_version);
 * - 平台闸卡通知给人话 label 不给决策码,waiting_id 用 gate.id;
 * - 非等人收口(idle/终态)不通知;重启恢复不重复轰炸;
 * - 通知是旁路:notifier 缺席(未配置)一切照旧。
 *
 * 范式与 issueFlowFixed.test.ts 同款:ScriptedModelServer 剧本 +
 * FakeLubanServer 假小鲁班,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const LINK_BASE = "https://mfc.example.com";

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

/** 带审批码的假小鲁班通知器:mobileApproval 打开后 latestApproval 里
 * 能读到 stateVersion/waitingId——通知载荷里无处安放的字段从这条
 * 手机审批绑定上断言。 */
function makeNotifier(luban: FakeLubanServer): Notifier {
  return new Notifier({
    endpoint: luban.endpoint,
    mobileApproval: true,
    approvalCode: ({ stateVersion }) => `CODE-${stateVersion}`,
    backoffMs: [0],
  });
}

function baseOptions(dataDir: string, model: ScriptedModelServer) {
  // 本文件测的是「等人卡」的通知管道:显式三档对齐,防止缺省二档
  // 把纯选项卡自动代答(ADR-0019)。
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    interventionTier: () => "3" as const,
  };
}

test("Agent 举卡等决策:通知归属用户,载荷钉死;恢复不重复,正常收口不通知", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      context: "已对齐两个候选修复方案",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    } } },
    { text: "收到,按方案A处理完毕,本回合到此。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  const dataDir = mfcTemp("mfc-issue-notify-");
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    // linkBase 带尾斜杠:链接拼接必须归一,不出现双斜杠。
    notifier,
    linkBase: `${LINK_BASE}/`,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    // ① 举卡 → waiting_user → 通知送达,载荷与卡一一对应。
    const record = await until(() => notifier.list()[0], "Agent 卡通知");
    // until 把 false 也当"已就绪"(非 undefined 即返回),这里必须
    // 回传数组本身做真值探针,等发送真正落账再断言条数。
    await until(() => luban.messages.length >= 1 ? luban.messages : undefined,
      "通知送达假小鲁班");
    assert.equal(record.task_id, created.id);
    assert.equal(record.account, "dev");
    assert.equal(record.waiting_id, `${created.id}:scripted-0`,
      "waiting_id = 会话:callId,幂等去重的锚");
    assert.equal(record.link, `${LINK_BASE}/issues/${created.id}`);
    assert.ok(record.summary.includes("采用哪个修复方案?"));
    assert.ok(record.summary.includes("方案A:超时回收"),
      "Agent 卡通知带选项原文(Agent 自己的措辞),不是投影码");
    assert.ok(!record.summary.includes("opt-0-0"), "决策码不发给人");
    assert.ok(record.text.includes("登录超时"), "subject = 会话标题");
    const approval = notifier.latestApproval("dev");
    assert.equal(approval?.waitingId, record.waiting_id);
    assert.equal(approval?.stateVersion, 1, "state_version 随通知出卡");

    // ② 重启恢复:waiting_user 照旧等家人,不重跑 settle,不重复轰炸。
    await service.shutdown();
    const restarted = new IssueFlowService({
      ...baseOptions(dataDir, model),
      notifier,
      linkBase: LINK_BASE,
    });
    const after = restarted.get(created.id);
    assert.equal(after.status, "waiting_user", "恢复不重跑等待卡");
    assert.equal(notifier.list().length, 1, "恢复不重复通知");
    assert.equal(luban.messages.length, 1);

    // ③ 作答后续跑正常收口(idle):非等人,不通知。
    restarted.answer(created.id, {
      state_version: 1,
      answers: { "0": "opt-0-0" },
    });
    await until(() => {
      const issue = restarted.get(created.id);
      return issue.status === "idle" ? issue : undefined;
    }, "作答后续跑收口");
    assert.equal(notifier.list().length, 1, "正常收口不通知");
    assert.equal(luban.messages.length, 1);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("平台闸卡:通知用人话 label 不带决策码,waiting_id 用 gate.id", async () => {
  const script: Scene[] = [
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "complete_stage", input: { note: "本单无需代码仓" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  const service = new IssueFlowService({
    ...baseOptions(mfcTemp("mfc-issue-notify-"), model),
    notifier,
    linkBase: LINK_BASE,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind
        === "analysis_confirm" ? issue : undefined;
    }, "分析确认闸");
    const record = await until(() => notifier.list()[0], "平台闸卡通知");
    assert.equal(record.waiting_id, gate.gate!.id,
      "幂等锚是闸卡自己的 id,不是 Agent 卡的 waiting.json 记录");
    assert.equal(record.task_id, created.id);
    assert.equal(record.account, "dev");
    assert.equal(record.link, `${LINK_BASE}/issues/${created.id}`);
    // 通知给人话:码表 label 全文在场,决策码一个都不出现。
    assert.ok(record.summary.includes("确认报告,开始问题修复"));
    assert.ok(record.summary.includes("有补充意见(填写补充说明)"));
    assert.ok(!record.summary.includes("confirm"));
    assert.ok(!record.summary.includes("supplement"));
    // step = stage_note(来自 complete_stage 的收口注记),不是阶段键。
    assert.equal(record.step, "跳过拉取代码仓:本单无需代码仓");
    assert.ok(record.text.includes(`登录超时(单号 ${TICKET})`),
      "有单号时 subject 拼上单号");
    const approval = notifier.latestApproval("dev");
    assert.equal(approval?.waitingId, gate.gate!.id);
    assert.equal(approval?.stateVersion, gate.gate!.state_version,
      "手机审批绑定核对闸卡的 state_version");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

test("notifier 缺席(未配置):举卡照常等待,不炸不通知", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "继续还是停止?",
        options: ["继续", "停止"],
        recommended: "继续",
      }],
    } } },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(mfcTemp("mfc-issue-notify-"), model),
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
    });
    const issue = await until(() => {
      const current = service.get(created.id);
      return current.status === "waiting_user" ? current : undefined;
    }, "未配通知器时照常举卡");
    assert.ok(issue.waiting, "问题卡照常在场,流程不受通知配置影响");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});
