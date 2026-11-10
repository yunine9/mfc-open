export type EventFilter = "all" | "messages" | "tools" | "errors";

/** 「右侧查看」选中的一项长内容(任务侧 EventTail 与问题侧现场页签
 * 同款交互,2026-09-08 对齐):长文本/结构化内容默认只在事件行里给
 * 预览按钮,点开在流旁的详情面板看全文。 */
export interface EventDetailSelection {
  key: string;
  eventId: number;
  eventLabel: string;
  fieldLabel: string;
  content: string;
  structured: boolean;
  timestamp: string;
}

export function executionEventKey(event: { eventId: number; sessionId?: string;
  execution?: { attempt: string } }): string {
  return `${event.execution?.attempt ?? "main"}:${event.sessionId ?? "main"}:${event.eventId}`;
}

export interface FilterableEvent {
  kind: string;
  payload: Record<string, unknown>;
}

export function isErrorEvent(event: FilterableEvent): boolean {
  return event.payload.is_error === true || /error|failed/i.test(event.kind);
}

export function matchesEventFilter(
  event: FilterableEvent,
  filter: EventFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "errors") return isErrorEvent(event);
  if (filter === "messages") {
    return event.kind === "user_message" || event.kind === "assistant_message";
  }
  return event.kind === "tool_requested" || event.kind === "tool_output"
    || event.kind === "tool_finished";
}

export function filterEvents<T extends FilterableEvent>(
  events: T[],
  filter: EventFilter,
): T[] {
  return filter === "all"
    ? events
    : events.filter((event) => matchesEventFilter(event, filter));
}

/** 事件完整保留，只限制一次挂进 DOM 的数量；用户可逐批查看更早记录。 */
export function eventWindow<T>(
  events: T[],
  limit: number,
): { items: T[]; hidden: number } {
  const size = Math.max(1, Math.floor(limit));
  const hidden = Math.max(0, events.length - size);
  return { items: events.slice(hidden), hidden };
}

export function eventFilterCounts(
  events: FilterableEvent[],
): Record<EventFilter, number> {
  return {
    all: events.length,
    messages: events.filter((event) => matchesEventFilter(event, "messages")).length,
    tools: events.filter((event) => matchesEventFilter(event, "tools")).length,
    errors: events.filter(isErrorEvent).length,
  };
}
