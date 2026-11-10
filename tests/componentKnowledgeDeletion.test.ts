import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { consumptionFixture } from "./componentConsumptionFixture.ts";
import { componentDeletionView, deleteComponentDocuments } from "../src/componentKnowledgeDeletion.ts";
import { listKnowledgeDeletions } from "../src/knowledgeDeletionStore.ts";
import { listKnowledgeDocuments, readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { KnowledgeSearch } from "../src/knowledgeSearch.ts";
import { componentKnowledgeCatalog } from "../src/componentKnowledgeCatalog.ts";
import { componentKnowledgeArtifacts } from "../src/componentKnowledgeArtifacts.ts";
import { componentKnowledgeRoute } from "../src/componentKnowledgeRoutes.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";

const mirror = (dir: string, id: string) => join(dir, "corpus", "_knowledge", `${createHash("sha256").update(id).digest("hex")}.md`);
function seedMirror(dir: string, id: string) { const path = mirror(dir, id); mkdirSync(join(dir, "corpus", "_knowledge"), { recursive: true }); writeFileSync(path, `---\nknowledge_id: "${id}"\nasset_status: published\n---\n# 线程池\n使用线程池执行后台任务。\n`); return path; }

test("删除历史与新版组件知识：正文、派生检查、全文副本的索引一并退出，其他资料保留", async () => {
  const f = consumptionFixture();
  try {
    const current = f.publish(), legacy = saveKnowledgeDocument(f.data, { title: "历史组件知识", content: "旧格式正文", active: false, research_source: { job_id: "cr-old" } }, "user");
    const ordinary = saveKnowledgeDocument(f.data, { title: "业务资料", content: "业务规则" }, "user");
    const mapping = componentKnowledgeCatalog(f.data, f.context).paradigms[0].mapping_id;
    const paths = [current.id, legacy.id].map(id => seedMirror(f.data, id));
    const kept = seedMirror(f.data, ordinary.id), removed: string[] = [];
    const search = new KnowledgeSearch(f.data, { remove: async (path: string) => { assert.equal(existsSync(path), false); removed.push(path); return true; } } as any);
    const selected = [current, legacy].map(({ id, revision }) => ({ id, revision }));
    assert.equal(componentDeletionView(f.data).documents.length, 2);
    assert.equal((await deleteComponentDocuments(f.data, selected, "owner", search)).pending.length, 0);
    assert.deepEqual(new Set(removed), new Set(paths)); assert.ok(existsSync(kept));
    assert.deepEqual(listKnowledgeDocuments(f.data).map(d => d.id), [ordinary.id]);
    assert.equal(existsSync(join(f.data, "knowledge-documents", `${current.id}.json`)), false);
    assert.throws(() => readKnowledgeDocument(f.data, current.id), /已删除/);
    assert.throws(() => saveKnowledgeDocument(f.data, { active: true }, "late", current.id), /已删除/);
    assert.throws(() => saveKnowledgeDocument(f.data, { ...legacy, source: { repository: "repo", branch: "main", path: "new.md", revision: "new" } }, "late-archive-sync"), /本次萃取的知识已删除/);
    assert.equal(search.read(f.context, current.id), undefined); assert.equal(componentKnowledgeCatalog(f.data, f.context).rules.length, 0);
    assert.throws(() => componentKnowledgeArtifacts(f.data, mapping), /停用|不存在/);
    assert.ok(listKnowledgeDeletions(f.data).every(d => d.operator === "owner" && d.index_state === "removed"));
    assert.equal((await deleteComponentDocuments(f.data, selected, "owner", search)).pending.length, 0, "重复请求幂等");
  } finally { f.cleanup(); }
});

test("索引离线时立即撤销知识并保留待清理状态；重启准备索引时重试，不恢复已删除正文", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), path = seedMirror(f.data, doc.id);
    const search = new KnowledgeSearch(f.data);
    const result = await deleteComponentDocuments(f.data, [doc], "owner", search);
    assert.equal(result.pending.length, 1); assert.equal(existsSync(path), false);
    assert.equal((await search.search(f.context, "后台任务")).hits.length, 0);
    let removals = 0, ingests = 0;
    const restored = new KnowledgeSearch(f.data, { remove: async (p: string) => { assert.equal(p, path); removals++; return true; }, ingest: async () => { ingests++; return true; } } as any);
    await restored.prepare(); assert.equal(removals, 1); assert.equal(ingests, 0);
    assert.equal(componentDeletionView(f.data).pending.length, 0); assert.equal(existsSync(path), false);
  } finally { f.cleanup(); }
});

