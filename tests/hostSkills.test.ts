/**
 * 宿主级 skill 的契约:团队的两个 UT skill 在内网出不来仓,老宿主
 * 是"每次手动集成进 ut-generator 子 agent";云端给它一个固定的家
 * ——`<数据目录>/skills` 放一次,每个任务自动带(子 Agent 经同一
 * openSession 装配,一并带上)。
 *
 * 这里测的是真到场:skill 的名字与描述必须出现在送给模型的请求里
 * (pi 把 SKILL.md 注进系统提示,而不是提供一个 skill 工具)。
 * 读 SDK 才发现 DefaultResourceLoader 是 includeDefaults=false——
 * 不显式喂路径就一个都不装,所以这条断言必须盯着真实请求,不能只
 * 断言"我传了参数"。
 */

import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { CloudSession } from "../src/sessionDriver.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { TranscriptStore } from "../src/transcriptStore.ts";
import { GateService } from "../src/gateService.ts";
import { HumanGate } from "../src/humanGate.ts";
import {
  KnowledgeTrace,
  knowledgeUsageSnapshot,
} from "../src/knowledgeTrace.ts";
import { materializeHostSkills } from "../src/hostSkillRuntime.ts";
import { approveSkillSubmission, listSkillVersions, rollbackHostSkill, submitHostSkill, updateHostSkillKnowledgeMetadata } from "../src/hostSkillLibrary.ts";
import { mfcTemp } from "./mfcTmp.ts";

const SCRIPT: Scene[] = [{ text: "写完了。" }];

function writeSkill(dir: string, name: string, body: string): string {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  const path = join(skillDir, "SKILL.md");
  writeFileSync(path,
    `---\nname: ${name}\ndescription: ${body}\nknowledge_nature: engineering\ntechnologies: [java]\n---\n\n正文:按这个口径写单测。\n`);
  return path;
}

async function runOnce(dataDir: string): Promise<string> {
  const model = new ScriptedModelServer(SCRIPT);
  await model.start();
  try {
    const service = new TaskService({
      dataDir,
      provider: "maeflow",
      model: "scripted-v1",
      modelsJson: model.modelsJson(),
    });
    const id = service.create("写点单测", {
      repositoryProfiles: [{
        repository: "https://code.example/team/java.git",
        technologies: ["java"], confirmed: true,
        updated_at: new Date().toISOString(), updated_by: "tester",
      }],
    }).id;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = service.get(id)!.status;
      if (status === "completed" || status === "failed") break;
      await new Promise((tick) => setTimeout(tick, 100));
    }
    assert.equal(service.get(id)!.status, "completed",
      service.get(id)!.detail ?? "");
    return JSON.stringify(model.requests);
  } finally {
    await model.stop();
  }
}

async function runDirect(
  workspace: string,
  repositorySkillPaths?: string[],
  script: Scene[] = SCRIPT,
  linear = false,
  hostSkillsDir?: string,
  resourceOptions: Partial<import("../src/sessionDriver.ts").CloudSessionOptions> = {},
): Promise<Array<Record<string, unknown>>> {
  const model = new ScriptedModelServer(
    script, "scripted-v1", linear ? { linear: true } : {});
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"),
    JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-repository-skills",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(workspace, "events.jsonl")),
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    hostSkillsDir,
    repositorySkillPaths,
    ...resourceOptions,
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    return model.requests;
  } finally {
    session.dispose();
    await model.stop();
  }
}

test("宿主级 skill 放一次,每个任务都带到模型眼前", async () => {
  const dataDir = mfcTemp("mfc-skill-");
  writeSkill(join(dataDir, "skills"), "java-autout",
    "内网单测写法指南 JAVA-AUTOUT-MARKER");
  const seen = await runOnce(dataDir);
  assert.match(seen, /java-autout/, "skill 名字没到模型眼前");
  assert.match(seen, /JAVA-AUTOUT-MARKER/, "skill 描述没到模型眼前");
});

