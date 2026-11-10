import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateDelivery, aggregateDeliveryModules } from "../src/deliveryAnalyticsSummary.ts";
import { emptyOrigins, type DeliveryAnalysisRow, type DeliveryCodeMetric } from "../src/deliveryAnalyticsTypes.ts";

function metric(first: number, review: number, deleted: number): DeliveryCodeMetric {
  return {
    version: 1, head: "source", base: "base", first: "first", collected_at: "2026-01-01",
    retained: { ...emptyOrigins(), first, review }, rework: emptyOrigins(), deleted, excluded_files: 0, commits: [],
  };
}

function row(id: string, module: string, data: Partial<DeliveryAnalysisRow> = {}): DeliveryAnalysisRow {
  return { id, title: id, repo: "repo", modules: [], business_module: { id: module, name: module },
    merged: true, at: "2026-01-01", ...data };
}

test("交付总量包含只能确认最终行数的 MR，首次实现占比只按已知来源的代码行加权", () => {
  const legacy = row("task-1", "A", { metric: metric(9, 1, 2) });
  const next = row("task-1", "A", { delivery_id: "second", metric: metric(0, 1, 1), final_code_lines: 1, final_deleted_lines: 1 });
  const rewritten = row("task-2", "B", { final_code_lines: 100, final_deleted_lines: 30 });
  const zero = row("task-3", "C", { final_code_lines: 0, final_deleted_lines: 8 });
  const unknown = row("task-4", "D");
  const rows = [row("task-1", "A"), legacy, next, rewritten, zero, unknown, { ...rewritten }];
  const summary = aggregateDelivery(rows);
  assert.deepEqual([summary.tasks, summary.codeAvailable, summary.codeLines, summary.deleted], [5, 4, 111, 41]);
  assert.deepEqual([summary.available, summary.total, summary.firstPercent], [2, 11, 9 / 11 * 100]);
  assert.deepEqual(summary.retained, { ...emptyOrigins(), first: 9, review: 2 });
  assert.deepEqual(aggregateDeliveryModules([...rows, row("unfinished", "E", { merged: false, final_code_lines: 42 })]), [
    { id: "B", name: "B", lines: 100, percent: 100 / 111 * 100 },
    { id: "A", name: "A", lines: 11, percent: 11 / 111 * 100 },
    { id: "C", name: "C", lines: 0, percent: 0 },
  ]);
});

test("只涉及删除的最终 MR 是已取到的零行，不产生首次实现占比", () => {
  const zero = row("task-1", "A", { final_code_lines: 0, final_deleted_lines: 5 });
  const summary = aggregateDelivery([zero, row("task-2", "B")]);
  assert.deepEqual([summary.codeAvailable, summary.codeLines, summary.deleted], [1, 0, 5]);
  assert.deepEqual([summary.available, summary.total, summary.firstPercent], [0, 0, null]);
  assert.deepEqual(aggregateDeliveryModules([zero]), [{ id: "A", name: "A", lines: 0, percent: 0 }]);
});
