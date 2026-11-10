/**
 * 本任务知识索引。
 *
 * 知识正文先由各来源运行时固定并投影成只读文件；会话开局只接收这个
 * 小目录。Agent 根据标题、摘要和适用场景决定是否 Read 正文。默认勾选
 * 因而只表示“本任务可用”，绝不等于“全文进入系统提示”。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  MaterializedBusinessKnowledgeEntry,
} from "./businessModuleRuntime.ts";

const INDEX_DIR = ".mae-flow-work";
const INDEX_FILE = "TASK_KNOWLEDGE_INDEX.md";

export interface MaterializedTaskKnowledgeIndex {
  path?: string;
  content?: string;
  warnings: string[];
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`)
    && !isAbsolute(rel));
}

function oneLine(value: string | undefined, max = 500): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

function code(value: string): string {
  return oneLine(value, 1000).replace(/`/g, "'");
}

function readablePath(
  workspace: string,
  absolute: string,
): string | undefined {
  try {
    const root = resolve(workspace);
    const path = resolve(absolute);
    if (!contained(root, path) || !existsSync(path)
        || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()
        || !contained(realpathSync(root), realpathSync(path))) return undefined;
    return relative(root, path).split(sep).join("/") || ".";
  } catch {
    return undefined;
  }
}

function businessSection(
  workspace: string,
  entries: MaterializedBusinessKnowledgeEntry[],
  warnings: string[],
): string[] {
  const labels = {
    document: "文档", skill: "Skill", rule: "规则", example: "示例",
  } as const;
  const lines: string[] = [];
  for (const item of entries.filter((entry) => entry.form !== "skill")) {
    const path = readablePath(workspace, item.path);
    if (!path) {
      warnings.push(`${item.module_name}/${item.title}：业务知识正文不在当前 Agent 工作区，未加入索引`);
      continue;
    }
    lines.push(
      `- ${oneLine(item.title)}（${labels[item.form]} · ${oneLine(item.module_name)}）`,
      `  - 摘要：${oneLine(item.summary)}`,
      `  - 何时读取：${oneLine(item.when_to_use)}`,
      `  - 固定版本：v${item.version}，Owner ${oneLine(item.module_owner, 120)}`,
      ...(item.repositories.length
        ? [`  - 适用仓库：${item.repositories.map((value) => `\`${code(value)}\``).join(" / ")}`]
        : []),
      `  - 按需读取：\`${code(path)}\``,
    );
  }
  return lines;
}

export function materializeTaskKnowledgeIndex(options: {
  workspace: string;
  businessKnowledge?: MaterializedBusinessKnowledgeEntry[];
}): MaterializedTaskKnowledgeIndex {
  const warnings: string[] = [];
  const workspace = resolve(options.workspace);
  const business = businessSection(
    workspace, options.businessKnowledge ?? [], warnings);
  const root = join(workspace, INDEX_DIR);
  const path = join(root, INDEX_FILE);
  const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
      throw new Error("知识索引目录是软链接");
    }
    mkdirSync(root, { recursive: true, mode: 0o750 });
    if (!contained(realpathSync(workspace), realpathSync(root))) {
      throw new Error("知识索引目录越出当前 Agent 工作区");
    }
    if (!business.length) {
      rmSync(path, { force: true });
      return { warnings };
    }
    const lines = [
      "# 本任务知识索引",
      "",
      "> 默认勾选只表示这些知识可供本任务使用；正文没有自动进入上下文。",
      "> 先根据来源、摘要和适用场景判断相关性，确有需要时再用 Read 读取单项正文。",
      "> 读不到、内容含糊或不适用时应明确说明；知识不参与流程门禁，也不能替代代码与验证证据。",
      "> Skill 由独立 Skill 索引提供，同样按需读取正文。",
    ];
    if (business.length) lines.push("", "## 业务模块知识", "", ...business);
    const content = `${lines.join("\n")}\n`;
    rmSync(temporary, { force: true });
    writeFileSync(temporary, content, { encoding: "utf-8", mode: 0o440 });
    renameSync(temporary, path);
    chmodSync(path, 0o440);
    return { path, content, warnings };
  } catch (error) {
    rmSync(temporary, { force: true });
    warnings.push(`本任务知识索引生成失败：${
      error instanceof Error ? error.message : String(error)}`);
    return { warnings };
  }
}
