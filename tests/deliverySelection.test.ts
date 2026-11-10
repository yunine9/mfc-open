/** 历史文件勾选不限制后续修复；交付清单只读展示 Git 事实。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { TaskControlError, TaskService } from "../src/taskService.ts";
import { deliveryChangeSnapshot, readArtifact, DIFF_NAME } from "../src/artifacts.ts";
import { removeLegacyDeliveryExcludes } from "../src/agentPlatformPaths.ts";

test("旧清单 ignore 迁移只删除 Cloud 标记区的已知业务路径，保留用户与平台规则", () => {
  const manual = "# user rules\n/missed.ts\n/build/\n";
  const cloud = "# mae-flow: local assets excluded from this delivery\n/.claude/\n/missed.ts\n/retained.ts\n";
  const after = "# user additions\n/missed.ts\n/notes/\n";
  const migrated = removeLegacyDeliveryExcludes(manual + cloud + after, ["missed.ts"]);
  assert.equal(migrated, manual + cloud.replace("/missed.ts\n", "") + after);
  assert.equal(removeLegacyDeliveryExcludes(migrated, ["missed.ts"]), migrated);
});

async function until<T>(
  probe: () => T | undefined,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

function repository(options: { commitArtifact?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-delivery-selection-"));
  const git = (...args: string[]) => execFileSync(
    "git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  git("init", "--quiet", "-b", "master");
  git("config", "user.name", "bot");
  git("config", "user.email", "bot@test");
  writeFileSync(join(cwd, "README.md"), "baseline\n");
  git("add", "README.md");
  git("commit", "--quiet", "-m", "baseline");
  const baseline = git("rev-parse", "HEAD");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "feature.ts"), "export const value = 1;\n");
  mkdirSync(join(cwd, "target", "classes"), { recursive: true });
  writeFileSync(join(cwd, "target", "classes", "Feature.class"), "bytecode");
  git("add", "src/feature.ts");
  if (options.commitArtifact) git("add", "target/classes/Feature.class");
  git("commit", "--quiet", "-m", "task result");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  return { cwd, git };
}

function kernel(): string {
  const root = mkdtempSync(join(tmpdir(), "mfc-delivery-kernel-"));
  mkdirSync(join(root, "flow"));
  writeFileSync(join(root, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        choices: ["continue", "revise"],
        choice_answers: {
          continue: ["代码无需调整，继续提交"],
          revise: ["需要调整代码（按清单返工）"],
        },
        next: { continue: "commit", revise: "rework" },
      },
      commit: {},
      rework: { allow_source_edit: true },
    },
  }));
  return root;
}

async function waitingService(repo: ReturnType<typeof repository>) {
  const model = new ScriptedModelServer([
    { tool: { name: "AskUserQuestion", input: { questions: [{
      question: "这轮代码通过吗？",
      options: ["代码无需调整，继续提交", "需要调整代码（按清单返工）"],
      recommended: "代码无需调整，继续提交",
    }] } } },
    { text: "收到清单。" },
  ]);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-delivery-task-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const id = service.create("按文件确认交付").id;
  await until(() => service.get(id)?.status === "waiting_for_human"
    ? true : undefined, "任务等待代码检视");
  const internal = (service as any).tasks.get(id);
  internal.cwd = repo.cwd;
  const baseline = JSON.parse(readFileSync(join(repo.cwd, ".mae-flow.json"), "utf8")).step_heads.branch_create;
  repo.git("branch", "preview-base", baseline);
  internal.summary.repo_url = repo.cwd;
  internal.summary.delivery = { target_branch: "preview-base" };
  // 待办与通知保存面向人的本地化标题；宿主必须从 pulse 的稳定步骤 ID
  // 读取内核契约，不能拿中文标题去查 flow.json。
  internal.summary.waiting.step = "最终代码增量检视";
  mkdirSync(join(repo.cwd, ".mae-flow-work"), { recursive: true });
  writeFileSync(join(repo.cwd, ".mae-flow-work", "panel-pulse.js"),
    "window.__panelPulse={\"step\":\"inspect\",\"step_title\":\"最终代码增量检视\",\"phase\":\"交付\",\"revision\":1};\n");
  writeFileSync(join(repo.cwd, ".mae-flow-work", "panel.html"),
    '<span class="phase-node current">交付</span>');
  (service.options as any).host = { kernelRoot: kernel(), repoPath: "/unused" };
  return { service, model, id, internal };
}

test("普通内核检视卡不消费交付勾选；真正 push 前再生成当前清单", async () => {
  const repo = repository();
  const { service, model, id, internal } = await waitingService(repo);
  try {
    const waiting = service.get(id)!.waiting!;
    assert.equal(waiting.recommended_view, "diff");
    assert.equal(service.get(id)!.progress?.step_id, "inspect");
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "代码无需调整，继续提交" },
      delivery_paths: ["src/feature.ts"],
    });
    assert.equal(service.get(id)?.delivery_selection, undefined,
      "阅读普通检视卡不能提前授权或整理 push 清单");

    writeFileSync(join(repo.cwd, "src", "extra.ts"), "export const extra = 1;\n");
    repo.git("add", "src/extra.ts");
    repo.git("commit", "--quiet", "-m", "late unreviewed file");
    assert.equal(await (service as any).pushConfirmationSatisfied(
      internal, "master_bot_REQ1", true), false);
    assert.equal(service.get(id)?.status, "waiting_for_human",
      "确认后现场变化应回到最新检视卡，不能掉进 failed 死胡同");
    assert.equal(service.get(id)?.waiting?.step, "cloud_push_confirm");
    assert.match(service.get(id)?.detail ?? "", /等待确认推送/);
    assert.match(String(service.get(id)?.waiting?.context ?? ""), /extra\.ts.*\[新增\]/);
    assert.ok((service.get(id)?.waiting?.question as any)?.delivery_files
      .some((file: any) => file.path === "src/extra.ts" && file.label === "新增"));
  } finally {
    await model.stop();
  }
});

test("非 push 检视卡夹带 delivery_paths 也不能机械改写现场", async () => {
  const repo = repository({ commitArtifact: true });
  const { service, model, id, internal } = await waitingService(repo);
  try {
    // 基线里就有的文件被改过并已提交——剔除它时最容易被"直接回退"
    // 误伤,专门验内容保留。
    writeFileSync(join(repo.cwd, "README.md"), "baseline\nagent 补的注记\n");
    repo.git("add", "README.md");
    repo.git("commit", "--quiet", "-m", "agent touches readme");
    const before = repo.git("rev-parse", "HEAD");
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "代码无需调整，继续提交" },
      delivery_paths: ["src/feature.ts"],
    });
    const after = repo.git("rev-parse", "HEAD");
    assert.equal(service.get(id)?.delivery_selection, undefined);
    assert.equal(after, before, "普通检视决定不能悄悄新增整理提交");
    assert.notEqual(repo.git("ls-files", "--", "target/classes/Feature.class"), "",
      "普通检视卡不能把已提交文件移出交付树");
    assert.equal(readFileSync(join(repo.cwd, "README.md"), "utf-8"),
      "baseline\nagent 补的注记\n", "现场内容必须原样保留");
  } finally {
    await model.stop();
  }
});

test("普通检视选“需要调整”只回注返工，不夹带 push 清单契约", async () => {
  const repo = repository({ commitArtifact: true });
  const { service, model, id } = await waitingService(repo);
  try {
    const waiting = service.get(id)!.waiting!;
    await service.decide(id, {
      state_version: waiting.state_version,
      selected_options: { "这轮代码通过吗？": "需要调整代码（按清单返工）" },
      delivery_paths: ["src/feature.ts"],
    });
    assert.equal(service.get(id)?.delivery_selection, undefined);
    await until(() => model.requests.length >= 2 ? true : undefined,
      "交付清单进入 Agent 上下文");
    const requests = model.requests.map((request) => JSON.stringify(request)).join("\n");
    assert.doesNotMatch(requests, /mae-flow-delivery-selection\/1|只交付以下 1 个文件/);
    assert.match(requests, /需要调整代码/);
  } finally {
    await model.stop();
  }
});

// 分支上有人直接推了提交(宿主已接续)之后,机械重组的锚必须是远端已有
// 的那个提交。锚更老,一次 reset 就把人推上去的东西从交付树上抹掉——
// 而且悄无声息:被剔除的路径不在勾选清单里,重组不会把它加回去。
test("有外来提交时机械重组不越过它:人推的代码不会被 reset 抹掉", async () => {
  const repo = repository();
  const { service, model, id, internal } = await waitingService(repo);
  try {
    const pushed = repo.git("rev-parse", "HEAD");
    const baseline = repo.git("rev-parse", "HEAD^");
    internal.summary.delivery_selection = {
      paths: ["src/feature.ts"],
      observed_paths: ["src/feature.ts", "target/classes/Feature.class"],
      excluded_paths: ["target/classes/Feature.class"],
      status: "confirmed", waiting_id: "push-review", head: pushed, baseline,
      updated_at: new Date().toISOString(),
    };

    // 人直接往分支上推的提交,已由宿主接续进本地历史。
    writeFileSync(join(repo.cwd, "hotfix.txt"), "human hotfix\n");
    repo.git("add", "hotfix.txt");
    repo.git("commit", "--quiet", "-m", "fix: 人工热修");
    const foreign = repo.git("rev-parse", "HEAD");
    internal.summary.delivery = {
      git_push: { sha: pushed, ref: "refs/heads/master_bot_REQ1",
        remote: "origin" },
      foreign_commits: { base_sha: foreign, absorbed_at: new Date().toISOString(),
        count: 1, subjects: [`${foreign.slice(0, 7)} fix: 人工热修`] },
    };

    // 之后的修复又把已排除的编译产物带回了提交:这正是机械重组的触发点。
    repo.git("add", "-f", "target/classes/Feature.class");
    repo.git("commit", "--quiet", "-m", "fix: 修复顺手带回产物");

    const outcome = await (service as any)
      .reconcileDeliveryPlatformBoundary(internal);

    assert.equal(outcome, "unchanged");
    assert.equal(repo.git("ls-files", "--", "target/classes/Feature.class"), "target/classes/Feature.class",
      "历史勾选不再自动撤销本轮有意提交的文件");
    assert.equal(repo.git("merge-base", "--is-ancestor", foreign, "HEAD"), "",
      "人推的提交必须仍是 HEAD 的祖先");
    assert.equal(repo.git("show", "HEAD:hotfix.txt"), "human hotfix",
      "人推的内容一个字节都不能丢");
  } finally {
    await model.stop();
  }
});


test("首次推送不能把含排除文件和平台目录历史的检视 HEAD 当作干净整理起点", async () => {
  const repo = repository({ commitArtifact: true });
  const { service, model, internal } = await waitingService(repo);
  try {
    const baseline = repo.git("rev-parse", "HEAD^");
    mkdirSync(join(repo.cwd, ".claude"));
    writeFileSync(join(repo.cwd, ".claude", "injected.md"), "local-only skill");
    repo.git("add", "-f", ".claude/injected.md");
    repo.git("commit", "--quiet", "-m", "accidental platform files");
    repo.git("rm", "-q", ".claude/injected.md");
    repo.git("commit", "--quiet", "-m", "remove platform files from tree");
    const reviewed = repo.git("rev-parse", "HEAD");
    internal.summary.delivery_selection = {
      paths: ["src/feature.ts"], excluded_paths: ["target/classes/Feature.class"],
      observed_paths: ["src/feature.ts", "target/classes/Feature.class"],
      status: "confirmed", waiting_id: "first-push", head: reviewed, baseline,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(join(repo.cwd, "src/feature.ts"), "export const value = 2;\n");
    repo.git("add", "src/feature.ts");
    repo.git("commit", "--quiet", "-m", "review repair after confirmation");
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "changed");
    assert.equal(repo.git("diff", "--name-only", baseline, "HEAD"), "src/feature.ts\ntarget/classes/Feature.class");
    assert.equal(repo.git("show", "HEAD:src/feature.ts"), "export const value = 2;");
    assert.equal(repo.git("log", "--format=", "--name-only", `${baseline}..HEAD`, "--", ".claude"), "",
      "先提交后删除的平台文件也不应随历史推送");
    assert.equal(readFileSync(join(repo.cwd, "target/classes/Feature.class"), "utf8"), "bytecode");
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "unchanged",
      "重试不重复整理或再生一道门禁");
  } finally {
    await service.shutdown(); await model.stop();
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("合入 master 的排除路径和平台目录不算本任务新增，脏文件不触发整理失败", async () => {
  const repo = repository();
  const { service, model, internal } = await waitingService(repo);
  try {
    const pushed = repo.git("rev-parse", "HEAD"), baseline = repo.git("rev-parse", "HEAD^");
    repo.git("checkout", "-qb", "feature");
    repo.git("checkout", "-q", "master");
    repo.git("reset", "--hard", baseline);
    mkdirSync(join(repo.cwd, ".claude"));
    writeFileSync(join(repo.cwd, ".claude", "upstream.md"), "upstream skill\n");
    writeFileSync(join(repo.cwd, "upstream.txt"), "master change\n");
    writeFileSync(join(repo.cwd, "toolType.dat"), "original binary");
    repo.git("add", ".claude/upstream.md", "upstream.txt", "toolType.dat");
    repo.git("commit", "-qm", "upstream additions");
    const upstream = repo.git("rev-parse", "HEAD");
    repo.git("update-ref", "refs/remotes/origin/master", upstream);
    repo.git("checkout", "-q", "feature"); repo.git("merge", "--no-edit", "master");
    writeFileSync(join(repo.cwd, ".mae-flow.json"), JSON.stringify({
      config: { 基线分支: "master", 分支名: "feature" }, step_heads: { branch_create: baseline },
    }));
    writeFileSync(join(repo.cwd, "toolType.dat"), "generated binary");
    mkdirSync(join(repo.cwd, "imap")); writeFileSync(join(repo.cwd, "imap", "output.o"), "generated");
    internal.summary.delivery = { target_branch: "master", git_push: { sha: pushed, ref: "refs/heads/feature", remote: "origin" } };
    internal.summary.delivery_selection = { status: "confirmed", paths: ["src/feature.ts"],
      excluded_paths: ["upstream.txt"], observed_paths: ["src/feature.ts"], head: pushed, baseline, waiting_id: "old", updated_at: "now" };
    const head = repo.git("rev-parse", "HEAD");
    const snapshot = (await deliveryChangeSnapshot(repo.cwd))!;
    assert.deepEqual(snapshot.committed_paths, ["src/feature.ts"]);
    assert.deepEqual(snapshot.added_agent_platform_paths, []);
    assert.ok(!snapshot.workspace_paths.includes("upstream.txt"));
    assert.match(readArtifact(repo.cwd, DIFF_NAME)!.content, /generated binary/);
    assert.doesNotMatch(readArtifact(repo.cwd, DIFF_NAME)!.content, /master change|upstream skill/);
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "unchanged");
    assert.equal(await (service as any).agentPlatformChangesAllowPush(internal), true);
    const review = await (service as any).buildPushReviewPresentation(internal, snapshot, false);
    assert.equal(review.base_sha, upstream, "上轮 push 到 merge HEAD 的差异不能冒充本轮任务增量");
    assert.equal(review.file_count, 1);
    assert.equal(repo.git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(repo.cwd, "imap/output.o"), "utf8"), "generated");
  } finally { await service.shutdown(); await model.stop(); rmSync(repo.cwd, { recursive: true, force: true }); }
});

test("平台目录整理只用提交树，历史未选文件与业务暂存、未暂存均不丢失", async () => {
  const repo = repository();
  const { service, model, internal } = await waitingService(repo);
  try {
    const pushed = repo.git("rev-parse", "HEAD"), baseline = repo.git("rev-parse", "HEAD^");
    internal.summary.delivery = { git_push: { sha: pushed, ref: "refs/heads/feature", remote: "origin" } };
    internal.summary.delivery_selection = { status: "confirmed", paths: ["src/feature.ts"],
      excluded_paths: ["target/classes/Feature.class"], observed_paths: ["src/feature.ts"], head: pushed, baseline, waiting_id: "old", updated_at: "now" };
    writeFileSync(join(repo.cwd, "src/feature.ts"), "export const value = 2;\n");
    repo.git("add", "src/feature.ts", "target/classes/Feature.class"); repo.git("commit", "-qm", "repair and unwanted output");
    mkdirSync(join(repo.cwd, ".claude"));
    writeFileSync(join(repo.cwd, ".claude", "injected.md"), "platform only");
    repo.git("add", "-f", ".claude/injected.md"); repo.git("commit", "-qm", "accidental platform file");
    writeFileSync(join(repo.cwd, "README.md"), "staged intent\n"); repo.git("add", "README.md");
    writeFileSync(join(repo.cwd, "README.md"), "unstaged intent\n");
    writeFileSync(join(repo.cwd, "src/feature.ts"), "uncommitted source\n");
    writeFileSync(join(repo.cwd, "user-new.ts"), "new staged source\n"); repo.git("add", "user-new.ts");
    mkdirSync(join(repo.cwd, "imap")); writeFileSync(join(repo.cwd, "imap/output.o"), "output");
    const staged = repo.git("diff", "--cached");
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "changed");
    assert.equal(repo.git("show", "HEAD:src/feature.ts"), "export const value = 2;");
    assert.equal(repo.git("diff", "--cached"), staged, "业务暂存保持原样");
    assert.equal(readFileSync(join(repo.cwd, "README.md"), "utf8"), "unstaged intent\n");
    assert.equal(readFileSync(join(repo.cwd, "src/feature.ts"), "utf8"), "uncommitted source\n");
    assert.equal(readFileSync(join(repo.cwd, "imap/output.o"), "utf8"), "output");
    assert.equal(readFileSync(join(repo.cwd, "target/classes/Feature.class"), "utf8"), "bytecode");
    assert.equal(repo.git("ls-files", "target/classes/Feature.class"), "target/classes/Feature.class");
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "unchanged");
  } finally { await service.shutdown(); await model.stop(); rmSync(repo.cwd, { recursive: true, force: true }); }
});


test("无法清理已推送的平台目录历史时恢复原提交并报告具体路径，不留下半整理现场", async () => {
  const repo = repository();
  const { service, model, internal } = await waitingService(repo);
  try {
    const baseline = repo.git("rev-parse", "HEAD^");
    mkdirSync(join(repo.cwd, ".claude"));
    writeFileSync(join(repo.cwd, ".claude", "injected.md"), "already published");
    repo.git("add", "-f", ".claude/injected.md");
    repo.git("commit", "--quiet", "-m", "already pushed platform file");
    const pushed = repo.git("rev-parse", "HEAD");
    internal.summary.delivery = { git_push: { sha: pushed, ref: "refs/heads/master", remote: "origin" } };
    internal.summary.delivery_selection = { paths: ["src/feature.ts"], observed_paths: ["src/feature.ts"],
      excluded_paths: [], status: "confirmed", waiting_id: "old", head: pushed, baseline, updated_at: new Date().toISOString() };
    writeFileSync(join(repo.cwd, "src/feature.ts"), "export const value = 3;\n");
    repo.git("add", "src/feature.ts"); repo.git("commit", "--quiet", "-m", "new repair");
    const original = repo.git("rev-parse", "HEAD");
    assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "blocked");
    assert.equal(repo.git("rev-parse", "HEAD"), original);
    assert.equal(readFileSync(join(repo.cwd, "src/feature.ts"), "utf8"), "export const value = 3;\n");
    assert.match(internal.summary.detail, /原提交、索引与工作区均未修改/);
    assert.match(internal.summary.detail, /\.claude\/injected.md/);
    assert.equal(repo.git("merge-base", "--is-ancestor", pushed, "HEAD"), "");
  } finally {
    await service.shutdown(); await model.stop();
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

test("旧单仓 Story 确认卡提交意见直接进入现有返工分支，不误调汇总 Story", async () => {
  const repo = repository();
  const { service, model, id, internal } = await waitingService(repo);
  try {
    internal.summary.requirement_graph = { stage: "confirmed", repositories: [{ id: "repo-1", name: "service" }], dependencies: [] };
    mkdirSync(join(repo.cwd, ".mae-flow-work", id), { recursive: true });
    writeFileSync(join(repo.cwd, ".mae-flow-work", id, "story.md"), "# Story\n当前设计");
    const note = service.addAnnotation(id, { author: "本地用户", artifact: "task-materials/overall-story.md",
      file: "story.md", line: 2, anchor: "当前设计", note: "补充异常处理场景", kind: "doc" });
    assert.deepEqual((await service.sendAnnotations(id, [note.id], "本地用户")).sent, [note.id]);
    await until(() => model.requests.length >= 2 ? true : undefined, "Story 意见进入原会话");
    assert.match(JSON.stringify(model.requests.at(-1)), /补充异常处理场景/);
    assert.doesNotMatch(JSON.stringify(model.requests.at(-1)), /plan_revision|story_sha256/);
  } finally {
    await service.shutdown(); await model.stop();
    rmSync(repo.cwd, { recursive: true, force: true });
  }
});

for (const current of ["external_verify", "end", "rework"]) {
  test(`旧整理失败在 ${current} 重启后重跑：按实际阶段继续，不遗留旧错误`, async () => {
    const repo = repository({ commitArtifact: true });
    const root = mkdtempSync(join(tmpdir(), "mfc-delivery-retry-"));
    const options = { dataDir: root, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
      host: { kernelRoot: kernel(), repoPath: repo.cwd },
      delivery: { platformUrl: "http://platform.invalid" } };
    let service = new TaskService(options);
    try {
      const task = service.create("整理失败后继续交付");
      const internal = (service as any).tasks.get(task.id);
      const baseline = repo.git("rev-parse", "HEAD^");
      // 目标分支停留在基准提交；待交付内容只能在任务分支，不能伪装成上游已有内容。
      repo.git("checkout", "-qb", "feature");
      repo.git("branch", "-f", "master", baseline);
      writeFileSync(join(repo.cwd, ".mae-flow.json"), JSON.stringify({ current,
        step_heads: { branch_create: baseline }, config: { 分支名: "feature", 基线分支: "master" } }));
      internal.cwd = repo.cwd;
      internal.summary.status = "failed";
      internal.summary.detail = "按已确认范围自动整理后复核未通过";
      internal.summary.push_confirmation = true;
      internal.summary.delivery = { skipped: internal.summary.detail };
      internal.summary.delivery_selection = { paths: ["src/feature.ts"], excluded_paths: ["target/classes/Feature.class"],
        observed_paths: ["src/feature.ts", "target/classes/Feature.class"], status: "requested",
        waiting_id: "old-request", head: repo.git("rev-parse", "HEAD"), baseline, updated_at: new Date().toISOString() };
      (service as any).persist(internal);
      await service.shutdown();
      service = new TaskService(options);
      assert.equal(service.recover().restored, 1);
      assert.equal((service as any).tasks.get(task.id).summary.status, "failed", "部署本身不自动推送");
      // 只替换远端查询及无关提交文案，执行真实 retry、Git 整理及推送确认。
      (service as any).absorbForeignRemoteCommits = async () => "unchanged";
      (service as any).existingMergeRequestAllowsDelivery = async () => true;
      (service as any).ensureCommitMessagePolicy = async () => "unchanged";
      let pushes = 0;
      (service as any).pushFromHost = async () => { pushes++; throw new Error("未经确认不能推送"); };
      service.retry(task.id, "owner");
      assert.equal(service.get(task.id)?.delivery?.skipped, undefined);
      if (current === "rework") {
        assert.equal(service.get(task.id)?.status, "queued", "可编辑阶段仍由 Agent 继续工作");
      } else {
        await until(() => service.get(task.id)?.waiting?.step === "cloud_push_confirm" ? true : undefined, "直接回到推送确认卡");
        assert.equal(service.get(task.id)?.delivery_selection?.status, "requested", "重跑不伪造确认");
        assert.equal(repo.git("diff", "--name-only", baseline, "HEAD"), "src/feature.ts\ntarget/classes/Feature.class");
        assert.equal(readFileSync(join(repo.cwd, "target/classes/Feature.class"), "utf8"), "bytecode");
        assert.equal((service as any).queue.length, 0, "不派编码 Agent 查询不存在的流水线");
      }
      assert.equal(pushes, 0);
    } finally { await service.shutdown(); rmSync(root, { recursive: true, force: true }); rmSync(repo.cwd, { recursive: true, force: true }); }
  });
}

for (const status of ["requested", "confirmed"] as const) {
  test(`中文及引号路径：${status} 旧清单恢复后真实整理不再 pathspec 失败`, async () => {
    const repo = repository({ commitArtifact: true });
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-quoted-delivery-"));
    const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
    try {
      const baseline = repo.git("rev-parse", "HEAD^");
      const paths = ["docs/template/软件实现设计-design.md", 'src/quote"name.ts', "src/with space.ts", "src/[ab].ts"];
      mkdirSync(join(repo.cwd, "docs/template"), { recursive: true });
      for (const path of paths) writeFileSync(join(repo.cwd, path), "keep exactly\n");
      repo.git("add", "--", ...paths.map(path => `:(literal)${path}`));
      repo.git("commit", "-qm", "add non-ASCII paths");
      repo.git("update-ref", "refs/remotes/origin/master", baseline);
      const task = service.create("中文路径交付回归");
      const internal = (service as any).tasks.get(task.id);
      internal.cwd = repo.cwd;
      internal.summary.baseline = "master";
      const quoted = repo.git("-c", "core.quotePath=true", "diff", "--name-only", baseline, "HEAD", "--", paths[0]);
      assert.ok(quoted.startsWith('"docs/template/\\'), "真实 Git 默认输出含八进制转义");
      const storedPath = status === "requested" ? quoted : quoted.replace(/\\/g, "/");
      internal.summary.delivery_selection = { status, paths: ["src/feature.ts", storedPath, ...paths.slice(1)],
        observed_paths: [storedPath], excluded_paths: ["target/classes/Feature.class"],
        head: repo.git("rev-parse", "HEAD"), baseline, waiting_id: "existing-card", updated_at: new Date().toISOString() };
      const snapshot = await deliveryChangeSnapshot(repo.cwd);
      assert.ok(snapshot);
      for (const path of paths) assert.ok(snapshot.committed_paths.includes(path), path);
      const contribution = await (service as any).deliveryContribution(internal, snapshot);
      for (const path of paths) assert.ok(contribution.paths.includes(path), path);
      assert.equal(internal.summary.delivery_selection.status, status, "修路径不伪造用户确认");
      assert.ok(internal.summary.delivery_selection.paths.includes(paths[0]), "存量八进制路径已恢复");
      assert.deepEqual(internal.summary.delivery_selection.observed_paths, [paths[0]]);
      assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "unchanged");
      for (const path of paths) assert.equal(repo.git("show", `HEAD:${path}`), "keep exactly");
      assert.equal(repo.git("ls-files", "--", "target/classes/Feature.class"), "target/classes/Feature.class");
      assert.equal(readFileSync(join(repo.cwd, "target/classes/Feature.class"), "utf8"), "bytecode");
      assert.equal(await (service as any).reconcileDeliveryPlatformBoundary(internal), "unchanged");
    } finally {
      await service.shutdown(); rmSync(repo.cwd, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
    }
  });
}

test("交付快照中未提交中文重命名与箭头文件名不被展示格式破坏", async () => {
  const repo = repository();
  try {
    repo.git("mv", "src/feature.ts", "src/新 名.ts");
    writeFileSync(join(repo.cwd, 'src/a -> b"c.ts'), "new\n");
    repo.git("add", "--", 'src/a -> b"c.ts');
    const snapshot = await deliveryChangeSnapshot(repo.cwd);
    assert.ok(snapshot?.workspace_paths.includes("src/新 名.ts"));
    assert.ok(snapshot?.workspace_paths.includes('src/a -> b"c.ts'));
    assert.ok(!snapshot?.workspace_paths.includes('b"c.ts'));
  } finally { rmSync(repo.cwd, { recursive: true, force: true }); }
});
