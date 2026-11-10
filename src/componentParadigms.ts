import { componentUsageMarkdown, compareComponentSections, validateComponentField, validateComponentUsageMarkdown } from "./componentKnowledgeMarkdown.ts";
import { componentRuleFiles } from "./componentRuleCandidates.ts";
import { componentCardId, componentCardText } from "./componentKnowledgeCards.ts";
import { createHash } from "node:crypto";
import type { ResearchSection } from "./componentResearchDocument.ts";

export interface ComponentCodeReference {
  repository_id: string; path: string; revision: string; start: number; end: number;
}
export interface ComponentParadigm {
  kind: "contracts" | "paradigm" | "pitfalls" | "index";
  component: string; language: string;
  status: "recommended" | "legacy" | "unverified";
  need: string; api: string[]; applicability: string;
  replaces: { identifiers: string[]; imports: string[]; patterns: string[] };
  evidence: ComponentCodeReference[];
  usage_evidence: string[];
  test_evidence: string[];
  open_questions: string[];
}
export const validComponentId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,59}$/.test(id);
/** 研究只读取代码及构建配置；旧知识正文和 Agent 指令不能成为证据。 */
export function excludedComponentSource(path: string) {
  return /(^|\/)(docs?|agents\.md|claude\.md|\.claude|\.codex)(\/|$)/i.test(path.replaceAll("\\", "/"))
    || /\.(?:md|mdx|rst|pdf|docx?|xlsx?|pptx?|png|jpg|jpeg|gif|svg|zip)$/i.test(path);
}
const strings = (v: unknown, max = 100): v is string[] => Array.isArray(v) && v.length <= max && v.every(s => typeof s === "string" && !!s.trim() && s.length <= 2000);
export function validateComponentParadigm(p: ComponentParadigm, repositoryIds: string[]) {
  const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
  if (!exact(p, ["kind", "component", "language", "status", "need", "api", "applicability", "replaces", "evidence", "usage_evidence", "test_evidence", "open_questions"]) || !exact(p.replaces, ["identifiers", "imports", "patterns"])) throw new Error("范式字段缺失或包含未知字段");
  if (!p || !["contracts", "paradigm", "pitfalls", "index"].includes(p.kind) || !validComponentId(p.component)
    || !/^[a-z][a-z0-9.+#-]{0,31}$/.test(p.language) || !["recommended", "legacy", "unverified"].includes(p.status)
    || typeof p.need !== "string" || !p.need.trim() || p.need.length > 1000
    || typeof p.applicability !== "string" || !p.applicability.trim() || p.applicability.length > 4000
    || !strings(p.api) || (p.kind === "paradigm" && !p.api.length)
    || !strings(p.open_questions) || !strings(p.usage_evidence) || !strings(p.test_evidence)
    || [...p.usage_evidence, ...p.test_evidence].some(id => !/^everycode-[a-f0-9]{24}$/.test(id))) throw new Error("范式需要合法的类型、组件、语言、状态、需求、适用条件、API 和证据编号");
  if (!p.replaces || !strings(p.replaces.identifiers) || !strings(p.replaces.imports) || !strings(p.replaces.patterns)) throw new Error("替代写法需要 identifiers、imports、patterns 列表");
  if (p.replaces.identifiers.some(s => !/^[A-Za-z_$~][\w$~]*(?:(?:::|\.)[A-Za-z_$~][\w$~]*)*$/.test(s))) throw new Error("被替代的标识符不能包含调用参数或任意表达式");
  if (["c", "cpp"].includes(p.language) && p.replaces.imports.some(s => !/^(<[^<>\s]+>|"[^"\s]+")$/.test(s))) throw new Error("C/C++ imports 必须是完整 include 对象");
  if (p.language === "java" && p.replaces.imports.some(s => !/^[a-z_][\w]*(\.[A-Za-z_$][\w$]*)+(\.\*)?$/.test(s))) throw new Error("Java imports 必须是完整包导入");
  if (p.kind === "paradigm" && p.status === "recommended" && !p.usage_evidence.length) throw new Error("推荐范式需要 everycode 调用证据；缺少时请标记 unverified");
  if (p.kind === "paradigm" && p.status === "recommended" && !p.test_evidence.length) throw new Error("推荐范式需要 everycode 测试证据；缺少时请标记 unverified");
  if (!Array.isArray(p.evidence) || !p.evidence.length || p.evidence.length > 100 || p.evidence.some(r =>
    !exact(r, ["repository_id", "path", "revision", "start", "end"]) || typeof r.repository_id !== "string" || !/^[\p{L}\p{N}_.-]+$/u.test(r.repository_id) || !repositoryIds.includes(r.repository_id) || typeof r.path !== "string" || !r.path || r.path.startsWith("/")
    || /[\\\x00-\x1f]/.test(r.path) || r.path.split("/").some(s => !s || s === "." || s === "..") || excludedComponentSource(r.path)
    || !/^[a-f0-9]{40,64}$/.test(r.revision) || !Number.isInteger(r.start) || !Number.isInteger(r.end) || r.start < 1 || r.end < r.start)) throw new Error("范式必须引用基础仓固定版本的代码或测试及有效行范围");
}
export function componentSources(p: ComponentParadigm) {
  return [...p.evidence.map(r => `\`${r.repository_id}:${r.path}:${r.start}-${r.end}\` @ ${r.revision}`),
    ...p.usage_evidence.map(id => `everycode 调用证据：${id}（版本以原始返回为准，未提供时为未知）`),
    ...p.test_evidence.map(id => `everycode 测试证据：${id}（版本以原始返回为准，未提供时为未知）`)].join("\n\n");
}
/** 派生产物始终是预览；是否启用必须由正式知识消费方另行决定。 */
export function deriveComponentParadigms(sections: ResearchSection[]) {
  const catalog = sections.filter(s => s.selected && s.paradigm).sort(compareComponentSections).map(s => {
    validateComponentParadigm(s.paradigm!, s.repository_ids);
    return { id: s.id, title: s.title, revision: s.revision, path: componentArtifactPath(s.id, s.paradigm!), ...s.paradigm! };
  });
  const recommended = catalog.filter(p => p.kind === "paradigm" && p.status === "recommended");
  const cell = (s: string) => s.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
  const mapping = ["# 组件选择表（预览）", "只在列出的适用条件下选择组件；详细步骤和来源见对应范式。", "| 需求 | 组件 / API | 适用条件 | 范式 |", "|---|---|---|---|",
    ...recommended.map(p => `| ${cell(p.need)} | ${cell(p.api.join("、"))} | ${cell(p.applicability)} | [${cell(p.title)}](../${p.path}) |`)].join("\n");
  const rules = recommended.flatMap(p => (["identifiers", "imports"] as const).flatMap(kind => p.replaces[kind].map(value => ({
    id: createHash("sha256").update(JSON.stringify([p.id, p.language, kind, value])).digest("hex").slice(0, 24),
    state: "candidate" as const, language: p.language, kind, value, paradigm_id: p.id,
    component: p.component, api: p.api, applicability: p.applicability,
    note: "候选尚未启用；需按语言生成语法规则并验证允许场景和误报。",
  }))));
  return { catalog, mapping, rules, enabled: false as const,
    digest: createHash("sha256").update(JSON.stringify(catalog)).digest("hex") };
}

export const COMPONENT_EXPORT_SCHEMA = "mfc.component-paradigm/v2";
/** 正文只供人阅读，程序字段必须来自同一导出包中的独立元数据。 */
export function readComponentArtifact(text: string, metadataJson: string | undefined) {
  if (!metadataJson || !text.trim() || /^---\r?\n/.test(text)) throw new Error("组件文档与独立元数据格式不一致");
  const fields = JSON.parse(metadataJson);
  const keys = ["schema", "id", "title", "revision", "kind", "component", "language", "status", "need", "api", "applicability", "replaces", "evidence", "usage_evidence", "test_evidence", "open_questions"];
  if (!fields || typeof fields !== "object" || Array.isArray(fields) || Object.keys(fields).length !== keys.length
    || keys.some(k => !Object.hasOwn(fields, k)) || fields.schema !== COMPONENT_EXPORT_SCHEMA
    || typeof fields.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(fields.id)
    || typeof fields.title !== "string" || !fields.title.trim() || !Number.isInteger(fields.revision) || fields.revision < 1) throw new Error("组件产物缺少必填字段或元数据格式/id/revision 无效");
  const { schema: _, id, title, revision, ...metadata } = fields;
  const p = metadata as ComponentParadigm;
  validateComponentParadigm(p, Array.isArray(p.evidence) ? p.evidence.map(e => e?.repository_id) : []);
  if (p.kind !== "paradigm" || p.status !== "recommended") throw new Error("正式组件产物只包含已推荐的用法；研究记录请在原任务查看");
  const body = /^# [^\n]+\n\n## 接入配置\n\n([\s\S]*?)\n\n(### 适用场景[\s\S]*)$/.exec(text);
  if (!body) throw new Error("组件用法正文缺少标题、接入配置或固定用法模板");
  validateComponentField(body[1], "接入配置");
  validateComponentUsageMarkdown(body[2]);
  return { id: id as string, title: title as string, revision: revision as number, paradigm: p, body: text };
}
/** 从实际导出的 Markdown 重新提取，再派生，确保导出格式就是程序的输入契约。 */
export function deriveComponentArtifacts(files: Record<string, string>) {
  const ids = new Set<string>();
  const sortedFiles = Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [path] of sortedFiles) {
    if (!/^components\/[a-z0-9-]+\/(?:paradigms\/)?[a-z0-9-]+\.(?:md|metadata\.json)$/.test(path)) throw new Error(`不支持的组件产物路径：${path}`);
    if (path.endsWith(".metadata.json") && !Object.hasOwn(files, path.replace(/\.metadata\.json$/, ".md"))) throw new Error(`元数据缺少对应文档：${path}`);
  }
  const sections = sortedFiles.filter(([path]) => path.endsWith(".md")).map(([path, text]) => {
    if (!/^components\/[a-z0-9-]+\/(?:paradigms\/)?[a-z0-9-]+\.md$/.test(path)) throw new Error(`不支持的组件产物路径：${path}`);
    const doc = readComponentArtifact(text, files[path.replace(/\.md$/, ".metadata.json")]);
    const expected = componentArtifactPath(doc.id, doc.paradigm);
    if (path !== expected || ids.has(doc.id)) throw new Error(`组件产物路径或编号重复：${doc.id}`);
    ids.add(doc.id);
    return { ...doc, selected: true, repository_ids: [...new Set(doc.paradigm.evidence.map(e => e.repository_id))],
      content: doc.body, interfaces: "", integration: "", example: "", unit_tests: "", sources: "", related_ids: [] } satisfies ResearchSection;
  });
  return { ...deriveComponentParadigms(sections), digest: createHash("sha256").update(JSON.stringify(sortedFiles)).digest("hex") };
}
function componentArtifactPath(id: string, p: ComponentParadigm) {
  return `components/${p.component}/${p.kind === "paradigm" ? "paradigms/" : ""}${id}.md`;
}
export function exportComponentArtifacts(sections: ResearchSection[]) {
  const files: Record<string, string> = {};
  const selected = sections.filter(s => s.selected && s.paradigm).sort(compareComponentSections);
  for (const s of selected) validateComponentParadigm(s.paradigm!, s.repository_ids);
  for (const s of selected.filter(s => s.paradigm!.kind === "paradigm" && s.paradigm!.status === "recommended")) {
    const path = componentArtifactPath(s.id, s.paradigm!);
    if (Object.hasOwn(files, path)) throw new Error("组件产物路径重复");
    validateComponentField(s.integration, "接入配置");
    files[path] = `# ${s.title}\n\n## 接入配置\n\n${s.integration.trim()}\n\n${componentUsageMarkdown(s)}\n`;
    files[path.replace(/\.md$/, ".metadata.json")] = JSON.stringify({ schema: COMPONENT_EXPORT_SCHEMA, id: s.id, title: s.title, revision: s.revision, ...s.paradigm }, null, 2) + "\n";
  }
  const derived = deriveComponentArtifacts(files);
  const cards = Object.fromEntries(derived.catalog.filter(p => p.kind === "paradigm" && p.status === "recommended")
    .map(p => [`derived/cards/${componentCardId(p).replaceAll("/", "__")}.md`, componentCardText(p, p.path, String(p.revision))]));
  return { schema: COMPONENT_EXPORT_SCHEMA, ...derived, files: { ...files, ...componentRuleFiles(derived.rules),
    ...cards,
    "derived/catalog.json": JSON.stringify({ schema: COMPONENT_EXPORT_SCHEMA, paradigms: derived.catalog }, null, 2) + "\n",
    "derived/mapping-table.md": derived.mapping + "\n",
    "derived/rule-candidates.json": JSON.stringify({ schema: COMPONENT_EXPORT_SCHEMA, enabled: false, rules: derived.rules }, null, 2) + "\n" } };
}
