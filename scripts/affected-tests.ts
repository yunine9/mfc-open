#!/usr/bin/env tsx
/**
 * 增量测试:按 git 改动反查受影响的测试文件,只跑它们。
 *
 * 用法:
 *   npm run test:affected                # 工作树相对 HEAD(含未跟踪文件)
 *   npm run test:affected -- --base main # 与某基线的 merge-base 对拍
 *   npm run test:affected -- --dry       # 只列清单不执行
 *
 * 依赖图口径(诚实边界,写在前面):
 * - 静态相对 import(import/export from "./x.ts"、动态 import("./x"))——
 *   覆盖 src/tests 的 TS 内部依赖,解析 .ts/.tsx/index;
 * - 字符串路径引用(["']src/…|web/src/…|assets/…|kernel/…|tests/browser/…["'])——
 *   UI 契约测试用 readFileSync(resolve("web/src/App.tsx")) 读源码文本断言,
 *   真浏览器测试用 resolve("tests/browser/x.tsx") 交 esbuild 打包,都不走
 *   import,纯 import 图会漏掉它们(2026-10-08 补 tests/browser:改 web 组件
 *   原先捞不到对应的浏览器测试);
 * - 已删除的源文件映射不到边(图只扫现存文件)——删模块会连坐破坏
 *   引用方,typecheck/gate 兜底;配置类改动(package.json/CI/脚本)同理,
 *   无映射时提示跑 npm run gate,宁可多跑不静默漏跑。
 * 全量回归仍属于 npm test / CI;本脚本只回答"这次改动牵连哪些用例"。
 */
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, posix } from "node:path";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const baseIndex = args.indexOf("--base");
const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
const root = process.cwd();

/** 收集目录下全部 .ts/.tsx(不进 node_modules/dist/隐藏目录)。 */
function collect(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
        continue;
      }
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
  };
  walk(join(root, dir));
  return out;
}

const files = new Set<string>(
  ["src", "web/src", "tests"].flatMap((dir) =>
    existsSync(join(root, dir))
      ? collect(dir).map((path) => posix.normalize(path.slice(root.length + 1)))
      : []),
);

/** 相对 import 解析到仓内真实文件(带扩展候选)。 */
function resolveRelative(from: string, spec: string): string | undefined {
  const target = posix.normalize(posix.join(dirname(from), spec));
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`,
    `${target}/index.ts`, `${target}/index.tsx`]) {
    if (files.has(candidate)) return candidate;
  }
  return undefined;
}

const importPattern = /(?:import|export)[^'";]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|require\(\s*["'](\.[^"']+)["']\s*\)/g;
const stringRefPattern = /["']((?:src|web\/src|assets|kernel|tests\/browser)\/[^"']+?\.(?:ts|tsx|md|json|mjs|py))["']/g;

/** 反向邻接:被依赖方 → 引用它的文件(只扫现存文件,见头注边界)。 */
const reverse = new Map<string, Set<string>>();
for (const file of files) {
  const text = readFileSync(join(root, file), "utf-8");
  for (const match of text.matchAll(importPattern)) {
    const spec = match[1] ?? match[2] ?? match[3];
    const resolved = spec && resolveRelative(file, spec);
    if (!resolved || resolved === file) continue;
    let bucket = reverse.get(resolved);
    if (!bucket) reverse.set(resolved, (bucket = new Set()));
    bucket.add(file);
  }
  for (const match of text.matchAll(stringRefPattern)) {
    const ref = posix.normalize(match[1]);
    if (ref === file) continue;
    let bucket = reverse.get(ref);
    if (!bucket) reverse.set(ref, (bucket = new Set()));
    bucket.add(file);
  }
}

/** git 改动清单(相对 base 的 merge-base 或 HEAD;未跟踪只在工作树模式收)。 */
function changedFiles(): string[] {
  const diff = execFileSync("git",
    ["diff", "--name-only", ...(base ? [`${base}...`] : ["HEAD"])],
    { cwd: root, encoding: "utf-8" });
  const untracked = base ? "" : execFileSync("git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf-8" });
  return `${diff}\n${untracked}`
    .split("\n").map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 从改动文件沿反向边 BFS:传递依赖到它们的文件都是受影响方。
const changed = changedFiles();
// 提示词资产是 promptCopy 运行时动态读盘(assets/issue-prompts/*.md),
// 静态图扫不到——定向等价于"改了 src/issueFlow/prompt.ts",让它的
// 引用方(问题流全家)亮起来,不静默漏跑。
if (changed.some((file) => file.startsWith("assets/issue-prompts/"))
    && files.has("src/issueFlow/prompt.ts")) {
  changed.push("src/issueFlow/prompt.ts");
}
const visited = new Set<string>(changed);
const queue = [...changed];
while (queue.length) {
  for (const importer of reverse.get(queue.shift()!) ?? []) {
    if (!visited.has(importer)) {
      visited.add(importer);
      queue.push(importer);
    }
  }
}
// 快层排除表与 package.json 的 npm test 同一份:被排除的重家族
// (delivery.part*/mrLoop/issueFlowFixed.part* 等)本来就不在本地跑,
// 增量也不捞它们——口径一致,免得"增量比全量还慢"。
const excluded = new RegExp(
  "delivery(\\.test|\\.part)|mrLoop|activity|containerOwnership|issueFlowFixed"
  + "|continuousReviewContract|gitToken|managedStartup|issueGatewayDegrade"
  + "|feedbackSourcesReceipt|annotateTargets|kernelUnavailableRecovery");
const affected = [...visited]
  .filter((file) => /^tests\/.*\.test\.ts$/.test(file))
  .filter((file) => !excluded.test(file.slice("tests/".length)))
  .filter((file) => existsSync(join(root, file)))
  .sort();

console.log(`[affected] 改动 ${changed.length} 个文件,受影响测试 ${affected.length} 个`
  + (base ? `(基线 ${base} 的 merge-base)` : "(相对 HEAD)"));
if (!affected.length) {
  console.log("[affected] 无可映射的受影响用例——配置类改动请跑 npm run gate 兜底");
  process.exit(0);
}
for (const file of affected) console.log(`  ${file}`);
if (dry) process.exit(0);

// 与 package.json 的 test 同款执行形态(进程内 tsx --test),只换文件清单。
const run = spawnSync(process.execPath,
  ["--import", "tsx", "--test",
    `--test-concurrency=${process.env.MFC_TEST_CONCURRENCY ?? 8}`,
    "--test-timeout=180000", "--test-force-exit", ...affected],
  { cwd: root, stdio: "inherit" });
process.exit(run.status ?? 1);
