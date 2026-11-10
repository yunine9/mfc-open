/**
 * 交付时间线语义(只读旁路):现场文件 → 人话条目。
 *
 * 钉四件事:
 * - 事实归纳:审批卡与决定、子 Agent 配对、质量台账成败、会话中断;
 * - 丢返回登记要显眼(run3 实锤的那类坑),但还在跑的子 Agent 不许
 *   被冤成"丢了";
 * - 内核 history 一步一条,且不复刻"步骤→阶段"映射(红线);
 * - fail-open:半行 JSON、缺文件、坏字段都只让那一条缺席,不炸整页。
 *
 * 不依赖 docker / PostgreSQL / 真模型——纯文件对拍。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildTimeline, type TimelineEntry } from "../src/timeline.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

/** 造一个假现场:workspace/events.jsonl + workspace/origin/内核文件。 */
function makeSite(options: {
  events?: Array<Record<string, unknown>>;
  rawEventsTail?: string;
  state?: Record<string, unknown>;
  ledger?: Record<string, unknown>;
} = {}): { workspace: string; cwd: string } {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-timeline-"));
  const cwd = join(workspace, "origin");
  mkdirSync(cwd, { recursive: true });
  const lines = (options.events ?? []).map((row) => JSON.stringify(row));
  const text = lines.join("\n") + (lines.length ? "\n" : "")
    + (options.rawEventsTail ?? "");
  if (text) writeFileSync(join(workspace, "events.jsonl"), text);
  if (options.state) {
    writeFileSync(join(cwd, ".mae-flow.json"),
      JSON.stringify(options.state));
  }
  if (options.ledger) {
    writeFileSync(join(cwd, ".mae-flow.json.quality-executions"),
      JSON.stringify(options.ledger));
  }
  return { workspace, cwd };
}

const titles = (entries: TimelineEntry[]) => entries.map((e) => e.title);
const find = (entries: TimelineEntry[], keyword: string) =>
  entries.find((entry) => entry.title.includes(keyword));

test("阶段轨迹/审批卡与决定/台账成败:读成人话且按时间正序", () => {
  const { workspace, cwd } = makeSite({
    events: [
      { eventId: 1, taskId: "task-1", sessionId: "main",
        ts: "2026-08-15 10:00:00", kind: "session_started",
        payload: { resume: false } },
      { eventId: 2, taskId: "task-1", sessionId: "main",
        ts: "2026-08-15 10:02:00", kind: "tool_requested",
        payload: { call_id: "c1", name: "AskUserQuestion",
          input: { questions: [
            { question: "配置是否正确?", options: ["确认", "修改"] },
            { question: "交付方式?", options: ["完整开发", "局部修改"] }] } } },
      { eventId: 3, taskId: "task-1", sessionId: "main",
        ts: "2026-08-15 10:05:00", kind: "human_decision",
        payload: { waiting_id: "task-1:c1", state_version: 1,
          decision: "确认以上全部配置", notes: "工号已核对" } },
    ],
    state: {
      current: "build",
      history: [
        { step: "config_confirm", result: "done", note: "",
          at: "2026-08-15 10:06:00" },
        { step: "build", result: "rework", note: "编译未过",
          at: "2026-08-15 10:20:00" },
      ],
    },
    ledger: {
      executions: [
        { kind: "COMPILE", step: "build", succeeded: true,
          command: "mvn -pl notify-service -am compile -q",
          at: "2026-08-15 10:10:00" },
        { kind: "UT", step: "build", succeeded: false,
          command: "mvn -pl notify-service -am test",
          at: "2026-08-15 10:30:00" },
      ],
    },
  });

  const entries = buildTimeline(workspace, cwd);
  // 两路来源都已规范成带时区 ISO，再按真实时间正序。
  const stamps = entries.map((entry) => entry.ts);
  assert.deepEqual(stamps, [...stamps].sort());
  assert.ok(stamps.every((stamp) => !stamp || /T.*Z$/.test(stamp)));

  const ask = find(entries, "请你决定");
  assert.ok(ask, `没有审批卡条目: ${titles(entries).join(" | ")}`);
  assert.match(ask!.title, /配置是否正确/);
  assert.equal(ask!.tone, "attention");
  assert.match(String(ask!.detail), /2 个问题/);

  const decision = find(entries, "你的决定");
  assert.equal(decision?.tone, "success");
  assert.match(String(decision?.detail), /工号已核对/);

  // 内核步骤原样示人(不复刻阶段映射),done 与非 done 语气有别。
  assert.ok(find(entries, "完成步骤「config_confirm」"));
  assert.equal(find(entries, "完成步骤「build」")?.tone, "attention");

  const compile = find(entries, "编译执行");
  assert.equal(compile?.tone, "success");
  assert.match(String(compile?.detail), /mvn -pl notify-service/);
  assert.equal(find(entries, "单元测试执行")?.tone, "danger");
  assert.match(String(find(entries, "单元测试执行")?.title), /失败/);

  assert.equal(find(entries, "开始执行")?.tone, "info");
});

