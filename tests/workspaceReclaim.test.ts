/**
 * 现场回收的契约。
 *
 * 用户 2026-08-22 拍板:保留期两周、可配置、按任务算;
 * 并且明确加了一句——"**可以清除编译环境啥的,但是交付历史数据啥的不要
 * 清除**"。所以这个文件里最重的一条是"交付历史逐项点名还在",
 * 而不是"腾出了多少磁盘"。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  humanBytes,
  judgeReclaim,
  reclaimWorkspace,
  KERNEL_STATE_SNAPSHOT,
  ARCHIVED_DOCUMENTS_DIR,
  withinDataDir,
} from "../src/workspaceReclaim.ts";
import { listArtifacts, readArtifact, resolveArtifactRoot, bundleArtifactDocuments } from "../src/artifacts.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-08-22T12:00:00Z");

function daysAgo(days: number): string {
  return new Date(NOW - days * DAY).toISOString();
}

function candidate(patch: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    status: "completed",
    workspace: "/tmp/ws",
    completed_at: daysAgo(30),
    ...patch,
  } as Parameters<typeof judgeReclaim>[0];
}

/** 造一个"什么都有"的现场:交付历史 + 编译环境各一份。 */
function fullWorkspace(): { workspace: string; dataDir: string } {
  // 真形态里 dataDir/task-N 才是现场,夹具照这个来——
  // 直接拿 mkdtemp 当现场会让边界闸永远看不到真正的父子关系。
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaim-"));
  const workspace = join(dataDir, "task-1");
  mkdirSync(workspace, { recursive: true });
  // —— 交付历史与证据(一个字节都不许动)——
  writeFileSync(join(workspace, "task.json"), JSON.stringify({
    summary: {
      id: "task-1", status: "completed",
      delivery: { mr_url: "https://内网/mr/42", pipeline: "全绿", sha: "abc123" },
    },
  }));
  writeFileSync(join(workspace, "events.jsonl"), '{"kind":"tool_finished"}\n');
  writeFileSync(join(workspace, "transcript.jsonl"), '{"role":"assistant"}\n');
  mkdirSync(join(workspace, "transcript", "subagents"), { recursive: true });
  writeFileSync(
    join(workspace, "transcript", "subagents", "agent-c1.jsonl"), "{}\n");
  mkdirSync(join(workspace, "prepush", "round-1-abc123"), { recursive: true });
  writeFileSync(
    join(workspace, "prepush", "round-1-abc123", "transcript.jsonl"), "{}\n");
  writeFileSync(join(workspace, "annotations.jsonl"), '{"text":"这里要留后四位"}\n');
  mkdirSync(join(workspace, "reviews"), { recursive: true });
  writeFileSync(join(workspace, "reviews", "discussions.json"), "[]");
  writeFileSync(join(workspace, "review_replies.md"), "# 答复");
  writeFileSync(join(workspace, "pipeline-facts.json"), '{"sha":"abc123"}');
  mkdirSync(join(workspace, "pipeline"), { recursive: true });
  writeFileSync(join(workspace, "pipeline", "compile.log"), "BUILD SUCCESS");
  writeFileSync(join(workspace, "waiting.json"), "{}");
  writeFileSync(join(workspace, "chain-plan.md"), "# 链方案");
  writeFileSync(join(workspace, "unit-brief.md"), "# 当前单元任务书");

  // —— 编译环境(可以清)——
  // 克隆目录名是按仓库地址算出来的,不是固定的 "origin":
  // cloneRepo 用 basename(source) 去掉 .git。黑名单点不全这种名字。
  const clone = join(workspace, "notify-service");
  mkdirSync(join(clone, ".git"), { recursive: true });
  writeFileSync(join(clone, ".mae-flow.json"),
    JSON.stringify({ current: "end", config: { lane: "完整开发" } }));
  writeFileSync(join(clone, "big.jar"), "x".repeat(4096));
  mkdirSync(join(workspace, "repositories", "另一个仓"), { recursive: true });
  writeFileSync(join(workspace, "repositories", "另一个仓", "pom.xml"), "<p/>");
  mkdirSync(join(workspace, "pi-agent"), { recursive: true });
  writeFileSync(join(workspace, "pi-agent", "models.json"),
    JSON.stringify({ apiKey: "sk-绝不该留在盘上" }));
  return { workspace, dataDir };
}

/* ---------------- 判据 ---------------- */

test("真终态 + 过了保留期才回收", () => {
  assert.equal(
    judgeReclaim(candidate(), { now: NOW, retentionDays: 14 }).reclaim, true);
  const fresh = judgeReclaim(
    candidate({ completed_at: daysAgo(3) }), { now: NOW, retentionDays: 14 });
  assert.equal(fresh.reclaim, false);
  assert.match(fresh.reason, /未到保留期 14 天/);
});

