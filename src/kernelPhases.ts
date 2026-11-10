/**
 * 进度条的阶段词表只有一个来源:内核 `flow/phases.json`。
 *
 * 2026-09-02 用户点出"每个任务进度条都不一样、点阶段名弹黄字说不匹配":
 * 本仓曾自带两套阶段词表(进入持续检视后强行换成五段,没内核进度时再来
 * 七段),内核看板又是第三套;老任务停在哪套显示哪套,而"点阶段弹方案"
 * 按名字去内核方案词表里找,自然找不到、退底版告警。宪法说"连阶段→步骤
 * 的映射都不许在 TS 侧再抄一份",那就连阶段名也不抄:读内核的那份文件。
 *
 * 这里只读名字、顺序和占位角色;步骤归属由内核在脉冲里算好(pulse.phase),
 * 本仓永远不做 step→phase 的判断,也不写任何阶段字面量。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface KernelPhaseVocabulary {
  /** 进度条顺序。 */
  names: string[];
  /** 内核没脉冲时按任务状态占哪一段:名字由内核那份文件指定。 */
  placeholders: {
    queued: string;
    analysis: string;
    delivering: string;
    terminal: string;
  };
}

const cache = new Map<string, KernelPhaseVocabulary | undefined>();

/** 读一次即缓存:词表随内核版本走,进程内不会变。读不到或不成形返回
 * undefined,调用方按"没有词表"处理(不画进度条),不许自造名字顶上。 */
export function kernelPhases(
  kernelRoot: string | undefined,
): KernelPhaseVocabulary | undefined {
  if (!kernelRoot) return undefined;
  if (cache.has(kernelRoot)) return cache.get(kernelRoot);
  let vocabulary: KernelPhaseVocabulary | undefined;
  try {
    const document = JSON.parse(readFileSync(
      join(kernelRoot, "flow", "phases.json"), "utf-8"));
    if (document?.schema === "mae-flow-phases/1" && Array.isArray(document.phases)) {
      const names: string[] = document.phases
        .map((entry: any) => String(entry?.name ?? "").trim())
        .filter(Boolean);
      const raw = document.placeholders ?? {};
      const role = (key: string, fallbackIndex: number) => {
        const value = String(raw[key] ?? "").trim();
        return names.includes(value) ? value : names[fallbackIndex];
      };
      const last = names.length - 1;
      if (names.length >= 2 && new Set(names).size === names.length) {
        vocabulary = {
          names,
          placeholders: {
            queued: role("queued", 0),
            analysis: role("analysis", Math.min(1, last)),
            delivering: role("delivering", Math.min(2, last)),
            terminal: role("terminal", last),
          },
        };
      }
    }
  } catch {
    vocabulary = undefined;
  }
  cache.set(kernelRoot, vocabulary);
  return vocabulary;
}

/** 测试用:换内核快照后清缓存。 */
export function resetKernelPhasesCache(): void {
  cache.clear();
}
