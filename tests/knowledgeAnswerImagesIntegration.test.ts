import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";
import { visionProbePng } from "../src/visionCapability.ts";
import { KnowledgeAnswers } from "../src/knowledgeAnswers.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { LocalAuth } from "../src/auth.ts";
import { parseKnowledgeAnswerComposition } from "../src/knowledgeAnswerComposition.ts";

test("历史图片问答：取消新附件后仍保留历史来源核对与本人访问权限", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-answer-images-"));
  const materialRoot = join(dir, "knowledge-materials"), png = visionProbePng();
  const digest = createHash("sha256").update(png).digest("hex");
  const material = await saveKnowledgeMaterial(materialRoot, { name: "图示.md", content_base64: Buffer.from("# 图示\n![色块](blocks.png)").toString("base64") });
  material.images = [{ id: digest, path: "blocks.png", mimeType: "image/png", bytes: png.length }];
  mkdirSync(join(materialRoot, material.id, "images"));
  writeFileSync(join(materialRoot, material.id, "images", digest), png);
  writeFileSync(join(materialRoot, material.id, "material.json"), JSON.stringify(material));
  const record = { id: "qa-00000000-0000-0000-0000-000000000001", owner: "alice", question: "图中有哪几个色块？",
    context: { material_ids: [material.id] }, status: "done", stage: "done", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    activity: [], warnings: [], evidence: [{ id: "ev-1", kind: "material", title: "历史图片", content: "历史图片原件", source_id: material.id,
      digest: createHash("sha256").update("历史图片原件").digest("hex"), retrieved_at: new Date().toISOString(), image: { path: "blocks.png", digest, mime_type: "image/png" } }],
    answer: { markdown: "图中有色块。[图片](#evidence-ev-1)", evidence_ids: ["ev-1"], unknowns: [] } };
  mkdirSync(join(dir, "knowledge-answers", record.id), { recursive: true });
  writeFileSync(join(dir, "knowledge-answers", record.id, "record.json"), JSON.stringify(record));
  const answers = new KnowledgeAnswers(dir, async () => { throw new Error("不能重新运行历史问答"); });
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "fixture-admin-password");
  auth.createUser("alice", "fixture-alice-password", "developer");
  auth.createUser("bob", "fixture-bob-password", "developer");
  const server = createTaskServer(service, { auth, knowledgeAnswers: answers });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(async () => { await answers.shutdown(); await service.shutdown(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (name: string) => (await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: name, password: `fixture-${name}-password` }) })).headers.get("set-cookie")!.split(";")[0];
  const alice = await login("alice"), bob = await login("bob");
  const saved = answers.get(record.id, "alice");
  assert.equal(saved.status, "done", saved.error);
  assert.throws(() => answers.create({ question: "新的图片问题", context: { material_ids: [material.id] } }, "alice"), /不再接受临时附件/);
  const endpoint = `${base}/knowledge-answers/${record.id}/evidence/${saved.evidence[0].id}/image`;
  const own = await fetch(endpoint, { headers: { cookie: alice } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await own.arrayBuffer()), png);
  assert.equal((await fetch(endpoint, { headers: { cookie: bob } })).status, 404);
  assert.equal((await fetch(endpoint)).status, 401);
  assert.throws(() => parseKnowledgeAnswerComposition(JSON.stringify({ points: [{ kind: "answer", body: "不能冒充文字原句", basis: [{ evidence_id: saved.evidence[0].id, start_line: 1, end_line: 1 }] }] }), saved.evidence), /不能伪造/);
  writeFileSync(join(materialRoot, material.id, "images", digest), "changed");
  assert.equal((await fetch(endpoint, { headers: { cookie: alice } })).status, 400, "损坏或被替换的原图不能冒充当次证据");
  assert.equal(JSON.parse(readFileSync(join(dir, "knowledge-answers", record.id, "record.json"), "utf8")).evidence[0].image.digest, digest);
});
