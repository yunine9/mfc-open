import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DockerCommandError,
  type DockerRunner,
  type DockerStreamOptions,
  type DockerStreamProcess,
  TASK_CONTAINER_HOME,
  TaskContainer,
  TaskContainerExecTimeoutError,
  TaskContainerUnavailableError,
  dockerAvailable,
  sweepManagedTaskContainers,
  taskContainerInstance,
} from "../src/containerRuntime.ts";

const ID = "a".repeat(64);
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const REPO_DIGEST = `registry.internal/build@sha256:${"c".repeat(64)}`;

function missing(args: readonly string[]): DockerCommandError {
  return new DockerCommandError(
    args,
    `Error response from daemon: No such container: ${args.at(-1)}`,
    1,
  );
}

class FakeDockerRunner implements DockerRunner {
  readonly commands: string[][] = [];
  readonly streams: string[][] = [];
  exists = false;
  running = false;
  stopRemoves = true;
  killRemoves = false;
  rmRemoves = true;
  insecureInspect = false;
  extraImageEnv: string[] = [];
  hangingStream = false;
  inspectFailuresRemaining = 0;
  streamKillCount = 0;
  configUser?: string;
  exitOnStart = false;
  private runArguments: string[] = [];

  constructor(readonly workspace: string) {}

  async command(args: readonly string[]): Promise<string> {
    const copy = [...args];
    this.commands.push(copy);
    if (args[0] === "info") return "27.0";
    if (args[0] === "exec") return "";
    if (args[0] === "run") {
      this.runArguments = copy;
      this.exists = true;
      this.running = !this.exitOnStart;
      return ID;
    }
    if (args[0] === "inspect") {
      if (!this.exists) throw missing(args);
      if (this.inspectFailuresRemaining > 0) {
        this.inspectFailuresRemaining -= 1;
        throw new Error("simulated truncated inspect response");
      }
      if (args.includes("--format")) return String(this.running);
      return JSON.stringify([this.inspectRecord()]);
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [REPO_DIGEST] }]);
    }
    if (args[0] === "logs") return "build environment is not writable: /home/builder/.m2";
    if (args[0] === "stop") {
      if (!this.exists) throw missing(args);
      this.running = false;
      if (this.stopRemoves) this.exists = false;
      return String(args.at(-1));
    }
    if (args[0] === "kill") {
      if (!this.exists) throw missing(args);
      this.running = false;
      if (this.killRemoves) this.exists = false;
      return String(args.at(-1));
    }
    if (args[0] === "rm") {
      if (!this.exists) throw missing(args);
      if (this.rmRemoves) this.exists = false;
      return String(args.at(-1));
    }
    throw new Error(`Fake 未实现 docker ${args.join(" ")}`);
  }

  stream(args: readonly string[], _options: DockerStreamOptions): DockerStreamProcess {
    this.streams.push([...args]);
    let finish!: (result: { exitCode: number | null }) => void;
    const completed = new Promise<{ exitCode: number | null }>((done) => {
      finish = done;
      if (!this.hangingStream) queueMicrotask(() => done({ exitCode: 0 }));
    });
    return {
      completed,
      kill: () => {
        this.streamKillCount += 1;
        finish({ exitCode: null });
      },
    };
  }

  private valueAfter(flag: string): string | undefined {
    const position = this.runArguments.indexOf(flag);
    return position < 0 ? undefined : this.runArguments[position + 1];
  }

  private valuesAfter(flag: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < this.runArguments.length - 1; index += 1) {
      if (this.runArguments[index] === flag) values.push(this.runArguments[index + 1]);
    }
    return values;
  }

  private inspectRecord(): Record<string, unknown> {
    const env = this.valuesAfter("-e");
    const labels = Object.fromEntries(
      this.valuesAfter("--label").map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    const tmpfs = Object.fromEntries(
      this.valuesAfter("--tmpfs").map((entry) => {
        const separator = entry.indexOf(":");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
    return {
      Id: ID,
      Name: `/${this.valueAfter("--name") ?? "mfc-hardening-test"}`,
      Image: IMAGE_ID,
      Created: "2026-08-21T01:00:00Z",
      Config: {
        Image: "internal/build:21",
        User: this.configUser ?? this.valueAfter("--user") ?? "1000:1000",
        Env: [...env, ...this.extraImageEnv],
        Labels: labels,
      },
      State: { Running: this.running, ExitCode: this.exitOnStart ? 73 : 0, StartedAt: "2026-08-21T01:00:01Z" },
      HostConfig: {
        ReadonlyRootfs: this.insecureInspect
          ? false : this.runArguments.includes("--read-only"),
        CapDrop: this.insecureInspect ? [] : ["ALL"],
        SecurityOpt: this.insecureInspect ? [] : ["no-new-privileges:true"],
        PidsLimit: Number(this.valueAfter("--pids-limit") ?? 0),
        NetworkMode: this.valueAfter("--network"),
        Memory: 4 * 1024 ** 3,
        NanoCpus: 2 * 10 ** 9,
        Tmpfs: tmpfs,
      },
      Mounts: this.valuesAfter("-v").map((volume) => {
        const parts = volume.split(":");
        return {
          Destination: resolve(parts[1]),
          RW: parts[2] !== "ro",
          Type: "bind",
        };
      }),
    };
  }
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "mfc-container-runtime-"));
}

function container(
  runner: FakeDockerRunner,
  options: ConstructorParameters<typeof TaskContainer>[6] = {},
  volumes: string[] = [],
): TaskContainer {
  return new TaskContainer(
    "internal/build:21",
    runner.workspace,
    "mfc-hardening-test",
    undefined,
    volumes,
    { memory: "4g", cpus: "2", user: "1000:1000", pidsLimit: 77 },
    { runner, ...options },
  );
}

test("命令检查及运行期间标记活动，成功和失败后都释放", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner);
  assert.equal(subject.hasActiveProcesses, false);
  await subject.start();
  const pending = subject.exec("true", runner.workspace, { onData() {} });
  assert.equal(subject.hasActiveProcesses, true, "异步容器检查前就已标记");
  await pending;
  assert.equal(subject.hasActiveProcesses, false);
  await subject.stop();
  await assert.rejects(subject.exec("true", runner.workspace, { onData() {} }));
  assert.equal(subject.hasActiveProcesses, false);
});

