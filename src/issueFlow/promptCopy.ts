/**
 * 提示词文案挂载器(ADR-0016):直接嵌进 AI 提示的自然语言,以 md 形式
 * 存于 assets/issue-prompts/,模块加载时整读一次(服务加载即挂载),
 * 按锚点取段、{{var}} 极简替换。
 *
 * 与 skills 挂载(materializeIssueSkills)同一纪律:文件缺失、锚点缺失、
 * 变量缺失、锚点重复都 fail-loud——文案是行为契约的载体,静默缺一段
 * 等于让 Agent 少一条规矩,宁可启动就炸。
 *
 * 分工边界(2026-09-03 拍板的分层,见 ADR-0016):
 * - 本目录只放"文案"——完整句/段的人话;阶段简报(goal/exit/tools)是
 *   阶段注册表的列,与工具门禁同源防漂移,不进这里;
 * - 工具 schema 的 description、举给用户的问题卡文案,不是 AI 提示词
 *   (后者是 UI 文案),留在代码;
 * - 与派发逻辑逐段拼装的修复回合(graded/mismatch/previousFailure),
 *   锚点化收益低,暂留代码(ADR-0016 记为已知未迁移)。
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 文案源目录:与 assets/issue-skills 平行的静态 md 目录。 */
export const PROMPT_SOURCE_DIR = resolve(
  fileURLToPath(import.meta.url), "..", "..", "..",
  "assets", "issue-prompts");

/** 文案文件(按消费方分类,命名即治理):opening=会话入口词,
 * notices=平台主动通知,receipts=工具回执。 */
const FILES = ["opening", "notices", "receipts", "briefs"] as const;
export type PromptFile = (typeof FILES)[number];

/** 模块加载即读:锚点 → 段文。key = "<file>.<anchor>"。 */
const sections = new Map<string, string>();
for (const file of FILES) {
  const path = join(PROMPT_SOURCE_DIR, `${file}.md`);
  const raw = readFileSync(path, "utf-8");
  let anchor: string | undefined;
  let body: string[] = [];
  const flush = () => {
    if (anchor === undefined) return;
    const key = `${file}.${anchor}`;
    if (sections.has(key)) {
      throw new Error(`提示词文案锚点重复: ${key}(源: ${path})`);
    }
    sections.set(key, body.join("\n").replace(/\n+$/,""));
  };
  for (const line of raw.split("\n")) {
    const header = /^##\s+(.+?)\s*$/.exec(line);
    if (header) {
      flush();
      anchor = header[1];
      body = [];
    } else if (anchor !== undefined) {
      body.push(line);
    }
    // 首个锚点之前的内容(许可的文件头注释/空白)忽略。
  }
  flush();
}

/** 取一段文案并做 {{var}} 替换。锚点缺席、变量缺席、替换后仍残留
 * {{…}} 都当场抛错——文案错配必须是显式失败,不能静默出门。 */
export function promptCopy(
  file: PromptFile,
  anchor: string,
  vars: Record<string, string | number> = {},
): string {
  const key = `${file}.${anchor}`;
  const text = sections.get(key);
  if (text === undefined) {
    throw new Error(`提示词文案锚点不存在: ${key}(源: ${PROMPT_SOURCE_DIR})`);
  }
  const resolved = text.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`提示词文案变量缺失: ${key} 需要 {{${name}}}`);
    }
    return String(value);
  });
  const leftover = /\{\{\w+\}\}/.exec(resolved);
  if (leftover) {
    throw new Error(`提示词文案替换后仍残留占位符: ${key} ${leftover[0]}`);
  }
  return resolved;
}

/** 测试与启动体检用:已挂载的锚点清单。 */
export function mountedPromptAnchors(): string[] {
  return [...sections.keys()];
}
