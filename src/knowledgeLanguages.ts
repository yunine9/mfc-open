/**
 * 知识资产的适用语言维度。
 *
 * 业务模块描述领域概念、规则、流程和边界，语言描述知识在哪种工程
 * 实现语境下适用。两者正交，因此这里统一成可多选标签；agnostic
 * 表示明确的语言无关，空数组只留给尚未补标的历史资产。
 */

const MAX_LANGUAGES = 8;
const LANGUAGE_ID = /^[a-z][a-z0-9.+#-]{0,31}$/;

const ALIASES = new Map<string, string>([
  ["通用", "agnostic"],
  ["语言无关", "agnostic"],
  ["general", "agnostic"],
  ["language-agnostic", "agnostic"],
  ["c++", "cpp"],
  ["cxx", "cpp"],
  ["c#", "csharp"],
  ["cs", "csharp"],
  ["js", "javascript"],
  ["node", "javascript"],
  ["nodejs", "javascript"],
  ["ts", "typescript"],
  ["py", "python"],
  ["golang", "go"],
  ["bash", "shell"],
  ["sh", "shell"],
  ["objective-c", "objective-c"],
  ["objc", "objective-c"],
]);

const ORDER = [
  "agnostic", "java", "cpp", "c", "csharp", "javascript", "typescript",
  "python", "go", "rust", "kotlin", "groovy", "swift", "objective-c",
  "shell", "sql",
];

const LABELS = new Map<string, string>([
  ["agnostic", "通用 / 语言无关"], ["java", "Java"], ["cpp", "C++"],
  ["c", "C"], ["csharp", "C#"], ["javascript", "JavaScript"],
  ["typescript", "TypeScript"], ["python", "Python"], ["go", "Go"],
  ["rust", "Rust"], ["kotlin", "Kotlin"], ["groovy", "Groovy"],
  ["swift", "Swift"], ["objective-c", "Objective-C"], ["shell", "Shell"],
  ["sql", "SQL"],
]);

export function knowledgeLanguageLabel(id: string): string {
  return LABELS.get(id) ?? id;
}

export function normalizeKnowledgeLanguages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("适用语言必须是数组");
  }
  if (value.length > MAX_LANGUAGES) {
    throw new Error(`适用语言最多选择 ${MAX_LANGUAGES} 项`);
  }
  const normalized = [...new Set(value.map((item) => {
    const raw = String(item).trim().toLowerCase();
    const id = ALIASES.get(raw) ?? raw;
    if (!LANGUAGE_ID.test(id)) {
      throw new Error(`适用语言标签不合法：${String(item)}`);
    }
    return id;
  }).filter(Boolean))];
  if (normalized.includes("agnostic") && normalized.length > 1) {
    throw new Error("“语言无关”不能与具体语言同时选择");
  }
  return normalized.sort((left, right) => {
    const leftIndex = ORDER.indexOf(left);
    const rightIndex = ORDER.indexOf(right);
    if (leftIndex < 0 && rightIndex < 0) return left.localeCompare(right);
    if (leftIndex < 0) return 1;
    if (rightIndex < 0) return -1;
    return leftIndex - rightIndex;
  });
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 只解析 languages/language 这一项，不接管 pi 对其余 frontmatter 的判定。 */
export function readSkillLanguages(content: string): string[] {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/
    .exec(content)?.[1];
  if (frontmatter === undefined) return [];
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?:languages|language)\s*:\s*(.*)$/i.exec(lines[index]);
    if (!match) continue;
    const inline = match[1].trim();
    let values: string[];
    if (inline.startsWith("[") && inline.endsWith("]")) {
      values = inline.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else if (inline) {
      values = inline.split(",").map(unquote).filter(Boolean);
    } else {
      values = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const item = /^\s+-\s*(.+)$/.exec(lines[cursor]);
        if (!item) break;
        values.push(unquote(item[1]));
      }
    }
    return normalizeKnowledgeLanguages(values);
  }
  return [];
}

/** 将语言标签写回 SKILL.md；包本身携带元数据，归档/回退自然同版本。 */
export function writeSkillLanguages(
  content: string,
  value: unknown,
): string {
  const languages = normalizeKnowledgeLanguages(value);
  const match = /^(---\s*\r?\n)([\s\S]*?)(\r?\n---(?:\s*\r?\n|$))/.exec(content);
  if (!match) throw new Error("SKILL.md 缺少 YAML frontmatter");
  const lines = match[2].split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^(?:languages|language)\s*:/i.test(lines[index])) {
      kept.push(lines[index]);
      continue;
    }
    while (index + 1 < lines.length && /^\s+-\s+/.test(lines[index + 1])) {
      index += 1;
    }
  }
  if (languages.length) kept.push(`languages: [${languages.join(", ")}]`);
  const frontmatter = kept.join("\n").replace(/\n+$/, "");
  return `${match[1]}${frontmatter}${match[3]}${content.slice(match[0].length)}`;
}
