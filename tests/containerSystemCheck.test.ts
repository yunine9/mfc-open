import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TaskService,
  type TaskContainerFactoryInput,
} from "../src/taskService.ts";

test("部署自检真实走统一容器并验证三类工具链，结束后销毁", async () => {
  const calls: string[] = [];
  let input: TaskContainerFactoryInput | undefined;
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-container-check-"));
  const kernelRoot = join(dataDir, "kernel");
  const settingsPath = join(dataDir, "settings.xml");
  mkdirSync(join(kernelRoot, "scripts"), { recursive: true });
  writeFileSync(join(kernelRoot, "scripts", "mae-flow.py"), "# fixture\n");
  writeFileSync(settingsPath, "<settings/>\n");
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    host: { kernelRoot, repoPath: join(dataDir, "repo"), python: "python3" },
    prepush: { enabled: true, buildSlots: 2 },
    isolation: {
      image: "internal/mae-flow-builder@sha256:fixture",
      cacheRoot: join(dataDir, "cache"),
      volumes: [
        `${settingsPath}:/etc/mae-flow/maven/settings.xml:ro`,
      ],
      memory: "8g",
      cpus: "2",
      pidsLimit: 512,
      containerFactory: (created) => {
        input = created;
        return {
          start: async () => { calls.push("start"); },
          exec: async (command, _cwd, options) => {
            calls.push("exec");
            assert.match(command, /javac/);
            assert.match(command, /c\+\+/);
            assert.match(command, /node --version/);
            assert.match(command, /\/etc\/profile\.d\/\*\.sh/);
            assert.match(command, /ca-bundle\.crt/);
            assert.match(command, /codehub-cli spes/);
            assert.match(command, /MFC_KERNEL_ROOT/);
            assert.match(command, /mae-flow\.py" init/,
              "自检必须走 Cloud 托管任务的真实机械 init");
            assert.match(command, /mae-flow\.py" current/);
            assert.match(command, /gate edit main\.ts/,
              "自检必须证明配置阶段源码写入会被内核拒绝");
            assert.match(command, /managed flow edit gate unexpectedly allowed/);
            // Execute the exact managed-flow part, not just its wording. The
            // old test mocked success and missed a real kernel policy change.
            const start = command.indexOf('if test -n "${MFC_KERNEL_ROOT:-}"; then flow_probe=');
            const end = command.indexOf('; cd "$OLDPWD"; fi', start);
            assert.ok(start >= 0 && end > start);
            const probe = command.slice(start, end + '; cd "$OLDPWD"; fi'.length);
            const scratch = mkdtempSync(join(tmpdir(), "mfc-managed-flow-probe-"));
            // Git hooks in a worktree export GIT_DIR et al. A real container
            // does not inherit them: the host probe must not reinitialize or
            // stage files in the repository currently being pushed.
            const probeEnv = { ...process.env, scratch, MFC_KERNEL_ROOT: join(process.cwd(), "kernel") };
            for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split("\n")) {
              delete (probeEnv as NodeJS.ProcessEnv)[name];
            }
            execFileSync("bash", ["-c", "set -eu; " + probe], {
              cwd: scratch, timeout: 30_000,
              env: probeEnv,
              stdio: "pipe",
            });
            assert.match(command, /passwd_home/);
            assert.match(command, /Java version: 21/,
              "不能只看 java -version，必须核对 Maven 实际使用的 JVM");
            assert.match(command, /lib\/security\/cacerts/);
            assert.match(command, /MFC_EXPECT_MAVEN_SETTINGS/);
            assert.match(command, /\$HOME\/\.m2\/settings\.xml/);
            assert.match(command, /scratch="\$PWD\/\.mfc-self-check-\$\$"/,
              "编译探针必须落在 bind-mounted workspace，不得只测 /tmp");
            for (const cache of ["maven", "npm", "ccache", "xdg"]) {
              assert.match(command, new RegExp(`/cache/${cache}`));
            }
            assert.match(command, /cpp_sdk_repository/);
            assert.match(command, /build\/\.\.\/\.\./,
              "自检必须验证仓库父子包络，而不只检查编译器在 PATH");
            options.onData(Buffer.from("__MFC_CONTAINER_TOOLCHAIN_OK__\n"));
            return { exitCode: 0 };
          },
          stop: async () => { calls.push("stop"); },
        };
      },
    },
  });

  const checked = await service.systemCheck();
  const container = checked.items.find((item) => item.key === "container");
  const prepush = checked.items.find((item) => item.key === "prepush");
  assert.equal(container?.status, "ok");
  assert.match(container?.detail ?? "", /真实启动/);
  assert.match(container?.detail ?? "", /托管任务 init\/current/);
  assert.equal(prepush?.status, "ok");
  assert.match(prepush?.detail ?? "", /构建槽位 2/);
  assert.deepEqual(calls, ["start", "exec", "stop"]);
  assert.ok(input?.volumes.some((volume) =>
    volume.endsWith(":/cache/maven")), "自检也必须验证真实缓存挂载");
  assert.ok(input?.volumes.some((volume) =>
    volume.split(":")[1]?.endsWith("/cpp_sdk_repository")),
  "自检也必须同形挂载 C++ SDK 同级缓存");
  assert.equal(input?.workspace.endsWith("/system-check-container/MfcProbeRepository"),
    true, "自检工作区必须保留父目录/仓名层级");
  assert.ok(input?.volumes.includes(`${kernelRoot}:${kernelRoot}:ro`),
    "自检必须同形挂载并验证 Mae-Flow 内核根");
  assert.ok(input?.volumes.includes(
    `${settingsPath}:/etc/mae-flow/maven/settings.xml:ro`));
  assert.equal(input?.options.environment?.MFC_KERNEL_ROOT, kernelRoot);
  assert.equal(input?.options.environment?.MFC_EXPECT_MAVEN_SETTINGS, "1");
  assert.equal(input?.limits.memory, "8g");
  assert.equal(input?.limits.pidsLimit, 512);
  assert.equal(input?.options.labels?.["com.mae-flow-cloud.role"], "system-check");
  assert.match(input?.options.labels?.["com.mae-flow-cloud.instance"] ?? "",
    /^[a-f0-9]{64}$/);
});

