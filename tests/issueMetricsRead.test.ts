/**
 * 统计读侧切换(工单 #327,ADR-0042 后半):一次率统计接口对终态
 * 会话优先读会话目录下的 metrics.json 冻结快照取判定事实,在途会话
 * 照旧现算;快照缺失、损坏或字段不认时自动回退现算——不报错、记一条
 * 日志,调用方无感。
 *
 * 覆盖:
 * 1. 快照判定字段的纯提取与验形(onceRateFactsFromSnapshot:字段齐整
 *    才采用,版本戳不认/缺字段/标了「不可得」一律返回 null);
 * 2. 终态会话走快照:篡改快照上的判定字段,统计输出跟着快照变
 *    (证明读的是快照,不是现算);
 * 3. 在途会话现算:盘上即使躺着一份残坏快照也不去读(读了会留下
 *    回退日志,用日志缺席证清白);
 * 4. 回退三态:快照缺失、JSON 坏行、内容不认(版本错/缺字段/判定
 *    字段标不可得/会话号对不上)都回退现算,输出正确、不抛错、各记
 *    一条日志;
 * 5. 等价回归:混合现场(终态交付+终态取消+无单+在途)先删掉快照
 *    纯现算跑一遍,再写入快照切换读侧跑一遍,两轴与逐会话明细
 *    逐位相等。
 *
 * 范式与 issueMetricsSnapshot 同款:种子现场直接写 issue.json 与
 * 检视/版本账,服务构造即走恢复路径,只走公开 API 断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { loadState, VERIFY_FAIL_NOTE_PREFIX } from "../src/issueFlow/state.ts";
import {
  ISSUE_METRICS_FILE,
  ISSUE_METRICS_SCHEMA_VERSION,
  writeIssueMetricsSnapshot,
  type IssueMetricsSnapshot,
} from "../src/issueFlow/metricsSnapshot.ts";
import {
  onceRateFactsFromSnapshot,
  type IssueOnceRateSummary,
} from "../src/issueFlow/onceRates.ts";
import { mfcTemp } from "./mfcTmp.ts";

const BASE_STATE = {
  account: "dev", created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
  source: "dts", scenario: "ticket", stage: "env_verify",
  stage_note: "", stage_at: "2026-09-01T09:00:00Z",
};

interface SeedSpec {
  id: string;
  status: string;
  ticket?: string;
  conclusionKind?: string;
  /** 终止原因(#542):canceled 终态伴生(种子原样落状态文件)。 */
  cancelReason?: string;
  /** 分析报告版本数(live 文件=初版,reviews/ 里再冻结若干版)。 */
  versions?: number;
  /** 转移账里「用户环境验证发现问题」前缀的条数。 */
  verifyFails?: number;
  /** 检视账里 sent/issue_review 操作数。 */
  reviewBatches?: number;
}

/** 种子一个会话现场,返回会话目录。 */
function seedSession(dataDir: string, spec: SeedSpec): string {
  const root = join(dataDir, "issues", spec.id);
  mkdirSync(root, { recursive: true });
  const transitions = Array.from({ length: spec.verifyFails ?? 0 },
    (_, index) => ({
      at: `2026-09-01T09:${String(10 + index).padStart(2, "0")}:00Z`,
      source: "platform" as const,
      // 生产记账格式(#328 验收要求):回退统一加「第 N 轮:」前缀,
      // 验证失败计数按包含匹配(共享判定 countVerifyFailures)。
      note: `第 ${index + 1} 轮:${VERIFY_FAIL_NOTE_PREFIX}`
        + `:复现仍存在(${index + 1})`,
    }));
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    ...BASE_STATE,
    id: spec.id,
    status: spec.status,
    ...(spec.ticket !== undefined ? { ticket: spec.ticket } : {}),
    ...(spec.conclusionKind
      ? {
        conclusion: {
          kind: spec.conclusionKind, summary: "s",
          at: "2026-09-01T10:00:00Z",
        },
      }
      : {}),
    ...(spec.cancelReason ? { cancel_reason: spec.cancelReason } : {}),
    ...(transitions.length ? { transitions } : {}),
  }, null, 1));
  if (spec.versions) {
    writeFileSync(join(root, "issue-analysis.md"), `# live ${spec.id}\n`);
    if (spec.versions > 1) {
      mkdirSync(join(root, "reviews"), { recursive: true });
      for (let index = 1; index < spec.versions; index += 1) {
        // 内容互不相同(去重口径:相同内容的相邻版本不出两条)。
        writeFileSync(join(root, "reviews",
          `issue-analysis@r${index.toString(36)}.md`),
          `# snapshot ${spec.id} ${index}\n`);
      }
    }
  }
  if (spec.reviewBatches) {
    const lines = Array.from({ length: spec.reviewBatches }, (_, index) =>
      JSON.stringify({ op: "sent", ids: [`an-${spec.id}-${index}`],
        via: "issue_review", at: "2026-09-01T09:00:00Z", by: "dev" }));
    writeFileSync(join(root, "reviews.jsonl"), lines.join("\n") + "\n");
  }
  return root;
}

