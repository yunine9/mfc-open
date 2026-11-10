import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeGitQuotedPath, gitStatusPaths, recoverQuotedGitPaths } from "../src/gitPaths.ts";
import { normalizedDeliveryPaths } from "../src/pushReviewPolicy.ts";

test("Git 展示路径解码：八进制是 UTF-8 字节，不能按字符或简单去引号处理", () => {
  const quoted = '"docs/\\350\\275\\257\\344\\273\\266-design.md"';
  assert.equal(decodeGitQuotedPath(quoted), "docs/软件-design.md");
  assert.equal(decodeGitQuotedPath('"src/a\\"b.ts"'), 'src/a"b.ts');
  assert.equal(decodeGitQuotedPath('"src/a\\tb.ts"'), 'src/a\tb.ts');
  assert.equal(decodeGitQuotedPath('"src/invalid\\q.ts"'), '"src/invalid\\q.ts"');
});

test("旧清单只按 Git 事实恢复别名，真实引号名字、不存在路径和越界路径不能被猜改", () => {
  const path = "docs/软件-design.md";
  const quoted = '"docs/\\350\\275\\257\\344\\273\\266-design.md"';
  assert.deepEqual(normalizedDeliveryPaths([quoted], [path]), [path]);
  assert.deepEqual(normalizedDeliveryPaths([quoted.replace(/\\/g, "/")], [path]), [path]);
  assert.deepEqual(recoverQuotedGitPaths([JSON.stringify(path)], [path]), [path]);
  const actualQuoted = '"docs/real.ts"';
  assert.deepEqual(recoverQuotedGitPaths([actualQuoted], [actualQuoted, "docs/real.ts"]), [actualQuoted]);
  assert.deepEqual(recoverQuotedGitPaths(['"missing.ts"'], [path]), ['"missing.ts"']);
  assert.throws(() => normalizedDeliveryPaths(['"../secret"'], ["../secret"]), /不安全路径/);
});

test("porcelain -z 正确读取重命名目标，普通箭头、引号和中文均是原始路径", () => {
  assert.deepEqual(gitStatusPaths('R  src/新名.ts\0src/旧名.ts\0 M src/a -> b.ts\0?? src/a"b.ts\0'), [
    { x: "R", y: " ", path: "src/新名.ts" },
    { x: " ", y: "M", path: "src/a -> b.ts" },
    { x: "?", y: "?", path: 'src/a"b.ts' },
  ]);
});
