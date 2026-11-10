import assert from "node:assert/strict";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { listKnowledgeDocumentVersions, readKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { componentPublicationExecute } from "./fixtures/componentPublicationWorker.ts";

async function bounded<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 5_000); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function body(record: ResearchRecord) {
  return { title: "文件组件正式指南", document_id: record.document_id ?? null, update_document_id: record.update_document_id ?? null,
    update_document_revision: record.update_document_revision,
    sections: record.document!.sections.filter(section => section.selected).map(section => ({ id: section.id, revision: section.revision, proposal_id: null })),
    };
}
async function fixture() {
  const dir = fs.mkdtempSync(join(tmpdir(), "knowledge-component-intent-rollback-"));
  seedTechnologyStacks(dir, ["cpp"]);
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("发布意图不能运行模型"); }, {
    publish: async (job, target) => ({ target_id: target.id, state: "opened", branch: "codex/component-intent", url: "https://example.test/mr/1", mr_id: 1,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) }),
  });
  const research = new ComponentResearch(dir, componentPublicationExecute, undefined, id => manager.componentArchive(id));
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const originalComponent = service.getComponentResearch(), originalDomain = service.getDomainKnowledgeExtraction();
  (service as any).componentResearch = research; (service as any).domainKnowledgeExtraction = manager;
  const server = createTaskServer(service);
  saveComponentRepository(dir, { name: "文件组件", repository: "https://example.test/file.git", branch: "main", path: "src", languages: ["cpp"] }, "alice");
  const initial = research.start({ language: "cpp" }, "alice");
  await until(() => research.get(initial.id).status === "done", "草稿未在5秒预算完成");
  const firstRecord = research.publish(initial.id, body(research.get(initial.id)) as any, "alice");
  const first = readKnowledgeDocument(dir, firstRecord.document_id!);
  const updating = research.beginUpdate(initial.id, "editor"), section = updating.document!.sections[0];
  research.editSection(initial.id, { section: { ...section, content: `${section.content}\n正式B新增的等待超时规则` }, base_revision: section.revision }, "editor");
  await bounded(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), "版本restore HTTP启动超过5秒预算");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const recordPath = join(dir, "component-research", initial.id, "record.json"), formalPath = join(dir, "knowledge-documents", `${first.id}.json`);
  return { dir, research, manager, first, id: initial.id, recordPath, formalPath, base,
    async close() {
      await bounded(Promise.all([research.shutdown(), manager.shutdown(), originalComponent.shutdown(), originalDomain.shutdown(), service.shutdown()]), "发布恢复夹具关停超过5秒预算");
      server.closeAllConnections(); await bounded(new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())), "版本restore HTTP关闭超过5秒预算");
      fs.rmSync(dir, { recursive: true, force: true });
    } };
}

for (const boundary of ["record"] as const) test(`生产线验收10/14（F8）：正式A更新到B后${boundary}提交EIO，人通过合法restore回A，恢复不得重装B或抹掉人工历史`, { timeout: 20_000 }, async t => {
  const f = await fixture(); let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      const path = String(args[1]);
      if (boundary === "record" && path === f.recordPath) {
        const record = JSON.parse(fs.readFileSync(args[0], "utf8"));
        if (record.document_id && record.published_revision !== f.first.revision) throw Object.assign(new Error("正式B后的文稿EIO"), { code: "EIO" });
      }
      return rename(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => f.research.publish(f.id, body(f.research.get(f.id)) as any, "editor"), /EIO/);
    const second = readKnowledgeDocument(f.dir, f.first.id); assert.notEqual(second.revision, f.first.revision); assert.match(second.content, /正式B新增/);
    assert.ok(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).publication_intent);
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    const response = await fetch(`${f.base}/knowledge-documents/${f.first.id}/restore`, { method: "POST", body: JSON.stringify({ revision: f.first.revision, expected_revision: second.revision }), signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, await response.clone().text());
    const restored = readKnowledgeDocument(f.dir, f.first.id); assert.equal(restored.revision, f.first.revision); assert.deepEqual(restored.content, f.first.content);
    assert.equal(restored.history.length, second.history.length + 1); const bytes = fs.readFileSync(f.formalPath, "utf8");
    f.research.recoverPublications();
    assert.equal(fs.readFileSync(f.formalPath, "utf8"), bytes, "恢复必须保留人工restore后的内容、元信息和历史，不能再安装冻结B");
    assert.deepEqual(readKnowledgeDocument(f.dir, f.first.id).history, restored.history);
    assert.ok(f.research.warnings().some(warning => warning.includes(f.id) && /新版本|人工|变化|历史|覆盖/.test(warning)), "回到旧内容也是新的人为事实，必须点名解释冲突");
    assert.ok(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).publication_intent);
    assert.equal(f.manager.componentArchive(f.id), undefined, "发布与恢复均不能创建归档任务");
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});

test("生产线验收10/14（F8）：更新B仅意图耐久而正式仍为原A精确历史时，恢复允许首次提交B，不把版本缓存误当已安装", { timeout: 20_000 }, async t => {
  const f = await fixture(); let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const before = fs.readFileSync(f.formalPath, "utf8"), rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === f.formalPath) throw Object.assign(new Error("正式B尚未安装EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    assert.throws(() => f.research.publish(f.id, body(f.research.get(f.id)) as any, "editor"), /EIO/);
    assert.equal(fs.readFileSync(f.formalPath, "utf8"), before);
    const intent = JSON.parse(fs.readFileSync(f.recordPath, "utf8")).publication_intent;
    assert.equal(intent.formal.previous_revision, f.first.revision); assert.notEqual(intent.formal.document.revision, f.first.revision);
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    f.research.recoverPublications();
    const second = readKnowledgeDocument(f.dir, f.first.id);
    assert.equal(second.revision, intent.formal.document.revision); assert.match(second.content, /正式B新增/);
    assert.equal(second.history.length, f.first.history.length + 1); assert.equal(listKnowledgeDocumentVersions(f.dir, f.first.id).length, 2);
    assert.equal(JSON.parse(fs.readFileSync(f.recordPath, "utf8")).publication_intent, undefined); assert.deepEqual(f.research.warnings(), []);
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await f.close(); }
});
