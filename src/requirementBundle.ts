/** 需求图片的任务存储与工作区副本；文档解析统一走 documentConversion。 */
import { createHash } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RequirementDocumentMeta } from "./requirementDocument.ts";

export const REQUIREMENT_BUNDLE_ASSET_ROOT = ".mae-flow-work/requirement-assets";

export type RequirementImageMime =
  | "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface RequirementAssetMeta {
  path: string;
  source_path: string;
  mime_type: RequirementImageMime;
  bytes: number;
  digest: string;
}

export interface RequirementAsset extends RequirementAssetMeta {
  content: Buffer;
}

export class RequirementBundleError extends Error {}

function writeNoFollow(path: string, content: Buffer): void {
  const descriptor = openSync(path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC
      | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, content); } finally { closeSync(descriptor); }
}

export function storeRequirementAssets(workspace: string, assets: RequirementAsset[]): void {
  let directory = workspace;
  for (const segment of [".mae-flow-work", "requirement-assets"]) {
    directory = join(directory, segment);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new RequirementBundleError("需求图片目录不是安全的普通目录");
    }
  }
  for (const asset of assets) writeNoFollow(join(workspace, asset.path), asset.content);
}

export function loadRequirementAssets(
  workspace: string,
  meta: RequirementDocumentMeta | undefined,
): RequirementAsset[] {
  return (meta?.assets ?? []).map((asset) => {
    const content = readFileSync(join(workspace, asset.path));
    const digest = createHash("sha256").update(content).digest("hex");
    if (digest !== asset.digest || content.length !== asset.bytes) {
      throw new RequirementBundleError(`需求图片已损坏：${asset.source_path}`);
    }
    return { ...asset, content };
  });
}

export function materializeRequirementAssets(
  taskWorkspace: string,
  runtimeWorkspace: string,
  meta: RequirementDocumentMeta | undefined,
): void {
  storeRequirementAssets(runtimeWorkspace, loadRequirementAssets(taskWorkspace, meta));
}

export function readRequirementAsset(
  workspace: string,
  meta: RequirementDocumentMeta | undefined,
  requestedPath: string,
): { meta: RequirementAssetMeta; content: Buffer } | undefined {
  const asset = meta?.assets?.find((item) => item.path === requestedPath);
  if (!asset) return undefined;
  const content = readFileSync(join(workspace, asset.path));
  return { meta: asset, content };
}
