import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSafeWorktreeGit,
  runSafeWorktreeGitAsync,
} from "../src/safeGit.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o700);
}

test("安全 Git 忽略 Agent 写入的 fsmonitor 与继承 GIT_CONFIG", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-git-"));
  git(cwd, "init", "--quiet");
  const marker = join(cwd, "fsmonitor-ran");
  const monitor = join(cwd, "monitor.sh");
  executable(monitor, `printf compromised > '${marker}'; exit 1`);
  git(cwd, "config", "core.fsmonitor", monitor);
  const hostileConfig = join(cwd, "hostile.gitconfig");
  writeFileSync(hostileConfig, `[core]\n\tfsmonitor = ${monitor}\n`);

  const result = runSafeWorktreeGit(cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"], {
      env: { GIT_CONFIG: hostileConfig },
    });
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(existsSync(marker), false);
});

test("安全 Git diff 不执行仓库 external diff/textconv", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-diff-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "a.txt"), "before\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "--quiet", "-m", "before");
  writeFileSync(join(cwd, "a.txt"), "after\n");
  const marker = join(cwd, "external-diff-ran");
  const driver = join(cwd, "diff.sh");
  executable(driver, `printf compromised > '${marker}'; exit 1`);
  git(cwd, "config", "diff.external", driver);

  const result = runSafeWorktreeGit(cwd,
    ["diff", "--no-ext-diff", "--no-textconv", "--", "a.txt"]);
  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stdout), /after/);
  assert.equal(existsSync(marker), false);
});

test("安全 Git 代理不读取 clean/smudge 配置，也拒绝外部 objects alternates", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-filter-"));
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "a.txt"), "tracked\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "--quiet", "-m", "before");
  const marker = join(cwd, "filter-ran");
  const filter = join(cwd, "filter.sh");
  executable(filter, `printf compromised > '${marker}'; cat`);
  git(cwd, "config", "filter.owned.clean", filter);
  git(cwd, "config", "filter.owned.smudge", filter);
  writeFileSync(join(cwd, ".gitattributes"), "*.txt filter=owned\n");
  writeFileSync(join(cwd, "a.txt"), "changed\n");

  const status = runSafeWorktreeGit(cwd,
    ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(status.status, 0, String(status.stderr));
  assert.equal(existsSync(marker), false,
    "宿主 status 不能执行 Agent 配置的 clean/smudge 进程");

  const outside = mkdtempSync(join(tmpdir(), "mfc-foreign-objects-"));
  const info = join(cwd, ".git", "objects", "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "alternates"), `${outside}\n`);
  assert.throws(() => runSafeWorktreeGit(cwd, ["rev-parse", "HEAD"]),
    /alternates 不允许/);
});

test("异步安全 Git 等待子进程时不阻塞事件循环", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-git-async-"));
  git(cwd, "init", "--quiet");
  let timerFired = false;
  const run = runSafeWorktreeGitAsync(cwd, ["pause"], {
    configs: [["alias.pause", "!sleep 0.15"]],
    timeoutMs: 2_000,
  });
  setTimeout(() => { timerFired = true; }, 20);
  const result = await run;
  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(timerFired, true,
    "Git 子进程运行期间 Node 定时器和 HTTP 回调必须仍可执行");
});

test("安全 Git 仅通过显式 commitIdentity 保留重建提交的作者与时间", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-safe-git-identity-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.email", "bot@test");
  git(cwd, "config", "user.name", "bot");
  writeFileSync(join(cwd, "a.txt"), "content\n");
  git(cwd, "add", "a.txt");
  git(cwd, "commit", "--quiet", "-m", "before");
  const tree = git(cwd, "rev-parse", "HEAD^{tree}");
  const parent = git(cwd, "rev-parse", "HEAD");
  const rebuilt = runSafeWorktreeGit(cwd, [
    "commit-tree", tree, "-p", parent, "-m", "[REQ][fix]修正标题",
  ], {
    env: { GIT_AUTHOR_NAME: "不能从普通环境注入" },
    commitIdentity: {
      authorName: "Original Author",
      authorEmail: "author@example.test",
      authorDate: "2026-09-01T09:10:11+08:00",
      committerName: "Original Committer",
      committerEmail: "committer@example.test",
      committerDate: "2026-09-01T09:12:13+08:00",
    },
  });
  assert.equal(rebuilt.status, 0, String(rebuilt.stderr));
  const facts = git(cwd, "show", "-s", "--format=%an|%ae|%aI|%cn|%ce|%cI",
    String(rebuilt.stdout).trim());
  assert.equal(facts,
    "Original Author|author@example.test|2026-09-01T09:10:11+08:00|"
    + "Original Committer|committer@example.test|2026-09-01T09:12:13+08:00");
});
