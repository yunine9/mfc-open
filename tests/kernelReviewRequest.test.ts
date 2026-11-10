import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { retireKernelReviewRequest } from "../src/kernelReviewRequest.ts";
import { HumanGate } from "../src/humanGate.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { KernelHost } from "../src/kernelHost.ts";
import { TaskService, type TaskSummary } from "../src/taskService.ts";

const kernel = resolve(process.env.MAE_FLOW_HOME ?? "kernel");
const confirm = "交付增量无需调整，确认推送";
for (const answer of [confirm, "先调整"]) {
  test(`真实 Cloud 回答 ${answer} 经 Hook 回传，旧指纹不再制造第二张卡`, async t => {
    const cwd = mkdtempSync(join(tmpdir(), "mfc-kernel-review-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main"); git("config", "user.name", "test"); git("config", "user.email", "test@example.test");
    writeFileSync(join(cwd, "a.txt"), "initial\n"); git("add", "."); git("commit", "-qm", "initial");
    writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
      current: "delivery_review", revision: 1,
      config: { "分支名": "main", "基线分支": "main", "单号": "REQ5" }, choices: {}, history: [],
      delivery_manifest: { files: ["a.txt"] }, implementation_base_head: git("rev-parse", "HEAD"),
      approval_subject: { step: "delivery_review", id: "a".repeat(16), sha256: "a".repeat(64) },
      approval_request: { step: "delivery_review", subject_id: "a".repeat(16) },
    }));
    writeFileSync(join(cwd, "a.txt"), "final version before first question\n");
    const command = `python3 '${join(kernel, "scripts/mae-flow.py")}' done`;
    const model = new ScriptedModelServer([
      { tool: { name: "AskUserQuestion", input: { questions: [{ question: "交付是否确认？", options: [confirm, "先调整"], recommended: confirm }] } } },
      { tool: { name: "bash", input: { command } } }, { text: "已处理真实决定" },
    ]);
    await model.start(); t.after(() => model.stop());
    const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    const gate = new HumanGate(join(cwd, "waiting.json"));
    const host = new KernelHost({ kernelRoot: kernel, workspace: cwd,
      transcriptPath: join(cwd, "transcript.jsonl"), taskId: "T5" });
    const session = await CloudSession.create({ taskId: "T5", workspace: cwd, agentDir,
      provider: "maeflow", model: "scripted-v1", humanGate: gate,
      gate: new GateService(), currentStep: () => "delivery_review",
      hostHooks: { preTool: event => host.preTool(event), postTool: event => host.postTool(event) },
      eventLog: new EventLog(join(cwd, "events.jsonl")),
      transcript: new TranscriptStore(join(cwd, "transcript.jsonl"), "main"),
    });
    t.after(() => session.dispose());
    const outcome = await session.start("确认交付，然后按真实决定推进");
    assert.equal(outcome.status, "waiting_for_human", readFileSync(join(cwd, "events.jsonl"), "utf8"));
    const waiting = outcome.waiting!;
    const resolved = gate.resolve(waiting.waiting_id, { stateVersion: waiting.state_version,
      decision: answer, answers: { "交付是否确认？": answer }, notes: "小鲁班手机审批" });
    assert.equal((await session.resumeWithDecision(resolved)).status, "turn_finished");
    assert.equal(gate.all().length, 1, "只出现 Agent 最初的问题");
    const after = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf8"));
    assert.equal(after.current, answer === confirm ? "push" : "delivery_review");
    if (answer === confirm) assert.equal(after.approval_request, undefined);
  });
}

for (const scene of ["legacy", "ordinary", "paused", "interrupted-migration"] as const) {
  test(`恢复在途确认：${scene}`, t => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-retire-review-"));
    t.after(() => rmSync(dataDir, { recursive: true, force: true }));
    const workspace = join(dataDir, "task-1");
    const gate = new HumanGate(join(workspace, "waiting.json"));
    const waiting = gate.createWaiting({ taskId: "task-1", step: "delivery_review",
      callId: scene === "ordinary" ? "real-question" : "kernel-review-delivery_review-" + "a".repeat(16),
      questionInput: { questions: [{ question: "是否确认？", options: [confirm, "先调整"], recommended: confirm }] },
    });
    writeFileSync(join(workspace, "task.json"), JSON.stringify({ summary: {
      id: "task-1", workspace, requirement: "恢复任务", created_at: "2026-09-12T00:00:00.000Z",
      status: scene === "paused" ? "paused" : "waiting_for_human", waiting,
    } satisfies TaskSummary }));
    if (scene === "interrupted-migration") assert.equal(retireKernelReviewRequest(gate, waiting), true);
    const service = new TaskService({ dataDir, provider: "maeflow", model: "scripted-v1", modelsJson: {}, maxConcurrent: 0 });
    t.after(() => service.shutdown());
    const recovered = service.recover();
    assert.equal(recovered.restored, 1);
    const retire = scene === "legacy" || scene === "interrupted-migration";
    assert.equal(recovered.requeued, retire ? 1 : 0);
    assert.equal(gate.get(waiting.waiting_id)?.status, retire ? "superseded" : "waiting");
    assert.equal(gate.get(waiting.waiting_id)?.decision, "", "撤下重复卡不伪造确认");
    assert.equal(service.get("task-1")?.status, retire ? "queued" : scene === "paused" ? "paused" : "waiting_for_human");
  });
}
