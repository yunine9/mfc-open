import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DisplayEventReader, annotationReply, displayEvent } from "../src/displayEvents.ts";
import { type SemanticEvent } from "../src/semanticEvents.ts";
import { buildActivity } from "../src/activity.ts";
import { buildConversation } from "../src/conversation.ts";
import { buildTimeline } from "../src/timeline.ts";
import { developerAssistantConversation, developerAssistantTools } from "../src/developerAssistant.ts";

function event(eventId: number, kind: SemanticEvent["kind"] = "assistant_message",
  payload: Record<string, unknown> = { text: `回复 ${eventId}` }, sessionId = "main"): SemanticEvent {
  return { eventId, taskId: "fixture", sessionId, ts: new Date(Date.UTC(2026, 8, 23, 0, 0, eventId)).toISOString(), kind, payload };
}
const line = (row: SemanticEvent) => JSON.stringify(row) + "\n";

test("40 MB 冷读分块让出主线程，并发共享读取，热读不读正文，追加只读新增字节", async t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-large-"));
  const path = join(root, "events.jsonl");
  const fd = openSync(path, "w");
  const output = "x".repeat(20 * 1024);
  try {
    for (let i = 1; i <= 2048; i++) writeSync(fd, line(event(i, "tool_finished", {
      call_id: String(i), name: "bash", input: { command: "npm run build" }, result: output, is_error: false,
    })));
    writeSync(fd, line(event(2049)));
  } finally { closeSync(fd); }
  let readBytes = 0, reads = 0, ticks = 0, maxGap = 0, last = performance.now();
  const reader = new DisplayEventReader({ observeRead: bytes => { readBytes += bytes; reads++; } });
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 1);
  try {
    const started = performance.now();
    const cold = reader.read(path);
    assert.equal(reader.read(path), cold, "同一文件的并发请求只读一次");
    const rows = await cold; const coldMs = performance.now() - started;
    assert.equal(rows.length, 2049);
    assert.equal(readBytes, statSync(path).size);
    assert.ok(reads > 600 && ticks > 1, "不能一次同步读完历史");
    assert.ok(JSON.stringify(rows).length < 1024 * 1024, "不缓存工具的完整大输出");
    const hot = performance.now(); assert.equal(await reader.read(path), rows);
    const hotMs = performance.now() - hot;
    assert.equal(readBytes, statSync(path).size, "轮询未变化日志不能重读正文");
    const addition = line(event(2050)); appendFileSync(path, addition);
    assert.equal((await reader.read(path)).at(-1)?.eventId, 2050);
    assert.equal(readBytes, statSync(path).size, "追加只能读取新增的字节");
    t.diagnostic(JSON.stringify({ file_bytes: readBytes, cold_ms: Math.round(coldMs), hot_ms: Math.round(hotMs), max_timer_gap_ms: Math.round(maxGap), ticks }));
  } finally { clearInterval(timer); rmSync(root, { recursive: true, force: true }); }
});

