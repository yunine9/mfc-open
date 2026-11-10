/**
 * 手动归档入口退役(ADR-0034 退役有单手动归档,ADR-0057 收尾连无单
 * 存量一并摘除):control 动作词只剩 cancel/revive,archive 一律 400
 * 打回;merge-status 随归档对话框一并退役(404)。手动终态唯一出口=
 * 取消,全场景可达;取消收尾走终态卫生尾巴(#434)——入队首次生成
 * 归属(code-origin.json 落盘可观察)。路由层钉协议,服务层钉取消。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { ISSUE_CODE_ORIGIN_FILE } from "../src/issueFlow/codeOrigin.ts";
import { mfcTemp } from "./mfcTmp.ts";

function issuePost(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => resolve({ status, text: output ?? "" }),
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

const BASE = {
  account: "dev", created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
  source: "manual" as const, stage: "fix", stage_note: "",
  stage_at: "2026-09-01T09:00:00Z",
};

async function controlScene(
  seed: Record<string, unknown>,
): Promise<{ id: string; service: IssueFlowService; root: string;
  stop: () => Promise<void> }> {
  const dataDir = mfcTemp("mfc-issue-archgate-");
  mkdirSync(join(dataDir, "issues", "issue-1"), { recursive: true });
  writeFileSync(join(dataDir, "issues", "issue-1", "issue.json"),
    JSON.stringify({ id: "issue-1", ...BASE, ...seed }));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  return {
    id: "issue-1", service, root: join(dataDir, "issues", "issue-1"),
    stop: () => service.shutdown().catch(() => undefined),
  };
}

test("control 动作词只剩 cancel/revive:archive 400 打回,merge-status 退役 404", async () => {
  const scene = await controlScene({
    ticket: "DTS202609000001", scenario: "ticket", status: "idle",
  });
  try {
    const archive = await issuePost(["issues", "issue-1", "control"],
      { action: "archive" }, scene.service);
    assert.equal(archive.status, 400, "archive 不再是合法动作词,fail-loud 打回");
    assert.match(archive.text, /只支持重跑\/取消/);
    const mergeStatus = await issuePost(["issues", "issue-1", "merge-status"],
      {}, scene.service);
    assert.equal(mergeStatus.status, 404, "归档对话框随手动归档一并退役");
  } finally {
    await scene.stop();
  }
});

test("取消是唯一手动终态出口:取消收尾入队归属(#434 终态卫生尾巴)", async () => {
  const scene = await controlScene({
    ticket: "DTS202609000001", scenario: "ticket", status: "idle",
    // 支持期内(conclusion.at 缺省回落 updated_at)才入队归属计算。
    updated_at: new Date().toISOString(),
    repo_urls: ["https://git.example.com/demo.git"],
  });
  try {
    const summary = await scene.service.control(scene.id, { action: "cancel" });
    assert.equal(summary.status, "canceled", "有单会话的取消出口不受影响");
    // 卫生尾巴的可见结果:伴生快照在后台通道落盘——漏掉这一步的单子
    // 会在达标率页顶着「待算」等每日清扫器兜底(#434 的病灶)。
    await until(
      () => existsSync(join(scene.root, ISSUE_CODE_ORIGIN_FILE)),
      "取消收尾入队首次生成归属(code-origin.json 落盘)");
  } finally {
    await scene.stop();
  }
});
