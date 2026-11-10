/**
 * 90%AI生成达标率读侧与呈现(工单 #338/#340,ADR-0044):
 * 1. GET /issues/once-generated 分母三态——有数据(伴生在场且留存
 *    源码行>0)/待算(支持期内终态、伴生缺席)/不支持期(起算日期前
 *    终态,永不回填);达标线缺省与逐会话明细;非完成交付(取消/误报)
 *    一律不进;
 * 2. GET /issues/:id/code-origin 伴生原样返回,缺席如实 404;
 * 3. web 侧特性聚合纯函数 onceGeneratedFeatureRows:归组/加权占比/
 *    达标率/排序/空白归「未分类」。
 *
 * 范式:issueOnceRates 的种子现场直写 issue.json + 服务构造恢复路径,
 * 只走公开路由断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { featureRepoTree, onceGeneratedFeatureRows } from "../web/src/teamOps.ts";

const BASE_STATE = {
  account: "dev", created_at: "2026-09-20T08:00:00Z",
  updated_at: "2026-09-20T09:00:00Z", title: "t", description: "",
  source: "dts", scenario: "ticket", stage: "mr_green",
  stage_note: "", stage_at: "2026-09-20T09:00:00Z",
};

const DELIVERED_SINCE = {
  status: "archived",
  // 起算日 2026-09-21(v2 首个完整日;v3 换版曾挪 09-23,v4 按度量
  // 可换算判据退回,ADR-0051)。收口故意落在 09-22——v3 纪律曾退休
  // 的窗口,锁死「9-21/22 的 v2 快照会话重新进分母」不回退。
  conclusion: { kind: "delivered", summary: "s", at: "2026-09-22T10:00:00Z" },
};

function seedSession(dataDir: string, state: Record<string, unknown>): void {
  const id = String(state.id);
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"),
    JSON.stringify({ ticket: "DTS202609000001", ...BASE_STATE, ...state }));
}

/** 手工冻结一份伴生快照(行数可指定;head/base 造假无妨——读侧不碰
 *  Git,只做投影聚合)。 */
function seedCompanion(dataDir: string, id: string, lines: {
  first: number; rework: number; external: number;
}): void {
  writeFileSync(join(dataDir, "issues", id, "code-origin.json"),
    JSON.stringify({
      // schema_version 故意落 2:读侧 v2..v4 同度量混读(ADR-0051),
      // 旧版快照照常进统计。
      schema_version: 2,
      generated_at: "2026-09-20T11:00:00.000Z",
      session_id: id,
      by_repo: [{
        repo: "https://git/example.git", branch: "master_dev_DTS1",
        head: "a".repeat(40), head_basis: "merged_sha", base: "b".repeat(40),
        boundary: null, lines, commits: [],
      }],
    }, null, 1));
}

async function callRoute(service: IssueFlowService, url: string,
  parts: string[]): Promise<{ status: number; body: Record<string, unknown> }> {
  let status = 0;
  let body: Record<string, unknown> = {};
  await handleIssueRoutes(
    { method: "GET", url } as never,
    {
      writeHead: (code: number) => { status = code; },
      end: (output?: string | Buffer) => {
        body = JSON.parse(Buffer.isBuffer(output)
          ? output.toString("utf-8") : output ?? "{}");
      },
    } as never,
    parts,
    { issueFlow: service, authEnabled: false },
  );
  return { status, body };
}

