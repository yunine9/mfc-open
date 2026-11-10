/**
 * append-only JSONL 账本的崩溃残迹自愈(issue-31/32/33 复盘,票 #160):
 * 与 EventLog 同一纪律的通用实现——进程/文件系统在 appendFileSync 落盘
 * 瞬间死掉会留下断写的尾巴(全零块/半行/缺换行),读侧修复而不是判死,
 * 也不是静默吞掉:
 *
 * - 末行崩溃残迹 → 截断丢弃 + 大声记账(丢弃字节数);
 * - 末行完好但缺换行 → 补 \n 愈合(否则下一次 append 粘行,残迹变成
 *   修不了的中间损坏);
 * - **文件中间**的坏行按账本身份分两档:
 *   - "throw":恢复必读的第二本账(EventLog)——真丢数据必须人来看;
 *   - "skip":展示/审计旁路台账——维持既有 fail-open 读语义,但大声
 *     记账,不再无声丢。
 *
 * 修复挂在读取路径上,而各账本的写路径都先读后追,保证崩溃后任何新
 * 写入之前尾巴已修掉(WAL 重放的标准纪律)。
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  ftruncateSync,
  openSync,
  readFileSync,
} from "node:fs";

export interface AppendOnlyJsonlReadOptions {
  /** 文件中间坏行的处置:"throw"=恢复必读账(EventLog);"skip"=旁路
   *  台账(跳过+大声记账,维持投影读口的 fail-open 语义)。 */
  middleCorrupt: "throw" | "skip";
  /** 记账通道;缺席退 console.error,永不静默。 */
  log?: (message: string) => void;
}

/** 读取 append-only JSONL 并自愈断写尾巴。返回全部完好行的解析结果;
 *  空白行跳过;健康文件零副作用(不写盘)。 */
export function readAppendOnlyJsonl<T = Record<string, unknown>>(
  path: string,
  options: AppendOnlyJsonlReadOptions,
): T[] {
  const note = (message: string) => (options.log ?? console.error)(message);
  if (!existsSync(path)) return [];
  const buffer = readFileSync(path);
  const segments = buffer.toString("utf-8").split("\n");
  // 尾段(split 后最后一段):文件以 \n 收尾时为空串,健康;非空即
  // 末行缺换行——断写的形状之一。
  const unterminated = segments.pop() ?? "";
  // 最后一条有内容的行:它之前的坏行=中间损坏;只有它(或无换行尾段)
  // 才够格按崩溃残迹处置。
  let lastContentIndex = -1;
  for (let index = 0; index < segments.length; index++) {
    if (segments[index].trim()) lastContentIndex = index;
  }
  const rows: T[] = [];
  let byteOffset = 0;
  let skippedMiddle = 0;
  const truncateTo = (length: number) => {
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, length);
    } finally {
      closeSync(fd);
    }
  };
  const truncateTail = (prefix: string) => {
    truncateTo(byteOffset);
    note(`${prefix}${path} 末行崩溃残迹已截断: 丢弃 `
      + `${buffer.length - byteOffset} 字节(完好行数=${rows.length}),`
      + `恢复自愈不判死;若非崩溃后首次读取,请检查写入方`);
  };
  for (const [index, line] of segments.entries()) {
    const lineBytes = Buffer.byteLength(line) + 1; // +1 = 行尾 \n
    if (line.trim()) {
      try {
        rows.push(JSON.parse(line) as T);
      } catch (cause) {
        if (index !== lastContentIndex) {
          if (options.middleCorrupt === "throw") {
            throw new Error(
              `账本损坏(${path} 第 ${index + 1} 行): ${cause}`);
          }
          skippedMiddle += 1;
        } else {
          // 末行崩溃残迹(全零块/半写):截断丢弃,大声记账,不判死。
          truncateTail("");
          return rows;
        }
      }
    }
    byteOffset += lineBytes;
  }
  if (unterminated === "") {
    if (skippedMiddle) {
      note(`${path} 中段坏行 ${skippedMiddle} 行已跳过(旁路台账纪律;`
        + `真丢数据,建议人工核对)`);
    }
    return rows;
  }
  // 无换行尾段:解析得动=完好行只差换行,补换行愈合;解析不动=半行
  // 残迹,截断。
  try {
    rows.push(JSON.parse(unterminated) as T);
    appendFileSync(path, "\n", "utf-8");
    note(`${path} 末行缺换行已愈合(补 \\n,行保留)——崩溃断写的轻损伤`);
  } catch {
    truncateTail("");
  }
  if (skippedMiddle) {
    note(`${path} 中段坏行 ${skippedMiddle} 行已跳过(旁路台账纪律;`
      + `真丢数据,建议人工核对)`);
  }
  return rows;
}
