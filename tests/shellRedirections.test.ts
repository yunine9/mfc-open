import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutShellRedirections } from "../src/shellRedirections.ts";

const normalized = (value: string) => withoutShellRedirections(value)
  .replace(/\s+/g, " ").trim();

test("重定向剥离保留管道与后续命令，不吞掉真正的参数", () => {
  assert.equal(normalized("rm -rf target 2>&1|head"), "rm -rf target |head");
  assert.equal(normalized("rm -rf target >'build log' src"), "rm -rf target src");
  assert.equal(normalized("rm -rf target2>log"), "rm -rf target2");
  assert.equal(normalized("rm -rf target 2 >log"), "rm -rf target 2");
  assert.equal(normalized("git 2>&1 -C . restore a"), "git -C . restore a");
  assert.equal(normalized("make &>>log&&ctest <input"), "make &&ctest");
});

test("引号内比较符号与转义操作符是参数，不能当重定向抹掉", () => {
  for (const command of [
    'test-runner --filter "a > b"', "test-runner --filter 'a < b'",
    'rm -rf target "2>"', "echo a\\>b",
  ]) assert.equal(withoutShellRedirections(command), command);
});

test("动态目标和不支持的 shell 语法保留原文供门禁保守处理", () => {
  for (const command of [
    "rm -rf $DIR 2>&1", "rm -rf target >$(echo log)",
    "rm -rf target >", "rm -rf target >'unclosed",
    "cat <<EOF\nrm -rf src\nEOF", "cat <(echo test)",
  ]) assert.equal(withoutShellRedirections(command), command);
});
