import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import { runGitProcess } from "./hostGitSandbox.ts";
import { gitAiEnabled } from "./gitAi.ts";

type Log = (message: string) => void;
function warn(log: Log | undefined, operation: string): void {
  try { log?.(`Git AI ${operation}未完成，代码提交和推送结果不受影响`); } catch { /* 观察不影响执行 */ }
}
const identity: [string, string][] = [["user.name", "mae-flow-cloud"], ["user.email", "cloud@mae-flow.local"]];
async function git(cwd: string, args: string[], optional = false): Promise<string> {
  const result = await runSafeWorktreeGitAsync(cwd, args, { timeoutMs: 30_000, configs: identity });
  if (result.status !== 0 && !optional) throw new Error("Git AI metadata Git command failed");
  return result.status === 0 ? result.stdout : "";
}
type Range = [number, number];
type Entry = { key: string; ranges: Range[] };
type Metadata = { schema_version: string; git_ai_version?: string; base_commit_sha: string;
  prompts: Record<string, unknown>; sessions?: Record<string, any>; humans?: Record<string, unknown> };
type Note = { files: Map<string, Entry[]>; metadata: Metadata };
function parseNote(text: string): Note | undefined {
  if (!text.trim()) return undefined;
  const divider = text.indexOf("\n---\n");
  if (divider < 0) throw new Error("Unsupported authorship note");
  const metadata = JSON.parse(text.slice(divider + 5)) as Metadata;
  if (metadata.schema_version !== "authorship/3.0.0" || !metadata.prompts) throw new Error("Unsupported note schema");
  const files = new Map<string, Entry[]>();
  let current: Entry[] | undefined;
  for (const line of text.slice(0, divider).split("\n")) {
    if (!line) continue;
    if (!line.startsWith("  ")) {
      const file = line.startsWith('"') ? JSON.parse(line) : line;
      if (typeof file !== "string") throw new Error("Invalid file path");
      current = []; files.set(file, current);
    } else {
      const match = /^  (\S+) ([\d,-]+)$/.exec(line);
      if (!match || !current) throw new Error("Invalid note ranges");
      const ranges = match[2].split(",").map(value => {
        const [start, end = start] = value.split("-").map(Number);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) throw new Error("Invalid note range");
        return [start, end] as Range;
      });
      current.push({ key: match[1], ranges });
    }
  }
  return { files, metadata };
}
function attribution(note: Note | undefined, file: string, line: number): Entry | undefined {
  return note?.files.get(file)?.find(entry => entry.ranges.some(([start, end]) => start <= line && line <= end));
}
function importAuthor(target: Metadata, source: Metadata, key: string): void {
  const field = key.startsWith("s_") ? "sessions" : key.startsWith("h_") ? "humans" : "prompts";
  const id = key.split("::")[0];
  const record = source[field]?.[id];
  if (!record) throw new Error("Missing note author");
  (target[field] ??= {})[id] = record;
}
function rangesOf(lines: number[]): string {
  const ranges: Range[] = [];
  for (const line of lines) {
    const last = ranges.at(-1);
    if (last && last[1] + 1 === line) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges.map(([start, end]) => start === end ? `${start}` : `${start}-${end}`).join(",");
}

async function writeNote(cwd: string, sha: string, text: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mfc-git-ai-note-"));
  try {
    const path = join(dir, "note");
    writeFileSync(path, text, { mode: 0o600 });
    await git(cwd, ["notes", "--ref=ai", "add", "-f", "-F", path, sha]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** 远端只接收用户授权的文件行号、工具、模型和匿名标识，不转发会话及路径元数据。 */
export function publicGitAiNote(text: string, sha: string): string | undefined {
  const note = parseNote(text);
  if (!note) return;
  const metadata: Metadata = { schema_version: "authorship/3.0.0", base_commit_sha: sha, prompts: {}, sessions: {} };
  const output: string[] = [];
  for (const [file, entries] of note.files) {
    if (!file || /^(?:\/|\\|[a-z]:)/i.test(file) || file.split(/[\\/]/).includes("..")) continue;
    const selected: string[] = [];
    for (const entry of entries) {
      if (!/^s_[0-9a-f]{14}::t_[0-9a-f]{14}$/.test(entry.key)) continue;
      const id = entry.key.split("::")[0];
      const agent = note.metadata.sessions?.[id]?.agent_id;
      if (agent?.tool !== "pi") continue;
      const model = typeof agent.model === "string" && /^[\w.:/+-]{1,160}$/.test(agent.model) ? agent.model : "unknown";
      metadata.sessions![id] = { agent_id: { tool: "pi", id, model }, human_author: "mae-flow-cloud" };
      selected.push(`  ${entry.key} ${entry.ranges.map(([a, b]) => a === b ? a : `${a}-${b}`).join(",")}`);
    }
    if (selected.length) output.push(JSON.stringify(file), ...selected);
  }
  return output.length ? `${output.join("\n")}\n---\n${JSON.stringify(metadata)}\n` : undefined;
}

/** 代码推送核实成功后，使用同一个已授权仓库及原凭据沙箱同步匿名归因。 */
export async function publishGitAiNotes(options: {
  cwd: string; sha: string; remote: string; staging: string;
  args: string[]; env: NodeJS.ProcessEnv; log?: Log;
}): Promise<void> {
  if (!gitAiEnabled()) return;
  let dir: string | undefined;
  try {
    const entries = (await git(options.cwd, ["notes", "--ref=ai", "list"]))
      .trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/));
    if (!entries.length) return;
    const run = async (args: string[]) => {
      const result = await runGitProcess([...options.args,
        ...identity.flatMap(([key, value]) => ["-c", `${key}=${value}`]),
        `--git-dir=${options.staging}`, ...args], { env: options.env, timeoutMs: 30_000 });
      if (result.status !== 0) throw new Error("Git AI notes transport failed");
      return result.stdout;
    };
    // 从远端 Notes 追加缺少的记录；保留其他任务内容，不强推，不拼接 JSON。
    const remote = await run(["ls-remote", options.remote, "refs/notes/ai"]);
    if (remote.trim()) await run(["fetch", "--no-tags", "--no-recurse-submodules",
      options.remote, "refs/notes/ai:refs/notes/ai"]);
    const existing = new Set((await run(["notes", "--ref=ai", "list"]))
      .trim().split("\n").filter(Boolean).map(line => line.trim().split(/\s+/)[1]));
    dir = mkdtempSync(join(tmpdir(), "mfc-git-ai-publish-"));
    const path = join(dir, "note");
    let added = false;
    for (const [blob, commit] of entries) {
      if (!/^[0-9a-f]{40,64}$/.test(blob ?? "") || !/^[0-9a-f]{40,64}$/.test(commit ?? "") || existing.has(commit)) continue;
      const reachable = await runSafeWorktreeGitAsync(options.cwd,
        ["merge-base", "--is-ancestor", commit, options.sha], { timeoutMs: 30_000 });
      if (reachable.status === 1) continue;
      if (reachable.status !== 0) throw new Error("Cannot establish note ownership");
      const note = publicGitAiNote(await git(options.cwd, ["cat-file", "blob", blob]), commit);
      if (!note) continue;
      writeFileSync(path, note, { mode: 0o600 });
      await run(["notes", "--ref=ai", "add", "-F", path, commit]);
      added = true;
    }
    // 并发非快进只留日志，下一次正常推送再同步；不重推代码或重开流程。
    if (added) await run(["push", options.remote, "refs/notes/ai:refs/notes/ai"]);
  } catch { warn(options.log, "Notes 同步"); }
  finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 观察清理 */ } } }
}

