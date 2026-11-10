import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("CodeHub 报告与执行语义：CLI/MCP、并行 UT、指标合并", () => {
  const result = spawnSync("python3", ["tests/test_pipeline_quality.py"], {
    cwd: resolve(import.meta.dirname, ".."), encoding: "utf-8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 30_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
