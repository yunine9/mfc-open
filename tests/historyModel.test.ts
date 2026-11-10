import assert from "node:assert/strict";
import test from "node:test";
import {
  historyTaskTitle,
  historyTaskHierarchy,
  isDeliveryArchiveStatus,
  workspaceHistoryEntries,
} from "../web/src/historyModel.ts";

interface TestTask {
  id: string;
  title?: string;
  requirement: string;
  status: string;
  created_at: string;
  updated_at?: string;
  last_progress_at?: string;
}

function task(overrides: Partial<TestTask> = {}): TestTask {
  return {
    id: "task-1",
    title: "清晰标题",
    requirement: "很长的需求正文\n第二行",
    status: "running",
    created_at: "2026-08-22T08:00:00Z",
    ...overrides,
  };
}

test("现场历史优先使用任务标题，并为旧任务提取需求首行", () => {
  assert.equal(historyTaskTitle(task()), "清晰标题");
  assert.equal(historyTaskTitle(task({ title: "", requirement: "首行摘要\n完整正文" })), "首行摘要");
});

test("现场历史按最近活动倒序并保留可跳转的完整任务", () => {
  const entries = workspaceHistoryEntries([
    task({ id: "task-1", updated_at: "2026-08-22T09:00:00Z" }),
    task({ id: "task-2", title: "较新的任务", last_progress_at: "2026-08-22T10:00:00Z" }),
  ]);

  assert.deepEqual(entries.map((entry) => entry.id), ["task-2", "task-1"]);
  assert.equal(entries[0]?.updated_at, "2026-08-22T10:00:00Z");
  assert.equal(entries[0]?.event_count, 0);
  assert.equal(entries[0]?.title, "较新的任务");
});

test("交付档案不再混入排队、运行和等待决策", () => {
  assert.equal(isDeliveryArchiveStatus("queued"), false);
  assert.equal(isDeliveryArchiveStatus("running"), false);
  assert.equal(isDeliveryArchiveStatus("waiting_for_human"), false);
  assert.equal(isDeliveryArchiveStatus("await_merge"), false);
  assert.equal(isDeliveryArchiveStatus("completed"), true);
  assert.equal(isDeliveryArchiveStatus("failed"), true);
  assert.equal(isDeliveryArchiveStatus("canceled"), true);
});

test("#517 档案按主子关系排序，数据库旧条目可从当前现场补齐关系", () => {
  const entries = [{ id: "child-2" }, { id: "other" }, { id: "parent" }, { id: "child-1", parent_task_id: "parent" }];
  const ordered = historyTaskHierarchy(entries, [{ id: "child-2", parent_task_id: "parent" }]);
  assert.deepEqual(ordered.map(entry => entry.id), ["other", "parent", "child-2", "child-1"]);
  assert.equal(ordered.find(entry => entry.id === "child-2")?.parent_task_id, "parent");
  assert.deepEqual(historyTaskHierarchy([{ id: "orphan", parent_task_id: "outside" }], []), [{ id: "orphan", parent_task_id: "outside" }]);
});
