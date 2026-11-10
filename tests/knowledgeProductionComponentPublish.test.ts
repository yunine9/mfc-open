import assert from "node:assert/strict";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ComponentResearch, type ResearchRecord } from "../src/componentResearch.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { componentRepositories, saveComponentRepository } from "../src/componentRepositories.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { eraseKnowledgeDocument, listKnowledgeDocuments, listKnowledgeDocumentVersions, readKnowledgeDocument, saveKnowledgeDocument } from "../src/knowledgeDocuments.ts";
import { writeKnowledgeDeletion } from "../src/knowledgeDeletionStore.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { componentPublicationExecute } from "./fixtures/componentPublicationWorker.ts";

const temporary = () => fs.mkdtempSync(join(tmpdir(), "knowledge-component-publish-"));
const recordPath = (dir: string, id: string) => join(dir, "component-research", id, "record.json");
const disk = (dir: string, id: string) => JSON.parse(fs.readFileSync(recordPath(dir, id), "utf8"));
async function within<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function input(record: ResearchRecord, options: Record<string, unknown> = {}) {
  return { title: "经过审查的组件知识", document_id: record.document_id ?? null, update_document_id: record.update_document_id ?? null,
    update_document_revision: record.update_document_revision,
    sections: record.document!.sections.filter(section => section.selected).map(section => ({ id: section.id, revision: section.revision,
      proposal_id: [...record.review_turns ?? []].reverse().find(turn => turn.section_id === section.id && turn.proposal?.status === "pending")?.id ?? null })), ...options };
}
async function publish(research: ComponentResearch, manager: DomainKnowledgeExtraction, id: string, body: unknown) {
  const action = (research as unknown as { publish?: (id: string, input: unknown, operator: string) => ResearchRecord | Promise<ResearchRecord> }).publish;
  assert.equal(typeof action, "function", "组件发布必须提供服务端单次公开操作");
  return within(Promise.resolve(action!.call(research, id, body, "reviewer")), 5_000, "组件发布超过5秒测试预算");
}
async function recover(research: ComponentResearch, manager: DomainKnowledgeExtraction) {
  const action = (research as unknown as { recoverPublications?: () => void | Promise<void> }).recoverPublications;
  assert.equal(typeof action, "function", "服务启动必须补完耐久组件发布意图");
  await within(Promise.resolve(action!.call(research)), 5_000, "组件发布恢复超过5秒测试预算");
}
function managers(dir: string) {
  const manager = new DomainKnowledgeExtraction(dir, async () => { throw new Error("组件发布不能启动领域模型"); }, {
    publish: async (job, target) => ({ target_id: target.id, state: "opened", branch: `codex/component-${job.component_research_id}`, url: "https://example.test/mr/1", mr_id: 1,
      documents: job.documents.map(document => ({ id: document.id, path: document.path, content: document.content, revision: document.revision,
        knowledge_document_id: document.knowledge_document_id, knowledge_revision: document.published_revision })) }),
  });
  const research = new ComponentResearch(dir, componentPublicationExecute, undefined, id => manager.componentArchive(id));
  return { research, manager };
}
async function seed(dir: string, research: ComponentResearch) {
  seedTechnologyStacks(dir, ["cpp"]);
  // 每次播种指定新的参考来源范围，得到独立的研究记录用于验证发布。
  const index = componentRepositories(dir).length;
  const component = saveComponentRepository(dir, { name: index ? `文件组件 ${index}` : "文件组件", repository: `https://example.test/component${index || ""}.git`, branch: "main", path: "src", languages: ["cpp"] }, "alice");
  const record = research.start({ language: "cpp", repository_ids: [component.id]}, "alice");
  await until(() => research.get(record.id).status === "done", "组件测试草稿未在5秒内完成");
  return research.get(record.id);
}
async function proposal(research: ComponentResearch, id: string, sectionId: string, message: string) {
  research.review(id, { section_id: sectionId, mode: "rework", message }, "alice");
  await until(() => research.get(id).status === "done", "组件修订建议未在5秒内完成");
  return research.get(id);
}
async function close(research: ComponentResearch, manager: DomainKnowledgeExtraction) {
  await within(Promise.all([research.shutdown(), manager.shutdown()]), 5_000, "组件测试管理器关停超过5秒预算");
}

