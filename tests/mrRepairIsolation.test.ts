import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { saveState, type IssueSessionState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";
import { issueApiUrl, issueSessionPath } from "../web/src/issues/issueLink.ts";

const now = new Date().toISOString();
function state(id: string, repair = false): IssueSessionState {
  return { id, account: "dev", title: repair ? "独立工具记录" : "真实 DTS", description: "", created_at: now, updated_at: now,
    source: "manual", status: "idle", scenario: repair ? "mr_repair" : "ticket", stage: "mr_green", stage_at: now, stage_note: "",
    round: 1, stage_states: repair ? ["done"] : ["done", "done", "done", "done", "done"],
    ...(repair ? { imported_mr: { url: "https://codehub.test/t/r/merge_requests/1", iid: "1", repo: "https://codehub.test/t/r.git", title: "fix",
      source_branch: "feature", target_branch: "main", sha: "a".repeat(40), state: "opened" as const } } : { ticket: "DTS-REAL-1" }) };
}
const options = (dataDir: string) => ({ dataDir, provider: "maeflow", model: "unused", modelsJson: {} });

test("共享工作台按编号选择工具链接，普通问题的链接与接口不变", () => {
  assert.equal(issueSessionPath("issue-1"), "/issues/issue-1");
  assert.equal(issueApiUrl("/issues/issue-1/conversation"), "/issues/issue-1/conversation");
  assert.equal(issueSessionPath("mr-repair-1"), "/pipeline-repairs/mr-repair-1");
  assert.equal(issueApiUrl("/issues/mr-repair-1/materials/diff?repo=a"), "/pipeline-repairs/mr-repair-1/materials/diff?repo=a");
  assert.equal(issueApiUrl("/issues?scope=all"), "/issues?scope=all");
});
async function route(service: IssueFlowService, path: string, method = "GET", payload?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const request: any = new EventEmitter(); request.method = method; request.url = path;
    let status = 0;
    void handleIssueRoutes(request, { writeHead: (value: number) => { status = value; }, end: (text: string) => resolve({ status, body: JSON.parse(text) }) } as any,
      path.split("/").filter(Boolean), { issueFlow: service, viewer: { username: "dev", role: "developer" }, authEnabled: true }).catch(reject);
    if (payload) request.emit("data", Buffer.from(JSON.stringify(payload))); request.emit("end");
  });
}

test("工具记录物理隔离：普通问题、团队 DTS 和统计 API 只看到真实问题；工具停止不生成交付快照", async () => {
  const dataDir = mfcTemp("mr-repair-isolation-");
  saveState(join(dataDir, "issues", "issue-1"), state("issue-1"));
  saveState(join(dataDir, "pipeline-repairs", "mr-repair-1"), state("mr-repair-1", true));
  const issues = new IssueFlowService(options(dataDir)), repairs = issues.createPipelineRepairTool();
  try {
    assert.deepEqual(issues.list().map(row => row.id), ["issue-1"]);
    assert.deepEqual(repairs.list().map(row => row.id), ["mr-repair-1"]);
    const rates = issues.onceRates(), generated = issues.onceGeneratedStats(), registered = issues.registrationStats();
    assert.deepEqual((await route(issues, "/issues")).body.issues.map((row: any) => row.id), ["issue-1"]);
    assert.equal((await route(issues, "/issues/mr-repair-1")).status, 404);
    assert.equal((await route(repairs, "/pipeline-repairs/issue-1")).status, 404);
    for (const path of ["dts", "once-generated", "registration-stats", "stats"]) {
      assert.equal((await route(repairs, `/pipeline-repairs/${path}`)).status, 404);
    }
    assert.equal((await route(repairs, "/pipeline-repairs/mr-repair-1/control", "POST", { action: "archive" })).status, 400);
    assert.equal(repairs.get("mr-repair-1").status, "idle");
    await repairs.control("mr-repair-1", { action: "cancel" });
    assert.equal(existsSync(join(dataDir, "pipeline-repairs", "mr-repair-1", "metrics.json")), false);
    assert.equal(existsSync(join(dataDir, "pipeline-repairs", "mr-repair-1", "code-origin.json")), false);
    assert.deepEqual(issues.onceRates(), rates);
    assert.deepEqual(issues.onceGeneratedStats(), generated);
    assert.deepEqual(issues.registrationStats(), registered);
  } finally { await repairs.shutdown(); await issues.shutdown(); }
});

test("已有混用记录迁出并保留现场，原归档工具记录恢复为完成记录，重启不会重复迁移", async () => {
  const dataDir = mfcTemp("mr-repair-migration-");
  const original = state("issue-2", true); original.status = "archived";
  original.conclusion = { kind: "delivered", summary: "旧版本自动归档", at: now };
  const oldRoot = join(dataDir, "issues", "issue-2");
  saveState(oldRoot, original); mkdirSync(join(oldRoot, "repo")); writeFileSync(join(oldRoot, "repo", "repair.txt"), "保留修复代码");
  writeFileSync(join(oldRoot, "events.jsonl"), "{\"kind\":\"kept\"}\n");
  saveState(join(dataDir, "issues", "issue-1"), state("issue-1"));
  let issues = new IssueFlowService(options(dataDir)), repairs = issues.createPipelineRepairTool();
  const migratedId = "mr-repair-legacy-issue-2", root = join(dataDir, "pipeline-repairs", migratedId);
  try {
    assert.equal(existsSync(oldRoot), false);
    assert.equal(readFileSync(join(root, "repo", "repair.txt"), "utf8"), "保留修复代码");
    assert.equal(readFileSync(join(root, "events.jsonl"), "utf8"), "{\"kind\":\"kept\"}\n");
    assert.equal(repairs.get(migratedId).status, "idle");
    assert.equal(repairs.get(migratedId).conclusion, undefined);
    assert.deepEqual(issues.list().map(row => row.id), ["issue-1"]);
  } finally { await repairs.shutdown(); await issues.shutdown(); }
  issues = new IssueFlowService(options(dataDir)); repairs = issues.createPipelineRepairTool();
  try { assert.equal(repairs.list().length, 1); assert.equal(repairs.list()[0].id, migratedId); }
  finally { await repairs.shutdown(); await issues.shutdown(); }
});
