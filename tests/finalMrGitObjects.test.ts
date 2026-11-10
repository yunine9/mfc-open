import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareFinalMrObjects, retainInitialMrCommit } from "../src/finalMrGitObjects.ts";
import { HostGitSandbox } from "../src/hostGitSandbox.ts";

test("从同仓另一个分支读取最终代码，忽略工作区的远端重写和 helper，不改变分支、引用、暂存内容", async t => {
  const root = mkdtempSync(join(tmpdir(), "final-mr-objects-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, "upstream"), local = join(root, "task");
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  mkdirSync(remote); git(remote, "init", "-b", "main");
  git(remote, "config", "user.name", "developer"); git(remote, "config", "user.email", "dev@example.test");
  writeFileSync(join(remote, "code.ts"), "export const value = 1;");
  git(remote, "add", "."); git(remote, "commit", "-m", "initial");
  git(root, "clone", "--no-local", remote, local);
  const base = git(local, "rev-parse", "HEAD");
  git(remote, "checkout", "-b", "local-tuning");
  writeFileSync(join(remote, "code.ts"), "export const value = 2;");
  git(remote, "commit", "-am", "adjust"); const head = git(remote, "rev-parse", "HEAD");
  const trap = join(root, "unexpected-helper");
  git(local, "config", "url.ext::touch " + trap + ".insteadOf", remote);
  git(local, "config", "credential.helper", "!touch " + trap);
  writeFileSync(join(local, "todo.txt"), "本地暂存"); git(local, "add", "todo.txt");
  const refs = git(local, "show-ref"), tree = git(local, "write-tree");
  const sandbox = new HostGitSandbox(root);
  await prepareFinalMrObjects(local, remote, [{base, head, source_branch: "local-tuning"}], sandbox);
  assert.match(git(local, "show", head + ":code.ts"), /value = 2/);
  assert.equal(git(local, "rev-parse", "HEAD"), base);
  assert.equal(git(local, "show-ref"), refs);
  assert.equal(git(local, "write-tree"), tree);
  assert.equal(existsSync(trap), false);
  assert.equal(existsSync(join(local, ".git", "FETCH_HEAD")), false);
  await assert.rejects(prepareFinalMrObjects(local, remote, [{head:"c".repeat(40)}], sandbox), /未能读取/);
  assert.equal(readdirSync(join(root, ".runtime", "host-git")).length, 0);
});


test("初版所在分支删除并清理 Git 后，仍能按首发版本读取代码", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "retain-initial-mr-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "developer"); git("config", "user.email", "dev@example.test");
  writeFileSync(join(cwd, "code.ts"), "old"); git("add", "code.ts"); git("commit", "-m", "base");
  git("switch", "-c", "first-mr");
  writeFileSync(join(cwd, "code.ts"), "draft"); git("commit", "-am", "first");
  const first = git("rev-parse", "HEAD");
  await retainInitialMrCommit(cwd, first);
  git("switch", "main"); git("branch", "-D", "first-mr");
  git("reflog", "expire", "--expire=now", "--all"); git("gc", "--prune=now");
  assert.equal(git("show", first + ":code.ts"), "draft");
  assert.equal(git("show", "HEAD:code.ts"), "old");
});
