/**
 * 语义事件 → transcript 同形 JSONL(详设 §3/D2)。
 *
 * 不让契约学新格式,让云端把事件流写成契约已认识的格式:
 * 产物必须能直接过 mae_flow_core 的 parse_transcript 与四个质量契约。
 * 这也是语言边界的接缝:TS 写、Python 读,JSONL 是中立契约。
 *
 * 子 Agent 各写各的 transcript,布局对齐内核 hook_transcript_paths 的
 * 确定性绑定: <主transcript去扩展名>/subagents/agent-<call_id>.jsonl。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SemanticEvent } from "./semanticEvents.ts";

type Row = Record<string, unknown>;

function userRow(blocks: Row[]): Row {
  return { type: "user", message: { role: "user", content: blocks } };
}

function assistantRow(blocks: Row[]): Row {
  return {
    type: "assistant",
    message: { role: "assistant", content: blocks },
  };
}

export class TranscriptStore {
  private children = new Map<string, string>();

  constructor(
    readonly mainPath: string,
    public mainSessionId: string,
  ) {}

  /** childSessionId ↔ 派发 call_id(tool_use_id)的确定性绑定。 */
  bindChild(childSessionId: string, callId: string): void {
    const safe = basename(String(callId || ""));
    if (!safe || safe !== callId) {
      throw new Error("子会话绑定需要一个可作文件名的 call_id");
    }
    const stem = this.mainPath.replace(/\.jsonl$/, "");
    this.children.set(childSessionId, join(stem, "subagents", `agent-${safe}.jsonl`));
  }

  childPath(childSessionId: string): string {
    return this.children.get(childSessionId) ?? "";
  }

  private pathFor(sessionId: string): string {
    if (sessionId === this.mainSessionId) return this.mainPath;
    const path = this.children.get(sessionId);
    if (!path) {
      // 证据落错文件比缺证据更毒:未绑定的子会话拒收,不悄悄进主 transcript。
      throw new Error(`未绑定的会话 ${sessionId}——子会话必须先 bindChild`);
    }
    return path;
  }

  private append(path: string, row: Row): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(row) + "\n", "utf-8");
  }

  /** 消费一条语义事件;与 transcript 无关的种类是 no-op。 */
  record(event: SemanticEvent): void {
    const payload = event.payload as Record<string, any>;
    switch (event.kind) {
      case "user_message":
        this.append(this.pathFor(event.sessionId), userRow(
          [{ type: "text", text: payload.text }]));
        break;
      case "assistant_message":
        this.append(this.pathFor(event.sessionId), assistantRow(
          [{ type: "text", text: payload.text }]));
        break;
      case "tool_requested":
        this.append(this.pathFor(event.sessionId), assistantRow([{
          type: "tool_use",
          id: payload.call_id,
          name: payload.name,
          input: payload.input,
        }]));
        break;
      case "tool_finished":
        // result 必须是宿主真实回传(含退出码文本)——call_failed 靠它嗅探失败。
        this.append(this.pathFor(event.sessionId), userRow([{
          type: "tool_result",
          tool_use_id: payload.call_id,
          is_error: Boolean(payload.is_error),
          content: payload.result,
        }]));
        break;
      case "agent_spawned":
        // 主 transcript 视角:一次 Task 工具调用(agent_kind 靠这些字段名推断)。
        this.bindChild(payload.child_session_id, payload.call_id);
        this.append(this.mainPath, assistantRow([{
          type: "tool_use",
          id: payload.call_id,
          name: "Task",
          input: {
            subagent_type: payload.agent_type,
            description: payload.description,
            prompt: payload.prompt,
          },
        }]));
        break;
      case "agent_finished":
        // XXX_RESULT 标记判定作用在 final_text 上,不得截断首行。
        this.append(this.mainPath, userRow([{
          type: "tool_result",
          tool_use_id: payload.call_id,
          is_error: payload.lifecycle !== "returned",
          content: payload.final_text,
        }]));
        break;
      default:
        break;
    }
  }
}
