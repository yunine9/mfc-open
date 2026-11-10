import { isResearchPlatformPath, listGitTreePaths, readGitBlobPage, readGitBuildFile } from "./componentResearchTools.ts";
import type { KnowledgeRepository } from "./domainKnowledgeTypes.ts";

export interface KnowledgeCodeSnapshot {
  repository: KnowledgeRepository; root: string; revision: string; files: string[];
  build_units: Array<{ path: string; targets: string[]; dependencies: string[] }>;
}
export async function scanKnowledgeCode(repository: KnowledgeRepository, source: { root: string; revision: string }, signal: AbortSignal, excludePath?: (path: string) => boolean) {
  const files = (await listGitTreePaths(source.root, source.revision, repository.path, signal))
    .filter(p => !isResearchPlatformPath(p) && !excludePath?.(p));
  const build_units: KnowledgeCodeSnapshot["build_units"] = [];
  for (const path of files.filter(f => /(^|\/)(CMakeLists\.txt|pom\.xml|package\.json)$/.test(f))) {
    const content = await readGitBuildFile(source.root, source.revision, path, signal);
    let targets: string[] = [], dependencies: string[] = [];
    if (path.endsWith("CMakeLists.txt")) {
      const clean = content.replace(/#[^\n]*/g, "");
      targets = [...clean.matchAll(/add_(?:library|executable)\s*\(\s*([^\s)]+)/gi)].map(m => m[1]);
      dependencies = [...clean.matchAll(/target_link_libraries\s*\(([^)]+)\)/gi)].flatMap(m => m[1].trim().split(/\s+/).slice(1)).filter(t => !/^(?:PUBLIC|PRIVATE|INTERFACE|debug|optimized|general)$/.test(t));
    } else if (path.endsWith("pom.xml")) {
      const clean = content.replace(/<!--[\s\S]*?-->/g, "");
      dependencies = [...clean.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)].flatMap(m => [...m[1].matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map(a => a[1]));
      targets = [...clean.replace(/<parent>[\s\S]*?<\/parent>|<dependencies>[\s\S]*?<\/dependencies>|<build>[\s\S]*?<\/build>/g, "").matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].slice(0, 1).map(m => m[1]);
    } else {
      try { const pkg = JSON.parse(content); targets = typeof pkg.name === "string" ? [pkg.name] : []; dependencies = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }); }
      catch { /* 不完整的构建文件由盘点会话核对。 */ }
    }
    build_units.push({ path, targets: [...new Set(targets)], dependencies: [...new Set(dependencies)] });
  }
  return { repository, ...source, files, build_units } satisfies KnowledgeCodeSnapshot;
}
export function knowledgeStructure(snapshots: KnowledgeCodeSnapshot[]) {
  return snapshots.map(s => ({ repository_id: s.repository.id, revision: s.revision, files: s.files.length,
    directories: [...new Set(s.files.map(f => f.split("/").slice(0, -1).join("/")).filter(Boolean))].slice(0, 400),
    build_units: s.build_units,
    dependency_edges: s.build_units.flatMap(unit => unit.dependencies.flatMap(dependency => snapshots.flatMap(other => other.build_units.filter(candidate => candidate.targets.includes(dependency)).map(candidate => ({ from: `${s.repository.id}:${unit.path}`, to: `${other.repository.id}:${candidate.path}`, dependency }))))),
    build_files: s.files.filter(f => /(^|\/)(CMakeLists\.txt|pom\.xml|build\.gradle(?:\.kts)?|package\.json|go\.mod|Cargo\.toml)$/.test(f)),
    note: "构建依赖由 CMake/Maven/npm 文本静态提取，只作候选：不执行构建，不解析变量、条件或外部下载依赖。读取真实调用和 import/include 后核实业务模块；目录列表最多 400 项，完整目录使用 component_source 分页。" }));
}

