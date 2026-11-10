import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const CONTEXT = ".pipeline-context.json";
/** 只保留当前版本的材料入口，旧原文移入旁边的历史目录；不替换 bind 根。
 * 先切换版本再请求平台：404、断网、空响应也不能留下上一版日志充数。 */
export function scopePipelineArtifacts(dir: string, sha: string, refresh = false): string {
  mkdirSync(dir, { recursive: true });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("流水线材料目录不能是软链接");
  const contextPath = join(dir, CONTEXT);
  let previous: { sha?: string; generation?: string } = {};
  if (existsSync(contextPath)) { try { previous = JSON.parse(readFileSync(contextPath, "utf8")); } catch { /* 无版本材料只归档 */ } }
  if (!refresh && previous.sha === sha && previous.generation) return previous.generation;
  const generation = randomUUID();
  const entries = readdirSync(dir).filter(name => name !== CONTEXT);
  if (entries.length) {
    const history = join(dirname(dir), "pipeline-history");
    mkdirSync(history, { recursive: true });
    if (lstatSync(history).isSymbolicLink()) throw new Error("流水线历史目录不能是软链接");
    const old = /^[a-zA-Z0-9-]{1,80}$/.test(previous.sha ?? "") ? previous.sha : "unbound";
    const archive = join(history, `${old}-${generation}`);
    mkdirSync(archive);
    for (const entry of entries) renameSync(join(dir, entry), join(archive, entry));
  }
  const temporary = join(dir, `.${generation}.tmp`);
  writeFileSync(temporary, JSON.stringify({ sha, generation,
    note: "此目录只展示本版本材料；材料缺席不代表验证通过，不要按历史版本告警重复修改。" }), { mode: 0o600, flag: "wx" });
  renameSync(temporary, contextPath);
  return generation;
}

export function currentPipelineArtifactScope(dir: string, generation: string): boolean {
  try { return JSON.parse(readFileSync(join(dir, CONTEXT), "utf8")).generation === generation; }
  catch { return false; }
}
