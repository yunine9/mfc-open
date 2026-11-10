import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  probeKernelCapabilities,
  requireContinuousReviewCapability,
} from "../src/kernelCapabilities.ts";

function fixture(payload: unknown, exitCode = 0): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-kernel-capability-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  const script = join(root, "scripts", "mae-flow.py");
  writeFileSync(script, [
    "#!/usr/bin/env node",
    `console.log(${JSON.stringify(JSON.stringify(payload))});`,
    `process.exit(${exitCode});`,
  ].join("\n"));
  chmodSync(script, 0o755);
  return root;
}

test("startup handshake accepts only the declared continuous-review capability", () => {
  const root = fixture({
    schema: "mae-flow-capabilities/1",
    capabilities: { continuous_review: true },
  });
  const result = probeKernelCapabilities({
    kernelRoot: root, python: process.execPath, cwd: root,
  });
  assert.equal(result.ready, true);
  assert.equal(result.continuous_review, true);
});

test("missing capability fails closed instead of silently using legacy lifecycle", () => {
  const root = fixture({
    schema: "mae-flow-capabilities/1", capabilities: {},
  });
  const result = probeKernelCapabilities({
    kernelRoot: root, python: process.execPath, cwd: root,
  });
  assert.equal(result.ready, false);
  assert.match(result.detail, /拒绝.*静默降级/);
  assert.throws(() => requireContinuousReviewCapability({
    kernelRoot: root, python: process.execPath, cwd: root,
  }), /需求流程拒绝启动/);
});

test("broken or non-zero capability probes are observable startup failures", () => {
  const root = fixture({ error: "old kernel" }, 2);
  const result = probeKernelCapabilities({
    kernelRoot: root, python: process.execPath, cwd: root,
  });
  assert.equal(result.ready, false);
  assert.match(result.detail, /能力探测失败/);
});