test("团队 Skill 在建任务时固定，货架更新与原位重跑都不改变既有任务版本",
  async () => {
    const dataDir = mfcTemp("mfc-skill-pin-");
    const source = writeSkill(join(dataDir, "skills"), "stable-skill",
      "PINNED-SKILL-V1");
    const service = new TaskService({
      dataDir, provider: "test", model: "test", modelsJson: {},
      maxConcurrent: 0,
    });
    const created = service.create("固定团队 Skill", {
      repositoryProfiles: [{
        repository: "https://code.example/team/java.git",
        technologies: ["java"], confirmed: true,
        updated_at: new Date().toISOString(), updated_by: "tester",
      }],
    });
    const snapshot = join(created.workspace, "host-skill-snapshot");
    const skillFile = (root: string): string => {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
          const found = skillFile(path);
          if (found) return found;
        } else if (entry.name === "SKILL.md") return path;
      }
      return "";
    };
    assert.match(readFileSync(skillFile(snapshot), "utf-8"), /PINNED-SKILL-V1/);

    writeFileSync(source,
      "---\nname: stable-skill\ndescription: PINNED-SKILL-V2\n"
      + "knowledge_nature: engineering\ntechnologies: [java]\n---\n\nV2\n");
    assert.match(readFileSync(skillFile(snapshot), "utf-8"), /PINNED-SKILL-V1/,
      "货架更新不能回写已经创建的任务快照");

    const internal = (service as any).tasks.get(created.id);
    internal.summary.status = "completed";
    internal.summary.completed_at = new Date().toISOString();
    (service as any).persist(internal);
    const rerun = await service.rerunFromStart(created.id);
    assert.equal(rerun.host_skills_pinned, true);
    assert.match(readFileSync(skillFile(snapshot), "utf-8"), /PINNED-SKILL-V1/,
      "原位从头重跑必须复制旧快照，不能重新读取货架最新版");
  });

test("没有 skill 目录照常跑——不是每个部署都有内网 skill", async () => {
  const dataDir = mfcTemp("mfc-skill-none-");
  const seen = await runOnce(dataDir);
  assert.ok(!seen.includes("JAVA-AUTOUT-MARKER"));
});

