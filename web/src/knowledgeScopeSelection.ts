const contains = (parent: string, path: string) => path === parent || path.startsWith(`${parent}/`);
function comparePaths(left: string, right: string): number {
  const a = left.split("/"), b = right.split("/");
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return a.length - b.length;
}

/** 排除项按目录边界匹配；docs/a 不影响 docs/ab。 */
export function canonicalKnowledgeExclusions(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort();
  return unique.filter(path => !unique.some(parent => parent !== path && contains(parent, path)));
}

export function knowledgeScopeRows(directories: string[], files: string[], excludedPaths: string[], savedExclusions: string[] = []) {
  const knownDirectories = new Set(directories), knownFiles = new Set(files);
  return [...new Set([...directories, ...files, ...excludedPaths, ...savedExclusions])].sort(comparePaths).map(path => ({
    path, kind: knownDirectories.has(path) ? "directory" as const : knownFiles.has(path) ? "file" as const : "unknown" as const,
    missing: !knownDirectories.has(path) && !knownFiles.has(path),
    excluded: excludedPaths.some(parent => contains(parent, path)),
    inherited: excludedPaths.some(parent => parent !== path && contains(parent, path)),
    partial: !excludedPaths.some(parent => contains(parent, path))
      && excludedPaths.some(child => child !== path && contains(path, child)),
  }));
}

export function selectKnowledgePath(excludedPaths: string[], path: string, included: boolean): string[] {
  // 排除父目录后其下目录和文件不可单独勾选；先恢复父目录，避免显示与保存结果相反。
  if (excludedPaths.some(parent => parent !== path && contains(parent, path))) return excludedPaths;
  const retained = excludedPaths.filter(child => !contains(path, child));
  return canonicalKnowledgeExclusions(included ? retained : [...retained, path]);
}
