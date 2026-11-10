import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDebugIssueSkillPatch, setupDebugIssue,
  type DebugIssueAuth } from "../src/issueFlow/debugIssue.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { until } from "./issueFlowFixed.helpers.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { readBusinessModule } from "../src/businessModuleLibrary.ts";
import { EnvironmentRegistry } from "../src/environmentRegistry.ts";
import { fetchMrGates } from "../src/mrGateClient.ts";
import { fetchMrDiscussions } from "../src/issueFlow/mrDiscussions.ts";
import { getPipelineStatus, triggerPipeline } from "../src/pipelineClient.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8" }).trim();
}

/** 造一个非 bare 的源仓(带 master 一笔提交),模拟本机真实项目。 */
function makeSourceRepo(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=master");
  git(dir, "config", "user.email", "t@t.local");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), `# ${name}\n`);
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

function fakeAuth(): DebugIssueAuth & { tokens: string[][] } {
  const tokens: string[][] = [];
  return {
    tokens,
    gitCredential: (username) => {
      const hit = tokens.find((row) => row[0] === username);
      return hit
        ? { username: hit[0], password: hit[1], email: hit[2] || undefined }
        : undefined;
    },
    setGitToken: (username, token, email) => {
      tokens.push([username, token, email ?? ""]);
    },
  };
}

interface Fixture {
  root: string;
  dataDir: string;
  sources: string[];
  mirrors: string[];
  setup: Awaited<ReturnType<typeof setupDebugIssue>>;
}

async function makeFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-test-"));
  const dataDir = join(root, "data");
  const repos = ["alpha", "beta"].map((name) => ({
    name, path: makeSourceRepo(root, name),
  }));
  const setup = await setupDebugIssue({
    dataDir,
    auth: fakeAuth(),
    repos,
    log: () => {},
  });
  return {
    root,
    dataDir,
    sources: repos.map((item) => item.path),
    mirrors: setup.mirrors.map((item) => item.path),
    setup,
  };
}