test("通用 Skill 完整包经上传审查、更新属性和回退，需求/问题 Agent 均能读取并执行 CLI", async () => {
  const dataDir = mfcTemp("mfc-general-cli-"), sourceRoot = join(dataDir, "skills");
  const metadata = { nature: "engineering" as const, business_module_ids: [], repositories: [], technologies: ["agnostic"] };
  const nativeFixture = join(dataDir, "native-echo");
  if (process.platform === "darwin") {
    const source = join(dataDir, "native.c");
    writeFileSync(source, "#include <stdio.h>\nint main(int argc, char **argv) { if (argc > 1) puts(argv[1]); return 0; }\n");
    execFileSync("cc", [source, "-o", nativeFixture]);
  }
  const files = [
    { path: "SKILL.md", content_base64: Buffer.from("---\nname: general-triage\ndescription: GENERAL-TRIAGE-DESCRIPTION\n---\nGENERAL-TRIAGE-BODY\n运行 bin/check 和 bin/native-echo。\n").toString("base64") },
    { path: "bin/check", content_base64: Buffer.from("#!/bin/sh\nprintf 'GENERAL-CLI-EXECUTED\\n'\n").toString("base64") },
    { path: "bin/native-echo", content_base64: readFileSync(process.platform === "darwin" ? nativeFixture : "/bin/echo").toString("base64") },
    { path: "templates/Example.class", content_base64: Buffer.from("cafebabe00000041", "hex").toString("base64") },
  ];
  const submission = await submitHostSkill(dataDir, "general-triage", files, "author", metadata);
  assert.deepEqual(submission.technologies, ["agnostic"]);
  await approveSkillSubmission(dataDir, "general-triage", submission.id, "reviewer");
  await updateHostSkillKnowledgeMetadata(dataDir, "general-triage", metadata, "reviewer");
  await rollbackHostSkill(dataDir, "general-triage", listSkillVersions(dataDir, "general-triage")[0].version_id, "reviewer");
  assert.equal(statSync(join(sourceRoot, "general-triage/bin/check")).mode & 0o777, 0o755);
  assert.equal(statSync(join(sourceRoot, "general-triage/bin/native-echo")).mode & 0o777, 0o755);
  assert.equal(statSync(join(sourceRoot, "general-triage/templates/Example.class")).mode & 0o777, 0o644);

  const service = new TaskService({ dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("使用通用问题处理方法");

  for (const knowledgeScope of ["task", "issue"] as const) {
    const workspace = knowledgeScope === "task" ? task.workspace : join(dataDir, knowledgeScope);
    mkdirSync(workspace, { recursive: true });
    const selectedRoot = knowledgeScope === "task" ? join(workspace, "host-skill-snapshot") : sourceRoot;
    const options = { sourceRoot: selectedRoot, workspaceRoot: workspace,
      snapshotRoot: join(workspace, ".mae-flow-work/host-skills"), knowledgeScope,
      context: { repositories: [], technologies: knowledgeScope === "task" ? ["cpp"] : [], businessModuleIds: [] } };
    const projected = materializeHostSkills(options);
    assert.deepEqual(projected.warnings, []);
    assert.deepEqual(projected.names, ["general-triage"]);
    const file = projected.paths[0], root = dirname(file), script = join(root, "bin/check"), native = join(root, "bin/native-echo");
    // 复用旧快照时只恢复执行位，不重新选版本或替换正文。
    chmodSync(script, 0o444); chmodSync(native, 0o444);
    assert.deepEqual(materializeHostSkills(options).paths, projected.paths);
    assert.equal(statSync(file).mode & 0o777, 0o444);
    assert.equal(statSync(script).mode & 0o777, 0o555);
    assert.equal(statSync(native).mode & 0o777, 0o555);
    const requests = await runDirect(workspace, undefined, [
      { tool: { name: "read", input: { path: file } } },
      { tool: { name: "bash", input: { command: `'${script}' && '${native}' GENERAL-NATIVE-EXECUTED` } } },
      { text: "完成。" },
    ], true, selectedRoot, { knowledgeScope, knowledgeContext: options.context });
    const seen = JSON.stringify(requests);
    assert.match(seen, /GENERAL-TRIAGE-DESCRIPTION/);
    assert.match(seen, /GENERAL-TRIAGE-BODY/);
    const toolResults = requests.flatMap(request => (request.messages as any[]) ?? []).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === "tool_result");
    assert.ok(toolResults.length >= 2);
    assert.ok(toolResults.every(block => !block.is_error), JSON.stringify(toolResults));
    assert.match(JSON.stringify(toolResults), /GENERAL-CLI-EXECUTED/);
    assert.match(JSON.stringify(toolResults), /GENERAL-NATIVE-EXECUTED/);
    assert.ok(!seen.includes(join(sourceRoot, "general-triage/SKILL.md")));
  }
});

test("任务资源清单可取消团队 Skill，空数组不会退回全量装载", () => {
  const root = mfcTemp("mfc-host-skill-selection-");
  const workspace = join(root, "repo");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  writeSkill(sourceRoot, "wanted", "WANTED-MARKER");
  writeSkill(sourceRoot, "not-wanted", "NOT-WANTED-MARKER");

  const selected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "selected"),
    selectedSourcePaths: ["wanted/SKILL.md"],
  });
  assert.deepEqual(selected.names, ["wanted"]);

  const empty = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "empty"),
    selectedSourcePaths: [],
  });
  assert.deepEqual(empty.paths, []);
});

