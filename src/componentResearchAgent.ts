import { listTechnologyStacks } from "./technologyStacks.ts";
import { scanComponentInterfaces } from "./componentCodeInventory.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CloudSession } from "./sessionDriver.ts";
import { EventLog } from "./semanticEvents.ts";
import { TranscriptStore } from "./transcriptStore.ts";
import { GateService } from "./gateService.ts";
import { HumanGate } from "./humanGate.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { checkEc, languageComponentSourceTool, codeSearchTool, evidencePreview } from "./componentResearchTools.ts";
import { scanKnowledgeCode, knowledgeStructure, validateKnowledgeReferences, type KnowledgeCodeSnapshot } from "./domainKnowledgeCode.ts";
import { KnowledgeExtractionSkills, extractionSkillMission, extractionSkillTool } from "./knowledgeExtractionSkills.ts";
import { isWholeResearchReview, sectionReady, validateComponentOverview, type ResearchSection } from "./componentResearchDocument.ts";
import { ComponentResearchPipeline, type ComponentWork, type ComponentWorkResult } from "./componentResearchPipeline.ts";
import { componentSources, excludedComponentSource, validateComponentParadigm, type ComponentParadigm } from "./componentParadigms.ts";
import { researchDraftContext, researchSourceRepositories, type ResearchExecution } from "./componentResearch.ts";
import type { ComponentRepository } from "./componentRepositories.ts";
import { KNOWLEDGE_RESEARCH_BUDGET_MESSAGE } from "./knowledgeProductionErrors.ts";

const list = () => Type.Array(Type.String());
const reference = Type.Object({ repository_id: Type.String(), path: Type.String(), revision: Type.String(), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) });
const metadata = Type.Object({ kind: Type.Union(["contracts", "paradigm", "pitfalls", "index"].map(s => Type.Literal(s))), component: Type.String(), language: Type.String(),
  status: Type.Union(["recommended", "legacy", "unverified"].map(s => Type.Literal(s))), need: Type.String(), api: list(), applicability: Type.String(),
  replaces: Type.Object({ identifiers: list(), imports: list(), patterns: list() }), evidence: Type.Array(reference), usage_evidence: list(), test_evidence: list(), open_questions: list() });
const sectionSchema = Type.Object({ id: Type.String(), title: Type.String(), repository_ids: list(), content: Type.String(), interfaces: Type.String(), integration: Type.String(),
  example: Type.String(), unit_tests: Type.String(), related_ids: list(), paradigm: metadata });
const resultSchema = Type.Object({ findings: Type.String(), open_questions: list(),
  components: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), repository_ids: list(), scope: Type.String(), dependencies: Type.Optional(list()) }))),
  paradigms: Type.Optional(Type.Array(Type.Object({ id: Type.String(), title: Type.String(), need: Type.String() }))) });
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
const failure = (error: unknown) => ({ ...reply(error instanceof Error ? error.message : String(error)), isError: true });

