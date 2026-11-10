/**
 * 「模块与依赖」页签与依赖图组件必须同一个判定。
 * 2026-09-06 用户实测:拆分已确认的父任务(候选仓 1 个、模块 2 个)点进页签
 * 是一片空白——页签认 stage=confirmed,组件只数候选仓。此后两边都用这一个函数。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requirementGraphVisible } from "../web/src/taskHierarchy.ts";

const graph = (stage: string, modules: number, assessments?: number) => ({
  stage, repositories: Array.from({ length: modules }, (_, index) => ({ task_id: `task-${index + 2}` })),
  ...(assessments !== undefined ? { repository_assessments: Array.from({ length: assessments }, () => ({})) } : {}),
});

test("没有图或本身是子任务:不露面", () => {
  assert.equal(requirementGraphVisible({}), false);
  assert.equal(requirementGraphVisible({ parent_task_id: "task-1", repositories: ["a", "b"], requirement_graph: graph("confirmed", 2) }), false);
});

test("多候选仓:分析中就露面,哪怕最终只剩 0 或 1 个模块", () => {
  assert.equal(requirementGraphVisible({ repositories: ["a", "b"], requirement_graph: graph("analysis", 0) }), true);
  assert.equal(requirementGraphVisible({ repositories: ["a", "b", "c"], requirement_graph: graph("analysis", 1) }), true);
});

test("单候选仓:只有显式要求分析、拆出多个模块或方案已确认才露面", () => {
  assert.equal(requirementGraphVisible({ repositories: ["a"], requirement_graph: graph("analysis", 1) }), false);
  assert.equal(requirementGraphVisible({ repositories: ["a"], requirement_analysis_requested: true, requirement_graph: graph("analysis", 1) }), true);
  assert.equal(requirementGraphVisible({ repositories: ["a"], requirement_graph: graph("analysis", 2) }), true, "候选仓数与模块数不一致时以模块为准");
  assert.equal(requirementGraphVisible({ repositories: ["a"], requirement_graph: graph("confirmed", 1) }), true, "已确认的拆分方案不能随候选仓数量消失");
});

test("候选仓缺席时退回逐仓排查结论数,再退回模块数", () => {
  assert.equal(requirementGraphVisible({ requirement_graph: graph("analysis", 0, 2) }), true);
  assert.equal(requirementGraphVisible({ requirement_graph: graph("analysis", 1, 1) }), false);
  assert.equal(requirementGraphVisible({ requirement_graph: graph("analysis", 2) }), true);
});

import { keepFamiliesTogether } from "../web/src/taskHierarchy.ts";

test("一家人一起看:先完成的子任务留在还在推进的父任务下面", () => {
  const all = [
    { id: "p", status: "coordinating" },
    { id: "c1", status: "completed", parent_task_id: "p" },
    { id: "c2", status: "running", parent_task_id: "p" },
    { id: "solo-done", status: "completed" },
  ];
  const current = all.filter((task) => !["completed"].includes(task.status));
  assert.deepEqual(keepFamiliesTogether(current, all).map((task) => task.id), ["p", "c2", "c1"],
    "完成的 c1 跟父任务回到当前桶");
  const delivered = all.filter((task) => task.status === "completed");
  assert.deepEqual(keepFamiliesTogether(delivered, all).map((task) => task.id), ["solo-done"],
    "c1 不再重复出现在完成桶;没有父任务的完成单照常");
});

test("一家人一起看:父任务不在列表里的子任务按自己的状态分桶", () => {
  const all = [{ id: "c1", status: "completed", parent_task_id: "gone" }];
  assert.deepEqual(keepFamiliesTogether(all, all).map((task) => task.id), ["c1"]);
});
