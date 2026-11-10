/** 附件流式上传：限制磁盘写入大小，不把完整日志读进服务端内存。 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
export const ATTACHMENT_MAX_BYTES = 500 * 1024 * 1024;
export function attachmentExtension(filename: string | undefined): string {
  const base = (filename ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  return /^[a-z0-9]{1,12}$/.test(ext) ? ext : "bin";
}

export async function stageAttachmentStream(
  request: IncomingMessage,
  input: { dataDir: string; filename?: string; maxBytes?: number; stagingDir?: string },
): Promise<{ path: string; bytes: number }> {
  const maxBytes = input.maxBytes ?? ATTACHMENT_MAX_BYTES;
  const ext = attachmentExtension(input.filename);
  const dir = join(input.dataDir, input.stagingDir ?? "issue-attachment-staging");
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const tmp = join(dir,
    `upload-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const sink = createWriteStream(tmp);
  const countAndHash = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        // 先掐请求源再拒绝:超限的大包体续传没有意义,流尽早停。
        request.destroy();
        callback(new Error(
          `附件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(request, countAndHash, sink);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已清理即达目的 */ }
    throw error;
  }
  const filename = `${hash.digest("hex").slice(0, 16)}.${ext}`;
  const target = join(dir, filename);
  try {
    if (existsSync(target)) unlinkSync(tmp);
    else renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 已清理即达目的 */ }
    throw error;
  }
  return { path: `attachments/${filename}`, bytes };
}
