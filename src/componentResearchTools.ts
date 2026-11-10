import { scanForSecrets } from "./hostSkillLibrary.ts";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export function executeFile(
  file: string,
  args: string[],
  cwd?: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      {
        cwd,
        timeout: 30000,
        signal,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        env: { ...process.env, EC_DEBUG: "0", GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout) =>
        error
          ? reject(
              Object.assign(
                new Error(
                  error.name === "AbortError" ? "操作已取消"
                    : error.code === "ENOENT" ? `${file === "git" ? "Git" : "ec"} 工具未安装或路径错误`
                    : error.code === "EACCES" ? `当前服务账户无权执行 ${file === "git" ? "Git" : "ec"}（${file}），请检查该文件的执行权限`
                    : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? "返回内容过大，请缩小搜索或读取范围"
                    : error.killed ? "操作超时，请缩小范围后重试"
                    : file === "git" ? "本地源码操作失败，请检查仓库、版本和路径" : "ec 调用失败，请检查工具配置、凭据和网络",
                ),
                { code: error.code },
              ),
            )
          : resolve(stdout),
    ),
  );
}

/** 先在流中选择源码页，避免大文件尚未分页就撞上 execFile 的缓冲上限。 */
async function streamGitOutput(args: string[], cwd: string, signal: AbortSignal | undefined, consume: (chunk: string) => void) {
  if (signal?.aborted) throw new Error("操作已取消");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EC_DEBUG: "0", GIT_TERMINAL_PROMPT: "0" } });
    let failure: Error | undefined, settled = false;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(new Error("操作已取消"));
    const timer = setTimeout(() => stop(new Error("操作超时，请缩小范围后重试")), 30_000); timer.unref();
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failure) return;
      try { consume(chunk); } catch (error) { stop(error instanceof Error ? error : new Error(String(error))); }
    });
    // 不保存 stderr，避免大批诊断把新的流式读取变成无界缓冲。
    child.stderr.resume();
    child.stdout.on("error", error => stop(error));
    child.stderr.on("error", error => stop(error));
    child.once("error", error => finish(Object.assign(new Error((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Git 工具未安装或路径错误" : "无法启动本地源码读取"), { code: (error as NodeJS.ErrnoException).code })));
    child.once("close", (code, killedBy) => finish(failure ?? (code === 0 && !killedBy ? undefined
      : new Error("本地源码操作失败，请检查仓库、版本和路径"))));
  });
}

/** 清单必须完整；超出资源预算时明确失败，不把部分文件当作全仓盘点。 */
export async function listGitTreePaths(root: string, revision: string, path = "", signal?: AbortSignal) {
  const files: string[] = [];
  let pending = "", characters = 0;
  await streamGitOutput(["--literal-pathspecs", "ls-tree", "-r", "-z", "--name-only", revision, "--", ...(path ? [path] : [])], root, signal, chunk => {
    let offset = 0;
    for (;;) {
      const end = chunk.indexOf("\0", offset), fragment = chunk.slice(offset, end < 0 ? undefined : end);
      pending += fragment;
      if (pending.length > 65_536) throw new Error("单个源码路径超过读取预算，无法完整列出目录");
      if (end < 0) break;
      if (pending) {
        characters += pending.length;
        if (characters > 32 * 1024 * 1024 || files.length >= 1_000_000) throw new Error("源码目录清单超过完整读取预算，请缩小配置的研究路径后重试");
        files.push(pending);
      }
      pending = ""; offset = end + 1;
    }
  });
  if (pending) throw new Error("源码目录输出不完整，不能作为完整盘点使用");
  return files;
}

/** 构建文件需要完整解析；保留明确上限，不能用截断的 JSON/XML 推断依赖。 */
export async function readGitBuildFile(root: string, revision: string, path: string, signal?: AbortSignal) {
  const chunks: string[] = []; let bytes = 0;
  await streamGitOutput(["show", `${revision}:${path}`], root, signal, chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024) throw new Error(`构建文件 ${path} 超过 16 MiB 完整解析预算，无法完成源码盘点`);
    chunks.push(chunk);
  });
  return chunks.join("");
}

