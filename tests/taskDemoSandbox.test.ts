import assert from "node:assert/strict";
import { test } from "node:test";
import { createTaskDemoSandbox, resolveTaskDemoAsset } from "../web/src/taskDemoSandbox";
import type { Annotation, ConversationItem, TaskSummary } from "../web/src/api";
import { suggestedDemoMessage, taskDemoPhaseSteps, type TaskDemoSnapshot } from "../web/src/taskDemoTypes";
import phaseCatalog from "../kernel/flow/phases.json";

function fixture() {
  const task: TaskSummary = {
    id: "source-task", title: "演示需求", requirement: "订单同步", created_at: "2026-10-22T00:00:00Z",
    status: "completed", luban_account: "original-owner", parent_task_id: "source-parent",
    parent_task: { id: "source-parent", status: "running" },
    progress: { phases: ["启动", "澄清需求", "定规格", "写设计", "写代码", "检视与验证", "已合入"], current_index: 6, current_phase: "已合入" },
    delivery: { mr_url: "https://code.example/real/mr/1", mr_state: "merged" },
    requirement_graph: { stage: "confirmed", repositories: [{ id: "r1", name: "repo", url: "https://example.test/repo", task_id: "other-task" }], dependencies: [] },
    workflow_profile: { schema: "mae-flow-execution-profile/2", revision: "1", source: { kind: "task", id: "s" },
      edits: [], diagnostics: [], asset_manifest: [], final_snapshot: { standard_id: "flow", standard_version: "1", catalog_digest: "abc",
        stages: [{ id: "story", title: "设计", phase: "写设计", steps: ["custom_design_confirm"], slots: [], items: [] }] } },
  };
  const annotations: Annotation[] = [{ id: "source-note", author: "original-reviewer", created_at: task.created_at,
    artifact: "story.md", file: "story.md", line: 1, anchor: "订单同步", note: "超时怎么处理？", kind: "doc", status: "draft", route: "owner_reply" }];
  const conversation: ConversationItem[] = [
    { kind: "turn", id: "real-turn", ts: task.created_at, end_ts: task.created_at, texts: [{ text: "已完成实际设计分析。", ts: task.created_at, truncated: false, role: "handoff" }], steps: { calls: 0, errors: 0, reads: 0, edits: 0, bash: 0, agents: 0, sample: [] }, open: false },
    { kind: "card", id: "real-card", ts: task.created_at, waiting_id: "real-wait", step: "custom_design_confirm",
      purpose: "confirmation", annotation_ids: [], questions: [{ question: "是否接受幂等方案？", options: ["接受", "调整"] }], status: "resolved" },
  ];
  const reads: Array<{ url: string; method: string }> = [];
  const sandbox = createTaskDemoSandbox({ task, actor: "admin", annotations, conversation,
    artifacts: [{ name: "story.md", label: "设计文档", kind: "doc", bytes: 40, modified_at: task.created_at }],
    reviews: [{ id: "source-review", task_id: task.id, task_title: "演示需求", requester: "original-owner", committer: "reviewer", created_at: task.created_at, status: "pending", attempts: 1, delivered: true }],
    fetchRead: async (input, init) => { reads.push({ url: String(input), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ content: "# 原始设计", kind: "doc", task_id: task.id, mr_url: "https://example.test/mr/real" }), { headers: { "content-type": "application/json" } }); },
  });
  const request = async (path: string, method = "GET", body?: object) => sandbox.fetch(`/tasks/${sandbox.taskId}${path}`, {
    method, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = async (path: string) => (await request(path)).json() as Promise<any>;
  return { task, annotations, conversation, sandbox, reads, request, data };
}

test("副本深拷贝材料、人物和任务关系，阶段历史问题保留真实来源，切换阶段保留批注", async () => {
  const f = fixture(); const original = structuredClone(f.task); const notes = structuredClone(f.annotations);
  assert.equal(f.sandbox.task.luban_account, "admin");
  assert.equal(f.sandbox.task.parent_task_id, undefined);
  assert.equal(f.sandbox.task.parent_task, undefined);
  assert.equal(f.sandbox.task.requirement_graph?.repositories[0].task_id, undefined);
  assert.equal(f.sandbox.task.delivery?.mr_url, undefined);
  f.task.requirement = "外部修改"; f.annotations[0].note = "外部修改";
  assert.equal(f.sandbox.task.requirement, "订单同步");
  assert.equal((await f.data("/annotations")).items[0].note, notes[0].note);
  const view = f.sandbox.selectPhase("写设计");
  assert.equal(view.waiting?.step, "custom_design_confirm");
  assert.equal(view.waiting?.question?.questions?.[0].question, "是否接受幂等方案？");
  assert.equal(view.waiting?.context, undefined);
  view.requirement = "读取结果被修改";
  assert.equal(f.sandbox.task.requirement, "订单同步");
  const history = await f.data("/conversation");
  assert.ok(history.items.some((row: any) => row.id === "real-turn"));
  await f.request("/annotations", "POST", { artifact: "story.md", file: "story.md", line: 1, anchor: "订单", note: "本地新意见", kind: "doc" });
  f.sandbox.selectPhase("定规格");
  assert.equal(f.sandbox.task.waiting, undefined);
  assert.equal((await f.data("/annotations")).items.length, 2);
  assert.deepEqual({ ...f.task, requirement: original.requirement }, original);
  f.sandbox.reset();
  assert.equal((await f.data("/annotations")).items.length, 1);
  assert.equal(f.sandbox.task.requirement, original.requirement);
  assert.equal(f.reads.length, 0);
});

test("有图与无图都严格沿用原任务七阶段，缺失进度时不伪造阶段", () => {
  const f = fixture(); const original = structuredClone(f.task);
  const phases = phaseCatalog.phases.map(phase => phase.name);
  assert.equal(phases.length, 7);
  assert.deepEqual(f.sandbox.task.progress, original.progress);
  assert.deepEqual(f.sandbox.task.progress?.phases, phases);
  assert.throws(() => f.sandbox.selectPhase("需求拆分"), /不在当前演示/);
  let view = f.sandbox.selectPhase(phaseCatalog.placeholders.analysis);
  assert.equal(view.progress?.current_index, 1);
  assert.equal(view.requirement_graph?.stage, "confirmed");
  view.requirement_graph!.repositories[0].name = "外部改动";
  assert.equal(f.sandbox.task.requirement_graph?.repositories[0].name, "repo");
  view = f.sandbox.selectPhase("写设计");
  assert.equal(view.progress?.current_index, 3);
  assert.equal(view.waiting?.step, "custom_design_confirm");
  f.sandbox.reset();
  assert.deepEqual(f.sandbox.task.progress, original.progress);
  assert.deepEqual(f.task, original);
  assert.deepEqual(f.reads, []);

  for (const withGraph of [true, false]) {
    const plain = structuredClone(original);
    if (!withGraph) delete plain.requirement_graph;
    delete plain.progress;
    const sandbox = createTaskDemoSandbox({ task: plain, actor: "admin", fetchRead: async () => { throw new Error("不应读取网络"); } });
    assert.equal(sandbox.task.progress, undefined);
    assert.throws(() => sandbox.selectPhase(phaseCatalog.placeholders.analysis), /不在当前演示/);
    sandbox.dispose();
  }
  f.sandbox.dispose();
});

test("拆分确认属于澄清需求，定制内核流程合并宿主分析步骤，高亮与提问同源且排除入口确认", () => {
  const f = fixture();
  const original = structuredClone(f.task);
  const phase = phaseCatalog.placeholders.analysis;
  original.workflow_profile!.final_snapshot!.stages.push({ id: "custom-analysis", title: "定制澄清", phase, steps: ["custom_clarify"], slots: [], items: [] });
  const sourceTurn = f.conversation.find(row => row.kind === "turn")!;
  const turn = { ...structuredClone(sourceTurn), id: "split-turn" };
  const card: Extract<ConversationItem, { kind: "card" }> = {
    kind: "card", id: "split-card", ts: original.created_at, waiting_id: "split-waiting",
    step: "requirement_analysis", purpose: "confirmation", annotation_ids: [],
    questions: [{ question: "订单与库存并行，联调等待两边完成？", options: ["确认并生成任务", "调整"] }], status: "resolved",
  };
  const entry = { ...structuredClone(card), id: "entry-card", step: "cloud_requirement_analysis_confirm",
    questions: [{ question: "是否进入需求分析？", options: ["开始分析"] }] };
  const snapshot: TaskDemoSnapshot = { schema: "mae-flow-demo-snapshot/1", captured_at: original.created_at,
    source_task_id: original.id, task: original, artifacts: [], annotations: { items: [] }, problems: [],
    conversation: { items: [...f.conversation, turn, card, { ...structuredClone(sourceTurn), id: "entry-turn" }, entry] },
    phase_steps: { [phase]: ["grill", "requirement_analysis", "cloud_requirement_analysis_confirm"] } };
  assert.deepEqual(taskDemoPhaseSteps(original, phase, snapshot.phase_steps), ["custom_clarify", "requirement_analysis"]);
  const source = { task: original, actor: "admin", phaseSteps: snapshot.phase_steps,
    fetchRead: async () => { throw new Error("不应读取网络"); } };
  const withHistory = createTaskDemoSandbox({ ...source, conversation: snapshot.conversation.items });
  assert.deepEqual(withHistory.selectPhase(phase).waiting?.question?.questions, card.questions);
  assert.equal(suggestedDemoMessage(snapshot, phase), "split-turn");
  assert.equal(withHistory.task.waiting?.context, undefined);
  assert.equal(withHistory.selectPhase("写设计").waiting?.step, "custom_design_confirm");

  const waitingSource = structuredClone(original);
  waitingSource.progress!.current_phase = phase; waitingSource.progress!.current_index = 1;
  waitingSource.waiting = { waiting_id: "split-now", state_version: 1, step: card.step,
    question: { purpose: "confirmation", questions: [{ question: "当前拆分范围是否完整？", options: ["确认并生成任务", "补充"] }] } };
  const before = structuredClone(waitingSource);
  const withWaiting = createTaskDemoSandbox({ ...source, task: waitingSource });
  assert.deepEqual(withWaiting.selectPhase(phase).waiting?.question?.questions, before.waiting?.question?.questions);
  assert.equal(withWaiting.task.requirement_graph?.stage, "confirmed");
  assert.deepEqual(waitingSource, before);

  waitingSource.waiting!.step = entry.step;
  const withEntry = createTaskDemoSandbox({ ...source, task: waitingSource, conversation: [entry] });
  assert.equal(withEntry.selectPhase(phase).waiting, undefined);
  assert.equal(suggestedDemoMessage({ ...snapshot, conversation: { items: [turn, entry] } }, phase), undefined);
  withEntry.dispose(); withWaiting.dispose(); withHistory.dispose(); f.sandbox.dispose();
});

test("admin 以责任人完整体验批注的编辑、答复、闭环、重新处理、转交和删除，无写网络", async () => {
  const f = fixture(); f.sandbox.selectPhase("写设计");
  const initial = await f.data("/annotations"); const annotationId = initial.items[0].id;
  assert.equal(annotationId, "source-note");
  assert.equal(initial.closures[0].can_edit, true);
  assert.equal(initial.closures[0].can_route, true);
  await f.request(`/annotations/${annotationId}`, "PATCH", { note: "补充超时处理规则" });
  await f.request(`/annotations/${annotationId}/reply`, "POST", { text: "保留原数据，允许重试" });
  let view = await f.data("/annotations");
  assert.equal(view.items[0].owner_reply.author, "admin");
  assert.equal(view.closures[0].can_resolve, true);
  await f.request(`/annotations/${annotationId}/resolve`, "POST", { outcome: "fixed", revision: 1 });
  assert.equal((await f.data("/annotations")).items[0].status, "verified");
  await f.request(`/annotations/${annotationId}/reopen`, "POST");
  view = await f.data("/annotations");
  assert.equal(view.items[0].status, "draft"); assert.equal(view.items[0].resolution, undefined);
  const receipt = await (await f.request("/annotations/send", "POST", { ids: [annotationId] })).json() as any;
  assert.match(receipt.receipt, /演示反馈/);
  view = await f.data("/annotations");
  assert.match(view.items[0].response.summary, /没有执行真实 Agent/);
  assert.equal(view.closures[0].can_verify, true);
  await f.request(`/annotations/${annotationId}/verify`, "POST");
  await f.request(`/annotations/${annotationId}/reopen`, "POST");
  await f.request(`/annotations/${annotationId}`, "DELETE");
  assert.equal((await f.data("/annotations")).items.length, 0);
  assert.equal(f.annotations[0].status, "draft"); assert.equal(f.annotations[0].note, "超时怎么处理？");
  assert.deepEqual(f.reads, []);
});

test("决定、插话、邀请和完成检视只影响演示状态，来源 review id 无权操作", async () => {
  const f = fixture(); f.sandbox.selectPhase("写设计");
  const waiting = f.sandbox.task.waiting!;
  const stale = await f.request("/decision", "POST", { waiting_id: "real-wait", state_version: waiting.state_version });
  assert.equal(stale.status, 409);
  const response = await f.request("/decision", "POST", { waiting_id: waiting.waiting_id, state_version: waiting.state_version,
    selected_options: { "现状": "采用建议" }, free_responses: {}, comment: "明确边界" });
  assert.equal(response.status, 200); assert.equal(f.sandbox.task.waiting, undefined);
  await f.request("/interrupt", "POST", { text: "补充验收" });
  const history = (await f.data("/conversation")).items;
  assert.ok(history.some((row: any) => row.kind === "decision" && row.by === "admin"));
  assert.ok(history.some((row: any) => row.kind === "steer" && row.delivered === false));
  const review = await (await f.request("/review-request", "POST", { committer: "another-person" })).json() as any;
  assert.equal(review.delivered, false);
  assert.equal((await f.sandbox.fetch(`/reviews/source-review/complete`, { method: "POST" })).status, 404);
  const completed = await (await f.sandbox.fetch(`/reviews/${review.id}/complete`, { method: "POST" })).json() as any;
  assert.equal(completed.status, "completed");
  assert.deepEqual(f.reads, []);
});

test("任务写入含未知操作和真实任务路径永不走 fetchRead", async () => {
  const f = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE"]) {
    for (const path of ["/unknown", "/artifacts/story.md", "/events", "/demo-snapshot"]) {
      const result = await f.request(path, method, {});
      assert.equal(result.status, 501, `${method} ${path}`);
    }
    for (const path of ["/tasks/source-task/decision", "/tasks/other-task/pause", "/auth/me", "/settings", "/tasks"]) {
      const result = await f.sandbox.fetch(path, { method, body: "{}" });
      assert.equal(result.status, 403, `${method} ${path}`);
    }
  }
  const request = new Request(`http://demo.local/tasks/${f.sandbox.taskId}/unknown`, { method: "PATCH", body: "{}" });
  assert.equal((await f.sandbox.fetch(request)).status, 501);
  assert.equal((await f.sandbox.fetch("https://external.example/tasks/source-task/artifacts/story.md")).status, 403);
  assert.deepEqual(f.reads, []);
});

