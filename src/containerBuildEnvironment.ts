import { isAbsolute, posix } from "node:path";

/** 用户目录是一个整体：不能只覆盖 HOME，却让 Maven/npm 继续写镜像旧目录。 */
export function containerUserEnvironment(home: string): Record<string, string> {
  if (!isAbsolute(home) || posix.normalize(home) !== home
      || /[\s:,\0]/.test(home) || home.split("/").filter(Boolean).length < 2
      || ["/tmp", "/proc", "/sys", "/dev", "/etc"].some((root) => home === root || home.startsWith(`${root}/`))) {
    throw new Error(`容器 HOME 必须是独立的绝对用户目录: ${home}`);
  }
  return { HOME: home, MAVEN_CONFIG: `${home}/.m2`,
    NPM_CONFIG_USERCONFIG: `${home}/.npmrc`, TMPDIR: "/tmp" };
}

/** 在登录 shell 加载镜像 profile 后探测。缓存加速器缺席不应让编译器无法启动。 */
export function withOptionalCompilerCache(command: string): string {
  return 'if command -v ccache >/dev/null 2>&1; then '
    + 'export CMAKE_C_COMPILER_LAUNCHER="${CMAKE_C_COMPILER_LAUNCHER:-ccache}"; '
    + 'export CMAKE_CXX_COMPILER_LAUNCHER="${CMAKE_CXX_COMPILER_LAUNCHER:-ccache}"; fi\n'
    + command;
}

/** 原生镜像不需要安装平台 entrypoint；平台在已隔离的容器内准备临时用户配置。 */
export const CONTAINER_USER_BOOTSTRAP = [
  "set -eu",
  'mkdir -p "$MAVEN_CONFIG"',
  'test -w "$HOME" && test -w "$MAVEN_CONFIG"',
  'if test -f /etc/mae-flow/maven/settings.xml; then test -r /etc/mae-flow/maven/settings.xml; ln -sfn /etc/mae-flow/maven/settings.xml "$MAVEN_CONFIG/settings.xml"; fi',
].join("; ");
