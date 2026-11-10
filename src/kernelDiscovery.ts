/**
 * 内核自动发现——serve/pilot/测试共用的唯一一条链:
 *   显式 MAE_FLOW_HOME > 仓内自带的 kernel/。
 *
 * mfc-open 自带一份完整内核快照，不依赖外部内核仓；需要联调活内核时
 * 显式设置 MAE_FLOW_HOME，避免开发机上恰好存在的其他版本被静默采用。
 *
 * 判定标记用 hooks/dispatch.py(内核转发壳入口,比 scripts/ 目录更
 * 不易误认);MAE_FLOW_HOME 显式指定则无条件信任,错了让它响亮地错。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function discoverKernelRoot(repoRoot: string, required = false): string | undefined {
  const bundled = resolve(repoRoot, "kernel");
  const root = process.env.MAE_FLOW_HOME
    ?? (existsSync(join(bundled, "hooks", "dispatch.py")) ? bundled : undefined);
  if (required && !root) {
    throw new Error("已要求内核模式，但找不到内核，拒绝降级为演示模式。"
      + "请恢复随 Cloud 发布的 kernel/，或正确配置 MAE_FLOW_HOME。"
      + "否则下单无法选择代码仓、任务也不会克隆代码。");
  }
  return root;
}
