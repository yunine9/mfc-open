/**
 * 归档快照两层代码现场取数(工单 #326,ADR-0042):提交归属比对
 * (MR 完整提交清单 vs 推送账,逐提交标注平台/平台外)与逐推送
 * diff 统计(文件数/增删行/仅源码增删行,扩展名白名单)。
 *
 * 覆盖:
 * 1. MR 清单含平台外提交(直接往假远端分支推一笔非平台提交):
 *    归属逐提交标注正确,含「平台推送后外部续推、再被平台接着推」
 *    的中间外部提交;
 * 1b. MR 已真实合入目标分支(非 squash):清单区间=合入提交的第一父
 *    ..合入头——合入后 MR 提交全部可达自目标分支,拿目标分支画界
 *    会恒空(本次收口修的缺陷);
 * 2. 逐推送 diff 数字正确:多文件、增删混合,md 与二进制不进
 *    「仅源码」行(白名单生效);
 * 3. 强推:被顶掉的平台提交不在 MR 清单,但推送事实层的记录与
 *    次数不受影响;
 * 4. 降级:工作区缺失 / 远端不可达——对应段标「不可得」,归档与
 *    快照其余部分照常(fetch 不可得但合入头在本地时,清单退回本地
 *    合入头现算并如实标注口径)。
 *
 * 范式:issuePushBranch 的假远端(bareOrigin)+ issueMetricsSnapshot
 * 的快照断言;种子现场直接写 issue.json,纯构建函数直测。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import {
  buildIssueMetricsSnapshot,
  writeIssueMetricsSnapshot,
  SOURCE_CODE_EXTENSIONS,
  isSourcePath,
  ISSUE_METRICS_FILE,
  type IssueMetricsAttributionRepo,
  type IssueMetricsAttributionRepoOk,
  type IssueMetricsPushDiff,
  type IssueMetricsPushDiffEntry,
  type IssueMetricsSnapshot,
  type IssueMetricsUnavailable,
} from "../src/issueFlow/metricsSnapshot.ts";
import { mfcTemp } from "./mfcTmp.ts";

const TICKET = "DTS-2026-3302";
const ACCOUNT = "dev";
const BRANCH = `master_${ACCOUNT}_${TICKET}`;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "agent",
  GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent",
  GIT_COMMITTER_EMAIL: "agent@example.com",
};

function rawGit(args: string[]): void {
  execFileSync("git", args, { env: GIT_ENV });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    env: GIT_ENV, encoding: "utf-8",
  }).trim();
}

/** 造一个裸仓远端(master 基线一笔 readme.md),返回其路径。 */
function bareOrigin(root: string, name = "origin"): string {
  const seed = join(root, `seed-${name}`);
  rawGit(["init", "-q", "-b", "master", seed]);
  writeFileSync(join(seed, "readme.md"), "基线\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "基线:master 起点");
  const origin = join(root, `${name}.git`);
  rawGit(["clone", "-q", "--bare", seed, origin]);
  return origin;
}

/** 会话现场:克隆远端到 <会话根>/repo/<仓名> 并切好修复分支
 * (issueRepoWorkspaces 的目录映射,仓名取地址末段去 .git)。 */
function seedWorkspace(sessionRoot: string, origin: string, name = "origin")
  : string {
  const dir = join(sessionRoot, "repo", name);
  rawGit(["clone", "-q", origin, dir]);
  git(dir, "checkout", "-q", "-b", BRANCH);
  return dir;
}

/** 工作区里落一笔提交(文件表:路径→内容,二进制传 Buffer)。 */
function commitFiles(dir: string, message: string, files: Record<string, string | Buffer>)
  : void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

/** 平台推送:工作区推修复分支到远端,返回完整提交号(账面记前 12 位)。 */
function pushPlatform(dir: string): string {
  git(dir, "push", "-q", "origin", BRANCH);
  return git(dir, "rev-parse", "HEAD");
}

interface SeedOptions {
  /** 转移账「分支已推送」逐笔的提交号(前 12 位)。 */
  pushShas: string[];
  /** MR 账:合入头(完整 40 位;缺席=MR 未合入)。 */
  mergedSha?: string;
  status?: IssueSessionState["status"];
}

/** 种子一份带推送账与 MR 账的会话(issue.json),返回状态对象。 */
function seedState(root: string, origin: string, options: SeedOptions)
  : IssueSessionState {
  const now = new Date().toISOString();
  const state: IssueSessionState = {
    id: "issue-1", account: ACCOUNT, reporter: ACCOUNT,
    created_at: now, updated_at: now,
    title: "归属比对夹具", description: "", source: "dts", ticket: TICKET,
    repo_url: origin, repo_urls: [origin],
    scenario: "ticket", round: 1,
    stage_states: ["done", "done", "done", "done", "pending"],
    status: options.status ?? "archived",
    stage: "mr_green", stage_note: "", stage_at: now,
    pushes: options.pushShas.length
      ? [{ repo: origin, branch: BRANCH,
          sha: options.pushShas.at(-1)!, at: now }]
      : [],
    mrs: [{
      repo: origin, branch: BRANCH, target: "master",
      title: `[${TICKET}] 归属比对夹具`, at: now,
      ...(options.mergedSha
        ? { merged_at: now, merged_sha: options.mergedSha }
        : {}),
    }],
    conclusion: { kind: "delivered", summary: "修复完成", at: now },
    transitions: options.pushShas.map((sha) => ({
      at: now, source: "platform" as const,
      note: `分支已推送 ${origin} ${BRANCH} @ ${sha}`,
    })),
  };
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify(state, null, 1));
  return state;
}

