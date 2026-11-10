import { KNOWLEDGE_WRITING_GUIDANCE } from "./knowledgeWritingGuidance.ts";
/**
 * 旁路提炼可复用的经验草稿。模型只建议结论与范围，不替人采纳；失败保留原始候选。
 * 目录摘要工具保留供现有调用方使用，不改变任务运行。
 */

import type { MemoryRecord, MemoryScope } from "./taskMemory.ts";
import { MEMORY_TRIGGER_LIMIT } from "./taskMemory.ts";

/** 起草与摘要都是旁路,不在主会话的路上,预算可以给宽:内网网关慢(用户
 * 2026-09-03 拍板 10 s 太短),给 90 s;到点就放弃、保留模板,绝不重试硬等。 */
export const MEMORY_DRAFT_BUDGET_MS = 90_000;
export const MEMORY_DIGEST_BUDGET_MS = 90_000;
/** 单目录超过这个数就推摘要不推明细(§13)。 */
export const MEMORY_DIGEST_THRESHOLD = 15;

const SCOPES: MemoryScope[] = ["one_off", "local", "general", "platform"];

export function buildMemoryDraftPrompt(record: MemoryRecord): { system: string; user: string } {
  const system = [
    KNOWLEDGE_WRITING_GUIDANCE,
    "你在为软件团队从任务记录中提炼可复用经验。输入是一次处理的来源材料，不自动证明结论正确或可推广。",
    "整理为待人工确认的经验候选，不是已经成立的规范。只回 JSON:",
    "conclusion 提炼可复用做法、证据依据和适用例外；不能只复述‘已修复’。证据不足时明确缺什么，不凭一次绿灯推导普遍结论。",
    "提炼步骤：先辨认被纠正的判断或缺失的知识，再解释为什么会错、什么条件下应如何判断；最后检验换一个仓库或业务对象是否仍成立。",
    "适度抽象：将订单名、任务号、文件名等偶然细节留在来源证据中；结论优先表达可迁移的因果关系、判断方法和行动。保留会改变结论的技术或业务前提，不能把业务规则泛化为全平台规则。",
    "例如：不要只记‘修正订单服务的重试’，可提炼为‘调用有外部副作用的接口超时时，先核对幂等保障或查询操作结果，再决定重试；纯读取或已保证幂等的调用不适用同样限制’。这只是抽象方式示例，不是所有候选的内容模板。",
    "避免‘注意质量、充分测试’等无法指导下一次行动的空话；没有可复用因果或足够依据就保留 one_off，不强行总结大道理。",
    "conclusion 用简短正文描述做法与依据；另起一段以‘适用例外：’写明前提、边界或缺失证据，方便人审查。",
    "不要把个人偏好当作普遍质量规则。区分缺业务知识、缺上下文与执行失误。不要编造修改、测试或验证结果。",
    '{"trigger": "<什么情况下该想起这条,一句话,动作锚定,不超过 40 字>",',
    ' "scope": "one_off" | "local" | "general" | "platform", "conclusion": "<提炼结论、依据与例外，尽量 300 字以内>"}',
    "scope 判断标准:",
    "- one_off:只对这一单成立(如临时数据、这次的手滑、与需求绑定的取舍),下一单改到同一处也用不上。",
    "- local:改到同一个文件/目录时才有用(这里的约定、这块的坑)。",
    "- general:改这个仓库任何地方都可能用到的规矩(命名、提交、依赖、安全底线)。",
    "- platform:不依赖当前仓特殊条件的跨仓工程经验，只是范围建议，仍需人工采纳。",
    "拿不准时选 local。trigger 用中文,以「改/加/修/写…时」这类动作开头。",
  ].join("\n");
  const user = [
    `来源:${record.source} / 判定者:${record.judged_by}`,
    `位置:${record.paths.join(", ") || "(无路径)"}${record.line ? `:${record.line}` : ""}`,
    record.phase ? `阶段:${record.phase}` : "",
    record.quote ? `原文:\n${record.quote.slice(0, 600)}` : "",
    record.problem ? `问题:\n${record.problem.slice(0, 800)}` : "",
    `结论:\n${record.conclusion.slice(0, 800)}`,
    `现在的模板 trigger:${record.trigger}`,
  ].filter(Boolean).join("\n\n");
  return { system, user };
}

