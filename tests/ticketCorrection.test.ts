import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { TaskService } from "../src/taskService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { prepareTicketRewrite, applyTicketRewrite, migrateTicketArtifacts } from "../src/ticketCorrection.ts";
import { correctKernelTicket, attestKernelHost } from "../src/kernelDelivery.ts";
import { sealPipelineLifecycle } from "./kernelHostFixture.ts";
import { TaskHostLedger } from "../src/taskHostTools.ts";

const kernelRoot = resolve(process.env.MAE_FLOW_HOME ?? "kernel");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "mfc-ticket-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "tasks", "task-1"), cwd = join(workspace, "repo"), remote = join(root, "remote.git");
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q", "-b", "master"); git(cwd, "config", "user.name", "Owner"); git(cwd, "config", "user.email", "owner@example.test");
  writeFileSync(join(cwd, "code.cpp"), "baseline\n"); git(cwd, "add", "code.cpp"); git(cwd, "commit", "-qm", "base");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "-qb", "master_owner_REQ111");
  writeFileSync(join(cwd, "code.cpp"), "baseline\nfeature\n"); git(cwd, "commit", "-qam", "[REQ111][feat]实现功能");
  const head = git(cwd, "rev-parse", "HEAD");
  git(root, "init", "-q", "--bare", remote);
  git(cwd, "remote", "add", "origin", remote);
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    current: "external_verify", revision: 3, history: [], initial_dirty: [],
    execution_contract: { schema: "mae-flow-execution/1", host: "cloud", compile: "pipeline", ut_write: "agent", ut_run: "pipeline", codecheck: "pipeline", git_push: "host", continuous_review: true, source: "order" },
    config: { "单号": "REQ111", "分支名": "master_owner_REQ111", "基线分支": "master" },
    step_heads: { branch_create: base },
  }));
  writeFileSync(join(cwd, ".mae-flow-order.json"), JSON.stringify({ "单号": "REQ111" }));
  return { root, workspace, cwd, remote, base, head };
}

test("单号对象重建保留代码、作者、脏索引、未提交内容及旧文档链接", async t => {
  const s = fixture(t);
  mkdirSync(join(s.cwd, ".mae-flow-work", "REQ111"), { recursive: true });
  writeFileSync(join(s.cwd, ".mae-flow-work", "REQ111", "story.md"), "original story");
  writeFileSync(join(s.cwd, ".mae-flow-work", "REQ111", ".ticket-id"), "REQ111");
  writeFileSync(join(s.cwd, "code.cpp"), "staged\n"); git(s.cwd, "add", "code.cpp");
  writeFileSync(join(s.cwd, "code.cpp"), "unstaged\n");
  const index = readFileSync(join(s.cwd, ".git", "index"));
  const plan = await prepareTicketRewrite(s.cwd, "REQ111", "REQ222", s.base);
  await applyTicketRewrite(s.cwd, plan); await applyTicketRewrite(s.cwd, plan);
  migrateTicketArtifacts(s.cwd, "REQ111", "REQ222"); migrateTicketArtifacts(s.cwd, "REQ111", "REQ222");
  assert.equal(git(s.cwd, "rev-parse", "HEAD^{tree}"), git(s.cwd, "rev-parse", `${s.head}^{tree}`));
  assert.equal(git(s.cwd, "log", "-1", "--format=%s"), "[REQ222][feat]实现功能");
  assert.equal(git(s.cwd, "log", "-1", "--format=%ae"), "owner@example.test");
  assert.deepEqual(readFileSync(join(s.cwd, ".git", "index")), index);
  assert.equal(readFileSync(join(s.cwd, "code.cpp"), "utf8"), "unstaged\n");
  assert.equal(readFileSync(join(s.cwd, ".mae-flow-work", "REQ111", "story.md"), "utf8"), "original story");
  assert.equal(readFileSync(join(s.cwd, ".mae-flow-work", "REQ222", ".ticket-id"), "utf8"), "REQ222");
});

