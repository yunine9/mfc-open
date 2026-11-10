export interface DeliveryMr {
  url: string;
  iid: string;
  title: string;
  repo: string;
  source_branch: string;
  target_branch: string;
  sha?: string;
  merge_commit_sha?: string;
  base_sha?: string;
  version?: { head: string; base: string };
  merged_at?: string;
  state: "opened" | "closed" | "merged";
}

export interface RepairMr extends DeliveryMr { sha: string }
const validSha = (sha: unknown): sha is string => typeof sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha);

export function normalizeRepairMrUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("请填写有效的 MR 链接");
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("请填写完整的 MR 链接"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || !/^\/.+\/(?:-\/)?merge_requests\/[1-9]\d*\/?$/.test(url.pathname)) {
    throw new Error("请填写不含凭据的 CodeHub MR 链接");
  }
  url.search = ""; url.hash = ""; url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

/** 仓库地址必须来自平台详情，不从 MR 链接拼接克隆地址。 */
export function parseDeliveryMr(raw: unknown, requestedUrl: string): DeliveryMr {
  const row = raw as Partial<DeliveryMr> | null;
  if (!row || normalizeRepairMrUrl(row.url) !== normalizeRepairMrUrl(requestedUrl)
    || !/^[1-9]\d*$/.test(String(row.iid))
    || !new URL(requestedUrl).pathname.endsWith(`/merge_requests/${row.iid}`)
    || !["opened", "closed", "merged"].includes(String(row.state))
    || (row.sha != null && !validSha(row.sha))
    || typeof row.source_branch !== "string" || !row.source_branch || row.source_branch.includes("\0")
    || typeof row.target_branch !== "string" || !row.target_branch || row.target_branch.includes("\0")
    || typeof row.repo !== "string" || !row.repo) {
    throw new Error("MR 详情不完整，无法确定仓库、分支和当前提交");
  }
  const repo = new URL(row.repo);
  // 平台返回的 HTTPS 克隆域名可以不同于 MR 网页域名。
  if ((repo.protocol !== "https:" && !(repo.protocol === "http:" && repo.origin === new URL(requestedUrl).origin))
    || repo.username || repo.password || repo.search || repo.hash) {
    throw new Error("MR 仓库地址无效，必须使用平台返回的不含凭据的 HTTPS 地址");
  }
  return { url: normalizeRepairMrUrl(row.url), iid: String(row.iid), title: String(row.title || `MR !${row.iid}`),
    repo: repo.toString(), source_branch: row.source_branch, target_branch: row.target_branch,
    state: row.state!,
    ...(validSha(row.sha) ? { sha: row.sha } : {}),
    ...(row.state === "merged" && validSha(row.merge_commit_sha) ? { merge_commit_sha: row.merge_commit_sha } : {}),
    ...(validSha(row.base_sha) ? { base_sha: row.base_sha } : {}),
    ...(row.version && [row.version.head, row.version.base].every(validSha)
      ? { version: { head: row.version.head, base: row.version.base } } : {}),
    ...(row.state === "merged" && typeof row.merged_at === "string" && Number.isFinite(Date.parse(row.merged_at))
      ? { merged_at: new Date(row.merged_at).toISOString() } : {}),
  };
}

export function parseRepairMr(raw: unknown, requestedUrl: string): RepairMr {
  const mr = parseDeliveryMr(raw, requestedUrl);
  if (!mr.sha) throw new Error("MR 详情没有源提交，无法进行流水线修复");
  return { ...mr, sha: mr.sha };
}
