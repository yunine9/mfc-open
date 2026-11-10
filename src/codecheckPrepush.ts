import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { materializeHostSkills, validateHostSkillSnapshotPackage } from "./hostSkillRuntime.ts";
import { runSafeWorktreeGitAsync } from "./safeGit.ts";
import { excludeCodecheckArtifacts } from "./codecheckArtifacts.ts";
import { codecheckToolchainStats, prepareCodecheckToolchain, seedCodecheckToolchain,
  type CodecheckToolchainPreparation } from "./codecheckToolchain.ts";

export const CODECHECK_SKILL = "codecheck-prepush";
export interface CodecheckRequest {
  repo: string;
  base: string;
  head: string;
  skillPath: string;
  prompt: string;
}
export type CodecheckRunner = (request: CodecheckRequest) => Promise<string>;
export interface CodecheckResult {
  base: string;
  head: string;
  summary: string;
  reused?: boolean;
}
interface CompletedCheck extends CodecheckResult {
  tree: string;
  skill: string;
}
interface Options {
  repo: string;
  workspace: string;
  recordRoot: string;
  sourceRoot?: string;
  moduleDataDir?: string;
  context?: Parameters<typeof materializeHostSkills>[0]["context"];
  scope?: "task" | "issue";
  base?: string;
  target?: string;
  ticket?: string;
  commitConvention?: string;
  run: CodecheckRunner;
  log?: (message: string) => void;
}
const active = new Map<string, Promise<CodecheckResult>>();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function save(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}
function read<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return undefined; }
}
async function git(repo: string, args: string[]): Promise<string> {
  const result = await runSafeWorktreeGitAsync(repo, args, { timeoutMs: 30_000 });
  if (result.status !== 0) throw new Error(`CodeCheck 范围读取失败：${result.stderr.trim().slice(0, 240)}`);
  return result.stdout.trim();
}
function recordDir(root: string, repo: string): string { return join(root, hash(repo).slice(0, 20)); }

/** 克隆完成、业务修改前调用。旧仓不能用当前 HEAD 冒充起点。 */
export async function rememberCodecheckBase(root: string, repo: string): Promise<void> {
  const file = join(recordDir(root, repo), "base.json");
  if (!existsSync(file)) save(file, { base: await git(repo, ["rev-parse", "HEAD"]) });
}

/** 显式调用上传技能，保存完成结果供推送重试复用；不推进任务阶段。 */
export function runCodecheckPrepush(options: Options): Promise<CodecheckResult> {
  const key = `${options.recordRoot}\0${options.repo}`;
  const existing = active.get(key);
  if (existing) return existing;
  const work = runOnce(options).finally(() => { if (active.get(key) === work) active.delete(key); });
  active.set(key, work);
  return work;
}
async function runOnce(options: Options): Promise<CodecheckResult> {
  const { repo } = options;
  excludeCodecheckArtifacts(repo);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  const root = recordDir(options.recordRoot, repo);
  const baselineFile = join(root, "base.json");
  let base = read<{ base: string }>(baselineFile)?.base ?? options.base ?? "";
  if (!base && options.target) {
    for (const ref of [`refs/remotes/origin/${options.target}`, `refs/heads/${options.target}`]) {
      try { base = await git(repo, ["merge-base", "HEAD", ref]); break; } catch { /* 尝试实际目标的本地引用 */ }
    }
  }
  const skillSet = materializeHostSkills({ sourceRoot: options.sourceRoot,
    workspaceRoot: options.workspace, snapshotRoot: join(repo, ".codecheckcli", "skills"),
    moduleDataDir: options.moduleDataDir, context: options.context, knowledgeScope: options.scope });
  const skillPath = skillSet.paths[skillSet.names.indexOf(CODECHECK_SKILL)];
  if (!skillPath) return { base, head, summary: "CodeCheck 未执行：当前任务没有可用的已发布 codecheck-prepush Skill。" };
  if (!base || !/^[0-9a-f]{40,64}$/i.test(base)) throw new Error("CodeCheck 无法确定修改前基点，未拿当前 HEAD 代替");
  try { await git(repo, ["merge-base", "--is-ancestor", base, head]); }
  catch { throw new Error("CodeCheck 原基点不在当前提交历史中，需核对范围"); }
  save(baselineFile, { base });
  const tree = await git(repo, ["rev-parse", "HEAD^{tree}"]);
  const skill = validateHostSkillSnapshotPackage({ sourceRoot: dirname(skillPath),
    sourceFile: skillPath, packageRoot: dirname(skillPath) }).package_digest;
  const file = join(root, "result.json");
  const previous = read<CompletedCheck>(file);
  if (previous?.base === base && previous.tree === tree && previous.skill === skill) {
    return { base, head, summary: previous.summary, reused: true };
  }
  const body = readFileSync(skillPath, "utf8");
  const branch = await git(repo, ["branch", "--show-current"]);
  const prompt = [
    "执行本次推送前的 codecheck-prepush Skill，完成后返回检查结论。",
    `代码仓：${repo}\n固定基点：${base}\n进入检查时 HEAD：${head}\nSkill 文件：${skillPath}`,
    `当前分支：${branch}${options.ticket ? `\n单号：${options.ticket}` : ""}`,
    ...(options.commitConvention ? [`当前任务提交规范：${options.commitConvention}`] : []),
    "下面是本次已装载的 Skill 正文，附件路径相对该文件目录解析：", body,
    "在上述代码仓按 Skill 完成检查、修复和复查，本地提交沿用仓库规范。",
    ".codecheckcli 仅存本地检查产物，绝不暂存或提交。禁止 push、创建 MR、修改任务阶段或启动另一套流程，后续推送由宿主负责。",
    "完成后返回实际检查到的最终提交、检查结果、修复内容和验证结果，宿主继续当前交付流程。",
  ].join("\n\n");
  let prepared: CodecheckToolchainPreparation | undefined;
  try { prepared = await prepareCodecheckToolchain(options.moduleDataDir, repo); }
  catch (error) { options.log?.(`CodeCheck 工具链准备失败，继续原检查：${String(error)}`); }
  let summary: string;
  try {
    summary = (await options.run({ repo, base, head, skillPath, prompt })).trim();
    if (!summary) throw new Error("CodeCheck 执行会话没有返回检查结果");
    try {
      await seedCodecheckToolchain(options.moduleDataDir, repo);
      if (options.moduleDataDir) {
        const stats = codecheckToolchainStats(options.moduleDataDir, repo);
        options.log?.(`CodeCheck 工具链占用：母本 ${stats.masters} 份 / ${stats.bytes} 字节；`
          + `当前任务 ${stats.taskBytes} 字节，增量 ${stats.taskIncrementalBytes} 字节`);
      }
    } catch (error) { options.log?.(`CodeCheck 工具链保存或统计失败，保留检查结果：${String(error)}`); }
  } finally {
    try { prepared?.release?.(); }
    catch (error) { options.log?.(`CodeCheck 工具链锁释放失败：${String(error)}`); }
  }
  // 使用修复后的树，不能因本轮 B → C 的提交变化再检查一次。
  const result: CompletedCheck = { base, skill, summary,
    head: await git(repo, ["rev-parse", "HEAD"]),
    tree: await git(repo, ["rev-parse", "HEAD^{tree}"]) };
  save(file, result);
  options.log?.(summary);
  return { base, head: result.head, summary };
}
