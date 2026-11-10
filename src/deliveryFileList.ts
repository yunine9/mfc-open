import { runSafeWorktreeGitAsync } from "./safeGit.ts";

const labels: Record<string, string> = { A: "新增", M: "修改", D: "删除", R: "重命名", C: "复制", T: "类型变更" };
export type DeliveryFile = { path: string; label: string; previous?: string };
type FileChange = DeliveryFile;
type Directory = { directories: Map<string, Directory>; files: FileChange[] };
const directory = (): Directory => ({ directories: new Map(), files: [] });
const visible = (text: string) => text.replace(/[\r\n\t]/g, char => ({ "\r": "\\r", "\n": "\\n", "\t": "\\t" }[char]!));

/** 只读展示完整提交文件，不生成选择状态，也不参与是否允许提交的判断。 */
export async function readDeliveryFiles(cwd: string, base: string | undefined, head: string, paths?: readonly string[]): Promise<DeliveryFile[]> {
  const changes = new Map<string, FileChange>();
  let readable = false;
  if (base && /^[\da-f]{40,64}$/i.test(base) && /^[\da-f]{40,64}$/i.test(head)) {
    const result = await runSafeWorktreeGitAsync(cwd,
      ["diff", "--name-status", "--find-renames", "-z", base, head, "--"], { timeoutMs: 30_000 });
    if (result.status === 0) {
      readable = true;
      const fields = String(result.stdout ?? "").split("\0");
      for (let i = 0; i < fields.length - 1;) {
        const status = fields[i++], first = fields[i++];
        const moved = status[0] === "R" || status[0] === "C";
        const path = moved ? fields[i++] : first;
        if (path) changes.set(path, { path, label: labels[status[0]] ?? "变更", ...(moved ? { previous: first } : {}) });
      }
    }
  }
  if (!paths && !readable) throw new Error("无法读取两个提交之间的文件变化");
  if (!paths) return [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b)).map(path => changes.get(path) ?? { path, label: "变更" });
}

export interface PushFileList {
  branch: string;
  head_sha: string;
  base_sha?: string;
  comparison?: "remote_branch" | "target_branch";
  files?: DeliveryFile[];
  unavailable_reason?: string;
}

/** sourceSha=null 表示已查证远端分支不存在，undefined 表示未能查证，不能混为首次推送。 */
export async function pendingPushFiles(cwd: string, branch: string, head: string,
  sourceSha: string | null | undefined, targetSha: string | undefined): Promise<PushFileList> {
  const result: PushFileList = { branch, head_sha: head };
  try {
    if (sourceSha === undefined) throw new Error("无法查证远端任务分支，暂时不能计算本次增量");
    let base = sourceSha;
    if (sourceSha === null) {
      if (!targetSha || !/^[\da-f]{40,64}$/i.test(targetSha)) throw new Error("首次推送缺少远端目标分支，暂时不能计算差异");
      const common = await runSafeWorktreeGitAsync(cwd, ["merge-base", "--all", targetSha, head], { timeoutMs: 30_000 });
      const bases = common.stdout.trim().split(/\s+/).filter(Boolean);
      if (common.status !== 0 || bases.length !== 1) throw new Error("无法确定目标分支与当前提交的共同起点");
      base = bases[0];
    }
    const files = await readDeliveryFiles(cwd, base!, head);
    return { ...result, base_sha: base!, comparison: sourceSha === null ? "target_branch" : "remote_branch", files };
  } catch (error) {
    return { ...result, unavailable_reason: error instanceof Error ? error.message : String(error) };
  }
}

export function deliveryFileList(files: readonly DeliveryFile[]): string {
  const counts = new Map<string, number>();
  const root = directory();
  for (const file of files) {
    counts.set(file.label, (counts.get(file.label) ?? 0) + 1);
    let parent = root;
    const parts = file.path.split("/");
    for (const part of parts.slice(0, -1)) {
      if (!parent.directories.has(part)) parent.directories.set(part, directory());
      parent = parent.directories.get(part)!;
    }
    parent.files.push({ ...file, path: parts.at(-1)! });
  }
  const lines: string[] = [];
  function render(node: Directory, prefix = "") {
    const entries = [
      ...[...node.directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => ({ name, child })),
      ...node.files.map(file => ({ name: file.path, file })),
    ];
    entries.forEach((entry, index) => {
      const last = index === entries.length - 1;
      const stem = prefix + (last ? "└─ " : "├─ ");
      if ("child" in entry) {
        lines.push(stem + visible(entry.name) + "/");
        render(entry.child, prefix + (last ? "   " : "│  "));
      } else {
        lines.push(`${stem}${visible(entry.name)}  [${entry.file.label}]`
          + (entry.file.previous ? ` ← ${visible(entry.file.previous)}` : ""));
      }
    });
  }
  render(root);
  // 文件名可以带反引号，围栏始终比正文中的反引号长，不让路径变成 Markdown。
  const fence = "`".repeat(Math.max(3, ...[...lines.join("\n").matchAll(/`+/g)].map(match => match[0].length + 1)));
  return [
    `**本次推送清单：${files.length} 个文件**`,
    [...counts].map(([label, count]) => `${label} ${count}`).join(" · "),
    counts.has("变更") ? "部分变更类型暂不可读，文件路径仍完整列出。" : "",
    files.length ? `${fence}text\n${lines.join("\n")}\n${fence}` : "当前没有待交付的文件变化。",
    "需要调整时，直接在回复中说明要移除、补充或修改的文件，Agent 会按意见修改并更新清单。",
  ].filter(Boolean).join("\n\n");
}
