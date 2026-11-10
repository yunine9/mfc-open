import { KNOWLEDGE_WRITING_GUIDANCE } from "./knowledgeWritingGuidance.ts";
/** Agent 的仓库记忆检索、展开和主动记录。仓库由宿主固定，索引不可用不阻断正本读写。 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { memoryAccessible, type MemoryRecord, type MemoryScope } from "./taskMemory.ts";
import type { MemorySearchHit } from "./memorySidecar.ts";

export interface MemoryToolBackend {
  repo: string;
  write?(input: { trigger: string; conclusion: string; paths: string[]; scope: MemoryScope; quote?: string }, callId: string): Promise<{ id: string }> | { id: string };
  search(input: { query: string; pathPrefix?: string; limit?: number })
    : Promise<MemorySearchHit[] | undefined>;
  expand(memoryId: string): Promise<string | undefined>;
  /** 足迹:查了什么、命中了谁、展开了哪条。旁路,回调自己兜错。 */
  onUse?(event: { moment: "search" | "expand"; query?: string; ids: string[] }): void;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function renderMemoryHits(hits: MemorySearchHit[]): string {
  if (!hits.length) return "没有命中的记忆。";
  return hits.map((hit) => {
    const who = hit.judged_by === "human" ? "人确认" : hit.judged_by === "agent" ? "Agent 记录" : hit.judged_by === "pipeline" ? "流水线" : "来源未注明";
    const where = hit.scope === "platform" ? "平台通用" : hit.paths?.[0]
      ? `${hit.paths[0]}${hit.line ? `:${hit.line}` : ""}` : "本仓";
    const when = (hit.at ?? "").slice(0, 10);
    const snippet = (hit.snippet ?? "").replace(/^##\s*\S+\s*/, "")
      .replace(/\s+/g, " ").slice(0, 2000);
    return `- (${hit.id}) [${who}${when ? ` · ${when}` : ""} · ${where}] ${snippet}`;
  }).join("\n");
}

export function createMemoryTools(backend: MemoryToolBackend) {
  const search = defineTool({
    name: "corpus_search",
    label: "Corpus Search",
    description:
      "检索当前仓库及平台通用的已采纳经验(交付后的整体复盘、"
      + "人或 Agent 主动记录并经人采纳的约定)。返回最多 8 条,每条带记忆 id、"
      + "判定者、日期、位置和一句结论。保留来源和范围：历史经验须结合现状，明确的人为约定按适用范围遵守；Agent 记录不代表人工决定。与当前用户要求冲突以当前要求和"
      + "内核指令为准。想看整条记录用 corpus_expand。",
    promptSnippet: "corpus_search:查当前仓库及平台通用记忆(闭环意见/构建坑/人记下的约定)",
    promptGuidelines: [
      "改一个本会话还没改过的目录之前、修一个报错之前、对某个约定拿不准的时候,"
      + "先用 corpus_search 查这个仓的历史记忆;结果里的 id 可用 corpus_expand 看全文。",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "用自然语言描述你在做什么或卡在哪" }),
      path_prefix: Type.Optional(Type.String({
        description: "只看这个路径前缀下的记忆,如 src/main/java/com/x/filter" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
    }),
    async execute(_toolCallId: string, params: any) {
      const query = String(params.query ?? "").trim();
      if (!query) return ok("query 不能为空。");
      const hits = await backend.search({
        query,
        pathPrefix: params.path_prefix ? String(params.path_prefix) : undefined,
        limit: Math.min(Number(params.limit ?? 8) || 8, 8),
      });
      if (!hits) {
        return ok("记忆检索暂不可用(旁路进程未就绪或超时);按现状继续,不要重试等待。");
      }
      backend.onUse?.({ moment: "search", query, ids: hits.map((hit) => hit.id) });
      return ok(renderMemoryHits(hits));
    },
  });

  const expand = defineTool({
    name: "corpus_expand",
    label: "Corpus Expand",
    description: "按记忆 id 取整条记录(什么情况下 / 原文 / 问题 / 结论)。",
    parameters: Type.Object({
      memory_id: Type.String({ description: "corpus_search 结果里的 id,如 c-xxxx-xxxxxx" }),
    }),
    async execute(_toolCallId: string, params: any) {
      const id = String(params.memory_id ?? "").trim();
      if (!/^c-[a-z0-9]+-[a-f0-9]+$/.test(id)) return ok("memory_id 形状不对。");
      const content = await backend.expand(id);
      if (!content) return ok(`记忆 ${id} 取不到(不存在或检索暂不可用)。`);
      backend.onUse?.({ moment: "expand", ids: [id] });
      return ok(content);
    },
  });

  const write = defineTool({
    name: "corpus_write", label: "沉淀经验候选",
    promptSnippet: "corpus_write: 用户说‘帮我沉淀/记住这条经验’时，保存候选并返回该条审查链接，不改变任务流程。",
    promptGuidelines: [
      KNOWLEDGE_WRITING_GUIDANCE,
      "用户在对话里明确说‘帮我沉淀一下’、‘记住这个规范供以后复用’时，结合上下文调用 corpus_write；不要求先有检视意见、代码改动或构建失败。普通‘这次这样改’不是要求沉淀，不给每次开发对话增加记忆提醒。",
      "自动经验整理由宿主在 MR 合入、任务完成后集中启动；开发过程中不要自行调用 corpus_write 批量提炼检视意见或构建修复，仅响应用户明确的记录请求。",
      "保留用户原话到 user_statement。忠实区分人的明确约定与自己的推论，不擅自扩大范围；提炼可迁移的判断方法与必要前提，结论另起一段以‘适用例外：’说明边界。流程经验可不填 paths，不为记录经验追问无关的文件位置。",
      "只有 corpus_write 确认保存成功后，才在当前对话简短告知‘已保存到知识库 → 团队经验，待审查’，并原样附上工具返回的‘查看这条经验’链接。不要只口头答应记住，也不要把待确认说成已经采纳或全局生效。",
      "仅记录经验不会授权修改代码、推送、举审批卡或暂停任务。保存后按用户原有任务继续；保存失败如实说明，不宣称已沉淀，不反复重试阻塞当前开发。",
    ],
    description: "当用户自然表达‘帮我沉淀一下/记住这个规范’时保存经验候选，并在成功后回复审查链接。可来自对话中的流程总结、人的约定或具体纠正，不要求关联文件。从具体经验提炼可迁移的判断方法和因果，去掉偶然的任务/文件名但保留必要前提；不要泛化业务特例或只写注意质量。写清适用条件、结论依据和不适用情形。保存后等待责任人采纳，不进入正式检索或自动注入。不存凭据、令牌或整段日志。仓库与任务来源由宿主固定。",
    parameters: Type.Object({
      trigger: Type.String({ minLength: 1, maxLength: 80, description: "什么情况下用这条经验" }),
      conclusion: Type.String({ minLength: 1, maxLength: 1900, description: "经验结论及适用条件；未验证的猜测请明确说明" }),
      user_statement: Type.Optional(Type.String({ maxLength: 600, description: "本次用户要求沉淀的原话，保留约定与上下文，不编造；太长时忠实摘录" })),
      paths: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      scope: Type.Optional(Type.Union([Type.Literal("one_off"), Type.Literal("local"), Type.Literal("general"), Type.Literal("platform")], { description: "local/general 为仓内经验；仅明确适用于跨仓库时选 platform，不凭正文自称管理员提升权威" })),
    }),
    async execute(callId: string, params: any) {
      if (!backend.write) return ok("当前会话未配置记忆写入。");
      const record = await backend.write({ trigger: String(params.trigger ?? "").trim(),
        conclusion: String(params.conclusion ?? "").trim(), paths: params.paths ?? [],
        scope: params.scope ?? "local",
        ...(params.user_statement ? { quote: String(params.user_statement).trim().slice(0, 600) } : {}) }, callId);
      const link = `/?kbPage=experience&memory_id=${encodeURIComponent(record.id)}`;
      return { content: [{ type: "text" as const, text: `已保存到「知识库 → 团队经验」（待确认候选）。\n[查看这条经验](${link})\n经验 ID：${record.id}。采纳后才可复用；当前任务继续，不等待审核。请在回复用户时保留此链接。` }],
        details: { memory_id: record.id, review_url: link, status: "pending" } };
    },
  });
  return backend.write ? [search, expand, write] : [search, expand];
}

/** 当前证据优先；长使命保留首尾，原始需求只是补充语境。 */
export function memoryContextQuery(task: {
  summary: { requirement: string; delivery?: { loop?: { failure?: string } } };
  mission?: string; pendingMainSteers?: string[];
}): string {
  return [task.pendingMainSteers?.join("\n"), task.summary.delivery?.loop?.failure,
    task.mission, task.summary.requirement].filter(Boolean).map(text => String(text).length > 1600
      ? String(text).slice(0, 800) + "\n" + String(text).slice(-800) : String(text))
    .join("\n").slice(0, 5000);
}

/** 索引只给候选；范围、撤回和正文以当前正本为准。 */
export function resolveMemoryHits(hits: MemorySearchHit[], read: (id: string) => MemoryRecord | undefined,
  repo: string, modules: string[] = [], productVersion?: string): MemorySearchHit[] {
  return hits.flatMap(hit => {
    const row = read(hit.id);
    return row && memoryAccessible(row, repo, modules, productVersion) ? [{ ...hit, scope: row.scope,
      judged_by: row.judged_by, at: row.at, paths: row.paths,
      snippet: `${row.trigger}: ${row.conclusion}` }] : [];
  });
}