export async function runComponentResearch(input: ResearchExecution, options: {
  dataDir: string; model: () => { provider: string; model: string; json: unknown } | undefined;
  source: (component: ComponentRepository, operator: string, signal?: AbortSignal, baselineRevisions?: string[]) => Promise<{ root: string; revision: string }>;
  concurrency?: number;
}) {
  const technologyStack = listTechnologyStacks(options.dataDir).find(stack => stack.id === input.record.language);
  const model = options.model(); if (!model) throw new Error("请在模型网关配置主模型");
  if (input.record.material_ids?.length) throw new Error("历史任务含上传资料，请新建仅使用基础仓代码与 everycode 的研究");
  const skills = new KnowledgeExtractionSkills(options.dataDir);
  const skill = skills.pin("component", join(input.root, "component-pipeline-skill.json"), input.record.use_latest_skill);
  const analysisSkill = skills.pin("component-analysis", join(input.root, "component-analysis-skill.json"), input.record.use_latest_skill);
  if (!skill.files["references/platform-pipeline.md"]) throw new Error("组件 Skill 尚未适配分任务与结构化产物协议，请更新组件萃取 Skill 后新建研究");
  input.update({ skill: { name: skill.name, digest: skill.digest }, analysis_skill: { name: analysisSkill.name, digest: analysisSkill.digest }, use_latest_skill: false, format: "joint-document",
    ...(input.record.document ? {} : { document: { overview: "", sections: [] } }) });
  await checkEc(input.signal);
  const components = researchSourceRepositories(input.record);
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  let totalExpired = false;
  const timer = setTimeout(() => { totalExpired = true; controller.abort(new Error(KNOWLEDGE_RESEARCH_BUDGET_MESSAGE)); }, 48 * 60 * 60_000); timer.unref();
  const root = join(input.root, "component-pipeline"), snapshots: KnowledgeCodeSnapshot[] = [];
  const revisions = { ...input.record.revisions };
  const supplementAdded = new Set<string>();
  const evidence = [...input.record.evidence];
  try {
    for (const component of components) {
      signal.throwIfAborted(); input.update({ stage: `扫描基础仓：${component.name}` });
      const prepared = await options.source(component, input.review?.operator ?? input.record.operator, signal, revisions[component.id] ? [revisions[component.id]] : []);
      const revision = revisions[component.id] ?? prepared.revision; revisions[component.id] = revision; input.update({ revisions: { ...revisions } });
      snapshots.push(await scanKnowledgeCode({ ...component, docs_path: "" }, { ...prepared, revision }, signal, excludedComponentSource));
    }
    input.update({ revisions, ...(components.length === 1 ? { revision: revisions[components[0].id] } : {}) });
    const interfaces = await scanComponentInterfaces(snapshots, signal);
    const methodDigest = createHash("sha256").update(JSON.stringify([analysisSkill.digest, skill.digest])).digest("hex");
    const pipeline = input.review ? undefined : new ComponentResearchPipeline(join(root, "state.json"), methodDigest, components.map(c => c.id), skill.digest);
    const session = async (task: ComponentWork, reviewResult?: ComponentWorkResult) => {
      signal.throwIfAborted();
      const reviewing = !!reviewResult, discussing = input.review?.mode === "discuss" || !!input.record.challenge;
      const sessionSkill = !input.review && !input.record.challenge && ["inventory", "plan"].includes(task.phase) ? analysisSkill : skill;
      const supplementing = !reviewing && input.review?.mode === "supplement";
      const wholeReview = !reviewing && isWholeResearchReview(input.review);
      const sessionId = randomUUID(), dir = join(root, "sessions", sessionId), agentDir = join(dir, "agent");
      mkdirSync(agentDir, { recursive: true }); writeFileSync(join(agentDir, "models.json"), JSON.stringify(model.json), { mode: 0o600 });
      const sourceReads: Array<Record<string, unknown>> = [], callerReads = new Set<string>(), draftReads = new Map<string, number>();
      let searched = false, searchedTests = false, saved = false, overviewRead = false, result: ComponentWorkResult | undefined, verdict: { pass: boolean; feedback: string } | undefined;
      const observe = (event: Record<string, unknown>) => {
        signal.throwIfAborted();
        const row = { ...event, pipeline_task: task.id, pipeline_session: sessionId };
        let id: string | undefined;
        if (event.tool === "component_source" && event.action === "read" && event.status === "returned") sourceReads.push(event);
        if (event.tool === "code_search" && event.status === "returned") {
          searched = true;
          if (event.purpose === "unit-test" && ["kw", "nls"].includes(String(event.action))) searchedTests = true;
          if (event.action === "read" && typeof event.content === "string" && event.content.trim() && !["[]", "{}", "null"].includes(event.content.trim())) {
            id = `everycode-${createHash("sha256").update(JSON.stringify([event.purpose ?? "usage", event.repository, event.path, event.start, event.end, event.content])).digest("hex").slice(0, 24)}`;
            Object.assign(row, { evidence_id: id }); callerReads.add(id);
          }
        }
        evidence.push(row); input.evidence(row); return id;
      };
      const verifyMetadata = async (p: ComponentParadigm, requireReads: boolean) => {
        validateComponentParadigm(p, components.map(c => c.id));
        if (p.language !== input.record.language) throw new Error("范式语言与研究语言不一致");
        for (const ref of p.evidence) {
          const snapshot = snapshots.find(s => s.repository.id === ref.repository_id)!;
          if (ref.revision !== snapshot.revision) throw new Error("引用版本不是本轮固定版本");
          const checked = await validateKnowledgeReferences(`\`${ref.repository_id}:${ref.path}:${ref.start}-${ref.end}\``, snapshots, signal);
          if (checked.errors.length) throw new Error(checked.errors.join("；"));
          if (requireReads && !sourceReads.some(r => r.component_id === ref.repository_id && r.path === ref.path && r.revision === ref.revision
            && Number(r.start ?? 1) <= ref.start && Math.min(Number(r.end ?? Number(r.start ?? 1) + 159), Number(r.start ?? 1) + 399) >= ref.end)) throw new Error("必须亲自读取引用的基础仓代码行范围");
        }
        for (const [purpose, ids] of [["usage", p.usage_evidence], ["unit-test", p.test_evidence]] as const) {
          for (const id of ids) if (!evidence.some(e => e.evidence_id === id && e.tool === "code_search" && e.action === "read" && e.status === "returned" && e.content && (e.purpose ?? "usage") === purpose)
            || (requireReads && !callerReads.has(id))) throw new Error(purpose === "unit-test" ? "必须读取已实际取得的 everycode 单元测试证据" : "必须读取已实际取得的 everycode 调用证据");
        }
        if (p.kind === "paradigm" && p.status === "recommended" && !p.usage_evidence.length) throw new Error("推荐范式需要展开的真实调用；未找到时标记 unverified 并说明缺口");
      };
      const draftTool = defineTool({ name: "research_document", label: "组件范式草稿",
        description: wholeReview ? "read 省略 id 列目录，id 读全文。可修订概述、已有章节或新增章节；修订前先读取原稿。范式字段为权威数据，来源由程序生成。" : "read 省略 id 列目录，id 读全文。写作只保存当前任务编号的章节，overview 仅供 synthesis；评审和讨论只读。范式字段为权威数据，来源由程序生成。",
        parameters: Type.Object({ action: Type.Union(["read", ...(!reviewing && !discussing ? ["section", "overview"] : [])].map(s => Type.Literal(s))),
          id: Type.Optional(Type.String()), overview: Type.Optional(Type.String()), section: Type.Optional(sectionSchema) }),
        execute: async (_id: string, args: any) => {
          try {
            signal.throwIfAborted(); const doc = input.readDocument!();
            if (args.action === "read") {
              if (!args.id) { overviewRead = true; return reply({ overview: doc.overview, sections: doc.sections.map(s => ({ id: s.id, title: s.title, revision: s.revision })) }); }
              const s = doc.sections.find(s => s.id === args.id); if (!s) throw new Error("章节不存在");
              draftReads.set(s.id, s.revision); return reply(s);
            }
            if (reviewing || discussing || result) throw new Error("当前会话不能修改草稿");
            if (supplementing && args.action !== "section") throw new Error("补充只能保存新的能力项（契约、范式、陷阱或导航），不能修改概述");
            if (args.action === "overview") {
              if (task.phase !== "synthesis" && !wholeReview) throw new Error("只有汇总任务可写概述");
              input.editDocument!({ action: "overview", overview: args.overview }); saved = true; return reply({ saved: true });
            }
            const s = args.section;
            if (supplementing) {
              // 补充轮没有预先排好的任务编号：新项编号和产物类型由研究者按发现定，"只能新增"由文稿编辑规则把关。
              if (!s || !["contracts", "paradigm", "pitfalls", "index"].includes(s.paradigm?.kind)) throw new Error("补充只能保存新的能力项（契约、范式、陷阱或导航）");
              if (doc.sections.some(old => old.id === s.id) && !supplementAdded.has(s.id)) throw new Error("补充轮只能填写本轮新增的能力项，已有能力保持原样；需要改已有项请人在该项上返工");
            } else if (!wholeReview) {
              if (args.action !== "section" || !s) throw new Error("保存章节需使用 action=section，并在 section 中填写完整章节");
              if (s.id !== task.id) throw new Error(`只能保存当前任务编号的章节：当前 task.id=${task.id}，收到 section.id=${s.id}`);
              if (!["contracts", "paradigm", "pitfalls", "index"].includes(task.phase)) throw new Error(`当前任务类型 ${task.phase} 不保存章节；inventory/plan 请提交研究结果，synthesis 请保存 overview`);
              if (s.paradigm?.kind !== task.phase || s.paradigm?.component !== task.component) throw new Error("产物类型和组件必须与当前任务一致");
            }
            if (input.review && draftReads.get(s.id) !== doc.sections.find(old => old.id === s.id)?.revision) throw new Error("修订前必须读取当前章节全文");
            await verifyMetadata(s.paradigm, true);
            if (!Array.isArray(s.repository_ids) || s.paradigm.evidence.some((e: any) => !s.repository_ids.includes(e.repository_id))) throw new Error("章节来源仓需包含所有基础仓证据");
            if (!doc.sections.some(old => old.id === s.id)) { input.editDocument!({ action: "outline", entries: [{ id: s.id, title: s.title, repository_ids: s.repository_ids }] }); if (supplementing) supplementAdded.add(s.id); }
            const next = input.editDocument!({ action: "section", section: { ...s, sources: componentSources(s.paradigm) } }); saved = true;
            return reply(next.sections.find(row => row.id === s.id));
          } catch (error) { return failure(error); }
        },
      });
      const resultTool = defineTool({ name: "component_work_result", label: reviewing ? "提交独立评审" : "提交研究结果",
        description: "任务结束前必须提交。作者实际读取源码，用法同时检索调用和单元测试；评审回读产物、源码、调用与测试证据。退回写明位置和修改建议。",
        parameters: reviewing ? Type.Object({ pass: Type.Boolean(), feedback: Type.String() }) : resultSchema,
        execute: async (_id: string, params: any) => {
          try {
            signal.throwIfAborted(); if (JSON.stringify(params).length > 120000) throw new Error("结果过长，请拆分任务");
            scanForSecrets("组件研究结果", Buffer.from(JSON.stringify(params)));
            if (!sourceReads.length) throw new Error("必须实际读取基础仓代码");
            if (reviewing) {
              if (!params.feedback?.trim()) throw new Error("评审需说明依据或具体退回原因");
              if (params.pass) {
                const section = input.readDocument!().sections.find(s => s.id === task.id);
                if (section) {
                  if (draftReads.get(section.id) !== section.revision) throw new Error("必须读取当前版本的待评审章节");
                  await verifyMetadata(section.paradigm!, true);
                } else if (task.phase === "synthesis" && !overviewRead) throw new Error("必须读取汇总概述");
              }
              verdict = { pass: params.pass, feedback: params.feedback };
            } else {
              if (!discussing && !["inventory", "plan", "pitfalls"].includes(task.phase) && !saved) {
                // 重试会话可接着磁盘上的完整产物提交；回读和独立评审仍核对当前内容。
                const doc = input.readDocument!(), section = doc.sections.find(s => s.id === task.id);
                if (task.phase === "synthesis" && !wholeReview) {
                  if (!overviewRead) throw new Error("已有概述请先 research_document read 回读，再提交结果；无需重复保存");
                  validateComponentOverview(doc.overview);
                } else if (!input.review && section && sectionReady(section) && section.paradigm?.kind === task.phase && section.paradigm.component === task.component) {
                  if (draftReads.get(section.id) !== section.revision) throw new Error("已有完整章节请先 research_document read 回读当前版本，再提交结果；无需重复保存");
                  await verifyMetadata(section.paradigm, true);
                } else throw new Error("必须先保存本项产物；已有章节需完整且与当前任务类型、组件一致");
              }
              if (((!discussing && ["inventory", "plan", "paradigm"].includes(task.phase)) || input.record.challenge) && !searched) throw new Error("必须通过 everycode 查找实际调用，并如实记录缺口");
              if (!discussing && task.phase === "paradigm" && !searchedTests) throw new Error("请通过 everycode 检索本用法的单元测试，purpose 使用 unit-test，并展开对应测试代码");
              if (!params.findings?.trim() || !Array.isArray(params.open_questions)) throw new Error("请保存具体结论与待确认问题");
              const refs = await validateKnowledgeReferences(params.findings, snapshots, signal); if (refs.errors.length) throw new Error(refs.errors.join("；"));
              result = structuredClone(params);
            }
            return reply({ saved: true });
          } catch (error) { return failure(error); }
        },
      });
      const workTool = defineTool({ name: "component_work", label: "读取研究进度和调用证据",
        description: "id 读取依赖任务结果；evidence_id 读取已保存的 everycode 原始调用正文（版本未知时保持未知）。省略参数列任务摘要。",
        parameters: Type.Object({ id: Type.Optional(Type.String()), evidence_id: Type.Optional(Type.String()) }),
        execute: async (_id: string, args: { id?: string; evidence_id?: string }) => {
          if (args.evidence_id) {
            const e = evidence.find(e => e.evidence_id === args.evidence_id && e.tool === "code_search" && e.action === "read" && e.content);
            if (!e) return failure(new Error("没有该 everycode 代码证据")); callerReads.add(args.evidence_id);
            return reply({ evidence_id: e.evidence_id, repository: e.repository, path: e.path, start: e.start, end: e.end, content: e.content, revision: "以返回正文为准；未提供则未知" });
          }
          return reply(args.id ? pipeline?.state.tasks.find(t => t.id === args.id) ?? null : pipeline?.state.tasks.map(t => ({ id: t.id, phase: t.phase, title: t.title, status: t.status })) ?? []);
        },
      });
      const structureTool = defineTool({ name: "component_structure", label: "接口扫描候选",
        description: "分页读取确定性扫描的接口文件、声明与公开信号。这里只是候选，发布支持需回读构建代码，跨仓调用需 everycode 核实。",
        parameters: Type.Object({ start: Type.Optional(Type.Integer({ minimum: 0 })), count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
        execute: async (_id: string, args: { start?: number; count?: number }) => { const start = args.start ?? 0, count = Math.min(100, args.count ?? 30); return reply({ total: interfaces.length, candidates: interfaces.slice(start, start + count), next_start: start + count < interfaces.length ? start + count : undefined }); },
      });
      const tools = [structureTool, extractionSkillTool(sessionSkill), draftTool, resultTool, workTool,
        languageComponentSourceTool(components, async c => snapshots.find(s => s.repository.id === c.id)!, observe, excludedComponentSource),
        codeSearchTool(observe, { captureRead: true, excludePath: excludedComponentSource })];
      const phaseReference = reviewing ? "references/phase-review.md" : input.record.challenge ? "references/api-boundary.md" : input.review ? "references/draft-contract.md" : `references/phase-${task.phase}.md`;
      const prompt = `执行当前小任务，围绕模块范围读取基础仓代码及 everycode 实际调用和测试。先读取 references/platform-pipeline.md、references/schema.md 及 ${phaseReference}。用结构化工具保存结果；正文严格遵循组件指南模板。平台保存格式以 output_contract 为准，固定的旧 Skill 仍可用于研究方法。\n` +
        extractionSkillMission(sessionSkill, { task, review_result: reviewResult, mode: input.review?.mode ?? "extract", language: input.record.language,
          output_contract: {
            overview: "## 组件用途\n具体用途及适用对象\n\n## 接入配置\n真实依赖与配置",
            content: "### 适用场景\n具体需求与前提\n\n### 使用步骤\n完整操作顺序\n\n### 使用约束\n确定的条件与行为；有确证误用时追加 ### 常见误用",
            interfaces: "受支持接口正文，标题由平台生成", integration: "真实接入依赖和配置正文，标题由平台生成",
            example: "完整使用代码块", unit_tests: "完整单元测试代码块、fixture/mock、断言及实际构建运行配置",
            evidence: "源码引用、usage_evidence 调用原文、test_evidence 单元测试原文分别保存，当前会话实际回读",
            status: "recommended 需要完整模板和调用、测试依据；未验证研究可留空代码字段且只保留在任务内",
          },
          technology_stack: { id: input.record.language, name: technologyStack?.name ?? input.record.language },
          topic: input.record.topic, scope: "按技术栈分析文件操作、数据库操作、P2P 等功能能力；参考仓提供代码线索，一个能力可跨仓实现，真实组件与场景由分析确定", source_repositories: components, revisions,
          module: pipeline?.state.tasks.find(t => t.id === "inventory")?.result?.components?.find(module => module.id === task.component),
          continuation: !reviewing && !input.review ? {
            section: input.readDocument!().sections.filter(s => s.id === task.id).map(s => ({ id: s.id, revision: s.revision, complete: sectionReady(s) }))[0],
            instruction: "保留已完成任务和已有章节。已有完整章节先读取全文并核对其源码、调用和测试证据，内容无须修改时直接提交研究结果，不必重复保存；若 task.feedback 有修改要求则先处理。已有完整概述回读后可直接提交。",
          } : undefined,
          structure: task.phase === "inventory" ? knowledgeStructure(snapshots) : undefined,
          feedback: input.review ? { message: input.review.message, previous_revisions: input.review.previous_revisions } : undefined });
      const driver = await CloudSession.create({ taskId: `${input.record.id}-${sessionId}`, workspace: dir, agentDir, resumeSession: false, excludeAgentFiles: true,
        provider: model.provider, model: model.model, allowHumanQuestions: false, allowSubagents: false, allowedTools: tools.map(t => t.name), extraTools: tools,
        eventLog: new EventLog(join(dir, "events.jsonl"), event => { if (event.kind === "assistant_message") observe({ tool: "research_note", preview: evidencePreview(String(event.payload.text ?? "")) }); }),
        transcript: new TranscriptStore(join(dir, "transcript.jsonl"), "main"), gate: new GateService({ workspace: dir, cwd: dir, failClosed: true }),
        humanGate: new HumanGate(join(dir, "waiting.json")), currentStep: () => task.title, compactAnchor: () => task.title });
      const abort = () => { void driver.abort().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
      let expired = false; const sessionTimer = setTimeout(() => { expired = true; abort(); }, 45 * 60_000); sessionTimer.unref();
      try {
        signal.throwIfAborted(); let outcome = await driver.start(prompt);
        for (let i = 0; i < 2 && !result && !verdict && outcome.status === "turn_finished"; i++) outcome = await driver.startResume("请继续完成当前任务，使用 component_work_result 提交结构化结果。");
        signal.throwIfAborted();
        if (expired) throw new Error("本项研究超过 45 分钟，已停止；已通过的任务保留，可重试接续");
        if (outcome.status !== "turn_finished") throw new Error(`本项研究会话中断：${outcome.detail || outcome.reason || outcome.status}；已通过的任务保留，可重试接续`);
        if (!result && !verdict) throw new Error("模型结束了回复，但未提交研究结果；已通过的任务保留，可重试接续");
        writeFileSync(join(dir, "result.json"), JSON.stringify(verdict ?? result), { mode: 0o600 });
        return { result, verdict };
      } finally { clearTimeout(sessionTimer); signal.removeEventListener("abort", abort); driver.dispose(); }
    };
    if (input.record.challenge) {
      input.update({ stage: "独立核对原生用法与组件边界" });
      const response = await session({ id: "challenge", phase: "inventory", title: "寻找合理反例", status: "running", attempts: 1, dependencies: [],
        spec: `待验证主张（仅为假设，不能作为证据）：${input.record.challenge.claim}\n独立寻找必须保留原生写法、组件无法替代的合理场景。读取基础仓实现边界，并使用 everycode 搜索、展开消费方调用。不要修改文档或启用规则。结果说明：找到反例 / 当前未找到 / 证据不足；逐条列出基础仓固定版本、代码位置、消费方调用位置及不能替代的原因。未找到不等于证明正确，记录搜索范围、版本未知与待确认问题。` });
      return response.result!.findings + (response.result!.open_questions.length ? "\n\n待确认：\n" + response.result!.open_questions.join("\n") : "");
    }
    if (isWholeResearchReview(input.review)) {
      const before = input.readDocument!();
      const work: ComponentWork = { id: "whole-review", title: "按整体意见修订文稿", phase: "inventory", dependencies: [], status: "running", attempts: 1,
        spec: "先读取全部文稿，结合用户整体意见处理遗漏、重复与不准确的内容。可更新概述、修订已有能力或新增有依据的能力；没有被要求改动的内容保持原样。新增与修改内容都要核对代码与调用证据。" };
      const response = await session(work);
      const after = input.readDocument!();
      for (const section of after.sections.filter(item => JSON.stringify(item) !== JSON.stringify(before.sections.find(old => old.id === item.id)))) {
        const review = await session({ id: section.id, title: section.title, phase: section.paradigm!.kind, component: section.paradigm!.component,
          dependencies: [], status: "running", attempts: 1, spec: "核对整体意见对应的修订是否成立，并检查来源、接口与示例。" }, response.result!);
        if (!review.verdict?.pass) throw new Error(`能力「${section.title}」独立评审未通过：${review.verdict?.feedback}`);
      }
      if (after.overview !== before.overview) {
        const review = await session({ ...work, id: "whole-review-overview", phase: "synthesis", title: "核对修订后的概述" }, response.result!);
        if (!review.verdict?.pass) throw new Error(`概述独立评审未通过：${review.verdict?.feedback}`);
      }
      return response.result!.findings;
    }
    if (input.review?.mode === "supplement") {
      const before = new Set(input.readDocument!().sections.map(s => s.id));
      const work: ComponentWork = { id: "supplement", title: "补充遗漏能力", phase: "inventory", dependencies: [], status: "running", attempts: 1,
        spec: "专家指出文稿遗漏了能力。先 research_document read 看清已有能力，不要重复已有项；在本次研究范围的组件仓内核对用户所说的遗漏，"
          + "每个确有依据的新能力用新编号保存为 contracts、paradigm、pitfalls 或 index 章节（按对应 phase 文件要求写，含接口、集成依赖、完整示例与证据）。"
          + "已有能力不改；查无依据就如实说明，不要硬凑。" };
      const response = await session(work);
      // 每个新增项都独立评审，与全量研究同一道门槛；任一不过整轮不并入。
      for (const added of input.readDocument!().sections.filter(s => !before.has(s.id))) {
        const check: ComponentWork = { id: added.id, title: added.title, phase: added.paradigm!.kind, component: added.paradigm!.component, dependencies: [], status: "running", attempts: 1,
          spec: "评审本轮补充的新能力项：是否确为文稿遗漏、证据与示例是否成立。" };
        const review = await session(check, response.result!);
        if (!review.verdict?.pass) throw new Error(`新增能力「${added.title}」独立评审未通过：${review.verdict?.feedback}`);
      }
      return response.result!.findings;
    }
    if (input.review) {
      const section = input.readDocument!().sections.find(s => s.id === input.review!.section_id)!;
      if (!section.paradigm) throw new Error("历史章节没有结构化范式，请新建研究；原稿保留可读");
      const work: ComponentWork = { id: section.id, title: section.title, phase: section.paradigm.kind, component: section.paradigm.component,
        spec: "围绕用户反馈核对当前章节，保留已有人工内容。先 research_document read，再提出局部修订。", dependencies: [], status: "running", attempts: 1 };
      const response = await session(work);
      if (input.review.mode !== "discuss") {
        const review = await session(work, response.result!); if (!review.verdict?.pass) throw new Error(`独立评审未通过：${review.verdict?.feedback}`);
      }
      return response.result!.findings;
    }
    await pipeline!.run({ signal, concurrency: options.concurrency, execute: async t => (await session(t)).result!,
      review: async (t, r) => { const v = (await session(t, r)).verdict!; return v.pass ? undefined : v.feedback; },
      changed: state => input.update({ pipeline: state, stage: state.tasks.filter(t => t.status === "running").map(t => t.title).join("、") || "组件用法研究" }) });
    return researchDraftContext(input.record, input.readDocument!());
  } catch (error) {
    if (totalExpired && !input.signal.aborted) throw new Error(KNOWLEDGE_RESEARCH_BUDGET_MESSAGE);
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