export interface GitBlobPage { lines: Array<{ number: number; text: string }>; totalLines: number; nextLine?: number; symbolFound: boolean }
/** 未选中的行只计数；单行或当前页过长时不保存半行，也不将半行登记为已读取。 */
export async function readGitBlobPage(root: string, revision: string, path: string,
  options: { start?: number; end?: number; maxCharacters?: number; symbol?: string } = {}, signal?: AbortSignal): Promise<GitBlobPage> {
  const start = options.start ?? 0, end = options.end ?? 0, limit = options.maxCharacters ?? 30_000;
  const lines: GitBlobPage["lines"] = [];
  let number = 1, current = "", characters = 0, nextLine: number | undefined, symbolTail = "", symbolFound = false;
  const record = () => {
    if (number >= start && number <= end && nextLine === undefined) {
      if (characters + current.length + String(number).length + 3 > limit) nextLine = number;
      else { lines.push({ number, text: current }); characters += current.length + String(number).length + 3; }
    }
    current = "";
  };
  await streamGitOutput(["show", `${revision}:${path}`], root, signal, chunk => {
    if (options.symbol && !symbolFound) {
      const combined = symbolTail + chunk; symbolFound = combined.includes(options.symbol);
      symbolTail = symbolFound || options.symbol.length < 2 ? "" : combined.slice(-(options.symbol.length - 1));
    }
    let offset = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", offset), stop = newline < 0 ? chunk.length : newline;
      if (number >= start && number <= end && nextLine === undefined) {
        const fragment = chunk.slice(offset, stop);
        if (characters + current.length + fragment.length + String(number).length + 3 > limit) { nextLine = number; current = ""; }
        else current += fragment;
      }
      if (newline < 0) break;
      record(); number++; offset = newline + 1;
    }
  });
  record();
  return { lines, totalLines: number, nextLine: nextLine ?? (end < number ? end + 1 : undefined), symbolFound };
}
export const ecBinary = () =>
  process.env.MAE_FLOW_EC_BIN ||
  (existsSync(join(homedir(), ".local/bin/ec"))
    ? join(homedir(), ".local/bin/ec")
    : "ec");
