import { resourceBlocked } from "./repositoryResourcePolicy.ts";
/**
 * 业务仓 Skill 的运行时装配。
 *
 * 仓库内容是不可信输入，而 Pi 的资源加载发生在工具 Gate 之前；因此
 * 不能把整个仓库目录直接交给 Pi 扫描。仓库原生模式只发现 Git 已跟踪
 * 的 Skill 包，临时注入或被忽略的 .claude/.cac 等内容一律不采用；
 * 随后做路径/软链/体积校验并复制为任务内只读快照。MFC 只是消费 Git
 * 事实，不承担仓内知识的编辑、发布或版本管理。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const ROOTS = [
  ".agents/skills",
  ".pi/skills",
  ".claude/skills",
  ".cac/skills",
] as const;
const MAX_SELECTED = 20;
const MAX_FILES = 256;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 6;

export interface SelectedRepositorySkill {
  id: string;
  repository: string;
  revision: string;
  name: string;
  description: string;
  relative_path: string;
  source: string;
  digest: string;
}

export interface RepositoryWorkspaceBinding {
  repository: string;
  workspace: string;
}

export interface MaterializedRepositorySkills {
  paths: string[];
  names: string[];
  entries: Array<{ path: string; skill: SelectedRepositorySkill }>;
  warnings: string[];
}

interface SnapshotMetadata {
  repository: string;
  relative_path: string;
  digest: string;
  /** SKILL.md 与同包相对资源的确定性整体哈希。只校验入口文件不足以
   * 冻结 Skill：正文可能引用 reference/、scripts/ 等相对文件。 */
  package_digest: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 第一版只认标准的一层目录；不递归翻整个业务仓。 */
export function validRepositorySkillPath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return ROOTS.some((root) => {
    if (!path.startsWith(`${root}/`) || !path.endsWith("/SKILL.md")) return false;
    const middle = path.slice(root.length + 1, -"/SKILL.md".length);
    return !!middle && !middle.includes("/") && middle !== "." && middle !== "..";
  });
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertNoSymlinkPath(root: string, target: string): void {
  const rel = relative(root, target);
  if (!contained(root, target)) throw new Error("Skill 路径越出仓库");
  let cursor = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("Skill 路径包含软链接");
  }
}

function validatePackage(
  root: string,
  current: string,
  depth: number,
  budget: { files: number; bytes: number },
): void {
  if (depth > MAX_DEPTH) throw new Error(`Skill 包目录深度超过 ${MAX_DEPTH}`);
  assertNoSymlinkPath(root, current);
  const currentReal = realpathSync(current);
  if (!contained(realpathSync(root), currentReal)) throw new Error("Skill 包越出仓库");
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 包含软链接: ${entry.name}`);
    if (entry.isDirectory()) {
      validatePackage(root, path, depth + 1, budget);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Skill 包含非普通文件: ${entry.name}`);
    const size = lstatSync(path).size;
    budget.files += 1;
    budget.bytes += size;
    if (budget.files > MAX_FILES || budget.bytes > MAX_PACKAGE_BYTES) {
      throw new Error("Skill 包体积超限");
    }
  }
}

function copyPackage(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyPackage(from, to);
    else copyFileSync(from, to);
  }
}

/** 目录名、文件名与文件内容共同入账；排序消除 readdir 顺序差异。
 * 软链/特殊文件在 validatePackage 已拒，这里仍按 lstat 再守一遍，
 * 避免恢复校验把后来塞进快照的软链当普通资源。 */
function packageDigest(root: string): string {
  const hash = createHash("sha256");
  const visit = (current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1
        : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(current, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Skill 包含软链接: ${rel}`);
      if (stat.isDirectory()) {
        hash.update(`D\0${rel}\0`);
        visit(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Skill 包含非普通文件: ${rel}`);
      const content = readFileSync(path);
      hash.update(`F\0${rel}\0${content.length}\0`);
      hash.update(content);
    }
  };
  visit(root);
  return hash.digest("hex");
}

