import { lstat, open, readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative, sep, extname } from "node:path";
import { Type } from "typebox";
import { summaryGit } from "./deliverySummaryAgent.ts";
import type { DeliveryCodeMetric } from "./deliveryAnalyticsTypes.ts";
import { redactAnalysisText, restrictedAnalysisPathSegment as blocked, serializeAnalysisValue } from "./analysisText.ts";
export { redactAnalysisText } from "./analysisText.ts";

export interface AnalysisScope { root: string; description: string; sourceOnly?: boolean }
async function analysisResult(value: Record<string, unknown>, receiptRoot?: string) {
  let text = serializeAnalysisValue(value);
  if (receiptRoot) {
    const id = createHash("sha256").update(text).digest("hex");
    await mkdir(receiptRoot, { recursive: true });
    await writeFile(join(receiptRoot, `${id}.json`), text, { mode: 0o600 });
    text = serializeAnalysisValue({ ...value, source_citation: value.citation, citation: `analysis://evidence/${id}` });
  }
  return { content: [{ type: "text" as const, text }], details: {} };
}
const textExtensions = new Set(["", ".ts", ".tsx", ".js", ".mjs", ".json", ".jsonl", ".md", ".txt", ".log", ".py", ".sh", ".yaml", ".yml", ".xml", ".ini", ".toml", ".diff", ".patch", ".html", ".css", ".cpp", ".h", ".java", ".sql"]);
async function checked(scope: AnalysisScope, path: string): Promise<string> {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (path.startsWith("/") || path.includes("\0") || parts.some(p => p === ".." || blocked.test(p))) throw new Error("材料路径不在只读分析范围内");
  if (scope.sourceOnly && parts.length && !["src", "web", "tests", "skills", "docs", "scripts", "kernel", "package.json", "CONTEXT.md", "AGENTS.md"].includes(parts[0])) throw new Error("平台读取只开放源码、规则和文档");
  let cursor = resolve(scope.root);
  if ((await lstat(cursor)).isSymbolicLink()) throw new Error("分析根目录不能是链接");
  for (const part of parts) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("材料路径不能包含链接");
  }
  const rel = relative(resolve(scope.root), cursor);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("材料越出读取范围");
  return cursor;
}

/** 原始材料按需读取，分页只限制单次返回，不将日志尾部冒充完整历史。 */
export function improvementEvidenceTool(scopes: Record<string, AnalysisScope>, receiptRoot?: string) {
  return {
    name: "analysis_evidence", label: "读取交付过程与平台材料",
    description: "只读任务及关联任务的原始记录、历史交付、知识/技能快照，以及开放范围中的当前团队货架、平台和内核源码。list查看目录，search定位，read按字节偏移续读。当前平台源码不是历史运行版本证明。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("scopes"), Type.Literal("list"), Type.Literal("read"), Type.Literal("search")]),
      scope: Type.Optional(Type.String()), path: Type.Optional(Type.String()), query: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
    execute: async (_id: string, args: { action: string; scope?: string; path?: string; query?: string; offset?: number }) => {
      const respond = (value: unknown) => analysisResult(Array.isArray(value) ? { scopes: value } : value as Record<string, unknown>, receiptRoot);
      if (args.action === "scopes") return respond(Object.entries(scopes).map(([id, s]) => ({ id, description: s.description })));
      const scopeId = args.scope ?? "task", scope = scopes[scopeId];
      if (!scope) throw new Error("未开放该材料范围");
      const path = args.path ?? "", absolute = await checked(scope, path), offset = args.offset ?? 0;
      const citation = `analysis://${scopeId}/${path}`;
      if (args.action === "list") {
        const entries = (await readdir(absolute, { withFileTypes: true })).filter(e => !blocked.test(e.name) && !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name));
        const allowed = [] as Array<{ name: string; directory: boolean }>;
        for (const entry of entries) { try { await checked(scope, join(path, entry.name)); allowed.push({ name: entry.name, directory: entry.isDirectory() }); } catch {} }
        return respond({ citation, total: allowed.length, items: allowed.slice(offset, offset + 100), next_offset: offset + 100 < allowed.length ? offset + 100 : null });
      }
      if (args.action === "read") {
        if (!textExtensions.has(extname(path).toLowerCase())) throw new Error("此材料不是可读取文本");
        const file = await open(absolute, "r");
        try {
          const stat = await file.stat();
          if (!stat.isFile()) throw new Error("read 需要文件路径");
          const buffer = Buffer.alloc(32 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
          if (buffer.subarray(0, bytesRead).includes(0)) throw new Error("二进制材料不能作为文本读取");
          // 留下末尾半个 UTF-8 字符供下一页读取。
          let end = bytesRead;
          if (offset + bytesRead < stat.size) { while (end && (buffer[end - 1] & 0xc0) === 0x80) end--; if (end && buffer[end - 1] >= 0xc0) end--; else end = bytesRead; }
          return respond({ citation: `${citation}#offset=${offset}`, total_bytes: stat.size, offset,
            next_offset: offset + end < stat.size ? offset + end : null, text: buffer.subarray(0, end).toString("utf8"),
            note: "原文件的一个分段；需续读才能确认其余内容，工具原返回也可能已被执行工具截断。" });
        } finally { await file.close(); }
      }
      if (args.action !== "search" || !args.query?.trim()) throw new Error("search 需要 query");
      const paths: string[] = [], errors: string[] = []; let limited = false;
      const walk = async (current: string, depth: number) => {
        if (depth > 12 || paths.length >= 3000) { limited = true; return; }
        let entries; try { entries = await readdir(await checked(scope, current), { withFileTypes: true }); } catch { errors.push(current); return; }
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
          if (blocked.test(entry.name) || entry.isSymbolicLink()) continue;
          const name = current ? `${current}/${entry.name}` : entry.name;
          try { await checked(scope, name); } catch { continue; }
          if (entry.isDirectory()) await walk(name, depth + 1);
          else if (entry.isFile() && textExtensions.has(extname(name).toLowerCase())) paths.push(name);
          if (paths.length >= 3000) { limited = true; break; }
        }
      };
      await walk(path, 0);
      const hits: Array<{ citation: string; offset: number; preview: string }> = [];
      // 搜索每次最多扫描 40 个文件；日志全文可通过 read 分页继续。
      for (const name of paths.slice(offset, offset + 40)) {
        const file = await open(await checked(scope, name), "r");
        try {
          const buffer = Buffer.alloc(128 * 1024), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          const text = buffer.subarray(0, bytesRead).toString("utf8"), at = text.indexOf(args.query!);
          if (at >= 0) hits.push({ citation: `analysis://${scopeId}/${name}`, offset: Buffer.byteLength(text.slice(0, at)), preview: text.slice(Math.max(0, at - 150), at + 600) });
        } finally { await file.close(); }
      }
      return respond({ hits, next_offset: offset + 40 < paths.length ? offset + 40 : null, errors,
        limitation: "仅搜索各文件前128KiB；大日志需read续读。无命中不证明内容不存在。", directory_scan_limited: limited });
    },
  };
}

