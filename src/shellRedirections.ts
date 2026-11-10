/** Remove literal shell redirections for argument inspection, never execution.
 * Quoted operators are arguments. Expansion is deliberately left untouched so
 * callers can refuse commands whose targets cannot be determined statically. */
export function withoutShellRedirections(source: string): string {
  if (/[$`]/.test(source)) return source;
  let result = "";
  let index = 0;
  const wordEnd = (start: number): number => {
    let quote = "";
    let i = start;
    for (; i < source.length; i++) {
      const c = source[i];
      if (c === "\\" && quote !== "'") { i++; continue; }
      if (quote) { if (c === quote) quote = ""; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (/[\s;&|<>()]/.test(c)) break;
    }
    return quote ? start : i;
  };
  while (index < source.length) {
    const c = source[index];
    if (c === "'" || c === '"' || c === "\\") {
      const end = wordEnd(index);
      if (end <= index) return source;
      result += source.slice(index, end); index = end; continue;
    }
    const operator = source.slice(index).match(/^(?:&>>?|>>|>&|>\||>|<&|<>|<)/)?.[0];
    if (!operator) { result += c; index++; continue; }
    // Heredocs/ here-strings and process substitution need a full shell parser.
    if (source.slice(index).startsWith("<<")) return source;
    let start = index + operator.length;
    while (/[ \t]/.test(source[start] ?? "") && start < source.length) start++;
    const end = wordEnd(start);
    if (end <= start) return source;
    // Only a separate, adjacent number is an fd: build2>log deletes build2,
    // while `2>log` has no rm operand. Do not turn build2 into build.
    result = result.replace(/(^|[\s;&|])\d+$/, "$1");
    result += " ";
    index = end;
  }
  return result;
}
