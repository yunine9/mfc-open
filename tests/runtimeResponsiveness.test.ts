import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PgProjection } from "../src/projection.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { startStartupDiagnostics, traceHttpRequest, pendingHttpRequests, sanitizeBrowserTimings } from "../src/runtimeDiagnostics.ts";
import { projectionPeer } from "./fixtures/projectionPeer.ts";
import { run as runServe } from "./serveConfig.helpers.ts";

test("历史重放逐条处理，实时事件及独立自检不会排在全部历史之后", async () => {
  const peer = await projectionPeer({ writeDelayMs: 8 });
  const root = mkdtempSync(join(tmpdir(), "mfc-replay-responsive-"));
  const projection = new PgProjection(peer.url);
  const event = (id: number) => ({ taskId: "task-1", eventId: id, sessionId: "main", ts: new Date().toISOString(), kind: "assistant_message" as const, payload: { text: "fixture" } });
  writeFileSync(join(root, "events.jsonl"), Array.from({ length: 100 }, (_, i) => JSON.stringify(event(i + 1))).join("\n") + "\n");
  try {
    const replay = projection.replayEvents("task-1", join(root, "events.jsonl"));
    await delay(40);
    assert.equal(projection.diagnostics().waiting, 0);
    const checked = await projection.health();
    assert.equal(checked.reachable, true);
    assert.ok(peer.counts().writes < 100, "不能等待历史全部写完才执行自检");
    await projection.appendEvent(event(101));
    assert.ok(peer.counts().writes < 100, "实时事件不能等在全部历史之后");
    await replay;
    assert.equal(peer.counts().writes, 101);
    assert.equal(projection.diagnostics().replay_active, undefined);
    await projection.replayEvents("task-1", join(root, "missing.jsonl"));
  } finally { await projection.close(); await peer.close(); rmSync(root, { recursive: true, force: true }); }
});

test("数据库连接无响应时自检自动结束并关闭连接，不需要人为断开", async () => {
  const peer = await projectionPeer({ silent: true }); const projection = new PgProjection(peer.url);
  try {
    const started = performance.now(); const result = await projection.health();
    assert.equal(result.reachable, false);
    assert.ok(performance.now() - started < 5_000);
    await delay(20); assert.equal(peer.counts().connections, 0);
  } finally { await projection.close(); await peer.close(); }
});

test("彻底删除等待正在写入的历史事件，删除后后台重放不能重新写回", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-delete-replay-"));
  const projection = new PgProjection("postgresql://fixture@127.0.0.1:1/fixture");
  let release!: () => void; let writes = 0; const commands: string[] = [];
  const write = new Promise<void>(resolve => { release = resolve; });
  (projection as any).pool = { query: async (sql: string) => {
    if (sql.includes("insert into task_events")) { writes++; await write; }
  }, connect: async () => ({ query: async (sql: string) => {
    commands.push(sql); return { rowCount: 1, rows: [{ status: "completed" }] };
  }, release: () => {} }), end: async () => {} };
  writeFileSync(join(root, "events.jsonl"), Array.from({ length: 20 }, (_, i) => JSON.stringify({ taskId: "task-1", eventId: i + 1, payload: {} })).join("\n"));
  try {
    const replay = projection.replayEvents("task-1", join(root, "events.jsonl"));
    while (writes === 0) await delay(5);
    const deleted = projection.deleteTask("task-1"); await setImmediate();
    assert.ok(!commands.some(sql => sql.startsWith("delete from")));
    release(); assert.equal((await deleted).deleted, true); await replay;
    assert.equal(writes, 1);
    assert.ok(commands.some(sql => sql.startsWith("delete from task_events")));
  } finally { release(); await projection.close(); rmSync(root, { recursive: true, force: true }); }
});