test("只有白名单资料读取映射到原任务，响应去除真实可写导航，未知读取不外发", async () => {
  const f = fixture();
  const doc = await f.data("/artifacts/story.md");
  assert.equal(doc.content, "# 原始设计"); assert.equal(doc.task_id, f.sandbox.taskId); assert.equal(doc.mr_url, undefined);
  assert.deepEqual(f.reads, [{ url: "/tasks/source-task/artifacts/story.md", method: "GET" }]);
  await f.sandbox.fetch("/auth/people"); await f.sandbox.fetch("/auth/committers");
  assert.equal(f.reads.length, 3);
  for (const path of ["/tasks/source-task/artifacts/story.md", "/tasks/other-task/artifacts/story.md", "/settings", "/auth/users", "/auth/people?secret=yes"]) {
    assert.equal((await f.sandbox.fetch(path)).status, 403);
  }
  assert.equal((await f.request("/events")).status, 501);
  assert.equal(f.reads.length, 3);
});

test("控制、Skill、报告和助手提供明确演示反馈；退出释放内存并停止读取", async () => {
  const f = fixture(); let updates = 0; f.sandbox.subscribe(() => { updates++; });
  f.sandbox.selectPhase("写设计");
  await f.request("/pause", "POST"); assert.equal(f.sandbox.task.status, "paused");
  await f.request("/resume", "POST"); assert.equal(f.sandbox.task.status, "waiting_for_human");
  const sync = await (await f.request("/skills/sync", "POST")).json() as any;
  assert.match(sync.receipt, /演示反馈/);
  await f.request("/delivery-report", "POST");
  const report = await f.data(`/artifacts/${encodeURIComponent("task-materials/交付报告.md")}`);
  assert.match(report.content, /不是实际代码、测试或交付证明/);
  await f.request("/developer-assistant", "POST", { text: "查看实现" });
  assert.equal(f.sandbox.task.assistant_engaged, true);
  const assistant = await f.data("/developer-assistant"); assert.match(assistant.messages[1].text, /演示反馈/);
  await f.request("/developer-assistant/return", "POST"); assert.equal(f.sandbox.task.assistant_engaged, false);
  assert.ok(updates >= 6); assert.deepEqual(f.reads, []);
  f.sandbox.dispose();
  assert.equal((await f.request("/annotations")).status, 410);
  assert.equal((await f.request("/artifacts/story.md")).status, 410);
  assert.throws(() => f.sandbox.reset(), /演示已退出/);
  assert.throws(() => f.sandbox.selectPhase("写设计"), /演示已退出/);
  assert.deepEqual(f.reads, []);
});