test("标准镜像原生 HOME 同步用户配置、tmpfs，镜像旧 Maven 目录被明确覆盖", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner, { environment: { HOME: "/home/builder" } });
  await subject.start();
  const run = runner.commands.find((args) => args[0] === "run")!;
  assert.ok(run.includes("HOME=/home/builder"));
  assert.ok(run.includes("MAVEN_CONFIG=/home/builder/.m2"));
  assert.ok(run.includes("NPM_CONFIG_USERCONFIG=/home/builder/.npmrc"));
  assert.ok(run.includes("/home/builder:rw,nosuid,nodev,size=256m,mode=1777"));
  assert.ok(run.includes("--read-only"));
  assert.ok(runner.commands.some((args) => args[0] === "exec" && args.at(-1)?.includes('"$MAVEN_CONFIG/settings.xml"')),
    "原生镜像没有平台 entrypoint 时也接入部署 Maven settings");
  await subject.stop();
  assert.equal(runner.exists, false);
});

test("entrypoint 退出 73 保留真实 ID、退出码和日志，取证后显式清理", async () => {
  const runner = new FakeDockerRunner(workspace());
  runner.exitOnStart = true;
  const subject = container(runner);
  await assert.rejects(subject.start(), /id=aaaaaaaaaaaa.*退出码 73.*\/home\/builder\/\.m2/);
  assert.equal(subject.metadata, undefined);
  assert.equal(subject.diagnostics.containerId, ID, "metadata 未赋值也能诊断真实 ID");
  assert.equal(subject.diagnostics.phase, "startup-inspect");
  assert.equal(runner.exists, false, "失败取证后不能留容器");
  assert.ok(runner.commands.findIndex((args) => args[0] === "logs")
    < runner.commands.findIndex((args) => args[0] === "stop"));
});