// ---- 断言取值助手(降级段当场 fail,取强类型字段) ----

const isUnavailable = (value: unknown): value is IssueMetricsUnavailable =>
  Boolean(value) && typeof value === "object"
  && typeof (value as IssueMetricsUnavailable).unavailable === "string";

function attributionOf(snapshot: IssueMetricsSnapshot) {
  const layer = snapshot.commit_attribution;
  if (isUnavailable(layer)) {
    assert.fail(`归属层不该整层降级:${layer.unavailable}`);
  }
  return layer;
}

function attributionOk(entry: IssueMetricsAttributionRepo)
  : IssueMetricsAttributionRepoOk {
  if (isUnavailable(entry)) {
    assert.fail(`归属段不该降级:${entry.unavailable}`);
  }
  return entry;
}

function pushDiffOf(entry: IssueMetricsPushDiffEntry): IssueMetricsPushDiff {
  if (isUnavailable(entry)) {
    assert.fail(`diff 段不该降级:${entry.unavailable}`);
  }
  return entry;
}

function diffLayerOf(snapshot: IssueMetricsSnapshot) {
  const layer = snapshot.per_push_diffs;
  if (isUnavailable(layer)) {
    assert.fail(`diff 层不该整层降级:${layer.unavailable}`);
  }
  return layer;
}

function diffRepoOf(snapshot: IssueMetricsSnapshot) {
  const repo = diffLayerOf(snapshot).by_repo[0]!;
  if (isUnavailable(repo)) {
    assert.fail(`diff 仓段不该降级:${repo.unavailable}`);
  }
  return repo;
}

// ---- 1. 提交归属:MR 清单含平台外提交 ----

