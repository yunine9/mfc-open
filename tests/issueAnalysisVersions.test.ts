/**
 * 分析报告版本投影的契约测试(#262,ADR-0025;数据面在
 * src/issueFlow/analysisVersions.ts):
 * - 推导:第 j 份快照 = 第 j 批修改型意见申报重写时冻结的版本,live
 *   恒为最新版(ADR-0035:提交检视不再冻结,快照时机在申报时刻,
 *   纯回复型批次不出版本);
 *   命名 v1=初版、v_i=修订(i-1);每版带该批提交的意见 id;
 * - 去重:快照=live(AI 未修订完)与相邻同文快照都不重复出条;
 * - 非检视通道(补充意见等)的报告重写不产生冻结版本(没检视过
 *   永远只有 live 一版);
 * - 冻结版读取:白名单即边界(只认推导出的版本名),路径逃逸一律
 *   打回;路由挂 issues 域、登录即可读、缺失为 200 {unavailable}。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ANALYSIS_DOC_NAME,
} from "../src/issueFlow/documents.ts";
import {
  listAnalysisVersions,
  readAnalysisVersion,
} from "../src/issueFlow/analysisVersions.ts";
import {
  addReview,
  snapshotAnalysisVersion,
  submitReviews,
} from "../src/issueFlow/reviews.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 快照与 sent_at 都取毫秒时钟:两批提交之间垫一小段真实时间,保证
 * 批次窗口(sent_at 落在相邻快照时刻之间)不因同毫秒而串批。 */
const tick = () => new Promise((done) => setTimeout(done, 12));

async function twoBatchWorkspace(): Promise<string> {
  const root = mfcTemp("mfc-issue-versions-");
  // 初版内容 → 第一批意见 → 提交(只送出,不冻结)→ 修改型申报时刻
  // 冻结快照 s1
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v1\n\n根因一。\n");
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "修一" });
  submitReviews(root);
  snapshotAnalysisVersion(root);
  await tick();
  // AI 按意见修订 → v2(修订1),第二批意见 → 提交+申报冻结 s2
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v2\n\n根因二。\n");
  addReview(root, { author: "dev", line: 3, anchor: "根因二", note: "修二" });
  submitReviews(root);
  snapshotAnalysisVersion(root);
  await tick();
  // AI 再修订 → v3(修订2,live 最新稿)
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v3\n\n根因三。\n");
  return root;
}

test("版本推导:两批意见 → 初版/修订1/修订2 三版;live 恒为最新版,每版带该批意见", async () => {
  const root = await twoBatchWorkspace();

  const versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name),
    ["初版", "修订1", "修订2"], "v1=初版,v_i=修订(i-1)");
  assert.deepEqual(versions.map((entry) => entry.index), [1, 2, 3]);
  assert.deepEqual(versions.map((entry) => entry.latest),
    [false, false, true], "live(修订2)是唯一最新版");

  // 前两版是检视提交时冻结的快照;最新版是 live,还没冻结时刻。
  assert.ok(versions[0].snapshot?.startsWith("issue-analysis@"),
    "初版带 reviews/ 内快照文件名");
  assert.ok(versions[1].snapshot?.startsWith("issue-analysis@"));
  assert.equal(versions[2].snapshot, undefined, "live 无快照名");
  for (const entry of versions) {
    assert.equal(typeof entry.bytes, "number");
    assert.ok(!Number.isNaN(Date.parse(entry.modified_at)));
  }

  // 意见按提交批次落版:初版锚第一批,修订1 锚第二批,live 无提交意见。
  assert.equal(versions[0].review_ids.length, 1);
  assert.equal(versions[1].review_ids.length, 1);
  assert.notEqual(versions[0].review_ids[0], versions[1].review_ids[0]);
  assert.deepEqual(versions[2].review_ids, [],
    "最新版是干净纸面,已提交意见不标在 live 上");
});

test("去重:快照=live(AI 未修订完)与相邻同文快照都不重复出条", async () => {
  const root = mfcTemp("mfc-issue-versions-dedupe-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v1\n\n根因一。\n");
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "修一" });
  submitReviews(root);
  snapshotAnalysisVersion(root);
  // live === s1:申报时冻结的就是当前稿,修订版还不存在 → 只有初版。
  let versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版"]);
  assert.equal(versions[0].latest, true);
  assert.ok(versions[0].snapshot, "最新版与快照同文时由快照条代表");

  await tick();
  // AI 还没修订就攒了第二批并申报:新快照与上一份同文 → 折并,不出假版本。
  addReview(root, { author: "dev", line: 3, anchor: "根因一", note: "再修一" });
  submitReviews(root);
  snapshotAnalysisVersion(root);
  versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版"],
    "相邻同文快照不重复出条");
  assert.equal(versions[0].review_ids.length, 2,
    "折并条目继承两批已提交意见(冻结版标记不丢)");

  await tick();
  // AI 修订后:修订1 才真正出现,且是 live 最新版。
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v2\n\n改好了。\n");
  versions = listAnalysisVersions(root);
  assert.deepEqual(versions.map((entry) => entry.name), ["初版", "修订1"]);
  assert.equal(versions[1].latest, true);
  assert.equal(versions[1].snapshot, undefined);
});

