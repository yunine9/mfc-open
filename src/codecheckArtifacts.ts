import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSafeGitView, runSafeWorktreeGitAsync } from "./safeGit.ts";

export const CODECHECK_PATHSPECS = [":(exclude).codecheckcli", ":(exclude).codecheckcli/**", ":(exclude,glob)**/.codecheckcli/**"];
export function isCodecheckPath(path: string): boolean {
  return path.replace(/\\/g, "/").replace(/^"|"$/g, "").split("/").includes(".codecheckcli");
}

/** 只修改本地 ignore，工具结果留在原地；不污染业务仓 .gitignore。 */
export function excludeCodecheckArtifacts(repo: string): void {
  const view = createSafeGitView(repo);
  const gitDir = view.repositoryGitDir;
  view.cleanup();
  const info = join(gitDir, "info");
  mkdirSync(info, { recursive: true });
  if (lstatSync(info).isSymbolicLink() || realpathSync(info) !== info) throw new Error("Git info 目录无效");
  const file = join(info, "exclude");
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())) throw new Error("Git exclude 文件无效");
  const original = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!original.split(/\r?\n/).includes(".codecheckcli/")) {
    writeFileSync(file, `${original}${original.endsWith("\n") ? "" : "\n"}.codecheckcli/\n`);
  }
}

export class CodecheckArtifactCommitError extends Error {}

/** 最终树删掉了也不够：中间提交仍会随 push 发布。这里只检查新增历史。 */
export async function assertNoCodecheckCommits(repo: string, base?: string): Promise<void> {
  const result = await runSafeWorktreeGitAsync(repo, ["log", "--format=", "--name-only", "-z",
    ...(base ? [`${base}..HEAD`] : ["HEAD", "--not", "--remotes"]),
    "--", ".codecheckcli", ":(glob)**/.codecheckcli/**"], { timeoutMs: 30_000 });
  if (result.status !== 0) throw new Error("无法核对 CodeCheck 本地文件是否进入提交历史");
  if (result.stdout.split("\0").some(path => isCodecheckPath(path.trim()))) {
    throw new CodecheckArtifactCommitError(".codecheckcli 是本地检查产物，已进入待推送提交历史。请移除该目录的提交记录后继续；仅在后续提交删除文件不能避免发布。");
  }
}
