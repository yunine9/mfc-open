/**
 * delivery 宿主命令的基础设施故障必须带预算重试,而且每次换新凭据。
 *
 * 持续检视是"反馈不断进环、直到合入"的长跑。原来 invoke() 一次 spawnSync
 * 完事,起不来/超时/被信号打死和内核明确拒收混成同一个 throw,调用方
 * (流水线红灯、冲突、Build-Fix、push 返工)一律 markVerificationStalled:
 * 一次 30 秒抖动 = 整条环停下来找人。KernelHost 对 dispatch 早就是三次
 * 预算重试,delivery 命令不该是例外。
 *
 * 真件:把 host.python 指向一个包装脚本,前 N 次 kill -9 自己(真·进程
 * 死亡),之后 exec 真 python3;计数落在文件里,断言就是"到底叫了几次"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKernelFeedback, KernelDeliveryError } from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "infra-retry", GIT_AUTHOR_EMAIL: "ir@example.com",
  GIT_COMMITTER_NAME: "infra-retry", GIT_COMMITTER_EMAIL: "ir@example.com",
};

/** 生产同形:<data>/<task>/<repo>,内核停在 delivery_watch,收据链已铺好。 */
function watchingTask(label: string) {
  const data = mkdtempSync(join(tmpdir(), "mfc-infra-retry-"));
  const workspace = join(data, `task-${label}`);
  const cwd = join(workspace, "repo");
  mkdirSync(cwd, { recursive: true });
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8", env: GIT_ENV }).trim();
  git("init", "--quiet", "-b", "master");
  writeFileSync(join(cwd, "main.ts"), "export const ready = true;\n");
  git("add", "main.ts");
  git("commit", "--quiet", "-m", "baseline");
  const head = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "delivery_watch", revision: 3,
    execution_contract: {
      schema: "mae-flow-execution/1", host: "cloud",
      compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
      codecheck: "pipeline", git_push: "host",
      continuous_review: true, source: "order",
    },
    config: { "分支名": "feature", "基线分支": "master" },
    step_heads: { branch_create: head, delivery_watch: head },
    quality: { external_verification: { verdict: "PASS", sha: head } },
    history: [], initial_dirty: [],
  }));
  const taskId = `task-${label}`;
  sealPipelineLifecycle({ cwd, workspace, taskId, kernelRoot: KERNEL_ROOT });
  return { data, workspace, cwd, head, taskId };
}

/** 前 `deaths` 次调用 kill -9 自己,之后交给真 python3。 */
function flakyPython(dir: string, deaths: number): { path: string; calls(): number } {
  const counter = join(dir, "calls.txt");
  writeFileSync(counter, "0");
  const path = join(dir, "flaky-python.sh");
  writeFileSync(path, [
    "#!/bin/sh",
    `n=$(cat "${counter}")`,
    "n=$((n+1))",
    `printf '%s' "$n" > "${counter}"`,
    `if [ "$n" -le ${deaths} ]; then kill -KILL $$; fi`,
    'exec python3 "$@"',
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return { path, calls: () => Number(readFileSync(counter, "utf-8")) };
}

function batchFor(taskId: string, head: string, id: string) {
  return {
    schema: "mae-flow-feedback-batch/1" as const,
    batch_id: id, task_id: taskId, base_sha: head,
    opened_at: new Date().toISOString(),
    items: [{ id: "mr:d-1", source: "mr_discussion", source_id: "d-1",
      source_revision: 0, kind: "code_review", summary: "请补空值分支",
      verification: "reviewer" }],
  };
}

test("内核进程连死两次:第三次成功,反馈照常打开,凭据每次都是新的", () => {
  const { data, workspace, cwd, head, taskId } = watchingTask("flaky");
  const python = flakyPython(data, 2);
  const opened = openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT, python: python.path },
    cwd, workspace, batch: batchFor(taskId, head, "fb-flaky-1"),
  });
  assert.equal(opened.status, "repairing");
  assert.equal(python.calls(), 3, "两次基础设施故障 + 一次成功 = 三次调用");
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  assert.equal(state.current, "feedback_triage");
  // 死掉的两次凭据没有被内核消费;成功那次的 nonce 才在案。
  assert.equal(state.host_capability_nonces.length, 2,
    "seal 一次 + 成功打开一次;被打死的尝试不留 nonce");
});

test("三次都起不来:如实抛出并写明已重试,不无限等待", () => {
  const { data, workspace, cwd, head, taskId } = watchingTask("dead");
  const python = flakyPython(data, 99);
  assert.throws(() => openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT, python: python.path },
    cwd, workspace, batch: batchFor(taskId, head, "fb-dead-1"),
  }), (error: unknown) => error instanceof KernelDeliveryError
    && /已重试 3 次仍不可用/.test(error.message)
    && /信号 SIGKILL/.test(error.message));
  assert.equal(python.calls(), 3, "预算用尽就停,不是无限重试");
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  assert.equal(state.current, "delivery_watch", "内核状态一字未动");
});

test("内核明确拒收:一次都不重试,拒收原因原样透传", () => {
  const { data, workspace, cwd, head, taskId } = watchingTask("refused");
  const python = flakyPython(data, 0);
  assert.throws(() => openKernelFeedback({
    host: { kernelRoot: KERNEL_ROOT, python: python.path },
    cwd, workspace,
    // base_sha 与 HEAD 不符,内核会明确拒绝。
    batch: batchFor(taskId, "b".repeat(40), "fb-refused-1"),
  }), /base_sha/);
  assert.equal(python.calls(), 1, "内核答了就是裁决,不重试");
});