function makeService(dataDir: string): {
  service: IssueFlowService; logs: string[];
} {
  const logs: string[] = [];
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    log: (message) => logs.push(message),
  });
  return { service, logs };
}

/** 走生产写路把终态会话的快照写到盘上(种子状态经 loadState 归一,
 *  与服务恢复时装进内存的现场同一份词)。 */
function freezeSnapshot(root: string): void {
  const state = loadState(root);
  assert.ok(state, `种子现场应有 issue.json:${root}`);
  const result = writeIssueMetricsSnapshot(root, state);
  assert.ok(result.written, `快照应已写入:${root}`);
}

function readSnapshot(root: string): IssueMetricsSnapshot {
  return JSON.parse(
    readFileSync(join(root, ISSUE_METRICS_FILE), "utf-8"),
  ) as IssueMetricsSnapshot;
}

function writeSnapshotFile(root: string, snapshot: IssueMetricsSnapshot): void {
  writeFileSync(join(root, ISSUE_METRICS_FILE),
    JSON.stringify(snapshot, null, 1));
}

/** 快照的可变视图:篡改/删字段用(测试里的盘上文件替身)。 */
function mutable(snapshot: IssueMetricsSnapshot): Record<string, unknown> {
  return snapshot as unknown as Record<string, unknown>;
}

function rowOf(summary: IssueOnceRateSummary, id: string) {
  const row = summary.per_session.find((item) => item.id === id);
  assert.ok(row, `逐会话明细应含 ${id}`);
  return row;
}

// ---- 1. 纯提取与验形 ----

test("纯提取:判定字段从快照取出;不认的形状一律不采用", () => {
  const shape = (overrides: Record<string, unknown> = {})
    : IssueMetricsSnapshot => {
    const snapshot: Record<string, unknown> = {
      schema_version: ISSUE_METRICS_SCHEMA_VERSION,
      session_id: "issue-1",
      terminal_status: "archived",
      ticket: "DTS-1",
      conclusion_kind: "delivered",
      verify_fail_count: 1,
      report_version_count: 2,
      reviews: { platform_review_comments: 3, review_batches: 2 },
      ...overrides,
    };
    return JSON.parse(JSON.stringify(snapshot)) as IssueMetricsSnapshot;
  };
  assert.deepEqual(onceRateFactsFromSnapshot(shape()), {
    id: "issue-1", ticket: "DTS-1", status: "archived",
    conclusion_kind: "delivered",
    verify_fail_count: 1, report_version_count: 2, review_count: 2,
  }, "齐整快照的判定事实原样取出");
  assert.equal(
    onceRateFactsFromSnapshot(shape(
      { schema_version: ISSUE_METRICS_SCHEMA_VERSION + 1 })),
    null, "版本戳不认识:等口径换版后重算,不猜旧版");
  assert.equal(
    onceRateFactsFromSnapshot(shape({ verify_fail_count: undefined })),
    null, "判定字段缺失");
  assert.equal(
    onceRateFactsFromSnapshot(shape(
      { verify_fail_count: { unavailable: "账损坏" } })),
    null, "判定字段标了「不可得」");
  assert.equal(
    onceRateFactsFromSnapshot(shape(
      { reviews: { platform_review_comments: 3, review_batches: undefined } })),
    null, "检视批次缺失");
  assert.equal(
    onceRateFactsFromSnapshot(shape({ terminal_status: "waiting_user" })),
    null, "终态字段不是终态词");
  // 终止原因(#542):canceled 快照伴生冻结,读侧原样透传交分类裁决。
  assert.deepEqual(onceRateFactsFromSnapshot(shape({
    terminal_status: "canceled", cancel_reason: "inaccurate",
  })), {
    id: "issue-1", ticket: "DTS-1", status: "canceled",
    conclusion_kind: "delivered",
    verify_fail_count: 1, report_version_count: 2, review_count: 2,
    cancel_reason: "inaccurate",
  }, "终止原因随快照原样透传,分类裁决在 issueOnceRates");
  assert.equal(onceRateFactsFromSnapshot(shape())?.cancel_reason,
    undefined, "缺席键=无原因取消,不虚构原因");
});

