/**
 * PostgreSQL 投影(主 spec §11):看板展示、审计与恢复引导的读侧。
 *
 * 三条红线(设计文档原文,双状态机的学费不交第二次):
 * - 阶段真相只在工作区 `.mae-flow.json`。这里保存的是任务摘要投影、
 *   追加式事件日志副本与关键外部动作台账——永远是投影,不是第二个状态机;
 *   两者不一致时以工作区现场文件为准。
 * - 投影失败不改流程:所有写入 fail-open——失败记日志、流程照走。
 *   台账丢一页可以重放补齐,任务因为数据库抖动而失败是本末倒置。
 * - 恢复流程负责重放:重放源是现场文件(task.json / events.jsonl),
 *   幂等锚沿用事件日志的 (taskId, eventId),重灌是 no-op。
 *
 * 外部动作台账(§10/§11):MR 创建、流水线触发按幂等键落一行,
 * 带请求摘要、结果摘要、绑定代码版本与起止时间——恢复时"先查远端
 * 真实状态再决定是否继续"的查询底账。
 */

import pg from "pg";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";
import type { TaskSummary } from "./taskService.ts";
import type { SemanticEvent } from "./semanticEvents.ts";

/** 历史条目 = 任务摘要投影 + 只有历史侧才有的两个字段:
 * 事件量(联查带出)与最近更新时间(排序依据,页面说人话用)。 */
export type TaskHistoryEntry = TaskSummary & {
  event_count: number;
  updated_at: string;
};

export interface ExternalAction {
  taskId: string;
  /** 幂等键:同任务同键只落一行(如 mr:feat->master、pipeline:<sha>)。 */
  idemKey: string;
  kind: "mr_create" | "pipeline_trigger" | "review_reply";
  request: Record<string, unknown>;
  result?: Record<string, unknown>;
  /** 绑定的代码版本:结果只为这个 SHA 背书(旧绿灯不背书新代码)。 */
  sha?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface ProjectionDeleteResult {
  found: boolean;
  deleted: boolean;
  status?: string;
}

export interface ProjectionTaskIdentity {
  found: boolean;
  status?: string;
  luban_account?: string;
}

const SCHEMA = `
create table if not exists tasks (
  task_id       text primary key,
  title         text,
  requirement   text not null,
  status        text not null,
  detail        text,
  luban_account text,
  workspace     text not null,
  created_at    timestamptz not null,
  last_progress_at timestamptz,
  completed_at  timestamptz,
  parent_task_id text,
  waiting       jsonb,
  delivery      jsonb,
  updated_at    timestamptz not null default now()
);
alter table tasks add column if not exists title text;
alter table tasks add column if not exists last_progress_at timestamptz;
alter table tasks add column if not exists completed_at timestamptz;
alter table tasks add column if not exists parent_task_id text;
create table if not exists task_events (
  task_id    text not null,
  event_id   bigint not null,
  session_id text not null,
  ts         text not null,
  kind       text not null,
  payload    jsonb not null,
  primary key (task_id, event_id)
);
create table if not exists external_actions (
  task_id     text not null,
  idem_key    text not null,
  kind        text not null,
  request     jsonb not null,
  result      jsonb,
  sha         text,
  started_at  timestamptz not null,
  finished_at timestamptz,
  primary key (task_id, idem_key)
);
`;

export class PgProjection {
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;
  private replayTail: Promise<void> = Promise.resolve();
  private replayPending = 0;
  private replayActive?: string;
  private replays = new Map<string, { cancelled: boolean; running: boolean; done: Promise<void> }>();
  private closing = false;
  /** 最近一次写失败的原因:页面/测试观测用,流程从不读它。 */
  lastError?: string;

  constructor(
    private connectionString: string,
    private log?: (message: string) => void,
  ) {
    this.pool = new pg.Pool({ connectionString, max: 4,
      connectionTimeoutMillis: 5_000, query_timeout: 10_000, statement_timeout: 10_000 });
    // 空闲连接的后台错误(数据库重启等)不许变成进程级 unhandled error。
    this.pool.on("error", (error) => this.fail("pool", error));
  }

  /** 建表幂等,首次写入前保证一次;失败进入 fail-open 常规路径。 */
  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = this.pool.query(SCHEMA).then(() => undefined)
      .catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  private fail(operation: string, error: unknown): void {
    this.lastError = `${operation}: ${String(error)}`;
    this.log?.(`[projection] 投影写入失败(${this.lastError}),流程不受影响`);
  }

