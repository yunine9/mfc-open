import { closeSync, lstatSync, openSync, readSync } from "node:fs";

/** 浏览器上传没有 Unix 权限信息；按解释器声明或程序头识别可执行文件。
 * 已有包的执行位也保留，覆盖手动安装的 CLI 和版本回退。 */
export function isExecutableSkillFile(path: string): boolean {
  if (lstatSync(path).mode & 0o111) return true;
  const header = Buffer.alloc(8);
  const fd = openSync(path, "r");
  let bytes: number;
  try { bytes = readSync(fd, header, 0, header.length, 0); }
  finally { closeSync(fd); }
  if (bytes >= 2 && header[0] === 0x23 && header[1] === 0x21) return true;
  if (bytes < 4) return false;
  const magic = header.subarray(0, 4).toString("hex");
  if ([
    "7f454c46", // Linux ELF
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", // Mach-O
  ].includes(magic)) return true;
  // Java class 同样以 cafebabe 开头；Universal Mach-O 后接架构数量。
  if (bytes < 8) return false;
  const count = ["cafebabe", "cafebabf"].includes(magic) ? header.readUInt32BE(4)
    : ["bebafeca", "bfbafeca"].includes(magic) ? header.readUInt32LE(4) : 0;
  return count > 0 && count <= 32;
}
