import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import { TaskService } from "../src/taskService.ts";
import type { PipelineCheck } from "../src/pipelineContract.ts";
import {
  listArtifactsAsync,
  PIPELINE_EVIDENCE_GAP_ARTIFACT,
  readArtifactAsync,
} from "../src/artifacts.ts";
import { JEST_LOG, issue28Artifacts } from "./pipelineSamples.ts";

async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function prepareFailedTask(
  service: any,
  checks: PipelineCheck[],
  account = "developer",
): { task: any; sha: string } {
  const created = service.create("修复流水线证据缺口", { account });
  service.options.host = LEGACY_TEST_HOST;
  const task = service.tasks.get(created.id);
  const cwd = mkdtempSync(join(tmpdir(), "mfc-evidence-repo-"));
  execFileSync("git", ["init", "--quiet", "-b", "master", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "Test"]);
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  execFileSync("git", ["-C", cwd, "add", "README.md"]);
  execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "baseline"]);
  const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  task.cwd = cwd;
  task.summary.status = "verifying";
  task.summary.delivery = {
    sha,
    pipeline: "failed",
    checks,
    mr_url: "https://codehub.example/mr/1",
  };
  service.persist(task);
  return { task, sha };
}

const LEGACY_TEST_HOST = {
  kernelRoot: join(process.cwd(), "kernel"),
  python: "python3",
  continuousReview: false,
};

test("全部红灯无具体证据时不派 Agent、不消耗修复轮次并通知人", async () => {
  const platform = new FakeGitPlatform();
  const luban = new FakeLubanServer();
  await platform.start();
  await luban.start();
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-missing-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
    notifier: new Notifier({ endpoint: luban.endpoint }),
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
      { dimension: "CODECHECK", status: "failed", tool: "CodeCheck" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.status, "verifying");
    assert.equal(task.summary.delivery.loop, undefined,
      "没有具体报错时不能凭空扣修复轮次");
    assert.equal(task.summary.delivery.evidence_gap.state, "waiting_human");
    assert.deepEqual(task.summary.delivery.evidence_gap.missing_dimensions,
      ["COMPILE", "CODECHECK"]);
    const gapMaterial = join(
      task.summary.workspace, "pipeline", "流水线证据缺口.md");
    assert.equal(existsSync(gapMaterial), true,
      "平台材料全空时也必须给人一个可批注的入口");
    assert.match(readFileSync(gapMaterial, "utf-8"), /编译\/构建、CodeCheck/);
    const visible = await listArtifactsAsync(undefined, {
      pipelineRoot: join(task.summary.workspace, "pipeline"),
    });
    assert.equal(visible[0]?.name, PIPELINE_EVIDENCE_GAP_ARTIFACT,
      "宿主生成材料必须真的出现在工作台材料接口，而不只是落盘");
    assert.match(String((await readArtifactAsync(undefined,
      PIPELINE_EVIDENCE_GAP_ARTIFACT, {
        pipelineRoot: join(task.summary.workspace, "pipeline"),
      }))?.content), /添加批注并点击“贴回报错”/);
    await until(() => luban.messages.length === 1, "证据缺口通知");
    assert.match(String(luban.messages[0].text), /编译\/构建、CodeCheck/);
    assert.match(String(luban.messages[0].text), /工作台.*批注/);
  } finally {
    await service.shutdown();
    await platform.stop();
    await luban.stop();
  }
});

test("部分维度有证据时只派可见问题，缺口并行求助", async () => {
  const platform = new FakeGitPlatform();
  const luban = new FakeLubanServer();
  platform.artifacts.push({
    name: "build_error_excerpt_compile.txt",
    text: "src/main.cpp:9: error: no matching function",
  });
  await platform.start();
  await luban.start();
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-partial-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
    notifier: new Notifier({ endpoint: luban.endpoint }),
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
      { dimension: "CODECHECK", status: "failed", tool: "CodeCheck" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.status, "queued");
    assert.equal(task.summary.delivery.loop.round, 1);
    assert.equal(task.summary.delivery.evidence_gap.state, "partial");
    assert.match(task.mission, /CodeCheck.*不许猜改/);
    assert.match(task.mission, /build_error_excerpt_compile\.txt/);
    await until(() => luban.messages.length === 1, "部分缺口通知");
  } finally {
    await service.shutdown();
    await platform.stop();
    await luban.stop();
  }
});

test("有限重试期间平台补出证据会自动恢复派发修复", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-retry-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: {
      platformUrl: platform.baseUrl,
      pollIntervalMs: 30,
      evidenceRetryMs: 30,
      pollTimeoutMs: 1_000,
    },
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.delivery.evidence_gap.state, "retrying");
    assert.equal(task.summary.delivery.loop, undefined);
    platform.artifacts.push({
      name: "build_error_excerpt_compile.txt",
      text: "src/main.cpp:9: fatal error: missing.hpp: No such file",
    });
    await until(() => task.summary.status === "queued", "证据恢复后自动派发修复");
    assert.equal(task.summary.delivery.loop.round, 1);
    assert.equal(task.summary.delivery.evidence_gap, undefined);
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});

