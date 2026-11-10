/**
 * 合入状态循环的返工轮补启动(#319):
 *  1. 返工(环境验证不通过→回退→第二轮)重新进入「提交MR·跑绿」阶段后,
 *     第二轮推送分支时合入状态循环一并跑起来——不依赖进程重启,MR 被
 *     人在平台上提前合入的事实当轮就能记账;
 *  2. 尚无 MR 记录的会话,推送不启动合入状态循环(「有 MR 才监看」);
 *  3. 循环已在跑时再挂流水线监看,不出现第二条并行循环(单例挡板)。
 *
 * 范式与 issueMergeFact 同款:ScriptedModelServer 剧本模型 +
 * FakeGitPlatform 假交付平台,只走公开 API 断言。用例 3 额外直接种
 * issue.json 现场(服务构造即走恢复路径,恢复路径本身就是循环的第一
 * 个启动点,正好充当「已在跑」的前提)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-1001";

const fastPoll = {
  models: () => ({}),
  runtime: () => ({
    poll_interval_s: 1, poll_timeout_s: 120,
  }),
};

const gitCred = () =>
  ({ username: "dev", password: "git-token", email: "dev@example.com" });

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) assert.fail(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 等指定闸出现并按码作答。 */
async function answerGate(
  service: IssueFlowService,
  id: string,
  kind: string,
  code: string,
  what: string,
): Promise<void> {
  await until(() => {
    const snapshot = service.get(id);
    return snapshot.status === "waiting_user"
      && snapshot.gate?.kind === kind ? snapshot : undefined;
  }, `${what}:${kind} 闸出现`);
  const version = service.get(id).gate!.state_version;
  service.answer(id, { state_version: version, code });
}

/** 四章节报告(submit_analysis 的机械门票)。 */
const report = () =>
  `printf '%s\\n' '# 问题分析:登录超时' '一句话总结:连接池耗尽,扩容并回收。' \\
    '## 问题现象' '登录超时。' '## 问题根因' '连接池耗尽。' \\
    '## 修改方案' '超时回收。' \\
    '## 置信度' '高:日志直接指向。' > issue-analysis.md`;

/** 建一个带 master 种子提交的裸仓远端(假平台的交付目标)。 */
function seedOrigin(
  platform: FakeGitPlatform,
  dataDir: string,
): string {
  const sourceDir = join(dataDir, "source");
  execFileSync("git", ["init", "-q", "-b", "master", sourceDir]);
  execFileSync("git", ["-C", sourceDir, "-c", "user.name=t", "-c",
    "user.email=t@e", "commit", "-q", "--allow-empty", "-m", "seed"]);
  // 会话基线分支要在远端在架:pull_repo 按基线克隆(#441)。
  execFileSync("git", ["-C", sourceDir, "branch", "br_V100R026C10_release"]);
  return platform.initBare(sourceDir, dataDir);
}

/** 假平台侧收到过的 /mr/gates 查询次数(合入状态循环的每秒一拍)。 */
const gatesCount = (platform: FakeGitPlatform) =>
  platform.seenIdentity.filter((entry) => entry.path === "/mr/gates").length;

/** 等合入状态循环安静下来:1.5 秒窗口内没有任何 /mr/gates 查询。
 * 剧本回合跑得比轮询间隔还快,回退后不加这道闸,上一轮循环可能还
 * 没走到退出检查,测试就把阶段推回了 mr_green。 */
async function untilMergeLoopQuiet(platform: FakeGitPlatform): Promise<void> {
  for (;;) {
    const before = gatesCount(platform);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    if (gatesCount(platform) === before) return;
  }
}

