import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { frozenTaskBaseline } from "./artifacts.ts";
import { analyticsCodePath, analyticsGit } from "./deliveryAnalyticsGit.ts";
import { restrictedAnalysisPathSegment } from "./analysisText.ts";
import type { TaskSummary } from "./taskService.ts";

type Task = Pick<TaskSummary, "id" | "workspace" | "delivery_generation">;
export interface LocalCodeSnapshot {
  version: 1; generator: string; url: string; base: string; head: string; captured_at: string;
  includes_untracked: boolean; patches: Record<string, string>; hash: string;
}
const pending = new Map<string, Promise<void>>();
const captures = new Map<string, string>();
function location(task: Task, url: string) {
  const key = createHash("sha256").update(JSON.stringify([task.workspace, task.id, task.delivery_generation, url])).digest("hex");
  return join(dirname(task.workspace), ".delivery-analysis", `${key}.local.json`);
}
export function readLocalCodeSnapshot(task: Task, url: string): LocalCodeSnapshot | undefined {
  try {
    const path = location(task, url), stat = lstatSync(path);
    if (lstatSync(dirname(path)).isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) return;
    const { hash, ...data } = JSON.parse(readFileSync(path, "utf8"));
    if (data.version !== 1 || data.url !== url || data.generator !== "local-code-v1" ||
      hash !== createHash("sha256").update(JSON.stringify(data)).digest("hex")) return;
    return { ...data, hash };
  } catch { return; }
}
export function localCodeSnapshotPending(task: Task, url: string) { return pending.has(location(task, url)); }
export async function awaitLocalCodeSnapshot(task: Task, url: string) { await pending.get(location(task, url)); }
/** 关联操作只启动只读采集；任何失败都不会撤销关联。 */
export function captureLocalCodeSnapshot(task: TaskSummary, cwd: string | undefined, url: string, log = console.warn): void {
  if (!cwd || task.workspace_reclaimed_at) return;
  const scope = { id: task.id, workspace: task.workspace, delivery_generation: task.delivery_generation };
  const path = location(scope, url);
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("快照目录不能是符号链接");
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 0 }), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) { log(`本地快照无法初始化 ${scope.id}：${String(error)}`); return; }
  const captured_at = new Date().toISOString();
  const token = randomUUID();
  captures.set(path, token);
  const initialBase = task.delivery?.initial_mr?.base;
  let work: Promise<void>;
  work = (async () => {
    if (!lstatSync(join(cwd, ".git"))) return;
    const head = (await analyticsGit(cwd, ["rev-parse", "HEAD"])).trim();
    const base = await frozenTaskBaseline(cwd) ?? initialBase;
    if (!base || !/^[a-f0-9]{40,64}$/.test(base)) throw new Error("缺少本地代码比较基线");
    const status = await analyticsGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const visible = (p: string) => analyticsCodePath(p) && !p.split(/[\\/]/).some(s => restrictedAnalysisPathSegment.test(s));
    const raw = await analyticsGit(cwd, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"]);
    const tracked = raw.split("\0").flatMap(s => /^\d+\t\d+\t([\s\S]+)$/.exec(s)?.[1] ?? []);
    const untracked = (await analyticsGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    const paths = [...new Set([...tracked, ...untracked])].filter(visible);
    if (paths.length > 300) throw new Error("本地快照超过 300 个文件");
    const patches: Record<string, string> = Object.create(null);
    let size = 0, includes_untracked = false;
    const fingerprints = new Map<string, string>();
    for (const p of paths) {
      if (Date.now() - Date.parse(captured_at) > 60_000) throw new Error("本地快照超过一分钟预算");
      if (untracked.includes(p)) {
        const file = join(cwd, p), stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (stat.size > 8 * 1024 * 1024) throw new Error("本地文件超出快照预算");
        const buffer = readFileSync(file);
        if (buffer.includes(0)) continue;
        fingerprints.set(p, createHash("sha256").update(buffer).digest("hex"));
        const text = buffer.toString("utf8"), lines = text.split("\n");
        if (lines.at(-1) === "") lines.pop();
        patches[p] = text ? `@@ -0,0 +1,${lines.length} @@\n${lines.map(s => "+" + s).join("\n")}\n` : "";
        includes_untracked = true;
      } else patches[p] = await analyticsGit(cwd, ["--literal-pathspecs", "diff", "--unified=2", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base, "--", p]);
      size += Buffer.byteLength(patches[p]);
      if (size > 8 * 1024 * 1024) throw new Error("本地快照超出大小预算");
    }
    for (const p of Object.keys(patches)) {
      if (Date.now() - Date.parse(captured_at) > 60_000) throw new Error("本地快照超过一分钟预算");
      if (fingerprints.has(p)) {
        if (createHash("sha256").update(readFileSync(join(cwd, p))).digest("hex") !== fingerprints.get(p)) throw new Error("采集期间未跟踪源码发生变化");
      } else if (patches[p] !== await analyticsGit(cwd, ["--literal-pathspecs", "diff", "--unified=2", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", base, "--", p])) throw new Error("采集期间源码发生变化");
    }
    if (head !== (await analyticsGit(cwd, ["rev-parse", "HEAD"])).trim() || status !== await analyticsGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) throw new Error("采集期间工作区发生变化");
    const data = { version: 1 as const, generator: "local-code-v1", url, base, head, captured_at, includes_untracked, patches };
    const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("快照目录不能是符号链接");
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ ...data, hash }), { mode: 0o600, flag: "wx" });
    if (captures.get(path) === token) renameSync(temp, path);
  })().catch(error => { log(`本地代码快照未保存 ${scope.id}：${String(error)}`); });
  pending.set(path, work);
  void work.finally(() => {
    if (pending.get(path) === work) pending.delete(path);
    if (captures.get(path) === token) captures.delete(path);
  });
}
