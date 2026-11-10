import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeTree,
  compactDirectory,
  displayDirectoryPaths,
  parseChanges,
} from "../web/src/gitDiffTree.ts";

function changed(paths: string[]) {
  return parseChanges([
    "## 未暂存",
    ...paths.flatMap((path) => [
      `diff --git a/${path} b/${path}`,
      "@@ -1 +1 @@",
      "-old",
      "+next",
    ]),
  ].join("\n"));
}

test("单链目录合成一级缩进，深层文件名不会被目录层级吃光", () => {
  const tree = changeTree(changed([
    "src/main/java/com/acme/FooService.java",
    "src/main/java/com/acme/BarService.java",
  ]));
  const compacted = compactDirectory(tree.directories[0]);

  assert.equal(compacted.label, "src/main/java/com/acme");
  assert.equal(compacted.directory.path, "src/main/java/com/acme");
  assert.deepEqual(compacted.directory.files.map((file) => file.path), [
    "src/main/java/com/acme/BarService.java",
    "src/main/java/com/acme/FooService.java",
  ]);
});

test("存在分叉时停止合并，main 与 test 仍是可分别折叠的目录", () => {
  const tree = changeTree(changed([
    "src/main/java/com/acme/FooService.java",
    "src/test/java/com/acme/FooServiceTest.java",
  ]));
  const compacted = compactDirectory(tree.directories[0]);

  assert.equal(compacted.label, "src");
  assert.deepEqual(compacted.directory.directories.map((item) => item.name), [
    "main",
    "test",
  ]);
  assert.deepEqual(displayDirectoryPaths(tree), [
    "src",
    "src/main/java/com/acme",
    "src/test/java/com/acme",
  ], "一键展开/折叠只操作界面真正显示的压缩目录行");
});

test("变更统计包含空白新增/删除行，但不把 +++/--- 文件头算进去", () => {
  const files = parseChanges([
    "## 已提交",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "-",
    "+next",
    "+",
  ].join("\n"));
  assert.equal(files[0].additions, 2);
  assert.equal(files[0].deletions, 2);
});

test("Git quoted UTF-8, spaces and rename headers retain their real paths", () => {
  const files = parseChanges([
    'diff --git "a/src/\\345\\221\\212\\350\\255\\246.cpp" "b/src/\\345\\221\\212\\350\\255\\246.cpp"',
    '@@ -1 +1 @@', '-before', '+after',
    'diff --git a/src/old name.cpp b/src/new name.cpp',
    'similarity index 100%', 'rename from src/old name.cpp', 'rename to src/new name.cpp',
  ].join('\n'));
  assert.deepEqual(files.map(file => file.path), ['src/告警.cpp', 'src/new name.cpp']);
  assert.equal(files[0].additions, 1);
});
