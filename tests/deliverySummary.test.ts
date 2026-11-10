import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliverySummaries, DELIVERY_SUMMARY_FILE, DELIVERY_SUMMARY_ARTIFACT, deliveryReportRevision, deliveryReportView } from "../src/deliverySummary.ts";
import { deliverySourceTool, runDeliverySummaryAgent, validateSummaryDiagrams, DELIVERY_SUMMARY_MISSION, summaryLanguageIssue, type DeliverySummaryInput } from "../src/deliverySummaryAgent.ts";
import { collectReportEvidence, reportEvidenceTool } from "../src/deliveryReportEvidence.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { ScriptedModelServer } from "../src/scriptedModel.ts";
import { EventLog } from "../src/semanticEvents.ts";
import { listArtifactDocuments, readArtifact } from "../src/artifacts.ts";
import { scopePipelineArtifacts } from "../src/pipelineArtifactScope.ts";

// 脚本模型仅验证整份报告的传递与渲染，内容质量仍需真实模型验收。
const leadership = `## 一页纸总结
| 项目 | 总结 |
| --- | --- |
| 解决什么问题 | 查询没有记录时，各处处理方式不同，使用者难以判断结果。 |
| 做了什么 | 统一查询入口的空结果处理，让各处获得相同结果，减少重复判断。 |
| 交付质量 | 已核对改动的代码，仍缺少逐项运行证据，不能据此确认全部通过。 |
| 当前状态 | 代码已经实现，验证尚未结束，合入和上线情况还需分别核对。 |
| 已知风险 | 空结果的完整业务流程仍需验证，暂不据此承诺可直接上线。 |
## 设计一致性结论
设计与实现核对结果（按 4+1 视图）：
| 视图 | 设计预期 | 实现结果（源码核对） | 一致性结论 |
| --- | --- | --- | --- |
| 逻辑视图 | 统一空结果 | 查询入口统一处理，独立检视版本未确认 | ⚠️ 待核实 |
| 开发视图 | 统一转换模块 | 模块调用已核对，独立检视版本未确认 | ⚠️ 待核实 |
| 进程视图 | 返回前转换 | 源码符合，运行结果未确认 | ⚠️ 待核实 |
| 物理视图 | 沿用部署 | 未改变配置，部署未验证 | ⚠️ 待核实 |
| 场景视图（+1） | 查询返回空数组 | 空结果的模块级行为缺少运行证据，TC-02 待确认 | ⚠️ 待核实 |
\`\`\`plantuml
@startuml
left to right direction
rectangle "设计预期：统一空结果、模块、顺序、部署、场景" as design
rectangle "实现结果：源码已核对，运行与版本待核实" as implementation
design --> implementation : 五个视图仍有待核实范围
@enduml
\`\`\`
`;
const diagram = leadership + `## 改动点 4+1
原来查询直接取配置 → 现在查询入口统一处理空结果。
### 逻辑视图
查询入口复用配置组件，空结果统一为空数组。
\`\`\`plantuml
@startuml
class "查询服务（修改）" as Query #LightBlue
interface "配置来源（既有）" as Config #LightGray
Query --> Config : 获取记录
@enduml
\`\`\`
依据：service.cpp 的查询入口。
### 开发视图
新增转换模块，查询模块调用后输出统一结果。
\`\`\`plantuml
@startuml
component "查询模块（修改）" as query #LightBlue
component "结果转换（新增）" as convert #LightGreen
component "配置组件（既有）" as config #LightGray
query --> config : 获取记录
query --> convert : 转换空结果
@enduml
\`\`\`
依据：service.cpp 的模块依赖。
### 进程视图
空记录在返回前转换，时序依据源码，尚无运行结果。
\`\`\`plantuml
@startuml
actor "调用者" as user
participant "查询入口（修改）" as query #LightBlue
participant "配置组件（既有）" as config #LightGray
user -> query : 查询
query -> config : 读取配置
config --> query : 空记录
query --> user : 空数组（修改）
@enduml
\`\`\`
### 物理视图
沿用既有服务进程，本次差异无部署配置变更。
### 场景视图（+1）
见进程视图的查询流程；空结果关联 TC-01（函数 UT）、TC-02（模块 UT），执行结果未确认。
## 测试报告
### 验证范围与结论
查询行为，执行证据不足，当前版本的逐项结果未确认。
### 设计用例与执行结果
| 用例编号/场景 | 用例级别 | 条件、操作与预期 | 测试代码位置 | 实际结果 | 执行证据及版本 |
|---|---|---|---|---|---|
| TC-01 空结果 | 函数 UT | 无配置，转换查询结果，预期返回空数组 | 未找到 | 未确认 | 未取得逐项结果 |
| TC-02 查询入口 | 模块 UT（MST） | 配置组件返回空记录，调用查询入口，预期返回空数组 | 未找到 | 未确认 | 未取得逐项结果 |
### 失败、遗漏与待确认项
需核对对应测试代码与真实执行证据，不能凭整体绿灯确认这两条用例通过。
`;
const misplacedDiagram = "## 测试报告\n```plantuml\n@startuml\nA -> B: 测试\n@enduml\n```\n## 改动点 4+1\n### 逻辑视图\n只分析 diff，没有图。";
const reviewType = "design-consistency-review";
const reviewAssignment = "派发过程标记，不应进入交付报告";
const reviewTime = "2026-10-15T00:01:00Z";
function spawnReviewer(log: EventLog, call: string, type = reviewType, ts = reviewTime, sessionId = "main") {
  log.append({ eventId: log.lastEventId() + 1, taskId: "task-15", sessionId, ts, kind: "agent_spawned",
    payload: { call_id: call, child_session_id: `child-${call}`, agent_type: type, description: "检视", prompt: reviewAssignment } });
}
function finishReviewer(log: EventLog, call: string, text: string, lifecycle = "returned", child = `child-${call}`, sessionId = "main") {
  log.append({ eventId: log.lastEventId() + 1, taskId: "task-15", sessionId, ts: reviewTime, kind: "agent_finished",
    payload: { call_id: call, child_session_id: child, lifecycle, final_text: text } });
}
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), "delivery-summary-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(repo, "service.cpp"), "// initial\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); git("update-ref", "refs/remotes/origin/main", base);
  writeFileSync(join(repo, "service.cpp"), "// first delivery\n"); git("commit", "-qam", "first");
  const head = git("rev-parse", "HEAD");
  const task: any = { cwd: repo, summary: { id: "task-15", workspace: repo, status: "verifying", requirement: "查询", delivery: {
    sha: head, git_push: { sha: head }, mr_url: "https://code.example/mr/15", target_branch: "main",
  } } };
  return { repo, git, base, head, task, dispose: () => rmSync(repo, { recursive: true, force: true }) };
}

