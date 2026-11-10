/**
 * 现场记录导出(纯函数):一个问题会话的全部执行事实 → 单文件 Markdown。
 *
 * 两种读者,一份文件(2026-08-28 拍板):
 * - 人:粗读定位"这一单问题出在哪"(工具报错/闸门卡壳/阶段推进异常);
 * - AI:整份喂给复盘模型,靠事件号(#n)精读引用。
 *
 * 数据源 = 事件流(events.jsonl 逐字:工具调用输入输出、AI 发言、用户
 * 指令与决策)+ issue.json 台账(单号/仓/阶段转移/结论)。原始语义保真:
 * 不脱敏、不删减、不截断——分析报告(issue-analysis.md)是 AI 用 Write
 * 写出来的,内容已在 tool_requested/tool_finished 里,不单独附加。
 */

import type { SemanticEvent } from "../semanticEvents.ts";
import {
  FIXED_STAGE_LABELS,
  type IssueSessionState,
} from "./state.ts";

export interface WorksiteExportInput {
  state: IssueSessionState;
  events: SemanticEvent[];
  /** 注入时钟(测试);缺省取当前时间。 */
  now?: string;
}

export interface WorksiteRecord {
  /** 建议的下载文件名(UTF-8)。 */
  filename: string;
  /** 纯 ASCII 兜底文件名(content-disposition 的 filename=)。 */
  filenameAscii: string;
  markdown: string;
}

/** 阶段键 → 显示名:固定流程词表按场景嵌套,未知场景就全场景扫一遍
 * 同名键;都不认识(存量现场的旧键)原样展示,不猜。 */
function stageLabel(stage: string, scenario?: string): string {
  const fixed = FIXED_STAGE_LABELS as Record<
    string, Record<string, string>>;
  if (scenario && fixed[scenario]?.[stage]) return fixed[scenario][stage];
  for (const labels of Object.values(fixed)) {
    if (labels[stage]) return labels[stage];
  }
  return stage;
}

function sourceLabel(source: string): string {
  return source === "agent" ? "AI 上报" : "平台";
}

/** 工具入参渲染:Bash 优先展示命令原文,其余序列化(保持逐字)。 */
function toolInputText(name: string, input: unknown): string {
  if (input && typeof input === "object" && typeof (input as {
    command?: unknown;
  }).command === "string") {
    return String((input as { command: string }).command);
  }
  try {
    return JSON.stringify(input, null, 2) ?? "(无输入)";
  } catch {
    return String(input);
  }
}

/** 事件 → Markdown 小节;未知 kind 兜底渲染原始 JSON(不丢事实)。 */
function renderEvent(event: SemanticEvent): string {
  const kind = String(event.kind ?? "");
  const ts = String(event.ts ?? "");
  const num = `### #${event.eventId}`;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (kind) {
    case "session_started":
      return `${num} 会话启动(${payload.resume ? "续跑" : "新会话"}) · ${ts}`;
    case "user_message":
      return `${num} 用户指令 · ${ts}\n\n${String(payload.text ?? "")}`;
    case "assistant_message":
      return `${num} AI 发言 · ${ts}\n\n${String(payload.text ?? "")}`;
    case "tool_requested": {
      const name = String(payload.name ?? "?");
      return `${num} 工具调用:${name} · ${ts}\n\n输入:\n\n\`\`\`\n${toolInputText(name, payload.input)}\n\`\`\``;
    }
    case "tool_finished": {
      const name = String(payload.name ?? "?");
      const failed = Boolean(payload.is_error);
      const result = String(payload.result ?? "(无结果)");
      return `${num} 工具结果:${name} ${failed ? "✗ 异常" : "✓"} · ${ts}\n\n输出:\n\n\`\`\`\n${result}\n\`\`\``;
    }
    case "human_decision": {
      const lines = [`${num} 用户决策 · ${ts}`];
      if (payload.decision !== undefined) {
        lines.push(`\n决定:${String(payload.decision)}`);
      }
      if (payload.notes) {
        lines.push(`\n补充:${String(payload.notes)}`);
      }
      return lines.join("\n");
    }
    case "turn_finished":
      return `${num} 回合结束(${String(payload.reason ?? "")}) · ${ts}`;
    case "session_ended":
      return `${num} 会话结束 · ${ts}\n\n原因:${String(payload.reason ?? "")}${payload.detail ? ` — ${String(payload.detail)}` : ""}`;
    default:
      return `${num} ${kind || "(未知事件)"} · ${ts}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
  }
}

/** 构建现场记录 Markdown。逐事件容错:单条渲染异常降级为原始 JSON 小节,
 * 整体不抛——导出是排障工具,自己不能是第一个炸点。 */
export function buildWorksiteRecord(
  input: WorksiteExportInput,
): WorksiteRecord {
  const { state, events } = input;
  const now = input.now ?? new Date().toISOString();
  const day = now.slice(0, 10).replaceAll("-", "");

  const header = [
    `# 现场记录:${state.title}`,
    "",
    `- 会话: ${state.id} · 单号: ${state.ticket ?? "未绑定"}`
      + ` · 来源: ${state.source === "dts" ? "DTS 拉单" : "自研登记"}`,
    `- 状态: ${state.status} · 阶段: ${stageLabel(state.stage, state.scenario)}`
      + (state.stage_note ? `(${state.stage_note})` : ""),
    `- 代码仓: ${(state.repo_urls ?? (state.repo_url ? [state.repo_url] : [])).join("、") || "无"}`,
    `- 结论: ${state.conclusion
      ? `${state.conclusion.kind} — ${state.conclusion.summary}` : "尚无"}`,
    `- 时间跨度: ${events[0]?.ts ?? state.created_at} → ${events.at(-1)?.ts ?? now}`
      + `(共 ${events.length} 条事件)`,
    `- 导出时间: ${now}`,
    "",
    "> 本文件含现场原文(工具命令与输出、对话逐字),未做脱敏;注意传播范围。",
    "> 读法:按时间序读,工具调用的「输入/输出」是定位问题的主要证据;",
    "`#编号` 是事件号,引用与讨论请用编号。",
    "",
  ].join("\n");

  const transitions = state.transitions ?? [];
  const stageSection = [
    "## 阶段推进",
    "",
    ...(transitions.length
      ? transitions.map((t) =>
          `- ${t.at} [${sourceLabel(t.source)}]`
            + `${t.stage ? ` ${stageLabel(t.stage, state.scenario)} —` : ""} ${t.note}`)
      : ["无阶段转移记录。"]),
    "",
  ].join("\n");

  const timeline = ["## 现场时间线", ""];
  for (const event of events) {
    try {
      timeline.push(renderEvent(event), "");
    } catch (cause) {
      timeline.push(
        `### #${event.eventId} (渲染失败) · ${event.ts ?? ""}`, "",
        `\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``, "");
      void cause;
    }
  }

  const markdown = [header, stageSection, timeline.join("\n")].join("\n");
  return {
    filename: `${state.id}-现场记录-${day}.md`,
    filenameAscii: `${state.id}-worksite-${day}.md`,
    markdown,
  };
}
