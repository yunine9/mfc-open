import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyGitCommitIdentity, gitCommitIdentityConfigs, GIT_COMMIT_IDENTITY_GUIDANCE } from "../src/gitCommitIdentity.ts";
import { runSafeWorktreeGitAsync } from "../src/safeGit.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";

test("真实提交使用登记邮箱，刷新旧工作区身份不改历史，宿主代提交也同一署名", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-identity-"));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init");
    git("config", "user.email", "invented@localhost");
    git("config", "author.email", "stale-author@localhost");
    git("config", "committer.email", "stale-committer@localhost");
    await applyGitCommitIdentity(dir, { username: "alice", email: "alice@corp.example" });
    git("commit", "--allow-empty", "-m", "first");
    const before = git("rev-parse", "HEAD");
    assert.equal(git("log", "-1", "--format=%an|%ae|%cn|%ce"), "alice|alice@corp.example|alice|alice@corp.example");
    await applyGitCommitIdentity(dir, { username: "bob", email: "bob@corp.example" });
    assert.equal(git("rev-parse", "HEAD"), before);
    git("commit", "--allow-empty", "-m", "resumed");
    assert.equal(git("log", "-1", "--format=%ae|%ce"), "bob@corp.example|bob@corp.example");
    const host = await runSafeWorktreeGitAsync(dir, ["commit", "--allow-empty", "-m", "host adjustment"], {
      configs: [["user.name", "mae-flow-cloud"], ["user.email", "cloud@mae-flow.local"], ...gitCommitIdentityConfigs({ username: "alice", email: "alice@corp.example" })],
    });
    assert.equal(host.status, 0, String(host.stderr));
    assert.equal(git("log", "-1", "--format=%ae|%ce"), "alice@corp.example|alice@corp.example");
    assert.equal(git("show", "-s", "--format=%ae", before), "alice@corp.example");
    const config = readFileSync(join(dir, ".git/config"), "utf8");
    await applyGitCommitIdentity(dir, { username: "missing" });
    assert.equal(readFileSync(join(dir, ".git/config"), "utf8"), config, "没登记邮箱不拼造身份");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("真实主/子会话都收到同一提交身份约束，不依赖主 Agent 转述", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-identity-session-"));
  const model = new ScriptedModelServer([
    { tool: { name: "Task", input: { subagent_type: "code-agent", description: "辅助修改", prompt: "检查代码" } } },
    { text: "子任务完成" }, { text: "完成" },
  ], "scripted-v1", { linear: true });
  let session: CloudSession | undefined;
  try {
    await model.start();
    const agentDir = join(workspace, "pi-agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
    session = await CloudSession.create({ taskId: "identity", workspace, agentDir,
      provider: "maeflow", model: "scripted-v1", eventLog: new EventLog(join(workspace, "events.jsonl")),
      transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
      gate: new GateService({ workspace, cwd: workspace }), humanGate: new HumanGate(join(workspace, "waiting.json")),
    });
    await session.start("开始");
    assert.equal(model.requests.length, 3);
    for (const request of model.requests) assert.ok(JSON.stringify(request.system).includes(GIT_COMMIT_IDENTITY_GUIDANCE));
  } finally { session?.dispose(); await model.stop(); rmSync(workspace, { recursive: true, force: true }); }
});
