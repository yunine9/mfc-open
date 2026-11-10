/** Read-only task diagnostics for the Agent. Unlike the human export, this
 * never discovers arbitrary files or runs Git with repository-local config. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";

export function assertTaskReadRoot(workspace: string, path: string): void {
  if (!existsSync(path)) return;
  const local = relative(realpathSync(workspace), realpathSync(path));
  if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`)) throw new Error("读取目标超出当前任务目录");
}

function readTaskTail(workspace: string, path: string): string {
  let fd: number | undefined;
  try {
    if (!existsSync(path)) return "（尚无记录）";
    assertTaskReadRoot(workspace, path);
    if (lstatSync(path).isSymbolicLink()) throw new Error("不读取软链文件");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    assertTaskReadRoot(workspace, path);
    const current = lstatSync(path);
    if (!stat.isFile() || stat.ino !== current.ino || stat.dev !== current.dev) throw new Error("读取期间文件已变化");
    const bytes = Math.min(stat.size, 16000), buffer = Buffer.alloc(bytes);
    const read = readSync(fd, buffer, 0, bytes, Math.max(0, stat.size - bytes));
    return `${stat.size > bytes ? "（仅末尾记录）\n" : ""}${buffer.subarray(0, read).toString("utf8")}`;
  } catch (error) { return `无法读取：${String(error)}`; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export async function collectAgentDiagnostics(input: {
  workspace: string; cwd?: string; task: { id: string; status: string; detail?: string };
  execution?: unknown; container?: unknown;
}): Promise<string> {
  const result: Record<string, unknown> = { at: new Date().toISOString(), task: input.task,
    execution: input.execution, container: input.container ?? "无当前容器" };
  if (input.cwd) {
    assertTaskReadRoot(input.workspace, input.cwd);
    const git = await runSafeWorktreeGitAsync(input.cwd, ["status", "--porcelain=v1", "-b"], { timeoutMs: 10000 });
    result.git = { exit: git.status, output: String(git.stdout ?? "").slice(0, 16000), error: String(git.stderr ?? "").slice(0, 4000) };
    result.kernel = readTaskTail(input.workspace, join(input.cwd, ".mae-flow.json"));
  }
  result.events = readTaskTail(input.workspace, join(input.workspace, "events.jsonl"));
  return JSON.stringify(result, null, 2);
}
