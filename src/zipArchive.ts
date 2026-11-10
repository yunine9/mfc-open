/**
 * 极小的 ZIP 生成器：只为服务端把少量已知文件打成标准 ZIP。
 *
 * 不落临时目录、不调用宿主 zip 命令，部署镜像无需额外依赖。条目名
 * 在这里统一做 zip-slip 防护；调用方仍负责限制文件数量与总字节数。
 */

import { deflateRawSync } from "node:zlib";

export interface ZipArchiveEntry {
  name: string;
  content: Buffer;
  modifiedAt?: Date;
}

const UTF8_FLAG = 0x0800;
const ZIP_VERSION = 20;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  CRC32_TABLE[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function safeEntryName(raw: string): string {
  const name = String(raw ?? "").replaceAll("\\", "/");
  if (!name || name.includes("\0") || name.startsWith("/")
      || name.split("/").some((part) => part === "..")) {
    throw new Error(`ZIP 条目名不合法:${raw}`);
  }
  return name;
}

/** ZIP 使用 DOS 本地时间字段。这里固定按 UTC 写，避免部署机器时区让
 * 同一个 mtime 产生不同包；ZIP 时间最早只能表达 1980 年。 */
function dosDateTime(input?: Date): { date: number; time: number } {
  const candidate = input && Number.isFinite(input.getTime())
    ? input : new Date();
  const year = Math.min(Math.max(candidate.getUTCFullYear(), 1980), 2107);
  const month = candidate.getUTCMonth() + 1;
  const day = candidate.getUTCDate();
  const hours = candidate.getUTCHours();
  const minutes = candidate.getUTCMinutes();
  const seconds = Math.floor(candidate.getUTCSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds,
  };
}

/** 生成非 ZIP64 档案。Markdown 通常压缩收益明显；若压缩后反而更大，
 * 自动改用 store，避免“打包”让文件膨胀。 */
export function createZipArchive(entries: ZipArchiveEntry[]): Buffer {
  if (entries.length > MAX_UINT16) throw new Error("ZIP 条目数量超过 65535");

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(safeEntryName(entry.name), "utf-8");
    if (name.length > MAX_UINT16) throw new Error("ZIP 条目名过长");
    if (entry.content.length > MAX_UINT32) throw new Error("ZIP 单条目超过 4 GiB");

    const deflated = deflateRawSync(entry.content);
    const stored = deflated.length >= entry.content.length;
    const method = stored ? 0 : 8;
    const packed = stored ? entry.content : deflated;
    const checksum = crc32(entry.content);
    const stamp = dosDateTime(entry.modifiedAt);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // Unix, ZIP 2.0
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + packed.length;
    if (localOffset > MAX_UINT32) throw new Error("ZIP 档案超过 4 GiB");
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (centralDirectory.length > MAX_UINT32
      || localOffset + centralDirectory.length > MAX_UINT32) {
    throw new Error("ZIP 档案超过 4 GiB");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
