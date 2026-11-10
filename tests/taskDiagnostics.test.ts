/**
 * 问题定位诊断包:任务出事时把全部可定位事实汇成一个文件。
 *
 * 契约:
 * - 采集齐全:任务状态、内核现场、Git 事实(含定格基线祖先判定)、
 *   会话事件尾部、人审现场、服务日志切片——一个 markdown 全有;
 * - 不脱敏但**白名单采集**:.runtime 下的明文 git 令牌对定位零信息量
 *   且诊断包生来要被转发,靠"只收列出的路径"从结构上保证不入包;
 * - fail-soft:哪节读不到写一行原因,整包照出;
 * - 自动触发:任务进 failed / 交付停摆即落盘一份,同一事故只落一份。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectTaskDiagnostics, writeTaskDiagnostics,
} from "../src/taskDiagnostics.ts";
import { TaskService } from "../src/taskService.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args],
    { encoding: "utf-8" }).trim();
}

function makeSite() {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-diag-ws-"));
  const cwd = mkdtempSync(join(tmpdir(), "mfc-diag-cwd-"));
  git(cwd, "init", "--quiet", "-b", "master");
  git(cwd, "config", "user.name", "bot");
  git(cwd, "config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "baseline");
  const baseline = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "feature.ts"), "export const value = 1;\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "--quiet", "-m", "task result");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "build",
    step_heads: { branch_create: baseline },
  }));
  writeFileSync(join(cwd, ".mae-flow.json.quality-executions"),
    JSON.stringify({ executions: [{ kind: "COMPILE", succeeded: true }] }));
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: { id: "task-1", status: "verifying", detail: "演练现场" },
  }));
  writeFileSync(join(workspace, "events.jsonl"),
    Array.from({ length: 250 }, (_, index) =>
      JSON.stringify({ eventId: index + 1, kind: "tool_requested" }))
      .join("\n"));
  mkdirSync(join(workspace, "reviews"), { recursive: true });
  writeFileSync(join(workspace, "reviews", "local-annotations.json"),
    JSON.stringify({ annotations: [{ id: "an-1", note: "变量名再明确" }] }));
  return { workspace, cwd, baseline };
}

test("采集齐全:状态/内核/Git/基线判定/事件尾部/人审/服务日志一包全有", async () => {
  const { workspace, cwd, baseline } = makeSite();
  const bundle = await collectTaskDiagnostics({
    taskId: "task-1", workspace, cwd,
    reason: "演练", serviceLogTail: ["2026-08-31T00:00:00Z [task] 演练日志行"],
  });
  assert.match(bundle, /演练现场/, "task.json 全文入包");
  assert.match(bundle, /quality-executions/, "内核旁账入包");
  assert.match(bundle, /task result/, "git log 入包");
  assert.match(bundle,
    new RegExp(`定格基线 ${baseline.slice(0, 12)}[\\s\\S]*?是否仍为 HEAD 祖先`),
    "基线祖先判定入包");
  assert.match(bundle, /尾部 200\/250 行/, "事件流截尾并写明总行数");
  assert.match(bundle, /变量名再明确/, "人审批注入包");
  assert.match(bundle, /演练日志行/, "服务日志切片入包");
  assert.match(bundle, /transcript\.jsonl[\s\S]*?（不存在/,
    "缺席材料写明不存在,不静默消失");
});

test("基线脱离的现场:is-ancestor 非零退出码作为事实入包", async () => {
  const { workspace, cwd } = makeSite();
  const head = git(cwd, "rev-parse", "HEAD");
  const orphan = git(cwd, "commit-tree", `${head}^{tree}`, "-m", "rearranged");
  git(cwd, "reset", "--soft", orphan);
  const bundle = await collectTaskDiagnostics({
    taskId: "task-1", workspace, cwd,
  });
  assert.match(bundle, /是否仍为 HEAD 祖先[\s\S]*?exit=1/,
    "祖先关系断裂必须以退出码形式可见");
});

test("白名单采集:.runtime 下的明文令牌绝不入包(不脱敏≠什么都收)", async () => {
  const { workspace, cwd } = makeSite();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-diag-data-"));
  const runtime = join(dataDir, ".runtime", "host-git", "operation-1");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(join(runtime, "credential"),
    "https://user:SECRET_TOKEN_VALUE@git.example\n");
  writeFileSync(join(dataDir, "crash.log"), "crash line 1\n");
  const bundle = await collectTaskDiagnostics({
    taskId: "task-1", workspace, cwd, dataDir,
  });
  assert.doesNotMatch(bundle, /SECRET_TOKEN_VALUE/,
    "明文令牌文件对定位零信息量,结构上就不该被扫到");
  assert.match(bundle, /crash line 1/, "同目录的 crash.log 正常入包");
});

test("落盘去重:同一事故键只落一份;人工导出不受限", async () => {
  const { workspace, cwd } = makeSite();
  const first = await writeTaskDiagnostics({
    taskId: "task-1", workspace, cwd, dedupeKey: "failed:同一原因",
  });
  const second = await writeTaskDiagnostics({
    taskId: "task-1", workspace, cwd, dedupeKey: "failed:同一原因",
  });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(first.path, second.path, "同事故复用同一份留档");
  const files = readdirSync(join(workspace, "diagnostics"));
  assert.equal(files.length, 1);
});

test("自动触发:任务进 failed 即落诊断包,重复 persist 不刷屏", async () => {
  const model = new ScriptedModelServer([
    { text: "编码完成。" }, { text: "备用。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-diag-svc-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    recentLog: () => ["ring 里的一行"],
  });
  try {
    const id = service.create("诊断演练").id;
    const deadline = Date.now() + 20_000;
    while (service.get(id)?.status !== "completed") {
      if (Date.now() > deadline) throw new Error("首轮会话未收口");
      await new Promise((tick) => setTimeout(tick, 40));
    }
    const internal = (service as any).tasks.get(id);
    internal.summary.status = "failed";
    internal.summary.detail = "演练:容器起不来";
    (service as any).persist(internal);
    (service as any).persist(internal); // 同一事故第二次 persist
    const dir = join(internal.summary.workspace, "diagnostics");
    const waitUntil = Date.now() + 10_000;
    while (!existsSync(dir) || readdirSync(dir).length === 0) {
      if (Date.now() > waitUntil) throw new Error("自动诊断包未落盘");
      await new Promise((tick) => setTimeout(tick, 40));
    }
    // 旁路是异步的:等第二次 persist 的旁路也走完再数文件。
    await new Promise((tick) => setTimeout(tick, 300));
    const files = readdirSync(dir);
    assert.equal(files.length, 1, "同一事故只落一份");
    const bundle = readFileSync(join(dir, files[0]), "utf-8");
    assert.match(bundle, /容器起不来/, "触发原因写进包里");
    assert.match(bundle, /ring 里的一行/, "服务日志切片随包");

    // 人工导出:现采现回并另行留档,不受自动去重限制。
    const exported = await service.exportDiagnostics(id);
    assert.match(exported.content, /诊断包/);
    assert.ok(exported.path.includes("-manual"));
    assert.equal(readdirSync(dir).length, 2);
  } finally {
    await model.stop();
  }
});
