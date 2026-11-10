/**
 * 问题会话接入平台统一知识检索(ADR-0062)的契约测试:
 * - 检索口径 issueToolKnowledgeContext:登记仓+绑定模块+产品版本,
 *   与货架匹配同源;repo 走 slug,与需求侧 memoryRepo 同语义;
 * - 开场词引导行:knowledge 工具引导常驻;知识仓克隆在场时声明主次
 *   (工具=权威正本,克隆=补充参考);
 * - 只读边界:createKnowledgeTool 不注入 research 时,指引不教学
 *   「发起研究」——生产动作在问题会话域不存在,也不该被指向。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnowledgeTool } from "../src/knowledgeTools.ts";
import type { ComponentResearch } from "../src/componentResearch.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import { issueToolKnowledgeContext } from "../src/issueFlow/service.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";

test("检索口径:登记仓+绑定模块+产品版本,repo 走 slug", () => {
  const context = issueToolKnowledgeContext({
    repo_urls: ["http://example.com/settle-core.git", "http://example.com/lib.git"],
    module_id: "pay-core",
    product_version: "V500R021",
  } as IssueSessionState);
  assert.deepEqual(context, {
    repo: "settle-core",
    repositories: ["http://example.com/settle-core.git", "http://example.com/lib.git"],
    moduleIds: ["pay-core"],
    productVersion: "V500R021",
  });
  const bare = issueToolKnowledgeContext({} as IssueSessionState);
  assert.deepEqual(bare, {
    repo: "_unknown",
    repositories: [],
    moduleIds: [],
    productVersion: undefined,
  });
});

test("开场词:knowledge 工具引导行常驻,知识仓在场时声明主次", () => {
  const base = {
    id: "issue-1", scenario: "no_ticket", stage: "analyze",
    title: "对账差异", description: "", account: "dev",
    repo_urls: ["http://example.com/origin.git"],
  } as unknown as IssueSessionState;
  const prompt = issueFixedOpeningPrompt(base, {}, { tier: "3" });
  assert.match(prompt, /用 knowledge 工具检索/);
  assert.doesNotMatch(prompt, /只作补充参考/);

  const withRepo = {
    ...base,
    knowledge_repo: {
      url: "http://example.com/team-docs.git", name: "team-docs",
      status: "ready", at: "2026-10-13T00:00:00.000Z",
    },
  } as IssueSessionState;
  const promptWithRepo = issueFixedOpeningPrompt(withRepo, {}, { tier: "3" });
  assert.match(promptWithRepo, /优先用 knowledge 工具检索/);
  assert.match(promptWithRepo, /repo\/ 下知识仓克隆只作补充参考/);
});

test("只读边界:research 缺席时指引不教发起研究,需求侧注入时保留", () => {
  const context = () => ({ repo: "r", repositories: [], moduleIds: [] });
  const readOnly = createKnowledgeTool({ service: () => undefined, context }) as { promptGuidelines: string[] };
  const withResearch = createKnowledgeTool({
    service: () => undefined, context,
    research: () => ({}) as unknown as ComponentResearch,
  }) as { promptGuidelines: string[] };
  assert.ok(!readOnly.promptGuidelines.some((g) => g.includes("action=research")),
    "旁路会话的指引不得指向 research 生产动作");
  assert.ok(readOnly.promptGuidelines.some((g) => g.includes("action=search")),
    "只读指引保留检索/阅读教学");
  assert.ok(withResearch.promptGuidelines.some((g) => g.includes("action=research")),
    "需求侧注入 research 后指引完整");
  assert.equal(readOnly.promptGuidelines.length, withResearch.promptGuidelines.length - 1);
});