test("新跨仓子任务从父快照复制时仍按本仓技术画像筛选 Skill", () => {
  const root = mfcTemp("mfc-host-skill-child-scope-");
  const sourceRoot = join(root, "skills");
  const parentWorkspace = join(root, "parent");
  const childWorkspace = join(root, "child");
  mkdirSync(parentWorkspace, { recursive: true });
  mkdirSync(childWorkspace, { recursive: true });
  writeSkill(sourceRoot, "java-autout", "JAVA-UT");
  const cppSkill = writeSkill(sourceRoot, "cpp-autout", "CPP-UT");
  writeFileSync(cppSkill, readFileSync(cppSkill, "utf-8")
    .replace("technologies: [java]", "technologies: [cpp]"));

  const parentRoot = join(parentWorkspace, "host-skill-snapshot");
  const parent = materializeHostSkills({
    sourceRoot,
    workspaceRoot: parentWorkspace,
    snapshotRoot: parentRoot,
    context: {
      repositories: [],
      technologies: ["java", "cpp"],
      businessModuleIds: [],
    },
  });
  assert.deepEqual(parent.names.sort(), ["cpp-autout", "java-autout"]);

  const child = materializeHostSkills({
    sourceRoot: parentRoot,
    workspaceRoot: childWorkspace,
    snapshotRoot: join(childWorkspace, "host-skill-snapshot"),
    context: {
      repositories: [],
      technologies: ["cpp"],
      businessModuleIds: [],
    },
  });
  assert.deepEqual(child.names, ["cpp-autout"]);
});

test("宿主 Skill 正文和附件从任务内只读快照读取,不暴露部署源路径", async () => {
  const root = mfcTemp("mfc-host-skill-projection-");
  const workspace = join(root, "repo");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  const sourceSkill = writeSkill(
    sourceRoot, "java-autout", "HOST-SKILL-DESCRIPTION-MARKER");
  writeFileSync(sourceSkill,
    "---\nname: java-autout\ndescription: HOST-SKILL-DESCRIPTION-MARKER\n"
    + "---\n\nHOST-SKILL-BODY-MARKER\n读取 references/guide.md。\n");
  const reference = join(dirname(sourceSkill), "references", "guide.md");
  mkdirSync(dirname(reference), { recursive: true });
  writeFileSync(reference, "HOST-SKILL-ATTACHMENT-MARKER\n");

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.warnings, []);
  assert.equal(projected.paths.length, 1);
  const projectedSkill = projected.paths[0];
  const projectedReference = join(
    dirname(projectedSkill), "references", "guide.md");
  assert.ok(projectedSkill.startsWith(
    join(realpathSync(workspace), ".mae-flow-work")));

  const requests = await runDirect(workspace, undefined, [
    { text: "读取宿主 Skill 正文。", tool: {
      name: "read", input: { path: projectedSkill },
    } },
    { text: "读取 Skill 引用的附件。", tool: {
      name: "read", input: { path: projectedReference },
    } },
    { text: "完成。" },
  ], false, sourceRoot);
  const seen = JSON.stringify(requests);
  assert.match(seen, /HOST-SKILL-BODY-MARKER/);
  assert.match(seen, /HOST-SKILL-ATTACHMENT-MARKER/);
  assert.ok(!seen.includes(sourceSkill), "模型请求不应出现部署源 SKILL.md 路径");
});

test("宿主 Skill 包含软链接时不投影,避免附件越出部署 Skill 根", () => {
  const root = mfcTemp("mfc-host-skill-symlink-");
  const sourceRoot = join(root, "deployment-skills");
  const sourceSkill = writeSkill(
    sourceRoot, "unsafe-skill", "UNSAFE-SKILL-MARKER");
  const outside = join(root, "outside-secret.md");
  mkdirSync(join(root, "repo"), { recursive: true });
  writeFileSync(outside, "SECRET\n");
  symlinkSync(outside, join(dirname(sourceSkill), "reference.md"));

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: join(root, "repo"),
    snapshotRoot: join(root, "repo", ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.paths, []);
  assert.match(projected.warnings.join("\n"), /软链接/);
});

test("宿主 Skill 只读快照损坏后会安全重建", () => {
  const root = mfcTemp("mfc-host-skill-rebuild-");
  const workspace = join(root, "repo");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  writeSkill(sourceRoot, "repair-skill", "REPAIR-SKILL-MARKER");
  const options = {
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  };
  const first = materializeHostSkills(options);
  assert.equal(first.paths.length, 1);
  chmodSync(dirname(first.paths[0]), 0o755);
  chmodSync(first.paths[0], 0o644);
  writeFileSync(first.paths[0], "tampered\n");

  const repaired = materializeHostSkills(options);
  assert.deepEqual(repaired.warnings, []);
  assert.equal(repaired.paths.length, 1);
  assert.match(readFileSync(repaired.paths[0], "utf-8"), /REPAIR-SKILL-MARKER/);
});