// ---- 2. 终态会话走快照 ----

test("终态读快照:篡改快照判定字段,统计输出跟着快照走", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-tamper-");
  const root = seedSession(dataDir, {
    id: "issue-t", status: "archived", ticket: "DTS-1",
    conclusionKind: "delivered",
    versions: 2, verifyFails: 1, reviewBatches: 2,
  });
  const { service, logs } = makeService(dataDir);
  try {
    freezeSnapshot(root);
    // 未篡改时快照与现算同值:两轴都不过,检视 2 批。
    const before = service.onceRates();
    const rowBefore = rowOf(before, "issue-t");
    assert.equal(rowBefore.localization_pass, false);
    assert.equal(rowBefore.repair_pass, false);
    assert.equal(rowBefore.reviews, 2);
    assert.ok(!logs.some((line) => line.includes("回退现算")),
      "快照齐整时不应有回退日志");

    // 篡改快照上的判定事实(现算口径里转移账有 1 次验证未通过、
    // 检视账有 2 批;若统计还在现算,这两个值不可能变)。
    const snapshot = mutable(readSnapshot(root));
    snapshot.verify_fail_count = 0;
    (snapshot.reviews as Record<string, unknown>).review_batches = 7;
    writeSnapshotFile(root, snapshot as unknown as IssueMetricsSnapshot);

    const after = service.onceRates();
    const rowAfter = rowOf(after, "issue-t");
    assert.equal(rowAfter.repair_pass, true,
      "验证未通过次数跟着篡改后的快照走(现算是 false)");
    assert.equal(rowAfter.reviews, 7, "检视批次跟着篡改后的快照走");
    assert.equal(rowAfter.localization_pass, false, "版本数未篡改,照旧");
    assert.ok(!logs.some((line) => line.includes("回退现算")),
      "读的是篡改后的快照,全程无回退");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 3. 在途会话现算 ----

test("在途现算:盘上躺着残坏快照也不去读", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-live-");
  const root = seedSession(dataDir, {
    id: "issue-w", status: "waiting_user", ticket: "DTS-2",
    versions: 1, verifyFails: 0, reviewBatches: 1,
  });
  // 在途会话目录里硬塞一份坏快照:若读侧去碰它,必留下「损坏回退」
  // 日志;不去碰,日志里就没有这个会话的任何快照字样。
  writeFileSync(join(root, ISSUE_METRICS_FILE), "{{{坏账现场:not json");
  const { service, logs } = makeService(dataDir);
  try {
    const summary = service.onceRates();
    assert.equal(summary.total, 0, "在途会话不进分母");
    assert.ok(!logs.some((line) => line.includes("issue-w")),
      "在途会话的快照读都没读");
    assert.ok(existsSync(join(root, ISSUE_METRICS_FILE)),
      "残坏快照原样躺着,读侧不清理不报错");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 4. 回退三态 ----

test("快照缺失:回退现算,输出正确,记一条日志", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-miss-");
  seedSession(dataDir, {
    id: "issue-m", status: "archived", ticket: "DTS-3",
    conclusionKind: "delivered",
    versions: 2, verifyFails: 1, reviewBatches: 2,
  });
  const { service, logs } = makeService(dataDir);
  try {
    // 服务起来之后再删:无论恢复路径是否补写,缺失现场都成立。
    rmSync(join(dataDir, "issues", "issue-m", ISSUE_METRICS_FILE),
      { force: true });
    const summary = service.onceRates();
    const row = rowOf(summary, "issue-m");
    assert.deepEqual([row.localization_pass, row.repair_pass, row.reviews],
      [false, false, 2], "回退现算的输出与账面一致");
    assert.ok(logs.some((line) =>
      line.includes("issue-m") && line.includes("终态快照缺失")
      && line.includes("回退现算")), "记一条缺失回退日志");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("快照损坏:JSON 坏行回退现算,不抛错", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-corrupt-");
  const root = seedSession(dataDir, {
    id: "issue-x", status: "archived", ticket: "DTS-4",
    conclusionKind: "delivered",
    versions: 1, verifyFails: 0, reviewBatches: 1,
  });
  // 合法 JSON 但顶层不是对象:同样按对不上处理,不炸统计。
  const nullRoot = seedSession(dataDir, {
    id: "issue-n", status: "archived", ticket: "DTS-7",
    conclusionKind: "delivered",
    versions: 1, verifyFails: 0, reviewBatches: 1,
  });
  const { service, logs } = makeService(dataDir);
  try {
    writeFileSync(join(root, ISSUE_METRICS_FILE), "{{{坏账现场:not json");
    writeFileSync(join(nullRoot, ISSUE_METRICS_FILE), "null");
    const summary = service.onceRates();
    const row = rowOf(summary, "issue-x");
    assert.deepEqual([row.localization_pass, row.repair_pass, row.reviews],
      [true, true, 1], "坏快照不拖累输出,照现算");
    assert.deepEqual(rowOf(summary, "issue-n"),
      { id: "issue-n", reviews: 1, localization_pass: true, repair_pass: true },
      "顶层不是对象的快照也回退现算");
    assert.ok(logs.some((line) =>
      line.includes("issue-x") && line.includes("终态快照损坏")
      && line.includes("回退现算")), "记一条损坏回退日志");
    assert.ok(logs.some((line) =>
      line.includes("issue-n") && line.includes("回退现算")),
      "非对象快照同样有回退日志");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("快照内容不认:版本错/缺字段/判定字段不可得/会话号对不上,各回退现算", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-unusable-");
  const spec = (id: string): SeedSpec => ({
    id, status: "archived", ticket: `DTS-${id}`, conclusionKind: "delivered",
    versions: 2, verifyFails: 1, reviewBatches: 2,
  });
  const v1 = seedSession(dataDir, spec("issue-v1"));
  const v2 = seedSession(dataDir, spec("issue-v2"));
  const v3 = seedSession(dataDir, spec("issue-v3"));
  const v4 = seedSession(dataDir, spec("issue-v4"));
  for (const root of [v1, v2, v3, v4]) freezeSnapshot(root);
  const tamper = (root: string, mutate: (view: Record<string, unknown>) => void)
    : void => {
    const view = mutable(readSnapshot(root));
    mutate(view);
    writeSnapshotFile(root, view as unknown as IssueMetricsSnapshot);
  };
  tamper(v1, (view) => {
    view.schema_version = ISSUE_METRICS_SCHEMA_VERSION + 99;
  });
  tamper(v2, (view) => {
    delete view.verify_fail_count;
  });
  tamper(v3, (view) => {
    view.verify_fail_count = { unavailable: "测试注入的降级段" };
  });
  tamper(v4, (view) => {
    view.session_id = "issue-someone-else";
  });
  const { service, logs } = makeService(dataDir);
  try {
    const summary = service.onceRates();
    assert.equal(summary.total, 4, "四个会话都照回退现算进分母");
    for (const id of ["issue-v1", "issue-v2", "issue-v3", "issue-v4"]) {
      const row = rowOf(summary, id);
      assert.deepEqual([row.localization_pass, row.repair_pass, row.reviews],
        [false, false, 2], `${id} 的输出与账面一致`);
    }
    for (const id of ["issue-v1", "issue-v2", "issue-v3"]) {
      assert.ok(logs.some((line) =>
        line.includes(id) && line.includes("不可用")
        && line.includes("回退现算")), `${id} 记一条内容不认的回退日志`);
    }
    assert.ok(logs.some((line) =>
      line.includes("issue-v4") && line.includes("会话号对不上")
      && line.includes("回退现算")), "会话号对不上单独立账");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 5. 等价回归:切换前后逐位相等 ----

test("等价回归:混合现场纯现算与读快照两遍,两轴与明细逐位相等", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-equiv-");
  // 终态交付 issue-a:两版报告+一次验证未通过+两批检视,两轴都不过。
  const a = seedSession(dataDir, {
    id: "issue-a", status: "archived", ticket: "DTS-1",
    conclusionKind: "delivered",
    versions: 2, verifyFails: 1, reviewBatches: 2,
  });
  // 终态交付 issue-b:一版报告+零验证未通过+一批检视,两轴都过。
  const b = seedSession(dataDir, {
    id: "issue-b", status: "archived", ticket: "DTS-2",
    conclusionKind: "delivered",
    versions: 1, verifyFails: 0, reviewBatches: 1,
  });
  // 终态取消 issue-c:读侧也走快照,但不进分母。
  const c = seedSession(dataDir, {
    id: "issue-c", status: "canceled", ticket: "DTS-3", versions: 1,
  });
  // 终态无单 issue-d 与结论非交付 issue-e:都进不了分母。
  const d = seedSession(dataDir, {
    id: "issue-d", status: "archived", conclusionKind: "delivered",
    versions: 1,
  });
  const e = seedSession(dataDir, {
    id: "issue-e", status: "archived", ticket: "DTS-5",
    conclusionKind: "non_issue", versions: 1,
  });
  // 在途两会话:等的人带单、空闲的无单,照旧现算。
  seedSession(dataDir, {
    id: "issue-w1", status: "waiting_user", ticket: "DTS-6", versions: 1,
  });
  seedSession(dataDir, { id: "issue-w2", status: "idle", versions: 1 });
  const { service, logs } = makeService(dataDir);
  try {
    // 第一遍:删净快照,纯现算(切换前的原路径)。
    for (const root of [a, b, c, d, e]) {
      rmSync(join(root, ISSUE_METRICS_FILE), { force: true });
    }
    const baseline = service.onceRates();
    assert.equal(baseline.total, 2, "分母=issue-a/issue-b");
    assert.deepEqual(baseline.localization, { passed: 1, total: 2, rate: 50 });
    assert.deepEqual(baseline.repair, { passed: 1, total: 2, rate: 50 });
    assert.deepEqual(rowOf(baseline, "issue-a"), {
      id: "issue-a", reviews: 2, localization_pass: false, repair_pass: false,
    });
    assert.deepEqual(rowOf(baseline, "issue-b"), {
      id: "issue-b", reviews: 1, localization_pass: true, repair_pass: true,
    });

    // 第二遍:终态会话逐个落上快照,读侧切到快照。
    for (const root of [a, b, c, d, e]) {
      freezeSnapshot(root);
      assert.ok(existsSync(join(root, ISSUE_METRICS_FILE)),
        `快照已在盘上:${root}`);
    }
    logs.length = 0;
    const switched = service.onceRates();
    assert.deepEqual(logs, [], "终态会话全部读到快照,一次回退都没有");
    assert.deepEqual(switched, baseline,
      "两轴与逐会话明细,切换读快照前后逐位相等");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

// ---- 6. 终止原因随终态快照进分母(#542) ----

test("终止原因随终态快照进分母:读快照与回退现算同判(#542)", async () => {
  const dataDir = mfcTemp("mfc-issue-metrics-read-cancel-");
  const root = seedSession(dataDir, {
    id: "issue-cancel", status: "canceled", ticket: "DTS-3",
    cancelReason: "inaccurate",
  });
  const { service } = makeService(dataDir);
  try {
    // 快照路径:生产写路冻结的 canceled 快照带 cancel_reason,读侧
    // 透传进分类,负面终止进一次解决率分母记失败。
    freezeSnapshot(root);
    const frozen = service.onceRates();
    assert.equal(frozen.terminated, 1);
    assert.equal(frozen.delivered, 0);
    assert.equal(frozen.total, 1, "分母=完成交付 0 + 负面终止 1");
    assert.deepEqual(frozen.localization,
      { passed: 0, total: 0, rate: null }, "两轴分母仍只含完成交付");
    assert.deepEqual(rowOf(frozen, "issue-cancel"),
      { id: "issue-cancel", cancel_reason: "inaccurate" },
      "明细行机器事实缺席不设键(#540 复审),仅身份与终止原因");

    // 现算路径:删掉快照回退,同判(口径不分家)。
    rmSync(join(root, ISSUE_METRICS_FILE));
    assert.deepEqual(service.onceRates(), frozen);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});
