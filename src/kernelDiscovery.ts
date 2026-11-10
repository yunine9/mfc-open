/**
 * 内核自动发现——serve/pilot/测试共用的唯一一条链:
 *   显式 MAE_FLOW_HOME > 仓内收编的 kernel/(与 Cloud 版本一起发布)
 *   > 开发布局的兄弟目录 ../mae-flow(只在发布快照缺席时兜底)。
 *
 * Cloud 与内核之间存在版本化契约。兄弟目录可能恰好是另一个分支或
 * 旧版本，若优先采用它，页面会有新字段而运行中的内核没有对应命令，
 * 形成静默降级。需要联调活内核时显式设置 MAE_FLOW_HOME，意图更清楚。
 *
 * 为什么必须共用:worktree 里跑测试时 cwd 变了,各处手写的
 * `cwd()/../mae-flow` 指到不存在的位置,内核 bootstrap 起不来,
 * 门禁拦死剧本会话,一串用例超时——同一条发现链只许写一遍。
 *
 * 判定标记用 hooks/dispatch.py(内核转发壳入口,比 scripts/ 目录更
 * 不易误认);MAE_FLOW_HOME 显式指定则无条件信任,错了让它响亮地错。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function discoverKernelRoot(repoRoot: string, required = false): string | undefined {
  const root = process.env.MAE_FLOW_HOME
    ?? [resolve(repoRoot, "kernel"), resolve(repoRoot, "..", "mae-flow")]
      .find((candidate) => existsSync(join(candidate, "hooks", "dispatch.py")));
  if (required && !root) {
    throw new Error("已要求内核模式，但找不到内核，拒绝降级为演示模式。"
      + "请恢复随 Cloud 发布的 kernel/，或正确配置 MAE_FLOW_HOME。"
      + "否则下单无法选择代码仓、任务也不会克隆代码。");
  }
  return root;
}
