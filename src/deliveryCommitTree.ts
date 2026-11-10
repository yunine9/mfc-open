import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafeWorktreeGitAsync, type SafeGitOptions } from "./safeGit.ts";

/** 用独立索引整理交付提交，不改变用户的暂存内容。
 * 默认只读 Git 对象；addPaths 仅用于用户明确勾选的工作区文件。
 * 返回候选提交，调用方完成复核后再移动分支。 */
export async function deliveryCommitTree(input: {
  cwd: string; head: string; baseline: string; parents: string[];
  restorePaths: string[]; addPaths?: string[]; message: string; configs: SafeGitOptions["configs"];
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "mae-delivery-index-"));
  try {
    const run = async (args: string[]) => {
      const result = await runSafeWorktreeGitAsync(input.cwd, args, {
        indexFile: join(root, "index"), configs: input.configs, timeoutMs: 60_000,
      });
      if (result.status !== 0) throw new Error(String(result.stderr || result.error || "Git 整理失败").slice(0, 300));
      return result.stdout.trim();
    };
    await run(["read-tree", input.head]);
    if (input.restorePaths.length) await run(["restore", "--source", input.baseline,
      "--staged", "--", ...input.restorePaths.map(path => `:(literal)${path}`)]);
    if (input.addPaths?.length) await run(["add", "-A", "--", ...input.addPaths.map(path => `:(literal)${path}`)]);
    const tree = await run(["write-tree"]);
    return await run(["commit-tree", tree, ...input.parents.flatMap(sha => ["-p", sha]), "-m", input.message]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
