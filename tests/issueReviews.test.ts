/**
 * 检视账本的单元契约(ADR-0007,数据面在 src/issueFlow/reviews.ts):
 * - 记/移除:作者恒为归属人,软删留痕;空内容/空锚点打回;
 * - 意见号(#261,ADR-0025):落账时分配,自 1 单调递增、永不复用
 *   (软删也不回收)、跨批次连续;意见号是落账硬要求,无号即坏账
 *   (系统未上线,不存在无号旧账,没有兼容分支);
 * - 锚点检测:gone = 已被改动的唯一判据,moved 只是漂移;读不到
 *   报告按 hit 放行(fail-open,检测绝不挡人);只服务草稿
 *   (ADR-0025「新版干净纸面」),sent 意见不再检测;
 * - 提交:草稿标记送出(ADR-0035:提交不再冻结版本快照,申报修改
 *   时由 snapshotAnalysisVersion 落 reviews/ 子目录,不混进过程文档
 *   清单);没有草稿返回空(服务层据此打回);
 * - 渲染:护栏原文沿用 annotations.ts 的契约,清单按意见号升序编排、
 *   序号 = 意见号(「意见N」,不再批次内 1..N 重编号),逐条 respond
 *   交代的护栏要求(ADR-0036:检视回复落账在意见处,报告不带应答段),
 *   收尾指回 submit_analysis。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addReview,
  anchorChecks,
  dropReview,
  renderReviewNotes,
  reviewStore,
  snapshotAnalysisVersion,
  submitReviews,
} from "../src/issueFlow/reviews.ts";
import {
  ANALYSIS_DOC_NAME,
  listSessionDocuments,
} from "../src/issueFlow/documents.ts";
import { mfcTemp } from "./mfcTmp.ts";

function workspace(content = "# 分析报告\n\n根因:重试无上限。\n"): string {
  const root = mfcTemp("mfc-issue-reviews-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), content);
  return root;
}

test("记意见与移除:草稿入账;空内容/空锚点打回;移除软删留痕", () => {
  const root = workspace();
  const added = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "重试要有上限",
  });
  assert.equal(added.status, "draft");
  assert.equal(added.artifact, ANALYSIS_DOC_NAME,
    "检视对象恒为分析报告(ADR-0007:检视范围只有它)");
  assert.equal(added.kind, "doc");

  assert.throws(() => addReview(root, {
    author: "dev", line: 1, anchor: "x", note: "  ",
  }), /内容不能为空|批注内容不能为空/);
  assert.throws(() => addReview(root, {
    author: "dev", line: 1, anchor: "", note: "n",
  }), /原文快照|无从定位/);

  const dropped = dropReview(root, added.id, "dev");
  assert.equal(dropped.status, "dropped");
  assert.equal(reviewStore(root).visible().length, 0, "软删的不再露面");
  assert.equal(reviewStore(root).list().length, 1, "jsonl 留痕可查");
});

test("锚点检测:没动=hit;重写原文消失=gone(已被改动的唯一判据);漂移=moved;读不到报告按 hit 放行", () => {
  const root = workspace();
  addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "n1",
  });
  assert.equal(anchorChecks(root)[0]?.state, "hit");

  // agent 修订 = 整份重写,意见锚定的原文没了 → gone + 现状原文
  writeFileSync(join(root, ANALYSIS_DOC_NAME),
    "# 分析报告 v2\n\n根因:连接池耗尽。\n");
  const gone = anchorChecks(root)[0];
  assert.equal(gone?.state, "gone");
  assert.match(gone?.now ?? "", /连接池耗尽/, "gone 带现状原文,让人自己判断");

  // 原文还在、只是行号漂移 → moved(不算"已被改动")
  const drift = workspace("# 报告\n\n根因:超时\n");
  addReview(drift, { author: "dev", line: 3, anchor: "根因:超时", note: "n" });
  writeFileSync(join(drift, ANALYSIS_DOC_NAME),
    "# 报告\n\n新增:前言。\n\n根因:超时\n");
  assert.equal(anchorChecks(drift)[0]?.state, "moved");

  // 读不到报告(权限/缺失):按 hit 放行——重锚定绝不挡住面板
  const blind = mfcTemp("mfc-issue-reviews-blind-");
  addReview(blind, { author: "dev", line: 1, anchor: "随便", note: "n" });
  assert.equal(anchorChecks(blind)[0]?.state, "hit");

  // 漂移检测只服务草稿(ADR-0025「新版干净纸面」):sent 意见锚在
  // 自己批次的冻结版上,冻结文本永不漂移——不再对 live 出检测项。
  const submitted = workspace();
  addReview(submitted, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "n",
  });
  assert.equal(anchorChecks(submitted).length, 1);
  submitReviews(submitted);
  assert.deepEqual(anchorChecks(submitted), [], "sent 意见不再漂移检测");
});

test("提交检视:草稿标记送出;提交不再冻结版本(ADR-0035),申报修改时快照落子目录、不混进过程文档清单;无草稿返回空", () => {
  const root = workspace();
  addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const sent = submitReviews(root);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((item) => item.status === "sent"));
  assert.equal(sent[0].line <= sent[1].line, true, "清单按行号升序");
  assert.equal(reviewStore(root).drafts().length, 0);

  // 提交不再伴快照(ADR-0035:纯回复型批次不出版本)——快照时机迁到
  // 修改型申报(snapshotAnalysisVersion)。
  assert.equal(existsSync(join(root, "reviews")), false, "提交不出快照");

  // 申报修改时冻结:快照落 reviews/ 子目录,避开顶层 .md 扫描,
  // 过程文档页签不见它。
  snapshotAnalysisVersion(root);
  const snapDir = join(root, "reviews");
  assert.ok(existsSync(snapDir));
  assert.ok(readdirSync(snapDir).some((name) => name.startsWith("issue-analysis@")));
  assert.deepEqual(
    listSessionDocuments(root).map((doc) => doc.name),
    [ANALYSIS_DOC_NAME],
    "快照不是过程文档页签");

  // 没有草稿:空清单(服务层据此打回"没有待提交的检视意见")
  assert.deepEqual(submitReviews(root), []);
});

test("意见号分配(#261):自 1 单调递增;跨批次连续不重置;软删永不复用", () => {
  const root = workspace();
  const numbers: Array<number | undefined> = [];
  for (const line of [3, 5, 7]) {
    numbers.push(addReview(root, {
      author: "dev", line, anchor: `锚${line}`, note: `n${line}`,
    }).seq);
  }
  assert.deepEqual(numbers, [1, 2, 3], "意见号自 1 单调递增");

  // 跨批次连续:第一批送出后,第二批接着往下编,不回 1。
  submitReviews(root);
  const secondBatch = addReview(root, {
    author: "dev", line: 9, anchor: "锚9", note: "n9",
  });
  assert.equal(secondBatch.seq, 4, "跨批次连续不重置(ADR-0025)");

  // 软删不复用:删掉末条(号 4)再新增,新号必须是 5 不是 4——
  // 否则上一批带号的回应会指错条。
  dropReview(root, secondBatch.id, "dev");
  assert.equal(addReview(root, {
    author: "dev", line: 11, anchor: "锚11", note: "n11",
  }).seq, 5, "删掉末条后不得复号");
  // 中间的号空洞同样不回填:软删的号 2 永远留在台账历史里占号。
  const middle = reviewStore(root).list().find((item) => item.seq === 2)!;
  dropReview(root, middle.id, "dev");
  assert.equal(addReview(root, {
    author: "dev", line: 13, anchor: "锚13", note: "n13",
  }).seq, 6, "中间号空洞也不回填");
  // max 口径看台账历史 add,不看读侧过滤:软删条目在 visible() 里
  // 已不露面,但号照占。
  assert.equal(reviewStore(root).visible().some((item) => item.seq === 2),
    false, "被软删的号不露面,但仍被占着");
});

test("意见号(#261):无号即坏账——台账历史有无 seq 的 add,新增与渲染都炸出来,不留兼容垫片", () => {
  const root = workspace();
  // 手写一条无 seq 的 add:系统未上线,台账不该出现这种记录,出现了
  // 就是坏账——按 CLAUDE.md 红线不给「旧账不占号」式宽容分支,炸出
  // 来修数据,而不是悄悄绕过。
  appendFileSync(join(root, "reviews.jsonl"), JSON.stringify({
    op: "add",
    record: {
      id: "an-legacy-1", author: "dev",
      created_at: "2026-01-01T00:00:00.000Z",
      artifact: ANALYSIS_DOC_NAME, file: ANALYSIS_DOC_NAME,
      line: 3, anchor: "根因:重试无上限", note: "旧账意见",
      kind: "doc", status: "draft",
    },
  }) + "\n");
  assert.throws(() => addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  }), /无意见号/, "落账口对无号历史 add 不再特殊照顾");

  // 渲染同样不收无号意见:意见必须带号,不给续编兜底。
  const legacy = reviewStore(root).list().find((item) => !item.seq)!;
  assert.throws(() => renderReviewNotes([legacy], "登录超时", 1),
    /意见必须带号/, "无号意见不渲染,不给「意见N」以外的假号");
});

test("意见清单跨批次按意见号升序(#261,ADR-0025):乱序输入也按号递增,不按行号/传入序", () => {
  const root = workspace();
  // 第一批:意见1 在第 10 行;送出后第二批接续编号,意见2 在第 3 行
  // (行号比意见1 小——行号序会把意见2 排到意见1 前,ADR-0025 的
  // 「清单按意见号编排」不容许这种倒挂)。
  const batchOne = addReview(root, {
    author: "dev", line: 10, anchor: "锚10", note: "n10",
  });
  submitReviews(root);
  const batchTwo = addReview(root, {
    author: "dev", line: 3, anchor: "锚3", note: "n3",
  });
  assert.equal(batchTwo.seq, batchOne.seq! + 1, "跨批次连续,号接续");
  // 故意按号倒序传入:输出必须按意见号升序,行号序与传入序都不认。
  const text = renderReviewNotes([batchTwo, batchOne], "登录超时", 2);
  const atOne = text.indexOf(`意见${batchOne.seq}. [${batchOne.id}]`);
  const atTwo = text.indexOf(`意见${batchTwo.seq}. [${batchTwo.id}]`);
  assert.ok(atOne >= 0 && atTwo > atOne,
    `意见${batchOne.seq} 必须排在意见${batchTwo.seq} 之前(跨批次不倒挂)`);
});

test("意见清单按意见号编排(#261):序号=意见号而非批次内重编号;逐条 respond 交代护栏在(ADR-0036)", () => {
  const root = workspace();
  const first = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  const second = addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  // 故意乱序传:渲染必须贴意见号,不是传入序、也不是批次内 1..N。
  const text = renderReviewNotes([second, first], "登录超时", 2);
  assert.match(text, new RegExp(`意见1\\. \\[${first.id}\\] 历史第 3 行`),
    "序号 = 意见号,跨批次唯一定位");
  assert.match(text, new RegExp(`意见2\\. \\[${second.id}\\] 历史第 5 行`));
  // 逐条交代落账在意见处(ADR-0036):修订后 respond_review 交代,
  // 未采纳/仅是提问也要给交代,不许漏号;报告正文不带应答段。
  assert.match(text, /respond_review/);
  assert.match(text, /改了什么\/答了什么/);
  assert.match(text, /未被采纳或仅是提问/);
  assert.match(text, /不许漏号/);
  // 应答段指令已删;护栏只反向点名禁写(不写进报告),不再要求加段。
  assert.doesNotMatch(text, /开头加一段「检视意见回应」/);
  assert.match(text, /不写「检视意见回应」/);
  // 既有护栏与收尾不回退(第几轮/重新提交)。
  assert.match(text, /第 2 轮/);
  assert.match(text, /重新 submit_analysis/);
});

test("意见清单渲染:四条护栏原文沿用;逐条带稳定 id/行号/原文/要求;收尾指回 submit_analysis", () => {
  const root = workspace();
  const first = addReview(root, {
    author: "dev", line: 3, anchor: "根因:重试无上限", note: "加重试上限",
  });
  const second = addReview(root, {
    author: "dev", line: 5, anchor: "方案:直接重试", note: "先说清重试策略",
  });
  const text = renderReviewNotes([second, first], "登录超时", 2);
  assert.match(text, /这是检视结论,不是征求意见/);
  assert.match(text, /不要只回复"已知悉"/);
  assert.match(text, /只按这些意见修订/);
  assert.match(text, /以原文为准定位/);
  assert.match(text, /说明理由,别默默跳过/);
  assert.match(text, new RegExp(`\\[${first.id}\\] 历史第 3 行`), "稳定 id 入清单");
  assert.match(text, /原文:根因:重试无上限/);
  assert.match(text, /要求:加重试上限/);
  assert.match(text, /第 2 轮/);
  assert.match(text, /重新 submit_analysis/);
});
