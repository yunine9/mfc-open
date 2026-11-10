import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";

const KERNEL = resolve("kernel");

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function branchedRepository(name: string): string {
  const repository = mkdtempSync(join(tmpdir(), `mfc-baseline-${name}-`));
  git(repository, "init", "--quiet", "-b", "main");
  git(repository, "config", "user.name", "baseline-test");
  git(repository, "config", "user.email", "baseline@test");
  const skill = join(repository, ".agents", "skills", "baseline-guide");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), [
    "---",
    "name: baseline-guide",
    "description: BASELINE-STABLE-SKILL",
    "---",
    "",
    "STABLE-SKILL-BODY",
    "",
  ].join("\n"));
  writeFileSync(join(repository, "branch.txt"), "stable\n");
  git(repository, "add", ".");
  git(repository, "commit", "--quiet", "-m", "stable baseline");
  git(repository, "branch", "stable");

  writeFileSync(join(skill, "SKILL.md"), [
    "---",
    "name: baseline-guide",
    "description: DEFAULT-MAIN-SKILL",
    "---",
    "",
    "MAIN-SKILL-BODY",
    "",
  ].join("\n"));
  writeFileSync(join(repository, "branch.txt"), "main\n");
  git(repository, "commit", "--quiet", "-am", "default branch moved");
  return repository;
}

function service(dataDir: string, modelsJson: Record<string, unknown>, max = 0) {
  return new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson,
    maxConcurrent: max,
    host: { kernelRoot: KERNEL },
  });
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 40));
  }
}

test("本地路径与 URL 形式仓库都在 clone 阶段检出任务基线", async () => {
  const repository = branchedRepository("transport");
  const taskService = service(
    mkdtempSync(join(tmpdir(), "mfc-baseline-transport-data-")), {}, 0);
  const sources = [repository, pathToFileURL(repository).toString()];
  for (const [index, source] of sources.entries()) {
    const root = mkdtempSync(join(tmpdir(), "mfc-baseline-checkout-"));
    const cwd = await (taskService as any).cloneRepo(
      root, undefined, undefined, source, "stable", `repo-${index}`,
    ) as string;
    assert.equal(git(cwd, "branch", "--show-current"), "stable");
    assert.equal(readFileSync(join(cwd, "branch.txt"), "utf-8"), "stable\n");
  }

  await assert.rejects(() => (taskService as any).cloneRepo(
    mkdtempSync(join(tmpdir(), "mfc-baseline-missing-")),
    undefined, undefined, repository, "does-not-exist", "repo",
  ), /仓库克隆失败：代码仓基线「does-not-exist」不存在或不可访问/);
});

test("正式单仓从所选 baseline 物化快照，并把 Skill 真正交给 Pi", async () => {
  const repository = branchedRepository("single-pi");
  const model = new ScriptedModelServer([{ text: "已读取任务上下文。" }]);
  await model.start();
  const taskService = service(
    mkdtempSync(join(tmpdir(), "mfc-baseline-single-data-")),
    model.modelsJson(),
    1,
  );
  let taskId = "";
  try {
    const catalog = await taskService.scanRepositorySkills({
      repositories: [repository], baseline: "stable", account: "dev",
    });
    const selected = catalog.repositories[0].skills[0];
    const task = taskService.create("按 stable 基线开发", {
      account: "dev",
      repo: repository,
      ticket: "REQ-BASELINE-1",
      baseline: "stable",
      repositorySkillCatalogToken: catalog.catalog_token,
      selectedRepositorySkillIds: [selected.id],
    });
    taskId = task.id;
    await until(() => model.requests.length > 0, "Pi 收到首个请求");

    const seen = JSON.stringify(model.requests);
    assert.match(seen, /BASELINE-STABLE-SKILL/,
      "扫描 baseline 中选中的 Skill 应出现在 Pi 能力目录");
    assert.ok(!seen.includes("DEFAULT-MAIN-SKILL"),
      "远端默认分支的同路径 Skill 不得冒充所选 baseline");
    const state = (taskService as any).tasks.get(task.id);
    assert.equal(git(state.cwd, "branch", "--show-current"), "stable");
  } finally {
    if (taskId && !["completed", "await_merge", "canceled"].includes(
      taskService.get(taskId)?.status ?? "")) {
      await taskService.cancel(taskId, "测试清理").catch(() => undefined);
    }
    await model.stop();
  }
});

