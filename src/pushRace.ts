/** Git 的非快进拒绝是并发事实，可以重新同步；权限、网络和仓库规则不能混作这一类。 */
export class RemoteBranchAdvancedError extends Error {}
export class RemoteBranchBusyError extends Error {}

export function rejectedByBranchAdvance(porcelain: string): boolean {
  return porcelain.split(/\r?\n/).some(line =>
    /^!\t[^\t]+\t\[rejected\] \((?:fetch first|non-fast-forward)\)$/.test(line.trimEnd()));
}

/** 每次重试先重新同步并检查既有授权。同一次宿主操作内最多发送三次，
 * 外部持续写入时明确停下，不把同一个旧提交交给 Agent 无限重试。 */
export async function pushWithFreshBranch<T>(publish: () => Promise<T>,
  refresh: () => Promise<boolean>): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try { return await publish(); }
    catch (error) {
      if (!(error instanceof RemoteBranchAdvancedError)) throw error;
      if (attempt === 2) throw new RemoteBranchBusyError(
        "远端任务分支在同步后仍被其他提交持续推进，三次推送均被拒绝；已停止自动重试。"
        + "请协调同分支的提交者后重试，当前本地改动已保留。此问题不是文件授权不足。");
      if (!await refresh()) return undefined;
    }
  }
}