test("--debug-issue 播种:双仓镜像/示例模块/假环境/调试单/假引擎/署名", async () => {
  const fx = await makeFixture();
  try {
    // 镜像真是 bare,且 HEAD 对齐源仓分支。
    for (const mirror of fx.mirrors) {
      assert.equal(git(mirror, "rev-parse", "--is-bare-repository"), "true");
      assert.equal(git(mirror, "symbolic-ref", "--short", "HEAD"), "master");
    }
    // 示例模块绑了两个镜像路径。
    const module = readBusinessModule(fx.dataDir, "debug-sample");
    assert.deepEqual([...module.repositories].sort(), [...fx.mirrors].sort());
    // 假环境条目在台账里(按 IP 幂等)。
    assert.ok(new EnvironmentRegistry(fx.dataDir).findByIp("127.0.0.1"));
    // 调试单文件:三张、全部可发起状态。
    const tickets = JSON.parse(readFileSync(fx.setup.dtsTicketFile, "utf-8"));
    assert.equal(tickets.length, 3);
    for (const ticket of tickets) {
      assert.equal(ticket.status, "开发人员实施修改");
    }
    // 假引擎在位、可执行、罐头路径已烤进脚本。
    const script = readFileSync(join(fx.setup.opsMockBinDir, "fetch-logs"), "utf-8");
    assert.ok(script.includes(fx.setup.demoLogsDir));
    assert.equal(statSync(join(fx.setup.opsMockBinDir, "fetch-logs")).mode & 0o777,
      0o755);
    assert.ok(existsSync(join(fx.setup.demoLogsDir, "order-export", "app.log")));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--debug-issue 播种幂等:重跑不覆盖用户改过的单据/日志/账", async () => {
  const fx = await makeFixture();
  try {
    // 用户改了调试单与罐头日志。
    writeFileSync(fx.setup.dtsTicketFile, JSON.stringify([{ ticket: "DTS-X",
      title: "我改的", status: "开发人员实施修改" }]));
    const cannedLog = join(fx.setup.demoLogsDir, "order-export", "app.log");
    writeFileSync(cannedLog, "我的日志内容");

    const auth = fakeAuth();
    // 预置 dev 已有署名 → 不应重复播种令牌。
    auth.tokens.push(["dev", "my-own-token", "me@local"]);
    const second = await setupDebugIssue({
      dataDir: fx.dataDir, auth,
      repos: fx.sources.map((path, index) => ({
        name: index === 0 ? "alpha" : "beta", path,
      })),
      log: () => {},
    });

    assert.equal(readFileSync(second.dtsTicketFile, "utf-8"),
      JSON.stringify([{ ticket: "DTS-X", title: "我改的",
        status: "开发人员实施修改" }]));
    assert.equal(readFileSync(cannedLog, "utf-8"), "我的日志内容");
    assert.equal(auth.tokens.length, 1, "已有署名不得再补演示令牌");
    // 镜像未被重建(HEAD 仍指向 master,内容仍在)。
    assert.equal(git(second.mirrors[0].path, "symbolic-ref", "--short", "HEAD"),
      "master");
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("--debug-issue 进程内平台:问题流全部消费端点可答且恒绿", async () => {
  const fx = await makeFixture();
  try {
    const platformUrl = fx.setup.platformUrl;
    const mirror = fx.mirrors[0];
    // 修复分支推上镜像(模拟 push_branch 的事实),再走问题流的客户端。
    const branch = "master_dev_DTS-2026-9001";
    git(fx.sources[0], "checkout", "--quiet", "-b", branch);
    writeFileSync(join(fx.sources[0], "fix.txt"), "fix\n");
    git(fx.sources[0], "add", ".");
    git(fx.sources[0], "commit", "--quiet", "-m",
      "[DTS-2026-9001][fix] 修复导出超时");
    git(fx.sources[0], "push", "--quiet", mirror, branch);
    const sha = git(fx.sources[0], "rev-parse", branch);

    // create_mr:POST /mr → 201,带 url 与 id。
    const created = await fetch(`${platformUrl}/mr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: mirror, source_branch: branch,
        target_branch: "master", title: "任意标题" }),
    });
    assert.equal(created.status, 201);
    const mr = await created.json() as { url: string; id: number };
    assert.ok(mr.url.startsWith("http://"));
    assert.ok(Number.isInteger(mr.id));

    // 流水线:触发即绿,按 SHA 查也绿(恒绿语义)。
    const triggered = await triggerPipeline({ platformUrl, sha, repo: mirror });
    assert.equal(triggered.status, "success");
    const status = await getPipelineStatus({ platformUrl, sha, repo: mirror });
    assert.equal(status.status, "success");

    // 合入事实:opened(不冒充已合入);gates 是对象数组。
    const gates = await fetchMrGates({ platformUrl, repo: mirror,
      headers: {}, delivery: { source_branch: branch, target_branch: "master" } });
    assert.ok(gates, "gates 查询应当可得");
    assert.equal(gates.mrState, "opened");

    // 讨论列表:可用且为空。
    const discussions = await fetchMrDiscussions({ platformUrl, repo: mirror });
    assert.equal(discussions.kind, "available");
    if (discussions.kind === "available") assert.equal(discussions.items.length, 0);

    // 附件端点在(空列表)。
    const artifacts = await fetch(
      `${platformUrl}/pipeline/artifacts?sha=${sha}&repo=${encodeURIComponent(mirror)}`);
    assert.equal(artifacts.status, 200);
    assert.deepEqual(await artifacts.json(), { files: [] });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("假 fetch-logs/fetch-logs-k8s:按服务名复制,退出码 0 + 解压完成", async () => {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-bin-"));
  try {
    const dataDir = join(root, "data");
    const source = makeSourceRepo(root, "solo");
    const setup = await setupDebugIssue({
      dataDir,
      auth: fakeAuth(),
      repos: [{ name: "solo", path: source }],
      log: () => {},
    });
    const out = join(root, "local-logs");
    for (const bin of ["fetch-logs", "fetch-logs-k8s"]) {
      const ran = spawnSync("bash", [join(setup.opsMockBinDir, bin),
        "--host", "1.2.3.4", "--service", "order-export",
        "--local-dir", out], { encoding: "utf-8" });
      assert.equal(ran.status, 0, ran.stderr);
      assert.ok(ran.stdout.includes("解压完成"));
    }
    const entries = existsSync(out) ? readdirSync(out) : [];
    const virtualized = entries.filter((name) => name.endsWith("mock-node"));
    const k8s = entries.filter((name) => name.endsWith("mock-pod"));
    assert.equal(virtualized.length, 1);
    assert.equal(k8s.length, 1);
    assert.ok(readFileSync(join(out, virtualized[0], "app.log"), "utf-8")
      .includes("TimeoutException"));
    // 未知服务:仍成功但抓空(与真引擎"服务名不对会抓空"同语义)。
    const empty = spawnSync("bash", [join(setup.opsMockBinDir, "fetch-logs"),
      "--service", "no-such", "--local-dir", out], { encoding: "utf-8" });
    assert.equal(empty.status, 0);
    assert.ok(empty.stdout.includes("解压完成"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("技能补丁:工作区 fetch-logs 的 wrapper 被假引擎覆盖且保留执行位", async () => {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-patch-"));
  try {
    const dataDir = join(root, "data");
    const setup = await setupDebugIssue({
      dataDir,
      auth: fakeAuth(),
      repos: [{ name: "solo", path: makeSourceRepo(root, "solo") }],
      log: () => {},
    });
    const workspace = join(root, "issue-workspace");
    const binDir = join(workspace, "skills", "fetch-logs", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "fetch-logs"), "#!/bin/sh\necho 真引擎");
    writeFileSync(join(binDir, "fetch-logs-k8s"), "#!/bin/sh\necho 真引擎");
    writeFileSync(join(binDir, "fetch-logs-linux-amd64"), "二进制别动我");

    applyDebugIssueSkillPatch(workspace, setup.opsMockBinDir);

    const patched = readFileSync(join(binDir, "fetch-logs"), "utf-8");
    assert.ok(patched.includes("解压完成"));
    assert.equal(statSync(join(binDir, "fetch-logs")).mode & 0o777, 0o755);
    assert.equal(statSync(join(binDir, "fetch-logs-k8s")).mode & 0o777, 0o755);
    assert.equal(readFileSync(join(binDir, "fetch-logs-linux-amd64"), "utf-8"),
      "二进制别动我");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MockDtsGateway 注入调试单数据源:列表/详情/查无此单", async () => {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-dts-"));
  try {
    const file = join(root, "dts-tickets.json");
    writeFileSync(file, JSON.stringify([{
      ticket: "DTS-2026-9001",
      title: "调试单",
      status: "开发人员实施修改",
      content: "正文",
    }]));
    const gateway = new MockDtsGateway(undefined, file);
    const list = await gateway.listByOwner("dev");
    assert.equal(list.length, 1);
    assert.equal(list[0].ticket, "DTS-2026-9001");
    const detail = await gateway.detail("DTS-2026-9001");
    assert.equal(detail.title, "调试单");
    await assert.rejects(gateway.detail("DTS-2026-0000"), /查无此单/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--debug-issue 播种公共组件仓(#426,ADR-0054):镜像+登记表+示例模块订阅幂等", async () => {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-components-"));
  try {
    const dataDir = join(root, "data");
    const repos = ["alpha", "beta"].map((name) => ({
      name, path: makeSourceRepo(root, name),
    }));
    const options = {
      dataDir,
      auth: fakeAuth(),
      repos,
      components: [{
        id: "comp-demo",
        name: "公共组件演示",
        path: repos[0].path,
        languages: ["TypeScript"],
        description: "排查组件渲染问题时读取",
      }],
      log: () => {},
    };
    const setup = await setupDebugIssue(options);
    // 登记表落在 dataDir 根,repository = 组件镜像路径(问题流的身份
    // 归类与订阅快照读的就是这份文件)。
    const registry = JSON.parse(readFileSync(
      join(dataDir, "component-repositories.json"), "utf-8")) as Array<{
        id: string; repository: string; enabled: boolean;
      }>;
    assert.equal(registry.length, 1);
    assert.equal(registry[0].id, "comp-demo");
    assert.equal(registry[0].enabled, true);
    assert.equal(registry[0].repository,
      join(setup.remotesDir, "comp-demo.git"));
    assert.ok(existsSync(join(setup.remotesDir, "comp-demo.git", "HEAD")));
    assert.deepEqual(setup.components,
      [{ id: "comp-demo", name: "公共组件演示",
        path: join(setup.remotesDir, "comp-demo.git") }]);
    // 示例模块订阅 comp-demo。
    const module = readBusinessModule(dataDir, "debug-sample");
    assert.deepEqual(module.reference_component_repos, ["comp-demo"]);
    // 幂等:重跑不重复订阅、登记表重写内容一致。
    await setupDebugIssue(options);
    assert.deepEqual(
      readBusinessModule(dataDir, "debug-sample").reference_component_repos,
      ["comp-demo"]);
    assert.equal((JSON.parse(readFileSync(
      join(dataDir, "component-repositories.json"), "utf-8")) as Array<unknown>)
      .length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("调试会话参考仓全链(#426):开场注入订阅目录,拉取入参考仓台账", async () => {
  const root = mkdtempSync(join(tmpdir(), "debug-issue-chain-"));
  const dataDir = join(root, "data");
  const repos = ["alpha", "beta"].map((name) => ({
    name, path: makeSourceRepo(root, name),
  }));
  const setup = await setupDebugIssue({
    dataDir,
    auth: fakeAuth(),
    repos,
    components: [{
      id: "comp-demo",
      name: "公共组件演示",
      path: repos[0].path,
      languages: ["TypeScript"],
      description: "排查组件渲染问题时读取",
    }],
    log: () => {},
  });
  const componentMirror = join(setup.remotesDir, "comp-demo.git");
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: setup.mirrors[0]!.path } } },
    { tool: { name: "pull_repo", input: { url: setup.mirrors[1]!.path } } },
    { tool: { name: "pull_repo", input: { url: componentMirror } } },
    { tool: { name: "complete_stage", input: { note: "仓已看齐" } } },
    { text: "分析中,已研读公共组件源码。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    const created = service.create({
      account: "dev", title: "调试全链:公共组件引用报错",
      moduleId: "debug-sample",
      environment: { hosts: ["192.0.2.8"], backendPassword: "x" },
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "调试全链回合收口");
    const state = JSON.parse(readFileSync(
      join(dataDir, "issues", created.id, "issue.json"), "utf-8")) as {
      public_repos?: Array<{ url: string; name: string }>;
      repo_urls?: string[];
    };
    assert.deepEqual(state.public_repos?.map((row) => row.url),
      [componentMirror], "组件镜像落参考仓台账");
    assert.deepEqual([...(state.repo_urls ?? [])].sort(),
      [setup.mirrors[0]!.path, setup.mirrors[1]!.path].sort(),
      "绑定镜像照旧平等入列");
    // 开场词:订阅目录注入的是本地镜像路径,AI 照抄地址即拉。
    const opening = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .filter((message: any) => message?.role === "user")
      .map((message: any) => typeof message.content === "string"
        ? message.content
        : (message.content ?? []).map((block: any) =>
          block?.text ?? "").join(" "))
      .join("\n");
    assert.match(opening, /公共组件演示/);
    assert.match(opening, new RegExp(componentMirror.replace(/[.\\]/g, "\\$&")));
    assert.match(opening, /何时需要读取: 排查组件渲染问题时读取/);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    // 克隆被 harden 成只读(拉仓收口的属主/权限治理),清理前先放开
    // 写位;失败尽力而为,不掩盖断言结果。
    try { execFileSync("chmod", ["-R", "u+w", root]); } catch { /* 尽力 */ }
    rmSync(root, { recursive: true, force: true });
  }
});
