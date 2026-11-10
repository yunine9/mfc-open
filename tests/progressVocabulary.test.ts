/**
 * 进度条只有一套阶段词表:内核 flow/phases.json。
 *
 * 2026-09-02 用户实锤:"每个任务进度条都不一样、点阶段名弹黄字说不匹配"。
 * 根因是三套词表打架——内核看板六段、Cloud 进入检视与验证后强行换成五段、
 * 前端没内核进度时再来七段;老任务停在哪套显示哪套,而"点阶段弹方案"按
 * 名字去内核方案词表里找,自然落空。
 *
 * 现在:阶段名与顺序只读内核那份文件;当前段由内核在脉冲里算好;宿主推进
 * 的阶段(登记 PASS、合入收口)内核强制刷脉冲;老任务旧词表的脉冲一律当
 * 没有内核进度,按状态占位——绝不把旧词表原样端出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { kernelPhases } from "../src/kernelPhases.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const CANONICAL = ["启动", "澄清需求", "定规格", "写设计", "写代码", "检视与验证", "已合入"];
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "phases", GIT_AUTHOR_EMAIL: "p@example.com",
  GIT_COMMITTER_NAME: "phases", GIT_COMMITTER_EMAIL: "p@example.com",
};

async function until(probe: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function completedTask(label: string) {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), `mfc-phases-${label}-`)),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create(`进度词表 ${label}`, { account: "worker" }).id;
  await until(() => service.get(id)?.status === "completed", "首轮会话收口");
  const internal = (service as any).tasks.get(id);
  const stop = async () => {
    await service.cancel(id, "tester").catch(() => undefined);
    await service.shutdown();
    await model.stop();
  };
  return { service, id, internal, stop };
}

test("词表来自内核 flow/phases.json,本仓源码不再有任何阶段字面量", () => {
  assert.deepEqual(kernelPhases(KERNEL_ROOT)?.names, CANONICAL);
  // 环节不减(用户拍板):前五段原样,「交付」改叫「检视与验证」,加终态「已合入」。
  assert.deepEqual(kernelPhases(KERNEL_ROOT)?.placeholders,
    { queued: "启动", analysis: "澄清需求", delivering: "写代码", terminal: "已合入" });
  assert.equal(kernelPhases(join(process.cwd(), "kernel-not-exists")), undefined);
  const forbidden = [/"配置与需求"/, /"已受理"/, /"验证与交付"/, /"子任务交付"/,
    /"检视与验证"/, /"写代码"/, /"澄清需求"/];
  for (const file of ["src/taskService.ts", "web/src/TaskWorkspace.tsx",
    "web/src/TaskCard.tsx"]) {
    const source = readFileSync(join(process.cwd(), file), "utf-8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} 不该再出现阶段字面量 ${pattern}`);
    }
  }
});

test("老任务旧词表的脉冲不再原样端出来:当没有内核进度,按状态占位", async () => {
  const { service, id, internal, stop } = await completedTask("stale");
  try {
    const cwd = join(internal.summary.workspace, "repo");
    mkdirSync(join(cwd, ".mae-flow-work"), { recursive: true });
    internal.cwd = cwd;
    writeFileSync(join(cwd, ".mae-flow-work", "panel-pulse.js"),
      'window.__panelPulse={"phase":"交付","step":"delivery_watch",'
      + '"step_title":"等待权威流水线","revision":3};');
    // 未修复时这里是 ["启动", ..., "交付"] 的旧看板词表(或直接没有进度)。
    const progress = service.get(id)!.progress!;
    assert.deepEqual(progress.phases, CANONICAL);
    assert.equal(progress.current_phase, "已合入", "completed 占末段");
    assert.equal(progress.current_index, CANONICAL.length - 1);
  } finally {
    await stop();
  }
});

test("老任务旧词表脉冲:配了内核就让它重写一次,进度条自愈到当前词表", async () => {
  const { service, id, internal, stop } = await completedTask("heal");
  try {
    const workspace = internal.summary.workspace as string;
    const cwd = join(workspace, "repo");
    mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) => execFileSync(
      "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
    git("init", "--quiet", "-b", "master");
    writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
    git("add", "main.ts");
    git("commit", "--quiet", "-m", "baseline");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
      current: "delivery_watch", revision: 3,
      execution_contract: {
        schema: "mae-flow-execution/1", host: "cloud",
        compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
        codecheck: "pipeline", git_push: "host",
        continuous_review: true, source: "order",
      },
      config: { "分支名": "feature", "基线分支": "master" },
      step_heads: { branch_create: head, delivery_watch: head },
      quality: { external_verification: { verdict: "PASS", sha: head } },
      history: [], initial_dirty: [],
    }));
    mkdirSync(join(cwd, ".mae-flow-work"), { recursive: true });
    // 阶段词表升级前留下的脉冲:阶段名是旧的「交付」。
    writeFileSync(join(cwd, ".mae-flow-work", "panel-pulse.js"),
      'window.__panelPulse={"phase":"交付","step":"delivery_watch",'
      + '"step_title":"等待权威流水线","revision":3};');
    internal.cwd = cwd;
    internal.summary.status = "await_merge";
    (service as any).options.host = {
      kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true,
    };
    // 第一眼:旧名字画不了轨道,按状态占位;同时已经让内核去重写脉冲。
    const first = service.get(id)!.progress!;
    assert.deepEqual(first.phases, CANONICAL);
    assert.equal(first.step_id, "delivery_watch", "契约事实不丢");
    await until(() => service.get(id)!.progress?.current_phase === "检视与验证",
      "内核按当前词表重写脉冲后进度条自愈");
    assert.match(readFileSync(join(cwd, ".mae-flow-work", "panel-pulse.js"), "utf-8"),
      /检视与验证/);
  } finally {
    await stop();
  }
});

test("宿主登记流水线 PASS 后内核强制刷脉冲,进度条立刻到「检视与验证」", async () => {
  const { service, id, internal, stop } = await completedTask("host");
  try {
    const workspace = internal.summary.workspace as string;
    const cwd = join(workspace, "repo");
    mkdirSync(cwd, { recursive: true });
    const git = (...args: string[]) => execFileSync(
      "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
    git("init", "--quiet", "-b", "master");
    writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
    git("add", "main.ts");
    git("commit", "--quiet", "-m", "baseline");
    const head = git("rev-parse", "HEAD");
    writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
      current: "external_verify", revision: 3,
      execution_contract: {
        schema: "mae-flow-execution/1", host: "cloud",
        compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
        codecheck: "pipeline", git_push: "host",
        continuous_review: true, source: "order",
      },
      config: { "分支名": "feature", "基线分支": "master" },
      step_heads: { branch_create: head, external_verify: head },
      history: [], initial_dirty: [],
    }));
    internal.cwd = cwd;
    internal.summary.status = "verifying";
    (service as any).options.host = {
      kernelRoot: KERNEL_ROOT, python: "python3", continuousReview: true,
    };
    // Agent 不在场,没有 Hook 事件替它写脉冲;内核宿主命令自己必须刷。
    assert.equal(existsSync(join(cwd, ".mae-flow-work", "panel-pulse.js")), false);
    sealPipelineLifecycle({ cwd, workspace, taskId: id, kernelRoot: KERNEL_ROOT });
    assert.equal(existsSync(join(cwd, ".mae-flow-work", "panel-pulse.js")), true,
      "宿主 pipeline record 落定后脉冲必须存在");
    const progress = service.get(id)!.progress!;
    assert.deepEqual(progress.phases, CANONICAL);
    assert.equal(progress.current_phase, "检视与验证");
    assert.equal(progress.step_id, "delivery_watch");
  } finally {
    await stop();
  }
});
