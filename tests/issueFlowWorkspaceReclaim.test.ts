/**
 * 问题会话工作区回收的契约(ADR-0073 白名单反转,#585)。
 *
 * 最重的三条:
 * 1. **保留名单一个字节都不许少**——归档会话的网页查看读 issue.json/
 *    反馈/事件/报告/附件/截图/日志,当场清之后这些必须原样活着;
 * 2. **名单外一律清**——Agent 自建的任何目录(命名再怪)与文件都不看
 *    体量、不看年龄,当场清直接删;repo/ 是服务专属路径的管辖,跳过;
 * 3. **保险丝**——非终态不碰;容器在跑跳过;旋钮 0 整体禁运;越界
 *    fail-closed;软链只解链不跟链。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ISSUE_WORKSPACE_KEEP_DIRS,
  ISSUE_WORKSPACE_KEEP_FILES,
  judgeIssueReclaim,
  reclaimIssueWorkspace,
  sweepIssueAttachmentStaging,
} from "../src/issueFlowWorkspaceReclaim.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 造一个"什么都有"的问题会话现场:保留名单 + 名单外重货各一份。 */
function sessionRoot(dataDir: string, id: string): string {
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "zhang", title: "订单模块 500",
    status: "archived", stage: "done",
  }, null, 1));
  // —— 保留名单(一个字节都不许动)——
  writeFileSync(join(root, "events.jsonl"),
    '{"kind":"stage_advanced","note":"定位到根因"}\n');
  writeFileSync(join(root, "transcript.jsonl"), '{"role":"assistant"}\n');
  writeFileSync(join(root, "knowledge-events.jsonl"), '{"kind":"knowledge"}\n');
  writeFileSync(join(root, "waiting.json"), "{}");
  writeFileSync(join(root, "issue-analysis.md"), "# 分析报告:连接池耗尽");
  mkdirSync(join(root, "feedback"), { recursive: true });
  writeFileSync(join(root, "feedback", "index.jsonl"),
    '{"source":"pipeline","status":"closed"}\n');
  mkdirSync(join(root, "attachments"), { recursive: true });
  writeFileSync(join(root, "attachments", "a3f.log"), "登记附件");
  mkdirSync(join(root, "issue-images"), { recursive: true });
  writeFileSync(join(root, "issue-images", "截图.png"), "人交的材料");
  mkdirSync(join(root, "ticket-images", "DTS-2026"), { recursive: true });
  writeFileSync(join(root, "ticket-images", "DTS-2026", "p.png"), "单据附件");
  mkdirSync(join(root, "local-logs", "网管A"), { recursive: true });
  writeFileSync(join(root, "local-logs", "网管A", "alarm.log"), "x".repeat(2048));
  mkdirSync(join(root, "pipeline", "mr-42"), { recursive: true });
  writeFileSync(join(root, "pipeline", "mr-42", "build.log"), "BUILD FAILURE");
  mkdirSync(join(root, "codecheck"), { recursive: true });
  writeFileSync(join(root, "codecheck", "transcript.jsonl"), '{"role":"assistant"}\n');
  mkdirSync(join(root, "warmup"), { recursive: true });
  writeFileSync(join(root, "warmup", "transcript.jsonl"), '{"role":"assistant"}\n');
  writeFileSync(join(root, "reviews.jsonl"), '{"text":"这里要写清阈值"}\n');
  mkdirSync(join(root, "reviews"), { recursive: true });
  writeFileSync(join(root, "reviews", "issue-analysis.v2.md"), "报告修订版");
  writeFileSync(join(root, "code-origin.json"), '{"ratio":0.83}');
  writeFileSync(join(root, "manual-edits.jsonl"), '{"path":"repo/svc/Main.java"}\n');

  // —— 名单外(当场清;命名学 Agent 的 9 种变体)——
  mkdirSync(join(root, "repo", "order-service", ".git"), { recursive: true });
  writeFileSync(join(root, "repo", "order-service", "pom.xml"), "<p/>");
  mkdirSync(join(root, "pi-agent"), { recursive: true });
  writeFileSync(join(root, "pi-agent", "models.json"), "{}");
  mkdirSync(join(root, "vision-cache"), { recursive: true });
  writeFileSync(join(root, "vision-cache", "img.json"), "{}");
  mkdirSync(join(root, ".ops-tools"), { recursive: true });
  writeFileSync(join(root, ".ops-tools", "fetch-logs-linux-amd64"), "ELF");
  mkdirSync(join(root, "skills", "java"), { recursive: true });
  writeFileSync(join(root, "skills", "java", "SKILL.md"), "# skill");
  mkdirSync(join(root, ".mae-flow-work"), { recursive: true });
  writeFileSync(join(root, ".mae-flow-work", "build-notes.md"), "notes");
  for (const variant of [".codecheck-home", ".codecheck-tmp", "cc-home",
                         ".codecheckcli-home"]) {
    mkdirSync(join(root, variant), { recursive: true });
    writeFileSync(join(root, variant, "cache.bin"), "y".repeat(1024));
  }
  writeFileSync(join(root, "stray-dump.bin"), "z".repeat(4096));
  return root;
}