/** 中间提交必须来自冻结的任务提交清单，不能运行任意 Git 命令。 */
export function improvementCodeTool(repo: string | undefined, metric?: DeliveryCodeMetric, archiveRoot?: string, receiptRoot?: string) {
  const allowed = new Set([metric?.base, metric?.head, metric?.first, ...metric?.commits.map(c => c.sha) ?? []].filter((s): s is string => !!s));
  return {
    name: "analysis_code", label: "读取本次交付的各次提交",
    description: "list查看冻结的提交清单；diff查看单个提交（merge按第一父链）或整体base到head；read/search读取允许SHA中的业务源码。缺失Git对象不能用提交标题替代。",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("diff"), Type.Literal("read"), Type.Literal("search")]),
      sha: Type.Optional(Type.String()), path: Type.Optional(Type.String()), query: Type.Optional(Type.String()), start_line: Type.Optional(Type.Integer({ minimum: 1 })) }),
    execute: async (_id: string, args: { action: string; sha?: string; path?: string; query?: string; start_line?: number }) => {
      if (args.action === "list") return analysisResult({ metric, available: !!repo || !!archiveRoot, note: "分类含规则推断，不代表实际动机；整体指标基线与首次发布MR可能不同。" }, receiptRoot);
      if (!metric) throw new Error("业务代码或统计提交范围不可用；可继续分析任务材料，代码结论需标缺失");
      const sha = args.sha ?? metric.head;
      if (!allowed.has(sha) || !/^[a-f0-9]{40,64}$/i.test(sha)) throw new Error("提交不在本次交付范围内");
      const path = args.path ?? "";
      if (path.startsWith("/") || path.includes("\0") || path.split(/[\\/]/).some(p => p === ".." || blocked.test(p))) throw new Error("源码路径不可读");
      const cacheKey = createHash("sha256").update(JSON.stringify([args.action, args.sha ?? "overall", sha, path, args.query])).digest("hex");
      const cache = archiveRoot ? join(archiveRoot, `${cacheKey}.json`) : undefined;
      let text: string;
      const load = async () => {
      if (!repo) throw new Error("Git现场已回收且本项没有保存的代码原文");
      if (args.action === "diff") {
        const parents = args.sha ? (await summaryGit(repo, ["rev-list", "--parents", "-n", "1", sha])).trim().split(/\s+/).slice(1) : [];
        let paths = (await summaryGit(repo, args.sha ? parents.length
          ? ["--literal-pathspecs", "diff", "--name-only", "-z", parents[0], sha, "--", ...(path ? [path] : [])]
          : ["--literal-pathspecs", "diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", sha, "--", ...(path ? [path] : [])]
          : ["--literal-pathspecs", "diff", "--name-only", "-z", metric.base, metric.head, "--", ...(path ? [path] : [])]))
          .split("\0").filter(name => name && !name.split(/[\\/]/).some(p => blocked.test(p)));
        if (!paths.length) return "无可读取的交付文本变更。";
        return summaryGit(repo, args.sha
          ? ["--literal-pathspecs", "show", "--format=fuller", "--first-parent", "--no-ext-diff", "--no-textconv", "--unified=5", sha, "--", ...paths]
          : ["--literal-pathspecs", "diff", "--no-ext-diff", "--no-textconv", "--unified=5", metric.base, metric.head, "--", ...paths]);
      }
      else if (args.action === "read" && path) return summaryGit(repo, ["show", `${sha}:${path}`]);
      else if (args.action === "search" && args.query) {
        // grep 的无匹配返回1；使用既有安全Git封装，异常不伪装成功。
        // 无路径搜索也按允许的文件清单限制，避免命中凭据文件。
        const paths = (await summaryGit(repo, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", sha, "--", ...(path ? [path] : [])])).split("\0").filter(name => name && !name.split(/[\\/]/).some(p => blocked.test(p)));
        if (!paths.length) return "没有可读取的源码文件。";
        try { return await summaryGit(repo, ["--literal-pathspecs", "grep", "-n", "-I", "-F", "-e", args.query, sha, "--", ...paths]); }
        catch { return "未取得搜索结果；可能无匹配或Git对象不可用，请用read核对。"; }
      } else throw new Error("read需要path，search需要query");
      };
      try { text = cache ? JSON.parse(await readFile(cache, "utf8")).text : await load(); }
      catch {
        text = await load();
        if (text.includes("\0")) throw new Error("该Git对象是二进制，不能作为文本读取");
        if (cache) { await mkdir(archiveRoot!, { recursive: true }); await writeFile(cache, JSON.stringify({ sha, path, action: args.action, text: redactAnalysisText(text) }), { mode: 0o600 }); }
      }
      if (text.includes("\0")) throw new Error("该Git对象是二进制，不能作为文本读取");
      const lines = text.split("\n"), start = (args.start_line ?? 1) - 1;
      return analysisResult({ sha, path, total_bytes: Buffer.byteLength(text), total_lines: lines.length,
        start_line: start + 1, next_line: start + 200 < lines.length ? start + 201 : null,
        text: lines.slice(start, start + 200).map((line, i) => `${start + i + 1}: ${line}`).join("\n") }, receiptRoot);
    },
  };
}

