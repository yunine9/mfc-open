/**
 * 状态权威文件耐久写(票 #163):tmp→fsync→rename 的行为契约——内容
 * 正确、覆写生效、不留 .tmp 残留。fsync 本身是 syscall,不可观测,
 * 这里钉的是包装层的可观测行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { durableWriteFileSync } from "../src/durableWrite.ts";
import { mfcTemp } from "./mfcTmp.ts";

test("耐久写:内容正确、不留 tmp、覆写生效、mode 可选", () => {
  const root = mfcTemp("mfc-durable-write-");
  const path = join(root, "state.json");
  durableWriteFileSync(path, '{"a":1}');
  assert.equal(readFileSync(path, "utf-8"), '{"a":1}');
  assert.ok(!existsSync(path + ".tmp"), "tmp 已被 rename 消费");
  durableWriteFileSync(path, '{"a":2}', { mode: 0o600 });
  assert.equal(readFileSync(path, "utf-8"), '{"a":2}', "覆写生效");
  assert.ok(!existsSync(path + ".tmp"));
});
