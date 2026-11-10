import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(root, "deploy", "build-image");
const dockerfile = readFileSync(join(assets, "Dockerfile"), "utf-8");
const entrypoint = readFileSync(join(assets, "entrypoint.sh"), "utf-8");
const settings = readFileSync(
  join(assets, "maven-settings.example.xml"), "utf-8");
const readme = readFileSync(join(assets, "README.md"), "utf-8");

test("build image: 工具链版本明确且最终以非 root builder 运行", () => {
  assert.match(dockerfile,
    /ARG JAVA_MAVEN_BASE_IMAGE=maven:3\.9\.9-eclipse-temurin-21-jammy@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile,
    /ARG NODE_BASE_IMAGE=node:18\.16\.1-bullseye-slim@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(dockerfile, /(?:FROM|ARG [A-Z_]+_IMAGE=)[^\n]*:latest/i);

  for (const tool of [
    "binutils", "bison", "ccache", "flex", "g++", "gcc", "git",
    "python3", "tini",
  ]) {
    const escaped = tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(dockerfile, new RegExp(`(?:^|\\s)${escaped}(?:\\s|;|$)`, "m"));
  }
  assert.match(dockerfile, /test "\$\(node --version\)" = "v18\.16\.1"/);
  assert.match(dockerfile, /test "\$\(npm --version\)" = "9\.5\.1"/);
  assert.match(dockerfile, /USER builder:builder/);
  assert.match(dockerfile,
    /com\.mae-flow\.builder\.contract="mae-flow-task-builder\/1"/);
  assert.ok(dockerfile.indexOf("USER builder:builder")
    < dockerfile.indexOf("RUN sh -lc 'set -eu"),
  "工具链必须在最终非 root 用户下验证");
  assert.match(dockerfile, /\/etc\/profile\.d\/\*\.sh/);
  assert.match(dockerfile, /\/etc\/pki\/tls\/certs\/ca-bundle\.crt/);
  assert.match(dockerfile, /codehub-cli spes/);
  assert.match(dockerfile, /HOME=\/home\/mae-flow/);
  assert.match(dockerfile, /MAVEN_CONFIG=\/home\/mae-flow\/\.m2/);
  assert.match(dockerfile, /TMPDIR=\/tmp(?:\s|$)/m,
    "TMPDIR 必须指向 tmpfs 根；流水线覆盖 entrypoint 时不能依赖预建子目录");
  assert.doesNotMatch(dockerfile, /TMPDIR=\/tmp\/[A-Za-z0-9._-]+/);
  assert.doesNotMatch(dockerfile, /\/home\/builder/);
  assert.match(dockerfile, /passwd_home/);
  assert.match(dockerfile, /Java version: 21/,
    "镜像构建时必须核对 Maven 实际使用的 JVM，而非只跑 java -version");
  assert.match(dockerfile, /lib\/security\/cacerts/);
  assert.match(dockerfile, /\/etc\/mae-flow\/maven/);
  assert.match(dockerfile,
    /ENTRYPOINT \["\/usr\/local\/bin\/mae-flow-build-entrypoint"\]/);
  assert.doesNotMatch(dockerfile,
    /ENTRYPOINT \["\/usr\/bin\/tini"/);
});

test("build image: 缓存分仓挂载，settings 与 CA 只读接入", () => {
  assert.match(dockerfile, /-Dmaven\.repo\.local=\/cache\/maven\/repository/);
  assert.match(dockerfile, /MFC_MAVEN_CACHE=\/cache\/maven\/repository/);
  assert.match(dockerfile, /NPM_CONFIG_CACHE=\/cache\/npm/);
  assert.match(dockerfile, /CCACHE_DIR=\/cache\/ccache/);
  assert.match(entrypoint, /\/etc\/mae-flow\/maven\/settings\.xml/);
  assert.match(entrypoint, /\/etc\/mae-flow\/ca\/company-ca\.pem/);
  assert.match(readme,
    /settings\.xml:\/etc\/mae-flow\/maven\/settings\.xml:ro/);
  assert.match(readme, /company-ca\.pem:\/etc\/mae-flow\/ca\/company-ca\.pem:ro/);
  assert.match(readme, /java-cacerts:\/opt\/java\/openjdk\/lib\/security\/cacerts:ro/);
  assert.match(readme, /<repository-id>\/maven:\/cache\/maven:rw/);
  assert.match(readme, /tmpfs:\/home\/mae-flow:rw,nosuid,nodev,mode=1777/);
  assert.match(readme, /tmpfs:\/tmp:rw,exec,nosuid,nodev,mode=1777/);
  assert.match(readme, /\/tmp` 必须显式带 `exec`/);
  assert.match(entrypoint, /"\$\{HOME\}"/);
  assert.match(entrypoint, /"\$\{MAVEN_CONFIG\}"/);
  assert.match(entrypoint, /build user HOME mismatch/);
  assert.match(entrypoint, /mounted Maven settings is not readable/);
});

test("build image: 不内置凭据、不关闭 TLS、不暴露宿主控制面", () => {
  const executableAssets = `${dockerfile}\n${entrypoint}\n${settings}`;
  assert.doesNotMatch(executableAssets, /sslVerify\s+false/i);
  assert.doesNotMatch(executableAssets, /strict-ssl\s*[=:]\s*false/i);
  assert.doesNotMatch(executableAssets, /(?:curl|wget)[^\n]*(?:--insecure|\s-k\b)/i);
  assert.doesNotMatch(settings, /<server>/i);
  assert.doesNotMatch(settings, /<password>/i);
  assert.doesNotMatch(dockerfile, /(?:TOKEN|PASSWORD|SECRET)\s*=/i);
  assert.match(entrypoint, /http\.sslCAInfo/);
  assert.match(readme, /TLS 校验始终保持开启/);
  assert.match(readme, /不挂载宿主 `HOME`/);
  assert.match(readme, /\/var\/run\/docker\.sock/);
});

test("build image: 支持 digest 覆盖和离线内部基础镜像", () => {
  assert.match(readme, /JAVA_MAVEN_BASE_IMAGE=.*@sha256:<approved-digest>/);
  assert.match(readme, /NODE_BASE_IMAGE=.*@sha256:<approved-digest>/);
  assert.match(dockerfile, /ARG INSTALL_OS_PACKAGES=true/);
  assert.match(readme, /INSTALL_OS_PACKAGES=false/);
});

test("build image: entrypoint 通过 POSIX shell 静态语法检查", () => {
  const checked = spawnSync("sh", ["-n", join(assets, "entrypoint.sh")], {
    encoding: "utf-8",
  });
  assert.equal(checked.status, 0, checked.stderr);
});
