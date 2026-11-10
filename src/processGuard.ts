import { appendFileSync, renameSync, statSync, truncateSync, writeSync } from "node:fs";
import { join } from "node:path";
import { muzzleBrokenPipes } from "./processOutput.ts";

// One current file and one backup, at most 10 MiB in total.
export const CRASH_LOG_MAX_BYTES = 5 * 1024 * 1024;
const MAX_DETAIL_BYTES = 64 * 1024;
const REPEAT_WINDOW_MS = 30_000;

/** Diagnostics must neither recurse through console nor exhaust the disk. */
export function createCrashRecorder(dataDir: string) {
  let recording = false;
  let previous = "", lastAt = 0, suppressed = 0;
  const path = join(dataDir, "crash.log");
  return (kind: string, error: unknown) => {
    if (recording) return;
    recording = true;
    try {
      const detail = error instanceof Error
        ? `${error.message}\n${error.stack ?? ""}` : String(error);
      const key = `${kind}: ${Buffer.from(detail).subarray(0, MAX_DETAIL_BYTES).toString("utf8")}`;
      const now = Date.now();
      if (key === previous && now - lastAt < REPEAT_WINDOW_MS) {
        suppressed++;
        return;
      }
      const repeated = suppressed ? `此前合并省略 ${suppressed} 次相同异常。\n` : "";
      const line = `[${new Date(now).toISOString()}] ${repeated}${key}\n`;
      previous = key;
      lastAt = now;
      suppressed = 0;
      try {
        let size = 0;
        try { size = statSync(path).size; } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        if (size + Buffer.byteLength(line) > CRASH_LOG_MAX_BYTES) {
          // Replace the one backup; trim oversized logs left by older servers.
          if (size > CRASH_LOG_MAX_BYTES) truncateSync(path, CRASH_LOG_MAX_BYTES);
          renameSync(path, `${path}.1`);
        }
        appendFileSync(path, line, { mode: 0o600 });
      } catch { /* ENOSPC/readonly diagnostics must not throw again. */ }
      // writeSync reports EPIPE synchronously, caught here. console.error can
      // emit it later, after the reentry flag resets, and recurse indefinitely.
      try { writeSync(2, `[serve] ${line}`); } catch { /* Broken output is abandoned. */ }
    } catch { /* Even unusual error.toString() implementations are untrusted. */ }
    finally { recording = false; }
  };
}

export function guardProcess(dataDir: string): void {
  muzzleBrokenPipes();
  const record = createCrashRecorder(dataDir);
  process.on("unhandledRejection", reason => record("未处理的异步异常", reason));
  process.on("uncaughtException", error => record("未捕获异常", error));
}