test("报告模板按管理摘要、一致性、4+1、测试顺序展开，两张表各五行", () => {
  const sections = ["一页纸总结", "设计一致性结论", "改动点 4+1", "测试报告"];
  for (const text of [DELIVERY_SUMMARY_MISSION, diagram]) {
    const positions = sections.map(section => text.indexOf(`## ${section}\n`));
    assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)));
    const tables = sections.slice(0, 2).map((_, index) => text.slice(positions[index], positions[index + 1]).split("\n").filter(line => /^\|/.test(line)));
    assert.equal(tables[0].length, 7);
    assert.deepEqual(tables[0].slice(2).map(row => row.split("|")[1].trim()), ["解决什么问题", "做了什么", "交付质量", "当前状态", "已知风险"]);
    assert.equal(tables[1].length, 7);
    assert.deepEqual(tables[1].slice(2).map(row => row.split("|")[1].trim()), ["逻辑视图", "开发视图", "进程视图", "物理视图", "场景视图（+1）"]);
    assert.ok(tables[1].slice(2).every(row => /\| (?:✅ 一致|⚠️ 待核实) \|$/.test(row)));
  }
  assert.match(DELIVERY_SUMMARY_MISSION, /150～250 字/);
  assert.match(DELIVERY_SUMMARY_MISSION, /不使用 HTML 标签（包括 <details>\/<summary>）/);
  assert.match(DELIVERY_SUMMARY_MISSION, /左右两个框/);
  assert.match(DELIVERY_SUMMARY_MISSION, /中间箭头标注真实的总体核对结论/);
  assert.match(DELIVERY_SUMMARY_MISSION, /独立检视缺席、返回不完整或版本无法核实/);
});

test("语言检查只扫描一页纸总结，函数、路径和编号不从技术正文误报", () => {
  assert.equal(summaryLanguageIssue(diagram), false);
  for (const term of ["mock", "BEH-12", "REQ20261109001", "spec", "test.js", "src/time.ts", "getTime()", "getTime", "get_time"]) {
    assert.equal(summaryLanguageIssue(diagram.replace("统一查询入口", term)), true, term);
    assert.equal(summaryLanguageIssue(diagram + `\n${term}`), false, `技术正文 ${term}`);
  }
});

for (const dirtyAgain of [false, true]) test(`摘要含 mock 时只修正一次，仍不合规也发布（仍含术语=${dirtyAgain}）`, async () => {
  const f = fixture(), logs: string[] = [];
  const dirty = diagram.replace("统一查询入口", "mock 查询入口");
  const model = new ScriptedModelServer([{ text: dirty }, { text: dirtyAgain ? dirty : diagram }], "scripted-v1", { linear: true });
  try {
    await model.start();
    const reports = new DeliverySummaries<any>(() => ({
      model: { choice: { provider: "maeflow", model: "scripted-v1" }, json: model.modelsJson() as Record<string, unknown> },
      renderDiagram: async () => ({ svg: "<svg/>" }), log: message => { logs.push(message); },
    }));
    reports.start(f.task); await reports.flush();
    assert.equal(model.requests.length, 2);
    assert.match(JSON.stringify(model.requests[1].messages), /用业务语言重写一页纸总结，不写函数名\/编号\/mock/);
    assert.equal(deliveryReportView(f.repo)?.status, "completed");
    const published = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    assert.equal(summaryLanguageIssue(published), dirtyAgain);
    assert.equal(logs.some(line => line.includes("仍含工程术语")), dirtyAgain);
  } finally { await model.stop(); f.dispose(); }
});

