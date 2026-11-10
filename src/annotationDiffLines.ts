/** 提取指定文件在统一 diff 中的变更后行；数组下标不是代码行号。 */
export function annotationDiffLines(text: string, file: string): {
  text: string; numbers: number[];
} {
  const rows: string[] = [];
  const numbers: number[] = [];
  let current = "";
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (header) { current = header[2]; line = 0; }
    if (current !== file) continue;
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      // 不允许全文匹配把两个不连续的 hunk 拼成同一选区。
      rows.push("\u0000"); numbers.push(0);
      line = Number(hunk[1]);
    } else if (line && /^[ +]/.test(raw)) {
      rows.push(raw.slice(1)); numbers.push(line++);
    }
  }
  return { text: rows.join("\n"), numbers };
}
