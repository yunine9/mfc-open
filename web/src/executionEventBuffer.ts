import type { SemanticEvent } from "./api";
import { executionEventKey } from "./eventView";
import { instantMs } from "./time";

type Entry = { event: SemanticEvent; time: number; order: number };
const compare = (a: Entry, b: Entry) => a.time - b.time || a.order - b.order;

/** Replay is a burst, not thousands of separate React updates. Keep identity
 * lookups constant-time and parse each timestamp only once. */
export class ExecutionEventBuffer {
  private seen = new Set<string>();
  private pending: Entry[] = [];
  private ordered: Entry[] = [];
  private snapshot: SemanticEvent[] = [];

  add(event: SemanticEvent): boolean {
    const key = executionEventKey(event);
    if (this.seen.has(key)) return false;
    const time = instantMs(event.ts);
    this.pending.push({ event, time: Number.isFinite(time) ? time : 0, order: this.seen.size });
    this.seen.add(key);
    return true;
  }

  flush(): SemanticEvent[] {
    if (!this.pending.length) return this.snapshot;
    const incoming = this.pending.sort(compare);
    this.pending = [];
    const merged: Entry[] = [];
    let left = 0, right = 0;
    while (left < this.ordered.length && right < incoming.length) {
      merged.push(compare(this.ordered[left], incoming[right]) <= 0
        ? this.ordered[left++] : incoming[right++]);
    }
    while (left < this.ordered.length) merged.push(this.ordered[left++]);
    while (right < incoming.length) merged.push(incoming[right++]);
    this.ordered = merged;
    this.snapshot = merged.map(entry => entry.event);
    return this.snapshot;
  }
}