test("工作台批注可回灌缺失报错并自动恢复同一 SHA", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-human-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "CODECHECK", status: "failed", tool: "CodeCheck" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    const note = service.addAnnotation(task.summary.id, {
      author: "developer",
      artifact: PIPELINE_EVIDENCE_GAP_ARTIFACT,
      file: "src/main.cpp",
      line: 42,
      anchor: "void oversizedFunction()",
      note: "平台原文：G.FUN.01-CPP，src/main.cpp:42，函数超过 80 行",
      kind: "code",
    });
    await service.sendAnnotations(task.summary.id, [note.id], "developer");
    await until(() => task.summary.status === "queued", "人工证据回灌后派发修复");
    assert.equal(task.summary.delivery.loop.round, 1);
    assert.match(task.mission, /人工从工作台贴回/);
    assert.match(task.mission, /G\.FUN\.01-CPP/);
    assert.equal(service.listAnnotations(task.summary.id).items[0].sent_via,
      "pipeline_evidence");
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});

test("部分证据会话先停下后，晚到人工证据可续同一修复轮", async () => {
  const platform = new FakeGitPlatform();
  platform.artifacts.push({
    name: "build_error_excerpt_compile.txt",
    text: "src/main.cpp:9: error: no matching function",
  });
  await platform.start();
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-late-human-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
      { dimension: "CODECHECK", status: "failed", tool: "CodeCheck" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    task.summary.status = "verifying";
    task.mission = undefined;
    task.summary.delivery.loop.state = "halted";
    const note = service.addAnnotation(task.summary.id, {
      author: "developer", artifact: "codecheck_detail.json",
      file: "src/main.cpp", line: 42, anchor: "oversizedFunction",
      note: "平台原文：src/main.cpp:42 命中 G.FUN.01-CPP，函数过长",
      kind: "code",
    });
    await service.sendAnnotations(task.summary.id, [note.id], "developer");
    await until(() => task.summary.status === "queued", "晚到证据续修");
    assert.equal(task.summary.delivery.loop.round, 1,
      "补齐原输入不是新失败轮次");
    assert.match(task.mission, /G\.FUN\.01-CPP/);
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});

test("服务重启后从同一 SHA 继续取证，不误走 prepush 或主任务", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-evidence-recover-"));
  const options = {
    dataDir,
    provider: "fixture",
    model: "fixture",
    modelsJson: {},
    maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
  };
  const before: any = new TaskService(options);
  let id = "";
  try {
    const { task, sha } = prepareFailedTask(before, [
      { dimension: "COMPILE", status: "failed", tool: "build2.0" },
    ]);
    id = task.summary.id;
    await before.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.delivery.evidence_gap.state, "waiting_human");
  } finally {
    await before.shutdown();
  }

  platform.artifacts.push({
    name: "build_error_excerpt_recovered.txt",
    text: "src/main.cpp:77: fatal error: recovered.hpp not found",
  });
  const after: any = new TaskService(options);
  try {
    after.options.host = LEGACY_TEST_HOST;
    assert.deepEqual(after.recover(), { restored: 1, requeued: 0 });
    await until(() => after.get(id)?.status === "queued",
      "重启后证据恢复并派发修复");
    assert.equal(after.get(id)?.delivery?.loop?.round, 1);
    assert.equal(after.get(id)?.detail.includes("prepush"), false);
  } finally {
    await after.shutdown();
    await platform.stop();
  }
});

test("UT 红灯+镜像日志有 Jest 失败原文→照常派发修复，无证据缺口", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  platform.artifacts.push({
    name: "build_log_ut-1.txt",
    text: JEST_LOG,
  });
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-ut-jest-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "UT", status: "failed", tool: "build2.0" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.status, "queued",
      "UT 维有可定位原文,照常派发修复");
    assert.equal(task.summary.delivery.loop.round, 1);
    assert.equal(task.summary.delivery.evidence_gap, undefined,
      "证据全有时不得生成证据缺口求助");
    assert.match(task.mission, /build_log_ut-1\.txt/,
      "修复使命点名镜像日志,让会话读原文定位");
    assert.doesNotMatch(task.mission, /证据缺口/);
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});

test("issue-28 形态：维度错配的质量门红灯从等人工变派发修复", async () => {
  const platform = new FakeGitPlatform();
  await platform.start();
  platform.artifacts.push(...issue28Artifacts());
  const service: any = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-evidence-issue28-")),
    provider: "fixture", model: "fixture", modelsJson: {}, maxConcurrent: 0,
    delivery: { platformUrl: platform.baseUrl, pollTimeoutMs: 0 },
  });
  try {
    const { task, sha } = prepareFailedTask(service, [
      { dimension: "CODECHECK", status: "failed", tool: "CodeCheck2.0" },
    ]);
    await service.dispatchCiRepair(task, sha, "", 2, task.controlEpoch);
    assert.equal(task.summary.status, "queued",
      "维度错配由跨维度兜底救回,自动派发修复");
    assert.equal(task.summary.delivery.loop.round, 1);
    assert.equal(task.summary.delivery.evidence_gap, undefined,
      "不再生成证据缺口求助");
    assert.match(task.mission, /维度归类错配的兜底采信/);
    assert.match(task.mission, /build_log_.*跨维度兜底/,
      "兜底来源带错配标注,修复会话按日志原文定位");
  } finally {
    await service.shutdown();
    await platform.stop();
  }
});
