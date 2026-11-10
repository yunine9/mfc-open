/**
 * 问题流子 Agent 派发(2026-09-06 开闸)的契约测试:
 * - 主会话模型可派 Task,子 Agent 事件(agent_spawned/agent_finished)
 *   落事件账,主流程不受派发阻断;
 * - 安全边界(结构性,代码即证据):子会话 extraTools 强制为空
 *   (sessionDriver.runSubagent),complete_stage/push_branch 等业务
 *   工具只存在于主会话;子内提问/再派发由框架拒绝工具打回。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { mfcTemp } from "./mfcTmp.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function bareOrigin(root: string): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

const MODULE_ID = "pay-core";

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("子 Agent 派发:Task 落账不阻断主流程,业务工具不进子会话", async () => {
  const dataDir = mfcTemp("mfc-issue-subagent-");
  const origin = bareOrigin(dataDir);
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    // 主 Agent 派子 Agent 复核证据;下一个场景是子会话的最终报告。
    { tool: { name: "Task", input: {
      subagent_type: "reviewer",
      description: "复核证据完整性",
      prompt: "复核 repo/origin 的登录超时证据,回复:复核完成,无补充。",
    } } },
    { text: "复核完成,无补充。" },
    { tool: { name: "bash", input: { command:
      "printf '# 初步定位\\n\\n## 问题现象\\n演示。\\n## 问题根因\\n是问题(索引缺失)。\\n## 置信度\\n高。\\n## 修改方案\\n补索引。\\n' > issue-analysis.md" } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "issue", summary: "是问题:索引缺失" } } },
    { text: "结论是问题,已提交等用户确认。" },
  ];
  // linear=跨会话顺演:Task 派发后子会话也是模型请求方,剧本必须按
  // 请求顺序推进(默认按对话深度选幕,子会话深度=0 会重演第一幕)。
  const model = new ScriptedModelServer(script, "scripted-v1", {
    linear: true,
  });
  await model.start();
  const service = new IssueFlowService({
    dataDir, provider: "maeflow", model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  try {
    createBusinessModule(dataDir, {
      id: MODULE_ID, name: "支付核心", description: "收单与清结算",
      owner: "dev", repositories: [origin],
    }, "tester");
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID,
      environment: {
        hosts: ["192.0.2.8"], backendPassword: "b",
      },
    });
    // 派发不阻断主流程:分析照常提交,结论闸照常升起。
    const gate = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "waiting_user" && issue.gate?.kind === "conclude"
        ? issue : undefined;
    }, "结论确认闸(派发不阻断主流程)");
    assert.equal(gate.gate?.proposal?.conclusion, "issue");

    // 事件账:派发与收口都有据可查。
    const events = readFileSync(
      join(dataDir, "issues", created.id, "events.jsonl"), "utf-8");
    assert.match(events, /agent_spawned/);
    assert.match(events, /agent_finished/);
    assert.match(events, /"lifecycle":"returned"/,
      "子 Agent 正常收口(非中断)");

    // 结构性边界:子会话仅可继承只读 knowledge(sessionDriver 限定),业务
    // 工具调用只可能来自主会话——事件账里 complete_stage 的调用次数
    // 等于剧本里的 1 次(若子会话能看到业务工具,模型剧本顺序错乱会
    // 在此显式暴露)。
    const stageCalls = events.split("\n").filter((line) =>
      line.includes('"kind":"tool_requested"')
      && line.includes('"name":"complete_stage"')).length;
    assert.equal(stageCalls, 1,
      "complete_stage 只在主会话发生一次(子会话 extraTools 为空,"
        + "结构性无业务工具)");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
    writeFileSync(join(dataDir, "done"), "ok");
  }
});
