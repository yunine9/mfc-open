import type { PrePushBuildProfile } from "./prepushBuildPlaybook.ts";

const FAILURE_PREFIX = "__MFC_PREPUSH_ENV_FAIL__:";
const SUCCESS_MARKER = "__MFC_PREPUSH_ENV_OK__";
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;

export interface PrePushEnvironmentOptions {
  profile: PrePushBuildProfile;
  /** 部署显式挂载了 settings 时，任务必须看到同一份只读配置。 */
  requireMavenSettings: boolean;
}

export interface PrePushEnvironmentVerdict {
  ready: boolean;
  detail: string;
}

/** Docker volume 使用 `host:container[:ro|rw]`。Cloud 只支持 Unix 宿主，
 * 因而容器目标路径里不会出现冒号。 */
export function hasContainerVolumeDestination(
  volumes: readonly string[],
  destination: string,
): boolean {
  return volumes.some((volume) => {
    const fields = volume.split(":");
    if (fields.length < 2) return false;
    const candidate = fields.length > 2 ? fields[fields.length - 2] : fields[1];
    return candidate.replace(/\/+$/, "") === destination.replace(/\/+$/, "");
  });
}

function shellFailure(message: string): string {
  return `mfc_fail ${JSON.stringify(message)}`;
}

/**
 * 模型启动前的确定性环境预检。这里只检查本地事实，不访问网络，也不猜
 * 构建命令：网络/制品仓真正可用性仍由随后真实的 Maven/npm 命令证明。
 * 预检失败会直接归类 infrastructure_failure，避免 Agent 用 curl 盲探。
 */
export function prePushEnvironmentCommand(
  options: PrePushEnvironmentOptions,
): string {
  const { profile } = options;
  const lines = [
    "set -u",
    `mfc_fail() { printf '%s%s\\n' '${FAILURE_PREFIX}' "$1" >&2; exit 78; }`,
    "mfc_need() { command -v \"$1\" >/dev/null 2>&1 || mfc_fail \"缺少命令: $1\"; }",
    "mfc_writable() { test -d \"$1\" && test -w \"$1\" || mfc_fail \"目录不可写: $1\"; }",
    "mfc_need id",
    "mfc_need awk",
    "mfc_need git",
    'passwd_home="$(awk -F: -v uid="$(id -u)" \'$3 == uid { print $6; exit }\' /etc/passwd)"',
    `test -n "$passwd_home" || ${shellFailure("/etc/passwd 找不到当前容器用户")}`,
    `test "$passwd_home" = "${"${HOME:-}"}" || ${shellFailure("/etc/passwd HOME 与环境变量 HOME 不一致")}`,
    `test -w "$PWD" || ${shellFailure("任务工作区不可写")}`,
  ];

  if (profile.maven) {
    const maven = profile.maven_command;
    if (maven === "./mvnw") {
      lines.push(`test -x ./mvnw || ${shellFailure("Maven Wrapper 不可执行")}`);
    } else {
      lines.push("mfc_need mvn");
    }
    lines.push(
      `mvn_info="$(${maven} --version 2>&1)" || { printf '%s\\n' "$mvn_info" >&2; ${shellFailure("Maven 无法启动")}; }`,
      "printf '%s\\n' \"$mvn_info\"",
      `printf '%s\\n' "$mvn_info" | grep -Eq 'Java version: 21([., ]|$)' || ${shellFailure("Maven 实际使用的不是 JDK 21")}`,
      `mvn_java_home="$(printf '%s\\n' "$mvn_info" | sed -n 's/^.*runtime: \\([^,]*\\).*$/\\1/p' | head -n 1)"`,
      `test -n "$mvn_java_home" || ${shellFailure("无法从 mvn --version 识别 Java runtime")}`,
      `test -r "$mvn_java_home/lib/security/cacerts" || ${shellFailure("Maven 使用的 JDK cacerts 不可读")}`,
      "mfc_writable /cache/maven",
    );
    if (options.requireMavenSettings) {
      lines.push(
        `test -r /etc/mae-flow/maven/settings.xml || ${shellFailure("部署声明了 Maven settings 挂载，但容器内不可读")}`,
        `test -r "$HOME/.m2/settings.xml" || ${shellFailure("Maven 用户目录没有接入部署 settings.xml")}`,
      );
    }
  }

  if (profile.stacks.includes("javascript")) {
    const manager = profile.javascript?.package_manager ?? "npm";
    lines.push(
      "mfc_need node",
      `mfc_need ${manager}`,
      `test "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 18 || ${shellFailure("Node.js 版本低于 18")}`,
      "mfc_writable /cache/npm",
    );
  }

  if (profile.stacks.includes("cpp")) {
    for (const command of ["c++", "cmake", "ar", "bison", "flex"]) {
      lines.push(`mfc_need ${command}`);
    }
    lines.push(
      'sdk_cache="$(dirname "$PWD")/cpp_sdk_repository"',
      "mfc_writable \"$sdk_cache\"",
      'mkdir -p "$PWD/build"',
      'envelope_root="$(cd "$PWD/build/../.." && pwd)"',
      `test "$envelope_root/$(basename "$PWD")" = "$PWD" || ${shellFailure("C++ 仓库父子挂载拓扑不正确")}`,
    );
  }

  lines.push(`printf '%s\\n' '${SUCCESS_MARKER}'`);
  return lines.join("\n");
}

function boundedTail(output: string): string {
  const buffer = Buffer.from(output, "utf-8");
  const bounded = buffer.length > MAX_DIAGNOSTIC_BYTES
    ? buffer.subarray(buffer.length - MAX_DIAGNOSTIC_BYTES).toString("utf-8")
    : output;
  return bounded.trim().split("\n").slice(-8).join(" | ");
}

export function inspectPrePushEnvironment(
  exitCode: number | null,
  output: string,
): PrePushEnvironmentVerdict {
  if (exitCode === 0 && output.includes(SUCCESS_MARKER)) {
    return { ready: true, detail: "容器构建环境预检通过" };
  }
  const failure = output.match(new RegExp(
    `^${FAILURE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+)$`, "m",
  ))?.[1]?.trim();
  const tail = boundedTail(output);
  const reason = failure || `预检进程异常退出（exit=${exitCode ?? "signal"}）`;
  return {
    ready: false,
    detail: `容器构建环境预检失败：${reason}${tail ? `；末段输出：${tail}` : ""}`,
  };
}

export const PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER = SUCCESS_MARKER;
