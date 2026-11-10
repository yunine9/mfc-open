import { existsSync } from "node:fs";
import { join } from "node:path";
import { readMemoryUsage } from "./memoryUsage.ts";
import type { MemoryStore } from "./taskMemory.ts";

/** Historical exposure is evidence for review, not a verdict that knowledge helped or harmed. */
export function memoryFeedbackEvidence(workspace: string, store: MemoryStore) {
  const records = new Map<string, {
    id: string; memory_id: string; revision?: string; note: string;
    historical?: { trigger: string; conclusion: string; scope: string; module?: string; product_versions?: string[] };
    current_revision?: number;
    current?: { trigger: string; conclusion: string; scope: string; module?: string; product_versions?: string[] };
    observations: Array<{ at?: string; moment: string; start_line?: number; end_line?: number }>;
  }>();
  const histories = new Map<string, ReturnType<MemoryStore["history"]>>();
  try {
    if (!existsSync(join(workspace, "memory-usage.jsonl"))) return { available: false, records: [] };
    for (const event of readMemoryUsage(workspace)) {
      const moment = String(event.moment);
      if (!["context", "expand", "launch", "phase", "edit"].includes(moment)
          || event.status && event.status !== "ready" && !(moment === "context" && event.status === "unavailable")
          || !Array.isArray(event.ids)) continue;
      for (const id of new Set(event.ids.filter((id): id is string => typeof id === "string" && id.startsWith("c-")))) {
        const asset = Array.isArray(event.assets) ? event.assets.find(a => a?.id === id) : undefined;
        const revision = typeof asset?.revision === "string" && asset.revision ? asset.revision : undefined;
        const key = `memory:${id}:${revision ?? "unknown"}`;
        if (!records.has(key)) {
          if (!histories.has(id)) histories.set(id, store.history(id));
          const historical = revision && histories.get(id)!.find(row => String(row.revision ?? 1) === revision);
          const current = store.find(id);
          records.set(key, { id: key, memory_id: id, revision,
            note: historical ? `经验 ${id} 的修订 ${revision} 曾提供给任务；历史正本供复核，不证明完整读取或正确采用。`
              : `经验 ${id} 的消费记录缺少可核对的历史版本；不能用当前正文代替当时内容。`,
            historical: historical ? { trigger: historical.trigger, conclusion: historical.conclusion,
              scope: historical.scope, module: historical.module, product_versions: historical.product_versions } : undefined,
            current_revision: current?.revision ?? undefined,
            current: current ? { trigger: current.trigger, conclusion: current.conclusion,
              scope: current.scope, module: current.module, product_versions: current.product_versions } : undefined,
            observations: [],
          });
        }
        records.get(key)!.observations.push({ at: typeof event.ts === "string" ? event.ts : undefined, moment,
          ...(Number.isInteger(asset?.start_line) ? { start_line: asset.start_line } : {}),
          ...(Number.isInteger(asset?.end_line) ? { end_line: asset.end_line } : {}) });
      }
    }
    return { available: true, records: [...records.values()] };
  } catch { return { available: false, records: [] }; }
}
