/**
 * Build-Fix 实时过程(用户点名的可观测性缺口:编译过程、执行命令必须
 * 看得见)。运行时跟随，结束后仍读取历史；独立轮次由服务端标记。
 */

import { useEffect, useRef, useState } from "react";
import { executionEventKey } from "./eventView";
import { useStickyBottom } from "./stickyBottom";
import { formatLocalClock } from "./time";
import {
  tailBuildFixEvents,
  type PrepushRuntime,
  type SemanticEvent,
  type SseConnectionState,
} from "./api";

const MAX_LINES = 400;
const RESULT_TAIL_LINES = 12;

interface LiveLine {
  key: string;
  kind: "cmd" | "out" | "err" | "note";
  text: string;
  /** 命令与消息行带时刻(用户点名);输出尾行属于上一条命令,不重复。 */
  time?: string;
}

function timeOf(ts: string): string | undefined {
  return formatLocalClock(ts, true);
}

function clip(value: string, limit: number): string {
  const normalized = value.replace(/\r/g, "");
  return normalized.length > limit
    ? `${normalized.slice(0, limit)}…` : normalized;
}

function linesOf(event: SemanticEvent): LiveLine[] {
  const payload = event.payload as {
    name?: unknown;
    input?: { command?: unknown; path?: unknown; file_path?: unknown };
    result?: unknown;
    is_error?: unknown;
    text?: unknown;
  };
  const key = executionEventKey(event);
  const time = timeOf(event.ts);
  switch (event.kind) {
    case "session_started":
      return [{ key, kind: "note", time, text: event.execution?.source === "build_fix"
        ? `Build-Fix · 第 ${event.execution.round} 轮开始` : "执行会话开始" }];
    case "turn_finished":
      return [{ key, kind: "note", time, text: "本轮 Agent 已收口，构建结论以验证结果为准" }];
    case "tool_requested": {
      const name = String(payload.name ?? "");
      if (/^bash$/i.test(name)) {
        return [{
          key, kind: "cmd", time,
          text: `$ ${clip(String(payload.input?.command ?? ""), 600)}`,
        }];
      }
      if (/^(edit|write)$/i.test(name)) {
        const path = payload.input?.path ?? payload.input?.file_path ?? "";
        return [{ key, kind: "note", time, text: `✎ 修改 ${clip(String(path), 200)}` }];
      }
      return [{ key, kind: "note", time, text: `${name} ${clip(String(payload.input?.path ?? payload.input?.file_path ?? ""), 200)}` }];
    }
    case "tool_output": {
      if (!/^bash$/i.test(String(payload.name ?? ""))) return [];
      const output = clip(String(payload.text ?? "").replace(/\r/g, "\n"), 8_000)
        .split("\n").filter((line) => line.length).slice(-80);
      return output.map((line, index) => ({
        key: `${key}:${index}`,
        kind: "out" as const,
        text: line,
      }));
    }
    case "tool_finished": {
      if (!/^bash$/i.test(String(payload.name ?? ""))) return [];
      // 全量输出在轮目录的 bash 日志里;这里给结尾片段够定位即可。
      const tail = clip(String(payload.result ?? ""), 4_000)
        .split("\n").filter((line) => line.trim()).slice(-RESULT_TAIL_LINES);
      return tail.map((line, index) => ({
        key: `${key}:${index}`,
        kind: payload.is_error ? "err" as const : "out" as const,
        text: line,
      }));
    }
    case "assistant_message": {
      const text = String(payload.text ?? "").trim();
      return text
        ? [{ key, kind: "note", time, text: clip(text, 300) }] : [];
    }
    default:
      return [];
  }
}

export function PrepushLiveLog({
  taskId,
  active,
  source = tailBuildFixEvents,
  title = "Build-Fix 过程",
  emptyText = "等待 Build-Fix Agent 的第一条命令……",
  onLogs,
}: {
  taskId: string;
  /** 运行时跟随，结束时读取一次完整历史快照。 */
  active: boolean;
  /** 事件源(默认 Build-Fix;环境预热等同构流复用本组件时替换)。 */
  source?: typeof tailBuildFixEvents;
  title?: string;
  emptyText?: string;
  onLogs?: () => void;
}) {
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [state, setState] = useState<SseConnectionState>("connecting");
  const seen = useRef(new Set<string>());
  const [received, setReceived] = useState(0);
  const follow = useStickyBottom<HTMLDivElement>(received);
  useEffect(() => {
    seen.current = new Set();
    setLines([]);
    setReceived(0);
  }, [taskId, source]);
  useEffect(() => {
    return source(taskId, (event) => {
      // EventSource 断线重连时服务端整文件重放:按事件锚去重。
      const anchor = executionEventKey(event);
      if (seen.current.has(anchor)) return;
      seen.current.add(anchor);
      const next = linesOf(event);
      if (next.length) {
        setLines((current) => [...current, ...next].slice(-MAX_LINES));
        setReceived((count) => count + next.length);
      }
    }, setState, { follow: active });
  }, [taskId, active, source]);
  return <div className="prepush-live" aria-label="Build-Fix 实时过程">
    <div className="prepush-live-head">
      <strong>{title}</strong>
      {active
        ? <span className={`prepush-live-state is-${state}`}>{
          state === "live" ? "实时"
            : state === "ended" ? "记录已读取"
              : state === "connecting" ? "连接中" : "重连中"}</span>
        : <span className="prepush-live-state is-done">{state === "ended" ? "历史记录" : state === "reconnecting" ? "读取中断，正在重连" : "正在读取历史"}</span>}
      {onLogs && <button type="button" onClick={onLogs}>完整执行日志 ↗</button>}
    </div>
    {follow.paused && <button type="button" className="follow-resume" onClick={follow.toBottom}>↓ 回到最新{follow.behind > 0 ? `（${follow.behind} 条新记录）` : ""}</button>}
    <div className="prepush-live-body" ref={follow.ref} onScroll={follow.onScroll}>
      {lines.length === 0
        && <p className="prepush-live-empty">{active ? emptyText : state === "ended" ? "没有可读取的 Build-Fix 执行记录。" : "正在读取 Build-Fix 历史记录…"}</p>}
      {lines.map((line) => <pre
        key={line.key} className={`line-${line.kind}`}>
        {line.time && <time>{line.time} </time>}{line.text}</pre>)}
    </div>
  </div>;
}

/** 新服务只认运行时 ownership；runtime 缺席时才兼容旧后端的阶段推断。 */
export function prepushActive(
  state?: string,
  runtime?: PrepushRuntime,
): boolean {
  if (runtime) return ["running", "recovering"].includes(runtime.state);
  return ["queued", "preparing", "compiling", "testing", "unit_testing",
    "ut", "repairing"].includes(String(state ?? ""));
}