test("技术正文含 mock 不触发摘要措辞修正，首轮成功图无占位", async () => {
  const f = fixture();
  const model = new ScriptedModelServer([{ text: diagram + "\n测试使用 mock。" }], "scripted-v1", { linear: true });
  try {
    await model.start();
    const report = await runDeliverySummaryAgent({ taskId: "task-15", root: join(f.repo, "delivery-summary"), repo: f.repo, base: f.base, head: f.head, mrUrl: "test", context: "", capturedAt: "now" }, new AbortController().signal, {
      model: { choice: { provider: "maeflow", model: "scripted-v1" }, json: model.modelsJson() as Record<string, unknown> },
      renderDiagram: async () => ({ svg: "<svg/>" }),
    });
    assert.equal(model.requests.length, 1);
    assert.equal(report.status, "completed");
    assert.equal(report.body, diagram + "\n测试使用 mock。");
    assert.doesNotMatch(report.body, /图生成失败/);
  } finally { await model.stop(); f.dispose(); }
});

for (const recovery of ["never", "first", "second"] as const) test(`逐图修正，保留成功图与正文，失败图恢复=${recovery}`, async () => {
  const f = fixture(), rendered: string[] = [], notices: any[] = [];
  const bad = diagram.replace("Query --> Config : 获取记录", "this is invalid ???");
  const revised = (fixed: boolean) => (fixed ? diagram : bad).replace("原来查询直接取配置", "模型意外改写正文").replace("design --> implementation", "design ..> implementation");
  const replies = recovery === "first" ? [bad, revised(true)] : [bad, revised(false), revised(recovery === "second")];
  const model = new ScriptedModelServer(replies.map(text => ({ text })), "scripted-v1", { linear: true });
  try {
    await model.start();
    f.task.summary.luban_account = "owner";
    let published = 0;
    const reports = new DeliverySummaries<any>(() => ({
      model: { choice: { provider: "maeflow", model: "scripted-v1" }, json: model.modelsJson() as Record<string, unknown> },
      renderDiagram: async source => { rendered.push(source); return source.includes("invalid") ? { syntax_error: true, svg: "<svg/>" } : { svg: "<svg/>" }; },
      log: () => {}, onPublished: () => { published++; }, taskLink: "https://cloud.example/task",
      notifier: { notifyOutcome: async notice => { notices.push(notice); return {} as any; } },
    }));
    reports.start(f.task); await reports.flush();
    const partial = recovery === "never", rounds = recovery === "first" ? 1 : 2;
    assert.equal(model.requests.length, rounds + 1);
    assert.equal(rendered.length, 4 + rounds, "四张图逐一校验，后续只渲染失败图");
    for (const request of model.requests.slice(1)) {
      const prompt = JSON.stringify((request.messages as unknown[]).at(-1));
      assert.match(prompt, /第 2 张图/); assert.match(prompt, /当前图源/); assert.match(prompt, /invalid/);
      assert.match(prompt, /PlantUML 语法错误/); assert.match(prompt, /只修失败图/); assert.match(prompt, /完整 Markdown/);
    }
    const publishedText = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    assert.doesNotMatch(publishedText, /意外改写正文|design \.\.>|invalid/);
    assert.match(publishedText, /design --> implementation/);
    assert.match(publishedText, /## 测试报告/);
    if (partial) assert.match(publishedText, /> 图生成失败：PlantUML 语法错误（已自动尝试 2 轮）/);
    else assert.doesNotMatch(publishedText, /图生成失败/);
    assert.equal((publishedText.match(/```plantuml/g) ?? []).length, partial ? 3 : 4);
    const state = JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8"));
    const view = deliveryReportView(f.repo)!;
    assert.equal(state.status, partial ? "partial" : "completed"); assert.equal(state.published_head, f.head);
    assert.equal(view.status, state.status); assert.equal(view.available, true); assert.equal(view.head, f.head);
    assert.ok(view.message.includes(f.head.slice(0, 8))); assert.doesNotMatch(view.message, /上份报告/);
    assert.equal(view.message.includes("交付报告已更新（部分图未生成）"), partial);
    assert.equal(notices[0].status.includes("（部分图未生成）"), partial);
    assert.equal(f.task.summary.status, "verifying"); assert.equal(published, 1);
    reports.start(f.task, true); await reports.flush(); assert.equal(published, 1, "部分成功也不因重启重复生成");
  } finally { await model.stop(); f.dispose(); }
});

test("报告不阻塞交付，验证结果变化后更新；相同结果及重启不重复生成", async () => {
  const f = fixture();
  try {
    const inputs: any[] = [];
    let published = 0;
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} }, onPublished: () => { published++; } }), async input => {
      inputs.push(JSON.parse(input.context));
      return { body: diagram, status: "completed" };
    });
    summaries.start(f.task);
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    await summaries.flush();
    assert.equal(inputs[0].test_records.pipeline, "pending");
    f.task.summary.delivery.pipeline = "running";
    summaries.start(f.task); await summaries.flush();
    assert.equal(inputs.length, 1);
    f.task.summary.delivery.pipeline = "success";
    f.task.summary.delivery.checks = [{ dimension: "UT", status: "success", job: "unit-tests" }];
    summaries.start(f.task); await summaries.flush();
    assert.equal(inputs.length, 2); assert.equal(published, 2);
    assert.equal(inputs[1].test_records.checks[0].status, "success");
    assert.equal(f.task.summary.status, "verifying");
    const content = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    assert.match(content, new RegExp(f.head)); assert.match(content, /本次验证结果已返回/);
    const sources = { taskMaterialRoot: f.repo };
    assert.ok(listArtifactDocuments(f.repo, sources).some(item => item.name === DELIVERY_SUMMARY_ARTIFACT));
    assert.equal(readArtifact(f.repo, DELIVERY_SUMMARY_ARTIFACT, sources)?.content, content);
    const restarted = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => { throw new Error("不能重复生成"); });
    restarted.start(f.task, true); await restarted.flush();
    assert.equal(readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8"), content);
  } finally { f.dispose(); }
});

test("源码读取报告固定版本，不受主 Agent 后续改动影响", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "service.cpp"), "// subsequent loop\n"); f.git("commit", "-qam", "loop");
    const input = { repo: f.repo, base: f.base, head: f.head } as DeliverySummaryInput;
    const tool = deliverySourceTool(input);
    const current = await tool.execute("call", { action: "read", path: "service.cpp" });
    assert.match(current.content[0].text, /first delivery/); assert.doesNotMatch(current.content[0].text, /subsequent/);
    const before = await tool.execute("call", { action: "read", path: "service.cpp", revision: "base" });
    assert.match(before.content[0].text, /initial/);
    const diff = await tool.execute("call", { action: "diff", path: "service.cpp" });
    assert.match(diff.content[0].text, /first delivery/); assert.doesNotMatch(diff.content[0].text, /subsequent/);
    await assert.rejects(tool.execute("call", { action: "read", path: "../secret" }), /非法/);
  } finally { f.dispose(); }
});

test("失败不改变交付状态，不发布半份文档，也不随 loop 重试", async () => {
  const f = fixture();
  try {
    let runs = 0;
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => { runs++; throw new Error("model unavailable"); });
    summaries.start(f.task); await summaries.flush(); summaries.start(f.task); await summaries.flush();
    assert.equal(runs, 1); assert.equal(f.task.summary.status, "verifying");
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).status, "failed");
  } finally { f.dispose(); }
});

test("shutdown 取消独立子会话，不留下后台发布", async () => {
  const f = fixture();
  try {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async (_input, signal) => {
      started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { body: diagram, status: "completed" };
    });
    summaries.start(f.task); await ready; await summaries.shutdown();
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
    assert.equal(f.task.summary.status, "verifying");
  } finally { f.dispose(); }
});

test("4+1 的图真实渲染，其他章节或代码示例中的图不能代替", async (t) => {
  // PlantUML 改参考实现服务端出图后要真 Java(df128f53);无 JDK 的测试
  // 环境跳过——与容器真件/PG 缺环境自动跳过同款分层纪律。
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return t.skip("宿主无 JDK,真实出图用例跳过(生产宿主应带 JDK)");
  }
  assert.equal(await validateSummaryDiagrams(diagram), undefined);
  assert.equal(await validateSummaryDiagrams(DELIVERY_SUMMARY_MISSION + "\n" + diagram), undefined, "提示词的对照图模板也能真实渲染");
  assert.equal(await validateSummaryDiagrams(diagram.replace("## 改动点 4+1\n", "").replaceAll("###", "##")), undefined, "允许直接排列五个视角，不强制总章节标题");
  assert.match((await validateSummaryDiagrams("no diagram"))!, /缺少/);
  assert.match((await validateSummaryDiagrams(misplacedDiagram))!, /4\+1.*缺少/);
  assert.match((await validateSummaryDiagrams("````markdown\n" + diagram + "\n````"))!, /缺少/);
  assert.equal(await validateSummaryDiagrams("## 改动点 4+1\n~~~PlantUML\n@startuml\nA -> B: 查询\n@enduml\n~~~"), undefined);
  const activity = "## 场景视图（+1）\n```plantuml\n@startuml\nstart\nif (有结果?) then (是)\n:返回结果（修改）; <<#LightBlue>>\nelse (否)\n:返回空结果;\nendif\nstop\n@enduml\n```";
  assert.equal(await validateSummaryDiagrams(activity), undefined);
  assert.match((await validateSummaryDiagrams(activity.replace(":返回结果（修改）; <<#LightBlue>>", "#LightBlue:返回结果（修改）;")))!, /黄色警告/);
  assert.match((await validateSummaryDiagrams("## 改动点 4+1\n```plantuml\n@startuml\nthis is invalid ???\n@enduml\n```"))!, /语法错误/);
});

for (const failed of [false, true]) {
  test(`通知服务通知责任人一次，通知失败=${failed} 不影响摘要或任务`, async () => {
    const f = fixture();
    try {
      f.task.summary.luban_account = "owner";
      const calls: any[] = [];
      const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} }, taskLink: "https://cloud.example/work/task-15",
        notifier: { notifyOutcome: async (input: any) => {
          calls.push(input);
          assert.ok(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), "先发布再通知");
          if (failed) throw new Error("notifier unavailable");
          return {} as any;
        } },
      }), async () => ({ body: diagram, status: "completed" }));
      summaries.start(f.task); await summaries.flush(); summaries.start(f.task); await summaries.flush();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].account, "owner");
      assert.match(calls[0].summary, /Committer/);
      assert.equal(calls[0].link, "https://cloud.example/work/task-15?deliverySummary=1");
      assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).status, "completed");
      assert.equal(f.task.summary.status, "verifying");
    } finally { f.dispose(); }
  });
}


