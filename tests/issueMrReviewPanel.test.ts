import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/** 「MR 检视」签批注面板的处置契约(2026-09-18 走查):
 *  1. 处置词表随实情:远端讨论删不掉,本地软删的动作叫「忽略」,且
 *     忽略会顺手在 CodeHub 代点已解决;自行答复可勾选代点;本地闭环
 *     纯本地;
 *  2. 多仓流程,批注按归属仓分组(仓取自 external_review.scope 的
 *     `仓名:iid` 前缀,同步侧拼装);
 *  3. 忽略先过全站确认框(spec #52):一键带「CodeHub 代点已解决」
 *     的外向不可逆副作用,且与相邻小按钮易误触(有用户误点反馈)。 */
const panel = readFileSync(
  resolve("web/src/issues/IssueExternalReviewPanel.tsx"), "utf-8");

test("MR 检视批注:本地动作叫「忽略」,忽略代点远端已解决", () => {
  assert.match(panel, /confirmDialog\(\{[\s\S]*?confirmLabel: "忽略"/,
    "忽略先过全站确认框(spec #52):远端代点已解决收不回,防误触");
  assert.match(panel, /danger: true/,
    "危险档:确认钮 destructive,焦点落「取消」,手滑连按回车不会误忽略");
  assert.match(panel, /dropIssueReview\(issueId, item\.id\)/,
    "忽略的落点仍是本地软删 + 远端代点已解决那一个后端动作");
  assert.ok(!panel.includes(">删除<"),
    "按钮词表:远端讨论删不掉,不叫删除");
  assert.match(panel, /本地忽略并留痕，同时在 CodeHub 把这条讨论标记为已解决/,
    "忽略钮如实说明远端半边");
  assert.match(panel, /自行答复可勾选同时在 CodeHub 标已解决；忽略也会代点已解决/,
    "提示行把各处置的远端语义说清");
  assert.ok(!panel.includes(">本地闭环<"),
    "本地闭环已随 2026-09-18 走查退役:了结路径只剩 Agent处理/自行答复/忽略");
  assert.match(panel, />Agent处理</,
    "交办加料的入口按用户词表叫 Agent处理");
});

test("MR 检视批注:按归属仓分组,仓取自 scope 前缀,缺席落未知仓", () => {
  assert.match(panel, /export function reviewRepo/);
  assert.match(panel, /scope\.indexOf\(":"\)/);
  assert.match(panel, /return cut > 0 \? scope\.slice\(0, cut\) : "未知仓"/);
  assert.match(panel, /repoGroups\.map\(\(\[repo, repoItems\]\)/,
    "渲染按仓分组,组头带仓名与条数");
});
