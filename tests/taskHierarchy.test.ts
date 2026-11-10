import assert from "node:assert/strict";
import test from "node:test";
import { orderHierarchyBy, orderTaskHierarchy, taskOverviewRelationship } from "../web/src/taskHierarchy";

test("按时间排序后主任务仍带着全部子任务，不被其他任务插开", () => {
  const newestFirst = [
    { id: "child-new", parent_task_id: "parent", created_at: 50 },
    { id: "other", created_at: 40 },
    { id: "child-old", parent_task_id: "parent", created_at: 30 },
    { id: "parent", created_at: 20 },
  ];

  assert.deepEqual(orderTaskHierarchy(newestFirst).map((item) => item.id), [
    "other", "parent", "child-new", "child-old",
  ]);
});

test("团队列表的包装对象也按任务层级成组，问题项保留原有排序位置", () => {
  const newestFirst = [
    { key: "child", task: { id: "child", parent_task_id: "parent" } },
    { key: "issue" },
    { key: "parent", task: { id: "parent" } },
  ];

  const ordered = orderHierarchyBy(newestFirst,
    (item) => item.task?.id ?? item.key,
    (item) => item.task?.parent_task_id);
  assert.deepEqual(ordered.map((item) => item.key), [
    "issue", "parent", "child",
  ]);
});

test("父任务被筛掉时子任务不会消失", () => {
  const filtered = [{ id: "child", parent_task_id: "hidden-parent" }];
  assert.deepEqual(orderTaskHierarchy(filtered), filtered);
});

test("总览关系跨筛选保留父任务，实际子任务与交付单元引用去重", () => {
  const parent = { id: "main", requirement_graph: { stage: "confirmed", repositories: [
    { task_id: "child" }, { task_id: "child" }, { task_id: "other-child" }, { task_id: "main" },
  ] } };
  const child = { id: "child", parent_task_id: "main" };
  const all = [parent, child];
  assert.equal(taskOverviewRelationship(child, all).parent, parent);
  assert.equal(taskOverviewRelationship(parent, all).childCount, 2);
  assert.equal(taskOverviewRelationship(child, [child]).parent, undefined);
});

test("分析中的候选仓不计作已创建子任务", () => {
  const task = { id: "main", requirement_graph: { stage: "analysis", repositories: [{ task_id: "candidate" }] } };
  assert.equal(taskOverviewRelationship(task, [task]).childCount, 0);
});
