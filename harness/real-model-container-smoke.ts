/**
 * 真实模型 + 真实任务容器的低成本冒烟。
 *
 * 不跑完整业务审批链，也不访问真实代码远端；模型面对一个故意失败的
 * Node 单测，自行诊断、修改并在统一构建容器里复验。模型配置只复制到
 * 工作区之外的 0600 临时目录，结束后立即删除，不打印 URL/API Key。
 */
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { TaskContainer } from "../src/containerRuntime.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { prePushGateContract } from "../src/prepushAgent.ts";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] ?? "") : fallback;
}

function jsonRows(path: string): Array<Record<string, any>> {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function logFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".log")) found.push(path);
    }
  };
  try {
    visit(root);
  } catch {
    return [];
  }
  return found;
}

const project = resolve(import.meta.dirname, "..");
const modelsPath = resolve(flag("--models", join(project, ".local/models.json")));
const providerName = flag("--provider", "glm");
const modelName = flag("--model", "glm-5.2");
const sourceModelName = flag("--source-model", "glm-5.1");
const image = flag("--image", "mae-flow-task-builder:local-test");
const startedAt = Date.now();

const modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
const provider = modelsJson.providers?.[providerName];
if (!provider) throw new Error(`模型配置里找不到 provider ${providerName}`);
const sourceModel = provider.models?.find((item: any) => item.id === modelName)
  ?? provider.models?.find((item: any) => item.id === sourceModelName);
if (!sourceModel) {
  throw new Error(`模型配置里找不到 ${modelName} 或模板 ${sourceModelName}`);
}
// 网关字段、能力声明沿用同系列已配置模型，只覆盖实际请求 model id。
provider.models = [{ ...sourceModel, id: modelName, name: modelName }];

const scratchBase = join(homedir(), ".cache", "mae-flow-cloud-tests");
mkdirSync(scratchBase, { recursive: true });
const taskRoot = mkdtempSync(join(scratchBase, "glm52-real-"));
chmodSync(taskRoot, 0o700);
const workspace = join(taskRoot, "repo");
const agentDir = join(taskRoot, "private-agent");
const cacheRoot = join(taskRoot, "cache");
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });
const caches = ["maven", "npm", "ccache", "xdg"] as const;
for (const cache of caches) mkdirSync(join(cacheRoot, cache), { recursive: true });
writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson), {
  encoding: "utf-8",
  mode: 0o600,
});
writeFileSync(join(workspace, "package.json"), JSON.stringify({
  private: true,
  type: "module",
  scripts: { test: "node --test" },
}, null, 2) + "\n");
writeFileSync(join(workspace, "math.js"),
  "export function add(a, b) {\n  return a - b;\n}\n");
writeFileSync(join(workspace, "math.test.js"), [
  'import test from "node:test";',
  'import assert from "node:assert/strict";',
  'import { add } from "./math.js";',
  'test("add", () => assert.equal(add(2, 3), 5));',
  "",
].join("\n"));

const safeName = `mfc-real-glm52-${process.pid}`.toLowerCase();
const lifecycle: string[] = [];
const container = new TaskContainer(
  image,
  workspace,
  safeName,
  (message) => lifecycle.push(message),
  caches.map((cache) => `${join(cacheRoot, cache)}:/cache/${cache}`),
  {},
  {
    labels: {
      "com.mae-flow-cloud.instance": "real-model-smoke",
      "com.mae-flow-cloud.role": "prepush",
      "com.mae-flow-cloud.task": basename(taskRoot),
    },
  },
);
let session: CloudSession | undefined;
let report: Record<string, unknown> = {};
try {
  await container.start();
  const eventPath = join(taskRoot, "events.jsonl");
  session = await CloudSession.create({
    taskId: "real-glm52-container-smoke",
    workspace,
    agentDir,
    provider: providerName,
    model: modelName,
    eventLog: new EventLog(eventPath),
    transcript: new TranscriptStore(join(taskRoot, "transcript.jsonl"), "main"),
    gate: new GateService({
      workspace,
      cwd: workspace,
      contract: prePushGateContract(),
      failClosed: true,
    }),
    humanGate: new HumanGate(join(taskRoot, "waiting.json")),
    allowHumanQuestions: false,
    bashOperations: container,
  });
  const outcome = await session.start([
    "这是推送前的真实编译/UT 冒烟。当前 Node 项目有一个失败单测。",
    "请自行读取代码，先运行 node --test 定位问题，只做必要修复，再运行",
    "node --test 复验；同时用 uname -s 确认命令环境。不要提问，不要 push。",
    "全部通过后回复 PREPUSH_SMOKE_PASS，并简述修改与验证结果。",
  ].join("\n"));

  const verification: Buffer[] = [];
  const verified = await container.exec("node --test", workspace, {
    onData: (chunk) => verification.push(chunk),
    timeout: 60,
  });
  const events = jsonRows(eventPath);
  const requested = events.filter((event) => event.kind === "tool_requested");
  const names = requested.map((event) => String(event.payload?.name ?? ""));
  const normalizedNames = names.map((name) => name.toLowerCase());
  const finalReply = session.finalReply();
  const fixed = /return\s+a\s*\+\s*b/.test(readFileSync(join(workspace, "math.js"), "utf-8"));
  const logs = logFiles(join(workspace, ".mae-flow-work", "bash-logs"));
  report = {
    ok: outcome.status === "turn_finished"
      && verified.exitCode === 0
      && fixed
      && normalizedNames.includes("bash")
      && (normalizedNames.includes("edit") || normalizedNames.includes("write")),
    provider: providerName,
    model: modelName,
    outcome: outcome.status,
    finalReplyMarker: finalReply.includes("PREPUSH_SMOKE_PASS"),
    toolCalls: names,
    hostVerificationExitCode: verified.exitCode,
    fixed,
    verificationMentionsPass: /pass\s+1|# pass 1/i.test(Buffer.concat(verification).toString("utf-8")),
    bashLogCount: logs.length,
    bashLogs: logs.map((path) => path.slice(workspace.length + 1)),
    container: {
      stateDuringVerification: container.state,
      image: container.metadata?.immutableImageReference,
      user: container.metadata?.user,
    },
    elapsedMs: Date.now() - startedAt,
    evidenceDir: taskRoot,
    lifecycle,
  };
} finally {
  session?.dispose();
  try {
    await container.stop();
  } finally {
    // 真实凭据不留在演练现场；其余 transcript/events/命令日志保留供定位。
    rmSync(agentDir, { recursive: true, force: true });
  }
}
report.containerStateAfterStop = container.state;
report.elapsedMs = Date.now() - startedAt;
console.log(JSON.stringify(report, null, 2));
if (!report.ok || container.state !== "stopped") process.exitCode = 1;
