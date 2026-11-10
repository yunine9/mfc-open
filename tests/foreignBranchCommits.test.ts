/**
 * 外来提交(人直接往任务分支推的代码)的接续契约。
 *
 * 真 git:裸仓当远端,一个克隆当"人",一个克隆当任务现场。判定全部落在
 * 提交图上——谁是谁的祖先、别人的提交 SHA 有没有被改写——假件说不清
 * 这些,只能用真件当裁判。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  absorbForeignBranchCommits,
  type ForeignGitResult,
} from "../src/foreignBranchCommits.ts";

const BRANCH = "master_bot_REQ9";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function runner(cwd: string) {
  return (args: string[]): Promise<ForeignGitResult> =>
    new Promise((resolve) => {
      execFile("git", args, { cwd, encoding: "utf-8" },
        (error, stdout, stderr) => {
          // git 退出码走 error.code(数字);spawn 本身失败时 code 是
          // "ENOENT" 之类的字符串,那才是真异常。
          const code = (error as (Error & { code?: number | string }) | null)
            ?.code;
          resolve({
            status: error ? (typeof code === "number" ? code : null) : 0,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            ...(error && typeof code !== "number" ? { error } : {}),
          });
        });
    });
}

function identify(repo: string): void {
  git(repo, "config", "user.email", "bot@test");
  git(repo, "config", "user.name", "bot");
}

function commit(repo: string, file: string, body: string, subject: string): string {
  writeFileSync(join(repo, file), body);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", subject);
  return git(repo, "rev-parse", "HEAD");
}

/** 远端裸仓 + 已经推过一轮的任务现场。返回值里的 pushed 就是"推送收据"。 */
function scene(): { bare: string; work: string; pushed: string } {
  const root = mkdtempSync(join(tmpdir(), "mfc-foreign-"));
  const source = join(root, "source");
  execFileSync("git", ["init", "--quiet", "-b", "master", source]);
  identify(source);
  commit(source, "README.md", "# demo\n", "init");
  const bare = join(root, "origin.git");
  execFileSync("git", ["init", "--quiet", "--bare", bare]);
  git(source, "push", "--quiet", bare, "--all");
  // 裸仓 HEAD 默认指向 init.defaultBranch;与源仓分支名不符时 clone 得到
  // 的是空工作树 + 未出生的 HEAD(git 只 warning),后面的分支会变成根提交。
  git(bare, "symbolic-ref", "HEAD", "refs/heads/master");
  const work = join(root, "work");
  execFileSync("git", ["clone", "--quiet", bare, work]);
  identify(work);
  git(work, "checkout", "--quiet", "-b", BRANCH);
  const pushed = commit(work, "a.txt", "bot round 1\n", "feat: 第一轮");
  git(work, "push", "--quiet", bare, `${BRANCH}:refs/heads/${BRANCH}`);
  return { bare, work, pushed };
}

/** 人直接 clone 下来往同一条分支上推东西。 */
function humanPush(bare: string, file: string, body: string, subject: string): string {
  const clone = mkdtempSync(join(tmpdir(), "mfc-human-"));
  execFileSync("git", ["clone", "--quiet", "--branch", BRANCH, bare, clone]);
  git(clone, "config", "user.email", "human@test");
  git(clone, "config", "user.name", "human");
  const sha = commit(clone, file, body, subject);
  git(clone, "push", "--quiet", "origin", BRANCH);
  return sha;
}

async function absorb(bare: string, work: string, lastPushedSha?: string) {
  return absorbForeignBranchCommits({
    branch: BRANCH,
    remoteUrl: bare,
    lastPushedSha,
    transport: runner(tmpdir()),
    worktree: runner(work),
  });
}

test("查询远端后、fetch 前又有人追加：使用实际 fetch 到的最新提交接续", async () => {
  const { bare, work, pushed } = scene();
  const first = humanPush(bare, "first.txt", "first\n", "feat: 第一次追加");
  commit(work, "mine.txt", "mine\n", "feat: 本地修改");
  let latest = first;
  const transport = runner(tmpdir());
  const outcome = await absorbForeignBranchCommits({ branch: BRANCH, remoteUrl: bare, lastPushedSha: pushed,
    transport: async args => {
      const result = await transport(args);
      if (args[0] === "ls-remote") latest = humanPush(bare, "second.txt", "second\n", "feat: 查询期间追加");
      return result;
    }, worktree: runner(work) });
  assert.equal(outcome.kind, "absorbed", JSON.stringify(outcome));
  if (outcome.kind !== "absorbed") return;
  assert.equal(outcome.base_sha, latest);
  assert.equal(git(work, "merge-base", "--is-ancestor", latest, "HEAD"), "");
  git(work, "push", "--quiet", bare, BRANCH);
  assert.equal(git(bare, "show", `${BRANCH}:second.txt`), "second");
});

