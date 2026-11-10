import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryFileList, readDeliveryFiles, pendingPushFiles } from "../src/deliveryFileList.ts";

test("完整交付清单保留所有真实 Git 文件和新增、修改、删除、重命名类型", async t => {
  const cwd = mkdtempSync(join(tmpdir(), "delivery-file-list-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "master"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
  for (const file of ["README.md", "deleted.txt", "old.txt"]) writeFileSync(join(cwd, file), file + "\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, "README.md"), "updated\n");
  git("rm", "deleted.txt"); git("mv", "old.txt", "中文 新名字.txt");
  mkdirSync(join(cwd, "build"));
  const artifacts = Array.from({ length: 150 }, (_, i) => `build/module-${i}.o`);
  for (const path of artifacts) writeFileSync(join(cwd, path), path + "\n");
  git("add", "."); git("commit", "-qm", "feat: changes");
  const head = git("rev-parse", "HEAD");
  const paths = [...artifacts, "README.md", "deleted.txt", "中文 新名字.txt"];
  const files = await readDeliveryFiles(cwd, base, head, paths);
  assert.equal(files.length, 153);
  for (const path of artifacts) assert.deepEqual(files.find(file => file.path === path), { path, label: "新增" });
  assert.deepEqual(files.find(file => file.path === "中文 新名字.txt"), { path: "中文 新名字.txt", label: "重命名", previous: "old.txt" });
  assert.equal(files.find(file => file.path === "README.md")?.label, "修改");
  assert.equal(files.find(file => file.path === "deleted.txt")?.label, "删除");
  const text = deliveryFileList(files);
  for (const path of paths) assert.ok(text.includes(path.split("/").at(-1)!), path);
  assert.match(text, /153 个文件/);
  assert.doesNotMatch(text, /其余|省略|\.\.\.|…/);
  assert.equal(git("rev-parse", "HEAD"), head, "清单只读，不改写提交");
  const first = await pendingPushFiles(cwd, "feature", head, null, base);
  assert.deepEqual(first.files, files);
  assert.equal(first.comparison, "target_branch");
  assert.deepEqual((await pendingPushFiles(cwd, "feature", head, head, base)).files, [], "远端已是当前提交时增量为空");
  writeFileSync(join(cwd, "README.md"), "changed again\n");
  git("commit", "-qam", "feat: change same path again");
  const next = git("rev-parse", "HEAD");
  assert.deepEqual((await pendingPushFiles(cwd, "feature", next, head, base)).files,
    [{ path: "README.md", label: "修改" }], "按内容差异而非文件名集合相减，已交付的其他 152 个文件不重复列出");
  assert.equal((await pendingPushFiles(cwd, "feature", next, undefined, base)).files, undefined, "远端未知不能冒充首次全量推送");
  assert.equal((await pendingPushFiles(cwd, "feature", next, "c".repeat(40), base)).files, undefined, "旧对象丢失不能悄悄回退全量");
});

test("变更类型无法读取时仍列全路径，不伪造修改类型", async () => {
  const files = await readDeliveryFiles("/missing-preview-repo", "a".repeat(40), "b".repeat(40), ["a.ts", "build/output.o"]);
  assert.deepEqual(files, [{ path: "a.ts", label: "变更" }, { path: "build/output.o", label: "变更" }]);
  assert.match(deliveryFileList(files), /部分变更类型暂不可读/);
});
