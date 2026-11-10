import assert from "node:assert/strict";
import test from "node:test";
import { ExecutionEventBuffer } from "../web/src/executionEventBuffer.ts";
import type { SemanticEvent } from "../web/src/api.ts";

const event = (id: number, ts = "2026-09-09T01:00:00Z", sessionId = "main"): SemanticEvent => ({
  eventId: id, sessionId, ts, kind: "assistant_message", payload: { text: String(id) },
});

test("历史批次去重、跨会话同号保留、迟到事件按时间归位", () => {
  const buffer = new ExecutionEventBuffer();
  const first = event(1, "2026-09-09T02:00:00Z");
  buffer.add(first);
  const snapshot = buffer.flush();
  assert.equal(buffer.add({ ...first }), false);
  assert.equal(buffer.flush(), snapshot, "重连整流重放不触发无效渲染");
  buffer.add(event(2));
  buffer.add(event(1, first.ts, "child"));
  buffer.add({ ...event(1, first.ts), execution: { source: "build_fix", attempt: "round-1-abc", round: 1 } });
  assert.deepEqual(buffer.flush().map(e => e.payload.text), ["2", "1", "1", "1"]);
  assert.equal(snapshot.length, 1, "已发布的 React 快照不可变");
});

test("两万条重放的去重与时间解析不反复扫描旧事件", () => {
  const buffer = new ExecutionEventBuffer();
  let timestamps = 0;
  const events = Array.from({ length: 20000 }, (_, id) => {
    const e = event(id);
    Object.defineProperty(e, "ts", { get() { timestamps++; return "2026-09-09T01:00:00Z"; } });
    return e;
  });
  for (const e of events) buffer.add(e);
  const snapshot = buffer.flush();
  for (const e of events) buffer.add(e);
  assert.equal(buffer.flush(), snapshot);
  assert.equal(snapshot.length, events.length);
  assert.equal(timestamps, events.length, "时间只解析一次，不能每条到达都重排全历史");
});
