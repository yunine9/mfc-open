/**
 * 业务知识地图(ADR-0012,2026-09-10 起单源化,ADR-0021)的契约测试:
 * - 资产库定格:进入 analyze 时按绑定模块从发布库选取并只读投影,
 *   台账落账;月光开档照样定格(地图不分介入档);未绑定模块静默缺席;
 * - 仓内 docs/ 不再平台扫描注入(ADR-0021):发现权归仓,提示词只
 *   承载全局置信度分层段(全阶段在场,不随 analyze 门控);
 * - 注入点:开场词在 analyze 阶段注入业务知识地图(只剩资产库一源)。
 *
 * 范式与 issueInterventionTiers.test.ts 同款:ScriptedModelServer 剧本,只走
 * 公开 API 断言;地图渲染为纯函数单元断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { createBusinessModule, publishBusinessKnowledgeAsset } from "../src/businessModuleLibrary.ts";
import {
  businessKnowledgeLines,
} from "../src/issueFlow/businessKnowledge.ts";
import { issueFixedOpeningPrompt } from "../src/issueFlow/prompt.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { mfcTemp } from "./mfcTmp.ts";

const MODULE_ID = "pay-core";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** 造一个带初始提交与 docs/ 业务总结的裸仓远端。 */
function bareOrigin(root: string, docFiles: number): string {
  const seed = join(root, "seed-repo");
  execFileSync("git", ["init", "-q", "-b", "master", seed], { env: GIT_ENV });
  const docs = join(seed, "docs");
  mkdirSync(join(docs, "领域手册"), { recursive: true });
  writeFileSync(join(docs, "领域手册", "对账流程.md"), "# 对账流程\n");
  for (let index = 0; index < docFiles; index += 1) {
    writeFileSync(join(docs, `业务说明-${index}.md`), `# 业务 ${index}\n`);
  }
  execFileSync("git", ["-C", seed, "add", "."], { env: GIT_ENV });
  execFileSync("git", ["-C", seed, "commit", "-q", "--allow-empty",
    "-m", "init"], { env: GIT_ENV });
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin], { env: GIT_ENV });
  return origin;
}

function seedModuleWithAsset(
  dataDir: string,
  origin: string,
  content: string,
): void {
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  publishBusinessKnowledgeAsset(dataDir, MODULE_ID, {
    id: "settlement-faq", title: "清结算 FAQ",
    summary: "对账差异的常见成因与排查顺序",
    when_to_use: "排查对账差异时",
    content,
  }, "tester");
}

const NO_TICKET_ENV = {
  hosts: ["192.0.2.8"],
  pagePassword: "page-secret",
  backendPassword: "env-shared-secret",
};

async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function baseOptions(dataDir: string, model: ScriptedModelServer) {
  return {
    dataDir,
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
  };
}

const REPORT = "printf '# 问题分析\\n\\n现象:对账差异。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n"
  + "非问题(测试数据问题)。\\n## 置信度\\n"
  + "高。\\n## 修改方案\\n修正数据。\\n"
  + "' > issue-analysis.md";

test("绑定模块+仓内 docs:进 analyze 定格资产并投影,台账/文件/转移账齐全", async () => {
  const dataDir = mfcTemp("mfc-issue-biz-know-");
  const origin = bareOrigin(dataDir, 2);
  seedModuleWithAsset(dataDir, origin, "# 清结算 FAQ\n\n对账差异先查时窗。\n");
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:测试数据" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    // 一档全自动:自动闭环归档,顺便证明定格/地图不分介入档。
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "archived" ? issue : undefined;
    }, "月光自动闭环归档");
    // 台账:资产按绑定模块定格,字段在场,条目带元数据与相对路径。
    const frozen = archived.business_knowledge;
    assert.ok(frozen, "进入 analyze 必须定格业务知识台账");
    assert.equal(frozen!.entries.length, 1);
    const [entry] = frozen!.entries;
    assert.equal(entry.title, "清结算 FAQ");
    assert.equal(entry.module_name, "支付核心");
    assert.equal(entry.relative_path,
      ".mae-flow-work/business-modules/pay-core/settlement-faq.md");
    // 投影:正文与 INDEX.md 只读落盘。
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      entry.relative_path)), "知识正文只读投影在工作区");
    assert.ok(existsSync(join(dataDir, "issues", created.id,
      ".mae-flow-work", "business-modules", "INDEX.md")),
      "INDEX.md 目录在工作区");
    const transitions = archived.transitions ?? [];
    assert.ok(
      transitions.some((entry) => entry.note.includes("业务知识资产已定格")),
      "定格留转移账");
    // 月光开档不举圈选闸,但资产定格照常——地图不分介入档。
    assert.equal(archived.skill_selection ?? undefined, undefined);
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("模块没有已发布资产:台账为空,流程照走(旁路不卡会话)", async () => {
  const dataDir = mfcTemp("mfc-issue-biz-nomod-");
  const origin = bareOrigin(dataDir, 0);
  createBusinessModule(dataDir, {
    id: MODULE_ID, name: "支付核心", description: "收单与清结算",
    owner: "dev", repositories: [origin],
  }, "tester");
  const script: Scene[] = [
    { tool: { name: "pull_repo", input: { url: origin } } },
    { tool: { name: "complete_stage", input: { note: "仓已拉齐" } } },
    { tool: { name: "bash", input: { command: REPORT } } },
    { tool: { name: "submit_analysis",
      input: { conclusion: "non_issue", confidence: "high",
        summary: "非问题:测试数据" } } },
    { text: "结论已提交。" },
  ];
  const model = new ScriptedModelServer(script, "scripted-v1", { linear: true });
  await model.start();
  const service = new IssueFlowService({
    ...baseOptions(dataDir, model),
    interventionTier: () => "1",
  });
  try {
    const created = service.create({
      account: "dev", title: "列表导出超时", repoUrl: origin,
      moduleId: MODULE_ID, environment: NO_TICKET_ENV,
    });
    const archived = await until(() => {
      const issue = service.get(created.id);
      if (issue.status === "failed") throw new Error(issue.error ?? "failed");
      return issue.status === "archived" ? issue : undefined;
    }, "无发布资产也会走完流程(旁路不卡会话)");
    assert.equal(archived.business_knowledge?.entries.length ?? 0, 0,
      "模块没有已发布资产,台账为空");
  } finally {
    await service.shutdown().catch(() => undefined);
    await model.stop();
  }
});