test("展示字段压缩后，活动、会话、时间线、开发助手的内容与原始事件一致", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-parity-"));
  const rows = [
    event(1, "session_started", { resume: true, context_restored: true, restored_messages: 4 }),
    event(2), event(3, "user_message", { text: "请检查", via: "interrupt" }),
    event(4, "tool_requested", { call_id: "c", name: "bash", input: { command: "npm run build" } }),
    event(5, "tool_output", { text: "日志".repeat(10000), name: "bash", log_path: "log" }),
    event(6, "tool_finished", { call_id: "c", name: "bash", input: { command: "npm run build" }, result: "mae-flow 门禁打回", is_error: true }),
    event(7, "tool_requested", { call_id: "r", name: "Read", input: { file_path: "src/a.ts" } }),
    event(8, "tool_finished", { call_id: "r", name: "Read", input: { file_path: "src/a.ts" }, result: "文件正文", is_error: false }),
    event(9, "tool_requested", { call_id: "q", name: "AskUserQuestion", input: { questions: [{ question: "确认吗", options: [{ label: "确认" }] }] } }),
    event(10, "agent_spawned", { call_id: "a", child_session_id: "child", agent_type: "reviewer", description: "审查", prompt: "不展示的提示" }),
    event(11, "agent_finished", { call_id: "a", child_session_id: "child", lifecycle: "completed", final_text: "不展示的长输出" }),
    event(12, "human_decision", { waiting_id: "w", state_version: 1, decision: "通过", notes: "可以" }),
    event(13, "tool_requested", { call_id: "d", name: "edit", input: { path: "src/a.ts", old_text: "旧", new_text: "新" } }, "developer-assistant"),
    event(14, "tool_finished", { call_id: "d", name: "edit", input: {}, result: { content: ["完成".repeat(5000)] }, is_error: false }, "developer-assistant"),
    event(15, "assistant_message", { text: "助手已修改" }, "developer-assistant"),
    event(16, "session_ended", { reason: "completed", detail: "完成" }),
  ];
  const compact = rows.map(displayEvent);
  try {
    assert.deepEqual(buildActivity(compact, { running: false, now: Date.UTC(2026, 8, 23) }), buildActivity(rows, { running: false, now: Date.UTC(2026, 8, 23) }));
    const sources = { waiting: [], annotations: [], annotationHistory: [], feedback: [] };
    assert.deepEqual(buildConversation({ ...sources, events: compact }), buildConversation({ ...sources, events: rows }));
    assert.deepEqual(buildTimeline(root, undefined, compact, []), buildTimeline(root, undefined, rows, []));
    const snapshot = { state: "idle" as const, messages: [] };
    assert.deepEqual(developerAssistantConversation(snapshot, compact), developerAssistantConversation(snapshot, rows));
    assert.deepEqual(developerAssistantTools(compact), developerAssistantTools(rows));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("批注回话保持最后提交时间、旧 UTC 时间、主会话、最先八段与截断语义", () => {
  const rows = [event(1), event(2), event(3, "assistant_message", { text: "子会话" }, "child"),
    event(4, "assistant_message", { text: "  " }), { ...event(5), ts: "2026-09-23 00:00:05" },
    event(6, "assistant_message", { text: "长".repeat(1600) }), ...Array.from({ length: 8 }, (_, i) => event(i + 7))];
  assert.equal(annotationReply(rows, []), undefined);
  assert.equal(annotationReply(rows, ["无效时间"]), undefined);
  const reply = annotationReply(rows, [event(1).ts, event(2).ts])!;
  assert.equal(reply.texts.length, 8); assert.equal(reply.texts[0], "回复 5");
  assert.equal(reply.texts[1].length, 1501); assert.equal(reply.truncated, true);
  assert.deepEqual(annotationReply([event(3)], [event(2).ts]), { texts: ["回复 3"], truncated: false });
});

test("不修写源日志，坏行可跳过，UTF-8 半行和缺换行旧行追加后不丢不重", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-tail-")); const path = join(root, "events.jsonl");
  const reader = new DisplayEventReader();
  const tail = Buffer.from(line(event(2, "assistant_message", { text: "中文回复" })));
  const split = tail.indexOf(Buffer.from("中")) + 1;
  writeFileSync(path, Buffer.concat([Buffer.from(line(event(1)) + "坏行\n"), tail.subarray(0, split)]));
  try {
    const before = readFileSync(path);
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [1]);
    assert.deepEqual(readFileSync(path), before, "读取不能截断正在追加的源文件");
    appendFileSync(path, tail.subarray(split));
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [1, 2]);
    assert.equal((await reader.read(path))[1].payload.text, "中文回复");
    appendFileSync(path, JSON.stringify(event(3)));
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [1, 2, 3]);
    appendFileSync(path, "\n" + line(event(4)));
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [1, 2, 3, 4]);
    writeFileSync(path, line(event(8)));
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [8]);
    writeFileSync(path, line(event(9)));
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [9], "等长改写也要失效");
    writeFileSync(path + ".new", line(event(7))); renameSync(path + ".new", path);
    assert.deepEqual((await reader.read(path)).map(e => e.eventId), [7], "文件替换后不能继续旧偏移");
    rmSync(path); assert.deepEqual(await reader.read(path), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("缓存按文件数及大小淘汰，缺换行的完整大尾行也计入内存预算", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-display-lru-"));
  const a = join(root, "a"), b = join(root, "b");
  writeFileSync(a, line(event(1))); writeFileSync(b, line(event(2)));
  let reads = 0;
  const reader = new DisplayEventReader({ maxFiles: 1, observeRead: () => reads++ });
  try {
    await reader.read(a); await reader.read(b); await reader.read(a); assert.equal(reads, 3);
    writeFileSync(a, JSON.stringify(event(3, "assistant_message", { text: "x".repeat(1024) })));
    const small = new DisplayEventReader({ maxBytes: 512, observeRead: () => reads++ });
    await small.read(a); await small.read(a); assert.equal(reads, 5);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