test("返工第二轮进 mr_green:推送分支即带上合入状态循环,合入事实不依赖重启就记账", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-relight-");
  const platform = new FakeGitPlatform();
  const origin = seedOrigin(platform, dataDir);
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
    // 第一轮:修完进「提交MR·跑绿」,推送、建 MR、申报(流水线默认绿,
    // 当场收口),AI 举出环境验证卡。
    { tool: { name: "complete_stage", input: { note: "修复完成,UT 15/15" } } },
    { tool: { name: "bash",
      input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { tool: { name: "create_mr", input: {} } },
    { tool: { name: "complete_stage",
      input: { note: "MR 已申报", mrs: [origin] } } },
    { tool: { name: "raise_gate", input: { kind: "env_verify" } } },
    { text: "验证卡已举出,等待用户验证。" },
    // 返工第二轮:重新分析确认后,修完再推分支(与真实流程同形:推送
    // 属于「提交MR·跑绿」阶段,此刻阶段已在 mr_green)。
    { tool: { name: "bash", input: { command: report() } } },
    { tool: { name: "submit_analysis",
      input: { summary: "根因补充=回收不及时,方案=立即回收" } } },
    { text: "第二轮分析已提交。" },
    { tool: { name: "complete_stage", input: { note: "第二轮修复完成" } } },
    { tool: { name: "bash",
      input: { command: commit(`[${TICKET}][fix] 第二轮修复`) } } },
    { tool: { name: "push_branch", input: {} } },
    { text: "第二轮修复已推送,等流水线结果。" },
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
    gitCredential: gitCred,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    await answerGate(service, created.id,
      "analysis_confirm", "confirm", "第一轮分析确认");
    await answerGate(service, created.id,
      "env_verify", "fail", "第一轮环境验证不通过");
    // 回退现场锚定:轮次+1、阶段回问题分析、MR 台账延用。
    const rolled = await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.stage === "analyze" && snapshot.round === 2
        && snapshot.mrs?.length ? snapshot : undefined;
    }, "环境验证不通过后回退第二轮");
    const firstSha = rolled.pushes![0].sha;
    assert.equal(rolled.mrs?.length, 1, "回退延用第一轮 MR 台账");
    // 等第一轮的合入状态循环退出干净(阶段已离开 mr_green,循环最多
    // 再睡一拍就散),第二轮的事实才只能由新的启动点记到。
    await untilMergeLoopQuiet(platform);
    // 第二轮流水线保持 running:不让收口路启动合入状态循环,合入事实
    // 只能由循环本身记到。
    platform.nextPipelineStatus = "running";
    await answerGate(service, created.id,
      "analysis_confirm", "confirm", "第二轮分析确认");
    const pushed = await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.stage === "mr_green" && snapshot.status === "idle"
        && snapshot.pushes?.[0]?.sha
        && snapshot.pushes[0].sha !== firstSha ? snapshot : undefined;
    }, "第二轮推送回合收口");
    assert.equal(pushed.mrs?.length, 1, "第二轮仍延用同一 MR");
    // 人在平台上把 MR 合了:循环在跑,事实当轮入账(全程未重启进程)。
    // 按会话真实分支名结算(ADR-0063:分支名是时间戳新名,不再有常量)。
    platform.settleMr(pushed.pushes![0].branch, "merged");
    const merged = await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.mrs?.[0]?.merged_at ? snapshot : undefined;
    }, "返工轮 MR 提前合入事实入账(不依赖重启)");
    assert.match(merged.mrs![0].merged_sha ?? "", /^[0-9a-f]{40}$/,
      "merged_sha 照平台返回记");
    assert.equal(merged.pipelines?.[origin]?.watching, true,
      "流水线仍在监看(未收口)——记账只能来自合入状态循环");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("尚无 MR 的会话:推送不启动合入状态循环(有 MR 才监看)", async () => {
  const dataDir = mfcTemp("mfc-issue-merge-nomr-");
  const platform = new FakeGitPlatform();
  const origin = seedOrigin(platform, dataDir);
  await platform.start();
  const commit = (message: string) =>
    `cd repo/origin && git -c user.name=test -c user.email=t@e commit -q --allow-empty -m '${message}'`;
  // 走到「提交MR·跑绿」阶段并推送,但停在建 MR 之前——推送时台账上
  // 还没有任何 MR 记录。
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
    { tool: { name: "bash",
      input: { command: commit(`[${TICKET}][fix] 修复登录超时`) } } },
    { tool: { name: "push_branch", input: {} } },
    { text: "分支已推,还没建 MR。" },
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
    gitCredential: gitCred,
  });
  try {
    const created = service.create({
      account: "dev", title: "登录超时", ticket: TICKET,
      source: "dts", repoUrl: origin,
      baseline: "br_V100R026C10_release",
    });
    await answerGate(service, created.id,
      "analysis_confirm", "confirm", "分析确认");
    const pushed = await until(() => {
      const snapshot = service.get(created.id);
      return snapshot.stage === "mr_green" && snapshot.status === "idle"
        && snapshot.pushes?.[0]?.sha ? snapshot : undefined;
    }, "推送回合收口");
    assert.equal(pushed.mrs?.length ?? 0, 0, "现场:还没建 MR");
    assert.equal(pushed.pipelines?.[origin], undefined,
      "没建 MR 的仓不挂流水线监看");
    // 浸泡一会儿:没有任何 /mr/gates 查询——合入状态循环没被启动。
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(gatesCount(platform), 0,
      "尚无 MR 记录的会话不去查合入事实");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});

