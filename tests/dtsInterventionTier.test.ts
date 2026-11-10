/**
 * 会话级介入档位(ADR-0057):发起前按单定档,创建即定格。
 * - 路由:发起带 intervention_tier 落盘并上 wire;非法值 400 打回
 * - 覆盖读取:特例会话的开场词用特例档,不吃全局改档(全局恒二档对照)
 * - 跟随全局:不带字段的会话开场词仍按账号全局档渲染
 * - 服务直调兜底:非法值打回,半截登记不落盘
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueControlError } from "../src/issueFlow/errors.ts";
import { loadState } from "../src/issueFlow/state.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { saveProductVersion } from "../src/configurationCenter.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交的裸仓远端(模块绑定的仓),返回其路径。 */
function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  return join(root, "origin.git");
}

/** POST 版(带 JSON 体),走真路由(无 HTTP 服务器)。 */
function issuePost(
  parts: string[],
  payload: unknown,
  service: IssueFlowService,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false,
        viewer: { username: "alice", role: "developer" }, ...extra },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
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

test("发起带档:创建即定格上 wire,开场词用特例档不吃全局(ADR-0057)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-tier-"));
  const origin = bareOrigin(dataDir);
  createBusinessModule(dataDir, {
    id: "pay-core", name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  saveProductVersion(dataDir, { version: "V100R025C10", branch: "master" });
  const fakeDts = {
    listByOwner: async () => [],
    detail: async (ticket: string) => ({
      ticket, version: "V100R025C10SPC010B009",
    }),
  };
  // 单轮文本剧本:每会话恰好一次模型请求,请求即开场词。
  const script: Scene[] = [{ text: "收到,按当前介入节奏推进。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  // 全局恒二档:特例会话若吃到全局,开场词就还是报告检视档——红。
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    interventionTier: () => "2",
  });
  try {
    // 特例:发起前选「全自动」。
    const created = await issuePost(["issues"], {
      account: "dev",
      title: "支付对账偶发不平",
      source: "dts",
      ticket: "DTS20260901020",
      module_id: "pay-core",
      intervention_tier: "1",
    }, service, { dts: fakeDts });
    assert.equal(created.status, 201);
    assert.equal(created.body.intervention_tier, "1", "特例上 wire");
    await until(() => {
      const issue = service.get(created.body.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "特例会话首轮收口");
    const state = loadState(join(dataDir, "issues", created.body.id));
    assert.equal(state?.intervention_tier, "1", "特例定格落盘");
    // 催办轮会复述阶段机,按标题定位会话自己的开场请求,别按序号数。
    assert.match(JSON.stringify(model.requests.find((row) =>
      JSON.stringify(row).includes("支付对账偶发不平"))),
    /介入节奏\(全自动档\)/, "开场词用特例档,不吃全局二档");

    // 对照:同账号不带字段 → 跟随全局,开场词按二档渲染。
    const follow = await issuePost(["issues"], {
      account: "dev",
      title: "消息网关重复消费",
      source: "dts",
      ticket: "DTS20260901021",
      module_id: "pay-core",
    }, service, { dts: fakeDts });
    assert.equal(follow.status, 201);
    assert.equal(follow.body.intervention_tier, undefined,
      "跟随全局不造字段");
    await until(() => {
      const issue = service.get(follow.body.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "idle" ? issue : undefined;
    }, "跟随会话首轮收口");
    assert.equal(
      loadState(join(dataDir, "issues", follow.body.id))?.intervention_tier,
      undefined, "跟随全局不落盘");
    assert.match(JSON.stringify(model.requests.find((row) =>
      JSON.stringify(row).includes("消息网关重复消费"))),
    /介入节奏\(优先报告档\)/, "无特例开场词按账号全局档渲染");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("发起带档:非法值 400 打回,指路三档(ADR-0057)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-tier-bad-"));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    for (const bad of ["9", "auto", true]) {
      const rejected = await issuePost(["issues"], {
        account: "dev",
        title: "t",
        source: "dts",
        ticket: "DTS20260901022",
        module_id: "whatever",
        intervention_tier: bad,
      }, service);
      assert.equal(rejected.status, 400, `非法值 ${String(bad)} 打回`);
      assert.match(String(rejected.body.error), /介入档位/);
    }
    // 空串/null=没选:按跟随全局放行(不落档位字段)。后续分支闸
    // (无网关读不到版本)会 400,但错误必须是分支的,不是档位的。
    const tolerated = await issuePost(["issues"], {
      account: "dev",
      title: "t",
      source: "dts",
      ticket: "DTS20260901023",
      module_id: "pay-core",
      intervention_tier: "",
    }, service);
    assert.equal(tolerated.status, 400, "空串跳过档位校验,落到下游闸");
    assert.doesNotMatch(String(tolerated.body.error), /介入档位不合法/);
  } finally {
    void service.shutdown().catch(() => undefined);
  }
});

test("服务直调兜底:非法档位打回,半截登记不落盘(ADR-0057)", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-dts-tier-svc-"));
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  void service.shutdown().catch(() => undefined);
  assert.throws(
    () => service.create({
      account: "dev",
      title: "t",
      // @ts-expect-error 直调方传非法值,运行时兜底校验兜住
      interventionTier: "9",
    }),
    IssueControlError,
  );
  assert.equal(loadState(join(dataDir, "issues", "issue-1")), undefined,
    "校验在烧号之前,盘上无半截会话");
});
