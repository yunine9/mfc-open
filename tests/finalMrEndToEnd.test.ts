import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createTaskServer } from "../src/server.ts";
import type { MrComparisonDetail, DeliveryAnalysisReport } from "../src/deliveryAnalyticsTypes.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";
import { ReviewStore } from "../src/reviews.ts";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

test("在任务 API 关联已合入的另一分支，历史初版补取基线，分析 API 展示实际最终代码",
  t => verifyFinalMrDelivery(t, "initial-mr"));
test("平台尚无 MR 和 Git 工作目录时，直接关联外部 MR 并按实际合入代码统计交付",
  t => verifyFinalMrDelivery(t, "no-code"));

test("用户拉取平台已推送的分支继续修改，自建 CodeHub MR 后可追溯后续修改",
  t => verifyFinalMrDelivery(t, "pushed-branch"));

async function verifyFinalMrDelivery(t: TestContext, start: "initial-mr" | "pushed-branch" | "no-code") {
  const initialPublished = start === "initial-mr";
  const priorNoProxy = process.env.no_proxy;
  process.env.no_proxy = [priorNoProxy, "127.0.0.1"].filter(Boolean).join(",");
  t.after(() => { if (priorNoProxy === undefined) delete process.env.no_proxy; else process.env.no_proxy = priorNoProxy; });
  const root = mkdtempSync(join(tmpdir(), "mfc-final-e2e-")), dataDir = join(root, "tasks");
  const workspace = join(dataDir, "task-1"), local = join(workspace, "repo"), upstream = join(root, "upstream");
  mkdirSync(upstream); mkdirSync(workspace, { recursive: true });
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(upstream, "init", "-b", "main");
  git(upstream, "config", "user.name", "developer"); git(upstream, "config", "user.email", "dev@example.test");
  const commit = (file: string, code: string, message: string) => {
    writeFileSync(join(upstream, file), code + "\n"); git(upstream, "add", file);
    git(upstream, "commit", "-m", message); return git(upstream, "rev-parse", "HEAD");
  };
  const firstBase = commit("service.ts", "export const retries = 0;", "baseline");
  git(upstream, "switch", "-c", "initial");
  const initial = commit("service.ts", "export const retries = 1;", "first draft");
  if (start !== "no-code") git(root, "clone", "--no-local", upstream, local);
  if (start !== "no-code")
    writeFileSync(join(local, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: firstBase } }));
  git(upstream, "switch", "main");
  const mainTip = commit("unrelated.ts", "export const mainOnly = 1;", "separate requirement");
  const finalBase = start === "pushed-branch" ? firstBase : mainTip;
  git(upstream, "switch", "-c", "local-tuning", start === "pushed-branch" ? "initial" : "main");
  const final = commit("service.ts", "export const retries = 3;", "adjust retries");
  git(upstream, "update-server-info");
  const versionReads: string[] = [], requests: string[] = [], logs: string[] = [];
  let origin = "";
  const platform = createServer((req, res) => {
    const url = new URL(req.url!, origin);
    requests.push(url.pathname);
    if (url.pathname === "/mr/detail") {
      const mr = url.searchParams.get("mr_url")!, iid = mr.split("/").at(-1)!;
      const version = url.searchParams.get("version_head");
      if (version) versionReads.push(version);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({url:mr, iid, repo:origin + "/team/repo.git", source_branch:iid === "1" ? "initial" : "local-tuning",
        target_branch:"main", state:iid === "1" ? "closed" : "merged", sha:iid === "1" ? firstBase : final,
        base_sha:iid === "2" ? finalBase : undefined, merged_at:"2026-10-30T09:00:00Z",
        version: iid === "1" && version === initial ? {head:initial, base:firstBase} : undefined}));
      return;
    }
    if (url.pathname === "/mr/gates") { res.end(JSON.stringify({mr_state:"opened",source_sha:initial,gates:[]})); return; }
    // 通过本地只读 HTTP 提供真正的 Git 对象；最终代码最初不在任务工作区。
    const name = url.pathname.replace(/^\/team\/repo\.git\//, "");
    if (/^(?:HEAD|info\/refs|objects\/(?:info\/packs|[a-f0-9]{2}\/[a-f0-9]{38}|pack\/pack-[a-f0-9]{40}\.(?:pack|idx)))$/.test(name)) {
      const path = join(upstream, ".git", name);
      if (existsSync(path) && statSync(path).isFile()) { res.end(readFileSync(path)); return; }
    }
    res.writeHead(404); res.end();
  });
  origin = await listen(platform);
  const mr = (i: number) => origin + "/team/repo/-/merge_requests/" + i;
  const initialDocs = join(workspace, "delivery-experience");
  if (initialPublished) {
    mkdirSync(initialDocs); writeFileSync(join(initialDocs, "first.json"), JSON.stringify({mr:mr(1),head:initial}));
  }
  const delivery = initialPublished ? {mr_url:mr(1),mr_id:1,source_branch:"initial",target_branch:"main"}
    : start === "pushed-branch" ? {git_push:{sha:initial, ref:"refs/heads/initial", remote:"origin", url:origin + "/team/repo.git"}} : undefined;
  writeFileSync(join(workspace, "task.json"), JSON.stringify({cwd:start === "no-code" ? undefined : local, summary:{
    id:"task-1", title:"重试次数", requirement:"修改重试次数", created_at:"2026-10-29T00:00:00Z", updated_at:"2026-10-29T08:00:00Z",
    status:initialPublished ? "await_merge" : "paused", workspace, baseline:"main", repo_url:origin + "/team/repo.git",
    delivery,
  }}));
  const reviewsPath = join(dataDir, "reviews.jsonl");
  const reviews = new ReviewStore(reviewsPath);
  const invitation = reviews.create({ taskId: "task-1", taskTitle: "重试次数", requester: "owner", committer: "bob" });
  const completedReview = reviews.create({ taskId: "task-1", taskTitle: "重试次数", requester: "owner", committer: "carol" });
  reviews.complete(completedReview.id, "carol");
  const service = new TaskService({dataDir,log:message => logs.push(message),provider:"test",model:"test",modelsJson:{},maxConcurrent:0,delivery:{platformUrl:origin,pollIntervalMs:100}});
  const api = createTaskServer(service);
  const baseUrl = await listen(api);
  t.after(async () => {
    api.closeAllConnections(); await new Promise<void>(r => api.close(() => r()));
    await service.shutdown();
    platform.closeAllConnections(); await new Promise<void>(r => platform.close(() => r()));
    rmSync(root, {recursive:true,force:true});
  });
  service.recover();
  const taskApi = baseUrl + "/tasks/task-1";
  const link = await fetch(taskApi + "/final-mr", {method:"POST",body:JSON.stringify({url:mr(2)})});
  const result = await link.json() as TaskSummary;
  assert.equal(link.status, 200, JSON.stringify(result)); assert.equal(result.status, "completed");
  const storedReviews = new ReviewStore(reviewsPath).list();
  assert.equal(storedReviews.find(row => row.id === invitation.id)?.status, "canceled",
    "MR 合入结束任务时立即关闭待检视邀请，不等工作台刷新");
  assert.equal(storedReviews.find(row => row.id === completedReview.id)?.status, "completed");
  assert.equal(service.listReviewsFor("bob")[0].status, "canceled");
  assert.equal(service.completeReview(invitation.id, "bob").status, "canceled",
    "过期的完成按钮不能将邀请关闭冒充检视完成");
  await assert.rejects(service.requestReview("task-1", "owner", "bob"), /任务已结束/);
  assert.equal(result.completed_at, "2026-10-30T09:00:00.000Z"); assert.equal(result.delivery?.initial_mr?.head, initialPublished ? initial : undefined);
  assert.equal(result.delivery?.mr_url, initialPublished ? mr(1) : undefined);
  let comparison: MrComparisonDetail | undefined;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const r = await fetch(taskApi + "/final-mr-comparison?generation=initial");
    if (r.ok) { comparison = await r.json() as MrComparisonDetail; break; }
    await delay(50);
  }
  const report = await (await fetch(baseUrl + "/delivery-analytics")).json() as DeliveryAnalysisReport;
  const row = report.rows.find((r: {id:string}) => r.id === "task-1");
  assert.ok(row); assert.ok(comparison, JSON.stringify({row,requests,logs})); assert.deepEqual(versionReads, initialPublished ? [initial] : []);
  assert.equal(row.merged, true); assert.equal(row.mr_url, mr(2)); assert.equal(row.initial_mr_url, initialPublished ? mr(1) : undefined);
  if (start === "pushed-branch") {
    assert.equal(result.delivery?.source_branch, "initial");
    assert.equal(result.delivery?.final_mr?.source_branch, "local-tuning");
    assert.equal(row.mr_comparison?.reference, "platform_push");
    assert.equal(row.mr_comparison?.initial_head, initial);
    assert.equal(row.metric?.retained.review, 1);
  } else if (initialPublished) {
    assert.deepEqual(row.metric?.retained, { first: 0, pipeline: 0, review: 1, other: 0 });
    assert.equal(row.metric?.content_comparison?.reference, "local_snapshot");
  } else assert.equal(row.metric, undefined, "单笔外部提交缺少来源证据，不猜测三类占比");
  assert.equal(row.final_code_lines, 1, "最终 MR 修改一行服务代码，目标分支的其他文件不计");
  assert.equal(row.final_deleted_lines, initialPublished ? 2 : 1);
  assert.deepEqual(comparison.files.map((f:{path:string}) => f.path), ["service.ts"]);
  if (start !== "no-code") {
    assert.match(comparison.files[0]!.change_patch, /retries = 1/);
    assert.match(comparison.files[0]!.final_patch, /retries = 3/);
    assert.equal(git(local, "rev-parse", "HEAD"), initial);
  } else {
    assert.equal(result.delivery?.initial_mr, undefined);
    assert.equal(row.external_collaboration, true);
    assert.equal(row.mr_comparison?.method, "final");
    assert.equal(comparison.comparison_basis, "final");
    assert.match(comparison.files[0]!.change_patch, /-export const retries = 0/);
    assert.match(comparison.files[0]!.change_patch, /\+export const retries = 3/);
    assert.equal(existsSync(local), false);
    await assert.rejects(service.continueDelivery("task-1", "再改一次", "next-round", "owner"), /工作分支.*main.*新任务/);
  }
}
