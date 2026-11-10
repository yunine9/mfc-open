import { statSync } from "node:fs";

function signature(file: string) {
  const stat = statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** 只缓存列表所需字段；文件改写、替换或删除后重新读取，坏件修复后也重新校验。 */
export class FileProjectionCache<T> {
  private entries = new Map<string, { signature: string; result: { value: T } | { error: unknown } }>();

  read(file: string, load: () => T): T {
    let current: string;
    try { current = signature(file); }
    catch (error) { this.entries.delete(file); throw error; }
    const cached = this.entries.get(file);
    if (cached?.signature === current) {
      if ("error" in cached.result) throw cached.result.error;
      return cached.result.value;
    }
    this.entries.delete(file);
    const remember = (result: { value: T } | { error: unknown }) => {
      try { if (signature(file) === current) this.entries.set(file, { signature: current, result }); }
      catch { /* 读取期间文件被移除，下次按文件的实际状态处理。 */ }
    };
    try { const value = load(); remember({ value }); return value; }
    catch (error) { remember({ error }); throw error; }
  }
}