export async function checkEc(signal?: AbortSignal) {
  await executeFile(ecBinary(), ["tools"], undefined, signal);
}
export function evidencePreview(text: string) {
  const preview = text.slice(0, 4000);
  try {
    scanForSecrets("源码摘要", Buffer.from(preview));
    return preview;
  } catch {
    return "摘要含疑似敏感值，不在记录中展示";
  }
}
const reply = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
});
export function isResearchPlatformPath(path: string): boolean {
  return /(^|\/)(?:\.cac|\.mae-flow|\.mae-flow-work|\.pi|\.codegraph|node_modules|\.git)(?:\/|$)/.test(path);
}
export function componentSourceTool(
  root: string,
  revision: string,
  range: string,
  onUse: (record: object) => void,
  sourceLabel = "当前仓",
  excludePath?: (path: string) => boolean,
) {
  return defineTool({
    name: "component_source",
    label: "读取参考源码",
    description:
      '只读本次固定版本的源码。list 默认列当前层的目录与文件，逐层指定 path 深入；recursive:true 按文件分页。默认排除平台生成目录，include_platform:true 可查看。read 读文件。search 多关键词用 keywords 数组，任意一个命中即可；完整短语用 query，两者只填一个。默认忽略大小写。每次只搜索指定仓，其他仓须分别调用。不能修改源码。',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("search"),
        Type.Literal("read"),
      ]),
      path: Type.Optional(Type.String({ description: "仓内完整相对路径，read 请使用 list/search 返回的路径，不要仅凭文件名猜测。" })),
      query: Type.Optional(Type.String({ description: "完整短语搜索，按字面匹配，不支持正则；多个关键词请用 keywords。" })),
      keywords: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32, description: "多个字面关键词，任意一个命中即可；与 query 二选一。" })),
      ignore_case: Type.Optional(Type.Boolean({ description: "默认 true：忽略大小写；false：区分大小写。" })),
      recursive: Type.Optional(Type.Boolean({ description: "list 默认列当前层；true 递归列全部文件并分页。" })),
      include_platform: Type.Optional(Type.Boolean({ description: "显式包含平台及依赖生成目录，默认排除。" })),
      start: Type.Optional(Type.Integer({ minimum: 1, description: "read 的起始行，或 list 的起始条目（从 1 开始）" })),
      end: Type.Optional(Type.Integer({ minimum: 1, description: "read 的末行，或 list 的末条目" })),
    }),
    async execute(_id: string, input: any, signal) {
      try {
        const requestedPath = String(input.path ?? range);
        const path = requestedPath.length > 1 ? requestedPath.replace(/\/$/, "") : requestedPath;
        if (
          path &&
          (path.startsWith("/") ||
            path
              .split("/")
              .some((p: string) => p === ".." || p === "." || !p) ||
            /[\\\0\r\n]/.test(path))
        )
          throw new Error("请使用仓内相对路径");
        if (range && path !== range && !path.startsWith(range + "/"))
          throw new Error(
            "请在配置的组件源码范围内阅读，跨仓调用请用 code_search",
          );
        if (excludePath?.(path)) throw new Error("本次验证屏蔽了既有文档与 AGENTS.md，请读取源码或本次上传资料");
        let text = "";
        if (input.action === "list") {
          const all = await listGitTreePaths(root, revision, path, signal);
          const files = all.filter(p => !excludePath?.(p) && (input.include_platform || !isResearchPlatformPath(p)));
          const prefix = path ? `${path}/` : "";
          const entries = input.recursive ? files : [...new Set(files.map(p => {
            const relative = p.startsWith(prefix) ? p.slice(prefix.length) : p;
            return relative.includes("/") ? `${prefix}${relative.split("/")[0]}/` : p;
          }))];
          const start = Math.max(1, input.start ?? 1);
          const wantedEnd = Math.min(entries.length, input.end ?? start + 99, start + 199);
          const page: string[] = []; let characters = 0;
          for (const entry of entries.slice(start - 1, wantedEnd)) {
            if (characters + entry.length + 1 > 29_000) break;
            page.push(entry); characters += entry.length + 1;
          }
          if (!page.length && start <= wantedEnd) throw new Error("单个目录项超过返回预算，无法完整列出该路径");
          const end = start + page.length - 1;
          text = `目录共 ${entries.length} 项，本次 ${start}–${end} 项；业务范围文件 ${files.length} 个，排除平台及依赖文件 ${all.length - files.length} 个\n${page.join("\n")}`;
          if (end < entries.length) text += `\n后续请用 list start=${end + 1} 继续，或指定 path 分目录读取`;
        }
        else if (input.action === "search") {
          const hasQuery = typeof input.query === "string" && !!input.query.trim();
          if (hasQuery && input.keywords !== undefined) throw new Error("query 与 keywords 只能填写一个；多关键词请用 keywords 数组");
          if (input.keywords !== undefined && (!Array.isArray(input.keywords) || !input.keywords.length || input.keywords.length > 32 || input.keywords.some((word: unknown) => typeof word !== "string" || !word.trim())))
            throw new Error("keywords 须包含 1～32 个非空字符串");
          const patterns: string[] = input.keywords !== undefined ? [...new Set<string>(input.keywords)] : hasQuery ? [input.query] : [];
          if (!patterns.length) throw new Error("请填写 query 完整短语，或 keywords 关键词数组");
          if (patterns.some(word => /[\r\n\0]/.test(word))) throw new Error("搜索词不能包含换行或空字符");
          if (input.ignore_case !== undefined && typeof input.ignore_case !== "boolean") throw new Error("ignore_case 须为布尔值");
          const ignoreCase = input.ignore_case ?? true;
          try {
            text = await executeFile(
              "git",
              [
                ...(excludePath ? ["-c", "core.quotepath=false"] : []),
                "--literal-pathspecs",
                "grep",
                ...(excludePath ? ["-I"] : []),
                "-n",
                "-F",
                ...(ignoreCase ? ["-i"] : []),
                ...patterns.flatMap(word => ["-e", word]),
                revision,
                "--",
                ...(path ? [path] : []),
              ],
              root, signal,
            );
          } catch (error) {
            if ((error as any).code !== 1) throw error;
            text = "没有命中。仅表示本仓当前版本和范围内未匹配，不代表其他仓没有相关代码。";
            if (hasQuery && /\s/.test(input.query)) text += "当前按完整短语搜索；若要查多个词，请改用 keywords 数组。";
          }
          if (!input.include_platform || excludePath) text = text.split("\n").filter(line => {
            const match = /^[^:]+:(.*?):\d+:/.exec(line);
            return !match || (!excludePath?.(match[1]) && (input.include_platform || !isResearchPlatformPath(match[1])));
          }).join("\n") || "业务范围没有命中（已排除平台及依赖生成目录）";
          text = `仓库：${sourceLabel}\n版本：${revision}\n范围：${path || "全仓"}\n匹配：${input.keywords !== undefined ? "多关键词任意命中" : "完整短语"}；${ignoreCase ? "忽略大小写" : "区分大小写"}；字面搜索\n${text}`;
        } else {
          if (!path) throw new Error("read 需要文件路径，请先用 list 查看目录");
          const entry = await executeFile("git", ["--literal-pathspecs", "ls-tree", revision, "--", path], root, signal);
          if (!entry.trim()) throw new Error(`当前版本下文件不存在：${path}。请先用 list 查找完整仓内路径，再 read；不要反复猜测文件名。`);
          if (/^040000 tree /.test(entry)) throw new Error(`路径是目录：${path}。请用 list 列出文件后再 read。`);
          const start = Math.max(1, input.start ?? 1), end = Math.min(input.end ?? start + 159, start + 399);
          const header = `${path} @ ${revision}\n`;
          const page = await readGitBlobPage(root, revision, path, { start, end, maxCharacters: Math.max(0, 29_500 - header.length) }, signal);
          if (!page.lines.length && page.nextLine === start && start <= page.totalLines) throw new Error(`第 ${start} 行超过完整行返回预算，无法作为已读取源码返回；请通过符号搜索定位其它可读片段`);
          text = header + page.lines.map(line => `${line.number}: ${line.text}`).join("\n");
          if (page.nextLine !== undefined && page.nextLine <= page.totalLines) text += `\n后续从 ${page.nextLine} 行读取`;
        }
        // 引用校验只能认可实际返回的完整行，不能把截断后的行视为已读。
        const delivered = text.length > 30000 ? text.slice(0, text.lastIndexOf("\n", 30000)) : text;
        const readLines = input.action === "read" ? [...delivered.matchAll(/^(\d+):/gm)].map(m => Number(m[1])) : [];
        onUse({
          tool: "component_source",
          ...input,
          ...(input.action === "read" ? { start: readLines[0] ?? 0, end: readLines.at(-1) ?? 0 } : {}),
          path,
          revision,
          status: "returned",
          characters: text.length,
          preview: evidencePreview(text),
        });
        return reply(text.length > 30000 ? delivered + "\n返回内容已截断，请缩小 path 或 start/end 范围继续读取。" : text);
      } catch (e) {
        onUse({
          tool: "component_source",
          ...input,
          status: "failed",
          error: (e as Error).message,
        });
        return { ...reply((e as Error).message), isError: true };
      }
    },
  });
}
export function codeSearchTool(onUse: (record: Record<string, unknown>) => unknown, options?: { captureRead?: boolean; excludePath?: (path: string) => boolean; executor?: typeof executeFile }) {
  return defineTool({
    name: "code_search",
    label: "Sourcegraph 代码搜索",
    description:
      "通过 everycode 检索真实调用和单元测试。purpose 区分 usage 与 unit-test；kw query 可带 repo: 和 lang:，nls 用于场景搜索，repos 查仓库，read 按返回的仓库名、完整路径展开代码、测试准备、断言和构建上下文。",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("repos"),
        Type.Literal("kw"),
        Type.Literal("nls"),
        Type.Literal("read"),
      ]),
      query: Type.Optional(Type.String()),
      purpose: Type.Optional(Type.Union([Type.Literal("usage"), Type.Literal("unit-test")])),
      repository: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      start: Type.Optional(Type.Integer({ minimum: 1 })),
      end: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id: string, input: any, signal) {
      try {
        if (!["usage", "unit-test"].includes(input.purpose ?? "usage")) throw new Error("purpose 请使用 usage 或 unit-test");
        const args =
          input.action === "read"
            ? [
                "read",
                input.repository,
                input.path,
                `--start:=${input.start ?? 1}`,
                `--end:=${input.end ?? 160}`,
              ]
            : [input.action, input.query];
        if (
          args.some(
            (a: any) =>
              typeof a !== "string" ||
              !a ||
              a.includes("\0") ||
              (a.startsWith("-") &&
                !a.startsWith("--start:=") &&
                !a.startsWith("--end:=")),
          ) ||
          (input.action === "read" &&
            [input.repository, input.path].some((a: string) =>
              a.startsWith("-"),
            ))
        )
          throw new Error("请提供查询或仓库与文件路径");
        if (input.action === "read" && options?.excludePath?.(String(input.path))) throw new Error("组件研究只读取代码与构建配置，不读取文档或 Agent 指令");
        const text = await (options?.executor ?? executeFile)(ecBinary(), args, undefined, signal);
        if (options?.captureRead) scanForSecrets("everycode 返回", Buffer.from(text));
        const evidenceId = onUse({
          tool: "code_search",
          ...input,
          purpose: input.purpose ?? "usage",
          status: "returned",
          characters: text.length,
          preview: evidencePreview(text),
          ...(options?.captureRead && input.action === "read" ? { content: text.slice(0, 30000) } : {}),
        });
        return reply((typeof evidenceId === "string" ? `证据编号：${evidenceId}\n` : "") + text.slice(0, 30000));
      } catch (e) {
        onUse({
          tool: "code_search",
          ...input,
          status: "failed",
          error: (e as Error).message,
        });
        return { ...reply((e as Error).message), isError: true };
      }
    },
  });
}