test("真实内核纠正后继承流水线签署、重复纠正幂等，拒绝代码不同的 SHA 映射", async t => {
  const s = fixture(t);
  sealPipelineLifecycle({ ...s, taskId: "task-1", kernelRoot });
  const before = JSON.parse(readFileSync(join(s.cwd, ".mae-flow.json"), "utf8"));
  const plan = await prepareTicketRewrite(s.cwd, "REQ111", "REQ222", s.base); await applyTicketRewrite(s.cwd, plan);
  const input = { host: { kernelRoot }, cwd: s.cwd, workspace: s.workspace, taskId: "task-1",
    correction: { id: "test", old_ticket: "REQ111", ticket: "REQ222", ...plan } };
  correctKernelTicket(input); correctKernelTicket(input);
  const state = JSON.parse(readFileSync(join(s.cwd, ".mae-flow.json"), "utf8"));
  assert.equal(state.config["单号"], "REQ222"); assert.equal(state.current, before.current);
  assert.equal(state.quality.external_verification.verdict, "PASS");
  assert.equal(state.quality.external_verification.sha, plan.head);
  assert.equal(state.ticket_corrections.length, 1);
  assert.equal(state.ticket_corrections[0].original.quality.external_verification.sha, s.head);
  assert.equal(attestKernelHost({ host: { kernelRoot }, cwd: s.cwd, lifecycle: ["pipeline-record"] }).lifecycle, true);
  assert.throws(() => correctKernelTicket({ ...input, correction: { id: "bad", old_ticket: "REQ222", ticket: "REQ333", sha_map: { [s.base]: plan.head } } }), /不能改变代码/);
});

async function serviceFixture(t: test.TestContext, pushed: boolean, withMr: boolean, failClose = false) {
  const s = fixture(t); const requests: string[] = []; let creates = 0; let fail = failClose;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/mr/discover")) { res.end(JSON.stringify({ mrs: [] })); return; }
    if (req.url?.startsWith("/mr/gates")) { res.end(JSON.stringify({ mr_state: "opened", sha: s.head, gates: [] })); return; }
    if (req.url === "/mr" && req.method === "POST") {
      const data = JSON.parse(body); assert.equal(data.dts_no, "REQ222"); assert.equal(data.title, "准确 AR 描述");
      creates++; res.end(JSON.stringify({ id: 2, url: "http://code/merge_requests/2" })); return;
    }
    if (req.url === "/mr/close") { if (fail) { res.statusCode = 503; res.end("retry"); } else res.end(JSON.stringify({ mr_state: "closed" })); return; }
    res.statusCode = 404; res.end("{}");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const platformUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  const service = new TaskService({ dataDir: join(s.root, "tasks"), provider: "unused", model: "unused", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot }, delivery: { platformUrl } });
  // 不启动模型。把实际停在检视阶段的任务注入，后续使用真实服务迁移、Git 传输、内核、HTTP。
  const task: any = { cwd: s.cwd, controlEpoch: 0, tokenUsage: {}, humanGate: new HumanGate(join(s.workspace, "waiting.json")),
    summary: { id: "task-1", requirement: "真实需求", ticket: "REQ111", luban_account: "owner", status: "waiting_for_human",
      workspace: s.workspace, repo_url: s.remote, baseline: "master", created_at: new Date().toISOString(),
      delivery: { source_branch: "master_owner_REQ111", target_branch: "master", last_reviewed_head: s.head } } };
  if (pushed) { git(s.cwd, "push", "-q", "origin", "HEAD"); task.summary.delivery.git_push = { sha: s.head, ref: "refs/heads/master_owner_REQ111", remote: "origin", url: s.remote }; task.summary.delivery.sha = s.head; }
  if (withMr) Object.assign(task.summary.delivery, { mr_id: 1, mr_url: "http://code/merge_requests/1" });
  (service as any).tasks.set("task-1", task);
  // 监听本身另有集成测试；此处避免用固定假平台的旧 SHA 在完成后触发新动作。
  (service as any).ensureMergeWatch = () => {};
  t.after(() => service.shutdown());
  const correct = async () => { service.correctTicket("task-1", { ticket: "REQ222", title: "准确 AR 描述" }, "owner"); await (service as any).ticketCorrections.get("task-1"); };
  return { ...s, service, task, requests, correct, creates: () => creates, allowClose: () => { fail = false; } };
}
for (const [pushed, mr] of [[false, false], [true, false], [true, true]]) {
  test(`服务完整纠正：已推送=${pushed}、已有 MR=${mr}`, async t => {
    const s = await serviceFixture(t, pushed, mr); await s.correct();
    assert.equal(s.task.summary.ticket_correction.state, "completed", s.task.summary.detail);
    assert.equal(s.task.summary.ticket, "REQ222"); assert.equal(s.task.summary.status, "waiting_for_human");
    assert.equal(s.task.summary.delivery.last_reviewed_head, git(s.cwd, "rev-parse", "HEAD"));
    const branches = git(s.root, "--git-dir=" + s.remote, "for-each-ref", "--format=%(refname)", "refs/heads");
    assert.equal(branches.includes("REQ222"), pushed); assert.equal(branches.includes("REQ111"), false);
    assert.equal(s.creates(), mr ? 1 : 0);
    if (!pushed) assert.equal(s.requests.length, 0);
    if (mr) assert.equal(s.task.summary.delivery.mr_id, 2);
  });
}
test("旧 MR 关闭失败后重试只补清理，不重复推送/建单，旧分支保留到成功", async t => {
  const s = await serviceFixture(t, true, true, true); await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "failed");
  assert.equal(s.task.summary.delivery.mr_id, 2);
  assert.ok(git(s.root, "--git-dir=" + s.remote, "rev-parse", "refs/heads/master_owner_REQ111"));
  s.allowClose(); await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "completed", s.task.summary.detail);
  assert.equal(s.creates(), 1);
});

