/**
 * 检视图片资产:批注里贴的截图/设计稿,给 Agent 看的。
 *
 * 用户 2026-09-06:"图是给 Agent 看的,很多时候要给它一张图让它理解页面该
 * 怎么设计"。Agent 侧已有 inspect_image 工具(视觉网关),只接受**任务工作区
 * 相对路径**——所以图片必须落进 Agent 的工作区。存两份:
 * - 任务目录 `<workspace>/reviews/assets/` 是真相(工作区会被回收/重建);
 * - 运行工作区 `<cwd>/.mae-flow-work/review-assets/` 是 Agent 读到的那份,
 *   现场重建时按 materializeReviewAssets 重新铺一遍(与需求图片同一套路)。
 * 文件名按内容哈希:同一张图贴几次只存一份;扩展名按魔数判定,不信客户端。
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_ASSET_ROOT = ".mae-flow-work/review-assets";
export const REVIEW_ASSET_STORE = join("reviews", "assets");
export const REVIEW_ASSET_MAX_BYTES = 8 * 1024 * 1024;

export interface ReviewAssetMeta {
  /** Agent 可直接交给 inspect_image 的工作区相对路径。 */
  path: string;
  mime_type: string;
  bytes: number;
}

export class ReviewAssetError extends Error {}

const TYPES: Array<{ ext: string; mime: string; matches: (b: Buffer) => boolean }> = [
  { ext: ".png", mime: "image/png", matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: ".jpg", mime: "image/jpeg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ".gif", mime: "image/gif", matches: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { ext: ".webp", mime: "image/webp", matches: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export function sniffImageType(bytes: Buffer): { ext: string; mime: string } | undefined {
  return TYPES.find((type) => type.matches(bytes));
}

/** 只认本模块产出的路径形状:根目录固定、文件名是 24 位哈希加已知扩展名。 */
export function isReviewAssetPath(path: string): boolean {
  return /^\.mae-flow-work\/review-assets\/[0-9a-f]{24}\.(?:png|jpg|gif|webp)$/.test(path);
}

export function storeReviewAsset(
  taskWorkspace: string,
  runtimeWorkspace: string | undefined,
  bytes: Buffer,
): ReviewAssetMeta {
  if (!bytes.length) throw new ReviewAssetError("图片是空的");
  if (bytes.length > REVIEW_ASSET_MAX_BYTES) {
    throw new ReviewAssetError(`图片超过 ${REVIEW_ASSET_MAX_BYTES / 1024 / 1024} MB`);
  }
  const type = sniffImageType(bytes);
  if (!type) throw new ReviewAssetError("只支持 PNG / JPEG / GIF / WebP 图片");
  const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 24)}${type.ext}`;
  const store = join(taskWorkspace, REVIEW_ASSET_STORE);
  mkdirSync(store, { recursive: true });
  const stored = join(store, name);
  if (!existsSync(stored)) writeFileSync(stored, bytes);
  if (runtimeWorkspace) mirrorOne(stored, runtimeWorkspace, name);
  return { path: `${REVIEW_ASSET_ROOT}/${name}`, mime_type: type.mime, bytes: bytes.length };
}

function mirrorOne(stored: string, runtimeWorkspace: string, name: string): void {
  const dir = join(runtimeWorkspace, ...REVIEW_ASSET_ROOT.split("/"));
  mkdirSync(dir, { recursive: true });
  const target = join(dir, name);
  if (!existsSync(target)) copyFileSync(stored, target);
}

/** 现场重建后把任务目录里的图重新铺进 Agent 工作区(旁路:失败不炸任务)。 */
export function materializeReviewAssets(taskWorkspace: string, runtimeWorkspace: string): void {
  const store = join(taskWorkspace, REVIEW_ASSET_STORE);
  if (!existsSync(store)) return;
  for (const name of readdirSync(store)) {
    if (isReviewAssetPath(`${REVIEW_ASSET_ROOT}/${name}`)) mirrorOne(join(store, name), runtimeWorkspace, name);
  }
}

export function readReviewAsset(
  taskWorkspace: string,
  path: string,
): { mime_type: string; content: Buffer } | undefined {
  if (!isReviewAssetPath(path)) return undefined;
  const name = path.slice(REVIEW_ASSET_ROOT.length + 1);
  const stored = join(taskWorkspace, REVIEW_ASSET_STORE, name);
  if (!existsSync(stored)) return undefined;
  const content = readFileSync(stored);
  const type = sniffImageType(content);
  return type ? { mime_type: type.mime, content } : undefined;
}
