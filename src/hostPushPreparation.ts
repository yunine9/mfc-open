import { deliveryChangeSnapshot } from "./artifacts.ts";
import type { HostOperation, TaskHostRuntime } from "./taskHostTools.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";

/** 释放写入权后刷新当前提交；已确认的推送不因同步产生新 SHA 而失效。 */
export async function prepareHostPush(host: Pick<TaskHostRuntime, "cwd" | "summary" | "assertActive">,
  operation: HostOperation, absorb: (branch: string) => Promise<"ok" | "absorbed" | "blocked">,
  reconcile: () => Promise<void>): Promise<void> {
  if (!host.cwd) throw new Error("任务没有代码现场");
  const before = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!before) throw new Error("无法读取当前待推送提交");
  const branch = await runSafeWorktreeGitAsync(host.cwd, ["branch", "--show-current"]);
  host.assertActive();
  if (branch.status !== 0 || branch.stdout.trim() !== operation.branch) throw new Error("工作分支已切换，不能把其他分支推入本次目标");
  operation.sha = before.head;
  const outcome = await absorb(operation.branch!);
  host.assertActive();
  if (outcome === "blocked") throw new Error(host.summary.delivery?.stalled ?? host.summary.detail ?? "远端分支同步失败，请调用 sync_branch 处理冲突后重新推送");
  // 自动交付与工具推送统一清理平台本地目录，且必须在同步之后、确认之前。
  await reconcile();
  host.assertActive();
  const after = await deliveryChangeSnapshot(host.cwd);
  host.assertActive();
  if (!after) throw new Error("同步远端后无法核对提交");
  operation.sha = after.head;
}
