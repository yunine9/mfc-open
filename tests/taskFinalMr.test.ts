import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { KernelHost } from "../src/kernelHost.ts";
import { ensureKernelHostCapability } from "../src/kernelDelivery.ts";
import { TaskService } from "../src/taskService.ts";
import { captureOriginalMr, originalMr } from "../src/taskFinalMr.ts";

async function until(check: () => boolean, label: string) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) assert.fail(label);
    await delay(15);
  }
}

for (const deletedSource of [false, true])
  test(
    deletedSource
      ? "最终 MR 删除源分支：缺少提交版本时继续查询，随后用真实合入提交签名结束任务"
      : "换分支交付：旧 MR 的迟到合入无效，重启后只读监听最终 MR，并以实际版本和时间完成",
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "mfc-linked-final-")),
        workspace = join(root, "task-1"),
        cwd = join(workspace, "repo");
      mkdirSync(cwd, { recursive: true });
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main");
      git("config", "user.name", "test");
      git("config", "user.email", "test@example.test");
      function commit(contents: string) {
        writeFileSync(join(cwd, "a.ts"), contents);
        git("add", "a.ts");
        git("commit", "-qm", contents);
        return git("rev-parse", "HEAD");
      }
      const stale = commit("old baseline");
      git("update-ref", "refs/remotes/origin/main", stale);
      const base = commit("current baseline");
      git("switch", "-qc", "cloud");
      const initial = commit("first version");
      git("switch", "-qc", "rewritten", base);
      const final = commit("different implementation");
      git("switch", "-q", "main");
      git("merge", "--no-ff", "-qm", "merge final delivery", "rewritten");
      const mergeCommit = git("rev-parse", "HEAD");
      git("switch", "-q", "cloud");
      let mergeCommitAvailable = false,
        sourceRestored = false;
      const methods: string[] = [],
        mergedAt = "2026-09-09T07:15:01.000Z";
      let state = "opened",
        finishOld!: () => void,
        finalReads = 0;
      const releaseOld = new Promise<void>((resolve) => (finishOld = resolve));
      const server = createServer(async (req, res) => {
        const url = new URL(req.url!, origin);
        methods.push(req.method! + " " + url.pathname);
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/mr/detail") {
          const mr = url.searchParams.get("mr_url")!,
            iid = mr.split("/").pop()!;
          if (iid === "2") finalReads++;
          res.end(
            JSON.stringify({
              url: mr,
              iid,
              repo: iid === "4" ? origin + "/wrong.git" : repo,
              state: iid === "3" ? "closed" : state,
              sha: iid === "1" ? initial : deletedSource && !sourceRestored && state === "merged" ? undefined : final,
              base_sha: base,
              source_branch: "rewritten",
              target_branch: "main",
              version:
                url.searchParams.get("version_head") === initial && iid === "1" ? { head: initial, base } : undefined,
              merge_commit_sha: mergeCommitAvailable ? mergeCommit : undefined,
              merged_at: state === "merged" ? mergedAt : undefined,
            }),
          );
        } else if (url.pathname === "/mr/gates") {
          await releaseOld;
          res.end(JSON.stringify({ mr_state: "merged", source_sha: initial, gates: [] }));
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`,
        repo = origin + "/repo.git",
        mr = (id: number) => origin + "/repo/-/merge_requests/" + id;
      // 模拟已出 MR 的旧任务。首次发布记录来自真实仓库，后续推送不能覆盖它。
      const initialMr = captureOriginalMr({ workspace }, mr(1), initial);
      assert.deepEqual(initialMr, { url: mr(1), head: initial });
      const now = new Date().toISOString();
      const summary = {
        id: "task-1",
        title: "外部交付",
        requirement: "实现需求",
        created_at: now,
        updated_at: now,
        status: "await_merge",
        workspace,
        repo_url: repo,
        luban_account: "owner",
        delivery: {
          mr_url: mr(1),
          mr_id: 1,
          source_branch: "cloud",
          target_branch: "main",
          mr_state: "等待合入",
          initial_mr: initialMr,
        },
      };
      writeFileSync(join(workspace, "task.json"), JSON.stringify({ summary, cwd }));
      const kernelRoot = join(process.cwd(), "kernel");
      const make = (signed = false) =>
        new TaskService({
          dataDir: root,
          provider: "test",
          model: "test",
          modelsJson: {},
          maxConcurrent: 0,
          host: signed ? { kernelRoot, continuousReview: true } : undefined,
          delivery: { platformUrl: origin, pollIntervalMs: 25 },
        });
      let service = make();
      t.after(async () => {
        finishOld();
        await service.shutdown();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(root, { recursive: true, force: true });
      });
      service.recover();
      await until(() => methods.includes("GET /mr/gates"), "未开始监听原 MR");
      await until(
        () => service.get("task-1")?.delivery?.initial_mr?.base === base,
        "应采用平台确认的首发基线，不能采用旧 origin/main",
      );
      await assert.rejects(service.linkFinalMr("task-1", mr(4)), /代码仓/);
      let selected = await service.linkFinalMr("task-1", mr(3));
      assert.equal(selected.delivery?.final_mr?.state, "closed");
      assert.equal(selected.status, "await_merge");
      selected = await service.linkFinalMr("task-1", mr(2));
      finishOld();
      await until(() => finalReads > 1, "未切换到最终 MR 的监听");
      assert.equal(service.get("task-1")?.status, "await_merge");
      assert.equal(selected.delivery?.mr_url, mr(1));
      assert.deepEqual(selected.delivery?.initial_mr, { ...initialMr, base });
      assert.throws(() => service.retry("task-1"), /最终 MR/);
      await service.shutdown();
      const authority = ensureKernelHostCapability({ workspace, taskId: "task-1", cwd });
      writeFileSync(
        join(cwd, ".mae-flow-order.json"),
        JSON.stringify({
          execution_contract: {
            schema: "mae-flow-execution/1",
            host: "cloud",
            compile: "pipeline",
            ut_write: "agent",
            ut_run: "pipeline",
            codecheck: "pipeline",
            git_push: "host",
            continuous_review: true,
            host_authority: authority,
          },
          单号: "REQ-1",
          基线分支: "main",
          工号: "owner",
        }),
      );
      const kernel = new KernelHost({
        kernelRoot,
        workspace: cwd,
        taskId: "task-1",
        transcriptPath: join(workspace, "transcript.jsonl"),
      });
      await kernel.bootstrapManaged("从最终 MR 交付需求");
      service = make(true);
      const recovered = service.recover();
      assert.equal(recovered.requeued, 0);
      state = "merged";
      if (deletedSource) {
        await until(() => !!service.get("task-1")?.delivery?.stalled?.includes("合入提交"), "缺少合入版本应显式等待");
        mergeCommitAvailable = true;
      }
      await until(() => service.get("task-1")?.status === "completed", "重启后未根据最终 MR 合入结束任务");
      const completed = service.get("task-1")!;
      assert.equal(completed.completed_at, mergedAt);
      assert.equal(completed.delivery?.final_mr?.head, deletedSource ? undefined : final);
      assert.equal(completed.delivery?.merged_sha, deletedSource ? mergeCommit : final);
      const kernelState = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
      assert.equal(kernelState.current, "end");
      assert.equal(kernelState.delivery_loop.close_events.at(-1).sha, deletedSource ? mergeCommit : final);
      if (deletedSource) {
        sourceRestored = true;
        service.deliveryAnalysis(true);
        await until(
          () => service.deliveryAnalysis().rows[0]?.mr_comparison?.method === "patch",
          "刷新后应从同一合入提交补回源版本并生成差异",
        );
        const refreshed = service.get("task-1")!;
        assert.equal(refreshed.delivery?.final_mr?.head, final);
        assert.equal(refreshed.completed_at, mergedAt);
        assert.equal(refreshed.delivery?.merged_sha, mergeCommit);
      }
      assert.equal(git("rev-parse", "HEAD"), initial);
      assert.ok(
        methods.every((m) => m.startsWith("GET ")),
        "外部 MR 接管后平台只能读",
      );
      assert.equal(
        JSON.parse(readFileSync(join(workspace, "task.json"), "utf8")).summary.delivery.initial_mr.head,
        initial,
      );
    },
  );

test("旧任务在没有初版证据时保留原 MR 链接，不把最近推送当初版", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-no-first-mr-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const url = "https://code.example/repo/-/merge_requests/1";
  const first = originalMr({
    workspace,
    delivery: { mr_url: url, git_push: { ref: "refs/heads/later", remote: "origin", sha: "f".repeat(40) } },
  });
  assert.ok(first);
  assert.equal(first.url, url);
  assert.equal(first.head, undefined);
});

for (const initialized of [false, true]) {
  test(`无平台初版 MR：${initialized ? "已开始的需求在内核登记真实合入" : "排队中尚无代码现场也可完成"}，只恢复最终 MR 监听`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "mfc-external-only-"));
    const repo = "https://code.example/acme/service.git", mr = (id: number) => `https://code.example/acme/service/-/merge_requests/${id}`;
    const calls: string[] = [];
    const mergedAt = "2026-11-04T08:15:00.000Z";
    let oldReads = 0, newReads = 0, merged = false, provideSha = false;
    let sha = "b".repeat(40), base = "a".repeat(40), releaseOld!: () => void;
    const held = new Promise<void>(resolve => { releaseOld = resolve; });
    const platform = createServer(async (request, response) => {
      const path = new URL(request.url!, "http://localhost");
      calls.push(request.method + " " + path.pathname);
      if (path.pathname !== "/mr/detail") { response.writeHead(404).end(); return; }
      const url = path.searchParams.get("mr_url")!, iid = url.split("/").at(-1);
      let state = "opened";
      if (iid === "2" && ++oldReads > 1) { await held; state = "merged"; }
      if (iid === "3") { newReads++; if (merged) state = "merged"; }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ url, iid, repo: iid === "4" ? "https://code.example/other.git" : repo,
        source_branch: "local", target_branch: "main", state,
        sha: provideSha || state !== "merged" ? sha : undefined, base_sha: base,
        merged_at: state === "merged" ? mergedAt : undefined }));
    });
    await new Promise<void>(resolve => platform.listen(0, "127.0.0.1", resolve));
    const address = platform.address(); assert.ok(address && typeof address === "object");
    const kernelRoot = join(process.cwd(), "kernel");
    const make = () => new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {},
      maxConcurrent: 0, host: { kernelRoot, continuousReview: true },
      delivery: { platformUrl: `http://127.0.0.1:${address.port}`, pollIntervalMs: 20 } });
    let service = make();
    t.after(async () => {
      releaseOld(); await service.shutdown();
      platform.closeAllConnections(); await new Promise<void>(resolve => platform.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    });
    const created = service.create("本地完成需求", { repo, ticket: "REQ-1", baseline: "main", account: "owner" });
    const task = (service as any).tasks.get(created.id);
    const cwd = join(created.workspace, "service");
    if (initialized) {
      task.cwd = cwd; mkdirSync(cwd);
      const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
      git("init", "-q", "-b", "main"); git("config", "user.email", "owner@example.test"); git("config", "user.name", "owner");
      git("commit", "--allow-empty", "-qm", "base"); base = git("rev-parse","HEAD");
      writeFileSync(join(cwd, "code.ts"), "export const shipped = true;\n");
      git("add", "code.ts"); git("commit", "-qm", "local code"); sha = git("rev-parse","HEAD");
      const authority = ensureKernelHostCapability({ workspace: created.workspace, taskId: created.id, cwd });
      writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({ execution_contract: {
        schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline", ut_write: "agent", ut_run: "pipeline",
        codecheck: "pipeline", git_push: "host", continuous_review: true, host_authority: authority } }));
      await new KernelHost({ kernelRoot, workspace: cwd, transcriptPath: join(created.workspace, "transcript.jsonl"),
        taskId: created.id }).bootstrapManaged("继续当前任务");
      task.summary.status = "waiting_for_human"; task.summary.delivery = { pipeline: "pending" };
      task.summary.waiting = task.humanGate.createWaiting({ taskId: created.id, step: "config_confirm", callId: "old",
        questionInput: { question: "是否继续配置？" } });
    }
    if (!initialized) {
      task.summary.origin = "issue";
      await assert.rejects(service.linkFinalMr(created.id, mr(2)), /需求交付任务/);
      task.summary.origin = "requirement"; task.summary.requirement_analysis_requested = true;
      await assert.rejects(service.linkFinalMr(created.id, mr(2)), /需求交付任务/);
      delete task.summary.requirement_analysis_requested;
      assert.deepEqual(calls, []);
    }
    const waitingId = task.summary.waiting?.waiting_id;
    await assert.rejects(service.linkFinalMr(created.id, mr(4)), /本任务的代码仓/);
    assert.equal(task.summary.delivery?.final_mr, undefined);
    if (!initialized) assert.equal(task.summary.delivery, undefined);
    assert.equal(task.summary.status, initialized ? "waiting_for_human" : "queued");
    const linked = await service.linkFinalMr(created.id, mr(2));
    assert.equal(linked.status, "await_merge"); assert.equal(linked.delivery?.mr_url, undefined);
    assert.equal(linked.delivery?.initial_mr, undefined); assert.equal(linked.waiting, undefined);
    assert.equal((service as any).queue.includes(created.id), false);
    if (waitingId) assert.equal(task.humanGate.get(waitingId).status, "superseded");
    await until(() => oldReads > 1, "未监听已关联的最终 MR");
    await service.linkFinalMr(created.id, mr(3)); releaseOld();
    await until(() => newReads > 1, "旧 MR 合入回调后未继续监听新链接");
    assert.equal(service.get(created.id)?.status, "await_merge");
    await service.shutdown();
    service = make();
    assert.equal(service.recover().requeued, 0);
    merged = true;
    if (initialized) {
      await until(() => !!service.get(created.id)?.delivery?.stalled?.includes("尚未返回源版本"), "已初始化内核必须等待合入版本");
      provideSha = true;
    }
    await until(() => service.get(created.id)?.status === "completed", "最终 MR 合入后任务没有结束");
    const final = service.get(created.id)!;
    assert.equal(final.completed_at, mergedAt); assert.equal(final.delivery?.final_mr?.url, mr(3));
    assert.equal(final.delivery?.initial_mr, undefined); assert.equal(final.delivery?.mr_url, undefined);
    if (initialized) {
      const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
      assert.equal(state.current, "end"); assert.equal(state.delivery_loop.close_events[0].sha, sha);
      assert.equal(final.delivery?.pipeline, "pending");
    }
    assert.ok(calls.every(call => call === "GET /mr/detail"));
  });
}