test("退出演示会取消仍在进行的只读请求", async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const f = fixture(); let aborted = false;
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", fetchRead: async (_input, init) => {
    started();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => {
      aborted = true; reject(new Error("aborted"));
    }));
  } });
  const pending = sandbox.fetch(`/tasks/${sandbox.taskId}/artifacts/story.md`);
  await ready; sandbox.dispose(); await assert.rejects(pending, /aborted/); assert.equal(aborted, true);
});

test("有副作用的 GET 只读演示状态，资料纯读使用缓存且保留真实 diff 目录", async () => {
  const f = fixture();
  for (const path of ["/diff-review", "/push-review-diff?scope=changes", "/overall-story", "/knowledge-source?resource=knowledge-1", "/memories", "/memories/usage", "/timeline", "/actions"]) {
    const response = await f.request(path); assert.equal(response.status, 200, path);
  }
  assert.deepEqual(f.reads, []);
  await f.data("/artifacts/story.md"); await f.data("/artifacts/story.md");
  f.sandbox.reset(); await f.data("/artifacts/story.md");
  assert.equal(f.reads.length, 1, "重置操作不重新读取原资料");
  let reads = 0;
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", artifacts: [{ name: "story.md", label: "设计", kind: "doc", bytes: 1, modified_at: f.task.created_at }],
    fetchRead: async () => { reads++; return new Response(JSON.stringify([{ name: "__workspace_diff__", label: "代码变更", kind: "diff", bytes: 8, modified_at: f.task.created_at }]), { headers: { "content-type": "application/json" } }); } });
  const lists = await Promise.all(["doc", "diff"].map(async kind => (await sandbox.fetch(`/tasks/${sandbox.taskId}/artifacts?kind=${kind}`)).json() as Promise<any[]>));
  assert.equal(reads, 1); assert.equal(lists[0][0].name, "story.md"); assert.equal(lists[1][0].name, "__workspace_diff__");
});

