import { previewBlockedResources } from "./blockedResourcePreview.ts";
import { resourceBlocked } from "./repositoryResourcePolicy.ts";
/**
 * 业务仓 Skill 的只读发现器。
 *
 * 安全边界：只对远端做一次无工作树浅克隆，再通过 Git object/tree 读取
 * 固定位置的 SKILL.md。仓库里的 hook、脚本、符号链接和 submodule 都不
 * 会被执行或跟随；临时目录无论成功、失败还是超时都会删除。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

export const REPOSITORY_SKILL_ROOTS = [
  ".agents/skills",
  ".pi/skills",
  ".claude/skills",
  ".cac/skills",
] as const;

export interface RepositorySkillDescriptor {
  id: string;
  name: string;
  description: string;
  relative_path: string;
  source: (typeof REPOSITORY_SKILL_ROOTS)[number];
  digest: string;
  selectable: boolean;
  warning?: string;
}

export interface RepositorySkillCatalog {
  blocked_resources?: Awaited<ReturnType<typeof previewBlockedResources>>;
  repository: string;
  revision: string;
  skills: RepositorySkillDescriptor[];
  error?: string;
}

export interface DiscoverRepositorySkillsOptions {
  blockedPaths?: string[];
  previewBlocked?: boolean;
  repository: string;
  baseline?: string;
  /** 宿主创建的短生命周期 Git credential helper；不会写入 clone config。 */
  credentialHelper?: string;
  /** 带个人令牌时必须一起给加固环境(prepareHostGitSandbox 的 env/args)。
   * 我们的 helper 问什么答什么、不看 host,部署机全局配置里一条
   * `url.<别处>.insteadOf` 就能把这次只读发现改道到另一台主机,顺手
   * 把用户令牌带走。空 HOME/全局/系统配置让改道的配置来源不存在。 */
  credentialArgs?: readonly string[];
  credentialEnv?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILLS = 100;
const MAX_TREE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const TEMP_PREFIX = "mae-flow-repository-skills-";

interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  oid: string;
  name: string;
}

class DiscoveryTimeoutError extends Error {}

function cleanRepository(raw: string): string {
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // 本地路径和 scp 风格 SSH 地址必须保持原样：后续任务工作区按这个
    // repository 做归属匹配，发现阶段不能擅自换一套身份字符串。
    return raw;
  }
}

function repositoryIsSafe(raw: string): boolean {
  if (!raw || raw.startsWith("-") || /[\0\r\n]/.test(raw)) return false;
  if (/^ext::/i.test(raw) || raw.includes("::")) return false;
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  return !scheme || ["http", "https", "ssh", "git", "file"].includes(scheme);
}

function baselineIsSafe(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  return raw.length > 0
    && raw.length <= 255
    && !raw.startsWith("-")
    && !/[\0\r\n\s\\]/.test(raw);
}

function helperIsSafe(raw: string | undefined): boolean {
  return raw === undefined
    || (raw.length > 0 && raw.length <= 4096 && !/[\0\r\n]/.test(raw));
}

function safePathSegment(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !/[\0-\x1f\x7f]/.test(name);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTree(output: Buffer): TreeEntry[] {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let index = 0; index <= output.length; index += 1) {
    if (index !== output.length && output[index] !== 0) continue;
    if (index === start) {
      start = index + 1;
      continue;
    }
    const record = output.subarray(start, index);
    start = index + 1;
    const tab = record.indexOf(9);
    if (tab < 0) continue;
    let header: string;
    let name: string;
    try {
      header = decoder.decode(record.subarray(0, tab));
      name = decoder.decode(record.subarray(tab + 1));
    } catch {
      // 非 UTF-8 文件名无法安全、稳定地送进 JSON/UI，直接拒绝。
      continue;
    }
    const match = header.match(
      /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64})$/,
    );
    if (!match) continue;
    entries.push({
      mode: match[1],
      type: match[2] as TreeEntry["type"],
      oid: match[3],
      name,
    });
  }
  return entries;
}

