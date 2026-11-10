import { publishedComponentParadigms, type PublishedComponentParadigm } from "./componentKnowledgeDocument.ts";
import type { ComponentParadigm } from "./componentParadigms.ts";
import type { SearchableKnowledge, KnowledgeHit } from "./knowledgeSearch.ts";
import { componentGuideInlineText } from "./componentKnowledgeMarkdown.ts";

export const isComponentKnowledge = (asset: SearchableKnowledge) => /^---\r?\n[\s\S]*?^schema:\s*"mfc\.component-[^"\r\n]+"/m.test(asset.content);
export const componentCardId = (p: ComponentParadigm & { id: string }) => `${p.language}/${p.component}/${p.id}`;
export function componentCardText(p: ComponentParadigm & { id: string; title: string }, document: string, revision: string) {
  const line = (v: string, max = 600) => v.replace(/[\r\n]+/g, " ").slice(0, max);
  return [`# ${p.component} · ${line(p.title, 160)}`, `card-id: ${componentCardId(p)}`, `语言：${p.language}`,
    `要做的事：${line(p.need)}`, `替代的原始写法：${line([...p.replaces.identifiers, ...p.replaces.imports, ...p.replaces.patterns].join("、"))}`,
    `组件与接口：${p.component}（${line(p.api.join("、"))}）`, `适用条件：${line(p.applicability)}`,
    `文档：${document}`, `文档版本：${revision}`].join("\n") + "\n";
}
export interface ComponentCard { source: SearchableKnowledge; paradigm: PublishedComponentParadigm; asset: SearchableKnowledge }
export const componentQueryLanguage = (query: string) => /c\+\+|\bcpp\b|\bcxx\b/i.test(query) ? "cpp" : /\bjava\b/i.test(query) ? "java" : /\bc\b/i.test(query) ? "c" : undefined;

/** 接入配置由正式指南统一提供；导航中的其他用法不能成为当前卡片的检索内容。 */
function componentGuideIntroductionRange(content: string) {
  const lines = content.split(/\r?\n/), front = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0];
  const start = front ? front.split(/\r?\n/).length - (front.endsWith("\n") ? 1 : 0) : 0;
  let end = start;
  let fence = "";
  for (const line of lines.slice(start)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
    } else if (marker) fence = marker[1];
    else if (/^ {0,3}##\s+用法导航\s*#*\s*$/.test(line) || /^<a id="component-[a-z0-9-]+"><\/a>$/.test(line)) break;
    end++;
  }
  return { start_line: start + 1, end_line: end };
}

/** 联合指南的接入配置按用法标题分组；只携带公共说明和当前用法的配置。 */
function componentIntroductionRanges(content: string, usages: PublishedComponentParadigm[]) {
  const range = componentGuideIntroductionRange(content), lines = content.split(/\r?\n/);
  const titles = new Set(usages.map(p => componentGuideInlineText(p.title)));
  return (selected: PublishedComponentParadigm) => {
    const title = componentGuideInlineText(selected.title);
    const ranges: Array<{ start_line: number; end_line: number }> = [];
    let include = true, fence = "";
    for (let line = range.start_line; line <= range.end_line; line++) {
      const text = lines[line - 1], marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
      if (fence) {
        if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      } else if (marker) fence = marker[1];
      else {
        // 无法识别的正文不改变所属分组，不能猜测它是另一用法的配置。
        const group = /^\*\*(.+)\*\*$/.exec(text)?.[1];
        const members = group?.split("、");
        if (group && `、${group}、`.includes(`、${title}、`)) include = true;
        else if (members?.every(name => titles.has(name))) include = members.includes(title);
      }
      if (!include) continue;
      const last = ranges.at(-1);
      if (last?.end_line === line - 1) last.end_line = line;
      else ranges.push({ start_line: line, end_line: line });
    }
    return ranges;
  };
}

/** 从同一正式修订读取公共配置与所选用法；不携带其他用法正文或巨大的全库元数据。 */
export function componentUsageDocument(source: SearchableKnowledge, paradigmId: string) {
  const usages = publishedComponentParadigms(source), p = usages.find(p => p.id === paradigmId);
  if (!p) return;
  const lines = source.content.split(/\r?\n/);
  const ranges = [
    ...componentIntroductionRanges(source.content, usages)(p).map(range => ({ heading: "公共用途与接入配置", ...range })),
    { heading: p.title.length <= 160 ? p.title : p.title.slice(0, 159).replace(/[\uD800-\uDBFF]$/, "") + "…", start_line: p.start_line, end_line: p.end_line },
  ];
  let text = `选定用法：${p.id}\n组件：${p.component}；语言：${p.language}\n要做的事：${p.need}\n`
    + `适用条件（正式文档元数据）：${p.applicability}\n接口声明：${p.api.join("、")}\n`
    + `文档范围：${source.scope}\n产品适用版本：${source.productVersions.join("、") || "未单独声明，请核对正文与实际依赖"}\n`
    + "源码依据（所选用法的正式文档元数据；源码修订与文档修订不同）：\n"
    + p.evidence.map(e => `- 仓库：${e.repository_id}；路径：${e.path}；源码修订：${e.revision}；行：${e.start}–${e.end}`).join("\n")
    + `\n调用证据：${p.usage_evidence.join("、")}\n测试证据：${p.test_evidence.join("、")}`
    + (p.open_questions.length ? `\n尚待核实：\n${p.open_questions.map(question => `- ${question}`).join("\n")}` : "") + "\n\n";
  const sections = ranges.map(range => {
    const start_offset = text.length;
    text += `【${range.heading}；原文第 ${range.start_line}–${range.end_line} 行】\n`
      + lines.slice(range.start_line - 1, range.end_line).join("\n") + "\n\n";
    return { ...range, start_offset, end_offset: text.length };
  });
  return { text, sections };
}

