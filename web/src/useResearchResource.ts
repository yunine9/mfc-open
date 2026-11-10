import { useEffect, useState } from "react";
import { componentRequest } from "./componentResearchApi";

/** 按当前任务与条目读取，切换后忽略迟到结果。 */
export function useResearchResource<T>(url?: string, revision?: unknown, poll = false) {
  const [state, setState] = useState<{ url?: string; value?: T; error?: string }>({});
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let live = true, loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const value = await componentRequest<T>(url, undefined, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
        if (live) setState({ url, value });
      } catch (error) { if (live) setState({ url, error: (error as Error).message }); }
      finally { loading = false; }
    };
    void load();
    const timer = poll ? setInterval(() => void load(), 4000) : undefined;
    return () => { live = false; controller.abort(); clearInterval(timer); };
  }, [url, revision, poll]);
  return state.url === url ? state : {};
}