function makeReadonly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      makeReadonly(child);
      chmodSync(child, 0o555);
    } else {
      chmodSync(child, 0o444);
    }
  }
  chmodSync(path, 0o555);
}

function snapshotKey(skill: SelectedRepositorySkill): string {
  return createHash("sha256")
    .update(`${skill.repository}\0${skill.relative_path}\0${skill.id}`)
    .digest("hex").slice(0, 20);
}

function existingSnapshot(
  directory: string,
  skill: SelectedRepositorySkill,
): string | undefined {
  const file = join(directory, "SKILL.md");
  // 元数据放包外：仓库 Skill 可以合法自带名为 .snapshot.json 的资源，
  // 宿主不能覆盖它并悄悄改变包语义。
  const metadataPath = `${directory}.snapshot.json`;
  if (!existsSync(file) || !existsSync(metadataPath)) return undefined;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf-8")) as SnapshotMetadata;
    const actual = sha256(readFileSync(file));
    if (metadata.repository === skill.repository
        && metadata.relative_path === skill.relative_path
        && metadata.digest === actual
        && (!skill.digest || metadata.digest === skill.digest)
        && metadata.package_digest === packageDigest(directory)) {
      return file;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function materializeOne(
  skill: SelectedRepositorySkill,
  binding: RepositoryWorkspaceBinding,
  snapshotRoot: string,
  warnings: string[],
): string | undefined {
  if (!validRepositorySkillPath(skill.relative_path)) {
    warnings.push(`${skill.name}: 路径不在允许的 Skill 目录`);
    return undefined;
  }
  const destination = join(snapshotRoot, snapshotKey(skill));
  const metadataPath = `${destination}.snapshot.json`;
  const hadSnapshot = existsSync(destination) || existsSync(metadataPath);
  const reused = existingSnapshot(destination, skill);
  if (reused) return reused;
  if (hadSnapshot) {
    warnings.push(`${skill.name}: 已有 Skill 快照整体校验失败，正从仓库源重建`);
    rmSync(destination, { recursive: true, force: true });
    rmSync(metadataPath, { force: true });
  }
  const sourceFile = join(binding.workspace, ...skill.relative_path.split("/"));
  const sourceDir = dirname(sourceFile);
  try {
    assertNoSymlinkPath(binding.workspace, sourceFile);
    if (!lstatSync(sourceFile).isFile()) throw new Error("SKILL.md 不是普通文件");
    if (lstatSync(sourceFile).size > MAX_SKILL_BYTES) {
      throw new Error("SKILL.md 超过 128 KiB");
    }
    validatePackage(binding.workspace, sourceDir, 0, { files: 0, bytes: 0 });
    const content = readFileSync(sourceFile);
    const actualDigest = sha256(content);
    if (skill.digest && actualDigest !== skill.digest) {
      warnings.push(`${skill.name}: 仓库内容与读取目录时的版本不一致，已跳过`);
      return undefined;
    }
    const sourcePackageDigest = packageDigest(sourceDir);
    mkdirSync(snapshotRoot, { recursive: true });
    copyPackage(sourceDir, destination);
    const copiedPackageDigest = packageDigest(destination);
    if (copiedPackageDigest !== sourcePackageDigest) {
      throw new Error("Skill 包复制后整体校验不一致");
    }
    writeFileSync(metadataPath, JSON.stringify({
      repository: skill.repository,
      relative_path: skill.relative_path,
      digest: actualDigest,
      package_digest: copiedPackageDigest,
    } satisfies SnapshotMetadata));
    chmodSync(metadataPath, 0o444);
    makeReadonly(destination);
    return join(destination, "SKILL.md");
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    rmSync(metadataPath, { force: true });
    warnings.push(`${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function gitOutput(workspace: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, {
    cwd: workspace,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** 整包必须来自 Git：入口已跟踪还不够，旁边混入一个未跟踪脚本，
 * 整包复制时照样会越界。普通未跟踪与 .gitignore 命中的文件都查。 */
function gitOwnsPackage(
  binding: RepositoryWorkspaceBinding,
  relativePath: string,
): boolean {
  const packagePath = relativePath.replace(/\\/g, "/").replace(/\/SKILL\.md$/, "");
  if (gitOutput(binding.workspace,
      ["ls-files", "--error-unmatch", "--", relativePath]) === undefined) {
    return false;
  }
  const untracked = gitOutput(binding.workspace,
    ["ls-files", "--others", "--exclude-standard", "--", packagePath]);
  const ignored = gitOutput(binding.workspace,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", packagePath]);
  return untracked !== undefined && ignored !== undefined
    && !untracked && !ignored;
}

function repositoryNativeSkills(
  binding: RepositoryWorkspaceBinding,
): SelectedRepositorySkill[] {
  const found: SelectedRepositorySkill[] = [];
  const revision = gitOutput(binding.workspace, ["rev-parse", "HEAD"]);
  if (!revision) return found;
  for (const root of ROOTS) {
    const directory = join(binding.workspace, ...root.split("/"));
    if (!existsSync(directory)) continue;
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const relativePath = `${root}/${entry.name}/SKILL.md`;
        const file = join(directory, entry.name, "SKILL.md");
        if (!existsSync(file) || lstatSync(file).isSymbolicLink()
            || !lstatSync(file).isFile()
            || !gitOwnsPackage(binding, relativePath)) continue;
        const digest = sha256(readFileSync(file));
        found.push({
          id: `repository:${sha256(`${binding.repository}\0${revision}\0${relativePath}\0${digest}`)}`,
          repository: binding.repository,
          revision,
          name: basename(dirname(file)),
          description: "仓库原生 Skill（由 Git 管理）",
          relative_path: relativePath,
          source: root.split("/")[0],
          digest,
        });
      }
    } catch {
      // 仓内能力是 fail-open；坏目录不妨碍任务运行。
    }
  }
  return found;
}

/**
 * `selected === undefined` 表示任务尚未固定仓库原生能力：只从当前
 * checkout 发现 Git 已跟踪 Skill。调用方首次物化后会把精确列表写回
 * task.json；后续恢复只读取固定快照，不随工作区变化。
 */
export function materializeRepositorySkills(options: {
  selected: SelectedRepositorySkill[] | undefined;
  bindings: RepositoryWorkspaceBinding[];
  snapshotRoot: string;
  reservedNames?: Iterable<string>;
  blockedPaths?: string[];
}): MaterializedRepositorySkills {
  const warnings: string[] = [];
  const reserved = new Set(
    [...(options.reservedNames ?? [])].map((name) => name.toLowerCase()));
  const candidates = options.selected === undefined
    ? options.bindings.flatMap(repositoryNativeSkills)
    : options.selected;
  const paths: string[] = [];
  const names: string[] = [];
  const entries: Array<{ path: string; skill: SelectedRepositorySkill }> = [];
  const seen = new Set<string>();
  for (const skill of candidates.filter(skill => !resourceBlocked(skill.relative_path, options.blockedPaths ?? [])).slice(0, MAX_SELECTED)) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    const binding = options.bindings.find(
      (item) => item.repository === skill.repository);
    if (!binding) {
      warnings.push(`${skill.name}: 不属于当前仓库，已跳过`);
      continue;
    }
    if (reserved.has(skill.name.toLowerCase())) {
      warnings.push(`${skill.name}: 与平台常驻 Skill 重名，已跳过`);
      continue;
    }
    const path = materializeOne(skill, binding, options.snapshotRoot, warnings);
    if (!path) continue;
    paths.push(path);
    names.push(skill.name);
    entries.push({ path, skill: { ...skill } });
  }
  if (candidates.length > MAX_SELECTED) {
    warnings.push(`最多装载 ${MAX_SELECTED} 个仓库 Skill，其余已跳过`);
  }
  return { paths, names, entries, warnings };
}