export async function includeImprovementMergeCommits(repo: string | undefined, metric?: DeliveryCodeMetric) {
  if (!repo || !metric) return;
  const rows = (await summaryGit(repo, ["log", "--first-parent", "--reverse", "--format=%H%x00%aI%x00%s", "-500", `${metric.base}..${metric.head}`, "--"]))
    .trim().split("\n").filter(Boolean).map(line => line.split("\0"));
  const known = new Map(metric.commits.map(commit => [commit.sha, commit]));
  for (const [sha, at, subject] of rows) if (!known.has(sha) && /^[a-f0-9]{40,64}$/.test(sha)) known.set(sha, {
    sha, at, subject, origin: "other", additions: 0, deletions: 0,
    origin_evidence: ["分析补充的第一父链提交（含合并）；不改变统计行数，实际用途须读差异核实。"],
  });
  const ordered = rows.map(([sha]) => known.get(sha)).filter((commit): commit is NonNullable<typeof commit> => !!commit);
  const orderedIds = new Set(ordered.map(commit => commit.sha));
  metric.commits = [...ordered, ...[...known.values()].filter(commit => !orderedIds.has(commit.sha))];
}

/** 在回收代码前保存逐提交差异与最终/基线的变更文件；遗漏显式记录。 */
export async function freezeImprovementCode(repo: string | undefined, metric: DeliveryCodeMetric | undefined, root: string, signal?: AbortSignal) {
  const limitations: string[] = [];
  if (!repo || !metric) return ["代码现场或统计范围缺失，无法补存逐提交代码。"];
  const tool = improvementCodeTool(repo, metric, root);
  let bytes = 0;
  for (const sha of [undefined, ...metric.commits.map(c => c.sha)]) {
    signal?.throwIfAborted();
    if (bytes > 64 * 1024 * 1024) { limitations.push("代码保存超过64MiB，剩余提交仅在Git现场可用时读取。"); return limitations; }
    try { const result = await tool.execute("archive", { action: "diff", sha }); bytes += JSON.parse(result.content[0].text).total_bytes ?? 0; }
    catch { limitations.push(`未保存提交差异 ${sha ?? "overall"}`); }
  }
  try {
    const paths = (await summaryGit(repo, ["diff", "--name-only", "-z", metric.base, metric.head, "--"])).split("\0").filter(Boolean);
    for (const path of paths) {
      signal?.throwIfAborted();
      if (path.split(/[\\/]/).some(p => blocked.test(p))) continue;
      for (const sha of [metric.base, metric.head]) {
        if (bytes > 64 * 1024 * 1024) { limitations.push("源码保存超过64MiB，剩余文件只在Git现场可用时读取。"); return limitations; }
        try { const result = await tool.execute("archive", { action: "read", sha, path }); bytes += JSON.parse(result.content[0].text).total_bytes ?? 0; }
        catch { limitations.push(`${sha.slice(0, 8)}:${path} 未保存，可能该版本无此文件或读取失败。`); }
      }
    }
  } catch { limitations.push("未取得变更文件清单，关键源码保存不完整。"); }
  return limitations;
}