test("非检视通道的报告重写不产生冻结版本:没检视过永远只有 live 一版", () => {
  const root = mfcTemp("mfc-issue-versions-rewrite-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 v1\n");
  let versions = listAnalysisVersions(root);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].name, "初版");
  assert.equal(versions[0].latest, true);
  assert.equal(versions[0].snapshot, undefined, "没有检视提交就没有快照");

  // 闸卡「补充意见」等通道整份重写 live:仍是同一版(live 只有最新
  // 一个槽),不出新快照、不出新条。
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 报告 完全重写\n");
  versions = listAnalysisVersions(root);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].snapshot, undefined);
  const read = readAnalysisVersion(root, "初版");
  assert.match(read?.content ?? "", /完全重写/);

  // 报告还没生成:清单如实为空,不虚构版本。
  const empty = mfcTemp("mfc-issue-versions-empty-");
  assert.deepEqual(listAnalysisVersions(empty), []);
});

test("冻结版读取:白名单即边界,版本名之外(路径逃逸/未知名)一律打回", async () => {
  const root = await twoBatchWorkspace();

  const first = readAnalysisVersion(root, "初版");
  assert.ok(first);
  assert.match(first.content, /报告 v1/, "冻结版读到的是提交时的快照");
  assert.equal(first.truncated, false);
  assert.ok(first.meta.snapshot, "读的是 reviews/ 内快照");

  const latest = readAnalysisVersion(root, "修订2");
  assert.ok(latest);
  assert.match(latest.content, /报告 v3/, "最新版读 live 本体");
  assert.equal(latest.meta.snapshot, undefined);

  // 白名单即边界:名字只对回推导出的版本清单,路径从不经输入拼接。
  assert.equal(readAnalysisVersion(root, "../issue.json"), undefined);
  assert.equal(readAnalysisVersion(root, "..\\reviews"), undefined);
  assert.equal(readAnalysisVersion(root, "初版/../修订1"), undefined);
  assert.equal(readAnalysisVersion(root, "issue-analysis@r1.md"), undefined,
    "快照文件名不是版本名,不开放直读");
  assert.equal(readAnalysisVersion(root, "修订99"), undefined);
  assert.equal(readAnalysisVersion(root, ""), undefined);

  // reviews/ 里的非分析报告文件不在投影里,同样读不到。
  mkdirSync(join(root, "reviews"), { recursive: true });
  writeFileSync(join(root, "reviews", "evil.md"), "secret");
  assert.equal(readAnalysisVersion(root, "evil.md"), undefined);
});

test("版本路由:清单与读取挂 issues 域读语义;缺失为 200 {unavailable}", async () => {
  const root = await twoBatchWorkspace();
  const service = {
    list: () => [{ id: "issue-ver", account: "dev" }],
    session: () => ({ root }),
  } as any;

  async function call(url: string, parts: string[]): Promise<{
    status: number;
    body: any;
  }> {
    return new Promise((resolve, reject) => {
      let status = 0;
      void handleIssueRoutes(
        { method: "GET", url } as any,
        {
          writeHead: (code: number) => { status = code; },
          end: (payload?: string | Buffer) => resolve({
            status,
            body: JSON.parse(Buffer.from(payload ?? "").toString("utf-8")),
          }),
        } as any,
        parts,
        { issueFlow: service, authEnabled: false },
      ).then((handled) => {
        if (!handled) reject(new Error("未被问题域接管"));
      }).catch((reason) => {
        resolve({
          status: reason?.status ?? 500,
          body: { error: String(reason instanceof Error ? reason.message : reason) },
        });
      });
    });
  }

  const listed = await call("/issues/issue-ver/analysis-versions",
    ["issues", "issue-ver", "analysis-versions"]);
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.versions.map((entry: { name: string }) => entry.name),
    ["初版", "修订1", "修订2"]);

  const read = await call(
    `/issues/issue-ver/analysis-versions/read?name=${encodeURIComponent("初版")}`,
    ["issues", "issue-ver", "analysis-versions", "read"]);
  assert.equal(read.status, 200);
  assert.equal(read.body.name, "初版");
  assert.match(read.body.content, /报告 v1/);

  const missing = await call(
    `/issues/issue-ver/analysis-versions/read?name=${encodeURIComponent("../issue.json")}`,
    ["issues", "issue-ver", "analysis-versions", "read"]);
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body, { unavailable: "版本不存在" },
    "路径逃逸不是 404,是人话空态");
});
