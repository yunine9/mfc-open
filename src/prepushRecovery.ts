import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 等旧 attempt 的 finally 释放后恢复本地验证，避免复用注定失败的旧 Promise。
 * 本地 Build-Fix 不能依赖远端 MR 查询才能恢复；网络交付在编译收口后接棒。 */
export async function resumePrePushVerification(host: {
  interrupted?: Promise<boolean>;
  cwd?: string;
  current(): boolean;
  fail(reason: string): void;
  prepare(branch: string, baseline: string): Promise<boolean>;
  deliver(): Promise<unknown>;
}): Promise<void> {
  if (host.interrupted) await host.interrupted.catch(() => false);
  if (!host.current()) return;
  if (!host.cwd) { host.fail("代码现场路径缺失"); return; }
  const statePath = join(host.cwd, ".mae-flow.json");
  if (!existsSync(statePath)) { host.fail("流程未初始化，无可恢复的分支配置"); return; }
  let branch: string, baseline: string;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    branch = String(state?.config?.["分支名"] ?? "");
    baseline = String(state?.config?.["基线分支"] ?? "");
  } catch (error) {
    host.fail(`流程配置无法读取：${String(error).slice(0, 500)}`);
    return;
  }
  if (!branch || !baseline) { host.fail("流程配置缺少分支名或基线分支"); return; }
  if (!await host.prepare(branch, baseline) || !host.current()) return;
  await host.deliver();
}