test("归属比对:平台外续推的中间提交在 MR 清单里,逐提交标注平台/平台外", () => {
  const dataDir = mfcTemp("mfc-issue-attr-external-");
  const origin = bareOrigin(dataDir);
  const root = join(dataDir, "issues", "issue-1");
  const ws = seedWorkspace(root, origin);

  // 平台第一推(推送账第 1 笔)。
  commitFiles(ws, `[${TICKET}][fix] 平台提交一`, { "src/a.ts": "修复\n" });
  const p1 = pushPlatform(ws);

  // 平台外提交:另一份克隆直接推同一远端分支(平台推送之间的外部动作)。
  const external = join(dataDir, "external");
  rawGit(["clone", "-q", origin, external]);
  git(external, "checkout", "-q", BRANCH);
  execFileSync("git", [
    "-C", external, "commit", "-q", "--allow-empty",
    "-m", "外部续推:人工补一处配置",
  ], {
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: "外部同事",
      GIT_AUTHOR_EMAIL: "ext@corp.example",
      GIT_COMMITTER_NAME: "外部同事",
      GIT_COMMITTER_EMAIL: "ext@corp.example",
    },
  });
  git(external, "push", "-q", "origin", BRANCH);

  // 平台第二推:先快进带上外部提交(不改写平台提交号),再续一笔。
  git(ws, "fetch", "-q", "origin");
  git(ws, "merge", "-q", "--ff-only", `origin/${BRANCH}`);
  commitFiles(ws, `[${TICKET}][fix] 平台提交二`, { "src/c.ts": "收尾\n" });
  const p2 = pushPlatform(ws);

  const state = seedState(root, origin,
    { pushShas: [p1.slice(0, 12), p2.slice(0, 12)], mergedSha: p2 });
  const snapshot = buildIssueMetricsSnapshot(root, state);

  const entry = attributionOk(attributionOf(snapshot).by_repo[0]!);
  assert.equal(entry.repo, origin);
  assert.equal(entry.list_basis, "merge_base",
    "未合入:没有合入提交可定位,清单按分叉点..合入头口径");
  assert.deepEqual(entry.commits.map((commit) => commit.origin),
    ["platform", "external", "platform"],
    "平台/平台外/平台:中间外部提交在清单且标注正确");
  assert.deepEqual(entry.commits.map((commit) => commit.sha),
    [p1, entry.commits[1]!.sha, p2], "清单从旧到新,两端是平台提交");
  assert.equal(entry.commits[1]!.author, "外部同事");
  assert.match(entry.commits[1]!.subject, /外部续推/);
  assert.equal(entry.platform_count, 2);
  assert.equal(entry.external_count, 1);

  // diff 层顺带在场:两笔推送、首笔从分支起点起算。
  const diffs = diffRepoOf(snapshot);
  assert.equal(diffs.pushes.length, 2);
  assert.equal(pushDiffOf(diffs.pushes[0]!).base_kind, "branch_start");
});

// ---- 1b. 已合入现场:清单区间=合入提交的第一父..合入头 ----

