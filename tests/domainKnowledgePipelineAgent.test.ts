import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CloudSession } from "../src/sessionDriver.ts";
import { runDomainKnowledgeFixture } from "./helpers/extractionSkillFixture.ts";
import { DomainKnowledgeExtraction } from "../src/domainKnowledgeExtraction.ts";
import { KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";
import { businessMaterial } from "./domainKnowledgeEvidenceFixture.ts";

test("来源工具由平台注册，主会话、调查、写作和独立评审读取同一份固定 Skill 来源方法", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-skill-agent-")), repo = join(root, "repo"), cli = join(root, "doubao");
  const env = { MAE_FLOW_WXDOUBAO_BIN: cli, WXDOUBAO_USERID: "fixture-user", WXDOUBAO_TOKEN: "fixture-credential" };
  const previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  mkdirSync(repo); execFileSync("git", ["init", "-q", repo]); mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/order.ts"), "export function cancel() { return 'reverse'; }\n");
  mkdirSync(join(repo, "docs")); writeFileSync(join(repo, "docs/old.md"), "旧文档内容"); writeFileSync(join(repo, "AGENTS.md"), "仓内说明");
  execFileSync("git", ["-C", repo, "add", "."]); execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture"]);
  const revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(cli, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{structuredContent:{text:"无线业务背景：网管操作状态和审计链用于追踪操作；不能据此确认本系统的取消规则。WIRELESS_BACKGROUND",url:"https://example.test/wireless-background"}}}));\n`, { mode: 0o700 });
  const material = await businessMaterial(root), sessions: any[] = [];
  const skills = new KnowledgeExtractionSkills(root), originalComponent = skills.current("component").digest;
  const sourcePath = "references/business-sources.md", sourceMethod = skills.current("domain").files[sourcePath];
  assert.ok(sourceMethod?.trim(), "内置方法必须包含实际来源研究文件");
  // 使用真实来源文件，步骤范围保持本测试的最小方法，不顺带启动完整文稿计划契约。
  const files = { "SKILL.md": `---\nname: settlement-guide\ndescription: 研究冲正规则。\n---\nMETHOD_A：每个会话先读 [来源方法](${sourcePath})，再按 [方法](guide/way.md) 调查、写作和独立复核。`,
    "guide/way.md": "只读调查后保存问答，由独立评审回读原始依据。", [sourcePath]: sourceMethod };
  const sourceReads: Array<{ role: string; content: string }> = [];
  const body = "# 已结算订单的取消\n\n上传资料要求已结算订单走冲正流程，并解释其目的是避免月底结算期间重复扣款。源码 cancel 返回 reverse。无线背景用于理解审计链概念，不能证明本系统的取消规则。";
  const document = { id: "guide", title: "冲正", layer: "domain", target_id: "domain", path: "docs/订单/settlement.md", content: body, sources: "src/order.ts 的 cancel；business-decisions.txt 的结算限制和业务原因；无线豆包仅提供审计链概念背景" };
  const intercepted = mock.method(CloudSession, "create", async (config: any) => {
    sessions.push(config);
    const call = async (name: string, args: any, error = false) => {
      const tool = config.extraTools.find((t: any) => t.name === name); assert.ok(tool, name);
      const response = await tool.execute("fixture", args, new AbortController().signal);
      assert.equal(!!response.isError, error, JSON.stringify(response));
      try { return JSON.parse(response.content[0].text); } catch { return response.content[0].text; }
    };
    return { start: async (prompt: string) => {
      const data = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      assert.equal(data.instructions, "只研究订单取消，不读取 legacy/payment.ts；正文只写业务规则");
      const anchor = JSON.parse(config.compactAnchor());
      for (const context of [data, anchor]) {
        assert.equal(context.materials.length, 1);
        const summary = context.materials[0];
        assert.equal(summary.id, material.id); assert.equal(summary.digest, material.digest);
        for (const key of ["sections", "documents", "images", "warnings"] as const) {
          assert.equal(summary[key], material[key]?.length ?? 0, `${key} 只在会话上下文与压缩锚点保留数量`);
        }
      }
      assert.match(anchor.skill.digest, /^[a-f0-9]{64}$/);
      assert.equal(anchor.skill.digest, JSON.parse(sessions[0].compactAnchor()).skill.digest);
      assert.match(prompt, /优先于 Skill 的默认安排/);
      assert.equal(config.excludeAgentFiles, true); assert.equal(config.allowedTools.includes("bash"), false);
      assert.match(prompt, /METHOD_A/); assert.doesNotMatch(prompt, /先用.*phase-|前两个模块|knowledge_research|知识正文写作要求/);
      for (const name of ["extraction_skill", "knowledge_material", "business_knowledge", "knowledge_evidence"]) {
        assert.ok(config.allowedTools.includes(name), name);
        assert.ok(config.extraTools.some((tool: any) => tool.name === name), name);
      }
      const paths = await call("extraction_skill", {}); assert.ok(paths.includes(sourcePath));
      const method = await call("extraction_skill", { path: sourcePath });
      assert.equal(method, sourceMethod, "独立会话通过工具读取固定包正文，不能换成后来变更的方法");
      sourceReads.push({ role: !data.step ? "coordinator" : data.reviewing ? "reviewer" : data.step.readonly ? "researcher" : "writer", content: method });
      if (!data.step) {
        assert.equal(config.resumeSession, true);
        const [directory] = await call("knowledge_material", {});
        assert.equal(directory.id, material.id); assert.equal(directory.sections.length, material.sections.length);
        for (const key of ["documents", "images", "warnings"] as const) assert.deepEqual(directory[key] ?? [], material[key] ?? [], `${key} 的完整目录仍可按需读取`);
        // 模拟可取得的新包变化；已经固定的本轮包及随后创建的子会话继续读原文件。
        files[sourcePath] = "NEW_METHOD_SHOULD_NOT_REPLACE_PINNED_SOURCE";
        await call("business_knowledge", { question: "ROOT_SHARED 网管操作状态与审计链概念" });
        await call("knowledge_work", { action: "schedule", steps: [
          { id: "research", title: "调查来源", instructions: `先读 ${sourcePath}，回读上传资料、源码与已有背景证据，仅保存调查结果`, depends_on: [], readonly: true },
          { id: "answer", title: "解释规则", instructions: `先读 ${sourcePath}，依据原始资料和源码写一份问答`, depends_on: ["research"], readonly: false,
            expected_document_ids: ["guide"], review: { instructions: `先读 ${sourcePath}，回读当前问答和原始依据，独立提交评审` } },
        ] });
        await call("knowledge_work", { action: "run", id: "answer" }, true);
        await call("knowledge_work", { action: "run", id: "research" });
        const reviewed = await call("knowledge_work", { action: "run", id: "answer" }); assert.equal(reviewed.review.pass, true);
        const count = sessions.length; await call("knowledge_work", { action: "run", id: "answer" }); assert.equal(sessions.length, count);
        await call("knowledge_work_result", { summary: "本方法的写作与评审完成", document_ids: ["guide"], data: { custom: true } });
      } else {
        assert.equal(config.resumeSession, true, "独立步骤恢复自己的会话，仍不继承主会话私有历史");
        assert.doesNotMatch(prompt, /ROOT_SHARED/, "独立步骤没有主会话的私有上下文");
        const shared = await call("knowledge_evidence", { action: "list", query: "ROOT_SHARED" });
        assert.ok(shared.entries[0].evidence_id);
        const raw = await call("knowledge_evidence", { action: "read", evidence_id: shared.entries[0].evidence_id });
        assert.match(raw.content, /WIRELESS_BACKGROUND/);
        // component_source returns plain source, so use the raw tool here.
        const source = await config.extraTools.find((t: any) => t.name === "component_source").execute("read", { action: "read", component_id: "repo-1", path: "src/order.ts" }, new AbortController().signal);
        assert.equal(!!source.isError, false);
        const originalMaterial = await call("knowledge_material", { id: material.id });
        assert.match(JSON.stringify(originalMaterial.sections), /ORIGINAL_BUSINESS_CONTEXT/);
        if (data.reviewing) {
          assert.equal((await call("knowledge_draft", { action: "read", id: "guide" })).content, body);
          await call("knowledge_draft", { action: "save", document: { ...document, content: "不能覆盖" } }, true);
          await call("knowledge_work_result", { summary: "已对照原始资料", document_ids: ["guide"], review: { pass: true, feedback: "源码、上传资料与概念背景分别核对，结论一致" } });
        } else if (data.step.readonly) {
          await call("knowledge_draft", { action: "save", document }, true);
          await call("knowledge_work_result", { summary: "已回读调查所需来源", document_ids: [], data: { material_id: material.id, repository_id: "repo-1", path: "src/order.ts" } });
        } else {
          await call("knowledge_draft", { action: "save", document });
          await call("knowledge_work_result", { summary: "已保存知识", document_ids: ["guide"], data: { whatever_this_skill_needs: [1, 2] } });
        }
      }
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {}, startResume: async () => { throw new Error("不应补充会话"); } } as any;
  });
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(files, input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => ({ root: repo, revision }) }));
  try {
    const job = service.create({ issue_no: "REQ-skill", title: "订单", scope: "取消", instructions: "只研究订单取消，不读取 legacy/payment.ts；正文只写业务规则", material_ids: [material.id], repositories: [{ repository: "https://example.test/orders.git", branch: "main" }] }, "expert");
    for (let i = 0; i < 1000 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(r => setTimeout(r, 10));
    const final = service.get(job.id); assert.equal(final.status, "done", final.error);
    assert.equal(final.documents.length, 1); assert.equal(final.documents[0].content, body); assert.equal(sessions.length, 4);
    assert.deepEqual(sourceReads.map(read => read.role), ["coordinator", "researcher", "writer", "reviewer"]);
    assert.ok(sourceReads.every(read => read.content === sourceMethod));
    const pinned = JSON.parse(readFileSync(join(root, "domain-extraction", job.id, "skill.json"), "utf8"));
    assert.equal(pinned.files[sourcePath], sourceMethod); assert.equal(final.turns[0].skill?.digest, pinned.digest);
    assert.equal(final.turns[0].revisions?.["repo-1"], revision);
    assert.ok(final.evidence.some(e => e.tool === "knowledge_material")); assert.ok(final.evidence.some(e => e.tool === "business_knowledge"));
    assert.equal(final.evidence.filter(e => e.tool === "knowledge_evidence" && e.action === "read").length, 3);
    assert.equal(final.evidence.filter(e => e.tool === "business_knowledge" && e.action === "knowledge_search").length, 1, "子会话复用已取得的背景证据，不为确认工具可用而重复查询");
    assert.ok(final.evidence.every(e => e.tool !== "business_knowledge" || e.action === "knowledge_search"), "无线豆包只做知识检索");
    assert.equal(skills.current("component").digest, originalComponent);
    const state = JSON.parse(readFileSync(join(root, "domain-extraction", job.id, "skill-runs", final.turns[0].id, "work.json"), "utf8"));
    assert.deepEqual(state.steps.map((s: any) => s.id), ["research", "answer"]);
    assert.equal(state.steps.find((s: any) => s.id === "answer").result.review.pass, true);
    assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" }), "");
  } finally { await service.shutdown(); intercepted.mock.restore(); for (const [k, v] of Object.entries(previous)) if (v === undefined) delete process.env[k]; else process.env[k] = v; rmSync(root, { recursive: true, force: true }); }
});

test("任务固定为单篇 Skill 即改变输出，不读取源码、不强制评审和领域文档，也不按特殊文件名分流", async () => {
  const root = mkdtempSync(join(tmpdir(), "domain-skill-swap-"));
  let method: Record<string, string> = {};
  let runs = 0, sources = 0;
  const intercepted = mock.method(CloudSession, "create", async (config: any) => ({
    start: async (prompt: string) => {
      runs++;
      const context = JSON.parse(prompt.split("本轮上下文：\n").at(-1)!);
      assert.equal(context.step, undefined); assert.match(prompt, /ONLY_ONE_PAGE/);
      const read = config.extraTools.find((t: any) => t.name === "extraction_skill");
      assert.match((await read.execute("read", { path: "custom/how.md" })).content[0].text, /自由正文/);
      for (const name of ["knowledge_material", "business_knowledge", "knowledge_evidence"]) assert.ok(config.allowedTools.includes(name), name);
      assert.equal((await read.execute("missing", { path: "references/business-sources.md" })).isError, true, "宿主不向任意固定包偷偷追加内置方法文件");
      const name = prompt.includes("VERSION_B") ? "faq" : "decision";
      const document = { id: name, title: name, target_id: name === "faq" ? "domain" : "repo-1", layer: name === "faq" ? "domain" : "repository", path: `docs/业务/${name}.md`, content: `# ${name}\n自由正文，没有固定章节或机器字段。`, sources: "用户提供的业务范围" };
      const saved = await config.extraTools.find((t: any) => t.name === "knowledge_draft").execute("save", { action: "save", document });
      assert.equal(!!saved.isError, false);
      const result = await config.extraTools.find((t: any) => t.name === "knowledge_work_result").execute("done", { summary: name, document_ids: [name] });
      assert.equal(!!result.isError, false);
      return { status: "turn_finished" };
    }, dispose() {}, abort: async () => {},
  }) as any);
  const service = new DomainKnowledgeExtraction(root, input => runDomainKnowledgeFixture(method, input, { dataDir: root, model: () => ({ provider: "fixture", model: "fixture", json: {} }), source: async () => { sources++; throw new Error("不应读取源码"); } }));
  try {
    const jobs: string[] = [];
    for (const version of ["A", "B"]) {
      method = { "SKILL.md": `---\nname: method-${version.toLowerCase()}\ndescription: 自定义领域方法。\n---\nONLY_ONE_PAGE VERSION_${version}，只按 [说明](custom/how.md) 写一篇文档。`, "custom/how.md": "自由正文。",
        ...(version === "B" ? { "references/platform-pipeline.md": "这是普通附件文件，不表示启动平台流水线。" } : {}) };
      const job = service.create({ issue_no: "REQ-skill", title: "业务", scope: "已知范围", repositories: version === "B" ? [] : [{ repository: "https://example.test/repo.git", branch: "main" }] }, "expert"); jobs.push(job.id);
      for (let i = 0; i < 200 && !["done", "failed"].includes(service.get(job.id).status); i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(service.get(job.id).status, "done", service.get(job.id).error);
    }
    assert.equal(runs, 2); assert.equal(sources, 0);
    assert.equal(service.get(jobs[0]).documents[0].id, "decision"); assert.equal(service.get(jobs[1]).documents[0].id, "faq");
    assert.notEqual(service.get(jobs[0]).turns[0].skill?.digest, service.get(jobs[1]).turns[0].skill?.digest);
    assert.ok(jobs.every(id => service.get(id).publications.length === 0));
  } finally { await service.shutdown(); intercepted.mock.restore(); rmSync(root, { recursive: true, force: true }); }
});