test("合入的目标分支历史不改写，只改任务主线；重复编号本地分支不覆盖", async t => {
  const s = fixture(t);
  git(s.cwd, "checkout", "-q", "master");
  writeFileSync(join(s.cwd, "shared.cpp"), "shared\n"); git(s.cwd, "add", "shared.cpp"); git(s.cwd, "commit", "-qm", "[REQ111][fix]别人的提交");
  const foreign = git(s.cwd, "rev-parse", "HEAD");
  git(s.cwd, "checkout", "-q", "master_owner_REQ111"); git(s.cwd, "merge", "--no-ff", "-qm", "Merge master", "master");
  const plan = await prepareTicketRewrite(s.cwd, "REQ111", "REQ222", s.base);
  assert.equal(plan.sha_map[foreign], undefined);
  assert.ok(git(s.cwd, "log", "--format=%s", plan.head).includes("[REQ111][fix]别人的提交"));
  assert.equal(git(s.cwd, "rev-parse", `${plan.old_head}^{tree}`), git(s.cwd, "rev-parse", `${plan.head}^{tree}`));
  await applyTicketRewrite(s.cwd, plan);
  await assert.rejects(prepareTicketRewrite(s.cwd, "REQ222", "REQ111", s.base), /已存在/);
});

test("重启保留纠正断点，不用旧推送收据覆盖新 MR；重试只补未完成的清理", async t => {
  const s = await serviceFixture(t, true, true, true); await s.correct();
  assert.equal(s.task.summary.ticket_correction.cleanup_only, true);
  assert.equal(s.task.summary.status, "waiting_for_human", "旧资源清理失败不能卡住新交付");
  // 模拟进程在投影落盘后、关闭旧 MR 前退出，此时不应启动普通恢复链。
  s.task.summary.ticket_correction.cleanup_only = false;
  s.task.summary.ticket_correction.state = "running";
  s.task.summary.status = "paused";
  (s.service as any).persist(s.task);
  await s.service.shutdown();
  const recovered = new TaskService(s.service.options); t.after(() => recovered.shutdown());
  (recovered as any).ensureMergeWatch = () => {};
  recovered.recover();
  const restored = (recovered as any).tasks.get("task-1");
  assert.equal(restored.summary.ticket_correction.state, "failed");
  assert.equal(restored.summary.delivery.mr_id, 2);
  s.allowClose(); recovered.correctTicket("task-1", { ticket: "REQ222", title: "准确 AR 描述" }, "owner");
  await (recovered as any).ticketCorrections.get("task-1");
  assert.equal(restored.summary.ticket_correction.state, "completed", restored.summary.detail);
  assert.equal(s.creates(), 1);
});

