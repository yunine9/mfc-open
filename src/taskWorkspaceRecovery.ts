import { existsSync, realpathSync, readdirSync } from "node:fs";
import { basename, join, resolve, sep as pathSep } from "node:path";
import type { TaskSummary } from "./taskService.ts";

/**
 * 从单号目录恢复真实代码现场。task.json 里的 cwd 是加速索引，不是真相：
 * 老版本没写、目录整体搬迁或服务在 clone 落盘与 task.json 落盘之间退出，
 * 都不能让一座仍完整存在的仓库从此变成“现场不存在”。
 *
 * 只在本任务 workspace 内寻找，正式开发仓必须是真 Git worktree；分析单
 * 则只认固定的 repositories 聚合目录。候选不唯一时宁可不猜，避免把
 * pi-agent、缓存或另一座仓误当成当前代码仓。
 */
export function recoverTaskCwd(
  summary: TaskSummary,
  workspace: string,
  saved: unknown,
): string | undefined {
  if (summary.workspace_reclaimed_at) return undefined;
  let root: string;
  try { root = realpathSync(workspace); } catch { return undefined; }
  const location = (
    candidate: string,
    mustBeInside: boolean,
  ): { actual: string; presented: string } | undefined => {
    try {
      const actual = realpathSync(candidate);
      if (mustBeInside
          && actual !== root && !actual.startsWith(`${root}${pathSep}`)) {
        return undefined;
      }
      // realpath 只用于防越界与去重；运行路径沿用 task.json 原始拼法。
      // macOS 会把 /var 改写成 /private/var，替换它会让既有任务、挂载
      // 表和测试夹具拿到一个“同目录但不同字符串”的 cwd。
      return { actual, presented: resolve(candidate) };
    } catch { return undefined; }
  };
  const analysis = ((summary.repositories?.length ?? 0) > 1
      || summary.requirement_analysis_requested === true)
    && !summary.parent_task_id;
  const valid = (candidate: string, mustBeInside = true): string | undefined => {
    const found = location(candidate, mustBeInside);
    if (!found) return undefined;
    const { actual, presented } = found;
    if (analysis) {
      if (basename(actual) !== "repositories") return undefined;
      return existsSync(join(actual, ".mae-flow-work"))
          || (summary.repositories ?? []).some((repository, index) =>
            existsSync(join(actual,
              `${index + 1}-${basename(repository).replace(/\.git$/, "") || "repo"}`,
              ".git")))
        ? presented : undefined;
    }
    return existsSync(join(actual, ".git")) ? presented : undefined;
  };
  if (typeof saved === "string" && location(saved, false)?.actual !== root) {
    // 明确保存过的仓库可以是外置现场，消失后不猜别的目录。
    // cwd 缺失或等于启动中的任务根目录占位值，才继续安全发现；
    // 区分“索引未落盘”和“现场确实被删”。
    return valid(saved, false);
  }
  if (analysis) return valid(join(root, "repositories"));

  const repo = summary.repo_url
    ?? (summary.repositories?.length === 1 ? summary.repositories[0] : undefined);
  if (repo) {
    const expected = valid(join(root,
      basename(repo).replace(/\.git$/, "") || "repo"));
    if (expected) return expected;
  }
  try {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => valid(join(root, entry.name)))
      .filter((entry): entry is string => !!entry);
    return candidates.length === 1 ? candidates[0] : undefined;
  } catch { return undefined; }
}

