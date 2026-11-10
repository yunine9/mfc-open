import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { openKernelFeedback } from "../src/kernelDelivery.ts";
import { queueTaskHostOperation, finishTaskHostOperation, recordTaskHostInstruction, TaskHostLedger } from "../src/taskHostTools.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import { deliveryChangeSnapshot } from "../src/artifacts.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { createMergeRequest } from "../src/mrClient.ts";
import { REVIEW_MISSION_END } from "../src/reviewHandoff.ts";
import { EventLog } from "../src/semanticEvents.ts";

const kernelRoot = join(process.cwd(), "kernel");
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" } }).trim();
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "push-baseline-"));
  const service: any = new TaskService({ dataDir: join(root, "data"), provider: "test",
    model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("推送前同步基准分支");
  t.after(async () => { await service.shutdown(); execFileSync("chmod", ["-R", "u+rwX", root]); rmSync(root, { recursive: true, force: true }); });
  const remote = join(root, "remote.git"), cwd = join(summary.workspace, "repo");
  git(root, "init", "--bare", "-q", remote);
  git(root, "init", "-q", "-b", "main", cwd);
  writeFileSync(join(cwd, "main.ts"), "export const value = 0;\n");
  git(cwd, "add", "main.ts"); git(cwd, "commit", "-qm", "base");
  git(cwd, "push", "-q", remote, "main");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-qb", "feature");
  const task = service.tasks.get(summary.id);
  task.cwd = cwd; task.summary.repo_url = remote; task.summary.baseline = "main";
  task.summary.status = "running"; task.summary.waiting = undefined;
  task.summary.delivery = { source_branch: "feature", target_branch: "main", sha: base };
  task.mission = "继续处理检视意见并保留逐条回复";
  service.removeFromQueue(task.summary.id);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({ current: "delivery_watch", revision: 3,
    execution_contract: { schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline",
      ut_write: "agent", ut_run: "pipeline", codecheck: "pipeline", git_push: "host", continuous_review: true, source: "order" },
    choices: { workflow: "完整开发" }, config: { "分支名": "feature", "基线分支": "main" },
    step_heads: { branch_create: base, delivery_watch: base },
    quality: { external_verification: { verdict: "PASS", sha: base } }, history: [], initial_dirty: [],
  }));
  sealPipelineLifecycle({ cwd, workspace: summary.workspace, taskId: summary.id, kernelRoot });
  service.options.host = { kernelRoot, python: "python3", continuousReview: true };
  const peer = join(root, "peer");
  git(root, "clone", "-q", "-b", "main", remote, peer);
  const upstream = (file: string, text: string) => {
    writeFileSync(join(peer, file), text); git(peer, "add", file);
    git(peer, "commit", "-qm", "upstream"); git(peer, "push", "-q", "origin", "main");
    return git(peer, "rev-parse", "HEAD");
  };
  const push = async (id: string) => {
    task.summary.status = "running";
    const host = service.taskHostRuntime(task);
    host.allowPush = async () => true; host.confirmPush = async () => true;
    await queueTaskHostOperation(host, id, { action: "push", reason: "推送当前修改" });
    await finishTaskHostOperation(host);
    return new TaskHostLedger(task.summary).read().operations.find(op => op.id === id)!;
  };
  return { root, cwd, remote, peer, service, task, base, upstream, push };
}

test("首次及再次 push 都包含最新基准分支；新 SHA 可登记到真实内核", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "feature");
  for (const round of [1, 2]) {
    const target = f.upstream(`upstream${round}.ts`, `export const round = ${round};\n`);
    const op = await f.push(`push-${round}`);
    assert.equal(op.state, "succeeded", op.result);
    const remoteHead = git(f.remote, "rev-parse", "feature");
    assert.equal(remoteHead, op.sha);
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, remoteHead), "");
    const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
    assert.equal(state.delivery_loop.published.sha, remoteHead);
    const manifests = new EventLog(f.service.eventLogPath(f.task.summary.id)).replay().filter(row => row.kind === "push_file_list");
    const manifest = manifests.at(-1)!.payload as any;
    assert.equal(manifest.head_sha, remoteHead);
    assert.deepEqual(manifest.files.map((file: any) => file.path), round === 1 ? ["feature.ts"] : ["upstream2.ts"],
      "首次只列目标分支之外的变化；再次合入上游时列出本次任务分支实际新增变化，不重复历史文件");
  }
});

