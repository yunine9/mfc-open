/**
 * 编译类会话(prepush/warmup 形态)的 skill 消费链彻底排查(用户
 * 2026-08-28 点名:"skill 真的能被消费吗")。四段链逐段钉死:
 * 货架 → 任务内只读快照(落在 workspace 下,随挂载进容器;pi 的
 * Read 在宿主执行,两条路都可达) → pi 注入(名字+描述进模型眼前)
 * → 足迹记账(available 事件按会话角色落盘)。
 * 快照路径的门禁放行(Read .mae-flow-work/host-skills/**)已在
 * tests/prepushAgent.test.ts 单独钉死,这里不重复。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudSession } from "../src/sessionDriver.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import { KnowledgeTrace } from "../src/knowledgeTrace.ts";

async function compileSessionProbe(sessionId: string) {
  const model = new ScriptedModelServer([{ text: "编译演练收口。" }]);
  await model.start();
  const root = mkdtempSync(join(tmpdir(), `mfc-compile-skill-`));
  const workspace = join(root, "repo");
  mkdirSync(workspace, { recursive: true });
  const skillDir = join(root, "data", "skills", "mae-remote-build");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"),
    "---\nname: mae-remote-build\ndescription: MAE 编译速查 MARKER-BUILD-SKILL\n---\n\n增量入口:source svc_profile.sh 后直驱 target/build make。\n");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
    JSON.stringify(model.modelsJson()));
  const eventsFile = join(root, "knowledge-events.jsonl");
  const session = await CloudSession.create({
    taskId: "T-compile",
    workspace,
    agentDir,
    hostSkillsDir: join(root, "data", "skills"),
    knowledgeTrace: new KnowledgeTrace(
      eventsFile, "T-compile", workspace, () => "build"),
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(root, "events.jsonl")),
    transcript: new TranscriptStore(join(root, "transcript.jsonl"), "main"),
    gate: new GateService(),
    humanGate: new HumanGate(join(root, "waiting.json")),
    allowHumanQuestions: false,
    sessionId,
  });
  try {
    const outcome = await session.start("开始编译演练。");
    assert.equal(outcome.status, "turn_finished");
  } finally {
    session.dispose();
    await model.stop();
  }
  return { model, workspace, eventsFile };
}

for (const sessionId of ["prepush", "warmup"]) {
  test(`${sessionId} 会话真的消费 skill:快照可达+pi 注入+足迹记账`, async () => {
    const { model, workspace, eventsFile } =
      await compileSessionProbe(sessionId);

    // ① 快照落在 workspace 下 → 随同路径挂载进容器,Bash/Read 都够
    //    得着;权限归一后人人可读。快照目录名是内容哈希 key,按内容找。
    const snapshotRoot = join(workspace, ".mae-flow-work", "host-skills");
    assert.ok(existsSync(snapshotRoot), "货架 skill 必须快照进任务 workspace");
    const snapshot = readdirSync(snapshotRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(snapshotRoot, entry.name, "SKILL.md"))
      .find((path) => existsSync(path)
        && readFileSync(path, "utf-8").includes("MARKER-BUILD-SKILL"));
    assert.ok(snapshot, "快照里必须能按内容找到该 skill 的 SKILL.md");
    assert.ok((statSync(snapshot!).mode & 0o444) === 0o444,
      "快照必须全员可读(容器 uid 与宿主可能对不上)");

    // ② pi 感知:skill 名字与描述必须出现在发给模型的请求里。
    const seen = model.requests.map((request) =>
      JSON.stringify(request)).join("\n");
    assert.match(seen, /mae-remote-build/, "skill 名字没到模型眼前");
    assert.match(seen, /MARKER-BUILD-SKILL/, "skill 描述没到模型眼前");

    // ③ 记账:available 事件落盘,角色按会话归属(排查时对得上号)。
    const events = readFileSync(eventsFile, "utf-8").trim().split("\n")
      .map((line) => JSON.parse(line));
    const available = events.find((event) =>
      event.kind === "skill" && event.name === "mae-remote-build"
      && event.action === "available");
    assert.ok(available, "skill 进入能力目录必须留 available 足迹");
    assert.equal(available.session_role, sessionId,
      "足迹角色必须归到编译会话本身,不许冒充主 Agent");
  });
}