test("知识飞轮可编辑、采纳、停用、保存历史和撤回，真实记录与索引不变", async () => {
  const f = fixture();
  const entry = (await f.data("/memories"))[0]; assert.equal(entry.can_review, true); assert.match(entry.trigger, /演示示例/);
  const review = async (body: object) => (await f.sandbox.fetch(`/memory-insights/${entry.id}/review`, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;
  let result = await review({ revision: 1, decision: "accepted", trigger: "可重试接口", conclusion: "先核对幂等约束", scope: "general" });
  assert.equal(result.review.status, "accepted"); assert.equal(result.review.by, "admin"); assert.equal(result.revision, 2);
  assert.match(result.maintenance_note, /未写入真实知识库/);
  result = await review({ revision: 2, decision: "rejected", note: "适用条件不充分" }); assert.equal(result.review.status, "rejected");
  result = await review({ revision: 3, decision: "pending" }); assert.equal(result.review.status, "pending");
  const history = await (await f.sandbox.fetch(`/memory-insights/${entry.id}/history`)).json() as any[];
  assert.equal(history.length, 4); assert.equal(history[1].review.status, "accepted");
  await f.request(`/memories/${entry.id}/withdraw`, "POST");
  assert.equal((await f.data(`/memories/${entry.id}`)).record.withdrawn, true);
  for (const path of ["/business-modules", "/product-versions", "/memory-insights", `/memory-insights/${entry.id}`]) assert.equal((await f.sandbox.fetch(path)).status, 200);
  const created = await (await f.sandbox.fetch("/memory-insights", { method: "POST", body: JSON.stringify({ trigger: "新经验", conclusion: "保留适用例外" }) })).json() as any;
  assert.equal(created.task, f.sandbox.taskId); assert.equal(created.review.status, "pending");
  assert.deepEqual(f.reads, []);
  f.sandbox.reset(); assert.equal((await f.data("/memories")).length, 1);
});

test("Story、架构图、BuildFix和模块调整均保留明确演示说明", async () => {
  const f = fixture();
  let story = await (await f.request("/overall-story", "POST")).json() as any;
  assert.match(story.label, /演示副本/); assert.equal(story.revisions.length, 1);
  await f.request("/overall-story/confirm", "POST", { revision: story.current });
  story = await f.data("/overall-story"); assert.equal(story.confirmed.by, "admin");
  await f.request("/overall-story/architecture", "POST");
  assert.match((await f.data("/overall-story")).label, /演示副本/);
  await f.request("/overall-story/stop", "POST");
  await f.request("/build-fix/retry", "POST"); assert.equal(f.sandbox.task.delivery?.prepush?.state, "compiling");
  await f.request("/build-fix/stop", "POST"); assert.equal(f.sandbox.task.delivery?.prepush_runtime?.state, "stopped");
  await f.request("/build-fix/skip", "POST"); assert.match(f.sandbox.task.delivery?.prepush?.message ?? "", /没有推送代码/);
  const modules = await (await f.sandbox.fetch("/business-modules")).json() as any;
  await f.request("/business-module", "PUT", { module_id: modules.modules[1].id });
  assert.equal(f.sandbox.task.business_module?.id, modules.modules[1].id); assert.equal(f.sandbox.task.business_module_history?.length, 1);
  assert.deepEqual(f.reads, []);
});

test("真实架构只读源任务并保留 revision，未知路径和写请求不能外传", async () => {
  const f = fixture(); const reads: Array<{ url: string; method: string }> = [];
  const projection = { revision: "source-revision-9", renderer: "archify", diagrams: [{ id: "orders.v1", title: "订单库存关系", type: "architecture", view: "logical" }] };
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", fetchRead: async (input, init) => {
    reads.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json(String(input).includes("/architecture/orders.v1")
      ? { revision: projection.revision, html: "<html><body>真实来源架构</body></html>" } : projection);
  } });
  const path = `/tasks/${sandbox.taskId}/architecture`;
  assert.deepEqual(await (await sandbox.fetch(path)).json(), projection);
  const rendered = await (await sandbox.fetch(`${path}/orders.v1?revision=source-revision-9`)).json() as any;
  assert.equal(rendered.revision, projection.revision); assert.match(rendered.html, /真实来源架构/);
  assert.deepEqual(reads, [
    { url: "/tasks/source-task/architecture", method: "GET" },
    { url: "/tasks/source-task/architecture/orders.v1?revision=source-revision-9", method: "GET" },
  ]);
  assert.equal((await sandbox.fetch(`${path}/nested/unknown`)).status, 501);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal((await sandbox.fetch(path, { method, body: "{}" })).status, 501);
    assert.equal((await sandbox.fetch(`${path}/orders.v1`, { method, body: "{}" })).status, 501);
    assert.equal((await sandbox.fetch("/tasks/source-task/architecture", { method, body: "{}" })).status, 403);
  }
  assert.equal(reads.length, 2); sandbox.dispose(); f.sandbox.dispose();
});

