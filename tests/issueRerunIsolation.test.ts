/**
 * 同单重跑的隔离与分支命名(2026-08-28 事故回归;ADR-0063 修订)。
 *
 * 原事故:会话 A 跑得不对被取消,重跑同单的会话 B 执行到中途,AI 说了句
 * "仓库已存在本地且修复分支已经存在"让人摸不着头脑。诊断结论:
 * - 目录隔离本身成立——每次登记都开新目录 issue-<N>,仓落在各自
 *   repo/<仓名>/。取消后按当前磁盘治理契约回收旧现场;重跑仍是全新克隆。
 * - 分支命名撞车:旧命名烧死 master_工号_单号,A 停止前推过的话,
 *   B 从基线另起同名分支——分叉憋到 push 才以非快进炸掉。
 *
 * ADR-0063 落地后的契约:分支名带秒级时间戳,重跑会话各用各的新名
 * (同单重跑 = 新分支新 MR,旧分支与旧 MR 留在平台由人处置)——撞名
 * 在结构上不可能再发生,当年的「遗留警报」(pull_repo 回执扫描远端
 * 分叉)随之退役,拉仓回执不再有警报。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { pushFromIssueWorkspace } from "../src/issueFlow/issueGit.ts";
import { loadState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin],
    { env: GIT_ENV });
  return origin;
}

async function until(
  probe: () => unknown,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function git(dir: string, ...args: string[]): string {
  const run = spawnSync("git", ["-C", dir, ...args],
    { encoding: "utf-8", env: GIT_ENV });
  assert.equal(run.status, 0, `git ${args.join(" ")} 失败: ${run.stderr}`);
  return run.stdout.trim();
}

const TICKET = "DTS-2026-1006";
const BASELINE = "master";

test("取消后重跑同单:新会话新目录全新克隆,各用各的时间戳新分支,回执无遗留警报", async () => {
  const dataDir = mfcTemp("mfc-issue-rerun-");
  const origin = bareOrigin(dataDir);
  const model = new ScriptedModelServer([
    // ---- 会话 A:拉单(自报收口)→ 拉仓 → 自报收口 → 修复分支上落一笔
    // 提交(模拟跑到中途)→ 举分析闸。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "cd repo/origin && git -c user.name=test -c user.email=t@e commit -q"
      + " --allow-empty -m halfway" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n根因:演示。\\n## 置信度\\n高。\\n## 修改方案\\n修复演示路径。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示" } } },
    { text: "分析已提交,等待确认。" },
    // ---- 会话 B(重跑):拉单 → 拉仓照常收口,没有任何遗留警报可报。
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command:
      "printf '# 问题分析\\n\\n## 问题现象\\n演示现象。\\n## 问题根因\\n根因:演示(重跑)。\\n## 置信度\\n高。\\n## 修改方案\\n修复演示路径。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis", input: { summary: "根因=演示(重跑)" } } },
    { text: "重跑分析已提交。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    opsTools: {
      async buildDeploy() { return { summary: "测试假件" }; },
    },
    gitCredential: () => ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  try {
    const first = service.create({
      account: "dev", title: "开局飞跑", ticket: TICKET,
      source: "dts", repoUrl: origin, baseline: BASELINE,
    });
    await until(() => service.get(first.id).status === "waiting_user",
      "会话 A 举分析闸");
    const branchA = loadState(join(dataDir, "issues", first.id))?.fix_branch;
    assert.match(branchA ?? "", /^master_dev_DTS-2026-1006_\d{14}$/,
      "A 的分支名=基线_工号_单号_时间戳");

    // 用户停掉 A 之前,上次运行已把修复分支推上远端(显式 URL 绕开
    // 工作区 pushurl 加固——模拟宿主 push 的结果状态)。
    const repoA = join(dataDir, "issues", first.id, "repo", "origin");
    const leftoverSha = git(repoA, "rev-parse", "HEAD");
    execFileSync("git",
      ["-C", repoA, "push", "-q", origin, `HEAD:refs/heads/${branchA}`],
      { env: GIT_ENV });

    await service.control(first.id, { action: "cancel" });
    assert.equal(service.get(first.id).status, "canceled");

    // 取消是终态,单号查重放行:同账号新会话必须开新目录。
    // 分支名时间戳秒级粒度(ADR-0063):快机上重跑会落进同一秒,两名
    // 相同而会话仍独立——垫出秒界,保住「各用各的时间戳新名」断言的
    // 确定性(CI 实锤:2026-10-31 首跑即同秒撞名)。
    const secondsBoundary = 1_000 - (Date.now() % 1_000);
    await new Promise(resolve => setTimeout(resolve, secondsBoundary + 5));
    const second = service.create({
      account: "dev", title: "开局飞跑(重跑)", ticket: TICKET,
      source: "dts", repoUrl: origin, baseline: BASELINE,
    });
    assert.notEqual(second.id, first.id, "重跑同单 = 全新会话");
    await until(() => service.get(second.id).status === "waiting_user",
      "会话 B 举分析闸");

    // 隔离与命名事实:B 有自己的全新克隆,用自己的时间戳新分支——
    // 与 A 的遗留分支不同名,起点是基线,A 的提交混不进来。
    const repoB = join(dataDir, "issues", second.id, "repo", "origin");
    assert.ok(existsSync(join(repoB, ".git")), "B 是全新克隆");
    // 取消即回收(磁盘治理票 01):canceled 单的 repo/ 当场后台回收
    // (setImmediate,不阻塞取消响应),落 repo_reclaimed_at 标记——
    // 过程记录全保留,只有源码克隆清掉(源码可随时重拉)。
    await until(() => !existsSync(join(repoA, ".git")),
      "取消后 A 的 repo/ 现场被回收");
    assert.ok(service.get(first.id).repo_reclaimed_at,
      "回收要落 repo_reclaimed_at 标记");
    const stateB = loadState(join(dataDir, "issues", second.id));
    assert.match(stateB?.fix_branch ?? "", /^master_dev_DTS-2026-1006_\d{14}$/,
      "B 的分支名同样=基线_工号_单号_时间戳");
    assert.notEqual(stateB?.fix_branch, branchA,
      "重跑不复用上一轮的分支:各用各的时间戳新名");
    assert.equal(git(repoB, "branch", "--show-current"), stateB?.fix_branch,
      "B 的修复分支已切好");
    assert.equal(git(repoB, "rev-parse", "HEAD"), git(repoB, "rev-parse", BASELINE),
      "B 本地分支起点=基线,不是 A 的遗留分支");
    const containsLeftover = spawnSync(
      "git", ["-C", repoB, "merge-base", "--is-ancestor", leftoverSha, "HEAD"],
      { encoding: "utf-8", env: GIT_ENV });
    assert.notEqual(containsLeftover.status, 0,
      "A 的遗留提交不能混进 B 的本地分支历史");
    // A 的遗留分支留在远端由人处置(平台无自动关 MR/删分支的通道)。
    const remoteBranches = spawnSync("git", ["--git-dir", origin, "for-each-ref",
      "--format=%(refname:short)", "refs/heads"],
      { encoding: "utf-8", env: GIT_ENV }).stdout;
    assert.ok(remoteBranches.includes(branchA ?? ""),
      "A 的遗留分支留在平台上,平台不代删");

    // 回执契约(ADR-0063):拉仓回执与阶段台账都不再有「遗留警报」——
    // 撞名在新命名下结构性不可能,警报是永远不响的死代码。
    assert.doesNotMatch(JSON.stringify(model.requests), /遗留警报/,
      "pull_repo 回执不再有遗留警报");
    const trail = (service.get(second.id).transitions ?? [])
      .map((item) => item.note).join("\n");
    assert.doesNotMatch(trail, /远端同名修复分支遗留/,
      "阶段台账不再记遗留分支事实");
  } finally {
    await service.shutdown();
    await model.stop();
  }
});

test("推送撞远端同名分支(罕见异动兜底):失败信息点名非快进并指路 sync_branch", async () => {
  const dataDir = mfcTemp("mfc-issue-push-");
  const origin = bareOrigin(dataDir);
  // 异动现场:远端已有同名分支且带一笔分叉提交。
  const x = join(dataDir, "x");
  execFileSync("git", ["clone", "-q", origin, x], { env: GIT_ENV });
  execFileSync("git", ["-C", x, "checkout", "-q", "-b", "feature/clash"],
    { env: GIT_ENV });
  execFileSync("git", ["-C", x, "commit", "-q", "--allow-empty",
    "-m", "old"], { env: GIT_ENV });
  execFileSync("git",
    ["-C", x, "push", "-q", origin, "feature/clash"], { env: GIT_ENV });
  // 本地从基线另起同名分支再推,必然非快进。
  const y = join(dataDir, "y");
  execFileSync("git", ["clone", "-q", origin, y], { env: GIT_ENV });
  execFileSync("git", ["-C", y, "checkout", "-q", "-b", "feature/clash"],
    { env: GIT_ENV });
  execFileSync("git", ["-C", y, "commit", "-q", "--allow-empty",
    "-m", "new"], { env: GIT_ENV });
  await assert.rejects(
    pushFromIssueWorkspace({ dataDir, repoDir: y, repoUrl: origin, branch: "feature/clash" }),
    (error: Error) => {
      assert.match(error.message, /非快进/);
      assert.match(error.message, /罕见异动/);
      // 处置指路 sync_branch(ADR-0074):先并入手改再重推,不盲盖、
      // 不再建议 force 重推(覆盖外部提交须人工核对后显式放行)。
      assert.match(error.message, /sync_branch/);
      assert.match(error.message, /外部提交/);
      return true;
    },
    "非快进失败要带人话:原因(罕见异动)+ 处置方向",
  );
});