test("还等着人或等着流水线的单,现场不碰", () => {
  // await_merge:MR 建了等人合入,现场可能还要看;
  // verifying:流水线还在跑。两个都不是"这单办完了"。
  for (const status of ["await_merge", "verifying", "waiting_for_human",
                        "running", "paused", "queued", "failed"]) {
    const verdict = judgeReclaim(
      candidate({ status }), { now: NOW, retentionDays: 14 });
    assert.equal(verdict.reclaim, false, `${status} 不该被回收`);
    assert.match(verdict.reason, /不可自动回收/);
  }
  // 明确取消的任务可以回收，失败任务必须留出恢复机会。
  for (const status of ["canceled"]) {
    assert.equal(judgeReclaim(candidate({ status }),
      { now: NOW, retentionDays: 14 }).reclaim, true);
  }
});

test("句柄还活着就不碰:状态是收口那一刻写的,清理和收尾会擦肩而过", () => {
  const verdict = judgeReclaim(
    candidate(), { now: NOW, retentionDays: 14, busy: true });
  assert.equal(verdict.reclaim, false);
  assert.match(verdict.reason, /活的会话或容器/);
});

test("保留期 0 = 永不回收,而且是明说的,不是偷偷不干活", () => {
  const verdict = judgeReclaim(candidate(), { now: NOW, retentionDays: 0 });
  assert.equal(verdict.reclaim, false);
  assert.match(verdict.reason, /永不回收/);
});

test("判不了年纪就不下手:没有可信收口时间宁可留着占地方", () => {
  const verdict = judgeReclaim(
    candidate({ completed_at: undefined, updated_at: undefined }),
    { now: NOW, retentionDays: 14 });
  assert.equal(verdict.reclaim, false);
  assert.match(verdict.reason, /判不了年纪/);
  // completed_at 缺席时退到 updated_at,不是直接放弃。
  assert.equal(judgeReclaim(
    candidate({ completed_at: undefined, updated_at: daysAgo(30) }),
    { now: NOW, retentionDays: 14 }).reclaim, true);
});

test("回收过就不再回收(也不再被重新裁决)", () => {
  const verdict = judgeReclaim(
    candidate({ workspace_reclaimed_at: daysAgo(1) }),
    { now: NOW, retentionDays: 14 });
  assert.equal(verdict.reclaim, false);
  assert.match(verdict.reason, /已经回收过/);
});

/* ---------------- 真删:这一条最重 ---------------- */

test("交付历史一个字节都不动——用户点名要求,逐项验", () => {
  const { workspace, dataDir } = fullWorkspace();
  const before = readFileSync(join(workspace, "task.json"), "utf-8");
  reclaimWorkspace(workspace, { cwd: join(workspace, "notify-service"), dataDir });

  // 1. 交付账本原样:MR 地址、流水线结论、绑定 SHA 全在。
  const after = readFileSync(join(workspace, "task.json"), "utf-8");
  assert.equal(after, before, "task.json 里就是交付账本,回收不许碰它");
  assert.match(after, /内网\/mr\/42/);

  // 2. 过程与证据。
  for (const path of [
    ["events.jsonl"],
    ["transcript.jsonl"],
    ["transcript", "subagents", "agent-c1.jsonl"],
    ["prepush", "round-1-abc123", "transcript.jsonl"],
    ["pipeline-facts.json"],
    ["pipeline", "compile.log"],
    ["waiting.json"],
    ["chain-plan.md"],
    ["unit-brief.md"],
  ]) {
    assert.ok(existsSync(join(workspace, ...path)),
      `${path.join("/")} 属于交付历史,不许清`);
  }

  // 3. 人自己写的字——最不可再生的东西。
  assert.equal(readFileSync(join(workspace, "annotations.jsonl"), "utf-8"),
    '{"text":"这里要留后四位"}\n');
  assert.ok(existsSync(join(workspace, "reviews", "discussions.json")));
  assert.ok(existsSync(join(workspace, "review_replies.md")));
});

test("只清明确的代码克隆和临时运行目录", () => {
  const { workspace, dataDir } = fullWorkspace();
  const result = reclaimWorkspace(
    workspace, { cwd: join(workspace, "notify-service"), dataDir });

  // 克隆叫 notify-service(按仓库地址算出来的),不叫 origin——
  // 这正是不能用黑名单的原因。
  assert.equal(existsSync(join(workspace, "notify-service")), false);
  assert.equal(existsSync(join(workspace, "repositories")), false,
    "多仓分析现场也是克隆");
  assert.equal(existsSync(join(workspace, "pi-agent")), false,
    "pi 会话临时目录里躺着 models.json,里面有 apiKey");
  assert.ok(result.freed > 4000, `应释放出 big.jar 那 4KB,实际 ${result.freed}`);
  assert.ok(result.removed.includes("notify-service"));
});