test("宿主工具 push 同步后调用上传 CodeCheck，确认与推送使用修复后的提交", async t => {
  const f = fixture(t);
  const skillDir = join(f.service.options.dataDir, "skills", "codecheck-prepush");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: codecheck-prepush\ndescription: 推送前检查\nknowledge_nature: engineering\ntechnologies: [agnostic]\n---\n完成本次检查。\n");
  f.task.summary.host_skills_pinned = false;
  f.task.summary.ticket = "T559";
  f.service.options.commitConvention = "本部署使用 [T559][fix] 描述";
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "[T559][feat] feature");
  f.upstream("synced.ts", "export const upstream = true;\n");
  let calls = 0;
  f.service.options.codecheck = { runner: async (request: any) => {
    calls++;
    assert.equal(request.base, f.base);
    assert.match(request.prompt, /当前分支：feature/);
    assert.match(request.prompt, /本部署使用 \[T559\]\[fix\] 描述/);
    assert.ok(existsSync(join(request.repo, "synced.ts")), "先同步目标分支再检查");
    writeFileSync(join(request.repo, "checked.ts"), "export const checked = true;\n");
    git(request.repo, "add", "checked.ts"); git(request.repo, "commit", "-qm", "[T559][fix] checked");
    return "CodeCheck 通过";
  } };
  const host = f.service.taskHostRuntime(f.task);
  host.allowPush = async () => true;
  host.confirmPush = async (operation: any) => {
    assert.equal(calls, 1);
    assert.equal(operation.sha, git(f.cwd, "rev-parse", "HEAD"));
    assert.ok(existsSync(join(f.cwd, "checked.ts")), "确认前已完成检查修复");
    return true;
  };
  await queueTaskHostOperation(host, "checked-push", { action: "push", reason: "推送当前修改" });
  await finishTaskHostOperation(host);
  const operation = new TaskHostLedger(f.task.summary).read().operations.find(op => op.id === "checked-push")!;
  assert.equal(operation.state, "succeeded", operation.result);
  assert.equal(git(f.remote, "show", "feature:checked.ts"), "export const checked = true;");
  assert.equal(git(f.remote, "rev-parse", "feature"), operation.sha);
  assert.equal((await f.push("repeat-checked-push")).state, "succeeded");
  assert.equal(calls, 1, "同一提交重推不会重启检查");
});

test("每次真实 push 前留下增量清单：重复修改、删除、重命名和外来提交均按远端起点计算", async t => {
  const f = fixture(t);
  const manifests: any[] = [];
  const original = f.service.presentPushFileList.bind(f.service);
  f.service.presentPushFileList = (task: any, manifest: any) => {
    const remote = git(f.remote, "ls-remote", "--heads", f.remote, "refs/heads/feature").split(/\s+/)[0];
    if (remote) assert.equal(manifest.base_sha, remote, "在传输发生前核对远端实际起点");
    manifests.push(manifest); original(task, manifest);
  };
  for (const file of ["repeat.ts", "deleted.ts", "renamed.ts"]) writeFileSync(join(f.cwd, file), file + "\n");
  git(f.cwd, "add", "repeat.ts", "deleted.ts", "renamed.ts"); git(f.cwd, "commit", "-qm", "feat: initial delivery");
  assert.equal((await f.push("initial")).state, "succeeded");
  writeFileSync(join(f.cwd, "repeat.ts"), "modified again\n");
  git(f.cwd, "rm", "deleted.ts"); git(f.cwd, "mv", "renamed.ts", "renamed-new.ts");
  git(f.cwd, "add", "repeat.ts"); git(f.cwd, "commit", "-qm", "feat: repairs");
  assert.equal((await f.push("repairs")).state, "succeeded");
  assert.deepEqual(manifests.at(-1).files, [
    { path: "deleted.ts", label: "删除" }, { path: "renamed-new.ts", label: "重命名", previous: "renamed.ts" },
    { path: "repeat.ts", label: "修改" },
  ]);
  // 人已向任务分支提交的文件不再算作 Agent 本次待推送内容。
  git(f.peer, "fetch", "-q", "origin", "feature"); git(f.peer, "checkout", "-qb", "feature", "origin/feature");
  writeFileSync(join(f.peer, "human.ts"), "human code\n"); git(f.peer, "add", "human.ts"); git(f.peer, "commit", "-qm", "feat: human change"); git(f.peer, "push", "-q", "origin", "feature");
  writeFileSync(join(f.cwd, "repeat.ts"), "third change\n"); git(f.cwd, "commit", "-qam", "feat: third change");
  assert.equal((await f.push("after-human")).state, "succeeded");
  assert.deepEqual(manifests.at(-1).files, [{ path: "repeat.ts", label: "修改" }]);
  assert.equal(manifests.length, 3);
  const items = f.service.conversation(f.task.summary.id).items.filter((item: any) => item.kind === "push_file_list");
  assert.equal(items.length, 3, "自动推送和已确认推送也在与 Agent 协作中保留每轮完整清单");
});