test("CST 旧 history 与真实 UTC 事件按发生顺序排列，不偏移八小时", () => {
  const prevTZ = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  try {
    const { workspace, cwd } = makeSite({
      events: [
        { ts: "2026-09-08T01:53:05.495Z", kind: "session_started", payload: {} },
        { ts: "2026-09-08T01:56:00Z", kind: "human_decision", payload: { decision: "继续" } },
      ],
      state: {
        current: "build",
        history: [{ step: "build", result: "done", note: "",
          at: "2026-09-08 09:55:43" }],
      },
      ledger: {
        executions: [{ kind: "COMPILE", step: "build", succeeded: true,
          command: "make", at: "2026-09-08 09:55:43" }],
      },
    });
    const entries = buildTimeline(workspace, cwd);
    const history = entries.find((entry) => entry.kind === "phase");
    const quality = entries.find((entry) => entry.kind === "quality");
    assert.equal(history?.ts, "2026-09-08T01:55:43.000Z");
    assert.equal(quality?.ts, "2026-09-08T01:55:43.000Z");
    assert.deepEqual(entries.map((entry) => entry.kind), ["session", "phase", "quality", "decision"]);
  } finally {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  }
});

test("带时区的内核时间跨 UTC/CST 读取保持不变，并兼容 at 中的 ISO", () => {
  const prevTZ = process.env.TZ;
  try {
    for (const tz of ["UTC", "Asia/Shanghai"]) {
      process.env.TZ = tz;
      const { workspace, cwd } = makeSite({ state: { history: [
        { step: "config_confirm", at: "2026-09-08 09:55:43", at_iso: "2026-09-08T09:55:43+08:00" },
        { step: "workflow_select", at: "2026-09-08T01:56:00Z" },
        { step: "open", at: "2026-09-08T09:57:00+08:00" },
      ] } });
      assert.deepEqual(buildTimeline(workspace, cwd).map((e) => e.ts), [
        "2026-09-08T01:55:43.000Z", "2026-09-08T01:56:00.000Z", "2026-09-08T01:57:00.000Z",
      ], tz);
    }
  } finally {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  }
});

test("子 Agent 配对:返回的成对,收口后仍无返回登记的标红", () => {
  const { workspace, cwd } = makeSite({
    events: [
      { eventId: 1, taskId: "t", sessionId: "main", ts: "2026-08-15 11:00:00",
        kind: "agent_spawned",
        payload: { call_id: "a1", agent_type: "COMPILE",
          description: "跑专项编译", prompt: "…", child_session_id: "c-1" } },
      { eventId: 2, taskId: "t", sessionId: "main", ts: "2026-08-15 11:03:00",
        kind: "agent_finished",
        payload: { call_id: "a1", child_session_id: "c-1",
          lifecycle: "returned", final_text: "COMPILE_RESULT: PASS" } },
      // 派出后再没有返回,而回合已经收口 → 真的丢了登记。
      { eventId: 3, taskId: "t", sessionId: "main", ts: "2026-08-15 11:05:00",
        kind: "agent_spawned",
        payload: { call_id: "a2", agent_type: "UT", description: "跑 UT",
          prompt: "…", child_session_id: "c-2" } },
      { eventId: 4, taskId: "t", sessionId: "main", ts: "2026-08-15 11:09:00",
        kind: "turn_finished", payload: { reason: "end_turn" } },
      // 收口之后又派出一个:还在跑,不许冤枉它。
      { eventId: 5, taskId: "t", sessionId: "main", ts: "2026-08-15 11:10:00",
        kind: "agent_spawned",
        payload: { call_id: "a3", agent_type: "CODECHECK", description: "检查",
          prompt: "…", child_session_id: "c-3" } },
    ],
  });

  const entries = buildTimeline(workspace, cwd);
  assert.equal(find(entries, "子 Agent 返回")?.tone, "info");
  assert.ok(find(entries, "派出子 Agent:COMPILE"));

  const lost = find(entries, "没有返回登记");
  assert.ok(lost, `丢返回没被标出: ${titles(entries).join(" | ")}`);
  assert.match(lost!.title, /UT/);
  assert.equal(lost!.tone, "danger");

  const running = find(entries, "派出子 Agent:CODECHECK");
  assert.equal(running?.tone, "attention", "还在跑的子 Agent 不该标红");
});

