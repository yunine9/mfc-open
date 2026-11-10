import type { MemoryUsageEvent } from "./memoryUsage.ts";
import { componentRepositories } from "./componentRepositories.ts";
import type { ComponentResearch } from "./componentResearch.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { KnowledgeSearch, KnowledgeContext } from "./knowledgeSearch.ts";
import { COMPONENT_PLAN_TEMPLATE, type ComponentPlan } from "./componentPlan.ts";
import { componentUsageDocument } from "./componentKnowledgeCards.ts";

export function createKnowledgeTool(options: {
  research?: () => ComponentResearch;
  researchOperator?: () => string;
  service: () => KnowledgeSearch | undefined;
  context: () => KnowledgeContext;
  plan?: () => ComponentPlan;
  onUse?: (event: MemoryUsageEvent) => void;
}) {
  const reply = (text: string, details: object = {}) => ({ content: [{ type: "text" as const, text }], details });
  const observe = (event: MemoryUsageEvent) => {
    try { options.onUse?.(event); } catch { /* Observation must not change a successful read. */ }
  };
  // 组件研究指引只在实际注入了 research 后端时教学：问题单等旁路
  // 会话不往知识库写、也不发起研究，不能教 Agent 调一个注定
  // 「暂不可用」的动作。
  const researchGuideline = "当前任务明确要求开展组件研究时，用 knowledge(action=research, language=cpp) 对该技术栈发起后台研究，默认参考所有已启用来源仓。knowledge(action=components) 列出参考源码；repository_ids 可选，用于限定参考来源。文件操作、数据库操作、P2P 等功能组件由分析确定，一个组件可跨仓实现。同一技术栈及来源范围已有研究时直接返回原记录。用返回的记录 ID 调 research_status 查看。继续其他独立工作，不循环轮询；草稿须经人工审查采纳。检索没有命中不自动发起研究。";
  const baseGuidelines = [
    "调查需求和源码时，随着发现新的职责、接口或约束，用 knowledge(action=search, query=具体问题) 查相关组件、规范和经验。查询写清准备做什么、关键技术或现象，保留命令、接口名、错误码和产品版本。",
    "尚不知道可复用能力或组件名称时，用 knowledge(action=component_context) 浏览能力目录，按 next_offset 翻页。按要做的事和适用场景理解候选；也可用 knowledge(action=search, scope=components, query=调查需求或源码后发现的具体职责或约束) 主动查找，不要求先知道接口名。",
    "例如：准备改异步回调，搜索‘C++ 异步回调 对象销毁 生命周期’；后来发现需要改 YAML，再搜索‘该配置用途 YAML 修改规范’。准备首次构建，搜索‘该仓库 C++ 首次构建 UT 依赖 命令’。",
    "组件候选用 knowledge(action=read, id=文档ID, revision=结果修订号, paradigm_id=用法编号) 从头读取公共用途、接入配置与选定用法。按返回的 next_offset 保持同一 revision 连续续读，直到 complete=true，再确认完整条件、示例和尾部约束；只读命中片段不能代替这份依据。",
    "普通文档先看适用条件、来源和版本，再用 knowledge(action=read, id=搜索结果ID, start_line=命中起始行, end_line=命中结束行, revision=结果版本) 读取规则和例外。结果提示后续行时按需继续读取。同一问题已查过且条件未变化，继续复用，不在每次读文件、改代码前重复搜索。遇到新的问题再查。",
    "检索结果只是候选：先核对业务模块、语言、来源路径；同名文档或相似术语不能混用，不凭目录名猜适用模块。不匹配当前仓库、产品版本或适用条件的不要套用，不因排名第一就视为正确。未声明产品版本时核对正文；不能把文档修订号当成适用产品版本。知识不覆盖当前用户明确要求，不代替实际验证。",
    "没有相关结果或检索暂不可用，按代码和现有证据继续，不反复空查或等待。发现知识与现场冲突时说明冲突，不擅自改写已采纳结论。",
  ];
  return defineTool({
    name: "knowledge", label: "检索团队知识",
    description: "统一查找已发布的团队文档、业务模块知识和已采纳经验。search 按要解决的问题检索，返回短卡片和原文位置；read 带 paradigm_id 和 revision 读取公共接入配置及选定组件用法，按 next_offset 续读到 complete=true。普通文档按行读取。component_context 按页浏览当前适用的能力目录，每页最多 12 条，用 next_offset 继续。plan 的 validate/check_impl/gaps 可核对已有组件使用计划。Skill 通过会话已有技能目录按需加载。索引不可用时继续工作，不阻塞任务。",
    promptSnippet: "knowledge: search 查团队、模块、仓库知识及已采纳经验；read 展开正文。",
    promptGuidelines: options.research ? [researchGuideline, ...baseGuidelines] : baseGuidelines,
    parameters: Type.Object({
      action: Type.Union([Type.Literal("search"), Type.Literal("read"), Type.Literal("component_context"), Type.Literal("plan"), Type.Literal("components"), Type.Literal("research"), Type.Literal("research_status")]),
      operation: Type.Optional(Type.Union([Type.Literal("validate"), Type.Literal("check_impl"), Type.Literal("gaps")])),
      scope: Type.Optional(Type.Literal("components")),
      plan_path: Type.Optional(Type.String({ maxLength: 1000 })), capability: Type.Optional(Type.String({ pattern: "^C[1-9][0-9]*$" })),
      repository_ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, uniqueItems: true })), language: Type.Optional(Type.String()),
      query: Type.Optional(Type.String({ maxLength: 4000 })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "component_context 的条目位置，或带 paradigm_id 的 read 的字符位置；仅使用对应操作上次返回的 next_offset，默认 0。" })),
      id: Type.Optional(Type.String({ maxLength: 200 })),
      paradigm_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "组件卡片中的用法编号；read 同时提供 id、revision，可连同公共配置完整读取该用法。" })),
      start_line: Type.Optional(Type.Integer({ minimum: 1 })),
      end_line: Type.Optional(Type.Integer({ minimum: 1 })),
      revision: Type.Optional(Type.String()),
    }),
    async execute(_callId: string, input: { action: string; operation?: string; scope?: string; plan_path?: string; capability?: string; repository_ids?: string[]; language?: string; query?: string; offset?: number; id?: string; paradigm_id?: string; start_line?: number; end_line?: number; revision?: string }) {
      try {
        if (["components", "research", "research_status"].includes(input.action)) {
          const research = options.research?.();
          if (!research) return reply("组件萃取暂不可用，继续当前任务。");
          if (input.action === "components") return reply(JSON.stringify({ source_repositories: componentRepositories(research.dir).filter(c => c.enabled) }));
          const record = input.action === "research" ? research.start({ language: input.language ?? "", ...(input.repository_ids ? { repository_ids: input.repository_ids } : {}) }, options.researchOperator?.() ?? "本地部署") : research.get(input.id ?? "");
          return reply(JSON.stringify({ ...record, key: undefined, url: `/?kbPage=task&kbKind=component&kbTask=${record.id}` }) + "\n草稿须人工审查采纳才进入知识库；继续独立工作，不循环轮询。");
        }
        const service = options.service();
        if (!service) { observe({moment:input.action === "read" ? "expand" : "search",ids:[],status:"unavailable",reason:"unavailable",requested_id:input.id});
          return reply("知识检索暂不可用；继续当前任务，不反复重试等待。"); }
        const context = options.context();
        const planService = options.plan?.();
        const plan = input.plan_path && planService ? { path: planService.path(input.plan_path).relative, capability: input.capability, operation: input.action } : undefined;
        if (input.action === "component_context") {
          const result = service.componentContext(context, input.offset);
          observe({ moment: "context", plan, ids: result.hits.map(h => h.id), assets: result.hits, status: "ready" });
          const next = result.next_offset === null ? "已到当前目录末页。" : `继续浏览可用 knowledge(action=component_context, offset=${result.next_offset})；已明确问题时可直接 search。`;
          const template = input.plan_path ? "\n已有计划需要记录组件选择时，可沿用此模板；来源版本填 id@revision。\n" + COMPONENT_PLAN_TEMPLATE : "";
          return reply(JSON.stringify(result) + `\n${next} 卡片按要做的事帮助发现候选；用 knowledge(action=read, id=文档ID, revision=修订号, paradigm_id=用法编号) 阅读公共配置及选定用法。` + template, result);
        }
        if (input.action === "plan") {
          if (!planService) return reply("当前会话没有计划工作区，不能检查计划；继续分析并说明缺口。");
          if (input.operation === "gaps") return reply(JSON.stringify({ gaps: planService.gaps() }));
          if (!input.plan_path) return reply("请提供现有 implementation 文档的 plan_path。");
          if (!["validate", "check_impl"].includes(input.operation ?? "")) return reply("operation 请选择 validate、check_impl 或 gaps。");
          const result = input.operation === "validate" ? planService.validate(input.plan_path) : await planService.check(input.plan_path);
          const errors = "errors" in result ? result.errors.length : result.findings.length;
          observe({ moment: "component_plan", ids: [], status: errors ? "rejected" : "ready", plan: { path: result.path, operation: input.operation!, errors, warnings: result.warnings.length } });
          return reply(JSON.stringify(result) + "\n这是计划核对结果，不新增交付门禁。", result);
        }
        if (input.action === "search") {
          const query = input.query?.trim();
          if (!query) return reply("请提供当前要解决的具体问题 query。");
          const result = await service.search(context, query, 5, input.scope === "components");
          observe({ moment: "search", query, plan, ids: result.hits.map(hit => hit.id),
            status: !result.available ? "unavailable" : result.hits.length ? "ready" : "empty",
            assets: result.hits.map(hit => ({id:hit.id,revision:hit.revision,start_line:hit.start_line,end_line:hit.end_line,heading:hit.heading,card_id:hit.card_id,retrieval:hit.retrieval})) });
          const warning = result.warnings.length ? `\n提示：${result.warnings.join("；")}` : "";
          if (!result.available) return reply(result.warnings.join("；"), { available: false });
          if (!result.hits.length) return reply("未找到足够相关的知识；继续根据现场证据工作，不代表相关知识一定不存在。" + warning, { available: true, hits: [] });
          return reply("以下是候选知识，不是已验证适用的答案。核对条件，必要时用 knowledge read 展开正文。\n"
            + result.hits.map(hit => `- (${hit.id}) ${hit.title}${hit.card_id ? `；card-id: ${hit.card_id}；检索方式：${hit.retrieval}` : ""}\n  ${hit.scope}；${hit.versionNote}\n  章节：${hit.heading ?? hit.title}；原文行：${hit.start_line ?? 1}-${hit.end_line ?? "未定位"}；revision=${hit.revision}\n  适用条件：${hit.whenToUse}\n  摘要：${hit.summary}${hit.paradigm_id ? `\n  完整用法：knowledge(${JSON.stringify({ action: "read", id: hit.id, revision: hit.revision, paradigm_id: hit.paradigm_id })})` : ""}${hit.contracts?.length ? `\n  相关契约：${JSON.stringify(hit.contracts)}` : ""}`).join("\n") + warning, result);
        }
        if (input.action !== "read" || !input.id) return reply("read 需要提供搜索结果中的 id。");
        const asset = service.read(context, input.id);
        if (!asset) { observe({moment:"expand",ids:[],requested_id:input.id,status:"rejected",reason:"not_accessible"});
          return reply("该知识取不到：已停用、已不适用于当前任务或不存在；不要沿用旧结论。"); }
        if (input.revision && input.revision !== asset.revision) { observe({moment:"expand",ids:[],requested_id:input.id,status:"rejected",reason:"revision_changed"});
          return reply("文档已更新，请重新 search 定位章节，不沿用旧版本行号。"); }
        if (input.paradigm_id !== undefined) {
          if (!input.revision) return reply("组件用法读取需要提供目录或搜索结果中的 revision，确保公共配置和各页正文来自同一修订。");
          if (input.start_line !== undefined || input.end_line !== undefined) return reply("组件用法整体读取使用 offset 续读，请勿同时传 start_line/end_line。");
          const document = componentUsageDocument(asset, input.paradigm_id), start = input.offset ?? 0;
          if (!document) return reply("该正式文档中没有此用法编号，请重新浏览组件目录或搜索，不套用其他用法。");
          if (!Number.isSafeInteger(start) || start < 0 || start >= document.text.length
            || (start > 0 && /[\uD800-\uDBFF]/.test(document.text[start - 1]) && /[\uDC00-\uDFFF]/.test(document.text[start]))) {
            observe({ moment: "expand", ids: [], requested_id: input.id, status: "rejected", reason: "invalid_range" });
            return reply("组件用法 offset 无效；首次读取省略 offset，续读使用上次返回的 next_offset。");
          }
          let end = Math.min(document.text.length, start + 20_000);
          if (end < document.text.length && /[\uD800-\uDBFF]/.test(document.text[end - 1]) && /[\uDC00-\uDFFF]/.test(document.text[end])) end--;
          const complete = end === document.text.length, next = complete ? null : end;
          const ranges = document.sections.filter(section => section.end_offset > start && section.start_offset < end)
            .map(section => ({ heading: section.heading, start_line: section.start_line, end_line: section.end_line,
              complete_in_page: section.start_offset >= start && section.end_offset <= end }));
          // 字符分页可能只暴露半行；只有整个区块已展示时才登记该区块的完整原文范围。
          observe({ moment: "expand", plan, ids: [asset.id], status: "ready", assets: [{ id: asset.id, revision: asset.revision, heading: `组件用法 ${input.paradigm_id}，字符 ${start}–${end}` },
            ...ranges.filter(range => range.complete_in_page).map(({ complete_in_page: _, ...range }) => ({ id: asset.id, revision: asset.revision, ...range }))] });
          const follow = complete ? "complete=true：已到所选资料末尾；请连同从 offset=0 开始读取的前页核对，不能把末页单独当成完整依据。"
            : `complete=false：公共配置或用法正文仍有未读内容，不能据此确认完整用法。继续调用 knowledge(${JSON.stringify({ action: "read", id: asset.id, revision: asset.revision, paradigm_id: input.paradigm_id, offset: next })})。`;
          return reply(`${asset.title.slice(0, 160)}\n来源：${asset.id}；revision=${asset.revision}（不是依赖版本）\n`
            + `所选资料字符 ${start}–${end}，共 ${document.text.length}；分页可能接续上一页代码或段落。\n\n`
            + document.text.slice(start, end) + `\n${follow}`, { id: asset.id, revision: asset.revision, paradigm_id: input.paradigm_id,
              offset: start, end_offset: end, total_chars: document.text.length, next_offset: next, complete, source_ranges: ranges });
        }
        if (input.offset !== undefined) return reply("普通文档按 start_line/end_line 读取；组件整体用法请同时提供 paradigm_id 和 revision，再用 offset 续读。");
        const lines = asset.content.split("\n");
        const start = Math.max(1, input.start_line ?? 1);
        if (start > lines.length || (input.end_line !== undefined && input.end_line < start)) {
          observe({moment:"expand",ids:[],requested_id:input.id,status:"rejected",reason:"invalid_range"});
          return reply(`读取范围无效；该文档共 ${lines.length} 行，请使用搜索返回的原文行号。`);
        }
        const end = Math.min(lines.length, input.end_line ?? start + 119, start + 599);
        const selected: string[] = [];
        let size = 0;
        for (let i = start - 1; i < end; i++) {
          const line = `${i + 1}: ${lines[i]}`;
          if (size + line.length > 24000 && selected.length) break;
          selected.push(line); size += line.length;
        }
        const next = start + selected.length;
        observe({ moment: "expand", plan, ids: [asset.id],status:"ready",assets:[{id:asset.id,revision:asset.revision,start_line:start,end_line:start+selected.length-1}] });
        return reply(`${asset.title}\n范围：${asset.scope}\n文档修订：${asset.revision}（不是产品版本）\n`
          + `产品版本：${asset.productVersions.join("、") || "未单独声明，请核对正文"}\n`
          + `适用条件：${asset.whenToUse}\n共 ${lines.length} 行，从 ${start} 行开始：\n`
          + selected.join("\n") + (next <= lines.length ? `\n后续原文从第 ${next} 行继续读取；勿把未读取的例外当作不存在。` : ""),
          { id: asset.id, revision: asset.revision, total_lines: lines.length, start_line: start, end_line: next - 1, next_line: next <= lines.length ? next : undefined });
      } catch (error) {
        if (input.action === "plan" || input.plan_path) return reply(error instanceof Error ? error.message : "计划检查未完成");
        if (["components", "research", "research_status"].includes(input.action)) return reply(error instanceof Error ? error.message : "萃取暂不可用");
        observe({moment:input.action === "read" ? "expand" : "search",ids:[],requested_id:input.id,status:"unavailable",reason:"unavailable"});
        return reply("知识读取暂不可用；继续当前任务，不反复重试等待。");
      }
    },
  });
}