test("真实 Pi 子会话只读固定 diff/源码及执行证据，修正图后发布并通知", async (t) => {
  // 同上:修正图后发布要真渲染 PlantUML,无 JDK 环境整用例跳过。
  if (spawnSync("java", ["-version"], { stdio: "ignore" }).status !== 0) {
    return t.skip("宿主无 JDK,真实出图用例跳过(生产宿主应带 JDK)");
  }
  const f = fixture();
  const model = new ScriptedModelServer([
    { tool: { name: "delivery_source", input: { action: "diff", path: "service.cpp" } } },
    { tool: { name: "delivery_source", input: { action: "read", path: "service.cpp" } } },
    { tool: { name: "delivery_evidence", input: { action: "list" } } },
    { tool: { name: "delivery_evidence", input: { action: "read", id: "design:1" } } },
    { tool: { name: "delivery_evidence", input: { action: "read", id: "design-review:2" } } },
    { text: misplacedDiagram },
    { text: diagram },
  ], "scripted-v1", { linear: true });
  try {
    f.task.summary.ticket = "REQ1";
    mkdirSync(join(f.repo, ".mae-flow-work/REQ1"), { recursive: true });
    writeFileSync(join(f.repo, ".mae-flow-work/REQ1/story.md"), "# Story\nTC-01 函数 UT：空结果返回空数组。\nTC-02 模块 UT（MST）：查询入口遇空记录返回空数组。");
    const taskLog = new EventLog(join(f.repo, "events.jsonl"));
    spawnReviewer(taskLog, "query");
    finishReviewer(taskLog, "query", "检视证据标记：针对 TC-02，模块级空结果行为仍缺运行证据。");
    await model.start();
    let notified = 0;
    f.task.summary.luban_account = "owner";
    const summaries = new DeliverySummaries<any>(() => ({
      model: { choice: { provider: "maeflow", model: "scripted-v1" }, json: model.modelsJson() as Record<string, unknown> },
      notifier: { notifyOutcome: async () => { notified++; return {} as any; } }, taskLink: "https://cloud.example/work/task-15",
    }), runDeliverySummaryAgent);
    summaries.start(f.task); await summaries.flush();
    const state = JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8"));
    assert.equal(state.status, "completed", state.error);
    assert.equal(notified, 1);
    const events = new EventLog(join(f.repo, "delivery-summary/events.jsonl")).replay();
    const finished = events.filter(e => e.kind === "tool_finished");
    assert.equal(finished.length, 5);
    assert.ok(finished.every(e => !e.payload.is_error), JSON.stringify(finished));
    assert.match(JSON.stringify(finished), /first delivery/);
    assert.match(JSON.stringify(finished), /TC-02/);
    assert.match(String(finished.at(-1)?.payload.result), /检视证据标记/);
    assert.doesNotMatch(JSON.stringify(finished), new RegExp(reviewAssignment));
    const published = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    assert.equal(published.match(/设计一致性/g)?.length, 1);
    assert.match(published, /TC-02 待确认/);
    assert.doesNotMatch(published, /检视证据标记|派发过程标记/);
    for (const part of ["测试报告", "模块 UT（MST）", "逻辑视图", "开发视图", "进程视图", "物理视图", "场景视图（+1）"])
      assert.ok(published.includes(part), part);
    const names = (model.requests[0].tools as Array<{ name: string }>).map(tool => tool.name);
    assert.deepEqual(names, ["delivery_source", "delivery_evidence"]);
    assert.match(JSON.stringify(model.requests[0].messages), /设计一致性/);
    assert.match(JSON.stringify(model.requests.at(-1)), /其他章节的图不能代替/);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
  } finally { await model.stop(); f.dispose(); }
});

