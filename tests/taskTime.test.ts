import { test } from "node:test";
import assert from "node:assert/strict";
import { waitedMs, waitingTimestamp } from "../web/src/taskTime.ts";

test("等待时间:旧版无时区 UTC 不再在东八区凭空多出 8 小时", () => {
  assert.equal(
    waitingTimestamp("2026-08-19 04:00:00"),
    Date.parse("2026-08-19T04:00:00.000Z"),
  );
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-19T04:10:00.000Z");
  try {
    const task = {
      status: "waiting_for_human",
      waiting: { created_at: "2026-08-19 04:00:00" },
      created_at: "2026-08-19T04:00:00.000Z",
    };
    assert.equal(waitedMs(task), 10 * 60_000);
  } finally {
    Date.now = originalNow;
  }
});

test("等待时间:标准 ISO 时区保持原样", () => {
  assert.equal(
    waitingTimestamp("2026-08-19T12:00:00.000+08:00"),
    Date.parse("2026-08-19T04:00:00.000Z"),
  );
});
