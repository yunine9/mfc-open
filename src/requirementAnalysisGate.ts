import { resolve, relative as pathRelative, sep as pathSep, isAbsolute as pathIsAbsolute } from "node:path";
import { lstatSync } from "node:fs";
import type { GateContract } from "./gateService.ts";

/** Cloud 需求分析不是内核流程。文件工具只写分析产物目录及指定回执；Bash
 * 即使看见仓内残留脚本，也不准启动 mae-flow 生命周期。候选仓在容器
 * 层另有只读挂载，这里负责文件工具和明确命令的第二道边界。 */
export function createRequirementAnalysisGateContract(
  cwd: string,
  artifactRoot: string,
  fallback?: GateContract,
  reviewReceiptsPath?: string,
): GateContract {
  const root = resolve(artifactRoot);
  const writable = (value: string): boolean => {
    const target = resolve(cwd, value);
    if (reviewReceiptsPath && target === resolve(reviewReceiptsPath)) {
      // 指定回执不能通过软链变成对仓内业务文件的额外写权限。
      try { return lstatSync(target).isFile(); } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT";
      }
    }
    const rel = pathRelative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${pathSep}`)
      && !pathIsAbsolute(rel));
  };
  return (tool, value, event) => {
    if (tool === "Bash"
        && /(?:^|[\/\s'"`])mae[-_]?flow(?:\.py)?(?:[\s'"`]|$)|\.mae-flow\.json(?:\.exited)?/i
          .test(value)) {
      return {
        action: "deny",
        reason: "当前是需求分析，不属于 Mae-Flow 内核流程；禁止执行 init/"
          + "current/done 或读写 .mae-flow.json。请继续只读分析，并把方案"
          + "写到指定的 .mae-flow-work 目录。",
      };
    }
    if (["Edit", "Write", "MultiEdit"].includes(tool) && !writable(value)) {
      return {
        action: "deny",
        reason: `需求分析阶段只能修改分析产物目录 ${root}${reviewReceiptsPath ? `，以及逐条检视回执文件 ${reviewReceiptsPath}` : ""}；候选仓业务代码只读。`,
      };
    }
    return fallback?.(tool, value, event);
  };
}
