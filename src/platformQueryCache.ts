export interface QueryResult { status: number; payload: unknown; headers?: Record<string, string> }
export const codeHubRateLimited = (error: unknown): boolean => /rate[ _-]*limit(?:ed|ing| exceeded)?|too many requests|HTTP[ :]*429/i.test(String(error));
const DELAYS = [10_000, 30_000, 60_000];
interface Scope { generation: number; level: number; until: number; probing: boolean }

/** 适配器进程内按实际凭据共享；只治理只读查询，不排队重放写操作。 */
export class PlatformQueryCache {
  private cache = new Map<string, { result: QueryResult; expires: number; bytes: number }>();
  private active = new Map<string, Promise<QueryResult>>();
  private scopes = new Map<string, Scope>();
  private bytes = 0;
  constructor(private ttlMs = 30_000, private now = () => Date.now()) {}

  invalidate(scope: string): void {
    const state = this.state(scope); state.generation++;
    for (const key of this.cache.keys()) if (key.startsWith(scope + "\0")) this.remove(key);
  }
  private state(scope: string): Scope {
    let state = this.scopes.get(scope);
    if (!state) { state = { generation: 0, level: -1, until: 0, probing: false }; this.scopes.set(scope, state); }
    return state;
  }
  private remove(key: string): void {
    this.bytes -= this.cache.get(key)?.bytes ?? 0; this.cache.delete(key);
  }
  private cooling(state: Scope, error = "CodeHub 查询已限流，请稍后重试"): QueryResult {
    const seconds = Math.max(1, Math.ceil((state.until - this.now()) / 1000));
    return { status: 429, payload: { error, retry_after_s: seconds }, headers: { "retry-after": String(seconds) } };
  }
  async read(scope: string, query: string, load: () => Promise<QueryResult>, cacheResult = true): Promise<{ result: QueryResult; source: string }> {
    const state = this.state(scope), generation = state.generation;
    const key = `${scope}\0${generation}\0${query}`;
    for (const [id, entry] of this.cache) if (entry.expires <= this.now()) this.remove(id);
    const cached = this.cache.get(key);
    if (cached) return { result: structuredClone(cached.result), source: "cache" };
    const active = this.active.get(key);
    if (active) return { result: structuredClone(await active), source: "shared" };
    if (state.until > this.now() || state.probing) return { result: this.cooling(state), source: "cooldown" };
    const probe = state.level >= 0;
    if (probe) state.probing = true;
    const work = Promise.resolve().then(load).then(result => {
      if (result.status === 429) throw new Error("HTTP 429: CodeHub rate limited");
      if (result.status >= 200 && result.status < 300) {
        if (probe) {
          state.level--;
          state.until = state.level >= 0 ? this.now() + DELAYS[state.level] : 0;
        }
        const bytes = Buffer.byteLength(JSON.stringify(result));
        if (cacheResult && this.ttlMs > 0 && bytes <= 1024 * 1024 && state.generation === generation) {
          this.cache.set(key, { result: structuredClone(result), expires: this.now() + this.ttlMs, bytes }); this.bytes += bytes;
          while (this.cache.size > 512 || this.bytes > 16 * 1024 * 1024) this.remove(this.cache.keys().next().value!);
        }
      }
      return result;
    }).catch(error => {
      if (!codeHubRateLimited(error)) {
        if (probe) state.until = this.now() + DELAYS[state.level];
        throw error;
      }
      state.level = Math.min(2, state.level + 1); state.until = this.now() + DELAYS[state.level];
      return this.cooling(state, String(error instanceof Error ? error.message : error));
    }).finally(() => { this.active.delete(key); if (probe) state.probing = false; });
    this.active.set(key, work);
    return { result: structuredClone(await work), source: "remote" };
  }
}
