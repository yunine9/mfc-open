/**
 * 异常重跑工作台入口的 UI 契约(票 #430,ADR-0055;先例:issueNavUi.test.ts)。
 *
 * 只断言 web/src 源码里外部可见的结构与交互锚点:重跑入口仅 failed 会话
 * 渲染(挂在归属人操作分支、与终止同位)、确认框带可留空的一句话说明、
 * 确认走既有 control 客户端发 revive(错误落既有 onError 通道)、发起中
 * 禁用防重、正文讲清与「重新发起」的差别(原地续跑全现场 vs 新开目录
 * 现场断代)。不测样式实现细节;api.ts 侧只钉请求类型联合与 note 字段。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const sessionView = readFileSync(
  resolve("web/src/issues/SessionView.tsx"), "utf-8");
const api = readFileSync(resolve("web/src/api.ts"), "utf-8");

/** 头部控件区(归档/终止/重跑同位的那一段)。 */
function headControls(): string {
  return sessionView.slice(
    sessionView.indexOf('className="ws-head-controls"'),
    sessionView.indexOf("</header>"));
}

/** 确认框整段(从开到关)。 */
function reviveDialog(): string {
  const start = sessionView.indexOf('<Dialog open={reviveOpen}');
  const end = sessionView.indexOf("</Dialog>", start);
  assert.ok(start > 0 && end > start, "确认框应存在于会话工作台");
  return sessionView.slice(start, end);
}

test("重跑入口:仅 failed 会话渲染,挂在归属人操作分支与终止同位", () => {
  const controls = headControls();
  // 整组沿用既有归属判断:归档/终止收在 canOperate 分支,重跑同组,
  // 不自造第二套权限(查看模式整组不渲染)。
  assert.ok(controls.includes("canOperate && <>"),
    "重跑入口必须挂在 canOperate 分支下(沿用归档/终止的归属判断)");
  // 渲染条件就是 failed 判定本身:其他状态不出现入口。
  const guardCount =
    (controls.match(/\{detail\.status === "failed" && <Button/g) ?? []).length;
  assert.equal(guardCount, 1,
    `重跑入口应以 failed 状态为唯一渲染条件,实际 ${guardCount} 处`);
  // 按钮本体:发起中禁用(防重),点击打开确认框,文案就叫「异常重跑」。
  const start = controls.indexOf('{detail.status === "failed" && <Button');
  const entry = controls.slice(start, controls.indexOf("</Button>", start) + 9);
  assert.ok(entry.includes("异常重跑"), "入口文案必须是「异常重跑」");
  assert.match(entry, /disabled=\{busy\}/, "发起中(busy)入口必须禁用防重");
  assert.match(entry, /setReviveOpen\(true\)/, "点击打开确认框");
  // 与取消同位:重跑排在终止之前(failed 下的两个出口并排)。锚
  // onClick 而不是文案——归档钮的禁用提示里也有「终止会话」字样。
  assert.ok(controls.indexOf('{detail.status === "failed" && <Button')
    < controls.indexOf('onClick={cancelSession}'),
    "重跑入口应与终止会话并排(操作区内,先恢复后放弃)");
});

test("确认交互:说明输入可留空,确认走既有 control 客户端发 revive", () => {
  // 调用串:经 perform 包裹的既有 controlIssue 客户端,action="revive"。
  // perform 的 catch 落 onError 既有通道,后端拒绝(状态已变等)不另造
  // 报错面。
  assert.match(sessionView,
    /void perform\(\(\) => controlIssue\(detail\.id, \{\s*\n\s*action: "revive",/,
    "确认重跑必须走 perform 包裹的既有 control 客户端发 revive");
  // 说明提交前 trim;空说明不发 note 字段(条件展开),可空提交。
  assert.match(sessionView, /const note = reviveNote\.trim\(\);/,
    "说明提交前要去首尾空白");
  assert.match(sessionView, /\.\.\.\(note \? \{ note \} : \{\}\),/,
    "空说明不携带 note 字段(后端按缺席取默认词)");
  // 输入位存在:受控输入,placeholder 讲清去向与可留空。
  const dialog = reviveDialog();
  assert.match(dialog, /<Input value=\{reviveNote\}/, "确认框要有说明输入");
  assert.match(dialog,
    /placeholder="可附一句话说明，随恢复回合送达 AI（可留空）"/,
    "placeholder 要说明「随恢复回合送达 AI」且可留空");
});

test("防重:发起中确认框与确认钮同样禁用,开合都过 busy 闸", () => {
  const dialog = reviveDialog();
  assert.match(dialog, /onOpenChange=\{\(open\) => \{ if \(!busy\) setReviveOpen\(open\); \}\}/,
    "发起中不许关确认框再开第二次(busy 闸)");
  assert.match(dialog, /disabled=\{busy\}/, "确认钮发起中必须禁用");
  assert.match(dialog, /onClick=\{reviveSession\}/,
    "确认钮接 reviveSession(确认后才发起)");
});

test("区分文案:确认框正文讲清异常重跑与重新发起的差别", () => {
  // 工作台没有「重新发起」入口,差别唯一讲在确认框正文:原地续跑全现场
  // vs 重新发起新开问题单目录、现场断代。
  const dialog = reviveDialog();
  assert.ok(dialog.includes("异常重跑") && dialog.includes("重新发起"),
    "正文必须同时点名「异常重跑」与「重新发起」");
  assert.ok(dialog.includes("原地续跑"), "正文要讲异常重跑=原地续跑");
  assert.ok(dialog.includes("现场断代") && dialog.includes("新开问题单目录"),
    "正文要讲重新发起=新开目录、现场断代");
  assert.ok(dialog.includes("分析报告") && dialog.includes("检视意见")
    && dialog.includes("人工决定") && dialog.includes("代码现场"),
    "正文要点名原地保留的四样现场:报告/检视/决定/代码");
  // 入口悬停提示同口径(按钮上就能看到第一条差别,不必先开确认框)。
  const controls = headControls();
  const start = controls.indexOf('{detail.status === "failed" && <Button');
  const entry = controls.slice(start, controls.indexOf("</Button>", start) + 9);
  assert.match(entry, /title="原地续跑[^"]*"/, "入口悬停提示要讲原地续跑");
});

test("api 客户端:control 动作联合含 revive,note 是请求侧字段", () => {
  const control = api.slice(api.indexOf("export function controlIssue"),
    api.indexOf("issueFetch(`/issues/", api.indexOf("export function controlIssue")));
  // 手动归档退役(ADR-0057),动作词只剩取消与异常重跑。
  assert.match(control, /action: "cancel" \| "revive";/,
    "动作联合类型要含 revive(#428 后端已上线)");
  assert.match(control, /note\?: string;/, "请求侧要有可选 note 字段");
});
