import assert from "node:assert/strict";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledge } from "../src/domainKnowledgeAgent.ts";
import { ComponentResearch } from "../src/componentResearch.ts";
import { runComponentResearch } from "../src/componentResearchAgent.ts";
import { saveComponentRepository } from "../src/componentRepositories.ts";

const TOTAL = 48 * 60 * 60_000;
const EXPECTED = "已达研究总预算 48 小时，本轮停止；可在审查当前草稿后发起更新";
const model = () => ({ provider: "fixture", model: "fixture", json: {} });
async function flush() { for (let i = 0; i < 5; i++) await setImmediate(); }

for (const action of ["budget", "human"] as const) {
  test(`生产线验收2/9（F18）：领域${action === "budget" ? "48小时预算到期说清原因与下一步" : "人工停止保留原取消语义"}，原草稿保留`, { timeout: 5_000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = mkdtempSync(join(tmpdir(), "production-domain-total-budget-"));
    let entered!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const session = t.mock.method(CloudSession, "create", async () => ({
      start: () => new Promise((_, fail) => { reject = fail; entered(); }),
      abort: async () => { reject?.(new DOMException("This operation was aborted", "AbortError")); }, dispose() {},
    }) as any);
    const service = new DomainKnowledgeExtraction(root, input => {
      input.save({ id: "rules", title: "订单规则", target_id: "domain", path: `${input.job.knowledge_target.docs_path}/rules.md`, layer: "domain", content: "# 已保存的草稿\n订单取消需核对。", sources: "已有研究证据" });
      return runDomainKnowledge(input, { dataDir: root, model, source: async () => { throw new Error("本用例不读取源码"); } });
    });
    const job = service.create({ title: "订单", scope: "取消", issue_no: "REQ-1", repositories: [] }, "alice");
    try {
      await started;
      if (action === "budget") {
        t.mock.timers.tick(TOTAL - 1); await flush(); assert.equal(service.get(job.id).status, "running");
        t.mock.timers.tick(1); await flush();
        assert.equal(service.get(job.id).status, "failed"); assert.equal(service.get(job.id).error, EXPECTED);
        assert.equal(service.get(job.id).turns[0].error, EXPECTED);
      } else {
        service.stop(job.id); await flush(); assert.equal(service.get(job.id).status, "cancelled");
        assert.doesNotMatch(service.get(job.id).error ?? "", /研究总预算|48 小时/);
      }
      assert.equal(service.get(job.id).documents[0].content, "# 已保存的草稿\n订单取消需核对。");
      assert.equal(service.get(job.id).documents[0].path, `${job.knowledge_target.docs_path}/rules.md`);
    } finally {
      const closing = service.shutdown(); reject?.(new Error("fixture cleanup")); t.mock.timers.tick(60_000); await flush(); await closing;
      session.mock.restore(); rmSync(root, { recursive: true, force: true }); t.mock.timers.reset();
    }
  });
}

for (const action of ["budget", "human"] as const) {
  test(`生产线验收2/9（F18）：组件${action === "budget" ? "48小时预算到期说清原因与下一步" : "人工停止保留原取消语义"}，原草稿保留`, { timeout: 5_000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const root = mkdtempSync(join(tmpdir(), "production-component-total-budget-")), ec = join(root, "ec"), previousEc = process.env.MAE_FLOW_EC_BIN;
    writeFileSync(ec, `#!${process.execPath}\nconsole.log('fixture ec tools');\n`, { mode: 0o700 }); process.env.MAE_FLOW_EC_BIN = ec;
    seedTechnologyStacks(root, ["java"]);
    saveComponentRepository(root, { name: "基础库", repository: "https://example.test/base.git", branch: "main", path: "src", languages: ["java"] }, "alice");
    let entered!: () => void, reject!: (error: Error) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const service = new ComponentResearch(root, input => {
      input.record.document = { overview: "# 已保存的组件草稿", sections: [] }; input.update({ document: input.record.document });
      return runComponentResearch(input, { dataDir: root, model,
        source: async (_component, _operator, signal) => new Promise<{ root: string; revision: string }>((_, fail) => {
          reject = fail; signal!.addEventListener("abort", () => fail(new DOMException("This operation was aborted", "AbortError")), { once: true }); entered();
        }) });
    });
    const job = service.start({ language: "java" }, "alice");
    try {
      await started;
      if (action === "budget") {
        t.mock.timers.tick(TOTAL - 1); await flush(); assert.equal(service.get(job.id).status, "running");
        t.mock.timers.tick(1); await flush();
        assert.equal(service.get(job.id).status, "failed"); assert.equal(service.get(job.id).error, EXPECTED);
      } else {
        service.stop(job.id); await flush(); assert.equal(service.get(job.id).status, "cancelled");
        assert.doesNotMatch(service.get(job.id).error ?? "", /研究总预算|48 小时/);
      }
      assert.equal(service.get(job.id).document?.overview, "# 已保存的组件草稿");
    } finally {
      const closing = service.shutdown(); reject?.(new Error("fixture cleanup")); t.mock.timers.tick(60_000); await flush(); await closing;
      if (previousEc === undefined) delete process.env.MAE_FLOW_EC_BIN; else process.env.MAE_FLOW_EC_BIN = previousEc;
      rmSync(root, { recursive: true, force: true }); t.mock.timers.reset();
    }
  });
}