test("生成期间新提交和最终结果合并处理，旧报告不发布；合入后保留 MR 差异起点", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { started = r; });
  const inputs: DeliverySummaryInput[] = [], published: string[] = [];
  const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} }, onPublished: () => {
    published.push(readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8"));
  } }), async input => { inputs.push(input); if (inputs.length === 1) { started(); await blocked; } return { body: diagram, status: "completed" }; });
  try {
    summaries.start(f.task); await ready;
    writeFileSync(join(f.repo, "service.cpp"), "// fixed\n"); f.git("commit", "-qam", "fix");
    const latest = f.git("rev-parse", "HEAD");
    f.task.summary.delivery.git_push.sha = latest; f.task.summary.delivery.sha = latest;
    summaries.start(f.task);
    f.task.summary.delivery.pipeline = "success";
    summaries.start(f.task);
    release(); await summaries.flush();
    assert.equal(inputs.length, 2); assert.equal(published.length, 1);
    assert.equal(inputs[1].head, latest); assert.match(published[0], new RegExp(latest));
    assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).first_head, f.head);
    f.git("update-ref", "refs/remotes/origin/main", latest);
    f.task.summary.status = "completed"; f.task.summary.delivery.merged_sha = latest;
    summaries.start(f.task); await summaries.flush();
    assert.equal(inputs[2].base, f.base);
    assert.match(published[1], /交付完成/);
  } finally { release?.(); await summaries.shutdown(); f.dispose(); }
});