test("部署自检失败返回 phase/name/id/image 与输出末段，便于直接定位", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-container-check-fail-"));
  const service = new TaskService({
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    prepush: { enabled: true },
    isolation: {
      image: "internal/builder:broken",
      cacheRoot: join(dataDir, "cache"),
      containerFactory: () => ({
        start: async () => undefined,
        exec: async (_command, _cwd, options) => {
          options.onData(Buffer.from("javac: compiler exploded at Probe.java:7\n"));
          return { exitCode: 2 };
        },
        stop: async () => undefined,
      }),
    },
  });
  const checked = await service.systemCheck();
  const item = checked.items.find((entry) => entry.key === "container");
  assert.equal(item?.status, "error");
  assert.match(item?.suggestion ?? "", /phase=toolchain-exec/);
  assert.match(item?.suggestion ?? "", /role=system-check name=mfc-/);
  assert.match(item?.suggestion ?? "", /id=unknown image=internal\/builder:broken/);
  assert.match(item?.suggestion ?? "", /Probe\.java:7/);
});

test("启动退出时没有 metadata 也能将真实 ID 和子阶段返回自检页面", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-check-startup-id-"));
  const service = new TaskService({ dataDir, provider: "fixture", model: "fixture", modelsJson: {},
    isolation: { image: "standard/builder", containerFactory: () => ({
      diagnostics: { containerId: "a".repeat(64), phase: "startup-inspect" },
      start: async () => { throw new Error("退出码 73；build environment is not writable: /home/builder/.m2"); },
      exec: async () => { throw new Error("不能执行"); }, stop: async () => undefined,
    }) },
  });
  const result = await service.systemCheck();
  const message = result.items.find((item) => item.key === "container")?.suggestion ?? "";
  assert.match(message, /phase=startup-inspect.*id=aaaaaaaaaaaa/);
  assert.match(message, /退出码 73.*\/home\/builder/);
  assert.doesNotMatch(message, /id=unknown/);
});

