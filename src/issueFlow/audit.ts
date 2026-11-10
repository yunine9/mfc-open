/**
 * 问题流审计账写入原语(ADR-0053,#402 图):JSON lines、双时间、
 * fail-open——落账失败记 stderr 降级,绝不拖垮主流程。
 *
 * 账面两级(规格 docs/audit-logging-spec.md §4):
 * - 会话级:<issueRoot>/audit/<name>.jsonl,每行自动带 issue_id;
 * - 进程级:<dataDir>/logs/<name>.jsonl(executionRuntime 装配时
 *   configureAudit 一次;缺席=进程账静默弃写,测试世界无进程账)。
 *
 * 纪律:审计是独立的一个轴——级别只表严重度,事实记 info;
 * 对话正文不进审计账,记"发生了什么+关联 id",正文原地引 transcript。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

export type AuditLevel = "debug" | "info" | "warn" | "error";

export interface AuditEntry {
  /** 稳定事件标识(代码协议,命名 <域>.<动作>)。 */
  kind: string;
  /** 一句人话:Agent 考古时的第一眼。 */
  msg: string;
  level?: AuditLevel;
  issue_id?: string;
  turn_id?: string;
  request_id?: string;
  [field: string]: unknown;
}

let logsDir = "";

/** 进程级账目录(<dataDir>/logs)。装配时调用一次。 */
export function configureAudit(dir: string): void {
  logsDir = dir;
}

export function auditLogsDir(): string {
  return logsDir;
}

/** 旧档压缩阈值。规格 §5:大小+时间双触发,P1 先大小(50MB,低频账
 *  一天远到不了);时间触发随 P2 的部署纪律一并落。测试可注小阈值。 */
export const AUDIT_ROTATE_BYTES = 50 * 1024 * 1024;

/** 滚动:换下明文档压成 .gz(只压缩不删除,审计属过程记录)。
 *  压缩失败保留明文档继续滚——账不能因为归档丢掉。 */
export function rotateAuditFile(file: string, limit = AUDIT_ROTATE_BYTES): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // 不存在=首写,无档可滚
  }
  if (size < limit) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archived = `${file}-${stamp}`;
  renameSync(file, archived);
  try {
    writeFileSync(`${archived}.gz`, gzipSync(readFileSync(archived)));
    unlinkSync(archived);
  } catch (error) {
    console.error(`[audit] 旧档压缩失败,保留明文 ${archived}: `
      + String(error instanceof Error ? error.message : error));
  }
}

export function appendAudit(file: string, entry: AuditEntry): void {
  try {
    const now = new Date().toISOString();
    // 双时间(ADR-0053):ts=事实发生,written_at=落账;实时写两者相等,
    // 补记路径显式传 ts 才分叉——事后补的账不被当成实时账。
    const line = JSON.stringify({
      ts: now, written_at: now, level: "info", ...entry,
    }) + "\n";
    mkdirSync(dirname(file), { recursive: true });
    rotateAuditFile(file);
    appendFileSync(file, line);
  } catch (error) {
    console.error(`[audit] 落账失败 ${file}: `
      + String(error instanceof Error ? error.message : error));
  }
}

/** 会话级账:<issueRoot>/audit/<name>.jsonl,自动带 issue_id。 */
export function sessionAudit(
  issueRoot: string,
  issueId: string,
  name: string,
  entry: AuditEntry,
): void {
  appendAudit(join(issueRoot, "audit", `${name}.jsonl`), {
    issue_id: issueId, ...entry,
  });
}

/** 进程级账:<dataDir>/logs/<name>.jsonl;未 configureAudit 弃写
 *  (裸构造的测试世界没有进程账面)。 */
export function processAudit(name: string, entry: AuditEntry): void {
  if (!logsDir) return;
  appendAudit(join(logsDir, `${name}.jsonl`), entry);
}

/** 动作级 request id。信箱条目沿用既有 mrr-* id 兼作 request_id
 *  (规格 §3),不另造;这里只给无既有 id 的动作。 */
export function newRequestId(): string {
  return `r-${randomUUID().slice(0, 8)}`;
}

export interface PlatformCallAudit {
  endpoint: string;
  request_id: string;
  issue_id?: string;
  detail?: Record<string, unknown>;
  startedAt: number;
  error?: string;
}

/** 宿主→适配层调用账(host-calls.jsonl,规格 §2):每次调用一行,
 *  带耗时与错误原文——401 可按端点聚合,与适配层侧按 request_id 对上
 *  (#383②③ 的直接解药)。 */
export function auditPlatformCall(input: PlatformCallAudit): void {
  const ok = !input.error;
  processAudit("host-calls", {
    kind: `call.${input.endpoint}`,
    msg: `${input.endpoint} ${ok ? "完成" : `失败:${input.error}`}`,
    level: ok ? "info" : "error",
    request_id: input.request_id,
    ...(input.issue_id ? { issue_id: input.issue_id } : {}),
    duration_ms: Date.now() - input.startedAt,
    ...(input.detail ?? {}),
    ...(input.error ? { error: input.error } : {}),
  });
}