test("归属比对:MR 已真实合入目标分支——清单定位合入提交,不恒空", () => {
  const dataDir = mfcTemp("mfc-issue-attr-merged-");
  const origin = bareOrigin(dataDir);
  const root = join(dataDir, "issues", "issue-1");
  const ws = seedWorkspace(root, origin);

  // 平台一推。
  commitFiles(ws, `[${TICKET}][fix] 平台提交一`, { "src/a.ts": "修复\n" });
  const p1 = pushPlatform(ws);

  // 平台外提交:另一份克隆直接推同一远端分支。
  const external = join(dataDir, "external");
  rawGit(["clone", "-q", origin, external]);
  git(external, "checkout", "-q", BRANCH);
  execFileSync("git", [
    "-C", external, "commit", "-q", "--allow-empty",
    "-m", "外部续推:人工补一处配置",
  ], {
    env: {
      ...GIT_ENV,
      GIT_AUTHOR_NAME: "外部同事",
      GIT_AUTHOR_EMAIL: "ext@corp.example",
      GIT_COMMITTER_NAME: "外部同事",
      GIT_COMMITTER_EMAIL: "ext@corp.example",
    },
  });
  git(external, "push", "-q", "origin", BRANCH);

  // 平台二推:快进带上外部提交,再续一笔。
  git(ws, "fetch", "-q", "origin");
  git(ws, "merge", "-q", "--ff-only", `origin/${BRANCH}`);
  commitFiles(ws, `[${TICKET}][fix] 平台提交二`, { "src/c.ts": "收尾\n" });
  const p2 = pushPlatform(ws);
  const externalSha = git(ws, "rev-parse", "HEAD~1");

  // 真实合入:维护者克隆把修复分支非快进合入 master 并推远端——此后
  // MR 提交全部可达自目标分支,「目标分支..合入头」口径恒空,归属必须
  // 靠定位合入提交(第一父=合入前的 master 头)来画界。
  const integrator = join(dataDir, "integrator");
  rawGit(["clone", "-q", origin, integrator]);
  git(integrator, "merge", "-q", "--no-ff", "-m", `Merge ${BRANCH}`,
    `origin/${BRANCH}`);
  git(integrator, "push", "-q", "origin", "master");

  const state = seedState(root, origin,
    { pushShas: [p1.slice(0, 12), p2.slice(0, 12)], mergedSha: p2 });
  const snapshot = buildIssueMetricsSnapshot(root, state);

  const entry = attributionOk(attributionOf(snapshot).by_repo[0]!);
  assert.equal(entry.list_basis, "merge_commit",
    "目标分支历史里定位到合入提交,区间=其第一父..合入头");
  assert.deepEqual(entry.commits.map((commit) => commit.sha),
    [p1, externalSha, p2], "合入后清单仍三笔全在,从旧到新");
  assert.deepEqual(entry.commits.map((commit) => commit.origin),
    ["platform", "external", "platform"], "合入后逐提交归属标注正确");
  assert.equal(entry.commits[1]!.author, "外部同事", "平台外提交的作者如实记录");
  assert.equal(entry.platform_count, 2);
  assert.equal(entry.external_count, 1);
});

// ---- 2. 逐推送 diff:数字与源码白名单 ----

test("逐推送 diff:文件数/增删行正确,md 与二进制不进仅源码行", () => {
  const dataDir = mfcTemp("mfc-issue-attr-diff-");
  const origin = bareOrigin(dataDir);
  const root = join(dataDir, "issues", "issue-1");
  const ws = seedWorkspace(root, origin);

  // 首笔:md 改一行(+1)、新源码两文件(+3/+2)、二进制一个(无行数)。
  commitFiles(ws, `[${TICKET}][fix] 首推`, {
    "readme.md": "基线\n更新一行\n",
    "src/a.ts": "a\nb\nc\n",
    "src/b.ts": "x\ny\n",
    "bin/logo.dat": Buffer.from([0x00, 0x01, 0x00, 0xff]),
  });
  const p1 = pushPlatform(ws);
  // 第二笔:只改源码,增 2 删 1。
  commitFiles(ws, `[${TICKET}][fix] 续推`, { "src/a.ts": "a\nc\nd\ne\n" });
  const p2 = pushPlatform(ws);

  const state = seedState(root, origin,
    { pushShas: [p1.slice(0, 12), p2.slice(0, 12)], mergedSha: p2 });
  const snapshot = buildIssueMetricsSnapshot(root, state);

  const diffs = diffRepoOf(snapshot);
  const first = pushDiffOf(diffs.pushes[0]!);
  assert.equal(first.sha, p1.slice(0, 12));
  assert.equal(first.base_kind, "branch_start", "首笔从分支起点起算");
  assert.equal(first.files, 4, "md/源码/二进制都计文件数");
  assert.equal(first.insertions, 6, "md +1 与源码 +3+2");
  assert.equal(first.deletions, 0);
  assert.equal(first.source_insertions, 5, "仅源码:+3+2(md 与二进制不掺水)");
  assert.equal(first.source_deletions, 0);

  const second = pushDiffOf(diffs.pushes[1]!);
  assert.equal(second.sha, p2.slice(0, 12));
  assert.equal(second.base_kind, "previous_push", "第二笔=上一笔..本笔");
  assert.equal(second.base, p1.slice(0, 12));
  assert.equal(second.files, 1);
  assert.equal(second.insertions, 2);
  assert.equal(second.deletions, 1);
  assert.equal(second.source_insertions, 2);
  assert.equal(second.source_deletions, 1);

  // 归属顺带:全平台提交,零平台外。
  const entry = attributionOk(attributionOf(snapshot).by_repo[0]!);
  assert.equal(entry.platform_count, 2);
  assert.equal(entry.external_count, 0);

  // 白名单本体:源码与配置类后缀在内,文档后缀不在。
  assert.ok(SOURCE_CODE_EXTENSIONS.has("ts")
    && SOURCE_CODE_EXTENSIONS.has("py") && SOURCE_CODE_EXTENSIONS.has("sh"));
  assert.ok(SOURCE_CODE_EXTENSIONS.has("json") && SOURCE_CODE_EXTENSIONS.has("xml")
    && SOURCE_CODE_EXTENSIONS.has("yaml") && SOURCE_CODE_EXTENSIONS.has("yml")
    && SOURCE_CODE_EXTENSIONS.has("properties"), "2026-09-22 扩入配置类后缀");
  assert.ok(!SOURCE_CODE_EXTENSIONS.has("md") && !SOURCE_CODE_EXTENSIONS.has("dat"));
  // 判定函数:大小写归一,无后缀/整名点文件不算。
  assert.ok(isSourcePath("src/app.json") && isSourcePath("cfg/app.properties"));
  assert.ok(isSourcePath("a/b.XML") && !isSourcePath("Makefile") && !isSourcePath(".gitignore"));
});

