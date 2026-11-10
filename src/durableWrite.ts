/**
 * 状态权威文件的耐久写(issue-31/32/33 复盘,票 #163,2026-09-10
 * 拍板落地):tmp → fsync → rename。
 *
 * 只给"每次状态保存才写一次"的文件用(issue.json/task.json/
 * waiting.json)。fsync 实测 3.2ms/次(生产同款 WSL2 宿主),状态保存
 * 的频率下可忽略;硬断电后 rename 顶上来的必然是刷过盘的完整内容,
 * 全零块(issue-31/32/33 的事故形状)在这一层被掐死——最坏退回上一版
 * 内容,丢崩溃瞬间的最后一笔,而不是整份不可读。
 *
 * append 台账(events.jsonl 等)不适用:每事件 3.2ms 不可接受,防线在
 * 读侧末行自愈(jsonlTailRepair),别把这把钥匙用错门。
 */

import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";

export function durableWriteFileSync(
  path: string,
  data: string,
  options?: { mode?: number },
): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, data, {
    encoding: "utf-8",
    ...(options?.mode !== undefined ? { mode: options.mode } : {}),
  });
  const fd = openSync(temporary, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