test("新结果生成失败时保留可读的上份报告，过期验证不能显示为新提交通过", async () => {
  const f = fixture(); let runs = 0;
  try {
    const summaries = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => {
      if (++runs > 1) throw new Error("模型不可用"); return { body: diagram, status: "completed" };
    });
    summaries.start(f.task); await summaries.flush();
    const previous = readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8");
    f.task.summary.delivery.pipeline = "failed";
    summaries.start(f.task); await summaries.flush(); summaries.start(f.task); await summaries.flush();
    assert.equal(runs, 2); assert.equal(readFileSync(join(f.repo, DELIVERY_SUMMARY_FILE), "utf8"), previous);
    f.task.summary.delivery.git_push.sha = "b".repeat(40);
    f.task.summary.delivery.pipeline = "success";
    f.task.summary.delivery.checks = [{ dimension: "UT", status: "success" }];
    const revision = deliveryReportRevision(f.task.summary);
    assert.equal(revision.verification.pipeline, "pending"); assert.equal(revision.verification.checks, undefined);
  } finally { f.dispose(); }
});

test("关停中断的报告重启补跑一次，已取消任务不生成", async () => {
  const f = fixture();
  let ready!: () => void;
  const started = new Promise<void>(r => { ready = r; });
  try {
    const first = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async (_input, signal) => {
      ready(); await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true }));
      signal.throwIfAborted(); return { body: diagram, status: "completed" };
    });
    first.start(f.task); await started; await first.shutdown();
    assert.equal(JSON.parse(readFileSync(join(f.repo, "delivery-summary/state.json"), "utf8")).status, "running");
    let runs = 0;
    const second = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async () => { runs++; return { body: diagram, status: "completed" }; });
    second.start(f.task, true); await second.flush();
    assert.equal(runs, 1); assert.ok(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)));
    f.task.summary.status = "canceled"; f.task.summary.delivery.pipeline = "success";
    second.start(f.task); await second.flush(); assert.equal(runs, 1);
  } finally { f.dispose(); }
});

test("报告证据包含完整设计与真实命令输出，排除自述和上一轮执行，并可分页读取", async () => {
  const f = fixture();
  try {
    f.task.summary.ticket = "REQ1";
    const dir = join(f.repo, ".mae-flow-work/REQ1"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".ticket-id"), "REQ1");
    writeFileSync(join(dir, "spec.md"), "# 规格\n[TC-01] 空结果返回空数组\n" + "设计说明\n".repeat(9000) + "最后一条验收");
    writeFileSync(join(dir, "implementation.md"), "# 实施附录\nMST-01：旧版模块用例，查询失败时保留原记录。");
    writeFileSync(join(dir, "decisions.md"), "# 确认决定\n最新决定：空结果返回空数组。");
    f.task.summary.continuation = { state: "active", at: "2026-10-15T00:00:00Z", text: "补充空结果测试" };
    const log = new EventLog(join(f.repo, "events.jsonl"));
    log.append({ eventId: 1, taskId: "task-15", sessionId: "main", ts: "2026-10-14T00:00:00Z", kind: "tool_finished",
      payload: { call_id: "old", name: "Bash", input: { command: "npm test" }, is_error: false, result: "old result" } });
    log.append({ eventId: 2, taskId: "task-15", sessionId: "main", ts: "2026-10-15T00:01:00Z", kind: "assistant_message", payload: { text: "所有测试通过" } });
    log.append({ eventId: 3, taskId: "task-15", sessionId: "child", ts: "2026-10-15T00:02:00Z", kind: "tool_finished",
      payload: { call_id: "test", name: "Bash", input: { command: "node --test test/query.test.js" }, is_error: false, result: "ok 1 TC-01\n# pass 1\n# fail 0" } });
    const evidence = await collectReportEvidence(f.repo, f.task.summary);
    assert.equal(evidence.records.length, 4);
    const spec = evidence.records.find(row => row.source.endsWith("/spec.md"))!;
    assert.match(spec.content, /最后一条验收/);
    assert.match(evidence.records.find(row => row.source.endsWith("/implementation.md"))!.content, /MST-01/);
    assert.match(evidence.records.find(row => row.source.endsWith("/decisions.md"))!.content, /最新决定/);
    const execution = evidence.records.find(row => row.id.startsWith("execution:"))!;
    assert.match(execution.content, /ok 1 TC-01/); assert.match(execution.content, /未绑定提交版本/);
    assert.doesNotMatch(JSON.stringify(evidence), /old result|所有测试通过/);
    writeFileSync(join(f.repo, "evidence.json"), JSON.stringify(evidence));
    const tool = reportEvidenceTool(f.repo);
    const row = JSON.parse((await tool.execute("read", { action: "read", id: spec.id, offset: 32000 })).content[0].text);
    assert.equal(row.offset, 32000); assert.ok(row.total > 32000);
    await assert.rejects(tool.execute("read", { action: "read", id: "../../secret" }), /未找到/);
  } finally { f.dispose(); }
});

