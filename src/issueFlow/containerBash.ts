/**
 * 问题流 AI bash 的容器内执行适配(BashOperations 的容器实现)。
 *
 * 2026-09-04:超时语义按 ops 工具的同款模式收窄(commit 7df0940 的
 * 路径跟进)——此前 execOptions 原样透传,沿用 TaskContainer.exec 的
 * "超时=销毁容器",一次 npm install 超时就掀掉会话容器;ensureContainer
 * 的自愈重建又把销毁变得廉价,模型不知道停手,2940 次重试循环 1.5 小时
 * 就是这么烧出来的。现在超时的第一响应在容器内:命令包进 coreutils
 * timeout(独立进程组,TERM 整组→KILL),只了结命令进程,容器不动;
 * exec 的销毁式超时加余量退为 timeout 失效时的兜底。机制本体在
 * src/containerTimeout.ts,ops 与 bash 共用一份真相。
 *
 * 诚实边界:Abort 语义不变——用户打断回合仍销毁容器(回合已被取消,
 * 下回合 ensureContainer 重建);收窄的只有 timeout 路径。
 * 124 的判定是约定退出码,不做哨兵复核(ops 有工具自己的成功哨兵,
 * bash 命令无哨兵可言);极少数自己返回 124 的命令会多看到一行说明,
 * 无害。
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { prePushCommandTimeoutSeconds, type PrePushExecutionBudget } from "../prepushBuildPlaybook.ts";
import type { TaskContainer } from "../containerRuntime.ts";
import {
  backstopTimeoutSeconds,
  TIMEOUT_EXIT_CODE,
  wrapShellLineWithTimeout,
} from "../containerTimeout.ts";

/** 超时被容器内 timeout 了结时,给模型补的一行说明:说清容器没受影响、
 * 想要更长预算该怎么办。经 onData 混入输出,模型与页面都能看到。 */
function timeoutNote(timeoutSeconds: number): string {
  return `\n[mae-flow] 命令超过 ${timeoutSeconds}s 预算,已由容器内 timeout `
    + `终止(只终止了本命令的进程组,会话容器不受影响)。若命令确实需要`
    + `更久,重试时给 Bash 传更大的 timeout 参数。`;
}

/** 不捕获容器实例:容器可能因超时/OOM/兜底销毁后被 ensureContainer
 * 重建,闭包里的旧引用会永远指向死容器——每次 exec 动态取当前实例。
 *
 * forwardAbort=false(预热会话专用):不向容器转发 AbortSignal。
 * 预热预算到点的 driver.abort() 是系统发起的打断,signal 若透传,
 * containerRuntime 的 Abort 语义会销毁与主 Agent 共享的任务容器——
 * 正好把预热焐热的缓存连坐清掉。剥离后,预算到点只收会话,命令按
 * 自己的容器内 timeout(或自然完成)收尾;用户主动打断走主会话,
 * Abort 语义不变。 */
export function createContainerBashOperations(
  getContainer: () => Pick<TaskContainer, "exec"> | undefined,
  options: { forwardAbort?: boolean; buildBudget?: PrePushExecutionBudget } = {},
): BashOperations {
  const forwardAbort = options.forwardAbort ?? true;
  return {
    exec: (command, dir, execOptions) => {
      const container = getContainer();
      if (!container) {
        throw new Error("会话容器不在场,拒绝执行(回合开始前应已拉起)");
      }
      const timeoutSeconds = options.buildBudget
        ? prePushCommandTimeoutSeconds(command, execOptions.timeout, options.buildBudget) : execOptions.timeout;
      const forwarded = forwardAbort
        ? execOptions
        : { ...execOptions, signal: undefined };
      if (timeoutSeconds === undefined) {
        return container.exec(command, dir, forwarded);
      }
      return container
        .exec(wrapShellLineWithTimeout(command, timeoutSeconds), dir, {
          ...forwarded,
          timeout: backstopTimeoutSeconds(timeoutSeconds),
        })
        .then((result) => {
          if (result.exitCode === TIMEOUT_EXIT_CODE) {
            execOptions.onData(Buffer.from(timeoutNote(timeoutSeconds)));
          }
          return result;
        });
    },
  };
}
