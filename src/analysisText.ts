/** 分析材料保留事实文本；常见凭据在交给模型及发布报告前隐藏。 */
export function redactAnalysisText(text: string): string {
  return text.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(/(\bBearer\s+)[^\s"'\\]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|(?:access[_-]?)?token|authorization)[\\"']*\s*[:=]\s*[\\"']*)[^\s,"'\\}]+/gi, "$1[REDACTED]");
}
export function serializeAnalysisValue(value: unknown): string {
  const clean = (item: unknown): unknown => {
    if (typeof item === "string") return redactAnalysisText(item);
    if (Array.isArray(item)) return item.map(clean);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, v]) =>
      [key, /^(?:api[_-]?key|password|secret|(?:access[_-]?)?token|authorization)$/i.test(key) ? "[REDACTED]" : clean(v)]));
    return item;
  };
  return JSON.stringify(clean(value));
}

export const restrictedAnalysisPathSegment = /^(?:\.git|node_modules|vendor|dist|build|target|\.ssh|\.aws|\.codex|\.pi|pi-agent|requirement-review-agent|agent|sessions|delivery-improvement|models(?:\.beta)?\.json|settings\.json|auth(?:entication)?\.json|\.host-capabilities|\.env(?:\..*)?|.*\.(?:pem|key|p12))$/i;
