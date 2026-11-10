import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskSummary } from "./taskService.ts";
import { createSafeGitView } from "./safeGit.ts";
import { createZipArchive } from "./zipArchive.ts";
import { runGitProcess } from "./hostGitSandbox.ts";

export interface TaskContinuation {
  id: string;
  text: string;
  actor: string;
  at: string;
  state: "preparing" | "failed" | "active";
  error?: string;
  branch: string;
  baseline: string;
}

export interface TaskDeliveryHistory {
  id: string;
  started_at: string;
  completed_at: string;
  delivery: TaskSummary["delivery"];
  request?: string;
  archive: string;
}

export function continuationPending(summary: Pick<TaskSummary, "continuation">): boolean {
  return !!summary.continuation && summary.continuation.state !== "active";
}

export function continuationArchive(workspace: string, id: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("继续修改记录编号无效");
  return join(workspace, "delivery-history", id);
}

/** 在改变代码前保存历史；重试只使用第一次保存的快照。 */
export function snapshotContinuation(summary: TaskSummary, cwd: string | undefined, id: string): TaskSummary {
  const archive = continuationArchive(summary.workspace, id);
  mkdirSync(archive, { recursive: true });
  const path = join(archive, "summary.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  if (cwd) {
    for (const name of [".mae-flow.json", ".mae-flow-order.json"]) {
      const source = join(cwd, name);
      if (existsSync(source) && lstatSync(source).isFile()) cpSync(source, join(archive, name));
    }
    const ticket = summary.ticket;
    if (ticket && !/[\\/]/.test(ticket) && ticket !== "." && ticket !== "..") {
      const materials = join(cwd, ".mae-flow-work", ticket);
      if (existsSync(materials) && !lstatSync(materials).isSymbolicLink()) {
        cpSync(materials, join(archive, "materials"), { recursive: true });
      }
    }
  }
  writeFileSync(path, JSON.stringify(summary), { flag: "wx", mode: 0o600 });
  return structuredClone(summary);
}

/** 只归档执行记录，不移动代码仓和构建缓存，也不删除交付材料。 */
export function archiveContinuationRuntime(workspace: string, id: string, hostLedger: string): void {
  const archive = continuationArchive(workspace, id);
  for (const name of ["waiting.json", "annotations.jsonl", "reviews", "review_replies.md",
    "feedback", "kernel-delivery", "pipeline", "pipeline-facts.json", "prepush",
    "developer-assistant.json", "pi-agent", "transcript", "transcript.jsonl",
    "delivery-summary", "交付报告.md", "delivery-experience", "交付经验复盘.md"]) {
    const source = join(workspace, name), target = join(archive, name);
    if (existsSync(source) && !existsSync(target)) renameSync(source, target);
  }
  const target = join(archive, "host-operations.json");
  if (existsSync(hostLedger) && !existsSync(target)) renameSync(hostLedger, target);
}

/** 使用权威仓地址与安全 Git 配置；不运行 clean，保留不冲突的编译缓存。 */
export async function resetContinuationBranch(input: {
  cwd: string; repo: string; branch: string; baseline: string;
  sandbox: { args: string[]; env: NodeJS.ProcessEnv };
}): Promise<void> {
  const view = createSafeGitView(input.cwd);
  try {
    const run = async (args: string[]) => {
      const result = await runGitProcess([...input.sandbox.args, ...args], {
        cwd: input.cwd, env: view.environment(input.sandbox.env), timeoutMs: 120_000,
      });
      if (result.status !== 0) throw new Error(`准备继续修改分支失败：${result.stderr || result.stdout || "Git 未完成"}`);
      return result.stdout.trim();
    };
    for (const ref of [input.branch, input.baseline]) await run(["check-ref-format", "--branch", ref]);
    if (input.branch === input.baseline) throw new Error("工作分支不能与基准分支相同");
    const existing = await run(["ls-remote", "--heads", input.repo, `refs/heads/${input.branch}`]);
    if (existing) throw new Error("远端同名工作分支仍存在，请先核对归属；本次没有覆盖它");
    const baselineRef = `refs/remotes/origin/${input.baseline}`;
    await run(["fetch", "--no-tags", "--no-recurse-submodules", input.repo,
      `+refs/heads/${input.baseline}:${baselineRef}`]);
    await run(["checkout", "-f", "-B", input.branch, baselineRef]);
    // 内核按本地基准分支计算差异、检查分支起点，它也必须指向刚拉取的版本。
    await run(["branch", "-f", input.baseline, baselineRef]);
    // 安全 Git 视图的 HEAD 是独立副本；显式交回真实仓，恢复时不能仍指向基准分支。
    writeFileSync(join(view.repositoryGitDir, "HEAD"), readFileSync(join(view.proxyGitDir, "HEAD")));
  } finally { view.cleanup(); }
}

export function continuationInstructions(summary: TaskSummary): string {
  if (summary.continuation?.state !== "active") return "";
  return `本次继续修改要求：\n${summary.continuation.text}\n\n`
    + "本次要求是当前目标。原需求、Spec、Story 和此前交付记录供按需参考，已有实现不重新做一遍。"
    + "本次有行为变化时，编码前在现有 Spec/Story 补充受影响的函数 UT 与模块 UT（MST）用例，写清条件、操作和预期；MST 就是模块 UT。"
    + "已有用例按需修订，历史用例可能在 implementation.md，不另开设计流程或重复确认；纯文档等不涉及模块行为的修改说明不适用原因。"
    + "按需调整文档、代码和测试；只有实质歧义才询问。代码已从最新基准重新建立同名工作分支，"
    + "上一次 MR 已合入；本次必须创建新的 MR，旧验证结果不能作为本次通过依据。";
}

/** 下载仅包含业务材料与执行记录，不包含 pi-agent 的模型配置或宿主凭据。 */
export function continuationHistoryZip(workspace: string, id: string): Buffer {
  const root = continuationArchive(workspace, id);
  const entries: Array<{ name: string; content: Buffer }> = [];
  let bytes = 0;
  const visit = (name: string) => {
    const path = join(root, name);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 64 * 1024 * 1024 || entries.length >= 500) throw new Error("本次历史材料过大，无法一次下载");
      entries.push({ name, content: readFileSync(path) });
    }
  };
  for (const name of ["summary.json", "materials", "annotations.jsonl", "reviews", "review_replies.md", "交付报告.md", "交付经验复盘.md"]) visit(name);
  return createZipArchive(entries);
}
