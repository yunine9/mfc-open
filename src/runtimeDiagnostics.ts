import { Session } from "node:inspector/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, readdirSync } from "node:fs";

type Log = (message: string) => void;

export function sanitizeBrowserTimings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap(row => {
    if (!row || !["resource", "navigation", "longtask"].includes(row.kind)) return [];
    const out: Record<string, string | number> = { kind: row.kind };
    if (["artifacts", "task", "issue", "domain", "knowledge", "static", "other"].includes(row.area)) out.area = row.area;
    for (const key of ["start_ms", "duration_ms", "first_byte_ms", "body_ms"]) {
      if (typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= (key === "start_ms" ? 1e15 : 600_000)) out[key] = row[key];
    }
    return typeof out.duration_ms === "number" ? [out] : [];
  });
}

const requests = new Map<string, { route: string; method: string; started: number }>();
export function pendingHttpRequests() {
  return [...requests].sort((a, b) => a[1].started - b[1].started).slice(0, 12)
    .map(([id, entry]) => ({ id, route: entry.route, method: entry.method,
      elapsed_ms: Math.round(performance.now() - entry.started) }));
}

/** 不记查询参数、文件名、账号或正文；只留路由类别。SSE 只统计建立响应的耗时。 */
export function traceHttpRequest(request: IncomingMessage, response: ServerResponse, log: Log = () => {}, layer = "runtime") {
  const parts = String(request.url ?? "/").split("?")[0].split("/").filter(Boolean);
  const route = "/" + parts.slice(0, 3).map((part, i) => i === 0 || /^[a-z][a-z-]+$/.test(part) ? part : ":id").join("/");
  const id = randomUUID().slice(0, 8); const started = performance.now();
  if (requests.size < 1000) requests.set(id, { route, method: request.method ?? "GET", started });
  let firstByte: number | undefined; let completed = false;
  const writeHead = response.writeHead;
  response.writeHead = function (this: ServerResponse, ...args: any[]) {
    if (firstByte === undefined) {
      firstByte = performance.now() - started;
      if (String(args[1]?.["content-type"] ?? args[2]?.["content-type"] ?? response.getHeader("content-type") ?? "").includes("text/event-stream")) finish("stream_open");
    }
    return writeHead.apply(this, args as any);
  } as typeof response.writeHead;
  const finish = (event: string) => {
    if (completed) return;
    completed = true; requests.delete(id);
    const elapsed = performance.now() - started;
    if (elapsed >= 500 || route === "/settings/check") log(`[http-timing] ${JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
      layer, id, route, method: request.method, event, status: response.statusCode, headers_sent: response.headersSent,
      elapsed_ms: Math.round(elapsed), first_byte_ms: firstByte === undefined ? undefined : Math.round(firstByte) })}`);
  };
  response.once("finish", () => finish("finish")); response.once("close", () => finish("close"));
}

/** 只记录执行阶段和时长，不记录配置、请求正文或工具参数。 */
export class SystemCheckTrace {
  readonly id = randomUUID().slice(0, 8);
  private started = performance.now();
  private phases = new Map<string, { started: number; elapsed_ms?: number; outcome?: string }>();
  constructor(private log: Log = () => {}) { this.note("start"); }
  private note(event: string, extra = {}) {
    this.log(`[system-check] ${JSON.stringify({ id: this.id, event, ...extra })}`);
  }
  async phase<T>(name: string, action: () => Promise<T>): Promise<T> {
    const phase = { started: performance.now(), outcome: "pending", elapsed_ms: undefined as number | undefined };
    this.phases.set(name, phase);
    this.note("phase_start", { phase: name });
    try { const result = await action(); phase.outcome = "returned"; return result; }
    catch (error) { phase.outcome = "threw"; throw error; }
    finally {
      phase.elapsed_ms = Math.round(performance.now() - phase.started);
      this.note("phase_end", { phase: name, elapsed_ms: phase.elapsed_ms, outcome: phase.outcome });
    }
  }
  snapshot() {
    return { id: this.id, elapsed_ms: Math.round(performance.now() - this.started),
      phases: [...this.phases].map(([name, value]) => ({ phase: name,
        elapsed_ms: value.elapsed_ms ?? Math.round(performance.now() - value.started), outcome: value.outcome })) };
  }
  finish(result?: unknown) { this.note("finish", { ...this.snapshot(), ...(result ? { result } : {}) }); }
}

