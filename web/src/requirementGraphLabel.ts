interface RequirementNodeName {
  name: string;
  scope?: { name?: string };
}

function cleanName(value: string | undefined): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function containsNamePrefix(longer: string, shorter: string): boolean {
  if (!longer || !shorter) return false;
  const rest = longer.slice(shorter.length);
  return longer.toLocaleLowerCase().startsWith(shorter.toLocaleLowerCase())
    && /^(?:\s|[-_/·:：])/.test(rest);
}

/** 仓名负责说明代码仓，模块名负责区分同仓交付单元。Agent 有时会把
 * “仓名 + 模块名”整段同时写进两个字段；展示层去掉机械重复，但不改
 * 原始机读图和稳定 id。 */
export function requirementNodeLabel(node: RequirementNodeName): string {
  const repository = cleanName(node.name);
  const scope = cleanName(node.scope?.name);
  if (!repository) return scope || "未命名模块";
  if (!scope) return repository;
  if (repository.toLocaleLowerCase() === scope.toLocaleLowerCase()) {
    return repository;
  }
  if (containsNamePrefix(scope, repository)) return scope;
  if (containsNamePrefix(repository, scope)) return repository;
  return `${repository} · ${scope}`;
}
