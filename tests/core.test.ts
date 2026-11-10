/**
 * 核心不变式单测(整链行为由 probe + 内核裁判验收,这里钉边界)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EventLog,
  EventLogError,
  type SemanticEvent,
} from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { HumanGate, StateConflictError } from "../src/humanGate.ts";
import { GateService } from "../src/gateService.ts";

function event(
  eventId: number,
  kind: SemanticEvent["kind"],
  payload: Record<string, unknown>,
  sessionId = "main",
): SemanticEvent {
  return {
    eventId, taskId: "T-1", sessionId,
    ts: "2026-08-14 12:00:00", kind, payload,
  };
}

test("事件日志:重放 no-op,倒退拒收,畸形抛错", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const log = new EventLog(join(dir, "events.jsonl"));
  assert.equal(log.append(event(1, "user_message", { text: "开工" })), true);
  assert.equal(log.append(event(1, "user_message", { text: "开工" })), false);
  assert.equal(
    log.append(event(1, "turn_finished", { reason: "end_turn" })), false);
  assert.throws(
    () => log.append(event(2, "tool_requested", { call_id: "c1" })),
    EventLogError);
  assert.equal(new EventLog(log.path).replay().length, 1);
});

test("人工待办:同 call_id 幂等,先到决定生效", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const first = gate.createWaiting({
    taskId: "T-1", step: "grill", callId: "c1",
    questionInput: { q: "通过吗" },
  });
  const again = gate.createWaiting({
    taskId: "T-1", step: "grill", callId: "c1",
    questionInput: { q: "换内容也不新建" },
  });
  assert.equal(again.waiting_id, first.waiting_id);
  assert.deepEqual(again.question, { q: "通过吗" });
  gate.resolve(first.waiting_id, {
    stateVersion: first.state_version, decision: "通过",
  });
  assert.throws(
    () => gate.resolve(first.waiting_id, {
      stateVersion: first.state_version, decision: "打回",
    }),
    StateConflictError);
  assert.equal(gate.pending().length, 0);
});

test("人工待办:可读取权威记录,完全相同的请求重放幂等返回", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const waiting = gate.createWaiting({
    taskId: "T-1", step: "cloud_push_confirm", callId: "push-confirm-a",
    questionInput: { q: "按清单推送吗" },
  });
  const first = gate.resolve(waiting.waiting_id, {
    stateVersion: waiting.state_version,
    decision: "需要调整代码",
    requestDigest: "same-request",
    continuation: { delivery_selection: { paths: ["src/a.ts"] } },
  });
  const replay = gate.resolve(waiting.waiting_id, {
    stateVersion: waiting.state_version,
    decision: "需要调整代码",
    requestDigest: "same-request",
    continuation: { delivery_selection: { paths: ["src/a.ts"] } },
  });
  assert.deepEqual(replay, first, "网络重试不能把已经成功的同一请求报成冲突");
  assert.deepEqual(gate.get(waiting.waiting_id), first,
    "任务概要与待办账冲突时必须能读取 waiting.json 的权威记录");
  assert.deepEqual(gate.resolved(), [first],
    "宿主必须能枚举已决收据以修复派生投影");
  assert.throws(() => gate.resolve(waiting.waiting_id, {
    stateVersion: waiting.state_version,
    decision: "确认推送",
    requestDigest: "different-request",
  }), StateConflictError, "真正不同的后到决定仍须拒绝");
});

test("用户接管只作废旧待办，不伪造通过或打回答案", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const gate = new HumanGate(join(dir, "waiting.json"));
  const waiting = gate.createWaiting({
    taskId: "T-1", step: "delivery_review", callId: "c2",
    questionInput: { q: "代码通过吗" },
  });
  const closed = gate.supersede(waiting.waiting_id, {
    stateVersion: waiting.state_version,
    notes: "用户接管代码，旧检视对象失效",
  });
  assert.equal(closed.status, "superseded");
  assert.equal(closed.decision, "");
  assert.equal(gate.pending().length, 0);
  assert.equal(gate.supersede(waiting.waiting_id, {
    stateVersion: waiting.state_version,
    notes: "重放",
  }).status, "superseded");
});

test("transcript:未绑定子会话拒收;绑定后落到确定性路径", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-"));
  const store = new TranscriptStore(join(dir, "transcript.jsonl"), "main");
  assert.throws(() => store.record(
    event(1, "assistant_message", { text: "hi" }, "S9")));
  store.record(event(1, "agent_spawned", {
    call_id: "toolu-7", agent_type: "ut-generator-agent",
    description: "编写单元测试", prompt: "只写测试", child_session_id: "S2",
  }));
  assert.match(store.childPath("S2"), /subagents\/agent-toolu-7\.jsonl$/);
  store.record(event(2, "assistant_message", { text: "UT_WRITE_RESULT: DONE" }, "S2"));
  const child = readFileSync(store.childPath("S2"), "utf-8");
  assert.match(child, /UT_WRITE_RESULT/);
});

test("门禁:路由与 fail-open", () => {
  const logged: string[] = [];
  const gate = new GateService({
    contract: () => { throw new Error("契约内部错误"); },
    log: (message) => logged.push(message),
  });
  assert.equal(gate.decide(event(1, "tool_requested", {
    call_id: "c1", name: "Bash", input: { command: "ls" },
  })).action, "allow");
  assert.ok(logged.some((line) => line.includes("fail-open")));
  assert.equal(new GateService().decide(event(1, "tool_requested", {
    call_id: "c1", name: "AskUserQuestion", input: {},
  })).action, "human");
  assert.equal(new GateService({ moonlight: true }).decide(
    event(1, "tool_requested", {
      call_id: "c1", name: "AskUserQuestion", input: {},
    })).action, "deny");
  assert.equal(new GateService().decide(event(1, "tool_requested", {
    call_id: "c1", name: "Task", input: {},
  })).action, "agent");
});

test("正式任务门禁故障 fail-closed，不回落执行工具", () => {
  const logged: string[] = [];
  const gate = new GateService({
    failClosed: true,
    contract: () => { throw new Error("证据服务不可用"); },
    log: (message) => logged.push(message),
  });
  const decision = gate.decide(event(1, "tool_requested", {
    call_id: "c1", name: "Bash", input: { command: "./build.sh" },
  }));
  assert.equal(decision.action, "deny");
  assert.match(decision.reason ?? "", /安全门禁暂时不可用/);
  assert.ok(logged.some((line) => line.includes("fail-closed")));
});

test("门禁:Pi 文件工具的 path 与旧宿主 file_path 走同一契约", () => {
  const calls: Array<{ tool: string; value: string }> = [];
  const gate = new GateService({
    contract: (tool, value) => {
      calls.push({ tool, value });
      return undefined;
    },
  });

  for (const [tool, input] of [
    ["Read", { path: "src/read.ts" }],
    ["Write", { path: ".mae-flow.json" }],
    ["Edit", { file_path: "src/legacy.ts" }],
  ] as const) {
    assert.equal(gate.decide(event(1, "tool_requested", {
      call_id: "c1", name: tool, input,
    })).action, "allow");
  }

  assert.deepEqual(calls, [
    { tool: "Read", value: "src/read.ts" },
    { tool: "Write", value: ".mae-flow.json" },
    { tool: "Edit", value: "src/legacy.ts" },
  ]);
});

test("门禁:文件工具只能访问任务工作区且不跟随软链逃逸", () => {
  const parent = mkdtempSync(join(tmpdir(), "mfc-gate-"));
  const workspace = join(parent, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  let hasOutsideLink = true;
  try {
    symlinkSync(parent, join(workspace, "outside-link"), "dir");
  } catch {
    hasOutsideLink = false;
  }
  const calls: string[] = [];
  const gate = new GateService({
    workspace,
    contract: (_tool, value) => {
      calls.push(value);
      return undefined;
    },
  });
  const decide = (tool: string, path: string) => gate.decide(
    event(1, "tool_requested", {
      call_id: "c1", name: tool, input: { path },
    }),
  );

  assert.equal(decide("Write", "src/new.ts").action, "allow");
  assert.equal(decide("Read", join(workspace, "src")).action, "allow");
  assert.equal(decide("Edit", "../outside.ts").action, "deny");
  assert.equal(decide("Read", join(parent, "secret.txt")).action, "deny");
  assert.equal(gate.decide(event(1, "tool_requested", {
    call_id: "c2", name: "Write", input: {
      path: "src/safe.ts", file_path: join(parent, "hidden.ts"),
    },
  })).action, "deny");
  if (hasOutsideLink) {
    assert.equal(decide("Write", "outside-link/new.ts").action, "deny");
  }
  assert.deepEqual(calls, ["src/new.ts", join(workspace, "src")]);
});

test("门禁:修复材料在仓外也要够得着,宿主账本只读", () => {
  // 边界一度锚在代码仓上,而修复使命指挥模型读 ../pipeline/ 的失败日志、
  // 写 ../review_replies.md 的检视回复——都在仓外,于是 Read/Write 被拒,
  // 检视修复环第一轮就死在"回复文件不存在"。边界的本意是"别跑出这个
  // 任务",不是"别出代码仓";账本另外守。
  const workspace = mkdtempSync(join(tmpdir(), "mfc-repair-"));
  const cwd = join(workspace, "repo");
  mkdirSync(join(workspace, "pipeline"), { recursive: true });
  mkdirSync(join(workspace, "reviews"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(workspace, "pipeline", "compile.log"), "boom");
  writeFileSync(join(workspace, "events.jsonl"), "{}\n");
  const gate = new GateService({ workspace, cwd });
  const decide = (tool: string, path: string) => gate.decide(
    event(1, "tool_requested", {
      call_id: "c1", name: tool, input: { path },
    }),
  ).action;

  // 修复使命点名要用的三条路径,一条都不能被拦。
  assert.equal(decide("Read", "../pipeline/compile.log"), "allow");
  assert.equal(decide("Read", "../reviews/discussions.json"), "allow");
  assert.equal(decide("Write", "../review_replies.md"), "allow");
  assert.equal(decide("Edit", "src/a.java"), "allow");
  // 账本:读随便读(本来就是它自己的记录),写一律拒——伪造事件流、
  // 等待记录或流水线事实等于伪造证据。
  assert.equal(decide("Read", "../events.jsonl"), "allow");
  for (const ledger of [
    "../events.jsonl", "../transcript.jsonl", "../waiting.json",
    "../task.json", "../annotations.jsonl", "../pipeline-facts.json",
    "../feedback/index.jsonl",
  ]) {
    assert.equal(decide("Write", ledger), "deny", ledger);
  }
  assert.equal(decide("Write", "../feedback/result-current.json"), "allow",
    "机器回执文件不是宿主索引，必须允许 Agent 写入");
  // 会话运行时目录连读都不给:pi-agent/models.json 明文存着模型网关
  // API Key。放宽可达边界的同时这一格必须焊死,否则等于递密钥。
  for (const tool of ["Read", "Write", "Edit"]) {
    assert.equal(decide(tool, "../pi-agent/models.json"), "deny", tool);
  }
  // 放宽到工作区不等于放开:任务之外照旧拦死。
  assert.equal(decide("Read", "../../别人的任务"), "deny");
  assert.equal(decide("Write", "/etc/passwd"), "deny");
});

test("门禁:extraLedgerDirs 支持嵌套条目,目录连同其下全部内容", () => {
  // 2026-09-04 探针实锤:账本目录匹配只看相对路径首段,带斜杠的嵌套
  // 条目(问题流的 .mae-flow-work/host-skills 只读投影)永远落空——
  // 注入的投影对 Agent 变成可写。钉死嵌套匹配与顶层条目两种形状。
  const workspace = mkdtempSync(join(tmpdir(), "mfc-gate-ledger-"));
  mkdirSync(join(workspace, ".mae-flow-work/host-skills/abc"), {
    recursive: true,
  });
  const gate = new GateService({
    workspace,
    cwd: workspace,
    extraLedgerFiles: ["issue.json"],
    extraLedgerDirs: ["skills", ".mae-flow-work/host-skills"],
  });
  const decide = (tool: string, path: string) => gate.decide(
    event(1, "tool_requested", {
      call_id: "c1", name: tool, input: { path },
    }),
  ).action;

  assert.equal(
    decide("Write", join(workspace, ".mae-flow-work/host-skills/abc/SKILL.md")),
    "deny", "嵌套账本目录条目连同其下内容全拒写",
  );
  assert.equal(
    decide("Read", join(workspace, ".mae-flow-work/host-skills/abc/SKILL.md")),
    "allow", "账本读不受限(它本来就是宿主自己的记录)",
  );
  assert.equal(
    decide("Write", join(workspace, ".mae-flow-work/build-notes.md")),
    "allow", "账本目录之外的 .mae-flow-work 照常可写(预热 build-notes)",
  );
  assert.equal(
    decide("Write", join(workspace, "skills/x.md")),
    "deny", "顶层账本目录条目保持原语义",
  );
  assert.equal(
    decide("Write", join(workspace, "issue.json")),
    "deny", "嵌套目录修复不影响账本文件判定",
  );
});