test("start 强制加固参数、精确 safe.directory，并记录不可变镜像元数据", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner, {
    labels: { "com.example.team": "alpha" },
    environment: { MAVEN_OPTS: "-Xmx2g" },
    forwardEnvironment: ["BUILD_FLAVOR"],
    network: "build-net",
  }, [`${join(runner.workspace, "maven-cache")}:/cache/maven:rw`]);
  await subject.start();

  const run = runner.commands.find((args) => args[0] === "run");
  assert.ok(run, "必须执行 docker run");
  assert.ok(run.includes("--read-only"));
  assert.deepEqual(run.slice(run.indexOf("--cap-drop"), run.indexOf("--cap-drop") + 2),
    ["--cap-drop", "ALL"]);
  assert.ok(run.includes("no-new-privileges:true"));
  assert.ok(run.includes(`${TASK_CONTAINER_HOME}:rw,nosuid,nodev,size=256m,mode=1777`));
  assert.ok(run.includes(`MAVEN_CONFIG=${TASK_CONTAINER_HOME}/.m2`));
  assert.ok(run.includes(`NPM_CONFIG_USERCONFIG=${TASK_CONTAINER_HOME}/.npmrc`));
  assert.equal(run.includes("--rm"), false, "先取退出诊断，再由 stop/失败清理/启动清扫显式回收");
  assert.ok(run.includes("/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777"));
  assert.ok(run.includes("GIT_CONFIG_KEY_0=safe.directory"));
  assert.ok(run.includes(`GIT_CONFIG_VALUE_0=${resolve(runner.workspace)}`));
  assert.ok(!run.some((value) => value.includes("safe.directory=*")));
  assert.ok(run.includes("com.example.team=alpha"));
  assert.ok(run.includes("MAVEN_OPTS=-Xmx2g"));

  assert.equal(subject.state, "running");
  assert.equal(subject.metadata?.imageId, IMAGE_ID);
  assert.equal(subject.metadata?.imageDigest, REPO_DIGEST);
  assert.equal(subject.metadata?.immutableImageReference, REPO_DIGEST);
  assert.equal(subject.metadata?.network, "build-net");
  assert.equal(subject.metadata?.pidsLimit, 77);
  assert.deepEqual(subject.metadata?.mounts.find((mount) =>
    mount.destination === "/cache/maven"), {
    destination: "/cache/maven", readOnly: false, type: "bind",
  });

  await subject.exec("printf ok", runner.workspace, {
    onData: () => undefined,
    env: {
      BUILD_FLAVOR: "fast",
      ANTHROPIC_API_KEY: "must-not-leak",
      PATH: "/host/only",
    },
  });
  const exec = runner.streams.at(-1)!;
  assert.ok(exec.includes("BUILD_FLAVOR=fast"));
  assert.ok(!exec.some((value) => value.includes("must-not-leak")));
  assert.ok(!exec.includes("PATH=/host/only"));
  await assert.rejects(
    subject.exec("pwd", join(runner.workspace, ".."), { onData: () => undefined }),
    /工作区之外/,
  );

  await subject.stop();
  assert.equal(subject.state, "stopped");
});

test("#75 npm_config_registry 以 -e 进容器创建参数,保留名单不拦", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner, {
    environment: {
      npm_config_registry: "https://npm.intra.example/repository/npm-group/",
    },
  });
  await subject.start();
  const run = runner.commands.find((args) => args[0] === "run");
  assert.ok(run?.includes(
    "npm_config_registry=https://npm.intra.example/repository/npm-group/"),
  "#75:registry 必须真的以 -e 进 docker run,内网 npm 才不打公网");
  await subject.stop();
  assert.equal(subject.state, "stopped");
});

test("exec 的瞬时 inspect 故障会重试且不会永久污染 lifecycle", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner);
  await subject.start();
  runner.inspectFailuresRemaining = 1;

  const result = await subject.exec("printf ok", runner.workspace, {
    onData: () => undefined,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(subject.state, "running");
  assert.ok(runner.commands.filter((args) => args.includes("--format")).length >= 2);
  await subject.stop();
});