test("路由 once-generated:分母三态与达标判定,非完成交付不进", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-"));
  // 有数据:占比 90(线 90,恰达标)与 50(不达标)。
  seedSession(dataDir, { id: "issue-a", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-a",
    { first: 90, rework: 5, external: 5 });
  seedSession(dataDir, { id: "issue-b", ...DELIVERED_SINCE,
    conclusion: { kind: "delivered", summary: "s", at: "2026-09-23T12:00:00Z" } });
  seedCompanion(dataDir, "issue-b",
    { first: 50, rework: 40, external: 10 });
  // 待算:支持期内终态、伴生缺席(通道在途或曾丢失)。
  seedSession(dataDir, { id: "issue-c", ...DELIVERED_SINCE });
  // 不支持期:起算日期前终态的存量会话,永不回填。
  seedSession(dataDir, { id: "issue-d", status: "archived",
    conclusion: { kind: "delivered", summary: "s", at: "2026-09-19T23:00:00Z" } });
  // 无源码交付:伴生在场但留存源码行 0,不进分母。
  seedSession(dataDir, { id: "issue-e", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-e", { first: 0, rework: 0, external: 0 });
  // 非完成交付:取消/误报一律不进(伴生在场也不进)。
  seedSession(dataDir, { id: "issue-f", status: "canceled",
    ticket: undefined });
  seedSession(dataDir, { id: "issue-g", status: "archived",
    conclusion: { kind: "non_issue", summary: "误报", at: "2026-09-20T10:00:00Z" } });

  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const { status, body } = await callRoute(service,
      "/issues/once-generated", ["issues", "once-generated"]);
    assert.equal(status, 200);
    assert.equal(body.threshold_percent, 90, "达标线缺省 90(参数)");
    assert.equal(body.supported_since, "2026-09-21");
    assert.equal(body.total, 2, "分母=issue-a/b(issue-e 无源码行不进)");
    assert.equal(body.passed, 1, "占比恰 90 判达标,50 不达标");
    assert.equal(body.rate, 50);
    assert.equal(body.pending, 1, "issue-c 待算");
    assert.equal(body.unsupported, 1, "issue-d 早于起算日");
    assert.equal(body.no_code, 1, "issue-e 无源码交付");
    // 三根过程率轴与 /issues/stats 同源:分母=完成交付全集(a/b/c/d/e,
    // 不随伴生在缺漂移);种子都没有报告账与验证失败 → 双轴满分、解决满分。
    assert.deepEqual(body.localization, { passed: 5, total: 5, rate: 100 });
    assert.deepEqual(body.verify, { passed: 5, total: 5, rate: 100 });
    assert.deepEqual(body.solved, { passed: 5, total: 5, rate: 100 });
    const repoRows = body.by_repo as Array<{
      repo: string; sessions: number; first: number; total: number; share: number | null;
    }>;
    assert.equal(repoRows.length, 1, "同仓跨会话归组");
    const repoRow = repoRows[0]!;
    assert.equal(repoRow.sessions, 2, "多会话按仓各计一次");
    assert.equal(repoRow.first, 140);
    assert.equal(repoRow.total, 200);
    assert.equal(repoRow.share, 70);
    const rows = body.per_session as Array<{
      id: string; state: string; module: string; share?: number; pass?: boolean;
      localization_pass?: boolean; verify_pass?: boolean; solved_pass?: boolean;
    }>;
    assert.deepEqual(rows.map((row) => row.id), ["issue-b", "issue-a", "issue-c", "issue-e", "issue-d"],
      "per_session 覆盖范围内全部完成交付会话,按收口时刻倒序");
    assert.deepEqual(rows.map((row) => row.state),
      ["ok", "ok", "pending", "no_code", "unsupported"]);
    assert.equal(rows.find((row) => row.id === "issue-a")?.module, "未分类",
      "模块标签空白归「未分类」");
    assert.equal(rows.find((row) => row.id === "issue-a")?.pass, true);
    assert.equal(rows.find((row) => row.id === "issue-a")?.solved_pass, true);
    assert.equal(rows.find((row) => row.id === "issue-b")?.solved_pass, true);
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("路由 once-generated:负面原因终止进按会话明细与一次解决率分母(#542)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-"));
  // 完成交付且一次:一次解决分子 1。
  seedSession(dataDir, { id: "issue-ok", ...DELIVERED_SINCE });
  seedCompanion(dataDir, "issue-ok", { first: 90, rework: 5, external: 5 });
  // 负面终止×2:取消时刻落在 09-22/09-23,参与收口倒序与完成时间筛选。
  seedSession(dataDir, { id: "issue-neg", title: "分析不准",
    status: "canceled", cancel_reason: "inaccurate",
    updated_at: "2026-09-23T12:00:00Z" });
  seedSession(dataDir, { id: "issue-other", title: "其他",
    status: "canceled", cancel_reason: "other",
    cancel_reason_text: "等了二十分钟没有反应",
    updated_at: "2026-09-22T08:00:00Z" });
  // 「问题已处理」取消与无原因取消(历史)不产生行。
  seedSession(dataDir, { id: "issue-resolved", status: "canceled",
    cancel_reason: "resolved", updated_at: "2026-09-23T13:00:00Z" });
  seedSession(dataDir, { id: "issue-legacy", status: "canceled",
    updated_at: "2026-09-23T14:00:00Z" });

  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const { status, body } = await callRoute(service,
      "/issues/once-generated", ["issues", "once-generated"]);
    assert.equal(status, 200);
    assert.equal(body.delivered, 1, "delivered 只数完成交付");
    assert.equal(body.terminated, 2, "负面终止单独计数");
    assert.deepEqual(body.solved, { passed: 1, total: 3, rate: 33.3 },
      "一次解决率分母=完成交付+负面终止,终止记失败");
    assert.deepEqual(body.localization, { passed: 1, total: 1, rate: 100 },
      "一次定位率口径不动(分母只含完成交付)");
    assert.deepEqual(body.verify, { passed: 1, total: 1, rate: 100 },
      "一次验证率口径不动(分母只含完成交付)");
    const rows = body.per_session as Array<Record<string, unknown>>;
    assert.deepEqual(rows.map((row) => row.id),
      ["issue-neg", "issue-ok", "issue-other"],
      "负面终止按取消时刻参与收口倒序;resolved 与无原因取消不产生行");
    const neg = rows.find((row) => row.id === "issue-neg")!;
    // 整行钉形(#540 复审):终止行只带身份与原因,工作机器事实缺席
    // 不设键——硬编码 false/0 假值会被第三方误读成「验证失败」。
    assert.deepEqual(neg, {
      id: "issue-neg", title: "分析不准", module: "未分类",
      reporter: "dev", concluded_at: "2026-09-23T12:00:00Z",
      state: "canceled", cancel_reason: "inaccurate",
    }, "终止时间=取消时刻;机器事实缺席,cancel_reason 在场");
    const other = rows.find((row) => row.id === "issue-other")!;
    assert.equal(other.cancel_reason, "other");
    assert.equal(other.cancel_reason_text, "等了二十分钟没有反应",
      "other 原因带说明文本");

    // 完成时间筛选按取消时刻裁负面终止行:09-23 之后只剩 issue-neg。
    const ranged = await callRoute(service,
      "/issues/once-generated?completed_from=2026-09-23T00:00:00.000Z",
      ["issues", "once-generated"]);
    assert.equal(ranged.status, 200);
    assert.equal(ranged.body.delivered, 0);
    assert.equal(ranged.body.terminated, 1);
    assert.equal(ranged.body.total, 0, "一次解决率分母随范围只剩负面终止");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("路由 code-origin:伴生原样返回;缺席如实 404;读侧 join 出 MR 链接", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-"));
  seedSession(dataDir, { id: "issue-a", ...DELIVERED_SINCE,
    // mrs 账按 仓+分支 对上伴生仓:读侧响应带 mr_url(冻结文件不动)。
    mrs: [{ repo: "https://git/example.git", branch: "master_dev_DTS1",
      title: "示例 MR", url: "https://git/example/-/merge_requests/7",
      at: "2026-09-20T10:00:00Z" }] });
  seedCompanion(dataDir, "issue-a", { first: 90, rework: 5, external: 5 });
  seedSession(dataDir, { id: "issue-c", ...DELIVERED_SINCE });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const ok = await callRoute(service, "/issues/issue-a/code-origin",
      ["issues", "issue-a", "code-origin"]);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.session_id, "issue-a");
    const byRepo = ok.body.by_repo as Array<{ lines: { first: number }; mr_url?: string }>;
    assert.equal(byRepo[0]!.lines.first, 90);
    assert.equal(byRepo[0]!.mr_url, "https://git/example/-/merge_requests/7",
      "仓+分支对上 mrs 账 → 响应带 MR 链接");

    const missing = await callRoute(service, "/issues/issue-c/code-origin",
      ["issues", "issue-c", "code-origin"]);
    assert.equal(missing.status, 404, "伴生缺席(未算完)不猜不补");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("onceGeneratedFeatureRows:归组/加权占比/达标率/排序/空白归未分类", () => {
  const rows = onceGeneratedFeatureRows([
    { module: "网关", share: 95, pass: true, localization_pass: false,
      verify_pass: true, solved_pass: false,
      lines: { first: 90, rework: 5, external: 5 } },
    { module: "网关", share: 50, pass: false, localization_pass: true,
      verify_pass: true, solved_pass: false,
      lines: { first: 50, rework: 50, external: 0 } },
    { module: "  ", share: 100, pass: true, localization_pass: true,
      verify_pass: true, solved_pass: true,
      lines: { first: 40, rework: 0, external: 0 } },
    { module: "计费", share: 30, pass: false, localization_pass: true,
      verify_pass: false, solved_pass: false,
      lines: { first: 30, rework: 60, external: 10 } },
  ]);
  assert.deepEqual(rows, [
    {
      module: "网关", sessions: 2, pass_rate: 50,
      solved_rate: 0, localization_rate: 50, verify_rate: 100,
      share: 70, total_lines: 200,
    },
    {
      module: "计费", sessions: 1, pass_rate: 0,
      solved_rate: 0, localization_rate: 100, verify_rate: 0,
      share: 30, total_lines: 100,
    },
    {
      module: "未分类", sessions: 1, pass_rate: 100,
      solved_rate: 100, localization_rate: 100, verify_rate: 100,
      share: 100, total_lines: 40,
    },
  ], "排序:会话数降序 → 工作行降序(计费 100 行在未分类 40 行前)→ 名称;解决率=定位∧验证");
  assert.deepEqual(onceGeneratedFeatureRows([]), []);
});

test("onceGeneratedFeatureRows:交付尝试口径——终止/无事实行进三率分母记失败,行数仍只认 ok(#353 形状安全)", () => {
  // 真实形状:pending/no_code/unsupported 行不带 share/lines;负面终止
  // 行连三率键都缺席(#540)。都不崩:进会话数与三率分母记失败;定位/
  // 验证分子只在键为 true 时累计。行数/占比/pass_rate 仍只认 share+lines
  // 在场的 ok 行。
  const rows = onceGeneratedFeatureRows([
    { module: "网关", share: 95, pass: true, localization_pass: true,
      verify_pass: true, solved_pass: true,
      lines: { first: 90, rework: 5, external: 5 } },
    // 交付了但伴生在途:无 share/lines,判定事实未过。
    { module: "网关", localization_pass: false, verify_pass: false,
      solved_pass: false },
    // 负面终止:三率键全缺席,记未解决/未定位/未验证。
    { module: "网关" },
    { module: "计费", share: 40, pass: false, localization_pass: true,
      verify_pass: false, solved_pass: false },
  ]);
  assert.deepEqual(rows, [
    {
      module: "网关", sessions: 3, solved_rate: 33.3,
      pass_rate: 100, localization_rate: 33.3, verify_rate: 33.3,
      share: 90, total_lines: 100,
    },
    {
      module: "计费", sessions: 1, solved_rate: 0,
      pass_rate: null, localization_rate: 100, verify_rate: 0,
      share: null, total_lines: 0,
    },
  ], "三率同分母=交付尝试(终止记失败);pass_rate 与行数/占比仅 ok 行(计费无 ok 行 → null)");
});

test("per_session ok 行携带按仓明细:跳过不可得仓与零行仓,非 ok 行不带(ADR-0065)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncegen-repo-"));
  seedSession(dataDir, { id: "issue-multi", ...DELIVERED_SINCE });
  writeFileSync(join(dataDir, "issues", "issue-multi", "code-origin.json"),
    JSON.stringify({
      schema_version: 4,
      generated_at: "2026-09-20T11:00:00.000Z",
      session_id: "issue-multi",
      by_repo: [
        { repo: "https://git/one.git", branch: "b1", head: "a".repeat(40),
          head_basis: "merged_sha", base: "b".repeat(40), boundary: null,
          lines: { first: 60, rework: 20, external: 10 }, commits: [] },
        { repo: "https://git/two.git", branch: "b2", head: "c".repeat(40),
          head_basis: "merged_sha", base: "d".repeat(40), boundary: null,
          lines: { first: 30, rework: 0, external: 0 }, commits: [] },
        { repo: "https://git/lost.git", branch: "b3", head: "e".repeat(40),
          head_basis: "merged_sha", base: "f".repeat(40),
          unavailable: "不可得:现场已回收" },
        { repo: "https://git/zero.git", branch: "b4", head: "1".repeat(40),
          head_basis: "merged_sha", base: "2".repeat(40), boundary: null,
          lines: { first: 0, rework: 0, external: 0 }, commits: [] },
      ],
    }, null, 1));
  // 待算行(伴生缺席)不带 by_repo;与 ok 行同页对照。
  seedSession(dataDir, { id: "issue-pending", ...DELIVERED_SINCE });
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const { status, body } = await callRoute(service,
      "/issues/once-generated", ["issues", "once-generated"]);
    assert.equal(status, 200);
    const rows = body.per_session as Array<{
      id: string; state: string; by_repo?: Array<{
        repo: string; first: number; rework: number; external: number;
      }>;
    }>;
    const multi = rows.find((row) => row.id === "issue-multi")!;
    assert.equal(multi.state, "ok");
    assert.deepEqual(multi.by_repo, [
      { repo: "https://git/one.git", first: 60, rework: 20, external: 10 },
      { repo: "https://git/two.git", first: 30, rework: 0, external: 0 },
    ], "只带可得且有工作行的仓,字段为最小形状(不落占比)");
    const pending = rows.find((row) => row.id === "issue-pending")!;
    assert.equal(pending.state, "pending");
    assert.equal(pending.by_repo, undefined, "非 ok 行不带仓明细");
  } finally {
    await service.shutdown().catch(() => undefined);
  }
});

