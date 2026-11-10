import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byTeamAttention,
  cycleTimeMs,
  isBlocked,
  isCurrentTeamTask,
  isStale,
  median,
  matchesTeamScope,
  needsAction,
  responsibleOf,
  teamDeliveryBreakdown,
  type TeamTask,
} from "../web/src/teamOps.ts";

function task(patch: Partial<TeamTask> = {}): TeamTask {
  return {
    id: "task-1",
    requirement: "修复通知降级",
    status: "running",
    created_at: "2026-08-16T00:00:00.000Z",
    ...patch,
  };
}

test("团队行动口径:任务只有一个责任人,人工节点和机器停机进入关注", () => {
  assert.equal(responsibleOf(task({ luban_account: "alice" })), "alice");
  assert.equal(needsAction(task({ status: "waiting_for_human" })), true);
  assert.equal(isBlocked(task({ status: "failed" })), true);
});

test("停滞只认有效进展时间,完成任务不误报", () => {
  const now = Date.parse("2026-08-16T04:00:00.000Z");
  assert.equal(isStale(task({
    last_progress_at: "2026-08-16T01:00:00.000Z",
  }), now), true);
  assert.equal(isStale(task({
    status: "completed",
    last_progress_at: "2026-08-16T01:00:00.000Z",
  }), now), false);
});

test("团队现场保留待合入任务：MR 合入或用户停止才离场", () => {
  assert.equal(isCurrentTeamTask(task({ status: "running" })), true);
  assert.equal(isCurrentTeamTask(task({ status: "waiting_for_human" })), true);
  assert.equal(isCurrentTeamTask(task({ status: "failed" })), true);
  assert.equal(isCurrentTeamTask(task({ status: "await_merge" })), true);
  assert.equal(isCurrentTeamTask(task({ status: "completed" })), false);
  assert.equal(isCurrentTeamTask(task({ status: "coordinating" })), true,
    "子任务进行中的主任务必须留在当前现场");
  assert.equal(isCurrentTeamTask(task({ status: "canceled" })), false);
});

test("团队交付统计的总览、阶段和状态使用同一批任务", () => {
  const rows = [
    task({ id: "done", status: "completed" }),
    task({ id: "coding", status: "running", progress: {
      current_phase: "开发", phases: ["方案", "开发", "检视与验证"],
    } }),
    task({ id: "verify", parent_task_id: "coding", status: "verifying", progress: {
      current_phase: "检视与验证", phases: ["方案", "开发", "检视与验证"],
    } }),
    task({ id: "failed", status: "failed" }),
    task({ id: "canceled", status: "canceled" }),
  ];
  const result = teamDeliveryBreakdown(rows);
  assert.equal(result.requirements, 3, "需求数只计主任务，并沿用概览排除已取消的口径");

  assert.deepEqual({
    total: result.total,
    delivered: result.delivered,
    delivering: result.delivering,
  }, { total: 4, delivered: 1, delivering: 3 });
  assert.equal(result.stages.reduce((sum, item) => sum + item.count, 0), 3);
  assert.equal(result.statuses.reduce((sum, item) => sum + item.count, 0), 3);
  assert.equal(result.statuses.length, 6,
    "原始技术状态应收敛成团队真正关心的业务状态");
  assert.deepEqual(result.statuses.filter((item) => item.count > 0), [
    { key: "progressing", label: "推进中", count: 1 },
    { key: "action_required", label: "需要处理", count: 1 },
    { key: "verifying", label: "验证中", count: 1 },
  ]);
  assert.deepEqual(result.stages, [
    { key: "方案", count: 0 },
    { key: "开发", count: 1 },
    { key: "检视与验证", count: 1 },
    { key: "尚未进入阶段", count: 1 },
  ]);
});

test("团队排序先行动项,再看停滞时长;交付周期中位数可解释", () => {
  const rows = [
    task({ id: "recent", last_progress_at: "2026-08-16T03:00:00.000Z" }),
    task({ id: "old", last_progress_at: "2026-08-16T00:00:00.000Z" }),
    task({ id: "blocked", status: "failed" }),
  ].sort(byTeamAttention);
  assert.equal(rows[0].id, "blocked");
  assert.equal(cycleTimeMs(task({
    created_at: "2026-08-16T00:00:00.000Z",
    completed_at: "2026-08-16T03:00:00.000Z",
  })), 3 * 60 * 60_000);
  assert.equal(median([1, 9, 3, 5]), 4);
});

test("团队排序优先使用服务端焦点,环境故障不会藏在普通运行态里", () => {
  const rows = [
    task({ id: "running" }),
    task({
      id: "environment",
      focus: {
        kind: "blocked",
        headline: "Maven 仓库不可达",
        next_action: "等待平台恢复编译环境",
        needs_attention: true,
        priority: 85,
      },
    }),
    task({
      id: "decision",
      focus: {
        kind: "human_action",
        headline: "需要确认 2 个决策项",
        next_action: "提交决定后 Agent 自动继续",
        needs_attention: true,
        priority: 100,
      },
    }),
  ].sort(byTeamAttention);
  assert.deepEqual(rows.map((row) => row.id), [
    "decision", "environment", "running",
  ]);
  assert.equal(needsAction(rows[1]), true);
  assert.equal(isBlocked(rows[1]), true);
});

test("运营指标点开后的任务数必须和卡片口径一致", () => {
  const now = Date.parse("2026-08-23T08:00:00.000Z");
  const rows = [
    task({ id: "decision", status: "waiting_for_human" }),
    task({
      id: "stale", status: "running",
      last_progress_at: "2026-08-23T05:00:00.000Z",
    }),
    task({
      id: "week", status: "completed",
      completed_at: "2026-08-22T08:00:00.000Z",
    }),
    task({
      id: "old", status: "completed",
      completed_at: "2026-08-01T08:00:00.000Z",
    }),
  ];
  assert.deepEqual(rows.filter((row) => matchesTeamScope(row, "action", now))
    .map((row) => row.id), ["decision"]);
  assert.deepEqual(rows.filter((row) => matchesTeamScope(row, "stale", now))
    .map((row) => row.id), ["stale"]);
  assert.deepEqual(rows.filter((row) => matchesTeamScope(row, "wip", now))
    .map((row) => row.id), ["decision", "stale"]);
  assert.deepEqual(rows.filter((row) => matchesTeamScope(row, "week", now))
    .map((row) => row.id), ["week"]);
  assert.deepEqual(rows.filter((row) => matchesTeamScope(row, "delivered", now))
    .map((row) => row.id), ["week", "old"]);
});
