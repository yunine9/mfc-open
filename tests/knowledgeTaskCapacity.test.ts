import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { TaskService } from "../src/taskService.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { skillExtractionTask } from "../src/knowledgeTaskCenter.ts";
import type { ExtractionJobRecord } from "../src/knowledgeExtraction.ts";
import type { DomainExecution } from "../src/domainKnowledgeTypes.ts";
import type { ResearchExecution } from "../src/componentResearch.ts";

async function flush() { for (let i = 0; i < 12; i++) await setImmediate(); }

test("三类知识任务合计并发 50，第 51 个排队；完成、失败和人工确认释放同一额度", async t => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-capacity-"));
  const service = new TaskService({ dataDir: dir, provider: "", model: "", modelsJson: {} });
  const holds = new Map<string, { finish: () => void; fail: () => void }>();
  let active = 0, peak = 0;
  const hold = async (id: string, signal?: AbortSignal) => {
    active++; peak = Math.max(peak, active);
    try {
      await new Promise<void>((resolve, reject) => {
        holds.set(id, { finish: resolve, fail: () => reject(new Error("模拟执行失败")) });
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    } finally { active--; holds.delete(id); }
  };
  t.mock.method(service as any, "activeModelChoice", () => ({ provider: "fixture", model: "fixture" }));
  t.mock.method(service as any, "runSkillExtraction", async (record: ExtractionJobRecord) => {
    await hold(record.id); record.status = "done"; record.finished_at = new Date().toISOString();
  });
  const domain = service.getDomainKnowledgeExtraction(), component = service.getComponentResearch();
  t.mock.method(domain as any, "execute", async (input: DomainExecution) => {
    await hold(input.job.id, input.signal);
    return { status: "paused", summary: "请审阅后确认", document_ids: [] };
  });
  t.mock.method(component as any, "execute", async (input: ResearchExecution) => {
    await hold(input.record.id, input.signal); return "组件草稿";
  });
  const domainInput = (i: number) => ({ title: `领域 ${i}`, scope: `规则 ${i}`, issue_no: "REQ-50", repositories: [],
    knowledge_target: { repository: "https://example.test/knowledge.git", branch: "main", docs_path: "domains" } });
  seedTechnologyStacks(dir, ["cpp"]);
  const componentIds = Array.from({ length: 21 }, (_, i) => saveComponentRepository(dir, {
    name: `组件 ${i}`, repository: `https://example.test/component-${i}.git`, branch: "main", path: "", languages: ["cpp"],
  }, "alice").id);
  const skill = (i: number) => service.startSkillExtraction({ repo: "https://example.test/reference.git", intent: `参考规则 ${i}`, operator: "alice" });
  try {
    const domains = Array.from({ length: 20 }, (_, i) => domain.create(domainInput(i), "alice"));
    const components = componentIds.slice(0, 20).map(repository_id => component.start({ repository_ids: [repository_id], language: "cpp" }, "bob"));
    const skills = Array.from({ length: 10 }, (_, i) => skill(i));
    await flush();
    assert.equal(active, 50); assert.equal(peak, 50);
    assert.ok([...domains, ...components, ...skills].every(job => job.status === "running"));

    const queuedComponent = component.start({ repository_ids: [componentIds[20]], language: "cpp" }, "bob");
    assert.equal(queuedComponent.status, "queued");
    holds.get(skills[0].id)!.finish(); await flush();
    assert.equal(component.get(queuedComponent.id).status, "running", "Skill 完成后可唤醒组件任务");
    assert.equal(active, 50);

    const queuedSkill = skill(10);
    assert.equal(queuedSkill.status, "queued"); assert.equal(queuedSkill.started_at, undefined);
    assert.equal(skillExtractionTask(queuedSkill).status_label, "排队中");
    const stored = JSON.parse(readFileSync(join(dir, "knowledge-extract", queuedSkill.id, "job.json"), "utf8"));
    assert.equal(stored.status, "queued", "排队事实可刷新读取");
    holds.get(components[0].id)!.fail(); await flush();
    assert.equal(component.get(components[0].id).status, "failed");
    assert.equal(service.skillExtractionJob(queuedSkill.id)!.status, "running", "组件失败后可唤醒 Skill 制作");
    assert.ok(service.skillExtractionJob(queuedSkill.id)!.started_at);
    assert.equal(active, 50);

    const queuedDomains = Array.from({ length: 55 }, (_, i) => domain.create(domainInput(i + 20), "carol"));
    assert.ok(queuedDomains.every(job => job.status === "queued"), "排队超过 50 也能继续创建，不限制历史或待执行任务总数");
    holds.get(domains[0].id)!.finish(); await flush();
    assert.equal(domain.get(domains[0].id).status, "paused");
    assert.equal(domain.get(queuedDomains[0].id).status, "running", "等待人工确认不占执行名额");
    assert.equal(active, 50); assert.equal(peak, 50, "三类合计从未超过 50");
  } finally {
    const closing = service.shutdown();
    for (const work of holds.values()) work.finish();
    await closing; await flush();
    assert.equal(active, 0);
    rmSync(dir, { recursive: true, force: true });
  }
});
