import { createHash } from "node:crypto";
import type { HumanGate, WaitingRecord } from "./humanGate.ts";

export const MR_DESCRIPTION_STEP = "cloud_mr_description";
export function mrDescriptionCallId(ticket: string): string {
  return `mr-description-${createHash("sha256").update(ticket).digest("hex").slice(0, 24)}`;
}
export function mrDescriptionAnswer(waiting: WaitingRecord): string {
  return String(Object.values(waiting.answers ?? {})[0] ?? waiting.decision).trim();
}

function mrDescriptionAttempts(
  gate: HumanGate,
  taskId: string,
  ticket: string,
): Array<{ generation: number; record: WaitingRecord }> {
  const baseCallId = mrDescriptionCallId(ticket);
  return gate.all().flatMap((record) => {
    if (record.task_id !== taskId || record.step !== MR_DESCRIPTION_STEP) return [];
    if (record.call_id === baseCallId) return [{ generation: 1, record }];
    const suffix = record.call_id.slice(baseCallId.length);
    if (!/^-r[2-9]\d*$/.test(suffix)) return [];
    const generation = Number(suffix.slice(2));
    return Number.isSafeInteger(generation) ? [{ generation, record }] : [];
  }).sort((left, right) => left.generation - right.generation);
}

export function savedMrDescription(gate: HumanGate, taskId: string, ticket: string): string | undefined {
  const record = mrDescriptionAttempts(gate, taskId, ticket)
    .reverse()
    .find((attempt) => attempt.record.status === "resolved")
    ?.record;
  return record?.status === "resolved" ? mrDescriptionAnswer(record) || undefined : undefined;
}
export function askMrDescription(gate: HumanGate, taskId: string, ticket: string): WaitingRecord {
  const baseCallId = mrDescriptionCallId(ticket);
  const attempts = mrDescriptionAttempts(gate, taskId, ticket);
  const latest = attempts.at(-1);
  // 普通重试仍复用同一张卡；用户接管作废的是旧现场，必须保留旧卡审计，
  // 同时另举一张可回答的新卡，不能把 superseded 记录重新挂回等待中。
  if (latest && latest.record.status !== "superseded") return latest.record;
  const callId = latest ? `${baseCallId}-r${latest.generation + 1}` : baseCallId;
  return gate.createWaiting({ taskId, step: MR_DESCRIPTION_STEP, callId,
    questionInput: { purpose: "clarification", questions: [{
      question: `请填写 AR 单号 ${ticket} 对应的准确描述（将原样用作 MR 标题）`, options: [],
    }] },
    context: "合入时要求 MR 标题与关联 AR 单的描述一致，平台暂时无法读取这段描述。请从 AR 单复制准确描述；填写后继续创建 MR，同一 AR 后续修复无需重复填写。",
  });
}