test("设计检视依据只取本轮主会话中配对的有效返回，缺口不冒充结论", async () => {
  const f = fixture();
  try {
    f.task.summary.continuation = { state: "active", at: "2026-10-15T00:00:00Z", text: "调整查询" };
    const log = new EventLog(join(f.repo, "events.jsonl"));
    spawnReviewer(log, "previous", reviewType, "2026-10-14T23:59:59Z");
    finishReviewer(log, "previous", "之前交付的迟到结论");
    spawnReviewer(log, "other", "build-verify-agent");
    finishReviewer(log, "other", "其他类型子任务返回");
    spawnReviewer(log, "wrong-child");
    finishReviewer(log, "wrong-child", "不匹配的子会话返回", "returned", "child-elsewhere");
    spawnReviewer(log, "not-main", reviewType, reviewTime, "other-session");
    finishReviewer(log, "not-main", "另一会话的检视结果", "returned", "child-not-main", "other-session");
    spawnReviewer(log, "timeout");
    finishReviewer(log, "timeout", "失败前的陈旧断言：没有偏离", "failed");
    spawnReviewer(log, "empty");
    finishReviewer(log, "empty", "  ");
    spawnReviewer(log, "pending");
    const prepush = new EventLog(join(f.repo, "prepush/1/events.jsonl"));
    spawnReviewer(prepush, "prepush");
    finishReviewer(prepush, "prepush", "推送前验证的旁路返回");
    const missing = await collectReportEvidence(f.repo, f.task.summary);
    assert.deepEqual(missing.records.filter(row => row.id.startsWith("design-review:")), []);
    assert.ok(missing.limitations.some(row => row.includes("未取得") && row.includes("设计检视")));

    spawnReviewer(log, "current");
    finishReviewer(log, "current", "TC-02 的模块运行行为仍未确认。");
    const current = await collectReportEvidence(f.repo, f.task.summary);
    const reviews = current.records.filter(row => row.id.startsWith("design-review:"));
    assert.deepEqual(reviews.map(row => row.id), [`design-review:${log.lastEventId()}`]);
    assert.equal(reviews[0]!.source, `events.jsonl#${log.lastEventId()}`);
    assert.match(reviews[0]!.content, /TC-02 的模块运行行为仍未确认/);
    assert.match(reviews[0]!.content, /未绑定提交版本/);
    assert.ok(current.limitations.some(row => row.includes("设计检视") && row.includes("有效结论")));
    assert.ok(current.limitations.some(row => row.includes("设计检视") && row.includes("返回")));
    assert.doesNotMatch(JSON.stringify(current.records), /派发过程标记|之前交付|其他类型|不匹配|另一会话|陈旧断言|旁路返回/);
  } finally { f.dispose(); }
});

test("流水线明细只读取本次提交，保留长材料边界，旧版本与链接文件不混入", async () => {
  const f = fixture();
  try {
    const root = join(f.repo, "pipeline");
    scopePipelineArtifacts(root, f.head);
    writeFileSync(join(root, "ut-result.json"), JSON.stringify({ cases: [{ name: "TC-02", result: "passed" }] }));
    writeFileSync(join(root, "long.log"), "x".repeat(1024 * 1024 + 50));
    symlinkSync(join(f.repo, "service.cpp"), join(root, "outside.txt"));
    const current = await collectReportEvidence(f.repo, f.task.summary);
    assert.equal(current.records.filter(row => row.id.startsWith("pipeline:")).length, 2);
    assert.match(current.records.find(row => row.source.endsWith("ut-result.json"))!.content, new RegExp(f.head));
    assert.match(current.records.find(row => row.source.endsWith("ut-result.json"))!.content, /TC-02/);
    assert.ok(current.limitations.some(row => row.includes("long.log") && row.includes("未确认")));
    f.task.summary.delivery.git_push.sha = "b".repeat(40);
    const stale = await collectReportEvidence(f.repo, f.task.summary);
    assert.equal(stale.records.filter(row => row.id.startsWith("pipeline:")).length, 0);
    assert.ok(stale.limitations.some(row => row.includes("不属于本次提交")));
  } finally { f.dispose(); }
});

