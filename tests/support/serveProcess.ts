/**
 * 起真 serve 子进程的统一入口(给需要真 HTTP 的测试用)。
 *
 * 为什么不用 `node_modules/.bin/tsx`:那是个包装脚本,它自己再 spawn 一个
 * node 子进程。**SIGTERM 它会转发,SIGKILL 转发不了**——包装进程当场死掉,
 * 真正在监听端口的 node 变成孤儿活下去。
 *
 * 这不是理论问题:2026-08-22 清场时在本机逮到 **57 个** `mfc-epipe-*` 孤儿
 * serve,最老的活了 2 天 12 小时,加起来约 3GB。serveBrokenPipe 用例收尾
 * 固定 SIGKILL,所以**每跑一次漏一个**;另外两个只在超时路径上漏。
 * (第一次数成 10 个,是我自己的统计管道上挂了 `| head` ——数孤儿也得
 * 有个不撒谎的数法。)
 * harness/restart-drill.sh 早就踩过同一个坑并记在注释里,测试这边没跟上。
 *
 * 直接用 `node --import tsx` 起,被 kill 的就是 serve 本体,没有中间人。
 */

import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { join } from "node:path";

export const SERVE_ENTRY = join(process.cwd(), "src", "serve.ts");

/** 返回类型保住 stdout/stderr 非空:调用方都要读启动日志或掐管道。 */
export function spawnServe(
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ["--import", "tsx", SERVE_ENTRY, ...args],
    {
      ...options,
      env: {
        MAE_FLOW_NO_NOTIFY: "1",
        ...process.env,
        ...(options.env ?? {}),
      },
    },
  );
}
