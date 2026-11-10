/**
 * Git 交付判定(§10):Agent 只提交，宿主释放会话后推送并反查远端 SHA。
 * 三条路:host push → MR+流水线 → 等待合入;流水线红 → 验证中;
 * host push 失败 → 明说原因,不硬造 MR。用最小剧本驱动真实闭环。
 *
 * part 1/6:MR 交付闭环、STALE 重验、外来提交与宿主 Git 信任边界。
 * 共享夹具在 tests/delivery.helpers.ts;断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";
import {
  buildService,
  deliveryModel,
  git,
  makeSourceRepo,
  runTask,
  until,
} from "./delivery.helpers.ts";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** external_verify 是宿主等待点：模型在此结束回合后应立即交给流水线，
 * 不能被“流程没到 end”催办继续。 */
function externalWaitScript(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "echo change > a.txt" } } },
    { text: "已到宿主流水线等待点。" },
  ];
}

test("分支已推+流水线绿 → MR 等待合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  try {
    const { task } = await runTask(platform, true);
    assert.equal(task.status, "await_merge", JSON.stringify(task.delivery));
    assert.equal(task.delivery?.mr_state, "等待合入");
    assert.equal(task.delivery?.pipeline, "success");
    assert.match(task.delivery?.mr_url ?? "", /\/mr\/\d+$/);
    assert.equal(platform.mergeRequests.length, 1);
    assert.equal(platform.mergeRequests[0].target_branch, "master");
    assert.equal(task.delivery?.git_push?.sha, task.delivery?.sha,
      "宿主推送收据必须与流水线 SHA 一致");
    assert.equal(task.delivery?.git_push?.ref,
      "refs/heads/master_bot_REQ9");
    assert.equal(platform.branchSha("master_bot_REQ9"), task.delivery?.sha,
      "推送后必须以远端反查 SHA 为准");
    const facts = JSON.parse(readFileSync(
      join(task.workspace, "pipeline-facts.json"), "utf-8"));
    assert.deepEqual(facts.git_push, task.delivery?.git_push,
      "内核 facts 必须携带 host push receipt");
    // 单号以独立字段递到平台(--e2e-issues 的原料),不许只活在 title
    assert.equal(platform.mergeRequests[0].e2e_issues, "REQ9");
  } finally {
    await platform.stop();
  }
});

