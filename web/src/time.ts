/**
 * 浏览器端统一时间口径。
 *
 * 新数据一律是带 Z/偏移量的 ISO 时间；早期语义事件和等待记录曾把
 * UTC 的 T/Z 去掉写成 `YYYY-MM-DD HH:mm:ss`，这里兼容时补回 Z。
 * 展示始终交给浏览器本地时区，禁止直接截取服务端字符串。
 */

const LEGACY_BARE_UTC = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export function instantMs(value: string | undefined | null): number {
  if (!value) return NaN;
  const normalized = LEGACY_BARE_UTC.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return new Date(normalized).getTime();
}

function instant(value: string | undefined | null): Date | undefined {
  const milliseconds = instantMs(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds) : undefined;
}

export function formatLocalDateTime(
  value: string | undefined | null,
  options: { seconds?: boolean; year?: boolean } = {},
): string {
  const date = instant(value);
  if (!date) return value ?? "";
  return date.toLocaleString("zh-CN", {
    ...(options.year ? { year: "numeric" as const } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
}

export function formatLocalClock(
  value: string | undefined | null,
  seconds = false,
): string {
  const date = instant(value);
  if (!date) return value ?? "";
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" as const } : {}),
    hour12: false,
  });
}

export function formatLocalDate(value: string | undefined | null): string {
  const date = instant(value);
  return date ? date.toLocaleDateString("zh-CN") : value ?? "";
}

export function relativeTime(
  value: string | undefined | null,
  now = Date.now(),
): string {
  const then = instantMs(value);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}
