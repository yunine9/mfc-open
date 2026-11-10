/**
 * workflows 资产库 UI 锚点(#252,#251 审计闭环核定):
 * - P0 状态胶囊:手搓 `em.status-*` 四色全灭,换 shadcn Badge 语义 variant
 *   (draft→neutral、pending_review→warning、published→success、archived→suspended);
 * - P1 搜索框:label.wf-library-search(自带边框)嵌自带边框的 shadcn Input
 *   是双层边框 + ~110px 死区的根因,收成单一 InputGroup 搜索壳、Input 撑满;
 * - P2 「工作流」叫法统一:页签(App)/库标题/详情返回键不再一个对象三个名。
 * 渲染冒烟走根侧 renderToStaticMarkup(uiDialogSmoke 同款装载);叫法一致
 * 性用源码扫描(issueUiContracts 同款)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";

// 根测试运行器按 classic JSX 装载 web 组件(uiDialogSmoke 用例同款)。
(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { WorkflowLibrary } = await import("../web/src/workflows/WorkflowLibrary.tsx");
const { WorkflowDetail } = await import("../web/src/workflows/WorkflowDetail.tsx");
const { statusBadgeVariants, statusLabels } = await import(
  "../web/src/workflows/model.ts");

const here = dirname(fileURLToPath(import.meta.url));

function summary(status: keyof typeof statusLabels) {
  return {
    id: `wf-${status}`, name: `演示-${statusLabels[status]}`,
    description: "四色胶囊锚点用例", scope: "team" as const, owner: "admin",
    maintainers: [], status, latest_version: 0, draft_revision: 1,
    selectable_for_tasks: false, updated_at: "2026-09-11T00:00:00.000Z",
    permissions: { can_view: true, can_edit: true, can_submit: true,
      can_publish: true, can_archive: true },
  };
}

function renderLibrary(status: keyof typeof statusLabels): string {
  return renderToStaticMarkup(React.createElement(WorkflowLibrary, {
    workflows: [summary(status)], onSelect: () => {},
  }));
}

function renderDetail(status: keyof typeof statusLabels): string {
  return renderToStaticMarkup(React.createElement(WorkflowDetail, {
    detail: {
      asset: summary(status), versions: [],
      draft: {
        revision: 1, digest: "sha256:" + "a".repeat(64),
        updated_at: "2026-09-11T00:00:00.000Z", updated_by: "admin",
        definition: {
          schema: "mae-flow-workflow-definition/1",
          base: { standard_id: "mae-flow.standard",
            standard_version: "2.0.0", catalog_digest: "sha256:" + "a".repeat(64) },
          applicability: { business_module_ids: [], repositories: [], technologies: [] },
          edits: [],
        },
      },
    },
    onBack: () => {},
  }));
}

test("P0 状态胶囊四色:draft/pending_review/published/archived 各归语义 Badge variant", () => {
  const expected = [
    ["draft", "neutral", "bg-muted text-muted-foreground"],
    ["pending_review", "warning", "bg-attention-soft text-attention"],
    ["published", "success", "bg-success-soft text-success"],
    ["archived", "suspended", "bg-suspended/10 text-suspended"],
  ] as const;
  // 映射表必须恰好覆盖四个状态,不许多不少。
  assert.deepEqual(Object.keys(statusBadgeVariants).sort(),
    ["archived", "draft", "pending_review", "published"]);
  for (const [status, variant, pillClass] of expected) {
    assert.equal(statusBadgeVariants[status as keyof typeof statusBadgeVariants],
      variant, `${status} 必须映射到 ${variant}`);
    const pattern = new RegExp(`class="[^"]*${pillClass.replace("/", "\\/")}`);
    // 详情头对四个状态都直接出徽标。
    const detail = renderDetail(status);
    assert.match(detail, new RegExp(`data-slot="badge" data-variant="${variant}"`),
      `${status} 详情徽标必须带语义 variant ${variant}`);
    assert.match(detail, pattern, `${status} 徽标必须是 ${variant} 的 soft 底配方`);
    assert.doesNotMatch(detail, new RegExp(`status-${status}\\b`),
      `${status} 不得再挂手搓 em 状态类`);
    assert.doesNotMatch(detail, /<em[\s>]/, "详情头不得再有 em 药丸");
    if (status === "archived") continue; // 库默认「当前」页签,归档卡在 SSR 不出现
    const html = renderLibrary(status);
    assert.match(html, new RegExp(`data-slot="badge" data-variant="${variant}"`),
      `${status} 列表徽标必须带语义 variant ${variant}`);
    assert.match(html, pattern, `${status} 徽标必须是 ${variant} 的 soft 底配方`);
    assert.doesNotMatch(html, new RegExp(`status-${status}\\b`),
      `${status} 不得再挂手搓 em 状态类`);
    assert.doesNotMatch(html, /<em[\s>]/, "列表卡不得再有 em 药丸");
  }
});

test("P0 状态胶囊:手搓 <em> 药丸在库与详情两个挂点全部退役", () => {
  const html = renderLibrary("published");
  assert.doesNotMatch(html, /<em[\s>]/, "列表卡不得再有 em 药丸");
  const detail = renderDetail("published");
  assert.doesNotMatch(detail, /<em[\s>]/, "详情头不得再有 em 药丸");
  assert.match(detail, /data-slot="badge" data-variant="success"/);
});

test("P1 搜索框:单一 InputGroup 搜索壳,Input 撑满,无双层边框/固定宽死区", () => {
  const html = renderLibrary("draft");
  assert.match(html, /data-slot="input-group"/, "搜索框要走 shadcn InputGroup 壳");
  assert.match(html, /data-slot="input-group-control"/, "输入框是壳内控件");
  assert.match(html, /aria-label="搜索工作流"/, "可访问名不得丢");
  assert.doesNotMatch(html, /wf-library-search/, "旧 wrapper 类(自带边框)必须退役");
  assert.doesNotMatch(html, /\bw-56\b/, "固定 224px 宽是死区根因,必须换成撑满");
});

test("P2 叫法统一:同一对象不再身兼「工作流方案/工作流资产/工作流」三名", () => {
  const app = readFileSync(join(here, "..", "web/src/App.tsx"), "utf-8");
  assert.doesNotMatch(app, /工作流方案/, "团队资产页签统一叫「工作流」");
  const detail = readFileSync(
    join(here, "..", "web/src/workflows/WorkflowDetail.tsx"), "utf-8");
  assert.doesNotMatch(detail, /工作流资产/, "详情返回键统一叫「工作流」");
  const library = readFileSync(
    join(here, "..", "web/src/workflows/WorkflowLibrary.tsx"), "utf-8");
  assert.match(library, /配置中心 \/ 团队工作流/, "团队资产视图拆散后，面包屑指向配置中心");
  assert.doesNotMatch(library, /工作流资产/, "错误横幅等文案不再叫「工作流资产」");
  // #256 收尾划转(#252 验收):帮助中心文案与固定工作流卡的
  // aria-label 同题同判,余量清零。
  const help = readFileSync(join(here, "..", "web/src/HelpCenter.tsx"), "utf-8");
  assert.doesNotMatch(help, /工作流方案/, "帮助中心文案统一叫「工作流」");
  assert.doesNotMatch(help, /工作流资产/, "帮助中心截图说明同图同称,不回旧名");
  const profileCard = readFileSync(
    join(here, "..", "web/src/WorkflowProfileCard.tsx"), "utf-8");
  assert.doesNotMatch(profileCard, /工作流方案/, "固定工作流卡 aria-label 统一叫「工作流」");
});