test("featureRepoTree:特性→仓归组/三率/加权占比/排序/by_repo 缺席不崩(ADR-0065)", () => {
  const { repos, lines } = featureRepoTree([
    { module: "网关", share: 80, solved_pass: true,
      localization_pass: true, verify_pass: false,
      lines: { first: 60, rework: 20, external: 10 },
      by_repo: [
        { repo: "https://git/two.git", first: 30, rework: 0, external: 0 },
        { repo: "https://git/one.git", first: 30, rework: 20, external: 10 },
      ] },
    { module: "网关", share: 100, solved_pass: false,
      localization_pass: false, verify_pass: true,
      lines: { first: 40, rework: 0, external: 0 },
      by_repo: [{ repo: "https://git/one.git", first: 40, rework: 0, external: 0 }] },
    { module: "计费", share: 90, solved_pass: true,
      localization_pass: true, verify_pass: true,
      lines: { first: 90, rework: 0, external: 0 },
      by_repo: [] },
    // 降级形状:share 在场但 by_repo 缺席——只不贡献仓行,不崩。
    { module: "计费", share: 50, lines: { first: 10, rework: 5, external: 5 } },
    // 非 ok 行:share 缺失整行跳过。
    { module: "网关" },
  ]);
  assert.deepEqual(repos.get("网关"), [
    { repo: "https://git/one.git", sessions: 2, solved: 1,
      localization_passed: 1, verify_passed: 1,
      first: 70, rework: 20, external: 10, total: 100, share: 70 },
    { repo: "https://git/two.git", sessions: 1, solved: 1,
      localization_passed: 1, verify_passed: 0,
      first: 30, rework: 0, external: 0, total: 30, share: 100 },
  ], "跨会话按仓归组求和;仓行按工作行合计降序;占比=首轮÷全部(一位小数);三率分子随行累计");
  assert.deepEqual(repos.get("计费"), [],
    "by_repo 缺席/空数组的行不贡献仓行(降级响应不崩)");
  assert.deepEqual(lines.get("网关"), { first: 100, rework: 20, external: 10 },
    "特性层首轮/返工/平台外=跨会话求和,供外层合并列对账");
  assert.equal(repos.get("未分类"), undefined, "全空输入不出组");
});