test("跨仓只读分析的每个仓都检出同一任务基线", async () => {
  const repositoryA = branchedRepository("analysis-a");
  const repositoryB = branchedRepository("analysis-b");
  const model = new ScriptedModelServer([{ text: "分析现场已读取。" }]);
  await model.start();
  const taskService = service(
    mkdtempSync(join(tmpdir(), "mfc-baseline-analysis-data-")),
    model.modelsJson(),
    1,
  );
  let taskId = "";
  try {
    const task = taskService.create("分析两个 stable 仓的改动", {
      account: "dev",
      repos: [repositoryA, repositoryB],
      ticket: "REQ-BASELINE-2",
      baseline: "stable",
    });
    taskId = task.id;
    const analysisRoot = join(task.workspace, "repositories");
    const cwdA = join(analysisRoot, `1-${basename(repositoryA)}`);
    const cwdB = join(analysisRoot, `2-${basename(repositoryB)}`);
    await until(() => {
      try {
        // cloneRepo 异步化后,clone 完成与 pushurl 配置写入之间事件循环
        // 会跑本轮询——就绪条件必须等到 cloneRepo 的最后一步(pushurl)。
        return git(cwdA, "branch", "--show-current") === "stable"
          && git(cwdB, "branch", "--show-current") === "stable"
          && git(cwdB, "config", "--get", "remote.origin.pushurl") !== "";
      } catch {
        return false;
      }
    }, "两个分析仓检出 stable 且只读配置就位");
    assert.equal(readFileSync(join(cwdA, "branch.txt"), "utf-8"), "stable\n");
    assert.equal(readFileSync(join(cwdB, "branch.txt"), "utf-8"), "stable\n");
    assert.equal(git(cwdA, "config", "--get", "remote.origin.pushurl"),
      "/dev/null/mae-flow-readonly");
    assert.equal(git(cwdB, "config", "--get", "remote.origin.pushurl"),
      "/dev/null/mae-flow-readonly");
  } finally {
    if (taskId && !["completed", "await_merge", "canceled"].includes(
      taskService.get(taskId)?.status ?? "")) {
      await taskService.cancel(taskId, "测试清理").catch(() => undefined);
    }
    await model.stop();
  }
});

test("恢复已有工作区不重新 checkout baseline，不覆盖进行中的任务分支", async () => {
  const repository = branchedRepository("recovery");
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-baseline-recovery-data-"));
  const serviceA = service(dataDir, {}, 0);
  const created = serviceA.create("恢复时保留现场分支", {
    account: "dev",
    repo: repository,
    ticket: "REQ-BASELINE-3",
    baseline: "stable",
  });
  const cwd = await (serviceA as any).cloneRepo(
    created.workspace, undefined, undefined, repository, "stable",
  ) as string;
  git(cwd, "checkout", "--quiet", "-b", "stable_dev_REQ-BASELINE-3");
  const stateA = (serviceA as any).tasks.get(created.id);
  stateA.cwd = cwd;
  (serviceA as any).persist(stateA);

  const serviceB = service(dataDir, {}, 0);
  assert.deepEqual(serviceB.recover(), { restored: 1, requeued: 1 });
  const stateB = (serviceB as any).tasks.get(created.id);
  assert.equal(stateB.cwd, cwd);
  assert.equal(git(cwd, "branch", "--show-current"),
    "stable_dev_REQ-BASELINE-3",
    "恢复必须复用保存的 cwd，不能把在途分支切回 stable");
  assert.equal(serviceB.get(created.id)?.baseline, "stable");
});
