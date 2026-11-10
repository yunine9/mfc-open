/**
 * 任务记忆第三期契约(docs/knowledge-memory-design.md §5/§6/§8-3/§9):
 * 起草收尾、台账与效果账、目录摘要层、沉底归档、时间线事件、效能页总览。
 *
 * 模型全部用假件(注入 memoryDrafter);sidecar 用假件;真 memsearch 在场时
 * 多跑一遍"起草后改标题能被搜到、归档重建后搜不到",缺席显式 skip。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  EMPTY_STATS, MemoryStore, memoryWeight, type MemoryInput,
} from "../src/taskMemory.ts";
import {
  buildMemoryDraftPrompt, parseDirectoryDigest, parseMemoryDraft,
  renderDirectoryDigestFallback,
} from "../src/memoryDraft.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import { TaskService } from "../src/taskService.ts";
import { buildTimeline } from "../src/timeline.ts";

const STUB = resolve(process.cwd(), "tests/fixtures/memsearch-sidecar-stub.mjs");
const REAL_PYTHON = process.env.MFC_MEMSEARCH_PYTHON
  ?? resolve(process.cwd(), "..", "..", "..", ".local", "memsearch-venv", "bin", "python");
const REAL_SCRIPT = resolve(process.cwd(), "harness", "memsearch-sidecar.py");
const DAY = 86_400_000;

const base = {
  source: "annotation", judged_by: "human", scope: "local", repo: "notify-service",
  paths: ["src/filter/FilterEngine.java"], line: 88, phase: "写代码", task: "task-old",
  evidence: "annotation:a-1", trigger: "改 src/filter/FilterEngine.java 第 88 行附近时",
  quote: "if (enabled) check();", problem: "黑名单判断放在开关后面了",
  conclusion: "黑名单判断必须在渠道开关之前",
} satisfies MemoryInput;

function fakeService(options: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-"));
  const logs: string[] = [];
  const svc = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    log: (line: string) => logs.push(line), ...options,
  });
  return { dataDir, svc, logs };
}

function liveTask(svc: TaskService, requirement = "改一下过滤顺序") {
  const id = svc.create(requirement).id;
  const internal = (svc as any).tasks.get(id);
  internal.summary.repo_url = "git@example.com:demo/notify-service.git";
  internal.summary.status = "running";
  const steered: Array<{ text: string; extra: any }> = [];
  internal.driver = {
    steer: async (text: string, extra: any) => { steered.push({ text, extra }); },
    abort: async () => {}, dispose: () => {}, pendingSteers: () => [],
  };
  internal.cwd = mkdtempSync(join(tmpdir(), "mfc-memory3-cwd-"));
  mkdirSync(join(internal.cwd, "src", "filter"), { recursive: true });
  writeFileSync(join(internal.cwd, "src", "filter", "FilterEngine.java"), "class A {}\n");
  return { id, internal, steered };
}

test("起草收尾:同一条记录补 trigger/scope,索引追加一版、读侧取最后一版;只收尾一次", () => {
  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory3-")));
  const first = store.record(base);
  const next = store.finalizeDraft(first.id, {
    trigger: "改过滤器的判断顺序时", scope: "general", state: "model" });
  assert.equal(next.revision, 2);
  assert.equal(next.draft, "model");
  const md = readFileSync(join(store.root, first.file), "utf-8");
  assert.match(md, /\n---\n# 改过滤器的判断顺序时\n/);
  assert.match(md, /\nscope: general\n/);
  assert.match(md, /\ndraft: model\n/);
  assert.match(md, /黑名单判断必须在渠道开关之前/, "人写的正文一个字不动");
  const rows = store.list();
  assert.equal(rows.length, 1, "同 id 两版只算一条");
  assert.equal(rows[0].trigger, "改过滤器的判断顺序时");
  assert.equal(readFileSync(join(store.root, "index.jsonl"), "utf-8").trim().split("\n").length, 2,
    "索引只追加不改写");
  assert.throws(() => store.finalizeDraft(first.id, { state: "model", trigger: "x" }), /已经起草收尾过/);
  // 起草失败:标 failed,模板保留
  const second = store.record({ ...base, evidence: "annotation:a-2" });
  const failed = store.finalizeDraft(second.id, { state: "failed" });
  assert.equal(failed.trigger, base.trigger);
  assert.equal(failed.draft, "failed");
});

test("起草解析:只认形状对的 JSON;摘要必须引用真实 id、不超 12 行", () => {
  assert.deepEqual(parseMemoryDraft('{"trigger":"改过滤顺序时","scope":"local"}'),
    { trigger: "改过滤顺序时", scope: "local" });
  assert.deepEqual(parseMemoryDraft('好的,这是结果:\n```json\n{"trigger": "加新渠道时", "scope": "general"}\n```'),
    { trigger: "加新渠道时", scope: "general" });
  assert.equal(parseMemoryDraft('{"trigger":"x","scope":"forever"}'), undefined, "scope 不在词表");
  assert.equal(parseMemoryDraft('{"trigger":"","scope":"local"}'), undefined);
  assert.equal(parseMemoryDraft("我觉得这条应该是 local"), undefined);
  assert.equal(parseMemoryDraft(`{"trigger":"${"长".repeat(81)}","scope":"local"}`), undefined);
  const prompt = buildMemoryDraftPrompt({ ...base, id: "c-1-a", at: "2026-09-03T00:00:00Z", file: "x" });
  assert.match(prompt.user, /黑名单判断放在开关后面了/);
  assert.match(prompt.system, /one_off/);

  const store = new MemoryStore(mkdtempSync(join(tmpdir(), "mfc-memory3-")));
  const rows = [store.record(base), store.record({ ...base, evidence: "e2" })];
  assert.equal(parseDirectoryDigest("- 有人要求过黑名单在开关前", rows), undefined, "没引用 id");
  assert.match(parseDirectoryDigest(`- 有人要求过黑名单在开关前(${rows[0].id})`, rows) ?? "", /开关前/);
  assert.equal(parseDirectoryDigest(Array(13).fill(`- x (${rows[0].id})`).join("\n"), rows), undefined);
  const fallback = renderDirectoryDigestFallback("src/filter", [...rows, ...rows, ...rows]);
  assert.match(fallback, /另有 1 条,用 knowledge search 描述 src\/filter/);
});

test("权重保留来源与时间排序，同文件意见不能作为有害知识扣分", () => {
  const now = Date.parse("2026-09-03T00:00:00Z");
  const fresh = { judged_by: "human", scope: "local", at: "2026-09-01T00:00:00Z" } as const;
  const human = memoryWeight(fresh, EMPTY_STATS, now);
  const pipeline = memoryWeight({ ...fresh, judged_by: "pipeline" }, EMPTY_STATS, now);
  const yearOld = memoryWeight({ ...fresh, at: "2025-09-01T00:00:00Z" }, EMPTY_STATS, now);
  const used = memoryWeight(fresh, { ...EMPTY_STATS, hits: 2 }, now);
  const reworked = memoryWeight(fresh, { ...EMPTY_STATS, hits: 2, reworks: 1 }, now);
  const general = memoryWeight({ ...fresh, scope: "general" }, EMPTY_STATS, now);
  assert.ok(human > pipeline);
  assert.ok(Math.abs(yearOld - human / 2) < 0.01);
  assert.ok(used > human);
  assert.equal(reworked, used, "同文件返工不证明经验有害");
  assert.ok(general > human);
  assert.ok(memoryWeight(fresh, { ...EMPTY_STATS, reworks: 9 }, now) >= 0.05, "有下限,不归零");
});

test("过程中主动记录直接保存，不调用逐条提炼模型", async () => {
  let calls = 0;
  const { svc } = fakeService({ memoryDrafter: async () => { calls++; return "{}"; } });
  try {
    const { id, internal } = liveTask(svc);
    const record = (svc as any).recordMemory(internal, { ...base, task: id, source: "agent_note" });
    await svc.flushMemoryDrafts();
    assert.equal(calls, 0);
    assert.equal(svc.listTaskMemories(id)[0].conclusion, base.conclusion);
    assert.equal(svc.listTaskMemories(id)[0].review?.status, "pending");
    svc.reviewTaskMemory(id, record.id, "owner", { decision:"accepted", revision:1 });
    assert.equal(svc.listTaskMemories(id)[0].review?.status, "accepted");
  } finally { await svc.shutdown(); }
});

test("台账保留同文件意见的关联事实，不据此降低经验权重;总览能看到", async () => {
  const { svc, dataDir } = fakeService();
  try {
    const store = new MemoryStore(dataDir);
    const a = store.record({ ...base, conclusion: "A:黑名单在开关前" });
    const b = store.record({ ...base, evidence: "e2", conclusion: "B:另一条同文件的" });
    for (const row of [a, b]) store.review(row.id, "owner", { decision: "accepted", revision: row.revision ?? 1 });
    const { id, internal, steered } = liveTask(svc);
    (svc as any).logMemoryUsage(internal, { moment: "context", ids: [a.id, b.id], query: "当前代码" });
    const stats = store.ledger.stats();
    assert.equal(stats.get(a.id)?.pushes, 1);
    assert.equal(stats.get(b.id)?.pushes, 1);

    // 人对同一文件提了意见(路由给 Agent)→ 两条都记返工;同单不重复记
    const before = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.deepEqual(new Set(before), new Set([a.id, b.id]));
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/filter/FilterEngine.java", line: 90,
      anchor: "y", note: "这里还是不对", kind: "code",
    });
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/filter/FilterEngine.java", line: 91,
      anchor: "z", note: "再提一条", kind: "code",
    });
    svc.addAnnotation(id, {
      author: "alice", artifact: "本任务变更", file: "src/other/X.java", line: 1,
      anchor: "q", note: "别的文件,不算", kind: "code",
    });
    const after = store.ledger.rows().filter((row) => row.kind === "rework");
    assert.equal(after.length, 2, "同单同条只记一次;别的文件不算");
    assert.deepEqual(new Set(after.map((row) => row.id)), new Set([a.id, b.id]));

    const rankAt = Date.now();
    assert.equal(memoryWeight(a, store.ledger.stats().get(a.id), rankAt), memoryWeight(a, { ...EMPTY_STATS, pushes: 1 }, rankAt), "意见关联不改变权重");
    // 新增条目仍可加入排序；同文件意见不证明旧经验有害。
    const c = store.record({ ...base, evidence: "e3", conclusion: "C:没推过的" });
    store.review(c.id, "owner", { decision: "accepted", revision: 1 });
    const ranked = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.equal(ranked[0], c.id);

    const insights = svc.memoryInsights();
    assert.equal(insights.sidecar, "absent");
    assert.equal(insights.repos[0].repo, "notify-service");
    assert.equal(insights.repos[0].active, 3);
    assert.equal(insights.repos[0].reworks, 2);
    assert.equal(insights.repos[0].pushes, 2);
    assert.equal(insights.memories[0].id, c.id);
    assert.equal(insights.memories.find((row) => row.id === a.id)?.reworks, 1);
    assert.ok(svc.readMemoryInsight(a.id)?.content.includes("## 结论"));
    assert.equal(svc.readMemoryInsight("c-nope-000000"), undefined);

    // 时间线:推送进了时间轴
    const timeline = buildTimeline(internal.summary.workspace, internal.cwd);
    const memoryEntries = timeline.filter((entry) => entry.kind === "memory");
    assert.equal(memoryEntries.length, 1);
    assert.match(memoryEntries[0].title, /本轮提供 2 条相关记忆/);
  } finally {
    await svc.shutdown();
  }
});

test("沉底:一年没人用的、失锚半年的挪进 _archive;不删、还能读、不再推;有 sidecar 就重建索引", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-"));
  const logs: string[] = [];
  const svc = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    log: (line: string) => logs.push(line),
    memory: { python: process.execPath, script: STUB, milvusPath: join(dataDir, "m.db") },
  });
  try {
    const store = new MemoryStore(dataDir);
    const idle = store.record({ ...base, conclusion: "一年没人用" });
    const lost = store.record({ ...base, evidence: "e2", conclusion: "失锚半年" });
    const alive = store.record({ ...base, evidence: "e3", conclusion: "最近推过" });
    for (const row of [idle, lost, alive]) store.review(row.id, "owner", { decision: "accepted", revision: 1 });
    const now = Date.now() + 400 * DAY;
    store.ledger.append({ kind: "unanchored", id: lost.id,
      at: new Date(Date.now() - 200 * DAY).toISOString() });
    store.ledger.append({ kind: "push", id: alive.id, task: "t", at: new Date(now - DAY).toISOString() });
    const archived = svc.sweepMemoryArchive({ now });
    assert.deepEqual(new Set(archived.map((row) => row.id)), new Set([idle.id, lost.id]));
    assert.match(archived.find((row) => row.id === idle.id)!.reason, /从未被推送或命中/);
    assert.match(archived.find((row) => row.id === lost.id)!.reason, /失锚超过 180 天/);
    assert.ok(!existsSync(join(store.root, idle.file)));
    assert.ok(existsSync(join(store.root, "_archive", idle.file)), "挪走不是删掉");
    assert.match(store.read(idle.id) ?? "", /一年没人用/, "归档的还能读");
    const rows = store.list();
    assert.equal(rows.find((row) => row.id === idle.id)?.archived, true);
    assert.equal(rows.find((row) => row.id === alive.id)?.archived, undefined);
    assert.deepEqual(svc.sweepMemoryArchive({ now }), [], "第二次扫没有新的");
    const { internal } = liveTask(svc);
    const ids = (svc as any).memoryCandidates(internal).map((row: any) => row.id);
    assert.deepEqual(ids, [alive.id], "归档的不推");
    // 重建是旁路(sweepMemoryArchive 只 fire-and-forget),日志要到旁路
    // 子进程拉起+握手+应答之后才落;全量并发跑时冷拉起可远超 300ms,
    // 固定小睡是赌时序。改为带截止的轮询等日志,契约本身不变。
    const rebuildDone = () => logs.some((line) => line.includes("沉底后索引重建完成"));
    for (let waited = 0; !rebuildDone() && waited < 15_000; waited += 50) {
      await new Promise((tick) => setTimeout(tick, 50));
    }
    assert.ok(rebuildDone(), logs.join("\n"));
    assert.equal(svc.memoryInsights().repos[0].archived, 2);
  } finally {
    await svc.shutdown();
  }
});

test("经验审查集中于团队资产，任务页只提供导航，不散落审批入口", () => {
  const board = readFileSync(resolve(process.cwd(), "web/src/MemoryBoard.tsx"), "utf8");
  assert.match(board, /MemoryReviewEditor/);
  const footprint = readFileSync(resolve(process.cwd(), "web/src/KnowledgeFootprint.tsx"), "utf8");
  assert.match(footprint, /kbPage=experience/);
  assert.doesNotMatch(footprint, /MemoryReviewEditor|reviewTaskMemory/);
});

test("真 memsearch:起草改标题后再入库能按新说法搜到;归档并重建索引后搜不到(venv 缺席则 skip)", async (t) => {
  if (!existsSync(REAL_PYTHON)) {
    t.skip(`找不到 memsearch venv 的 python(${REAL_PYTHON});设 MFC_MEMSEARCH_PYTHON 后重跑`);
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory3-real-"));
  const store = new MemoryStore(dataDir);
  const sidecar = new MemorySidecar({
    python: REAL_PYTHON, script: REAL_SCRIPT,
    corpusDir: store.root, milvusPath: join(dataDir, "memsearch", "milvus.db"),
    budgets: { searchMs: 5_000, ingestMs: 20_000, bootMs: 120_000 },
    env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    log: () => {},
  });
  try {
    assert.equal(await sidecar.start(), true, "真 sidecar 起不来");
    const record = store.record(base);
    const other = store.record({ ...base, evidence: "e2", paths: ["pom.xml"], line: undefined,
      trigger: "加新渠道时", problem: "", quote: "", conclusion: "枚举新增渠道要同步改 registry.xml" });
    assert.equal(await sidecar.ingest(join(store.root, record.file)), true);
    assert.equal(await sidecar.ingest(join(store.root, other.file)), true);
    const next = store.finalizeDraft(record.id, {
      trigger: "调整过滤器里判断先后顺序时", scope: "general", state: "model" });
    store.review(next.id, "owner", { decision: "accepted", revision: next.revision ?? 1 });
    store.review(other.id, "owner", { decision: "accepted", revision: other.revision ?? 1 });
    assert.equal(await sidecar.ingest(join(store.root, other.file)), true);
    assert.equal(await sidecar.ingest(join(store.root, next.file)), true);
    const hits = await sidecar.search({ query: "过滤器判断先后顺序", repo: "notify-service" });
    assert.equal(hits?.[0]?.id, record.id, "按起草后的新说法能搜到");
    store.archive(record.id, "测试归档");
    const chunks = await sidecar.reindex();
    assert.ok(typeof chunks === "number", "重建索引要回块数");
    const after = await sidecar.search({ query: "过滤器判断先后顺序", repo: "notify-service" });
    assert.ok(!(after ?? []).some((hit) => hit.id === record.id),
      `归档并重建后不该再搜到: ${JSON.stringify(after)}`);
    assert.ok((after ?? []).some((hit) => hit.id === other.id) || (after ?? []).length === 0);
  } finally {
    sidecar.stop();
  }
});

test("主模型不可用时保留模板；旧专用模型配置不改变行为", async () => {
  for (const options of [{}, { memoryDraftModel: { provider: "missing", model: "missing" } }]) {
    const { svc } = fakeService(options);
    try {
      const { id, internal } = liveTask(svc);
      const record = (svc as any).recordMemory(internal, { ...base, task: id });
      await svc.flushMemoryDrafts();
      assert.equal(svc.memoryInsights().drafting, 0);
      const summary = svc.memoryInsights().memories.find((row) => row.id === record.id)!;
      assert.equal(summary.draft, "template");
      assert.equal(summary.drafting, false);
      assert.equal(svc.listTaskMemories(id)[0].drafting, false);
      assert.ok(svc.readTaskMemory(id, record.id)?.content.includes(base.conclusion));
      const other = liveTask(svc, "另一单");
      assert.ok(!(svc as any).memoryCandidates(other.internal).some((row: any) => row.id === record.id));
      svc.reviewTaskMemory(id, record.id, "本地用户", { decision: "accepted", revision: record.revision ?? 1 });
      assert.ok((svc as any).memoryCandidates(other.internal).some((row: any) => row.id === record.id));
    } finally { await svc.shutdown(); }
  }
});


test("重启读取已持久化的模板记忆，没有作业时仍如实显示已记录", async () => {
  const first = fakeService();
  const { id, internal } = liveTask(first.svc);
  const record = (first.svc as any).recordMemory(internal, { ...base, task: id });
  await first.svc.shutdown();
  const second = fakeService({ dataDir: first.dataDir });
  try {
    const insights = second.svc.memoryInsights();
    assert.equal(insights.drafting, 0);
    assert.equal(insights.memories.find((row) => row.id === record.id)?.drafting, false);
    assert.equal(insights.memories.find((row) => row.id === record.id)?.draft, "template");
  } finally { await second.svc.shutdown(); }
});

test("Agent 无 sidecar 也能写记忆并展开；归属和来源由宿主固定", async () => {
  const { svc } = fakeService();
  const { id, internal } = liveTask(svc);
  const tools = (svc as any).memoryTools(internal) as any[];
  const write = tools.find(tool => tool.name === "corpus_write");
  assert.ok(write);
  await write.execute("call-memory-1", { trigger: "首次编译", conclusion: "先加载仓库环境脚本。",
    repo: "another-repo", task: "another-task", judged_by: "human" });
  const records = svc.listTaskMemories(id);
  assert.equal(records.length, 1);
  assert.equal(records[0].repo, "notify-service");
  assert.equal(records[0].task, id);
  assert.equal(records[0].source, "agent_note");
  assert.equal(records[0].judged_by, "agent");
  assert.equal(records[0].evidence, "agent:call-memory-1");
  assert.equal(records[0].drafting, false);
  const expand = tools.find(tool => tool.name === "knowledge");
  assert.match((await expand.execute("pending", { action: "read", id: records[0].id })).content[0].text, /取不到/);
  svc.reviewTaskMemory(id, records[0].id, "本地用户", { decision: "accepted", revision: records[0].revision ?? 1 });
  const result = await expand.execute("expand-1", { action: "read", id: records[0].id });
  assert.match(result.content[0].text, /先加载仓库环境脚本/);
  internal.summary.repo_url = "git@example.com:demo/other.git";
  const denied = await expand.execute("expand-2", { action: "read", id: records[0].id });
  assert.match(denied.content[0].text, /取不到/);
});

test("平台记忆跨仓推送和展开，当前使命驱动检索，旧 general 不扩大范围", async () => {
  const { svc } = fakeService();
  const api = svc as any;
  try {
    const { internal } = liveTask(svc);
    const store = api.memories() as MemoryStore;
    const platform = store.record({ ...base, source: "agent_note", judged_by: "agent",
      scope: "platform", repo: "other-repo", paths: ["absent/in/this/repo"],
      trigger: "多仓共用工具链报错时", conclusion: "核对平台工具链约定" });
    const local = store.record({ ...base, scope: "general", repo: "other-repo" });
    const retired = store.record({ ...base, scope: "platform", source: "user_note", author: "owner" });
    for (const row of [platform, local, retired]) store.review(row.id, "owner", { decision: "accepted", revision: 1 });
    store.withdraw(retired.id, "owner");
    assert.ok(platform.file.startsWith("_platform/"));
    assert.equal(platform.repo, "other-repo", "保留原始来源仓库");
    assert.ok(api.memoryCandidates(internal).some((row: any) => row.id === platform.id));
    assert.ok(!api.memoryCandidates(internal).some((row: any) => row.id === local.id));
    const queries: string[] = [];
    api.memorySidecar = { available: true, search: async (input: any) => {
      queries.push(input.query);
      return [platform, local, retired].map(row => ({ id: row.id, score: 1, snippet: "过期索引内容" }));
    }, stop() {} };
    internal.mission = "当前处理平台工具链证书失效";
    internal.pendingMainSteers = ["责任人补充：使用新版工具链"];
    const messages = await api.taskMemoryContext(internal)([{role: "user", content: "继续当前工作"}]);
    const briefing = messages.at(-1).content;
    assert.match(queries[0], /证书失效/);
    assert.match(queries[0], /新版工具链/);
    assert.match(briefing, /平台通用.*Agent 记录/);
    assert.match(briefing, /核对平台工具链约定/);
    const hits = await api.memorySearch(internal, { query: "工具链" });
    assert.deepEqual(hits.map((hit: any) => hit.id), [platform.id]);
    const expand = api.memoryTools(internal).find((tool: any) => tool.name === "knowledge");
    assert.match((await expand.execute("expand-platform", { action: "read", id: platform.id })).content[0].text,
      /核对平台工具链约定/);
    assert.match((await expand.execute("expand-retired", { action: "read", id: retired.id })).content[0].text, /取不到/);
    const usage = svc.listTaskMemoryUsage(internal.summary.id);
    assert.ok(usage.some(row => row.moment === "context" && String(row.query).includes("证书失效")));
  } finally { await svc.shutdown(); }
});

test("模型前台遇到侧车未就绪时不启动或等待冷启动", async () => {
  const { svc } = fakeService();
  const api = svc as any;
  try {
    const { internal } = liveTask(svc);
    let calls = 0;
    api.memorySidecar = { available: false, start: async () => { calls++; return false; },
      search: async () => { calls++; return []; }, stop() {} };
    const messages = [{role: "user", content: "开始工作"}];
    assert.deepEqual(await api.taskMemoryContext(internal)(messages), messages);
    assert.equal(calls, 0);
    assert.equal(svc.listTaskMemoryUsage(internal.summary.id).at(-1)?.status, "unavailable");
  } finally { await svc.shutdown(); }
});


test("交付复盘跟随任务主模型，未指定时使用平台主模型", async () => {
  const { svc } = fakeService({ provider: "main", model: "default", modelsJson: {
    providers: { main: { models: [{ id: "default" }, { id: "chosen" }] } },
  }, memoryDraftModel: { provider: "obsolete", model: "ignored" } });
  try {
    const { internal } = liveTask(svc);
    internal.summary.model_choice = { provider: "main", model: "chosen" };
    const coordinator = (svc as any).deliveryExperiences;
    assert.deepEqual(coordinator.options(internal).model.choice, {provider:"main",model:"chosen"});
    delete internal.summary.model_choice;
    assert.deepEqual(coordinator.options(internal).model.choice, {provider:"main",model:"default"});
    assert.equal(internal.summary.status, "running");
  } finally { await svc.shutdown(); }
});
