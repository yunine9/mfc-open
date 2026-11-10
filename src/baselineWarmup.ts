import { frozenTaskBaseline } from "./artifacts.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";

/** 会话恢复不代表编译发生过。仅在可核对的基线上补跑，脏文件另由调用方检查。 */
export async function resumedWarmupBaselineMatches(
  cwd: string, head: string, previousSha?: string, baseline?: string,
): Promise<boolean> {
  const frozen = await frozenTaskBaseline(cwd);
  const known = previousSha || frozen;
  if (known) return known === head;
  // 尚未建分支/写入内核基线时，克隆的远端引用仍能证明起点。
  const ref = baseline ? `refs/remotes/origin/${baseline}` : "refs/remotes/origin/HEAD";
  const result = await runSafeWorktreeGitAsync(cwd,
    ["rev-parse", "--verify", `${ref}^{commit}`], { timeoutMs: 30_000 });
  return result.status === 0 && String(result.stdout).trim() === head;
}
