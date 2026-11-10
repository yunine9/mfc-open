import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncKnowledgeSource } from "../src/knowledgeExtractionFactory.ts";

test("知识源码装配同步指定分支，复用缓存并保留取消行为", async () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-source-"));
  try {
    const source = join(dir, "source"), cache = join(dir, "cache");
    execFileSync("git", ["init", "-q", "-b", "main", source]);
    const git = (...args: string[]) => execFileSync("git", ["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { encoding: "utf8" }).trim();
    git("commit", "-q", "--allow-empty", "-m", "first");
    const sandbox = { args: [], env: process.env };
    assert.deepEqual(await syncKnowledgeSource(cache, source, "main", sandbox), { root: cache, revision: git("rev-parse", "HEAD") });
    git("commit", "-q", "--allow-empty", "-m", "second");
    assert.equal((await syncKnowledgeSource(cache, source, "main", sandbox)).revision, git("rev-parse", "HEAD"));
    assert.equal((await syncKnowledgeSource(cache, source, "", sandbox)).revision, git("rev-parse", "HEAD"), "未登记分支时读取真实远端 HEAD，不猜 main/master");
    await assert.rejects(syncKnowledgeSource(cache, source, "main", sandbox, AbortSignal.abort()), (error: Error) => error.name === "AbortError");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