test("docs 不再进地图(ADR-0021):平台不扫描仓内 docs/,资产是唯一注入源", () => {
  const workspace = mfcTemp("mfc-issue-biz-docs-");
  const repoDir = join(workspace, "repo", "origin");
  mkdirSync(join(repoDir, "docs", "手册"), { recursive: true });
  writeFileSync(join(repoDir, "docs", "总览.md"), "# 总览\n");
  writeFileSync(join(repoDir, "docs", "手册", "细节.md"), "# 细节\n");
  const state = {
    scenario: "no_ticket", stage: "analyze",
    repo_urls: ["http://example.com/origin.git"],
  } as unknown as IssueSessionState;
  // 只有 docs、没有资产台账 → 整段缺席:docs 的存在性靠 AGENTS.md
  // 标准句声明,不靠平台扫描。
  assert.deepEqual(businessKnowledgeLines(state), []);
  // 有资产台账 → 只出资产条目,不混入任何 docs/ 路径。
  const withAssets = {
    ...state,
    business_knowledge: {
      at: "2026-09-10T00:00:00.000Z",
      entries: [{
        id: "settlement-faq", module_id: MODULE_ID, module_name: "支付核心",
        title: "清结算 FAQ", summary: "对账差异排查",
        when_to_use: "排查对账差异时", form: "markdown", version: 1,
        relative_path: ".mae-flow-work/business-modules/pay-core/settlement-faq.md",
      }],
    },
  } as unknown as IssueSessionState;
  const lines = businessKnowledgeLines(withAssets);
  assert.ok(lines.some((line) => line.includes("业务知识地图")));
  assert.ok(lines.some((line) => line.includes("清结算 FAQ")));
  assert.doesNotMatch(lines.join("\n"), /docs\//,
    "仓内 docs/ 路径不得出现在地图里(ADR-0021)");
});

test("提示层:开场词 analyze 只注入资产地图，repo-docs 规则不再重复注入", () => {
  const base = {
    id: "issue-1", scenario: "no_ticket", stage: "analyze",
    title: "对账差异", description: "", account: "dev",
    repo_urls: ["http://example.com/origin.git"],
    business_knowledge: {
      at: "2026-09-10T00:00:00.000Z",
      entries: [{
        id: "settlement-faq", module_id: MODULE_ID, module_name: "支付核心",
        title: "清结算 FAQ", summary: "对账差异排查",
        when_to_use: "排查对账差异时", form: "markdown", version: 1,
        relative_path: ".mae-flow-work/business-modules/pay-core/settlement-faq.md",
      }],
    },
  } as unknown as IssueSessionState;
  const prompt = issueFixedOpeningPrompt(base, {}, { tier: "3" });
  assert.match(prompt, /业务知识地图/);
  assert.match(prompt, /清结算 FAQ/);
  assert.doesNotMatch(prompt, /置信度中等/,
    "docs 分层已收口到 repo-docs skill，避免每回合重复注入");
  assert.doesNotMatch(prompt, /repo\/origin\/docs\//,
    "docs 路径不再由平台注入");
  // 非 analyze 阶段:地图不注入，docs 分层仍由按需装载的
  // repo-docs skill 承担，不在开场词常驻。
  const prep = { ...base, stage: "prep_repo" } as IssueSessionState;
  const prepPrompt = issueFixedOpeningPrompt(prep, {}, { tier: "3" });
  assert.doesNotMatch(prepPrompt, /业务知识地图/);
  assert.doesNotMatch(prepPrompt, /置信度中等/);
});
