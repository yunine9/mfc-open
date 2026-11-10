/**
 * 问题流的宿主侧运维工具执行器(build-deploy)。
 *
 * 日志抓取引擎已迁为平台技能 fetch-logs 的 bin(容器内由 Agent 直接
 * 跑,见 assets/issue-skills/fetch-logs),这里只剩 build-deploy:
 * 二进制来自 assets/ops-tools(every-skill 仓的 Go 产物,本仓带
 * linux-amd64/arm64/exe 三平台)。关键边界:密码经环境变量只交给
 * 子进程(BUILD_DEPLOY_PASSWORD),不落盘、不回传、不进模型上下文
 * ——与旧 Go 适配器同一条纪律。
 *
 * 2026-08-31:build-deploy 原在宿主(root)执行,AI 的 bash 走容器内
 * (mfc 用户),Maven 环境(root 的 /root/.m2 vs 容器 /tmp/m2)不一致
 * 导致 PluginContainerException。现在 ops 工具优先走容器内执行
 * (containerExec),与 AI bash 同一条路,环境天然一致。无 isolation
 * 的旧部署/测试回退到宿主执行。
 *
 * 2026-09-02:容器内超时的第一响应改为 coreutils timeout(把命令放进
 * 独立进程组,到点 TERM 整组、kill-after 后 KILL)——只了结工具进程,
 * 容器不动。此前沿用 TaskContainer.exec 的"超时=销毁容器"语义,对
 * 已知耗时的换库构建过于连坐:一次合法的长构建就会把会话容器掀掉。
 * docker exec 的客户端超时杀不到容器内进程(docker 公认语义,非实测:
 * exec 进程归容器 PID 1 管,客户端死掉它照跑),销毁容器降级为进程组
 * 都杀不干净时的兜底(TaskContainer.exec 的超时加了余量,必须赛输
 * 容器内 timeout),宿主回退路径(execFile 直接杀子进程)不变。
 * 诚实边界:已验 = 命令形状/兜底时序/124 转译(假件契约测试);未验 =
 * 真容器内的 TERM→KILL 链(真 Docker 用例待补)。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  backstopTimeoutSeconds,
  shellQuote,
  timeoutPrefix,
  TIMEOUT_EXIT_CODE,
} from "../containerTimeout.ts";

export interface OpsBuildDeployRequest {
  /** 含 deployment/pom.xml 的项目根(会话工作区内的克隆目录)。 */
  projectPath: string;
  hosts: string[];
  password: string;
  includeLib: boolean;
}

/** 日志抓取已是平台技能 fetch-logs(整包自带 bin 引擎),这里只剩
 * build-deploy——它被 ADR-0013 封存,引擎随技能迁移前原地保留。 */
export interface IssueOpsTools {
  buildDeploy(request: OpsBuildDeployRequest): Promise<{ summary: string }>;
}

export class IssueOpsError extends Error {}

function platformBinary(toolsDir: string, base: string): string {
  const name = process.platform === "win32"
    ? `${base}.exe`
    : process.arch === "arm64" ? `${base}-linux-arm64` : `${base}-linux-amd64`;
  const path = join(toolsDir, name);
  if (!existsSync(path)) {
    throw new IssueOpsError(`运维二进制不存在: ${path}(部署需带 assets/ops-tools)`);
  }
  return path;
}

/**
 * 容器内二进制名(断定宿主与容器架构一致,坑2 已忽略)。
 * 容器内路径是 workspace 下的 .ops-tools/<binary>。
 */