test("宿主 Skill 快照祖先是软链接时 fail-closed,不向任务外写入", () => {
  const root = mfcTemp("mfc-host-skill-target-link-");
  const workspace = join(root, "repo");
  const outside = join(root, "outside");
  const sourceRoot = join(root, "deployment-skills");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeSkill(sourceRoot, "safe-skill", "SAFE-SKILL-MARKER");
  symlinkSync(outside, join(workspace, ".mae-flow-work"), "dir");

  const projected = materializeHostSkills({
    sourceRoot,
    workspaceRoot: workspace,
    snapshotRoot: join(workspace, ".mae-flow-work", "host-skills"),
  });
  assert.deepEqual(projected.paths, []);
  assert.match(projected.warnings.join("\n"), /快照路径包含软链接/);
});

test("仓内 Skill 未选择时完全不可见,不再自动扫描 .pi/.claude/.cac", async () => {
  const workspace = mfcTemp("mfc-repo-skill-none-");
  writeSkill(join(workspace, ".pi", "skills"), "repo-a",
    "REPO-A-MARKER");
  writeSkill(join(workspace, ".claude", "skills"), "repo-b",
    "REPO-B-MARKER");
  writeSkill(join(workspace, ".cac", "skills"), "repo-c",
    "REPO-C-MARKER");

  const seen = JSON.stringify(await runDirect(workspace));
  assert.ok(!seen.includes("REPO-A-MARKER"));
  assert.ok(!seen.includes("REPO-B-MARKER"));
  assert.ok(!seen.includes("REPO-C-MARKER"));
});

test("精确选择仓 A 的 Skill,不会顺带装载同目录仓 B Skill", async () => {
  const workspace = mfcTemp("mfc-repo-skill-one-");
  const skillRoot = join(workspace, ".pi", "skills");
  const skillA = writeSkill(skillRoot, "repo-a", "REPO-A-MARKER");
  writeSkill(skillRoot, "repo-b", "REPO-B-MARKER");

  const seen = JSON.stringify(await runDirect(workspace, [skillA]));
  assert.match(seen, /REPO-A-MARKER/);
  assert.ok(!seen.includes("REPO-B-MARKER"));
});

