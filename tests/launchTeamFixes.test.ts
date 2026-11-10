/**
 * 2026-09-02 检视 codex 的"主任务讨论参与人"改动后修的三处小毛病。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";

test("原位重跑沿用已受邀的参与人:别人的个人设置过期不挡主责任人重跑", async () => {
  const ready = new Set(["alice", "bob"]);
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-rerun-collab-")),
    provider: "a", model: "a-1", maxConcurrent: 0,
    modelsJson: { providers: { a: { models: [{ id: "a-1" }] } } },
    host: { kernelRoot: discoverKernelRoot(process.cwd())! },
    collaborationAssigneeReadiness: (account) => ready.has(account)
      ? { ready: true, missing: [] }
      : { ready: false, missing: ["CodeHub Token"] },
  });
  const parent = service.create("跨仓主任务", {
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    account: "owner", collaborators: ["alice"],
  });
  assert.deepEqual(parent.collaborators, ["alice"]);
  await service.cancel(parent.id, "owner");
  assert.equal(service.get(parent.id)!.status, "canceled");
  // alice 的令牌过期了。受邀时已核过就绪,之后就绪与否在她自己行动时再查。
  ready.delete("alice");
  assert.throws(() => service.create("新单仍要核就绪", {
    repos: ["https://codehub/team/api.git", "https://codehub/team/web.git"],
    account: "owner", collaborators: ["alice"],
  }), /alice 的个人设置尚未就绪/, "新下单照旧拦");
  const rerun = await service.rerunFromStart(parent.id);
  assert.equal(rerun.status, "queued");
  assert.deepEqual(rerun.collaborators, ["alice"], "重跑不丢参与人、不被她挡住");
  await service.shutdown();
});

test("下单页:没有大需求开关(2026-09-03 起单仓也没有);名单读不到就清空邀请并说清", () => {
  const launch = readFileSync(join(process.cwd(), "web/src/LaunchWorkspace.tsx"), "utf-8");
  // 多仓天然先形成主任务共同分析;单仓拆不拆由 Agent 读完仓后提议,下单页
  // 不再摆任何"大需求"开关。
  assert.doesNotMatch(launch, /analysisEligible && !multiRepository && \(/);
  assert.match(launch, /analysisEligible && multiRepository && \(/);
  assert.match(launch, /多个代码仓会先形成主任务共同分析/);
  // 名单读不到时文案说"本次不邀请其他人",动作也真的清空——不再让草稿里的
  // 参与人以"未就绪"卡住发起。
  assert.match(launch, /setCollaborators\(\[\]\);\s*setCollaborationAssigneesError\(/);
  assert.match(launch, /本次发起不邀请其他人/);
});