test("生产线验收10/14（F8/D4）：一个真实 HTTP publish 接受全部所选最新建议，只写平台且不建归档或 MR，未选原稿保留", { timeout: 20_000 }, async () => {
  const dir = temporary(), { research, manager } = managers(dir);
  const host = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const previousResearch = host.getComponentResearch(), previousManager = host.getDomainKnowledgeExtraction();
  (host as any).componentResearch = research; (host as any).domainKnowledgeExtraction = manager;
  const server = createTaskServer(host);
  try {
    let record = await seed(dir, research);
    research.selectSections(record.id, ["cap-2"], false);
    for (const id of ["cap-0", "cap-1", "cap-2"]) record = await proposal(research, record.id, id, `仅修订 ${id}`);
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "组件 HTTP 启动超过5秒预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(`${base}/component-research/${record.id}/publish`, { method: "POST", body: JSON.stringify(input(record)), signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as ResearchRecord;
    assert.equal(result.id, record.id); assert.ok(result.document_id); assert.ok(result.production);
    const formal = readKnowledgeDocument(dir, result.document_id!);
    assert.match(formal.content, /本轮修订：仅修订 cap-0/); assert.match(formal.content, /本轮修订：仅修订 cap-1/); assert.doesNotMatch(formal.content, /能力 2|仅修订 cap-2/);
    assert.equal(result.review_turns!.find(turn => turn.section_id === "cap-0")!.proposal!.status, "accepted");
    assert.equal(result.review_turns!.find(turn => turn.section_id === "cap-1")!.proposal!.status, "accepted");
    assert.equal(result.review_turns!.find(turn => turn.section_id === "cap-2")!.proposal!.status, "pending", "未选能力的建议与原稿保留，不被单路发布吞掉");
    assert.equal(result.published_revision, formal.revision);
    assert.equal(manager.componentArchive(record.id), undefined, "平台发布不能创建归档任务、归档批次或 MR");
    assert.equal(listKnowledgeDocumentVersions(dir, formal.id).length, 1, "同次平台发布不能再写一遍正式库而生成另一版本");
    assert.equal(disk(dir, record.id).publication_intent, undefined);
  } finally {
    await close(research, manager); await close(previousResearch, previousManager); await within(host.shutdown(), 5_000, "组件 HTTP 宿主关停超过5秒预算");
    if (server.listening) await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "组件 HTTP 关停超过5秒预算");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B5验收1/生产线验收10/14：组件只保留耐久publish写入口，旧adopt返回404且不写正式库", { timeout: 20_000 }, async () => {
  const dir = temporary(), { research, manager } = managers(dir);
  const host = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {}, maxConcurrent: 0 });
  const previousResearch = host.getComponentResearch(), previousManager = host.getDomainKnowledgeExtraction();
  (host as any).componentResearch = research; (host as any).domainKnowledgeExtraction = manager;
  const server = createTaskServer(host);
  try {
    const record = await seed(dir, research);
    await within(new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }), 5_000, "单路发布HTTP启动超过预算");
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const old = await fetch(`${base}/component-research/${record.id}/adopt`, { method: "POST", body: JSON.stringify({ title: "旧入口不可发布", scope: "platform" }), signal: AbortSignal.timeout(5_000) });
    assert.equal(old.status, 404, "旧发布入口必须退役，不做代理");
    assert.equal(listKnowledgeDocuments(dir).length, 0);
    const response = await fetch(`${base}/component-research/${record.id}/publish`, { method: "POST", body: JSON.stringify(input(record)), signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, await response.clone().text());
    const published = await response.json() as ResearchRecord;
    assert.equal(listKnowledgeDocuments(dir).length, 1);
    assert.equal(readKnowledgeDocument(dir, published.document_id!).research_source?.job_id, record.id);
  } finally {
    await close(research, manager); await close(previousResearch, previousManager); await within(host.shutdown(), 5_000, "单路发布宿主关停超过预算");
    if (server.listening) await within(new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }), 5_000, "单路发布HTTP关停超过预算");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("生产线验收10/14（F8）：后一个所选建议基线冲突时全体预检失败，前一个建议、正式库和原记录字节都不改", { timeout: 15_000 }, async () => {
  const dir = temporary(), { research, manager } = managers(dir);
  try {
    let record = await seed(dir, research);
    record = await proposal(research, record.id, "cap-0", "第一项正确建议");
    record = await proposal(research, record.id, "cap-1", "第二项旧基线建议");
    const section = record.document!.sections[1];
    research.editSection(record.id, { section: { ...section, content: section.content + "\n人工先保存的新内容" }, base_revision: section.revision }, "expert");
    record = research.get(record.id);
    const before = fs.readFileSync(recordPath(dir, record.id), "utf8");
    await assert.rejects(publish(research, manager, record.id, input(record)), /基线|章节已有新版本|冲突/);
    assert.equal(fs.readFileSync(recordPath(dir, record.id), "utf8"), before, "不能先接受第一项再在第二项报错");
    assert.equal(listKnowledgeDocuments(dir).length, 0); assert.equal(manager.componentArchive(record.id), undefined);
    assert.ok(research.get(record.id).review_turns!.every(turn => turn.proposal?.status === "pending"));
  } finally { await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收10/14（F8）：选择全集、显式null建议及最新建议ID漂移均拒绝，精确正式绑定不能伪造或丢失", { timeout: 20_000 }, async () => {
  const dir = temporary(), { research, manager } = managers(dir);
  try {
    let record = await seed(dir, research);
    const old = input(record);
    record = await proposal(research, record.id, "cap-0", "发布前新增的建议");
    const valid = input(record), sections = valid.sections;
    for (const body of [old, { ...valid, sections: sections.slice(1) }, { ...valid, sections: [...sections, sections[0]] },
      { ...valid, sections: sections.map(section => ({ id: section.id, revision: section.revision })) }, { ...valid, document_id: "kd-00000000-0000-0000-0000-000000000000" }]) {
      const before = fs.readFileSync(recordPath(dir, record.id), "utf8");
      await assert.rejects(publish(research, manager, record.id, body), /建议|选择|清单|绑定|版本/);
      assert.equal(fs.readFileSync(recordPath(dir, record.id), "utf8"), before); assert.equal(listKnowledgeDocuments(dir).length, 0);
    }
  } finally { await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收10/14（F8）：未配置 Git 时一次发布只入正式库，没有归档任务且后续更新沿用标题、模块、元信息与版本", { timeout: 20_000 }, async () => {
  const dir = temporary(), { research, manager } = managers(dir);
  try {
    const module = createBusinessModule(dir, { id: "orders", name: "订单", description: "组件知识的模块归属", owner: "alice", repositories: ["https://example.test/orders.git"] }, "alice");
    let record = await seed(dir, research);
    record = await publish(research, manager, record.id, input(record, { title: "订单组件正式标题", scope: "module", module_ids: [module.id], when_to_use: "订单异常处理", product_versions: ["product-v1"] }));
    const first = readKnowledgeDocument(dir, record.document_id!);
    assert.equal(record.production?.status_label, "已发布（未归档）"); assert.ok(record.production?.archive.actions.some(action => action.id === "archive"));
    assert.equal(manager.componentArchive(record.id), undefined); assert.equal(manager.componentArchive(record.id)?.archive_batches?.length ?? 0, 0);
    const updated = research.beginUpdate(record.id, "editor");
    const section = updated.document!.sections[0]; research.editSection(record.id, { section: { ...section, content: section.content + "\n新增错误回收规则" }, base_revision: section.revision }, "editor");
    record = await publish(research, manager, record.id, input(research.get(record.id), { title: first.title }));
    const second = readKnowledgeDocument(dir, record.document_id!);
    assert.equal(second.id, first.id); assert.notEqual(second.revision, first.revision); assert.equal(second.history.length, first.history.length + 1);
    for (const key of ["title", "scope", "module_ids", "repositories", "product_versions", "when_to_use"] as const) assert.deepEqual(second[key], first[key], `更新不能丢掉 ${key}`);
    assert.equal(listKnowledgeDocuments(dir).length, 1); assert.equal(listKnowledgeDocumentVersions(dir, first.id).length, 2);
    assert.equal(second.research_source?.job_id, record.id); assert.equal(disk(dir, record.id).publication_intent, undefined);
  } finally { await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const window of ["intent", "formal", "record"] as const) {
  test(`生产线验收10/14（F8）：${window}耐久边界后真 kill -9，重启补完原正式ID/版本并清除意图，不创建归档`, { timeout: 25_000,
    skip: !constants.signals.SIGSTOP || !constants.signals.SIGKILL ? "当前系统不支持 POSIX SIGSTOP/SIGKILL，不能验证真 kill -9" : false }, async () => {
    const dir = temporary(), initial = managers(dir);
    let restarted: ReturnType<typeof managers> | undefined;
    let child: ReturnType<typeof spawn> | undefined, closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let output = "";
    try {
      const record = await seed(dir, initial.research);
      fs.writeFileSync(join(dir, "publication-request.json"), JSON.stringify(input(record)));
      await close(initial.research, initial.manager);
      child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/componentPublicationWorker.ts", import.meta.url)), "--component-publish-worker", dir, record.id, window], { stdio: ["ignore", "pipe", "pipe"] });
      const append = (chunk: Buffer) => { if (output.length < 8192) output += chunk.toString("utf8").slice(0, 8192 - output.length); };
      child.stdout?.on("data", append); child.stderr?.on("data", append);
      closed = new Promise((resolve, reject) => { child!.once("error", reject); child!.once("close", (code, signal) => resolve({ code, signal })); });
      void closed.catch(() => undefined);
      await until(() => {
        if (fs.existsSync(join(dir, "publication-cut.json"))) return true;
        if (child!.exitCode !== null || child!.signalCode !== null) throw new Error(`子进程未到达 ${window} 边界：${output}`);
        return false;
      }, `子进程未在5秒内到达 ${window} 边界：${output}`);
      assert.equal(child.kill("SIGKILL"), true); assert.equal((await within(closed, 5_000, "组件 SIGKILL 子进程超过5秒退出预算")).signal, "SIGKILL");
      const raw = disk(dir, record.id), intent = raw.publication_intent;
      if (window === "record") assert.equal(intent, undefined, "最终记录写入后发布已结束");
      else assert.ok(intent, "正式记录写成之前耐久意图仍保留");
      if (intent) assert.ok(intent.formal?.document.id && intent.formal.document.revision, "首次正式写入之前意图已经确定精确正式ID与版本，不能在重启后重算");
      assert.equal(intent?.record.production, undefined, "接受后文稿快照不持久化只读状态投影");
      assert.equal(intent?.record.publication_intent, undefined, "意图不能把自己嵌套进文稿快照");
      const before = listKnowledgeDocuments(dir), originalId = before[0]?.id, originalRevision = before[0]?.revision;
      restarted = managers(dir);
      await recover(restarted.research, restarted.manager);
      const recovered = restarted.research.get(record.id), formal = readKnowledgeDocument(dir, recovered.document_id!);
      assert.equal(formal.id, intent?.formal.document.id ?? raw.document_id); assert.equal(formal.revision, intent?.formal.document.revision ?? raw.published_revision);
      assert.equal(listKnowledgeDocuments(dir).length, 1); if (originalId) assert.equal(formal.id, originalId); if (originalRevision) assert.equal(formal.revision, originalRevision);
      assert.equal(recovered.published_revision, formal.revision); assert.equal(listKnowledgeDocumentVersions(dir, formal.id).length, 1);
      assert.equal(restarted.manager.componentArchive(record.id), undefined);
      assert.equal(disk(dir, record.id).publication_intent, undefined);
      const snapshot = JSON.stringify(formal);
      await recover(restarted.research, restarted.manager);
      assert.equal(JSON.stringify(readKnowledgeDocument(dir, formal.id)), snapshot); assert.equal(restarted.manager.componentArchive(record.id), undefined);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (closed) await within(closed, 5_000, "组件子进程清理超过5秒退出预算");
      if (restarted) await close(restarted.research, restarted.manager);
      await close(initial.research, initial.manager); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("生产线验收10/14（F8）：文稿写盘失败后显式开始新修订清除旧意图，新草稿与新正式版本不能被旧发布重放覆盖", { timeout: 15_000 }, async t => {
  const dir = temporary(), { research, manager } = managers(dir);
  let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const record = await seed(dir, research), rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === recordPath(dir, record.id) && JSON.parse(fs.readFileSync(args[0], "utf8")).document_id) throw Object.assign(new Error("新修订前文稿 EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(publish(research, manager, record.id, input(record)), /EIO/);
    const first = readKnowledgeDocument(dir, research.get(record.id).document_id!);
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    const updating = research.beginUpdate(record.id, "editor");
    assert.equal(disk(dir, record.id).publication_intent, undefined, "显式新修订必须终止旧意图重放");
    assert.equal(updating.update_document_id, first.id); assert.equal(updating.update_document_revision, first.revision);
    const section = updating.document!.sections[0];
    research.editSection(record.id, { section: { ...section, content: `${section.content}\n人工新修订不会被旧意图覆盖` }, base_revision: section.revision }, "editor");
    const complete = await publish(research, manager, record.id, input(research.get(record.id)));
    const current = readKnowledgeDocument(dir, complete.document_id!);
    assert.equal(current.id, first.id); assert.notEqual(current.revision, first.revision); assert.match(current.content, /人工新修订不会被旧意图覆盖/);
    assert.equal(complete.update_document_id, undefined); assert.equal(complete.production?.review.readonly, true);
    assert.equal(manager.componentArchive(record.id), undefined);
    await recover(research, manager); assert.deepEqual(readKnowledgeDocument(dir, first.id), JSON.parse(JSON.stringify(current)));
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收10（F8）：正式成功而文稿提交 EIO 时读取真实磁盘投影已入库未归档，仅有意图但正式未写不冒称入库", { timeout: 15_000 }, async t => {
  const dir = temporary(), { research, manager } = managers(dir);
  let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    const record = await seed(dir, research), rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (/[\\/]knowledge-documents[\\/]kd-[a-f0-9-]{36}\.json$/.test(String(args[1]))) throw Object.assign(new Error("正式尚未提交 EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(publish(research, manager, record.id, input(record)), /EIO/);
    assert.ok(disk(dir, record.id).publication_intent); assert.equal(listKnowledgeDocuments(dir).length, 0);
    const beforeFormal = research.get(record.id);
    assert.equal(beforeFormal.production?.knowledge_document_id, undefined); assert.equal(beforeFormal.production?.status_label, "待审查");
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === recordPath(dir, record.id) && JSON.parse(fs.readFileSync(args[0], "utf8")).document_id) throw Object.assign(new Error("正式已提交但文稿提交 EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(publish(research, manager, record.id, input(beforeFormal)), /EIO/);
    const persisted = disk(dir, record.id), formal = readKnowledgeDocument(dir, persisted.publication_intent.formal.document.id);
    assert.equal(persisted.document_id, undefined, "文稿提交 EIO 是真实耐久边界，不能靠提前改内存冒充成功");
    const projected = research.get(record.id);
    assert.equal(projected.production?.knowledge_document_id, formal.id); assert.equal(projected.published_revision, formal.revision);
    assert.equal(projected.production?.status_label, "已发布（未归档）"); assert.ok(projected.production?.archive.actions.some(action => action.id === "archive"));
    assert.equal(projected.production?.review.readonly, true);
    assert.equal(disk(dir, record.id).document_id, undefined, "只读投影不得为了显示状态补写 record");
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收10/14（F8）：正式提交事务未完成时编辑、选择、讨论与建议操作全部拒绝，仅显式新修订可废弃旧意图", { timeout: 15_000 }, async t => {
  const dir = temporary(), { research, manager } = managers(dir);
  let renameMock: ReturnType<typeof t.mock.method> | undefined;
  try {
    let record = await seed(dir, research); record = await proposal(research, record.id, "cap-0", "已预检的正式修订");
    const rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === recordPath(dir, record.id) && JSON.parse(fs.readFileSync(args[0], "utf8")).document_id) throw Object.assign(new Error("禁止覆盖新稿的文稿 EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(publish(research, manager, record.id, input(record)), /EIO/);
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    const before = fs.readFileSync(recordPath(dir, record.id), "utf8"), section = record.document!.sections[0], turn = record.review_turns!.at(-1)!;
    const actions = [
      () => research.selectSections(record.id, [section.id], false),
      () => research.editSection(record.id, { section: { ...section, content: `${section.content}\n不能被旧意图吞掉的人改` }, base_revision: section.revision }, "editor"),
      () => research.review(record.id, { section_id: section.id, mode: "discuss", message: "事务未完成时不要另起讨论" }, "editor"),
      () => research.review(record.id, { section_id: section.id, mode: "rework", message: "事务未完成时不要另起返工" }, "editor"),
      () => research.decideProposal(record.id, turn.id, "accept", "editor"),
      () => research.decideProposal(record.id, turn.id, "discard", "editor"),
      () => research.retry(record.id, "editor"),
    ];
    for (const action of actions) {
      assert.throws(action, /发布.*未完成|未完成.*发布|补建归档|新修订/);
      assert.equal(fs.readFileSync(recordPath(dir, record.id), "utf8"), before, "拒绝必须在任何文稿落盘或研究启动前完成");
    }
    await recover(research, manager);
    const complete = research.get(record.id), formal = readKnowledgeDocument(dir, complete.document_id!);
    assert.match(formal.content, /已预检的正式修订/); assert.doesNotMatch(formal.content, /不能被旧意图吞掉的人改/);
    assert.equal(disk(dir, record.id).publication_intent, undefined); assert.equal(complete.review_turns!.length, record.review_turns!.length);
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收10/14（F8）：未完成发布时显式删除研究任务保留正式来源，读取和启动恢复均不得复活被隐藏任务", { timeout: 15_000 }, async t => {
  const dir = temporary(), initial = managers(dir);
  let renameMock: ReturnType<typeof t.mock.method> | undefined, restarted: ReturnType<typeof managers> | undefined;
  try {
    const record = await seed(dir, initial.research), rename = fs.renameSync;
    renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
      if (String(args[1]) === recordPath(dir, record.id) && JSON.parse(fs.readFileSync(args[0], "utf8")).document_id) throw Object.assign(new Error("删除前文稿提交 EIO"), { code: "EIO" });
      return rename(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(publish(initial.research, initial.manager, record.id, input(record)), /EIO/);
    const formal = listKnowledgeDocuments(dir)[0]; assert.ok(formal);
    renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
    assert.deepEqual(initial.research.remove(record.id, "expert"), { deleted: true });
    assert.ok(initial.research.get(record.id).deleted_at); assert.equal(initial.research.get(record.id).deleted_by, "expert");
    assert.equal(initial.research.list().length, 0); const hidden = fs.readFileSync(recordPath(dir, record.id), "utf8");
    await recover(initial.research, initial.manager); assert.equal(fs.readFileSync(recordPath(dir, record.id), "utf8"), hidden);
    await close(initial.research, initial.manager); restarted = managers(dir); await recover(restarted.research, restarted.manager);
    assert.equal(restarted.research.list().length, 0); assert.ok(restarted.research.get(record.id).deleted_at);
    assert.equal(fs.readFileSync(recordPath(dir, record.id), "utf8"), hidden); assert.deepEqual(readKnowledgeDocument(dir, formal.id), JSON.parse(JSON.stringify(formal)));
    assert.equal(formal.research_source?.job_id, record.id); assert.equal(restarted.manager.componentArchive(record.id), undefined);
  } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); if (restarted) await close(restarted.research, restarted.manager); await close(initial.research, initial.manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("生产线验收3/10/14（F8）：publication意图坏形状启动逐条隔离并点名，保留坏字节及正常相邻草稿", { timeout: 15_000 }, async () => {
  const dir = temporary(), initial = managers(dir);
  let restarted: ReturnType<typeof managers> | undefined;
  try {
    const good = await seed(dir, initial.research);
    const malformed: Array<{ id: string; bytes: string }> = [];
    for (const intent of [null, { formal: { document: { id: "not-a-formal-id", revision: "unknown" } }, record: {}, archive_input: null }]) {
      const record = await seed(dir, initial.research);
      const bytes = JSON.stringify({ ...disk(dir, record.id), publication_intent: intent });
      fs.writeFileSync(recordPath(dir, record.id), bytes); malformed.push({ id: record.id, bytes });
    }
    await close(initial.research, initial.manager);
    restarted = managers(dir);
    await recover(restarted.research, restarted.manager);
    assert.deepEqual(restarted.research.list().map(record => record.id), [good.id]);
    for (const item of malformed) {
      assert.equal(fs.readFileSync(recordPath(dir, item.id), "utf8"), item.bytes, "坏意图不能被迁移、删除或改成另一状态");
      assert.ok(restarted.research.warnings().some(warning => warning.includes(`component-research/${item.id}/record.json`)), "告警必须点名意图所在原文件");
    }
    assert.equal(restarted.research.get(good.id).status, "done"); assert.equal(listKnowledgeDocuments(dir).length, 0);
  } finally { if (restarted) await close(restarted.research, restarted.manager); await close(initial.research, initial.manager); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const conflict of ["newer", "deleted"] as const) {
  test(`生产线验收10/14（F8）：正式已写但record落盘 EIO 后遇到${conflict === "newer" ? "第三版本" : "知识删除"}，恢复不覆盖或复活也不归档过期版本`, { timeout: 15_000 }, async t => {
    const dir = temporary(), { research, manager } = managers(dir);
    let renameMock: ReturnType<typeof t.mock.method> | undefined;
    try {
      const record = await seed(dir, research), rename = fs.renameSync;
      renameMock = t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
        if (String(args[1]) === recordPath(dir, record.id)) {
          const next = JSON.parse(fs.readFileSync(args[0], "utf8"));
          if (next.document_id) throw Object.assign(new Error("研究记录耐久写测试 EIO"), { code: "EIO" });
        }
        return rename(...args);
      });
      syncBuiltinESMExports();
      await assert.rejects(publish(research, manager, record.id, input(record)), /EIO/);
      const formal = listKnowledgeDocuments(dir)[0]; assert.ok(formal); assert.ok(disk(dir, record.id).publication_intent);
      renameMock.mock.restore(); renameMock = undefined; syncBuiltinESMExports();
      let expected: ReturnType<typeof readKnowledgeDocument> | undefined;
      if (conflict === "newer") expected = saveKnowledgeDocument(dir, { ...formal, content: formal.content + "\n其他人的正式更新" }, "expert", formal.id, { expectedRevision: formal.revision });
      else { writeKnowledgeDeletion(dir, { id: formal.id, title: formal.title, revision: formal.revision, operator: "expert", at: new Date().toISOString(), research_job_id: record.id, index_ids: [], index_state: "removed" }); eraseKnowledgeDocument(dir, formal.id); }
      await recover(research, manager);
      if (expected) assert.deepEqual(readKnowledgeDocument(dir, formal.id), JSON.parse(JSON.stringify(expected))); else assert.throws(() => readKnowledgeDocument(dir, formal.id), /已删除/);
      assert.ok(disk(dir, record.id).publication_intent, "冲突不能清除未完成事实");
      assert.ok(research.warnings().some(warning => warning.includes(record.id) && /新版本|删除|变化|覆盖/.test(warning)), "恢复失败必须点名任务并解释第三版本/删除边界");
      assert.equal(manager.componentArchive(record.id)?.archive_batches?.length ?? 0, 0, "冲突版本不得入新归档批次");
    } finally { renameMock?.mock.restore(); syncBuiltinESMExports(); await close(research, manager); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
