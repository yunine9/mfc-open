import assert from "node:assert/strict";
import test from "node:test";
import { journeyCurrent, recentJourney } from "../web/src/journeyModel.ts";
import type { TaskSummary, TimelineEntry } from "../web/src/api.ts";

test("当前卡点以任务快照为准，不从不完整时间线推断无卡点", () => {
  const task = { status: "waiting_for_human", waiting: { question: { questions: [{ question: "是否推送？" }] } } } as TaskSummary;
  assert.equal(journeyCurrent(task).title, "等待负责人确认");
  assert.equal(journeyCurrent(task).detail, "是否推送？");
  assert.equal(journeyCurrent(task).tone, "attention");
  assert.equal(journeyCurrent({ status: "failed", detail: "构建失败" } as TaskSummary).tone, "danger");
  assert.equal(journeyCurrent({ status: "verifying", delivery: { stalled: "平台无响应" } } as TaskSummary).detail, "平台无响应");
});

test("过程按真实时间降序，同时间保留倒序顺序，不改动源数据", () => {
  const entries = [
    { ts: "2026-09-05 00:00:00", title: "开始" },
    { ts: "2026-09-05T00:10:00Z", title: "验证失败" },
    { ts: "2026-09-05T00:10:00Z", title: "进入修复" },
  ] as TimelineEntry[];
  assert.deepEqual(recentJourney(entries).map((one) => one.title), ["进入修复", "验证失败", "开始"]);
  assert.equal(entries[0].title, "开始");
});

test("进展展示 Agent 正文，工具载荷留给执行日志", async () => {
  const { journeyMessage } = await import("../web/src/journeyModel.ts");
  const event = { eventId: 1, ts: "2026-09-05T00:00:00Z", kind: "assistant_message", payload: { text: "已完成验证" } };
  assert.equal(journeyMessage(event)?.detail, "已完成验证");
  assert.equal(journeyMessage({ ...event, kind: "tool_finished" }), undefined);
  assert.equal(journeyMessage({ ...event, payload: { text: " " } }), undefined);
});
