/**
 * delivery 拆分后的共享夹具与辅助函数(原 tests/delivery.test.ts 逐字搬移)。
 * 不带 .test.ts 后缀,测试运行器不会执行本文件;
 * 各 delivery.partN.test.ts 按需 import,断言与测试行为零变化。
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitPlatform } from "../src/gitPlatform.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { MrDescriptionReplyService as TaskService } from "./support/mrDescriptionReply.ts";
import { RuntimeSettings } from "../src/settings.ts";
import { discoverKernelRoot } from "../src/kernelDiscovery.ts";
import { managedFlowFixture } from "./support/managedFlowFixture.ts";

// bootstrap 会真跑内核(INACTIVE 全放行),所以内核必须真找得到——
// worktree 里 cwd()/../mae-flow 不存在,手写路径曾让整批用例超时。
function kernelRootOrDie(): string {
  const found = discoverKernelRoot(process.cwd());
  if (!found) throw new Error("找不到内核(MAE_FLOW_HOME/../mae-flow/仓内 kernel/ 皆无)");
  return found;
}
export const KERNEL_ROOT = kernelRootOrDie();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** 模拟修复 Agent 按持续检视契约为本批每条反馈留下精确回执。 */
function feedbackReceiptCommand(summary: string): string {
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

export function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-dsrc-"));
  git(dir, "init", "--quiet", "-b", "master");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  return dir;
}

/** Agent 只改业务文件；分支、提交和测试终态由 managedFlowFixture 作为
 * 受信任宿主事实准备，绝不再让假模型覆盖内核状态。 */
export function walkScript(_allowHostPush = true, _authoritativeRepo?: string): Scene[] {
  return [
    { tool: { name: "bash", input: { command:
        "echo change > a.txt" } } },
    { text: "交付完成。" },
  ];
}

export function buildService(
  platform: FakeGitPlatform,
  dataDir: string,
  modelsJson: Record<string, unknown>,
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number;
           repairRounds?: number },
  settings?: RuntimeSettings,
) {
  const service = new TaskService({
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson,
    log: process.env.DEBUG_CONTINUOUS_REVIEW ? console.error : undefined,
    settings,
    // host 指向裸仓:克隆即从"服务端"取码。kernelRoot 不参与本测
    // (bootstrap 会跑,INACTIVE 全放行;状态文件由剧本伪造)。
    host: {
      kernelRoot: KERNEL_ROOT,
      repoPath: platform.barePath,
      python: "python3",
      continuousReview: true,
    },
    delivery: { platformUrl: platform.baseUrl, ...poll },
  });
  // 本夹具只验证交付状态机。首次 MR 旁路摘要使用同一个假模型会消耗
  // 线性剧本的下一幕，使 CI 修复命令被摘要会话执行，主会话跳过修复。
  // 摘要本身由 deliverySummary.test.ts 独立验证。
  (service as unknown as { deliverySummaries: { start: () => void } })
    .deliverySummaries.start = () => {};
  return service;
}

export function deliveryModel(
  script: Scene[],
  dataDir: string,
  options: { linear?: boolean; terminalStep?: "end" | "external_verify" } = {},
): ScriptedModelServer {
  return new ScriptedModelServer(script, "scripted-v1", {
    linear: options.linear,
    beforeScene: managedFlowFixture(dataDir, {
      terminalStep: options.terminalStep,
      continuousReview: true,
    }),
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
    await new Promise((tick) => setTimeout(tick, 100));
  }
}

export async function runTask(
  platform: FakeGitPlatform,
  push: boolean,
  poll?: { pollIntervalMs?: number; pollTimeoutMs?: number;
           repairRounds?: number },
  dataDir = mkdtempSync(join(tmpdir(), "mfc-deliver-")),
  extraScenes: Scene[] = [],
  settings?: RuntimeSettings,
  createExtras?: { repairRounds?: number; ticket?: string },
  linear = false,
) {
  const model = new ScriptedModelServer(
    [...walkScript(push, platform.barePath), ...extraScenes],
    "scripted-v1", {
      linear,
      beforeScene: managedFlowFixture(dataDir, {
        continuousReview: true,
        ...(!push ? { takeRepositoryOffline: platform.barePath } : {}),
      }),
    });
  await model.start();
  const service = buildService(
    platform, dataDir, model.modelsJson(), poll, settings);
  const created = service.create("交付 REQ9:演练交付链",
    { ticket: "REQ9", ...createExtras });
  const effectiveRepairRounds = createExtras?.repairRounds
    ?? settings?.runtime().repair_rounds ?? poll?.repairRounds;
  await until(() => {
    const current = service.get(created.id)!;
    if (["completed", "failed", "await_merge"].includes(current.status)) {
      return true;
    }
    if (current.status !== "verifying") return false;
    // running 是稳定的宿主等待态；终态 success/failed 还要等内核登记
    // 完成，避免在 pipelineVerdict 的异步窗口读到半份 delivery。
    return current.delivery?.pipeline === "running"
      || Boolean(current.delivery?.waiting_on)
      || ["halted", "exhausted"].includes(
        current.delivery?.loop?.state ?? "")
      || (effectiveRepairRounds === 0
        && (current.delivery?.pipeline ?? "").startsWith("failed"));
  }, "任务收口");
  await model.stop();
  return { task: service.get(created.id)!, service, dataDir };
}

/** 修复环剧本:一幕修复提交(可选)+一幕收口；传输始终归宿主。 */
export function repairScenes(commit: boolean): Scene[] {
  const command = commit
    ? `echo fixed >> a.txt; ${feedbackReceiptCommand("流水线问题已修复")}`
    : "git status --short";
  return [
    { text: "流水线红了,我来修。",
      tool: { name: "bash", input: { command } } },
    { text: "修复完成。" },
  ];
}
