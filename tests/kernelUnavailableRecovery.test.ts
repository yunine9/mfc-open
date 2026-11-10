/**
 * "内核暂时不可用"必须和"内核拒收/收据缺失"分开:前者挂起带预算自愈,
 * 后者才停下叫人。
 *
 * 2026-09-02 把收据核对收回内核 delivery attest 之后又核出来的一条:
 * syncFeedbackStoreFromKernel 自己内部 catch 一切异常并标成「持续检视
 * 索引损坏，需要你介入」——内核起不来三次也会被判成索引损坏,人被叫
 * 起来一次假警报;而 pipelineVerdict 里"对账失败只挂起重试"的兜底因此
 * 永远跑不到(死代码)。回执登记那条路更糟:一次内核抖动先烧一轮 Agent
 * 去"补回执",再 halted 停摆。
 *
 * 真件:包装脚本只在参数里出现 attest 时 kill -9 自己,其余命令交给真
 * python——内核"写得进、答不了",精确复现"登记成功但核对不可用"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { KERNEL_UNAVAILABLE, openKernelFeedback } from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const KERNEL_ROOT = join(process.cwd(), "kernel");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "unavailable", GIT_AUTHOR_EMAIL: "u@example.com",
  GIT_COMMITTER_NAME: "unavailable", GIT_COMMITTER_EMAIL: "u@example.com",
};

async function until(probe: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function repositoryInside(workspace: string): { cwd: string; head: string } {
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
  return { cwd, head };
}

/** 只在 `delivery attest` 时 kill -9 自己;写命令照常交给真 python。 */
function attestKiller(dir: string): { path: string; kills(): number } {
  const counter = join(dir, "attest-kills.txt");
  writeFileSync(counter, "0");
  const path = join(dir, "attest-killer.sh");
  writeFileSync(path, [
    "#!/bin/sh",
    'for a in "$@"; do',
    '  if [ "$a" = "attest" ]; then',
    `    n=$(cat "${counter}"); printf '%s' "$((n+1))" > "${counter}"; kill -KILL $$`,
    "  fi",
    "done",
    'exec python3 "$@"',
    "",
  ].join("\n"));
  chmodSync(path, 0o755);
  return { path, kills: () => Number(readFileSync(counter, "utf-8")) };
}

const readState = (cwd: string) =>
  JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));

async function serviceWithWatchingTask(label: string) {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), `mfc-unavail-${label}-`)),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create(`内核不可用自愈 ${label}`, { account: "worker" }).id;
  await until(() => service.get(id)?.status === "completed", "首轮会话收口");
  const internal = (service as any).tasks.get(id);
  const { cwd, head } = repositoryInside(internal.summary.workspace);
  internal.cwd = cwd;
  sealPipelineLifecycle({
    cwd, workspace: internal.summary.workspace, taskId: id, kernelRoot: KERNEL_ROOT,
  });
  const killer = attestKiller(internal.summary.workspace);
  const useHost = (python: string) => {
    (service as any).options.host = {
      kernelRoot: KERNEL_ROOT, python, continuousReview: true,
    };
  };
  const stop = async () => {
    await service.cancel(id, "tester").catch(() => undefined);
    await service.shutdown();
    await model.stop();
  };
  return { service, internal, id, cwd, head, killer, useHost, stop };
}

test("流水线登记成功但收据核对时内核不可用:挂起带预算重试,不是索引损坏停摆", async () => {
  const { service, internal, head, killer, useHost, stop } =
    await serviceWithWatchingTask("verdict");
  try {
    useHost(killer.path);
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      ...(internal.summary.delivery ?? {}),
      sha: head, pipeline: "success", mr_url: "http://mr.example/1",
    };
    await (service as any).pipelineVerdict(
      internal, head, "success", "", undefined, internal.controlEpoch);

    assert.ok(killer.kills() >= 3, `attest 该被打死满三次,实际 ${killer.kills()}`);
    assert.equal(internal.summary.status, "verifying");
    const waiting = String(internal.summary.delivery?.waiting_on ?? "");
    assert.match(waiting, /对账失败/);
    assert.match(waiting, /内核暂时不可用/);
    assert.doesNotMatch(waiting, /索引损坏/,
      "内核根本没答不是索引损坏——未修复时这里正是「持续检视索引损坏，需要你介入」");
    assert.equal(internal.summary.delivery?.stalled, undefined, "不许停摆叫人");
    assert.equal(internal.evidenceRetryActive, true, "要带预算重试");
  } finally {
    await stop();
  }
});

