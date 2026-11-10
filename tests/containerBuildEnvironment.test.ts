import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CONTAINER_USER_BOOTSTRAP, containerUserEnvironment, withOptionalCompilerCache } from "../src/containerBuildEnvironment.ts";
import { DockerCliRunner } from "../src/containerRuntime.ts";

test("平台统一用户配置路径覆盖镜像旧 MAVEN_CONFIG，普通 shell 实际能写入", () => {
  const parent = join(homedir(), ".cache", "mae-flow-cloud-tests");
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, "mfc-native-home-"));
  const env = { ...process.env, MAVEN_CONFIG: "/home/builder/.m2", ...containerUserEnvironment(home) };
  execFileSync("sh", ["-c", CONTAINER_USER_BOOTSTRAP], { env });
  assert.equal(env.MAVEN_CONFIG, `${home}/.m2`);
  assert.ok(existsSync(join(home, ".m2")));
});

test("缓存加速器缺席可正常执行，存在才设置 launcher，并保留显式配置", () => {
  const bin = mkdtempSync(join(tmpdir(), "mfc-optional-ccache-"));
  const run = (extra = {}) => execFileSync("/bin/sh", ["-c", withOptionalCompilerCache(
    'printf "%s/%s" "${CMAKE_C_COMPILER_LAUNCHER:-none}" "${CMAKE_CXX_COMPILER_LAUNCHER:-none}"')],
  { encoding: "utf8", env: { PATH: bin, ...extra } });
  assert.equal(run(), "none/none");
  writeFileSync(join(bin, "ccache"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(run(), "ccache/ccache");
  assert.equal(run({ CMAKE_C_COMPILER_LAUNCHER: "sccache" }), "sccache/ccache");
});

test("docker logs 成功但错误日志在 stderr 时也能收集，其他命令 stdout 保持纯净", async () => {
  const bin = mkdtempSync(join(tmpdir(), "mfc-docker-stderr-"));
  writeFileSync(join(bin, "docker"), '#!/bin/sh\nprintf "container-id\\n"\nprintf "build environment is not writable: /home/builder/.m2\\n" >&2\n', { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = bin;
  try {
    const runner = new DockerCliRunner();
    assert.equal(await runner.command(["run"]), "container-id");
    assert.match(await runner.command(["logs", "id"], { includeStderr: true }), /not writable/);
  } finally { process.env.PATH = previous; }
});
