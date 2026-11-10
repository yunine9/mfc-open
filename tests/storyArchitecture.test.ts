import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { storyArchitecture } from "../src/storyArchitecture.ts";
import { ARCHIFY_ROOT, renderArchify } from "../src/archifyRender.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { storyPath } from "../src/overallStoryStore.ts";
import { materializeArchifyReferences } from "../src/archifyReferences.ts";

const source = { schema_version: 1, diagram_type: "architecture", meta: { title: "订单同步模块", locale: "zh-CN" },
  components: [{ id: "sync", type: "backend", label: "同步与校验", pos: [40, 40], size: [180, 64] }], connections: [] };
const block = (value: unknown) => `\n\`\`\`archify\n${JSON.stringify(value)}\n\`\`\`\n`;
const artifact = (story: string, diagrams: Array<Record<string, unknown>> = [{ id: "sync", view: "logical", story_line: 2, source }]) => JSON.stringify({
  schema_version: 1, story_sha256: createHash("sha256").update(story).digest("hex"), diagrams,
});

test("架构投影不读取 Story PlantUML，平台内部 Archify 产物按 Story 版本绑定", () => {
  const text = "# Story\n```plantuml\nclass Order\n```\n" + block(source);
  const a = storyArchitecture(text, artifact(text));
  assert.equal(a.diagrams.length, 1);
  assert.equal(a.diagrams[0].title, "订单同步模块");
  assert.equal(a.diagrams[0].view, "logical");
  assert.match(a.warnings[0], /旧版 Archify/);
  assert.notEqual(storyArchitecture(text + "\n更新职责", artifact(text)).revision, a.revision);
  assert.equal(storyArchitecture("````text\n" + block(source) + "````").diagrams.length, 0);
  assert.equal(storyArchitecture("~~~archify\n" + JSON.stringify(source) + "\n~~~").diagrams.length, 0);
});

test("缺失、未完成、不支持或坏图源提供诊断，其他正常图仍可展示", () => {
  assert.deepEqual(storyArchitecture("# 老 Story\n只有类图").diagrams, []);
  const story = "# Story";
  const projection = storyArchitecture(story, artifact(story));
  assert.equal(projection.warnings.length, 0);
  assert.equal(projection.diagrams.length, 1);
  assert.equal(projection.diagrams[0].id, "archify-sync");
  assert.match(storyArchitecture("```archify\n{}").warnings[0], /未闭合/);
  assert.match(storyArchitecture(story, artifact(story, [{ id: "large", view: "logical", source: { ...source, extra: "a".repeat(256 * 1024) } }])).warnings[0], /超过/);
});

test("真实 Archify 五种类型零安装渲染，中文与交互脚本保留，页面禁止联网", async () => {
  const files = ["web-app.architecture.json", "agent-tool-call.workflow.json", "cache-miss-request.sequence.json",
    "event-stream.dataflow.json", "agent-run.lifecycle.json"];
  for (const file of files) {
    const example = JSON.parse(readFileSync(join(ARCHIFY_ROOT, "examples", file), "utf8"));
    example.meta.locale = "zh-CN";
    example.meta.title = "订单模块验证";
    const result = await renderArchify(example);
    assert.equal(result.error, undefined, `${file}: ${result.error}`);
    assert.match(result.html!, /订单模块验证/);
    assert.match(result.html!, /<svg/);
    assert.match(result.html!, /connect-src 'none'/);
    assert.match(result.html!, /Archify\.view\.zoomIn/);
  }
});

test("图源不能让渲染器读取外部品牌、仓库或写出指定路径；坏关系不冒充成功", async () => {
  for (const field of ["brand", "sources", "repository"]) {
    const unsafe = { ...source, [field]: "https://example.invalid/private" };
    assert.equal(storyArchitecture("# Story", artifact("# Story", [{ id: field, view: "logical", source: unsafe }])).diagrams.length, 0);
    assert.match((await renderArchify(unsafe)).error!, /不读取外部/);
  }
  const result = await renderArchify({ ...source, connections: [{ from: "sync", to: "missing" }] });
  assert.ok(result.error); assert.equal(result.html, undefined);
  const harmless = await renderArchify({ ...source, meta: { ...source.meta, output: "/not-a-writable-path/probe.html" } });
  assert.equal(harmless.error, undefined);
  assert.match(harmless.html!, /订单同步模块/);
});

