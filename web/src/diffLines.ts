/**
 * diff 行 → 新文件行号。批注定位的地基,所以单独成文件:web/ 没有测试
 * 运行器,拆出来根测试才钉得住它(算错一位,所有代码批注都指错地方)。
 */

/**
 * 每一行在**新文件**里的真实行号,从 `@@ -a,b +c,d @@` 的 c 起递推。
 *
 * 批注要落成 `SmsHandler.java:23`,不是"diff 里第 8 行"——后者对模型
 * 毫无意义,它手上的文件里没有"diff 第几行"这回事。删除行不占新文件的
 * 行号(它在新文件里已经不存在),所以只有上下文行和新增行往前走。
 * 拿不到行号的行(diff 头、hunk 头)返回 0,由调用方决定不给锚点。
 */
export function newFileLines(lines: string[]): number[] {
  const numbers: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    if (line === "") {
      // split("\n") leaves a trailing separator; an actual empty context line starts with a space.
      numbers.push(0);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      cursor = Number(hunk[1]);
      numbers.push(0);
      continue;
    }
    if (!cursor || /^diff --git |^index |^--- |^\+\+\+ |^\?\? /.test(line)) {
      numbers.push(0);
      continue;
    }
    if (/^-/.test(line)) {
      numbers.push(0);          // 删除行在新文件里不存在,不占行号
      continue;
    }
    numbers.push(cursor);
    cursor += 1;
  }
  return numbers;
}

export type DiffCellKind = "context" | "added" | "removed";

export interface DiffCell {
  number: number;
  text: string;
  kind: DiffCellKind;
  /** 行内真正变化的字符区间 [start, end)。只在删除/新增行按位置配对
   * 且两侧行文本存在公共前后缀时给出——渲染层据此加 <mark>,让人一眼
   * 看到"这行到底改了哪几个字"而不是逐字肉眼对比。锚定安全:mark 不
   * 改变 textContent,批注取 [data-code] 原文不受影响。 */
  emphasis?: [number, number];
}

/** 给配对的删除/新增行标注行内差异区间(公共前缀/后缀之外的中段)。
 * 整行都不同(无公共部分)时不标——全行高亮等于没高亮。 */
function markIntralineChange(removed: DiffCell, added: DiffCell): void {
  const before = removed.text;
  const after = added.text;
  if (!before || !after || before === after) return;
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  if (prefix === 0 && suffix === 0) return;
  removed.emphasis = [prefix, before.length - suffix];
  added.emphasis = [prefix, after.length - suffix];
}

export type DiffReviewRow =
  | { type: "line"; old?: DiffCell; next?: DiffCell }
  | { type: "hunk" | "meta"; text: string };

/**
 * 统一 diff → 双栏审阅行。删除块与紧随其后的新增块按位置配对，
 * 这样修改前/修改后能横向比较；行号始终来自 hunk 头而不是数组下标。
 */
export function diffReviewRows(lines: string[]): DiffReviewRow[] {
  const rows: DiffReviewRow[] = [];
  let oldCursor = 0;
  let newCursor = 0;
  let removed: DiffCell[] = [];
  let added: DiffCell[] = [];

  const flushChanges = () => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      const row: Extract<DiffReviewRow, { type: "line" }> = { type: "line" };
      if (removed[index]) row.old = removed[index];
      if (added[index]) row.next = added[index];
      if (removed[index] && added[index]) {
        markIntralineChange(removed[index], added[index]);
      }
      rows.push(row);
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line === "") continue;
    const hunk = line.match(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/,
    );
    if (hunk) {
      flushChanges();
      oldCursor = Number(hunk[1]);
      newCursor = Number(hunk[2]);
      rows.push({ type: "hunk", text: line });
      continue;
    }
    if (/^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode )/.test(line)) {
      continue;
    }
    if (/^\\ No newline at end of file/.test(line)) {
      flushChanges();
      rows.push({ type: "meta", text: "文件末尾没有换行符" });
      continue;
    }
    if (!oldCursor && !newCursor) {
      if (line.trim()) rows.push({ type: "meta", text: line });
      continue;
    }
    if (line.startsWith("-")) {
      removed.push({ number: oldCursor, text: line.slice(1), kind: "removed" });
      oldCursor += 1;
      continue;
    }
    if (line.startsWith("+")) {
      added.push({ number: newCursor, text: line.slice(1), kind: "added" });
      newCursor += 1;
      continue;
    }
    flushChanges();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      type: "line",
      old: { number: oldCursor, text, kind: "context" },
      next: { number: newCursor, text, kind: "context" },
    });
    oldCursor += 1;
    newCursor += 1;
  }
  flushChanges();
  return rows;
}

/** Unified view keeps each deletion block before its replacement, with original source line numbers. */
export function unifiedDiffRows(rows: readonly DiffReviewRow[]): DiffReviewRow[] {
  const result: DiffReviewRow[] = [];
  let removed: DiffReviewRow[] = [], added: DiffReviewRow[] = [];
  const flush = () => { result.push(...removed, ...added); removed = []; added = []; };
  for (const row of rows) {
    if (row.type === 'line' && (row.old?.kind === 'removed' || row.next?.kind === 'added')) {
      if (row.old) removed.push({type:'line', old:row.old});
      if (row.next) added.push({type:'line', next:row.next});
    } else { flush(); result.push(row); }
  }
  flush();
  return result;
}
