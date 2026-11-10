import { MAE_BUILD_REPOSITORIES } from "../maeBuildSupport.ts";
/**
 * 问题流多仓契约文件收集(spec #131 / issue #132,2026-09-03)。
 *
 * 动机:每个代码仓自带的 AGENTS.md/CLAUDE.md 是仓的行为契约(提交
 * 规范、目录约定、构建纪律),模型开局就该知道。但问题流会话的 cwd
 * 是工作区根 live.root,代码仓平铺在 live.root/repo/<仓名>/ 下——
 * SDK 的祖先目录发现从 live.root 往上找,永远望不到仓根,契约文件
 * 靠 SDK 自己永远进不了系统提示词。所以平台代替 SDK 收:按与 SDK
 * 完全相同的候选优先级逐仓取一份,经 sessionDriver 的
 * agentsFilesOverride 塞进系统提示词。
 *
 * 纪律:这是启动期的上下文装配,不是交付链路——fail-open(旁路纪律),
 * 任何一仓读不动就跳过,绝不因装配失败炸掉会话开启。
 */

import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/** 与 pi SDK resource-loader 的逐仓候选序逐字一致(读 SDK dist 才
 * 发现不止认 AGENTS.md,且 override 优先、大小写各算一条):每仓取
 * 第一个存在的候选,先到先得,不叠加——同仓双份契约会互相矛盾,
 * SDK 语义如此,平台收集不另立规矩。导出供守约测试对齐 SDK 升级。 */
export const CONTRACT_CANDIDATES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

/** 单仓契约截断线(16K 字符——按 content.length 数,中文 UTF-8 下
 *  约合数万字节,比字面 16KB 宽松;方向安全,多仓同时注入,
 * 不设上限等于把系统提示词让给最啰嗦的那个仓;截断只丢正文不丢
 * 路径——模型要全文自己 Read,文件就在仓里。 */
const MAX_CONTRACT_CHARS = 16_000;

const TRUNCATION_MARKER =
  "\n\n[平台注:文件超 16K 字符已截断,完整内容请按路径 Read]";

/** 一个仓契约文件:绝对路径 + 注入正文(可能带截断尾注)。形状与
 * SDK agentsFilesOverride 的元素对齐,sessionDriver 原样并入。 */
export interface RepoContextFile {
  path: string;
  content: string;
}

/** 扫 <workspaceRoot>/repo/ 下平铺的仓目录,逐仓按候选序收集契约文件。
 * 没有 repo/ 目录(一仓未拉)返回空数组;单仓出错跳过该仓,不抛。 */
export function collectRepoContextFiles(
  workspaceRoot: string,
): RepoContextFile[] {
  const repoRoot = join(workspaceRoot, "repo");
  let entries: Dirent[];
  try {
    entries = readdirSync(repoRoot, { withFileTypes: true });
  } catch {
    // repo/ 不存在 = 还没拉任何仓,这是常态不是异常,静默空。
    return [];
  }
  // readdir 顺序不保证(跨平台更不保证):按仓名排序,多仓注入顺序
  // 确定,提示词与测试都可复现。
  const collected: RepoContextFile[] = [];
  for (const entry of [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    // withFileTypes 走 lstat 语义:符号链接(哪怕指向目录)不算
    // isDirectory,天然出局——repo/ 下不该有指出去的链接,有也不追。
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (MAE_BUILD_REPOSITORIES.some((repo) => repo.name === entry.name)) continue;
    const file = pickContractFile(join(repoRoot, entry.name));
    if (!file) continue;
    try {
      collected.push({
        path: file,
        content: readFileSync(file, "utf-8"),
      });
    } catch {
      // 读不动(权限/竞态删除)只丢这一仓的契约:少一份上下文,
      // 好过整场会话开不起来。
      continue;
    }
  }
  return collected.map((item) => item.content.length > MAX_CONTRACT_CHARS
    ? {
      path: item.path,
      content: item.content.slice(0, MAX_CONTRACT_CHARS) + TRUNCATION_MARKER,
    }
    : item);
}

/** 按候选序找第一个"真文件":存在但是目录(或 stat 失败)当没命中,
 * 继续试下一个候选——不把目录误当契约正文灌进提示词。 */
function pickContractFile(repoDir: string): string | undefined {
  for (const candidate of CONTRACT_CANDIDATES) {
    const path = join(repoDir, candidate);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // 不存在 = 试下一个候选,不报错。
    }
  }
  return undefined;
}
