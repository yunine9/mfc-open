/**
 * 阶段 0 演练入口:真 pi(进程内 SDK)+ 剧本假模型跑完整链,
 * 然后把现场交给 Python 内核裁判(harness/verify_transcript.py)验收
 * ——证据判定只有一份权威实现,在 mae_flow_core 里,TS 不复刻。
 *
 * 用法: npm run probe [-- --out <目录>]
 * 前置: pi 不需要单独安装(SDK 内嵌);内核优先来自 MAE_FLOW_HOME 或
 * 随 Cloud 发布的 kernel/，快照缺席时才回退 ../mae-flow。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService, type GateDecision } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import { ScriptedModelServer, type Scene } from "./scriptedModel.ts";
import { CloudSession } from "./sessionDriver.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** 剧本(主/子会话共用,按各自对话的 tool_result 数走幕):
 * 工作区命令放行 → 危险命令打回 → 派发 UT 编写 Agent(子会话里再派发被嵌套封顶
 * 打回、提问被"子 Agent 不设人工节点"打回)→ 人工节点挂起 → 收口。 */
const SCRIPT: Scene[] = [
  { text: "先确认工作区可用",
    tool: { name: "bash", input: { command: "printf 'WORKSPACE_READY\\n'" } } },
  { tool: { name: "bash", input: { command: "rm -rf 演练禁区" } } },
  { tool: { name: "Task",
            input: { subagent_type: "ut-generator-agent",
                     description: "编写单元测试",
                     prompt: "只编写单元测试，不在本机运行" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "未提交 Diff 通过吗?",
                                   options: ["通过", "打回"],
                                   recommended: "通过" }] } } },
  { text: "UT_WRITE_RESULT: DONE 已按决定继续交付" },
];

function demoContract(
  _tool: string,
  value: string,
): GateDecision | undefined {
  if (value.includes("rm -rf")) {
    return {
      action: "deny",
      reason: "演练拦截:危险命令被打回,原样返回给 Agent",
    };
  }
  return undefined;
}

async function main(): Promise<number> {
  const outFlag = process.argv.indexOf("--out");
  const out = resolve(
    outFlag > 0 ? process.argv[outFlag + 1] : join(REPO_ROOT, ".probe"));
  rmSync(out, { recursive: true, force: true });
  const agentDir = join(out, "pi-agent");
  mkdirSync(agentDir, { recursive: true });

  console.log(`[probe] 进程内 pi + 剧本假模型演练,现场目录: ${out}`);
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  writeFileSync(
    join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));

  const mainPath = join(out, "transcript.jsonl");
  const humanGate = new HumanGate(join(out, "waiting.json"));
  const driver = await CloudSession.create({
    taskId: "PROBE-1",
    workspace: out,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(out, "events.jsonl")),
    transcript: new TranscriptStore(mainPath, "main"),
    gate: new GateService({ workspace: out, contract: demoContract }),
    humanGate,
    currentStep: () => "build",
    log: (message) => console.log(`  [pi] ${message}`),
  });

  try {
    let outcome = await driver.start(
      "交付 PROBE-1:完成需求并补齐单测；质量执行交给流水线");
    if (outcome.status !== "waiting_for_human" || !outcome.waiting) {
      console.log(`[probe] ❌ 预期人工节点挂起,实际: ${outcome.status}`);
      return 1;
    }
    console.log("  ⏸ 人工节点挂起,模拟 Web 审批提交决定…");
    const resolved = humanGate.resolve(outcome.waiting.waiting_id, {
      stateVersion: outcome.waiting.state_version,
      decision: "通过",
      notes: "演练自动决定;云端由 Web 审批页提交",
    });
    outcome = await driver.resumeWithDecision(resolved);
    if (outcome.status !== "turn_finished") {
      console.log(`[probe] ❌ 预期收轮,实际: ${JSON.stringify(outcome)}`);
      return 1;
    }
  } finally {
    driver.dispose();
    await model.stop();
  }

  // 内核裁判:证据判定的唯一权威实现在 mae_flow_core,这里只递现场。
  const judge = spawnSync(
    "python3",
    [join(REPO_ROOT, "harness", "verify_transcript.py"), out],
    { stdio: "inherit", encoding: "utf-8" },
  );
  return judge.status ?? 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[probe] 异常:", error);
    process.exit(1);
  },
);
