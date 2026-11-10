import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { prepareContainerWritableFile, repairContainerMutationOwnership } from "./containerOwnership.ts";

/** 仓外材料属于任务根，不能由 Agent 当前 cd 到哪里来决定。 */
export function taskAgentMaterialInstructions(workspace: string): string {
  return [
    "任务材料路径（以这些绝对路径为准，覆盖旧提示中的 ../ 相对写法；切换目录也不改变）：",
    `检视材料目录：${JSON.stringify(resolve(workspace, "reviews"))}`,
    `逐条检视回执：${JSON.stringify(resolve(workspace, "reviews", "local-receipts.json"))}`,
    `MR 逐条回复：${JSON.stringify(resolve(workspace, "review_replies.md"))}`,
    `流水线材料：${JSON.stringify(resolve(workspace, "pipeline"))}`,
    `Build-Fix 执行记录：${JSON.stringify(resolve(workspace, "prepush"))}`,
    "只处理本轮已派发的材料；不存在的材料不需创建。反馈批次 JSON 使用本批次单独给出的绝对回执路径。",
    "current 的反馈清单保留原始意见及来源 SHA，不是尚未处理条目的实时清单。不要仅因原意见仍列在其中就重复修改或复制回执。",
    "实际修改与本轮逐条回执完成后，按内核指引完成当前步骤并正常收口；宿主负责登记反馈结果、验证与推送后发布 MR 回复。回执落盘不等于已推送或作者已验收。",
  ].join("\n");
}

/** 只开放一份 MR 回复文件，不把宿主控制目录整体交给容器。 */
export function prepareReviewReplyFile(workspace: string, user?: string): string {
  const path = resolve(workspace, "review_replies.md");
  if (!existsSync(path)) writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("MR 回复目标必须是普通文件");
  prepareContainerWritableFile({ workspace, path, user });
  return path;
}

/** 宿主文件工具与容器 Bash 交替写入时，精确交接单文件，不 chown 任务根。 */
export function repairTaskAgentFileOwnership(input: {
  workspace: string; cwd: string; path: string; user?: string; feedbackResult?: string;
}): void {
  const path = resolve(input.cwd, input.path);
  const materials = [
    resolve(input.workspace, "reviews", "local-receipts.json"),
    resolve(input.workspace, "review_replies.md"),
    input.feedbackResult,
  ];
  if (materials.includes(path)) {
    prepareContainerWritableFile({ workspace: input.workspace, path, user: input.user });
  } else {
    repairContainerMutationOwnership({ workspace: input.cwd, path, user: input.user });
  }
}
