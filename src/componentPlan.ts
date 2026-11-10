import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { componentCardId } from "./componentKnowledgeCards.ts";
import { publishedComponentParadigms } from "./componentKnowledgeDocument.ts";
import type { KnowledgeContext, KnowledgeSearch } from "./knowledgeSearch.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import { comparisonBase } from "./componentKnowledgeCheck.ts";

const BEGIN = "<!-- component-plan:begin -->", END = "<!-- component-plan:end -->";
const TRAIL_BEGIN = "<!-- component-plan:searches:begin -->", TRAIL_END = "<!-- component-plan:searches:end -->";
export const COMPONENT_PLAN_TEMPLATE = `## 组件使用计划\n\n${BEGIN}\n| 编号 | 能力 | 决策 | 范式 | 来源版本 | 设计约束及应对 | 理由 |\n|---|---|---|---|---|---|---|\n${END}\n`;
interface Row { capability: string; need: string; decision: string; card: string; source: string; constraints: string; reason: string }
const cell = (value: unknown) => String(value ?? "").replace(/[\r\n]+/g, " ").replaceAll("|", "\\|");
export function parseComponentPlan(content: string): Row[] {
  if (content.split(BEGIN).length !== 2 || content.split(END).length !== 2) throw new Error("请在现有实施计划中加入唯一的组件使用计划表格，模板见 component_context");
  const body = content.split(BEGIN)[1].split(END)[0];
  const lines = body.split(/\r?\n/).filter(line => line.trim().startsWith("|"));
  if (lines.length < 2) throw new Error("组件使用计划缺少表头");
  return lines.slice(2).map(line => {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(c => c.trim().replaceAll("\\|", "|").replace(/^`|`$/g, ""));
    if (cells.length !== 7) throw new Error("组件使用计划每行必须有 7 列");
    const [capability, need, decision, card, source, constraints, reason] = cells;
    return { capability, need, decision, card, source, constraints, reason };
  });
}
export class ComponentPlan {
  constructor(private options: { workspace: string; cwd: () => string | undefined; baseline: () => string; search: () => KnowledgeSearch; context: () => KnowledgeContext; usage: () => Array<Record<string, any>> }) {}
  path(input: string) {
    const root = realpathSync(this.options.workspace), absolute = realpathSync(resolve(root, input));
    const rel = relative(root, absolute);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !/\.md$/i.test(absolute) || !statSync(absolute).isFile() || statSync(absolute).size > 512 * 1024) throw new Error("计划必须是当前任务工作区内不超过 512 KiB 的 Markdown 文件");
    return { absolute, relative: rel.replaceAll("\\", "/") };
  }
  private sources() {
    const catalog = this.options.search().catalog(this.options.context());
    const paradigms = catalog.assets.flatMap(asset => { try { return publishedComponentParadigms(asset); } catch { return []; } });
    return { paradigms, warnings: catalog.warnings };
  }
  validate(input: string, updateTrail = true) {
    const path = this.path(input), text = readFileSync(path.absolute, "utf8"), rows = parseComponentPlan(text);
    const { paradigms, warnings: sourceWarnings } = this.sources();
    const errors: string[] = [], warnings = [...sourceWarnings], seen = new Set<string>();
    const usage = this.options.usage().filter(e => e.plan?.path === path.relative);
    if (!rows.length) warnings.push("本次未列出通用能力；请说明是否仅涉及文案或局部修复。");
    for (const row of rows) {
      const label = `${row.capability} ${row.need}`;
      if (!/^C[1-9]\d*$/.test(row.capability) || seen.has(row.capability) || !row.need) errors.push(`${label}：能力编号或描述不完整、重复`);
      seen.add(row.capability);
      const searches = usage.filter(e => e.moment === "search" && e.plan?.capability === row.capability);
      if (row.decision === "使用") {
        const p = paradigms.find(p => componentCardId(p) === row.card && `${p.document_id}@${p.document_revision}` === row.source);
        if (!p || p.kind !== "paradigm" || p.status !== "recommended") errors.push(`${label}：所选范式不存在、版本已变或不是推荐状态，请重新查询`);
        else {
          const reads = usage.filter(e => e.moment === "expand" && Array.isArray(e.assets) && e.assets.some((a: any) => a.id === p.document_id && a.revision === p.document_revision && a.start_line <= p.start_line && a.end_line >= Math.min(p.end_line, p.start_line + 10)));
          if (!reads.length) warnings.push(`${label}：未观察到读取当前范式正文，请核对用法和契约`);
        }
        if (!row.constraints || row.constraints === "-") errors.push(`${label}：请写明影响设计的约束及应对方式`);
        if (!row.reason || row.reason === "-") errors.push(`${label}：请说明为何适用`);
      } else if (row.decision === "不使用") {
        if (!row.reason || row.reason === "-") errors.push(`${label}：不使用组件必须说明原因`);
        if (new Set(searches.map(e => e.query)).size < 2) warnings.push(`${label}：检索证据较少；建议从需求描述和原始写法两种说法补查，或说明已有证据`);
      } else if (row.decision === "待核实") warnings.push(`${label}：选型尚未确认，请说明缺口并继续独立工作`);
      else errors.push(`${label}：决策应为使用、不使用或待核实`);
    }
    const trail = [TRAIL_BEGIN, "### 检索记录（系统生成）", "", "| 能力 | 查询 | 结果 |", "|---|---|---|",
      ...usage.filter(e => e.moment === "search").map(e => `| ${cell(e.plan?.capability)} | ${cell(e.query)} | ${cell((e.assets ?? []).map((a: any) => `${a.card_id ?? a.id}@${a.revision}`).join("、") || (e.status === "unavailable" ? "检索未完成" : "未命中"))} |`), TRAIL_END].join("\n");
    if (updateTrail) {
      let next: string;
      if (text.includes(TRAIL_BEGIN) || text.includes(TRAIL_END)) {
        if (text.split(TRAIL_BEGIN).length !== 2 || text.split(TRAIL_END).length !== 2 || text.indexOf(TRAIL_BEGIN) > text.indexOf(TRAIL_END)) throw new Error("系统检索记录标记不完整，未修改计划");
        next = text.slice(0, text.indexOf(TRAIL_BEGIN)) + trail + text.slice(text.indexOf(TRAIL_END) + TRAIL_END.length);
      } else next = text.trimEnd() + "\n\n" + trail + "\n";
      if (next !== text) writeFileSync(path.absolute, next);
    }
    return { path: path.relative, valid: !errors.length, errors, warnings, rows, blocks_delivery: false };
  }
  private async addedCode(target?: string) {
    const cwd = this.options.cwd(); if (!cwd) throw new Error("当前任务尚无代码仓，无法对照实现");
    const git = async (args: string[]) => { const r = await runSafeWorktreeGitAsync(cwd, args, { timeoutMs: 15000, maxBuffer: 4 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`Git ${args[0]} 未完成，无法对照计划`); return r.stdout; };
    const head = (await git(["rev-parse", "--verify", "HEAD"])).trim();
    if (target && !/^[a-f0-9]{40,64}$/.test(target)) throw new Error("待检查版本应为完整 SHA");
    const base = await comparisonBase(cwd, this.options.baseline(), target ?? head);
    const extensions = ["*.c", "*.h", "*.cpp", "*.cc", "*.cxx", "*.hpp", "*.java"];
    const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--unified=0", base, ...(target ? [target] : []), "--", ...extensions]);
    const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1));
    if (!target) {
      const files = (await git(["ls-files", "--others", "--exclude-standard", "-z", "--", ...extensions])).split("\0").filter(Boolean);
      if (files.length > 100) throw new Error("新增文件过多，请缩小检查范围");
      for (const file of files) {
        const full = realpathSync(resolve(cwd, file)), rel = relative(realpathSync(cwd), full);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || statSync(full).size > 1024 * 1024) throw new Error("源文件越界或过大，计划对照未完成");
        added.push(readFileSync(full, "utf8"));
      }
    }
    if (!target && (await git(["rev-parse", "HEAD"])).trim() !== head) throw new Error("检查期间提交发生变化，请对当前代码重新检查");
    return added.join("\n");
  }
  async check(input: string, target?: string) {
    const validation = this.validate(input, !target), findings = [...validation.errors];
    const code = await this.addedCode(target), { paradigms } = this.sources();
    const words = new Set(code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, " ").match(/[A-Za-z_]\w*/g) ?? []);
    const used = new Set<string>(), planned = new Set(validation.rows.filter(r => r.decision === "使用").map(r => `${r.source}#${r.card}`));
    for (const p of paradigms.filter(p => p.kind === "paradigm" && p.status === "recommended")) {
      const key = `${p.document_id}@${p.document_revision}#${componentCardId(p)}`;
      const found = p.api.map(api => api.split("(")[0].trim().match(/[A-Za-z_]\w*$/)?.[0])
        .filter((api): api is string => !!api && api.length >= 3 && words.has(api));
      if (found.length) used.add(key);
      if (planned.has(key) && !found.length) findings.push(`${componentCardId(p)}：新增代码中未观察到计划接口，需核对是否通过已有封装调用`);
      if (!planned.has(key) && found.length) findings.push(`${componentCardId(p)}：新增代码出现计划外接口 ${found.join("、")}，请核对`);
    }
    return { path: validation.path, findings, warnings: ["接口名匹配仅供核对，不能证明设计、调用顺序或生命周期正确。"], observed: [...used], blocks_delivery: false };
  }
  recordedPaths() { return [...new Set(this.options.usage().filter(e => e.moment === "component_plan" && e.plan?.operation === "validate").map(e => String(e.plan.path)))]; }
  gaps() {
    return this.recordedPaths().flatMap<(Row & { path: string }) | { path: string; error: string }>(path => {
      try { return this.validate(path, false).rows.filter(r => r.decision !== "使用").map(row => ({ path, ...row })); }
      catch (e) { return [{ path, error: e instanceof Error ? e.message : String(e) }]; }
    });
  }
}
