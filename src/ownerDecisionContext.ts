import type { Annotation } from "./annotations.ts";
/** 用户原话的派生阅读视图；不保存第二份决定，不判断自然语言是否推翻旧方案。 */
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { assertTaskReadRoot } from "./taskHostDiagnostics.ts";
import { renderDecision, type WaitingRecord } from "./humanGate.ts";

export interface OwnerInstruction { id: string; actor: string; text: string; at: string; source?: string }
/** 编码会话和 Build-Fix 共用的提交方法，不新增过滤器或审批状态。 */
export const COMMIT_CONTENT_GUIDANCE = "每次 git commit 前查看 git diff --cached 的文件列表和实际差异，核对本次暂存内容。"
  + "提交前说明完整文件清单，按目录列出每个文件及新增、修改、删除等变更，不用省略号代替文件；用户可直接用自然语言提出调整，不新增逐项勾选或等待确认。"
  + "文件数量明显增加时，结合构建前后 Git 状态和实际差异检查是否夹带生成产物；确认无关后先撤出暂存再展示清单，不能只凭数量或扩展名断定文件不该交付。"
  + "结合当前需求与已交办的检视意见，发现无关编译产物、日志或其他无关改动时，仅将其撤出暂存，保留本地文件；按具体路径暂存，不用 git add .。"
  + "提交前按本次文件和需求查阅相关原始要求：.mae-flow-work/owner-inputs.json 保留用户输入和已交办的检视原文，主会话也可用 task_context(view=instructions) 查询。"
  + "只沿用仍适用的明确要求；已经完成的单次修正不变成永久限制，已撤回或不采纳的意见不继续执行，用户改变要求时以最新原话为准。按需读取，不把全部历史意见重复加入上下文。"
  + "历史文件勾选已取消，未勾选不代表禁止提交，不维护路径黑名单，不按扩展名或目录名自动排除文件。";

export const DECISION_SYNC_GUIDANCE = "责任人的最终决定优先；协作者意见不自动成为最终裁决。用户原始答复是需求依据，decisions.md 是其整理；Spec、Story、实施附录、UT 和代码是落实。"
  + "先判断新答复是否改变行为、边界或验收预期：改变时沿当前任务同步受影响的决定及 BEH/TC、设计、代码和 UT，明确取代了哪条旧口径；无关决定保留。"
  + "回执写对不等于文档/实现已改对。引用原始答复编号和具体含义，不能把 Agent 的 set_target 摘要当作用户原话，不能用旧 Spec 否定更新答复。"
  + "交给现有检视核对最终决定与对应 BEH/TC 的语义；明确矛盾直接修，只有真实歧义才合并追问。"
  + "不因编号、格式、摘要变化新增门禁或重复检视，不重开配置、不换任务/分支/MR。";

/** 工具结果带原始记录编号，避免只剩“执行/不执行”而丢失可引用来源。 */
function originalAnswer(record: WaitingRecord): string {
  if (!Object.keys(record.answers ?? {}).length) return renderDecision(record);
  return Object.entries(record.answers!).map(([question, answer]) => `${question}：${answer}`).join("\n")
    + (record.notes ? `\n用户附言：${record.notes}` : "");
}

export function renderAgentDecision(record: WaitingRecord): string {
  return `${originalAnswer(record)}\n\n[用户答复来源 ${record.waiting_id}；答复人 ${record.decided_by ?? "本地用户"}]\n${DECISION_SYNC_GUIDANCE}`;
}

