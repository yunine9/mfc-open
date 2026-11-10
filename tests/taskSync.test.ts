import assert from "node:assert/strict";
import test from "node:test";
import { taskSyncCopy } from "../web/src/taskSync.ts";

test("同步失败必须明说页面正在展示旧数据", () => {
  assert.deepEqual(taskSyncCopy({
    kind: "error",
    last_success_at: "2026-08-23T08:00:00Z",
    detail: "network down",
  }), {
    title: "数据更新中断",
    detail: "当前显示上次结果 · 点击重试",
    retry: true,
  });
});

test("首屏失败与正常同步使用不同口径", () => {
  assert.equal(taskSyncCopy({ kind: "error", detail: "offline" }).detail,
    "尚未取得任务数据 · 点击重试");
  assert.deepEqual(taskSyncCopy({
    kind: "live",
    last_success_at: "2026-08-23T08:00:00Z",
  }), {
    title: "任务数据已同步",
    detail: "现场持续更新",
    retry: false,
  });
});
