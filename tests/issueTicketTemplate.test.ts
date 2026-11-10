/**
 * 提单模板与转正退役的路由契约(ADR-0048):模板读路由登录即可
 * (登记人只读可复制),缺席 404;关联转正显式 410 指引存量挂起取消
 * 收口(手动归档亦退役,ADR-0057)。
 * 模板内容三要素(版式/参考两节/防采信说明)由服务级闭环测试钉住
 * (issueFlowFixed.part1 / issueFlowMultiRepo),这里只钉过线协议。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";

function issueCall(
  method: string,
  parts: string[],
  service: IssueFlowService,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let status = 0;
    void handleIssueRoutes(
      { method } as any,
      {
        writeHead: (code: number) => { status = code; },
        end: (payload?: string) => resolve({ status, text: payload ?? "" }),
      } as any,
      parts,
      { issueFlow: service, authEnabled: false },
    ).catch(reject);
  });
}

function seedIssue(dataDir: string, id: string, kind: "issue" | "non_issue") {
  const root = join(dataDir, "issues", id);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "issue.json"), JSON.stringify({
    id, account: "dev", reporter: "tester",
    created_at: "2026-09-21T00:00:00Z", updated_at: "2026-09-21T00:00:00Z",
    title: `会话 ${id}`, description: "现象描述", source: "manual",
    scenario: "no_ticket", status: "archived", stage: "conclude", stage_note: "",
    conclusion: { kind, summary: kind === "issue" ? "是问题" : "非问题",
      at: "2026-09-21T00:00:00Z" },
  }));
}

test("提单模板读路由与转正退役 410(ADR-0048)", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-ticket-tpl-"));
  // 种子在服务构造前落盘:live 表在构造时装载,构造后补写不进表。
  seedIssue(dataDir, "issue-ok", "issue");
  writeFileSync(
    join(dataDir, "issues", "issue-ok", "issue-ticket-template.md"),
    "单据标题:会话 issue-ok\n参考:问题根因\n说明:不应直接采信");
  seedIssue(dataDir, "issue-no", "non_issue");
  const service = new IssueFlowService({
    dataDir, provider: "p", model: "m", modelsJson: {},
    dts: new MockDtsGateway(),
  });
  try {
    const ok = await issueCall("GET",
      ["issues", "issue-ok", "ticket-template"], service);
    assert.equal(ok.status, 200, "确认是问题闭环的会话模板在场");
    assert.match(ok.text, /单据标题:会话 issue-ok/);

    const absent = await issueCall("GET",
      ["issues", "issue-no", "ticket-template"], service);
    assert.equal(absent.status, 404, "非问题闭环没有模板,404 如实");

    const missing = await issueCall("GET",
      ["issues", "issue-missing", "ticket-template"], service);
    assert.equal(missing.status, 404, "不存在的会话同样 404");

    const retired = await issueCall("POST",
      ["issues", "issue-ok", "associate"], service);
    assert.equal(retired.status, 410, "关联转正显式退役");
    assert.match(retired.text, /闭环归档/, "410 文案指向现行为(确认即归档出模板)");
  } finally {
    await service.shutdown().catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
