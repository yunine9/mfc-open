/**
 * AskUserQuestion → WAITING_FOR_HUMAN(详设 §5/D4)。
 *
 * Agent 按步骤文档提问,问题被自定义工具接住变成结构化 Web 待办;
 * 决定回来后以工具结果按 call_id 回注,Agent 视角与旧插件完全一致。
 *
 * 并发规则:第一个匹配状态版本的决定生效,后到的抛 StateConflictError
 * ——两个浏览器同时审批,不覆盖先到决定。写入用临时文件+rename 保原子。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { durableWriteFileSync } from "./durableWrite.ts";
import { dirname } from "node:path";

export class StateConflictError extends Error {}

export interface WaitingRecord {
  waiting_id: string;
  task_id: string;
  step: string;
  call_id: string;
  question: Record<string, unknown>;
  /** 举卡前 Agent 刚展示的上文(清单/确认单),随卡呈现防盲签。 */
  preface?: string;
  /** 提问前模型的最后一段话:审批卡的上下文。"编译与 UT 命令如上表"
   * 这类指代,表就在这里——不带上它,卡在页面上就是悬空的
   * (真人实战第一单实测)。 */
  context?: string;
  state_version: number;
  status: "waiting" | "resolved" | "superseded";
  decision: string;
  /** 结构化回答(问题→选项)。多问题卡必填;单问题卡可由 decision 派生。 */
  answers?: Record<string, string>;
  notes: string;
  created_at: string;
  resolved_at: string;
  /** 同一 HTTP 请求的稳定指纹。网络重试只有完全相同才幂等返回；
   * 不同决定仍严格执行先到生效。旧记录缺席时保持原有冲突语义。 */
  request_digest?: string;
  /** 谁提交的决定。管理员可替责任人拍板,事后必须答得出"谁点的"
   * (2026-08-30 审计:决策不记 actor,追责只能靠猜)。 */
  decided_by?: string;
  /** 决定落袋后宿主完成后续动作所需的结构化收据。它与决定同在
   * waiting.json 的原子替换里，避免进程死在“决定已收、task.json
   * 尚未推进”的窗口后丢失交付清单等上下文。 */
  continuation?: Record<string, unknown>;
}

interface Store {
  records: Record<string, WaitingRecord>;
}

function now(): string {
  // 必须保留 Z。旧实现把 UTC 的 T/Z 剥掉，浏览器会把它当成本地时间，
  // 在东八区一张刚生成的卡会立刻显示“等你 8 小时”。
  return new Date().toISOString();
}

export class HumanGate {
  constructor(readonly path: string) {}

  private load(): Store {
    if (!existsSync(this.path)) return { records: {} };
    return JSON.parse(readFileSync(this.path, "utf-8")) as Store;
  }

