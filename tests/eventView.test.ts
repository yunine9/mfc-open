import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventFilterCounts,
  eventWindow,
  filterEvents,
  isErrorEvent,
} from "../web/src/eventView.ts";

interface TestEvent {
  eventId: number;
  kind: string;
  ts: string;
  payload: Record<string, unknown>;
}

function event(
  eventId: number,
  kind: string,
  payload: Record<string, unknown> = {},
): TestEvent {
  return { eventId, kind, payload, ts: "2026-08-23T00:00:00.000Z" };
}

test("SSE 筛选只改变读法，不改写或丢弃原始事件", () => {
  const events = [
    event(1, "assistant_message"),
    event(2, "tool_requested"),
    event(3, "tool_finished", { is_error: true }),
    event(4, "task_failed"),
  ];
  assert.deepEqual(filterEvents(events, "messages").map((item) => item.eventId), [1]);
  assert.deepEqual(filterEvents(events, "tools").map((item) => item.eventId), [2, 3]);
  assert.deepEqual(filterEvents(events, "errors").map((item) => item.eventId), [3, 4]);
  assert.equal(events.length, 4);
  assert.equal(isErrorEvent(events[2]), true);
  assert.deepEqual(eventFilterCounts(events), {
    all: 4, messages: 1, tools: 2, errors: 2,
  });
});

test("SSE 大账本仅渐进挂载 DOM，完整事件仍留在原数组", () => {
  const events = Array.from({ length: 500 }, (_, index) =>
    event(index + 1, "tool_finished"));
  const first = eventWindow(events, 120);
  assert.equal(first.hidden, 380);
  assert.equal(first.items[0].eventId, 381);
  assert.equal(first.items.at(-1)?.eventId, 500);
  assert.equal(eventWindow(events, 240).items[0].eventId, 261);
  assert.equal(events.length, 500);
});
