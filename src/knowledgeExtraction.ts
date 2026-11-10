/**
 * 定向知识提取(用户拍板 2026-09-01):同事说"参考那个仓某模块的做法"
 * ——把这句话变成一份可检视、可上架的 SKILL.md 草稿。
 *
 * 边界,设计期钉死:
 * - 提取是知识库侧的旁路能力,不建任务、不碰交付链;会话带硬预算,
 *   超时如实停,人可以再点;
 * - 产物只是**草稿**:回填到 Skill 提交表单由人编辑,上架仍走既有
 *   提交/审核闸(密钥扫描、装载器裁决都在那边);草稿本身也先过一遍
 *   密钥扫描——参考仓的代码里完全可能躺着带密钥的配置样例;
 * - 纪律文本是平台内置 skill(internal-skills/,不进团队货架,任务
 *   勾选不到),迭代它不用改代码。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTRACTION_TIMEOUT_MS = 10 * 60_000;

export type ExtractionJobStatus = "queued" | "running" | "done" | "failed";

export interface ExtractionJobRecord {
  id: string;
  status: ExtractionJobStatus;
  repo: string;
  intent: string;
  path_hint?: string;
  operator: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  /** 成功时的草稿与说明;失败时 error 是给人看的分类原因。 */
  draft?: string;
  notes?: string;
  error?: string;
  /** 草稿已提交到 Skill 库审查（"目录/提交号"）。制作任务到此结束，审查只在那条提交上做一次，
   * 不再在任务中心留两条"待审查"（D9：制作 Skill 只审一次）。 */
  submission_id?: string;
}

/** 内置提取 skill 正文。读不到按缺陷抛错——它是发布件的一部分,
 * 缺了说明打包坏了,静默用空纪律跑会产出没有闸的草稿。 */
export function extractionSkillText(): string {
  const path = join(dirname(fileURLToPath(import.meta.url)),
    "..", "internal-skills", "knowledge-extract", "SKILL.md");
  const text = readFileSync(path, "utf-8").trim();
  if (!text) throw new Error("内置提取 skill 为空,发布件损坏");
  return text;
}

export function buildExtractionMission(input: {
  repoLabel: string;
  intent: string;
  pathHint?: string;
  timeoutMinutes: number;
}): string {
  return [
    "你是知识提取会话。当前工作目录是参考仓的只读克隆(推送已在 git",
    "配置层禁用,不要尝试任何写远端操作;也不要修改仓内文件)。",
    "",
    `提取意图:${input.intent}`,
    input.pathHint
      ? `路径提示(工程师认为相关实现大概在这里,仅供起点,不必受限):${
        input.pathHint}`
      : "没有路径提示:先用检索定位与意图相关的实现,再深入阅读。",
    `参考仓:${input.repoLabel}`,
    `预算:${input.timeoutMinutes} 分钟,超时会被安全停止;把时间花在读`,
    "与意图直接相关的代码上。",
    "",
    "以下提取纪律必须逐条遵守:",
    "",
    extractionSkillText(),
  ].join("\n");
}

/** 提取草稿必须显式带标记；草稿直接回填编辑框，不能把模型闲聊混进正文。 */
export function parseExtractionDraft(
  text: string,
): { draft: string; notes: string } | undefined {
  const skillMatch = text.match(/===SKILL===\s*\n([\s\S]*?)\n\s*===NOTES===/);
  if (!skillMatch) return undefined;
  const notesMatch = text.match(/===NOTES===\s*\n([\s\S]*)$/);
  return {
    draft: skillMatch[1].trim(),
    notes: (notesMatch?.[1] ?? "").trim(),
  };
}

/** 任务现场留档:job.json 落在提取目录里,重启后仍可回答"这个 job
 * 后来怎么样了"。写失败不拦流程(内存态照常服务),只记日志。 */
export function persistExtractionJob(
  root: string,
  record: ExtractionJobRecord,
  log?: (message: string) => void,
): void {
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "job.json"),
      JSON.stringify(record, null, 2), { mode: 0o600 });
  } catch (error) {
    log?.(`知识提取 ${record.id} 留档失败(不拦流程): ${String(error)}`);
  }
}

export function readExtractionJob(
  root: string,
): ExtractionJobRecord | undefined {
  const path = join(root, "job.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}