test("连续 inspect 基础设施故障按结构化错误熔断但允许下一轮重新探测", async () => {
  const runner = new FakeDockerRunner(workspace());
  const subject = container(runner);
  await subject.start();
  runner.inspectFailuresRemaining = 3;

  await assert.rejects(
    subject.exec("printf first", runner.workspace, { onData: () => undefined }),
    (error: unknown) => error instanceof TaskContainerUnavailableError
      && error.kind === "inspect_unavailable",
  );
  assert.equal(subject.state, "running", "不可观测不等于容器已停止");

  const recovered = await subject.exec("printf second", runner.workspace, {
    onData: () => undefined,
  });
  assert.equal(recovered.exitCode, 0);
  await subject.stop();
});

test("疑似凭据、保留环境、Docker socket 与 host network 均 fail-closed", async () => {
  const root = workspace();
  const runner = new FakeDockerRunner(root);
  assert.throws(() => container(runner, {
    environment: { MODEL_API_KEY: "secret" },
  }), /疑似凭据/);
  assert.throws(() => container(runner, {
    environment: { HOME: "/root" },
  }), /独立的绝对用户目录/);

  const unsafeNetwork = container(runner, { network: "host" });
  await assert.rejects(unsafeNetwork.start(), /网络模式不安全/);
  const socket = new TaskContainer(
    "image", root, "mfc-socket-test", undefined,
    ["/var/run/docker.sock:/var/run/docker.sock"], {}, { runner },
  );
  await assert.rejects(socket.start(), /禁止挂载 Docker socket/);
});

test("显式 root/0 与镜像空 Config.User 均拒启并清理", async () => {
  const root = workspace();
  const runner = new FakeDockerRunner(root);
  for (const user of ["", "root", "root:root", "0", "0:0"]) {
    const subject = new TaskContainer(
      "image", root, `mfc-root-${user.replace(/[^a-z0-9]/gi, "x") || "empty"}`,
      undefined, [], { user }, { runner },
    );
    await assert.rejects(subject.start(), /禁止使用 root\/0 或空用户/);
  }

  const emptyRunner = new FakeDockerRunner(root);
  emptyRunner.configUser = "";
  const fromImage = new TaskContainer(
    "image", root, "mfc-empty-image-user", undefined, [], {},
    { runner: emptyRunner },
  );
  await assert.rejects(fromImage.start(), /Config\.User 为空或为 root\/0/);
  assert.equal(emptyRunner.exists, false, "拒绝镜像 root 身份后也必须清掉容器");
});

test("启动清扫只删除完整 dataDir ownership 匹配且逐项复验通过的容器", async () => {
  const dataDir = workspace();
  const instance = taskContainerInstance(dataDir);
  const id = "d".repeat(64);
  let exists = true;
  const commands: string[][] = [];
  const runner: DockerRunner = {
    command: async (args) => {
      commands.push([...args]);
      if (args[0] === "ps") return id;
      if (args[0] === "inspect") {
        if (!exists) throw missing(args);
        return JSON.stringify([{
          Id: id,
          Name: `/mfc-${instance.namePrefix}-task-9-prepush`,
          Image: `sha256:${"e".repeat(64)}`,
          Config: { Image: "builder:test", Labels: {
            "com.mae-flow-cloud.managed": "true",
            "com.mae-flow-cloud.instance": instance.fingerprint,
            "com.mae-flow-cloud.container":
              `mfc-${instance.namePrefix}-task-9-prepush`,
            "com.mae-flow-cloud.role": "prepush",
            "com.mae-flow-cloud.task": "task-9",
          } },
        }]);
      }
      if (args[0] === "stop") { exists = false; return id; }
      throw new Error(`unexpected docker ${args.join(" ")}`);
    },
    stream: () => { throw new Error("unused"); },
  };
  const logs: string[] = [];
  const result = await sweepManagedTaskContainers({
    instanceFingerprint: instance.fingerprint,
    namePrefix: instance.namePrefix,
    runner,
    log: (line) => logs.push(line),
  });
  assert.deepEqual(result.removed,
    [`mfc-${instance.namePrefix}-task-9-prepush`]);
  assert.ok(commands[0].includes(
    `label=com.mae-flow-cloud.instance=${instance.fingerprint}`));
  assert.match(logs.join("\n"), /phase=TERM.*role=prepush.*id=dddddddddddd/);
  assert.match(logs.join("\n"), /phase=removed/);
});