test("新分支被占用时保留旧分支和 MR，能撤销尚未修改的纠正", async t => {
  const s = await serviceFixture(t, true, true);
  git(s.cwd, "branch", "master_owner_REQ222", s.base);
  await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "failed");
  assert.equal(s.task.summary.ticket, "REQ111");
  assert.equal(git(s.cwd, "branch", "--show-current"), "master_owner_REQ111");
  s.service.cancelTicketCorrection("task-1");
  assert.equal(s.task.summary.ticket_correction, undefined);
  assert.equal(s.creates(), 0);
});

test("父任务只更新对应子任务单号，兄弟任务不改；Build-Fix PASS 沿用到相同代码", async t => {
  const { createHash } = await import("node:crypto");
  const { createPrePushVerification, getReusablePushReceipt } = await import("../src/prePushVerification.ts");
  const s = await serviceFixture(t, false, false);
  const fingerprint = createHash("sha256").update(s.head).digest("hex");
  const pre: any = createPrePushVerification({ sha: s.head, workspace_fingerprint: fingerprint }, new Date().toISOString());
  pre.state = "passed"; pre.checks = { compile: { state: "passed", attempt_id: "a", completed_at: "2026-09-21T00:00:00Z" }, unit_test: { state: "passed", attempt_id: "a", completed_at: "2026-09-21T00:00:00Z" } };
  pre.receipt = { schema: "mae-flow-cloud/prepush-pass/1", sha: s.head, workspace_fingerprint: fingerprint, issued_at: "2026-09-21T00:00:00Z", checks: structuredClone(pre.checks) };
  s.task.summary.delivery.prepush = pre;
  const parent: any = { summary: { id: "task-2", workspace: join(s.root, "tasks", "task-2"), status: "coordinating", requirement: "parent", ticket: "REQ100", created_at: new Date().toISOString(), requirement_graph: { stage: "dispatched", repositories: [ { id: "u1", task_id: "task-1", ticket: "REQ111" }, { id: "u2", task_id: "task-3", ticket: "REQ111" } ], dependencies: [] } }, humanGate: new HumanGate(join(s.root, "waiting-parent.json")), controlEpoch: 0, tokenUsage: {} };
  mkdirSync(parent.summary.workspace, { recursive: true });
  (s.service as any).tasks.set("task-2", parent); s.task.summary.parent_task_id = "task-2";
  await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "completed", s.task.summary.detail);
  assert.equal(parent.summary.requirement_graph.repositories[0].ticket, "REQ222");
  assert.equal(parent.summary.requirement_graph.repositories[1].ticket, "REQ111");
  assert.equal(parent.summary.ticket, "REQ100");
  const sha = git(s.cwd, "rev-parse", "HEAD");
  assert.ok(getReusablePushReceipt(s.task.summary.delivery.prepush, { sha, workspace_fingerprint: createHash("sha256").update(sha).digest("hex") }));
  assert.equal(s.task.summary.delivery.prepush.receipt.issued_at, pre.receipt.issued_at);
});

test("换号不顺带发布本地尚未交付的新提交", async t => {
  const s = await serviceFixture(t, true, true);
  writeFileSync(join(s.cwd, "code.cpp"), "baseline\nfeature\nnot delivered\n");
  git(s.cwd, "commit", "-qam", "[REQ111][fix]尚未交付的改动");
  const localTree = git(s.cwd, "rev-parse", "HEAD^{tree}");
  const remoteTree = git(s.cwd, "rev-parse", `${s.head}^{tree}`);
  await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "completed", s.task.summary.detail);
  assert.equal(git(s.cwd, "rev-parse", "HEAD^{tree}"), localTree);
  assert.equal(git(s.root, "--git-dir=" + s.remote, "rev-parse", "refs/heads/master_owner_REQ222^{tree}"), remoteTree);
  assert.notEqual(git(s.cwd, "rev-parse", "HEAD"), s.task.summary.delivery.git_push.sha);
});