// ---- 3. 强推:顶掉的平台提交不在 MR 清单,事实层照全 ----

test("强推:被顶掉的平台提交不在 MR 清单,推送账的记录与次数不受影响", () => {
  const dataDir = mfcTemp("mfc-issue-attr-force-");
  const origin = bareOrigin(dataDir);
  const root = join(dataDir, "issues", "issue-1");
  const ws = seedWorkspace(root, origin);

  commitFiles(ws, `[${TICKET}][fix] 会被顶掉的提交`, { "src/old.ts": "旧解\n" });
  const p1 = pushPlatform(ws);
  // 平台强推:回退到基线重写(同分叉点另起一笔),强推覆盖远端。
  git(ws, "reset", "-q", "--hard", "HEAD~1");
  commitFiles(ws, `[${TICKET}][fix] 重写后的提交`, { "src/new.ts": "新解\n" });
  git(ws, "push", "-q", "--force", "origin", BRANCH);
  const p2 = git(ws, "rev-parse", "HEAD");

  const state = seedState(root, origin,
    { pushShas: [p1.slice(0, 12), p2.slice(0, 12)], mergedSha: p2 });
  const snapshot = buildIssueMetricsSnapshot(root, state);

  // MR 清单:只有合入头可达的提交——被顶掉的 P1 不在(未被合入属正常)。
  const entry = attributionOk(attributionOf(snapshot).by_repo[0]!);
  assert.deepEqual(entry.commits.map((commit) => commit.sha), [p2],
    "被强推顶掉的平台提交不在 MR 清单");
  assert.equal(entry.platform_count, 1);
  assert.equal(entry.external_count, 0);

  // 推送事实层:两笔推送全量保留(次数与提交号清单)。
  assert.equal(snapshot.pushes.total, 2, "强推不减推送次数");
  assert.deepEqual(snapshot.pushes.by_repo[0]!.commits,
    [p1.slice(0, 12), p2.slice(0, 12)], "被顶掉的提交仍在推送账投影");

  // diff 层:两笔区间都可算(对象都还在工作区)。
  const diffs = diffRepoOf(snapshot);
  assert.equal(diffs.pushes.length, 2);
  assert.equal(pushDiffOf(diffs.pushes[1]!).base, p1.slice(0, 12),
    "第二笔区间=被顶掉的提交..新头");
});

// ---- 4. 降级:工作区缺失 / 远端不可达 ----