test("DEV 架构样例只从内存读取，更新只更换副本版本", async () => {
  const f = fixture(); let reads = 0;
  const architecture = { projection: { renderer: "demo", warnings: ["虚构示例"],
    diagrams: [{ id: "demo-overview" as const, title: "订单与库存示例", type: "architecture", view: "logical" as const }] },
    diagram: { html: "<html><body>订单 → 事件 → 库存（示例）</body></html>" } };
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", architecture,
    fetchRead: async () => { reads++; throw new Error("不应访问网络"); } });
  architecture.diagram.html = "外部修改";
  const get = async (path: string) => (await sandbox.fetch(`/tasks/${sandbox.taskId}${path}`)).json() as Promise<any>;
  const before = await get("/architecture");
  assert.equal(before.diagrams[0].title, "订单与库存示例");
  assert.match((await get("/architecture/demo-overview")).html, /订单 → 事件 → 库存/);
  await sandbox.fetch(`/tasks/${sandbox.taskId}/overall-story/architecture`, { method: "POST", body: "{}" });
  const after = await get("/architecture");
  assert.notEqual(after.revision, before.revision);
  assert.equal((await get("/architecture/demo-overview")).revision, after.revision);
  assert.equal((await sandbox.fetch("/diagrams/plantuml", { method: "POST", body: "{}" })).status, 400);
  assert.equal(reads, 0); sandbox.dispose(); f.sandbox.dispose();
});

