import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLocalClock,
  instantMs,
  relativeTime,
} from "../web/src/time.ts";

test("时间入口:历史 UTC 裸串与标准 ISO 表示同一个时间点", () => {
  const expected = Date.parse("2026-08-19T03:36:59.000Z");
  assert.equal(instantMs("2026-08-19 03:36:59"), expected);
  assert.equal(instantMs("2026-08-19T03:36:59.000Z"), expected);
  assert.equal(instantMs("2026-08-19T11:36:59.000+08:00"), expected);
});

test("相对耗时:统一入口不会把 UTC 裸串凭空多算八小时", () => {
  assert.equal(relativeTime(
    "2026-08-19 03:36:59",
    Date.parse("2026-08-19T03:46:59.000Z"),
  ), "10 分钟前");
});

test("本地展示:结果来自浏览器时区而非服务端字符串截取", () => {
  const value = "2026-08-19T03:36:59.000Z";
  assert.equal(formatLocalClock(value, true), new Date(value).toLocaleTimeString(
    "zh-CN",
    { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false },
  ));
});
