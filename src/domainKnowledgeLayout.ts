import type { DomainKnowledgeJob, KnowledgeRepository } from "./domainKnowledgeTypes.ts";

const opaqueModuleId = /^module-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function hasOpaqueModuleDirectory(directory: string): boolean {
  return directory.split("/").some(part => opaqueModuleId.test(part));
}

export function needsModuleKnowledgeLayout(job: Pick<DomainKnowledgeJob, "module_id" | "knowledge_layout" | "component_research_id">
  & Partial<Pick<DomainKnowledgeJob, "knowledge_target" | "repositories" | "documents">>): boolean {
  // 已确认删除须按原位置删除 Git 文件，不能迁往一个从未归档的新路径。
  if (job.documents?.length && job.documents.every(document => document.deleted && document.knowledge_document_id
    && document.published_document_revision === document.revision)) return false;
  return !job.component_research_id && (job.knowledge_layout !== "directory-v1"
    || [job.knowledge_target, ...job.repositories ?? []].some(target => target && hasOpaqueModuleDirectory(target.docs_path))
    || job.repositories?.some(target => target.docs_path === "." || !target.docs_path.startsWith("docs/")) === true
    || job.documents?.some(document => {
      if (document.deleted) return false;
      const target = [job.knowledge_target, ...job.repositories ?? []].find(target => target?.id === document.target_id);
      const path = document.archive_path ?? document.path;
      return hasOpaqueModuleDirectory(path) || !!target && !path.startsWith(`${target.docs_path}/`);
    }) === true);
}