test("循环已在跑时再挂流水线监看:不出现第二条并行循环", async () => {
  // 单据号与分支名自洽(push_branch 的机械门禁按会话定名的修复分支
  // 核对;此现场是老会话升级形态——推送账记着旧格式名,门禁沿用旧名,
  // 与文件顶部的 DTS-2026-1001 各记各的)。
  const ticket = "DTS-2026-1002";
  const branch = `master_dev_${ticket}`;
  const dataDir = mfcTemp("mfc-issue-merge-single-");
  const platform = new FakeGitPlatform();
  const origin = seedOrigin(platform, dataDir);
  await platform.start();
  platform.nextPipelineStatus = "running";
  // 会话工作区:目标分支上两个提交,第二轮推送推第二个。
  const clone = join(dataDir, "issues", "issue-1", "repo", "origin");
  execFileSync("git", ["clone", "-q", origin, clone]);
  execFileSync("git", ["-C", clone, "checkout", "-q", "-b", branch]);
  const commitAt = (message: string) => {
    execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c",
      "user.email=t@e", "commit", "-q", "--allow-empty", "-m", message]);
  };
  commitAt("first");
  const revparse = () => execFileSync(
    "git", ["-C", clone, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  const sha1 = revparse();
  commitAt("second");
  const sha2 = revparse();
  // 种现场:「提交MR·跑绿」进行中、MR 台账在、第一提交的流水线监看
  // 已按终态处理(watching=false)。恢复路径启动合入状态循环;假平台
  // 不登记这个 MR,/mr/gates 查询失败,循环照常每秒一拍地轮询。
  const root = join(dataDir, "issues", "issue-1");
  mkdirSync(root, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id: "issue-1", account: "dev",
    created_at: now, updated_at: now,
    title: "合入循环单例", description: "", source: "dts",
    ticket,
    repo_url: origin, repo_urls: [origin],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "in_progress"],
    status: "idle", stage: "mr_green", stage_note: "", stage_at: now,
    pushes: [{ repo: origin, branch, sha: sha1, at: now }],
    mrs: [{ repo: origin, branch,
      title: `[${ticket}] 合入循环单例`,
      url: "http://loop.test/mr/1", at: now }],
    pipelines: {
      [origin]: {
        sha: sha1, status: "success", watching: false,
        started_at: now,
        deadline: new Date(Date.now() + 120_000).toISOString(),
        round: 1,
      },
    },
  }));
  const model = new ScriptedModelServer([
    { tool: { name: "push_branch", input: {} } },
    { text: "已推送第二个提交。" },
    { text: "收到,等申报。" },
  ], "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    dataDir,
    provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
    settings: fastPoll,
    dts: new MockDtsGateway(),
    platformUrl: platform.baseUrl,
    gitCredential: gitCred,
  });
  try {
    // 前提:恢复路径已把合入状态循环挂上(已在跑)。
    await until(() => (gatesCount(platform) > 0 ? true : undefined),
      "恢复后合入状态循环已在轮询");
    // 续聊唤醒:推送第二个提交 → 重挂流水线监看 → 合入状态循环被再次
    // 要求启动,应被单例挡板挡掉。
    service.reply("issue-1", "把第二个修复提交推上去。");
    await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.pipelines?.[origin]?.sha === sha2
        && snapshot.pipelines[origin].watching ? snapshot : undefined;
    }, "第二轮推送重挂流水线监看");
    await until(() => service.get("issue-1").status === "idle"
      ? true : undefined, "推送回合收口");
    // 流水线出绿 → 申报提醒回合(剧本第三幕收嘴)。
    platform.finishPipeline(sha2, "success");
    await until(() => {
      const snapshot = service.get("issue-1");
      return snapshot.status === "idle"
        && snapshot.pipelines?.[origin]?.watching === false
        ? snapshot : undefined;
    }, "跑绿处理与申报提醒回合收口");
    // 固定窗口内数 /mr/gates 查询:一条循环约每秒一拍,5 秒窗口最多
    // 6 次;出现第二条并行循环会翻倍到 8 次以上。
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const before = gatesCount(platform);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const delta = gatesCount(platform) - before;
    assert.ok(delta >= 2 && delta <= 6,
      `单条循环每秒一拍(5 秒窗口实测 ${delta} 次),不应出现第二条并行循环`);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    await platform.stop();
  }
});
