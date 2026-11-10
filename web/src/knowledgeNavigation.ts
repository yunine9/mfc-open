export type KnowledgeAssetFocus =
  | { kind: "business"; moduleId: string; assetId: string;
      version: number; digest: string }
  | { kind: "skill"; directory: string; digest: string;
      packageDigest: string };

function clean(value: string | null): string {
  return value?.trim() ?? "";
}

function digest(value: string | null): string {
  const normalized = clean(value).toLowerCase().replace(/^sha256:/, "");
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : "";
}

/**
 * 团队资产使用根路径查询参数做深链：服务端无需新增 SPA 路由，刷新、
 * 前进后退和把链接发给同事仍能回到同一份全文。
 */
export function knowledgeAssetPath(target: KnowledgeAssetFocus): string {
  const query = new URLSearchParams();
  if (target.kind === "business" && /^kg-[a-f0-9]{64}$/.test(target.assetId)) {
    query.set("kbPage", "module");
    query.set("kbModule", `business:${target.moduleId}`);
    query.set("knowledgeDocument", target.assetId);
    return `/?${query.toString()}`;
  }
  query.set("knowledge", target.kind);
  if (target.kind === "business") {
    query.set("module", target.moduleId);
    query.set("asset", target.assetId);
    query.set("version", String(target.version));
    query.set("digest", target.digest);
  } else {
    query.set("asset", target.directory);
    query.set("digest", target.digest);
    query.set("package_digest", target.packageDigest);
  }
  return `/?${query.toString()}`;
}

export function readKnowledgeAssetFocus(
  search?: string,
): KnowledgeAssetFocus | undefined {
  const browserSearch = (globalThis as { location?: { search?: string } })
    .location?.search ?? "";
  const query = new URLSearchParams(search ?? browserSearch);
  const kind = clean(query.get("knowledge"));
  const asset = clean(query.get("asset"));
  const contentDigest = digest(query.get("digest"));
  if (!asset || !contentDigest) return undefined;
  if (kind === "business") {
    const moduleId = clean(query.get("module"));
    const version = Number(clean(query.get("version")));
    return moduleId && Number.isInteger(version) && version >= 1
      ? { kind, moduleId, assetId: asset, version, digest: contentDigest }
      : undefined;
  }
  if (kind === "skill") {
    const packageDigest = digest(query.get("package_digest"));
    return packageDigest
      ? { kind, directory: asset, digest: contentDigest, packageDigest }
      : undefined;
  }
  return undefined;
}

export function knowledgeAssetElementId(
  kind: KnowledgeAssetFocus["kind"],
  ...parts: string[]
): string {
  return `knowledge-${kind}-${parts.map(encodeURIComponent).join("-")}`;
}

/** 萃取方法继续使用现有阅读页和平台 Skill 详情，不保留旧页面入口。 */
export function extractionSkillSearch(search: string, kind: "component" | "component-analysis" | "domain"): string {
  const query = new URLSearchParams(search);
  for (const key of ["kbPage", "kbAsk", "kbKind", "kbModule", "kbTask", "kbReview", "knowledgeDocument"]) query.delete(key);
  query.set("kbPage", "module");
  query.set("kbModule", "platform");
  query.set("knowledgeDocument", `platform-skill-${kind}`);
  return `?${query.toString()}`;
}
