/**
 * 任务级模型 Token 台账。
 *
 * 只接受模型提供方经 Pi 标准化后的真实 usage；不拿字符数、SSE 字节数
 * 猜 Token。累计值随 task.json 持久化，最近一分钟样本只用于实时吞吐，
 * 不参与任务状态、流程门禁或“是否有进展”的判断。
 */

export const TOKEN_RATE_WINDOW_MS = 60_000;

export interface ModelTokenUsageSample {
  input_tokens: number;
  output_tokens: number;
  at: string;
  session_id: string;
}

interface RecentTokenUsage {
  input_tokens: number;
  output_tokens: number;
  at: string;
}

export interface TokenUsageState {
  schema: "mae-flow-token-usage/1";
  input_tokens: number;
  output_tokens: number;
  updated_at?: string;
  recent: RecentTokenUsage[];
}

export interface TaskTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_per_minute: number;
  output_tokens_per_minute: number;
  rate_window_seconds: 60;
  updated_at: string;
  source: "provider";
}

function tokens(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function usageToken(usage: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = tokens(usage[key]);
    if (value !== undefined) return value;
  }
  return 0;
}

/** Pi 当前给 input/output；后两个别名只做网关兼容，不改变统计口径。 */
export function modelTokenUsageSample(
  message: unknown,
  sessionId: string,
  at = new Date().toISOString(),
): ModelTokenUsageSample | undefined {
  if (!message || typeof message !== "object") return undefined;
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return undefined;
  const row = usage as Record<string, unknown>;
  const input = usageToken(row, ["input", "input_tokens", "inputTokens"]);
  const output = usageToken(row, ["output", "output_tokens", "outputTokens"]);
  if (input === 0 && output === 0) return undefined;
  return {
    input_tokens: input,
    output_tokens: output,
    at,
    session_id: sessionId,
  };
}

export function emptyTokenUsageState(): TokenUsageState {
  return {
    schema: "mae-flow-token-usage/1",
    input_tokens: 0,
    output_tokens: 0,
    recent: [],
  };
}

function recentSample(value: unknown): RecentTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const at = String(row.at ?? "");
  if (!Number.isFinite(Date.parse(at))) return undefined;
  const input = tokens(row.input_tokens);
  const output = tokens(row.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  return { input_tokens: input, output_tokens: output, at };
}

/** 坏的旧现场只丢统计，不影响任务恢复。 */
export function restoreTokenUsageState(value: unknown): TokenUsageState {
  if (!value || typeof value !== "object") return emptyTokenUsageState();
  const row = value as Record<string, unknown>;
  const input = tokens(row.input_tokens);
  const output = tokens(row.output_tokens);
  if (input === undefined || output === undefined) return emptyTokenUsageState();
  const recent = Array.isArray(row.recent)
    ? row.recent.map(recentSample).filter((item): item is RecentTokenUsage => !!item)
    : [];
  const updatedAt = String(row.updated_at ?? "");
  return {
    schema: "mae-flow-token-usage/1",
    input_tokens: input,
    output_tokens: output,
    ...(Number.isFinite(Date.parse(updatedAt)) ? { updated_at: updatedAt } : {}),
    recent,
  };
}

function activeRecent(
  recent: RecentTokenUsage[],
  now: number,
): RecentTokenUsage[] {
  return recent.filter((sample) => {
    const at = Date.parse(sample.at);
    return Number.isFinite(at) && at <= now + 1_000
      && at > now - TOKEN_RATE_WINDOW_MS;
  });
}

export function recordTokenUsage(
  value: TokenUsageState | undefined,
  sample: ModelTokenUsageSample,
): TokenUsageState {
  const state = restoreTokenUsageState(value);
  const at = Date.parse(sample.at);
  const input = tokens(sample.input_tokens);
  const output = tokens(sample.output_tokens);
  if (!Number.isFinite(at) || input === undefined || output === undefined
      || (input === 0 && output === 0)) {
    return state;
  }
  return {
    schema: "mae-flow-token-usage/1",
    input_tokens: state.input_tokens + input,
    output_tokens: state.output_tokens + output,
    updated_at: sample.at,
    recent: [
      ...activeRecent(state.recent, at),
      { input_tokens: input, output_tokens: output, at: sample.at },
    ],
  };
}

export function tokenUsageSnapshot(
  value: TokenUsageState | undefined,
  now = Date.now(),
): TaskTokenUsage | undefined {
  const state = restoreTokenUsageState(value);
  if (!state.updated_at || state.input_tokens + state.output_tokens === 0) {
    return undefined;
  }
  const recent = activeRecent(state.recent, now);
  return {
    input_tokens: state.input_tokens,
    output_tokens: state.output_tokens,
    total_tokens: state.input_tokens + state.output_tokens,
    input_tokens_per_minute: recent.reduce(
      (total, sample) => total + sample.input_tokens, 0),
    output_tokens_per_minute: recent.reduce(
      (total, sample) => total + sample.output_tokens, 0),
    rate_window_seconds: 60,
    updated_at: state.updated_at,
    source: "provider",
  };
}