function runGit(
  args: string[],
  options: {
    cwd?: string;
    deadline: number;
    maxBuffer?: number;
    /** 带令牌时由调用方给出的加固环境;缺省沿用宿主环境。 */
    env?: NodeJS.ProcessEnv;
  },
): Promise<Buffer> {
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) {
    return Promise.reject(new DiscoveryTimeoutError("repository skill discovery timed out"));
  }
  return new Promise<Buffer>((resolveRun, rejectRun) => {
    execFile("git", args, {
      cwd: options.cwd,
      encoding: null,
      timeout: remaining,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer ?? MAX_TREE_BYTES,
      env: {
        ...(options.env ?? process.env),
        GIT_TERMINAL_PROMPT: "0",
        // 禁掉 ext 等外部 remote helper；只开放平台实际会用到的传输。
        GIT_ALLOW_PROTOCOL: "file:http:https:ssh:git",
      },
    }, (error, stdout) => {
      if (!error) {
        resolveRun(stdout);
        return;
      }
      const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed
        || Date.now() >= options.deadline;
      rejectRun(timedOut
        ? new DiscoveryTimeoutError("repository skill discovery timed out")
        : error);
    });
  });
}

async function listTree(
  cwd: string,
  treeish: string,
  deadline: number,
): Promise<TreeEntry[]> {
  const output = await runGit(["ls-tree", "-z", treeish], {
    cwd,
    deadline,
    maxBuffer: MAX_TREE_BYTES,
  });
  return parseTree(output);
}

async function rootTree(
  cwd: string,
  revision: string,
  root: (typeof REPOSITORY_SKILL_ROOTS)[number],
  deadline: number,
): Promise<TreeEntry | undefined> {
  const output = await runGit(["ls-tree", "-z", revision, "--", root], {
    cwd,
    deadline,
    maxBuffer: 64 * 1024,
  });
  return parseTree(output).find((entry) => entry.name === root
    && entry.mode === "040000" && entry.type === "tree");
}

function gitAuthArgs(credentialHelper: string | undefined): string[] {
  return credentialHelper
    ? ["-c", "credential.helper=", "-c", `credential.helper=${credentialHelper}`]
    : [];
}

/**
 * 在指定仓库版本发现可供 Pi 消费的 Skill 元数据。
 *
 * 发现失败是页面可展示的 catalog.error，不让一次仓库故障拖垮下单页。
 */
