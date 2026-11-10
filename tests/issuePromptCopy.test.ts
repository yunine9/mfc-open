/**
 * 提示词文案挂载器(ADR-0015)的契约测试:目录挂载、锚点协议、
 * {{var}} 替换的 fail-loud 纪律。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mountedPromptAnchors,
  promptCopy,
  PROMPT_SOURCE_DIR,
} from "../src/issueFlow/promptCopy.ts";

test("文案目录挂载:三个文件全部加载,锚点按域分布", () => {
  const anchors = mountedPromptAnchors();
  assert.ok(anchors.length >= 30, `锚点数量异常少: ${anchors.length}`);
  for (const file of ["opening", "notices", "receipts"]) {
    assert.ok(
      anchors.some((anchor) => anchor.startsWith(`${file}.`)),
      `${file}.md 没有挂载出任何锚点(源目录: ${PROMPT_SOURCE_DIR})`);
  }
  // 高频锚点抽检:契约/催办/单号门禁在,少一个都是让 Agent 裸奔。
  for (const key of [
    "opening.fixed.contract",
    "opening.resume.header",
    "notices.nudge.body",
    "receipts.push.no_ticket",
    "receipts.complete.stage_closed",
  ]) {
    assert.ok(anchors.includes(key), `关键锚点缺失: ${key}`);
  }
});

test("{{var}} 替换:数字自动转串,文本原样保序", () => {
  const text = promptCopy("receipts", "push.branch_mismatch", {
    expected: "master_dev_D1_20261015090000", branch: "main",
  });
  assert.match(text, /应为 master_dev_D1_20261015090000,实际 main/);
  assert.match(text, /基线_工号_单号_时间戳/, "静态部分不能丢(ADR-0063 命名口径)");
  const nudge = promptCopy("notices", "nudge.body", {
    attempt: 1, budget: 2,
    stage_brief: "当前阶段「问题分析」: X。出口: Y。可用工具: Z。",
    remain: 2,
  });
  assert.match(nudge, /平台催办\(第 1\/2 次\)/);
  assert.match(nudge, /当前阶段「问题分析」/);
  assert.match(nudge, /再无故停下 2 次/);
});

test("fail-loud:锚点缺失、变量缺失、替换后残留占位符都当场抛错", () => {
  assert.throws(
    () => promptCopy("receipts", "no.such.anchor"),
    /锚点不存在/,
  );
  assert.throws(
    () => promptCopy("receipts", "push.branch_mismatch"),
    /变量缺失.*\{\{expected\}\}/,
  );
  // md 里写了变量、代码没传,绝不允许静默出门。
  assert.throws(
    () => promptCopy("receipts", "mrgate.awaiting", {}),
    /变量缺失/,
  );
});

test("编译产物回收通知:继续原任务,按需重建且不保证依赖无需下载", () => {
  const notice = promptCopy("notices", "rework.products_reclaimed");
  assert.match(notice, /部分编译中间产物已释放/);
  assert.match(notice, /接着当前任务继续/);
  assert.match(notice, /答卡或继续分析无需立即编译/);
  assert.match(notice, /真正需要编译时检查现有准备情况/);
  assert.match(notice, /重新准备相关仓并编译/);
  assert.match(notice, /缺少的依赖仍需下载/);
  assert.doesNotMatch(notice, /node_modules|无需重新下载|首次编译是全量编译/);
});

test("本地验证按改动风险选择,如实报告并保留当前提交流水线验收", () => {
  const delivery = readFileSync(
    new URL("../assets/issue-skills/issue-delivery/SKILL.md", import.meta.url),
    "utf-8");
  assert.match(delivery, /可以直接提交推送,无需专门启动本地编译/);
  assert.match(delivery, /判断依据是风险,不是文件数量/);
  assert.match(delivery, /环境准备、首次构建和 UT 要求/);
  assert.match(delivery, /准备、下载和编译命令设合理超时/);
  assert.match(delivery, /同一错误先查原因再重试/);
  assert.match(delivery, /未做本地编译或测试就在交付说明中写明范围与原因/);
  assert.match(delivery, /当前提交真实流水线结果/);
  assert.doesNotMatch(delivery, /先写能复现问题的单测再改码转绿/,
    "简单修改无需为了启动验证专门编译,也不强制增加复现单测");
});

test("红灯材料的外部头提醒:声明平台已自动并好最新代码,不再给不可执行的拉取指引", () => {
  const notice = promptCopy("notices", "red.deliver.external_head", {
    sha: "abc123def456",
  });
  assert.match(notice, /平台已在回合开工时自动把远端最新代码合并进工作区/,
    "主线口径:平台自动并好,不再是让 AI 自己拉的空头指引");
  assert.match(notice, /不许回滚/, "外部提交纪律要在场");
  assert.match(notice, /sync_branch/, "冲突例外:指路 sync_branch 收尾");
  assert.match(notice, /abc123def456/);
  assert.doesNotMatch(notice, /先拉取分支最新代码/,
    "容器里没有拉取动作,这条指令执行不了(ADR-0074 的出发点)");
});

test("回合开始吸收的通知词(notices.absorb.*):各形态一段,纪律与指路齐全", () => {
  const merged = promptCopy("notices", "absorb.merged", {
    branch: "master_dev_D1_20261106090000", count: 2,
    from: "aaa111bbb111", to: "ccc333ddd333",
  });
  assert.match(merged, /并入 2 条外部提交/);
  assert.match(merged, /不许回滚/);
  assert.match(merged, /aaa111bbb111 → ccc333ddd333/);
  assert.match(merged, /重读相关文件/, "提醒旧上下文可能过时");

  const conflict = promptCopy("notices", "absorb.conflict", {
    branch: "master_dev_D1_20261106090000", count: 1, files: "a.txt",
  });
  assert.match(conflict, /已还原现场/, "现场还原要声明(不留半合并工作区)");
  assert.match(conflict, /照常进行/, "冲突不阻塞回合");
  assert.match(conflict, /不许回滚、不许用 ours\/theirs/);
  assert.match(conflict, /sync_branch/);
  assert.match(conflict, /a\.txt/);

  const blocked = promptCopy("notices", "absorb.blocked", {
    finding: "远端修复分支头 ccc333ddd333 的历史对不上,疑似被改写",
  });
  assert.match(blocked, /合并已暂停/);
  assert.match(blocked, /照常进行/);
  assert.match(blocked, /绝不自动处理、绝不强制覆盖/);
  assert.match(blocked, /转告用户/);

  const dirty = promptCopy("notices", "absorb.dirty", {
    count: 1, files: "b.txt",
  });
  assert.match(dirty, /未提交/);
  assert.match(dirty, /sync_branch/, "指路先收尾再同步");
  assert.match(dirty, /b\.txt/);

  const failed = promptCopy("notices", "absorb.failed", {
    reason: "merge 失败但没有冲突文件",
  });
  assert.match(failed, /已还原/);
  assert.match(failed, /照常进行/);
  assert.match(failed, /sync_branch/);
});
