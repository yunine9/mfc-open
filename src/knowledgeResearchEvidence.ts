type Evidence = Record<string, unknown>;
export interface ResearchEvidencePage {
  total: number;
  errors: number;
  entries: Array<{ index: number; event: Evidence }>;
  before?: number;
}

/** 记录只追加，按原始位置向前翻页；首屏不复制工具输出或源码全文。 */
export function researchEvidencePage(evidence: Evidence[], before?: string): ResearchEvidencePage {
  const end = before === undefined ? evidence.length : Number(before);
  if (!Number.isSafeInteger(end) || end < 0 || end > evidence.length) throw new Error("研究记录位置无效");
  const start = Math.max(0, end - 40);
  return { total: evidence.length, errors: evidence.reduce((count, event) => count + Number(!!event.error || ["failed", "error"].includes(String(event.status))), 0), before: start || undefined,
    entries: evidence.slice(start, end).map((event, offset) => ({ index: start + offset,
      event: Object.fromEntries(["at", "tool", "action", "status", "error", "query", "keywords", "path", "preview"]
        .flatMap(key => {
          const value = event[key];
          // 复杂的工具参数在展开后查看，摘要不序列化大对象。
          return typeof value === "string" ? [[key, value.slice(0, 240)]] : [];
        })),
    })).reverse() };
}

export function researchEvidenceEntry(evidence: Evidence[], index: string): Evidence {
  const position = Number(index);
  if (!Number.isSafeInteger(position) || position < 0 || position >= evidence.length) throw new Error("研究记录不存在");
  return structuredClone(evidence[position]);
}
