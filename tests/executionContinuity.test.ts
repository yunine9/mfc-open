import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createExecutionGateway } from "../src/executionGateway.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { openSessionCheckpoint, restorePendingToolResults } from "../src/sessionCheckpoint.ts";

async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (!await check()) {
    if (Date.now() > end) throw new Error("condition timed out");
    await new Promise(r => setTimeout(r, 25));
  }
}
async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000); timer.unref();
  try { await exited; } finally { clearTimeout(timer); }
}
function processAt(entry: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(entry), ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout!.on("data", data => { output += data; }); child.stderr!.on("data", data => { output += data; });
  return { child, output: () => output };
}

async function worker(root: string, mode: string) {
  const result = processAt("tests/fixtures/sessionContinuityWorker.ts", [root, mode]);
  await until(() => /"port":\d+/.test(result.output()) || result.child.exitCode !== null);
  assert.equal(result.child.exitCode, null, result.output());
  return { ...result, url: `http://127.0.0.1:${JSON.parse(result.output().trim().split("\n").find(line => line.startsWith('{"port"'))!).port}` };
}
async function setup(t: any, script: Scene[], beforeScene?: ConstructorParameters<typeof ScriptedModelServer>[2]) {
  const root = mkdtempSync(join(tmpdir(), "mfc-continuity-"));
  mkdirSync(join(root, "pi-agent"));
  const model = new ScriptedModelServer(script, "scripted-v1", beforeScene);
  await model.start();
  writeFileSync(join(root, "pi-agent/models.json"), JSON.stringify(model.modelsJson()));
  writeFileSync(join(root, "evidence.txt"), "独有证据 CONTEXT-7143：等效数方案已验证，后续直接使用此结果。\n");
  const children: ChildProcess[] = [];
  t.after(async () => {
    await Promise.all(children.map(child => stop(child)));
    await model.stop(); rmSync(root, { recursive: true, force: true });
  });
  return { root, model, children };
}

test("执行进程 SIGKILL 后恢复：原工具结果和用户新决定进入模型，不重复命令", { timeout: 30_000 }, async t => {
  let release!: () => void;
  const blocked = new Promise<void>(r => { release = r; });
  const { root, model, children } = await setup(t, [
    { tool: { name: "read", input: { path: "evidence.txt" } } },
    { tool: { name: "bash", input: { command: "printf 'once\\n' >> count.txt; echo VERIFIED-RESULT-8831" } } },
    { text: "复用结果继续完成" },
  ], { beforeScene: async ({ requestNumber }) => { if (requestNumber === 3) await blocked; } });
  let runtime = await worker(root, "new"); children.push(runtime.child);
  t.after(() => release());
  await fetch(`${runtime.url}/start`, { method: "POST" });
  await until(() => model.requests.length === 3);
  await stop(runtime.child, "SIGKILL"); release();
  // 模拟 Pi 结果已落盘但旁路事件尚未写全的中断窗口。
  const eventPath = join(root, "events.jsonl");
  const savedEvents = new EventLog(eventPath).replay().filter(event =>
    !(event.kind === "tool_finished" && event.payload.call_id === "scripted-1"));
  writeFileSync(eventPath, savedEvents.map(event => JSON.stringify(event)).join("\n") + "\n");
  rmSync(join(root, "evidence.txt"));
  runtime = await worker(root, "resume"); children.push(runtime.child);
  await fetch(`${runtime.url}/start`, { method: "POST" });
  await until(() => existsSync(join(root, "outcome.json")));
  const continued = JSON.stringify(model.requests[3]);
  assert.match(continued, /CONTEXT-7143/);
  assert.match(continued, /VERIFIED-RESULT-8831/);
  assert.match(continued, /最新决定：使用 queryENE.sh/);
  assert.equal(readFileSync(join(root, "count.txt"), "utf8"), "once\n");
  const events = new EventLog(join(root, "events.jsonl")).replay();
  assert.equal(events.filter(e => e.kind === "tool_requested").length, 2);
  const repaired = events.find(e => e.kind === "tool_finished" && e.payload.call_id === "scripted-1");
  assert.equal(repaired?.payload.is_error, false);
  assert.match(String(repaired?.payload.result), /VERIFIED-RESULT-8831/);
  assert.equal(events.filter(e => e.kind === "session_started").at(-1)?.payload.context_restored, true);
});