test("删克隆之前先把内核阶段真相抄下来:两周后还答得上停在哪一步", () => {
  const { workspace, dataDir } = fullWorkspace();
  const result = reclaimWorkspace(
    workspace, { cwd: join(workspace, "notify-service"), dataDir });
  assert.equal(result.snapshotted, true);
  const snapshot = JSON.parse(
    readFileSync(join(workspace, KERNEL_STATE_SNAPSHOT), "utf-8"));
  assert.equal(snapshot.current, "end");
  // 名字里带 reclaimed:它是封存副本,不是第二个状态机,不许被当活状态读。
  assert.match(KERNEL_STATE_SNAPSHOT, /reclaimed/);
});

test("回收是幂等的:再来一次不炸,也没什么可删了", () => {
  const { workspace, dataDir } = fullWorkspace();
  reclaimWorkspace(workspace, { cwd: join(workspace, "notify-service"), dataDir });
  const again = reclaimWorkspace(workspace, { cwd: join(workspace, "notify-service"), dataDir });
  assert.deepEqual(again.removed, []);
  assert.equal(again.freed, 0);
  assert.ok(existsSync(join(workspace, "task.json")));
  assert.ok(existsSync(join(workspace, "annotations.jsonl")));
});

test("回收代码后需求与新增文档、修订历史、图片、Story 和交付报告原样保留，原入口可阅读和下载过程文档", () => {
  const { workspace, dataDir } = fullWorkspace(), cwd = join(workspace, "notify-service");
  const files = {
    "requirement-input.md": "完整需求正文",
    "requirement-history/revision.before.md": "需求修改前的正文",
    "requirement-history/revision.diff": "需求修改差异",
    "overall-story/state.json": JSON.stringify({ current: "00000000-0000-0000-0000-000000000001", revisions: [{ id: "00000000-0000-0000-0000-000000000001" }] }),
    "overall-story/revisions/00000000-0000-0000-0000-000000000001/story.md": "全局 Story 正文",
    "交付报告.md": "这次交付的摘要",
    "交付经验复盘.md": "这次交付的复盘",
    "delivery-summary/state.json": "摘要生成记录",
    "delivery-experience/state.json": "经验整理记录",
    "新增加的文档目录/设计说明.md": "未来新增的文档也不能误删",
  };
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(workspace, name, ".."), { recursive: true });
    writeFileSync(join(workspace, name), content);
  }
  const work = join(cwd, ".mae-flow-work", "REQ1");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, ".ticket-id"), "REQ1");
  writeFileSync(join(work, "spec.md"), "# 需求约束\n全文保留");
  writeFileSync(join(work, "story.md"), "# 本次 Story\n全文保留");
  writeFileSync(join(work, "diagram.png"), Buffer.from([0, 1, 2, 255]));
  const assets = join(workspace, ".mae-flow-work", "requirement-assets");
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, "uploaded.png"), Buffer.from([3, 4, 5, 255]));

  const result = reclaimWorkspace(workspace, { cwd, dataDir });
  assert.equal(result.refused, undefined); assert.equal(existsSync(cwd), false, "代码克隆可以删除");
  for (const [name, content] of Object.entries(files)) assert.equal(readFileSync(join(workspace, name), "utf8"), content, name);
  assert.deepEqual(readFileSync(join(assets, "uploaded.png")), Buffer.from([3, 4, 5, 255]));
  const root = resolveArtifactRoot(workspace, cwd);
  assert.equal(root, join(workspace, ARCHIVED_DOCUMENTS_DIR));
  assert.deepEqual(readFileSync(join(root!, ".mae-flow-work", "REQ1", "diagram.png")), Buffer.from([0, 1, 2, 255]));
  const sources = { taskMaterialRoot: workspace };
  for (const name of ["REQ1/spec.md", "REQ1/story.md", "task-materials/交付报告.md", "task-materials/交付经验复盘.md", "task-materials/overall-story.md"]) {
    assert.ok(listArtifacts(root, sources).some(item => item.name === name), name);
    assert.ok(readArtifact(root, name, sources)?.content, name);
  }
  assert.ok(bundleArtifactDocuments(root, sources), "原打包下载入口仍有完整文档");
  assert.deepEqual(reclaimWorkspace(workspace, { cwd, dataDir }).removed, []);
});