test("启动清扫迁移删除旧版无三标签 issue 容器，但必须精确核对工作区", async () => {
  const dataDir = workspace();
  const issuesRoot = join(dataDir, "issues");
  const instance = taskContainerInstance(dataDir);
  const id = "9".repeat(64);
  const name = `mfc-${instance.namePrefix}-issue-30`;
  const issueRoot = join(issuesRoot, "issue-30");
  let exists = true;
  const destructive: string[][] = [];
  const runner: DockerRunner = {
    command: async (args) => {
      if (args[0] === "ps") {
        return args.includes(
          `label=com.mae-flow-cloud.instance=${instance.fingerprint}`)
          ? "" : id;
      }
      if (args[0] === "inspect") {
        if (!exists) throw missing(args);
        return JSON.stringify([{
          Id: id, Name: `/${name}`, Image: `sha256:${"8".repeat(64)}`,
          Config: { Labels: {
            "com.mae-flow-cloud.managed": "true",
            "com.mae-flow-cloud.container": name,
          } },
          Mounts: [{
            Source: issueRoot, Destination: issueRoot, Type: "bind", RW: true,
          }],
        }]);
      }
      if (args[0] === "stop") {
        destructive.push([...args]);
        exists = false;
        return id;
      }
      throw new Error(`unexpected docker ${args.join(" ")}`);
    },
    stream: () => { throw new Error("unused"); },
  };
  const result = await sweepManagedTaskContainers({
    instanceFingerprint: instance.fingerprint,
    namePrefix: instance.namePrefix,
    legacyIssueRoot: issuesRoot,
    runner,
  });
  assert.deepEqual(result.removed, [name]);
  assert.equal(destructive.length, 1);

  exists = true;
  destructive.length = 0;
  const wrongMountRunner: DockerRunner = {
    ...runner,
    command: async (args) => {
      if (args[0] === "ps") {
        return args.includes(
          `label=com.mae-flow-cloud.instance=${instance.fingerprint}`)
          ? "" : id;
      }
      if (args[0] === "inspect") return JSON.stringify([{
        Id: id, Name: `/${name}`,
        Config: { Labels: {
          "com.mae-flow-cloud.managed": "true",
          "com.mae-flow-cloud.container": name,
        } },
        Mounts: [{
          Source: join(dataDir, "someone-else"), Destination: issueRoot,
          Type: "bind", RW: true,
        }],
      }]);
      destructive.push([...args]);
      return "";
    },
  };
  await assert.rejects(sweepManagedTaskContainers({
    instanceFingerprint: instance.fingerprint,
    namePrefix: instance.namePrefix,
    legacyIssueRoot: issuesRoot,
    runner: wrongMountRunner,
  }), /ownership 复验失败/);
  assert.equal(destructive.length, 0,
    "只像旧 issue、但工作区不匹配的容器不能删除");
});

test("清扫命中 filter 但 ownership 复验失败时 fail-closed", async () => {
  const instance = taskContainerInstance(workspace());
  const id = "f".repeat(64);
  const destructive: string[][] = [];
  const runner: DockerRunner = {
    command: async (args) => {
      if (args[0] === "ps") return id;
      if (args[0] === "inspect") return JSON.stringify([{
        Id: id,
        Name: `/mfc-${instance.namePrefix}-task-1`,
        Config: { Labels: {
          "com.mae-flow-cloud.managed": "true",
          "com.mae-flow-cloud.instance": instance.fingerprint,
          // container ownership label 被伪造/损坏，不能删。
          "com.mae-flow-cloud.container": "someone-else",
          "com.mae-flow-cloud.role": "coding",
          "com.mae-flow-cloud.task": "task-1",
        } },
      }]);
      destructive.push([...args]);
      return "";
    },
    stream: () => { throw new Error("unused"); },
  };
  await assert.rejects(sweepManagedTaskContainers({
    instanceFingerprint: instance.fingerprint,
    namePrefix: instance.namePrefix,
    runner,
  }), /ownership 复验失败/);
  assert.equal(destructive.length, 0);
});