test("后台克隆期间关联已合入 MR，迟到的克隆不能再启动内核或 Agent", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-link-during-clone-"));
  const repo = "https://code.example/acme/service.git";
  const url = "https://code.example/acme/service/-/merge_requests/3";
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 1, host: { kernelRoot: join(process.cwd(), "kernel"), continuousReview: true } });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const clone = t.mock.method(service as any, "cloneRepo", async (workspace: string) => {
    await held;
    const cwd = join(workspace, "repo"); mkdirSync(cwd);
    return cwd;
  });
  const bootstrap = t.mock.method(KernelHost.prototype, "bootstrapManaged", async () => "");
  t.mock.method(service as any, "readFinalMr", async () => ({ url, iid: "3", repo,
    source_branch: "local", target_branch: "main", state: "merged" }));
  t.after(async () => { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const task = service.create("本地已经交付", { repo, ticket: "REQ-9", account: "alice", baseline: "main" });
  await until(() => clone.mock.callCount() === 1, "任务未进入克隆");
  const final = await service.linkFinalMr(task.id, url);
  assert.equal(final.status, "completed", "未建立内核的任务以经核验的合入事实结束");
  release();
  await until(() => (service as any).runningCount === 0, "克隆完成后未释放运行名额");
  assert.equal(bootstrap.mock.callCount(), 0);
  assert.equal(existsSync(join(task.workspace, "repo", ".mae-flow-order.json")), false);
  assert.equal(service.get(task.id)?.delivery?.initial_mr, undefined);
  assert.equal(service.get(task.id)?.status, "completed");
});
