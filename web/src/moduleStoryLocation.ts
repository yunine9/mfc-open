/** 从当前 Story 查找模块段落，不保存容易随修订失效的行号。
 * 优先精确匹配模块表第一列的稳定 ID；旧 Story 可回退到唯一模块标题。 */
export function moduleStoryLine(story: string, module: { id: string; name: string }): number | undefined {
  const rows: number[] = [], headings: number[] = [];
  let fence: string | undefined;
  story.split(/\r\n|[\n\r\u2028\u2029]/).forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return; }
    if (fence) return;
    const cells = line.trim().startsWith("|") ? line.trim().split("|").slice(1, -1).map((cell) => cell.trim().replace(/[`*]/g, "")) : [];
    if (cells[0] === module.id) rows.push(index + 1);
    const heading = /^\s*#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading && (heading === module.name || heading === `${module.name}模块`
      || heading.replace(/^\d+(?:\.\d+)*\s+/, "") === module.name)) headings.push(index + 1);
  });
  if (rows.length === 1) return rows[0];
  if (!rows.length && headings.length === 1) return headings[0];
  return undefined;
}