export async function discoverRepositorySkills(
  options: DiscoverRepositorySkillsOptions,
): Promise<RepositorySkillCatalog> {
  const displayRepository = cleanRepository(options.repository);
  const failed = (message: string): RepositorySkillCatalog => ({
    repository: displayRepository,
    revision: "",
    skills: [],
    error: message,
  });
  if (!repositoryIsSafe(options.repository)) {
    return failed("仓库地址不安全，无法发现 Skill");
  }
  if (!baselineIsSafe(options.baseline)) {
    return failed("基线版本格式不合法，无法发现 Skill");
  }
  if (!helperIsSafe(options.credentialHelper)) {
    return failed("Git 凭据辅助程序格式不合法");
  }

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.floor(options.timeoutMs!))
    : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const temporaryRoot = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const cloneDir = join(temporaryRoot, "repository.git");
  const parseDir = join(temporaryRoot, "parse");
  // 只有这两条真的带着个人令牌上网,加固环境跟着它们走;后面
  // ls-tree/cat-file 都在本地临时克隆上跑,不登记 helper。
  const authArgs = options.credentialHelper
    ? [...(options.credentialArgs ?? []), ...gitAuthArgs(options.credentialHelper)]
    : [];
  const authEnv = options.credentialHelper ? options.credentialEnv : undefined;
  let revision = "";
  try {
    await runGit([
      "-c", "core.hooksPath=/dev/null",
      ...authArgs,
      "clone", "--quiet", "--no-checkout", "--no-local", "--depth=1",
      "--", options.repository, cloneDir,
    ], { deadline, maxBuffer: 256 * 1024, env: authEnv });

    if (options.baseline) {
      await runGit([
        ...authArgs,
        "fetch", "--quiet", "--depth=1", "origin", options.baseline,
      ], { cwd: cloneDir, deadline, maxBuffer: 256 * 1024, env: authEnv });
      revision = (await runGit(
        ["rev-parse", "--verify", "FETCH_HEAD^{commit}"],
        { cwd: cloneDir, deadline, maxBuffer: 4096 },
      )).toString("utf-8").trim();
    } else {
      revision = (await runGit(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        { cwd: cloneDir, deadline, maxBuffer: 4096 },
      )).toString("utf-8").trim();
    }
    if (!/^[0-9a-f]{40,64}$/.test(revision)) {
      throw new Error("invalid resolved revision");
    }

    // 递归发现(2026-09-04 起支持分类层,如 .agents/skills/<分类>/<名>/
    // SKILL.md):直接含 SKILL.md 的子树即一个技能包,发现即止——包内
    // 子目录是资源不是分类。深度封顶与团队货架同约定;每层段名仍走
    // safePathSegment。flat 技能的 relativePath 形状不变,既有 id 稳定。
    const MAX_SKILL_TREE_DEPTH = 8;
    const candidates: Array<{
      root: (typeof REPOSITORY_SKILL_ROOTS)[number];
      directory: TreeEntry;
      relPath: string;
    }> = [];
    const collectCandidates = async (
      treeOid: string,
      relParts: string[],
      depth: number,
      root: (typeof REPOSITORY_SKILL_ROOTS)[number],
    ): Promise<void> => {
      if (depth > MAX_SKILL_TREE_DEPTH) return;
      const entries = await listTree(cloneDir, treeOid, deadline);
      if (entries.some((entry) => entry.name === "SKILL.md")) {
        const name = relParts.at(-1)!;
        candidates.push({
          root,
          directory: { name, oid: treeOid, mode: "040000", type: "tree" },
          relPath: `${root}/${relParts.join("/")}/SKILL.md`,
        });
        return;
      }
      const children = entries
        .filter((entry) => entry.mode === "040000"
          && entry.type === "tree" && safePathSegment(entry.name))
        .sort((left, right) => left.name < right.name ? -1
          : left.name > right.name ? 1 : 0);
      for (const child of children) {
        await collectCandidates(
          child.oid, [...relParts, child.name], depth + 1, root);
      }
    };
    for (const root of REPOSITORY_SKILL_ROOTS) {
      const rootEntry = await rootTree(cloneDir, revision, root, deadline);
      if (!rootEntry) continue;
      await collectCandidates(rootEntry.oid, [], 0, root);
    }
    candidates.sort((left, right) => left.relPath < right.relPath ? -1
      : left.relPath > right.relPath ? 1 : 0);

    const skills: RepositorySkillDescriptor[] = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const { root, directory, relPath } = candidates[index];
      if (resourceBlocked(relPath, options.blockedPaths ?? [])) continue;
      const skillFile = (await listTree(cloneDir, directory.oid, deadline))
        .find((entry) => entry.name === "SKILL.md");
      // 100644/100755 是普通 blob；120000 符号链接、160000 submodule
      // 以及 tree 一律不跟随。
      if (!skillFile || skillFile.type !== "blob"
          || !/^100(?:644|755)$/.test(skillFile.mode)) continue;
      const sizeText = (await runGit(["cat-file", "-s", skillFile.oid], {
        cwd: cloneDir,
        deadline,
        maxBuffer: 4096,
      })).toString("utf-8").trim();
      const size = Number(sizeText);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SKILL_BYTES) {
        continue;
      }
      const content = await runGit(["cat-file", "blob", skillFile.oid], {
        cwd: cloneDir,
        deadline,
        maxBuffer: MAX_SKILL_BYTES + 1024,
      });
      if (content.length !== size) continue;

      // Pi SDK 自己解析并验证 name / description /
      // disable-model-invocation；我们只负责安全地给它一份普通文件。
      const staged = join(parseDir, String(index), directory.name);
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(staged, "SKILL.md"), content, { mode: 0o600 });
      const parsed = loadSkillsFromDir({ dir: staged, source: "repository" });
      if (parsed.skills.length !== 1 || parsed.diagnostics.length > 0) continue;
      const skill = parsed.skills[0];
      if (typeof skill.name !== "string" || typeof skill.description !== "string"
          || !skill.name || !skill.description.trim()) continue;

      const relativePath = relPath;
      const digest = sha256(content);
      const selectable = !skill.disableModelInvocation;
      skills.push({
        id: sha256([
          displayRepository,
          revision,
          relativePath,
          digest,
        ].join("\0")),
        name: skill.name,
        description: skill.description,
        relative_path: relativePath,
        source: root,
        digest,
        selectable,
        ...(!selectable ? {
          warning: "仓库已禁止模型自动调用此 Skill",
        } : {}),
      });
      if (skills.length >= MAX_SKILLS) break;
    }

    const blocked_resources = options.previewBlocked
      ? await previewBlockedResources(options.blockedPaths ?? [], revision,
          args => runGit(args, { cwd: cloneDir, deadline, maxBuffer: MAX_TREE_BYTES })) : undefined;
    return { repository: displayRepository, revision, skills, ...(blocked_resources ? { blocked_resources } : {}) };
  } catch (error) {
    return {
      repository: displayRepository,
      revision,
      skills: [],
      error: error instanceof DiscoveryTimeoutError
        ? "仓内 Skill 发现超时"
        : "仓库或基线不可访问，无法发现仓内 Skill",
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
