import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { consumptionFixture, enableComponentHints } from "./componentConsumptionFixture.ts";
import { ComponentKnowledgeConsumption } from "../src/componentKnowledgeConsumption.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { TaskService } from "../src/taskService.ts";
import { saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";

test("真实 Pi 主/子会话只用 knowledge 查询组件，写文件和 Bash 改码收到同源检查反馈", async () => {
  const f = consumptionFixture(), doc = f.publish(), reports: any[] = [];
  enableComponentHints(f);
  const consumer = new ComponentKnowledgeConsumption({ dataDir: f.data, cwd: f.cwd, context: () => f.context, languages: () => ["cpp"], baseline: () => "main", onReport: r => reports.push(r) });
  const p = consumer.catalog().paradigms[0];
  const model = new ScriptedModelServer([
    { tool: { name: "Task", input: { subagent_type: "component-plan-agent", description: "核对组件", prompt: "只分析后台任务的选型，先读正式知识。" } } },
    { tool: { name: "knowledge", input: { action: "search", query: "后台" } } },
    { tool: { name: "knowledge", input: { action: "read", id: doc.id, revision: doc.revision, start_line: p.start_line, end_line: p.end_line } } },
    { text: "已核对 Pool.submit 和等待约束，按正式知识实施。" },
    { tool: { name: "write", input: { path: "new.cpp", content: "void f() { std::thread created; }\n" } } },
    { tool: { name: "bash", input: { command: "printf 'void f() { std::thread shell_created; }\\n' > shell.cpp" } } },
    { text: "收到组件使用提示，核对适用条件。" },
    { tool: { name: "knowledge", input: { action: "search", query: "后台" } } },
    { text: "正式文档已停用，不再沿用。" },
  ], "scripted-v1", { linear: true });
  let session: CloudSession | undefined;
  try {
    await model.start(); const agentDir = join(f.dir, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    session = await CloudSession.create({ taskId: "consumer", workspace: f.cwd, agentDir, provider: "maeflow", model: "scripted-v1",
      eventLog: new EventLog(join(f.dir, "events.jsonl")), transcript: new TranscriptStore(join(f.dir, "transcript.jsonl"), "main"),
      gate: new GateService({ cwd: f.cwd, workspace: f.cwd }), humanGate: new HumanGate(join(f.dir, "waiting.json")), componentKnowledge: consumer,
      extraTools: [createKnowledgeTool({ service: () => new KnowledgeSearch(f.data), context: () => f.context })] });
    assert.equal((await session.start("开发后台任务")).status, "turn_finished");
    assert.doesNotMatch(JSON.stringify(model.requests[0]), /本任务可查阅的已采纳组件范式|"name":"component_knowledge"/);
    assert.doesNotMatch(JSON.stringify(model.requests[1]), /本任务可查阅的已采纳组件范式|"name":"component_knowledge"/);
    assert.match(JSON.stringify(model.requests[3]), /退出前等待任务完成/);
    assert.match(JSON.stringify(model.requests[5]), /new.cpp:1/);
    assert.match(JSON.stringify(model.requests[6]), /shell.cpp:1/);
    assert.ok(reports.some(r => r.findings.some((finding: any) => finding.path === "shell.cpp")));
    saveKnowledgeDocument(f.data, { active: false }, "expert", doc.id);
    await session.continueWith("重新核对已停用的知识");
    const lastRequest = model.requests.at(-1) as any;
    const system = lastRequest.system ?? (lastRequest.messages ?? []).filter((m: any) => m.role === "system");
    assert.doesNotMatch(JSON.stringify(system), /本任务可查阅的已采纳组件范式/);
    const result = lastRequest.messages.at(-1).content[0].content;
    assert.match(String(result), /未找到足够相关的知识/);
  } finally { session?.dispose(); await model.stop(); f.cleanup(); }
});

for (const mode of ["shadow", "warning", "unavailable"]) test(`宿主实际推送：${mode} 不阻断推送，报告对应真实 SHA`, async () => {
  const f = consumptionFixture(); f.publish();
  if (mode !== "shadow") enableComponentHints(f);
  const previousBinary = process.env.MFC_AST_GREP_BIN;
  if (mode === "unavailable") process.env.MFC_AST_GREP_BIN = join(f.dir, "missing-scanner");
  const remote = join(f.dir, "remote.git"); execFileSync("git", ["init", "--bare", "-q", remote]);
  writeFileSync(join(f.cwd, "new.cpp"), "void f() { std::thread work; }\n"); f.git("add", "."); f.git("commit", "-qm", "feature");
  const head = f.git("rev-parse", "HEAD"), service: any = new TaskService({ dataDir: f.data, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const summary = service.create("验证组件消费"); service.removeFromQueue(summary.id);
    const task = service.tasks.get(summary.id); task.cwd = f.cwd; task.summary.repo_url = remote; task.summary.repositories = [remote]; task.summary.baseline = "main";
    const receipt = await service.pushFromHost(task, "feature", head);
    assert.equal(receipt.sha, head);
    const report = service.get(summary.id).delivery.component_knowledge;
    assert.equal(report.trigger, "mr"); assert.equal(report.head, head); assert.equal(report.status, mode === "unavailable" ? "incomplete" : "completed", report.warnings.join("\n"));
    if (mode !== "unavailable") assert.ok(report.findings.some((r: any) => r.path === "new.cpp"));
    assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "feature"], { encoding: "utf8" }).trim(), head);
  } finally { await service.shutdown(); if (previousBinary === undefined) delete process.env.MFC_AST_GREP_BIN; else process.env.MFC_AST_GREP_BIN = previousBinary; f.cleanup(); }
});
