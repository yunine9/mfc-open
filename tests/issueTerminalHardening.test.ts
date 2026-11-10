/**
 * 体检③④修复的回归钉(2026-09-10,ADR-0020 验收句对照产物):
 * - 高洞(C-H1/C-H2):取消落在监看迭代内,监看收口/举闸/预算块都不得再写
 *   已终态会话——canceled 不被覆写成 waiting_user,不发"请人工"通知;
 * - C-H3:终态(挂起同款)会话不接受补配环境(防复活);
 * - C-H6:收口清面——终态会话不再投影闸/未决卡;
 * - C-H7:wire 不漏机制账(预绑锁退役字段、pipelines 重试/刹车子字段)。
 *
 * 范式与 issueMrDiscussions 同款:ScriptedModelServer + FakeGitPlatform。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { loadState, summarize, type IssueSessionState } from "../src/issueFlow/state.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";
const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 300,
  }),
};

async function until(probe: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`超时:${what}`);
}

const report = () =>
  `printf '%s\\n' '# 问题分析:登录超时' '一句话总结:连接池耗尽,扩容并回收。' \\
    '## 问题现象' '登录超时。' '## 问题根因' '连接池耗尽。' \\
    '## 修改方案' '超时回收。' \\
    '## 置信度' '高:日志直接指向。' > issue-analysis.md`;

/** 开到 mr_green 申报停等(流水线 running=监看循环在途)的现场。 */
async function watchFixture() {
  const dataDir = mfcTemp("mfc-issue-terminal-");
  const platform = new FakeGitPlatform();
  platform.nextPipelineStatus = "running";
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  // 会话基线分支要在远端在架:pull_repo 按基线克隆(#441,同 bareOrigin)。
  execFileSync("git", ["-C", sourceDir, "branch", "br_V100R026C10_release"]);
  const origin = platform.initBare(sourceDir, dataDir);
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  const script: Scene[] = [
    { tool: { name: "dts_get_ticket", input: {} } },
    { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: report() } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
    { text: "分析报告已提交,等待用户确认。" },
    { tool: { name: "complete_stage", input: { note: "修复完成,UT 15/15" } } },
    { tool: { name: "bash", input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage", input: { note: "MR 已申报", mrs: [origin] } } },
    { text: "MR 已申报,等待流水线。" },
    { text: "收到,继续处理。" },
    { text: "收到,继续处理。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: () =>
      ({ username: "dev", password: "git-token", email: "dev@example.com" }),
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET,
    source: "dts", repoUrl: origin,
    baseline: "br_V100R026C10_release",
  });
  await until(() => {
    const snapshot = service.get(created.id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === "analysis_confirm";
  }, "分析确认闸收口");
  return {
    id: created.id, origin, platform, model, service,
    /** 确认分析闸,让剧本继续走到申报停等。 */
    confirm: () => service.answer(created.id, {
      state_version: service.get(created.id).gate!.state_version,
      code: "confirm",
    }),
    stop: async () => {
      await model.stop();
      await platform.stop();
    },
  };
}

test("取消撞上监看迭代:终态不被监看收口/举闸/预算块覆写,环境补配拒绝", async () => {
  const scene = await watchFixture();
  try {
    scene.confirm();
    // 监看表挂上(watching=true)→ 循环在途,处于 sleep/fetch 节奏中。
    await until(() => {
      const watch = scene.service.get(scene.id).pipelines?.[scene.origin];
      return watch?.watching === true;
    }, "流水线监看挂表");
    // 在迭代窗口内取消(人的意志先行),随后平台才出红灯终态。
    await scene.service.control(scene.id, { action: "cancel" });
    assert.equal(scene.service.get(scene.id).status, "canceled");
    const sha = scene.service.get(scene.id).pushes!.at(-1)!.sha;
    scene.platform.finishPipeline(sha, "failed", "compile: 语义错误");
    // 等监看循环醒来跑完这一拍(两个轮询周期):任何收口路径都不得
    // 把 canceled 写回 waiting_user、不得落闸、不得发"请人工"。
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = scene.service.get(scene.id);
    assert.equal(after.status, "canceled", "终态不被覆写");
    assert.equal(after.gate, undefined, "不落新闸");
    assert.doesNotMatch(after.stage_note ?? "", /预算耗尽|请人工/,
      "预算块不给终态会话写停机note");
    // C-H3:终态会话拒绝补配环境(防复活)。
    await assert.rejects(
      async () => scene.service.attachEnvironment(scene.id, {
        hosts: ["192.0.2.3"], port: 22, env_type: "virtualized",
        backend_password: "x",
      } as never),
      /终态/, "终态会话不能补配环境");
  } finally {
    await scene.stop();
  }
});

test("收口清面:等待中的会话取消后,闸与未决卡不再投影", async () => {
  const scene = await watchFixture();
  try {
    // 现场正停在分析确认闸(waiting_user+gate)。
    const before = scene.service.get(scene.id);
    assert.equal(before.status, "waiting_user");
    assert.ok(before.gate, "取消前闸在场");
    await scene.service.control(scene.id, { action: "cancel" });
    const after = scene.service.get(scene.id);
    assert.equal(after.status, "canceled");
    assert.equal(after.gate, undefined, "终态不投影闸");
    assert.equal(after.waiting, undefined, "终态不投影未决卡");
  } finally {
    await scene.stop();
  }
});

test("wire 契约:预绑锁退役字段不上投影;pipelines 重试/刹车字段按镜像可见", () => {
  // 走真实读盘路径:盘上存量死账(字段已退役,ADR-0056)loadState 即剥,
  // 投影不携带;剥离点在读盘,不在投影。
  const root = mkdtempSync(join(tmpdir(), "mfc-wire-legacy-"));
  const state = {
    id: "issue-x", account: "dev", title: "t", status: "idle",
    created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z",
    scenario: "ticket", stage: "mr_green",
    stage_note: "", stage_at: "2026-09-10T00:00:00.000Z",
    module_locked: true,
    pipelines: {
      "http://r.git": {
        sha: "a".repeat(40), status: "failed", watching: true,
        started_at: "2026-09-10T00:00:00.000Z",
        deadline: "2026-09-10T00:30:00.000Z",
        round: 1,
        evidence_retry_deadline: "2026-09-10T00:10:00.000Z",
        evidence_retry_attempts: 2,
        evidence_failure_log: "compile: boom",
        last_repair_sha: "b".repeat(40),
        last_failure_summary: "compile 失败",
      },
    },
  } as unknown as IssueSessionState;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify(state));
  const wire = summarize(loadState(root)!) as Record<string, any>;
  assert.equal("module_locked" in wire, false, "module_locked 读盘即剥,不上 wire");
  const watch = wire.pipelines["http://r.git"];
  assert.equal(watch.sha, "a".repeat(40), "流水线主体照常投影");
  // 2026-09-10 勘定(C-H7 复议):重试窗/刹车五字段是测试与后续 UI 的
  // 可观察面——补前端镜像(api.ts)而非剥投影,整条记录按 wire 可见。
  for (const key of ["evidence_retry_deadline", "evidence_retry_attempts",
    "evidence_failure_log", "last_repair_sha", "last_failure_summary"]) {
    assert.ok(key in watch, `${key} 在投影(镜像已补)`);
  }
});