test("原生会话保留压缩摘要、隔离身份并修复断写尾行；未知调用只记待核实", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-checkpoint-"));
  try {
    const args = { taskId: "t", sessionId: "main", transcriptPath: join(root, "transcript.jsonl"), agentDir: join(root, "pi-agent"), cwd: root, resume: false };
    const first = openSessionCheckpoint(args);
    const id = first.manager.appendMessage({ role: "user", content: "最初的决定", timestamp: Date.now() });
    first.manager.appendCompaction("已完成分析：结论 A，勿重复调查", id, 100);
    first.manager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "push-1", name: "bash", arguments: { command: "git push" } }],
      api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    writeFileSync(first.manager.getSessionFile()!, '{"type":', { flag: "a" });
    const recovered = openSessionCheckpoint({ ...args, resume: true });
    assert(recovered.restored);
    restorePendingToolResults(recovered.manager, [], "main");
    const messages = recovered.manager.buildSessionContext().messages as any[];
    assert.match(JSON.stringify(messages), /已完成分析/);
    assert.match(JSON.stringify(messages.at(-1)), /先检查文件/);
    assert.equal(messages.at(-1).isError, true);
    assert.equal(openSessionCheckpoint({ ...args, taskId: "other", resume: true }).restored, false);
    assert.equal(statSync(recovered.manager.getSessionFile()!).mode & 0o777, 0o600);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("已完成子 Agent 报告在 Pi 接收前中断：按原调用恢复报告，不拿别的会话充数", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-checkpoint-report-"));
  try {
    const args = { taskId: "t", sessionId: "main", transcriptPath: join(root, "transcript.jsonl"), agentDir: join(root, "pi-agent"), cwd: root, resume: false };
    const { manager } = openSessionCheckpoint(args);
    manager.appendMessage({ role: "assistant", content: [
      { type: "toolCall", id: "report-1", name: "Task", arguments: {} },
      { type: "toolCall", id: "unknown-1", name: "bash", arguments: {} },
    ], api: "anthropic-messages", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const resumed = openSessionCheckpoint({ ...args, resume: true });
    const events: any[] = [
      { kind: "agent_finished", sessionId: "main", payload: { call_id: "report-1", lifecycle: "returned", final_text: "已完成模块分析 REPORT-912" } },
      { kind: "tool_finished", sessionId: "other-session", payload: { call_id: "unknown-1", is_error: false, result: "其他会话的成功不能借用" } },
    ];
    restorePendingToolResults(resumed.manager, events, "main");
    const results = resumed.manager.buildSessionContext().messages.filter((m: any) => m.role === "toolResult") as any[];
    assert.equal(results.length, 2);
    assert.equal(results[0].isError, false);
    assert.match(JSON.stringify(results[0]), /REPORT-912/);
    assert.equal(results[1].isError, true);
    assert.doesNotMatch(JSON.stringify(results[1]), /其他会话的成功/);
    const before = readFileSync(resumed.manager.getSessionFile()!, "utf8");
    restorePendingToolResults(resumed.manager, events, "main");
    assert.equal(readFileSync(resumed.manager.getSessionFile()!, "utf8"), before, "再次恢复不重复追加结果");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("网关保留权限与流式响应；写请求连接失败不自动重试，执行服务故障如实 503", async t => {
  let writes = 0;
  const runtime = createServer((req, res) => {
    if (req.url === "/write") { writes++; req.socket.destroy(); return; }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write("id: 7\ndata: started\n\n"); return;
    }
    res.writeHead(req.headers.cookie === "session=owner" ? 200 : 401, { "set-cookie": "session=owner; HttpOnly" });
    res.end(JSON.stringify({ host: req.headers.host }));
  });
  await new Promise<void>(r => runtime.listen(0, "127.0.0.1", r));
  const proxy = createExecutionGateway({ runtimeUrl: `http://127.0.0.1:${(runtime.address() as any).port}`, headerTimeoutMs: 200 });
  await new Promise<void>(r => proxy.listen(0, "127.0.0.1", r));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); runtime.closeAllConnections(); runtime.close(); });
  const url = `http://127.0.0.1:${(proxy.address() as any).port}`;
  assert.equal((await fetch(url)).status, 401);
  const allowed = await fetch(url, { headers: { cookie: "session=owner" } });
  assert.equal(allowed.status, 200); assert.match(allowed.headers.get("set-cookie")!, /HttpOnly/);
  const stream = await fetch(`${url}/events`);
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 7/); await reader.cancel();
  assert.equal((await fetch(`${url}/write`, { method: "POST", body: "decision" })).status, 503);
  assert.equal(writes, 1);
  runtime.closeAllConnections(); await new Promise<void>(r => runtime.close(() => r()));
  assert.equal((await fetch(`${url}/health`)).status, 503);
});