function containerBinary(base: string): string {
  const name = process.platform === "win32"
    ? `${base}.exe`
    : process.arch === "arm64" ? `${base}-linux-arm64` : `${base}-linux-amd64`;
  return join(".ops-tools", name);
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 容器内执行能力(与 TaskContainer.exec 同形,但返回收集后的 stdout/stderr)。 */
export interface ContainerExec {
  exec(
    command: string,
    cwd: string,
    options: {
      timeout?: number;
      /** 运维密码等特例凭据,绕过容器 SECRET_ENV 正则和白名单。 */
      privilegedEnv?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

function run(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(binary, args, {
      env,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      resolve({
        code: error ? (typeof code === "number" ? code : -1) : 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

function tail(text: string, limit = 2_500): string {
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

// 容器内超时机制已抽到共享模块(2026-09-04):AI bash 路径跟进同款
// 语义,常量与拼装收拢到 src/containerTimeout.ts,这里只消费。

/** 成功哨兵:退出码之外,以工具自己的输出作"活真干完了"的唯一证据。
 * 2026-09-02 拍板把哨兵收拢到这一处——调用方的成功判定和 runInContainer
 * 的超时守卫共用同一份真相,免得两处正则各写一份、日后各自漂移。
 * (拉日志引擎已迁为平台技能 fetch-logs 的 bin,哨兵随迁技能正文。) */
export const BUILD_DEPLOY_SENTINEL = /\[INFO\].*部署完成/;

/** 失败报错统一拼输出尾部(stdout\nstderr 合并取尾):超时与业务失败
 * 共用同一拼装,模型能看到的现场就只有报错里的这段尾部。suffix 供
 * buildDeploy 追加诊断段。 */
function failureWithTail(
  prefix: string,
  // 结构化收窄:容器 exec 的原始结果(exitCode)与 RunResult(code)都要能进来。
  output: { stdout: string; stderr: string },
  suffix = "",
): IssueOpsError {
  return new IssueOpsError(
    prefix + tail(`${output.stdout}\n${output.stderr}`.trim()) + suffix);
}

/**
 * 容器内执行:通过 docker exec 在容器内跑 ops 二进制,收集 stdout/stderr。
 * 超时的第一响应在容器内:coreutils timeout(基座镜像 Ubuntu/Debian,
 * coreutils 必有)把命令放进独立进程组,到点 TERM 整组、kill-after 后
 * KILL——只了结工具进程,容器不动。工具被 timeout 了结时退出码固定
 * 124(TIMEOUT_EXIT_CODE),这里转成带输出尾部的明确报错;但若成功
 * 哨兵已出现在输出里,说明活其实干完了,124 另有端倪,此时不冒充
 * 超时,原样交还调用方的常规失败路径去报。
 */
async function runInContainer(
  containerExec: ContainerExec,
  binary: string,
  args: string[],
  privilegedEnv: NodeJS.ProcessEnv,
  timeoutMs: number,
  workspace: string,
  sentinel: RegExp,
): Promise<RunResult> {
  const command = [
    ...timeoutPrefix(timeoutMs / 1000),
    shellQuote(binary), ...args.map(shellQuote),
  ].join(" ");
  const result = await containerExec.exec(command, workspace, {
    timeout: backstopTimeoutSeconds(timeoutMs / 1000),
    privilegedEnv,
  });
  if (result.exitCode === TIMEOUT_EXIT_CODE
    && !sentinel.test(`${result.stdout}\n${result.stderr}`)
  ) {
    throw failureWithTail(
      `命令超过 ${Math.round(timeoutMs / 60_000)} 分钟预算,已由容器内 `
        + `timeout 终止——只终止了工具进程,容器与工作区不受影响,`
        + `排查后可重试。输出尾部: `,
      result,
    );
  }
  return {
    code: result.exitCode ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function createGoOpsTools(options: {
  toolsDir: string;
  /** 容器内执行能力;有 isolation 才传,走容器内执行。 */
  containerExec?: ContainerExec;
  /** 会话工作区(容器内同路径挂载);containerExec 在场时必传,
   *  作为 docker exec 的 cwd——resolve(".") 会解析为宿主启动目录,
   *  不在 workspace 内,被安全检查拒绝。 */
  workspace?: string;
  log?: (message: string) => void;
}): IssueOpsTools {
  const { toolsDir, containerExec, workspace, log } = options;
  return {
    async buildDeploy(request) {
      if (!request.hosts.length) throw new IssueOpsError("未提供部署目标服务器");
      if (!existsSync(join(request.projectPath, "deployment", "pom.xml"))) {
        throw new IssueOpsError(
          `项目路径 ${request.projectPath} 下没有 deployment/pom.xml,`
          + "build-deploy 无法识别服务——请确认代码仓结构");
      }
      const args = [
        "--project-path", request.projectPath,
        ...request.hosts.flatMap((host) => ["--host", host]),
      ];
      if (request.includeLib) args.push("--include-lib");
      log?.(`[build-deploy]: ${request.projectPath} @ `
        + `${request.hosts.join(",")}${request.includeLib ? " (含 lib)" : ""}`);
      const privilegedEnv = { BUILD_DEPLOY_PASSWORD: request.password };
      const result = containerExec
        ? await runInContainer(
          containerExec, containerBinary("build-deploy"), args,
          privilegedEnv, 20 * 60_000, workspace!, BUILD_DEPLOY_SENTINEL,
        )
        : await run(
          platformBinary(toolsDir, "build-deploy"), args,
          { ...process.env, BUILD_DEPLOY_PASSWORD: request.password },
          20 * 60_000,
        );
      if (result.code !== 0 || !BUILD_DEPLOY_SENTINEL.test(result.stdout)) {
        // 构建失败时输出诊断上下文:Maven settings 是否可读、本地仓库状态。
        // 常见根因:settings.xml 权限不对(640 root:root)→ Maven 找不到
        // 内部仓库 → parent POM 不可解析。
        let diag = "";
        if (containerExec) {
          try {
            const check = await containerExec.exec(
              'echo "settings:$(test -r "$HOME/.m2/settings.xml" && echo OK || echo MISSING)"'
              + ' && echo "repo:$(ls -d /cache/maven/repository 2>/dev/null && echo EXISTS || echo NONE)"'
              + ' && echo "maven_opts:${MAVEN_OPTS:-unset}"',
              workspace!,
              { timeout: 5 },
            );
            diag = `\n[诊断] ${check.stdout.trim()}`;
          } catch { /* best-effort */ }
        }
        throw failureWithTail(
          `构建部署失败(退出码 ${result.code}): `, result, diag);
      }
      return { summary: `部署输出:\n${tail(result.stdout)}` };
    },
  };
}
