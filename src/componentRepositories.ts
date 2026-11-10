/** Human-managed CBB source ranges. Language is explicit, never inferred from names. */
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { normalizeKnowledgeLanguages } from "./knowledgeLanguages.ts";
import { requireTechnologyStackChanges } from "./technologyStacks.ts";
import { assertRepositoryCloneAddress } from "./repositoryAddress.ts";
export interface ComponentRepository {
  id: string;
  name: string;
  repository: string;
  branch: string;
  path: string;
  languages: string[];
  description: string;
  enabled: boolean;
}
const file = (dir: string) => join(dir, "component-repositories.json");
export function componentRepositories(dir: string): ComponentRepository[] {
  return existsSync(file(dir))
    ? JSON.parse(readFileSync(file(dir), "utf8"))
    : [];
}
export function componentKey(c: ComponentRepository) {
  return createHash("sha256").update(JSON.stringify(c)).digest("hex");
}
export function saveComponentRepository(
  dir: string,
  input: Partial<ComponentRepository>,
  operator: string,
): ComponentRepository {
  const rows = componentRepositories(dir),
    old = input.id ? rows.find((r) => r.id === input.id) : undefined;
  if (input.id && !old) throw new Error("组件配置已不存在");
  const value = { ...old, ...input },
    name = String(value.name ?? "").trim(),
    repository = String(value.repository ?? "").trim(),
    branch = String(value.branch ?? "").trim(),
    path = String(value.path ?? "")
      .trim()
      .replace(/\/$/, "");
  if (!name || name.length > 100) throw new Error("组件名称必填，最多 100 字");
  if (
    !/^https?:\/\//i.test(repository) ||
    repository.length > 2048 ||
    /[\s\0]/.test(repository)
  )
    throw new Error("请填写 HTTP/HTTPS 代码仓地址");
  const url = new URL(repository);
  if (url.username || url.password)
    throw new Error("仓库地址不能携带凭据，请使用个人 Git 配置");
  assertRepositoryCloneAddress(repository);
  if (
    !branch ||
    branch.length > 255 ||
    branch.startsWith("-") ||
    /[\s\\\0]|\.\.|@\{/.test(branch)
  )
    throw new Error("请填写有效分支");
  if (
    path &&
    (path.length > 1000 ||
      path
        .split("/")
        .some((p) => !p || p === "." || p === ".." || /[\\\x00-\x1f]/.test(p)))
  )
    throw new Error("组件路径必须是仓内相对路径");
  const languages = normalizeKnowledgeLanguages(value.languages ?? []);
  if (!languages.length) throw new Error("请选择组件适用语言");
  requireTechnologyStackChanges(dir, languages, old?.languages);
  const row: ComponentRepository = {
    id: old?.id ?? randomUUID(),
    name,
    repository,
    branch,
    path,
    languages,
    description: String(value.description ?? "")
      .trim()
      .slice(0, 1000),
    enabled: value.enabled !== false,
  };
  if (rows.some((r) => r.id !== row.id && r.name === row.name))
    throw new Error("组件名称已存在");
  mkdirSync(dir, { recursive: true });
  const temporary = file(dir) + ".tmp";
  writeFileSync(
    temporary,
    JSON.stringify(
      old ? rows.map((r) => (r.id === row.id ? row : r)) : [...rows, row],
      null,
      2,
    ),
    { mode: 0o600 },
  );
  renameSync(temporary, file(dir));
  appendFileSync(
    join(dir, "component-repository-audit.jsonl"),
    JSON.stringify({
      at: new Date().toISOString(),
      operator,
      previous: old,
      current: row,
    }) + "\n",
    { mode: 0o600 },
  );
  return row;
}
