import { componentPathMatches } from "./componentKnowledgePolicy.ts";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import type { ComponentKnowledgeCatalog, PublishedComponentParadigm } from "./componentKnowledgeCatalog.ts";

import type { ComponentKnowledgeFinding, ComponentKnowledgeCheckReport } from "./componentKnowledgeTypes.ts";
export type { ComponentKnowledgeCheckReport } from "./componentKnowledgeTypes.ts";
export const componentAstGrepBinary = () => process.env.MFC_AST_GREP_BIN
  || createRequire(import.meta.url)("@ast-grep/cli/postinstall.js").resolveBinaryPath();
type ChangedFile = { path: string; oldPath?: string; untracked?: boolean };
type Source = { path: string; language: string; content: string; added: Array<[number, number]> };

const supportedLanguages = (path: string) => path.endsWith(".C") ? ["cpp"] : /\.(?:cpp|cc|cxx|hpp|hh|hxx)$/i.test(path) ? ["cpp"]
  : /\.c$/.test(path) ? ["c"] : /\.h$/i.test(path) ? ["c", "cpp"] : /\.java$/i.test(path) ? ["java"] : [];
async function git(cwd: string, args: string[]) {
  const result = await runSafeWorktreeGitAsync(cwd, args, { timeoutMs: 15000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Git ${args[0]} 未完成：${String(result.stderr || result.error?.message || result.status).slice(0, 500)}`);
  return result.stdout;
}
/** 用真实目标分支的共同祖先计算增量；基线不存在时不能回退成空差异。 */
export async function comparisonBase(cwd: string, baseline: string, head: string) {
  if (!baseline || baseline.startsWith("-") || /[\r\n\0]/.test(baseline)) throw new Error("缺少有效的目标分支基线，组件检查未完成");
  const refs = baseline.startsWith("refs/") || /^[a-f0-9]{40,64}$/.test(baseline) ? [baseline] : baseline.startsWith("origin/") ? [`refs/remotes/${baseline}`] : [`refs/remotes/origin/${baseline}`, `refs/heads/${baseline}`];
  for (const ref of refs) {
    const resolved = await runSafeWorktreeGitAsync(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { timeoutMs: 15000 });
    if (resolved.status === 0) return (await git(cwd, ["merge-base", head, resolved.stdout.trim()])).trim();
  }
  throw new Error(`目标分支基线 ${baseline} 不存在，组件检查未完成`);
}
function changedFiles(text: string): ChangedFile[] {
  const tokens = text.split("\0"); if (tokens.at(-1) === "") tokens.pop();
  const files: ChangedFile[] = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++], path = tokens[i++];
    if (!status || !path) throw new Error("Git 变更清单格式不完整");
    if (/^[RC]/.test(status)) { const next = tokens[i++]; if (!next) throw new Error("Git 重命名记录不完整"); files.push({ path: next, oldPath: path }); }
    else if (status !== "D") files.push({ path });
  }
  return files;
}
function addedRanges(diff: string): Array<[number, number]> {
  return [...diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].flatMap(m => {
    const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
    return count ? [[start, start + count - 1] as [number, number]] : [];
  });
}
async function workspaceContent(cwd: string, path: string) {
  const absolute = resolve(cwd, path), root = await realpath(cwd), rel = relative(root, await realpath(absolute));
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`文件越出代码仓：${path}`);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`仅支持普通源文件：${path}`);
  if (stat.size > 1024 * 1024) throw new Error(`源文件超过 1 MiB，未完成检查：${path}`);
  return readFile(absolute, "utf8");
}
function finding(p: PublishedComponentParadigm, rule: string, path: string, start: number, end: number): ComponentKnowledgeFinding {
  return { path, line: start, end_line: end, rule_id: rule, need: p.need, component: p.component, api: p.api,
    applicability: [p.applicability, p.product_versions.length ? `产品版本：${p.product_versions.join("、")}` : ""].filter(Boolean).join("；"),
    document_id: p.document_id, document_revision: p.document_revision, document_line: p.start_line, paradigm_id: p.id };
}

/** 对代码快照运行与导出预览相同的规则。只读文件，不运行仓内配置、脚本或插件。 */
async function scan(sources: Source[], catalog: ComponentKnowledgeCatalog) {
  const root = await mkdtemp(join(tmpdir(), "mfc-component-check-"));
  try {
    await mkdir(join(root, "rules")); await mkdir(join(root, "files"));
    for (const r of catalog.rules) await writeFile(join(root, "rules", `${r.id}.yml`), JSON.stringify({ id: r.id,
      language: { c: "C", cpp: "Cpp", java: "Java" }[r.language], severity: "warning", message: "核对组件适用条件", rule: r.rule }));
    await writeFile(join(root, "sgconfig.yml"), "ruleDirs:\n  - rules\n");
    const byFile = new Map<string, Source>();
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i], path = join(root, "files", `${i}.${s.language === "java" ? "java" : s.language === "c" ? "c" : "cpp"}`);
      await writeFile(path, s.content); byFile.set(resolve(path), s);
    }
    const executable = componentAstGrepBinary();
    if (!executable) throw new Error("ast-grep 原生程序不可用，请在部署宿主安装锁定的 npm 依赖（含 optionalDependencies）");
    const text = await new Promise<string>((accept, reject) => execFile(executable, ["scan", "-c", join(root, "sgconfig.yml"), "--json=stream", join(root, "files")],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => error
        ? reject(new Error(`ast-grep 检查未完成：${String(stderr || error.message).slice(0, 500)}`)) : accept(stdout)));
    const results: ComponentKnowledgeFinding[] = [];
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const match = JSON.parse(line), source = byFile.get(resolve(match.file)), rule = catalog.rules.find(r => r.id === match.ruleId);
      const start = match.range?.start?.line + 1, end = match.range?.end?.line + 1;
      if (!source || !rule || !Number.isInteger(start) || !Number.isInteger(end)) throw new Error("ast-grep 返回了无法关联的检查结果");
      if (componentPathMatches(source.path, rule.policy.scope) && source.added.some(([a, b]) => start <= b && end >= a)) results.push({
        ...finding(rule.paradigm, rule.id, source.path, start, end), level: rule.policy.level, source_digest: rule.source_digest,
        context: source.content.split("\n").slice(Math.max(0, start - 3), end + 2).join("\n").slice(0, 4000),
      });
    }
    return [...new Map(results.map(r => [JSON.stringify([r.path, r.line, r.end_line, r.rule_id]), r])).values()]
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule_id.localeCompare(b.rule_id));
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function checkComponentKnowledge(options: { cwd: string; baseline: string; catalog: ComponentKnowledgeCatalog;
  target?: string; paths?: string[]; trigger: ComponentKnowledgeCheckReport["trigger"] }): Promise<ComponentKnowledgeCheckReport> {
  const deadline = Date.now() + 45000;
  const { cwd } = options;
  const catalog = { ...options.catalog, rules: options.catalog.rules.filter(r => r.policy.level !== "off") };
  const report: ComponentKnowledgeCheckReport = { mode: "observe", trigger: options.trigger, status: "not_applicable", checked_at: new Date().toISOString(),
    rules_digest: catalog.digest, checked_files: 0, rules: catalog.rules.length, findings: [], warnings: [...catalog.warnings] };
  try {
    if (!catalog.rules.length) { if (report.warnings.length) report.status = "incomplete"; return report; }
    const head = (await git(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
    report.head = options.target ?? head;
    if (!/^[a-f0-9]{40,64}$/.test(report.head)) throw new Error("待检查版本必须是完整提交 SHA");
    const sample = options.trigger === "sample";
    const base = report.base = sample ? head : await comparisonBase(cwd, options.baseline, report.head);
    const target = options.target ? [options.target] : [];
    const names = await git(cwd, ["diff", "--name-status", "-z", "--find-renames", "--no-ext-diff", base, ...target, "--"]);
    const files = sample ? (await git(cwd, ["ls-tree", "-r", "--name-only", "-z", head])).split("\0").filter(Boolean).map(path => ({ path })) as ChangedFile[] : changedFiles(names);
    if (!sample && !options.target) files.push(...(await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean).map(path => ({ path, untracked: true })));
    let selected = [...new Map(files.map(f => [f.path, f])).values()].filter(f => !/(^|\/)\.mae-flow-work\//.test(f.path)
      && supportedLanguages(f.path).some(l => catalog.rules.some(r => r.language === l)) && (!options.paths || options.paths.includes(f.path)));
    if (selected.length > 200) {
      if (!sample) throw new Error("变更超过 200 个组件相关源文件，本次检查未完成，请按范围分批检查");
      report.warnings.push(`存量共 ${selected.length} 个相关文件，本次随机抽取 200 个；抽样不能证明不存在反例`);
      for (let i = selected.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [selected[i], selected[j]] = [selected[j], selected[i]]; }
      selected = selected.slice(0, 200);
    }
    const sources: Source[] = [];
    for (const f of selected) {
      if (Date.now() > deadline) throw new Error("组件检查超过 45 秒预算，本次未完成；不会中止开发任务");
      let content: string;
      if (options.target || sample) {
        const info = await git(cwd, ["ls-tree", options.target ?? head, "--", f.path]);
        if (!/^100(?:644|755) blob /.test(info)) throw new Error(`提交中的 ${f.path} 不是普通源文件`);
        content = await git(cwd, ["show", `${options.target ?? head}:${f.path}`]);
      } else content = await workspaceContent(cwd, f.path);
      if (Buffer.byteLength(content) > 1024 * 1024 || content.includes("\0")) throw new Error(`源文件过大或不是文本：${f.path}`);
      const added = sample || f.untracked ? [[1, content.split("\n").length] as [number, number]] : addedRanges(await git(cwd,
        ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=0", base, ...target, "--", ...(f.oldPath ? [f.oldPath] : []), f.path]));
      if (!added.length) continue;
      for (const language of supportedLanguages(f.path).filter(l => catalog.rules.some(r => r.language === l))) sources.push({ path: f.path, language, content, added });
    }
    report.checked_files = new Set(sources.map(s => s.path)).size;
    const matches = sources.length ? await scan(sources, catalog) : [];
    report.findings = matches.slice(0, 200);
    if (!sample && !options.target) for (const source of [...new Map(sources.map(s => [s.path, s])).values()]) {
      if (await workspaceContent(cwd, source.path) !== source.content) report.warnings.push(`${source.path} 在检查期间已变化，请按当前内容重新检查`);
    }
    if (matches.length > 200) report.warnings.push(`共 ${matches.length} 处命中，仅展示前 200 处；请按范围继续检查`);
    if (!options.target && (await git(cwd, ["rev-parse", "HEAD"])).trim() !== head) report.warnings.push("检查期间 HEAD 发生变化，请对当前版本重新检查");
    report.status = report.warnings.length ? "incomplete" : "completed";
  } catch (error) { report.status = "incomplete"; report.warnings.push(error instanceof Error ? error.message : String(error)); }
  return report;
}

export function componentCheckMessage(report: ComponentKnowledgeCheckReport) {
  report = { ...report, findings: report.findings.filter(f => f.level === "warning" && !f.exempt_reason) };
  return [report.status === "incomplete" ? "组件使用检查未完成。" : report.status === "not_applicable" ? "当前没有适用的组件语法规则。" : `组件使用检查：${report.checked_files} 个文件，${report.findings.length} 处需核对。`,
    `模式：观察提示；规则版本 ${report.rules_digest.slice(0, 12)}。语法命中不等于违规，请核对依赖版本、适用条件和合法例外，不机械替换。`,
    ...report.findings.slice(0, 20).map(f => `${f.path}:${f.line}：${f.need}，可选 ${f.component} / ${f.api.join("、")}。条件：${f.applicability}。依据：knowledge read id=${f.document_id} start_line=${f.document_line} revision=${f.document_revision}（${f.paradigm_id}）`),
    ...(report.findings.length > 20 ? ["更多结果见任务的组件使用检查。"] : []), ...report.warnings].join("\n");
}
