/** 只保存分析需要的会话输入；失败不能影响任务执行。 */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { redactAnalysisText } from "./analysisText.ts";

interface ContextSession {
  readonly systemPrompt?: string;
  getAllTools?(): Array<{ name: string; description?: string; parameters?: unknown }>;
  getActiveToolNames?(): string[];
}

export interface AnalysisContextSnapshotInput {
  eventLogPath: string;
  taskId: string;
  sessionId: string;
  provider: string;
  model: string;
  session: ContextSession;
  agentsFiles?: Array<{ path: string; content: string }>;
  step?: string;
  /** 显式根目录仅用于定位源码版本，不扫描宿主文件。 */
  platformRoot?: string;
  log?: (message: string) => void;
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const platformRoot = fileURLToPath(new URL("../", import.meta.url));

async function checkoutVersion(root: string): Promise<{ git_head: string | null; source: string }> {
  // 仅读取明确的版本文件；.git 为指向外部的文件时宁可记未知。
  try {
    const git = join(root, ".git");
    if (!(await lstat(git)).isDirectory() || (await lstat(git)).isSymbolicLink()) throw new Error("not local git directory");
    const head = (await readFile(join(git, "HEAD"), "utf8")).trim();
    if (/^[a-f0-9]{40,64}$/.test(head)) return { git_head: head, source: "checkout_HEAD; deployment_version_unconfirmed" };
    const ref = /^ref: (refs\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
    if (!ref || ref.split("/").includes("..")) throw new Error("invalid ref");
    let value: string;
    try {
      const refPath = join(git, ref);
      if (!(await realpath(refPath)).startsWith((await realpath(git)) + sep)) throw new Error("external ref");
      value = (await readFile(refPath, "utf8")).trim();
    } catch {
      const packed = await readFile(join(git, "packed-refs"), "utf8");
      value = packed.split("\n").find(line => line.endsWith(` ${ref}`))?.split(" ")[0] ?? "";
    }
    if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("unknown head");
    return { git_head: value, source: "checkout_HEAD; deployment_version_unconfirmed" };
  } catch { return { git_head: null, source: "unknown" }; }
}

/** 不 await 此函数也安全：所有失败都收敛为日志，不会产生未处理拒绝。 */
export async function saveAnalysisContextSnapshot(input: AnalysisContextSnapshotInput): Promise<string | undefined> {
  try {
    // 在第一个 await 前读取 SDK 对象，避免后续会话修改导致快照混入其他时刻。
    const prompt = typeof input.session.systemPrompt === "string" ? input.session.systemPrompt : undefined;
    const active = input.session.getActiveToolNames?.();
    const tools = input.session.getAllTools?.().map(tool => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      active: active ? active.includes(tool.name) : null,
    }));
    const agents = input.agentsFiles?.map(file => ({
      path: file.path, content: file.content, digest: digest(file.content),
    }));
    const capturedAt = new Date().toISOString();
    const snapshot = {
      schema: "mae-flow-analysis-context/1",
      capture_stage: "session_created",
      note: "会话创建时输入；不代表每轮动态扩展、压缩后或模型实际请求的完整上下文。",
      task_id: input.taskId, session_id: input.sessionId, step: input.step ?? null,
      captured_at: capturedAt, provider: input.provider, model: input.model,
      system_prompt: prompt ?? null, system_prompt_digest: prompt === undefined ? null : digest(prompt),
      agents_files: agents ?? null, tools: tools ?? null,
      platform_version: await checkoutVersion(resolve(input.platformRoot ?? platformRoot)),
    };
    const parent = dirname(input.eventLogPath);
    const directory = join(parent, "analysis-context");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()
      || await realpath(directory) !== join(await realpath(parent), "analysis-context")) throw new Error("快照目录不在事件目录内");
    const path = join(directory, `${capturedAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
    await writeFile(path, redactAnalysisText(JSON.stringify(snapshot, null, 2)), { mode: 0o600, flag: "wx" });
    return path;
  } catch {
    // 异常可能带敏感路径或正文，不将原始异常输出到公共日志。
    try { input.log?.("分析上下文快照保存失败；任务继续执行，事后分析需注明此项证据缺失。"); } catch { /* 观测不能影响执行 */ }
    return undefined;
  }
}
