/** 一次性清理已退役的生产侧数据；必须显式指定 dataDir，默认只列出目录。 */
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// 目录名已与退役前的候选库、Skill 制作和知识整理存储代码核对。
const RETIRED_ROOTS = ["knowledge-candidates", "skill-candidates", "knowledge-consolidation"];
const SNAPSHOT_DIRECTORY = "engineering-knowledge-snapshot";
const RUNTIME_DIRECTORY = "team-engineering-knowledge";

export interface RetirementResult {
  dataDir: string;
  mode: "preview" | "apply";
  targets: string[];
  removed: string[];
  skipped: string[];
  failed: Array<{ path: string; reason: string }>;
}

export function retireKnowledgeProductionData(dataDir: string, apply = false): RetirementResult {
  if (!dataDir.trim()) throw new Error("请显式指定 dataDir");
  const root = resolve(dataDir);
  if (dirname(root) === root) throw new Error("dataDir 不能是文件系统根目录");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("dataDir 必须是普通目录");
  const result: RetirementResult = { dataDir: root, mode: apply ? "apply" : "preview", targets: [], removed: [], skipped: [], failed: [] };

  const include = (path: string) => {
    const info = lstatSync(path);
    if (info.isDirectory() && !info.isSymbolicLink()) result.targets.push(relative(root, path));
    else result.skipped.push(relative(root, path));
  };

  // 快照和投影属于 task-N 现场；不遍历知识库、源码缓存或问题流目录。
  const visitTask = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() || [".git", "node_modules"].includes(entry.name)) continue;
      if (entry.name === RUNTIME_DIRECTORY && basename(path) === ".mae-flow-work") include(child);
      else visitTask(child);
    }
  };

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (RETIRED_ROOTS.includes(entry.name)) include(path);
    else if (entry.name === "domain-extraction" && entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const task of readdirSync(path, { withFileTypes: true })) {
        if (!task.isDirectory() || task.isSymbolicLink()) continue;
        const taskRoot = join(path, task.name), recordPath = join(taskRoot, "job.json");
        try {
          const info = lstatSync(recordPath);
          if (!info.isFile() || info.isSymbolicLink()) { result.skipped.push(relative(root, recordPath)); continue; }
          const job = JSON.parse(readFileSync(recordPath, "utf8"));
          if (!job || typeof job !== "object" || Array.isArray(job)) throw new Error("记录格式无效");
          // probe 在退役前只以 {module} 对象保存；普通研究上的 source_cleanup 只是附属记录。
          const probe = job?.probe && typeof job.probe === "object" && typeof job.probe.module === "string" && job.probe.module.trim();
          if (probe || job?.cleanup_only === true) include(taskRoot);
        } catch {
          // 坏记录交给 B2 的记录隔离处理，清理脚本不猜身份，也不打印正文片段。
          result.skipped.push(relative(root, recordPath));
        }
      }
    }
    else if (/^task-\d+$/.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink()) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (child.name === SNAPSHOT_DIRECTORY) include(join(path, child.name));
      }
      visitTask(path);
    }
  }
  result.targets.sort();
  result.skipped.sort();
  if (apply) for (const path of result.targets) {
    try {
      const target = join(root, path);
      // 列出之后再次确认普通目录；不沿被替换的符号链接删除其他现场。
      const info = lstatSync(target);
      if (!info.isDirectory() || info.isSymbolicLink()) { result.skipped.push(path); continue; }
      rmSync(target, { recursive: true });
      result.removed.push(path);
    } catch (error) {
      result.failed.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function retirementArguments(args: string[]) {
  let dataDir: string | undefined, apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && dataDir === undefined && args[i + 1] && !args[i + 1].startsWith("--")) dataDir = args[++i];
    else if (args[i] === "--apply" && !apply) apply = true;
    else throw new Error("用法：npx tsx scripts/knowledge-production-retirement.ts --data-dir <目录> [--apply]");
  }
  if (!dataDir?.trim()) throw new Error("请使用 --data-dir 显式指定目录；默认只列清单，--apply 才删除");
  return { dataDir, apply };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { dataDir, apply } = retirementArguments(process.argv.slice(2));
    const result = retireKnowledgeProductionData(dataDir, apply);
    // 只打印目录名与删除结果；job.json 只用于识别退役任务，模型配置和凭据文件不读。
    console.log(JSON.stringify(result, null, 2));
    if (result.failed.length) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
