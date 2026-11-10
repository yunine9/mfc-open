/**
 * 分析期的两件事(2026-09-04 用户反馈):
 * 1. 卡上不能拿 repo-1/repo-2 指代仓库——人看不出是哪个仓;
 * 2. 受邀参与讨论的人要能看、能答决策卡,拍板类决定仍只认责任人。
 * 端到端的一段在 chainAnalysis.test.ts(真会话举卡);这里是纯函数契约
 * 加各层口径的静态对拍,防止哪一层被顺手改回去。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { humanizeRepositoryIds } from "../src/repositoryNames.ts";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

test("repo-N 序号换成仓库名:只换整词,不吃前缀,没有名字就原样留", () => {
  const repositories = [
    { id: "repo-1", name: "svc-api" },
    { id: "repo-2", name: "svc-web" },
    { id: "repo-3", name: "repo-3" },
  ];
  assert.equal(
    humanizeRepositoryIds("repo-1 的接口先于 repo-2 合入,repo-2/src 改动面", repositories),
    "svc-api 的接口先于 svc-web 合入,svc-web/src 改动面");
  assert.equal(humanizeRepositoryIds("my-repo-1 与 repo-10 不动", repositories),
    "my-repo-1 与 repo-10 不动", "前缀/更长序号不能被误换");
  assert.equal(humanizeRepositoryIds("repo-3 没名字", repositories), "repo-3 没名字");
  assert.equal(humanizeRepositoryIds("", repositories), "");
  assert.equal(humanizeRepositoryIds("repo-1", []), "repo-1");
});

test("受邀参与讨论的人能答卡:HTTP、decide 硬闸、前端三层口径一致", () => {
  const server = read("src/server.ts");
  assert.match(server,
    /parts\[2\] === "decision"[\s\S]{0,600}canCollaborate\(viewer, target, !!options\.auth\)/,
    "决策路由按参与讨论放行,不再只认责任人");
  const service = read("src/taskService.ts");
  assert.match(service, /assertOwnerDecides\(task, input\.actor, "确认拆分方案"\)/,
    "拆单只认责任人");
  assert.match(service, /assertOwnerDecides\(task, input\.actor, "决定拆不拆"\)/);
  assert.match(service, /assertOwnerDecides\(task, input\.actor, "确认进入需求分析"\)/);
  assert.match(service, /humanizeQuestionText: analysisOnly/,
    "序号替换只挂分析会话");
  assert.match(service, /仓库清单（仓库名 \| 原始地址 \| 本地只读分析路径）/);
  const app = read("web/src/App.tsx");
  assert.match(app, /canOperate=\{canOperate\(task\)\} canDecide=\{canCollaborate\(task\)\}/,
    "我的需求列表:参与讨论的单子能答卡但不能管任务");
  assert.match(app, /discussions: myWaiting\.filter\(invitedToDiscuss\)/,
    "待办收件箱把受邀讨论单独立成一类");
  const card = read("web/src/TaskCard.tsx");
  assert.match(card, /export function isOwnerOnlyWaiting/);
  assert.match(card, /participant && confirmsChainOption\(option\)/,
    "参与人卡上的拆单项锁住");
  const workspace = read("web/src/TaskWorkspace.tsx");
  assert.match(workspace, /const decides = isOwnerOnlyWaiting\(task\)[\s\S]{0,180}viewerUsername === \(task\.luban_account \?\? "本地用户"\)/, "拍板卡只认当前任务责任人，管理员不能代签");
  // 2026-09-05 起决定卡渲在右栏会话流里:能答的人拿到 WaitingCard,不能答的拿到只读说明。
  assert.match(workspace, /currentCard=\{waiting \? \(decides \? \(/);
});