test("会话中断如实呈现;成功收口不刷屏", () => {
  const { workspace, cwd } = makeSite({
    events: [
      { eventId: 1, taskId: "t", sessionId: "main", ts: "2026-08-15 12:00:00",
        kind: "session_started", payload: { resume: true } },
      { eventId: 2, taskId: "t", sessionId: "main", ts: "2026-08-15 12:01:00",
        kind: "session_ended",
        payload: { reason: "failed", detail: "模型回合失败: 429 rate limit" } },
      { eventId: 3, taskId: "t", sessionId: "main", ts: "2026-08-15 12:02:00",
        kind: "session_ended", payload: { reason: "done", detail: "" } },
    ],
  });
  const entries = buildTimeline(workspace, cwd);
  const broken = find(entries, "会话中断");
  assert.equal(broken?.tone, "danger");
  assert.match(String(broken?.detail), /429/);
  assert.equal(find(entries, "依据现场重建会话")?.tone, "info");
  // 正常收口不产生条目:时间线是人话摘要,不是事件转储。
  assert.equal(entries.filter((e) => e.title === "会话中断").length, 1);
});

test("路由 GET /tasks/:id/timeline:能看任务就能看时间线;不存在 404",
  async () => {
    const script: Scene[] = [{ text: "一步收工。" }];
    const model = new ScriptedModelServer(script);
    await model.start();
    const service = new TaskService({
      dataDir: mkdtempSync(join(tmpdir(), "mfc-timeline-api-")),
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const server = createTaskServer(service);
    await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const created = await fetch(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({ requirement: "演练:时间线路由" }),
      }).then((response) => readJson(response));
      const confirmation = service.get(created.id)!.waiting!;
      const confirmationQuestion = (confirmation.question.questions as
        Array<{ question: string }>)[0].question;
      await service.decide(created.id, {
        waiting_id: confirmation.waiting_id,
        state_version: confirmation.state_version,
        selected_options: {
          [confirmationQuestion]: "需求已确认，进入需求分析",
        },
      });
      const deadline = Date.now() + 30_000;
      while (service.get(created.id)!.status !== "completed") {
        if (Date.now() > deadline) throw new Error("任务未收口");
        await new Promise((tick) => setTimeout(tick, 50));
      }

      const response = await fetch(`${base}/tasks/${created.id}/timeline`);
      assert.equal(response.status, 200);
      const entries = (await readJson(response)) as TimelineEntry[];
      assert.ok(Array.isArray(entries) && entries.length > 0);
      assert.ok(entries.some((entry) => entry.title === "开始执行"));

      const missing = await fetch(`${base}/tasks/task-99/timeline`);
      assert.equal(missing.status, 404);
    } finally {
      server.close();
      await model.stop();
    }
  });

test("fail-open:半行 JSON、缺文件、坏字段都不炸整页", () => {
  const { workspace, cwd } = makeSite({
    events: [
      { eventId: 1, taskId: "t", sessionId: "main", ts: "2026-08-15 13:00:00",
        kind: "human_decision",
        payload: { waiting_id: "w", state_version: 1, decision: "通过",
          notes: "" } },
    ],
    // 写入方还在写的半行:必须被跳过,后面的条目照出。
    rawEventsTail: '{"eventId": 2, "kind": "human_deci',
    state: { current: "build", history: [null, { step: "init" }] },
    ledger: { executions: [{ kind: "COMPILE" }, "坏行"] },
  });

  const entries = buildTimeline(workspace, cwd);
  assert.ok(find(entries, "你的决定"), "半行把好行也毁了");
  // 坏 history 项跳过,好的仍在(缺 result 当 info)。
  assert.ok(find(entries, "完成步骤「init」"));
  // 台账缺 command 要如实说"没记到",而不是假装没执行过。
  const bare = find(entries, "编译执行");
  assert.ok(bare, "缺字段的台账行被整条吞了");
  assert.match(String(bare!.detail), /台账没记到命令/);

  // 完全空的现场:返回空数组而不是抛错。
  const empty = mkdtempSync(join(tmpdir(), "mfc-timeline-empty-"));
  assert.deepEqual(buildTimeline(empty), []);
  // cwd 不传也能自己找到内核现场(host 模式克隆在工作区之下)。
  assert.ok(buildTimeline(workspace).some((e) => e.kind === "phase"));
});