function newDataDir(): string {
  return mfcTemp("mfc-issue-reclaim-");
}

/* ---------------- 名单外当场清 ---------------- */

test("当场清:名单外全删(含 Agent 自建变体与散文件),repo 跳过,保留名单一个字节不少", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1");

  const result = reclaimIssueWorkspace(root, { dataDir });

  assert.equal(result.refused, undefined);
  const removed = new Set(result.removed.map((entry) => entry.name));
  // 名单外点名:旧必删三件套、技能物化、AI 倾倒、Agent 自建变体、散文件。
  for (const name of ["pi-agent", "vision-cache", ".ops-tools", "skills",
                      ".mae-flow-work", ".codecheck-home", ".codecheck-tmp",
                      "cc-home", ".codecheckcli-home", "stray-dump.bin"]) {
    assert.equal(existsSync(join(root, name)), false, `${name} 在名单外,该清`);
    assert.ok(removed.has(name), `${name} 应出现在留痕清单`);
  }
  // repo/ 是服务专属路径(归属等待/开关/标记)的管辖,本模块不越权。
  assert.ok(existsSync(join(root, "repo", "order-service", "pom.xml")),
    "repo/ 由 reclaimRepoDir 专管,这里跳过");
  assert.equal(removed.has("repo"), false);
  // 保留名单逐项点名:查看模式与复盘全靠它们。
  for (const name of ISSUE_WORKSPACE_KEEP_FILES) {
    assert.ok(existsSync(join(root, name)), `${name} 在保留名单,不许动`);
  }
  for (const name of ISSUE_WORKSPACE_KEEP_DIRS) {
    assert.ok(existsSync(join(root, name)), `${name} 在保留名单,不许动`);
  }
  assert.match(readFileSync(join(root, "issue.json"), "utf-8"), /订单模块 500/);
  assert.match(readFileSync(join(root, "events.jsonl"), "utf-8"), /定位到根因/);
  assert.equal(
    readFileSync(join(root, "local-logs", "网管A", "alarm.log"), "utf8"),
    "x".repeat(2048));
  assert.ok(result.freed > 0, "释放字节数应被统计");
});

test("当场清不看大小也不看年龄:小名单外条目照样删,新鲜的重货照样删", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1");
  // 刚写的(时间戳就是现在)小重货:体量小、年龄新,都不构成豁免。
  mkdirSync(join(root, ".codecheck-cc"), { recursive: true });
  writeFileSync(join(root, ".codecheck-cc", "t.bin"), "s");

  const result = reclaimIssueWorkspace(root, { dataDir });

  assert.equal(existsSync(join(root, ".codecheck-cc")), false,
    "名单外只有一条规则:删");
  assert.ok(removedName(result, ".codecheck-cc"));
});

function removedName(
  result: { removed: Array<{ name: string }> },
  name: string,
): boolean {
  return result.removed.some((entry) => entry.name === name);
}

test("当场清是幂等的:第二轮没有名单外条目可删,不再计数", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1");
  const first = reclaimIssueWorkspace(root, { dataDir });
  assert.ok(first.removed.length > 0);
  const second = reclaimIssueWorkspace(root, { dataDir });
  assert.deepEqual(second.removed, []);
  assert.equal(second.freed, 0);
});

/* ---------------- 软链:只解链,不跟链 ---------------- */

test("根下的软链条目:解链本身,链外的原件一个字节不动", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1");
  const outside = mkdtempSync(join(tmpdir(), "mfc-issue-outside-entry-"));
  writeFileSync(join(outside, "big.jar"), "x".repeat(4096));
  symlinkSync(outside, join(root, "agent-home"));

  const result = reclaimIssueWorkspace(root, { dataDir });

  assert.ok(removedName(result, "agent-home"), "软链条目按名单外删除");
  assert.ok(existsSync(join(outside, "big.jar")),
    "删除的是链接本身,链外原件不许碰");
  assert.equal(existsSync(join(root, "agent-home")), false);
});

test("保留名单名字被换成软链:不许动(保守方向)", () => {
  const dataDir = newDataDir();
  const root = sessionRoot(dataDir, "issue-1");
  const outside = mkdtempSync(join(tmpdir(), "mfc-issue-outside-keep-"));
  writeFileSync(join(outside, "a3f.log"), "外部同名的登记附件");
  // 人为把保留条目换成软链(异常现场):保守处理,留着不碰。
  rmSync(join(root, "attachments"), { recursive: true, force: true });
  symlinkSync(join(outside, "a3f.log"), join(root, "attachments"));

  const result = reclaimIssueWorkspace(root, { dataDir });

  assert.equal(removedName(result, "attachments"), false);
  assert.ok(existsSync(join(root, "attachments")), "保留名单按名字保守放行");
});

/* ---------------- 边界闸 ---------------- */

