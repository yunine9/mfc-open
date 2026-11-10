/** 真 Pi + 真 Bash 的独立进程夹具；测试模型由父进程提供。 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloudSession } from "../../src/sessionDriver.ts";
import { EventLog } from "../../src/semanticEvents.ts";
import { TranscriptStore } from "../../src/transcriptStore.ts";
import { GateService } from "../../src/gateService.ts";
import { HumanGate } from "../../src/humanGate.ts";

const [root, mode] = process.argv.slice(2);
const session = await CloudSession.create({
  taskId: "continuity", workspace: root, agentDir: join(root, "pi-agent"),
  provider: "maeflow", model: "scripted-v1", resumeSession: mode === "resume",
  eventLog: new EventLog(join(root, "events.jsonl")),
  transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
  gate: new GateService({ workspace: root, cwd: root }),
  humanGate: new HumanGate(join(root, "waiting.json")),
});
let state = "idle";
const server = createServer(async (request, response) => {
  if (request.url === "/status") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ state, pid: process.pid })); return;
  }
  if (request.url === "/start" && request.method === "POST") {
    if (state !== "idle") { response.writeHead(409).end(); return; }
    state = "running";
    response.writeHead(202).end();
    const outcome = await (mode === "resume"
      ? session.startResume("最新决定：使用 queryENE.sh 的等效数方案，取代旧简化方案。继续尚未完成的工作。")
      : session.start("先读取 evidence.txt 得到结论，再执行一次工作命令；不要重复已完成工作。"));
    state = outcome.status;
    writeFileSync(join(root, "outcome.json"), JSON.stringify(outcome));
    return;
  }
  response.writeHead(404).end();
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: (server.address() as any).port }) + "\n"));
process.once("SIGTERM", () => { void session.abort().finally(() => {
  session.dispose(); server.closeAllConnections(); server.close(() => process.exit(0));
}); });