/** One language-wide tool; checkouts are prepared only when the agent inspects a component. */
export function languageComponentSourceTool(
  components: import("./componentRepositories.ts").ComponentRepository[],
  prepare: (component: import("./componentRepositories.ts").ComponentRepository) => Promise<{root: string; revision: string}>,
  onUse: (record: Record<string, unknown>) => void,
  excludePath?: (path: string, repositoryId?: string) => boolean,
) {
  const base = componentSourceTool("", "", "", onUse);
  const sources = new Map<string, Promise<{root: string; revision: string}>>();
  return defineTool({
    ...base,
    description: `按 repository_id 选择参考来源仓；这是代码来源编号，功能组件由能力分析确定。未提供 ID 时仅在一个来源仓时自动选择。${base.description}`,
    parameters: Type.Object({ ...base.parameters.properties, repository_id: Type.Optional(Type.String()), component_id: Type.Optional(Type.String({ description: "旧固定方法的来源仓编号；新方法使用 repository_id。" })) }),
    async execute(id: string, input: any, signal, onUpdate, context) {
      if (input.repository_id && input.component_id && input.repository_id !== input.component_id) return { ...reply("参考来源仓编号不一致"), isError: true };
      const sourceId = input.repository_id ?? input.component_id;
      const component = components.find(c => c.id === sourceId) ?? (!sourceId && components.length === 1 ? components[0] : undefined);
      if (!component) return { ...reply("请指定本次参考来源仓的 repository_id"), isError: true };
      try {
        if (!sources.has(component.id)) sources.set(component.id, prepare(component));
        const source = await sources.get(component.id)!;
        return await componentSourceTool(source.root, source.revision, component.path, event => onUse({ ...event, repository_id: component.id, component_id: component.id, repository: component.repository }), `${component.id} (${component.repository})`, excludePath ? path => excludePath(path, component.id) : undefined).execute(id, input, signal, onUpdate, context);
      } catch (error) {
        sources.delete(component.id);
        const message = error instanceof Error ? error.message : "源码准备失败";
        onUse({ tool: "component_source", action: input.action, repository_id: component.id, component_id: component.id, repository: component.repository, status: "failed", error: message });
        return { ...reply(message), isError: true };
      }
    },
  });
}