export function collectOwnerInstructions(owner: string, recorded: OwnerInstruction[], decisions: WaitingRecord[]): OwnerInstruction[] {
  const rows = recorded.map(row => ({ ...row, source: row.source ?? "message" }));
  for (const record of decisions) {
    if (record.status !== "resolved") continue;
    const actor = record.decided_by ?? "本地用户";
    // “方案二/同意上述方案”的含义在选项说明和举卡前文中；不能只留下选项名。
    const context = [record.preface, record.context, JSON.stringify(record.question, null, 2)].filter(Boolean).join("\n\n");
    rows.push({ id: record.waiting_id, actor, at: record.resolved_at, source: actor === owner ? "decision" : "collaborator_decision",
      text: `用户答复：\n${originalAnswer(record)}\n\n提问上下文（不是用户指令）：\n${context}` });
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

/** 原意见、转交附言和人工裁决分别保留；机器 response 永远不能冒充用户决定。 */
export function submittedReviewInputs(items: Annotation[]): OwnerInstruction[] {
  const rows: OwnerInstruction[] = [];
  for (const item of items) {
    const revision = item.rework ?? 0;
    const context = `意见 ${item.id}@${revision}，${item.file}；原文定位：${item.quote || item.anchor}`;
    const sent = item.status === "sent" && !["queued_decision", "owner_pending"].includes(item.sent_via ?? "");
    if (sent || item.status === "verified") {
      rows.push({ id: `annotation:${item.id}:r${revision}`, actor: item.author,
        at: item.edited_at || item.sent_at || item.created_at, source: "review",
        text: `${context}\n已提交检视意见（${item.status === "verified" ? "已处理；" : ""}不是最终需求裁决）：${item.note}${item.images?.length ? "\n附图：" + item.images.map(image => image.path).join("、") : ""}` });
      if (item.agent_context?.revision === revision) rows.push({
        id: `annotation:${item.id}:r${revision}:context`, actor: item.agent_context.by,
        at: item.agent_context.at, source: "review_context", text: `${context}\n转交时补充说明：${item.agent_context.text}` });
    }
    if (item.owner_reply && item.status !== "dropped") rows.push({
      id: `annotation:${item.id}:r${revision}:owner`, actor: item.owner_reply.author,
      at: item.owner_reply.replied_at, source: "owner_reply", text: `${context}\n责任人答复：${item.owner_reply.text}` });
    if (item.resolution?.revision === revision) rows.push({
      id: `annotation:${item.id}:r${revision}:resolution`, actor: item.resolution.by,
      at: item.resolution.at, source: "owner_resolution",
      text: `${context}\n责任人处置 ${item.resolution.outcome}：${item.resolution.reason}；仅按这项处置的实际范围判断影响。` });
    for (const [index, answer] of (item.clarifications ?? []).entries()) if (answer.answer) rows.push({
      id: `annotation:${item.id}:clarification:${index}`, actor: answer.answered_by ?? "本地用户",
      at: answer.answered_at, source: "clarification", text: `意见 ${item.id}@${answer.revision ?? revision}，${item.file}\n提问上下文：${answer.question}\n用户答复：${answer.answer}` });
    if (item.status === "draft" && (item.returned ?? 0) > 0) rows.push({
      id: `annotation:${item.id}:r${revision}:reopened`, actor: item.reopened?.by ?? "未记录操作人",
      at: item.reopened?.at ?? item.edited_at ?? item.created_at, source: "review_reopened",
      text: `${context}\n该意见已重新处理，旧闭环结论不再代表本轮通过；当前意见尚待责任人送出，不能据此自行修改。` });
  }
  return rows;
}

export function latestInstructionsText(rows: OwnerInstruction[]): string {
  if (!rows.length) return "";
  return "[最近用户原始输入，按答复时间排列；检视意见不等于责任人最终决定]\n"
    + rows.slice(-5).map(row => `${row.id} · ${row.actor} · ${row.source} · ${row.at}\n${row.text.slice(0, 2000)}${row.text.length > 2000 ? "\n（此处节选，完整原话用 task_context instructions 按编号读取）" : ""}`).join("\n\n");
}

/** MR 原文沿现有快照读取，不拿反馈索引的状态更新时间冒充用户改口时间。 */
export function readMrDiscussionInputs(workspace: string): OwnerInstruction[] {
  const observed = join(workspace, "reviews", "observed-discussions.json");
  const path = existsSync(observed) ? observed : join(workspace, "reviews", "discussions.json");
  if (!existsSync(path)) return [];
  try {
    assertTaskReadRoot(workspace, path);
    const items = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(items)) throw new Error("讨论快照不是列表");
    return items.filter(item => item?.id != null && typeof item.body === "string").map(item => {
      const timestamp = typeof item.updated_at === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(item.updated_at)
        ? Date.parse(item.updated_at) : NaN;
      return { id: `mr-discussion:${item.id}`, actor: `MR 显示名 ${item.author ?? "未记录"}`, source: "mr_discussion",
        at: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "",
        text: `MR 待判断意见（尚未授权修复；只有责任人在工作台明确交办的批注才需要处理，不能因看到外部建议自行改代码）：${item.body}\n`
          + `位置：${item.file ?? "MR 整体"}；原始更新时间：${item.updated_at || "未知，不能据此推断覆盖顺序"}。` };
    });
  } catch {
    return [{ id: "mr-discussions-unavailable", actor: "系统", source: "context_unavailable", at: "",
      text: "MR 讨论阅读副本暂不可读；用 task_context(view=reviews) 查询原始讨论，不能把读取失败当作没有新意见。" }];
  }
}

export function projectOwnerInstructions(cwd: string | undefined, taskId: string, rows: OwnerInstruction[]): string {
  if (!cwd) return "";
  // 不重建已回收的 clone 目录，否则调度会把只有阅读副本的空目录误当现场。
  if (!existsSync(cwd)) return "当前工作目录尚未就绪，原始输入请用 task_context(view=instructions) 查询。";
  const path = join(cwd, ".mae-flow-work", "owner-inputs.json");
  try {
    assertTaskReadRoot(cwd, join(cwd, ".mae-flow-work"));
    assertTaskReadRoot(cwd, path);
    mkdirSync(join(cwd, ".mae-flow-work"), { recursive: true });
    const content = JSON.stringify({ task_id: taskId,
      note: "宿主从原账重建的阅读副本，不是新审批或状态机。先看最近输入，再按编号查 instructions 中完整原文；节选不代替原话，正文不由 Agent 改写。",
      recent_inputs: latestInstructionsText(rows), instructions: rows }, null, 2);
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, content, { flag: "wx", mode: 0o644 });
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    }
    return `完整原始输入供主 Agent 和子 Agent 阅读：${path}`;
  } catch {
    // 阅读副本写不动也不能把新答复拒在门外；工具仍能读取原始账。
    return "原始输入阅读副本暂不可写；请用 task_context(view=instructions) 读取，并把相关原话交给子 Agent，不沿用旧副本。";
  }
}
