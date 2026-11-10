/** Pure helpers for deterministic batches and user-facing feedback grouping. */

import { createHash } from "node:crypto";
import type {
  FeedbackRecord,
  FeedbackSource,
  FeedbackStatus,
} from "./feedbackStore.ts";

export function feedbackIdentity(input: {
  source: FeedbackSource;
  source_id: string;
  source_revision?: number;
  observed_sha: string;
}): string {
  return `${input.source}:${input.source_id}:r${input.source_revision ?? 0}`
    + `@${input.observed_sha}`;
}

export function feedbackBatchId(
  taskId: string,
  observedSha: string,
  records: Pick<FeedbackRecord, "id">[],
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    taskId,
    observedSha,
    ids: records.map((record) => record.id).sort(),
  })).digest("hex").slice(0, 20);
  return `fb-${taskId}-${digest}`;
}

export function feedbackCounts(records: FeedbackRecord[]): Record<FeedbackStatus, number> {
  const counts: Record<FeedbackStatus, number> = {
    open: 0,
    repairing: 0,
    addressed: 0,
    awaiting_verification: 0,
    closed: 0,
    needs_human: 0,
    deferred: 0,
    superseded: 0,
    superseded_by_merge: 0,
  };
  for (const record of records) counts[record.status] += 1;
  return counts;
}