test("同名外部容器没有平台 ownership labels 时拒绝误杀", async () => {
  const runner = new FakeDockerRunner(workspace());
  runner.exists = true;
  runner.running = true;
  // 还没有经过本 TaskContainer 的 run，fake inspect 因而没有 managed labels。
  const subject = container(runner);
  await assert.rejects(subject.start(), /不属于本任务.*拒绝清理/);
  assert.equal(runner.exists, true, "外部同名容器必须原样保留");
  assert.equal(runner.commands.some((args) =>
    ["stop", "kill", "rm"].includes(args[0])), false);
});

test("基础镜像 ENV 含疑似凭据时拒启，错误不泄露 value", async () => {
  const runner = new FakeDockerRunner(workspace());
  runner.extraImageEnv = ["INTERNAL_ACCESS_TOKEN=super-secret-value"];
  const subject = container(runner);
  await assert.rejects(subject.start(), (error: Error) => {
    assert.match(error.message, /INTERNAL_ACCESS_TOKEN/);
    assert.doesNotMatch(error.message, /super-secret-value/);
    return true;
  });
  assert.equal(runner.exists, false, "污染镜像也要在拒启后销毁容器");
});

test("timeout 销毁整个容器：TERM→KILL→rm 后才杀本机 exec，且 stop 幂等", async () => {
  const runner = new FakeDockerRunner(workspace());
  runner.hangingStream = true;
  runner.stopRemoves = false;
  runner.killRemoves = false;
  const subject = container(runner, { stopGraceSeconds: 0 });
  await subject.start();

  await assert.rejects(
    subject.exec("sleep infinity", runner.workspace, {
      onData: () => undefined,
      timeout: 0.005,
    }),
    (error: unknown) => error instanceof TaskContainerExecTimeoutError
      && error.timeoutSeconds === 0.005
      && /timeout:0\.005/.test(error.message),
  );
  assert.equal(subject.state, "stopped");
  assert.equal(runner.exists, false, "timeout 返回前必须确认容器已删除");
  assert.ok(runner.streamKillCount >= 1, "容器销毁后应收掉本机 docker exec");
  const lifecycle = runner.commands
    .filter((args) => ["stop", "kill", "rm"].includes(args[0]))
    .map((args) => args[0]);
  assert.deepEqual(lifecycle, ["stop", "kill", "rm"]);

  const before = runner.commands.length;
  await subject.stop();
  assert.equal(runner.commands.length, before, "重复 stop 不应再次访问 Docker");
  await assert.rejects(
    subject.exec("true", runner.workspace, { onData: () => undefined }),
    (error: unknown) => error instanceof TaskContainerUnavailableError
      && error.kind === "stopped"
      && /未运行/.test(error.message),
  );
});

test("Abort 同样销毁整个容器，不把取消误装成只杀 docker exec", async () => {
  const runner = new FakeDockerRunner(workspace());
  runner.hangingStream = true;
  const subject = container(runner);
  await subject.start();
  const controller = new AbortController();
  const executing = subject.exec("sleep infinity", runner.workspace, {
    onData: () => undefined,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(executing, /^Error: aborted$/);
  assert.equal(runner.exists, false);
  assert.equal(subject.state, "stopped");
});

test("inspect 加固项不符会拒绝启动并清理；无法删除则 stop 明确失败", async () => {
  const insecure = new FakeDockerRunner(workspace());
  insecure.insecureInspect = true;
  const rejected = container(insecure);
  await assert.rejects(rejected.start(), /read-only root filesystem/);
  assert.equal(insecure.exists, false, "启动复验失败也必须清理容器");
  assert.equal(rejected.state, "failed");

  const stuck = new FakeDockerRunner(workspace());
  stuck.stopRemoves = false;
  stuck.killRemoves = false;
  stuck.rmRemoves = false;
  const notRemoved = container(stuck);
  await notRemoved.start();
  await assert.rejects(notRemoved.stop(), /无法确认容器/);
  assert.equal(notRemoved.state, "failed");
  assert.equal(stuck.exists, true);
});

test("dockerAvailable 通过注入 runner 检查 daemon，而不是只看 CLI", async () => {
  const runner = new FakeDockerRunner(workspace());
  assert.equal(await dockerAvailable(runner), true);
  const unavailable: DockerRunner = {
    command: async () => { throw new Error("daemon down"); },
    stream: () => { throw new Error("unused"); },
  };
  assert.equal(await dockerAvailable(unavailable), false);
});