test("降级:工作区缺失——两层标不可得,归档照常、快照其余部分照写", () => {
  const dataDir = mfcTemp("mfc-issue-attr-reclaim-");
  const origin = join(dataDir, "origin.git");
  const root = join(dataDir, "issues", "issue-1");
  // 现场已回收:只有账,没有 repo/ 克隆(远端地址也无需真实存在)。
  const state = seedState(root, origin, {
    pushShas: ["a".repeat(12)],
    mergedSha: "ab".repeat(20),
  });

  const result = writeIssueMetricsSnapshot(root, state);
  assert.equal(result.written, true, "降级不得阻塞快照落盘");
  assert.ok(result.degraded.includes("commit_attribution.by_repo[0]")
    && result.degraded.includes("per_push_diffs.by_repo[0]"),
    `缺项路径在列:${result.degraded.join("、")}`);

  const snapshot = JSON.parse(
    readFileSync(join(root, ISSUE_METRICS_FILE), "utf-8")) as IssueMetricsSnapshot;
  const attributionDown = attributionOf(snapshot).by_repo[0]!;
  if (!isUnavailable(attributionDown)) assert.fail("归属段应标不可得");
  assert.match(attributionDown.unavailable, /工作区没有该仓的克隆/);
  const diffDown = diffLayerOf(snapshot).by_repo[0]!;
  if (!isUnavailable(diffDown)) assert.fail("diff 段应标不可得");
  assert.match(diffDown.unavailable, /工作区没有该仓的克隆/);
  // 其余部分照常:事实投影完整、快照定格为归档终态。
  assert.equal(snapshot.terminal_status, "archived");
  assert.equal(snapshot.pushes.total, 1);
  assert.deepEqual(snapshot.pushes.by_repo[0]!.commits, ["a".repeat(12)]);
  assert.equal(snapshot.mrs.total, 1);
});

test("降级:远端不可达——合入头在本地则清单退回本地现算并标注口径,否则标不可得", () => {
  const dataDir = mfcTemp("mfc-issue-attr-unreachable-");
  const origin = bareOrigin(dataDir);
  const root = join(dataDir, "issues", "issue-1");
  const ws = seedWorkspace(root, origin);
  commitFiles(ws, `[${TICKET}][fix] 本地可算`, { "src/fix.ts": "修复\n第二行\n" });
  const p1 = pushPlatform(ws);

  // 远端不可达:挪走裸仓(fetch 必败)。
  renameSync(origin, `${origin}.gone`);

  // 甲:合入头(merged_sha)在本地——清单退回本地现算,口径如实标注。
  const state = seedState(root, origin,
    { pushShas: [p1.slice(0, 12)], mergedSha: p1 });
  const snapshot = buildIssueMetricsSnapshot(root, state);
  const entry = attributionOk(attributionOf(snapshot).by_repo[0]!);
  assert.equal(entry.list_basis, "merged_sha_local",
    "fetch 不可得,退回本地合入头");
  assert.deepEqual(entry.commits.map((commit) => commit.sha), [p1]);
  assert.equal(entry.platform_count, 1);
  // diff 层只读本地对象:远端死活不影响。
  const diffs = diffRepoOf(snapshot);
  const first = pushDiffOf(diffs.pushes[0]!);
  assert.equal(first.base_kind, "branch_start");
  assert.equal(first.files, 1);
  assert.equal(first.insertions, 2);

  // 乙:fetch 不可得且没有合入头——归属段如实标不可得,其余照写。
  delete state.mrs![0]!.merged_sha;
  delete state.mrs![0]!.merged_at;
  const degraded = buildIssueMetricsSnapshot(root, state);
  const down = attributionOf(degraded).by_repo[0]!;
  if (!isUnavailable(down)) assert.fail("无合入头可退,归属段应标不可得");
  assert.match(down.unavailable, /fetch .*失败|远端/);
  assert.equal(degraded.pushes.total, 1, "推送事实层不受影响");
});
