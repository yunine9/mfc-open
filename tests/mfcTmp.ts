/**
 * 测试临时目录的自清理(2026-09-07,/tmp 反复打满的治理):重型家族
 * (issue 与 assistant 两个家族)的 mkdtemp 改走 mfcTemp(),文件跑完由
 * 顶层 after 当场删掉——不再把清理指望在"下一轮测试开头的清道夫"上
 * (强杀常态化的套件里下一轮不一定来,而清道夫的 24h 安全窗又永远
 * 收不走当天的残留,只进不出,一天就能塞满 tmpfs)。
 *
 * 归属精确:只删本进程经 mfcTemp 建出来的目录,并行的套件互不误伤。
 * after 在本模块被 import 时(测试文件的收集期)注册,总是执行——
 * 要留红灯案发现场时用 MFC_TEST_KEEP_TMP=1 保留。清道夫
 * (clean-test-tmp.ts)退居异常兜底:强杀/崩溃时 after 不会执行,
 * 那部分残留仍由它在 24h 后收走。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { SWEEP_MARKER, sweepStaleMfcTmp } from "../scripts/clean-test-tmp.ts";
import { forceRm } from "./mfcRm.ts";

export { forceRm };

// 清扫脱钩 npm test(2026-09-21,#34 复发复盘):定向跑(npx tsx --test
// file)绕过 npm test 的前置清道夫,残留只会越积越多——任何测试入口
// 只要 import 本模块就先扫一次,24h 安全窗不变,fail-open 不挡测试。
// 只在真收走了东西或删失败时打一行,套件并行 71 个进程不刷屏。
try {
  const { removed, failed } = sweepStaleMfcTmp();
  if (removed.length || failed.length) {
    console.warn(`[mfcTmp] 加载即扫:删除 ${removed.length} 个超窗残留,`
      + `${failed.length} 个删除失败(权限/竞态)`);
  }
} catch {
  // 扫描失败(权限/竞态)不挡测试,下一轮再收。
}

const created = new Set<string>();

after(() => {
  if (process.env.MFC_TEST_KEEP_TMP) return;
  for (const dir of created) forceRm(dir);
});

/** mkdtempSync 的自清理替身:前缀照旧(mfc-<家族>-),多记一笔账。
 *  同时落家族标记(SWEEP_MARKER):清扫器只删带标记的超窗目录——
 *  没有它,agent 照本前缀起的 worktree/检出会被当残留误删
 *  (2026-10-12 /tmp/mfc-personal 实毁,详见 clean-test-tmp.ts 头注)。 */
export function mfcTemp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, SWEEP_MARKER),
    new Date().toISOString() + "\n");
  created.add(dir);
  return dir;
}