test("回执登记遇到内核不可用:不叫 Agent 补回执、不停摆,自愈时先补登记再交付", async () => {
  const { service, internal, id, cwd, head, killer, useHost, stop } =
    await serviceWithWatchingTask("receipt");
  try {
    useHost("python3");
    const batchId = "fb-unavail-1";
    openKernelFeedback({
      host: { kernelRoot: KERNEL_ROOT }, cwd, workspace: internal.summary.workspace,
      batch: {
        schema: "mae-flow-feedback-batch/1",
        batch_id: batchId, task_id: id, base_sha: head,
        opened_at: new Date().toISOString(),
        items: [{ id: "pipe:1", source: "pipeline", source_id: "job-1",
          source_revision: 0, kind: "pipeline_red", summary: "UT 红了",
          verification: "pipeline" }],
      },
    });
    assert.equal(readState(cwd).current, "feedback_triage");
    // 生产里批次经 taskService 打开时会同步登进 Cloud 反馈索引;这里直接
    // 走内核开批,用同一条"从内核权威批次重建索引"的路补齐。
    (service as any).syncFeedbackStoreFromKernel(internal);
    // Agent 已把逐条回执留在工作区文件里——材料齐全,只差登记。
    const digest = createHash("sha256").update(batchId).digest("hex").slice(0, 24);
    mkdirSync(join(internal.summary.workspace, "feedback"), { recursive: true });
    writeFileSync(join(internal.summary.workspace, "feedback", `result-${digest}.json`),
      JSON.stringify({
        schema: "mae-flow-feedback-results/1", batch_id: batchId,
        results: [{ id: "pipe:1", status: "explained", summary: "环境问题，已说明" }],
      }));

    useHost(killer.path);
    const failure = (service as any).recordActiveFeedbackResult(internal) as string;
    assert.ok(failure?.startsWith(KERNEL_UNAVAILABLE),
      `原因必须以「${KERNEL_UNAVAILABLE}」开头,实际:${failure}`);
    assert.doesNotMatch(failure, /可篡改状态/,
      "未修复时这里是「缺少 Cloud 宿主权威收据，已拒绝使用可篡改状态」");
    assert.equal(readState(cwd).delivery_loop.batches[0].result_digest, undefined);

    // 完成路径会 holdWithRecovery:模拟挂起后的自愈 tick,内核仍不可用。
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      ...(internal.summary.delivery ?? {}), waiting_on: failure, mr_state: "验证中",
    };
    const killsBefore = killer.kills();
    await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    assert.ok(killer.kills() > killsBefore, "自愈 tick 真的又去问了内核");
    assert.equal(internal.summary.status, "verifying");
    assert.match(String(internal.summary.delivery?.waiting_on ?? ""), /内核暂时不可用/);
    assert.equal(internal.summary.delivery?.stalled, undefined, "预算内不停摆");
    assert.equal(internal.deliveryRecoveryActive, true, "已排下一次自愈");
    assert.equal(readState(cwd).delivery_loop.batches[0].result_digest, undefined);

    // 内核恢复:同一份回执材料被补登记进内核,不需要 Agent 再来一轮。
    useHost("python3");
    internal.deliveryRecoveryActive = false;
    try {
      await (service as any).runDeliveryRecovery(internal, internal.controlEpoch);
    } catch { /* 之后的 tryDeliver 没有远端可推,不是本用例要证的 */ }
    const batch = readState(cwd).delivery_loop.batches[0];
    assert.ok(batch.result_digest,
      `回执已登记进内核;现场:${String(internal.summary.delivery?.waiting_on)}`);
    assert.equal(internal.summary.delivery?.stalled, undefined,
      "补登记成功后没有理由停摆");
    assert.equal(batch.results?.[0]?.status, "explained");
  } finally {
    await stop();
  }
});
