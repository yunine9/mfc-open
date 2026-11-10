import { resolveBusinessModuleIds } from "./businessModuleIdentity.ts";
/**
 * 团队 Skill 货架(只读):部署数据目录 skills/ 的资产清单。
 *
 * 货架回答"现在生效的是什么"(身份/指纹/新鲜度/装载性),与消费足迹
 * (knowledge-insights 的 resources)互补——后者只看得见被任务带过的,
 * 一个放坏了的 skill 在足迹里是隐形的,货架必须把它照出来。
 * 正文不进接口(SKILL.md 可能很长且与展示无关),digest 是版本锚:
 * 后续可写货架(上传/回退)与留痕都对着它。
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import {
  readSkillKnowledgeMetadata,
  type KnowledgeNature,
} from "./knowledgeAssetModel.ts";
import { packageDigest } from "./hostSkillRuntime.ts";

/** 与宿主 Skill 快照(hostSkillRuntime)同深度上限:货架照见的范围
 * 不应超过运行时真会去装的范围。 */
const MAX_DEPTH = 8;

export interface HostSkillShelfEntry {
  name: string;
  description: string;
  /** Skill 只是形态；nature 才是业务/工程知识属性。 */
  nature: KnowledgeNature;
  form: "skill";
  business_module_ids: string[];
  repositories: string[];
  technologies: string[];
  /** SKILL.md 正文 sha256:版本指纹,页面对拍与后续留痕的锚。 */
  digest: string;
  /** 整个 Skill 包（正文及附件）的指纹；工作流精确引用使用它。 */
  package_digest: string;
  /** SKILL.md 的 mtime(ISO)。 */
  updated_at: string;
  /** 相对 skills 根的路径——宿主绝对路径不出接口。 */
  path: string;
  /** 任务固定快照中的哈希目录会在这里还原原货架相对路径。 */
  source_path?: string;
  bytes: number;
  /** pi 装载器认不认。false = 放了也不会进任何会话(缺 name/description
   * 等),货架必须照出来,否则"放了没生效"只能靠试跑撞见。 */
  loadable: boolean;
}

export interface HostSkillShelf {
  root_exists: boolean;
  skills: HostSkillShelfEntry[];
  warnings: string[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** 收集根下全部 SKILL.md。软链接整条跳过并出警告——与快照器同纪律,
 * 货架不能展示一个运行时拒绝装载的东西还不说明原因。 */
function collectSkillFiles(root: string, warnings: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      if (lstatSync(absolute).isSymbolicLink()) {
        warnings.push(`跳过软链接: ${relative(root, absolute)}`);
        continue;
      }
      if (entry.isDirectory()) walk(absolute, depth + 1);
      else if (entry.name === "SKILL.md") found.push(absolute);
    }
  };
  walk(root, 0);
  return found;
}

/** 不可装载的条目也要有名字:frontmatter 能读多少读多少,读不出就用
 * 目录名兜底(与 pi 的兜底语义一致),仅用于展示。 */
function fallbackFrontmatter(
  content: string,
  key: "name" | "description",
): string {
  const match = content.match(
    new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : "";
}

function snapshotSourcePath(root: string, file: string): string | undefined {
  const first = relative(root, file).split(sep)[0];
  if (!first) return undefined;
  const metadata = join(root, `${first}.snapshot.json`);
  if (!existsSync(metadata) || lstatSync(metadata).isSymbolicLink()
      || !lstatSync(metadata).isFile()) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(metadata, "utf-8")) as {
      source_path?: unknown;
    };
    const source = String(parsed.source_path ?? "").trim();
    if (!source || source.startsWith("/") || source.split(/[\\/]/).includes("..")) {
      return undefined;
    }
    return source.split(sep).join("/");
  } catch {
    return undefined;
  }
}

/** 既能照见实时货架，也能照见任务内已经固定的哈希快照。 */
export function listHostSkillShelfRoot(inputRoot: string): HostSkillShelf {
  const root = resolve(inputRoot);
  if (!existsSync(root)) {
    return { root_exists: false, skills: [], warnings: [] };
  }
  const warnings: string[] = [];
  // 装载性以 pi 的装载器为唯一判据——货架自己不发明第二套认定规则。
  const loadableByPath = new Map<string, { name: string; description: string }>();
  try {
    for (const skill of loadSkills({
      cwd: root,
      agentDir: root,
      skillPaths: [root],
      includeDefaults: false,
    }).skills) {
      loadableByPath.set(resolve(skill.filePath), {
        name: skill.name,
        description: skill.description ?? "",
      });
    }
  } catch (error) {
    warnings.push(`装载器扫描失败(货架退化为纯文件清单): ${String(error)}`);
  }
  const skills: HostSkillShelfEntry[] = [];
  for (const file of collectSkillFiles(root, warnings)) {
    let content: Buffer;
    let mtime: Date;
    try {
      content = readFileSync(file);
      mtime = lstatSync(file).mtime;
    } catch (error) {
      warnings.push(
        `读取失败: ${relative(root, file)} — ${String(error)}`);
      continue;
    }
    const loaded = loadableByPath.get(resolve(file));
    const text = content.toString("utf-8");
    const directory = relative(root, file).split(sep).slice(0, -1).join("/");
    let wholePackageDigest: string;
    try {
      wholePackageDigest = packageDigest(dirname(file));
    } catch (error) {
      warnings.push(`Skill 包指纹失败: ${relative(root, file)} — ${String(error)}`);
      wholePackageDigest = sha256(content);
    }
    if (!loaded) {
      warnings.push(`不可装载(pi 装载器未接受,检查 frontmatter 的 `
        + `name/description): ${relative(root, file)}`);
    }
    let metadata = {
      nature: "unclassified" as KnowledgeNature,
      form: "skill" as const,
      business_module_ids: [] as string[],
      repositories: [] as string[],
      technologies: [] as string[],
    };
    try {
      metadata = { ...readSkillKnowledgeMetadata(text), form: "skill" };
    } catch (error) {
      warnings.push(`Skill 知识属性无效: ${relative(root, file)} — ${
        error instanceof Error ? error.message : String(error)}`);
    }
    const sourcePath = snapshotSourcePath(root, file);
    skills.push({
      name: loaded?.name
        || fallbackFrontmatter(text, "name")
        || directory || relative(root, file),
      description: loaded?.description
        || fallbackFrontmatter(text, "description"),
      nature: metadata.nature,
      form: "skill",
      business_module_ids: metadata.business_module_ids,
      repositories: metadata.repositories,
      technologies: metadata.technologies,
      digest: sha256(content),
      package_digest: wholePackageDigest,
      updated_at: mtime.toISOString(),
      path: relative(root, file).split(sep).join("/"),
      ...(sourcePath ? { source_path: sourcePath } : {}),
      bytes: content.byteLength,
      loadable: !!loaded,
    });
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { root_exists: true, skills, warnings };
}

export function listHostSkillShelf(dataDir: string): HostSkillShelf {
  const shelf = listHostSkillShelfRoot(resolve(dataDir, "skills"));
  return { ...shelf, skills: shelf.skills.map(skill => ({ ...skill, business_module_ids: resolveBusinessModuleIds(dataDir, skill.business_module_ids) })) };
}
