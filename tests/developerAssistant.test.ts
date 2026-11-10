import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEVELOPER_ASSISTANT_SESSION,
  appendDeveloperAssistantMessage,
  developerAssistantGateContract,
  developerAssistantMission,
  developerAssistantTools,
  interruptDeveloperAssistant,
  readDeveloperAssistant,
} from "../src/developerAssistant.ts";
import type { SemanticEvent } from "../src/semanticEvents.ts";

function event(
  eventId: number,
  sessionId: string,
  kind: SemanticEvent["kind"],
  payload: Record<string, unknown>,
): SemanticEvent {
  return {
    eventId,
    taskId: "task-1",
    sessionId,
    kind,
    ts: `2026-08-23T00:00:0${eventId}.000Z`,
    payload,
  };
}

test("开发助手超过 60 条消息后，最初的人话在再次读取和追加后仍保存", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-assistant-history-"));
  for (let index = 0; index < 65; index++) {
    appendDeveloperAssistantMessage(workspace, index % 2 ? "assistant" : "user", `历史原话 ${index}`, "ready");
  }
  assert.equal(readDeveloperAssistant(workspace).messages.length, 65);
  const next = appendDeveloperAssistantMessage(workspace, "user", "重新打开后继续", "ready");
  assert.equal(next.messages.length, 66);
  assert.equal(next.messages[0].text, "历史原话 0");
  const stored = JSON.parse(readFileSync(join(workspace, "developer-assistant.json"), "utf8"));
  assert.equal(stored.messages[0].text, "历史原话 0");
  assert.equal(stored.messages.at(-1).text, "重新打开后继续");
});

test("开发助手门禁绕开流程命令限制，但保留内核/Git/凭据边界", () => {
  const gate = developerAssistantGateContract();
  const decide = (tool: string, value: string) => gate(
    tool,
    value,
    event(1, DEVELOPER_ASSISTANT_SESSION, "tool_requested", {
      call_id: "call-1", name: tool, input: value,
    }),
  );

  assert.notEqual(decide("Bash", "mvn -q test")?.action, "deny");
  assert.notEqual(decide("Bash", "npm run build && rg TODO src")?.action, "deny");
  assert.notEqual(decide("Write", "src/example.ts")?.action, "deny");

  assert.equal(decide("Bash", "mae-flow current")?.action, "deny");
  assert.equal(decide("Bash", "git add src/example.ts")?.action, "deny");
  assert.equal(decide("Bash", "git --no-pager add src/example.ts")?.action,
    "deny");
  assert.equal(decide("Bash", "git -C . restore src/example.ts")?.action,
    "deny");
  assert.notEqual(decide("Bash", "git diff -- src/add.ts")?.action, "deny");
  assert.equal(decide("Bash", "git restore src/example.ts")?.action, "deny");
  assert.equal(decide("Bash", "git commit -am test")?.action, "deny");
  assert.equal(decide("Bash", "git 2>/tmp/git.log commit -am test")?.action, "deny");
  assert.equal(decide("Bash", "git -C . 2>&1 restore src/example.ts")?.action, "deny");
  assert.notEqual(decide("Bash", "git 2>/tmp/git.log diff -- src/add.ts")?.action, "deny");
  assert.equal(decide("Bash", "git push origin HEAD")?.action, "deny");
  assert.equal(decide("Write", ".git/HEAD")?.action, "deny");
  assert.equal(decide("Edit", ".git/refs/heads/main")?.action, "deny");
  assert.equal(decide("Write", ".claude/skills/central/SKILL.md")?.action,
    "deny");
  assert.equal(decide("Edit", ".cac/skills/central/SKILL.md")?.action,
    "deny");
  assert.notEqual(decide("Read", ".claude/skills/central/SKILL.md")?.action,
    "deny", "平台目录允许按需只读");
  assert.equal(decide("Bash", "printf x > .git/HEAD")?.action, "deny");
  assert.equal(decide("Read", ".mae-flow.json")?.action, "deny");
  assert.equal(decide("Read", "../pi-agent/models.json")?.action, "deny");
});

test("开发助手工具结果只投影自己的 SSE 会话，并配对输入与输出", () => {
  const events: SemanticEvent[] = [
    event(1, "main", "tool_requested", {
      call_id: "main-1", name: "Bash", input: { command: "ignored" },
    }),
    event(2, DEVELOPER_ASSISTANT_SESSION, "tool_requested", {
      call_id: "assistant-1", name: "Bash", input: { command: "mvn test" },
    }),
    event(3, DEVELOPER_ASSISTANT_SESSION, "tool_finished", {
      call_id: "assistant-1", name: "Bash", input: { command: "mvn test" },
      is_error: false, result: "BUILD SUCCESS",
    }),
    event(4, DEVELOPER_ASSISTANT_SESSION, "tool_finished", {
      call_id: "assistant-2", name: "Read", input: { path: "missing" },
      is_error: true, result: "not found",
    }),
  ];

  const tools = developerAssistantTools(events);
  assert.equal(tools.length, 2);
  assert.deepEqual(tools.map((tool) => tool.state), ["passed", "failed"]);
  assert.match(tools[0].input, /mvn test/);
  assert.match(tools[0].result ?? "", /BUILD SUCCESS/);
  assert.equal(tools.some((tool) => tool.call_id === "main-1"), false);
});

test("开发助手对话可恢复，运行中断会留下用户可见状态", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-"));
  appendDeveloperAssistantMessage(workspace, "user", "跑一下相关 UT", "running");
  assert.equal(readDeveloperAssistant(workspace).state, "running");

  const interrupted = interruptDeveloperAssistant(workspace, "服务重启");
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.error, "服务重启");
  assert.equal(interrupted.messages[0].text, "跑一下相关 UT");

  const mission = developerAssistantMission("修复空指针", interrupted.messages);
  assert.match(mission, /不是 Mae-Flow 主流程 Agent/);
  assert.match(mission, /真实执行/);
  assert.match(mission, /跑一下相关 UT/);
  assert.match(mission, /\.claude.*\.cac.*只读/s);
});

test("开发助手快照拒绝跟随软链，原子写只替换链接本身", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-developer-assistant-link-"));
  const workspace = join(root, "workspace");
  const secret = join(root, "secret.json");
  // mkdir 不用额外引入：先复用 mkdtemp 生成可信任务目录。
  const taskWorkspace = mkdtempSync(`${workspace}-`);
  writeFileSync(secret, '{"token":"must-stay-secret"}\n');
  symlinkSync(secret, join(taskWorkspace, "developer-assistant.json"));

  const unreadable = readDeveloperAssistant(taskWorkspace);
  assert.equal(unreadable.state, "failed");
  assert.doesNotMatch(JSON.stringify(unreadable), /must-stay-secret/);

  appendDeveloperAssistantMessage(taskWorkspace, "user", "检查一下", "running");
  assert.equal(readFileSync(secret, "utf-8"),
    '{"token":"must-stay-secret"}\n', "宿主目标文件不得被覆盖");
  assert.equal(readDeveloperAssistant(taskWorkspace).messages[0].text, "检查一下");
});
