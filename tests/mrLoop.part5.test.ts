/**
 * MR 闭环 part 5/6:门禁分类与失败详情:等人门禁、真实冲突、内网门禁集、失败维度点名、链接详情、假平台 E2E 两轮合入。
 * 共享夹具在 tests/mrLoop.helpers.ts(拆分背景见其头注);
 * 断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import {
  git,
  makeSourceRepo,
  walkScript,
  localReviewReceiptCommand,
  feedbackReceiptCommand,
  buildService,
  mrModel,
  until,
  closeWorkspaceReview,
} from "./mrLoop.helpers.ts";


test("等人门禁:挂起等待不派 agent,说清卡在哪;人批完合入收口", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.humanGates.approvers_passed = false; // 等审批
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-wait-"));
  const model = mrModel(walkScript(), dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:等审批").id;
    await until(() => service.get(id)!.status === "await_merge", "先到等待合入");
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "").includes("等审批"),
      "挂起等待要说清卡在哪");
    assert.equal(service.get(id)!.delivery?.loop, undefined,
      "等人不是失败,不开修复环不扣重试");
    // 审批人批了 → 平台合入
    platform.humanGates.approvers_passed = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("冲突门禁:宿主 merge 造真实冲突标记,会话在真冲突上解,推送后收口", async () => {
  const platform = new FakeGitPlatform();
  const source = makeSourceRepo();
  platform.initBare(source, mkdtempSync(join(tmpdir(), "mfc-p-")));
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-cf-"));
  const model = mrModel([
    ...walkScript(),
    // 冲突修复会话:确认标记在,解掉,完成合并提交；宿主随后推送
    { tool: { name: "bash", input: { command:
        "grep -q '<<<<<<<' a.txt && "
        + "printf 'change\\nupstream\\n' > a.txt && git add a.txt "
        + "&& git commit --quiet --no-edit; "
        + feedbackReceiptCommand("合并冲突已解决") } } },
    { text: "冲突已解并完成合并提交。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:解冲突").id;
    await until(() => service.get(id)!.status === "await_merge", "先绿");
    const preConflictSha = service.get(id)!.delivery?.sha;
    const taskState = JSON.parse(readFileSync(
      join(service.get(id)!.workspace, "task.json"), "utf-8"));
    const taskCwd = String(taskState.cwd);
    const mergeMarker = join(taskCwd, ".git", "merge-driver-ran");
    const mergeDriver = join(taskCwd, ".git", "malicious-merge.sh");
    writeFileSync(mergeDriver,
      `#!/bin/sh\nprintf compromised > '${mergeMarker}'\nexit 1\n`);
    chmodSync(mergeDriver, 0o700);
    writeFileSync(join(taskCwd, ".git", "info", "attributes"),
      "a.txt merge=owned\n");
    git(taskCwd, "config", "merge.owned.driver",
      `${mergeDriver} %O %A %B`);
    // 目标分支动了且与工作分支冲突(a.txt 两边都改)
    const other = mkdtempSync(join(tmpdir(), "mfc-mrl-other-"));
    execFileSync("git",
      ["clone", "--quiet", platform.barePath, join(other, "clone")]);
    const clone = join(other, "clone");
    git(clone, "checkout", "--quiet", "master");
    git(clone, "config", "user.email", "peer@test");
    git(clone, "config", "user.name", "peer");
    writeFileSync(join(clone, "a.txt"), "upstream\n");
    git(clone, "add", ".");
    git(clone, "commit", "--quiet", "-m", "master 侧改动");
    git(clone, "push", "--quiet", "origin", "master");
    platform.conflictGate = true;
    // 监控发现冲突 → 派冲突修复(不扣 CI 重试)
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "conflict",
      "冲突修复派单");
    assert.equal(service.get(id)!.delivery?.loop?.round, 0);
    // 会话解完推送(剧本里 grep 证明标记真实在场)→ 新流水线绿
    await until(() => service.get(id)!.status === "await_merge"
      && service.get(id)!.delivery?.sha !== preConflictSha,
    "解完推送新合并提交并回到 monitoring", 90_000);
    assert.equal(existsSync(mergeMarker), false,
      "宿主准备冲突不能执行 Agent 配置的自定义 merge driver");
    // 故意让平台冲突门禁多红几拍，模拟真实平台异步刷新。宿主已确认
    // HEAD 包含目标分支时必须继续监控，不能把陈旧门禁误判成“同 SHA
    // 修复无提交”而停环；旧实现稳定在这里进入 halted。
    await new Promise((tick) => setTimeout(tick, 600));
    assert.notEqual(service.get(id)!.delivery?.loop?.state, "halted",
      "平台冲突门禁刷新滞后不应触发同 SHA 刹车");
    platform.conflictGate = false;
    await until(() => service.get(id)!.status === "await_merge", "回到等待合入");
    // 合并提交信息的形状是**平台硬约束**(2026-08-18 拿到 pre-receive
    // 完整正则):放行 "Merge remote-tracking branch '…' into x" 与
    // git pull 那两种,**不放行本地 merge 的 "Merge branch 'master'
    // into x"**。所以宿主必须 merge origin/<target> 而不是 <target>
    // ——改错一个词,冲突修复的推送会在钩子那里被拒。
    const mergeSubject = git(platform.barePath, "log", "-1", "--format=%s",
      "master_bot_REQ9");
    assert.match(mergeSubject, /^Merge remote-tracking branch 'origin\//,
      `合并提交信息形状不对(平台钩子会拒收): ${mergeSubject}`);
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("内网真实门禁集(19 项):质量红要派发修复,受保护分支挂人话等待", async () => {
  // 2026-08-18 内网 selftest 第一次拿到真门禁集,比契约里的九项多十项。
  // 两件事必须钉死:
  // ①`codequality_passed` 是**改代码能解决的**(CodeCheck/CodeCC 那类),
  //   归到等人就会让 MR 卡着没人动、任务干等到预算耗尽——必须派发修复;
  // ②多出来的等人项要说人话:界面上"等 merged_by_user_passed"没人
  //   看得懂,而它的真实含义是"目标分支受保护,得让有权限的人点合入"。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  // 首跑流水线绿(ci_state_passed 过),但质量门禁红——这正是内网
  // 那条 MR 的形状:流水线与质量是两个门禁,别互相冒充。
  Object.assign(platform.humanGates, {
    codequality_passed: false,
    merged_by_user_passed: false,
    approval_reviewers_required_passed: true,
    committer_must_cast_two_votes_passed: true,
    non_ff_passed: true,
  });
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-19-"));
  const model = mrModel([
    ...walkScript(),
    // 质量修复会话:改代码并提交，宿主随后推送
    { tool: { name: "bash", input: { command:
        `echo quality-fixed >> a.txt; ${feedbackReceiptCommand("质量门禁已修复")}` } } },
    { text: "质量问题已修并提交。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:真实门禁集").id;
    // 质量门禁红 → 派 CI 那一路修复(不是干等)
    await until(() =>
      (service.get(id)!.delivery?.loop?.kind ?? "") === "ci",
      "质量门禁要派发修复而不是挂起");
    // 修完推新提交 → 质量门禁转绿 → 只剩"等人点合入"
    platform.humanGates.codequality_passed = true;
    await until(() =>
      (service.get(id)!.delivery?.waiting_on ?? "").includes("等有权限的人点合入"),
      "受保护分支要说人话");
    assert.ok(
      !(service.get(id)!.delivery?.waiting_on ?? "")
        .includes("merged_by_user_passed"),
      "别把平台字段名甩给人看");
    // 有权限的人点了合入 → 收口
    platform.humanGates.merged_by_user_passed = true;
    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "合入收口");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("日志只详细到一维时:失败维度逐项点名,不许修完细的那维就交差", async () => {
  // 2026-08-21 内网真实数据:log 里 CODECHECK 给到了文件+行号+规则
  // (1181 字),COMPILE 只有一句"构建失败=1"(build log 拿不到)。
  // 只喂 log,模型会照着详细那一维修完就提交,编译照旧红,又白烧一轮。
  // checks 是结构化的平台事实,失败维度必须点名进使命。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  platform.nextPipelineChecks = [
    { dimension: "COMPILE", status: "failed", job: "CloudBuild2.0" },
    { dimension: "UT", status: "success", job: "unit-test" },
    { dimension: "CODECHECK", status: "failed", job: "CodeCheck2.0" },
  ];
  platform.nextPipelineLog = [
    "FAILED stage=CodeCheck2.0",
    "【CODECHECK 告警明细】",
    "  NRANROpMgr.cpp:115 | function 'processAdviceStatus' exceeds size",
    "    规则: G.FUN.01-CPP 函数功能要单一",
  ].join("\n");
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-dims-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command: "git status --short" } } },
    { text: "CodeCheck 已修;COMPILE 这一维日志与 ../pipeline/ 均无失败原文,"
        + "不猜改——请补 build log 通道。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:逐项维度").id;
    await until(() =>
      (service.get(id)!.delivery?.loop?.state ?? "") === "halted",
      "无新提交应如实停下");
    const seen = model.requests
      .flatMap((request) => (request as any).messages ?? [])
      .map((message: any) => JSON.stringify(message.content ?? ""))
      .join("\n");
    assert.match(seen, /本轮失败的维度/, "失败维度要单独点名");
    assert.match(seen, /COMPILE\(CloudBuild2\.0\)/, "点名要带 job 便于定位");
    assert.match(seen, /CODECHECK\(CodeCheck2\.0\)/);
    assert.ok(!seen.includes("UT(unit-test)"), "过了的维度不许混进来");
    assert.match(seen, /尚未暂缓的每一维都要有明确处理结果/,
      "未暂缓的维度不能因为日志较少而漏掉，也不能重启责任人已暂缓的修复");
    // 日志本身有真内容,不该被"无证据"判据误伤
    assert.match(seen, /失败详情\(平台原文\)/);
    // 使命不许指挥内核没有的动作(2026-08-21 内网实锤,2026-08-25 瘦身
    // 后语义更新):交付主流程已不再签发 COMPILE/UT/CODECHECK 任务卡,
    // 原文让它"派专职子 agent",模型照做就在"要卡拿不到→生成被拒→
    // current 说在等流水线"之间空转。
    assert.match(seen, /不要找内核要 COMPILE\/UT\/CODECHECK 任务卡或派专职质量子 agent/,
      "得明说本轮没有质量任务卡可拿、不许派专职质量 agent");
    assert.ok(!/能派专职子 agent 的派专职去修/.test(seen),
      "旧话术会把模型支去撞内核的拦截");
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("失败详情只是个链接:不派 Agent、不扣修复轮次并明确等人", async () => {
  // 内网实锤:适配层把 log 填成流水线页面链接(会话没有登录态打不开),
  // 使命却包装成"失败详情(平台原文)"——会话以为自己有输入,硬着头皮
  // 定位→修改→提交,看着专业实为猜改。证据缺席必须明说,会话的正确
  // 行为才成立:能自证的修,不能自证的写诊断停下喊人。
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("failed");
  // 内网真实形态:标签 + 链接。第一版判据只认裸链接,正好漏掉它
  // (2026-08-21 读进场报告逮住)——用真实形态当裁判,别用理想形态。
  platform.nextPipelineLog =
    "FAILED stage=CodeCheck2.0 job=CodeCheck2.0  detail: "
    + "https://codecc.example.com/tasks/44944736";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-mrl-blind-"));
  const model = mrModel([
    ...walkScript(),
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson(),
    { pollTimeoutMs: 0 });
  try {
    const id = service.create("交付 REQ9:无证据修复").id;
    // 取证预算立即收口：没有可靠输入时连修复会话都不开。
    await until(() =>
      service.get(id)!.delivery?.evidence_gap?.state === "waiting_human",
      "无据时应如实等人工回灌");
    const task = service.get(id)!;
    assert.equal(task.delivery?.loop, undefined,
      "没有派发修复就不能凭空产生或扣掉修复轮次");
    assert.match(task.delivery?.waiting_on ?? "", /批注.*平台报错原文/);
    assert.deepEqual(task.delivery?.evidence_gap?.missing_dimensions,
      ["COMPILE"]);
  } finally {
    await model.stop();
    await platform.stop();
  }
});

test("假平台 E2E：同一 MR 经工作台意见与流水线反馈两轮后合入", async () => {
  const platform = new FakeGitPlatform();
  platform.initBare(makeSourceRepo(), mkdtempSync(join(tmpdir(), "mfc-p-")));
  platform.statusQueue.push("success", "failed", "success");
  platform.nextPipelineLog = "BUILD FAILURE: review change exposed null branch";
  await platform.start();
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-continuous-e2e-"));
  const model = mrModel([
    ...walkScript(),
    { tool: { name: "bash", input: { command:
        `echo reviewer-fix >> a.txt; ${localReviewReceiptCommand("批注要求已落实")}` } } },
    { text: "工作台意见已逐条处理。" },
    { tool: { name: "bash", input: { command:
        `echo pipeline-fix >> a.txt; ${feedbackReceiptCommand("流水线反馈已修复")}` } } },
    { text: "流水线反馈已修复。" },
  ], dataDir);
  await model.start();
  const service = buildService(platform, dataDir, model.modelsJson());
  try {
    const id = service.create("交付 REQ9:两类反馈持续闭环").id;
    await until(() => service.get(id)!.status === "await_merge", "首轮绿灯");
    const originalMr = service.get(id)!.delivery!.mr_url;
    const note = service.addAnnotation(id, {
      author: "developer", artifact: "未提交改动", file: "a.txt", line: 1,
      anchor: "change", note: "空值分支要返回明确错误", kind: "code",
    });
    await service.sendAnnotations(id, [note.id]);
    await closeWorkspaceReview(service, id, [note]);
    await until(() => service.get(id)!.delivery?.loop?.kind === "ci",
      "工作台修改触发的红灯进入流水线反馈");
    // 同一交付范围已获确认，CI 修复换 SHA 不应再弹第二次推送确认。
    await until(() => Boolean(service.get(id)!.status === "await_merge"
      && service.get(id)!.feedback?.some((item) =>
        item.source === "pipeline" && item.status === "closed")),
    "人工意见已闭环，旧流水线反馈随新推送归档");

    const beforeMerge = service.get(id)!;
    assert.equal(beforeMerge.waiting, undefined, "沿用已确认的交付范围，不重复询问");
    assert.equal(beforeMerge.delivery?.mr_url, originalMr, "全程只更新原 MR");
    assert.equal(platform.mergeRequests.length, 1, "不能为返工创建第二张 MR");
    assert.deepEqual(new Set(beforeMerge.feedback?.map((item) => item.source)),
      new Set(["workspace", "pipeline"]));
    assert.ok(beforeMerge.feedback?.every((item) => item.status === "closed"),
      "新 SHA 已取得权威绿灯，旧流水线反馈方可核销；人工意见仍须责任人真实闭环");
    assert.equal(beforeMerge.delivery?.pipeline, "success", "当前提交仍须取得自己的验证结果");

    platform.settleMr("master_bot_REQ9", "merged");
    await until(() => service.get(id)!.status === "completed", "MR 合入后终态");
    assert.equal(service.get(id)!.progress?.current_phase, "已合入");
  } finally {
    await model.stop();
    await platform.stop();
  }
});
