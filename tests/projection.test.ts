/**
 * PostgreSQL 投影的本地可跑契约:投影是旁路——数据库不可达时写入
 * 不抛错、流程无感(fail-open)。真 PG 集群的 upsert/幂等/重放语义
 * 用例已于 2026-09-17 测试精简专题删除(本地与 CI 均无 PG 二进制,
 * 恒 skip,双环境零执行)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PgProjection } from "../src/projection.ts";

function summaryOf(id: string, status: string) {
  return {
    id, requirement: "需求原话", status: status as never,
    created_at: new Date().toISOString(), workspace: `/w/${id}`,
  };
}

test("fail-open:数据库不可达,写入不抛错,失败可观测", async () => {
  // 端口 1 永远连不上;这条不依赖临时集群,无 PG 二进制也要跑。
  const logs: string[] = [];
  const projection = new PgProjection(
    "postgresql://postgres@127.0.0.1:1/postgres",
    (message) => logs.push(message));
  try {
    await projection.upsertTask(summaryOf("task-9", "queued"));
    assert.ok(projection.lastError, "失败必须可观测");
    assert.ok(logs.some((line) => line.includes("流程不受影响")));
  } finally {
    await projection.close();
  }
});

test("#517 历史投影写入与读取父任务 ID，不依赖本机仍保存任务", async () => {
  const projection = new PgProjection("postgresql://postgres@127.0.0.1:1/postgres");
  let storedParent: unknown;
  const pool = (projection as any).pool;
  pool.query = async (sql: string, values?: unknown[]) => {
    if (sql.includes("insert into tasks")) {
      const columns = sql.match(/insert into tasks \(([^)]+)\)/s)![1].split(",").map(column => column.trim());
      storedParent = values![columns.indexOf("parent_task_id")];
      assert.match(sql, /parent_task_id = excluded.parent_task_id/);
    }
    if (sql.includes("select t.task_id")) {
      assert.match(sql, /t.parent_task_id/);
      return { rows: [{ task_id: "child", requirement: "子需求", status: "completed", workspace: "/w/child", created_at: "2026-10-16", updated_at: "2026-10-16", event_count: 0, parent_task_id: storedParent }] };
    }
    return { rows: [] };
  };
  try {
    await projection.upsertTask({ ...summaryOf("child", "completed"), parent_task_id: "parent" });
    assert.equal(projection.lastError, undefined);
    assert.equal((await projection.listTaskHistory())[0].parent_task_id, "parent");
  } finally { await projection.close(); }
});