test("#432 漏选后分批补齐 12→15→16→19 文件，同步和重启后均不删修复或重复确认", async t => {
  const f = fixture(t);
  let service = f.service, task = f.task;
  const initial = Array.from({ length: 12 }, (_, i) => `feature-${i}.ts`);
  const groups = [["MessageCode.xml", "OtherMessageCode.xml", "MsgCodeMgr.hpp"], ["CMakeLists.txt"], ["app_define.json", "ServiceImpl.cpp", "ControllerTest.cpp"]];
  for (const path of initial) writeFileSync(join(f.cwd, path), "initial change\n");
  git(f.cwd, "add", ...initial); git(f.cwd, "commit", "-qm", "feat: initial files");
  task.summary.push_confirmation = true;
  task.summary.delivery_selection = { status: "confirmed", paths: initial, excluded_paths: groups[0], observed_paths: [...initial, ...groups[0]],
    head: git(f.cwd, "rev-parse", "HEAD"), baseline: f.base, waiting_id: "reviewed-12", updated_at: new Date().toISOString() };
  const exclude = join(f.cwd, ".git/info/exclude");
  writeFileSync(exclude, "# user rules\n/user-notes.txt\n# mae-flow: local assets excluded from this delivery\n/.claude/\n" + groups[0].map(path => `/${path}`).join("\n") + "\n");
  service.registerAgentPlatformLocalExcludes(f.cwd);
  assert.ok(!readFileSync(exclude, "utf8").includes("/MsgCodeMgr.hpp"), "启动时清除旧清单留下的永久 ignore");
  assert.ok(readFileSync(exclude, "utf8").includes("/user-notes.txt"), "保留用户自己的规则");
  writeFileSync(join(f.cwd, "user-notes.txt"), "private local notes\n");
  let confirmations = 0;
  const delivered = [...initial];
  for (let i = 0; i < groups.length; i++) {
    service.notifyWaiting = () => { confirmations++; };
    for (const path of groups[i]) writeFileSync(join(f.cwd, path), `required repair ${i}\n`);
    git(f.cwd, "add", ...groups[i]); git(f.cwd, "commit", "-qm", `feat: required repair ${i}`);
    delivered.push(...groups[i]);
    f.upstream(`upstream-${i}.ts`, "upstream changes\n");
    task.summary.status = "running";
    const host = service.taskHostRuntime(task); host.allowPush = async () => true;
    await queueTaskHostOperation(host, `repair-${i}`, { action: "push", reason: "补齐需求实现与编译依赖" });
    await finishTaskHostOperation(host);
    const operation = new TaskHostLedger(task.summary).read().operations.find(op => op.id === `repair-${i}`)!;
    assert.equal(operation.state, "succeeded", operation.result);
    assert.equal(confirmations, 0);
    for (const path of delivered) assert.ok(git(f.remote, "show", `feature:${path}`).length, path);
    assert.equal(git(f.remote, "ls-tree", "--name-only", "feature", "--", "user-notes.txt"), "");
    const snapshot = (await deliveryChangeSnapshot(f.cwd))!;
    assert.equal((await service.deliveryContribution(task, snapshot)).paths.length, [15, 16, 19][i]);
    const manifest = new EventLog(service.eventLogPath(task.summary.id)).replay().filter(row => row.kind === "push_file_list").at(-1)!.payload as any;
    const expected = i === 0 ? delivered : [...groups[i], `upstream-${i}.ts`];
    assert.deepEqual(manifest.files.map((file: any) => file.path).sort(), [...expected].sort(),
      "重启后增量起点仍是远端已推送提交，不回退任务起点或旧勾选清单");
    assert.equal(await service.pushConfirmationSatisfied(task, "feature"), true, "自动交付入口复用同一确认");
    if (i === 0) {
      service.persist(task); await service.shutdown();
      service = new TaskService({ ...service.options, maxConcurrent: 0 });
      t.after(() => service.shutdown());
      assert.equal(service.recover().restored, 1);
      task = service.tasks.get(task.summary.id);
      service.removeFromQueue(task.summary.id);
    }
  }
});

test("旧的待调整清单不会自动开启审批，正常交付只发布已提交文件", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "needed.ts"), "required implementation\n");
  git(f.cwd, "add", "needed.ts"); git(f.cwd, "commit", "-qm", "feat: implementation");
  writeFileSync(join(f.cwd, "build.log"), "local build output\n");
  f.task.summary.delivery_selection = { status: "requested", paths: [], excluded_paths: ["needed.ts"],
    observed_paths: ["needed.ts"], head: f.base, baseline: f.base, waiting_id: "old-selection", updated_at: new Date().toISOString() };
  assert.equal(await f.service.pushConfirmationSatisfied(f.task, "feature"), true);
  const host = f.service.taskHostRuntime(f.task); host.allowPush = async () => true;
  await queueTaskHostOperation(host, "automatic", { action: "push", reason: "继续交付" });
  await finishTaskHostOperation(host);
  const op = new TaskHostLedger(f.task.summary).read().operations.find(op => op.id === "automatic")!;
  assert.equal(op.state, "succeeded", op.result);
  assert.equal(f.task.summary.waiting, undefined);
  assert.equal(git(f.remote, "show", "feature:needed.ts"), "required implementation");
  assert.equal(git(f.remote, "ls-tree", "--name-only", "feature", "build.log"), "");
  assert.equal(readFileSync(join(f.cwd, "build.log"), "utf8"), "local build output\n");
  // 旧 ignore 清理后产物重新出现在 status，也不能因此反复唤醒已推送的检视任务。
  f.task.mission = `MR 上有 1 条意见需要修复\n${REVIEW_MISSION_END}`;
  f.task.summary.delivery.mr_url = "https://example.test/mr/1";
  f.task.summary.delivery.loop = { kind: "review", review_source: "platform" };
  f.service.effectivePlatformUrl = () => "https://example.test";
  f.service.stageReviewReplies = async () => ({ ok: true });
  f.service.recordActiveFeedbackResult = () => undefined;
  f.service.atHostDeliveryWait = () => true;
  f.service.flushReviewReplyOutbox = async () => true;
  f.service.ensureMergeWatch = () => {};
  assert.equal(await host.finishReviewAfterPush(op), true);
  assert.equal(f.task.summary.status, "verifying");
  assert.equal(readFileSync(join(f.cwd, "build.log"), "utf8"), "local build output\n");
});