  private save(store: Store): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // 耐久写(票 #163):人工决定是权威账,tmp fsync 后再 rename。
    durableWriteFileSync(this.path, JSON.stringify(store, null, 1));
  }

  /** 同一 call_id 幂等返回已有记录:恢复重放不得生成第二张待办。 */
  createWaiting(options: {
    taskId: string;
    step: string;
    callId: string;
    questionInput: Record<string, unknown>;
    context?: string;
    /** 卡片正文之外的"上文":举卡前 Agent 刚展示的清单/说明。卡上写
     * "上述配置是否正确"时,"上述"必须就在卡里,不能让人去现场流水里
     * 回翻(MFC-028 盲签风险)。 */
    preface?: string;
  }): WaitingRecord {
    const waitingId = `${options.taskId}:${options.callId}`;
    const store = this.load();
    const existing = store.records[waitingId];
    if (existing) return { ...existing };
    const record: WaitingRecord = {
      waiting_id: waitingId,
      task_id: options.taskId,
      step: options.step,
      call_id: options.callId,
      question: options.questionInput,
      context: options.context || undefined,
      preface: options.preface || undefined,
      state_version: 1,
      status: "waiting",
      decision: "",
      notes: "",
      created_at: now(),
      resolved_at: "",
    };
    store.records[waitingId] = record;
    this.save(store);
    return { ...record };
  }

  pending(): WaitingRecord[] {
    return Object.values(this.load().records)
      .filter((record) => record.status === "waiting")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  /** 全部记录(等待中/已决/已作废)按举卡时刻排——会话流投影用它把
   * "举了什么卡、谁怎么答的"按时间摆回原位。只读,不参与判定。 */
  all(): WaitingRecord[] {
    let store: Store;
    try {
      store = this.load();
    } catch {
      return [];                 // 投影旁路:读不动就当没有,不挡页面
    }
    return Object.values(store.records)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((record) => ({ ...record }));
  }

  /** waiting.json 是人工决定的权威账。task.json 只存页面投影副本；
   * 两者发生分叉时，调用方必须从这里重新对账。 */
  get(waitingId: string): WaitingRecord | undefined {
    const record = this.load().records[waitingId];
    return record ? { ...record } : undefined;
  }

  /** 已落袋决定清单供宿主修复派生投影（例如批注 sent 状态）。决定
   * 本身仍以 waiting.json 为唯一真相，调用方不得据此重做业务选择。 */
  resolved(): WaitingRecord[] {
    return Object.values(this.load().records)
      .filter((record) => record.status === "resolved")
      .sort((left, right) => left.resolved_at.localeCompare(right.resolved_at))
      .map((record) => ({ ...record }));
  }

  /** 消费决定;版本不匹配或已被抢先,抛 StateConflictError。 */
  resolve(
    waitingId: string,
    options: {
      stateVersion: number;
      question?: Record<string, unknown>;
      decision: string;
      answers?: Record<string, string>;
      notes?: string;
      requestDigest?: string;
      decidedBy?: string;
      continuation?: Record<string, unknown>;
    },
  ): WaitingRecord {
    const store = this.load();
    const record = store.records[waitingId];
    if (!record) throw new StateConflictError(`待办 ${waitingId} 不存在`);
    if (record.status !== "waiting") {
      if (record.status === "resolved"
          && options.requestDigest
          && record.request_digest === options.requestDigest) {
        return { ...record };
      }
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 已由先到决定完成`);
    }
    if (record.state_version !== options.stateVersion) {
      throw new StateConflictError(
        `任务状态已变化:待办 ${waitingId} 版本不匹配`);
    }
    if (options.question) record.question = options.question;
    record.status = "resolved";
    record.decision = String(options.decision);
    if (options.answers && Object.keys(options.answers).length) {
      record.answers = { ...options.answers };
    }
    record.notes = String(options.notes ?? "");
    record.request_digest = options.requestDigest || undefined;
    // 有值才赋:赋 undefined 会造出值为 undefined 的自有属性,与 JSON
    // 落盘回读(键消失)不等价,幂等重放的 deepEqual 会被它绊倒(实测)。
    if (options.decidedBy) record.decided_by = options.decidedBy;
    record.continuation = options.continuation
      ? { ...options.continuation } : undefined;
    record.state_version += 1;
    record.resolved_at = now();
    this.save(store);
    return { ...record };
  }

  /** 用户主动接管代码后，旧问题绑定的现场已经失效。它不是一次
   * “通过/打回”决定，只从待办列表撤下并保留审计原因。 */
  supersede(
    waitingId: string,
    options: { stateVersion: number; notes: string },
  ): WaitingRecord {
    const store = this.load();
    const record = store.records[waitingId];
    if (!record) throw new StateConflictError(`待办 ${waitingId} 不存在`);
    if (record.status === "superseded") return { ...record };
    if (record.status !== "waiting"
        || record.state_version !== options.stateVersion) {
      throw new StateConflictError(`任务状态已变化:待办 ${waitingId} 已失效`);
    }
    record.status = "superseded";
    record.decision = "";
    record.answers = undefined;
    record.notes = String(options.notes);
    record.state_version += 1;
    record.resolved_at = now();
    this.save(store);
    return { ...record };
  }
}

/**
 * 决定 → 回注文本。决定顶行,备注跟在后面——旧插件捕获路径吃的
 * 就是这个形状(XXX_RESULT 同款纪律:不挤掉首行)。
 */
export function renderDecision(record: {
  decision: string;
  answers?: Record<string, string>;
  notes?: string;
}): string {
  const answers = record.answers ?? {};
  const decision = Object.keys(answers).length
    ? Object.values(answers).join("\n")
    : String(record.decision ?? "");
  const notes = String(record.notes ?? "");
  return notes ? `${decision}\n${notes}` : decision;
}