test("Agent 工作区的离线渲染器依赖齐全，可直接验证实际图源", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-archify-references-"));
  try {
    materializeArchifyReferences(root);
    const input = join(root, "input.json"), output = join(root, "preview.html");
    writeFileSync(input, JSON.stringify(source));
    execFileSync(process.execPath, [join(root, "renderers/architecture/render-architecture.mjs"), input, output],
      { cwd: root, timeout: 15000, stdio: "pipe" });
    assert.match(readFileSync(output, "utf8"), /订单同步模块/);
    assert.match(readFileSync(output, "utf8"), /<svg/);
    writeFileSync(input, JSON.stringify({ ...source, connections: [{ from: "sync", to: "missing" }] }));
    assert.throws(() => execFileSync(process.execPath,
      [join(root, "renderers/architecture/render-architecture.mjs"), input, output],
      { cwd: root, timeout: 15000, stdio: "pipe" }), /missing/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("架构 API 复用真实分析 Story、鉴权与版本检查，不接收任意文件图源", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-archify-api-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("owner", "owner-password", "developer");
  const service = new TaskService({ dataDir: join(root, "data"), provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const task = service.create("全局设计", { account: "owner", ticket: "REQ-ARCH", requirementAnalysis: true });
  const internal = (service as any).tasks.get(task.id);
  internal.cwd = join(task.workspace, "repo");
  internal.summary.requirement_graph = { stage: "analysis", repositories: [], dependencies: [] };
  const directory = join(internal.cwd, ".mae-flow-work", "REQ-ARCH");
  mkdirSync(directory, { recursive: true });
  const story = "# Story\n## 逻辑视图\n```plantuml\n@startuml\ntitle 订单类关系\ninterface Store\nclass OrderStore\nStore <|.. OrderStore\n@enduml\n```\n";
  const path = join(directory, "story.md"); writeFileSync(path, story);
  writeFileSync(join(directory, "architecture.json"), artifact(story));
  const child = service.create("模块设计", { account: "owner", ticket: "REQ-ARCH-U1", parentTaskId: task.id });
  const childInternal = (service as any).tasks.get(child.id);
  childInternal.cwd = join(child.workspace, "repo");
  childInternal.summary.requirement_graph = { stage: "confirmed", repositories: [], dependencies: [] };
  const childDirectory = join(childInternal.cwd, ".mae-flow-work", "REQ-ARCH-U1");
  mkdirSync(childDirectory, { recursive: true });
  const childStory = "# 模块 Story\n## 进程视图\n模块运行设计。\n";
  writeFileSync(join(childDirectory, "story.md"), childStory);
  writeFileSync(join(childDirectory, "architecture.json"), artifact(childStory, [{ id: "transaction", view: "process", story_line: 2, source: {
    ...source, meta: { ...source.meta, title: "模块事务时序" },
  } }]));
  const server = createTaskServer(service, { auth });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    const url = `${base}/tasks/${task.id}/architecture`;
    assert.equal((await fetch(url)).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "owner", password: "owner-password" }) });
    const headers = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const list = await fetch(url, { headers }).then((r) => r.json()) as { revision: string; diagrams: Array<{ source?: unknown }> };
    assert.equal(list.diagrams.length, 1);
    assert.equal(list.diagrams[0].source, undefined);
    const response = await fetch(`${url}/archify-sync?revision=${list.revision}`, { headers });
    assert.equal(response.status, 200);
    assert.match((await response.json() as { html: string }).html, /订单同步模块/);
    const childUrl = `${base}/tasks/${child.id}/architecture`;
    const childList = await fetch(childUrl, { headers }).then((r) => r.json()) as { revision: string; diagrams: Array<{ title: string }> };
    assert.equal(childList.diagrams[0].title, "模块事务时序");
    const childResponse = await fetch(`${childUrl}/archify-transaction?revision=${childList.revision}`, { headers });
    assert.equal(childResponse.status, 200);
    assert.match((await childResponse.json() as { html: string }).html, /模块事务时序/);
    const published = storyPath(child.workspace, "architecture.json");
    mkdirSync(join(published, ".."), { recursive: true });
    writeFileSync(published, artifact(childStory, [{ id: "updated", view: "process", source: {
      ...source, meta: { ...source.meta, title: "刷新后的模块图" },
    } }]));
    const refreshed = await fetch(childUrl, { headers }).then(r => r.json()) as { diagrams: Array<{ title: string }> };
    assert.equal(refreshed.diagrams[0].title, "刷新后的模块图", "子任务优先展示刷新发布的图，而非仓内旧图");
    writeFileSync(path, "# Story\n职责改变");
    assert.equal((await fetch(`${url}/archify-sync?revision=${list.revision}`, { headers })).status, 409);
    assert.equal((await fetch(`${url}/archify-sync`, { headers })).status, 409);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify(source) })).status, 404);
  } finally {
    await new Promise<void>((done) => server.close(() => done())); await service.shutdown(); rmSync(root, { recursive: true, force: true });
  }
});


test("架构页只采用独立 Archify 产物，Story 中的 PlantUML 与旧 Archify 都不混入", () => {
  const story = "## 逻辑视图\n~~~plantuml\n@startuml\ntitle 订单职责与接口\nclass Order\n@enduml\n~~~\n"
    + block(source) + "\n## 物理视图\n```plantuml\nnode Server\n```\n```plantuml\n";
  const result = storyArchitecture(story, artifact(story, [{ id: "sync", view: "logical", story_line: 9, source }]));
  assert.deepEqual(result.diagrams.map(({ title, renderer, line }) => ({ title, renderer, line })), [
    { title: "订单同步模块", renderer: "archify", line: 9 },
  ]);
  assert.match(result.warnings.join("\n"), /旧版 Archify/);
  assert.equal(storyArchitecture("```plantuml\n```\n").warnings.length, 0);
});


test("节点详情按真实节点投影，局部查看不是新增交付任务，旧图仍可读", () => {
  const story = "# Story";
  const result = storyArchitecture(story, artifact(story, [{id:"overview",view:"logical",source,nodes:[
    {id:"sync", responsibility:"同步订单", interfaces:"订单 → 回执"},
    {id:"invented",responsibility:"不存在的节点"},
  ]}, {id:"local",view:"logical",source,overview_id:"overview",focus_node:"sync"}]));
  assert.equal(result.diagrams[0].nodes?.length,1);
  assert.equal(result.diagrams[0].nodes?.[0].responsibility,"同步订单");
  assert.equal(result.diagrams[1].overview_id,"archify-overview");
  assert.equal(storyArchitecture(story,artifact(story)).diagrams[0].nodes?.[0].name,"同步与校验");
});