test("知识只以索引进入首轮；正文被 Agent 按需读取后才进入上下文", async () => {
  const workspace = mfcTemp("mfc-repo-knowledge-");
  const businessPath = join(workspace, "team-build.md");
  writeFileSync(businessPath,
    "# 业务模块知识\n\nBUSINESS-KNOWLEDGE-BODY-MARKER\n");
  const model = new ScriptedModelServer([
    { text: "索引显示业务模块知识相关，按需读取。", tool: {
      name: "read", input: { path: businessPath },
    } },
    { text: "已读取所需正文，完成。" },
  ]);
  await model.start();
  const agentDir = join(workspace, "pi-agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.modelsJson()));
  const session = await CloudSession.create({
    taskId: "T-repository-knowledge",
    workspace,
    agentDir,
    provider: "maeflow",
    model: "scripted-v1",
    eventLog: new EventLog(join(workspace, "events.jsonl")),
    transcript: new TranscriptStore(join(workspace, "transcript.jsonl"), "main"),
    gate: new GateService({ workspace, cwd: workspace }),
    humanGate: new HumanGate(join(workspace, "waiting.json")),
    businessModuleKnowledge: { warnings: [], skill_paths: [], entries: [{
      id: "business-1",
      title: "业务模块知识",
      summary: "仅在构建超时时参考",
      when_to_use: "构建长时间无结果时",
      form: "document",
      module_id: "orders", module_name: "订单", module_owner: "owner", repositories: [],
      digest: "digest-2", version: 1,
      relative_path: "team-build.md", path: businessPath,
    }] },
    knowledgeTrace: new KnowledgeTrace(
      join(workspace, "knowledge-events.jsonl"),
      "T-repository-knowledge", workspace,
    ),
  });
  try {
    const outcome = await session.start("开始");
    assert.equal(outcome.status, "turn_finished", outcome.detail ?? "");
    const firstRequest = JSON.stringify(model.requests[0]);
    assert.match(firstRequest, /本任务知识索引/);
    assert.match(firstRequest, /仅在构建超时时参考/);
    assert.doesNotMatch(firstRequest, /BUSINESS-KNOWLEDGE-BODY-MARKER/,
      "默认勾选不能把业务模块知识正文偷渡进首轮上下文");
    assert.match(JSON.stringify(model.requests),
      /BUSINESS-KNOWLEDGE-BODY-MARKER/,
      "Agent 主动 Read 后，对应正文才应进入后续请求");
    const usage = knowledgeUsageSnapshot({ workspace })!;
    assert.ok(usage.events.some((event) => event.id === "business-1"
      && event.action === "available"));
    assert.ok(usage.events.some((event) => event.id === "business-1"
      && event.action === "read"));
    assert.ok(!usage.events.some((event) => event.id === "business-1"
      && event.action === "loaded"), "索引可见不能冒充正文已加载");
  } finally {
    session.dispose();
    await model.stop();
  }
});

test("子 Agent 与主 Agent 使用同一仓库 Skill allowlist", async () => {
  const workspace = mfcTemp("mfc-repo-skill-child-");
  const skillRoot = join(workspace, ".pi", "skills");
  const skillA = writeSkill(skillRoot, "repo-a", "REPO-A-MARKER");
  writeSkill(skillRoot, "repo-b", "REPO-B-MARKER");
  const requests = await runDirect(workspace, [skillA], [
    {
      text: "交给子 Agent。",
      tool: {
        name: "Task",
        input: {
          subagent_type: "reviewer-agent",
          description: "检查实现",
          prompt: "CHILD-SKILL-CHECK",
        },
      },
    },
    { text: "子 Agent 已返回,完成。" },
  ], true);

  assert.ok(requests.length >= 2, "应至少包含主 Agent 与子 Agent 请求");
  const childRequest = JSON.stringify(requests[1]);
  assert.match(childRequest, /CHILD-SKILL-CHECK/);
  assert.match(childRequest, /REPO-A-MARKER/);
  assert.ok(!childRequest.includes("REPO-B-MARKER"));
});


test("平台屏蔽实际模型上下文中的仓库 Skill 与 AGENTS，保留未屏蔽资源", async () => {
  const workspace = mfcTemp("mfc-resource-block-");
  const blocked = writeSkill(join(workspace, ".cac", "skills"), "department", "BLOCKED_SKILL_SENTINEL");
  const allowed = writeSkill(join(workspace, ".agents", "skills"), "business", "ALLOWED_SKILL_SENTINEL");
  writeFileSync(join(workspace, "AGENTS.md"), "BLOCKED_AGENT_SENTINEL");
  const options = { repositoryResourceBlocks: () => [".cac", "AGENTS.md"],
    repoContextFiles: [{ path: join(workspace, "repo", "service", "AGENTS.md"), content: "BLOCKED_MULTI_REPO_SENTINEL" }] };
  const requests = await runDirect(workspace, [blocked, allowed], SCRIPT, false, undefined, options);
  const seen = JSON.stringify(requests);
  assert.doesNotMatch(seen, /BLOCKED_SKILL_SENTINEL|BLOCKED_AGENT_SENTINEL|BLOCKED_MULTI_REPO_SENTINEL/);
  assert.match(seen, /ALLOWED_SKILL_SENTINEL/);
  assert.match(seen, /平台已屏蔽/);
  assert.ok(readFileSync(join(workspace, "AGENTS.md"), "utf8").includes("BLOCKED_AGENT_SENTINEL"));
});
