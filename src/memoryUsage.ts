import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { MemoryStore } from "./taskMemory.ts";

export interface MemoryUsageEvent {
  moment: "launch" | "phase" | "edit" | "search" | "expand" | "context" | "component_check" | "component_plan";
  plan?: { path: string; capability?: string; operation: string; errors?: number; warnings?: number };
  check?: { trigger: string; head?: string; findings: number; hints: number; rules_digest: string };
  status?: "ready" | "unavailable" | "empty" | "rejected";
  /** Exact current sources exposed by this operation; this records access, not correct application. */
  assets?: Array<{ id: string; revision: string; start_line?: number; end_line?: number; heading?: string; card_id?: string; retrieval?: string }>;
  requested_id?: string;
  reason?: "unavailable" | "not_accessible" | "revision_changed" | "invalid_range";
  ids: string[]; query?: string; phase?: string; dir?: string; digest?: boolean;
}
export function recordMemoryUsage(context: {
  workspace: string; taskId: string; store: () => MemoryStore; log?: (message: string) => void;
}, event: MemoryUsageEvent): void {
    try {
      appendFileSync(join(context.workspace, "memory-usage.jsonl"),
        JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n", "utf-8");
    } catch (error) {
      context.log?.(`任务 ${context.taskId} 记忆足迹写入失败: ${String(error)}`);
    }
    // 台账是跨任务的账(排序、沉底都看它),足迹是这单的账;两边都记。
    // Context may still contain valid cached entries while its search refresh is unavailable.
    if (event.status && event.status !== "ready"
        && !(event.moment === "context" && event.status === "unavailable")) return;
    try {
      const kind = event.moment === "search" || event.moment === "expand"
        ? event.moment : "push";
      for (const id of new Set(event.ids.filter(id => id.startsWith("c-")))) {
        context.store().ledger.append({ kind, id, task: context.taskId,
          revision: event.assets?.find(asset => asset.id === id)?.revision,
          note: event.moment === "edit" ? event.dir : event.phase ?? event.moment });
      }
    } catch (error) {
      context.log?.(`记忆台账写入失败: ${String(error)}`);
    }
}

export function readMemoryUsage(workspace: string): Array<Record<string, unknown>> {
  const path = join(workspace, "memory-usage.jsonl");
  return existsSync(path) ? readAppendOnlyJsonl<Record<string, unknown>>(path,
    { middleCorrupt: "skip" }) : [];
}
