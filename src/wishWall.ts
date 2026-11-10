/**
 * 团队许愿墙：诉求和问题共用一份追加式台账，截图单独落盘。
 *
 * 图片只接受浏览器能安全内联显示的位图，并用文件头复核类型；SVG
 * 即使伪装成 image/* 也进不来。台账不覆盖旧记录，误删、状态流转和
 * 点赞都有来路可查。
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type WishKind = "wish" | "issue";
export type WishStatus = "open" | "accepted" | "done" | "declined";

export interface WishImage {
  id: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: number;
}

export interface WishRecord {
  id: string;
  kind: WishKind;
  title: string;
  detail?: string;
  author: string;
  created_at: string;
  status: WishStatus;
  decision_note?: string;
  decided_by?: string;
  decided_at?: string;
  images: WishImage[];
  voters: string[];
}

export interface WishImageInput {
  mime_type?: unknown;
  content_base64?: unknown;
}

type WishOperation =
  | { op: "create"; record: WishRecord }
  | { op: "vote"; id: string; by: string; voted: boolean; at: string }
  | { op: "status"; id: string; status: WishStatus; note?: string;
      by: string; at: string }
  | { op: "delete"; id: string; by: string; at: string };

export class WishWallError extends Error {}
export class WishWallNotFoundError extends WishWallError {}
export class WishWallPermissionError extends WishWallError {}

export const WISH_IMAGE_LIMIT = 4;
export const WISH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const WISH_IMAGES_MAX_BYTES = 12 * 1024 * 1024;

const IMAGE_TYPES: Record<string, { extension: string; matches: (data: Buffer) => boolean }> = {
  "image/png": {
    extension: ".png",
    matches: (data) => data.length >= 8
      && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  },
  "image/jpeg": {
    extension: ".jpg",
    matches: (data) => data.length >= 3
      && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff,
  },
  "image/webp": {
    extension: ".webp",
    matches: (data) => data.length >= 12
      && data.subarray(0, 4).toString("ascii") === "RIFF"
      && data.subarray(8, 12).toString("ascii") === "WEBP",
  },
  "image/gif": {
    extension: ".gif",
    matches: (data) => data.length >= 6
      && ["GIF87a", "GIF89a"].includes(data.subarray(0, 6).toString("ascii")),
  },
};

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function decodeImage(input: WishImageInput): {
  mime: WishImage["mime_type"];
  data: Buffer;
  extension: string;
} {
  const mime = String(input?.mime_type ?? "").toLowerCase();
  const type = IMAGE_TYPES[mime];
  if (!type) {
    throw new WishWallError("图片仅支持 PNG、JPG、WebP 或 GIF");
  }
  let encoded = String(input?.content_base64 ?? "").trim();
  const dataUrl = encoded.match(/^data:([^;,]+);base64,(.+)$/s);
  if (dataUrl) {
    if (dataUrl[1].toLowerCase() !== mime) {
      throw new WishWallError("图片声明的格式前后不一致");
    }
    encoded = dataUrl[2];
  }
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/i.test(encoded.replace(/\s/g, ""))) {
    throw new WishWallError("图片内容不是有效的 Base64 数据");
  }
  const compact = encoded.replace(/\s/g, "");
  const data = Buffer.from(compact, "base64");
  if (!data.length || !type.matches(data)) {
    throw new WishWallError("图片内容与声明格式不一致");
  }
  if (data.length > WISH_IMAGE_MAX_BYTES) {
    throw new WishWallError("单张图片不能超过 5 MB");
  }
  return {
    mime: mime as WishImage["mime_type"],
    data,
    extension: type.extension,
  };
}

export class WishWallStore {
  readonly logPath: string;
  readonly imageDir: string;

  constructor(readonly root: string) {
    this.logPath = join(root, "wishes.jsonl");
    this.imageDir = join(root, "images");
  }

    list(): WishRecord[] {
    if (!existsSync(this.logPath)) return [];
    const records = new Map<string, WishRecord>();
    const deleted = new Set<string>();
    // 中段坏行跳过(协作旁路 fail-open);断写尾巴读口自愈(票 #160)
    //  ——崩溃半行不再吞掉下一次追加的愿望/点赞账。
    for (const operation of readAppendOnlyJsonl<WishOperation>(this.logPath,
      { middleCorrupt: "skip" })) {
      if (operation.op === "create" && operation.record?.id) {
        records.set(operation.record.id, {
          ...operation.record,
          images: [...(operation.record.images ?? [])],
          voters: [...(operation.record.voters ?? [])],
        });
      } else if (operation.op === "vote") {
        const record = records.get(operation.id);
        if (!record || deleted.has(operation.id)) continue;
        const voters = new Set(record.voters);
        if (operation.voted) voters.add(operation.by);
        else voters.delete(operation.by);
        record.voters = [...voters];
      } else if (operation.op === "status") {
        const record = records.get(operation.id);
        if (record && !deleted.has(operation.id)) {
          record.status = operation.status;
          record.decision_note = operation.note;
          record.decided_by = operation.by;
          record.decided_at = operation.at;
        }
      } else if (operation.op === "delete") {
        deleted.add(operation.id);
      }
    }
    return [...records.values()]
      .filter((record) => !deleted.has(record.id))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  create(input: {
    kind?: unknown;
    title?: unknown;
    detail?: unknown;
    images?: unknown;
  }, author: string): WishRecord {
    const kind: WishKind = input.kind === "issue" ? "issue" : "wish";
    const title = cleanText(input.title, 100);
    const detail = cleanText(input.detail, 2000);
    if (!title) throw new WishWallError("写一句标题，让大家知道你在期待什么");
    const rawImages = Array.isArray(input.images) ? input.images : [];
    if (rawImages.length > WISH_IMAGE_LIMIT) {
      throw new WishWallError(`一条最多放 ${WISH_IMAGE_LIMIT} 张图片`);
    }
    // 全部校验完再落盘，避免第 3 张不合格时留下前两张孤儿文件。
    const decoded = rawImages.map((image) => decodeImage(image as WishImageInput));
    if (decoded.reduce((sum, image) => sum + image.data.length, 0)
        > WISH_IMAGES_MAX_BYTES) {
      throw new WishWallError("一条消息的图片合计不能超过 12 MB");
    }
    const images = decoded.map((image) => ({
      id: randomUUID(),
      mime_type: image.mime,
      bytes: image.data.length,
    }));
    const record: WishRecord = {
      id: `wish-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      kind,
      title,
      ...(detail ? { detail } : {}),
      author: cleanText(author, 80) || "本地用户",
      created_at: new Date().toISOString(),
      status: "open",
      images,
      voters: [],
    };
    mkdirSync(this.imageDir, { recursive: true });
    const paths = decoded.map((image, index) =>
      join(this.imageDir, images[index].id + image.extension));
    try {
      decoded.forEach((image, index) => {
        writeFileSync(paths[index], image.data, { mode: 0o600 });
      });
      this.append({ op: "create", record });
    } catch (error) {
      // 发布没有进入台账时，刚写下的随机文件也必须一起回滚；否则一次
      // 磁盘故障会悄悄积攒永远无法访问、也无法从界面清理的孤儿截图。
      paths.forEach((path) => {
        try { rmSync(path, { force: true }); } catch { /* 保留原始写入错误 */ }
      });
      throw error;
    }
    return record;
  }

  setVote(id: string, by: string, voted: boolean): WishRecord {
    const record = this.require(id);
    const current = record.voters.includes(by);
    if (current !== voted) {
      this.append({ op: "vote", id, by, voted, at: new Date().toISOString() });
    }
    return this.require(id);
  }

  setStatus(id: string, status: WishStatus, by: string, note?: unknown): WishRecord {
    if (!["open", "accepted", "done", "declined"].includes(status)) {
      throw new WishWallError("未知的许愿墙状态");
    }
    const decisionNote = cleanText(note, 500);
    if (status === "declined" && !decisionNote) {
      throw new WishWallError("暂不接纳时请留一句说明，别让愿望没有下文");
    }
    this.require(id);
    this.append({
      op: "status", id, status, by,
      ...(decisionNote ? { note: decisionNote } : {}),
      at: new Date().toISOString(),
    });
    return this.require(id);
  }

  delete(id: string, by: string, admin = false): void {
    const record = this.require(id);
    if (!admin && record.author !== by) {
      throw new WishWallPermissionError("只能移除自己发布的内容");
    }
    this.append({ op: "delete", id, by, at: new Date().toISOString() });
  }

  readImage(id: string): { mime_type: WishImage["mime_type"]; data: Buffer } {
    const image = this.list().flatMap((record) => record.images)
      .find((candidate) => candidate.id === id);
    if (!image) throw new WishWallNotFoundError("图片不存在或所属内容已移除");
    const extension = IMAGE_TYPES[image.mime_type].extension;
    const path = join(this.imageDir, image.id + extension);
    if (!existsSync(path)) throw new WishWallNotFoundError("图片文件不存在");
    return { mime_type: image.mime_type, data: readFileSync(path) };
  }

  private require(id: string): WishRecord {
    const record = this.list().find((candidate) => candidate.id === id);
    if (!record) throw new WishWallNotFoundError("这条愿望不存在或已移除");
    return record;
  }

  private append(operation: WishOperation): void {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.logPath, JSON.stringify(operation) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}
