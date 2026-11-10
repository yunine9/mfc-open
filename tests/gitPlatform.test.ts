/**
 * Git 平台与流水线模拟的契约(主 spec §7.3/§10/§14.5):
 * 裸仓是唯一远端真相、MR 幂等、流水线结果绑 SHA、
 * MR 状态"验证中→等待合入"由流水线通过驱动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-src-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

test("裸仓灌历史 → 克隆 → 推分支 → MR 幂等 → 流水线绑 SHA", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  const bare = platform.initBare(source, dataDir);
  await platform.start();
  try {
    // 任务视角:从裸仓克隆、切需求分支、改代码、推回。
    const work = join(dataDir, "work");
    git(dataDir, "clone", "--quiet", bare, "work");
    git(work, "config", "user.email", "bot@test");
    git(work, "config", "user.name", "bot");
    git(work, "checkout", "--quiet", "-b", "master_bot_REQ1");
    writeFileSync(join(work, "a.txt"), "change\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "feat: REQ1");
    git(work, "push", "--quiet", "origin", "master_bot_REQ1");
    const sha = git(work, "rev-parse", "HEAD");

    // MR:创建 → 幂等(恢复重放不翻倍)→ 初始状态"验证中"。
    const create = () => fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master_bot_REQ1",
        target_branch: "master",
        title: "feat: REQ1",
      }),
    }).then((r) => readJson(r));
    const mr = await create();
    const replay = await create();
    assert.equal(replay.id, mr.id);
    assert.equal(mr.sha, sha);
    assert.equal(mr.state, "验证中");

    // 旧 SHA 没有任何流水线记录可背书。
    const empty = await fetch(
      `${platform.baseUrl}/pipeline/status?sha=${sha}`)
      .then((r) => readJson(r));
    assert.equal(empty.runs.length, 0);

    // 流水线通过 → 同 SHA 的 MR 变"等待合入";系统不自动合并。
    const run = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    }).then((r) => readJson(r));
    assert.equal(run.status, "success");
    assert.deepEqual(
      run.checks.map((item: { dimension: string }) => item.dimension),
      ["COMPILE", "UT", "CODECHECK"],
      "总体绿灯之外必须给内核三项独立事实");
    assert.ok(run.checks.every((item: { status: string }) =>
      item.status === "success"));
    const after = (await fetch(`${platform.baseUrl}/mr`)
      .then((r) => readJson(r)))[0];
    assert.equal(after.state, "等待合入");

    // 新提交出现:旧绿灯不背书新代码。
    writeFileSync(join(work, "b.txt"), "more\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "fix: 补一刀");
    const newSha = git(work, "rev-parse", "HEAD");
    const stale = await fetch(
      `${platform.baseUrl}/pipeline/status?sha=${newSha}`)
      .then((r) => readJson(r));
    assert.equal(stale.runs.length, 0);
  } finally {
    await platform.stop();
  }
});

test("假平台按 repo 路由第二裸仓的 MR、流水线与浏览器合入", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-multi-"));
  const sourceA = makeSourceRepo();
  const sourceB = makeSourceRepo();
  const platform = new FakeGitPlatform();
  platform.initBare(sourceA, dataDir);
  const bareB = join(dataDir, "origin-aux.git");
  mkdirSync(bareB, { recursive: true });
  git(bareB, "init", "--bare", "--quiet");
  execFileSync("git", ["push", "--quiet", bareB, "--all"], {
    cwd: sourceB, encoding: "utf-8",
  });
  git(bareB, "symbolic-ref", "HEAD", "refs/heads/master");
  await platform.start();
  try {
    const work = join(dataDir, "work-aux");
    git(dataDir, "clone", "--quiet", bareB, "work-aux");
    git(work, "config", "user.email", "bot@test");
    git(work, "config", "user.name", "bot");
    git(work, "checkout", "--quiet", "-b", "master_owner_REQ_AUX");
    writeFileSync(join(work, "aux.txt"), "aux change\n");
    git(work, "add", "aux.txt");
    git(work, "commit", "--quiet", "-m", "feat: aux");
    git(work, "push", "--quiet", "origin", "master_owner_REQ_AUX");
    const sha = git(work, "rev-parse", "HEAD");

    const mr = await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        repo: bareB,
        source_branch: "master_owner_REQ_AUX",
        target_branch: "master",
        title: "aux MR",
      }),
    }).then((r) => readJson(r));
    assert.equal(mr.sha, sha, "第二仓分支不能误去默认仓查找");
    assert.equal(mr.repo, bareB);

    const run = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST",
      body: JSON.stringify({ sha, repo: bareB }),
    }).then((r) => readJson(r));
    assert.equal(run.status, "success");
    const gates = await fetch(`${platform.baseUrl}/mr/gates?${new URLSearchParams({
      repo: bareB,
      source_branch: "master_owner_REQ_AUX",
      target_branch: "master",
    })}`).then((r) => readJson(r));
    assert.ok(gates.gates.every((gate: { passed: boolean }) => gate.passed));

    const merged = await fetch(`${platform.baseUrl}/mr/${mr.id}/merge`, {
      method: "POST", redirect: "manual",
    });
    assert.equal(merged.status, 303);
    assert.equal(git(bareB, "rev-parse", "master"), sha,
      "浏览器合入必须推进第二仓目标分支");
    assert.notEqual(git(platform.barePath, "rev-parse", "master"), sha,
      "默认仓不能被第二仓 MR 污染");
  } finally {
    await platform.stop();
  }
});

test("流水线失败:MR 停在验证中;失败结果同样绑 SHA 留痕", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  platform.initBare(source, dataDir);
  await platform.start();
  try {
    const sha = platform.branchSha("master");
    const mr = await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master", target_branch: "master", title: "t",
      }),
    }).then((r) => readJson(r));
    platform.nextPipelineStatus = "failed";
    const run = await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    }).then((r) => readJson(r));
    assert.equal(run.status, "failed");
    const after = (await fetch(`${platform.baseUrl}/mr`)
      .then((r) => readJson(r)))[0];
    assert.equal(after.state, "验证中");
    assert.equal(mr.id, after.id);
  } finally {
    await platform.stop();
  }
});

test("浏览器路径:MR 页面可开、门禁全绿才可合入、合入真实快进目标 ref(MFC-005)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-merge-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  const bare = platform.initBare(source, dataDir);
  await platform.start();
  try {
    const work = join(dataDir, "work");
    git(dataDir, "clone", "--quiet", bare, "work");
    git(work, "config", "user.email", "bot@test");
    git(work, "config", "user.name", "bot");
    git(work, "checkout", "--quiet", "-b", "master_bot_REQ2");
    writeFileSync(join(work, "b.txt"), "merge me\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "feat: REQ2");
    git(work, "push", "--quiet", "origin", "master_bot_REQ2");
    const sha = git(work, "rev-parse", "HEAD");
    const mr = await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master_bot_REQ2", target_branch: "master",
        title: "feat: REQ2",
      }),
    }).then((r) => readJson(r)) as { id: number; url: string };

    // 页面可开(曾经 404,任务卡上的链接是死的)。
    const page = await fetch(mr.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /master_bot_REQ2/);
    assert.match(html, /门禁未过|未跑/, "流水线未跑时页面必须说清为什么不能合入");
    assert.doesNotMatch(html, /<button/, "门禁未过不给合入按钮");

    // 门禁红时 POST 合入被拒,目标 ref 不动。
    const refused = await fetch(`${mr.url}/merge`, { method: "POST" });
    assert.equal(refused.status, 409);
    assert.notEqual(git(bare, "rev-parse", "master"), sha);

    // 流水线绿灯后按钮出现,合入真实快进目标分支并翻 merged。
    await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    });
    const ready = await fetch(mr.url).then((r) => r.text());
    assert.match(ready, /<button/);
    const merged = await fetch(`${mr.url}/merge`, { method: "POST", redirect: "manual" });
    assert.equal(merged.status, 303, "浏览器表单合入后回到 MR 页面");
    assert.equal(git(bare, "rev-parse", "master"), sha,
      "合入必须真实推进目标 ref,不是翻状态字段");
    const gates = await fetch(`${platform.baseUrl}/mr/gates`
      + "?source_branch=master_bot_REQ2&target_branch=master")
      .then((r) => readJson(r)) as { mr_state: string };
    assert.equal(gates.mr_state, "merged", "宿主轮询看到的就是合入事实");
    // 二次合入幂等拒绝。
    const again = await fetch(`${mr.url}/merge`, { method: "POST" });
    assert.equal(again.status, 409);
  } finally {
    await platform.stop();
  }
});

// MFC-037:冲突门禁与真正 merge 必须同一套事实。此前门禁读测试布尔恒
// 绿,页面给出合入按钮,点了才在 Git 层撞 409——MFC 看见假绿永远不派
// 冲突修复,人卡在浏览器死路里。现在目标分支前进(非快进)时门禁就红。
test("目标分支前进后冲突门禁立即红;合入 409 给人话页面;补齐快进后恢复", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-git-conflict-"));
  const source = makeSourceRepo();
  const platform = new FakeGitPlatform();
  const bare = platform.initBare(source, dataDir);
  await platform.start();
  try {
    const work = join(dataDir, "work");
    git(dataDir, "clone", "--quiet", bare, "work");
    git(work, "config", "user.email", "bot@test");
    git(work, "config", "user.name", "bot");
    git(work, "checkout", "--quiet", "-b", "master_bot_REQ3");
    writeFileSync(join(work, "c.txt"), "task change\n");
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "feat: REQ3");
    git(work, "push", "--quiet", "origin", "master_bot_REQ3");
    const sha = git(work, "rev-parse", "HEAD");
    const mr = await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master_bot_REQ3", target_branch: "master",
        title: "feat: REQ3",
      }),
    }).then((r) => readJson(r)) as { id: number; url: string };
    await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha }),
    });

    // 模拟别的 MR 先合入:目标分支前进,任务分支不再可快进。
    const other = join(dataDir, "other");
    git(dataDir, "clone", "--quiet", bare, "other");
    git(other, "config", "user.email", "peer@test");
    git(other, "config", "user.name", "peer");
    writeFileSync(join(other, "d.txt"), "peer change\n");
    git(other, "add", ".");
    git(other, "commit", "--quiet", "-m", "feat: peer");
    git(other, "push", "--quiet", "origin", "master");

    // 门禁与页面同一事实:conflict_passed 红、无合入按钮。
    const gates = await fetch(`${platform.baseUrl}/mr/gates`
      + "?source_branch=master_bot_REQ3&target_branch=master")
      .then((r) => readJson(r)) as {
        gates: Array<{ name: string; passed: boolean; detail?: string }> };
    const conflict = gates.gates.find((g) => g.name === "conflict_passed")!;
    assert.equal(conflict.passed, false, "目标分支前进后冲突门禁必须红");
    assert.match(String(conflict.detail), /先在任务侧合并目标分支/);
    const page = await fetch(mr.url).then((r) => r.text());
    assert.doesNotMatch(page, /<button/, "冲突红时不给合入按钮");

    // 即便绕过页面直接 POST,也拿到人话 HTML 而非裸 JSON 死路。
    const refused = await fetch(`${mr.url}/merge`, { method: "POST" });
    assert.equal(refused.status, 409);
    const refusedHtml = await refused.text();
    assert.match(refusedHtml, /合入失败/);
    assert.match(refusedHtml, /自动派发修复|返回 MR 页/);

    // 任务侧合并目标分支后重推,门禁恢复绿,可正常合入。
    git(work, "fetch", "--quiet", "origin");
    git(work, "merge", "--quiet", "--no-edit", "origin/master");
    git(work, "push", "--quiet", "origin", "master_bot_REQ3");
    const mergedSha = git(work, "rev-parse", "HEAD");
    await fetch(`${platform.baseUrl}/mr`, {
      method: "POST",
      body: JSON.stringify({
        source_branch: "master_bot_REQ3", target_branch: "master",
        title: "feat: REQ3",
      }),
    }); // 幂等复用把 MR sha 对齐到新 HEAD
    await fetch(`${platform.baseUrl}/pipeline/trigger`, {
      method: "POST", body: JSON.stringify({ sha: mergedSha }),
    });
    const recovered = await fetch(`${platform.baseUrl}/mr/gates`
      + "?source_branch=master_bot_REQ3&target_branch=master")
      .then((r) => readJson(r)) as {
        gates: Array<{ name: string; passed: boolean }> };
    assert.equal(recovered.gates
      .find((g) => g.name === "conflict_passed")!.passed, true,
      "快进恢复后冲突门禁必须回绿");
    const merged = await fetch(`${mr.url}/merge`,
      { method: "POST", redirect: "manual" });
    assert.equal(merged.status, 303);
    assert.equal(git(bare, "rev-parse", "master"), mergedSha);
  } finally {
    await platform.stop();
  }
});
