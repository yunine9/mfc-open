import { useEffect, useSyncExternalStore } from "react";
import { loadTechnologyStacks, subscribeTechnologyStacks, technologyStackSnapshot } from "./technologyStacks";

export function useTechnologyStacks() {
  const snapshot = useSyncExternalStore(subscribeTechnologyStacks, technologyStackSnapshot, technologyStackSnapshot);
  useEffect(() => {
    void loadTechnologyStacks().catch(() => {});
    const refresh = () => { void loadTechnologyStacks(true).catch(() => {}); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return { ...snapshot, reload: () => loadTechnologyStacks(true) };
}
