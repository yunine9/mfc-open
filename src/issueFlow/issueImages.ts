/**
 * 登记现象描述内嵌截图(#47):手工登记的图片上传落盘与工作区同步。
 *
 * 与 ticketImages.ts(DTS 单据内嵌图)同款架构红线:图片本体绝不进
 * 主模型上下文,进上下文的只有描述文本里的工作区相对路径引用。
 *
 * 数据流:
 *   前端粘贴/拖拽 → POST /issues/issue-image(raw binary)
 *     → 落 <dataDir>/issue-image-staging/<sha256前16>.<ext>(content-addressed)
 *     → 返回 path = "issue-images/<hash>.<ext>"
 *     → textarea 光标处插入 ![截图](issue-images/<hash>.<ext>)
 *   提交登记 → create() 调 syncIssueImagesToWorkspace
 *     → 从 staging 复制到 <issue-root>/issue-images/<hash>.<ext>
 *     → description 不改写(保持工作区相对路径,AI 直接 inspect_image)
 *
 * staging 全局共享(content-addressed,哈希去重);工作区副本按会话隔离,
 * AI 侧 inspect_image 按工作区相对路径识图,与 ticketImages 同口径。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";

/** 单张上限,与 ticketImages / inspect_image 的源图上限一致。 */
export const ISSUE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** staging 目录名(全局共享,content-addressed)。 */
const STAGING_DIR = "issue-image-staging";

/** description 里引用的工作区相对目录名。 */
export const ISSUE_IMAGE_DIR = "issue-images";

/** 图片扩展名:先认魔数(与 ticketImages / inspect_image 同款判定),
 * content-type 兜底,实在认不出给 img(不影响落盘)。 */
function imageExtension(data: Buffer, contentType: string): string {
  const at = (...values: number[]) => values.every((value, index) =>
    data[index] === value);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0xff, 0xd8, 0xff)) return "jpg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0x42, 0x4d)) return "bmp";
  if (at(0x52, 0x49, 0x46, 0x46)
      && data[8] === 0x57 && data[9] === 0x45
      && data[10] === 0x42 && data[11] === 0x50) {
    return "webp";
  }
  const byType: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp",
  };
  return byType[contentType.split(";")[0].trim().toLowerCase()] ?? "img";
}

/** 扩展名 → MIME 类型(回显时定 content-type)。staging 回显与会话
 * 工作区图片回显(workspaceImages)共用这一份,不复制第二份。 */
export const EXT_TO_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", img: "application/octet-stream",
};

/** staging 目录的绝对路径。 */
function stagingRoot(dataDir: string): string {
  return join(dataDir, STAGING_DIR);
}

/** 校验前端回传的 path 形态:必须是 issue-images/<hex16>.<ext>,不含
 * 分隔符或 .. 段(路径穿越拒之门外)。返回 { hash, ext } 或 undefined。 */
function parseIssueImagePath(path: string): { hash: string; ext: string } | undefined {
  // path 形如 "issue-images/abcd1234ef567890.png"
  const match =
    new RegExp(`^${ISSUE_IMAGE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([0-9a-f]{16})\\.([a-z]+)$`, "i")
      .exec(path);
  if (!match) return undefined;
  return { hash: match[1], ext: match[2].toLowerCase() };
}

/** staging 文件名:<hash>.<ext>(与工作区副本同名)。 */
function stagingFilename(hash: string, ext: string): string {
  return `${hash}.${ext}`;
}

/**
 * 把上传的图片落 staging,返回工作区相对路径引用(进 description)。
 * content-addressed:同内容只存一份(哈希同名跳过写入)。
 */
