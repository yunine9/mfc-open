/**
 * DTS 单号→自动接单排除标记(ADR-0070):用户点名"这张单别被定时
 * 扫描自动接走"的单级事实。扫描器在服务端跑,标记落平台侧服务端
 * 存储(浏览器 localStorage 出局——换台电脑标记就丢了);按单号全局
 * 一份,DTS 改派责任人后标记留在单上。
 *
 * 从简——仿 dtsModuleBindings 的姿态:一个 JSON 文件、读全量/写单条
 * 两个动作,并发写 last-write-wins,记 updated_by/updated_at 供审计
 * 对账。条目在场=排除;取消即删条目,不留墓碑。能看见这单就能改,
 * 与「单号→模块映射」同尺(团队共享事实,人人可写、无审批);但改写
 * 接口留在登录闸后,操作人取登录身份(ADR-0069 结构性默认)。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const FILE = "dts-auto-claim-exclusions.json";
/** 与问题流服务端的单号同一把尺(service.ts 的 TICKET_PATTERN 镜像,
 *  亦与 dtsModuleBindings 同款)。 */
const TICKET = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export class DtsAutoClaimExclusionError extends Error {}

export interface DtsAutoClaimExclusionEntry {
  updated_by: string;
  updated_at: string;
}

export interface DtsAutoClaimExclusionFile {
  version: 1;
  exclusions: Record<string, DtsAutoClaimExclusionEntry>;
}

function exclusionsFile(dataDir: string): string {
  return join(dataDir, FILE);
}

/** 读全量排除表。文件缺席或损坏一律当空(旁路数据不反噬主流程),
 *  写入时会原样重建。 */
export function readDtsAutoClaimExclusions(
  dataDir: string,
): Record<string, DtsAutoClaimExclusionEntry> {
  const path = exclusionsFile(dataDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed?.version !== 1 || typeof parsed.exclusions !== "object"
        || parsed.exclusions === null) return {};
    return parsed.exclusions as Record<string, DtsAutoClaimExclusionEntry>;
  } catch {
    return {};
  }
}

/** 写单条:excluded=true 落条目(在场=排除,last-write-wins 留痕);
 *  excluded=false 删条目(没有条目也当取消成功,幂等)——不留墓碑,
 *  「允许」就是文件里没有这张单。返回落盘后的条目(取消时无)。 */
export function setDtsAutoClaimExclusion(
  dataDir: string,
  ticket: string,
  excluded: boolean,
  updatedBy: string,
): { entry?: DtsAutoClaimExclusionEntry } {
  const id = ticket.trim();
  if (!TICKET.test(id)) {
    throw new DtsAutoClaimExclusionError(
      `单号 ${id || "(空)"} 格式不合法:只能是字母数字下划线连字符`);
  }
  const by = updatedBy.trim();
  if (!by) throw new DtsAutoClaimExclusionError("缺少操作人账号");
  const exclusions = readDtsAutoClaimExclusions(dataDir);
  let entry: DtsAutoClaimExclusionEntry | undefined;
  if (excluded) {
    entry = { updated_by: by, updated_at: new Date().toISOString() };
    exclusions[id] = entry;
  } else {
    delete exclusions[id];
  }
  const path = exclusionsFile(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    version: 1,
    exclusions,
  } satisfies DtsAutoClaimExclusionFile, null, 1), "utf-8");
  renameSync(temporary, path);
  return { ...(entry ? { entry } : {}) };
}
