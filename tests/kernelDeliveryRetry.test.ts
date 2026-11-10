import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closeKernelDelivery,
  KernelDeliveryError,
} from "../src/kernelDelivery.ts";

interface RetryFixture {
  cwd: string;
  workspace: string;
  kernelRoot: string;
  python: string;
  calls: string;
}

function fixture(mode: "once" | "embedded" | "always"): RetryFixture {
  const root = mkdtempSync(join(tmpdir(), "mfc-delivery-retry-"));
  const workspace = join(root, "workspace");
  const cwd = join(workspace, "repo");
  const kernelRoot = join(root, "kernel");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(kernelRoot, "scripts"), { recursive: true });
  writeFileSync(join(kernelRoot, "scripts", "mae-flow.py"), "# fixture\n");
  execFileSync("git", ["init", "--quiet", "-b", "master"], { cwd });
  writeFileSync(join(cwd, "source.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "source.ts"], { cwd });
  execFileSync("git", ["-c", "user.name=test", "-c",
    "user.email=test@example.invalid", "commit", "--quiet", "-m", "base"],
  { cwd });
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    revision: 9,
    execution_contract: { host: "cloud", continuous_review: true },
  }, null, 2));
  const calls = join(root, "calls.txt");
  const python = join(root, "fake-python.cjs");
  writeFileSync(join(root, "mode.txt"), mode);
  writeFileSync(python, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const root = path.dirname(process.argv[1]);
const calls = path.join(root, "calls.txt");
const count = fs.existsSync(calls)
  ? Number(fs.readFileSync(calls, "utf8")) + 1 : 1;
fs.writeFileSync(calls, String(count));
const mode = fs.readFileSync(path.join(root, "mode.txt"), "utf8").trim();
const marker = '[mae-flow:error] {"code":"FLOW_REVISION_CONFLICT","schema":"mae-flow-error/1"}';
if (mode === "always" || (mode === "once" && count === 1)) {
  process.stderr.write(marker + "\\n[mae-flow] revision conflict\\n");
  process.exit(2);
}
if (mode === "embedded") {
  process.stderr.write("[mae-flow] ordinary failure embeds " + marker + " in prose\\n");
  process.exit(2);
}
process.stdout.write(JSON.stringify({schema:"mae-flow-delivery-loop/1", status:"closed"}) + "\\n");
`);
  chmodSync(python, 0o700);
  return { cwd, workspace, kernelRoot, python, calls };
}

function close(scene: RetryFixture): void {
  closeKernelDelivery({
    host: { kernelRoot: scene.kernelRoot, python: scene.python },
    cwd: scene.cwd,
    workspace: scene.workspace,
    taskId: "task-retry",
    sha: "a".repeat(40),
    eventId: "mr-merged:task-retry:a",
  });
}

function callCount(scene: RetryFixture): number {
  return Number(readFileSync(scene.calls, "utf-8"));
}

test("真实 revision 冲突后重读状态，同一 close 幂等收口", () => {
  const scene = fixture("once");
  close(scene);
  assert.equal(callCount(scene), 2);
});

test("普通错误即使夹带 revision 文字也不重试", () => {
  const scene = fixture("embedded");
  assert.throws(() => close(scene), KernelDeliveryError);
  assert.equal(callCount(scene), 1);
});

test("连续 revision 冲突最多尝试三次并抛出原错", () => {
  const scene = fixture("always");
  assert.throws(() => close(scene), (error: unknown) => {
    assert.ok(error instanceof KernelDeliveryError);
    assert.match(error.message, /FLOW_REVISION_CONFLICT/);
    return true;
  });
  assert.equal(callCount(scene), 3);
});