test("宿主 Git 边界:不执行 Agent hook,不信 origin/ext 改道", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const attacker = mkdtempSync(join(tmpdir(), "mfc-git-attacker-"));
  git(attacker, "init", "--quiet", "--bare");
  const evidence = mkdtempSync(join(tmpdir(), "mfc-git-boundary-"));
  const hookMarker = join(evidence, "pre-push-ran");
  const extMarker = join(evidence, "remote-ext-ran");
  const extHelper = join(evidence, "remote-ext.sh");
  writeFileSync(extHelper, [
    "#!/bin/sh",
    `printf compromised > ${shellQuote(extMarker)}`,
    "exit 1",
    "",
  ].join("\n"));
  chmodSync(extHelper, 0o700);
  const hostile: Scene[] = [
    { tool: { name: "bash", input: { command:
        "echo change > a.txt && "
        + "mkdir -p .git/hooks && "
        + `printf '#!/bin/sh\\nprintf compromised > %s\\nexit 1\\n' `
        + `${shellQuote(hookMarker)} > .git/hooks/pre-push && `
        + "chmod +x .git/hooks/pre-push && "
        // 两层改道同时落入 Agent 可写配置：origin 指向攻击仓，攻击仓
        // 又被 insteadOf 改写成 ext helper。宿主必须两层都不读取。
        + `git remote set-url origin ${shellQuote(attacker)} && `
        + "git config protocol.ext.allow always && "
        + `git config ${shellQuote(`url.ext::${extHelper}.insteadOf`)} `
        + `${shellQuote(attacker)}` } } },
    { text: "代码已提交，等待宿主交付。" },
  ];
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = new ScriptedModelServer(hostile, "scripted-v1", {
    beforeScene: managedFlowFixture(dataDir, {
      terminalStep: "external_verify", continuousReview: true,
    }),
  });
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson());
    const created = service.create("交付 REQ9:宿主 Git 信任边界",
      { ticket: "REQ9" });
    await until(() => service.get(created.id)!.status === "await_merge",
      "宿主绕过不可信 Git 配置后完成交付");
    const task = service.get(created.id)!;
    assert.equal(existsSync(hookMarker), false,
      "宿主 push 执行了 Agent 写入的 pre-push hook");
    assert.equal(existsSync(extMarker), false,
      "宿主传输读取了 Agent 写入的 protocol.ext/url.insteadOf 配置");
    assert.equal(git(attacker, "branch", "--list", "master_bot_REQ9"), "",
      "Agent 篡改的 origin 收到了宿主提交");
    assert.equal(
      git(platform.barePath, "rev-parse", "refs/heads/master_bot_REQ9"),
      task.delivery?.sha,
      "权威下单/部署仓没有收到绑定 SHA");
    assert.equal(task.delivery?.git_push?.url, platform.barePath,
      "交付收据没有记录权威仓地址");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("external_verify 是宿主等待点：不催办 Agent，直接触发并核销流水线", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = new ScriptedModelServer(externalWaitScript(), "scripted-v1", {
    beforeScene: managedFlowFixture(dataDir, {
      terminalStep: "external_verify", continuousReview: true,
    }),
  });
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson());
    const created = service.create("交付 REQ9:宿主等待点", { ticket: "REQ9" });
    await until(() => service.get(created.id)!.status === "await_merge",
      "宿主等待点触发流水线并通过内核核销");
    const task = service.get(created.id)!;
    assert.equal(platform.pipelines.length, 1);
    assert.match(task.delivery?.attested ?? "", /^PASS@/);
    assert.equal(task.delivery?.waiting_on, undefined);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

for (const oldStatus of ["success", "failed"] as const) test(`旧 SHA ${oldStatus} 但 HEAD 已变化 → 先 STALE，再由宿主推新 HEAD 自动再验`, async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(externalWaitScript(), dataDir,
    { terminalStep: "external_verify" });
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson(),
      { pollIntervalMs: 100 });
    const created = service.create("交付 REQ9:旧结果不背书新 HEAD",
      { ticket: "REQ9" });
    await until(() =>
      service.get(created.id)!.delivery?.pipeline === "running",
    "宿主已推送旧 SHA 并等待流水线");
    const before = service.get(created.id)!;
    const saved = JSON.parse(readFileSync(
      join(before.workspace, "task.json"), "utf-8"));
    const cwd = String(saved.cwd);
    writeFileSync(join(cwd, "local-only.txt"), "newer\n");
    git(cwd, "add", "local-only.txt");
    git(cwd, "commit", "--quiet", "-m", "fix: unpushed head");
    // 旧 SHA 先收敛成 success；宿主发现 STALE 后推新 HEAD，新 SHA
    // 必须触发自己的流水线，测试明确让第二条同步变绿。
    platform.nextPipelineStatus = "success";
    platform.finishPipeline(before.delivery!.sha!, oldStatus);
    await until(() => Boolean(service.get(created.id)!.delivery?.waiting_on),
      "内核拒绝旧 SHA");
    const task = service.get(created.id)!;
    assert.equal(task.status, "verifying");
    assert.match(task.delivery?.attested ?? "", /^STALE@/);
    assert.match(task.delivery?.waiting_on ?? "", /STALE|旧结果不背书/);
    const requestsAtStale = model.requests.length;
    await until(() => service.get(created.id)!.status === "await_merge",
      "STALE 后由宿主推送新 HEAD 并重验");
    assert.equal(platform.pipelines.length, 2,
      "新 HEAD 必须有自己绑定的新流水线");
    assert.equal(model.requests.length, requestsAtStale,
      "STALE 是宿主等待/重验，不得催 Agent 回来补证据");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

