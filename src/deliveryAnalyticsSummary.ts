import { emptyOrigins, type DeliveryAnalysisRow, type OriginCounts } from "./deliveryAnalyticsTypes";
export const sumOrigins = (counts: OriginCounts): number => Object.values(counts).reduce((a, b) => a + b, 0);
function deliveryLines(row: DeliveryAnalysisRow): number | undefined {
  return row.final_code_lines ?? (row.metric ? sumOrigins(row.metric.retained) : undefined);
}

// 一行代表一次交付，同一任务的下一轮有独立的 delivery_id。
function deliveryRounds(rows: DeliveryAnalysisRow[]): Map<string, DeliveryAnalysisRow> {
  const rounds = new Map<string, DeliveryAnalysisRow>();
  for (const row of rows) {
    const key = `${row.id}:${row.delivery_id ?? "initial"}`;
    const previous = rounds.get(key);
    if (!previous || (!previous.metric && row.metric) ||
        (deliveryLines(previous) === undefined && deliveryLines(row) !== undefined)) {
      rounds.set(key, row);
    }
  }
  return rounds;
}

export function aggregateDelivery(rows: DeliveryAnalysisRow[]) {
  const retained = emptyOrigins(), rework = emptyOrigins();
  let available = 0, deleted = 0, codeAvailable = 0, codeLines = 0;
  const rounds = deliveryRounds(rows);
  for (const row of rounds.values()) {
    const lines = deliveryLines(row);
    if (lines !== undefined) {
      codeAvailable++;
      codeLines += lines;
    }
    deleted += row.final_deleted_lines ?? row.metric?.deleted ?? 0;
    if (!row.metric) continue;
    available++;
    for (const key of Object.keys(retained) as Array<keyof OriginCounts>) {
      retained[key] += row.metric.retained[key];
      rework[key] += row.metric.rework[key];
    }
  }
  const total = sumOrigins(retained);
  return { retained, rework, available, tasks: rounds.size, total, deleted, codeAvailable, codeLines,
    firstPercent: total ? retained.first / total * 100 : null };
}

/** Count only actual merged delivery leaves; each has one root requirement owner. */
export function aggregateDeliveryModules(rows: DeliveryAnalysisRow[]) {
  const groups = new Map<string, { id: string; name: string; lines: number }>();
  for (const row of deliveryRounds(rows.filter(row => row.merged)).values()) {
    const lines = deliveryLines(row);
    if (lines === undefined) continue;
    const id = row.business_module?.id ?? "";
    const group = groups.get(id) ?? { id, name: row.business_module?.name ?? "未关联模块", lines: 0 };
    group.lines += lines; groups.set(id, group);
  }
  const total = [...groups.values()].reduce((sum, group) => sum + group.lines, 0);
  return [...groups.values()].sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name))
    .map(group => ({ ...group, percent: total ? group.lines / total * 100 : 0 }));
}

/** Parent analysis includes its own planning and the selected children's usage.
 * Each task ledger is counted once; absent provider data is not a measured zero. */
export function aggregateDeliveryTokens(ids: string[], ledger: import("./deliveryAnalyticsTypes.ts").DeliveryTaskTokens[] = [], parentId?: string) {
  const byId = new Map(ledger.map(row => [row.id, row]));
  const selected = new Set(ids);
  if (parentId) {
    selected.add(parentId);
    for (const id of ids) {
      let parent = byId.get(id)?.parent_id;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent); selected.add(parent);
        if (parent === parentId) break;
        parent = byId.get(parent)?.parent_id;
      }
    }
  }
  let input = 0, output = 0, available = 0;
  for (const id of selected) {
    const usage = byId.get(id)?.usage;
    if (!usage) continue;
    available++; input += usage.input_tokens; output += usage.output_tokens;
  }
  return { input, output, total: input + output, available, tasks: selected.size };
}
