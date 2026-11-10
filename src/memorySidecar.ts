/**
 * 任务记忆检索旁路进程的宿主侧客户端(docs/knowledge-memory-design.md §7)。
 *
 * memsearch 是 Python,模型加载要几秒,所以常驻一个子进程,stdio 一行一个
 * JSON。这里只做三件事:拉起/重拉、按 id 配对请求、每次调用带预算。
 *
 * 纪律(红线"agent 不能因 harness 卡死"):
 * - 每个请求都有超时,超时返回 undefined,调用方按"检索暂不可用"处理;
 *   绝不让 Agent 或页面等一个不会回来的应答。
 * - 进程死了自动重拉,带退避和次数上限;拉不起来就 unavailable,任务照跑。
 * - 检索是索引不是正本:这里任何失败都不影响 corpus/ 里的 md。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface MemorySidecarOptions {
  /** venv 里的 python(部署包装脚本已带 HF_HOME/OFFLINE/TMPDIR)。 */
  python: string;
  script: string;
  corpusDir: string;
  milvusPath: string;
  provider?: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** 测试用:替换 spawn。 */
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv)
    => ChildProcessWithoutNullStreams;
  budgets?: Partial<MemorySidecarBudgets>;
}

export interface MemorySidecarBudgets {
  healthMs: number;
  ingestMs: number;
  searchMs: number;
  expandMs: number;
  /** 起进程到 ready 的预算:模型加载内网实测 2.8s,给 60s 兜冷盘。 */
  bootMs: number;
}

export const DEFAULT_MEMORY_BUDGETS: MemorySidecarBudgets = {
  healthMs: 500, ingestMs: 5_000, searchMs: 3_000, expandMs: 1_000, bootMs: 60_000,
};

export interface MemorySearchHit {
  id: string;
  score: number;
  semantic_score?: number;
  heading?: string;
  start_line?: number;
  end_line?: number;
  snippet?: string;
  file?: string;
  repo?: string;
  judged_by?: "human" | "pipeline" | "agent";
  source?: string;
  scope?: string;
  at?: string;
  task?: string;
  paths?: string[];
  line?: number;
  phase?: string;
}

export type MemorySearchResults = MemorySearchHit[] & { pendingSources?: number };

type Pending = {
  resolve: (value: Record<string, unknown> | undefined) => void;
  timer: NodeJS.Timeout;
};

const MAX_RESTARTS = 5;

export class MemorySidecar {
  private child?: ChildProcessWithoutNullStreams;
  private ready = false;
  private booting?: Promise<boolean>;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private restarts = 0;
  private retryAt = 0;
  private readonly failedChildren = new WeakSet<ChildProcessWithoutNullStreams>();
  private readonly terminating = new WeakSet<ChildProcessWithoutNullStreams>();
  private stopped = false;
  private sectionCounts = new Map<string, number>();
  indexedSections(path: string): number | undefined { return this.sectionCounts.get(path); }
  private readonly budgets: MemorySidecarBudgets;

  constructor(private readonly options: MemorySidecarOptions) {
    this.budgets = { ...DEFAULT_MEMORY_BUDGETS, ...(options.budgets ?? {}) };
  }

  get searchBudgetMs(): number { return this.budgets.searchMs; }

  get available(): boolean {
    return this.ready && !!this.child && !this.stopped;
  }

  /** 拉起并等 ready。重复调用共用一个 boot;失败返回 false 不抛。 */
  start(): Promise<boolean> {
    if (this.available) return Promise.resolve(true);
    if (this.booting) return this.booting;
    if (this.stopped || this.restarts >= MAX_RESTARTS || Date.now() < this.retryAt
      || (this.child && this.terminating.has(this.child))) return Promise.resolve(false);
    this.booting = this.boot().finally(() => { this.booting = undefined; });
    return this.booting;
  }

