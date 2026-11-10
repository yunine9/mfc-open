import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";

test("业务研究创建和继续均保留所有明确资料，解析失败不能静默跳过", async t => {
  const dir = mkdtempSync(join(tmpdir(), "domain-material-input-"));
  const root = join(dir, "knowledge-materials");
  const good = await saveKnowledgeMaterial(root, { name: "需求.md", content_base64: Buffer.from("业务约束").toString("base64") });
  const failed = await saveKnowledgeMaterial(root, { name: "损坏.txt", content_base64: Buffer.from([0xff]).toString("base64") });
  assert.equal(failed.state, "failed");
  let runs = 0;
  const service = new DomainKnowledgeExtraction(dir, async () => { runs++; return "本轮完成"; });
  t.after(async () => { await service.shutdown(); rmSync(dir, { recursive: true, force: true }); });
  const input = { issue_no: "REQ-materials", title: "资料研究", scope: "根据全部资料整理约束",
    repositories: [{ name: "交易", repository: "https://example.test/trade.git", branch: "main", docs_path: "docs/business" }],
    knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains/trade" } };
  assert.throws(() => service.create({ ...input, material_ids: [good.id, failed.id] }, "owner"), /损坏.txt.*解析失败/);
  assert.equal(runs, 0);
  const job = service.create({ ...input, material_ids: [good.id] }, "owner");
  service.stop(job.id);
  for (let n = 0; n < 200 && (service as any).running.has(job.id); n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((service as any).running.has(job.id), false);
  const initialRuns = runs;
  assert.throws(() => service.run(job.id, { mode: "extract", message: "继续整理", material_ids: [good.id, failed.id] }, "owner"), /损坏.txt.*解析失败/);
  assert.deepEqual(service.get(job.id).material_ids, [good.id]);
  assert.equal(runs, initialRuns);
});