test("提前开始只调整演示依赖；真实任务 ID 不进入副本导航", async () => {
  const f = fixture(); f.task.blocked_by = ["real-dependency-a", "real-dependency-b"]; f.task.status = "queued";
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", fetchRead: async () => { throw Error("不得读取真实任务"); } });
  const task = sandbox.task; assert.ok(task.blocked_by?.every(id => id.startsWith(sandbox.taskId)));
  const request = (path: string, body: object) => sandbox.fetch(`/tasks/${sandbox.taskId}${path}`, { method: "POST", body: JSON.stringify(body) });
  const preview = await (await request("/early-start/preview", { release_ids: [task.blocked_by![0]], ticket: "DEMO-2" })).json() as any;
  assert.equal(preview.remaining.length, 1); assert.equal(preview.owner, "admin");
  await request("/early-start", { release_ids: preview.release_ids, ticket: preview.ticket, revision: preview.revision });
  assert.equal(sandbox.task.blocked_by?.length, 1); assert.equal(sandbox.task.ticket, "DEMO-2");
  assert.deepEqual(f.task.blocked_by, ["real-dependency-a", "real-dependency-b"]);
});

test("演示附图解析为本地 blob，重置释放图片，来源附图不请求真实接口", async () => {
  const f = fixture();
  assert.equal(resolveTaskDemoAsset("ordinary-task", "anything"), undefined);
  const image = await (await f.request("/annotation-assets", "POST", { content_base64: "iVBORw0KGgo=" })).json() as any;
  const url = resolveTaskDemoAsset(f.sandbox.taskId, image.path)!; assert.match(url, /^blob:/);
  assert.equal(f.sandbox.resolveAsset(image.path), url);
  assert.match(resolveTaskDemoAsset(f.sandbox.taskId, "original.png") ?? "", /^data:image\/svg\+xml/);
  f.sandbox.reset(); assert.equal(f.sandbox.resolveAsset(image.path), undefined);
  await assert.rejects(fetch(url));
  f.sandbox.dispose(); assert.equal(resolveTaskDemoAsset(f.sandbox.taskId, image.path), undefined);
  assert.deepEqual(f.reads, []);
});