test("远端多了人推的提交:本任务的提交接到它后面,外来提交原样不动", async () => {
  const { bare, work, pushed } = scene();
  const human = humanPush(bare, "hotfix.txt", "human fix\n", "fix: 人工热修");
  const mine = commit(work, "b.txt", "bot round 2\n", "feat: 第二轮");

  const outcome = await absorb(bare, work, pushed);

  assert.equal(outcome.kind, "absorbed", JSON.stringify(outcome));
  if (outcome.kind !== "absorbed") return;
  assert.equal(outcome.base_sha, human);
  assert.equal(outcome.count, 1);
  assert.match(outcome.subjects[0], /人工热修/);
  assert.equal(outcome.previous_head, mine);
  assert.notEqual(outcome.head, mine, "本任务的提交必须被重放到新基座上");
  assert.equal(git(work, "rev-parse", "HEAD"), outcome.head);
  // 别人的提交是新基座,SHA 一个字节都不能变——改写它等于把人推上去的
  // 东西从历史里抹掉。
  assert.equal(git(work, "rev-parse", "HEAD~1"), human);
  assert.equal(git(work, "cat-file", "-p", `${human}:hotfix.txt`), "human fix");
  assert.equal(git(work, "log", "--format=%s", "-1"), "feat: 第二轮");
  assert.equal(git(work, "rev-parse", `refs/remotes/origin/${BRANCH}`), human,
    "远端跟踪引用要写下来:提交说明门禁靠 --not --remotes 放过外来提交");
});

test("远端头就是本任务推过的提交:不拉不改,原地放行", async () => {
  const { bare, work, pushed } = scene();
  const mine = commit(work, "b.txt", "bot round 2\n", "feat: 第二轮");
  const outcome = await absorb(bare, work, pushed);
  assert.equal(outcome.kind, "none");
  assert.equal(git(work, "rev-parse", "HEAD"), mine, "HEAD 不能被动过");
});

test("远端历史被改写(推过的提交已不可达):停下点名两个 SHA,不接续", async () => {
  const { bare, work, pushed } = scene();
  // 有人 force push 掉了我们验证过的那条历史。
  const clone = mkdtempSync(join(tmpdir(), "mfc-human-"));
  execFileSync("git", ["clone", "--quiet", "--branch", BRANCH, bare, clone]);
  identify(clone);
  git(clone, "reset", "--hard", "HEAD~1");
  commit(clone, "a.txt", "human rewrote\n", "feat: 人工重写");
  git(clone, "push", "--quiet", "--force", "origin", BRANCH);

  const outcome = await absorb(bare, work, pushed);

  assert.equal(outcome.kind, "blocked", JSON.stringify(outcome));
  if (outcome.kind !== "blocked") return;
  assert.match(outcome.reason, /已被改写/);
  assert.match(outcome.reason, new RegExp(pushed.slice(0, 7)),
    "要点名本任务推送过的提交");
});

test("接不上(同一文件冲突):还原现场后停下,不留半个 rebase", async () => {
  const { bare, work, pushed } = scene();
  humanPush(bare, "a.txt", "human line\n", "fix: 人工改了同一处");
  const mine = commit(work, "a.txt", "bot line\n", "feat: 机器改了同一处");

  const outcome = await absorb(bare, work, pushed);

  assert.equal(outcome.kind, "blocked", JSON.stringify(outcome));
  if (outcome.kind !== "blocked") return;
  assert.match(outcome.reason, /冲突文件:a\.txt|接不到/);
  assert.equal(git(work, "rev-parse", "HEAD"), mine, "现场必须还原");
  assert.equal(git(work, "status", "--porcelain"), "",
    "不能留下冲突标记或半个 rebase");
});

test("工作区还有未提交改动:不猜着卷进接续,停下喊人", async () => {
  const { bare, work, pushed } = scene();
  humanPush(bare, "hotfix.txt", "human fix\n", "fix: 人工热修");
  commit(work, "b.txt", "bot round 2\n", "feat: 第二轮");
  writeFileSync(join(work, "b.txt"), "还没提交的改动\n");

  const outcome = await absorb(bare, work, pushed);

  assert.equal(outcome.kind, "blocked", JSON.stringify(outcome));
  if (outcome.kind !== "blocked") return;
  assert.match(outcome.reason, /未提交改动/);
});

test("没有推送收据却撞上已有分支:不认领,如实停下", async () => {
  const { bare, work } = scene();
  humanPush(bare, "hotfix.txt", "human fix\n", "fix: 人工热修");
  commit(work, "b.txt", "bot round 2\n", "feat: 第二轮");

  const outcome = await absorb(bare, work, undefined);

  assert.equal(outcome.kind, "blocked", JSON.stringify(outcome));
  if (outcome.kind !== "blocked") return;
  assert.match(outcome.reason, /分支归属/);
});

test("远端还没有这条分支:首次推送不受影响", async () => {
  const { bare, work } = scene();
  git(work, "checkout", "--quiet", "-b", "master_bot_REQ10");
  const outcome = await absorbForeignBranchCommits({
    branch: "master_bot_REQ10",
    remoteUrl: bare,
    transport: runner(tmpdir()),
    worktree: runner(work),
  });
  assert.equal(outcome.kind, "none");
});