test("纠正单号 HTTP 入口只有责任人可用，任务详情返回进度与结果", async t => {
  const { LocalAuth } = await import("../src/auth.ts");
  const { createTaskServer } = await import("../src/server.ts");
  const s = await serviceFixture(t, false, false);
  const auth = new LocalAuth(join(s.root, "auth.json"));
  auth.bootstrapAdmin("owner", "owner-test-pass"); auth.createUser("other", "other-test-pass", "developer");
  const server = createTaskServer(s.service, { auth });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const cookie = async (username: string) => (await fetch(url + "/auth/login", { method: "POST", body: JSON.stringify({ username, password: `${username}-test-pass` }) })).headers.get("set-cookie")!.split(";")[0];
  const post = async (user: string) => fetch(url + "/tasks/task-1/correct-ticket", { method: "POST", headers: { cookie: await cookie(user) }, body: JSON.stringify({ ticket: "REQ222", title: "准确 AR 描述" }) });
  assert.equal((await post("other")).status, 403);
  assert.equal((await post("owner")).status, 202);
  await (s.service as any).ticketCorrections.get("task-1");
  const response = await fetch(url + "/tasks/task-1", { headers: { cookie: await cookie("owner") } });
  const value = await response.json() as any;
  assert.equal(value.ticket, "REQ222"); assert.equal(value.ticket_correction.state, "completed");
});

test("文档目录迁移不改变批注的闭环状态、版本和原文", async t => {
  const { AnnotationStore } = await import("../src/annotations.ts");
  const s = fixture(t); const path = join(s.workspace, "annotations.jsonl");
  writeFileSync(path, JSON.stringify({ op: "add", record: { id: "a", author: "owner", created_at: new Date().toISOString(), artifact: "REQ111/story.md", file: ".mae-flow-work/REQ111/story.md", line: 1, anchor: "原文", note: "保留职责", rework: 2, status: "verified" } }) + "\n");
  const store = new AnnotationStore(path); store.relocateTicketArtifacts("REQ111", "REQ222", "owner");
  store.relocateTicketArtifacts("REQ111", "REQ222", "owner");
  const item = store.list()[0]; assert.equal(item.artifact, "REQ222/story.md"); assert.equal(item.file, ".mae-flow-work/REQ222/story.md");
  assert.equal(item.status, "verified"); assert.equal(item.rework, 2); assert.equal(item.anchor, "原文");
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
});

test("等待旧 AR 描述时纠正单号，撤下旧卡并直接继续宿主交付", async t => {
  const s = await serviceFixture(t, true, false);
  const { askMrDescription, savedMrDescription } = await import("../src/mrDescription.ts");
  const prior = askMrDescription(s.task.humanGate, "task-1", "REQ111");
  s.task.summary.waiting = prior;
  let continued = 0;
  (s.service as any).tryDeliver = async () => { continued++; };
  await s.correct();
  assert.equal(s.task.summary.ticket_correction.state, "completed");
  assert.equal(s.task.summary.waiting, undefined);
  assert.equal(s.task.humanGate.all().find((r: any) => r.waiting_id === prior.waiting_id)?.status, "superseded");
  assert.equal(savedMrDescription(s.task.humanGate, "task-1", "REQ222"), "准确 AR 描述");
  assert.equal(s.task.summary.status, "verifying");
  assert.equal(continued, 1);
});

test("纠正等待已发出的宿主操作落账，保留刚取得的 MR，不遗漏清理", async t => {
  const s = await serviceFixture(t, true, false);
  let finish!: () => void;
  s.task.hostActionActive = new Promise<boolean>(resolve => {
    finish = () => {
      Object.assign(s.task.summary.delivery, { mr_id: 1, mr_url: "http://code/merge_requests/1" });
      const ledger = new TaskHostLedger(s.task.summary);
      ledger.update({ id: "inflight", input: { action: "create_mr", reason: "create" }, state: "running", at: new Date().toISOString(),
        sha: s.head, branch: "master_owner_REQ111", mr_receipt: { id: 1, url: "http://code/merge_requests/1" } });
      resolve(true);
    };
  });
  s.service.correctTicket("task-1", { ticket: "REQ222", title: "准确 AR 描述" }, "owner");
  finish();
  await (s.service as any).ticketCorrections.get("task-1");
  assert.equal(s.task.summary.ticket_correction.state, "completed", s.task.summary.detail);
  assert.equal(s.task.summary.delivery.mr_id, 2);
  assert.equal(new TaskHostLedger(s.task.summary).pending()?.mr_receipt?.id, 2);
  assert.equal(s.requests.filter(r => r === "POST /mr/close").length, 1);
});
