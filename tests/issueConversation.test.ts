/**
 * 问题域协作流投影(ADR-0018:问题工作台复用任务工作台,协作流吃
 * 同形状成员)的契约测试:事件账本 → 会话流条目,纯函数接缝,不碰
 * HTTP。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { issueConversation } from "../src/issueFlow/conversation.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

let seq = 0;
function ev(kind: string, payload: Record<string, unknown> = {}, ts?: string) {
  return {
    eventId: ++seq,
    taskId: "issue-1", sessionId: "issue-1",
    ts: ts ?? new Date(Date.now() + seq * 1000).toISOString(),
    kind, payload,
  };
}

test("会话起讫:session_started/ended 投影为 session 条目,resume 标记随行", () => {
  const items = issueConversation([
    ev("session_started", { resume: true }),
    ev("session_ended", { reason: "archive", detail: "已归档" }),
  ], {}).items;
  assert.equal(items[0].kind, "session");
  assert.equal(items[0].phase, "started");
  assert.equal(items[0].resume, true);
  assert.equal(items[1].kind, "session");
  assert.equal(items[1].phase, "ended");
  assert.equal(items[1].detail, "已归档");
});

test("回合聚合:assistant 发言入 texts,平台工具回执计入 steps,turn_finished 收口", () => {
  const items = issueConversation([
    ev("session_started"),
    ev("assistant_message", { text: "先拉单据" }),
    ev("tool_requested", { call_id: "c1", name: "dts_get_ticket", input: {} }),
    ev("tool_finished", { call_id: "c1", name: "dts_get_ticket",
      is_error: false, result: "单据详情…" }),
    ev("assistant_message", { text: "单据已通读,进入拉仓" }),
    ev("turn_finished", { reason: "end_turn" }),
  ], {}).items;
  const turn = items.find((item) => item.kind === "turn") as
    Extract<typeof items[number], { kind: "turn" }>;
  assert.ok(turn, "回合条目在场");
  assert.equal(turn.texts.length, 2);
  assert.equal(turn.texts[0].role, "narration");
  assert.equal(turn.texts[1].role, "handoff", "收口前的最后一句是交接语");
  assert.equal(turn.steps.calls, 1);
  assert.equal(turn.steps.errors, 0);
  assert.equal(turn.open, false);
  assert.ok(turn.end_ts);
});

test("未收口的回合 open=true:没有 turn_finished 就悬置", () => {
  const items = issueConversation([
    ev("session_started"),
    ev("assistant_message", { text: "正在分析" }),
  ], {}).items;
  const turn = items.at(-1) as Extract<typeof items[number], { kind: "turn" }>;
  assert.equal(turn.kind, "turn");
  assert.equal(turn.open, true);
});

test("插话与续聊:user_message 投影为 steer 条目", () => {
  const items = issueConversation([
    ev("user_message", { text: "优先查登录服务", via: "interrupt" }),
    ev("user_message", { text: "补充:重启过服务" }),
  ], {}).items;
  assert.equal(items[0].kind, "steer");
  assert.equal(items[0].delivered, true);
  assert.equal(items[1].kind, "steer");
});

test("Agent 卡:卡账源是 waiting.json 记录(真 waiting_id/真状态),事件不出卡", () => {
  const items = issueConversation([
    ev("tool_requested", { call_id: "c2", name: "AskUserQuestion", input: {
      questions: [{ question: "基线分支对吗?", options: ["master", "dev"] }],
    } }),
    ev("human_decision", { waiting_id: "issue-1:c2", state_version: 1,
      decision: "master", notes: "" }),
    ev("turn_finished", { reason: "end_turn" }),
  ], { agentCards: [{
    waiting_id: "issue-1:c2", step: "问题分析",
    created_at: "2026-09-07T00:00:00.000Z",
    question: { questions: [{ question: "基线分支对吗?", options: ["master", "dev"] }] },
    status: "resolved",
  }] }).items;
  const cards = items.filter((item) => item.kind === "card");
  assert.equal(cards.length, 1, "卡只有一张,来自 waiting.json 记录");
  const card = cards[0] as Extract<typeof items[number], { kind: "card" }>;
  assert.equal(card.waiting_id, "issue-1:c2",
    "真 waiting_id:卡座去重与选项高亮都靠它连接");
  assert.equal(card.status, "resolved");
  // purpose 按协议缺省 confirmation(任务侧 purposeOf 同一口径);
  // 旧事件路硬编码 clarification 本身就是错的。
  assert.equal(card.purpose, "confirmation");
  assert.equal(card.step, "问题分析");
  assert.deepEqual(card.questions[0]?.options, ["master", "dev"]);
});

test("重复举卡事件不重复出卡:重放与子会话拒绝的 AskUserQuestion 事件不冒充卡", () => {
  const question = {
    questions: [{ question: "采用哪个修复方案?", options: ["方案A", "方案B"] }],
  };
  const items = issueConversation([
    ev("tool_requested", { call_id: "c2", name: "AskUserQuestion", input: question }),
    // 重建会话把同一调用重放:账本里第二个同名词事件(转录配对所需,
    // sessionDriver 有意为之)——它不是第二张卡。
    ev("tool_requested", { call_id: "c2", name: "AskUserQuestion", input: question }),
    // 子 Agent 里的 AskUserQuestion 是拒绝工具,同样落同名词事件。
    ev("tool_requested", { call_id: "c9", name: "AskUserQuestion", input: question }),
  ], { agentCards: [{
    waiting_id: "issue-1:c2", step: "",
    created_at: "2026-09-07T00:00:00.000Z",
    question, status: "waiting",
  }] }).items;
  const cards = items.filter((item) => item.kind === "card");
  assert.equal(cards.length, 1, "三条同名词事件只出记录对应的那一张卡");
  assert.equal((cards[0] as Extract<typeof items[number], { kind: "card" }>)
    .status, "waiting");
});

test("平台闸裁决:human_decision 带问句快照投影为 decision,闸题是确认不是澄清", () => {
  const items = issueConversation([
    ev("human_decision", { waiting_id: "g1", state_version: 2,
      decision: "确认报告,开始问题修复", notes: "补充一句",
      gate: { questions: [{ question: "问题分析报告已产出,请查阅后确认",
        options: ["确认报告,开始问题修复", "有补充意见(填写补充说明)"] }] } }),
  ], {}).items;
  const decision = items[0] as Extract<typeof items[number], { kind: "decision" }>;
  assert.equal(decision.kind, "decision");
  assert.equal(decision.purpose, "confirmation");
  assert.equal(decision.questions?.length, 1);
  assert.equal(decision.notes, "补充一句");
});

test("检视:review_submitted 投影为 review 条目", () => {
  const items = issueConversation([
    ev("review_submitted", { count: 2, text: "检视《登录超时》的结果…" }),
  ], {}).items;
  assert.equal(items[0].kind, "review");
  assert.equal(items[0].count, 2);
});

test("回执:平台工具的 tool_finished 投影为 receipts 条目(成功失败都留痕)", () => {
  const items = issueConversation([
    ev("tool_finished", { call_id: "c3", name: "push_branch",
      is_error: false, result: "已推送 master_dev_D1 @ abc" }),
    // request_env 举配置卡是成功收口(2026-09-08):发起请求本身完成了,
    // 不再借错误通道——回执画 ✓ 不画 ✕。
    ev("tool_finished", { call_id: "c4", name: "request_env",
      is_error: false, result: "已向用户发起网管环境配置请求,等待填写" }),
    ev("tool_finished", { call_id: "c6", name: "pull_repo",
      is_error: true, result: "远端不可达:克隆失败" }),
    // bash 是过程性调用:进回合 steps,不单列回执。
    ev("tool_finished", { call_id: "c5", name: "bash",
      is_error: false, result: "ok" }),
  ], {}).items;
  const receipts = items.find((item) => item.kind === "receipts") as
    Extract<typeof items[number], { kind: "receipts" }>;
  assert.ok(receipts, "回执条目在场");
  assert.equal(receipts.items.length, 3, "bash 不进回执");
  assert.equal(receipts.items[0].outcome, "success");
  assert.equal(receipts.items[1].outcome, "success",
    "举配置卡是成功收口,不是失败");
  assert.equal(receipts.items[2].outcome, "error");
});

test("在场闸:未作答的平台闸投影为 waiting 卡,排在流末尾", () => {
  const items = issueConversation([
    ev("session_started"),
  ], { waitingCard: {
    waiting_id: "gate-9", step: "问题分析",
    question: "问题分析报告已产出,请查阅 issue-analysis.md 后确认",
    options: ["确认报告,开始问题修复", "有补充意见(填写补充说明)"],
  } }).items;
  const card = items.find((item) => item.kind === "card") as
    Extract<typeof items[number], { kind: "card" }>;
  assert.ok(card, "在场闸投影为卡");
  assert.equal(card.status, "waiting");
  assert.equal(card.waiting_id, "gate-9");
  assert.equal(card.purpose, "confirmation");
  assert.equal(card.step, "问题分析");
});

test("投影片上顶:超限保留最新并如实标注 truncated,events_seen 计全量", () => {
  const rows = [ev("session_started")];
  for (let index = 0; index < 900; index += 1) {
    rows.push(ev("user_message", { text: `第 ${index} 句` }));
  }
  const view = issueConversation(rows, { maxItems: 100 });
  assert.equal(view.events_seen, 901);
  assert.equal(view.truncated, true);
  assert.ok(view.items.length <= 100);
  assert.equal(view.items.at(-1)?.kind, "steer", "保留的是最新尾部");
});

test("坏账容忍:未知事件跳过,投影不炸", () => {
  const view = issueConversation([
    ev("session_started"),
    ev("mystery_event" as never, {}),
    { garbage: true } as never,
  ], {});
  assert.equal(view.items[0].kind, "session");
  assert.equal(view.items.length, 1);
});

test("服务级:等待中的 Agent 卡流内只有一条投影,waiting_id 是真去重键", async () => {
  const dataDir = mfcTemp("mfc-issue-conv-card-");
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: {
      context: "已对齐两个候选修复方案",
      questions: [{
        question: "采用哪个修复方案?",
        options: ["方案A:超时回收", "方案B:扩容连接池"],
        recommended: "方案A:超时回收",
      }],
    } } },
    { text: "收到,按方案A处理完毕,本回合到此。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const { MockDtsGateway } = await import("../src/issueFlow/gateways.ts");
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    // 等「等人卡」的管道测试:显式三档对齐(ADR-0019 缺省二档会代答)。
    interventionTier: () => "3",
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: "DTS-2026-1001", source: "dts",
    });
    const until = async (probe: () => boolean, what: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (probe()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`超时:${what}`);
    };
    await until(() =>
      service.get(created.id).status === "waiting_user", "Agent 卡举卡");
    // 用户实测症状:等待中的卡在流里出现两份(流内一份还误标已决定)。
    // 契约:卡座去重键(waiting_id)真实在卡条目上,且流内只有这一条。
    const waiting = service.conversation(created.id);
    const waitingCards = waiting.items.filter((item) => item.kind === "card");
    assert.equal(waitingCards.length, 1, "等待中的卡流内只有一条投影");
    assert.equal((waitingCards[0] as Extract<typeof waiting.items[number],
      { kind: "card" }>).waiting_id, `${created.id}:scripted-0`,
      "卡条目带真 waiting_id,与卡座同一把钥匙");
    // 作答后:同一张卡转已决,不新增第二张。
    service.answer(created.id, {
      state_version: 1, answers: { "0": "opt-0-0" },
    });
    await until(() =>
      service.get(created.id).status === "idle", "作答后收口");
    const resolved = service.conversation(created.id);
    const resolvedCards = resolved.items.filter((item) => item.kind === "card");
    assert.equal(resolvedCards.length, 1, "答完还是同一张卡,不重复");
    assert.equal((resolvedCards[0] as Extract<typeof resolved.items[number],
      { kind: "card" }>).status, "resolved");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("服务级冒烟:真实会话的协作流有回合回放,在场闸投影为 waiting 卡", async () => {
  const dataDir = mfcTemp("mfc-issue-conv-svc-");
  const origin = join(dataDir, "origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  const model = new ScriptedModelServer([
    { tool: { name: "request_env", input: {} } },
    { text: "等待网管环境配置。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    // 等 env 闸的管道测试:三档对齐(2026-10-31 起三档同举,ADR-0019 增补)。
    interventionTier: () => "3",
  });
  try {
    const created = service.create({
      account: "dev", title: "协作流冒烟", repoUrl: origin,
      ticket: "DTS-2026-1001", source: "dts",
    });
    // 轮询等闸(request_env 举闸后 settle 定格 waiting_user),不睡死等。
    const until = async (probe: () => boolean, what: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (probe()) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail(`超时:${what}`);
    };
    await until(() =>
      service.get(created.id).status === "waiting_user", "env_needed 闸");
    // 在场闸投影为 waiting 卡。
    const raised = service.conversation(created.id);
    assert.ok(raised.events_seen > 0, "事件账本已落");
    const liveCard = raised.items.find((item) =>
      item.kind === "card" && item.status === "waiting") as
      Extract<typeof raised.items[number], { kind: "card" }> | undefined;
    assert.ok(liveCard, "在场闸投影为 waiting 卡");
    assert.equal(liveCard.purpose, "confirmation");
    // 配置环境清闸后,waiting 卡消失;历史里剩回合回放。
    service.attachEnvironment(created.id, {
      hosts: ["192.0.2.8"], backendPassword: "env-shared-secret",
    });
    const cleared = service.conversation(created.id);
    assert.equal(cleared.items.some((item) =>
      item.kind === "card" && item.status === "waiting"), false,
      "清闸后不再有 waiting 卡");
    assert.ok(cleared.items.some((item) => item.kind === "turn"),
      "回合回放在场");

    // HTTP 冒烟(handleIssueRoutes 直调,先例 issueFlowContract):登录
    // 可读、形状对、未登录 401。
    const { handleIssueRoutes } = await import("../src/issueFlow/routes.ts");
    const call = (parts: string[], viewer?: object) =>
      new Promise<{ status: number; body: Record<string, any> }>(
        (resolve, reject) => {
          let status = 0;
          void handleIssueRoutes(
            { method: "GET" } as never,
            {
              writeHead: (code: number) => { status = code; },
              end: (payload?: string) => {
                try { resolve({ status, body: JSON.parse(payload ?? "{}") }); }
                catch (error) { reject(error); }
              },
            } as never,
            parts,
            { issueFlow: service, authEnabled: true,
              ...(viewer ? { viewer } : {}) } as never,
          ).catch(reject);
        });
    const ok = await call(["issues", created.id, "conversation"],
      { username: "dev", role: "developer" });
    assert.equal(ok.status, 200);
    assert.ok(Array.isArray(ok.body.items), "协作流条目是数组");
    assert.ok(ok.body.events_seen > 0);
    const denied = await call(["issues", created.id, "conversation"]);
    assert.equal(denied.status, 401, "未登录 401");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("插话入队不冒充已读取，界面只展示用户原话；批量交办保留接收说明", () => {
  const body = "请改两行\n[内部处理指引]";
  const events = [ev("user_message", { text: body, display: "请改两行", via: "interrupt" }),
    ev("review_submitted", { count: 2, text: "两条意见", mode: "incremental", receipt: "已接收，结合当前工作处理" })];
  const pending = issueConversation(events, { pendingSteers: [body] }).items;
  assert.equal(pending[0].kind, "steer");
  if (pending[0].kind === "steer") {
    assert.equal(pending[0].delivered, false);
    assert.equal(pending[0].text, "请改两行");
  }
  if (pending[1].kind === "review") {
    assert.equal(pending[1].delivery_mode, "incremental");
    assert.match(pending[1].receipt!, /已接收/);
  } else assert.fail("缺少批量交办条目");
  const consumed = issueConversation(events, { pendingSteers: [] }).items[0];
  assert.equal(consumed.kind === "steer" && consumed.delivered, true);
});
