/**
 * 「元信息」首签(#239)的根侧 node 冒烟:经 Vite 的 SSR loader 装载
 * MetaPane(前端模块带 @/ 别名与 Badge→@base-ui 的间接引用,与
 * workspaceUiLogic 同款装法;根侧不裸引 @base-ui/lucide),再
 * renderToStaticMarkup 验关态静态渲染的事实。本仓刻意不为前端测试
 * 引入 jsdom:绑定标走 getBusinessModules 的 effect,SSR 不跑
 * effects——冒烟里绑定标按降级缺席,恰好就是这个降级路径的真实形态
 * (目录读不到/未取到时清单照列、标识不出);绑定标识的源码契约由
 * issueUiContracts 钉住。开态交互留给浏览器人工过目,别当它测过。
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import type { IssueDetail } from "../web/src/api.ts";

const vite = await createServer({
  root: "web",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
// 只按用到的形状标类型,不把组件源码拉进根类型程序(根 tsconfig 没有
// DOM lib,conversationStream 同款边界)。
const metaPaneModule = await vite.ssrLoadModule("/src/issues/MetaPane.tsx") as {
  IssueMetaPane: (props: { detail: IssueDetail }) => unknown;
};
const IssueMetaPane = metaPaneModule.IssueMetaPane as unknown as
  React.FunctionComponent<{ detail: IssueDetail; canOperate: boolean }>;
after(() => vite.close());

function detail(overrides: Partial<IssueDetail> = {}): IssueDetail {
  return {
    id: "issue-1",
    account: "zhou",
    created_at: "2026-09-10T02:00:00.000Z",
    updated_at: "2026-09-10T03:00:00.000Z",
    title: "网管侧告警未消除",
    description: "告警从周一持续至今,重启未恢复。",
    source: "manual",
    status: "running",
    stage: "analyze",
    stage_note: "",
    stage_at: "2026-09-10T02:00:00.000Z",
    has_environment: true,
    has_analysis: false,
    module: "传送网模块",
    module_id: "mod-1",
    environment: {
      credential_ref: "vault-ref-do-not-render",
      name: "省网网管",
      hosts: ["192.0.2.8"],
      port: 8443,
      env_type: "k8s",
    },
    repo_urls: [
      "https://git.example.test/team/alpha.git",
      "https://git.example.test/team/beta.git",
    ],
    ...overrides,
  } as IssueDetail;
}

function render(overrides: Partial<IssueDetail> = {}, canOperate = true): string {
  return renderToStaticMarkup(
    React.createElement(IssueMetaPane,
      { detail: detail(overrides), canOperate }));
}

test("无单会话元信息平铺陈列(无登记信息壳),凭据引用零出现", () => {
  const html = render();
  assert.ok(!html.includes("登记信息"), "「登记信息」壳已随 ADR-0026 退役");
  assert.match(html, /网管侧告警未消除/);
  assert.match(html, /告警从周一持续至今,重启未恢复。/);
  assert.match(html, /传送网模块/);
  assert.match(html, /省网网管/);
  assert.match(html, /10\.10\.0\.8/);
  assert.match(html, /端口 8443/);
  assert.match(html, /容器化/, "env_type=k8s 出中文形态(虚拟化/容器化口径)");
  assert.ok(!html.includes("vault-ref-do-not-render"),
    "服务端 vault 引用不上屏");
  // 字段区只读陈列;写口只存在于文末 #241 编辑器
  // (形状见下方「编辑骨架」test 与 issueUiContracts 源码契约)。
});

test("有单会话不渲染标题/问题描述(单据页签唯一出处),模块/环境照常", () => {
  const html = render({ source: "dts", ticket: "DTS2026090100001" });
  assert.ok(!html.includes("网管侧告警未消除"),
    "标题不得在 DTS 会话元信息出现(发起时它只是单据标题的抄本)");
  assert.ok(!html.includes("告警从周一持续至今"),
    "描述不得在 DTS 会话元信息出现");
  assert.match(html, /传送网模块/, "业务模块两场景都显");
  assert.match(html, /省网网管/, "网管环境两场景都显");
});

test("关联仓清单:仓名+完整 URL;SSR 降级无绑定标;回收标注与空态如实", () => {
  const html = render();
  assert.match(html, /关联仓清单/);
  assert.match(html, /alpha/);
  assert.match(html, /https:\/\/git\.example\.test\/team\/alpha\.git/);
  assert.match(html, /beta/);
  // effects 在 SSR 不跑,boundRepos 停在初始 undefined——绑定标按降级
  // 缺席,仓清单照列(与目录读不到的降级形态一致)。
  assert.ok(!html.includes("模块绑定"), "SSR 关态绑定标应缺席(降级路径)");
  const reclaimed = render({ repo_reclaimed_at: "2026-09-11T00:00:00.000Z" });
  assert.match(reclaimed, /现场已回收/);
  const empty = render({ repo_urls: undefined, repo_url: undefined });
  assert.match(empty, /会话没有登记代码仓/);
});

test("关联仓行融入交付事实(ADR-0027):角色标同步计算,无事实不占位", () => {
  const html = render();
  assert.match(html, /未交付/, "无推送记录的仓标未交付(repoDeliveryRows 纯函数,SSR 同步可断言)");
  assert.ok(!html.includes("逐仓交付"), "逐仓交付页签语义不再出现");
  assert.ok(!html.includes("还没有推送与 MR 记录"),
    "无交付事实不渲染占位行(第三行有才渲染)");
  // 有推送记录的仓标「变更仓」并陈列推送事实(branch@sha 前 10 位)。
  const delivered = render({
    pushes: [{
      repo: "https://git.example.test/team/alpha.git",
      branch: "master_zhou_DTS1", sha: "abc1234567",
      at: "2026-09-14T00:00:00.000Z",
    }],
  });
  assert.match(delivered, /变更仓/);
  assert.match(delivered, /已推送 master_zhou_DTS1@/);
  assert.match(delivered, /abc1234567/);
});

test("MR 人员失败静默，关联仓保留 MR 链接，成功和已有 MR 说明继续显示", () => {
  const mr: NonNullable<IssueDetail["mrs"]>[number] = {
    repo: "https://git.example.test/team/alpha.git", branch: "fix", title: "修复",
    at: "2026-10-13T00:00:00.000Z", url: "https://git.example.test/team/alpha/merge_requests/9", iid: "9",
    participants: { status: "failed", requested: {
      reviewers: ["reviewer1"], approval_approvers: ["approver1"],
    }, message: "CodeHub 权限不足" },
  };
  for (const state of [mr, { ...mr, merged_at: mr.at }, { ...mr, closed_at: mr.at }]) {
    for (const canOperate of [true, false]) {
      const html = render({ status: "archived", mrs: [state] }, canOperate);
      assert.doesNotMatch(html, /CodeHub 权限不足|MR 人员设置未完成|重试设置人员/);
      assert.match(html, /merge_requests\/9/);
    }
  }
  const success = render({ mrs: [{ ...mr, participants: { ...mr.participants!, status: "applied" } }] });
  assert.match(success, /已按模块配置设置 MR 人员。/);
  assert.doesNotMatch(success, /重试设置人员/);
  const existing = render({ mrs: [{ ...mr, participants: { status: "skipped", requested: mr.participants!.requested } }] });
  assert.match(existing, /已有 MR 保留原人员设置。/);
});

test("主动拉取/下载按钮(#267/#268):关态两钮全无(三态计数防闪现),终态/查看模式缺席拉取钮", () => {
  const html = render();
  // SSR 不跑 effects,logFileCount 停在"读取中"三态——拉取/下载两钮
  // 都不出:有日志的会话进页签不许闪现拉取钮再切换。
  assert.ok(!html.includes("下载日志"), "关态(清单未到)不出下载钮");
  assert.ok(!html.includes("拉取日志"), "关态不出拉取钮");
  const peer = render({}, false);
  assert.ok(!peer.includes("拉取日志"), "查看模式不出拉取写口(意图递交是写)");
  for (const status of ["canceled", "archived", "failed"] as const) {
    assert.ok(!render({ status }).includes("拉取日志"),
      `${status} 终态不出拉取钮(终态通知只会写成死信)`);
  }
});

test("空值如实降级,终态会话(canceled/archived)照常陈列且零编辑入口", () => {
  const unfilled = render({
    environment: undefined,
    module: undefined,
    description: "",
  });
  assert.match(unfilled, /\(未填\)/);
  assert.match(unfilled, /尚未配置——AI按需配置/,
    "环境空态从简(ADR-0026 翻案:拉取钮由环境门把守,文案不再兼职引导)");
  for (const status of ["canceled", "archived"] as const) {
    const html = render({ status });
    assert.match(html, /网管侧告警未消除/, "终态会话信息面照常可读");
    assert.match(html, /关联仓清单/);
    assert.ok(!/<button|<input|<textarea/i.test(html),
      `${status} 会话不渲染任何编辑入口`);
  }
});

test("#241 编辑骨架:非终态在场且关态可辨,终态零编辑入口", () => {
  const html = render();
  // 编辑骨架(新增输入 + 添加/确定按钮)只在非终态渲染。SSR 关态缓冲
  // 为空,「确定」必须带 disabled——「缓冲非空才可点确认」的门禁直接
  // 钉在静态标记里(交互态行为由 issueUiContracts 源码契约钉)。
  assert.match(html, /调整关联仓/);
  assert.match(html, /<input[^>]*aria-label="新增代码仓地址"/);
  assert.match(html, /添加到清单/);
  const confirmButton =
    html.match(/<button[^>]*>[\s\S]{0,200}?确定[\s\S]{0,80}?<\/button>/)?.[0]
      ?? "";
  assert.ok(confirmButton, "确定按钮在场");
  assert.match(confirmButton, /\bdisabled\b/, "缓冲为空时确定禁用(关态门禁)");
  // 终态会话(含 failed,与会话域终局口径一致)连编辑骨架都不出。
  for (const status of ["canceled", "archived", "failed"] as const) {
    assert.ok(!/<button|<input|<textarea/i.test(render({ status })),
      `${status} 会话零编辑入口`);
  }
});

test("已有 MR 元信息复用原面板，固定源仓库且无需网管环境", () => {
  const html = render({ scenario: "mr_repair", environment: undefined });
  assert.match(html, /关联仓清单/);
  assert.match(html, /本次只修复 MR 流水线，无需网管环境/);
  assert.doesNotMatch(html, /调整关联仓|新增代码仓地址|>移除</);
});