/** 模型回复 → {trigger, scope};形状不对返回 undefined,调用方按起草失败处理。 */
export function parseMemoryDraft(text: string): { trigger: string; scope: MemoryScope; conclusion?: string } | undefined {
  const match = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const trigger = String((parsed as { trigger?: unknown }).trigger ?? "")
    .replace(/\s+/g, " ").trim();
  const scope = (parsed as { scope?: unknown }).scope;
  if (!trigger || trigger.length > MEMORY_TRIGGER_LIMIT) return undefined;
  if (!SCOPES.includes(scope as MemoryScope)) return undefined;
  const conclusion = (parsed as { conclusion?: unknown }).conclusion;
  if (conclusion !== undefined && (typeof conclusion !== "string" || !conclusion.trim() || conclusion.length > 1200)) return undefined;
  return { trigger, scope: scope as MemoryScope, ...(typeof conclusion === "string" ? { conclusion: conclusion.trim() } : {}) };
}

/** 摘要缓存键:成员 id 集合的稳定串。成员变了就重做,没变就复用。 */
export function digestKey(rows: Array<Pick<MemoryRecord, "id">>): string {
  return rows.map((row) => row.id).sort().join(",");
}

export function buildDirectoryDigestPrompt(
  dir: string,
  rows: MemoryRecord[],
): { system: string; user: string } {
  const system = [
    "你在为一个软件团队的任务记忆库写目录摘要。下面是同一个目录里积累的历史记忆,",
    "每条都是闭环过的事实(意见被改并确认,或构建失败被修好)。",
    "把它们压成一段给编码 Agent 看的摘要:不超过 8 行、每行一条要点,合并重复、去掉一次性的,",
    "每条要点末尾用括号带上最相关的一两个记忆 id。只输出摘要正文,不要标题、不要解释。",
    "措辞是线索不是命令:写「有人要求过 X」,不写「必须 X」。",
  ].join("\n");
  const user = [
    `目录:${dir || "仓库根"}(共 ${rows.length} 条)`,
    ...rows.map((row) => `- (${row.id}) [${row.judged_by === "human" ? "人确认" : row.judged_by === "agent" ? "Agent 记录" : "流水线"}`
      + ` · ${row.at.slice(0, 10)} · ${row.paths[0] ?? ""}] ${row.trigger}:`
      + `${row.conclusion.replace(/\s+/g, " ").slice(0, 200)}`),
  ].join("\n");
  return { system, user };
}

/** 确定性兜底摘要:按权重取前几条,其余只报数。 */
export function renderDirectoryDigestFallback(
  dir: string,
  rows: MemoryRecord[],
  top = 5,
): string {
  const head = rows.slice(0, top).map((row) =>
    `- ${row.trigger}:${row.conclusion.replace(/\s+/g, " ").slice(0, 120)}(${row.id})`);
  const rest = rows.length - head.length;
  return [
    ...head,
    rest > 0 ? `- 另有 ${rest} 条,用 knowledge search 描述 ${dir || "当前工作"} 的具体问题查明细。` : "",
  ].filter(Boolean).join("\n");
}

/** 模型摘要的形状校验:非空、不超 12 行、至少引用一个真实 id;否则用兜底。 */
export function parseDirectoryDigest(text: string, rows: MemoryRecord[]): string | undefined {
  const body = String(text ?? "").trim();
  if (!body) return undefined;
  const lines = body.split("\n").filter((line) => line.trim());
  if (lines.length > 12 || body.length > 1600) return undefined;
  const ids = new Set(rows.map((row) => row.id));
  const cited = body.match(/c-[a-z0-9]+-[a-f0-9]+/g) ?? [];
  if (!cited.some((id) => ids.has(id))) return undefined;
  return lines.join("\n");
}
