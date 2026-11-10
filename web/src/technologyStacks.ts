import { invalidateKnowledgeReads } from "./knowledgeReadCache";
export interface TechnologyStack { id: string; name: string; enabled: boolean }
export interface CatalogState { stacks: TechnologyStack[]; loading: boolean; loaded: boolean; error: string; deletedIds: string[] }
let state: CatalogState = { stacks: [], loading: true, loaded: false, error: "", deletedIds: [] };
let pending: Promise<TechnologyStack[]> | undefined;
let revision = 0;
const listeners = new Set<() => void>();
function update(next: CatalogState) { state = next; for (const listener of listeners) listener(); }
export function subscribeTechnologyStacks(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function stack(value: unknown): TechnologyStack {
  const item = value as TechnologyStack | undefined;
  if (!item || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.enabled !== "boolean") throw new Error("技术栈配置格式不正确");
  return { id: item.id, name: item.name, enabled: item.enabled };
}
async function request(path = "", init?: RequestInit) {
  const response = await fetch(`/technology-stacks${path}`, init);
  const body = await response.json() as { error?: string; stacks?: unknown; stack?: unknown };
  if (!response.ok) throw new Error(body?.error || "技术栈配置读取失败");
  return body;
}

export function loadTechnologyStacks(refresh = false): Promise<TechnologyStack[]> {
  if (pending) return pending;
  if (state.loaded && !refresh) return Promise.resolve(state.stacks);
  const expected = ++revision;
  update({ ...state, loading: true, error: "" });
  pending = request().then(body => {
    if (!Array.isArray(body.stacks)) throw new Error("技术栈配置格式不正确");
    const incoming: TechnologyStack[] = body.stacks.map(stack);
    const stacks = JSON.stringify(incoming) === JSON.stringify(state.stacks) ? state.stacks : incoming;
    if (expected === revision) update({ stacks, loading: false, loaded: true, error: "",
      deletedIds: [...new Set([...state.deletedIds, ...state.stacks.map(item => item.id)])].filter(id => !stacks.some(row => row.id === id)) });
    return state.stacks;
  }).catch(error => {
    if (expected === revision) update({ ...state, loading: false, error: error.message });
    throw error;
  }).finally(() => { pending = undefined; });
  return pending;
}

export async function saveTechnologyStack(input: { id?: string; name: string; enabled?: boolean }): Promise<TechnologyStack> {
  const body = await request(input.id ? `/${encodeURIComponent(input.id)}` : "", {
    method: input.id ? "PUT" : "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: input.name, enabled: input.enabled }),
  });
  const saved = stack(body.stack);
  revision++;
  const stacks = state.stacks.some(item => item.id === saved.id)
    ? state.stacks.map(item => item.id === saved.id ? saved : item) : [...state.stacks, saved];
  update({ stacks, loading: false, loaded: true, error: "", deletedIds: state.deletedIds.filter(id => id !== saved.id) });
  invalidateKnowledgeReads();
  return saved;
}

export async function deleteTechnologyStack(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
  revision++;
  update({ ...state, stacks: state.stacks.filter(item => item.id !== id),
    deletedIds: [...new Set([...state.deletedIds, id])], loading: false, error: "" });
  invalidateKnowledgeReads();
}

export function technologyStackLabel(id: string, stacks: readonly TechnologyStack[] = state.stacks): string {
  return id === "agnostic" ? "通用 / 技术栈无关" : stacks.find(item => item.id === id)?.name ?? id;
}

export function technologyStackSnapshot(): CatalogState { return state; }
