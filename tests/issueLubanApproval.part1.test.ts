/**
 * issueLubanApproval part 1:审批码长流程:通知审批码同源,手机裸序号回复落账并续跑。
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


test("Agent 问题卡:通知审批码同源,手机裸序号回复落账并续跑", async () => {
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
  let service: IssueFlowService | undefined;
  try {
    const made = await makeService(model, notifier);
    service = made.service;
    const { id } = made;
    await until(() => service!.get(id).status === "waiting_user"
      ? service!.get(id) : undefined, "Agent 卡举卡");
    // 通知出卡,审批码与网关侧派码同源(同 token 同四元组)。
    const approval = await until(() => notifier.latestApproval("dev"),
      "等待卡通知");
    const gateway = makeGateway(new IssueFlowLubanApproval(service), notifier);
    const list = await reply(gateway, "mae-flow 待审批");
    assert.ok(list.text.includes(`mae-flow 选择 ${approval.code}`),
      "待办详情带审批码,用户可按码定位");
    // 裸序号回复(唯一待办):适配层 decide → answer → 续跑。
    const answer = await reply(gateway, "1");
    assert.equal(answer.status, 200);
    assert.match(answer.text, /已提交/);
    const done = await until(() => {
      const issue = service!.get(id);
      return issue.status === "idle" ? issue : undefined;
    }, "作答后续跑收口");
    assert.equal(done.waiting, undefined, "卡已消费");
    // 落的是用户选中的选项原文(Agent 看到自己的措辞)。
    assert.ok((done.last_reply ?? "").length > 0);
  } finally {
    await service?.shutdown().catch(() => undefined);
    await model.stop();
    await luban.stop();
  }
});

