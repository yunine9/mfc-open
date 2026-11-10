import { KnowledgeAnswerError } from "./knowledgeAnswerModel.ts";
import { knowledgeAnswerCitations } from "./knowledgeAnswerCitations.ts";
import type { KnowledgeAnswerEvidence, KnowledgeAnswerResult } from "./knowledgeAnswerTypes.ts";

export class KnowledgeAnswerCompositionError extends KnowledgeAnswerError {}

interface CompositionPoint {
  kind: "answer" | "recommendation";
  body: string;
  basis: Array<{ evidence_id: string; quote?: string; image?: boolean; start_line?: number; end_line?: number }>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(",") === expected;
const text = (value: unknown, maximum: number): value is string => typeof value === "string" && !!value.trim() && value.length <= maximum;
const quoteText = (value: string, numbered = false) => (numbered ? value.replace(/^\d+: /gm, "") : value).replace(/\s+/g, " ").trim();

/** 兼容已保存的三字段答案；只检查格式、实际来源编号与可点击引用。 */
export function parseKnowledgeAnswer(raw: string, evidence: readonly KnowledgeAnswerEvidence[], maxChars = 24_000): KnowledgeAnswerResult {
  const clean = raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let value: any;
  try { value = JSON.parse(clean); } catch { throw new KnowledgeAnswerCompositionError("回答不是完整 JSON"); }
  if (!record(value) || !keys(value, "evidence_ids,markdown,unknowns") || !text(value.markdown, maxChars)
    || JSON.stringify(value).length > maxChars || !Array.isArray(value.evidence_ids) || value.evidence_ids.length > evidence.length
    || value.evidence_ids.some((id: unknown) => typeof id !== "string") || new Set(value.evidence_ids).size !== value.evidence_ids.length
    || !Array.isArray(value.unknowns) || value.unknowns.length > 32 || value.unknowns.some((item: unknown) => !text(item, 2000))) {
    throw new KnowledgeAnswerCompositionError("回答字段不符合格式要求");
  }
  const evidenceIds = value.evidence_ids as string[];
  const unknowns = value.unknowns as string[];
  const allowed = new Set(evidence.map(source => source.id));
  const links = knowledgeAnswerCitations(value.markdown);
  const references = [...value.markdown.matchAll(/#evidence-([^\s)<>"']+)/g)].map(match => match[1]);
  const cited = new Set(links);
  if (evidenceIds.some(id => !allowed.has(id) || !cited.has(id)) || references.some(id => !allowed.has(id) || !cited.has(id))
    || links.some(id => !evidenceIds.includes(id)) || !evidenceIds.length && !unknowns.length) {
    throw new KnowledgeAnswerCompositionError("回答引用不存在、格式不正确或与引用列表不一致");
  }
  return { markdown: value.markdown.trim(), evidence_ids: evidenceIds, unknowns: unknowns.map(item => item.trim()) };
}

/** 原句和来源标题按文字显示，不能借其中的 Markdown、HTML 或来源指针生成额外链接。 */
function escapeMarkdown(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/[\\`*_{}\[\]()#+\-.!|]/g, "\\$&");
}

function sourceText(source: KnowledgeAnswerEvidence): string[] {
  return [quoteText(source.content, !!source.start_line), ...[
    source.title, source.scope, source.revision, source.repository, source.path, source.location,
    source.digest, source.retrieved_at, source.source_id, source.url, source.kind, source.id,
  ].filter((value): value is string => typeof value === "string").map(value => quoteText(value))];
}

/** 回答展示和行范围引用使用同一份原文行；未声明的真实数字前缀不会被去掉。 */
export function knowledgeAnswerSourceLines(source: KnowledgeAnswerEvidence): { startLine: number; lines: string[] } {
  const startLine = source.start_line ?? 1;
  if (!Number.isSafeInteger(startLine) || startLine < 1 || typeof source.content !== "string") {
    throw new KnowledgeAnswerCompositionError("来源起始行号或原文不正确");
  }
  const lines = source.content.split(/\r\n|[\n\r\u2028\u2029]/);
  if (!Number.isSafeInteger(startLine + lines.length - 1)
    || source.end_line !== undefined && (!Number.isSafeInteger(source.end_line) || source.end_line < startLine)) {
    throw new KnowledgeAnswerCompositionError("来源的已读行范围不正确");
  }
  if (source.start_line === undefined) return { startLine, lines };
  const expected = lines.map((_line, index) => `${startLine + index}: `);
  const matching = lines.map((line, index) => line.startsWith(expected[index]));
  if (matching.every(Boolean)) return { startLine, lines: lines.map((line, index) => line.slice(expected[index].length)) };
  if (matching.some(Boolean)) throw new KnowledgeAnswerCompositionError("来源行号有缺失或混合，不能确定连续原文范围");
  return { startLine, lines };
}

function rangeQuote(source: KnowledgeAnswerEvidence, start: unknown, end: unknown): string {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 1 || end < start) throw new KnowledgeAnswerCompositionError("来源行范围必须是连续的正整数");
  const { startLine, lines } = knowledgeAnswerSourceLines(source);
  const maximum = Math.min(startLine + lines.length - 1, source.end_line ?? Infinity);
  if (start < startLine || end > maximum) throw new KnowledgeAnswerCompositionError("引用的行范围不在本次实际读取的原文中");
  // 保留原文件的换行形式，不扩展、拼接或截断；长原文在展示时改用来源链接。
  const separators = source.content.split(/(\r\n|[\n\r\u2028\u2029])/).filter((_part, index) => index % 2 === 1);
  const quote = lines.slice(start - startLine, end - startLine + 1)
    .map((line, index) => line + (start + index < end ? separators[start - startLine + index] : "")).join("");
  if (!quote.trim()) throw new KnowledgeAnswerCompositionError("来源行范围的实际原文不能为空");
  return quote;
}

function validateReferences(value: string, allowed: ReadonlySet<string>): void {
  const links = [...value.matchAll(/\[([^\[\]\r\n]+)\]\(#evidence-([A-Za-z0-9_-]+)\)/g)];
  const visible = knowledgeAnswerCitations(value);
  if (links.length !== visible.length || links.some((link, index) => !allowed.has(link[2]) || visible[index] !== link[2])
    || /#evidence/.test(value.replace(/\[([^\[\]\r\n]+)\]\(#evidence-([A-Za-z0-9_-]+)\)/g, ""))) {
    throw new KnowledgeAnswerCompositionError("每条结论的引用必须对应其来源原句，并使用完整可点击的来源链接");
  }
}

function validateCodeFences(body: string): void {
  let fence: { marker: string; length: number } | undefined;
  for (const line of body.split(/\r\n|[\n\r\u2028\u2029]/)) {
    const marker = /^[\t ]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!marker) continue;
    if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
    else if (marker[1][0] === fence.marker && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
  }
  if (fence) throw new KnowledgeAnswerCompositionError("正文代码块必须完整闭合，不能遮住适用前提或来源");
}

/** 只校验结构、预算和引用是否实际存在；不证明来源支持完整判断。 */
export function parseKnowledgeAnswerComposition(raw: string, evidence: readonly KnowledgeAnswerEvidence[], maxChars = 24_000): KnowledgeAnswerResult {
  const overBudget = () => { throw new KnowledgeAnswerCompositionError("知识回答的结构或最终内容超过本次预算，未截断正文或来源"); };
  if (!Number.isSafeInteger(maxChars) || maxChars < 1 || raw.length > maxChars) overBudget();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new KnowledgeAnswerCompositionError("回答不是完整 JSON"); }
  if (!record(value) || !keys(value, "points") || !Array.isArray(value.points) || !value.points.length || value.points.length > 16) {
    throw new KnowledgeAnswerCompositionError("回答必须包含完整正文和来源，或明确的未确认项");
  }
  if (JSON.stringify(value).length > maxChars) overBudget();
  const sources = new Map(evidence.map(source => [source.id, source]));
  const points: CompositionPoint[] = [];
  const unknowns: string[] = [];
  for (const point of value.points) {
    if (record(point) && point.kind === "unconfirmed") {
      if (!keys(point, "body,kind") || !text(point.body, 2000) || /#evidence/i.test(point.body)) {
        throw new KnowledgeAnswerCompositionError("未确认项只能包含类型和具体说明，不能带来源字段或来源指针");
      }
      unknowns.push(point.body.trim());
      continue;
    }
    if (!record(point) || (point.kind !== "answer" && point.kind !== "recommendation") || !keys(point, "basis,body,kind") || !text(point.body, 4000)
      || !Array.isArray(point.basis) || !point.basis.length || point.basis.length > 3) {
      throw new KnowledgeAnswerCompositionError("有依据的答复须包含类型、完整正文和实际来源原句");
    }
    const allowed = new Set<string>();
    const basis = point.basis.map(item => {
      const source = record(item) && typeof item.evidence_id === "string" ? sources.get(item.evidence_id) : undefined;
      if (!record(item) || !source || !/^[A-Za-z0-9_-]+$/.test(source.id) || typeof source.content !== "string") {
        throw new KnowledgeAnswerCompositionError("来源原句的字段、长度或来源编号不正确");
      }
      if (source.image) {
        if (!keys(item, "evidence_id")) throw new KnowledgeAnswerCompositionError("图片依据只引用图片编号，不能伪造原文行号或引文");
        allowed.add(source.id);
        return { evidence_id: source.id, image: true };
      }
      if (keys(item, "end_line,evidence_id,start_line")) {
        const quote = rangeQuote(source, item.start_line, item.end_line);
        allowed.add(source.id);
        return { evidence_id: source.id, quote, start_line: item.start_line as number, end_line: item.end_line as number };
      }
      if (!keys(item, "evidence_id,quote") || !text(item.quote, 1200)) {
        throw new KnowledgeAnswerCompositionError("来源原句的字段、长度或来源编号不正确");
      }
      const quote = quoteText(item.quote, !!source.start_line);
      if (!quote || !sourceText(source).some(actual => actual.includes(quote))) {
        throw new KnowledgeAnswerCompositionError("引用的原句不在本次实际证据中");
      }
      allowed.add(source.id);
      return { evidence_id: source.id, quote: item.quote.trim() };
    });
    validateReferences(point.body, allowed);
    validateCodeFences(point.body);
    points.push({ kind: point.kind, body: point.body.trim(), basis });
  }
  const render = (inlineQuotes: boolean) => points.map(point => {
    const quotes = point.basis.map(basis => {
      const source = sources.get(basis.evidence_id)!;
      if (basis.image) return `[图片：${escapeMarkdown(source.title.replace(/\s+/g, " ").trim() || source.id)}](#evidence-${source.id})`;
      if (!inlineQuotes) {
        const location = basis.start_line === undefined ? "" : `，第 ${basis.start_line}–${basis.end_line} 行`;
        return `[原文 ${source.id}${location}](#evidence-${source.id})`;
      }
      const label = escapeMarkdown(source.title.replace(/\s+/g, " ").trim() || "来源");
      const quotation = basis.quote!.split(/\r\n|[\n\r\u2028\u2029]/).map(line => `> ${escapeMarkdown(line)}`).join("\n");
      return `${quotation}\n\n[${label}](#evidence-${source.id})`;
    }).join("\n\n");
    const body = point.kind === "recommendation" ? `**建议做法：**\n\n${point.body}` : point.body;
    return `${body}\n\n**${point.basis.some(item => item.image) ? "来源依据（点击查看）：" : inlineQuotes ? "来源原句：" : "来源原文（点击查看）："}**\n\n${quotes}`;
  });
  const resultFor = (rendered: string[]): KnowledgeAnswerResult => {
    const markdown = rendered.join("\n\n") || "本次查阅的资料不足以确认这些问题，具体缺口见未确认项。";
    return { markdown, evidence_ids: [...new Set(knowledgeAnswerCitations(markdown))], unknowns };
  };
  const inlineQuotes = points.every(point => point.basis.every(basis => !basis.quote || basis.quote.length <= 4000));
  let rendered = render(inlineQuotes), result = resultFor(rendered);
  // 原文已另存为证据。平台展开造成的膨胀改用完整原件链接，不裁句，也不让模型重新作答。
  if (JSON.stringify(result).length > maxChars) {
    rendered = render(false);
    result = resultFor(rendered);
  }
  const { markdown } = result;
  const links = knowledgeAnswerCitations(markdown);
  const expectedLinks = rendered.flatMap(part => knowledgeAnswerCitations(part));
  const basisIds = new Set(points.flatMap(point => point.basis.map(item => item.evidence_id)));
  if (JSON.stringify(links) !== JSON.stringify(expectedLinks) || links.some(id => !basisIds.has(id))
    || [...basisIds].some(id => !links.includes(id))) {
    throw new KnowledgeAnswerCompositionError("最终答案的实际来源链接不完整，未展示被正文遮住的引用");
  }
  if (markdown.length > maxChars || JSON.stringify(result).length > maxChars) overBudget();
  return parseKnowledgeAnswer(JSON.stringify(result), evidence, maxChars);
}
