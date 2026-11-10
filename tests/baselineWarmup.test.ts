import { readFileSync } from "node:fs";
/**
 * 环境预热编译(观测旁路,用户 2026-08-26 拍板"开始就爆红是好事"):
 * 现场就绪即并行编译基线。契约:收据绑起跑 SHA;runner 抛错=按基础
 * 设施故障记账,绝不碰任务状态(fail-open);收过口的收据不重跑;
 * 结果绝不构成交付证据——那是 prepush 与流水线的领地。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { TaskService } from "../src/taskService.ts";
import {
  parseWarmupReport,
  warmupMission,
  WARMUP_NOTES_PATH,
  type WarmupRunRequest,
} from "../src/warmupAgent.ts";

async function until<T>(probe: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-warmup-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  return { cwd, git };
}

async function completedTask() {
  const model = new ScriptedModelServer([{ text: "会话完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-warmup-data-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("环境预热演练").id;
  await until(() => service.get(id)?.status === "completed"
    ? true : undefined, "首轮会话收口");
  const repo = repository();
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  return { service, model, id, internal, repo };
}

test("收据绑起跑 SHA;收过口不重跑;fail-open 不碰任务状态", async () => {
  const { service, model, id, internal, repo } = await completedTask();
  try {
    const calls: WarmupRunRequest[] = [];
    (service as any).options.warmup = {
      runner: async (request: WarmupRunRequest) => {
        calls.push(request);
        return {
          status: "passed",
          message: "基线编译通过",
          build_command: "mvn -q compile",
        };
      },
    };
    (service as any).startBaselineWarmup(internal, 0);
    const receipt = await until(() => {
      const current = service.get(id)?.baseline_build;
      return current?.finished_at ? current : undefined;
    }, "预热收据落账");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.sha, repo.git("rev-parse", "HEAD"),
      "收据必须绑起跑 SHA——责任切分靠它");
    assert.equal(receipt.build_command, "mvn -q compile");
    assert.equal(service.get(id)?.status, "completed",
      "预热是旁路,任务状态一个字都不许动");

    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(calls.length, 1, "收过口的收据不重跑(缓存已经热了)");
  } finally {
    await model.stop();
  }
});

test("runner 抛错按基础设施故障记账,任务照常", async () => {
  const { service, model, id, internal } = await completedTask();
  try {
    (service as any).options.warmup = {
      runner: async () => { throw new Error("容器起不来"); },
    };
    (service as any).startBaselineWarmup(internal, 0);
    const receipt = await until(() => {
      const current = service.get(id)?.baseline_build;
      return current?.finished_at ? current : undefined;
    }, "失败收据落账");
    assert.equal(receipt.status, "infrastructure_failure");
    assert.match(String(receipt.detail), /容器起不来/);
    assert.equal(service.get(id)?.status, "completed");
  } finally {
    await model.stop();
  }
});

test("恢复时基线不明或工作区脏，不把半成品当基线", async () => {
  // 内网实锤:恢复单的预热把 Agent 写了一半的类编了,报"基线缺
  // import"——责任切分反向误导。
  const { service, model, id, internal, repo } = await completedTask();
  try {
    let calls = 0;
    (service as any).options.warmup = {
      runner: async () => {
        calls += 1;
        return { status: "passed", message: "不该跑到这" };
      },
    };
    internal.resume = true;
    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(calls, 0, "无法核对恢复基线时不预热");
    assert.equal(service.get(id)?.baseline_build, undefined);

    internal.resume = false;
    writeFileSync(join(repo.cwd, "wip.java"), "class Wip {}\n");
    (service as any).startBaselineWarmup(internal, 0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(calls, 0, "脏工作区不预热——那不再是基线");
    assert.equal(service.get(id)?.baseline_build, undefined,
      "没跑就是没跑,不落收据不伪装");
  } finally {
    await model.stop();
  }
});

test("使命写清三件事与红线;报告解析只认合法结构、后写者胜", () => {
  const mission = warmupMission({
    taskId: "t1", workspace: "/tmp/repo", sha: "a".repeat(40),
  });
  assert.match(mission, /C\+\+ 仓首次编译必须先执行 `mvn generate-sources -DDT_test=UT`/);
  assert.match(mission, /mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT/);
  assert.match(mission, /后一条命令会同时\s*完成编译并执行全量 UT/);
  assert.match(mission, /不允许去掉 DT_test=UT/);
  assert.match(mission, /必须把 UT 全部跑一遍/);
  assert.ok(mission.includes(WARMUP_NOTES_PATH),
    "构建入口沉淀路径必须写进使命——编码期子 Agent 与 prepush 靠它复用");
  assert.match(mission, /不执行任何 git 写操作/);
  assert.match(mission, /\.claude.*\.cac.*只读/s);
  assert.match(mission, /warmup-result/);

  assert.equal(parseWarmupReport("没有报告"), undefined);
  assert.equal(parseWarmupReport(
    '<warmup-result>{"status":"unknown","message":"x"}</warmup-result>'),
    undefined, "status 白名单外一律不认,交给基础设施故障处理");
  const last = parseWarmupReport([
    '<warmup-result>{"status":"failed","message":"first"}</warmup-result>',
    '<warmup-result>{"status":"passed","message":"编译通过",'
    + '"build_command":"npm run build"}</warmup-result>',
  ].join("\n"));
  assert.equal(last?.status, "passed");
  assert.equal(last?.build_command, "npm run build");
});

test("预热与 Build-Fix 的 Java 生命周期同一条:预热要把 package 用的插件拉进缓存", () => {
  // 2026-09-06 跨仓演练:预热只跑 compile/test,Build-Fix 首条是 package -DskipTests,
  // jar/resources 插件不在缓存、容器没外网,依赖解析空转 14 分钟烧光 30 分钟预算。
  const mission = warmupMission({ taskId: "t2", workspace: "/tmp/repo", sha: "b".repeat(40) });
  assert.match(mission, /mvn package -DskipTests/, "预热样例必须包含 Build-Fix 的那条 package 命令");
  const playbook = readFileSync(new URL("../src/prepushBuildPlaybook.ts", import.meta.url), "utf-8");
  assert.match(playbook, /package -DskipTests/, "Build-Fix 的 Java 首条仍是 package -DskipTests;改了这里也要改预热样例");
});


test("子任务出队即预编译，主会话初始化和写文档不等待编译完成", async (t) => {
  const model = new ScriptedModelServer([{ text: "先整理需求文档。" }]);
  await model.start();
  let finishBuild!: () => void;
  const building = new Promise<void>(resolve => { finishBuild = resolve; });
  let initializeMain!: () => void;
  const initializing = new Promise<void>(resolve => { initializeMain = resolve; });
  let calls = 0;
  const options = {
    dataDir: mkdtempSync(join(tmpdir(), "mfc-child-warmup-")),
    provider: "maeflow", model: "scripted-v1", modelsJson: model.modelsJson(),
    maxConcurrent: 0,
    warmup: { runner: async () => {
      calls++;
      await building;
      return { status: "passed" as const, message: "基线就绪" };
    } },
  };
  const service = new TaskService(options);
  const originalCreate = CloudSession.create;
  t.mock.method(CloudSession, "create", async (...args: Parameters<typeof originalCreate>) => {
    await initializing;
    return originalCreate.apply(CloudSession, args);
  });
  try {
    const child = service.create("子任务：整理需求与设计", { parentTaskId: "parent" });
    const git = (...args: string[]) => execFileSync("git", ["-C", child.workspace, ...args]);
    git("init", "--quiet");
    git("config", "user.name", "test");
    git("config", "user.email", "test@test");
    writeFileSync(join(child.workspace, "README.md"), "baseline");
    writeFileSync(join(child.workspace, ".gitignore"), "pi-agent/\ntask.json\ncreation-audit.json\n*jsonl\n");
    git("add", "README.md", ".gitignore");
    git("commit", "--quiet", "-m", "baseline");
    assert.equal(service.get(child.id)?.status, "queued");
    assert.equal(calls, 0, "排队不占用编译资源");
    options.maxConcurrent = 1;
    await (service as any).pump();
    await until(() => calls === 1 ? true : undefined, "主会话未初始化时预编译已启动");
    assert.equal(service.get(child.id)?.baseline_build?.status, "running");
    initializeMain();
    await until(() => service.get(child.id)?.status === "completed" ? true : undefined,
      "预编译未结束时主 Agent 已完成文档回合");
    assert.equal(calls, 1, "主会话创建后不能重复触发");
    finishBuild();
    await until(() => service.get(child.id)?.baseline_build?.status === "passed" ? true : undefined,
      "编译独立完成");
  } finally {
    initializeMain();
    finishBuild();
    t.mock.restoreAll();
    await model.stop();
  }
});

test("分析时跳过，转开发即使 resume 也补跑；中断后的基线编译可重试", async () => {
  const { service, model, id, internal, repo } = await completedTask();
  try {
    let calls = 0;
    (service as any).options.warmup = { runner: async () => {
      calls++;
      return { status: "passed", message: "基线通过" };
    } };
    const sha = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.cwd, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: sha } }));
    internal.summary.requirement_analysis_requested = true;
    (service as any).startBaselineWarmup(internal, 0);
    assert.equal(internal.warmupActive, undefined);
    internal.summary.requirement_analysis_requested = false;
    internal.resume = true;
    (service as any).startBaselineWarmup(internal, 0);
    // launch 会清 resume；检查必须使用启动时快照，不能异步重读。
    internal.resume = false;
    await until(() => service.get(id)?.baseline_build?.status === "passed" ? true : undefined, "恢复后首次预热");
    await until(() => internal.warmupActive === false ? true : undefined, "预热已退出");
    assert.equal(calls, 1);
    internal.summary.baseline_build = { status: "infrastructure_failure", sha,
      started_at: new Date().toISOString(), finished_at: new Date().toISOString(), detail: "重启中断" };
    internal.resume = true;
    (service as any).startBaselineWarmup(internal, 0);
    await until(() => service.get(id)?.baseline_build?.status === "passed" ? true : undefined, "中断编译补跑");
    assert.equal(calls, 2);
  } finally { await model.stop(); }
});

test("恢复时 HEAD 已提交业务修改，即使工作区干净也不能冒充基线", async () => {
  const { service, model, internal, repo } = await completedTask();
  try {
    let calls = 0;
    (service as any).options.warmup = { runner: async () => { calls++; return { status: "passed" }; } };
    const baseline = repo.git("rev-parse", "HEAD");
    writeFileSync(join(repo.cwd, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: baseline } }));
    writeFileSync(join(repo.cwd, "README.md"), "changed\n");
    repo.git("add", "README.md");
    repo.git("commit", "-m", "business change");
    internal.resume = true;
    (service as any).startBaselineWarmup(internal, 0);
    internal.resume = false;
    await until(() => internal.warmupActive === false ? true : undefined, "核对恢复基线");
    assert.equal(calls, 0);
    assert.equal(internal.summary.baseline_build, undefined);
  } finally { await model.stop(); }
});