  private async boot(): Promise<boolean> {
    const { options } = this;
    const args = [
      options.script, "--corpus", options.corpusDir, "--milvus", options.milvusPath,
      ...(options.provider ? ["--provider", options.provider] : []),
      ...(options.model ? ["--model", options.model] : []),
    ];
    const env = { ...process.env, ...(options.env ?? {}) };
    // Milvus Lite uses local gRPC. Desktop proxy settings must not route that
    // connection outside the machine; preserve all existing bypass entries.
    const noProxy = [...new Set([env.NO_PROXY ?? "", env.no_proxy ?? "", "localhost,127.0.0.1,::1"]
      .flatMap(value => value.split(",")).map(value => value.trim()).filter(Boolean))].join(",");
    env.NO_PROXY = env.no_proxy = noProxy;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = options.spawnProcess
        ? options.spawnProcess(options.python, args, env)
        : spawn(options.python, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch (error) {
      options.log?.(`记忆检索旁路拉不起来: ${String(error)}`);
      this.recordFailure();
      return false;
    }
    this.child = child;
    this.ready = false;
    const readyPromise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), this.budgets.bootMs);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;                         // 非协议行(依赖库偶尔往 stdout 吐)只丢它自己
        }
        if (message.id === 0) {
          if (this.child !== child || this.stopped || this.terminating.has(child)) return;
          if (message.ready === true) {
            clearTimeout(timer);
            this.ready = true;
            resolve(true);
          } else if (message.error) {
            options.log?.(`记忆检索旁路启动失败: ${String(message.error)}`);
            clearTimeout(timer);
            resolve(false);
          }
          return;
        }
        const id = Number(message.id);
        const waiter = this.pending.get(id);
        if (!waiter) return;
        this.pending.delete(id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      });
      const diagnostics = createInterface({ input: child.stderr });
      diagnostics.on("line", (line) => {
        // 一次 data 可以带多条日志；按行保留资源指标，避免截掉后续请求。
        const text = line.trim();
        if (text) options.log?.(`[memsearch-sidecar] ${text.slice(0, 1024)}`);
      });
      child.on("error", (error) => {
        options.log?.(`记忆检索旁路进程错误: ${String(error)}`);
        clearTimeout(timer);
        this.failChild(child);
        resolve(false);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        this.onExit(child, code, signal);
        resolve(false);
      });
      child.on("close", (code, signal) => {
        // spawn 失败可能只有 error/close，没有 exit。
        clearTimeout(timer);
        this.onExit(child, code, signal);
        resolve(false);
      });
    });
    const ok = await readyPromise;
    if (!ok) {
      this.failChild(child);
    }
    return ok;
  }

  private recordFailure(): void {
    this.restarts += 1;
    this.retryAt = Date.now() + Math.min(100 * 2 ** (this.restarts - 1), 30_000);
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    // 独立进程组也包含旧版 Milvus 的子进程，不能只留下退出的 Python。
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch { /* 测试或 Windows 使用单进程 */ }
    }
    try { child.kill(signal); } catch { /* 已退出 */ }
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (this.terminating.has(child)) return;
    this.terminating.add(child);
    child.once("exit", () => this.signalChild(child, "SIGKILL"));
    this.signalChild(child, "SIGTERM");
    const timer = setTimeout(() => this.signalChild(child, "SIGKILL"), 1000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }

  private failChild(child: ChildProcessWithoutNullStreams): void {
    if (!this.failedChildren.has(child) && !this.stopped) {
      this.failedChildren.add(child);
      this.recordFailure();
    }
    if (this.child === child) {
      this.ready = false;
      this.finishPending();
      this.terminateChild(child);
    }
  }

  private onExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.child !== child) return;
    this.signalChild(child, "SIGKILL");
    this.failChild(child);
    this.child = undefined;
    this.ready = false;
    this.finishPending();
    if (this.stopped) return;
    this.options.log?.(
      `记忆检索旁路退出(code=${code ?? "-"} signal=${signal ?? "-"}),`
      + (this.restarts < MAX_RESTARTS ? `退避后按需重拉(失败 ${this.restarts}/${MAX_RESTARTS})` : "重拉次数用尽,检索停用"));
  }

  private finishPending(): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.resolve(undefined);
      this.pending.delete(id);
    }
  }

  private async request(
    payload: Record<string, unknown>,
    budgetMs: number,
  ): Promise<Record<string, unknown> | undefined> {
    if (!(await this.start())) return undefined;
    const child = this.child;
    if (!child) return undefined;
    if (this.pending.size >= 128) {
      this.options.log?.(`记忆检索队列繁忙，${String(payload.op)} 未入队`);
      return undefined;
    }
    const id = this.nextId++;
    const sentAt = Date.now();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.options.log?.(`记忆检索 id=${id} ${String(payload.op)} 超预算 ${budgetMs}ms,按不可用处理`);
        resolve(undefined);
      }, budgetMs);
      this.pending.set(id, { resolve, timer });
      try {
        child.stdin.write(JSON.stringify({ id, ...payload, sent_at_ms: sentAt, deadline_ms: sentAt + budgetMs }) + "\n");
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.options.log?.(`记忆检索写入失败: ${String(error)}`);
        resolve(undefined);
      }
    });
  }

  async health(): Promise<boolean> {
    const reply = await this.request({ op: "health" }, this.budgets.healthMs);
    return reply?.ok === true;
  }

  /** 单条入库;失败只记日志——正本已经在 md 里,索引晚点重建也不丢。 */
  async ingest(path: string, budgetMs = this.budgets.ingestMs): Promise<boolean> {
    const reply = await this.request({ op: "ingest", path }, budgetMs);
    if (reply?.ok && typeof reply.sections === "number") this.sectionCounts.set(path, reply.sections);
    if (reply?.error) this.options.log?.(`记忆索引失败 ${path}: ${String(reply.error)}`);
    return reply?.ok === true;
  }

  async reindex(): Promise<number | undefined> {
    const reply = await this.request({ op: "reindex" }, this.budgets.bootMs);
    return reply?.ok === true ? Number(reply.chunks ?? 0) : undefined;
  }

  /** 删除指定来源的全部索引块；只有旁路确认成功才返回 true。 */
  async remove(path: string): Promise<boolean> {
    this.sectionCounts.delete(path);
    const reply = await this.request({ op: "remove", path }, this.budgets.ingestMs);
    if (reply?.error) this.options.log?.(`知识索引删除失败：${String(reply.error)}`);
    return reply?.ok === true;
  }

  async search(input: {
    query: string; repo: string; pathPrefix?: string; limit?: number;
    sources?: Array<{ id: string; path: string }>;
  }): Promise<MemorySearchResults | undefined> {
    const reply = await this.request({
      op: "search", query: input.query, repo: input.repo,
      ...(input.sources ? { sources: input.sources } : {}),
      path_prefix: input.pathPrefix ?? "", limit: Math.min(input.limit ?? 8, 20),
    }, this.budgets.searchMs);
    if (reply?.error) this.options.log?.(`知识检索查询失败：${String(reply.error).slice(0, 400)}`);
    if (!reply || reply.error || !Array.isArray(reply.hits)) return undefined;
    const hits: MemorySearchResults = (reply.hits as MemorySearchHit[]).filter((hit) => typeof hit.id === "string");
    if (typeof reply.pending_sources === "number" && reply.pending_sources > 0) {
      hits.pendingSources = reply.pending_sources;
    }
    return hits;
  }

  async expand(memoryId: string): Promise<string | undefined> {
    const reply = await this.request(
      { op: "expand", memory_id: memoryId }, this.budgets.expandMs);
    return reply?.ok === true && typeof reply.content === "string"
      ? reply.content : undefined;
  }

  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = undefined;
    this.ready = false;
    this.finishPending();
    if (child) {
      try { child.stdin.end(); } catch { /* 已死 */ }
      this.terminateChild(child);
    }
  }
}