test("issues/ 下的软链接不许绕过边界:realpath 在外面就一个字节不删", () => {
  // 2026-08-22 同款教训:readdir 看着在 dataDir 里,realpath 一解在外面,
  // 删的是原件。删除动作必须自己验边界。
  const dataDir = newDataDir();
  const outside = mfcTemp("mfc-issue-outside-");
  writeFileSync(join(outside, "issue.json"), JSON.stringify({
    id: "issue-9", status: "archived",
  }));
  mkdirSync(join(outside, "pi-agent"), { recursive: true });
  writeFileSync(join(outside, "pi-agent", "models.json"), "{}");
  mkdirSync(join(dataDir, "issues"), { recursive: true });
  symlinkSync(outside, join(dataDir, "issues", "issue-9"));

  const result = reclaimIssueWorkspace(join(dataDir, "issues", "issue-9"),
    { dataDir });
  assert.match(String(result.refused), /拒绝删除/);
  assert.ok(existsSync(join(outside, "pi-agent", "models.json")),
    "越界现场一个字节都不许动");
});

/* ---------------- 判据(当场制,不看年龄) ---------------- */

test("判据:旋钮 0 禁运、非终态不碰、容器在跑跳过、终态即到点", () => {
  const off = judgeIssueReclaim(
    { status: "archived" }, { retentionEnabled: false });
  assert.equal(off.reclaim, false);
  assert.match(off.reason, /永不回收/);
  assert.equal(off.skip, "retention_off");

  for (const status of ["running", "waiting_user", "idle", "queued",
                        "failed"]) {
    const skip = judgeIssueReclaim(
      { status }, { retentionEnabled: true });
    assert.equal(skip.reclaim, false, `${status} 不可自动回收`);
    assert.equal(skip.skip, "not_terminal", `${status} 的跳过码`);
  }

  const busy = judgeIssueReclaim(
    { status: "canceled" },
    { retentionEnabled: true, containerRunning: true });
  assert.equal(busy.reclaim, false);
  assert.equal(busy.skip, "container_running");

  // 当场制没有年龄:刚收口的终态与一年前的终态同一条路。
  for (const status of ["archived", "canceled"]) {
    const go = judgeIssueReclaim(
      { status }, { retentionEnabled: true });
    assert.equal(go.reclaim, true, `${status} 终态即到点`);
  }
});

/* ---------------- 附件中转 GC(图片中转豁免) ---------------- */

test("附件中转:满保留期的文件删,新鲜的留,0 值禁运", () => {
  const dataDir = newDataDir();
  const staging = join(dataDir, "issue-attachment-staging");
  mkdirSync(staging, { recursive: true });
  const old = join(staging, "aabbccdd11223344.log");
  const fresh = join(staging, "1122334455667788.zip");
  writeFileSync(old, "o".repeat(2048));
  writeFileSync(fresh, "f".repeat(8));
  const stale = Date.parse("2026-01-01T00:00:00Z");
  // utimesSync 传数字按秒解释,这里统一用 Date 保毫秒语义。
  utimesSync(old, new Date(stale), new Date(stale));
  const now = Date.parse("2026-02-01T00:00:00Z");

  const swept = sweepIssueAttachmentStaging(dataDir,
    { retentionDays: 14, now });

  assert.equal(swept.removed, 1);
  assert.equal(existsSync(old), false, "31 天前的中转原件该清");
  assert.ok(existsSync(fresh), "新鲜文件不动");

  const off = sweepIssueAttachmentStaging(dataDir,
    { retentionDays: 0, now });
  assert.equal(off.removed, 0, "0 = 永不回收");
});

test("图片中转豁免:两个中转目录都在,只清附件那一个", () => {
  const dataDir = newDataDir();
  const attachments = join(dataDir, "issue-attachment-staging");
  const images = join(dataDir, "issue-image-staging");
  mkdirSync(attachments, { recursive: true });
  mkdirSync(images, { recursive: true });
  const stale = Date.parse("2026-01-01T00:00:00Z");
  for (const [dir, name] of [
    [attachments, "aabbccdd11223344.png"],
    [images, "55667788aabbccdd.png"],
  ] as const) {
    const file = join(dir, name);
    writeFileSync(file, "img");
    utimesSync(file, new Date(stale), new Date(stale));
  }

  sweepIssueAttachmentStaging(dataDir, { retentionDays: 14, now: Date.parse("2026-02-01T00:00:00Z") });

  assert.equal(existsSync(join(attachments, "aabbccdd11223344.png")), false);
  assert.ok(existsSync(join(images, "55667788aabbccdd.png")),
    "回显接口按内容哈希读图片中转原件,删了老会话截图就 404——豁免");
});

test("中转目录缺席:安静返回,不抛", () => {
  const dataDir = newDataDir();
  const swept = sweepIssueAttachmentStaging(dataDir,
    { retentionDays: 14, now: Date.now() });
  assert.deepEqual(swept, { removed: 0, freed: 0 });
});