test("演示 PlantUML 使用正常出图接口，仅传图源，任务及其他接口仍隔离", async () => {
  const f = fixture(); const before = structuredClone(f.task);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const rendered = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">原任务图</text></svg>' };
  const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", fetchRead: async (url, init) => {
    requests.push({ url: String(url), init }); return Response.json(rendered);
  } });
  const source = "@startuml\n用户 -> 平台: 查看需求\n@enduml";
  const body = JSON.stringify({ source, task_id: f.task.id, action: "resume" });
  assert.deepEqual(await (await sandbox.fetch("/diagrams/plantuml", { method: "POST", body })).json(), rendered);
  assert.equal(requests[0].url, "/diagrams/plantuml");
  assert.equal(requests[0].init?.method, "POST");
  assert.equal(requests[0].init?.redirect, "error");
  assert.equal(new Headers(requests[0].init?.headers).get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { source });
  const request = new Request("http://demo.local/diagrams/plantuml", { method: "POST", body });
  assert.deepEqual(await (await sandbox.fetch(request)).json(), rendered);
  for (const path of ["/diagrams/plantuml?task=source-task", "/diagrams/plantuml/other", "/tasks/source-task/resume", "https://external.example/diagrams/plantuml"]) {
    assert.equal((await sandbox.fetch(path, { method: "POST", body })).status, 403, path);
  }
  for (const method of ["GET", "PUT", "DELETE"]) {
    assert.equal((await sandbox.fetch("/diagrams/plantuml", { method, ...(method === "GET" ? {} : { body }) })).status, 403);
  }
  for (const invalid of [{}, { source: 123 }, { source: " " }]) {
    assert.equal((await sandbox.fetch("/diagrams/plantuml", { method: "POST", body: JSON.stringify(invalid) })).status, 400);
  }
  assert.equal(requests.length, 2); assert.deepEqual(f.task, before);
  sandbox.dispose();
  assert.equal((await sandbox.fetch("/diagrams/plantuml", { method: "POST", body })).status, 410);
  assert.equal(requests.length, 2); f.sandbox.dispose();
});

test("退出演示或取消请求会取消尚未完成的 PlantUML 出图请求", async () => {
  const f = fixture();
  for (const mode of ["dispose", "signal", "request-signal"] as const) {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const sandbox = createTaskDemoSandbox({ task: f.task, actor: "admin", fetchRead: async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    } });
    const controller = new AbortController();
    const init = { method: "POST", body: JSON.stringify({ source: "Alice -> Bob: hello" }), signal: controller.signal };
    const pending = mode === "request-signal"
      ? sandbox.fetch(new Request("http://demo.local/diagrams/plantuml", init))
      : sandbox.fetch("/diagrams/plantuml", init);
    await ready;
    if (mode === "dispose") sandbox.dispose(); else controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    sandbox.dispose();
  }
  f.sandbox.dispose();
});