/** 最终目录：代码仓集中在 docs 的业务子目录，领域仓使用用户选择的相对目录。 */
export function directoryKnowledgeDirectory(directory: string, title: string, moduleId: string | undefined, isDomain: boolean): string {
  const name = repositoryKnowledgeDirectory(title), fallback = `docs/${opaqueModuleId.test(name) ? "领域知识" : name}`;
  const cleaned = readableDomainKnowledgeDirectory(directory, moduleId, title).replace(/\/$/, "");
  if (!cleaned || [".", "docs", "domain-docs", "domains", "docs/knowledge"].includes(cleaned)
    || hasOpaqueModuleDirectory(directory) && (!isDomain || /^(?:domain-docs|domains|docs\/knowledge)\//.test(directory))) return fallback;
  if (isDomain || cleaned.startsWith("docs/")) return cleaned;
  return `docs/${cleaned}`;
}

/** 拆掉旧目录包装后，所有文稿统一进入最终目录，保持内部子目录结构。 */
export function directoryKnowledgePath(oldDirectory: string, newDirectory: string, path: string, repositoryNames: readonly string[] = []): string {
  if (path.startsWith(`${newDirectory}/`) && !hasOpaqueModuleDirectory(path)) return /\/agents\.md$/i.test(path) ? path.replace(/[^/]+$/, "README.md") : path;
  const parts = path.split("/"), wrapper = parts.reduce((last, part, index) => opaqueModuleId.test(part) ? index : last, -1);
  const old = oldDirectory.replace(/\/$/, ""), removedOld = old !== "." && path.startsWith(`${old}/`);
  let relative = wrapper >= 0 ? parts.slice(wrapper + 1).join("/") : removedOld ? path.slice(old.length + 1) : path;
  const repository = repositoryNames.find(name => name && relative.startsWith(`${name}/`));
  if (repository) relative = relative.slice(repository.length + 1);
  if (repository || wrapper < 0 && !removedOld) {
    for (const prefix of ["docs/knowledge/", "domain-docs/", "domains/", "docs/"]) if (relative.startsWith(prefix)) { relative = relative.slice(prefix.length); break; }
  } else if (wrapper >= 0 && repositoryNames.length) {
    for (const prefix of ["docs/knowledge/", "docs/"]) if (relative.startsWith(prefix)) { relative = relative.slice(prefix.length); break; }
  }
  relative = relative.replace(/(^|\/)agents\.md$/i, "$1README.md");
  return `${newDirectory}/${relative}`;
}


/** 默认领域目录使用创建时的业务名称；不把内部编号写进目录。 */
export function repositoryKnowledgeDirectory(name: string): string {
  const value = name.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").replace(/^[. ]+|[. ]+$/g, "").slice(0, 160);
  return value && value.toLowerCase() !== ".git" ? value : "domain-docs";
}

/** 替换历史内部编号段；已经指定的其他目录段保持原样，不再追加名称。 */
export function readableDomainKnowledgeDirectory(directory: string, moduleId: string | undefined, title: string): string {
  const name = repositoryKnowledgeDirectory(title);
  const readable = opaqueModuleId.test(name) ? "领域知识" : name;
  const parts = directory.trim().replace(/\/$/, "").split("/");
  return parts.map(part => part === moduleId || opaqueModuleId.test(part) ? readable : part).join("/");
}

/** 部分旧记录只改了目标配置；从文稿实际路径恢复旧包装，避免再次套目录。 */
export function repairModuleKnowledgePath(oldDirectory: string, newDirectory: string, path: string,
  repositoryNames: readonly string[] = [], stripOldDirectory = false): string {
  const parts = path.split("/"), index = parts.reduce((last, part, index) => opaqueModuleId.test(part) ? index : last, -1);
  return repositoryKnowledgePath(index >= 0 ? parts.slice(0, index + 1).join("/") : oldDirectory,
    newDirectory, path, repositoryNames, index >= 0 || stripOldDirectory);
}

/** 只去掉已知旧目录及准确匹配的工作区仓名前缀，保留仓内相对结构。 */
export function repositoryKnowledgePath(oldDirectory: string, newDirectory: string, path: string, repositoryNames: readonly string[] = [], stripOldDirectory = false): string {
  const old = oldDirectory.replace(/\/$/, ""), directory = newDirectory.replace(/\/$/, "");
  let relative = path;
  const removedOldPrefix = stripOldDirectory && old !== "." && relative.startsWith(`${old}/`);
  if (removedOldPrefix) relative = relative.slice(old.length + 1);
  const name = repositoryNames.find(name => name && relative.startsWith(`${name}/`));
  if (name) {
    relative = relative.slice(name.length + 1);
    // 工作区前缀后的 docs/x 已是仓内路径；指定 docs 时只保留一层。
    if (removedOldPrefix && directory !== "." && relative.startsWith(`${directory}/`)) relative = relative.slice(directory.length + 1);
  }
  if (/^agents\.md$/i.test(relative)) relative = directory === "." ? "docs/README.md" : "README.md";
  else if (/\/agents\.md$/i.test(relative)) relative = relative.replace(/[^/]+$/, "index.md");
  if (directory === ".") return relative;
  return !removedOldPrefix && relative.startsWith(`${directory}/`) ? relative : `${directory}/${relative}`;
}

/** 模块目录由平台确定；已经带模块编号的目录不会重复追加。 */
export function moduleKnowledgeDirectory(base: string, moduleId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(moduleId)) throw new Error("业务模块编号不能用作知识目录");
  const directory = base.trim().replace(/\/$/, "");
  if (!directory || directory.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) throw new Error("请使用仓内知识目录的相对路径");
  const result = directory.endsWith(`/${moduleId}`) ? directory : `${directory}/${moduleId}`;
  if (result.length > 1000) throw new Error("模块知识目录过长");
  return result;
}

/** 整理旧文稿时保留目录结构；根 AGENTS 的模块内容移入模块说明。 */
export function moduleKnowledgePath(oldDirectory: string, newDirectory: string, path: string): string {
  oldDirectory = oldDirectory.replace(/\/$/, "");
  newDirectory = newDirectory.replace(/\/$/, "");
  if (path.toLowerCase() === "agents.md") return `${newDirectory}/README.md`;
  const mapped = path.startsWith(`${newDirectory}/`) ? path : path.startsWith(`${oldDirectory}/`)
    ? `${newDirectory}/${path.slice(oldDirectory.length + 1)}` : `${newDirectory}/${path}`;
  return /\/agents\.md$/i.test(mapped) ? mapped.replace(/[^/]+$/, "index.md") : mapped;
}

/** 一次整理全部文稿；同仓同分支使用相同 collision_group，未配置仓库时使用目标编号。 */
export function moduleKnowledgePaths(
  documents: ReadonlyArray<{ id: string; target_id: string; path: string; desired_path?: string }>,
  targets: ReadonlyArray<{ id: string; old_directory: string; new_directory: string; collision_group: string }>,
  occupiedPaths: ReadonlyArray<{ collision_group: string; path: string; document_id?: string }> = [],
): { paths: Map<string, string>; renamed: Array<{ id: string; target_id: string; path: string; desired_path: string }> } {
  const targetById = new Map(targets.map(target => [target.id, target]));
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const key = (group: string, path: string) => JSON.stringify([group, path.toLowerCase()]);
  const entries = documents.map(document => {
    const target = targetById.get(document.target_id);
    if (!target) throw new Error("文稿的归档目标不存在");
    const directory = target.new_directory.replace(/\/$/, "");
    const desired = directory === "." ? document.desired_path ?? repositoryKnowledgePath(target.old_directory, directory, document.path) : moduleKnowledgePath(target.old_directory, directory, document.desired_path ?? document.path);
    if (directory !== "." && !desired.startsWith(`${directory}/`) || !desired.endsWith(".md") || desired.length > 1000
      || desired.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
      throw new Error("文稿整理后的路径须为归档目录内的 Markdown 文件");
    }
    // 原根入口优先占用 README；其他碰撞先保留已经位于目标路径的文稿。
    const priority = document.path.toLowerCase() === "agents.md" && desired === (directory === "." ? "README.md" : `${directory}/README.md`) ? 0 : document.path === desired ? 1 : 2;
    return { document, target, desired, priority };
  }).sort((a, b) => a.priority - b.priority || compare(a.document.id, b.document.id));
  if (new Set(entries.map(entry => entry.document.id)).size !== entries.length) throw new Error("文稿编号不能重复");
  // 正式位置只允许唯一对应的原文稿复用；未发布的其他篇也不能让出已有正式位置。
  const occupied = new Map<string, Set<string | undefined>>();
  for (const location of occupiedPaths) {
    const locationKey = key(location.collision_group, location.path), owners = occupied.get(locationKey) ?? new Set<string | undefined>();
    owners.add(location.document_id); occupied.set(locationKey, owners);
  }
  const belongsToOther = (locationKey: string, documentId: string) => {
    const owners = occupied.get(locationKey);
    return !!owners && (owners.size !== 1 || !owners.has(documentId));
  };
  // 所有期望名先预留，自动避让也保护仅大小写不同的文件名。
  const claimed = new Set<string>();
  const reserved = new Set(entries.map(entry => key(entry.target.collision_group, entry.desired)));
  const result = new Map<string, string>();
  const renamed: Array<{ id: string; target_id: string; path: string; desired_path: string }> = [];
  for (const { document, target, desired } of entries) {
    const desiredKey = key(target.collision_group, desired);
    let path = desired;
    if (claimed.has(desiredKey) || belongsToOther(desiredKey, document.id)) {
      const suffixId = document.id.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "document";
      const slash = desired.lastIndexOf("/"), directory = desired.slice(0, slash + 1), stem = desired.slice(slash + 1, -3);
      for (let attempt = 1; ; attempt++) {
        const suffix = `-${suffixId}${attempt === 1 ? "" : `-${attempt}`}.md`;
        const available = Math.min(255, 1000 - directory.length) - suffix.length;
        if (available < 1) throw new Error("模块知识目录过长，无法保留文稿文件名");
        path = `${directory}${stem.slice(0, available)}${suffix}`;
        const pathKey = key(target.collision_group, path);
        if (!reserved.has(pathKey) && !claimed.has(pathKey) && !belongsToOther(pathKey, document.id)) break;
      }
      renamed.push({ id: document.id, target_id: document.target_id, path, desired_path: desired });
    }
    claimed.add(key(target.collision_group, path)); reserved.add(key(target.collision_group, path)); result.set(document.id, path);
  }
  return { paths: new Map([...result].sort(([a], [b]) => compare(a, b))), renamed: renamed.sort((a, b) => compare(a.id, b.id)) };
}

/** 按任务固定的目录规则校验文稿，旧批次不继承新任务布局。 */
export function assertModuleKnowledgePath(
  job: Pick<DomainKnowledgeJob, "module_id" | "knowledge_layout">,
  target: Pick<KnowledgeRepository, "docs_path">,
  path: string,
): void {
  if (job.knowledge_layout === "repository-v1" || job.knowledge_layout === "directory-v1") {
    if (job.knowledge_layout === "directory-v1" && target.docs_path === ".") throw new Error("请选择保存知识文稿的相对目录");
    if ((target.docs_path !== "." && !path.startsWith(`${target.docs_path}/`)) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
      throw new Error(`文稿须使用归档目录 ${target.docs_path} 内的仓根相对路径`);
    }
    if (/(^|\/)agents\.md$/i.test(path)) throw new Error("文稿不生成 AGENTS.md；请使用 README.md 或 index.md，仓根入口由平台维护");
    return;
  }
  if (job.knowledge_layout !== "module-v1") return;
  if (!job.module_id || moduleKnowledgeDirectory(target.docs_path, job.module_id) !== target.docs_path) throw new Error("模块知识目录缺少业务模块编号，请重新设置归档位置");
  if (!path.startsWith(`${target.docs_path}/`) || path.split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || /[\\\x00-\x1f]/.test(part))) {
    throw new Error(`本模块文稿须保存在 ${target.docs_path}/ 内；仓库根目录 AGENTS.md 由平台维护入口`);
  }
  if (/\/agents\.md$/i.test(path)) throw new Error("本模块文稿不生成 AGENTS.md；请使用 README.md 或 index.md，仓库只保留根目录统一入口");
}
