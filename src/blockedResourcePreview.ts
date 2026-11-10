import { resourceBlocked } from "./repositoryResourcePolicy.ts";
export interface BlockedResourcePreview {
  path: string;
  rules: string[];
  content?: string;
  note?: string;
}

/** Preview remote Git objects as plain text, never execute repository code.
 * Object IDs avoid interpreting repository filenames as Git revision syntax. */
export async function previewBlockedResources(
  rules: string[], revision: string, run: (args: string[]) => Promise<Buffer>,
): Promise<{ files: BlockedResourcePreview[]; truncated: boolean }> {
  if (!rules.length) return { files: [], truncated: false };
  const tree = (await run(["ls-tree", "-r", "-z", revision])).toString("utf8");
  const matches = tree.split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    return { mode, type, oid, path: row.slice(tab + 1) };
  }).filter(item => resourceBlocked(item.path, rules));
  const files: BlockedResourcePreview[] = [];
  for (const item of matches.slice(0, 30)) {
    const result: BlockedResourcePreview = { path: item.path, rules: rules.filter(rule => resourceBlocked(item.path, [rule])) };
    if (!/^100(?:644|755)$/.test(item.mode) || item.type !== "blob") {
      result.note = "符号链接或特殊条目，不读取目标";
    } else if (Number((await run(["cat-file", "-s", item.oid])).toString("utf8")) > 64 * 1024) {
      result.note = "文件超过 64 KiB，暂不预览";
    } else {
      const content = await run(["cat-file", "blob", item.oid]);
      if (content.includes(0)) result.note = "二进制文件，暂不预览";
      else {
        result.content = content.toString("utf8").slice(0, 16000);
        if (content.toString("utf8").length > 16000) result.note = "仅展示前 16000 字符";
      }
    }
    files.push(result);
  }
  return { files, truncated: matches.length > 30 };
}
