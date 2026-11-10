import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";
import { readBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import { seedTechnologyStacks } from "./fixtures/technologyStacks.ts";

function createService(dataDir: string, host?: { kernelRoot: string; repoPath: string }): TaskService {
  return new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {},
    maxConcurrent: 0, ...(host ? { host } : {}),
  });
}

test("B1验收1：工程候选、Skill 蒸馏、知识整理及领域旧操作全部返回 404",
  { timeout: 15_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-retired-knowledge-api-"));
    const service = createService(dataDir);
    const task = service.create("保留普通需求服务");
    const server = createTaskServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const endpoints: Array<[string, string]> = [
        ["GET", "/knowledge-candidates"],
        ["GET", "/knowledge-candidates/retired"],
        ["POST", "/knowledge-candidates/retired/publish"],
        ["POST", "/knowledge-candidates/retired/reject"],
        ["POST", `/tasks/${task.id}/knowledge-candidates`],
        ["GET", "/skills/retired/candidates"],
        ["GET", "/skills/retired/candidates/old"],
        ["POST", "/skills/retired/distill"],
        ["POST", "/skills/retired/candidates/old/adopt"],
        ["DELETE", "/skills/retired/candidates/old"],
        ["GET", "/knowledge-documents/consolidation"],
        ["GET", "/knowledge-documents/consolidation/jobs/old"],
        ["GET", "/knowledge-documents/consolidation/jobs/old/source/document/old"],
        ...["run", "retry", "stop", "settings"].map((action): [string, string] =>
          ["POST", `/knowledge-documents/consolidation/${action}`]),
        ...["edit", "adopt", "discard", "withdraw"].map((action): [string, string] =>
          ["POST", `/knowledge-documents/consolidation/old/${action}`]),
        ["GET", "/domain-extraction/probes"],
        ["POST", "/domain-extraction/probes"],
        ["GET", "/domain-extraction/retired/source-cleanup"],
        ...["cleanup-template", "cleanup-preview", "cleanup-confirm"].map((action): [string, string] =>
          ["GET", `/domain-extraction/retired/${action}`]),
        ...["cleanup-template", "cleanup-preview", "cleanup-confirm"].map((action): [string, string] =>
          ["POST", `/domain-extraction/retired/${action}`]),
        ...["preview", "confirm", "publish"].map((action): [string, string] =>
          ["POST", `/domain-extraction/retired/source-cleanup/${action}`]),
      ];
      for (const [method, path] of endpoints) {
        const response = await fetch(base + path, {
          method, signal: AbortSignal.timeout(2_000),
          ...(method === "GET" ? {} : {
            headers: { "content-type": "application/json" }, body: "{}",
          }),
        });
        assert.equal(response.status, 404, `${method} ${path}`);
      }
      assert.deepEqual(service.getDomainKnowledgeExtraction().list(), []);
      for (const directory of ["knowledge-candidates", "skill-candidates", "knowledge-consolidation"]) {
        assert.equal(existsSync(join(dataDir, directory)), false, directory);
      }
    } finally {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

test("B1验收3：模块管理、资产消费与发起预览保留当前版本",
  { timeout: 15_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-retained-business-knowledge-"));
    const service = createService(dataDir, {
      kernelRoot: "/tmp", repoPath: "/tmp/fixed-demo-repo",
    });
    const server = createTaskServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const repository = "https://code.example/team/orders.git";
    const write = (path: string, body: unknown) => fetch(base + path, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
    });
    try {
      assert.equal((await fetch(`${base}/business-modules`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "orders", name: "订单域", description: "订单业务",
          owner: "owner", repositories: [repository] }),
      })).status, 201);
      assert.equal((await write("/business-modules/orders", { name: "订单模块" })).status, 200);
      const assetPath = "/business-modules/orders/assets/refund";
      assert.equal((await write(assetPath, { title: "退款规则", summary: "退款约束",
        when_to_use: "处理退款时", form: "document", content: "# 退款规则\n退款必须幂等。" })).status, 200);
      const document = await (await fetch(base + assetPath)).json() as any;
      assert.equal(document.asset.version, 1);
      assert.match(document.content, /退款必须幂等/);
      const preview = service.previewLaunchKnowledge({
        repositories: [repository], selectedBusinessModuleIds: ["orders"],
      });
      assert.equal(preview.complete, true);
      assert.equal(preview.business_knowledge[0].version, 1);
      assert.equal(preview.business_knowledge[0].id, "refund");
      assert.equal("engineering_knowledge" in preview, false);
      assert.equal("engineering_knowledge" in service.launchOptions(), false);
      const task = service.create("处理退款", {
        repo: repository, selectedBusinessModuleIds: ["orders"],
        knowledgePreviewDigest: preview.selection_digest,
      });
      assert.equal(task.business_modules?.[0].assets[0].version, 1);
      assert.equal("engineering_knowledge" in task, false);
      // 模块资产已退出统一检索面(正文统一从正式 Git 快照读取);
      // 「保留当前版本」按模块键直读资产钉住。
      assert.match(readBusinessKnowledgeAsset(dataDir, "orders", "refund").content, /退款必须幂等/);
      assert.equal((await fetch(base + assetPath, { method: "DELETE" })).status, 200);
      assert.equal(readBusinessKnowledgeAsset(dataDir, "orders", "refund").asset.status, "archived", "删除后归档,不再作为当前版本消费");
    } finally {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

test("B1验收3：Skill 保留提交、审查、读取与定向提取校验入口",
  { timeout: 15_000 }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mfc-retained-skill-api-"));
    seedTechnologyStacks(dataDir, ["cpp"]);
    const service = createService(dataDir);
    const server = createTaskServer(service);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown = {}) => fetch(base + path, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2_000),
    });
    const payload = { nature: "engineering", business_module_ids: [], repositories: [], technologies: ["cpp"],
      files: [{ path: "SKILL.md", content_base64: Buffer.from(
        "---\nname: retained\ndescription: 保留 Skill 审查\nknowledge_nature: engineering\ntechnologies: [cpp]\n---\n审查后发布。",
      ).toString("base64") }] };
    try {
      const submit = await post("/skills/retained/submissions", payload);
      assert.equal(submit.status, 200);
      const pending = await submit.json() as { id: string };
      assert.equal((await fetch(base + "/skills/submissions")).status, 200);
      assert.equal((await fetch(`${base}/skills/retained/submissions/${pending.id}`)).status, 200);
      assert.equal((await post(`/skills/retained/submissions/${pending.id}/reject`, { reason: "补充使用示例" })).status, 200);
      const resubmit = await post("/skills/retained/submissions", payload);
      assert.equal(resubmit.status, 200);
      const revised = await resubmit.json() as { id: string };
      assert.equal((await post(`/skills/retained/submissions/${revised.id}/approve`)).status, 200);
      for (const path of ["/skills", "/skills/retained", "/skills/retained/package", "/skills/retained/versions"]) {
        assert.equal((await fetch(base + path)).status, 200, path);
      }
      const invalidExtraction = await post("/knowledge/skill-extract", { repo: "", intent: "起草 Skill" });
      assert.equal(invalidExtraction.status, 409);
      assert.match(await invalidExtraction.text(), /合法的参考仓地址/);
    } finally {
      await service.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