/** 人直接 clone 任务分支推一条提交:bot 分支上出现外来提交的唯一成因。 */
function humanCommit(bare: string, branch: string, subject: string): string {
  const clone = mkdtempSync(join(tmpdir(), "mfc-human-"));
  execFileSync("git", ["clone", "--quiet", "--branch", branch, bare, clone]);
  git(clone, "config", "user.email", "human@test");
  git(clone, "config", "user.name", "human");
  writeFileSync(join(clone, "hotfix.txt"), "human hotfix\n");
  git(clone, "add", ".");
  git(clone, "commit", "--quiet", "-m", subject);
  git(clone, "push", "--quiet", "origin", branch);
  return git(clone, "rev-parse", "HEAD");
}

// task-40 实锤:人往 bot 分支推了一条修复后,宿主拿同一个已验证 SHA 撞
// 远端 non-fast-forward 拒收,自愈预算原样重放刷了 110 次同一条失败。
// 外来提交只可能是人为介入(用户 2026-09-04 拍板"默认可信"):接上去继续,
// 不举卡、不问、更不能改写别人的提交。
test("分支上出现外来提交:宿主接上去继续推,不改写别人的提交", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.nextPipelineStatus = "running";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-"));
  const model = deliveryModel(externalWaitScript(), dataDir,
    { terminalStep: "external_verify" });
  await model.start();
  try {
    const service = buildService(platform, dataDir, model.modelsJson(),
      { pollIntervalMs: 100 });
    const created = service.create("交付 REQ9:分支上有人推了代码",
      { ticket: "REQ9" });
    await until(() =>
      service.get(created.id)!.delivery?.pipeline === "running",
    "宿主已推送第一版并等待流水线");
    const before = service.get(created.id)!;
    const branch = "master_bot_REQ9";
    const firstPush = before.delivery!.git_push!.sha;
    const human = humanCommit(platform.barePath, branch, "fix: 人工热修");
    // 本任务这边也在继续做事(修复轮的产物),两边都有新提交才是真现场。
    const cwd = String(JSON.parse(readFileSync(
      join(before.workspace, "task.json"), "utf-8")).cwd);
    writeFileSync(join(cwd, "local-only.txt"), "newer\n");
    git(cwd, "add", "local-only.txt");
    git(cwd, "commit", "--quiet", "-m", "fix: unpushed head");
    // 旧 SHA 收敛成 success 触发 STALE,宿主据此推新 HEAD——正是这一步
    // 从前撞在非快进上。
    platform.nextPipelineStatus = "success";
    platform.finishPipeline(before.delivery!.sha!, "success");

    await until(() => service.get(created.id)!.status === "await_merge",
      "接上外来提交后必须真的推成功");
    const task = service.get(created.id)!;
    assert.equal(platform.branchSha(branch), task.delivery?.sha,
      "远端分支头必须是宿主这次推上去的提交");
    assert.equal(git(platform.barePath, "merge-base", "--is-ancestor",
      human, branch) , "", "人推的提交必须仍在分支历史里");
    assert.equal(git(platform.barePath, "cat-file", "-p", `${human}:hotfix.txt`),
      "human hotfix", "别人的提交内容一个字节都不能被改写");
    assert.equal(git(platform.barePath, "merge-base", "--is-ancestor",
      firstPush, branch), "", "本任务第一次推的提交同样不该被抹掉");
    assert.equal(task.delivery?.foreign_commits?.count, 1);
    assert.equal(task.delivery?.foreign_commits?.base_sha, human);
    assert.match(task.delivery?.foreign_commits?.subjects[0] ?? "", /人工热修/);
    assert.equal(task.delivery?.stalled, undefined,
      "外来提交默认可信:不停摆、不举卡");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