export function componentCards(assets: SearchableKnowledge[]) {
  const cards: ComponentCard[] = [], warnings: string[] = [];
  for (const source of assets.filter(isComponentKnowledge)) {
    try {
      const lines = source.content.split(/\r?\n/), usages = publishedComponentParadigms(source);
      const introductionRanges = componentIntroductionRanges(source.content, usages);
      for (const p of usages) {
        if (p.kind !== "paradigm" || p.status !== "recommended") continue;
        const introduction = introductionRanges(p)
          .map(range => lines.slice(range.start_line - 1, range.end_line).join("\n")).join("\n\n").trim();
        const usage = lines.slice(p.start_line - 1, p.end_line).join("\n");
        cards.push({ source, paradigm: p, asset: { ...source,
          id: `component-card:${source.id}:${p.id}`, title: `${p.component} · ${p.title}`, summary: p.need, whenToUse: p.applicability,
          content: [componentCardText(p, `${source.id}:${p.start_line}-${p.end_line}`, source.revision), introduction, usage].join("\n\n") } });
      }
    } catch (e) { warnings.push(`${source.title}：${e instanceof Error ? e.message : String(e)}`); }
  }
  return { cards, warnings };
}
export function componentCardHit(card: ComponentCard, retrieval: "memsearch" | "local" | "full"): KnowledgeHit {
  const { source, paradigm: p } = card;
  const excerpt = (value: string, max: number) => {
    const text = value.replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim(), omitted = "…（已省略，详见原文）";
    return text.length <= max ? text : text.slice(0, max - omitted.length) + omitted;
  };
  // 保留完整版本值，超出摘要容量时省略后续值，不能把截短的值当作实际版本。
  const productVersions: string[] = [];
  for (const version of source.productVersions) {
    if (JSON.stringify([...productVersions, version]).length > 600) break;
    productVersions.push(version);
  }
  const versionsOmitted = productVersions.length < source.productVersions.length;
  return { id: source.id, title: excerpt(source.title, 160), kind: source.kind, scope: excerpt(source.scope, 240), revision: source.revision,
    productVersions, whenToUse: excerpt(p.applicability, 240), heading: excerpt(p.title, 160), start_line: p.start_line, end_line: p.end_line,
    card_id: componentCardId(p), paradigm_id: p.id, retrieval,
    summary: excerpt(`要做的事：${p.need}；相关接口：${p.component} / ${p.api.join("、")}`, 440) + "；仅摘要，完整接口、条件和约束请读原文。",
    contracts: publishedComponentParadigms(source).filter(c => c.kind === "contracts" && c.component === p.component && c.language === p.language && c.status === "recommended")
      .slice(0, 3).map(c => ({ id: c.document_id, revision: c.document_revision, start_line: c.start_line, end_line: c.end_line })),
    versionNote: source.productVersions.length ? excerpt(`适用产品版本：${productVersions.join("、")}`, 160)
      + (versionsOmitted ? "；版本列表已省略，完整范围请读原文。" : "") : "未限定产品版本，请核对实际依赖。" };
}
function tokens(text: string) {
  const words = text.toLowerCase().match(/[a-z_][a-z0-9_:.$+-]*|[\p{Script=Han}]+/gu) ?? [];
  return words.flatMap(w => /^\p{Script=Han}+$/u.test(w) ? w.length < 2 ? [w] : Array.from({length:w.length-1},(_,i)=>w.slice(i,i+2)) : [w, ...w.split(/::|\./)]);
}
/** 索引未就绪或 memsearch 故障时，在相同的正式用法正文上做本地 BM25 检索。 */
export function localComponentCards(cards: ComponentCard[], query: string, limit = 5): KnowledgeHit[] {
  const language = componentQueryLanguage(query);
  const documents = new Map<string, number>();
  const rows = cards.filter(c => !language || c.paradigm.language === language).map(card => {
    const words = tokens(card.asset.content), counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    for (const word of counts.keys()) documents.set(word, (documents.get(word) ?? 0) + 1);
    return { card, counts, length: words.length };
  });
  const terms = [...new Set(tokens(query))].filter(t => !/^(cpp|cxx|c\+\+|java|c)$/.test(t));
  const average = rows.reduce((sum, r) => sum + r.length, 0) / (rows.length || 1) || 1;
  return rows.map(row => ({ ...row, score: terms.reduce((sum, term) => {
    const n = documents.get(term) ?? 0, count = row.counts.get(term) ?? 0;
    return sum + Math.log(1 + (rows.length - n + .5) / (n + .5)) * count * 2.2 / (count + 1.2 * (.25 + .75 * row.length / average));
  }, 0) })).filter(r => r.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(r => componentCardHit(r.card, "local"));
}