/** 把 CPU 采样压成日志中的调用位置和调用者，不输出堆、局部变量或业务文本。 */
export function summarizeCpuProfile(profile: { nodes: any[]; samples?: number[]; timeDeltas?: number[] }) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const weights = new Map<number, number>();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples![i]; weights.set(id, (weights.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 1));
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const location = (id: number) => {
    const frame = nodes.get(id)?.callFrame ?? {};
    const url = String(frame.url ?? "").split(/[?#]/)[0].replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
    const knownPath = url.match(/(?:^|\/)(src|node_modules|kernel)\/(.+)/);
    const file = knownPath ? `${knownPath[1]}/${knownPath[2]}`.split("/").slice(-5).join("/") : url.split("/").at(-1);
    return `${frame.functionName || "(anonymous)"}${file ? ` ${file}:${(frame.lineNumber ?? 0) + 1}` : ""}`;
  };
  return [...weights].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([id, weight]) => {
    const callers: string[] = []; let parent = parents.get(id);
    while (parent !== undefined && callers.length < 5) { callers.push(location(parent)); parent = parents.get(parent); }
    return { at: location(id), sample_percent: total ? Math.round(weight / total * 10_000) / 100 : 0, callers };
  });
}

/** 启动后三分钟自动取证；10ms CPU 采样，30 秒输出一次热点，5 秒输出资源状态。
 * 限时结束后释放 profiler、计时器和延迟监测；失败只记日志，不影响服务启动。 */
export async function startStartupDiagnostics(log: Log, snapshot: () => unknown,
  options: { durationMs?: number; sampleMs?: number; profileMs?: number } = {}) {
  const durationMs = options.durationMs ?? 180_000;
  const sampleMs = options.sampleMs ?? 5_000;
  const profileMs = options.profileMs ?? 30_000;
  const session = new Session();
  const delay = monitorEventLoopDelay({ resolution: 20 }); delay.enable();
  let cpu = process.cpuUsage(); let elu = performance.eventLoopUtilization(); let sampled = performance.now();
  let stopped = false; let profiling = false; let rotating: Promise<void> = Promise.resolve();
  const emit = (event: string, extra: object) => log(`[runtime-diagnostics] ${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...extra })}`);
  const read = (path: string) => { try { return readFileSync(path, "utf8").trim().slice(0, 1024); } catch { return undefined; } };
  const threads = () => {
    if (process.platform !== "linux") return undefined;
    try { return readdirSync("/proc/self/task").slice(0, 64).flatMap(tid => {
      const stat = read(`/proc/self/task/${tid}/stat`); if (!stat) return [];
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      return [{ tid: Number(tid), state: fields[0], user_ticks: Number(fields[11]), system_ticks: Number(fields[12]),
        wait: read(`/proc/self/task/${tid}/wchan`) }];
    }); } catch { return undefined; }
  };
  const sample = () => {
    const now = performance.now(); const spent = process.cpuUsage(cpu); cpu = process.cpuUsage();
    const nextElu = performance.eventLoopUtilization(); const used = performance.eventLoopUtilization(nextElu, elu); elu = nextElu;
    const memory = process.memoryUsage();
    emit("sample", { window_ms: Math.round(now - sampled),
      cpu_percent: Math.round((spent.user + spent.system) / Math.max(1, now - sampled) / 10),
      event_loop_utilization: Math.round(used.utilization * 1000) / 1000,
      event_loop_delay_max_ms: Math.round(delay.max / 1e6), event_loop_delay_p99_ms: Math.round(delay.percentile(99) / 1e6),
      rss_mb: Math.round(memory.rss / 1024 ** 2), heap_mb: Math.round(memory.heapUsed / 1024 ** 2),
      threads: threads(), state: snapshot() });
    sampled = now; delay.reset();
  };
  emit("start", { node: process.version, duration_ms: durationMs, cpu_sample_interval_us: 10_000,
    cpu_limit: read("/sys/fs/cgroup/cpu.max"), memory_limit: read("/sys/fs/cgroup/memory.max") });
  try {
    session.connect(); await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 10_000 });
    await session.post("Profiler.start"); profiling = true;
  } catch { emit("cpu_profile_unavailable", {}); session.disconnect(); }
  const rotate = () => {
    rotating = rotating.then(async () => {
      if (!profiling) return;
      try {
        const { profile } = await session.post("Profiler.stop"); profiling = false;
        emit("cpu_profile", { window_ms: Math.round((profile.endTime - profile.startTime) / 1000), hotspots: summarizeCpuProfile(profile) });
        if (!stopped) { await session.post("Profiler.start"); profiling = true; }
      } catch { profiling = false; emit("cpu_profile_unavailable", {}); }
    });
    return rotating;
  };
  const sampleTimer = setInterval(sample, sampleMs); sampleTimer.unref();
  const profileTimer = setInterval(() => void rotate(), profileMs); profileTimer.unref();
  const stop = async () => {
    if (stopped) return rotating;
    stopped = true; clearInterval(sampleTimer); clearInterval(profileTimer); clearTimeout(stopTimer);
    sample(); await rotate(); session.disconnect(); delay.disable(); emit("stop", {});
  };
  const stopTimer = setTimeout(() => void stop(), durationMs); stopTimer.unref();
  return stop;
}
