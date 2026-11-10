import { spawn } from "node:child_process";
import { classifyKnowledgeGitFailure, type KnowledgeGitFailureKind } from "./knowledgeProductionErrors.ts";

export class KnowledgeProcessError extends Error {
  constructor(readonly code: string | number, readonly killed = false, readonly gitFailure?: KnowledgeGitFailureKind) { super("知识工具执行失败"); }
}
/** Bounded CLI execution; abort also terminates document-parser child processes. */
export function runKnowledgeCommand(file: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<string> {
  return runKnowledgeBufferCommand(file, args, options).then(buffer => buffer.toString("utf8"));
}
/** 图片等仓库资源必须保留原始字节，不能先按 UTF-8 解码再存回。 */
export function runKnowledgeBufferCommand(file: string, args: string[], options: { signal?: AbortSignal; timeoutMs: number; maxBytes: number; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<Buffer> {
  if (options.signal?.aborted) return Promise.reject(new KnowledgeProcessError("cancelled", true));
  return new Promise((resolve, reject) => {
    const detached = process.platform !== "win32";
    const child = spawn(file, args, { env: options.env ?? process.env, cwd: options.cwd, detached, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = []; let bytes = 0, diagnostics = "", failure: KnowledgeProcessError | undefined;
    const stop = (code: string) => {
      failure ??= new KnowledgeProcessError(code, true, file === "git" && code === "timeout" ? "network" : undefined);
      try { if (detached && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    };
    const abort = () => stop("cancelled");
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs); timer.unref();
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) stop("output_limit"); else chunks.push(chunk); });
    // 原始 stderr 只在内存里分类，异常仅带类别，不能泄漏凭据或命令。
    child.stderr.on("data", (chunk: Buffer) => {
      if (file === "git" && diagnostics.length < 32_768) diagnostics += chunk.toString("utf8").slice(0, 32_768 - diagnostics.length);
      bytes += chunk.length; if (bytes > options.maxBytes) stop("output_limit");
    });
    child.on("error", (error: NodeJS.ErrnoException) => { failure ??= new KnowledgeProcessError(error.code ?? "execution"); });
    child.on("close", code => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new KnowledgeProcessError(code ?? "execution", false, file === "git" ? classifyKnowledgeGitFailure(diagnostics) : undefined));
      else resolve(Buffer.concat(chunks));
    });
  });
}
