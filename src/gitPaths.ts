/** Git 的机器接口使用 -z，路径不经过引号/八进制展示转义。 */
export function gitNullPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** 仅用于 Git 的展示输出；不要对用户或文件系统提供的真实路径盲目去引号。 */
export function decodeGitQuotedPath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
  const inner = value.slice(1, -1);
  for (let i = 0; i < inner.length;) {
    if (inner[i] !== "\\") {
      const point = String.fromCodePoint(inner.codePointAt(i)!);
      bytes.push(...Buffer.from(point)); i += point.length;
    } else {
      const octal = inner.slice(i + 1).match(/^[0-7]{1,3}/)?.[0];
      if (octal) { bytes.push(parseInt(octal, 8)); i += octal.length + 1; }
      else if (inner[i + 1] in escapes) { bytes.push(escapes[inner[i + 1]]!); i += 2; }
      else return value;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 修复旧清单必须由本次 Git 路径事实佐证；真实带引号文件名优先原样保留。 */
export function recoverQuotedGitPaths(values: string[], knownPaths: string[]): string[] {
  if (!values.some(value => value.startsWith('"') && value.endsWith('"'))) return values;
  const known = new Set(knownPaths);
  const aliases = new Map<string, string | undefined>();
  for (const path of known) {
    const octal = '"' + [...Buffer.from(path)].map(byte => byte >= 128
      ? "\\" + byte.toString(8).padStart(3, "0")
      : byte === 34 ? '\\"' : byte === 92 ? "\\\\" : String.fromCharCode(byte)).join("") + '"';
    // 旧 normalizedDeliveryPaths 曾把转义反斜杠转成 /，一并兼容已落盘形式。
    for (const alias of [JSON.stringify(path), octal, octal.replace(/\\/g, "/")]) {
      aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== path ? undefined : path);
    }
  }
  return values.map(value => {
    if (known.has(value)) return value;
    const decoded = decodeGitQuotedPath(value);
    return known.has(decoded) ? decoded : aliases.get(value) ?? value;
  });
}

/** porcelain v1 -z：重命名目标在前，紧随的第二项是旧名，不是下一条状态。 */
export function gitStatusPaths(output: string): Array<{ path: string; x: string; y: string }> {
  const fields = output.split("\0");
  const entries: Array<{ path: string; x: string; y: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const x = entry[0]!, y = entry[1]!;
    entries.push({ path: entry.slice(3), x, y });
    if (/[RC]/.test(x + y)) i++;
  }
  return entries;
}
