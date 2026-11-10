import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DisplayEventReader } from "../src/displayEvents.ts";
import { AnnotationStore, TASK_REQUIREMENT_ARTIFACT } from "../src/annotations.ts";
import { EventLog, type SemanticEvent } from "../src/semanticEvents.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { PIPELINE_EVIDENCE_GAP_ARTIFACT, PIPELINE_EVIDENCE_GAP_FILE } from "../src/artifacts.ts";

test("40 MB 任务并发打开批注和会话时文档仍可读取，热读和追加不回放历史", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-http-"));
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("核对需求原文");
  const state = (service as any).tasks.get(task.id);
  state.summary.status = "completed";
  const note = service.addAnnotation(task.id, { author: "本地用户", artifact: TASK_REQUIREMENT_ARTIFACT,
    file: "需求原文", line: 1, anchor: "核对需求原文", note: "补充验收说明", kind: "doc" });
  new AnnotationStore(join(task.workspace, "annotations.jsonl")).markSent([note.id], "interrupt");
  mkdirSync(join(task.workspace, "pipeline"), { recursive: true });
  writeFileSync(join(task.workspace, "pipeline", PIPELINE_EVIDENCE_GAP_FILE), "# 验收说明\n正常读取");
  const ts = new Date(Date.now() + 1000).toISOString();
  const event = (eventId: number, kind: SemanticEvent["kind"], payload: Record<string, unknown>) =>
    JSON.stringify({ eventId, taskId: task.id, sessionId: "main", ts, kind, payload }) + "\n";
  const path = service.eventLogPath(task.id), fd = openSync(path, "w");
  const message = "请核对完整原文：" + "内容".repeat(1000);
  state.pendingMainSteers = [message];
  try {
    for (let i = 1; i <= 2048; i++) writeSync(fd, event(i, "tool_finished", {
      call_id: String(i), name: "bash", input: { command: "npm run build" }, is_error: false, result: "x".repeat(20 * 1024),
    }));
    writeSync(fd, event(2049, "user_message", { text: message, display: "请核对", via: "interrupt" }));
    writeSync(fd, event(2050, "assistant_message", { text: "已补充验收说明" }));
  } finally { closeSync(fd); }
  const size = statSync(path).size;
  let bytes = 0, began!: () => void;
  const reading = new Promise<void>(resolve => { began = resolve; });
  (service as any).displayEvents = new DisplayEventReader({ observeRead: n => { bytes += n; began(); } });
  const replay = t.mock.method(EventLog.prototype, "replay", () => { throw new Error("页面不能调用恢复回放"); });
  const server = createTaskServer(service, { startup: { state: "ready" } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timings: Record<string, number> = {};
  const get = async (suffix: string, label = suffix): Promise<any> => {
    const started = performance.now();
    const response = await fetch(base + `/tasks/${task.id}/` + suffix);
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    timings[label] = Math.round(performance.now() - started); return body;
  };
  const requests = [get("annotations"), get("conversation"), get("interrupts"), get("activity"), get("developer-assistant"), get("timeline")];
  const cold = Promise.all(requests);
  void cold.catch(() => {});
  try {
    await reading;
    const health = await fetch(base + "/health"); assert.equal(health.status, 200); await health.json();
    const doc = await get("artifacts/" + encodeURIComponent(PIPELINE_EVIDENCE_GAP_ARTIFACT), "document_during_cold_read");
    assert.match(doc.content, /正常读取/);
    assert.ok(bytes < size, "普通文档必须在大日志读完之前返回");
    const [annotations, , interrupts] = await cold;
    assert.deepEqual(annotations.reply, { texts: ["已补充验收说明"], truncated: false });
    assert.equal(interrupts[0].text, "请核对"); assert.equal(interrupts[0].delivered, false);
    assert.equal(bytes, size, "六个并发端点共用一次冷读");
    await get("annotations", "annotations_warm"); await get("conversation", "conversation_warm");
    assert.equal(bytes, size, "热读不能再次读取历史正文");
    state.pendingMainSteers = [];
    assert.equal((await get("interrupts"))[0].delivered, true, "缓存事件不能缓存送达判定");
    const extra = event(2051, "assistant_message", { text: "继续补充" }); appendFileSync(path, extra);
    assert.deepEqual((await get("annotations", "annotations_after_append")).reply.texts, ["已补充验收说明", "继续补充"]);
    assert.equal(bytes, size + Buffer.byteLength(extra));
    assert.equal(replay.mock.callCount(), 0);
    t.diagnostic(JSON.stringify({ file_bytes: size, ...timings }));
  } finally {
    await Promise.allSettled(requests);
    replay.mock.restore(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("原始 SSE 分块重放大日志，慢客户端不会丢行，跨块 UTF-8 及超长行保持原文", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-sse-"));
  const service = new TaskService({ dataDir: root, provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("fixture");
  (service as any).tasks.get(task.id).summary.status = "completed";
  const rows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ eventId: i + 1, taskId: task.id,
    sessionId: "main", ts: "2026-09-23T00:00:00Z", kind: "assistant_message", payload: { text: "中文".repeat(80_000) } }));
  writeFileSync(service.eventLogPath(task.id), rows.join("\n") + "\n");
  const server = createTaskServer(service, { startup: { state: "ready" } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${base}/tasks/${task.id}/events`);
    assert.equal(response.status, 200);
    // 暂不消费响应体；此时服务必须仍可服务其他请求。
    const health = await fetch(base + "/health"); assert.equal(health.status, 200); await health.json();
    const streamed = (await response.text()).split("\n\n").filter(Boolean).map(line => line.slice(6));
    assert.deepEqual(streamed, rows);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
