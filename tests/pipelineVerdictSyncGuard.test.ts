/**
 * 流水线登记失败必须如实挂起并重试，不能被反馈索引对账抢先掀翻。
 *
 * 2026-09-02 站在 origin/main 上实测:持续检视里每一轮改码修复都以
 * Agent 停在 external_verify、生命周期暂无收据背书结尾——正是随后的
 * pipeline record 重新封印。它若失败一次(30 秒预算、内核拒收),
 * pipelineVerdict 里无条件的 syncFeedbackStoreFromKernel 必然找不到匹配
 * 收据,被它自己的 catch 误诊成「持续检视索引损坏或不可写，已停止自动
 * 闭环」直接 stalled 通知人;而 schedulePipelineEvidenceRetry 看到
 * stalled 就退出。结果:一次瞬时抖动 = 停摆找人,重试预算形同虚设,
 * "如实标 verifying + 带预算重试"那条诚实分支永远跑不到。
 *
 * 真件:真内核铺好能力/绑定/收据,再让内核"死掉"复现登记失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "verdict-guard", GIT_AUTHOR_EMAIL: "vg@example.com",
  GIT_COMMITTER_NAME: "verdict-guard", GIT_COMMITTER_EMAIL: "vg@example.com",
};

async function until(probe: () => boolean, what: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 与生产同形:代码仓在任务 workspace 之内,内核停在 delivery_watch。 */
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
    current: "delivery_watch",
    revision: 3,
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

test("内核登记流水线失败时:如实挂起 + 安排重试,不被反馈索引对账抢先掀翻", async () => {
  const model = new ScriptedModelServer([{ text: "完成。" }]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-verdict-guard-")),
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("验证裁决兜底", { account: "worker" }).id;
  await until(() => service.get(id)?.status === "completed", "首轮会话收口");
  const internal = (service as any).tasks.get(id);
  try {
    const { cwd, head } = repositoryInside(internal.summary.workspace);
    internal.cwd = cwd;
    const kernelRoot = join(process.cwd(), "kernel");
    (service as any).options.host = {
      kernelRoot, python: "python3", continuousReview: true,
    };
    // 真内核铺好能力、绑定与一张 pipeline-record 收据。
    sealPipelineLifecycle({
      cwd, workspace: internal.summary.workspace, taskId: id, kernelRoot,
    });
    // 模拟一轮改码修复收尾:Agent 把内核推到 external_verify。此刻生命
    // 周期投影与任何既有收据都不再一致,只有下一次成功的 pipeline
    // record 才能重新封印——这是持续检视里每一轮的常态,不是异常。
    const statePath = join(cwd, ".mae-flow.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    state.current = "external_verify";
    state.revision = Number(state.revision ?? 0) + 1;
    writeFileSync(statePath, JSON.stringify(state));

    // 内核"死掉":这一次登记必然失败。兜底必须在它防御的故障下被测。
    (service as any).options.host = {
      kernelRoot: join(cwd, "kernel-not-exists"),
      python: "python3", continuousReview: true,
    };
    internal.summary.status = "verifying";
    internal.summary.delivery = {
      ...(internal.summary.delivery ?? {}),
      sha: head, pipeline: "success", mr_url: "http://mr.example/1",
    };

    await (service as any).pipelineVerdict(
      internal, head, "success", "", undefined, internal.controlEpoch);

    assert.equal(internal.summary.status, "verifying");
    assert.match(String(internal.summary.delivery?.waiting_on ?? ""),
      /等待流水线证据核销/,
      "登记失败必须写进 waiting_on,人在页面上看得见真实原因");
    assert.match(String(internal.summary.detail ?? ""), /等待流水线证据核销/);
    // 未修复时这里是「持续检视索引损坏或不可写，已停止自动闭环」:一次
    // 瞬时登记失败被误诊成索引损坏,直接 stalled 找人,而重试调度看到
    // stalled 就退出——重试预算形同虚设。
    assert.equal(internal.summary.delivery?.stalled, undefined,
      "瞬时的登记失败不是索引损坏,不许停摆");
    assert.doesNotMatch(String(internal.summary.delivery?.waiting_on ?? ""),
      /索引损坏/);
    assert.equal(internal.evidenceRetryActive, true,
      "登记失败要带预算重试,而不是一次抖动就停摆找人");
  } finally {
    await service.cancel(id, "tester").catch(() => undefined);
    await service.shutdown();
    await model.stop();
  }
});
