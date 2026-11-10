/**
 * 问题流容器生命周期契约(2026-09-01 拍板,对齐需求流"随任务起、
 * 随收口停"):容器随会话存活到终态——回合收口(idle)与等人
 * (waiting_user)都保持原实例,续聊/作答直接复用;真正的停点只在
 * 终态(取消/归档/挂起/转正/关停)。用 isolation.containerFactory
 * 窄注入口在无 daemon 环境钉死这套时机。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, lstatSync, readdirSync, chmodSync, existsSync } from "node:fs";
import { reclaimBuildCaches } from "../src/buildCache.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskContainer } from "../src/containerRuntime.ts";
import { IssueFlowService, type IssueContainerBuild } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

function removeFixture(root: string): void {
  // 平台 Skill 快照目录是 0555；先还原测试目录权限，否则 rm 会留下 ENOTEMPTY。
  const writable = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) writable(join(path, name));
    }
  };
  writable(root);
  rmSync(root, { recursive: true, force: true });
}

/** 无 daemon 假容器:只记生命周期事件,不碰 Docker CLI。 */
class FakeTaskContainer extends TaskContainer {
  readonly events: string[] = [];
  private stopped = false;

  constructor() {
    super("fake-image", "/tmp/fake-ws", "fake-container");
  }

  override get isAlive(): boolean {
    return !this.stopped;
  }

  override async start(): Promise<void> {
    this.events.push("start");
  }

  override async stop(): Promise<void> {
    this.events.push("stop");
    this.stopped = true;
  }

  override async exec(_command: string, _cwd: string, _options: {
    onData: (data: Buffer) => void;
  }): Promise<{ exitCode: number | null }> {
    this.events.push("exec");
    return { exitCode: 0 };
  }
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("容器随会话存活:回合收口不停、续聊复用原实例,取消才停", async () => {
  const dataDir = mfcTemp("mfc-issue-container-");
  // 无工具的纯文本剧本:非 linear 索引按工具回执数取幕,两轮都落第 0 幕。
  const script: Scene[] = [{ text: "已收到问题,先做初步分析。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const containers: FakeTaskContainer[] = [];
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    isolation: {
      image: "fake-image",
      volumes: [],
      memory: "1g",
      cpus: "1",
      pidsLimit: 100,
      network: "none",
      containerFactory: () => {
        const container = new FakeTaskContainer();
        containers.push(container);
        return container;
      },
    },
  });
  try {
    const created = service.create({
      account: "dev", title: "容器生命周期", description: "验证随会话存活",
      ticket: "DTS-CT1",
    });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口到 idle");

    assert.equal(containers.length, 1, "首轮恰好拉起一个容器");
    const container = containers[0];
    assert.ok(container.events.includes("start"));
    assert.ok(!container.events.includes("stop"),
      "回合收口不得停容器(对齐需求流:容器随会话存活)");
    assert.ok(container.isAlive, "回合结束后容器仍在场");

    // idle 续聊:复用同一实例,不重建(旧世界这里会停了再起)。
    service.reply(created.id, "补充:现象还能复现");
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "续聊收口");
    assert.equal(containers.length, 1, "续聊复用原容器,不得重建");
    assert.ok(container.isAlive);

    // 终态停点:取消必须同步停净(用户可见的"已取消"以容器消失为前提)。
    await service.control(created.id, { action: "cancel" });
    assert.ok(container.events.includes("stop"), "取消必须停容器");
    assert.ok(!container.isAlive);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    removeFixture(dataDir);
  }
});

test("容器 npm 源(#75):isolation.environment 进问题流创建环境,缺省绝不出现", async () => {
  // --isolate-npm-registry 在 serve 层落进 isolation.environment;问题流
  // 侧的合并点在 ensureContainer(先继承 environment 再追加缓存变量)。
  // 用生产形态(cacheRoot 在场)钉:registry 必须在合并后幸存。
  async function boot(environment?: NodeJS.ProcessEnv) {
    const dataDir = mfcTemp("mfc-issue-registry-");
    const model = new ScriptedModelServer(
      [{ text: "已收到问题,先做初步分析。" }]);
    await model.start();
    const builds: IssueContainerBuild[] = [];
    const service = new IssueFlowService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
      isolation: {
        image: "fake-image",
        volumes: [],
        cacheRoot: join(dataDir, "cache"),
        memory: "1g",
        cpus: "1",
        pidsLimit: 100,
        network: "none",
        ...(environment ? { environment } : {}),
        containerFactory: (build) => {
          builds.push(build);
          return new FakeTaskContainer();
        },
      },
    });
    return { dataDir, model, builds, service };
  }
  const registry = "https://npm.intra.example/repository/npm-group/";

  const configured = await boot({ npm_config_registry: registry });
  try {
    const created = configured.service.create({
      account: "dev", title: "容器 npm 源", description: "验证注入",
      ticket: "DTS-REG1",
    });
    await until(() => {
      const issue = configured.service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口到 idle");
    assert.equal(configured.builds.length, 1, "首轮恰好拉起一个容器");
    assert.equal(configured.builds[0].options.environment?.npm_config_registry,
      registry, "registry 必须进容器创建环境,内网 npm 才不打公网");
    assert.equal(configured.builds[0].options.environment?.npm_config_cache,
      "/cache/npm", "registry 与缓存变量共存,合并顺序没被破坏");
  } finally {
    await configured.service.shutdown().catch(() => undefined);
    await configured.model.stop();
    removeFixture(configured.dataDir);
  }

  const bare = await boot();
  try {
    const created = bare.service.create({
      account: "dev", title: "容器 npm 源缺省", description: "验证缺省不注入",
      ticket: "DTS-REG2",
    });
    await until(() => {
      const issue = bare.service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "首轮收口到 idle");
    assert.ok(!("npm_config_registry" in (bare.builds[0].options.environment ?? {})),
      "缺省不注入:没配 registry 时容器创建环境不得出现该键");
  } finally {
    await bare.service.shutdown().catch(() => undefined);
    await bare.model.stop();
    removeFixture(bare.dataDir);
  }
});

test("#586 辅助仓准备期间回收缓存，容器创建时仍取得完整挂载源", async () => {
  const dataDir = mfcTemp("mfc-issue-cache-start-");
  const cacheRoot = join(dataDir, "cache");
  const model = new ScriptedModelServer([{ text: "已收到问题。" }]);
  await model.start();
  let checked = false;
  const service = new IssueFlowService({ dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(), isolation: { image: "fake", volumes: [], cacheRoot,
      memory: "1g", cpus: "1", pidsLimit: 100, network: "none",
      containerFactory: build => {
        const shared = build.volumes.find(volume => volume.includes("shared-maven/remote:"))!;
        assert.ok(shared, "应接入共享下载区");
        assert.ok(existsSync(shared.split(":")[0]), "不能把准备辅助仓前已被清理的路径交给 Docker");
        checked = true;
        return new FakeTaskContainer();
      } } });
  (service as any).prepareMaeBuild = async () => {
    await reclaimBuildCaches({ cacheRoot, activeKeys: () => new Set(), retentionDays: 0, maxBytes: 0, allUnused: true });
  };
  try {
    const created = service.create({ account: "dev", title: "共享缓存启动竞态", description: "检查启动前准备", ticket: "DTS-CACHE" });
    await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "容器准备完成");
    assert.equal(checked, true);
  } finally {
    await service.shutdown().catch(() => {});
    await model.stop();
    removeFixture(dataDir);
  }
});
