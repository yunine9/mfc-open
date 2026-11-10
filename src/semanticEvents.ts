/**
 * 语义事件:Pi 事件进内核前的唯一形状(详设 §2)。
 *
 * 事件日志是追加式 JSONL,PostgreSQL 投影与恢复重放都以它为源;
 * `.mae-flow.json` 仍是阶段真相,事件日志不是第二个状态机。
 * 幂等锚是任务内单调递增的 eventId:重放同一事件是 no-op,
 * 乱序/回退的 eventId 被拒收。
 *
 * 服务是单 Node 进程,追加天然串行,不需要跨进程文件锁——
 * 这是从 Python 版(多进程 Hook 场景)迁移时被删掉的机制,不是遗漏。
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";

export type SemanticEventKind =
  | "session_started"
  | "user_message"
  | "assistant_message"
  | "tool_requested"
  | "tool_output"
  | "tool_finished"
  | "agent_spawned"
  | "agent_finished"
  | "agent_observed"
  | "turn_finished"
  | "session_ended"
  | "human_decision"
  | "push_file_list"
  /** 检视提交(问题域,ADR-0007):用户对分析报告的检视意见清单落账
   * ——过程问答投影靠它呈现"这轮为什么重跑"。 */
  | "review_submitted"
  | "workspace_reclaimed"
  /** 异常重跑(问题域,ADR-0055):操作者确认异常已排除,failed 会话
   * 原地复活。operator_note=操作者随重跑附的一句话说明,空串=未附。 */
  | "issue_revived";

export interface SemanticEvent {
  eventId: number;
  taskId: string;
  sessionId: string;
  ts: string;
  kind: SemanticEventKind;
  payload: Record<string, unknown>;
}

/** 每种事件 payload 的最小充分集——字段名对齐内核消费的真实名字(详设 §1)。 */
const REQUIRED_PAYLOAD: Record<SemanticEventKind, readonly string[]> = {
  session_started: ["resume"],
  user_message: ["text"],
  assistant_message: ["text"],
  tool_requested: ["call_id", "name", "input"],
  tool_output: ["name", "text", "log_path"],
  tool_finished: ["call_id", "name", "input", "is_error", "result"],
  agent_spawned: [
    "call_id", "agent_type", "description", "prompt", "child_session_id"],
  agent_finished: ["call_id", "child_session_id", "lifecycle", "final_text"],
  agent_observed: ["call_id", "source_event_id"],
  turn_finished: ["reason"],
  session_ended: ["reason", "detail"],
  human_decision: ["waiting_id", "state_version", "decision", "notes"],
  push_file_list: ["branch", "head_sha"],
  review_submitted: ["count", "text"],
  /** 磁盘治理(票 01/03):终态现场或构建产物回收落账。bytes=本次
   *  回收字节数;scope=repo(整仓现场)或 products(构建产物)。 */
  workspace_reclaimed: ["bytes", "scope"],
  issue_revived: ["operator_note"],
};

export function validateEvent(event: SemanticEvent): string {
  if (!(event.kind in REQUIRED_PAYLOAD)) return `未知事件种类: ${event.kind}`;
  if (!Number.isInteger(event.eventId) || event.eventId <= 0) {
    return "eventId 必须是正整数";
  }
  if (!event.taskId) return "缺少 taskId";
  const missing = REQUIRED_PAYLOAD[event.kind].filter(
    (name) => !(name in event.payload));
  if (missing.length) return `${event.kind} 缺少字段: ${missing.join("、")}`;
  return "";
}

export class EventLogError extends Error {}

/**
 * 追加式任务事件日志。append 语义:
 * - eventId > last:写入,返回 true;
 * - eventId <= last:重放,no-op 返回 false(恢复时安全重灌);
 * - 畸形事件:抛 EventLogError——静默丢事件会让投影缺页还查不出来。
 *
 * 崩溃残迹自愈(issue-31/32/33 复盘,2026-09-10):进程/文件系统在
 * appendFileSync 落盘瞬间死掉会留下断写的尾巴——全零块(元数据已扩、
 * 数据块未刷,WSL2/虚拟盘硬停机的典型形状)或半行。恢复读到这里不再
 * 判死整个任务:末行残迹截断修复并大声记账;**文件中间**的坏行仍
 * fail-loud——那是真丢数据,静默跳过正是本类最初要防的"投影缺页还
 * 查不出来"。修复挂在 rows() 里,lastEventId() 是每次 append 的必经
 * 之路,保证崩溃后任何新写入之前尾巴已修掉——否则新事件追加在残迹
 * 后面,残迹变成中间损坏,就修不了了(WAL 重放的标准纪律)。
 */
export class EventLog {
  private last: number | null = null;

  /** mirror:每条新写入事件的旁路投影(PostgreSQL 等)。只在真正
   * 追加成功后调用;重放 no-op 不触发。旁路自己 fail-open,
   * 这里不 await——投影永远不能拖慢或拖垮事件落盘。
   * log:修复记账通道;缺席退 console.error,永不静默。 */
  constructor(
    readonly path: string,
    private mirror?: (event: SemanticEvent) => void,
    private log?: (message: string) => void,
  ) {}

  lastEventId(): number {
    if (this.last === null) {
      this.last = 0;
      for (const row of this.rows()) {
        this.last = Math.max(this.last, Number(row.eventId ?? 0));
      }
    }
    return this.last;
  }

  append(event: SemanticEvent): boolean {
    const error = validateEvent(event);
    if (error) throw new EventLogError(error);
    if (event.eventId <= this.lastEventId()) return false;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(event) + "\n", "utf-8");
    this.last = event.eventId;
    try {
      this.mirror?.(event);
    } catch {
      // 旁路失败=没投影,由旁路自己记日志;事件已落盘,追加语义不受影响。
    }
    return true;
  }

  replay(): SemanticEvent[] {
    return this.rows() as unknown as SemanticEvent[];
  }

  private note(message: string): void {
    (this.log ?? console.error)(message);
  }

  private rows(): Array<Record<string, unknown>> {
    if (!existsSync(this.path)) return [];
    try {
      return readAppendOnlyJsonl<Record<string, unknown>>(this.path, {
        middleCorrupt: "throw",
        log: (message) => this.note(message),
      });
    } catch (cause) {
      // 通用层的"账本损坏"在本域必须以 EventLogError 露面——调用方
      // 按类型分拣(恢复路径对它有专门处置)。
      if (cause instanceof EventLogError) throw cause;
      throw new EventLogError(
        cause instanceof Error ? cause.message : String(cause));
    }
  }
}
