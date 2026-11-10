/**
 * issueLubanApproval part 2:平台闸快路径:手机确认落账/空补充打回/多来源合册。
 * 共享夹具在 tests/issueLubanApproval.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueFlowLubanApproval } from "../src/issueFlow/lubanApproval.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import {
  lubanApprovalCode,
  LubanApprovalGateway,
  type LubanApprovalService,
} from "../src/lubanApproval.ts";
import type { TaskSummary } from "../src/taskService.ts";
import { mfcTemp } from "./mfcTmp.ts";
import {
  TICKET,
  TOKEN,
  until,
  makeNotifier,
  makeGateway,
  reply,
  makeService,
  ANALYZE_SCRIPT,
} from "./issueLubanApproval.helpers.ts";


test("平台闸卡:手机回复确认落账,闸清阶段走;卡换了回审批码过期", async () => {
  const model = new ScriptedModelServer(ANALYZE_SCRIPT, "scripted-v1",
    { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier);
    service = made.service;
    const { id } = made;
    const gated = await until(() => {
      const issue = service!.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind
        === "analysis_confirm" ? issue : undefined;
    }, "分析确认闸");
    const approval = await until(() => notifier.latestApproval("dev"),
      "闸卡通知");
    assert.equal(approval.waitingId, gated.gate!.id,
      "闸卡审批码绑 gate.id(与通知同锚)");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    const answer = await reply(gateway, "mae-flow 选择 "
      + `${approval.code} 1`);
    assert.equal(answer.status, 200);
    const cleared = await until(() => {
      const issue = service!.get(id);
      return issue.gate === undefined ? issue : undefined;
    }, "闸已清");
    assert.equal(cleared.gate, undefined);
    assert.ok((cleared.transitions ?? []).some((item) =>
      item.note.includes("用户作答(analysis_confirm)")),
    "闸作答进转移账");

    // 同一张码再答:卡已消费 → stale,不是 500。
    const stale = await reply(gateway, "mae-flow 选择 "
      + `${approval.code} 1`);
    assert.equal(stale.status, 409);
    assert.match(stale.text, /已更新或审批码已过期/);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});



test("「填写补充说明」类选项:空补充打回并指引;带说明的补充回流分析", async () => {
  const model = new ScriptedModelServer(ANALYZE_SCRIPT, "scripted-v1",
    { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier);
    service = made.service;
    const { id } = made;
    await until(() => {
      const issue = service!.get(id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind
        === "analysis_confirm" ? issue : undefined;
    }, "分析确认闸");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    // 选项 2 = 有补充意见(填写补充说明),不带说明打回。
    const rejected = await reply(gateway, "2");
    assert.equal(rejected.status, 409);
    assert.match(rejected.text, /需要附上说明/);
    assert.equal(service.get(id).gate?.kind, "analysis_confirm",
      "打回不动闸,卡还等着");
    // 序号+说明:受理,回流分析(补充意见不推进)。
    const accepted = await reply(gateway, "2: 先补登录日志再下结论");
    assert.equal(accepted.status, 200);
    const cleared = await until(() => {
      const issue = service!.get(id);
      return issue.gate === undefined ? issue : undefined;
    }, "补充后闸已清");
    const transition = (cleared.transitions ?? []).at(-1);
    assert.ok(transition?.note.includes("先补登录日志再下结论"),
      "补充说明进现场账");
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});



test("多来源合并:需求任务与问题卡同册,回复各归各家", async () => {
  const script: Scene[] = [
    { tool: { name: "AskUserQuestion", input: {
      questions: [{
        question: "继续还是停止?",
        options: ["继续", "停止"],
        recommended: "继续",
      }],
    } } },
    { text: "收到,继续处理完毕。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const notifier = makeNotifier(luban);
  let service: IssueFlowService | undefined;
  const decided: string[] = [];
  const fakeTasks: TaskSummary[] = [{
    id: "T-99",
    title: "需求任务",
    requirement: "需求任务",
    status: "waiting_for_human",
    luban_account: "dev",
    workspace: "/tmp/T-99",
    created_at: "2026-09-02T00:00:00.000Z",
    waiting: {
      waiting_id: "T-99:call-1", task_id: "T-99", step: "delivery_review",
      call_id: "call-1",
      question: { questions: [{ question: "Diff 通过吗?", options: ["通过", "打回"] }] },
      state_version: 1, status: "waiting", decision: "", notes: "",
      created_at: "2026-09-02T00:00:00.000Z", resolved_at: "",
    },
  }];
  const fakeService: LubanApprovalService = {
    list: () => fakeTasks,
    decide: async (id) => {
      decided.push(id);
      fakeTasks[0].status = "completed";
      return fakeTasks[0];
    },
  };
  try {
    const made = await makeService(model, notifier);
    service = made.service;
    const { id } = made;
    await until(() => service!.get(id).status === "waiting_user"
      ? service!.get(id) : undefined, "Agent 卡举卡");
    const gateway = makeGateway(
      [fakeService, new IssueFlowLubanApproval(service)], notifier);
    const list = await reply(gateway, "mae-flow 待审批");
    assert.match(list.text, /你有 2 项待审批/);
    assert.match(list.text, /需求任务/, "需求任务在册");
    assert.match(list.text, /问题 DTS-2026-1001/, "问题卡在册,称呼带「问题」");
    // 先答需求任务(序号 1 → T-99 详情 → 选「通过」):路由到需求侧。
    await reply(gateway, "1");
    const task = await reply(gateway, "1");
    assert.equal(task.status, 200);
    assert.deepEqual(decided, ["T-99"], "决定路由到需求任务来源");
    // 问题卡仍在册,单卡可继续裸序号作答:路由到问题适配层。
    const issueReply = await reply(gateway, "mae-flow 待审批");
    assert.doesNotMatch(issueReply.text, /需求任务/, "需求任务已收口");
    const answer = await reply(gateway, "1");
    assert.equal(answer.status, 200);
    await until(() => service!.get(id).status === "idle"
      ? service!.get(id) : undefined, "问题卡作答后续跑收口");
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

