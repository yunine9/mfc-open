/**
 * 没带 evidence 的逐条回执也必须过内核的载荷摘要核对。
 *
 * 2026-09-02 在做"内核不可用自愈"回归时顺手撞出来的生产级 bug:Cloud 的
 * canonical() 把 undefined 的键拼成 `"evidence":undefined` 去签摘要,而
 * 事实文件是 JSON.stringify 写的、没有这个键;内核重算摘要对不上,一律
 * "宿主凭据绑定的载荷摘要不匹配"拒收。流水线告警、工作台批注的回执
 * 不填证据是常态——这意味着这两种来源的反馈在生产里根本闭不了环:Agent
 * 被叫回来"补回执"再拒一次,最后 halted 停摆叫人。
 *
 * 真件:真内核真收据,回执里故意不带 evidence(以及一条带的),必须登记成功。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openKernelFeedback,
  recordKernelFeedbackResult,
  type KernelFeedbackBatch,
} from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const HOST = { kernelRoot: KERNEL_ROOT };
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "digest", GIT_AUTHOR_EMAIL: "digest@example.com",
  GIT_COMMITTER_NAME: "digest", GIT_COMMITTER_EMAIL: "digest@example.com",
};

test("回执条目不带 evidence(undefined 键)也能过内核载荷摘要,登记成功", () => {
  const data = mkdtempSync(join(tmpdir(), "mfc-digest-"));
  const taskId = "task-digest";
  const workspace = join(data, taskId);
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
  sealPipelineLifecycle({ cwd, workspace, taskId, kernelRoot: KERNEL_ROOT });
  const request: KernelFeedbackBatch = {
      schema: "mae-flow-feedback-batch/1",
      batch_id: "fb-digest", task_id: taskId, base_sha: head,
      opened_at: new Date().toISOString(),
      items: [
        { id: "pipe:1", source: "pipeline", source_id: "job-1", source_revision: 0,
          kind: "pipeline_red", summary: "UT 红了", verification: "pipeline" },
        { id: "pipe:2", source: "pipeline", source_id: "job-2", source_revision: 0,
          kind: "pipeline_red", summary: "CodeCheck 告警", verification: "pipeline" },
      ],
  };
  // A valid long source identity must remain intact through both commands.
  request.items[0].source_id = "job-" + "x".repeat(185);
  request.items[0].id = `pipeline:${request.items[0].source_id}:r0@${head}`;
  openKernelFeedback({ host: HOST, cwd, workspace, batch: request });
  const reopened = openKernelFeedback({ host: HOST, cwd, workspace,
    batch: { ...request, items: [...request.items].reverse() } });
  assert.equal(reopened.idempotent, true, "列表重排仍是同一批，不能重新派工");
  // 与 taskService.recordActiveFeedbackResult 拼出来的形状一致:没有证据
  // 的条目 evidence 字段是 undefined,不是缺省。
  const record = recordKernelFeedbackResult({
    host: HOST, cwd, workspace, taskId, batchId: "fb-digest", changed: false,
    results: [
      { id: request.items[0].id, status: "explained", summary: "环境问题，已说明", evidence: undefined },
      { id: "pipe:2", status: "explained", summary: "误报", evidence: "见 job 日志" },
    ],
  });
  assert.equal(record.schema, "mae-flow-delivery-loop/1");
  const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  const batch = state.delivery_loop.batches.find((item: any) => item.batch_id === "fb-digest");
  assert.ok(batch.result_digest, "内核已登记本批回执");
  assert.equal(batch.results.length, 2);
  const replayed = recordKernelFeedbackResult({ host: HOST, cwd, workspace, taskId,
    batchId: "fb-digest", changed: false, results: [
      { id: "pipe:2", status: "explained", summary: "误报", evidence: "见 job 日志" },
      { id: request.items[0].id, status: "explained", summary: "环境问题，已说明", evidence: undefined },
    ] });
  assert.equal(replayed.idempotent, true, "回执重排不能作废结果或生成新一轮");
  const after = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
  assert.deepEqual(after.delivery_loop, state.delivery_loop, "保留原记录、摘要与轮次");
});
