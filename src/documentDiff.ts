import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { TaskControlError } from "./errors.ts";
/** 需求文档两版之间的统一 diff。走 git diff --no-index:本仓处处依赖 git,
 * 不为一个 diff 再背一个依赖。改前改后写进临时目录,头两行换成稳定的
 * 文件名,前端 GitDiff 才认得出这是一个文件。 */
export function requirementDiff(
  before: string,
  after: string,
): { text: string; additions: number; deletions: number } {
  const dir = mkdtempSync(join(tmpdir(), "mfc-requirement-diff-"));
  try {
    const left = join(dir, "before.md");
    const right = join(dir, "after.md");
    writeFileSync(left, before.endsWith("\n") ? before : `${before}\n`);
    writeFileSync(right, after.endsWith("\n") ? after : `${after}\n`);
    const run = spawnSync("git", [
      "diff", "--no-index", "--no-color", "--unified=3", "--", left, right,
    ], { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
    // --no-index 有差异时退出码是 1,不是错;2 才是 git 自己出错。
    if (run.status !== 0 && run.status !== 1) {
      throw new TaskControlError(`生成需求文档对比失败：${run.stderr?.trim() || run.status}`);
    }
    const text = String(run.stdout ?? "")
      .split("\n")
      .map((line) => line
        .replace(/^diff --git a\S+ b\S+$/, "diff --git a/需求原文.md b/需求原文.md")
        .replace(/^--- a\S+$/, "--- a/需求原文.md")
        .replace(/^\+\+\+ b\S+$/, "+++ b/需求原文.md"))
      .join("\n");
    let additions = 0;
    let deletions = 0;
    for (const line of text.split("\n")) {
      if (/^\+(?!\+\+ )/.test(line)) additions += 1;
      else if (/^-(?!-- )/.test(line)) deletions += 1;
    }
    return { text, additions, deletions };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
