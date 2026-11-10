/**
 * 测试套件的 /tmp 卫生:清扫 /tmp/mfc-* 中 mtime 超过 24h 且带本家族
 * 标记的残留目录(issue #34)。
 *
 * 为什么要清:进程被杀/超时/崩溃时测试的 mkdtemp 目录就留下了,多次
 * 累积后塞满 /tmp,套件批量 ENOSPC 假失败,只能手动 rm -rf 救回来。
 *
 * 分工(2026-09-07 起):重型家族(issue/assistant)已改走 tests/mfcTmp.ts
 * 的 mfcTemp() 自清理——文件跑完当场删,本脚本的"24h 安全窗"退居异常
 * 兜底,专收强杀/崩溃留下的、after 摸不到的残留。
 *
 * 为什么只敢删"过期"的:这台机器上有多个并行会话同时在跑套件,在用的
 * mfc-* 目录不能动。24h 安全窗就是给它们的——活着的测试目录 mtime 是
 * 分钟级新鲜,永远落不进清扫范围;能超窗的只有异常残留。
 *
 * 为什么还要认标记(2026-10-12 起,ADR-0061 部署期实测):mfc-* 是本仓
 * 的签名前缀,agent 会照它给 worktree/检出起名(/tmp/mfc-personal 被当
 * 残留实删一次,连带测试归因作废)。所以超窗之外加一道身份核验:只删
 * 带 mfcTemp 标记文件(.mfc-test-tmp)的目录——那是本家族自建的铁证;
 * 无标记的超窗目录(外来物,或直建 mkdtempSync 家族的旧残留)一律保留。
 * 代价:直建家族的崩溃兜底收窄(它们本就靠测试内 rmSync 自清),换来
 * 外来目录绝对安全;/tmp 已落磁盘,残留不再是 tmpfs 危机。
 *
 * npm test 入口前置本脚本。清扫只是旁路,自身任何失败都告警放行
 * (exit 0),绝不挡住测试——同本仓"旁路 fail-open"的纪律。
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { forceRm } from "../tests/mfcRm.ts";

/** 安全窗:目录 mtime 距今超过这个时长才认定是异常残留。 */
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** 家族标记文件名:mfcTemp() 建目录即落,清扫器只认它——超窗且无标记
 *  的 mfc-* 目录视为外来物(如 git worktree),一律保留。 */
export const SWEEP_MARKER = ".mfc-test-tmp";

export interface SweepResult {
  /** 删掉的目录名(不含路径)。 */
  removed: string[];
  /** 删除失败(权限/竞态)的目录名:单条告警后继续,不炸。 */
  failed: string[];
  /** 安全窗内保留的 mfc-* 目录个数(在用的,不动)。 */
  kept: number;
}

export function sweepStaleMfcTmp(
  options: { root?: string; prefix?: string; maxAgeMs?: number; now?: number } = {},
): SweepResult {
  const root = options.root ?? tmpdir();
  const prefix = options.prefix ?? "mfc-";
  const maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const result: SweepResult = { removed: [], failed: [], kept: 0 };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    // 只认目录:本仓 mkdtemp 建的全是目录,同名符号链接等异物不碰。
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const full = join(root, entry.name);
    // lstat 不跟随符号链接;stat 竞态消失(并行会话自己清掉了)按保留计,无害。
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(full).mtimeMs;
    } catch {
      result.kept += 1;
      continue;
    }
    if (now - mtimeMs <= maxAgeMs) {
      result.kept += 1;
      continue;
    }
    // 身份核验:超窗但无家族标记,是外来物(worktree/检出/别的项目),
    // 不是测试残留——保留,且不计入台账(kept 只数本家族)。
    if (!existsSync(join(full, SWEEP_MARKER))) {
      continue;
    }
    try {
      // forceRm 而非裸 rmSync:git 产物里的只读目录挡 unlink,裸删会
      // EACCES 留尸(2026-09-21 复盘:687 个超窗残留删 0 个的根因);
      // force 吞掉 ENOENT:扫到删之间被并行会话清掉,不算失败。
      forceRm(full);
      result.removed.push(entry.name);
    } catch (error) {
      // 权限/竞态等单条失败:告警后继续,这轮清不完下轮还会再来。
      result.failed.push(entry.name);
      console.warn(`[clean-test-tmp] 删除失败,跳过 ${full}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return result;
}

/** 直接执行:清扫真 /tmp 并打一行台账;被测试 import 时只出函数。 */
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { removed, failed, kept } = sweepStaleMfcTmp();
    console.log(
      `[clean-test-tmp] 清扫 ${join(tmpdir(), "mfc-*")}:删除 ${removed.length} 个(mtime>24h),` +
        `保留 ${kept} 个(安全窗内),失败 ${failed.length} 个`,
    );
  } catch (error) {
    // 扫描本身失败(如 /tmp 不可读):告警放行,测试照跑。
    console.warn(`[clean-test-tmp] 清扫失败,放行不挡测试: ${error instanceof Error ? error.message : error}`);
  }
}
