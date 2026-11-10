import { componentPipelineScript, fixtureEvidence, fixtureCaller, fixtureUnitTest, guideOverview, recordFixtureEvidence, usageContent } from "./componentPipelineFixture.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { ComponentResearch, researchSourceRepositories, type ResearchExecution } from "../src/componentResearch.ts";
import { ComponentResearchPipeline } from "../src/componentResearchPipeline.ts";
import { componentCards } from "../src/componentKnowledgeCards.ts";
import { createTechnologyStack } from "../src/technologyStacks.ts";
import {
  componentRepositories,
  saveComponentRepository,
} from "../src/componentRepositories.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import {
  componentSourceTool,
  languageComponentSourceTool,
  codeSearchTool,
} from "../src/componentResearchTools.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { collectSearchableKnowledge } from "../src/knowledgeSearch.ts";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import { editResearchDocument, researchDocumentMarkdown } from "../src/componentResearchDocument.ts";
import { readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { componentPublishInput, publishComponentKnowledge } from "./fixtures/componentPublish.ts";
const sectionData = (id: string, repository_ids: string[], language = "cpp") => ({ id, title: `能力 ${id}`, repository_ids,
  content: usageContent("关闭不再使用的文件句柄。"), interfaces: "Close(Handle& handle)：关闭句柄并将 closed 设置为 true。",
  integration: "CMake target file，对应 libfile.so；Java 对应发布的 JAR/依赖坐标。",
  example: "```cpp\n" + fixtureCaller + "```", unit_tests: "运行：c++ -Iinclude tests/file_test.cpp -lfile && ./a.out\n```cpp\n" + fixtureUnitTest + "```", sources: "", related_ids: [],
  paradigm: { kind: "paradigm" as const, component: "file", language, status: "recommended" as const, need: `关闭句柄 ${id}`, api: ["Close"], applicability: "当前固定版本的文件句柄", replaces: { identifiers: [], imports: [], patterns: [] },
    evidence: repository_ids.map(repository => fixtureEvidence(repository).reference), usage_evidence: [fixtureEvidence(repository_ids[0]).usageId], test_evidence: [fixtureEvidence(repository_ids[0]).testId], open_questions: [] } });
function writeJoint(input: ResearchExecution, count = 2) {
  const ids = researchSourceRepositories(input.record).map(c => c.id);
  recordFixtureEvidence(input);
  input.editDocument!({ action: "overview", overview: guideOverview("文件与日期能力跨仓协作，初始化先于调用；按构建依赖组合。") });
  input.editDocument!({ action: "outline", entries: Array.from({length:count}, (_, i) => ({ id:`cap-${i}`, title:`能力 cap-${i}`, repository_ids:ids })) });
  for (let i = 0; i < count; i++) input.editDocument!({ action: "section", section: sectionData(`cap-${i}`, ids, input.record.language) });
  return "联合草稿已保存";
}
const temporary = () => {
  const dir = mkdtempSync(join(tmpdir(), "component-research-"));
  for (const name of ["C++", "Java"]) createTechnologyStack(dir, { name }, "fixture");
  return dir;
};
const config = {
  name: "文件组件",
  repository: "https://code.example/cbb.git",
  branch: "main",
  path: "src",
  languages: ["cpp", "java"],
};
async function until(check: () => boolean) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function finished(research: ComponentResearch, id: string) {
  await until(() => !["queued", "running"].includes(research.get(id).status));
  const record = research.get(id);
  assert.equal(record.status, "done", record.error);
  return record;
}
const call = (tool: any, input: object) =>
  tool.execute("test", input, undefined, undefined, {});
test("配置必填语言、拒绝凭据和越界路径，普通操作者可编辑并留痕", () => {
  const dir = temporary();
  try {
    assert.throws(
      () => saveComponentRepository(dir, { ...config, languages: [] }, "alice"),
      /语言|技术栈/,
    );
    assert.throws(
      () =>
        saveComponentRepository(
          dir,
          { ...config, repository: "https://u:token@host/r" },
          "alice",
        ),
      /凭据/,
    );
    assert.throws(
      () =>
        saveComponentRepository(
          dir,
          { ...config, path: "../outside" },
          "alice",
        ),
      /路径/,
    );
    const row = saveComponentRepository(dir, config, "alice");
    saveComponentRepository(dir, { id: row.id, enabled: false }, "bob");
    assert.equal(componentRepositories(dir)[0].enabled, false);
    assert.match(
      readFileSync(join(dir, "component-repository-audit.jsonl"), "utf8"),
      /bob/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("B5验收1/生产线验收10/14：同技术栈与来源范围复用研究；共享并发，草稿隔离且发布可追溯", async () => {
  const dir = temporary();
  const row = saveComponentRepository(dir, config, "alice");
  const other = saveComponentRepository(dir, { ...config, name: "日期组件", repository: "https://code.example/date.git", languages: ["cpp"] }, "alice");
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  let concurrent = 0,
    max = 0,
    adopts = 0;
  const research = new ComponentResearch(
    dir,
    async (input) => {
      concurrent++;
      max = Math.max(max, concurrent);
      input.evidence({ tool: "component_source", path: "src/file.cpp" });
      await hold;
      concurrent--;
      return writeJoint(input);
    },
    () => adopts++,
  );
  try {
    const input = { repository_ids: [row.id], language: "cpp" };
    const first = research.start(input, "alice");
    assert.equal(research.start(input, "bob").id, first.id, "同技术栈与来源范围不分操作者，只有一次研究");
    assert.deepEqual(researchSourceRepositories(first).map(c => c.id), [row.id]);
    assert.notEqual(first.topic, row.name, "来源仓名称不能成为组件知识的默认主题");
    assert.throws(
      () => research.start({ ...input, language: "python" }, "alice"),
      /语言|技术栈/,
    );
    assert.throws(() => research.start({ repository_ids: [other.id], language: "java" }, "alice"), /来源|语言|技术栈/);
    const java = research.start({ ...input, language: "java" }, "alice");
    assert.notEqual(java.id, first.id);
    const third = research.start({ language: "cpp" }, "alice");
    assert.deepEqual(new Set(researchSourceRepositories(third).map(c => c.id)), new Set([row.id, other.id]));
    assert.equal(research.start({ language: "cpp", repository_ids: [other.id, row.id] }, "alice").id, third.id, "默认来源和同集合不同顺序必须复用");
    assert.equal(third.status, "running");
    release();
    await until(() => research.list().every((r) => r.status === "done"));
    assert.equal(max, 3, "三个独立研究范围可同时执行");
    assert.equal(
      collectSearchableKnowledge(dir, {
        repo: "",
        repositories: [],
        moduleIds: [],
      }).assets.length,
      0,
    );
    const doc = publishComponentKnowledge(research, dir, first.id, { scope: "platform" }, "bob");
    assert.deepEqual(doc.technologies, ["cpp"]);
    assert.equal(doc.research_source?.job_id, first.id);
    const repeated = publishComponentKnowledge(research, dir, first.id, {}, "alice");
    assert.equal(repeated.id, doc.id);
    assert.equal(repeated.revision, doc.revision, "重复发布沿用同一正式版本");
    assert.equal(adopts, 1);
    assert.ok(
      collectSearchableKnowledge(dir, {
        repo: "",
        repositories: [],
        moduleIds: [],
      }).assets.some((a) => a.id === doc.id),
    );
    assert.equal(research.start(input, "alice").id, first.id, "已发布的同范围研究再次发起回到原研究，改动走更新知识");
    research.remove(first.id, "alice");
    const fresh = research.start(input, "alice");
    assert.notEqual(fresh.id, first.id);
    await finished(research, fresh.id);
    await research.shutdown();
    const reloaded = new ComponentResearch(dir, async () => "");
    assert.equal(reloaded.get(first.id).document_id, doc.id);
    await reloaded.shutdown();
  } finally {
    release();
    await research.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("重启接续原任务；任务 knowledge 可发起并读取记录，不依赖搜索索引在线", async () => {
  const dir = temporary();
  const row = saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => writeJoint(input));
  try {
    const tool = createKnowledgeTool({
      service: () => undefined,
      context: () => ({ repo: "", repositories: [], moduleIds: [] }),
      research: () => research,
      researchOperator: () => "alice",
    });
    const components = await call(tool, { action: "components" });
    assert.match(components.content[0].text, /文件组件/);
    const result = await call(tool, {
      action: "research",
      repository_ids: [row.id],
      language: "cpp",
      query: "文件读取",
    });
    const started = JSON.parse(result.content[0].text.split("\n")[0]);
    assert.equal(started.url, `/?kbPage=task&kbKind=component&kbTask=${started.id}`);
    await until(() => research.list()[0].status === "done");
    const job = research.list()[0];
    const status = await call(tool, { action: "research_status", id: job.id });
    assert.match(status.content[0].text, /草稿/);
    await research.shutdown();
    const path = join(dir, "component-research", job.id, "record.json");
    const stale = JSON.parse(readFileSync(path, "utf8"));
    stale.status = "running";
    writeFileSync(path, JSON.stringify(stale));
    const reloaded = new ComponentResearch(dir, async input => writeJoint(input));
    assert.equal(reloaded.get(job.id).status, "queued");
    await finished(reloaded, job.id);
    assert.equal(reloaded.get(job.id).error, undefined);
    await reloaded.shutdown();
  } finally {
    await research.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("真实 Git + Pi 会话 + ec 替身：读取固定版本、查真实调用接口、生成带证据草稿", async () => {
  const dir = temporary(),
    source = join(dir, "source");
  mkdirSync(join(source, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(source, "src/file.cpp"), "struct Handle { bool closed = false; }; void Close(Handle& handle) { handle.closed = true; }\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  writeFileSync(join(source, "src/file.cpp"), "WORKTREE MODIFIED\n");
  const fakeEc = join(dir, "ec"),
    oldEc = process.env.MAE_FLOW_EC_BIN;
  writeFileSync(
    fakeEc,
    `#!${process.execPath}\nconst action = process.argv[2];\nif (action === "tools") console.log('["search","read"]');\nelse if (action === "kw") console.log("consumer/src/use.cpp consumer/tests/file_test.cpp");\nelse if (action === "read") process.stdout.write(process.argv.some(value => value.includes("file_test")) ? ${JSON.stringify(fixtureUnitTest)} : ${JSON.stringify(fixtureCaller)});\nelse process.exit(2);\n`,
    { mode: 0o700 },
  );
  process.env.MAE_FLOW_EC_BIN = fakeEc;
  writeFileSync(join(dir, "AGENTS.md"), "FORBIDDEN_COMPONENT_CONTEXT_SENTINEL");
  const row = saveComponentRepository(dir, config, "alice");
  const model = new ScriptedModelServer(componentPipelineScript(row.id, "src/file.cpp", revision, fixtureCaller, fixtureUnitTest).script, "scripted-v1", { linear: true });
  await model.start();
  const research = new ComponentResearch(dir, (input) =>
    runComponentResearch(input, {
      dataDir: dir,
      model: () => ({
        provider: "maeflow",
        model: "scripted-v1",
        json: model.modelsJson(),
      }),
      source: async () => ({ root: source, revision }),
    }),
  );
  try {
    const denied = await call(
      componentSourceTool(source, revision, "src", () => {}),
      { action: "read", path: "other.cpp" },
    );
    assert.match(denied.content[0].text, /范围/);
    const pinned = await call(
      componentSourceTool(source, revision, "src", () => {}),
      { action: "read", path: "src/file.cpp" },
    );
    assert.match(pinned.content[0].text, /void Close/);
    assert.doesNotMatch(pinned.content[0].text, /WORKTREE/);
    const batch = research.start({ language: "cpp" }, "alice");
    const job = research.get(batch.id);
    await until(() => ["done", "failed"].includes(research.get(job.id).status));
    const done = research.get(job.id);
    assert.equal(done.status, "done", done.error);
    assert.match(JSON.stringify(model.requests[0]), /component-module-analysis/);
    assert.equal(done.analysis_skill?.name, "component-module-analysis");
    assert.equal(done.skill?.name, "component-knowledge-extraction");
    assert.ok(done.evidence.some(e => e.tool === "code_search" && e.purpose === "unit-test" && e.action === "read"));
    assert.doesNotMatch(JSON.stringify(model.requests), /FORBIDDEN_COMPONENT_CONTEXT_SENTINEL/);
    assert.match(JSON.stringify(model.requests.at(-1)), /受支持接口与接入配置/);
    assert.match(JSON.stringify(model.requests.at(-1)), /内部实现、测试 helper、fixture、mock/);
    assert.match(JSON.stringify(model.requests.at(-1)), /interface、idl、include、api/);
    assert.match(JSON.stringify(model.requests.at(-1)), /公开头文件安装布局、库产物和链接目标/);
    assert.match(JSON.stringify(model.requests.at(-1)), /sdk\/pom\.xml 时读取并追踪 modules/);
    assert.equal(done.document?.sections.length, 4);
    assert.equal(done.revision, revision);
    assert.ok(done.evidence.some(e => e.tool === "research_note"));
    assert.ok(done.evidence.some(e => e.tool === "code_search" && e.action === "read" && e.evidence_id));
    assert.doesNotMatch(done.draft!, /未提供时为未知|### 来源/);
    const toolNames = (model.requests[0].tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    assert.ok(toolNames.includes("component_source"));
    assert.ok(toolNames.includes("code_search"));
    assert.ok(toolNames.includes("research_document"));
    assert.ok(
      !toolNames.includes("Bash") &&
        !toolNames.includes("bash") &&
        !toolNames.includes("write") &&
        !toolNames.includes("Task"),
    );
    assert.equal(git("rev-parse", "HEAD"), revision);
    assert.equal(
      readFileSync(join(source, "src/file.cpp"), "utf8"),
      "WORKTREE MODIFIED\n",
    );
    process.env.MAE_FLOW_EC_BIN = join(dir, "missing-ec");
    research.remove(job.id, "alice");
    const failed = research.start({ repository_ids: [row.id], language: "cpp" },
      "alice",
    );
    await until(() => research.get(failed.id).status === "failed");
    assert.match(research.get(failed.id).error!, /ec/);
    const events: object[] = [];
    const failTool = await call(
      codeSearchTool((e) => events.push(e)),
      { action: "kw", query: "Close" },
    );
    assert.match(failTool.content[0].text, /ec 工具未安装或路径错误/);
    assert.equal((events[0] as any).status, "failed");
    // 本机实测：~/.local/bin/ec 存在但没有执行权限，旧提示只说"无权执行工具"，不知道是哪个文件。
    const blocked = join(dir, "blocked-ec");
    writeFileSync(blocked, "#!/bin/sh\n", { mode: 0o600 });
    process.env.MAE_FLOW_EC_BIN = blocked;
    const forbidden = await call(codeSearchTool(() => {}), { action: "kw", query: "Close" });
    assert.ok(forbidden.content[0].text.includes(`无权执行 ec（${blocked}）`), forbidden.content[0].text);
  } finally {
    await research.shutdown();
    await model.stop();
    if (oldEc === undefined) delete process.env.MAE_FLOW_EC_BIN;
    else process.env.MAE_FLOW_EC_BIN = oldEc;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("源码缓存增量同步、同仓准备串行，旧研究仍能读取固定版本", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const dir = temporary(),
    repo = join(dir, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "file.cpp"), "v1\n");
  git("add", ".");
  git("commit", "-qm", "v1");
  const service = new TaskService({
    dataDir: join(dir, "data"),
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
    gitCredential: account => account === "bob" ? {username:"bob",password:"fixture-personal"} : undefined,
    platformGitCredential: () => ({username:"oauth2",password:"fixture-system"}),
  });
  const identities: any[] = [];
  const originalSandbox = (service as any).prepareHostGitSandbox.bind(service);
  (service as any).prepareHostGitSandbox = (identity: any) => { identities.push(identity); return originalSandbox(identity); };
  try {
    const component = {
      ...config,
      id: "fixture",
      repository: repo,
      enabled: true,
      description: "",
      path: "",
    };
    const prepare = () =>
      (service as any).componentResearchSource(component, "alice");
    const [a, b] = await Promise.all([prepare(), prepare()]);
    assert.equal(a.root, b.root);
    assert.equal(a.revision, b.revision);
    writeFileSync(join(repo, "file.cpp"), "v2\n");
    git("add", ".");
    git("commit", "-qm", "v2");
    const c = await prepare();
    assert.equal(c.root, a.root);
    assert.notEqual(c.revision, a.revision);
    assert.equal(
      execFileSync("git", ["-C", a.root, "show", `${a.revision}:file.cpp`], {
        encoding: "utf8",
      }),
      "v1\n",
    );
    const bob = await (service as any).componentResearchSource(
      component,
      "bob",
    );
    assert.notEqual(bob.root, a.root);
    assert.equal(identities[0].username, "oauth2", "无个人凭据时只读同步使用系统账号");
    assert.equal(identities.at(-1).username, "bob", "个人凭据优先");
  } finally {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP 配置、萃取、查看及单路发布走同一记录，非法语言拒绝", async () => {
  const { TaskService } = await import("../src/taskService.ts");
  const { createTaskServer } = await import("../src/server.ts");
  const dir = temporary();
  const service = new TaskService({
    dataDir: dir,
    provider: "test",
    model: "test",
    modelsJson: {},
    maxConcurrent: 0,
  });
  const research = new ComponentResearch(
    dir,
    async input => input.review ? `已答复所选组件的问题，见 \`${researchSourceRepositories(input.record)[0].id}:src/file.cpp:1\`` : writeJoint(input),
  );
  (service as any).componentResearch = research;
  const server = createTaskServer(service);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body: object) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const governanceResponse = await fetch(url + "/component-knowledge");
    assert.equal(governanceResponse.status, 200);
    assert.deepEqual((await governanceResponse.json() as any).items, []);
    assert.equal((await post("/component-knowledge/sample", { task_id: "missing" })).status, 400);
    const configResponse = await post("/component-repositories", config);
    assert.equal(configResponse.status, 200);
    const component: any = await configResponse.json();
    assert.equal((await post("/component-research", { language: "cpp", material_ids: ["old-upload"] })).status, 400);
    assert.match((await (await post("/component-research", { language: "cpp", topic: "UT" })).json() as any).error, /不支持参数：topic/);
    assert.equal(
      (
        await post("/component-research", {
          repository_ids: [component.id],
          language: "python",
        })
      ).status,
      400,
    );
    const launched = await post("/component-research", {
      repository_ids: [component.id],
      language: "cpp",
    });
    assert.equal(launched.status, 202);
    const batch: any = await launched.json();
    assert.equal(batch.format, "joint-document");
    await finished(research, batch.id);
    const progress: any = await (await fetch(`${url}/component-research/${batch.id}`)).json();
    assert.equal(progress.document.sections.length, 2);
    const selected = await post(`/component-research/${batch.id}/selection`, { ids: ["cap-0"], selected: false });
    assert.equal(selected.status, 200);
    const download = await fetch(`${url}/component-research/${batch.id}/document`);
    assert.match(download.headers.get("content-type")!, /text\/markdown/);
    assert.doesNotMatch(await download.text(), /## 能力 cap-0/);
    const artifactsResponse = await fetch(`${url}/component-research/${batch.id}/artifacts`);
    assert.equal(artifactsResponse.status, 200);
    const artifacts: any = await artifactsResponse.json();
    assert.equal(artifacts.schema, "mfc.component-paradigm/v2");
    assert.equal(artifacts.enabled, false);
    assert.ok(artifacts.files["derived/catalog.json"]);
    assert.equal((await post(`/component-research/${batch.id}/review`, {section_id:"unknown",mode:"discuss",message:"问题"})).status, 400);
    assert.equal((await post(`/component-research/${batch.id}/review`, {section_id:"cap-0",mode:"discuss",message:"头文件对应哪个库？"})).status, 202);
    await finished(research, batch.id);
    assert.match(research.get(batch.id).review_turns![0].reply!, /所选组件/);
    assert.match(research.get(batch.id).review_turns![0].reply!, /`文件组件:src\/file\.cpp:1`/, "给人看的回复用组件名");
    assert.doesNotMatch(research.get(batch.id).review_turns![0].reply!, new RegExp(component.id), "不露出仓库编号");
    assert.equal(research.get(batch.id).document!.sections[0].selected, false);
    const detail: any = await (
      await fetch(`${url}/component-research/${batch.id}`)
    ).json();
    const published = await post(`/component-research/${batch.id}/publish`, componentPublishInput(detail, {
      title: "范式",
      scope: "platform",
    }));
    assert.equal(published.status, 200);
    const publishedRecord: any = await published.json();
    assert.equal(publishedRecord.id, batch.id);
    assert.ok(publishedRecord.document_id);
    const doc = readKnowledgeDocument(dir, publishedRecord.document_id);
    assert.deepEqual(doc.technologies, ["cpp"]);
    const docs: any = await (await fetch(`${url}/knowledge-documents`)).json();
    assert.equal(docs.documents[0].id, doc.id);
    assert.equal((await post("/component-research", {mode:"all",language:"cpp"})).status, 400);
  } finally {
    await service.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("按技术栈默认快照全部启用参考仓，拒绝旧仓即组件参数；来源配置变化重新研究", async () => {
  const dir = temporary();
  const first = saveComponentRepository(dir, config, "alice");
  const second = saveComponentRepository(dir, {...config, name:"日期来源", repository:"https://code.example/date.git", languages:["cpp"]}, "alice");
  const off = saveComponentRepository(dir, {...config, name:"停用来源", repository:"https://code.example/off.git", enabled:false}, "alice");
  const executions: ResearchExecution["record"][] = [];
  const research = new ComponentResearch(dir, async input => { executions.push(input.record); return writeJoint(input); });
  try {
    assert.throws(() => research.start({ language:"cpp", component_id:first.id } as never, "alice"), /不支持参数.*component_id/);
    assert.throws(() => research.start({ language:"cpp", repository_ids:[off.id] }, "alice"), /不存在|停用|来源/);
    const job = research.start({ language:"cpp" }, "alice");
    assert.deepEqual(new Set(researchSourceRepositories(job).map(c => c.id)), new Set([first.id, second.id]));
    assert.equal(job.component, undefined, "新记录不把第一来源仓指定为组件");
    assert.equal(job.components, undefined, "来源仓必须保存在规范来源字段中");
    await finished(research, job.id);
    assert.equal(researchSourceRepositories(executions[0]).length, 2);
    saveComponentRepository(dir, {id:first.id, path:"include"}, "alice");
    const next = research.start({ language:"cpp" }, "alice");
    assert.notEqual(next.id, job.id);
    assert.equal(researchSourceRepositories(next).find(c => c.id === first.id)?.path, "include");
    assert.equal(researchSourceRepositories(research.get(job.id)).find(c => c.id === first.id)?.path, "src", "历史范围不被当前配置覆盖");
    saveComponentRepository(dir, {...config, name:"新增来源", repository:"https://code.example/new.git", languages:["cpp"]}, "alice");
    const expanded = research.start({ language:"cpp" }, "alice");
    assert.notEqual(expanded.id, next.id, "参考来源集合变化不能复用旧范围研究");
    assert.equal(researchSourceRepositories(expanded).length, 3);
    assert.throws(() => research.start({ language:"python", repository_ids:[first.id] }, "alice"), /语言|技术栈/);
  } finally { await research.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test("技术栈一次研究读取两仓，盘点文件、数据库及跨仓 P2P 能力，发布卡片保留功能组件身份", async t => {
  const dir = temporary();
  const first = saveComponentRepository(dir, { ...config, name:"参考来源 A" }, "alice");
  const second = saveComponentRepository(dir, { ...config, name:"参考来源 B", repository:"https://code.example/transport.git" }, "alice");
  const capabilities = [
    { id:"file-operations", title:"文件操作", repository_ids:[first.id], scope:"src/files.cpp：读取、写入和关闭文件" },
    { id:"database-operations", title:"数据库操作", repository_ids:[first.id], scope:"src/database.cpp：查询与事务" },
    { id:"p2p", title:"P2P 通信", repository_ids:[first.id, second.id], scope:"src/peer.cpp + src/transport.cpp：发现节点并交换数据" },
  ];
  const phases: string[] = [];
  let executions = 0;
  const research = new ComponentResearch(dir, async input => {
    executions++;
    const sources = researchSourceRepositories(input.record);
    assert.deepEqual(new Set(sources.map(source => source.id)), new Set([first.id, second.id]));
    recordFixtureEvidence(input);
    const pipeline = new ComponentResearchPipeline(join(input.root, "capability-fixture.json"), "fixture-analysis", sources.map(source => source.id));
    await pipeline.run({ signal:input.signal,
      execute:async task => {
        phases.push(task.id);
        if (task.phase === "inventory") return { findings:"文件操作、数据库操作是独立功能；P2P 门面与传输实现跨仓协作。", open_questions:[], components:capabilities };
        if (task.phase === "paradigm") {
          const capability = capabilities.find(capability => capability.id === task.component)!;
          const section = sectionData(task.id, capability.repository_ids);
          section.title = `${capability.title}完整用法`;
          section.paradigm.component = capability.id;
          section.paradigm.need = capability.title;
          input.editDocument!({ action:"outline", entries:[{ id:section.id, title:section.title, repository_ids:section.repository_ids }] });
          input.editDocument!({ action:"section", section });
        }
        if (task.phase === "synthesis") input.editDocument!({ action:"overview", overview:guideOverview("文件操作、数据库操作和 P2P 通信分别解决不同开发需求。") });
        return { findings:`完成 ${task.title}`, open_questions:[],
          ...(task.phase === "plan" ? { paradigms:[{ id:"use", title:`${task.title}完整用法`, need:task.title }] } : {}) };
      }, review:async () => undefined, changed:state => input.update({ pipeline:state }),
    });
    return "功能组件指南已完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir,{recursive:true,force:true}); });
  const job = research.start({ language:"cpp" }, "alice");
  assert.equal(research.start({ language:"cpp" }, "bob").id, job.id);
  await finished(research, job.id);
  assert.equal(executions, 1);
  assert.equal(phases.filter(id => id === "inventory").length, 1);
  assert.deepEqual(phases.filter(id => id.startsWith("plan-")), capabilities.map(capability => `plan-${capability.id}`));
  const document = publishComponentKnowledge(research, dir, job.id, { scope:"platform" }, "alice");
  const assets = collectSearchableKnowledge(dir,{ repo:"", repositories:[], moduleIds:[] }).assets;
  const cards = componentCards(assets.filter(asset => asset.id === document.id)).cards;
  assert.deepEqual(new Set(cards.map(card => card.paradigm.component)), new Set(capabilities.map(capability => capability.id)));
  assert.deepEqual(new Set(cards.find(card => card.paradigm.component === "p2p")!.paradigm.evidence.map(ref => ref.repository_id)), new Set([first.id, second.id]));
});

test("跨组件读取按 ID 路由、固定版本且延迟准备，证据保留仓库", async () => {
  const dir = temporary();
  try {
    execFileSync("git", ["init", "-q", dir]);
    writeFileSync(join(dir,"sample.cpp"), "void close_file() {}\n");
    execFileSync("git", ["-C",dir,"add","."]);
    execFileSync("git", ["-C",dir,"-c","user.name=Test","-c","user.email=test@example.com","commit","-qm","fixture"]);
    const revision = execFileSync("git", ["-C",dir,"rev-parse","HEAD"], {encoding:"utf8"}).trim();
    const components = ["one","two"].map(id => ({...config,id,path:"",enabled:true,description:"",repository:`https://code.example/${id}.git`}));
    const prepared: string[] = [], evidence: any[] = [];
    const tool = languageComponentSourceTool(components, async c => { prepared.push(c.id); return {root:dir,revision}; }, e => evidence.push(e));
    await call(tool, {action:"read",path:"sample.cpp"});
    assert.equal(prepared.length, 0, "多仓不能默认读第一项");
    for (const id of ["two","one","two"]) {
      const result = await call(tool, {action:"read",component_id:id,path:"sample.cpp"});
      assert.match(JSON.stringify(result), /close_file/);
    }
    assert.deepEqual(prepared, ["two","one"]);
    assert.deepEqual(evidence.map(e => e.component_id), ["two","one","two"]);
    assert.equal(evidence[0].repository, components[1].repository);
    assert.equal(evidence[0].revision, revision);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test("组件源码目录分段列出并明确续读位置，扫描不会静默丢弃后续条目", async t => {
  const dir = temporary();
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  execFileSync("git", ["init", "-q", dir]);
  for (let i=0;i<105;i++) writeFileSync(join(dir,`api-${String(i).padStart(3,"0")}.h`), "void call();\n");
  execFileSync("git", ["-C",dir,"add","--", ...Array.from({ length: 105 }, (_, i) => `api-${String(i).padStart(3,"0")}.h`)]);
  execFileSync("git", ["-C",dir,"-c","user.name=Test","-c","user.email=test@example.com","commit","-qm","fixture"]);
  const tool = componentSourceTool(dir,"HEAD","",()=>{});
  const first = await call(tool,{action:"list"});
  assert.match(first.content[0].text,/目录共 105 项/);
  assert.match(first.content[0].text,/list start=101/);
  assert.doesNotMatch(first.content[0].text,/api-104/);
  const next = await call(tool,{action:"list",start:101});
  assert.match(next.content[0].text,/api-104/);
  assert.doesNotMatch(next.content[0].text,/后续请/);
});

test("停止和删除不会被迟到结果复活；删除保留已采纳知识，失败可以重试", async () => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  let release!: () => void;
  const hold = new Promise<void>(r => release = r);
  let calls = 0;
  const research = new ComponentResearch(dir, async input => {
    calls++;
    if (calls === 1) { await hold; input.update({stage:"迟到更新"}); }
    if (calls === 2) throw new Error("测试失败");
    return writeJoint(input);
  });
  try {
    const slow = research.start({ language:"cpp" }, "alice");
    await until(() => research.get(slow.id).status === "running");
    research.stop(slow.id);
    release();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(research.get(slow.id).status, "cancelled");
    assert.equal(research.get(slow.id).stage, "已停止");
    research.remove(slow.id, "bob");
    assert.ok(!research.list().some(r => r.id === slow.id));
    assert.equal(research.get(slow.id).deleted_by, "bob");
    const fail = research.start({ language:"cpp" }, "alice");
    await until(() => research.get(fail.id).status === "failed");
    assert.equal(research.start({ language:"cpp" }, "alice").id, fail.id, "失败的研究也是这个组件的那一次研究");
    const done = research.retry(fail.id, "alice");
    assert.equal(done.id, fail.id, "重试原地继续");
    await finished(research, done.id);
    const doc = publishComponentKnowledge(research, dir, done.id, {scope:"platform"}, "alice");
    research.remove(done.id, "bob");
    assert.ok(research.get(done.id).draft, "来源追溯保留");
    const {readKnowledgeDocument} = await import("../src/knowledgeDocuments.ts");
    assert.equal(readKnowledgeDocument(dir, doc.id).id, doc.id);
    assert.throws(() => research.retry(done.id,"alice"), /删除/);
  } finally { release(); await research.shutdown(); rmSync(dir,{recursive:true,force:true}); }
});

test("同来源范围只执行一次研究，细粒度能力默认全选，筛选后采纳为单篇文档", async t => {
  const dir = temporary();
  const one = saveComponentRepository(dir, config, "alice");
  const two = saveComponentRepository(dir, {...config, name:"日期组件", repository:"https://code.example/date.git"}, "alice");
  saveComponentRepository(dir, {...config, name:"Java", languages:["java"]}, "alice");
  saveComponentRepository(dir, {...config, name:"已停用", enabled:false}, "alice");
  const executions: string[] = [];
  const research = new ComponentResearch(dir, async input => {
    executions.push(input.record.id);
    assert.equal(input.record.mode, "all");
    assert.equal(researchSourceRepositories(input.record).length, 1);
    writeJoint(input, 32);
    input.editDocument!({ action: "section", section: { ...sectionData("cap-0", [researchSourceRepositories(input.record)[0].id]), related_ids: ["cap-1"] } });
    return "完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  const batch = research.start({ language:"C++", repository_ids: [one.id]}, "alice");
  assert.equal(research.start({ language:"cpp", repository_ids: [one.id]}, "alice").id, batch.id);
  assert.notEqual(research.start({ language:"cpp", repository_ids: [two.id]}, "alice").id, batch.id, "不同参考来源范围是另一份研究，组件仍由分析生成");
  await finished(research, batch.id);
  const complete = research.get(batch.id);
  await until(() => research.list().every(r => r.status === "done"));
  assert.equal(executions.filter(id => id === batch.id).length, 1);
  assert.equal(complete.document!.sections.length, 32);
  assert.ok(complete.document!.sections.every(section => section.selected));
  assert.equal((complete.draft!.match(/### 完整示例/g) ?? []).length, 32);
  assert.equal((complete.draft!.match(/### 单元测试示例/g) ?? []).length, 32);
  assert.equal(research.list(true).length, 2);
  assert.ok(research.list(true).every(r => r.document === undefined));
  assert.throws(() => research.selectSections(batch.id, ["unknown"], false), /有效/);
  research.selectSections(batch.id, complete.document!.sections.map(s => s.id), false);
  assert.throws(() => publishComponentKnowledge(research, dir, batch.id, {scope:"platform"}, "alice"), /请选择至少一个/);
  research.selectSections(batch.id, ["cap-0"], true);
  const doc = publishComponentKnowledge(research, dir, batch.id, {scope:"platform",content:"不可覆盖结构化草稿"}, "alice");
  assert.match(doc.content, /## 能力 cap-0/);
  assert.doesNotMatch(doc.content, /## 能力 cap-1\b|不可覆盖结构化草稿/);
  assert.doesNotMatch(doc.content, /#component-cap-1\b/, "未选用法不进入导航");
  assert.deepEqual(doc.research_source?.components?.map(c => c.id), [one.id]);
  const repeated = publishComponentKnowledge(research, dir, batch.id, {}, "alice");
  assert.equal(repeated.id, doc.id);
  assert.equal(repeated.revision, doc.revision);
  assert.throws(() => research.review(batch.id, { section_id:"cap-0",mode:"rework",message:"修改" }, "alice"), /不可/);
  research.remove(batch.id, "alice");
  assert.equal(research.list().length, 1);
  assert.equal(research.get(batch.id).document_id, doc.id);
  assert.throws(() => research.retry(batch.id, "alice"), /删除/);
});

test("技术栈的 53 个参考仓进入同一研究范围，停止后迟到章节和结果不能覆盖草稿", async t => {
  const dir = temporary();
  const rows = Array.from({length:53}, (_, i) => saveComponentRepository(dir, {...config, name:`组件 ${i}`, repository:`https://code.example/c${i}.git`}, "alice"));
  let count = 0;
  const research = new ComponentResearch(dir, async input => {
    count++;
    assert.deepEqual(new Set(researchSourceRepositories(input.record).map(c => c.id)), new Set(rows.map(row => row.id)));
    writeJoint(input);
    await new Promise<void>(resolve => input.signal.aborted ? resolve() : input.signal.addEventListener("abort", () => resolve(), {once:true}));
    assert.throws(() => input.editDocument!({action:"overview",overview:"迟到内容"}), /停止/);
    return "# 迟到草稿";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  const batch = research.start({ language:"cpp" }, "alice");
  await until(() => count === 1);
  assert.equal(research.start({ language:"cpp" }, "alice").id, batch.id);
  research.stop(batch.id);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(count, 1);
  assert.equal(research.get(batch.id).document?.sections.length, 2);
  assert.doesNotMatch(research.get(batch.id).draft!, /迟到/);
  assert.equal(research.get(batch.id).status, "cancelled");
  research.remove(batch.id, "alice");
  assert.equal(research.list().length, 0);
});

test("重启中断保留章节、勾选与对话，继续研究沿用原始组件范围", async t => {
  const dir = temporary();
  const row = saveComponentRepository(dir, config, "alice");
  saveComponentRepository(dir, {...config,name:"日期",repository:"https://code.example/date.git"}, "alice");
  const initial = new ComponentResearch(dir, async input => writeJoint(input));
  const batch = initial.start({ language:"cpp", repository_ids: [row.id]}, "alice");
  await finished(initial, batch.id);
  initial.selectSections(batch.id, ["cap-1"], false);
  await initial.shutdown();
  const original = initial.get(batch.id).document;
  const file = join(dir,"component-research",batch.id,"record.json");
  const state = JSON.parse(readFileSync(file,"utf8"));
  writeFileSync(file,JSON.stringify({...state,status:"running",review_turns:[{id:"turn",section_id:"cap-0",mode:"discuss",message:"补充说明",operator:"alice",status:"running",created_at:new Date().toISOString()}]}));
  let runs = 0;
  const recovered = new ComponentResearch(dir, async ({record,review}) => {
    runs++; assert.deepEqual(researchSourceRepositories(record).map(c => c.id), [row.id]);
    assert.equal(review?.section_id,"cap-0");assert.equal(review?.mode,"discuss");
    return "# 重试完成";
  });
  t.after(async () => { await recovered.shutdown(); rmSync(dir, {recursive:true,force:true}); });
  assert.equal(recovered.get(batch.id).status, "queued");
  assert.equal(recovered.get(batch.id).review_turns?.[0].status, "queued");
  assert.deepEqual(recovered.get(batch.id).document, original);
  for (const repo of componentRepositories(dir)) saveComponentRepository(dir,{id:repo.id,enabled:false},"alice");
  await finished(recovered, batch.id);
  assert.equal(runs,1);
  assert.deepEqual(recovered.get(batch.id).document, original);
});

test("对话只读；局部返工只替换指定章节，失败与停止均保留原稿", async t => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    const target = input.readDocument!().sections[0];
    assert.equal(input.review.section_id, target.id);
    assert.throws(() => input.editDocument!({action:"overview",overview:"不能改总览"}), /只能修改/);
    assert.throws(() => input.editDocument!({action:"section",section:sectionData("cap-1",target.repository_ids)}), /只能修改/);
    if (input.review.mode === "discuss") {
      assert.throws(() => input.editDocument!({action:"section",section:target}), /讨论不会修改/);
      return "此接口的资源由调用方释放，可补充失败路径示例。";
    }
    input.editDocument!({action:"section",section:{...target,content:usageContent("新增取消与异常路径"),example:"```cpp\nClose(handle); // error cleanup\n```"}});
    if (input.review.message === "失败") throw new Error("读取异常");
    if (input.review.message === "停止") await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), {once:true}));
    return "已核对接口，仅修订所选组件的错误处理示例。";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir,{recursive:true,force:true}); });
  const job = research.start({ language:"cpp" },"alice");
  await finished(research, job.id);
  const original = research.get(job.id).document!;
  research.review(job.id,{section_id:"cap-0",mode:"discuss",message:"为什么需要清理？"},"expert");
  assert.throws(() => research.review(job.id,{section_id:"cap-1",mode:"rework",message:"同时改"},"expert"), /本轮/);
  await finished(research, job.id);
  assert.deepEqual(research.get(job.id).document, original);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"按建议修改"},"expert");
  await finished(research, job.id);
  assert.deepEqual(research.get(job.id).document, original, "建议未采纳不能修改正文");
  const suggestion = research.get(job.id).review_turns!.at(-1)!;
  assert.equal(suggestion.proposal?.status, "pending");
  research.decideProposal(job.id, suggestion.id, "accept", "expert");
  const revised = research.get(job.id).document!;
  assert.equal(revised.sections[0].revision, 2);
  assert.deepEqual(revised.sections[1], original.sections[1]);
  assert.equal(revised.overview, original.overview);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"失败"},"expert");
  await until(() => research.get(job.id).status === "failed");
  assert.deepEqual(research.get(job.id).document, revised);
  research.retry(job.id,"expert");
  await until(() => research.get(job.id).status === "failed");
  assert.equal(research.get(job.id).review_turns!.at(-1)!.section_id,"cap-0");
  assert.equal(research.get(job.id).review_turns!.at(-1)!.message,"失败");
  assert.deepEqual(research.get(job.id).document,revised);
  research.review(job.id,{section_id:"cap-0",mode:"rework",message:"停止"},"expert");
  await until(() => research.get(job.id).status === "running");
  await new Promise(resolve => setTimeout(resolve, 20));
  research.stop(job.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(research.get(job.id).document, revised);
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.status), ["done","done","failed","failed","cancelled"]);
});

test("缺完整示例不能完成，已保存能力允许继续补齐而不重做", async t => {
  const dir = temporary();
  const repo = saveComponentRepository(dir, config, "alice");
  let runs = 0;
  const research = new ComponentResearch(dir, async input => {
    if (++runs === 1) {
      writeJoint(input, 1);
      input.editDocument!({action:"outline",entries:[{id:"missing",title:"缺示例",repository_ids:[repo.id]}]});
      assert.throws(() => input.editDocument!({action:"section",section:{...sectionData("missing",[repo.id]),example:"只有文字"}}), /完整示例/);
    } else input.editDocument!({action:"section",section:sectionData("missing",[repo.id])});
    return "已保存";
  });
  t.after(async () => {await research.shutdown();rmSync(dir,{recursive:true,force:true});});
  const job = research.start({ language:"cpp" },"alice");
  await until(() => research.get(job.id).status === "failed");
  const preserved = research.get(job.id).document!.sections[0];
  assert.throws(() => publishComponentKnowledge(research, dir, job.id,{scope:"platform"},"alice"), /完成后发布/);
  research.retry(job.id,"alice");
  await finished(research, job.id);
  assert.deepEqual(research.get(job.id).document!.sections[0],preserved);
});

test("B5验收1/生产线验收10/14：组件发布拒绝未检视或过期建议，并发冲突保留原稿，单次确认采用最新建议", async t => {
  const { listKnowledgeDocuments } = await import("../src/knowledgeDocuments.ts");
  const dir = temporary(); saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    const section = input.readDocument!().sections.find(section => section.id === input.review!.section_id)!;
    input.editDocument!({ action: "section", section: { ...section, content: usageContent(input.review.message) } });
    if (input.review.message === "未完成的修改") throw new Error("研究失败");
    return "修改完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  for (const message of ["旧建议", "新建议"]) {
    research.review(job.id, { section_id: "cap-0", mode: "rework", message }, "alice");
    await finished(research, job.id);
  }
  const viewed = componentPublishInput(research.get(job.id));
  assert.throws(() => research.publish(job.id, { ...viewed, sections: viewed.sections.map(section => ({ ...section, proposal_id: null })) }, "alice"), /修改建议已有变化/);
  const oldProposalId = research.get(job.id).review_turns![0].id;
  assert.throws(() => research.publish(job.id, { ...viewed, sections: viewed.sections.map(section => section.id === "cap-0" ? { ...section, proposal_id: oldProposalId } : section) }, "alice"), /修改建议已有变化/);
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.proposal!.status), ["pending", "pending"]);
  assert.equal(listKnowledgeDocuments(dir).length, 0, "未检视或过期建议均不能写正式库");
  const section = research.get(job.id).document!.sections[0];
  research.editSection(job.id, { section: { ...section, content: usageContent("其他人修改的正文") }, base_revision: section.revision }, "bob");
  assert.throws(() => research.publish(job.id, componentPublishInput(research.get(job.id)), "alice"), /基线冲突/);
  assert.throws(() => research.decideProposal(job.id, research.get(job.id).review_turns!.at(-1)!.id, "accept", "alice"), /新版本/);
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.proposal!.status), ["pending", "pending"]);
  assert.equal(listKnowledgeDocuments(dir).length, 0);
  research.review(job.id, { section_id: "cap-1", mode: "rework", message: "未完成的修改" }, "alice");
  await until(() => research.get(job.id).status === "failed");
  assert.throws(() => research.decideProposal(job.id, research.get(job.id).review_turns!.at(-1)!.id, "accept", "alice"), /尚未完成/);
  research.review(job.id, { section_id: "cap-0", mode: "rework", message: "最终确认的修改" }, "alice");
  await finished(research, job.id);
  research.selectSections(job.id, ["cap-1"], false);
  const published = publishComponentKnowledge(research, dir, job.id, {}, "alice");
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.proposal!.status), ["discarded", "discarded", "pending", "accepted"]);
  assert.match(published.content, /最终确认的修改/); assert.doesNotMatch(published.content, /未完成的修改/);
  const repeated = publishComponentKnowledge(research, dir, job.id, {}, "alice");
  assert.equal(repeated.id, published.id, "重复发布保持幂等，未选章节的意见仍保留");
  assert.equal(repeated.revision, published.revision);
  assert.equal(research.get(job.id).review_turns![2].proposal!.status, "pending", "未选章节的意见仍保留");
});

test("组件连续整体意见接着上一轮候选修改，原稿与发布基线保留到确认", async t => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  const seen: string[] = [];
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    const document = input.readDocument!(), section = document.sections[0];
    assert.deepEqual(input.record.document, document, "执行快照和读取工具使用同一份候选内容");
    assert.equal(input.record.draft, researchDocumentMarkdown(input.record.topic, document));
    seen.push(section.content);
    input.editDocument!({ action: "section", section: { ...section, content: section.content + `\n${input.review.message}` } });
    return "修改完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  const original = research.get(job.id).document!;
  for (const message of ["补充第一轮边界", "补充第二轮示例"]) {
    research.review(job.id, { section_id: "cap-0", mode: "rework", message }, "expert");
    await until(() => ["done", "failed"].includes(research.get(job.id).status));
    assert.equal(research.get(job.id).status, "done", research.get(job.id).error);
  }
  const pending = research.get(job.id), content = original.sections[0].content;
  assert.deepEqual(seen, [content, content + "\n补充第一轮边界"]);
  assert.deepEqual(pending.document, original, "待确认候选不会修改原稿");
  assert.equal(pending.document_id, undefined);
  assert.equal(pending.review_turns!.at(-1)!.proposal!.base_revision, original.sections[0].revision);
  assert.equal(pending.review_turns!.at(-1)!.proposal!.section.content, content + "\n补充第一轮边界\n补充第二轮示例");
  research.editSection(job.id, { section: { ...original.sections[0], content: usageContent("人工保存的新正文") }, base_revision: original.sections[0].revision }, "editor");
  research.review(job.id, { section_id: "cap-0", mode: "rework", message: "核对人工正文" }, "expert");
  await until(() => ["done", "failed"].includes(research.get(job.id).status));
  assert.equal(research.get(job.id).status, "done", research.get(job.id).error);
  assert.equal(seen.at(-1), usageContent("人工保存的新正文"), "版本已变更时不会沿用过期候选");
  const latest = research.get(job.id).review_turns!.at(-1)!;
  const confirmed = research.decideProposal(job.id, latest.id, "accept", "expert");
  assert.equal(confirmed.document!.sections[0].content, usageContent("人工保存的新正文") + "\n核对人工正文");
  assert.equal(confirmed.document!.sections[0].revision, original.sections[0].revision + 2);
  assert.deepEqual(confirmed.document!.sections[1], original.sections[1]);
});

test("组件确认竞态：不覆盖较新建议，研究进行中不能确认，放弃新建议后可确认旧建议", async t => {
  const dir = temporary(); saveComponentRepository(dir, config, "alice");
  let release = () => {}, discussing = false;
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    if (input.review.mode === "discuss") { await new Promise<void>(resolve => { release = resolve; discussing = true; }); return "讨论完成"; }
    const section = input.readDocument!().sections.find(section => section.id === input.review!.section_id)!;
    input.editDocument!({ action: "section", section: { ...section, content: usageContent(input.review.message) } }); return "修改完成";
  });
  t.after(async () => { release(); await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  for (const message of ["已阅读的旧建议", "刚生成的新建议"]) {
    research.review(job.id, { section_id: "cap-0", mode: "rework", message }, "alice");
    await finished(research, job.id);
  }
  const [old, latest] = research.get(job.id).review_turns!;
  assert.throws(() => research.decideProposal(job.id, old.id, "accept", "alice"), /更新的修改建议/);
  assert.deepEqual(research.get(job.id).review_turns!.map(turn => turn.proposal!.status), ["pending", "pending"]);
  assert.equal(research.get(job.id).document!.sections[0].revision, 1);
  research.review(job.id, { section_id: "cap-0", mode: "discuss", message: "继续讨论" }, "alice");
  await until(() => discussing);
  assert.throws(() => research.decideProposal(job.id, latest.id, "accept", "alice"), /当前研究仍在进行/);
  release(); await finished(research, job.id);
  research.decideProposal(job.id, latest.id, "discard", "alice");
  const accepted = research.decideProposal(job.id, old.id, "accept", "alice");
  assert.equal(accepted.document!.sections[0].content, usageContent("已阅读的旧建议"));
  assert.deepEqual(accepted.review_turns!.slice(0, 2).map(turn => turn.proposal!.status), ["accepted", "discarded"]);
});

test("结构化章节拒绝未知来源、空示例和悬空关联；Markdown 保留真实依赖", () => {
  const doc = editResearchDocument({overview:guideOverview("联合关系"),sections:[]},{action:"outline",entries:[{id:"a",title:"A",repository_ids:["r"]},{id:"b",title:"B",repository_ids:["r"]}]},["r"]);
  const section = sectionData("a",["r"]);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,repository_ids:["other"]}},["r"]), /范围/);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,example:"```cpp\n\n```"}},["r"]), /完整示例/);
  assert.throws(() => editResearchDocument(doc,{action:"section",section:{...section,related_ids:["unknown"]}},["r"]), /关联组件/);
  const filled = editResearchDocument(doc,{action:"section",section:{...section,related_ids:["b"]}},["r"]);
  assert.deepEqual(filled.sections[0].related_ids, ["b"]);
  const complete = editResearchDocument(filled,{action:"section",section:sectionData("b",["r"])},["r"]);
  const md = researchDocumentMarkdown("指南",complete);
  assert.match(md, /关键接口/); assert.match(md, /libfile.so/); assert.match(md, /#component-b/);
});

test("超过普通上传容量的联合长文可完整采纳，后续调整范围不丢正文", async t => {
  const dir = temporary();saveComponentRepository(dir,config,"alice");
  const longContent = "完整使用细节。".repeat(150_000);
  const research = new ComponentResearch(dir,async input => {
    writeJoint(input,1);
    input.editDocument!({action:"section",section:{...sectionData("cap-0",researchSourceRepositories(input.record).map(c => c.id)),content:usageContent(longContent)}});
    return "完成";
  });
  t.after(async () => {await research.shutdown();rmSync(dir,{recursive:true,force:true});});
  const job = research.start({ language:"cpp" },"alice");
  await finished(research, job.id);
  const doc = publishComponentKnowledge(research, dir, job.id,{scope:"platform"},"alice");
  assert.ok(Buffer.byteLength(doc.content) > 2 * 1024 * 1024);
  assert.ok(doc.content.includes(longContent));
  const { saveKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  assert.equal(saveKnowledgeDocument(dir,{active:false},"alice",doc.id).content,doc.content);
  assert.throws(() => saveKnowledgeDocument(dir,{title:"普通上传",content:usageContent(longContent)},"alice"),/最大 2 MiB/);
});

test("已采纳组件更新沿用同一知识条目及名称范围，人工版本冲突不覆盖", async t => {
  const { saveKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  const dir = temporary(); saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => writeJoint(input));
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  const first = publishComponentKnowledge(research, dir, job.id, { title: "团队定制的组件指南", scope: "repository", repositories: [config.repository] }, "alice");
  const update = research.beginUpdate(job.id, "bob");
  assert.equal(update.update_metadata?.title, first.title); assert.equal(update.update_metadata?.scope, "repository");
  assert.deepEqual(update.update_metadata?.repositories, [config.repository]);
  const section = update.document!.sections[0];
  research.editSection(job.id, { section: { ...section, content: section.content + "\n人工补充" }, base_revision: section.revision }, "bob");
  const second = publishComponentKnowledge(research, dir, job.id, update.update_metadata!, "bob");
  assert.equal(second.id, first.id); assert.equal(second.title, first.title); assert.equal(second.scope, first.scope); assert.match(second.content, /人工补充/);
  assert.notEqual(second.revision, first.revision, "人工修改形成同一正式条目的新版本");
  research.beginUpdate(job.id, "bob");
  saveKnowledgeDocument(dir, { content: "另一维护人的正文" }, "other", first.id);
  assert.throws(() => publishComponentKnowledge(research, dir, job.id, {}, "bob"), /正式知识已有新版本/);
});

test("B5缺口3：正式文档在别处改过后仍可发起更新，如实提示别处修改不会带入", async t => {
  const { saveKnowledgeDocument, readKnowledgeDocument } = await import("../src/knowledgeDocuments.ts");
  const dir = temporary(); saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => writeJoint(input));
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  const first = publishComponentKnowledge(research, dir, job.id, { title: "组件指南" }, "alice");
  const edited = saveKnowledgeDocument(dir, { content: "阅读页里人工改过的正文" }, "other", first.id, { expectedRevision: first.revision });
  const update = research.beginUpdate(job.id, "bob");
  assert.equal(update.update_document_revision, edited.revision, "以当前正式版本为发布基线，不会被版本锁永久拒绝");
  assert.match(update.stage ?? "", /别处的修改不会自动带入/);
  const section = update.document!.sections[0];
  research.editSection(job.id, { section: { ...section, content: section.content + "\n更新补充" }, base_revision: section.revision }, "bob");
  const { saveKnowledgeReviewNote, listKnowledgeReviewNotes } = await import("../src/knowledgeReviewNotes.ts");
  const sources = { dataDir: dir, component: research } as unknown as Parameters<typeof saveKnowledgeReviewNote>[0];
  saveKnowledgeReviewNote(sources, "component", job.id, { document_id: section.id, scope: "document", note: "下次再补异常示例" }, "carol");
  const second = publishComponentKnowledge(research, dir, job.id, update.update_metadata!, "bob");
  assert.equal(second.id, first.id); assert.match(second.content, /更新补充/);
  assert.equal(listKnowledgeReviewNotes(sources, "component", job.id).notes[0].status, "open", "B5：未处理意见不拦发布，保持原状");
  assert.equal(readKnowledgeDocument(dir, first.id).revision, second.revision);
});

test("补充遗漏能力：只能新增能力项，经整轮完成才并入并默认勾选；空补充、不完整、失败与停止都保留原稿", async t => {
  const dir = temporary();
  saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    assert.equal(input.review.mode, "supplement"); assert.equal(input.review.section_id, "");
    const ids = researchSourceRepositories(input.record).map(c => c.id), existing = input.readDocument!().sections[0];
    assert.throws(() => input.editDocument!({ action: "overview", overview: "改概述" }), /不能修改概述/);
    assert.throws(() => input.editDocument!({ action: "section", section: { ...existing, content: "借补充改已有项" } }), /只能填写本轮新增/);
    assert.throws(() => input.editDocument!({ action: "outline", entries: [{ id: existing.id, title: existing.title, repository_ids: ids }] }), /已有能力请在该项上返工/);
    const message = input.review.message;
    if (message === "查无") return "核对后未发现遗漏。";
    input.editDocument!({ action: "outline", entries: [{ id: "cap-pool", title: "连接池超时回收", repository_ids: ids }] });
    if (message === "不完整") return "只列了目录。";
    input.editDocument!({ action: "section", section: { ...sectionData("cap-pool", ids), title: "连接池超时回收" } });
    if (message === "失败") throw new Error("评审未通过");
    if (message === "停止") await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve(), { once: true }));
    return "补充了连接池超时回收。";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice");
  await finished(research, job.id);
  research.selectSections(job.id, ["cap-1"], false);
  const original = research.get(job.id).document!;
  assert.throws(() => research.review(job.id, { section_id: "cap-0", mode: "supplement", message: "x" }, "expert"), /不针对已有能力项/);
  for (const [message, reason] of [["查无", /没有找到可补充的能力/], ["不完整", /补充的能力尚不完整（连接池超时回收）/], ["失败", /评审未通过/]] as const) {
    research.review(job.id, { section_id: "", mode: "supplement", message }, "expert");
    await until(() => research.get(job.id).status === "failed");
    const turn = research.get(job.id).review_turns!.at(-1)!;
    assert.match(turn.error ?? "", reason); assert.equal(turn.added_section_ids, undefined, "失败轮不留下看似已补充的编号");
    assert.deepEqual(research.get(job.id).document, original, `${message}：原稿与勾选保持不变`);
  }
  research.retry(job.id, "expert");
  await until(() => research.get(job.id).status === "failed");
  assert.equal(research.get(job.id).review_turns!.at(-1)!.mode, "supplement", "重试按原补充要求重放");
  research.review(job.id, { section_id: "", mode: "supplement", message: "停止" }, "expert");
  await until(() => research.get(job.id).status === "running");
  await new Promise(resolve => setTimeout(resolve, 20));
  research.stop(job.id);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(research.get(job.id).document, original);
  research.review(job.id, { section_id: "", mode: "supplement", message: "漏了连接池超时回收" }, "expert");
  assert.match(research.get(job.id).stage, /^(等待|正在)补充遗漏能力$/);
  await finished(research, job.id);
  const supplemented = research.get(job.id);
  assert.deepEqual(supplemented.document!.sections.map(s => [s.id, s.selected]), [["cap-0", true], ["cap-1", false], ["cap-pool", true]], "新项追加并默认勾选，已有勾选不变");
  assert.deepEqual(supplemented.document!.sections.slice(0, 2), original.sections, "已有能力原样保留");
  assert.equal(supplemented.document!.overview, original.overview);
  assert.deepEqual(supplemented.review_turns!.at(-1)!.added_section_ids, ["cap-pool"]);
  assert.match(supplemented.draft ?? "", /连接池超时回收/);
  await research.shutdown();
  const reopened = new ComponentResearch(dir, async () => "不应运行");
  assert.deepEqual(reopened.get(job.id).document!.sections.map(s => s.id), ["cap-0", "cap-1", "cap-pool"], "补充轮记录可跨重启读取");
  await reopened.shutdown();
});

test("#457 整体返工原子更新概述及多项文稿，新增内容可审阅，失败不覆盖原稿", async t => {
  const dir = temporary(); saveComponentRepository(dir, config, "alice");
  const research = new ComponentResearch(dir, async input => {
    if (!input.review) return writeJoint(input);
    assert.equal(input.review.section_id, "");
    const ids = researchSourceRepositories(input.record).map(c => c.id);
    input.editDocument!({ action: "overview", overview: guideOverview("删除重复介绍，补充整体使用边界。") });
    for (const section of input.readDocument!().sections) input.editDocument!({ action: "section", section: { ...section, content: `${section.content}\n修订后的边界说明。` } });
    input.editDocument!({ action: "outline", entries: [{ id: "missing", title: "遗漏的异常恢复", repository_ids: ids }] });
    input.editDocument!({ action: "section", section: sectionData("missing", ids) });
    if (input.review.message === "失败") throw new Error("独立评审失败");
    return "全部文稿修订完成";
  });
  t.after(async () => { await research.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const job = research.start({ language: "cpp" }, "alice"); await finished(research, job.id);
  research.selectSections(job.id, ["cap-1"], false);
  const original = research.get(job.id).document;
  research.review(job.id, { section_id: "", mode: "rework", message: "失败" }, "alice"); await until(() => research.get(job.id).status === "failed");
  assert.deepEqual(research.get(job.id).document, original);
  research.review(job.id, { section_id: "", mode: "rework", message: "补充并去重" }, "alice"); await finished(research, job.id);
  const result = research.get(job.id);
  assert.match(result.document!.overview, /整体使用边界/);
  assert.deepEqual(result.document!.sections.map(s => [s.id, s.selected]), [["cap-0", true], ["cap-1", false], ["missing", true]]);
  assert.match(result.document!.sections[1].content, /修订后的边界/);
  assert.equal(result.section_history!.length, 2);
  assert.equal(result.document_id, undefined, "只修改草稿，不自动发布");
});
