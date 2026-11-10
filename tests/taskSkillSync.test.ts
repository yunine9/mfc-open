import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { TaskService } from "../src/taskService.ts";
import { listHostSkillShelfRoot } from "../src/hostSkillShelf.ts";
import { mfcTemp } from "./mfcTmp.ts";

function skill(data: string, name: string, body = "original", tech = "java") {
  const dir = join(data, "skills", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\nknowledge_nature: engineering\ntechnologies: [${tech}]\n---\n${body}\n`);
  writeFileSync(join(dir, "scripts", "check.sh"), "echo ready\n");
}
function setup() {
  const data = mfcTemp("mfc-skill-sync-");
  skill(data, "old-skill");
  const service = new TaskService({ dataDir: data, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("任务", { account: "owner", repositoryProfiles: [{ repository: "https://code.example/java.git", technologies: ["java"], confirmed: true, updated_at: new Date().toISOString(), updated_by: "owner" }] });
  const state = (service as any).tasks.get(task.id);
  // 本套只测技能同步，不启动内核或克隆业务仓；补齐真实任务的范围投影。
  state.summary.repositories = ["https://code.example/java.git"];
  state.summary.repository_profiles = [{ repository: "https://code.example/java.git", technologies: ["java"] }];
  return { data, service, task, state };
}

test("排队任务补充新技能全包，保留旧版本，按技术匹配且重复点击不重复通知", async () => {
  const { data, service, task, state } = setup();
  skill(data, "old-skill", "replacement"); skill(data, "activity-center"); skill(data, "cpp-only", "cpp", "cpp");
  const result = await service.syncTaskSkills(task.id, "owner");
  assert.deepEqual(result.added, ["activity-center"]);
  const root = join(task.workspace, "host-skill-snapshot");
  const shelf = listHostSkillShelfRoot(root).skills;
  assert.deepEqual(shelf.map(s => s.name).sort(), ["activity-center", "old-skill"]);
  assert.match(readFileSync(join(root, shelf.find(s => s.name === "old-skill")!.path), "utf8"), /original/);
  assert.equal(state.pendingMainSteers.length, 1);
  const runtime = listHostSkillShelfRoot(join(task.workspace, ".mae-flow-work", "host-skills")).skills;
  const entry = runtime.find(s => s.name === "activity-center")!;
  assert.ok(entry);
  assert.ok(existsSync(join(task.workspace, ".mae-flow-work", "host-skills", dirname(entry.path), "scripts", "check.sh")));
  const persisted = JSON.parse(readFileSync(join(task.workspace, "task.json"), "utf8"));
  assert.match(JSON.stringify(persisted.pending_main_steers), /activity-center/);
  assert.deepEqual((await service.syncTaskSkills(task.id, "owner")).added, []);
  assert.equal(state.pendingMainSteers.length, 1);
});

test("运行中真实发送，发送失败后重试保留通知；等待决定时延后发送", async () => {
  const { data, service, task, state } = setup();
  skill(data, "activity-center");
  state.summary.status = "running";
  state.driver = { noteUserMessage() {}, async steer() { throw new Error("temporary"); } };
  await assert.rejects(service.syncTaskSkills(task.id, "owner"), /temporary/);
  assert.equal(state.pendingMainSteers.length, 1);
  const messages: string[] = [];
  state.driver.steer = async (text: string) => { messages.push(text); };
  await service.syncTaskSkills(task.id, "owner");
  assert.equal(messages.length, 1); assert.match(messages[0], /activity-center.*SKILL.md/);
  assert.equal(state.pendingMainSteers.length, 0);
  state.summary.status = "waiting_for_human";
  skill(data, "new-guide");
  await service.syncTaskSkills(task.id, "owner");
  assert.equal(messages.length, 1);
  assert.match(state.pendingDecisionKnowledge[0], /new-guide/);
});

test("运行目录装载失败可重试，不会因已拍快照永久丢失通知", async () => {
  const { data, service, task, state } = setup();
  skill(data, "activity-center");
  const target = join(task.workspace, ".mae-flow-work");
  writeFileSync(target, "blocked");
  await assert.rejects(service.syncTaskSkills(task.id, "owner"), /装载失败/);
  assert.ok(existsSync(join(task.workspace, "pending-skill-sync.json")));
  rmSync(target);
  const result = await service.syncTaskSkills(task.id, "owner");
  assert.deepEqual(result.added, ["activity-center"]);
  assert.equal(state.pendingMainSteers.length, 1);
  assert.equal(existsSync(join(task.workspace, "pending-skill-sync.json")), false);
});

test("补充技能只允许当前责任人，结束任务拒绝修改", async () => {
  const { service, task, state } = setup();
  await assert.rejects(service.syncTaskSkills(task.id, "reviewer"), /责任人/);
  state.summary.status = "completed";
  await assert.rejects(service.syncTaskSkills(task.id, "owner"), /已结束/);
});
