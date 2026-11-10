/** 来源记录单独保存；阅读与下载只显示使用知识，代码块保持原样。 */
export function componentKnowledgeMarkdown(text: string): string {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const output: string[] = [];
  let fence = "", sourceLevel = 0;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = "";
      if (!sourceLevel) output.push(line);
      continue;
    }
    if (!fence) {
      const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading && sourceLevel && (heading[1].length <= sourceLevel || /^(?:公共接口|集成产物与依赖|集成与依赖|最佳示例|完整示例|使用限制|关联组件)$/.test(heading[2]))) sourceLevel = 0;
      if (heading && /^(?:来源|萃取来源|来源依据|来源与证据|源码依据|参考来源|证据来源)$/.test(heading[2])) { sourceLevel = heading[1].length; continue; }
    }
    if (!sourceLevel) output.push(line);
  }
  return output.join("\n").trim();
}

interface MarkdownLine { text: string; code: boolean; heading?: { level: number; title: string } }
/** 标题只在代码块外生效；模板检查不能误改示例里的注释。 */
function markdownLines(text: string, label: string): MarkdownLine[] {
  let fence = "";
  const lines = text.split(/\r?\n/).map(text => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      return { text, code: true };
    }
    if (marker) { fence = marker[1]; return { text, code: true }; }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
    return { text, code: false, ...(heading ? { heading: { level: heading[1].length, title: heading[2] } } : {}) };
  });
  if (fence) throw new Error(`${label}的代码块未闭合，请补齐结束围栏`);
  return lines;
}
const meaningful = (text: string) => !!text.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*#{1,6}\s+.*$/gm, "").replace(/[\s#>*_`~\-]/g, "");
function templateSections(text: string, required: string[], level: number, optional: string[] = []): Record<string, string> {
  const allowed = [...required, ...optional], parts: Record<string, string[]> = {};
  let current = "", last = -1;
  for (const line of markdownLines(text, required.join("、"))) {
    if (line.heading && line.heading.level <= level) {
      const title = line.heading.title, position = allowed.indexOf(title);
      if (line.heading.level !== level || position < 0) throw new Error(`不支持标题「${title}」；请按 ${"#".repeat(level)} ${allowed.join(`、${"#".repeat(level)} `)} 填写`);
      if (position <= last) throw new Error(`「${title}」重复或顺序不正确；应依次填写${allowed.join("、")}`);
      last = position; current = title; parts[current] = [];
    } else if (current) parts[current].push(line.text);
    else if (line.text.trim()) throw new Error(`请从「${"#".repeat(level)} ${required[0]}」开始，不能在模板外填写正文`);
  }
  for (const title of required) if (!parts[title]) throw new Error(`缺少「${"#".repeat(level)} ${title}」及其内容`);
  return Object.fromEntries(Object.entries(parts).map(([title, lines]) => {
    const body = lines.join("\n").trim();
    if (!meaningful(body)) throw new Error(`「${title}」不能为空，请填写具体内容；无确证误用时请省略整个常见误用区块`);
    return [title, body];
  }));
}
export function componentGuideOverview(text: string) {
  const sections = templateSections(text, ["组件用途", "接入配置"], 2);
  return { purpose: sections["组件用途"], integration: sections["接入配置"] };
}
export function componentUsageContent(text: string) {
  const sections = templateSections(text, ["适用场景", "使用步骤", "使用约束"], 3, ["常见误用"]);
  return { scenario: sections["适用场景"], steps: sections["使用步骤"], constraints: sections["使用约束"], pitfalls: sections["常见误用"] };
}
export function validateComponentField(text: string, label: string, options: { code?: boolean; codeOnly?: boolean } = {}) {
  if (typeof text !== "string" || !meaningful(text)) throw new Error(`${label}不能为空，请填写具体内容`);
  const lines = markdownLines(text, label);
  if (lines.some(line => line.heading && line.heading.level <= 3)) throw new Error(`${label}的标题由程序生成，请只填写正文；内部说明可使用四级以下标题`);
  if (options.code && !lines.some(line => line.code && !/^ {0,3}(`{3,}|~{3,})/.test(line.text) && !!line.text.trim())) throw new Error(`${label}需要完整且非空的代码块`);
  if (options.codeOnly && lines.some(line => !line.code && !!line.text.trim())) throw new Error(`${label}只填写完整代码块，解释请放入使用步骤`);
}
export interface ComponentUsageFields { content: string; interfaces: string; example: string; unit_tests: string }
export function componentUsageMarkdown(section: ComponentUsageFields): string {
  const content = componentUsageContent(section.content);
  validateComponentField(section.interfaces, "关键接口");
  validateComponentField(section.example, "完整示例", { code: true, codeOnly: true });
  validateComponentField(section.unit_tests, "单元测试示例", { code: true });
  return ["### 适用场景", content.scenario, "### 关键接口", section.interfaces.trim(), "### 使用步骤", content.steps,
    "### 完整示例", section.example.trim(), "### 单元测试示例", section.unit_tests.trim(), "### 使用约束", content.constraints,
    ...(content.pitfalls ? ["### 常见误用", content.pitfalls] : [])].join("\n\n");
}
/** 机器消费读取和作者写入使用同一模板，坏正文必须报错，不能靠清理后看似通过。 */
export function validateComponentUsageMarkdown(text: string) {
  const parts = templateSections(text, ["适用场景", "关键接口", "使用步骤", "完整示例", "单元测试示例", "使用约束"], 3, ["常见误用"]);
  validateComponentField(parts["关键接口"], "关键接口");
  validateComponentField(parts["完整示例"], "完整示例", { code: true, codeOnly: true });
  validateComponentField(parts["单元测试示例"], "单元测试示例", { code: true });
}

export interface ComponentGuideSection extends ComponentUsageFields {
  id: string; title: string; integration: string;
  paradigm?: { component: string; kind: string; status: string; need: string; applicability: string };
}
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function compareComponentSections(a: ComponentGuideSection, b: ComponentGuideSection) {
  return compareText(a.paradigm?.component ?? "", b.paradigm?.component ?? "") || compareText(a.title, b.title) || compareText(a.id, b.id);
}
export const componentGuideInlineText = (text: string) => text.replace(/[\r\n]+/g, " ").replace(/([\\`*_\[\]<>])/g, "\\$1");
const inlineText = componentGuideInlineText;
export function componentGuideMarkdown(title: string, overview: string, sections: ComponentGuideSection[], strict = false): string {
  const usages = sections.filter(section => section.paradigm?.kind === "paradigm" && section.paradigm.status === "recommended").sort(compareComponentSections);
  const summary = overview.trim() || strict ? componentGuideOverview(overview) : undefined;
  if (strict && !usages.length) throw new Error("请选择至少一个已有完整示例和单元测试的推荐用法");
  const integrations = new Map<string, string[]>();
  for (const section of usages) {
    validateComponentField(section.integration, "接入配置");
    const content = section.integration.trim(), titles = integrations.get(content) ?? [];
    if (!titles.includes(section.title)) titles.push(section.title);
    integrations.set(content, titles);
  }
  const configuration = [summary?.integration, ...[...integrations].filter(([body]) => body !== summary?.integration)
    .map(([body, titles]) => `**${titles.map(inlineText).join("、")}**\n\n${body}`)].filter(Boolean).join("\n\n");
  return [`# ${inlineText(title)}`, ...(summary ? ["## 组件用途", summary.purpose] : []), ...(configuration ? ["## 接入配置", configuration] : []),
    ...(usages.length ? ["## 用法导航", usages.map(section => `- [${inlineText(section.title)}](#component-${section.id})：${inlineText(section.paradigm!.need)}；${inlineText(section.paradigm!.applicability)}`).join("\n")] : []),
    ...usages.map(section => `<a id="component-${section.id}"></a>\n\n## ${inlineText(section.title)}\n\n${componentUsageMarkdown(section)}`)].join("\n\n");
}