test("数据库检查等待时容器照常检查，同时点击只创建一个自检容器", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-check-responsive-"));
  let release!: (value: { reachable: boolean }) => void; let starts = 0; const logs: string[] = [];
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {},
    projection: { health: () => new Promise(resolve => { release = resolve; }) } as any,
    log: message => logs.push(message), isolation: { image: "fixture", containerFactory: () => ({
      start: async () => { starts++; }, stop: async () => {}, exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("__MFC_CONTAINER_TOOLCHAIN_OK__")); return { exitCode: 0 };
      },
    }) },
  });
  service.launchOptions = () => { throw new Error("自检不得读取整份 Skill 和知识目录"); };
  try {
    const one = service.systemCheck(); const two = service.systemCheck();
    assert.equal(one, two); await setImmediate(); assert.equal(starts, 1);
    assert.ok(service.systemCheckStatus()?.phases.some(phase => phase.phase === "postgres" && phase.outcome === "pending"));
    release({ reachable: false }); const result = await one;
    assert.equal(result.items.find(item => item.key === "container")?.status, "ok");
    assert.equal(result.items.find(item => item.key === "postgres")?.status, "error");
    assert.equal(service.systemCheckStatus(), undefined);
    assert.ok(logs.some(line => line.includes('"phase":"container.exec"')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("读取产出文档与订阅事件只读必要元数据，不执行完整任务详情", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-file-responsive-"));
  const workspace = join(root, "task-1"); mkdirSync(workspace);
  writeFileSync(join(workspace, "requirement.md"), "# 需求\nfixture");
  writeFileSync(join(workspace, "events.jsonl"), "");
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {} });
  (service as any).tasks.set("task-1", { summary: { id: "task-1", workspace, status: "completed", requirement: "fixture", created_at: new Date().toISOString() } });
  service.get = () => { throw new Error("文件读取不应重建详情或同步运行 Python"); };
  const server = createTaskServer(service); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const files = await fetch(url + "/tasks/task-1/artifacts"); assert.equal(files.status, 200); await files.json();
    const events = await fetch(url + "/tasks/task-1/events"); assert.equal(events.status, 200); await events.text();
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});

test("自动诊断输出 CPU 热点及事件循环状态，到期释放资源且不记录查询密钥", async () => {
  const logs: string[] = [];
  const stop = await startStartupDiagnostics(line => logs.push(line), () => ({ requests: pendingHttpRequests() }), { durationMs: 150, sampleMs: 30, profileMs: 70 });
  await delay(200); await stop();
  assert.ok(logs.some(line => line.includes('"event":"cpu_profile"')));
  assert.ok(logs.some(line => line.includes('"event_loop_delay_max_ms"')));
  assert.ok(logs.some(line => line.includes('"event":"stop"')));
  const size = logs.length; await delay(40); assert.equal(logs.length, size);
  const server = createServer(async (request, response) => {
    traceHttpRequest(request, response, line => logs.push(line));
    await delay(520); response.writeHead(200); response.end("ok");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/tasks/task-1/artifacts/secret.md?token=private-secret`)).text();
    assert.ok(logs.some(line => line.includes("[http-timing]")));
    assert.doesNotMatch(logs.join("\n"), /private-secret|secret\.md/);
    assert.equal(pendingHttpRequests().length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("浏览器诊断只接受固定分类和数字，不把客户端附带的 URL、内容和凭据写入日志", () => {
  const rows = sanitizeBrowserTimings([{ kind: "resource", area: "artifacts", duration_ms: 1500,
    first_byte_ms: 1000, url: "/private/file?token=secret", content: "业务正文", cookie: "secret" },
    { kind: "secret", duration_ms: 1000 }, { kind: "longtask", duration_ms: Infinity }]);
  assert.deepEqual(rows, [{ kind: "resource", area: "artifacts", duration_ms: 1500, first_byte_ms: 1000 }]);
});

test("真实服务启动自动启用诊断，恢复完成后正常关闭并输出最后一份 CPU 摘要", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-startup-diagnostics-"));
  try {
    const result = await runServe(["--data", root, "--port", "0"], line => line.includes("任务恢复完成，开始接收业务请求"));
    assert.equal(result.code, 0, result.output); assert.equal(result.matched, true);
    assert.match(result.output, /\[startup-phase\]/);
    assert.match(result.output, /"event":"cpu_profile"/);
    assert.match(result.output, /\[runtime-diagnostics\].*"event":"stop"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
