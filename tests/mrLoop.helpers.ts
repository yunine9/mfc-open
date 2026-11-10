/**
 * MR 闭环(docs/mr-loop-adaptation.md,对照内网既有框架):
 * - 失败先分类再派单:检视 > 冲突 > CI,同时多项只修最高优先级一路;
 * - 重试语义:只有 CI 修复累加 round,检视/冲突触发时清零;
 * - 检视闭环:意见落盘→专职会话逐条回复→宿主发布并标已解决;
 * - 冲突修复:宿主 merge 造真实冲突标记,agent 在真冲突上解;
 * - 等人门禁(审批/投票/WIP):挂起等待,不派 agent 不扣重试,说清卡在哪;
 * - MR 平台终态:merged=完成,closed=失败请人工;
 * - 平台不支持门禁契约(404)= 旧语义一字不变(delivery.test.ts 全兜着)。
 *
 * 拆分后的共享夹具与辅助函数(原 tests/mrLoop.test.ts 逐字搬移;
 * 2026-09-11 按负载均衡拆成 mrLoop.part1-6,单文件 557s 曾是全量
 * 测试的墙钟地板——node:test 按文件并行、文件内串行)。不带
 * .test.ts 后缀,测试运行器不会执行本文件;各 part 按需 import,
 * 断言与测试行为零变化。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import type { PrePushRunner } from "../src/prepushAgent.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

export const KERNEL_ROOT = (() => {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  return found;
})();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-mrl-src-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  writeFileSync(join(dir, "a.txt"), "base\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

/** 首跑 Agent 只改业务文件；测试宿主负责阶段与提交。 */
export function walkScript(): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "echo change > a.txt" } } },
    { text: "交付完成。" },
  ];
}

/** 模拟 Agent 按新契约逐条留下结构化回执。真实场景由使命提示写文件；
 * 测试从宿主已经落好的 local-annotations.json 取稳定 id/revision。 */
export function localReviewReceiptCommand(summary: string): string {
  const safeSummary = JSON.stringify(summary);
  return "node -e 'const fs=require(\"fs\");"
    + "const p=JSON.parse(fs.readFileSync(\"../reviews/local-annotations.json\",\"utf8\"));"
    + `const summary=${safeSummary};`
    + "fs.writeFileSync(\"../reviews/local-receipts.json\",JSON.stringify({receipts:p.annotations.map(a=>({annotation_id:a.id,revision:a.rework||0,outcome:\"fixed\",summary,evidence:[a.file+\":\"+a.line]}))}))'";
}

/** 模拟 Agent 按使命为流水线/冲突等机器来源逐条写回执。 */
export function feedbackReceiptCommand(summary: string): string {
  const safeSummary = JSON.stringify(summary);
  return "node -e 'const fs=require(\"fs\"),c=require(\"crypto\");"
    + "const d=\"../kernel-delivery\";const ps=fs.readdirSync(d)"
    + ".filter(x=>x.startsWith(\"feedback-open-\"));"
    + "fs.mkdirSync(\"../feedback\",{recursive:true});"
    + `const summary=${safeSummary};`
    + "for(const p of ps){const b=JSON.parse(fs.readFileSync(d+\"/\"+p,\"utf8\"));"
    + "const id=b.batch_id;const name=\"result-\"+c.createHash(\"sha256\")"
    + ".update(id).digest(\"hex\").slice(0,24)+\".json\";"
    + "fs.writeFileSync(\"../feedback/\"+name,JSON.stringify({schema:"
    + "\"mae-flow-feedback-results/1\",batch_id:id,results:b.items.map(x=>({"
    + "id:x.id,status:\"fixed\",summary,evidence:\"a.txt\"}))}));}'";
}

export function buildService(
  platform: FakeGitPlatform,
  dataDir: string,
  modelsJson: Record<string, unknown>,
  deliveryExtra: {
    resolveDiscussions?: boolean;
    pollTimeoutMs?: number;
    repairRounds?: number;
  } = {},
  prepushRunner?: PrePushRunner,
): TaskService {
  const service = new TaskService({
    dataDir, provider: "maeflow", model: "scripted-v1", modelsJson,
    // 主流程剧本按次序消费；经验旁路使用独立假响应，不消耗下一幕。
    memoryDrafter: async () => JSON.stringify({ trigger: "修改交付代码时", scope: "one_off", conclusion: "测试候选，待人工确认。" }),
    log: process.env.DEBUG_CONTINUOUS_REVIEW ? console.error : undefined,
    host: { kernelRoot: KERNEL_ROOT, repoPath: platform.barePath,
            python: "python3", continuousReview: true },
    delivery: { platformUrl: platform.baseUrl, pollIntervalMs: 120,
                ...deliveryExtra },
    ...(prepushRunner
      ? { prepush: { enabled: true, runner: prepushRunner } } : {}),
  });
  // 与 delivery.helpers.ts 同理(ec3011b0):首次 MR 旁路摘要(0d350630)
  // 走同一个线性假模型，会在首轮 MR 创建后抢走后续修复幕——实测修复
  // bash 幕被摘要会话领走("Tool bash not found")，主会话只剩收尾文本，
  // 逐条回执缺失，修复环停在 halted。摘要本身由 deliverySummary.test.ts
  // 独立验证，本夹具只验证 MR 闭环状态机。
  (service as unknown as { deliverySummaries: { start: () => void } })
    .deliverySummaries.start = () => {};
  return service;
}

export function mrModel(script: Scene[], dataDir: string): ScriptedModelServer {
  return new ScriptedModelServer(script, "scripted-v1", {
    linear: true,
    beforeScene: managedFlowFixture(dataDir, { continuousReview: true }),
  });
}

export async function until(
  probe: () => boolean,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
    await new Promise((tick) => setTimeout(tick, 80));
  }
}

/** 本地人工意见触发的修改统一在 push 前回到意见作者手里。测试辅助只
 * 代演真实交互：责任人逐条处置，再由任务责任人确认最终代码。 */
export async function closeWorkspaceReview(
  service: TaskService,
  id: string,
  annotations: Array<{ id: string; author: string }>,
): Promise<void> {
  await until(() => service.get(id)?.status === "waiting_for_human"
    && service.get(id)?.waiting?.step === "cloud_push_confirm",
  "人工意见修改后进入复检");
  for (const annotation of annotations) {
    service.verifyAnnotation(id, annotation.id, service.get(id)?.luban_account ?? "本地用户");
  }
  const waiting = service.get(id)!.waiting!;
  const question = (waiting.question as any).questions[0].question;
  await service.decide(id, {
    waiting_id: waiting.waiting_id,
    state_version: waiting.state_version,
    selected_options: { [question]: "确认推送" },
  });
}
