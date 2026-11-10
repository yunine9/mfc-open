import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";

type ToolCall = { name: string; input: Record<string, unknown> };
const call = (name: string, input: Record<string, unknown>): ToolCall => ({ name, input });

/** 同一回复可含多个真实工具调用，只实现本测试需要的 Anthropic SSE 协议。 */
function emitReply(response: ServerResponse, calls: ToolCall[], requestNumber: number) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (type: string, data: Record<string, unknown>) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  emit("message_start", { message: { id: `message-${requestNumber}`, type: "message", role: "assistant", model: "ordering-v1", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  if (!calls.length) {
    emit("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    emit("content_block_delta", { index: 0, delta: { type: "text_delta", text: "本会话执行结束" } });
    emit("content_block_stop", { index: 0 });
  }
  calls.forEach((tool, index) => {
    emit("content_block_start", { index, content_block: { type: "tool_use", id: `tool-${requestNumber}-${index}`, name: tool.name, input: {} } });
    emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
    emit("content_block_stop", { index });
  });
  emit("message_delta", { delta: { stop_reason: calls.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  emit("message_stop", {}); response.end();
}

async function until(check: () => boolean, detail: () => string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error(`等待工具执行超时：${detail()}`);
}

test("真实 Pi 同一回复保存、执行及完成按序排队，保存等待源码时不启动子会话或提前完成", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-tool-ordering-")), repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  const requests: Array<Record<string, any>> = [];
  const docsPath = "docs/取消规则";
  const document = { id: "cancel", title: "取消规则", target_id: "domain", path: `${docsPath}/cancel.md`, layer: "domain",
    content: "# 取消规则\n未结算订单取消时释放库存。", sources: "本次研究范围原话" };
  const step = { id: "check", title: "取消规则核对", instructions: "读取已保存文稿并提交候选，不要重复保存", readonly: true, depends_on: [],
    expected_document_ids: ["cancel"], review: { instructions: "独立读取当前正文，核对未结算适用条件" } };
  const script: ToolCall[][] = [
    [call("knowledge_work", { action: "save_document", document: { id: "plan", title: "完整规划", content: "# 完整规划\n必须保存 cancel 文稿并独立核对。" } }),
      call("knowledge_work", { action: "plan", document_ids: ["cancel"], work_document_id: "plan" }),
      call("knowledge_work", { action: "schedule", steps: [step] })],
    [call("knowledge_draft", { action: "save", document }), call("knowledge_work", { action: "run" }),
      call("knowledge_work_result", { summary: "完整计划已经核对", document_ids: ["cancel"] })],
    [call("knowledge_draft", { action: "read", id: "cancel" }),
      call("knowledge_work_result", { summary: "已读取取消规则，提交独立评审", document_ids: ["cancel"] })],
    [],
    [call("knowledge_draft", { action: "read", id: "cancel" }),
      call("knowledge_work_result", { summary: "已核对未结算前提", document_ids: ["cancel"], review: { pass: true, feedback: "已回读完整正文，未结算适用条件符合输入" } })],
    [],
    [],
  ];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push(body);
      emitReply(response, script[requests.length - 1] ?? [], requests.length);
    });
  });
  let sourceEntered = false, releaseSource!: () => void;
  const sourceReady = new Promise<void>(resolve => { releaseSource = resolve; });
  let service: DomainKnowledgeExtraction | undefined;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const method = { "SKILL.md": "---\nname: tool-ordering\ndescription: 逐篇核对文稿\nexecution: reviewed-document-plan\n---\n按完整计划保存文稿并独立评审。" };
    service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(method, input, { dataDir: root,
      model: () => ({ provider: "maeflow", model: "ordering-v1", json: { providers: { maeflow: { baseUrl, api: "anthropic-messages", apiKey: "scripted", models: [{ id: "ordering-v1" }] } } } }),
      source: async () => { sourceEntered = true; await sourceReady; return { root: repo, revision }; },
    }));
    const job = service.create({ title: "取消规则", scope: "未结算订单取消时释放库存", issue_no: "REQ-475", repositories: [],
      knowledge_target: { name: "知识仓", repository: "https://example.test/knowledge.git", branch: "main", docs_path: docsPath } }, "tester");
    const detail = () => JSON.stringify({ status: service!.get(job.id).status, requests: requests.length });
    await until(() => sourceEntered, detail);
    // 让真实 Pi 有机会处理同回复中的其余调用；保存仍由 sourceReady 明确阻塞。
    await delay(100);
    assert.equal(requests.length, 2, "保存尚未完成，run 必须等待，不能提前请求作者或评审会话");
    const waiting = service.get(job.id);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.documents.length, 0);
    assert.equal(waiting.turns[0].research?.capabilities[0].state, "pending");
    releaseSource();
    await until(() => ["done", "failed", "paused"].includes(service!.get(job.id).status), detail);
    const done = service.get(job.id);
    assert.equal(done.status, "done", done.error);
    assert.equal(done.documents.length, 1); assert.equal(done.documents[0].revision, 1);
    assert.equal(done.documents[0].path, `${done.knowledge_target.docs_path}/cancel.md`);
    assert.equal(done.turns[0].research?.capabilities[0].state, "researched");
    assert.equal(requests.length, script.length);
    const toolResults = requests.flatMap(request => request.messages ?? []).flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === "tool_result");
    assert.ok(toolResults.length > 0);
    assert.ok(toolResults.every((block: any) => !block.is_error), "排队调用应成功执行，而不是在并发锁处被拒绝后碰巧结束");
    const finalResults = (requests.at(-1)!.messages as any[]).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === "tool_result" && ["tool-2-0", "tool-2-1", "tool-2-2"].includes(block.tool_use_id));
    assert.deepEqual(finalResults.map(block => block.tool_use_id), ["tool-2-0", "tool-2-1", "tool-2-2"], "保存、执行、完成均在同一主会话回复中成功返回");
  } finally {
    releaseSource();
    try { await service?.shutdown(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  }
});
