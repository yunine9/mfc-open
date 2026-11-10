import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { DeliveryAnalytics } from "./DeliveryAnalytics";
import { Button } from "@/components/ui/button";
import { createTaskDemoDeliveryRead, DEMO_DELIVERY_MAIN_TASK, DEMO_DELIVERY_TASK_IDS } from "./taskDemoDeliveryPreviewData";

const knownTask = (id: string | null) => id && (DEMO_DELIVERY_TASK_IDS as readonly string[]).includes(id) ? id : DEMO_DELIVERY_MAIN_TASK;
function taskDemoUrl(taskId: string) {
  const url = new URL("/", location.origin);
  url.searchParams.set("taskDemoPreview", "1");
  url.searchParams.set("taskDemoTask", knownTask(taskId));
  url.searchParams.set("taskDemoPhase", "已合入");
  url.searchParams.set("theme", document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  return url.href;
}

/** 与正式页复用同一个分析组件，传输仅连接本地虚构样例。 */
export default function TaskDemoDeliveryPreview() {
  const [ready, setReady] = useState(false);
  const [returning, setReturning] = useState(false);
  const returnCleanup = useRef<() => void>(() => {});
  const sourceTask = knownTask(new URLSearchParams(location.search).get("deliveryTask"));
  useEffect(() => () => returnCleanup.current(), []);
  function returnToDemo() {
    const fallback = () => location.assign(taskDemoUrl(sourceTask));
    const copyId = new URLSearchParams(location.search).get("taskDemoCopy");
    if (!copyId || typeof BroadcastChannel === "undefined") { fallback(); return; }
    setReturning(true);
    const channel = new BroadcastChannel("mae-flow-demo-return");
    const requestId = crypto.randomUUID();
    const timer = window.setTimeout(() => { cleanup(); fallback(); }, 600);
    const cleanup = () => { window.clearTimeout(timer); channel.close(); };
    returnCleanup.current = cleanup;
    channel.onmessage = ({ data }) => {
      if (data?.type !== "demo-returned" || data.requestId !== requestId) return;
      cleanup();
      window.close();
      // 浏览器禁止关闭标签时仍有可用的返回路径。
      const fallbackTimer = window.setTimeout(fallback, 150);
      returnCleanup.current = () => window.clearTimeout(fallbackTimer);
    };
    channel.postMessage({ type: "return-to-demo", copyId, requestId });
  }
  useEffect(() => {
    const originalFetch = window.fetch;
    const read = createTaskDemoDeliveryRead(location.origin);
    window.fetch = read;
    const onLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link) return;
      const url = new URL(link.href, location.href);
      const task = url.origin === location.origin ? /^\/work\/([^/]+)\/?$/.exec(url.pathname) : null;
      if (task) {
        event.preventDefault();
        location.assign(taskDemoUrl(decodeURIComponent(task[1])));
      }
    };
    document.addEventListener("click", onLink, true);
    setReady(true);
    return () => {
      document.removeEventListener("click", onLink, true);
      window.fetch = originalFetch;
    };
  }, []);

  return <main className="h-screen overflow-y-auto bg-background px-8 pb-8 text-foreground" data-demo-delivery-analysis="true">
    <header className="sticky top-0 z-10 mb-7 flex items-center justify-between gap-6 border-b border-line bg-background py-4">
      <Button variant="outline" disabled={returning} onClick={returnToDemo}><ArrowLeft />{returning ? "正在返回…" : "返回任务演示"}</Button>
      <div className="flex items-center gap-3 text-sm text-muted-foreground"><strong className="rounded-full bg-attention-soft px-3 py-1 text-attention">演示数据</strong><span>比例与用量均为样例，不代表实际交付效果</span></div>
    </header>
    {ready ? <DeliveryAnalytics onOpenTask={id => location.assign(taskDemoUrl(id))} /> : <p>正在准备交付分析演示…</p>}
  </main>;
}
