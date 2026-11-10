/**
 * 只读目录树的强删(独立小件,2026-09-21 自 tests/mfcTmp.ts 提出):清道夫
 * (scripts/clean-test-tmp.ts)与测试自清理(tests/mfcTmp.ts)共用——git 产物
 * 里有只读目录挡 unlink,裸 rmSync 会 EACCES 留尸(清道夫删 0 个的根因),
 * 先把沿途目录放开再删一遍。刻意不 import node:test:清道夫脚本是普通
 * 进程,挂了 after 钩子的模块它导不进来。
 */

import { chmodSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** 删一棵目录树:git 产物里有只读目录挡 unlink,先把沿途目录全放开
 *  再删一遍——删文件只需父目录可写,文件本身不用动。 */
export function forceRm(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 只读目录挡路,放开权限走重试。
  }
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) forceRm(join(dir, entry.name));
    }
  } catch {
    // 树可能已被并发清掉,最后一刀 force 会给出真相。
  }
  rmSync(dir, { recursive: true, force: true });
}
