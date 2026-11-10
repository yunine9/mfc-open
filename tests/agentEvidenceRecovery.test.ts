import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession, type HostHooks } from "../src/sessionDriver.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { EventLog, type SemanticEvent } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

const DISPATCH: Scene = { tool: { name: "Task", input: {
  subagent_type: "grill-critic-agent", description: "检视", prompt: "prep",
} } };

async function fixture(script: Scene[], hooks: HostHooks, seed: SemanticEvent[] = []) {
  const root = mkdtempSync(join(tmpdir(), "mfc-agent-evidence-"));
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const log = new EventLog(join(root, "events.jsonl"));
  const transcript = new TranscriptStore(join(root, "transcript.jsonl"), "main");
  for (const event of seed) { log.append(event); transcript.record(event); }
  const session = await CloudSession.create({
    taskId: "T-evidence", workspace: root, agentDir, provider: "maeflow", model: "scripted-v1",
    eventLog: log, transcript, gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")), hostHooks: hooks,
  });
  return { session, root, log, model, close: async () => { session.dispose(); await model.stop(); } };
}

test("Critic 的完成 Hook 落盘后主 Agent 才能继续工具调用", async () => {
  let recorded = false;
  const f = await fixture([DISPATCH, { text: "报告" },
    { tool: { name: "bash", input: { command: "echo next" } } }, { text: "完成" }], {
    postTool: async (event) => {
      if (event.payload.name !== "Task") return;
      assert.equal(event.payload.lifecycle, "returned");
      assert.equal(event.payload.child_session_id, "child-1");
      await new Promise((done) => setTimeout(done, 30));
      recorded = true;
    },
    preTool: async (event) => {
      if (event.payload.name === "Bash") assert.ok(recorded);
      return undefined;
    },
  });
  try {
    assert.equal((await f.session.start("开始")).status, "turn_finished");
    const events = f.log.replay();
    const finished = events.find(e => e.kind === "agent_finished")!;
    const ack = events.find(e => e.kind === "agent_observed")!;
    assert.equal(ack.payload.source_event_id, finished.eventId);
    assert.ok(recorded);
  } finally { await f.close(); }
});

test("Critic 完成登记失败时后续 Bash 被阻止，留下未确认事件供恢复", async () => {
  const f = await fixture([DISPATCH, { text: "报告" },
    { tool: { name: "bash", input: { command: "touch should-not-exist" } } }, { text: "结束" }], {
    postTool: async (event) => {
      if (event.payload.name === "Task") throw new Error("evidence disk unavailable");
    },
  });
  try {
    const outcome = await f.session.start("开始");
    assert.equal(outcome.status, "session_ended");
    assert.match(outcome.detail ?? "", /evidence disk unavailable/);
    assert.equal(existsSync(join(f.root, "should-not-exist")), false);
    assert.equal(f.log.replay().filter(e => e.kind === "agent_observed").length, 0);
  } finally { await f.close(); }
});

function crashedCompletion(): SemanticEvent[] {
  const base = { taskId: "T-evidence", sessionId: "main", ts: "2026-09-08T02:00:00Z" };
  return [
    { ...base, eventId: 1, kind: "agent_spawned", payload: {
      call_id: "old-call", child_session_id: "child-8", agent_type: "grill-critic-agent",
      description: "检视", prompt: "prep",
    } },
    { ...base, eventId: 2, kind: "agent_finished", payload: {
      call_id: "old-call", child_session_id: "child-8", lifecycle: "returned", final_text: "旧报告",
    } },
  ];
}

test("报告已落盘但 Hook 未确认的崩溃窗口：按原 ID/时间补登记，确认后不再发送", async () => {
  const received: SemanticEvent[] = [];
  const f = await fixture([{ text: "继续" }], {
    postTool: async event => { received.push(event); },
  }, crashedCompletion());
  let persisted: SemanticEvent[];
  try {
    assert.equal((await f.session.startResume("继续")).status, "turn_finished");
    assert.equal(received.length, 1);
    assert.equal(received[0].payload.call_id, "old-call");
    assert.equal(received[0].payload.lifecycle, "returned");
    assert.equal(received[0].ts, "2026-09-08T02:00:00Z");
    persisted = f.log.replay();
    assert.equal(persisted.filter(e => e.kind === "agent_finished").length, 1);
  } finally { await f.close(); }
  const next = await fixture([{ text: "继续" }], {
    postTool: async () => { assert.fail("已确认的完成记录不应重投"); },
  }, persisted!);
  try { assert.equal((await next.session.startResume("继续")).status, "turn_finished"); }
  finally { await next.close(); }
});

test("恢复补登记失败不会启动模型，也不会伪造确认记录", async () => {
  const f = await fixture([{ text: "不应运行" }], {
    postTool: async () => { throw new Error("still unavailable"); },
  }, crashedCompletion());
  try {
    await assert.rejects(f.session.startResume("继续"), /still unavailable/);
    assert.equal(f.model.requests.length, 0);
    assert.equal(f.log.replay().filter(e => e.kind === "agent_observed").length, 0);
  } finally { await f.close(); }
});

test("真实 KernelHost → Python Hook：两个 Critic 跨宿主实例精确登记，错误返回不算通过", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-real-critic-"));
  execFileSync("git", ["init", "--quiet", workspace]);
  writeFileSync(join(workspace, ".mae-flow.json"), JSON.stringify({
    current: "grill", config: { 单号: "REQ-CRITIC" }, choices: { workflow: "full" },
    history: [], started: "2026-09-08 09:00:00",
    agent_tasks: { GRILL_PREP: { step: "grill" }, GRILL_FINAL: { step: "grill" } },
  }));
  const host = () => new KernelHost({
    kernelRoot: process.env.MFC_AGENT_TEST_KERNEL_ROOT ?? join(process.cwd(), "kernel"),
    workspace, transcriptPath: join(workspace, "transcript.jsonl"), taskId: "T-real-critic",
  });
  for (const [index, phase] of ["prep", "final", "failed"].entries()) {
    const event: SemanticEvent = {
      eventId: index + 1, taskId: "T-real-critic", sessionId: "main",
      ts: "2026-09-08T02:00:00Z", kind: "tool_requested", payload: {
        call_id: `critic-${phase}`, name: "Task", child_session_id: `child-${index + 1}`,
        input: { subagent_type: "grill-critic-agent", prompt: phase },
      },
    };
    assert.equal(await host().preTool(event), undefined);
    const completed = { ...event, kind: "tool_finished" as const, payload: {
      ...event.payload, lifecycle: phase === "failed" ? "failed" : "returned",
      is_error: phase === "failed", result: `${phase} report`,
    } };
    assert.equal(await host().postTool(completed), undefined);
    assert.equal(await host().postTool(completed), undefined, "重复发送必须幂等");
  }
  const records = JSON.parse(readFileSync(join(workspace,
    ".mae-flow.json.agent-observations"), "utf8")).observations;
  const returned = records.filter((r: any) => r.lifecycle === "returned");
  assert.deepEqual(returned.map((r: any) => r.kind), ["GRILL_PREP", "GRILL_FINAL"]);
  assert.equal(records.filter((r: any) => r.lifecycle === "interrupted").length, 1);
  assert.equal(records.length, 6);
});
