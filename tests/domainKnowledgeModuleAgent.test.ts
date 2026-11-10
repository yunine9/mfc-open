import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudSession } from "../src/sessionDriver.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { createBusinessModule } from "../src/businessModuleLibrary.ts";
import { runDomainKnowledgeFixture, genericDomainSkillFixture } from "./helpers/extractionSkillFixture.ts";

test("模块目录及业务身份进入主子会话和压缩上下文，越界保存先于 Git 读取被拒绝", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-module-agent-"));
  const sessions: string[] = [];
  let sourceCalls = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      sessions.push(context.step?.id ?? "coordinator");
      for (const value of [context, JSON.parse(config.compactAnchor())]) {
        // 模块任务 13ff28b7 起默认 directory-v1:代码仓知识落 docs/<业务名>。
        assert.equal(value.module_id, "trade"); assert.equal(value.knowledge_layout, "directory-v1");
        assert.equal(value.archive_targets.find((target: any) => target.id === "repo-1").docs_path, "docs/交易");
      }
      const call = async (name: string, args: unknown, error = false) => {
        const tool = config.extraTools.find((tool: any) => tool.name === name);
        assert.ok(tool);
        const response = await tool.execute("module-agent", args, new AbortController().signal);
        assert.equal(!!response.isError, error, JSON.stringify(response));
        try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
      };
      if (!context.step) {
        await call("knowledge_work", { action: "schedule", steps: [{ id: "write-trade", title: "保存交易模块知识",
          instructions: "在本模块目录保存已有研究结论", readonly: false, depends_on: [], expected_document_ids: ["trade-guide"] }] });
        await call("knowledge_work", { action: "run", id: "write-trade" });
        await call("knowledge_work_result", { summary: "模块研究已保存", document_ids: ["trade-guide"] });
      } else {
        const document = { id: "trade-guide", title: "交易规则", target_id: "repo-1", layer: "repository",
          content: "# 交易规则\n\n只适用于交易模块的取消入口。", sources: "已核对的交易源码" };
        for (const path of ["AGENTS.md", "docs/交易/AGENTS.md", "docs/payments/README.md", "docs/交易/../payments/README.md"]) {
          await call("knowledge_draft", { action: "save", document: { ...document, path } }, true);
          assert.equal(sourceCalls, 0, "根文件和其他模块的路径在读取 Git 基线前被拒绝");
        }
        // 未配置知识仓时，领域宿主允许先保存草稿，不需要准备归档仓。
        await call("knowledge_draft", { action: "save", document: { ...document, path: "docs/交易/README.md" } });
        await call("knowledge_work_result", { summary: "保存本模块知识", document_ids: [document.id] });
      }
      return { status: "turn_finished" };
    },
    startResume: async () => { throw new Error("本测试应一次保存结果"); }, abort: async () => {}, dispose() {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(genericDomainSkillFixture, input, {
    dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }),
    source: async () => { sourceCalls++; throw new Error("本测试不需要读取源码或归档仓"); },
  }));
  try {
    createBusinessModule(root, { id: "trade", name: "交易", description: "共享仓中的交易业务", owner: "expert",
      repositories: ["https://example.test/shared.git"] }, "expert");
    const job = service.create({ module_id: "trade", issue_no: "REQ-module" }, "expert");
    for (let attempt = 0; attempt < 400; attempt++) {
      const current = service.get(job.id);
      if (["done", "failed", "paused", "cancelled"].includes(current.status)) {
        assert.equal(current.status, "done", current.error);
        assert.equal(current.documents.length, 1);
        assert.equal(current.documents[0].path, "docs/交易/README.md");
        assert.deepEqual(sessions, ["coordinator", "write-trade"]); assert.equal(sourceCalls, 0);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("模块研究没有返回");
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