test("多仓回收先保存分析文档和各仓文稿，同名单号的文稿不会覆盖", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaim-multiple-")), workspace = join(dataDir, "task-1"), cwd = join(workspace, "repositories");
  for (const repo of ["", "1-core", "2-api"]) {
    const root = join(cwd, repo, ".mae-flow-work", "REQ1");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "spec.md"), repo || "总体设计");
  }
  const result = reclaimWorkspace(workspace, { cwd, dataDir });
  assert.equal(result.refused, undefined); assert.equal(existsSync(cwd), false);
  const archive = join(workspace, ARCHIVED_DOCUMENTS_DIR);
  assert.equal(readFileSync(join(archive, ".mae-flow-work", "REQ1", "spec.md"), "utf8"), "总体设计");
  for (const repo of ["1-core", "2-api"]) assert.equal(readFileSync(join(archive, "source-materials", "repositories", repo, ".mae-flow-work", "REQ1", "spec.md"), "utf8"), repo);
});

test("文档无法安全保存时不删除代码，未知目录和错误 cwd 也不能成为清理目标", () => {
  const { workspace, dataDir } = fullWorkspace(), cwd = join(workspace, "notify-service");
  const work = join(cwd, ".mae-flow-work", "REQ1");
  mkdirSync(work, { recursive: true });
  symlinkSync(join(workspace, "task.json"), join(work, "spec.md"));
  const refused = reclaimWorkspace(workspace, { cwd, dataDir });
  assert.match(refused.refused!, /文档保存失败/); assert.deepEqual(refused.removed, []); assert.ok(existsSync(cwd));
  unlinkSync(join(work, "spec.md"));
  const documents = join(workspace, "new-documents");
  mkdirSync(documents); writeFileSync(join(documents, "design.md"), "设计原文");
  assert.equal(reclaimWorkspace(workspace, { cwd: documents, dataDir }).refused, undefined);
  assert.equal(readFileSync(join(documents, "design.md"), "utf8"), "设计原文");
});

test("现场不存在时不炸,而且按越界处理:删除动作宁可不做", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaim-"));
  const result = reclaimWorkspace(join(dataDir, "task-404"), { dataDir });
  assert.equal(result.freed, 0);
  assert.deepEqual(result.removed, []);
  assert.match(String(result.refused), /不在本服务的数据目录/);
});

/* ---------------- 边界闸:这条是拿真现场的血换来的 ---------------- */

test("现场不在本服务数据目录内 → 一个字节都不删", () => {
  // 2026-08-22 实测踩到的事:summary.workspace 是任务创建时写死的**绝对
  // 路径**,而 recover() 是按 dataDir/task-N 扫目录认任务的。把现场目录
  // 拷一份出来排障时,恢复出来的任务带着老路径,回收照着老路径下手——
  // 删的是原件。读侧按老路径读只是读不到,删侧按老路径删是真没了。
  const { workspace } = fullWorkspace();          // 现场在 A 的 dataDir 下
  const otherDataDir = mkdtempSync(join(tmpdir(), "mfc-other-"));
  const result = reclaimWorkspace(workspace, {
    cwd: join(workspace, "notify-service"), dataDir: otherDataDir,
  });
  assert.match(String(result.refused), /拒绝删除/);
  assert.deepEqual(result.removed, []);
  assert.ok(existsSync(join(workspace, "notify-service")), "越界还把克隆删了");
  assert.ok(existsSync(join(workspace, "task.json")));
});

test("dataDir 自己不算「在里面」:别把整个数据目录端了", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaim-"));
  assert.equal(withinDataDir(dataDir, dataDir), false);
  assert.equal(withinDataDir(join(dataDir, "task-1"), dataDir), false,
    "不存在的子目录也不放行(realpath 解不出来就当越界)");
  mkdirSync(join(dataDir, "task-1"));
  assert.equal(withinDataDir(join(dataDir, "task-1"), dataDir), true);
});

test("软链接不许绕过边界:比的是 realpath,不是字符串前缀", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-reclaim-"));
  const outside = mkdtempSync(join(tmpdir(), "mfc-outside-"));
  // 字符串上看 <dataDir>/task-1 明明在里面,realpath 一解就到外面了。
  symlinkSync(outside, join(dataDir, "task-1"));
  assert.equal(withinDataDir(join(dataDir, "task-1"), dataDir), false);
});

test("释放量说人话", () => {
  assert.equal(humanBytes(0), "0B");
  assert.equal(humanBytes(2048), "2.0KB");
  assert.equal(humanBytes(15 * 1024 * 1024), "15MB");
});