test("任务服务的交付事实变更自动生成及更新报告", async () => {
  const f = fixture();
  const data = mkdtempSync(join(tmpdir(), "report-service-"));
  const service = new TaskService({ dataDir: data, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  try {
    const summary = service.create("查询", { deferQueue: true });
    const task = (service as any).tasks.get(summary.id);
    task.cwd = f.repo; task.summary.delivery = structuredClone(f.task.summary.delivery); task.summary.status = "verifying";
    const inputs: any[] = [];
    const reports = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async input => { inputs.push(JSON.parse(input.context)); return { body: diagram, status: "completed" }; });
    (service as any).deliverySummaries = reports;
    (service as any).persist(task); await reports.flush();
    task.summary.delivery.pipeline = "success";
    (service as any).persist(task); await reports.flush();
    assert.deepEqual(inputs.map(input => input.test_records.pipeline), ["pending", "success"]);
    assert.ok(existsSync(join(summary.workspace, DELIVERY_SUMMARY_FILE)));
  } finally { await service.shutdown(); f.dispose(); rmSync(data, { recursive: true, force: true }); }
});

for (const taskStatus of ["await_merge", "completed"] as const) test(`绿灯任务 ${taskStatus} 可补报告和失败重试，权限与原始差异不变`, async () => {
  const f = fixture(), data = mkdtempSync(join(tmpdir(), "report-api-"));
  const auth = new LocalAuth(join(data, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("owner", "owner-password", "developer");
  auth.createUser("reviewer", "reviewer-password", "developer");
  const service = new TaskService({ dataDir: data, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const summary = service.create("查询", { account: "owner", collaborators: ["reviewer"], collaboratorsTrusted: true, deferQueue: true });
  const task = (service as any).tasks.get(summary.id);
  task.cwd = f.repo; task.summary.delivery = structuredClone(f.task.summary.delivery); task.summary.status = taskStatus;
  task.summary.delivery.pipeline = "success";
  if (taskStatus === "completed") {
    task.summary.delivery.merged_sha = f.head;
    f.git("update-ref", "refs/remotes/origin/main", f.head);
  }
  writeFileSync(join(f.repo, ".mae-flow.json"), JSON.stringify({ step_heads: { branch_create: f.base } }));
  let runs = 0;
  const reports = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async input => {
    runs++; assert.equal(input.base, f.base);
    if (runs === 2) throw new Error("模型暂不可用");
    return { body: diagram, status: runs === 3 ? "partial" : "completed" };
  });
  (service as any).deliverySummaries = reports;
  const server = createTaskServer(service, { auth });
  try {
    if (taskStatus === "completed") {
      reports.start(task, true); await reports.flush(); assert.equal(runs, 0, "历史完成任务不自动批量补跑");
    }
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
    const url = `${base}/tasks/${summary.id}/delivery-report`;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    const login = async (username: string) => {
      const response = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username, password: `${username}-password` }) });
      assert.equal(response.status, 200);
      return { cookie: response.headers.get("set-cookie")!.split(";")[0] };
    };
    const reviewer = await login("reviewer");
    assert.equal((await fetch(url, { method: "POST", headers: reviewer })).status, 403);
    const owner = await login("owner");
    for (const status of ["completed", "failed", "partial", "completed"]) {
      const response = await fetch(url, { method: "POST", headers: owner });
      assert.equal(response.status, 202);
      assert.equal((await response.json() as any).delivery_report.status, "running");
      await reports.flush();
      const view = service.get(summary.id)!;
      assert.equal(view.delivery_report?.status, status);
      assert.equal(view.delivery_report?.available, true, "失败时已有报告仍可查看");
      if (status === "partial") {
        assert.match(view.delivery_report!.message, /交付报告已更新（部分图未生成）/);
        assert.equal(view.delivery_report!.head, f.head);
        const get = await fetch(`${base}/tasks/${summary.id}`, { headers: owner });
        assert.equal((await get.json() as any).delivery_report.status, "partial");
      }
      assert.equal(view.status, taskStatus);
      assert.equal(view.delivery?.pipeline, "success");
    }
    assert.equal(runs, 4);
    assert.match(readFileSync(join(summary.workspace, DELIVERY_SUMMARY_FILE), "utf8"), taskStatus === "completed" ? /交付完成/ : /本次验证结果已返回/);
    task.summary.workspace_reclaimed_at = new Date().toISOString();
    assert.equal((await fetch(url, { method: "POST", headers: owner })).status, 409);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.shutdown(); f.dispose(); rmSync(data, { recursive: true, force: true });
  }
});

for (const cancel of [false, true]) test(`停止报告（取消任务=${cancel}），即使版本已变化也不重新启动旧任务`, async () => {
  const f = fixture(); let started!: () => void, runs = 0;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const reports = new DeliverySummaries<any>(() => ({ model: { json: {} } }), async (_input, signal) => {
    runs++; started(); await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted(); return { body: diagram, status: "completed" };
  });
  try {
    reports.start(f.task); await ready;
    f.task.summary.delivery.pipeline = "success"; reports.start(f.task);
    if (cancel) { f.task.summary.status = "canceled"; reports.start(f.task); await reports.flush(); }
    else await reports.stopTask(f.task.summary.id);
    assert.equal(reports.isRunning(f.task.summary.id), false); assert.equal(runs, 1);
    assert.equal(existsSync(join(f.repo, DELIVERY_SUMMARY_FILE)), false);
  } finally { await reports.shutdown(); f.dispose(); }
});
