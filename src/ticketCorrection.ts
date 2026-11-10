import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, lstatSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createSafeGitView, runSafeWorktreeGitAsync, type SafeGitCommitIdentity } from "./safeGit.ts";
import { preserveGitAiNotes } from "./gitAiNotes.ts";

export interface TicketCorrection {
  id: string; old_ticket: string; ticket: string; title: string; actor: string;
  state: "running" | "failed" | "completed"; message: string; at: string; can_cancel?: boolean; cleanup_only?: boolean;
}
export function ticketCorrectionBlocks(value?: TicketCorrection): boolean {
  return !!value && value.state !== "completed" && !value.cleanup_only;
}

export interface TicketRewrite {
  old_branch: string; branch: string; old_head: string; head: string;
  base: string; sha_map: Record<string, string>;
}

export function validateCorrectionTicket(ticket: string, title: string): void {
  // 只保护文件路径和 Git 引用；不伪装成需求系统的 AR 真伪校验。
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,119}$/.test(ticket)) throw new Error("单号只能包含字母、数字、下划线和短横线");
  if (!title.trim() || /[\r\n\0]/.test(title) || title.length > 1000) throw new Error("请填写新 AR 的准确描述（一行文字）");
}

export function writeCorrectionJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

/** 台账在 Agent 工作区外；每个阶段完成即落盘，失败重试沿用同一计划。 */
export function correctionJournal(workspace: string, id: string): string {
  const key = createHash("sha256").update(workspace).digest("hex");
  return join(dirname(workspace), ".ticket-corrections", key, `${id}.json`);
}

async function git(cwd: string, args: string[], identity?: SafeGitCommitIdentity): Promise<string> {
  const result = await runSafeWorktreeGitAsync(cwd, args, { timeoutMs: 60_000, commitIdentity: identity });
  if (result.status !== 0) throw new Error(`单号纠正 Git 操作失败：${result.stderr || result.error || args[0]}`);
  return result.stdout.trimEnd();
}

/** 只重建对象，不 checkout/reset/rebase，索引和未提交文件逐字保留。 */
export async function prepareTicketRewrite(cwd: string, oldTicket: string, ticket: string, base: string): Promise<TicketRewrite> {
  const oldBranch = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const oldHead = await git(cwd, ["rev-parse", "HEAD"]);
  await git(cwd, ["merge-base", "--is-ancestor", base, oldHead]);
  const branch = oldBranch.includes(oldTicket) ? oldBranch.replace(oldTicket, ticket) : `${oldBranch}_${ticket}`;
  await git(cwd, ["check-ref-format", "--branch", branch]);
  const existing = await runSafeWorktreeGitAsync(cwd, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (existing.status === 0) throw new Error(`本地分支 ${branch} 已存在，请换一个未被使用的单号`);
  const commits = (await git(cwd, ["rev-list", "--reverse", "--topo-order", `${base}..${oldHead}`])).split(/\s+/).filter(Boolean);
  // 目标分支合入的提交保留原说明，仅替换当前任务主线中旧单号的前缀。
  const mainline = new Set((await git(cwd, ["rev-list", "--first-parent", `${base}..${oldHead}`])).split(/\s+/));
  const mapping: Record<string, string> = {};
  const oldKey = oldTicket.replace(/[^A-Za-z0-9_]/g, "_");
  const newKey = ticket.replace(/[^A-Za-z0-9_]/g, "_");
  for (const sha of commits) {
    const fields = (await git(cwd, ["show", "-s", "--format=%T%x00%P%x00%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B", sha])).split("\0");
    const [tree, parentsText, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate] = fields;
    const parents = parentsText.split(/\s+/).filter(Boolean);
    const mapped = parents.map(parent => mapping[parent] ?? parent);
    const original = fields.slice(8).join("\0");
    let message = original;
    if (mainline.has(sha)) {
      for (const [oldPrefix, newPrefix] of [[`[${oldTicket}]`, `[${ticket}]`], [`[${oldKey}]`, `[${newKey}]`], [oldTicket, ticket]]) {
        if (message.startsWith(oldPrefix)) { message = newPrefix + message.slice(oldPrefix.length); break; }
      }
    }
    if (message === original && mapped.every((parent, index) => parent === parents[index])) continue;
    mapping[sha] = await git(cwd, ["commit-tree", tree, ...mapped.flatMap(parent => ["-p", parent]), "-m", message],
      { authorName, authorEmail, authorDate, committerName, committerEmail, committerDate });
  }
  return { old_branch: oldBranch, branch, old_head: oldHead, head: mapping[oldHead] ?? oldHead, base, sha_map: mapping };
}

export async function applyTicketRewrite(cwd: string, plan: TicketRewrite, log?: (message: string) => void): Promise<void> {
  const current = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  if (current === plan.branch && head === plan.head) {
    await preserveGitAiNotes(cwd, new Map(Object.entries(plan.sha_map)), log);
    return;
  }
  if (current !== plan.old_branch || head !== plan.old_head) throw new Error("纠正期间代码现场发生变化，未覆盖现场；请保留当前现场后重试");
  const previous = await runSafeWorktreeGitAsync(cwd, ["rev-parse", "--verify", `refs/heads/${plan.branch}`]);
  if (previous.status === 0 && previous.stdout.trim() !== plan.head) throw new Error("新分支被其他操作占用，未覆盖");
  if (previous.status !== 0) await git(cwd, ["update-ref", `refs/heads/${plan.branch}`, plan.head, "0".repeat(plan.head.length)]);
  // SafeGit 的 HEAD 是只读快照。只改已验证真实 gitdir 中的 HEAD，不读取 hooks/config。
  const view = createSafeGitView(cwd);
  try {
    const path = join(view.repositoryGitDir, "HEAD");
    const lock = `${path}.lock`;
    writeFileSync(lock, `ref: refs/heads/${plan.branch}\n`, { flag: "wx" });
    renameSync(lock, path);
  } finally { view.cleanup(); }
  await preserveGitAiNotes(cwd, new Map(Object.entries(plan.sha_map)), log);
}

/** 只迁移活动投影的精确引用；历史事件、测试原始日志不重写。 */
export function mapCorrectionReferences<T>(value: T, replacements: Record<string, string>): T {
  if (typeof value === "string") return (replacements[value] ?? value) as T;
  if (Array.isArray(value)) return value.map(item => mapCorrectionReferences(item, replacements)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [replacements[key] ?? key, mapCorrectionReferences(item, replacements)])) as T;
  return value;
}

export function migrateTicketArtifacts(cwd: string, oldTicket: string, ticket: string): void {
  const root = join(cwd, ".mae-flow-work");
  const oldPath = join(root, oldTicket), newPath = join(root, ticket);
  if (existsSync(oldPath) && !lstatSync(oldPath).isSymbolicLink()) {
    if (existsSync(newPath)) throw new Error("新单号的过程文档目录已存在，未覆盖");
    renameSync(oldPath, newPath);
  }
  // 保留旧批注、旧文档链接；新会话使用新目录，不复制大文件。
  if (existsSync(newPath) && !existsSync(oldPath)) symlinkSync(ticket, oldPath, "dir");
  for (const path of [join(cwd, ".ticket-id"), join(newPath, ".ticket-id")]) {
    if (existsSync(path) && readFileSync(path, "utf8").trim() === oldTicket) writeFileSync(path, ticket);
  }
}