/** 宿主重建提交不触发 Git AI；按旧树真实 blame 保留已知归因，不推断未知来源。 */
export async function preserveGitAiNotes(cwd: string, mappings: ReadonlyMap<string, string>, log?: Log): Promise<void> {
  if (!gitAiEnabled()) return;
  try {
    if (!(await git(cwd, ["notes", "--ref=ai", "list"])).trim()) return;
    const cache = new Map<string, Note | undefined>();
    const read = async (sha: string) => {
      if (!cache.has(sha)) cache.set(sha, parseNote(await git(cwd, ["notes", "--ref=ai", "show", sha], true)));
      return cache.get(sha);
    };
    for (const [oldSha, newSha] of mappings) {
      if (oldSha === newSha) continue;
      if (!/^[0-9a-f]{40,64}$/.test(oldSha) || !/^[0-9a-f]{40,64}$/.test(newSha)) throw new Error("Invalid commit");
      const tip = await read(oldSha);
      const [oldInfo, newInfo] = await Promise.all([oldSha, newSha]
        .map(sha => git(cwd, ["show", "-s", "--format=%T%x00%P", sha])));
      const [oldTree, oldParents = ""] = oldInfo.trim().split("\0");
      const [newTree, newParents = ""] = newInfo.trim().split("\0");
      const mappedParents = oldParents.split(/\s+/).filter(Boolean).map(sha => mappings.get(sha) ?? sha).join(" ");
      // 只改说明的一对一映射不需要逐文件 blame；保留整张图原有的归因关系。
      if (oldTree === newTree && mappedParents === newParents) {
        if (tip) {
          const body = [...tip.files].flatMap(([file, entries]) => [JSON.stringify(file), ...entries.map(entry =>
            `  ${entry.key} ${entry.ranges.map(([a, b]) => a === b ? a : `${a}-${b}`).join(",")}`)]).join("\n");
          await writeNote(cwd, newSha, `${body}\n---\n${JSON.stringify({ ...tip.metadata, base_commit_sha: newSha })}\n`);
        }
        continue;
      }
      const metadata: Metadata = { schema_version: "authorship/3.0.0", git_ai_version: tip?.metadata.git_ai_version,
        base_commit_sha: newSha, prompts: {} };
      const output: string[] = [];
      const files = (await git(cwd, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", "-m", newSha]))
        .split("\0").filter(Boolean);
      for (const file of new Set(files)) {
        const oldBlob = (await git(cwd, ["rev-parse", `${oldSha}:${file}`], true)).trim();
        const newBlob = (await git(cwd, ["rev-parse", `${newSha}:${file}`], true)).trim();
        if (!/^[0-9a-f]{40,64}$/.test(oldBlob) || oldBlob !== newBlob) continue;
        const blame = await git(cwd, ["-c", "core.quotePath=false", "blame", "--line-porcelain", oldSha, "--", file]);
        const authors = new Map<string, number[]>();
        let sha = "", sourceLine = 0, targetLine = 0, sourceFile = file;
        for (const line of blame.split("\n")) {
          const header = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/.exec(line);
          if (header) { sha = header[1]; sourceLine = Number(header[2]); targetLine = Number(header[3]); }
          else if (line.startsWith("filename ")) {
            const name = line.slice(9); sourceFile = name.startsWith('"') ? JSON.parse(name) : name;
          } else if (line.startsWith("\t")) {
            let note = tip, entry = attribution(tip, file, targetLine);
            if (!entry) { note = await read(sha); entry = attribution(note, sourceFile, sourceLine); }
            if (entry && note) {
              importAuthor(metadata, note.metadata, entry.key);
              const lines = authors.get(entry.key) ?? []; lines.push(targetLine); authors.set(entry.key, lines);
            }
          }
        }
        if (authors.size) {
          output.push(JSON.stringify(file));
          for (const [key, lines] of authors) output.push(`  ${key} ${rangesOf(lines)}`);
        }
      }
      if (!output.length) continue;
      await writeNote(cwd, newSha, `${output.join("\n")}\n---\n${JSON.stringify(metadata)}\n`);
    }
  } catch { warn(log, "提交改写归因保留"); }
}
