/**
 * 会话卡片的一次结果章(详情端点 GET /issues/:id 的 once_outcome):
 * 只在「有单+修复完成归档(delivered)」上出章,判定与团队页一次率
 * 两轴同一函数(口径一处两用);无单、取消、失败、非问题收口不带
 * 字段——避免给没有修复旅程的会话误发「一次修复」章。终态会话优先
 * 读冻结快照(metrics.json),快照缺席回退现算,两条路都要对。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";

const BASE_STATE = {
  account: "dev", created_at: "2026-09-01T08:00:00Z",
  updated_at: "2026-09-01T09:00:00Z", title: "t", description: "",
  source: "dts", scenario: "ticket", stage: "env_verify",
  stage_note: "", stage_at: "2026-09-01T09:00:00Z",
};

const DELIVERED = {
  status: "archived",
  conclusion: { kind: "delivered", summary: "s",
    at: "2026-09-01T10:00:00Z" },
};

function seedSession(
  dataDir: string,
  state: Record<string, unknown>,
): string {
  const id = String(state.id);
  mkdirSync(join(dataDir, "issues", id), { recursive: true });
  writeFileSync(join(dataDir, "issues", id, "issue.json"),
    JSON.stringify({ ...BASE_STATE, ...state }));
  return join(dataDir, "issues", id);
}

/** 报告版本:live 文件=初版,reviews/ 快照各成一版。 */
function seedReport(root: string, versions: number): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue-analysis.md"), `# v${versions} live\n`);
  for (let index = 0; index < versions - 1; index += 1) {
    const dir = join(root, "reviews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `issue-analysis@r${(index + 1).toString(36)}.md`),
      `# snapshot ${index}\n`);
  }
}

async function getDetail(dataDir: string, id: string)
  : Promise<Record<string, unknown>> {
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  try {
    let status = 0;
    let body: Record<string, unknown> = {};
    await handleIssueRoutes(
      { method: "GET", url: `/issues/${id}` } as never,
      {
        writeHead: (code: number) => { status = code; },
        end: (output?: string | Buffer) => {
          body = JSON.parse(Buffer.isBuffer(output)
            ? output.toString("utf-8") : output ?? "{}");
        },
      } as never,
      ["issues", id],
      { issueFlow: service, authEnabled: false },
    );
    assert.equal(status, 200, `详情应 200(id=${id})`);
    return body;
  } finally {
    await service.shutdown().catch(() => undefined);
  }
}

test("修复完成归档:出章且与两轴同判——快照路", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncebadge-"));
  // 双失败现场:两版报告+一次验证失败(生产记账格式),期望 ✗✗;
  // 终态现场有 metrics.json(冻结快照),读侧应走快照。
  const root = seedSession(dataDir, { id: "issue-bad", ticket: "DTS1",
    ...DELIVERED, transitions: [{ at: "2026-09-01T09:00:00Z",
      source: "platform",
      note: "第 2 轮:用户环境验证发现问题:仍复现" }] });
  seedReport(root, 2);
  writeFileSync(join(root, "metrics.json"), JSON.stringify({
    schema_version: 1, generated_at: "2026-09-01T10:00:01Z",
    session_id: "issue-bad", terminal_status: "archived",
    ticket: "DTS1", verify_fail_count: 1, report_version_count: 2,
  }));
  // 对照现场:一版报告+零失败,期望 ✓✓。
  const rootGood = seedSession(dataDir, { id: "issue-good",
    ticket: "DTS2", ...DELIVERED });
  seedReport(rootGood, 1);

  const bad = await getDetail(dataDir, "issue-bad");
  const good = await getDetail(dataDir, "issue-good");
  assert.deepEqual(bad.once_outcome,
    { localization_pass: false, repair_pass: false }, "两版报告+验证失败=✗✗");
  assert.deepEqual(good.once_outcome,
    { localization_pass: true, repair_pass: true }, "一版+零失败=✓✓");
});

test("快照缺席回退现算:同一现场两条路出章一致", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncebadge-"));
  const root = seedSession(dataDir, { id: "issue-fallback", ticket: "DTS3",
    ...DELIVERED, transitions: [{ at: "2026-09-01T09:00:00Z",
      source: "platform", note: "用户环境验证发现问题:旧格式也计数" }] });
  seedReport(root, 3);
  const outcome = await getDetail(dataDir, "issue-fallback");
  assert.deepEqual(outcome.once_outcome,
    { localization_pass: false, repair_pass: false },
    "无快照时按转移账与版本账现算,两种记账格式都计入");
});

test("不适用即不出章:无单/非问题/取消/失败/在途一律无字段", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-issue-oncebadge-"));
  // 目录名必须 issue- 前缀(装载循环只认它),否则会话不进内存表。
  const nonTicket = seedSession(dataDir, { id: "issue-no-ticket",
    status: "archived",
    conclusion: { kind: "non_issue", summary: "误报",
      at: "2026-09-01T10:00:00Z" } });
  seedReport(nonTicket, 1);
  const canceled = seedSession(dataDir, { id: "issue-canceled",
    ticket: "DTS4", status: "canceled" });
  seedReport(canceled, 1);
  const failed = seedSession(dataDir, { id: "issue-failed",
    ticket: "DTS5", status: "failed" });
  seedReport(failed, 1);
  const inFlight = seedSession(dataDir, { id: "issue-inflight",
    ticket: "DTS6", status: "waiting_user", stage: "mr_green" });
  seedReport(inFlight, 1);
  // 盘面旧词 suspended:读盘归取消(ADR-0048/0057),同样不适用一次章。
  const suspended = seedSession(dataDir, { id: "issue-suspended",
    ticket: "DTS7", status: "suspended" });
  seedReport(suspended, 1);

  for (const id of ["issue-no-ticket", "issue-canceled", "issue-failed",
    "issue-inflight", "issue-suspended"]) {
    const detail = await getDetail(dataDir, id);
    assert.equal("once_outcome" in detail, false,
      `${id} 不适用一次结果章,字段不应出现(不渲染而非 false)`);
  }
  // 清理临时目录显式化(测试进程退出前的礼貌,非必需)。
  rmSync(dataDir, { recursive: true, force: true });
});