test("featureRepoTree:isBound 绑定外仓沉底,各自再按行数降序(ADR-0065 修订)", () => {
  const rows = [
    { module: "网关", share: 80,
      lines: { first: 100, rework: 0, external: 0 },
      by_repo: [
        // 绑定外仓行数反而更大:仍要排在绑内仓之后。
        { repo: "https://git/wild.git", first: 90, rework: 0, external: 0 },
        { repo: "https://git/one.git", first: 10, rework: 0, external: 0 },
      ] },
  ];
  const isBound = (feature: string, repo: string) =>
    feature === "网关" && repo === "https://git/one.git";
  assert.deepEqual(featureRepoTree(rows, isBound).repos.get("网关")!.map((row) => row.repo),
    ["https://git/one.git", "https://git/wild.git"], "绑内在前,绑定外沉底");
  // 归一由调用方做:isBound 收到的就是 by_repo 原样值。
  assert.deepEqual(featureRepoTree(rows).repos.get("网关")!.map((row) => row.repo),
    ["https://git/wild.git", "https://git/one.git"],
    "isBound 缺席=全部视为绑内,退回纯行数降序");
});

test("#457 DTS 完成日期按结论时刻过滤，结束边界不计入，聚合与明细范围一致", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "issue-completion-range-"));
  for (const [id, at] of [["issue-start", "2026-10-08T16:00:00.000Z"], ["issue-end", "2026-10-09T15:59:59.999Z"], ["issue-next", "2026-10-09T16:00:00.000Z"]]) {
    seedSession(dataDir, { id, created_at: "2026-08-01T00:00:00Z", status: "archived", conclusion: { kind: "delivered", summary: "完成", at } });
    seedCompanion(dataDir, id, { first: 90, rework: 10, external: 0 });
  }
  const service = new IssueFlowService({ dataDir, provider: "p", model: "m", modelsJson: {} });
  try {
    const query = new URLSearchParams({ completed_from: "2026-10-08T16:00:00.000Z", completed_before: "2026-10-09T16:00:00.000Z" });
    const { status, body } = await callRoute(service, `/issues/once-generated?${query}`, ["issues", "once-generated"]);
    assert.equal(status, 200); assert.equal(body.delivered, 2); assert.equal(body.total, 2);
    assert.deepEqual((body.per_session as Array<{id: string}>).map(row => row.id), ["issue-end", "issue-start"]);
    assert.equal((body.localization as {total: number}).total, 2);
  } finally { await service.shutdown(); (await import("node:fs")).rmSync(dataDir, { recursive: true, force: true }); }
});

test("repoShortName:去协议/域名/.git,取路径末两段", async () => {
  const { repoShortName } = await import("../web/src/repoIdentity.ts");
  assert.equal(repoShortName("https://git.example.com/team/alarm.git"), "team/alarm");
  assert.equal(repoShortName("https://git.example.com/alarm"), "alarm");
  assert.equal(repoShortName("https://git.example.com/team/alarm/"), "team/alarm");
  assert.equal(repoShortName("ssh://git@host:2222/team/platform.GIT"), "team/platform");
});
