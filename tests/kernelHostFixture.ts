import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createKernelHostProof } from "../src/kernelDelivery.ts";

/**
 * Tests that start directly at delivery_watch must still establish that state
 * through the real host-authenticated pipeline command.  A handwritten state
 * file is Agent-writable and deliberately no longer counts as a predecessor.
 */
export function sealPipelineLifecycle(input: {
  cwd: string;
  workspace: string;
  taskId: string;
  kernelRoot: string;
}): void {
  const sha = execFileSync("git", ["-C", input.cwd, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  const facts = {
    sha,
    status: "success",
    source: "test-host-fixture",
    git_push: { sha, ref: "refs/heads/test", remote: "origin" },
  };
  mkdirSync(input.workspace, { recursive: true });
  const path = join(input.workspace, "pipeline-host-fixture.json");
  writeFileSync(path, JSON.stringify(facts));
  const proof = createKernelHostProof({
    cwd: input.cwd,
    workspace: input.workspace,
    taskId: input.taskId,
    action: "pipeline-record",
    payload: facts,
  });
  try {
    execFileSync("python3", [
      join(input.kernelRoot, "scripts", "mae-flow.py"),
      "pipeline", "record", "--file", path,
      "--host-proof", proof.path,
    ], { cwd: input.cwd, encoding: "utf-8" });
  } finally {
    proof.cleanup();
  }
}