  /** 任务摘要投影:落盘点与 task.json 相同(persist 时机),整行覆盖。 */
  async upsertTask(summary: TaskSummary): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `insert into tasks (task_id, title, requirement, status, detail,
           luban_account, workspace, created_at, last_progress_at,
           completed_at, waiting, delivery, parent_task_id, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         on conflict (task_id) do update set
           title = excluded.title, status = excluded.status,
           detail = excluded.detail,
           waiting = excluded.waiting, delivery = excluded.delivery,
           luban_account = excluded.luban_account,
           last_progress_at = excluded.last_progress_at,
           completed_at = excluded.completed_at,
           parent_task_id = excluded.parent_task_id, updated_at = now()`,
        [
          summary.id, summary.title ?? null, summary.requirement, summary.status,
          summary.detail ?? null, summary.luban_account ?? null,
          summary.workspace, summary.created_at,
          summary.last_progress_at ?? summary.created_at,
          summary.completed_at ?? null,
          summary.waiting ? JSON.stringify(summary.waiting) : null,
          summary.delivery ? JSON.stringify(summary.delivery) : null,
          summary.parent_task_id ?? null,
        ]);
    } catch (error) {
      this.fail(`upsertTask ${summary.id}`, error);
    }
  }

  /** 事件副本:幂等锚 (taskId, eventId),重放冲突即 no-op。 */
  async appendEvent(event: SemanticEvent): Promise<void> {
    try {
      await this.writeEvent(event);
    } catch (error) {
      this.fail(`appendEvent ${event.taskId}#${event.eventId}`, error);
    }
  }

  private async writeEvent(event: SemanticEvent): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
        `insert into task_events (task_id, event_id, session_id, ts, kind, payload)
         values ($1,$2,$3,$4,$5,$6)
         on conflict (task_id, event_id) do nothing`,
        [
          event.taskId, event.eventId, event.sessionId,
          event.ts, event.kind, JSON.stringify(event.payload),
        ]);
  }

  /** 历史日志按文件、按事件逐条补齐，不把全部历史压进连接池等待队列。
   * 实时事件仍直接写入，重复记录由原有主键去重。只读源文件，失败留待下次补齐。 */
  replayEvents(taskId: string, path: string): Promise<void> {
    const existing = this.replays.get(taskId);
    if (existing) return existing.done;
    const replay = { cancelled: false, running: false, done: Promise.resolve() };
    this.replayPending++;
    this.replayTail = this.replayTail.then(async () => {
      this.replayPending--;
      if (this.closing || replay.cancelled) return;
      replay.running = true;
      await setImmediate();
      this.replayActive = taskId;
      const stream = createReadStream(path, { encoding: "utf8" });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (this.closing || replay.cancelled) break;
          if (!line.trim()) continue;
          const event = JSON.parse(line) as SemanticEvent;
          if (event.taskId !== taskId) throw new Error("历史事件的任务编号不匹配");
          await this.writeEvent(event);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.fail(`replay ${taskId}`, error);
      } finally {
        lines.close(); stream.destroy(); this.replayActive = undefined;
      }
    }).finally(() => { this.replays.delete(taskId); });
    replay.done = this.replayTail;
    this.replays.set(taskId, replay);
    return this.replayTail;
  }

  diagnostics() {
    return { connections: this.pool.totalCount, idle: this.pool.idleCount,
      waiting: this.pool.waitingCount, replay_pending: this.replayPending,
      replay_active: this.replayActive, schema_started: this.ready !== null };
  }

  /** 外部动作台账:同幂等键重复登记只更新结果侧,请求侧保留首次。 */
  async recordAction(action: ExternalAction): Promise<void> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `insert into external_actions
           (task_id, idem_key, kind, request, result, sha, started_at, finished_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (task_id, idem_key) do update set
           result = excluded.result, finished_at = excluded.finished_at`,
        [
          action.taskId, action.idemKey, action.kind,
          JSON.stringify(action.request),
          action.result ? JSON.stringify(action.result) : null,
          action.sha ?? null, action.startedAt, action.finishedAt ?? null,
        ]);
    } catch (error) {
      this.fail(`recordAction ${action.taskId}/${action.idemKey}`, error);
    }
  }

  /** 历史读侧:任务摘要投影(按最近更新倒序)。内存列表只有本进程
   * recover 到的任务;数据目录清理或换机后,历史只活在这里——
   * 看板/审计的跨生命周期入口。读失败抛错,纪律同 listActions。
   * 事件量随行带出:一条 left join 分组联查,不做 N+1。 */
  async listTaskHistory(limit = 100): Promise<TaskHistoryEntry[]> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      `select t.task_id, t.title, t.requirement, t.status, t.detail,
              t.luban_account, t.workspace, t.created_at, t.updated_at,
              t.last_progress_at, t.completed_at,
              t.waiting, t.delivery, t.parent_task_id, coalesce(e.n, 0) as event_count
         from tasks t
         left join (select task_id, count(*)::int as n
                      from task_events group by task_id) e
           on e.task_id = t.task_id
        order by t.updated_at desc limit $1`,
      [limit]);
    return rows.rows.map((row) => ({
      id: row.task_id,
      title: row.title ?? undefined,
      requirement: row.requirement,
      status: row.status,
      detail: row.detail ?? undefined,
      luban_account: row.luban_account ?? undefined,
      workspace: row.workspace,
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
      last_progress_at: row.last_progress_at
        ? new Date(row.last_progress_at).toISOString() : undefined,
      completed_at: row.completed_at
        ? new Date(row.completed_at).toISOString() : undefined,
      waiting: row.waiting ?? undefined,
      delivery: row.delivery ?? undefined,
      parent_task_id: row.parent_task_id ?? undefined,
      event_count: row.event_count,
    }));
  }

  /** 删除授权不能只依赖本机工作区：现场回收或换机后，任务可能只剩
   * PostgreSQL 历史。这里仅返回裁权所需的最小身份，不展开任务内容。 */
  async taskIdentity(taskId: string): Promise<ProjectionTaskIdentity> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      "select status, luban_account from tasks where task_id = $1",
      [taskId],
    );
    if (!rows.rowCount) return { found: false };
    return {
      found: true,
      status: String(rows.rows[0].status),
      luban_account: rows.rows[0].luban_account
        ? String(rows.rows[0].luban_account) : undefined,
    };
  }

  /** 历史条目的事件量指标:该任务的事件副本行数。读失败抛错。 */
  async countEvents(taskId: string): Promise<number> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      "select count(*)::int as n from task_events where task_id = $1",
      [taskId]);
    return rows.rows[0].n;
  }

  /** 审计读侧:某任务的外部动作台账(按开始时间正序)。
   * 读失败抛给调用方——审计查询失败必须可见,不适用写侧的 fail-open
   * (写丢一页可重放,读装没事就是骗人)。 */
  async listActions(taskId: string): Promise<ExternalAction[]> {
    await this.ensureSchema();
    const rows = await this.pool.query(
      `select idem_key, kind, request, result, sha,
              started_at, finished_at
         from external_actions where task_id = $1 order by started_at`,
      [taskId]);
    return rows.rows.map((row) => ({
      taskId,
      idemKey: row.idem_key,
      kind: row.kind,
      request: row.request,
      result: row.result ?? undefined,
      sha: row.sha ?? undefined,
      startedAt: String(row.started_at),
      finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    }));
  }

  /** 管理员“彻底删除”是少数不能 fail-open 的写操作：成功响应必须
   * 表示摘要、事件和外部动作三张投影都已经消失。projection-only 的
   * 老任务没有本地现场可裁决，故在同一事务里锁定状态并只删真终态。 */
  async deleteTask(
    taskId: string,
    verifiedTerminal = false,
  ): Promise<ProjectionDeleteResult> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    let transaction = false;
    try {
      await client.query("begin");
      transaction = true;
      const rows = await client.query(
        "select status from tasks where task_id = $1 for update",
        [taskId],
      );
      if (!rows.rowCount) {
        await client.query("commit");
        transaction = false;
        return { found: false, deleted: false };
      }
      const status = String(rows.rows[0].status);
      if (!verifiedTerminal
          && !["completed", "failed", "canceled"].includes(status)) {
        await client.query("rollback");
        transaction = false;
        return { found: true, deleted: false, status };
      }
      // 已授权删除的历史不能被后台重放重新写回；只等该任务已发出的那一次写入。
      const replay = this.replays.get(taskId);
      if (replay) { replay.cancelled = true; if (replay.running) await replay.done; }
      await client.query("delete from task_events where task_id = $1", [taskId]);
      await client.query(
        "delete from external_actions where task_id = $1",
        [taskId],
      );
      await client.query("delete from tasks where task_id = $1", [taskId]);
      await client.query("commit");
      transaction = false;
      return { found: true, deleted: true, status };
    } catch (error) {
      if (transaction) await client.query("rollback").catch(() => undefined);
      this.fail(`deleteTask ${taskId}`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /** 自检使用短命独立连接，不等待建表、历史重放或业务连接池。
   * 连接与查询各有 3 秒上限；最后关闭连接，避免超时后后台继续积压。 */
  async health(): Promise<{ reachable: boolean; last_error?: string }> {
    const client = new pg.Client({ connectionString: this.connectionString,
      connectionTimeoutMillis: 3_000, query_timeout: 3_000, statement_timeout: 3_000 });
    client.on("error", () => {}); // 连接关闭期间的后台错误由本次结果反映。
    try {
      await client.connect();
      await client.query("select 1");
      return { reachable: true, last_error: this.lastError };
    } catch (error) {
      return { reachable: false, last_error: String(error) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.replayTail;
    await this.pool.end().catch(() => undefined);
  }
}
