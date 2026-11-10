import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { execFileSync } from "node:child_process";
import { storeTaskAttachment, taskAttachmentContext, materializeTaskAttachments } from "../src/taskAttachments.ts";
import { GateService } from "../src/gateService.ts";
const request = (bytes: Buffer | string) => Readable.from([Buffer.from(bytes)]) as IncomingMessage;

test("日志和压缩包在重建现场可读、可搜索和解压，文件工具仍不能越出工作区", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-task-attachments-"));
  try {
    const runtime = join(root, "runtime"); mkdirSync(runtime);
    const stored = await storeTaskAttachment(root, runtime, request("ERROR order timeout\n"), "现场日志.log");
    const archive = execFileSync("python3", ["-c", "import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('service.log','ERROR order timeout'); z.close(); sys.stdout.buffer.write(b.getvalue())"]);
    const zipped = await storeTaskAttachment(root, runtime, request(archive), "现场.zip");
    rmSync(runtime, { recursive: true }); mkdirSync(runtime);
    materializeTaskAttachments(root, runtime);
    assert.equal(readFileSync(join(runtime, stored.path), "utf8"), "ERROR order timeout\n");
    const gate = new GateService({ workspace: runtime, cwd: runtime, failClosed: true });
    const allowed = (name: string, input: object) => gate.decide({ eventId: 1, taskId: "t", sessionId: "s", ts: new Date().toISOString(), kind: "tool_requested", payload: { name, input } }).action;
    assert.equal(allowed("Read", { path: zipped.path }), "allow");
    const cmd = `python3 -c "import zipfile; z=zipfile.ZipFile('${zipped.path}'); z.extractall('.mae-flow-work/attachment-analysis')"`;
    assert.equal(allowed("Bash", { command: cmd }), "allow");
    execFileSync("python3", ["-c", `import zipfile; z=zipfile.ZipFile('${zipped.path}'); z.extractall('.mae-flow-work/attachment-analysis')`], { cwd: runtime });
    assert.match(execFileSync("grep", ["ERROR", ".mae-flow-work/attachment-analysis/service.log"], { cwd: runtime }).toString(), /order timeout/);
    assert.equal(allowed("Read", { path: ".mae-flow-work/attachment-analysis/service.log" }), "allow");
    assert.equal(allowed("Read", { path: "../../outside" }), "deny");
    const context = taskAttachmentContext(root, runtime, "t", "分析这个问题", [stored.path, zipped.path]);
    assert.match(context, /现场日志.log/); assert.match(context, /Agent 工作区路径/);
    assert.doesNotMatch(context, /ERROR order timeout/);
    assert.throws(() => taskAttachmentContext(root, runtime, "t", "", ["../../etc/passwd"]), /无效/);
    const other = join(root, "other"); mkdirSync(other);
    assert.throws(() => taskAttachmentContext(other, undefined, "other", "", [stored.path]), /不存在/);
    const dir = join(runtime, ".mae-flow-work", "attachments"); rmSync(dir, { recursive: true }); symlinkSync(other, dir);
    assert.throws(() => materializeTaskAttachments(root, runtime), /目录不可用/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("真实 Agent 会话从后台提示取得附件路径，读取日志并解压后读取压缩包日志", { timeout: 60000 }, async () => {
  const { CloudSession } = await import("../src/sessionDriver.ts");
  const { ScriptedModelServer } = await import("../src/scriptedModel.ts");
  const { EventLog } = await import("../src/semanticEvents.ts");
  const { TranscriptStore } = await import("../src/transcriptStore.ts");
  const { HumanGate } = await import("../src/humanGate.ts");
  const { writeFileSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "mfc-attachment-agent-"));
  let session: Awaited<ReturnType<typeof CloudSession.create>> | undefined;
  const model = new ScriptedModelServer([], "scripted-v1", { linear: true });
  try {
    const runtime = join(root, "runtime"); mkdirSync(runtime);
    const log = await storeTaskAttachment(root, runtime, request("ERROR request-id=abc timeout\n"), "后台.log");
    const archive = execFileSync("python3", ["-c", "import io,zipfile,sys; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('service.log','ERROR archived-request=xyz'); z.close(); sys.stdout.buffer.write(b.getvalue())"]);
    const zip = await storeTaskAttachment(root, runtime, request(archive), "后台.zip");
    model.script.push(
      { tool: { name: "read", input: { path: log.path } } },
      { tool: { name: "bash", input: { command: `python3 -c "import zipfile; z=zipfile.ZipFile('${zip.path}'); print(z.namelist()); z.extractall('.mae-flow-work/attachment-analysis')"` } } },
      { tool: { name: "read", input: { path: ".mae-flow-work/attachment-analysis/service.log" } } },
      { text: "日志显示请求超时，压缩包中的日志已读取。" },
    );
    await model.start();
    const agentDir = join(root, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    session = await CloudSession.create({ taskId: "attachment-task", workspace: runtime, agentDir,
      provider: "maeflow", model: "scripted-v1",
      eventLog: new EventLog(join(root, "events.jsonl")), transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace: runtime, cwd: runtime, failClosed: true }), humanGate: new HumanGate(join(root, "waiting.json")) });
    const outcome = await session.start(taskAttachmentContext(root, runtime, "attachment-task", "参考这个日志", [log.path, zip.path]));
    assert.equal(outcome.status, "turn_finished");
    assert.match(JSON.stringify(model.requests[0]), /参考这个日志/);
    assert.ok(JSON.stringify(model.requests[0]).includes(log.path));
    assert.ok(JSON.stringify(model.requests[0]).includes(zip.path));
    assert.match(JSON.stringify(model.requests[1]), /request-id=abc/);
    assert.match(JSON.stringify(model.requests[3]), /archived-request=xyz/);
  } finally { session?.dispose(); await model.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("HTTP 上传后，普通对话由服务端注入附件路径，下载保持原文件", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const { createTaskServer } = await import("../src/server.ts");
  const root = mkdtempSync(join(tmpdir(), "mfc-attachment-api-"));
  const service = new TaskService({ dataDir: root, maxConcurrent: 0, provider: "test", model: "test", modelsJson: {} });
  const summary = service.create("验证附件");
  const received: string[] = [];
  service.interrupt = async (_id, text) => { received.push(text); return summary; };
  const server = createTaskServer(service);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/tasks/${summary.id}`;
    const response = await fetch(`${base}/attachments?name=${encodeURIComponent("现场.log")}`, { method: "POST", body: "ERROR timeout" });
    assert.equal(response.status, 201);
    const meta = await response.json() as { path: string };
    for (const endpoint of ["interrupt"]) {
      const sent = await fetch(`${base}/${endpoint}`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "参考这个日志", comment: "参考这个日志", attachments: [meta.path] }) });
      assert.equal(sent.status, 200, await sent.text());
      assert.ok(received.at(-1)?.includes(meta.path));
      assert.match(received.at(-1)!, /先读取附件/);
      assert.doesNotMatch(received.at(-1)!, /ERROR timeout/);
    }
    const download = await fetch(`${base}/attachments?path=${encodeURIComponent(meta.path)}`);
    assert.equal(download.status, 200); assert.equal(await download.text(), "ERROR timeout");
    const invalid = await fetch(`${base}/interrupt`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "参考", attachments: ["../../etc/passwd"] }) });
    assert.equal(invalid.status, 409); assert.equal(received.length, 1);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
