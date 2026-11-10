import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HumanGate, renderDecision } from "./humanGate.ts";
import { EventLog } from "./semanticEvents.ts";

/** 转入全局分析时重新投影人的原话。不能把旧 Agent 的拆分摘要当成人的决定台账。 */
export function materializeAnalysisDecisions(workspace: string, artifactDir: string): string {
  const records: Array<Record<string, unknown> & { at: string }> = [];
  const warnings: string[] = [];
  try {
    for (const record of new HumanGate(join(workspace, "waiting.json")).resolved()) {
      records.push({ kind: "decision", at: record.resolved_at,
        id: record.waiting_id, actor: record.decided_by, questions: record.question,
        text: renderDecision(record) });
    }
  } catch { warnings.push("部分历史决定无法读取，请按现有证据核对，不要推断已经确认"); }
  try {
    for (const event of new EventLog(join(workspace, "events.jsonl")).replay()) {
      if (event.kind === "user_message" && event.payload.via === "interrupt") {
        records.push({ kind: "supplement", at: event.ts, id: event.eventId,
          text: String(event.payload.text ?? "") });
      }
    }
  } catch { warnings.push("部分历史插话无法读取，请核对是否遗漏补充要求"); }
  if (!records.length) return warnings.join("；");
  records.sort((a, b) => a.at.localeCompare(b.at));
  try {
    mkdirSync(artifactDir, { recursive: true });
    const path = join(artifactDir, "inherited-decisions.json");
    writeFileSync(path, JSON.stringify({ records, warnings }, null, 2), "utf8");
    return `开始澄清前必须读取 ${path}：这是本任务历次人工答复和插话原文，按时间排序。`
      + "责任人已经明确的业务决定必须继承到全局 Story 和子任务，不因换会话重新提问；"
      + "协作者建议保持建议身份，尚未确认的问题不能当作已拍板。后续明确修改按新决定执行，"
      + "只有新增缺口、真实冲突或设计变化才继续澄清。不要拿上一位 Agent 的摘要替代这些原话。"
      + (warnings.length ? `\n注意：${warnings.join("；")}` : "");
  } catch { return "历史决定投影写入失败，请从任务 waiting.json 与 events.jsonl 核对已答复内容，避免重复提问。"; }
}