for (const status of ["confirmed", "requested"] as const) test(`旧会话恢复清单操作直接结束，不再改写 ${status} 历史记录或调用内核`, async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "feature.ts"), "feature\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "feat: feature");
  f.task.summary.delivery_selection = { status, paths: ["feature.ts"], excluded_paths: ["missed.ts"],
    observed_paths: ["feature.ts", "missed.ts"], head: git(f.cwd, "rev-parse", "HEAD"), baseline: f.base,
    waiting_id: "original-decision", confirmation_mode: "human", updated_at: new Date().toISOString() };
  const host = f.service.taskHostRuntime(f.task);
  const requestId = recordTaskHostInstruction(f.task.summary, "补回 missed.ts，修复需要的 dependency.ts 也一起提交");
  await queueTaskHostOperation(host, "legacy-restore", { action: "restore_delivery_paths",
    reason: "落实责任人最新意见", request_id: requestId, paths: ["missed.ts", "dependency.ts"] });
  for (const path of ["missed.ts", "dependency.ts"]) writeFileSync(join(f.cwd, path), "required repair\n");
  git(f.cwd, "add", "missed.ts", "dependency.ts"); git(f.cwd, "commit", "-qm", "feat: repair");
  await finishTaskHostOperation(host);
  const operation = new TaskHostLedger(f.task.summary).read().operations.find(op => op.id === "legacy-restore")!;
  assert.equal(operation.state, "succeeded", operation.result);
  assert.equal(f.task.summary.delivery_selection.status, status);
  assert.equal(f.task.summary.delivery_selection.waiting_id, "original-decision");
  assert.equal(f.task.summary.delivery_selection.confirmation_mode, "human");
  assert.deepEqual(f.task.summary.delivery_selection.excluded_paths, ["missed.ts"]);
  assert.deepEqual(f.task.summary.delivery_selection.paths, ["feature.ts"]);
  assert.equal(f.task.summary.waiting, undefined);
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.ok(!JSON.stringify(state).includes("dependency.ts"), "旧清单操作不再向内核写入文件限制");
});

test("旧已确认操作缺文件快照，排队后补齐代码仍沿用确认并记录实际发布 SHA", async t => {
  const f = fixture(t);
  f.task.summary.push_confirmation = true;
  const host = f.service.taskHostRuntime(f.task); host.allowPush = async () => true;
  await queueTaskHostOperation(host, "legacy-approved-push", { action: "push", reason: "继续已确认的推送" });
  const ledger = new TaskHostLedger(f.task.summary);
  ledger.update({ ...ledger.pending()!, push_confirmed: true });
  writeFileSync(join(f.cwd, "dependency.ts"), "necessary repair\n");
  git(f.cwd, "add", "dependency.ts"); git(f.cwd, "commit", "-qm", "feat: repair dependency");
  const head = git(f.cwd, "rev-parse", "HEAD");
  await finishTaskHostOperation(host);
  const operation = ledger.read().operations.find(op => op.id === "legacy-approved-push")!;
  assert.equal(operation.state, "succeeded", operation.result);
  assert.equal(f.task.summary.waiting, undefined);
  assert.equal(git(f.remote, "rev-parse", "feature"), head);
  assert.equal(f.task.summary.delivery.sha, head);
  assert.equal(f.task.summary.delivery_selection, undefined, "推送不再生成文件选择记录");
});

for (const continuous of [false, true]) test(`同步完成后远端${continuous ? "持续" : "再次"}推进：${continuous ? "三次后停下，不唤醒 Agent 空转" : "同一次宿主操作内重新同步推送"}`, async t => {
  const f = fixture(t);
  git(f.cwd, "push", "-q", f.remote, "feature");
  git(f.peer, "fetch", "-q", "origin", "feature"); git(f.peer, "checkout", "-qb", "feature", "origin/feature");
  writeFileSync(join(f.cwd, "mine.ts"), "my change\n");
  git(f.cwd, "add", "mine.ts"); git(f.cwd, "commit", "-qm", "feat: my change");
  const original = f.service.pushFromHostTransport.bind(f.service);
  let sends = 0, foreign = "";
  f.service.pushFromHostTransport = async (...args: unknown[]) => {
    sends++;
    if (continuous || sends === 1) {
      writeFileSync(join(f.peer, `peer-${sends}.ts`), "peer change\n");
      git(f.peer, "add", "."); git(f.peer, "commit", "-qm", "feat: peer change");
      git(f.peer, "push", "-q", "origin", "feature"); foreign = git(f.peer, "rev-parse", "HEAD");
    }
    return original(...args);
  };
  const operation = await f.push("racing-push");
  assert.equal(sends, continuous ? 3 : 2, operation.result);
  if (continuous) {
    assert.equal(operation.state, "failed"); assert.equal(f.task.summary.status, "failed");
    assert.match(operation.result!, /三次推送均被拒绝.*已停止自动重试/);
    assert.equal(f.service.queue.includes(f.task.summary.id), false);
    assert.equal(git(f.remote, "rev-parse", "feature"), foreign);
  } else {
    assert.equal(operation.state, "succeeded", operation.result);
    assert.equal(operation.push_receipt?.sha, operation.sha);
    assert.equal(git(f.remote, "rev-parse", "feature"), operation.sha);
    assert.equal(git(f.cwd, "merge-base", "--is-ancestor", foreign, operation.sha!), "");
    assert.equal(git(f.remote, "show", "feature:mine.ts"), "my change");
    assert.equal(git(f.remote, "show", "feature:peer-1.ts"), "peer change");
    const manifests = new EventLog(f.service.eventLogPath(f.task.summary.id)).replay().filter(row => row.kind === "push_file_list");
    const last = manifests.at(-1)!.payload as any;
    assert.equal(last.base_sha, foreign, "重试在同步后重新按新的远端起点计算");
    assert.deepEqual(last.files, [{ path: "mine.ts", label: "新增" }]);
  }
});

