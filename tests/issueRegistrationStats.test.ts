/**
 * 登记问题统计(ADR-0048,口径 2026-10-16 由 ADR-0064 收紧):无单
 * 会话的结论漏斗与研究质量。两层钉死:
 * 1. 纯聚合:人群=研究结论已出(非问题+确认是问题);取消是退场、
 *    不算研究结论,不进任何数字;一次定位分母=非问题+确认是问题;
 *    按模块/按登记人分组与合计一致。
 * 2. 真路由直调:GET /issues/registration-stats 从服务台账聚合同一
 *    口径(手搓响应对象,与 issueOnceRates 同一 seam 评审口径);
 *    进行中/有单/取消(含存量挂起读盘按取消退场)不进任何数字,
 *    days 过滤按结论时刻。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateRegistrationStats,
  type IssueRegistrationSessionRow } from "../src/issueFlow/registrationStats.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";

function row(overrides: Partial<IssueRegistrationSessionRow> = {}):
    IssueRegistrationSessionRow {
  return {
    id: "issue-x", title: "t", module: "网管", reporter: "王芳",
    account: "dev", concluded_at: "2026-09-20T00:00:00Z",
    conclusion: "issue", report_version_count: 1, localization_pass: true,
    ...overrides,
  };
}

test("纯聚合:瓦片计数与分母(人群=非问题+确认是问题,一次定位同分母)", () => {
  const stats = aggregateRegistrationStats([
    row({ id: "a" }),
    row({ id: "b", conclusion: "non_issue", localization_pass: false }),
  ]);
  assert.equal(stats.total, 2);
  assert.equal(stats.non_issue, 1);
  assert.equal(stats.issue_confirmed, 1);
  assert.deepEqual(stats.localization, { passed: 1, total: 2, rate: 50 },
    "一次定位分母=非问题+确认是问题");
});

test("纯聚合:按模块/按登记人分组,组内合计与瓦片一致", () => {
  const stats = aggregateRegistrationStats([
    row({ id: "a", module: "拓扑", reporter: "王芳" }),
    row({ id: "b", module: "拓扑", reporter: "李强", conclusion: "non_issue",
      localization_pass: false }),
    row({ id: "c", module: "告警", reporter: "王芳", conclusion: "non_issue" }),
  ]);
  assert.deepEqual(stats.by_module.map((entry) =>
    [entry.key, entry.total, entry.non_issue, entry.issue_confirmed]), [
    ["拓扑", 2, 1, 1], ["告警", 1, 1, 0],
  ]);
  const wangfang = stats.by_reporter.find((entry) => entry.key === "王芳");
  assert.ok(wangfang);
  assert.equal(wangfang.total, 2);
  assert.equal(wangfang.localization_total, 2, "组内定位分母=该组全部会话");
  assert.equal(wangfang.localization_rate, 100);
});

function issueGet(
  parts: string[],
  service: IssueFlowService,
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method: "GET", url: "http://x" } as any,
      {
        writeHead: (code: number) => { status = code; },
        end: (payload?: string) => {
          try { resolve({ status, body: JSON.parse(payload ?? "{}") }); }
          catch (error) { reject(error); }
        },
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
  });
}

const DAY = 86400000;

test("路由:人群=非问题+确认是问题;取消/存量挂起退场/进行中/有单不进;days 按结论时刻过滤", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-regstats-"));
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const seed = (id: string, extra: Record<string, unknown>) => {
    const root = join(dataDir, "issues", id);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "issue.json"), JSON.stringify({
      id, account: "dev", reporter: "tester",
      created_at: iso(now - 40 * DAY), updated_at: iso(now - 1 * DAY),
      title: id, description: "", source: "manual",
      scenario: "no_ticket", status: "archived", stage: "conclude",
      stage_note: "", ...extra,
    }));
  };
  // 确认是问题,一版报告 → 一次定位过。
  seed("issue-a", { module: "拓扑", reporter: "王芳",
    conclusion: { kind: "issue", summary: "是问题", at: iso(now - 2 * DAY) } });
  // 非问题,两版报告(修订快照在 reviews/)→ 一次定位不过。
  const rootB = join(dataDir, "issues", "issue-b");
  mkdirSync(join(rootB, "reviews"), { recursive: true });
  writeFileSync(join(rootB, "reviews", "issue-analysis@20260919T000000Z.md"),
    "# 修订");
  seed("issue-b", { module: "拓扑", reporter: "李强",
    conclusion: { kind: "non_issue", summary: "误报", at: iso(now - 5 * DAY) } });
  // 取消:退场不算研究结论,不入统计(ADR-0064)。
  seed("issue-c", { module: "告警", status: "canceled",
    updated_at: iso(now - 40 * DAY) });
  // 盘面旧词挂起:读盘按取消退场,同不入统计(ADR-0048/0057/0064)。
  seed("issue-hold", { module: "告警", status: "suspended" });
  // 研究进行中:不进。
  seed("issue-wip", { module: "性能", status: "idle", stage: "analyze" });
  // 有单交付:人群不同,不进登记问题页签。
  seed("issue-dts", { module: "性能", scenario: "ticket", ticket: "DTS-1",
    conclusion: { kind: "delivered", summary: "交付", at: iso(now - 2 * DAY) } });
  // 分析版本账:live 报告在场=初版,再放一份快照=修订。
  writeFileSync(join(dataDir, "issues", "issue-a", "issue-analysis.md"),
    "# 初步定位\n\n## 问题根因\nX");
  writeFileSync(join(dataDir, "issues", "issue-b", "issue-analysis.md"),
    "# 初步定位\n\n## 问题根因\nY");

  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    const { body } = await issueGet(["issues", "registration-stats"], service);
    assert.equal(body.total, 2, "分母=非问题+确认是问题;取消/挂起退场/进行中/有单全不进");
    assert.equal(body.canceled, undefined, "取消计数字段随 ADR-0064 退役");
    const ranged = service.registrationStats(undefined, { from: iso(now - 2 * DAY), before: iso(now - DAY) });
    assert.deepEqual(ranged.per_session.map(row => row.id), ["issue-a"], "#457 按完成日期区间包含起点，排除区间外及创建时间");
    assert.equal(ranged.total, 1); assert.equal(ranged.by_module[0].total, 1);
    assert.equal(body.non_issue, 1);
    assert.equal(body.issue_confirmed, 1);
    assert.deepEqual(body.localization, { passed: 1, total: 2, rate: 50 });
    const rows = body.per_session as Array<Record<string, any>>;
    assert.deepEqual(rows.map((entry) => entry.id), ["issue-a", "issue-b"],
      "明细按结论时刻降序;取消与挂起退场会话不在场");
    assert.equal(rows.find((entry) => entry.id === "issue-b")
      ?.report_version_count, 2, "版本账=初版+修订快照");
    assert.equal(rows.find((entry) => entry.id === "issue-b")
      ?.localization_pass, false, "一次定位人人有评,取消行退场后无缺席态");
    const topo = (body.by_module as Array<Record<string, any>>)
      .find((entry) => entry.key === "拓扑");
    assert.equal(topo?.total, 2);
    assert.equal(topo?.canceled, undefined, "分组取消列随 ADR-0064 退役");
    assert.equal(topo?.localization_rate, 50);
    const wangfang = (body.by_reporter as Array<Record<string, any>>)
      .find((entry) => entry.key === "王芳");
    assert.equal(wangfang?.total, 1);

    // days 过滤按结论时刻走:a 收口在 2 天前,b 在 5 天前,3 天窗只剩 a。
    // days 走查询串,不在 parts 里;url 假件带 query 由路由自行解析。
    const filtered = await new Promise<{ status: number; body: Record<string, any> }>(
      (resolve, reject) => {
        let status = 0;
        void handleIssueRoutes(
          { method: "GET", url: "http://x?days=3" } as any,
          {
            writeHead: (code: number) => { status = code; },
            end: (payload?: string) => {
              try { resolve({ status, body: JSON.parse(payload ?? "{}") }); }
              catch (error) { reject(error); }
            },
          } as any,
          ["issues", "registration-stats"],
          { issueFlow: service, authEnabled: false },
        ).catch(reject);
      });
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.total, 1, "b 收口在 5 天前,出 3 天窗");
    assert.equal((filtered.body.per_session as Array<Record<string, any>>)
      .map((entry) => entry.id).join(","), "issue-a");
  } finally {
    await service.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
