/** Shared display facts only; do not import the Node host into the web build. */
interface TaskProgress {
  current_phase: string; step_id?: string; revision?: number; step?: string;
  milestone?: { task_id: string; event: string; title?: string; reason?: string };
}
/** Pulse revision/rendering is not progress. The first observation after restart
 * only warms the cache; it must not reset an already persisted stalled clock. */
export function progressAdvanced(previous: TaskProgress | undefined, next: TaskProgress): boolean {
  if (!previous) return false;
  const facts = (p: TaskProgress) => [p.current_phase, p.step_id, p.milestone?.task_id, p.milestone?.event];
  return JSON.stringify(facts(previous)) !== JSON.stringify(facts(next));
}

/** Waiting/completion timestamps remain reliable even for historical tasks whose
 * progress clock was polluted by background refreshes. */
export function taskProgressTimestamp(task: { status?: string; created_at: string; last_progress_at?: string; completed_at?: string; waiting?: { created_at?: string } | null }): string {
  if (task.status === "waiting_for_human" && task.waiting?.created_at) return task.waiting.created_at;
  if (task.status === "completed" && task.completed_at) return task.completed_at;
  return task.last_progress_at ?? task.created_at;
}