export function stageIssueImage(input: {
  data: Buffer;
  contentType: string;
  dataDir: string;
}): { path: string; bytes: number } {
  const { data, contentType, dataDir } = input;
  if (data.length > ISSUE_IMAGE_MAX_BYTES) {
    throw new Error(
      `图片 ${Math.round(data.length / 1024 / 1024)}MB,超过单张 `
      + `${Math.round(ISSUE_IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限`);
  }
  const ext = imageExtension(data, contentType);
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  const dir = stagingRoot(dataDir);
  const filename = stagingFilename(hash, ext);
  const target = join(dir, filename);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(target)) {
    // 同内容不重复写入(content-addressed 去重)。
    const tmp = join(dir, `${filename}.tmp`);
    writeFileSyncAtomic(tmp, target, data);
  }
  return {
    path: `${ISSUE_IMAGE_DIR}/${filename}`,
    bytes: data.length,
  };
}

/** 原子写:先写 .tmp 再 rename,防并发读到半截文件。 */
function writeFileSyncAtomic(tmp: string, target: string, data: Buffer): void {
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/**
 * 读取 staging 里的图片(回显用)。path 必须是 issue-images/<hash>.<ext>。
 * 返回二进制与 MIME 类型;不存在或非法返回 undefined。
 */
export function readStagedImage(input: {
  path: string;
  dataDir: string;
}): { data: Buffer; mime_type: string } | undefined {
  const parsed = parseIssueImagePath(input.path);
  if (!parsed) return undefined;
  const file = join(stagingRoot(input.dataDir), stagingFilename(parsed.hash, parsed.ext));
  if (!existsSync(file)) return undefined;
  return {
    data: readFileSync(file),
    mime_type: EXT_TO_MIME[parsed.ext] ?? "application/octet-stream",
  };
}

/** description 里所有 issue-images/<hash>.<ext> 引用(去重,按出现序)。 */
export function extractIssueImagePaths(description: string | undefined): string[] {
  if (!description) return [];
  const pattern =
    new RegExp(`${ISSUE_IMAGE_DIR.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[0-9a-f]{16}\\.[a-z]+`, "gi");
  const paths: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(description)) !== null) {
    if (!seen.has(match[0])) {
      seen.add(match[0]);
      paths.push(match[0]);
    }
  }
  return paths;
}

/**
 * 登记 create() 时调用:把 description 引用的图片从 staging 复制到
 * 会话工作区 issue-images/ 目录。description 不改写——引用已是工作区
 * 相对路径,AI 侧 inspect_image 直接可用。
 *
 * fail-open:单图复制失败只跳过(可能 staging 已被清理),不阻断登记;
 * 调用方记日志。
 */
export function syncIssueImagesToWorkspace(input: {
  description: string;
  dataDir: string;
  workspace: string;
  log?: (message: string) => void;
}): { copied: number; missing: number } {
  const paths = extractIssueImagePaths(input.description);
  if (!paths.length) return { copied: 0, missing: 0 };

  const workspaceRoot = resolve(input.workspace);
  const targetDir = resolve(join(workspaceRoot, ISSUE_IMAGE_DIR));
  if (!targetDir.startsWith(workspaceRoot + sep)) {
    // 越界保护:理论上不会触发(parseIssueImagePath 已限定形态)。
    input.log?.(`[issue-images] 目标目录越出工作区,跳过 ${paths.length} 张`);
    return { copied: 0, missing: paths.length };
  }
  mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  let missing = 0;
  for (const path of paths) {
    const parsed = parseIssueImagePath(path);
    if (!parsed) { missing += 1; continue; }
    const source = join(stagingRoot(input.dataDir), stagingFilename(parsed.hash, parsed.ext));
    const target = join(targetDir, stagingFilename(parsed.hash, parsed.ext));
    if (!existsSync(source)) {
      missing += 1;
      input.log?.(`[issue-images] staging 缺失: ${path}`);
      continue;
    }
    if (!existsSync(target)) copyFileSync(source, target);
    copied += 1;
  }
  input.log?.(`[issue-images] 同步 ${copied} 张到工作区,缺失 ${missing}`);
  return { copied, missing };
}