test("整批校验版本及来源；删除接口列出旧格式知识，拒绝误删业务资料", async () => {
  const f = consumptionFixture();
  try {
    const doc = f.publish(), other = saveKnowledgeDocument(f.data, { title: "业务", content: "资料" }, "user");
    const search = new KnowledgeSearch(f.data, { remove: async () => true } as any);
    const service: any = { options: { dataDir: f.data }, getKnowledgeSearch: () => search };
    const route = async (name: string, body: any, method = "POST") => { let result: any;
      await componentKnowledgeRoute({ method } as any, {} as any, ["component-knowledge", name], service, "owner", async () => body, (_r, status, value) => result = { status, value }); return result; };
    assert.equal((await route("documents", {}, "GET")).value.documents[0].id, doc.id);
    assert.equal((await route("delete", { documents: [doc, { ...other, revision: "stale" }] })).status, 400);
    assert.equal((await route("delete", { documents: [{ id: doc.id, revision: "stale" }] })).status, 400);
    assert.equal(listKnowledgeDocuments(f.data).length, 2);
    assert.equal((await route("delete", { documents: [doc] })).status, 200);
    assert.equal((await route("retry-deletions", {})).status, 200);
  } finally { f.cleanup(); }
});

test("删除发生在旧格式知识索引途中：迟到完成和旧检索命中都不能恢复资料", async () => {
  const f = consumptionFixture(); let finish!: (ok: boolean) => void;
  try {
    const doc = saveKnowledgeDocument(f.data, { title: "旧组件", content: "后台任务", research_source: { job_id: "cr-old" } }, "user");
    const gate = new Promise<boolean>(resolve => { finish = resolve; }); let started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; });
    const search = new KnowledgeSearch(f.data, { ingest: async () => { started(); return gate; }, search: async () => [{ id: doc.id, snippet: "旧命中" }], remove: async () => true } as any);
    const query = search.search(f.context, "后台任务"); await begin;
    await deleteComponentDocuments(f.data, [doc], "owner", search); finish(true);
    assert.deepEqual((await query).hits, []); assert.equal(existsSync(mirror(f.data, doc.id)), false);
  } finally { finish?.(true); f.cleanup(); }
});

test("真实 memsearch 删除：索引后删除来源，重建索引与旧路径查询均不能恢复", { timeout: 60000 }, async t => {
  const python = process.env.MFC_MEMSEARCH_PYTHON;
  if (!python) return t.skip("设置 MFC_MEMSEARCH_PYTHON 运行真实 memsearch");
  const f = consumptionFixture();
  const sidecar = new MemorySidecar({ python, script: join(process.cwd(), "harness/memsearch-sidecar.py"), corpusDir: join(f.data, "corpus"), milvusPath: join(f.data, "index.db"), env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, budgets: { ingestMs: 20000 } });
  try {
    const doc = saveKnowledgeDocument(f.data, { title: "线程池", content: "# 线程池\n使用线程池执行后台任务，结束前等待所有任务完成。", research_source: { job_id: "cr-legacy" } }, "user");
    const service = new KnowledgeSearch(f.data, sidecar); await service.prepare();
    const path = mirror(f.data, doc.id);
    assert.ok(sidecar.indexedSections(path)! > 0, "真实数据库已有索引块");
    assert.ok(readFileSync(path, "utf8").includes(doc.id));
    const removed = await deleteComponentDocuments(f.data, [doc], "owner", service);
    assert.equal(removed.pending.length, 0, "只有确认数据库来源块为空才算完成");
    assert.equal(sidecar.indexedSections(path), undefined);
    assert.equal(await sidecar.reindex(), 0);
    assert.deepEqual(await sidecar.search({ query: "线程池", repo: "", sources: [{ id: doc.id, path }] }), []);
    assert.equal(await sidecar.remove(path), true, "重复删除确认数据库仍为空");
  } finally { sidecar.stop(); f.cleanup(); }
});
