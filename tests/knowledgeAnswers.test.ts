import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeAnswers, KnowledgeAnswerError } from "../src/knowledgeAnswers.ts";
import type { KnowledgeAnswerRecord, KnowledgeAnswerRunner } from "../src/knowledgeAnswerTypes.ts";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";

const pause = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function finished(service: KnowledgeAnswers, id: string, owner = "alice"): Promise<KnowledgeAnswerRecord> {
  for (let n = 0; n < 200; n++) { const record = service.get(id, owner); if (!["queued", "running"].includes(record.status)) return record; await pause(); }
  throw new Error("问答未结束");
}
const fixture = () => mkdtempSync(join(tmpdir(), "knowledge-answers-"));

test("删除本人问答会停止执行并移除历史，排队及迟到结果不重建文件，其他资料保留", async () => {
  const dir = fixture(), started: string[] = [];
  let release!: () => void, runningSignal: AbortSignal | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const shared = join(dir, "original.md"); writeFileSync(shared, "共享原件");
  const service = new KnowledgeAnswers(dir, async input => {
    started.push(input.record.question);
    if (input.record.question === "运行中") {
      runningSignal = input.signal; await pending;
      assert.throws(() => input.progress("answering", "迟到进度"));
      assert.throws(() => input.addEvidence({ kind: "material", title: "迟到来源", content: "正文" }));
    }
    if (input.record.question === "失败") throw new Error("测试失败");
    return { markdown: "未取得资料", evidence_ids: [], unknowns: ["资料待补充"] };
  }, { concurrency: 1 });
  try {
    const running = service.create({ question: "运行中" }, "alice").record;
    const queued = service.create({ question: "排队中" }, "alice").record;
    const other = service.create({ question: "其他人" }, "bob").record;
    for (let n = 0; n < 100 && !runningSignal; n++) await pause();
    assert.throws(() => service.remove(running.id, "bob"), (error: KnowledgeAnswerError) => error.status === 404);
    assert.equal(runningSignal?.aborted, false);
    service.remove(queued.id, "alice"); service.remove(running.id, "alice");
    assert.equal(runningSignal?.aborted, true);
    assert.deepEqual(service.list("alice"), []);
    assert.throws(() => service.get(running.id, "alice"), (error: KnowledgeAnswerError) => error.status === 404);
    assert.equal((await finished(service, other.id, "bob")).status, "done", "删除运行问答后及时释放并发位置");
    release(); await pause();
    assert.equal(existsSync(join(dir, "knowledge-answers", running.id)), false);
    assert.equal(existsSync(join(dir, "knowledge-answers", queued.id)), false);
    assert.deepEqual(started, ["运行中", "其他人"]);
    const failed = service.create({ question: "失败" }, "alice").record;
    assert.equal((await finished(service, failed.id)).status, "failed");
    service.remove(failed.id, "alice"); service.remove(other.id, "bob");
    await service.shutdown();
    const restored = new KnowledgeAnswers(dir, async () => { throw new Error("删除记录不能恢复"); });
    assert.deepEqual(restored.list("alice"), []); assert.deepEqual(restored.list("bob"), []);
    await restored.shutdown();
    assert.equal(readFileSync(shared, "utf8"), "共享原件");
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("#471 长引用答案完成并落盘，重启后可读取完整原文和行范围链接", async () => {
  const dir = fixture(), original = "实际规则。".repeat(600) + "\n末尾例外不得省略。";
  let executions = 0;
  const run: KnowledgeAnswerRunner = async input => {
    executions++;
    const sources = Array.from({ length: 8 }, (_, index) => input.addEvidence({ kind: "knowledge", title: `规则 ${index + 1}`, content: original, source_id: `rule-${index}` }));
    return parseKnowledgeAnswerComposition(JSON.stringify({ points: sources.map(source => ({
      kind: "answer", body: `依据 ${source.title} 的完整结论。`, basis: [{ evidence_id: source.id, start_line: 1, end_line: 2 }],
    })) }), sources);
  };
  let service = new KnowledgeAnswers(dir, run);
  try {
    const start = service.create({ question: "多份规则的适用条件是什么？" }, "alice").record;
    const done = await finished(service, start.id);
    assert.equal(done.status, "done", done.error);
    assert.ok(JSON.stringify(done.answer).length <= 24_000);
    assert.equal(done.answer!.evidence_ids.length, 8);
    const summary = service.list("alice")[0];
    assert.deepEqual(Object.keys(summary).sort(), ["created_at", "id", "question", "stage", "status", "updated_at"]);
    assert.ok(JSON.stringify(summary).length < 500);
    assert.ok(JSON.stringify(done).length > 20_000);
    assert.match(done.answer!.markdown, /第 1–2 行/);
    await service.shutdown();
    service = new KnowledgeAnswers(dir, run);
    const restored = service.get(start.id, "alice");
    assert.equal(restored.status, "done");
    assert.deepEqual(restored.answer, done.answer);
    assert.deepEqual(restored.evidence, done.evidence);
    for (const source of restored.evidence) assert.equal(source.content, original);
    assert.equal(executions, 1);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("问答持久保存真实来源，检查完成前没有答案，各人记录隔离", async () => {
  const dir = fixture(); let release!: () => void;
  const checking = new Promise<void>(resolve => { release = resolve; });
  const service = new KnowledgeAnswers(dir, async input => {
    input.progress("researching", "读取测试规则");
    const source = input.addEvidence({ kind: "knowledge", title: "规则", content: "只有条件 A 成立才执行 B", revision: "v1", source_id: "rule-1" });
    input.progress("checking", "核对条件"); await checking;
    return { markdown: `条件 A 成立才执行 B。[规则](#evidence-${source.id})`, evidence_ids: [source.id], unknowns: [] };
  });
  try {
    const start = service.create({ question: "什么情况下执行 B？", owner: "bob" }, "alice").record;
    for (let n = 0; n < 100 && service.get(start.id, "alice").stage !== "checking"; n++) await pause();
    const current = service.get(start.id, "alice");
    assert.equal(current.stage, "checking"); assert.equal(current.answer, undefined); assert.equal(current.owner, "alice");
    assert.equal(service.list("bob").length, 0);
    assert.throws(() => service.get(start.id, "bob"), (error: KnowledgeAnswerError) => error.status === 404);
    current.evidence[0].content = "客户端更改";
    assert.equal(service.get(start.id, "alice").evidence[0].content, "只有条件 A 成立才执行 B");
    release(); const done = await finished(service, start.id);
    assert.equal(done.status, "done"); assert.ok(done.answer!.markdown.includes("条件 A"));
    assert.ok(done.evidence[0].digest); assert.ok(done.evidence[0].retrieved_at);
    service.feedback(start.id, "alice", { useful: false, comment: "请核对例外" });
    await service.shutdown();
    const restored = new KnowledgeAnswers(dir, async () => { throw new Error("不应重跑已完成记录"); });
    assert.deepEqual(restored.get(start.id, "alice").evidence, done.evidence);
    assert.equal(restored.get(start.id, "alice").feedback?.comment, "请核对例外"); await restored.shutdown();
  } finally { release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("来源编号在问答内稳定，按实际内容和范围去重；重启保留引用与旧 hash 编号", async () => {
  const dir = fixture();
  const original = { kind: "knowledge" as const, title: "交易重试规则", content: "仅在条件 A 成立时重试。", source_id: "rule-1", revision: "v1", scope: "交易模块" };
  const run: KnowledgeAnswerRunner = async input => {
    const first = input.addEvidence(original);
    const duplicate = input.addEvidence({ scope: original.scope, revision: original.revision, source_id: original.source_id, content: original.content, title: original.title, kind: original.kind });
    assert.deepEqual(duplicate, first, "属性顺序不同的相同资料沿用原编号和查阅时间");
    const second = input.addEvidence({ ...original, content: "条件 A 不成立时不重试。" });
    const revision = input.addEvidence({ ...original, revision: "v2" });
    const scope = input.addEvidence({ ...original, scope: "支付模块" });
    assert.equal(input.record.evidence.length, 4, "重复读取不增加来源数，内容或版本或范围变化分别保留");
    const sources = [first, second, revision, scope];
    assert.deepEqual(sources.map(source => source.id), ["ev-1", "ev-2", "ev-3", "ev-4"]);
    for (const source of sources) {
      assert.match(source.digest, /^[a-f0-9]{64}$/);
      assert.equal(source.digest, createHash("sha256").update(source.content).digest("hex"), "短编号不替代完整原文校验摘要");
    }
    assert.equal(revision.digest, first.digest); assert.equal(scope.digest, first.digest);
    return { markdown: sources.map(source => `[${source.title} ${source.revision} ${source.scope}](#evidence-${source.id})`).join("\n\n"), evidence_ids: sources.map(source => source.id), unknowns: [] };
  };
  let service = new KnowledgeAnswers(dir, run);
  try {
    const current = service.create({ question: "当前规则和例外分别是什么？" }, "alice").record;
    const done = await finished(service, current.id);
    assert.equal(done.status, "done", done.error);
    const old = service.create({ question: "旧问答记录" }, "alice").record;
    const legacy = await finished(service, old.id);
    assert.equal(legacy.status, "done", legacy.error);
    await service.shutdown();
    const ids = new Map<string, string>();
    legacy.evidence = legacy.evidence.map(source => {
      const { id, digest, retrieved_at, ...input } = source;
      const oldId = `ev-${createHash("sha256").update(JSON.stringify({ ...input, digest })).digest("hex").slice(0, 20)}`;
      ids.set(id, oldId); return { ...input, id: oldId, digest, retrieved_at };
    });
    legacy.answer!.markdown = legacy.answer!.markdown.replace(/#evidence-(ev-\d+)/g, (_match, id: string) => `#evidence-${ids.get(id)}`);
    legacy.answer!.evidence_ids = legacy.answer!.evidence_ids.map(id => ids.get(id)!);
    const legacyFile = join(dir, "knowledge-answers", legacy.id, "record.json");
    const legacyBytes = `${JSON.stringify(legacy, null, 2)}\n`;
    writeFileSync(legacyFile, legacyBytes);
    service = new KnowledgeAnswers(dir, async () => { throw new Error("恢复历史不应重新运行"); });
    const restored = service.get(current.id, "alice");
    assert.equal(restored.status, "done");
    assert.deepEqual(restored.evidence, done.evidence);
    assert.deepEqual(restored.answer, done.answer, "重启保留短编号、引用链接和查阅快照");
    const restoredLegacy = service.get(legacy.id, "alice");
    assert.equal(restoredLegacy.status, "done");
    assert.deepEqual(restoredLegacy.evidence, legacy.evidence);
    assert.deepEqual(restoredLegacy.answer, legacy.answer, "旧 hash 编号与引用仍可读取");
    assert.equal(readFileSync(legacyFile, "utf8"), legacyBytes, "读取旧记录不迁移或改写编号");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("停止和超时不会被迟到答案覆盖；错误引用不得写成完成", async () => {
  const dir = fixture(); let late!: () => void;
  const running = new Promise<void>(resolve => { late = resolve; });
  const service = new KnowledgeAnswers(dir, async input => { await running; return { markdown: "迟到结果", evidence_ids: [], unknowns: [] }; });
  try {
    const start = service.create({ question: "问题" }, "alice").record;
    await pause(); service.cancel(start.id, "alice"); late(); await pause();
    assert.equal(service.get(start.id, "alice").status, "cancelled"); assert.equal(service.get(start.id, "alice").answer, undefined);
    const timeout = new KnowledgeAnswers(join(dir, "timeout"), async () => new Promise(() => {}), { timeoutMs: 15 });
    const timed = timeout.create({ question: "超时问题" }, "alice").record;
    assert.equal((await finished(timeout, timed.id)).status, "failed"); await timeout.shutdown();
    const bad = new KnowledgeAnswers(join(dir, "bad"), async () => ({ markdown: "凭空引用", evidence_ids: ["missing"], unknowns: [] }));
    const invalid = bad.create({ question: "错误引用" }, "alice").record;
    assert.equal((await finished(bad, invalid.id)).status, "failed"); assert.equal(bad.get(invalid.id, "alice").answer, undefined); await bad.shutdown();
  } finally { late(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("小鲁班消息去重跨重启保存，消息冲突和账号隔离均核对", async () => {
  const dir = fixture(); let executions = 0;
  const run: KnowledgeAnswerRunner = async () => { executions++; return { markdown: "尚未取得资料，无法确认", evidence_ids: [], unknowns: ["资料缺失"] }; };
  let service = new KnowledgeAnswers(dir, run);
  try {
    const input = { question: "相同问题", context: { module_ids: ["b", "a"] } }, integration = { kind: "luban" as const, message_id: "message-1" };
    const first = service.create(input, "alice", integration);
    assert.equal(service.create({ question: input.question, context: { module_ids: ["a", "b"] } }, "alice", integration).record.id, first.record.id);
    assert.throws(() => service.create({ question: "另一条问题" }, "alice", integration), (error: KnowledgeAnswerError) => error.status === 409);
    await finished(service, first.record.id); await service.shutdown();
    service = new KnowledgeAnswers(dir, run);
    assert.equal(service.create(input, "alice", integration).replayed, true); assert.equal(executions, 1);
    assert.notEqual(service.create(input, "bob", integration).record.id, first.record.id);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("排队有并发与单人上限，非法输入不会启动模型", async () => {
  const dir = fixture(); const pending: Array<() => void> = []; let started = 0;
  const service = new KnowledgeAnswers(dir, async () => { started++; await new Promise<void>(resolve => pending.push(resolve)); return { markdown: "未确认", evidence_ids: [], unknowns: ["暂无原文"] }; }, { concurrency: 1 });
  try {
    assert.throws(() => service.create({ question: "" }, "alice"));
    assert.throws(() => service.create({ question: "问题", context: { material_ids: "any" } }, "alice"));
    const first = service.create({ question: "一" }, "alice").record;
    service.create({ question: "二" }, "alice"); service.create({ question: "三" }, "alice");
    assert.throws(() => service.create({ question: "四" }, "alice"), (error: KnowledgeAnswerError) => error.status === 429);
    await pause(); assert.equal(started, 1);
    pending.shift()!(); await finished(service, first.id); await pause(); assert.equal(started, 2);
  } finally { for (const release of pending) release(); await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("写盘失败也会中止全部执行，取消不会等待保存成功", async () => {
  const dir = fixture(), signals: AbortSignal[] = [];
  const service = new KnowledgeAnswers(dir, async input => { signals.push(input.signal); return new Promise(() => {}); });
  const blockRecord = (id: string) => { const path = join(dir, "knowledge-answers", id, "record.json"); rmSync(path); mkdirSync(path); };
  try {
    const first = service.create({ question: "一" }, "alice").record, second = service.create({ question: "二" }, "bob").record;
    for (let n = 0; n < 100 && signals.length < 2; n++) await pause();
    assert.equal(signals.length, 2);
    blockRecord(first.id);
    assert.throws(() => service.cancel(first.id, "alice"));
    assert.equal(signals[0].aborted, true, "保存失败不能阻止取消模型");
    blockRecord(second.id);
    await assert.rejects(service.shutdown(), /记录未能保存/);
    assert.equal(signals[1].aborted, true, "关闭仍中止其他执行");
    assert.equal(service.get(first.id, "alice").status, "cancelled"); assert.equal(service.get(second.id, "bob").status, "failed");
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("恢复时损坏记录不影响其他历史，失败记录残留草稿不可展示", async () => {
  const dir = fixture();
  let service = new KnowledgeAnswers(dir, async () => ({ markdown: "尚无依据", evidence_ids: [], unknowns: ["资料未取得"] }));
  try {
    const good = service.create({ question: "可恢复" }, "alice").record, bad = service.create({ question: "时间损坏" }, "alice").record;
    const draft = service.create({ question: "残留草稿" }, "bob").record;
    await finished(service, good.id); await finished(service, bad.id); await finished(service, draft.id, "bob"); await service.shutdown();
    const alter = (id: string, change: (record: KnowledgeAnswerRecord) => void) => {
      const file = join(dir, "knowledge-answers", id, "record.json"), record = JSON.parse(readFileSync(file, "utf8")); change(record); writeFileSync(file, JSON.stringify(record));
    };
    alter(bad.id, record => { record.created_at = null as any; });
    alter(draft.id, record => { record.status = "failed"; record.answer = { markdown: "未经核对的草稿", evidence_ids: [], unknowns: [] }; });
    service = new KnowledgeAnswers(dir, async () => { throw new Error("终态不可自动重跑"); });
    assert.deepEqual(service.list("alice").map(record => record.id), [good.id]);
    assert.equal(service.get(draft.id, "bob").answer, undefined);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});

test("开始与完成写盘失败都不会留下无人执行的运行状态或未保存答案", async () => {
  const dir = fixture(); let executions = 0;
  const service = new KnowledgeAnswers(dir, async input => {
    executions++;
    const path = join(dir, "knowledge-answers", input.record.id, "record.json"); rmSync(path); mkdirSync(path);
    return { markdown: "暂未确认", evidence_ids: [], unknowns: ["暂无依据"] };
  });
  try {
    const early = service.create({ question: "运行前写盘失败" }, "alice").record;
    const path = join(dir, "knowledge-answers", early.id, "record.json"); rmSync(path); mkdirSync(path);
    assert.equal((await finished(service, early.id)).status, "failed"); assert.equal(executions, 0);
    const late = service.create({ question: "完成时写盘失败" }, "alice").record;
    assert.equal((await finished(service, late.id)).status, "failed"); assert.equal(service.get(late.id, "alice").answer, undefined);
    assert.equal(executions, 1);
  } finally { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
