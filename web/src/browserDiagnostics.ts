/** 页面打开后的三分钟自动采集耗时。只发送数字和固定分类，不发送 URL、内容或身份。 */
export function startBrowserDiagnostics() {
  if (typeof PerformanceObserver === "undefined") return;
  const rows: Array<Record<string, string | number>> = [];
  const observers: PerformanceObserver[] = [];
  const record = (entry: PerformanceEntry) => {
    if (entry.duration < (entry.entryType === "longtask" ? 200 : 500)) return;
    if (rows.length >= 60) return;
    const row: Record<string, string | number> = { kind: entry.entryType,
      start_ms: Math.round(performance.timeOrigin + entry.startTime), duration_ms: Math.round(entry.duration) };
    if (entry.entryType === "resource" || entry.entryType === "navigation") {
      const resource = entry as PerformanceResourceTiming;
      let url: URL; try { url = new URL(entry.name, location.href); } catch { return; }
      if (url.origin !== location.origin || url.pathname === "/browser-timing") return;
      row.area = url.pathname.includes("/artifacts") ? "artifacts"
        : url.pathname.startsWith("/tasks/") ? "task"
        : url.pathname.startsWith("/issues/") ? "issue"
        : url.pathname.startsWith("/domain-extraction") ? "domain"
        : url.pathname.startsWith("/knowledge-documents") ? "knowledge"
        : url.pathname.startsWith("/assets/") ? "static" : "other";
      row.first_byte_ms = Math.max(0, Math.round(resource.responseStart - entry.startTime));
      row.body_ms = Math.max(0, Math.round(resource.responseEnd - resource.responseStart));
    }
    rows.push(row);
  };
  for (const type of ["resource", "navigation", "longtask"]) {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) continue;
    const observer = new PerformanceObserver(list => list.getEntries().forEach(record));
    observer.observe({ type, buffered: true }); observers.push(observer);
  }
  const flush = () => {
    if (!rows.length) return;
    void fetch("/browser-timing", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries: rows.splice(0, 20) }), keepalive: true }).catch(() => {});
  };
  const timer = setInterval(flush, 10_000);
  setTimeout(() => { clearInterval(timer); observers.forEach(observer => observer.disconnect()); flush(); rows.length = 0; }, 180_000);
}
