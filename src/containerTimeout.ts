/**
 * 容器内命令超时的统一机制:coreutils timeout 包命令。
 *
 * 背景(2026-09-04):TaskContainer.exec 的 timeout/Abort 语义是"销毁整
 * 个任务容器"——docker exec 的客户端超时杀不到容器内进程,销毁容器是
 * 唯一确定的了结手段。对已知耗时的合法长命令(npm install、换库构建)
 * 这是连坐:一次超时就掀掉会话容器,自愈重建又给"模型在死容器上无限
 * 重试"的循环添了燃料。收窄后的分工:命令包进容器内 timeout(独立进
 * 程组,到点 TERM 整组、kill-after 后 KILL),只了结命令进程;销毁容器
 * 降级为 timeout 自身失效时的兜底(TaskContainer.exec 的超时加余量,
 * 必须赛输容器内 timeout)。
 *
 * 第一处采用是 ops 工具(2026-09-02,commit 7df0940);AI bash 路径
 * (issueFlow/containerBash.ts)2026-09-04 跟进。两处共用本模块的常量
 * 与形状,免得"超时语义"在两个调用方各自漂移。
 */

/** 容器内 timeout 发出 TERM 后等 KILL 的宽限(秒)。 */
export const IN_CONTAINER_KILL_AFTER_S = 30;

/** TaskContainer.exec 兜底超时的追加余量:常规超时必须先在容器内
 * 了结命令进程,销毁容器只是 timeout 失效时的保险——兜底必须赛输
 * 容器内 timeout,否则就退化回"超时连坐容器"。 */
export const BACKSTOP_MARGIN_MS = 60_000;

/** GNU coreutils timeout 的约定超时退出码:到点 TERM 与 kill-after 后
 * KILL 两种了结方式都落在这个码上。 */
export const TIMEOUT_EXIT_CODE = 124;

/** shell 单引号转义:容器内命令拼装的唯一引号纪律。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** timeout 前缀(argv 形状):调用方自己接二进制+参数(ops 工具形状)。 */
export function timeoutPrefix(timeoutSeconds: number): string[] {
  const budget = Math.max(1, Math.ceil(timeoutSeconds));
  return [
    "timeout", `--kill-after=${IN_CONTAINER_KILL_AFTER_S}`, String(budget),
  ];
}

/**
 * 把任意 shell 行包进容器内 timeout。AI bash 的命令是任意 shell 行
 * (管道、&&、重写向),而 timeout 直接 execvp 程序不解析 shell——内层
 * 必须再包一层 sh -c 才能保住原命令的语义;cwd 与环境变量经 docker
 * exec -w/-e 传给外层 sh,内层照常继承,语义与不包装时一致。
 */
export function wrapShellLineWithTimeout(
  command: string,
  timeoutSeconds: number,
): string {
  return [...timeoutPrefix(timeoutSeconds), "sh", "-c", shellQuote(command)]
    .join(" ");
}

/** TaskContainer.exec 兜底超时(秒):命令预算 + 余量,保证赛输容器内
 * timeout——容器内已了结的命令永远不会等到兜底。 */
export function backstopTimeoutSeconds(timeoutSeconds: number): number {
  return Math.floor((timeoutSeconds * 1000 + BACKSTOP_MARGIN_MS) / 1000);
}
