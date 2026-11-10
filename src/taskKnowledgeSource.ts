import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { TaskKnowledgeUsage } from "./knowledgeTrace.ts";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** 只按任务已经登记的知识 ID 查原文，不接受浏览器指定文件路径。
 * 读取当前文件并如实提示版本变化；不能把当前内容冒充历史快照。 */
export function readTaskKnowledgeSource(options: {
  workspace: string; repositoryRoot?: string; hostRulesRoot?: string;
  usage?: TaskKnowledgeUsage; resourceId: string;
}): { name: string; path: string; content: string; version_changed: boolean } {
  const resource = options.usage?.resources.find((item) => item.id === options.resourceId);
  if (!resource) throw new Error("这项知识不在本任务的知识记录中");
  const workspace = resolve(options.workspace);
  const candidates = [resolve(workspace, resource.path),
    ...(options.repositoryRoot ? [resolve(options.repositoryRoot, resource.path)] : []),
    ...(options.usage?.events ?? []).filter((event) => event.id === resource.id
      && event.observed_path && basename(event.observed_path) === basename(resource.path))
      .map((event) => resolve(event.observed_path!))];
  // SDK 会加载宿主项目规则，足迹只保留末两段。这里只还原确切的
  // AGENTS/CLAUDE 规则文件，绝不把宿主目录开放成任意文件阅读器。
  const host = options.hostRulesRoot && resolve(options.hostRulesRoot);
  const rule = basename(resource.path);
  const hostRule = host && resource.kind === "rules"
    && /^(AGENTS(?:\.override)?|CLAUDE)\.md$/.test(rule)
    && resource.path === `${basename(host)}/${rule}` ? resolve(host, rule) : undefined;
  if (hostRule) candidates.push(hostRule);
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!/\.(md|mdx|txt|rst)$/i.test(candidate)) continue;
      const actual = realpathSync(candidate);
      if (candidate === hostRule) {
        if (actual !== resolve(realpathSync(host!), rule)) continue;
      } else if (!inside(workspace, candidate)
          || !inside(realpathSync(workspace), actual)) continue;
      const stat = statSync(actual);
      if (!stat.isFile()) continue;
      if (stat.size > 1024 * 1024) throw new Error("知识原文超过 1 MB，请在源仓库查看");
      const content = readFileSync(actual, "utf-8");
      const digest = resource.digest?.replace(/^sha256:/, "").toLowerCase();
      return { name: resource.name, path: resource.path, content,
        version_changed: Boolean(digest && /^[a-f0-9]{64}$/.test(digest)
          && createHash("sha256").update(content).digest("hex") !== digest) };
    } catch (error) {
      if (error instanceof Error && error.message.includes("超过 1 MB")) throw error;
    }
  }
  throw new Error("原文已不在当前工作区，或属于未保留的外部文件；这条知识使用记录仍然保留");
}
