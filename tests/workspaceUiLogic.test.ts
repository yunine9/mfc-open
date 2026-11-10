import assert from "node:assert/strict";
import {
  annotationClosure,
  annotationClosures,
  annotationOverrideAccess,
  annotationVerdictReady,
} from "../src/feedbackPolicy.ts";
import type { Annotation } from "../src/annotations.ts";
import { after, test } from "node:test";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";

// Vite 的 SSR loader 负责消费前端的 TSX/CSS import；这样验证的是实际导出
// 的运行逻辑，而不是对源码做字符串匹配。本仓刻意不为前端测试引入 jsdom。
const vite = await createServer({
  root: "web",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const app = await vite.ssrLoadModule("/src/App.tsx");
const people = await vite.ssrLoadModule("/src/People.tsx");
const workspace = await vite.ssrLoadModule("/src/TaskWorkspace.tsx");
const taskCard = await vite.ssrLoadModule("/src/TaskCard.tsx");
const deliveryList = await vite.ssrLoadModule("/src/DeliveryFileList.tsx");
const prepush = await vite.ssrLoadModule("/src/PrepushStatus.tsx");
const api = await vite.ssrLoadModule("/src/api.ts");
const annotationPanel = await vite.ssrLoadModule("/src/AnnotationPanel.tsx");
const lubanTokenCard = await vite.ssrLoadModule("/src/LubanTokenCard.tsx");
const gitDiff = await vite.ssrLoadModule("/src/GitDiff.tsx");
const warmup = await vite.ssrLoadModule("/src/WarmupPanel.tsx");
const repositoryPicker = await vite.ssrLoadModule("/src/RepositoryAssigneePicker.tsx");

// 闭环判定已经收敛到服务端唯一处;页面只渲染结论。测试因此也走同一条
// 路:用 feedbackPolicy 算好 closures 再喂给面板——两半对不上就红。
const Panel = (props: Record<string, unknown>) => React.createElement(
  annotationPanel.AnnotationPanel, { ...props, closures: closuresFor(props) });

function closuresFor(props: Record<string, unknown>) {
  const items = (props.items ?? []) as Annotation[];
  const checks = (props.checks ?? []) as Array<{ id: string; state: string }>;
  const people = (props.people ?? []) as Array<
    { username: string; display_name?: string }>;
  return annotationClosures(items, {
    task_status: String(props.taskStatus ?? "running"),
    owner_controlled: Boolean(props.ownerControlled),
    task_owner: String(props.taskOwner ?? "本地用户"),
    review_ready: Boolean(props.reviewReady),
    review_annotation_ids: (props.reviewAnnotationIds ?? []) as string[],
    archival: props.taskStatus === "completed",
  }, {
    username: String(props.viewerUsername ?? ""),
    can_override: Boolean(props.canOverride),
    can_route_others: Boolean(props.canRouteOthers),
  }, {
    anchor_gone_ids: checks.filter((one) => one.state === "gone")
      .map((one) => one.id),
    person_name: (username) => people.find((one) => one.username === username)
      ?.display_name?.trim() || username,
  });
}

const verdictReady = (
  item: unknown, status: string, reviewReady: boolean,
) =>
  annotationVerdictReady(item as Annotation, {
    task_status: status, review_ready: reviewReady,
    review_annotation_ids: [], archival: false,
  });

after(async () => {
  await vite.close();
});

function task(id: string, status = "running", owner = "alice") {
  return {
    id,
    requirement: `任务 ${id}`,
    status,
    created_at: "2026-08-30T00:00:00.000Z",
    luban_account: owner,
  };
}

test("单仓单元的 AR 已有值、清空、输入首字符后始终可编辑", () => {
  for (const ticket of ["REQ-UI-301", "", "R", "REQ-NEW-302"]) {
    const html = renderToStaticMarkup(React.createElement(repositoryPicker.RepositoryAssigneePicker, {
      taskId: "editable-ar", repositories: [{ id: "a", name: "前端", url: "https://example.test/ui.git", ticket: "REQ-UI-301" }],
      selection: { assignments: { a: "alice" }, tickets: { a: ticket }, ready: true, loading: false }, onSelectionChange() {},
    }));
    assert.match(html, /<input[^>]*aria-label="前端的 AR 单号"/);
    assert.ok(html.includes(`value="${ticket}"`));
    assert.doesNotMatch(html, /repository-ticket-readonly|readonly=/i);
    if (!ticket) assert.match(html, /缺少 AR 单号/);
  }
});

test("AR 保持可编辑时允许串行单元共用单号，仍校验空白", () => {
  const render = (tickets: Record<string, string>) => renderToStaticMarkup(React.createElement(repositoryPicker.RepositoryAssigneePicker, {
    taskId: "duplicate-ar", repositories: [
      { id: "a", name: "模块一", url: "https://example.test/ui.git" },
      { id: "b", name: "模块二", url: "https://example.test/ui.git" },
    ], selection: { assignments: { a: "alice", b: "alice" }, tickets, ready: false, loading: false }, onSelectionChange() {},
  }));
  assert.doesNotMatch(render({ a: "REQ-SAME", b: "REQ-SAME" }), /单号.*重复/);
  assert.match(render({ a: "REQ BAD", b: "REQ-OK" }), /AR 单号无效/);
  assert.doesNotMatch(render({ a: "REQ-ONE", b: "REQ-TWO" }), /单号.*重复|AR 单号无效|缺少 AR 单号/);
});

test("开工前编译准备常驻显示，缺记录及已回收不声称就绪", () => {
  const render = (extra = {}) => renderToStaticMarkup(React.createElement(warmup.WarmupBadge, {
    task: { ...task("readiness"), ...extra }, onOpen() {},
  }));
  const receipt = { sha: "abc123", started_at: "2026-09-05T00:00:00Z" };
  for (const [status, label] of [["running", "准备中"], ["passed", "已就绪"], ["failed", "失败"], ["infrastructure_failure", "准备中断"]]) {
    const html = render({ baseline_build: { ...receipt, status } });
    assert.match(html, /aria-haspopup="dialog"/);
    // #216 收编 Badge 后 <b> 带字重类,锚在标签收口上。
    assert.ok(html.includes(`>${label}</b>`));
  }
  const missing = render();
  assert.match(missing, />暂无记录<\/b>/);
  assert.doesNotMatch(missing, /is-passed|>已就绪<\/b>/);
  const reclaimed = render({ baseline_build: { ...receipt, status: "passed" }, workspace_reclaimed_at: "2026-09-05T01:00:00Z" });
  assert.match(reclaimed, />现场已回收<\/b>/);
  assert.doesNotMatch(reclaimed, /is-passed|>已就绪<\/b>/);
});

function review(id: string, taskId: string) {
  return {
    id,
    task_id: taskId,
    task_title: `检视 ${taskId}`,
    requester: "alice",
    committer: "bob",
    status: "pending",
    created_at: "2026-08-30T00:00:00.000Z",
    delivered: true,
    attempts: 1,
  };
}

test("个人小鲁班已配置时显示连通测试，未配置时只引导配置", () => {
  const ready = renderToStaticMarkup(React.createElement(
    lubanTokenCard.LubanTokenCard,
    { session: {
      username: "alice", role: "developer", luban_token_hint: "••••cret",
    } },
  ));
  assert.match(ready, />测试连通性<\/button>/);
  assert.match(ready, />更新 Token<\/button>/);

  const missing = renderToStaticMarkup(React.createElement(
    lubanTokenCard.LubanTokenCard,
    { session: { username: "bob", role: "developer" } },
  ));
  assert.doesNotMatch(missing, /测试连通性/);
  assert.match(missing, />配置小鲁班<\/button>/);
});

function annotation(overrides: Record<string, unknown> = {}) {
  return {
    id: "annotation-1",
    author: "alice",
    created_at: "2026-08-30T00:00:00.000Z",
    artifact: "diff",
    file: "src/example.ts",
    line: 12,
    anchor: "return result;",
    note: "请补测试",
    kind: "code",
    status: "sent",
    response: {
      revision: 0,
      outcome: "fixed",
      summary: "已补测试",
      evidence: ["tests/example.test.ts"],
      responded_at: "2026-08-30T00:01:00.000Z",
    },
    ...overrides,
  };
}

test("状态短文案与'需介入'只镜像服务端投影,前端不再按 loop/prepush 自己判", () => {
  // 推断表在 tests/statusLabel.test.ts(src/taskFocus.ts);这里只钉住
  // 镜像语义:有 status_label 就显示它,没有(只知道状态码的子任务行)退回词表。
  assert.equal(api.statusText({ status: "running", status_label: "正在按检视意见修改" }),
    "正在按检视意见修改");
  assert.equal(api.statusText({ status: "verifying" }), "代码已提交,流水线验证中");
  assert.equal(api.statusText({ status: "verifying", status_label: "Build-Fix 恢复中" }),
    "Build-Fix 恢复中");
  assert.equal(api.repairStopped({ repair_stopped: true }), true);
  assert.equal(api.repairStopped({ repair_stopped: false }), false);
  assert.equal(api.repairStopped({}), false, "旧后端缺席时不亮'需介入'");
});

test("圈注权与发送权拆开，需求原文批注能回到原文视图", () => {
  assert.equal(workspace.canCreateWorkspaceAnnotation("completed"), true,
    "已交付任务仍可留下交付后记录");
  assert.equal(workspace.canCreateWorkspaceAnnotation("canceled"), false,
    "用户明确停止的任务不再新增记录");
  assert.equal(workspace.materialViewForAnnotation(
    api.TASK_REQUIREMENT_ARTIFACT, []), "source");
  assert.equal(workspace.materialViewForAnnotation("__requirement_graph__", []), "chain");
  assert.equal(workspace.materialViewForAnnotation("__workspace_diff__", []), "diff",
    "工作区代码批注的虚拟标识不能被当作文档名");
  assert.equal(workspace.materialViewForAnnotation("changes.diff", [
    { name: "changes.diff", label: "代码差异", kind: "diff", bytes: 1 },
  ]), "diff");
  assert.deepEqual(workspace.decisionAnnotationIds([
    annotation({ id: "mine", status: "draft", author: "alice" }),
    annotation({ id: "visitor", status: "draft", author: "visitor" }),
    annotation({ id: "sent", status: "sent", author: "alice" }),
  ], "alice"), ["mine"],
  "决定只能携带当前操作者自己的未送达草稿");
});

test("材料搜索只匹配当前正文行，兼容中文和英文大小写", () => {
  const rows = [
    { textContent: "配置确认：启用自动修复" },
    { textContent: "const BuildResult = await compile();" },
    { textContent: null },
    { textContent: "自动修复完成" },
  ];
  assert.deepEqual(workspace.matchingMaterialRowIndexes(rows, "自动修复"),
    [0, 3]);
  assert.deepEqual(workspace.matchingMaterialRowIndexes(rows, "buildresult"),
    [1]);
  assert.deepEqual(workspace.matchingMaterialRowIndexes(rows, "  "), []);
});

test("流水线证据缺口直接打开补证材料，用户切走后不被轮询抢回", () => {
  const gap = {
    name: "pipeline/流水线证据缺口.md",
    label: "流水线证据缺口.md",
    kind: "doc",
    purpose: "pipeline_evidence_gap",
    bytes: 120,
    modified_at: "2026-08-30T00:00:00.000Z",
  };
  const spec = {
    name: "REQ1/spec.md", label: "spec.md", kind: "doc", bytes: 100,
    modified_at: "2026-08-30T00:01:00.000Z",
  };
  const evidenceTask = {
    ...task("gap", "verifying"),
    delivery: { evidence_gap: {
      sha: "a".repeat(40), state: "waiting_human",
      missing_dimensions: ["COMPILE"], available_dimensions: [],
      reasons: ["日志缺失"], attempts: 3,
    } },
  };
  assert.equal(workspace.pipelineEvidenceNeedsHuman(evidenceTask), true);
  assert.equal(workspace.defaultWorkspaceView(evidenceTask), "focus",
    "补证先在当前视图呈现行动与关键证据，不能用自动跳页替代信息层级");
  assert.equal(workspace.preferredWorkspaceArtifact(
    [spec, gap], "", undefined, true), gap.name,
  "点名的补证材料优先于最近修改排序");
  assert.equal(workspace.preferredWorkspaceArtifact(
    [spec, gap], spec.name, undefined, true), spec.name,
  "用户主动切换后的有效选择不能被后台刷新抢走");
  assert.equal(workspace.pipelineEvidenceNeedsHuman({
    ...evidenceTask,
    delivery: { evidence_gap: {
      ...evidenceTask.delivery.evidence_gap, state: "retrying",
    } },
  }), false, "系统仍在自动重试时不冒充人工待办");
});

test("拆分子任务默认先打开自己的任务书，整体方案与原始需求只作参考", () => {
  const plan = {
    name: "task-materials/chain-plan.md", label: "整体拆分方案",
    kind: "doc", purpose: "delivery_plan", bytes: 200,
    modified_at: "2026-09-04T00:01:00.000Z",
  };
  const brief = {
    name: "task-materials/unit-brief.md", label: "当前单元任务书",
    kind: "doc", purpose: "delivery_unit_brief", bytes: 100,
    modified_at: "2026-09-04T00:00:00.000Z",
  };
  assert.equal(workspace.preferredWorkspaceArtifact(
    [plan, brief], "", "doc", false), brief.name,
  "即使整体方案更新得更晚，也不能盖过当前子任务的主任务书");
});

test("已交付批注明确是归档记录，不再冒充待提交", () => {
  const html = renderToStaticMarkup(React.createElement(
    Panel,
    {
      taskId: "task-done",
      viewerUsername: "visitor",
      items: [annotation({
        status: "draft", author: "visitor",
        artifact: api.TASK_REQUIREMENT_ARTIFACT,
        file: "需求原文",
      })],
      checks: [],
      canOperate: false,
      taskStatus: "completed",
      mergeRequestOpen: false,
      onChanged: () => undefined,
    },
  ));
  assert.match(html, /交付后记录/);
  assert.match(html, /已保存在本任务档案中/);
  assert.doesNotMatch(html, /条待提交/);
  assert.doesNotMatch(html, />提交 1 条/);
});

test("批注卡显示当前完整范围，原文消失后明确标历史行而不是当前跳转坐标", () => {
  const props = { taskId: "t", viewerUsername: "visitor", canOperate: false,
    items: [annotation({ line: 3, line_end: 7 })], onChanged() {} };
  const moved = renderToStaticMarkup(React.createElement(Panel,
    { ...props, checks: [{ id: "annotation-1", state: "moved", line: 13 }] }));
  assert.match(moved, /:13–17/);
  assert.doesNotMatch(moved, /:13–7/);
  const gone = renderToStaticMarkup(React.createElement(Panel,
    { ...props, checks: [{ id: "annotation-1", state: "gone" }] }));
  assert.match(gone, /打开材料，核对原文位置/);
  assert.match(gone, /原 3/);
});

test("个人行动清单能关联别人归属的 Committer 检视，且缺详情也不吞角标", () => {
  const foreign = task("foreign", "waiting_for_human", "alice");
  const visible = app.buildPersonalActionItems({
    waiting: [],
    intervention: [],
    merges: [],
    reviews: [review("review-1", foreign.id)],
    tasks: [foreign],
  });
  assert.equal(visible.length, 1);
  assert.equal(visible[0].task, foreign);
  assert.equal(visible[0].action, "开始检视");

  const temporarilyMissing = app.buildPersonalActionItems({
    waiting: [],
    intervention: [],
    merges: [],
    reviews: [review("review-2", "not-synced")],
    tasks: [],
  });
  assert.equal(temporarilyMissing.length, 1,
    "pending review 仍须占一项，不能让侧栏有角标而行动区显示已清空");
  assert.equal(temporarilyMissing[0].task, undefined);
  assert.equal(temporarilyMissing[0].action, "任务暂不可用");

  for (const [item, message] of [
    [visible[0], "邀请你检视代码与交付材料"],
    [temporarilyMissing[0], "邀请你检视；任务详情暂未同步，请稍后刷新"],
  ] as const) {
    const html = renderToStaticMarkup(React.createElement(people.PeopleProvider, {
      known: [{ username: "alice", display_name: "张三" }],
    }, item.detail));
    assert.equal(html, `<span title="alice">张三</span> ${message}`);
    assert.equal(renderToStaticMarkup(item.detail), `<span title="alice">alice</span> ${message}`);
  }
});

test("空任务目录完成加载后能判定 /work 深链失效，加载中不抢跑", () => {
  assert.deepEqual(app.resolveWorkspaceTarget("gone", "", [], false),
    { kind: "pending" });
  assert.deepEqual(app.resolveWorkspaceTarget("gone", "", [], true),
    { kind: "missing" });
  const present = task("present");
  assert.deepEqual(app.resolveWorkspaceTarget("present", "", [present], true),
    { kind: "ready", task: present });
});

test("任务已完成或取消时旧邀请不再进入行动清单，关闭状态也不冒充待检视", () => {
  assert.deepEqual(app.buildPersonalActionItems({
    waiting: [], intervention: [], merges: [],
    reviews: [review("stale", "canceled"), review("finished", "completed"),
      { ...review("closed", "live"), status: "canceled" }],
    tasks: [task("canceled", "canceled"), task("completed", "completed"), task("live")],
  }), []);
});

test("await_merge 的右栏明确给出合入行动，关闭 MR 给出异常行动", () => {
  assert.deepEqual(workspace.workspaceNextActionCopy({
    ...task("merge", "await_merge"),
    delivery: { mr_url: "https://code.example/mr/1" },
  }, false), {
    title: "等待检视与合入",
    detail: "前往 CodeHub 完成最后一步",
  });
  assert.equal(workspace.workspaceNextActionCopy({
    ...task("closed", "await_merge"),
    delivery: { mr_state: "已关闭" },
  }, false).title, "MR 已关闭，需要处理");
});

test("过期 push diff 不进入 GitDiff 内容", () => {
  const stale = workspace.normalizePushReviewDiffResult({
    unavailable: "这张检视卡对应的代码已经变化，请刷新查看最新版本",
    status: 404,
  });
  assert.equal(stale.content, "");
  assert.deepEqual(stale.state, {
    kind: "error",
    message: "这张检视卡对应的代码已经变化，请刷新查看最新版本",
    expired: true,
  });
  const fresh = workspace.normalizePushReviewDiffResult({
    content: "diff --git a/src/a.ts b/src/a.ts\n",
    branch: "feature/a",
  });
  assert.equal(fresh.state.kind, "ready");
});

test("push diff API 保留 404 状态，供工作台识别版本失效", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: "代码已经变化",
  }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  try {
    assert.deepEqual(await api.readPushReviewDiff("task/a", "changes"), {
      unavailable: "代码已经变化",
      status: 404,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("代码差异目录以完整清单为准，正文只补当前文件", () => {
  const files = gitDiff.filesForDiff([
    "## 已提交(committed)",
    "diff --git a/docs/large.md b/docs/large.md",
    "--- a/docs/large.md",
    "+++ b/docs/large.md",
    "@@ -1 +1 @@",
    "-旧内容",
    "+新内容",
  ].join("\n"), [
    { path: "docs/large.md", stage: "committed", additions: 1, deletions: 1 },
    { path: "src/after.ts", stage: "unstaged", additions: 3, deletions: 0 },
  ]);
  assert.deepEqual(files.map((file: { path: string }) => file.path),
    ["docs/large.md", "src/after.ts"]);
  assert.equal(files[0].lines.length > 0, true);
  assert.equal(files[1].lines.length, 0,
    "尚未点开的文件用清单占位，不能从目录树消失");
  assert.equal(files[1].kind, "代码");
});

test("点开正文或正文截断不改变其他文件和当前文件的完整增删统计", () => {
  const manifest = [
    {path:"src/a.ts",stage:"committed",additions:1000,deletions:7},
    {path:"src/b.ts",stage:"committed",additions:23,deletions:4},
  ];
  const body = (path: string) => `## 已提交(committed)\ndiff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
  for (const text of ["",body("src/a.ts"),body("src/b.ts")]) {
    assert.deepEqual(gitDiff.filesForDiff(text,manifest).map((file: {additions:number;deletions:number}) => [file.additions,file.deletions]),[[1000,7],[23,4]]);
  }
});

test("上万条文件清单的首屏保持有界，不在服务端一次性输出全部文件节点", () => {
  const manifest = Array.from({ length: 10_000 }, (_, index) => ({
    path: `target/CMakeFiles/module-${index}/object.o`,
    stage: "untracked",
    additions: 0,
    deletions: 0,
  }));
  const html = renderToStaticMarkup(React.createElement(gitDiff.GitDiff, {
    text: "工作区文件正文按需读取",
    manifest,
  }));
  assert.match(html, /10000 个文件/);
  assert.match(html, /搜索变更文件/);
  assert.doesNotMatch(html, /module-9999\/object\.o/,
    "首屏不能先渲染所有文件、再靠 effect 折叠");
  assert.ok(html.length < 100_000,
    `折叠后的首屏 HTML 不应随一万条清单膨胀：${html.length}`);
});

test("工作台面向用户只说实时执行日志和单元测试", () => {
  const html = renderToStaticMarkup(React.createElement(taskCard.ExecutionPanel, {
    task: task("live"),
  }));
  // 2026-09-08 拍板:面板默认只看对话,文案随之更新——依旧不漏 SSE 等术语。
  assert.match(html, /只看对话，可切全部\/工具\/异常/);
  assert.doesNotMatch(html, /SSE/);

  for (const state of ["repairing", "blocked", "passed", "user_skipped"]) {
    assert.match(prepush.prepushViewOf(state).detail, /单元测试/);
    assert.doesNotMatch(prepush.prepushViewOf(state).detail, /\bUT\b/);
  }
  assert.equal(api.issueStageText({
    scenario: "ticket",
    stage: "ut",
  }), "单元测试验证");
});

test("完整交付清单不截断或过滤文件，大目录默认折叠且可以搜索末尾文件", () => {
  const files = Array.from({ length: 232 }, (_, i) => ({ path: `build/output-${i}.o`, label: "新增" }));
  const groups = deliveryList.deliveryFileGroups(files);
  assert.equal(groups[0][1].length, 232);
  assert.deepEqual(deliveryList.deliveryFileGroups(files, "output-231"), [["build", [files[231]]]]);
  const large = renderToStaticMarkup(React.createElement(deliveryList.DeliveryFileList, { files }));
  assert.match(large, /232 个文件/);
  assert.match(large, /搜索交付文件/);
  assert.doesNotMatch(large, /checkbox|<details[^>]*open|output-231/, "折叠目录不挂载数百个隐藏行");
  const small = renderToStaticMarkup(React.createElement(deliveryList.DeliveryFileList, { files: [files[231], { path: "README.md", label: "修改" }] }));
  assert.match(small, /output-231\.o/);
  assert.match(small, /仓库根目录/);
  assert.match(small, /README\.md/);
  assert.doesNotMatch(small, /checkbox/);
});

test("最终交付决定卡不要求勾选文件，人工意见仍可提交", () => {
  const deliveryTask = {
    ...task("delivery", "waiting_for_human"),
    waiting: {
      waiting_id: "wait-delivery",
      state_version: 1,
      step: "cloud_push_confirm",
      recommended_view: "diff",
      question: { delivery_files: [{ path: "src/delivery.ts", label: "新增" }], questions: [{
        question: "是否按清单继续？",
        options: ["确认按清单推送", "按清单返工"],
      }] },
      choice_effects: [
        { key: "confirm", answers: ["确认按清单推送"], closes_feedback: true },
        { key: "revise", answers: ["按清单返工"], handles_feedback: true },
      ],
    },
  };
  const html = renderToStaticMarkup(React.createElement(taskCard.WaitingCard, {
    task: deliveryTask,
    onDecided: () => undefined,
    unresolvedAnnotationCount: 3,
  }));
  assert.doesNotMatch(html, /这次推送哪些文件|文件去留|选文件|重新编译后提交|不再编译，直接提交|全部纳入|全部仅留本地/);
  assert.match(html, /当前有 3 条检视意见未闭环/);
  assert.match(html, /建议选择“按清单返工”/);
  assert.doesNotMatch(html, /当前卡片缺少调整选项/);
  assert.match(html, /本次推送清单/);
  assert.match(html, /delivery\.ts/);
});

test("需求最终方案卡展示拆分建议和 Agent 的理由，选项仍提交原有契约值", () => {
  const render = (count: number, question: string) => renderToStaticMarkup(React.createElement(taskCard.WaitingCard, {
    task: {
      ...task(`split-${count}`, "waiting_for_human"),
      requirement_graph: {
        stage: "analysis",
        repositories: Array.from({ length: count }, (_, index) => ({ id: `unit-${index}`, responsibility: "独立交付" })),
        repository_assessments: [], dependencies: [],
      },
      waiting: {
        waiting_id: `wait-${count}`, state_version: 1, step: "requirement-analysis",
        question: { questions: [{ question, options: [
          count === 1 ? "确认并继续开发" : "确认并生成任务", "需要修改",
        ] }] },
      },
    },
    onDecided: () => undefined,
    repositoryAssigneeSelection: { assignments: {}, tickets: {}, ready: false, loading: false },
  }));
  const single = render(1, "建议不拆分：只有一个独立验收目标。是否同意？");
  assert.match(single, /确认开发方案/);
  assert.match(single, /建议不拆分：只有一个独立验收目标。是否同意？/);
  assert.match(single, /同意不拆分，继续开发/);
  assert.match(single, /不同意当前方案，要求调整/);

  const multiple = render(2, "建议拆分：两个模块可以独立交付。是否同意？");
  assert.match(multiple, /确认拆分方案/);
  assert.match(multiple, /建议拆分：两个模块可以独立交付。是否同意？/);
  assert.match(multiple, /同意拆分，生成任务/);
});

test("管理员旁路只开放给当前复检白名单中的他人待闭环意见", () => {
  const current = annotation();
  const access = (item: Record<string, unknown>, options: {
    viewerUsername?: string;
    reviewReady?: boolean;
    ids?: string[];
  } = {}) => {
    const access = annotationOverrideAccess(item as unknown as Annotation, {
      task_status: "waiting_for_human",
      review_ready: options.reviewReady ?? true,
      review_annotation_ids: options.ids ?? ["annotation-1"],
      archival: false,
    }, {
      username: options.viewerUsername ?? "admin",
      can_override: true,
      can_route_others: false,
    });
    return { canDrop: access.can_drop, canVerify: access.can_verify };
  };

  assert.deepEqual(access(current), { canDrop: true, canVerify: true });
  assert.deepEqual(access(current, { ids: [] }),
    { canDrop: false, canVerify: false }, "历史意见不应沿用管理员入口");
  assert.deepEqual(access(current, { viewerUsername: "alice" }),
    { canDrop: false, canVerify: false }, "管理员自己的意见仍由本人裁决");
  assert.deepEqual(access(annotation({ status: "draft", response: undefined })),
    { canDrop: false, canVerify: false }, "他人草稿不属于管理员代办");
  assert.deepEqual(access(current, { reviewReady: false }),
    { canDrop: false, canVerify: false }, "非当前复检阶段必须默认关闭");
  assert.deepEqual(access(annotation({
    rework: 1,
    response: { ...current.response, revision: 0 },
  })), { canDrop: true, canVerify: false }, "旧一轮回复不能被误确认");
  assert.deepEqual(access(annotation({
    response: { ...current.response, outcome: "needs_clarification" },
  })), { canDrop: true, canVerify: false }, "仍需补充说明时不能代确认");
});

test("管理员危险动作必须连续确认同一条意见和同一动作", () => {
  const first = annotationPanel.advanceAdminOverrideArm(
    undefined, "annotation-1", "drop");
  assert.deepEqual(first, {
    execute: false,
    arm: { annotationId: "annotation-1", action: "drop" },
  });

  const switched = annotationPanel.advanceAdminOverrideArm(
    first.arm, "annotation-1", "verify");
  assert.equal(switched.execute, false, "切换动作只能重新武装，不能沿用第一次点击");
  assert.deepEqual(switched.arm,
    { annotationId: "annotation-1", action: "verify" });

  const second = annotationPanel.advanceAdminOverrideArm(
    switched.arm, "annotation-1", "verify");
  assert.deepEqual(second, { execute: true, arm: undefined });
});

test("普通流程批注在 Agent 再次举卡后可由作者闭环，不依赖 MR 复检状态", () => {
  const common = {
    taskId: "task-1",
    viewerUsername: "alice",
    checks: [],
    canOperate: true,
    canOverride: false,
    taskStatus: "waiting_for_human",
    reviewReady: false,
    reviewAnnotationIds: [],
    mergeRequestOpen: false,
    onChanged: () => undefined,
  };
  const ordinary = annotation({ sent_via: "decision", response: undefined });
  assert.equal(verdictReady(
    ordinary, "waiting_for_human", false), true);
  const html = renderToStaticMarkup(React.createElement(
    Panel,
    { ...common, items: [ordinary] },
  ));
  assert.match(html, /请核对处理结果/);
  assert.match(html, />仍需调整<\/button>/);
  assert.match(html, />确认已修复<\/button>/);

  assert.equal(verdictReady(
    ordinary, "running", false), false,
  "Agent 仍在修改时不能提前验收");
  assert.equal(verdictReady(
    annotation({ sent_via: "queued_decision", response: undefined }),
    "waiting_for_human", false), false,
  "只登记、尚未真正送达 Agent 的意见不能立即验收");
  assert.equal(verdictReady(
    annotation({ sent_via: "review_repair" }),
    "waiting_for_human", false), false,
  "MR 修复仍必须等 Build-Fix 与复检卡");
  assert.equal(verdictReady(
    annotation({ sent_via: "review_repair", response: undefined }),
    "waiting_for_human", true), false,
  "MR 修复缺逐条回执时不能误开放通过");
});

test("待处理意见由检视卡统一送达，责任人仍可自行答复或删除，闭环后可重开", () => {
  const item = annotation({ status: "draft", response: undefined, route: "owner_reply", author: "reviewer", assignee: "owner" });
  const common = { taskId: "task", taskOwner: "owner", ownerControlled: true, items: [item], checks: [], taskStatus: "running", onChanged() {} };
  const html = renderToStaticMarkup(React.createElement(Panel, { ...common, viewerUsername: "owner" }));
  assert.doesNotMatch(html, />交给 Agent<\/button>/); assert.match(html, />自行答复<\/button>/); assert.match(html, />删除<\/button>/);
  assert.doesNotMatch(html, />确认闭环<\/button>|决策后处理|记为记忆|申请撤回表达/);
  for (const viewerUsername of ["reviewer", "admin"]) {
    const readonly = renderToStaticMarkup(React.createElement(Panel, { ...common, viewerUsername }));
    assert.doesNotMatch(readonly, />删除<\/button>|>交给 Agent<\/button>|>自行答复<\/button>/);
  }
  const closed = renderToStaticMarkup(React.createElement(Panel, { ...common, viewerUsername: "owner", items: [annotation({ ...item, status: "verified" })] }));
  assert.match(closed, />重新处理<\/button>/);
});

test("MR 复检把真正可操作的意见置顶成待确认卡，缺回执时不说已有按钮", () => {
  const actionable = annotation({
    id: "review-actionable",
    file: "src/actionable.ts",
    sent_via: "review_repair",
  });
  const clarification = annotation({
    id: "review-clarification",
    file: "src/clarification.ts",
    sent_via: "review_repair",
    response: {
      revision: 0,
      outcome: "needs_clarification",
      summary: "需要补充边界",
      evidence: [],
      responded_at: "2026-08-30T00:01:00.000Z",
    },
  });
  const missing = annotation({
    id: "review-missing",
    file: "src/missing.ts",
    sent_via: "review_repair",
    response: undefined,
  });
  const history = annotation({
    id: "review-history",
    file: "src/history.ts",
    status: "verified",
    sent_via: "review_repair",
  });
  const html = renderToStaticMarkup(React.createElement(
    Panel,
    {
      taskId: "task-review",
      viewerUsername: "alice",
      items: [history, missing, actionable, clarification],
      checks: [],
      canOperate: true,
      taskStatus: "waiting_for_human",
      reviewReady: true,
      reviewAnnotationIds: [actionable.id, clarification.id, missing.id],
      mergeRequestOpen: true,
      onChanged: () => undefined,
    },
  ));
  assert.match(html, /待我确认/);
  assert.match(html, /2 项/);
  assert.match(html, /本轮有 2 条意见待你逐条处置/);
  assert.match(html, /另有 1 条意见的当前轮逐条回执尚未就绪/);
  assert.match(html, />仍需调整<\/button>/);
  assert.match(html, />确认已修复<\/button>/);
  assert.match(html, />回答这个问题<\/button>/, "追问的回答入口按动作命名");
  assert.ok(html.indexOf("src/actionable.ts") < html.indexOf("src/history.ts"),
    "待确认卡必须排在历史记录前面");
});

test("批注面板显示受限管理员入口和实际代确认审计", () => {
  const common = {
    taskId: "task-1",
    viewerUsername: "admin",
    checks: [],
    canOperate: false,
    canOverride: true,
    taskStatus: "waiting_for_human",
    reviewReady: true,
    mergeRequestOpen: true,
    onChanged: () => undefined,
  };
  const current = annotation();
  const eligibleHtml = renderToStaticMarkup(React.createElement(
    Panel,
    { ...common, items: [current], reviewAnnotationIds: [current.id] },
  ));
  assert.doesNotMatch(eligibleHtml, />管理员代删<\/button>/);
  assert.match(eligibleHtml, />管理员代确认<\/button>/);
  assert.match(eligibleHtml, /第一次点击只会进入确认/);

  const historicalHtml = renderToStaticMarkup(React.createElement(
    Panel,
    { ...common, items: [current], reviewAnnotationIds: [] },
  ));
  assert.doesNotMatch(historicalHtml, />管理员代删<\/button>/);
  assert.doesNotMatch(historicalHtml, />管理员代确认<\/button>/);

  const auditedHtml = renderToStaticMarkup(React.createElement(
    Panel,
    {
      ...common,
      reviewReady: false,
      items: [annotation({ status: "verified", verified_by: "ops-admin" })],
      reviewAnnotationIds: [],
      people: [
        { username: "alice", display_name: "爱丽丝" },
        { username: "ops-admin", display_name: "值班管理员" },
      ],
    },
  ));
  assert.match(auditedHtml, /管理员 值班管理员 代确认/);
  assert.match(auditedHtml, /批注作者 爱丽丝/);
  assert.doesNotMatch(auditedHtml, /批注作者 alice/,
    "看板展示姓名，账号仍只在权限判断里使用");
  assert.doesNotMatch(auditedHtml, /你已确认/);
});

test("检视状态只报告有证据的进度，不再把所有未闭环项写成 Agent 正在处理", () => {
  const common = {
    taskId: "task-status",
    viewerUsername: "alice",
    items: [annotation({ response: undefined, sent_via: "interrupt" })],
    canOperate: true,
    taskStatus: "running",
    mergeRequestOpen: false,
    onChanged: () => undefined,
  };
  const html = renderToStaticMarkup(React.createElement(
    Panel,
    { ...common, checks: [] },
  ));
  assert.match(html, /已交给 Agent/);
  assert.doesNotMatch(html, /Agent 处理中/);
  const changedHtml = renderToStaticMarkup(React.createElement(
    Panel,
    { ...common, checks: [{ id: "annotation-1", state: "gone" }] },
  ));
  assert.match(changedHtml, /已有改动·待验证/,
    "圈选内容已经变化时如实显示已有改动，不继续冒充 Agent 仍在修改");
  assert.doesNotMatch(changedHtml, /Agent 处理中/);
  assert.equal(annotationPanel.displayPersonName("alice", [
    { username: "alice", display_name: "  爱丽丝  " },
  ]), "爱丽丝");
  assert.equal(annotationPanel.displayPersonName("unknown", []), "unknown",
    "历史账号没有姓名时仍可读");
});

test("代码意见定位直接选目标文件，折叠的上下文行仍渲染，快照对应变更后代码", () => {
  const text = [
    "diff --git a/first.ts b/first.ts", "--- a/first.ts", "+++ b/first.ts",
    "@@ -1 +1 @@", "-before();", "+after();",
    "diff --git a/second.ts b/second.ts", "--- a/second.ts", "+++ b/second.ts",
    "@@ -100,20 +100,20 @@", ...Array.from({ length: 20 }, (_, i) => ` context${i}();`),
  ].join("\n");
  const html = renderToStaticMarkup(React.createElement(gitDiff.GitDiff, {
    text, embeddedBrowser: true, annotationLocation: { file: "second.ts", request: 1 },
  }));
  assert.match(html, /data-file="second.ts"/);
  assert.match(html, /data-l="110"/);
  assert.doesNotMatch(html, /class="diff-fold"/);
  assert.match(html, /data-code-side="new"/);
});


test("责任人逐条处置表单保留缺回执事实，检视人和管理员只能看处置状态", () => {
  const pending = annotation({ author: "reviewer", response: undefined });
  const props = { taskId: "owner-review", taskOwner: "owner", ownerControlled: true,
    items: [pending], checks: [], taskStatus: "waiting_for_human", reviewReady: true,
    reviewAnnotationIds: [pending.id], onChanged: () => undefined };
  const html = renderToStaticMarkup(React.createElement(Panel, { ...props, viewerUsername: "owner" }));
  assert.doesNotMatch(html, />确认闭环<\/button>/);
  assert.doesNotMatch(html, /其他处理/);
  assert.doesNotMatch(html, /这条意见的处理依据|保存处理结果/, "处置表单不能在阅读批注时自动展开");
  assert.match(html, /当前轮逐条回执尚未就绪/);
  assert.doesNotMatch(html, /Agent 已处理本轮|Agent 已处理你提出/);
  for (const viewerUsername of ["reviewer", "admin"]) {
    const readonly = renderToStaticMarkup(React.createElement(Panel, { ...props, viewerUsername, canOverride: true }));
    assert.doesNotMatch(readonly, /确认通过|其他处理|管理员代确认|管理员代删/);
    assert.match(readonly, /等待 Agent 答复/);
  }
});


test("责任人核对 Agent 修复后直接确认通过，不再自动展开处置表单", () => {
  for (const artifact of ["requirement", "diff", "design.md"]) {
    const html = renderToStaticMarkup(React.createElement(Panel, {
      taskId: "owner-review", taskOwner: "owner", ownerControlled: true,
      viewerUsername: "owner", items: [annotation({ artifact, author: "reviewer" })],
      checks: [], taskStatus: "waiting_for_human", onChanged: () => undefined,
    }));
    assert.match(html, />确认闭环<\/button>/);
    assert.doesNotMatch(html, />退回待处理<\/button>/);
    assert.doesNotMatch(html, /role="combobox"|<textarea/);
    assert.match(html, /annot-response outcome-fixed/);
    assert.doesNotMatch(html, /class="annot-response fixed"/);
  }
});

for (const status of ["running", "waiting_for_human", "await_merge", "paused"]) test(`统一修改意见按钮：${status} 使用相同文案并汇总他人意见`, () => {
  const html = renderToStaticMarkup(React.createElement(Panel, {
    taskId: "task-1", viewerUsername: "owner", taskOwner: "owner", ownerControlled: true,
    canOperate: true, taskStatus: status, mergeRequestOpen: true, checks: [], onChanged() {},
    // 49d7a2f5 起按钮可提交性由后端视图决定;单测给"可提交"视图,验证各状态文案一致。
    submission: { ordinary: { enabled: true, hint: "提交后继续处理当前任务的修改意见。" },
      story: { enabled: true, hint: "提交后继续处理当前任务的修改意见。" } },
    items: [annotation({ id: "pending", author: "reviewer", status: "draft", response: undefined }),
      annotation({ id: "answered", author: "reviewer", status: "draft", response: undefined,
        owner_reply: { author: "owner", text: "无需修改", replied_at: "2026-09-12" } })],
  }));
  assert.match(html, /提交修改意见/);
  assert.match(html, /1<!-- --> 条待提交|1 条待提交/);
  assert.doesNotMatch(html, /交给 Agent|先逐条加入待发送清单/);
});

test("检视人只能记下，不能替责任人提交修改意见", () => {
  const html = renderToStaticMarkup(React.createElement(Panel, {
    taskId: "task-1", viewerUsername: "reviewer", taskOwner: "owner", ownerControlled: true,
    canOperate: true, taskStatus: "await_merge", mergeRequestOpen: true, checks: [], onChanged() {},
    items: [annotation({ author: "reviewer", status: "draft", response: undefined })],
  }));
  assert.doesNotMatch(html, /提交修改意见/);
});
