let generation = 0;
const listeners = new Set<() => void>();
export const knowledgeReadGeneration = () => generation;
export function subscribeKnowledgeReads(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** 修改、同步或权限切换后立即失效；旧请求完成时不得恢复已失效的缓存。 */
export function invalidateKnowledgeReads() {
  generation++;
  for (const listener of listeners) listener();
}

/** 仅保留有期限、有容量上限的读取结果；同一版本的并发读取共享请求。 */
export function createKnowledgeReadCache<T>(options: {
  maxEntries: number; maxWeight: number; ttl: number; weight: (value: T) => number;
}) {
  type Entry = { generation: number; pending: Promise<T>; value?: T; expires: number; weight: number };
  const entries = new Map<string, Entry>();
  function valid(key: string) {
    const entry = entries.get(key);
    if (entry && (entry.generation !== generation || entry.value !== undefined && entry.expires <= Date.now())) {
      entries.delete(key); return undefined;
    }
    return entry;
  }
  return {
    peek(key: string): T | undefined { return valid(key)?.value; },
    read(key: string, load: () => Promise<T>, refresh = false, accept: (value: T) => boolean = () => true): Promise<T> {
      const existing = refresh ? undefined : valid(key);
      if (existing) {
        entries.delete(key); entries.set(key, existing);
        return existing.pending;
      }
      const entry: Entry = { generation, pending: undefined!, expires: 0, weight: 0 };
      entry.pending = Promise.resolve().then(load).then(value => {
        if (entries.get(key) !== entry || generation !== entry.generation) return value;
        const weight = options.weight(value);
        if (!accept(value) || weight > options.maxWeight) { entries.delete(key); return value; }
        entry.value = value; entry.weight = weight; entry.expires = Date.now() + options.ttl;
        let total = [...entries.values()].reduce((sum, item) => sum + item.weight, 0);
        for (const [oldKey, old] of entries) {
          if (entries.size <= options.maxEntries && total <= options.maxWeight) break;
          entries.delete(oldKey); total -= old.weight;
        }
        return value;
      }).catch(error => { if (entries.get(key) === entry) entries.delete(key); throw error; });
      entries.set(key, entry);
      // 尚未完成的请求也受条目数限制，切换大量文稿时不会无限积累。
      while (entries.size > options.maxEntries) entries.delete(entries.keys().next().value!);
      return entry.pending;
    },
  };
}
