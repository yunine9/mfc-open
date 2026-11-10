/**
 * 多仓契约文件收集与注入(spec #131 / issue #132,2026-09-03):
 * 问题流会话 cwd 是工作区根,repo/<仓名>/ 下的 AGENTS.md 不在 SDK
 * 祖先发现链上,平台按 SDK 同款候选序逐仓收集,经 CloudSessionOptions
 * .repoContextFiles 并入系统提示词。这里钉两件事:
 * 1. 收集器纯函数的候选优先级/多仓/跳过/截断/fail-open 纪律;
 * 2. 注入真的到了模型系统提示词(种子工作区 → 重启恢复开驱动 →
 *    断言请求正文,不起新模型通路,与既有 issueFlow 测试同一形态)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { forceRm } from "./mfcTmp.ts";
import { isAbsolute, join } from "node:path";
import {
  CONTRACT_CANDIDATES,
  collectRepoContextFiles,
} from "../src/issueFlow/repoContextFiles.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "mfc-repo-contract-"));
}

function seedRepo(ws: string, name: string, files: Record<string, string>): void {
  mkdirSync(join(ws, "repo", name), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(ws, "repo", name, file), content);
  }
}

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("候选优先级与 SDK 逐字对齐:override 压 AGENTS.md 压 CLAUDE.md,大小写变体各算一条", () => {
  // AGENTS.md 与 CLAUDE.md 同仓在场:先到先得取 AGENTS.md(SDK 语义,
  // 平台不叠加——两份契约同时注入只会互相矛盾)。
  const both = workspace();
  try {
    seedRepo(both, "orders", {
      "AGENTS.md": "AGENTS-WINS\n",
      "CLAUDE.md": "CLAUDE-LOSES\n",
    });
    const files = collectRepoContextFiles(both);
    assert.equal(files.length, 1, "一仓只收一份契约");
    assert.match(files[0].path, /repo\/orders\/AGENTS\.md$/);
    assert.equal(files[0].content, "AGENTS-WINS\n");
  } finally {
    rmSync(both, { recursive: true, force: true });
  }

  // override 是仓主的临时说法,压过正式契约(与 SDK 同序)。
  const override = workspace();
  try {
    seedRepo(override, "pay", {
      "AGENTS.override.md": "OVERRIDE-WINS\n",
      "AGENTS.md": "AGENTS-LOSES\n",
    });
    assert.match(collectRepoContextFiles(override)[0].content,
      /OVERRIDE-WINS/, "AGENTS.override.md 必须压过 AGENTS.md");
  } finally {
    rmSync(override, { recursive: true, force: true });
  }

  // 大小写变体是独立候选(读 SDK dist 才确认的清单,不是想当然):
  // 只有大写形式在场也要收得到。
  const upper = workspace();
  try {
    seedRepo(upper, "legacy", { "AGENTS.MD": "UPPER-AGENTS\n" });
    seedRepo(upper, "claude", { "CLAUDE.MD": "UPPER-CLAUDE\n" });
    const files = collectRepoContextFiles(upper);
    assert.deepEqual(files.map((f) => f.content), [
      "UPPER-CLAUDE\n", "UPPER-AGENTS\n",
    ], "大小写变体各算候选;输出按仓名排序(claude < legacy)");
  } finally {
    rmSync(upper, { recursive: true, force: true });
  }
});

test("多仓各收一份,按仓名排序;无候选的仓、杂散文件、符号链接一律跳过", () => {
  const ws = workspace();
  try {
    seedRepo(ws, "beta", { "AGENTS.md": "BETA\n" });
    seedRepo(ws, "alpha", { "AGENTS.md": "ALPHA\n" });
    // 无任何候选文件的仓:照常跳过,不影响别的仓。
    seedRepo(ws, "bare", { "README.md": "没有契约\n" });
    // repo/ 下的杂散文件不是仓:跳过。
    writeFileSync(join(ws, "repo", "stray.txt"), "not a repo\n");
    // 指向目录的符号链接也不是仓(withFileTypes 走 lstat 语义):
    symlinkSync(join(ws, "repo", "alpha"), join(ws, "repo", "linked"), "dir");
    const files = collectRepoContextFiles(ws);
    assert.deepEqual(files.map((f) => f.content), ["ALPHA\n", "BETA\n"],
      "只收真仓;顺序按仓名,多仓注入顺序确定");
    assert.ok(files.every((f) => isAbsolute(f.path)
      && f.path.startsWith(join(ws, "repo"))), "返回仓内绝对路径");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("超 16K 字符截断:保前 16K 字符并追加平台尾注,路径不丢", () => {
  const ws = workspace();
  try {
    seedRepo(ws, "big", { "AGENTS.md": "长".repeat(16_500) });
    const [file] = collectRepoContextFiles(ws);
    assert.ok(file.content.startsWith("长".repeat(16_000)),
      "前 16K 字符原样保留");
    assert.match(file.content.slice(16_000),
      /^\n\n\[平台注:文件超 16K 字符已截断/, "尾注紧随其后");
    assert.ok(file.content.length < 16_500,
      "截断后必须短于原文,系统提示词不被单仓吃满");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("fail-open:没有 repo/ 目录返回空;候选名被目录占用不炸(注:readFileSync 失败分支未测——root 下 chmod 000 造不出来,见下)", () => {
  // 一仓未拉是常态:静默空数组,不是异常。
  const empty = workspace();
  try {
    assert.deepEqual(collectRepoContextFiles(empty), []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  // 候选名被目录占用(仓里怪布局):当没命中,该仓跳过,别仓照收。
  // (不用 chmod 000 造"读不动":测试身份若为 root 则 chmod 失效,
  // 断言会漂;目录占位走的是同一条 statSync().isFile() 拒绝路径。)
  const weird = workspace();
  try {
    seedRepo(weird, "good", { "AGENTS.md": "GOOD\n" });
    mkdirSync(join(weird, "repo", "odd", "AGENTS.md"), { recursive: true });
    const files = collectRepoContextFiles(weird);
    assert.deepEqual(files.map((f) => f.content), ["GOOD\n"],
      "目录占位候选不进提示词,也不许抛");
  } finally {
    rmSync(weird, { recursive: true, force: true });
  }
});

test("注入钉死:种子工作区带 repo 契约,重启恢复建会话时进模型系统提示词并留一行日志", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-repo-contract-e2e-"));
  // 裸远端带一份契约文件,再手动 clone 进种子工作区的 repo/orders/
  // ——等价于"上一轮会话已 pull_repo 落地,进程重启后重建上下文"。
  const seed = join(dataDir, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  writeFileSync(join(seed, "AGENTS.md"),
    "提交说明必须以 [ORDERS] 前缀开头(REPO-CONTRACT-MARKER-77)。\n");
  execFileSync("git", ["-C", seed, "add", "AGENTS.md"], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "init"],
    { env: GIT_ENV });
  const origin = join(dataDir, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });

  const issueRoot = join(dataDir, "issues", "issue-1");
  mkdirSync(join(issueRoot, "repo"), { recursive: true });
  execFileSync("git", ["clone", "-q", origin, join(issueRoot, "repo", "orders")],
    { env: GIT_ENV });
  // 种子可恢复会话(status=running → 重启恢复重新入队 → 现场无 driver
  // → openDriver 重建,收集发生在这次上下文构建)。
  writeFileSync(join(issueRoot, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
    title: "多仓契约注入", description: "", source: "manual",
    scenario: "no_ticket", round: 1,
    repo_url: origin, repo_urls: [origin],
    stage_states: ["done", "done", "done"],
    status: "running", stage: "analyze",
    stage_note: "正在核对日志时序", stage_at: "2026-09-03T00:00:00Z",
  }));

  const model = new ScriptedModelServer(
    [{ text: "仓契约已读,开始分析。" }], "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (message) => logs.push(message),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "恢复回合收口");

    const requestText = JSON.stringify(model.requests);
    assert.ok(requestText.includes("REPO-CONTRACT-MARKER-77"),
      "仓契约正文必须进模型请求(系统提示词),不是只躺在选项里");
    const contractLog = logs.find((line) => line.includes("注入仓契约"));
    assert.ok(contractLog, "注入了什么必须留一行日志对账");
    assert.match(contractLog!, /orders\/AGENTS\.md/,
      "日志只记 repo/ 下相对路径,不贴正文");
    assert.equal(logs.filter((line) => line.includes("注入仓契约")).length, 1,
      "一次上下文构建只留一行");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    forceRm(dataDir);
  }
});

test("注入钉死(反面):工作区没有 repo/,提示词与日志都不出现仓契约", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-repo-contract-empty-"));
  const issueRoot = join(dataDir, "issues", "issue-1");
  mkdirSync(issueRoot, { recursive: true });
  writeFileSync(join(issueRoot, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: "2026-09-03T00:00:00Z", updated_at: "2026-09-03T00:00:00Z",
    title: "还没有拉仓", description: "", source: "manual",
    scenario: "no_ticket", round: 1,
    stage_states: ["done", "done", "done"],
    status: "running", stage: "analyze",
    stage_note: "", stage_at: "2026-09-03T00:00:00Z",
  }));
  const model = new ScriptedModelServer(
    [{ text: "先做初步分析。" }], "scripted-v1", { linear: true });
  await model.start();
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    log: (message) => logs.push(message),
  });
  try {
    await until(() => {
      const issue = service.get("issue-1");
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "空工作区回合收口");
    assert.ok(!JSON.stringify(model.requests).includes("REPO-CONTRACT-MARKER"),
      "没有仓就没有契约注入");
    assert.equal(logs.filter((line) => line.includes("注入仓契约")).length, 0,
      "空收集不刷日志");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    forceRm(dataDir);
  }
});

test("守约:候选优先级清单与 SDK 逐字一致——SDK 升级漂移会在这里红", () => {
  // 收集器的候选序是照抄 pi 资源加载器的(候选取首个命中),但 SDK 没导出
  // 这个常量,只能对 dist 源码做字面断言:升级换序时这里先红,而不是
  // 线上某仓的 CLAUDE.md 悄悄压过 AGENTS.md。
  const sdkSource = readFileSync(
    new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.js",
      import.meta.url), "utf-8");
  const declared = sdkSource.match(
    /const candidates = \[([^\]]+)\]/)?.[1] ?? "";
  const sdkOrder = [...declared.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(sdkOrder.length >= 3, `SDK 候选清单解析失败: ${declared.slice(0, 80)}`);
  assert.deepEqual(sdkOrder.slice(0, CONTRACT_CANDIDATES.length),
    [...CONTRACT_CANDIDATES],
    "SDK 换了候选序——收集器必须跟着对齐,否则仓契约的命中语义漂移");
});
