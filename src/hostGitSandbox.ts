import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

/** 宿主 Git 的短期凭据和配置隔离；不读取或改变任何任务流程状态。 */
export class HostGitSandbox {
  constructor(private readonly dataDir: string, private readonly log?: (message: string) => void) {}
  /** Host Git 动作使用的短生命周期 helper。目录/脚本仅活在一次
   * clone 或 push 的受控调用窗口，绝不进入 agentDir，也不写进仓库
   * config；调用方必须 finally cleanupHostGitCredential。 */
  private prepareHostGitCredential(
    credential: { username: string; password: string },
  ): { dir: string; helper: string } {
    // 可执行 helper 不能放系统 /tmp：生产宿主通常将 /tmp 挂成 noexec。
    // 使用 Cloud 数据目录下 0700 的控制面运行目录，仍与任务工作区隔离。
    const dir = this.createHostGitRuntimeDirectory();
    chmodSync(dir, 0o700);
    const file = join(dir, "credential");
    writeFileSync(file,
      `username=${credential.username}\npassword=${credential.password}\n`);
    chmodSync(file, 0o600);
    const script = join(dir, "helper.sh");
    writeFileSync(script, [
      "#!/bin/sh",
      'if [ "$1" = "get" ]; then',
      '  cat "$(dirname "$0")/credential"',
      "fi",
      "exit 0",
      "",
    ].join("\n"));
    chmodSync(script, 0o700);
    return { dir, helper: script };
  }

  cleanup(
    prepared: { dir: string } | undefined,
  ): void {
    if (!prepared) return;
    try {
      rmSync(prepared.dir, { recursive: true, force: true });
    } catch (error) {
      this.log?.(
        `临时 Git 凭据目录清理失败 ${prepared.dir}: ${String(error)}`);
    }
  }

  /** Host push/ls-remote 不得继承 Agent 可写的仓库配置或部署机用户配置。
   *
   * 工作区里的 .git/config、hooks、origin 都属于不可信输入：Agent 为了
   * 正常开发必须能写它们，但宿主传输不能因此执行 hook、credential
   * helper、ext remote helper，或被 url.*.insteadOf 改道。这里给一次
   * 交付动作建全新的 HOME/全局配置/askpass 边界；真正的 push 还会从
   * 一个临时 bare 仓发起，从物理上不读取工作区 .git/config。 */
  prepare(
    credential: { username: string; password: string } | undefined,
  ): {
    dir: string;
    helper?: string;
    args: string[];
    env: NodeJS.ProcessEnv;
  } {
    const prepared = credential
      ? this.prepareHostGitCredential(credential) : undefined;
    const dir = prepared?.dir ?? this.createHostGitRuntimeDirectory();
    chmodSync(dir, 0o700);
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(xdg, { mode: 0o700 });
    const globalConfig = join(dir, "global.gitconfig");
    const systemConfig = join(dir, "system.gitconfig");
    writeFileSync(globalConfig, "");
    writeFileSync(systemConfig, "");
    chmodSync(globalConfig, 0o600);
    chmodSync(systemConfig, 0o600);
    const askpass = join(dir, "reject-askpass.sh");
    writeFileSync(askpass, "#!/bin/sh\nexit 1\n");
    chmodSync(askpass, 0o700);

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Git 的环境配置注入优先级高于文件配置。部署进程若意外带了这些
    // 变量，不能让它们越过下面的 -c 硬边界；工作区定位类变量同理。
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG$/i.test(key)
          || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/i.test(key)
          || /^(?:GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_OBJECT_DIRECTORY|GIT_ALTERNATE_OBJECT_DIRECTORIES|GIT_EXEC_PATH|GIT_TEMPLATE_DIR|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND)$/i.test(key)) {
        delete env[key];
      }
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: xdg,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askpass,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "Never",
    });
    const args = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "protocol.ext.allow=never",
      // 空项先清除任何低优先级 helper；个人令牌只交给本次临时 helper。
      "-c", "credential.helper=",
      ...(prepared ? ["-c", `credential.helper=${prepared.helper}`] : []),
    ];
    return { dir, helper: prepared?.helper, args, env };
  }

  /** 一次 Host Git 动作一个私有目录。拒绝符号链接，防止控制面 helper
   * 被 Agent 或同机用户引到任务工作区；操作结束仍由既有 cleanup 删除。 */
  private createHostGitRuntimeDirectory(): string {
    const configuredDataRoot = resolve(this.dataDir);
    mkdirSync(configuredDataRoot, { recursive: true });
    const dataRoot = realpathSync(configuredDataRoot);
    const runtime = join(dataRoot, ".runtime");
    const gitRoot = join(runtime, "host-git");
    for (const directory of [runtime, gitRoot]) {
      if (existsSync(directory)) {
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(`Host Git 运行目录不是可信普通目录: ${directory}`);
        }
      } else {
        mkdirSync(directory, { mode: 0o700 });
      }
      chmodSync(directory, 0o700);
      const actual = realpathSync(directory);
      if (actual !== directory
          || !(actual === dataRoot || actual.startsWith(`${dataRoot}/`))) {
        throw new Error(`Host Git 运行目录越出 Cloud 数据目录: ${directory}`);
      }
    }
    const operation = mkdtempSync(join(gitRoot, "operation-"));
    chmodSync(operation, 0o700);
    return operation;
  }

}
export type PreparedHostGit = ReturnType<HostGitSandbox["prepare"]>;

interface AsyncGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  error?: Error;
}

/** 宿主网络 Git 的异步执行边界。timeout 时杀整个进程组，避免只杀 git
 * 却留下 ssh/credential 子进程；输出有界，远端异常也不能撑爆服务。 */
export function runGitProcess(
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxBuffer?: number;
    signal?: AbortSignal;
  },
): Promise<AsyncGitResult> {
  const aborted = () => options.signal?.reason instanceof Error ? options.signal.reason : new Error("Git 操作已停止");
  if (options.signal?.aborted) return Promise.resolve({ status: null, stdout: "", stderr: "", signal: null, timedOut: false, error: aborted() });
  return new Promise((resolveResult) => {
    const detached = process.platform !== "win32";
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached,
    });
    const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow: Error | undefined;
    let timedOut = false;
    let spawnError: Error | undefined;
    let abortError: Error | undefined;
    const append = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
      const current = stream === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = maxBuffer - current;
      if (remaining <= 0) {
        overflow ??= new Error(`git ${stream} 超过 ${maxBuffer} bytes`);
        return;
      }
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      if (stream === "stdout") stdoutBytes += kept.length;
      else stderrBytes += kept.length;
      if (kept.length < chunk.length) {
        overflow ??= new Error(`git ${stream} 超过 ${maxBuffer} bytes`);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, "stderr"));
    const killGroup = () => {
      try {
        if (detached && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // 进程可能恰好已经退出。
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    timer.unref?.();
    const abort = () => { abortError ??= aborted(); killGroup(); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveResult({
        status: (spawnError || overflow || timedOut || abortError) ? null : status,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
        ...((spawnError ?? overflow ?? abortError) ? { error: spawnError ?? overflow ?? abortError } : {}),
      });
    });
  });
}