test("推送已成功、反查前远端又追加：确认祖先关系，不把成功误报成失败", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "mine.ts"), "my change\n");
  git(f.cwd, "add", "mine.ts"); git(f.cwd, "commit", "-qm", "feat: my change");
  const hook = join(f.remote, "hooks", "post-receive");
  writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  tree=$(git rev-parse "$new^{tree}")
  next=$(printf 'feat: concurrent follow-up\\n' | git -c user.name=peer -c user.email=peer@test commit-tree "$tree" -p "$new")
  git update-ref "$ref" "$next" "$new" || exit 1
done
`);
  chmodSync(hook, 0o755);
  const operation = await f.push("accepted-before-peer");
  assert.equal(operation.state, "succeeded", operation.result);
  const remote = git(f.remote, "rev-parse", "feature");
  assert.notEqual(remote, operation.sha, "反查看到的是外部追加后的提交");
  assert.equal(git(f.remote, "merge-base", "--is-ancestor", operation.sha!, remote), "");
  assert.equal(operation.push_receipt?.sha, git(f.cwd, "rev-parse", "HEAD"), "收据只能登记本次实际推送的 SHA");
});

test("自动交付入口遇到并发推送，也在宿主内同步重试且只触发最终 SHA 的流水线", async t => {
  const f = fixture(t);
  const platform = new FakeGitPlatform(); platform.barePath = f.remote; await platform.start();
  t.after(() => platform.stop());
  f.service.options.delivery = { platformUrl: platform.baseUrl, pollIntervalMs: 100_000, repairRounds: 0 };
  const content = "first=0\n" + "\n".repeat(12) + "last=0\n";
  writeFileSync(join(f.cwd, "main.ts"), content); git(f.cwd, "commit", "-qam", "feat: initial implementation");
  const published = git(f.cwd, "rev-parse", "HEAD");
  git(f.cwd, "push", "-q", f.remote, "feature");
  const mr = await createMergeRequest({ platformUrl: platform.baseUrl, repo: f.remote, sourceBranch: "feature", targetBranch: "main", title: "并发推送" });
  f.task.summary.delivery = { ...f.task.summary.delivery, mr_url: mr.url, mr_id: mr.id,
    git_push: { sha: published, ref: "refs/heads/feature", remote: "origin" }, sha: published };
  f.task.summary.status = "verifying"; f.task.mission = undefined;
  f.task.summary.push_confirmation = false;
  writeFileSync(join(f.cwd, "main.ts"), content.replace("first=0", "first=1")); git(f.cwd, "commit", "-qam", "feat: my change");
  f.task.summary.delivery_selection = { status: "confirmed", paths: ["main.ts"], observed_paths: ["main.ts"], excluded_paths: [],
    head: git(f.cwd, "rev-parse", "HEAD"), baseline: f.base, waiting_id: "approved", updated_at: new Date().toISOString() };
  git(f.peer, "fetch", "-q", "origin", "feature"); git(f.peer, "checkout", "-qb", "feature", "origin/feature");
  const original = f.service.pushFromHostTransport.bind(f.service); let sends = 0;
  f.service.pushFromHostTransport = async (...args: unknown[]) => {
    if (++sends === 1) {
      writeFileSync(join(f.peer, "main.ts"), content.replace("last=0", "last=1")); git(f.peer, "add", ".");
      git(f.peer, "commit", "-qm", "feat: peer change"); git(f.peer, "push", "-q", "origin", "feature");
    }
    return original(...args);
  };
  await f.service.tryDeliver(f.task, f.task.controlEpoch);
  assert.equal(sends, 2, JSON.stringify(f.task.summary));
  const sha = git(f.remote, "rev-parse", "feature");
  assert.equal(f.task.summary.delivery.git_push.sha, sha);
  assert.equal(platform.pipelines.length, 1, JSON.stringify(f.task.summary));
  assert.equal(platform.pipelines[0].sha, sha);
  const manifest = new EventLog(f.service.eventLogPath(f.task.summary.id)).replay().filter(row => row.kind === "push_file_list").at(-1)!.payload as any;
  assert.equal(manifest.head_sha, sha);
  assert.deepEqual(manifest.files, [{ path: "main.ts", label: "修改" }], "自动入口在最后一次真实推送前也生成清单");
  assert.equal(git(f.remote, "show", "feature:main.ts"), content.replace("first=0", "first=1").replace("last=0", "last=1").trim());
});

test("真实冲突先返回原检视会话；内核允许解决、提交和重新推送，不要求旧 SHA 许可", async t => {
  const f = fixture(t);
  openKernelFeedback({ host: { kernelRoot }, cwd: f.cwd, workspace: f.task.summary.workspace,
    batch: { schema: "mae-flow-feedback-batch/1", batch_id: "review", task_id: f.task.summary.id,
      base_sha: f.base, opened_at: new Date().toISOString(), items: [{ id: "review-1", source: "mr_discussion",
        source_id: "r1", source_revision: 0, kind: "code_review", summary: "修改返回值", verification: "reviewer" }] } });
  writeFileSync(join(f.cwd, "main.ts"), "export const value = 1;\n");
  git(f.cwd, "add", "main.ts"); git(f.cwd, "commit", "-qm", "review fix");
  const target = f.upstream("main.ts", "export const value = 2;\n");
  const failed = await f.push("conflicted-push");
  assert.equal(failed.state, "failed");
  assert.match(failed.result!, /真实合并冲突/);
  assert.equal(git(f.remote, "branch", "--list", "feature"), "");
  assert.match(f.task.mission, /继续处理检视意见/);
  assert.match(readFileSync(join(f.cwd, "main.ts"), "utf8"), /<<<<<<</);
  assert.ok(existsSync(join(f.cwd, ".git", "MERGE_HEAD")));
  const kernel = new KernelHost({ kernelRoot, workspace: f.cwd, taskId: f.task.summary.id,
    transcriptPath: join(f.task.summary.workspace, "transcript.jsonl") });
  for (const [name, input] of [["task_control", { action: "sync_branch", reason: "解决冲突" }],
    ["Edit", { file_path: join(f.cwd, "main.ts"), old_string: "", new_string: "" }],
    ["Bash", { command: "git add main.ts && git commit --no-edit" }]] as const) {
    const result = await kernel.preTool({ eventId: 1, taskId: f.task.summary.id, sessionId: "main", ts: "",
      kind: "tool_requested", payload: { call_id: `resolve-${name}`, name, input } });
    assert.notEqual(result?.action, "deny", JSON.stringify(result));
  }
  writeFileSync(join(f.cwd, "main.ts"), "export const value = 3;\n");
  git(f.cwd, "add", "main.ts"); git(f.cwd, "commit", "--no-edit", "-q");
  const pushed = await f.push("resolved-push");
  assert.equal(pushed.state, "succeeded", pushed.result);
  assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, pushed.sha!), "");
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.delivery_loop.active_batch_id, "review", "同步不能丢弃未完成检视批次");
  assert.equal(state.delivery_loop.published.sha, pushed.sha);
});

test("拉取基准分支失败时不推送，原目标保留供恢复", async t => {
  const f = fixture(t);
  f.task.summary.delivery.target_branch = "missing-target";
  const op = await f.push("missing-target");
  assert.equal(op.state, "failed");
  assert.match(op.result!, /fetch missing-target/);
  assert.equal(git(f.remote, "branch", "--list", "feature"), "");
  assert.match(f.task.mission, /继续处理检视意见/);
});

test("同步上游平台目录后仍可带本地编译产物推送，仅 HEAD 进入原 MR 分支", async t => {
  const f = fixture(t);
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "task source");
  const initial = git(f.cwd, "rev-parse", "HEAD");
  mkdirSync(join(f.peer, ".claude"));
  f.upstream(".claude/upstream.md", "upstream instructions\n");
  const target = f.upstream("toolType.dat", "baseline binary");
  await f.service.syncTargetBeforePush(f.task, "main", f.task.controlEpoch);
  writeFileSync(join(f.cwd, "toolType.dat"), "local build output");
  mkdirSync(join(f.cwd, "imap")); writeFileSync(join(f.cwd, "imap/output.o"), "object");
  f.task.summary.delivery_selection = { status: "confirmed", head: initial, baseline: f.base,
    paths: ["feature.ts"], observed_paths: ["feature.ts"], excluded_paths: [], waiting_id: "reviewed", updated_at: "now" };
  const head = git(f.cwd, "rev-parse", "HEAD");
  const op = await f.push("push-with-local-output");
  assert.equal(op.state, "succeeded", op.result);
  assert.equal(git(f.remote, "rev-parse", "feature"), head);
  assert.equal(git(f.remote, "show", "feature:toolType.dat"), "baseline binary");
  assert.equal(git(f.remote, "ls-tree", "--name-only", "feature", "imap"), "");
  assert.equal(git(f.cwd, "merge-base", "--is-ancestor", target, head), "");
  assert.equal(readFileSync(join(f.cwd, "toolType.dat"), "utf8"), "local build output");
  assert.deepEqual((await deliveryChangeSnapshot(f.cwd))!.committed_paths, ["feature.ts"]);
  const state = JSON.parse(readFileSync(join(f.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.delivery_loop.published.sha, head, "真实内核接受同步后的发布 SHA");
});

test("旧 delivery.sha 不阻止真实推送：一次人工确认覆盖后续同范围 CI 修复和排队后的重建提交", async t => {
  const f = fixture(t);
  f.task.summary.push_confirmation = true;
  let notifications = 0;
  f.service.notifyWaiting = () => { notifications++; };
  git(f.cwd, "push", "-q", f.remote, "feature");
  f.task.summary.delivery.git_push = { sha: f.base, ref: "refs/heads/feature", remote: "origin" };
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = 1;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "CI repair");
  const first = git(f.cwd, "rev-parse", "HEAD");
  const runtime = () => {
    f.task.summary.status = "running";
    const host = f.service.taskHostRuntime(f.task);
    host.allowPush = async () => true; // 仅省去 CodeHub HTTP；确认、同步和真实 Git 推送均不替换。
    return host;
  };
  const host = runtime();
  await queueTaskHostOperation(host, "confirmed-first", { action: "push", reason: "修复后推送" });
  await finishTaskHostOperation(host);
  assert.equal(f.task.summary.waiting?.step, "host_push_confirm");
  assert.equal(f.task.summary.delivery.sha, f.base, "未推送不得提前覆盖远端事实");
  const waiting = f.task.summary.waiting;
  assert.deepEqual(waiting.question.delivery_files, [{ path: "feature.ts", label: "新增" }]);
  assert.match(waiting.context, /feature\.ts.*\[新增\]/);
  await finishTaskHostOperation(runtime());
  assert.equal(f.task.summary.waiting.waiting_id, waiting.waiting_id, "恢复同一待办不另举卡");
  assert.equal(notifications, 1);
  const question = waiting.question.questions[0].question;
  // 真实人工入口；包含小鲁班备注，确认后宿主实际把对象传到 bare remote。
  f.service.existingMergeRequestAllowsDelivery = async () => true;
  await f.service.decide(f.task.summary.id, { state_version: waiting.state_version,
    selected_options: { [question]: "确认推送" }, notes: "小鲁班手机审批" });
  const deadline = Date.now() + 20000;
  while (new TaskHostLedger(f.task.summary).read().operations[0].state === "running") {
    if (Date.now() > deadline) throw new Error("确认后推送未完成");
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  const firstOp = new TaskHostLedger(f.task.summary).read().operations[0];
  assert.equal(firstOp.state, "succeeded", firstOp.result);
  assert.equal(git(f.remote, "rev-parse", "feature"), first);
  assert.equal(f.task.summary.delivery.sha, first);
  assert.equal(f.task.summary.delivery_selection, undefined, "确认只记录决定，不再创建文件清单");
  for (const round of [2, 3]) {
    writeFileSync(join(f.cwd, "feature.ts"), `export const feature = ${round};\n`);
    git(f.cwd, "commit", "-qam", "next CI repair");
    const nextHost = runtime();
    await queueTaskHostOperation(nextHost, `repair-${round}`, { action: "push", reason: "继续修复" });
    // 模拟排队后宿主重建 merge/提交说明；只变提交对象，不再当成授权失效。
    git(f.cwd, "commit", "--amend", "-qm", `compliant repair ${round}`);
    const head = git(f.cwd, "rev-parse", "HEAD");
    assert.notEqual(f.task.summary.delivery.sha, head);
    await finishTaskHostOperation(nextHost);
    const op = new TaskHostLedger(f.task.summary).read().operations.find(row => row.id === `repair-${round}`)!;
    assert.equal(op.state, "succeeded", op.result);
    assert.equal(op.sha, head);
    assert.equal(git(f.remote, "rev-parse", "feature"), head);
    assert.equal(f.task.summary.delivery.sha, head);
    assert.equal(f.task.summary.waiting, undefined);
  }
  assert.equal(notifications, 1, "不是每个新 SHA 再问一次");
});

test("确认跨入口复用，新增及漏选文件直接交付；明确先调整仍须处理", async t => {
  const f = fixture(t);
  f.task.summary.push_confirmation = true;
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "feature");
  f.task.summary.delivery_selection = { paths: ["feature.ts"], excluded_paths: [], observed_paths: ["feature.ts"],
    head: f.base, baseline: f.base, status: "confirmed", waiting_id: "prior-cloud-card", updated_at: new Date().toISOString() };
  let notifications = 0; f.service.notifyWaiting = () => notifications++;
  const run = async (id: string) => {
    f.task.summary.status = "running";
    const host = f.service.taskHostRuntime(f.task); host.allowPush = async () => true;
    await queueTaskHostOperation(host, id, { action: "push", reason: "推送修复" });
    await finishTaskHostOperation(host);
    return new TaskHostLedger(f.task.summary).read().operations.find(op => op.id === id)!;
  };
  assert.equal((await run("reuse-cloud")).state, "succeeded");
  assert.equal(notifications, 0);
  writeFileSync(join(f.cwd, "new.ts"), "new file\n");
  git(f.cwd, "add", "new.ts"); git(f.cwd, "commit", "-qm", "add new file");
  assert.equal((await run("scope-expanded")).state, "succeeded");
  assert.equal(notifications, 0, "新业务文件不重开文件范围确认");
  f.task.summary.delivery_selection.status = "requested";
  assert.equal((await run("explicit-adjustment")).state, "running");
  assert.equal(notifications, 1);
  let waiting = f.task.summary.waiting;
  await f.service.decide(f.task.summary.id, { state_version: waiting.state_version,
    selected_options: { [waiting.question.questions[0].question]: "先调整" }, notes: "保留原文件范围" });
  assert.equal(f.task.summary.delivery_selection.status, "requested");
  git(f.cwd, "rm", "-q", "new.ts"); git(f.cwd, "commit", "-qm", "adjust scope");
  assert.equal((await run("after-rework")).state, "running", "明确打回后即使文件面恢复也要确认");
  assert.equal(notifications, 2);
  waiting = f.task.summary.waiting;
  assert.equal(waiting.step, "host_push_confirm");
});

test("传输失败保留真实旧 SHA，重试沿用确认；切到其他分支不能发布", async t => {
  const f = fixture(t);
  f.task.summary.push_confirmation = true;
  writeFileSync(join(f.cwd, "feature.ts"), "export const feature = true;\n");
  git(f.cwd, "add", "feature.ts"); git(f.cwd, "commit", "-qm", "repair");
  const head = git(f.cwd, "rev-parse", "HEAD");
  f.task.summary.delivery_selection = { paths: ["feature.ts"], excluded_paths: [], observed_paths: ["feature.ts"],
    head: f.base, baseline: f.base, status: "confirmed", waiting_id: "confirmed", updated_at: new Date().toISOString() };
  let notifications = 0; f.service.notifyWaiting = () => notifications++;
  const runtime = () => {
    f.task.summary.status = "running";
    const host = f.service.taskHostRuntime(f.task); host.allowPush = async () => true;
    return host;
  };
  const failedHost = runtime();
  failedHost.push = async () => { throw new Error("simulated network failure"); };
  await queueTaskHostOperation(failedHost, "network-failed", { action: "push", reason: "修复" });
  await finishTaskHostOperation(failedHost);
  assert.equal(new TaskHostLedger(f.task.summary).read().operations[0].state, "failed");
  assert.equal(f.task.summary.delivery.sha, f.base);
  assert.equal(git(f.remote, "branch", "--list", "feature"), "");
  const retryHost = runtime();
  await queueTaskHostOperation(retryHost, "network-retry", { action: "push", reason: "重试" });
  await finishTaskHostOperation(retryHost);
  assert.equal(git(f.remote, "rev-parse", "feature"), head);
  assert.equal(f.task.summary.delivery.sha, head);
  assert.equal(notifications, 0);
  const switchedHost = runtime();
  await queueTaskHostOperation(switchedHost, "switched-branch", { action: "push", reason: "推送" });
  git(f.cwd, "checkout", "-qb", "other");
  await finishTaskHostOperation(switchedHost);
  const switched = new TaskHostLedger(f.task.summary).read().operations.find(op => op.id === "switched-branch")!;
  assert.equal(switched.state, "failed");
  assert.match(switched.result!, /工作分支已切换/);
  assert.equal(git(f.remote, "rev-parse", "feature"), head);
});

test("旧客户端携带勾选也不改变提交：推送既有 commit，不加入暂存或未跟踪文件", async t => {
  const f = fixture(t);
  f.task.summary.push_confirmation = true;
  writeFileSync(join(f.cwd, 'feature.ts'), 'export const feature = true;\n');
  writeFileSync(join(f.cwd, 'local.ts'), 'export const localOnly = true;\n');
  git(f.cwd, 'add', 'feature.ts', 'local.ts'); git(f.cwd, 'commit', '-qm', 'task changes');
  writeFileSync(join(f.cwd, 'selected-local.ts'), 'export const selectedLocal = true;\n');
  writeFileSync(join(f.cwd, 'unrelated.ts'), 'export const stagedOnly = true;\n');
  git(f.cwd, 'add', 'unrelated.ts');
  const host = f.service.taskHostRuntime(f.task);
  host.allowPush = async () => true;
  await queueTaskHostOperation(host, 'selected-push', { action: 'push', reason: '交付所选文件' });
  await finishTaskHostOperation(host);
  const waiting = f.task.summary.waiting;
  assert.equal(waiting.step, 'host_push_confirm');
  f.service.existingMergeRequestAllowsDelivery = async () => true;
  await f.service.decide(f.task.summary.id, {
    state_version: waiting.state_version, waiting_id: waiting.waiting_id,
    selected_options: { [waiting.question.questions[0].question]: '确认推送' },
    delivery_paths: ['feature.ts', 'selected-local.ts'], delivery_compile_action: 'skip',
  });
  const deadline = Date.now() + 20000;
  let op;
  do {
    op = new TaskHostLedger(f.task.summary).read().operations[0];
    if (op.state !== 'running' && op.state !== 'queued') break;
    if (Date.now() > deadline) throw new Error('所选范围推送超时');
    await new Promise(resolve => setTimeout(resolve, 30));
  } while (true);
  assert.equal(op.state, 'succeeded', op.result);
  assert.equal(git(f.remote, 'show', 'feature:local.ts'), 'export const localOnly = true;');
  assert.equal(git(f.remote, 'show', 'feature:feature.ts'), 'export const feature = true;');
  assert.equal(readFileSync(join(f.cwd, 'local.ts'), 'utf8'), 'export const localOnly = true;\n');
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'feature', 'unrelated.ts'), '');
  assert.equal(git(f.cwd, 'diff', '--cached', '--name-only'), 'unrelated.ts');
  assert.equal(git(f.remote, 'ls-tree', '--name-only', 'feature', 'selected-local.ts'), '', '即便旧请求勾选，平台也不替 Agent add 文件');
  assert.equal(f.task.summary.waiting, undefined);
  assert.equal(f.task.summary.delivery_selection, undefined);
  assert.deepEqual(op.push_paths, ['feature.ts', 'local.ts']);
});
