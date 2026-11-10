/**
 * Agent 在开发中提议拆分(docs/delivery-unit-split-design.md 2026-09-03
 * 勘误):拆不拆是分析的产物,不是下单时的开关——下单的人在信息最少的
 * 时刻判断"大不大"判不准,读完仓的 Agent 才判得准。
 *
 * 工具只做一件事:把"为什么需要拆分、建议怎么切"交给宿主;宿主
 * 受理后终止当前会话,把本单转成分析拆分单重新启动(澄清→盘点→划分
 * 方向卡→方案→人工确认→按单元建子任务)。受理与拒绝都用一句人话回给
 * 模型,拒绝不抛错。
 */

import { DELIVERY_SPLIT_GUIDANCE } from "./deliverySplitGuidance.ts";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface SplitProposalInput {
  reason: string;
  suggested_units?: string[];
}

export function createSplitProposalTool(
  onPropose: (input: SplitProposalInput, toolCallId: string) => Promise<string> | string,
) {
  return defineTool({
    name: "propose_split",
    label: "Propose Split",
    description:
      "本单是单仓直接开发任务。若用户已明确要求按功能模块拆分，读仓确认边界后也应使用此工具提出方案。你在澄清需求或定规格阶段读完仓、盘出改动面后,"
      + "如果存在可独立交付的功能边界，或大前置会让多个下游长期等待，且拆分收益大于协调与集成成本，用它把本单转为「先分析再拆分」:"
      + "平台会终止当前会话,以只读分析现场重新启动,走澄清→改动面盘点→划分"
      + "方向卡→拆分方案→人工确认,再按交付单元生成子任务。拆不拆由责任人"
      + "在决定卡上拍板:选「不拆」你就按一个任务继续,不要再提议。调用前不要"
      + "开始改代码;已有推送或 MR 的任务不能再转。",
    promptSnippet: "propose_split:用户要求按模块交付或改动面过大时，提议转为先分析再拆分",
    promptGuidelines: [
      DELIVERY_SPLIT_GUIDANCE,
      "用户明确要求按功能模块分别交付时，优先落实这一要求；不要用改动文件少或单仓为由忽略拆分意图。仍由责任人确认具体边界。",
      "澄清需求或定规格阶段读完仓、盘出改动面后，确认独立交付或提前释放下游的收益，再在写代码之前调用 propose_split；受理后"
      + "立即结束本轮发言,不要再调用任何工具。",
    ],
    parameters: Type.Object({
      reason: Type.String({
        description: "为什么该拆：说明用户交付要求、功能边界、改动面和依赖，给出可独立验证的单元" }),
      suggested_units: Type.Optional(Type.Array(Type.String(), {
        description: "建议的切法，每项说明完整交付目标；优先识别下游真正需要的最小前置，不追求最多任务；拿不准可以不给" })),
    }),
    async execute(toolCallId: string, params: any) {
      // 会话挂起点:受理后宿主举卡,人拍板前 pi 停在这里(同 AskUserQuestion)。
      const text = await onPropose({
        reason: String(params.reason ?? ""),
        suggested_units: Array.isArray(params.suggested_units)
          ? params.suggested_units.map((item: unknown) => String(item)) : undefined,
      }, toolCallId);
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });
}