/** 同一个 start 分别用于四类结果，直到所有集合都没有下一页。 */
export function knowledgeStructurePage(snapshots: KnowledgeCodeSnapshot[], repositoryId: string, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("结构盘点的 start 必须是非负安全整数");
  const snapshot = snapshots.find(s => s.repository.id === repositoryId);
  if (!snapshot) throw new Error("仓不在研究范围");
  const pageSize = 30, pageEnd = start + pageSize;
  const nextStart = (total: number) => pageEnd < total ? pageEnd : undefined;
  const preview = (values: string[]) => ({
    values: values.slice(0, 8).map(value => value.length > 256 ? value.slice(0, 256) + "…" : value),
    complete: values.length <= 8 && values.every(value => value.length <= 256),
  });
  const build_units = snapshot.build_units.slice(start, pageEnd).map(unit => {
    const targets = preview(unit.targets), dependencies = preview(unit.dependencies);
    return {
      path: unit.path,
      targets_preview: targets.values, targets_total: unit.targets.length, targets_preview_complete: targets.complete,
      dependencies_preview: dependencies.values, dependencies_total: unit.dependencies.length, dependencies_preview_complete: dependencies.complete,
      source: { tool: "component_source", action: "read", repository_id: repositoryId, path: unit.path, start: 1 },
    };
  });
  const build_files: string[] = [], directories: string[] = [], seenDirectories = new Set<string>();
  let build_files_total = 0, directories_total = 0;
  for (const file of snapshot.files) {
    if (/(^|\/)(CMakeLists\.txt|pom\.xml|build\.gradle(?:\.kts)?|package\.json|go\.mod|Cargo\.toml)$/.test(file)) {
      if (build_files_total >= start && build_files_total < pageEnd) build_files.push(file);
      build_files_total++;
    }
    const slash = file.lastIndexOf("/"), directory = slash < 0 ? "" : file.slice(0, slash);
    if (directory && !seenDirectories.has(directory)) {
      seenDirectories.add(directory);
      if (directories_total >= start && directories_total < pageEnd) directories.push(directory);
      directories_total++;
    }
  }

  // 同名 target 可能对应多个仓、多个构建单元。索引只保存候选引用，边只生成当前页。
  const targets = new Map<string, Array<{ repositoryId: string; path: string }>>();
  for (const other of snapshots) for (const unit of other.build_units) {
    const candidate = { repositoryId: other.repository.id, path: unit.path };
    for (const target of new Set(unit.targets)) {
      const candidates = targets.get(target);
      if (candidates) candidates.push(candidate); else targets.set(target, [candidate]);
    }
  }
  const dependency_edges: Array<{ from: string; to: string; dependency: string; dependency_truncated: boolean }> = [];
  let dependency_edges_total = 0;
  for (const unit of snapshot.build_units) for (const dependency of unit.dependencies) {
    const candidates = targets.get(dependency);
    if (!candidates) continue;
    const first = Math.max(0, start - dependency_edges_total), end = Math.min(candidates.length, pageEnd - dependency_edges_total);
    for (let i = first; i < end; i++) dependency_edges.push({
      from: `${repositoryId}:${unit.path}`, to: `${candidates[i].repositoryId}:${candidates[i].path}`,
      dependency: dependency.length > 256 ? dependency.slice(0, 256) + "…" : dependency,
      dependency_truncated: dependency.length > 256,
    });
    dependency_edges_total += candidates.length;
    if (!Number.isSafeInteger(dependency_edges_total)) throw new Error("构建依赖数量超出可精确分页范围");
  }
  const build_units_total = snapshot.build_units.length;
  return {
    repository_id: repositoryId, revision: snapshot.revision, files: snapshot.files.length, start, page_size: pageSize,
    build_units, build_units_total, build_units_next_start: nextStart(build_units_total),
    build_files, build_files_total, build_files_next_start: nextStart(build_files_total),
    dependency_edges, dependency_edges_total, dependency_edges_next_start: nextStart(dependency_edges_total),
    directories, directories_total, directories_next_start: nextStart(directories_total),
    next_start: nextStart(Math.max(build_units_total, build_files_total, dependency_edges_total, directories_total)),
    note: "四类结果分别按 start 分页，每类最多 30 项；使用 next_start 继续，直到所有集合读完。构建单元的 targets_preview/dependencies_preview 最多 8 项，每项最多 256 字符；*_preview_complete=false 表示预览不完整，完整内容按 source 入口分页读取构建文件。dependency_truncated=true 时依赖名也只是预览，须读取 from 指向的文件。构建依赖由 CMake/Maven/npm 文本静态提取，只作候选：不执行构建，不解析变量、条件或外部下载依赖；请读取真实调用和 import/include 核实。",
  };
}
export function codeReferences(text: string): string[] {
  const refs = [...text.matchAll(/`([\p{L}\p{N}_.-]+:[^`\s]+)`/gu)].map(m => m[1]).filter(r => !/^[a-z]+:\/\//i.test(r));
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (frontmatter) {
    let inRefs = false;
    for (const line of frontmatter.split(/\r?\n/)) {
      if (/^related_code\s*:/.test(line)) {
        inRefs = true;
        const inline = line.replace(/^related_code\s*:\s*/, "");
        if (inline && inline !== "[]") for (const item of inline.replace(/^\[|\]$/g, "").split(",")) refs.push(item.trim().replace(/^["']|["']$/g, ""));
      } else if (inRefs && /^\s*-\s*/.test(line)) refs.push(line.replace(/^\s*-\s*/, "").trim().replace(/^["']|["']$/g, ""));
      else if (line.trim() && !/^\s/.test(line)) inRefs = false;
    }
  }
  return [...new Set(refs)];
}
export async function validateKnowledgeReferences(text: string, snapshots: KnowledgeCodeSnapshot[], signal: AbortSignal) {
  const errors: string[] = [], checked: string[] = [];
  for (const ref of codeReferences(text)) {
    signal.throwIfAborted();
    const colon = ref.indexOf(":"), repo = ref.slice(0, colon), rest = ref.slice(colon + 1);
    const matches = snapshots.filter(s => s.repository.id === repo || s.repository.name === repo);
    if (matches.length !== 1) { errors.push(`${ref}：仓编号未知或重名，请使用 repository_id`); continue; }
    const snapshot = matches[0], match = /^(.*?)(?::(\d+)(?:-(\d+))?|#(.+))?$/.exec(rest)!;
    const path = match[1];
    if (!path || path.startsWith("/") || /[\\\x00-\x1f]/.test(path) || path.split("/").some(s => s === ".." || s === ".")) { errors.push(`${ref}：路径无效`); continue; }
    const pattern = new RegExp("^" + path.split("**").map(p => p.split("*").map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*") + "$");
    const files = snapshot.files.filter(f => pattern.test(f) || (!path.includes("*") && f.startsWith(`${path}/`)));
    if (!files.length) { errors.push(`${ref}：当前版本和研究范围内没有匹配文件`); continue; }
    if (match[2] || match[4]) {
      if (!snapshot.files.includes(path)) { errors.push(`${ref}：行号或符号必须指向文件`); continue; }
      const source = await readGitBlobPage(snapshot.root, snapshot.revision, path,
        { symbol: match[4]?.split("::").at(-1)!.replace(/\(\)$/, "") }, signal);
      if (match[2]) {
        const start = Number(match[2]), end = Number(match[3] ?? match[2]);
        if (start < 1 || end < start || end > source.totalLines) { errors.push(`${ref}：行号越界`); continue; }
      }
      if (match[4] && !source.symbolFound) { errors.push(`${ref}：符号不存在`); continue; }
    }
    checked.push(ref);
  }
  return { checked, errors };
}
