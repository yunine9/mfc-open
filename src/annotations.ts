import type { ExternalReviewSource } from "./externalReviewInbox.ts";
/**
 * 检视批注:在材料上圈出问题,攒成模型一次就能落地的清单。
 *
 * 为什么值得做(内核 panel/annotate.py 的原话,这里同理):检视的瓶颈
 * 从来不是发现问题,是把"哪一行、要改成什么"准确传达出去。口述"那个
 * 短信处理器里重试那块"要模型猜三轮;`sms_handler.py:23` 加一句意见
 * 它一次就到位。批注的本质是把人脑里那个**指向**,压成
 * **坐标 + 原文快照 + 要求** 三元组。
 *
 * 与内核面板那套的区别,全在约束上:面板是 file:// 单文件 HTML,不能
 * 写文件,所以只能剪贴板 + localStorage;我们有服务端、有会话、有插话
 * 通道,该继承的是它的语义(尤其"以原文为准定位"和那四条护栏),不是
 * 它的实现。照抄"复制给 Agent"等于把别人的枷锁搬到没有枷锁的地方。
 *
 * 落盘用 append-only 的 jsonl:多人同圈一份文档时,就地覆盖的
 * last-write-wins 会静默吃掉别人写的字。改自己的用新增+软删。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { pendingReviewAnnotation } from "./annotationPending.ts";
import { isReviewAssetPath } from "./reviewAssets.ts";
import { annotationDiffLines } from "./annotationDiffLines.ts";

/**
 * 需求原文来自任务快照，不是 .mae-flow-work 下的真实产物。批注仍需一个
 * 稳定锚点标识，前后端用这个保留值识别它，不能把它混进产物清单。
 */
export const TASK_REQUIREMENT_ARTIFACT = "__task_requirement__";

/** 模块拆分图不是磁盘文档，却同样需要进入统一批注账。artifact 使用稳定
 * 虚拟标识，anchor 则记录方案整体、模块 id 或依赖边；服务端会从当前
 * requirement_graph 机械还原可重锚定文本。这样图上意见不必硬挂到
 * CHAIN 文档某一行，也不用另造一套“图评论”状态机。 */
export const REQUIREMENT_GRAPH_ARTIFACT = "__requirement_graph__";

export type AnnotationKind = "doc" | "code";
/** 一条检视意见首先是在找谁做下一步，不是天然都在命令 Agent。旧账
 * 没有 route，读侧一律按 agent 解释，避免升级后改变历史任务语义。 */
export type AnnotationRoute = "agent" | "owner_reply" | "owner_decision"
  /** 记为记忆:不发给任何人、不进决定卡,圈选即闭环,直接落一条任务记忆
   * (docs/knowledge-memory-design.md §4.1)。空口一句缺的就是引文和位置,
   * 圈选把这两样自动补齐。 */
  | "memory";
/** verified = 人看过改动、点了"确认通过"——这是人的判断,不是系统推断,
 * 所以它只能由按钮产生,永远不会被重锚定自动打上。 */
export type AnnotationStatus = "draft" | "sent" | "verified" | "dropped";
export type SentVia =
  | "overall_story_queue" | "overall_story_processing" | "overall_story"
  | "requirement_review"
  | "requirement_queue"
  | "interrupt"
  | "decision"
  | "pipeline_evidence"
  /** MR 已创建后的本地检视：进入当前 MR 的持续修复环。 */
  | "review_repair"
  /** “责任人答复 / 决策后处理”已送到责任人，尚未交给 Agent。 */
  | "owner_pending"
  /** 任务正等人决定时提交:先成为团队事实(阻塞放行),正文随下一次
   * 决定的 continuation 送达 Agent。检视人不必等任务恰好 running
   * (MFC-022:曾经这窗口里没有任何合法提交路径)。 */
  | "queued_decision"
  /** 问题域的检视提交(ADR-0007):意见清单随整体回退注入新一轮
   * 问题分析。存储/锚点/重锚定与需求流同一套,只有通道不同。 */
  | "issue_review";

/** Agent 对一条已提交意见的结构化回执。它只陈述 Agent 做了什么，
 * 不能代替意见作者的 verify：response 是机器事实，verified 是人的判断。 */
export interface AnnotationResponse {
  /** 同一条意见返工后 revision 递增，旧回执仍留在 JSONL 审计账里。 */
  revision: number;
  outcome: "fixed" | "not_fixed" | "needs_clarification";
  summary: string;
  evidence: string[];
  /** 回执对应的本地提交；没有代码仓的纯文档任务可以缺席。 */
  fixed_sha?: string;
  responded_at: string;
}

/** 责任人的原话单独记账。它不是 Agent 回执，也不能被页面混写成
 * “Agent 已处理”；decision 类型会把这段原话作为后续实现依据送给 Agent。 */
export interface AnnotationOwnerReply {
  author: string;
  text: string;
  replied_at: string;
}

export interface AnnotationResolution {
  revision: number;
  outcome: "fixed" | "not_adopted" | "deferred" | "accepted_risk";
  reason: string;
  by: string;
  at: string;
}

export interface Annotation {
  external_review?: ExternalReviewSource;
  id: string;
  author: string;
  created_at: string;
  /** 圈在哪份产物上——重锚定回头读的就是它。 */
  artifact: string;
  /** 给模型看的真实路径(代码批注是源文件路径,文档批注同产物名)。 */
  file: string;
  /** 收到材料时的行号。模型一改就会偏移,所以它只是辅助,不是依据。 */
  line: number;
  /** 原文快照——定位以它为准。内核那条经验在活靶子上更要紧。 */
  anchor: string;
  context_before?: string;
  context_after?: string;
  /** 划选一块时的整块原文(≤ ANNOTATION_QUOTE_MAX):给人和模型看语境,
   * 不参与定位;按行点的没有。 */
  quote?: string;
  /** 划选跨行时的末行;单行圈注没有。 */
  line_end?: number;
  note: string;
  /** 意见号(#261,ADR-0025,可选):问题域检视意见在单个问题控制台内
   * 的展示编号,自 1 单调递增、永不复用(软删也不回收)、跨批次连续,
   * 展示与 AI 引用统一用它。分配口径在调用方(问题域 reviews.ts),这里
   * 只透传落账;需求流不传号——缺席即无号,形状语义不变。台账另持有
   * an- 前缀 id(上面),它是对内连接键,不对外展示。 */
  seq?: number;
  /** 批注附图(给 Agent 看的截图/设计稿):工作区相对路径,Agent 用
   * inspect_image 读。图先经 /annotation-assets 落盘,这里只记引用。 */
  images?: Array<{ path: string; label?: string }>;
  /** 最近一次修改意见的时间。修改留在 append-only 台账里，不覆盖旧记录。 */
  edited_at?: string;
  kind: AnnotationKind;
  /** 缺省 = agent，用于兼容上线前的 annotations.jsonl。 */
  route?: AnnotationRoute;
  /** 非 agent 意见的责任人账号，由任务服务端按当前任务责任人固定。 */
  assignee?: string;
  status: AnnotationStatus;
  sent_at?: string;
  sent_via?: SentVia;
  /** 谁把草稿正式送入处理流程。与 author 分开：责任人可以原样转交
   * 他人的意见，但不能因此变成作者或取得最终裁决权。 */
  sent_by?: string;
  /** Agent 对当前 rework revision 的逐条回应。 */
  response?: AnnotationResponse;
  owner_reply?: AnnotationOwnerReply;
  /** 一旦交给 Agent 即保留，重新打开也不能删除已经进入处理流程的意见。 */
  agent_assigned?: boolean;
  /** 转交时责任人的补充说明，与原意见分开保存。 */
  agent_context?: { text: string; by: string; at: string; revision: number };
  verified_at?: string;
  resolution?: AnnotationResolution;
  /** 已提交后修改或撤回表达，仍须责任人逐条处置。 */
  needs_owner_closure?: boolean;
  withdrawal_requested?: { by: string; at: string };
  /** 实际确认者；旧作者本人确认记录可缺席，新责任人处置总是填写。 */
  verified_by?: string;
  /** 这条意见正文的版本号(0 = 首版):人退回返工、或作者改字重提都
   * 会加一。Agent 回执必须带同一个 revision 才算数——旧版本的回执不能
   * 背书新文字(2026-09-05:改字曾不加版本,盘上残留的旧 fixed 回执
   * 会被下一次读取当成新文字已处理)。"第几次返工"看 returned。 */
  rework?: number;
  /** 人点过几次"仍需调整"(0/缺省 = 没退回过)。只用于人话与提示——
   * 作者补充说明重提不算返工,不能把它说成"上一轮改坏了"。 */
  returned?: number;
  /** 从既有 reopen 事件投影，避免恢复时把重新处理误排到意见创建时。 */
  reopened?: { at: string; by?: string };
  /** 返工时锚点若已失效,这里存上一轮针对的原文——给模型看历史。 */
  anchor_was?: string;
  /** Agent 问过什么(needs_clarification 的回执),作者改字重提时留档:
   * 渲染给模型看,免得它把补充说明当新意见、再问一遍同一件事
   * (内网实锤:两条意见来回问了几轮重复的问题)。
   * 带 answer 的一条是人在澄清卡上直接答的:回执随之清空,Agent 要按
   * 答复继续并重新写回执;revision 记它属于哪一版正文,用来限次追问。 */
  clarifications?: Array<{
    question: string;
    asked_at: string;
    answered_at: string;
    answer?: string;
    answered_by?: string;
    revision?: number;
  }>;
  /** 作者在意见处对 Agent 回应的逐条回复(问题域检视回复环,ADR-0035):
   * 每条快照它所回应的那份回执(回执随之清空,最新回应只在 response),
   * 按序排列即「Agent 回复 → 作者回复 → …」的完整线程;意见正文不动、
   * revision 不变,Agent 须按回复重新 respond(同 revision)。 */
  author_replies?: Array<{
    text: string;
    replied_at: string;
    by?: string;
    revision: number;
    /** 被回应的那份回执:清空后只有这里还能看到它。 */
    response: AnnotationResponse;
  }>;
}

export interface AnnotationInput {
  external_review?: ExternalReviewSource;
  author: string;
  artifact: string;
  file: string;
  line: number;
  anchor: string;
  context_before?: string;
  context_after?: string;
  note: string;
  kind: AnnotationKind;
  /** 意见号透传(见 Annotation.seq):分配在调用方,store 只落账。 */
  seq?: number;
  route?: AnnotationRoute;
  assignee?: string;
  quote?: string;
  line_end?: number;
  images?: Array<{ path: string; label?: string }>;
}

/** 整块原文上限,与前端 QUOTE_MAX 同值(两边各自截,不互信)。 */
export const ANNOTATION_QUOTE_MAX = 1500;

type Operation =
  | { op: "relocate_ticket"; old_ticket: string; ticket: string; by: string; at: string }
  | { op: "add"; record: Annotation }
  | { op: "edit"; id: string; note: string; at: string; by?: string; owner_controlled?: boolean }
  | { op: "owner_resolution"; id: string; resolution: AnnotationResolution }
  | { op: "withdraw_request"; id: string; by: string; at: string }
  /** by 缺席 = 作者本人(老账);带 by = 管理员代闭环,审计凭它。 */
  | { op: "drop"; id: string; by?: string }
  | { op: "sent"; ids: string[]; via: SentVia; at: string; by?: string }
  | { op: "respond"; id: string; response: AnnotationResponse }
  | { op: "agent_context"; id: string; by: string; at: string; text: string }
  | { op: "route_agent"; id: string; by: string; at: string; context?: string }
  /** via 只在责任人直接接住 draft 并答复时出现，使“接收 + 答复”成为
   * 一条原子台账操作；旧记录缺少 via 时仍按原语义回放。 */
  | { op: "owner_reply"; id: string; reply: AnnotationOwnerReply;
      via?: "owner_pending" }
  | { op: "verify"; id: string; at: string; by?: string }
  | { op: "reopen"; id: string; at: string; by?: string; owner_controlled?: boolean;
      line?: number; anchor?: string; note?: string }
  | { op: "delivery_reset"; id: string; at: string; reason: string }
  /** 人在澄清卡上答了 Agent 的追问:追问留档带答复,回执清空等新回执。 */
  | { op: "clarified"; id: string; answer: string; at: string; by?: string }
  /** 作者在意见处回复了 Agent 的回应:回复留档快照所回应的回执,
   * 回执清空等 Agent 按回复重新回应(问题域检视回复环,ADR-0035)。 */
  | { op: "author_reply"; id: string; text: string; at: string; by?: string };

/** 台账的原始操作(只读暴露给会话流投影:回执/退回/确认各自落账的时刻
 * 只在操作上,回放后的记录只剩"最终状态")。 */
export type AnnotationOperation = Operation;

export class AnnotationError extends Error {}
export class AnnotationPermissionError extends AnnotationError {}
export class AnnotationConflictError extends AnnotationError {}

/** 锚点还在不在:送出前问一次,答案摊给人看,不替人决定。 */
export type AnchorState = "hit" | "moved" | "gone" | "ambiguous";

export interface AnchorCheck {
  id: string;
  state: AnchorState;
  /** hit/moved/ambiguous 时的当前行号(1 起)。 */
  line?: number;
  /** 完整划选原文仍在时，当前选区末行；不能只平移旧选区的长度。 */
  line_end?: number;
  /** 旁路放行不等于位置已验证；前端不得拿历史行号强行跳转。 */
  location_verified?: boolean;
  /** 靶子已变时的现状原文,让人自己判断这条还要不要送。 */
  now?: string;
}

export class AnnotationStore {
  constructor(readonly path: string, private readonly ownerControlled = false,
    private readonly onChanged?: () => void) {}

  /** 仅迁移文档位置，不改意见正文、修订号和闭环状态。旧路径保留在追加账中。 */
  relocateTicketArtifacts(oldTicket: string, ticket: string, by: string): void {
    if (!this.list().some(item => [item.artifact, item.file].some(path =>
      path.includes(`.mae-flow-work/${oldTicket}/`) || path.startsWith(`${oldTicket}/`)))) return;
    this.append({ op: "relocate_ticket", old_ticket: oldTicket, ticket, by, at: new Date().toISOString() });
  }

  /** 回放得到当前状态。中段坏行跳过不炸整页(旁路 fail-open,大声
 *  记账);断写尾巴由读口自愈——崩溃半行不再吞掉下一次追加的账。 */
  list(): Annotation[] {
    if (!existsSync(this.path)) return [];
    return this.replay(readAppendOnlyJsonl<Operation>(this.path,
      { middleCorrupt: "skip" }));
  }

  /** 演示副本只读取当前字节，不能修复原账本的坏尾或缺失换行。 */
  snapshot(): { items: Annotation[]; history: AnnotationOperation[]; skipped: number } {
    if (!existsSync(this.path)) return { items: [], history: [], skipped: 0 };
    const history: AnnotationOperation[] = [];
    let skipped = 0;
    for (const line of readFileSync(this.path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const operation = JSON.parse(line) as AnnotationOperation;
        if (!operation || typeof operation !== "object" || !("op" in operation)) {
          skipped += 1;
        } else history.push(operation);
      } catch { skipped += 1; }
    }
    return { items: this.replay(structuredClone(history)), history, skipped };
  }

  private replay(operations: readonly Operation[]): Annotation[] {
    const byId = new Map<string, Annotation>();
    for (const operation of operations) {
      if (operation.op === "add" && operation.record?.id) {
        byId.set(operation.record.id, operation.record);
        continue;
      }
      if (operation.op === "agent_context") {
        const found = byId.get(operation.id);
        if (found) found.agent_context = operation.text ? { text: operation.text, by: operation.by, at: operation.at, revision: found.rework ?? 0 } : undefined;
        continue;
      }
      if (operation.op === "route_agent") {
        const found = byId.get(operation.id);
        if (found) { found.route = "agent"; found.status = "draft"; found.agent_assigned = true; found.needs_owner_closure = true;
          if (operation.context) found.agent_context = { text: operation.context, by: operation.by, at: operation.at, revision: found.rework ?? 0 }; }
        continue;
      }
      if (operation.op === "relocate_ticket") {
        for (const found of byId.values()) {
          for (const key of ["artifact", "file"] as const) {
            found[key] = found[key].replace(`.mae-flow-work/${operation.old_ticket}/`, `.mae-flow-work/${operation.ticket}/`);
            if (found[key].startsWith(`${operation.old_ticket}/`)) found[key] = operation.ticket + found[key].slice(operation.old_ticket.length);
          }
        }
        continue;
      }
      if (operation.op === "owner_resolution") {
        const found = byId.get(operation.id);
        if (found && (found.rework ?? 0) === operation.resolution.revision) {
          found.status = "verified";
          found.resolution = operation.resolution;
          found.verified_by = operation.resolution.by;
          found.verified_at = operation.resolution.at;
          found.needs_owner_closure = false;
        }
        continue;
      }
      if (operation.op === "withdraw_request") {
        const found = byId.get(operation.id);
        if (found && !["verified", "dropped"].includes(found.status)) {
          found.withdrawal_requested = { by: operation.by, at: operation.at };
          found.needs_owner_closure = true;
        }
        continue;
      }
      if (operation.op === "drop") {
        const found = byId.get(operation.id);
        if (found) found.status = "dropped";
        continue;
      }
      if (operation.op === "edit") {
        const found = byId.get(operation.id);
        if (!found || found.status === "dropped") continue;
        found.note = operation.note;
        found.edited_at = operation.at;
        // 已送出的意见一旦改字，就不能继续冒充“这版已提交”。退回草稿，
        // 由责任人重新送出；旧内容和送出记录仍完整保留在 jsonl 中。
        if (found.status !== "draft" || found.needs_owner_closure) {
          if (operation.owner_controlled) found.needs_owner_closure = true;
          found.resolution = undefined;
          found.withdrawal_requested = undefined;
          // 改字就是新版本:盘上残留的旧回执(同 id、旧 revision)不能再
          // 被读成"新文字已处理"。返工次数(returned)不动——这不是退回。
          found.rework = (found.rework ?? 0) + 1;
          // Agent 的追问不能随回执一起抹掉:它是作者这次改字的由头,下一轮
          // 要原样给模型看。
          if (found.response?.outcome === "needs_clarification") {
            found.clarifications = [...(found.clarifications ?? []), {
              question: found.response.summary,
              asked_at: found.response.responded_at,
              answered_at: operation.at,
            }];
          }
          found.status = "draft";
          found.sent_at = undefined;
          found.sent_via = undefined;
          found.sent_by = undefined;
          found.response = undefined;
          found.owner_reply = undefined;
          found.verified_at = undefined;
          found.verified_by = undefined;
        }
        continue;
      }
      if (operation.op === "sent") {
        for (const id of operation.ids ?? []) {
          const found = byId.get(id);
          if (!found || found.resolution) continue;
          found.status = "sent";
          found.sent_at = operation.at;
          found.sent_via = operation.via;
          if (operation.via !== "owner_pending") found.agent_assigned = true;
          if (operation.by) found.sent_by = operation.by;
        }
        continue;
      }
      if (operation.op === "respond") {
        const found = byId.get(operation.id);
        if (!found || found.resolution || found.status === "draft" || found.status === "dropped") {
          continue;
        }
        // 晚到的旧轮回执不能覆盖新一轮返工。revision=0 兼容首轮。
        if (operation.response.revision === (found.rework ?? 0)) {
          found.response = operation.response;
        }
        continue;
      }
      if (operation.op === "owner_reply") {
        const found = byId.get(operation.id);
        if (!found || found.status === "dropped" || found.status === "verified") {
          continue;
        }
        if (found.status === "draft" && operation.via === "owner_pending") {
          found.status = "sent";
          found.sent_at = operation.reply.replied_at;
          found.sent_via = operation.via;
          found.sent_by = operation.reply.author;
        }
        if (found.status !== "sent") continue;
        found.owner_reply = operation.reply;
        continue;
      }
      if (operation.op === "verify") {
        const found = byId.get(operation.id);
        if (found) {
          found.status = "verified";
          found.verified_at = operation.at;
          found.verified_by = operation.by;
        }
        continue;
      }
      if (operation.op === "clarified") {
        const found = byId.get(operation.id);
        // 只对"当前版本正等补充说明"的意见成立;作者已改字重提(版本变了)
        // 或 Agent 已另写回执时,这份答复只是迟到的历史,不改状态。
        if (!found || found.status !== "sent"
            || found.response?.outcome !== "needs_clarification"
            || found.response.revision !== (found.rework ?? 0)) {
          continue;
        }
        found.clarifications = [...(found.clarifications ?? []), {
          question: found.response.summary,
          asked_at: found.response.responded_at,
          answered_at: operation.at,
          answer: operation.answer,
          ...(operation.by ? { answered_by: operation.by } : {}),
          revision: found.rework ?? 0,
        }];
        found.response = undefined;
        continue;
      }
      if (operation.op === "author_reply") {
        const found = byId.get(operation.id);
        // 只对"当前版本有回执可回"的意见成立:回执已被上一条回复清空
        // (等 Agent 重新回应)或版本已变时,这份回复是迟到的历史,不改状态。
        if (!found || found.status !== "sent"
            || !found.response
            || found.response.revision !== (found.rework ?? 0)) {
          continue;
        }
        found.author_replies = [...(found.author_replies ?? []), {
          text: operation.text,
          replied_at: operation.at,
          ...(operation.by ? { by: operation.by } : {}),
          revision: found.rework ?? 0,
          response: found.response,
        }];
        found.response = undefined;
        continue;
      }
      if (operation.op === "reopen" || operation.op === "delivery_reset") {
        const found = byId.get(operation.id);
        if (!found) continue;
        found.resolution = undefined;
        found.withdrawal_requested = undefined;
        // 新一轮或系统确认未完成的交接，均恢复责任人的编辑/删除能力。
        found.agent_assigned = undefined;
        if (operation.op === "reopen") {
          found.reopened = { at: operation.at, by: operation.by ?? found.author };
          // 重新处理开启新一轮；上一轮的送达事实留在事件历史，不能锁住新草稿。
          found.agent_context = undefined;
          if (operation.owner_controlled) found.needs_owner_closure = true;
        }
        found.status = "draft";
        found.rework = (found.rework ?? 0) + 1;
        if (operation.op === "reopen") found.returned = (found.returned ?? 0) + 1;
        found.sent_at = undefined;
        found.sent_via = undefined;
        found.sent_by = undefined;
        found.response = undefined;
        found.owner_reply = undefined;
        found.verified_at = undefined;
        found.verified_by = undefined;
        if (operation.op === "delivery_reset") continue;
        if (operation.anchor && operation.anchor !== found.anchor) {
          found.anchor_was = found.anchor;
          found.anchor = operation.anchor;
        }
        if (operation.line) found.line = operation.line;
        if (operation.note) found.note = operation.note;
      }
    }
    // 需求侧旧现场中，返工/改字后的 draft 已经是团队意见，不能通过
    // 删除草稿绕过责任人；只补读侧事实，保留旧账与 Issue 侧原有语义。
    return [...byId.values()].map((item) => this.ownerControlled
      && item.status === "draft" && (item.rework ?? 0) > 0
      && item.needs_owner_closure === undefined
      ? { ...item, needs_owner_closure: true } : item);
  }

  /** 原始操作按落账顺序(坏行跳过)。它是给投影读时刻用的,业务状态一律
   * 走 list() 的回放结论——两处口径分家就会出现"流里说已确认、面板说还等"。 */
  history(): AnnotationOperation[] {
    if (!existsSync(this.path)) return [];
    return readAppendOnlyJsonl<AnnotationOperation>(this.path,
      { middleCorrupt: "skip" })
      .filter((operation) =>
        operation && typeof operation === "object" && "op" in operation);
  }

  /** 尚未提交的原始草稿；决定发送应使用 pendingReview，包含责任人队列。 */
  drafts(): Annotation[] {
    return this.list().filter((item) => item.status === "draft");
  }

  pendingReview(): Annotation[] {
    return this.list().filter(pendingReviewAnnotation);
  }

  /** 页面要看的:草稿 + 已送出。软删的不再露面(留在文件里可查)。
   * 送出后不消失是刻意的——人得看得见"这条提过没有、现在什么进展"。 */
  visible(): Annotation[] {
    return this.list().filter((item) => item.status !== "dropped");
  }

  add(input: AnnotationInput): Annotation {
    const note = String(input.note ?? "").trim();
    // 记为记忆可以不写一句话:圈的那段原文本身就是要记的东西(用户拍板,
    // "必须像批注一样输入想法"是多余负担)。交给人的意见仍必须有内容。
    if (!note && input.route !== "memory") throw new AnnotationError("批注内容不能为空");
    const anchor = String(input.anchor ?? "").trim();
    if (!anchor) throw new AnnotationError("缺少原文快照,批注无从定位");
    const artifact = String(input.artifact ?? "").trim();
    if (!artifact) throw new AnnotationError("缺少产物名");
    const line = Number.isFinite(input.line) ? Math.max(0, Math.trunc(input.line)) : 0;
    const quote = String(input.quote ?? "").trim();
    const lineEnd = Number.isFinite(input.line_end)
      ? Math.trunc(input.line_end as number) : 0;
    // 附图只认资产模块产出的路径形状:别的路径 Agent 读不到,也可能越界。
    const images = (input.images ?? []).map((image) => ({
      path: String(image?.path ?? "").trim(),
      ...(String(image?.label ?? "").trim() ? { label: String(image.label).trim().slice(0, 80) } : {}),
    })).filter((image) => image.path);
    for (const image of images) {
      if (!isReviewAssetPath(image.path)) {
        throw new AnnotationError(`附图路径不合法:${image.path}(须先上传为检视图片资产)`);
      }
    }
    if (images.length > 6) throw new AnnotationError("一条批注最多带 6 张图");
    const record: Annotation = {
      id: `an-${Date.now().toString(36)}-${this.list().length + 1}`,
      author: String(input.author ?? "").trim() || "未署名",
      created_at: new Date().toISOString(),
      artifact,
      ...(input.external_review ? { external_review: input.external_review } : {}),
      file: String(input.file ?? "").trim() || artifact,
      line,
      anchor,
      ...(input.context_before ? { context_before: String(input.context_before).slice(-1200) } : {}),
      ...(input.context_after ? { context_after: String(input.context_after).slice(0, 1200) } : {}),
      ...(quote ? { quote: quote.length > ANNOTATION_QUOTE_MAX
        ? quote.slice(0, ANNOTATION_QUOTE_MAX) + "…" : quote } : {}),
      ...(lineEnd > line ? { line_end: lineEnd } : {}),
      note,
      // 意见号只透传不分配:谁发号(问题域 reviews.ts 的单调口径)与
      // 存储解耦,需求流不传号就保持旧形状。
      ...(input.seq !== undefined && Number.isFinite(input.seq)
        ? { seq: Math.max(1, Math.trunc(input.seq)) } : {}),
      ...(images.length ? { images } : {}),
      kind: input.kind === "code" ? "code" : "doc",
      ...(input.route && input.route !== "agent" ? { route: input.route } : {}),
      ...(input.assignee?.trim() ? { assignee: input.assignee.trim() } : {}),
      // 记忆条目没有"送出/回执/确认"这几站:人圈的那一下就是闭环。
      ...(input.route === "memory"
        ? { status: "verified" as const, verified_at: new Date().toISOString() }
        : { status: "draft" as const }),
    };
    this.append({ op: "add", record });
    return record;
  }

  /** 软删:多人环境里硬删等于替别人做主,留痕才查得清。
   *
   * 已送出的也允许移除。原来禁止,理由是"送出去撤不回来"——话没错,
   * 但清单是人自己的看板:提过二十条之后满屏都是已完成的旧条目,
   * 反而看不见当前要紧的那几条。移除只是从看板上拿掉,jsonl 里留痕
   * 照查;界面上因此把措辞分开说,别让人误以为能撤回。 */
  drop(id: string, by: string, override = false): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by && !override) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,不能替他删`);
    }
    // override = 管理员出路:作者不在场时,一条未闭环批注会把整单的
    // 推送永远锁死(2026-08-30 审计)。代删必须留痕(op.by),不是撤销
    // "谁的意见谁裁决"——那仍是默认规则,这里只是给死锁开的有账可查
    // 的门。
    this.append(found.author !== by
      ? { op: "drop", id, by } : { op: "drop", id });
    return { ...found, status: "dropped" };
  }

  /** 普通调用只认作者；责任人模式由服务层核验后允许修改，原文保留在事件历史。
   * 已提交/已确认的意见修改后退回待提交，
   * 避免清单显示的是新文字，Agent 实际收到的却还是旧文字。 */
  edit(id: string, note: string, by: string, ownerControlled = false): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by && !ownerControlled) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,不能替他改`);
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    const normalized = String(note ?? "").trim();
    if (!normalized) throw new AnnotationError("批注内容不能为空");
    const at = new Date().toISOString();
    this.append({ op: "edit", id, note: normalized, at, by, owner_controlled: ownerControlled });
    return this.list().find((item) => item.id === id)!;
  }

  markSent(ids: string[], via: SentVia, by?: string): void {
    if (!ids.length) return;
    this.append({ op: "sent", ids, via, at: new Date().toISOString(), by });
  }

  /** 异步发送/执行只登记实际处理的那版。期间退回、改字或闭环的意见保留现状。 */
  markSentFor(snapshot: readonly Annotation[], via: SentVia, by?: string): string[] {
    const current = new Map(this.list().map((item) => [item.id, item]));
    const ids = snapshot.filter((item) => {
      const latest = current.get(item.id);
      return latest && !latest.resolution && ["draft", "sent"].includes(latest.status)
        && (latest.rework ?? 0) === (item.rework ?? 0) && latest.note === item.note;
    }).map((item) => item.id);
    this.markSent(ids, via, by);
    return ids;
  }

  /** 系统处理失败或重启恢复，不代表作者否定结果；只更新回执版本。 */
  resetRequirementDelivery(id: string, reason: string): void {
    const found = this.list().find((item) => item.id === id);
    if (!found || found.status !== "sent"
        || !["requirement_queue", "requirement_review", "overall_story_queue", "overall_story_processing"].includes(found.sent_via ?? "")) return;
    this.append({ op: "delivery_reset", id, at: new Date().toISOString(), reason });
  }

  /** 异步交接失败：只释放仍停在原版草稿的预登记，不回滚已排队/已送达记录。 */
  resetUnsentAssignments(snapshot: readonly Annotation[]): void {
    const current = new Map(this.list().map(item => [item.id, item]));
    for (const before of snapshot) {
      const item = current.get(before.id);
      if (item?.status === "draft" && item.agent_assigned
          && (item.rework ?? 0) === (before.rework ?? 0) && item.note === before.note) {
        this.append({ op: "delivery_reset", id: item.id, at: new Date().toISOString(), reason: "意见交接未完成，已恢复待处理" });
      }
    }
  }

  /** 记录 Agent 的逐条回应。只接受已经提交且仍是当前 revision 的意见；
   * 作者是否认可由 verify/reopen 决定，绝不在这里自动闭环。 */
  respond(
    id: string,
    input: Omit<AnnotationResponse, "revision" | "responded_at"> & {
      revision?: number;
      responded_at?: string;
    },
  ): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.status === "draft") {
      throw new AnnotationError("批注尚未提交，不能登记 Agent 回应");
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    const revision = input.revision ?? (found.rework ?? 0);
    if (revision !== (found.rework ?? 0)) {
      throw new AnnotationError(
        `批注 ${id} 当前是第 ${(found.rework ?? 0) + 1} 轮，不能登记旧轮回应`,
      );
    }
    const summary = String(input.summary ?? "").trim();
    if (!summary) throw new AnnotationError("Agent 逐条回应不能为空");
    const response: AnnotationResponse = {
      revision,
      outcome: input.outcome,
      summary,
      evidence: [...new Set((input.evidence ?? [])
        .map((item) => String(item).trim()).filter(Boolean))].slice(0, 20),
      ...(input.fixed_sha?.trim() ? { fixed_sha: input.fixed_sha.trim() } : {}),
      responded_at: input.responded_at ?? new Date().toISOString(),
    };
    this.append({ op: "respond", id, response });
    return this.list().find((item) => item.id === id)!;
  }

  /** 人在澄清卡上答复 Agent 的追问。答复不是验收:它只把球踢回 Agent
   * ——追问连同答复留档,当前回执清空,Agent 必须按答复继续并重新写
   * 回执;意见作者仍在最终卡上逐条确认。谁能答由上层(卡的权限)定。 */
  answerClarification(id: string, answer: string, by?: string): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.status !== "sent"
        || found.response?.outcome !== "needs_clarification"
        || found.response.revision !== (found.rework ?? 0)) {
      throw new AnnotationError(`批注 ${id} 当前没有等待答复的追问`);
    }
    const normalized = String(answer ?? "").trim();
    if (!normalized) throw new AnnotationError("答复不能为空");
    this.append({ op: "clarified", id, answer: normalized,
      at: new Date().toISOString(), ...(by ? { by } : {}) });
    return this.list().find((item) => item.id === id)!;
  }

  /** 意见作者在意见处回复 Agent 的当前回应(问题域检视回复环,
   * ADR-0035):回复留档并快照所回应的回执,回执清空——作者是否认可
   * 仍由后续确认决定,这里只把球踢回 Agent,唤醒由上层负责。只接受
   * 已提交且回应还在场的意见;上一条回复还没被 Agent 处理时不能再叠。 */
  replyToResponse(id: string, text: string, by?: string): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.status === "draft") {
      throw new AnnotationError("意见尚未提交,不能回复");
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    if (!found.response) {
      throw new AnnotationError(
        "Agent 还没有回复这条意见,或你上一条回复还在等它处理",
      );
    }
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new AnnotationError("回复不能为空");
    this.append({ op: "author_reply", id, text: normalized,
      at: new Date().toISOString(), ...(by ? { by } : {}) });
    return this.list().find((item) => item.id === id)!;
  }

  /** 责任人回答一条“问责任人 / 决策后处理”意见。只有指派对象可以答；
   * 管理员代答也应由上层显式传 override，并在 author 中留下真实操作者。 */
  replyAsOwner(
    id: string,
    by: string,
    text: string,
    override = false,
  ): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if ((found.status === "draft" && found.agent_assigned)
        || (found.status === "sent" && found.sent_via !== "owner_pending")) throw new AnnotationError("意见已交给 Agent，请等待答复后处理");
    if (found.status !== "draft" && found.status !== "sent") {
      throw new AnnotationError("这条意见当前不能答复");
    }
    if (found.owner_reply) {
      throw new AnnotationError("责任人已经答复；如需改变结论，请由提出人重新发起一轮");
    }
    if (found.assignee && found.assignee !== by && !override) {
      throw new AnnotationPermissionError(
        `这条意见指派给 ${found.assignee}，只能由他答复`,
      );
    }
    const normalized = String(text ?? "").trim();
    if (!normalized) throw new AnnotationError("责任人答复不能为空");
    const reply: AnnotationOwnerReply = {
      author: by,
      text: normalized,
      replied_at: new Date().toISOString(),
    };
    this.append({
      op: "owner_reply", id, reply,
      ...(found.status === "draft" ? { via: "owner_pending" as const } : {}),
    });
    return this.list().find((item) => item.id === id)!;
  }

  /** 谁的意见谁裁决:和 drop 同一条规矩,替别人点"通过"等于替他签字。
   * override 是管理员的死锁出路,凭 op.by 留痕(见 drop 的注释)。 */
  private judgeable(id: string, by: string, override = false): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by && !override) {
      throw new AnnotationPermissionError(`这条是 ${found.author} 写的,只能由他裁决`);
    }
    if (found.status === "draft") {
      throw new AnnotationError("还没提交过,没有可裁决的改动");
    }
    if (found.status === "dropped") {
      throw new AnnotationError("这条已经移除");
    }
    return found;
  }

  /** 服务层先核对当前任务责任人；这里原子校对意见版本并追加真实处置。 */
  resolveAsOwner(id: string, by: string, decision: Omit<AnnotationResolution, "by" | "at">): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (!Number.isInteger(decision.revision) || decision.revision !== (found.rework ?? 0)) {
      throw new AnnotationConflictError("意见版本已变化，请刷新后逐条处理");
    }
    if (found.resolution) {
      if (found.resolution.by === by && found.resolution.outcome === decision.outcome
          && found.resolution.reason === decision.reason.trim()) return found;
      throw new AnnotationError("这条意见已处置，请刷新查看记录");
    }
    if (found.status !== "sent" && !(found.status === "draft" && (found.needs_owner_closure || found.external_review))) {
      throw new AnnotationError("这条意见尚未提交或已经闭环");
    }
    if (!["fixed", "not_adopted", "deferred", "accepted_risk"].includes(decision.outcome)) {
      throw new AnnotationError("请选择有效的逐条处置结果");
    }
    const reason = decision.reason.trim();
    if (!reason && decision.outcome !== "fixed") {
      throw new AnnotationError("请填写这条意见的处理依据；不采纳、延期或接受风险必须说明理由");
    }
    this.append({ op: "owner_resolution", id, resolution: { ...decision, reason, by, at: new Date().toISOString() } });
    return this.list().find((item) => item.id === id)!;
  }

  saveAgentContext(id: string, by: string, text: string): Annotation {
    const found = this.list().find(item => item.id === id);
    if (!found || !pendingReviewAnnotation(found) || found.agent_assigned) throw new AnnotationError("意见已交办或已闭环，请另行补充新意见");
    if (text.trim().length > 4000) throw new AnnotationError("补充说明最多 4000 字");
    this.append({ op: "agent_context", id, by, at: new Date().toISOString(), text: text.trim() });
    return this.list().find(item => item.id === id)!;
  }

  assignToAgent(id: string, by: string, context = ""): void {
    const found = this.list().find((item) => item.id === id);
    if (!found || (found.status !== "draft" && !(found.status === "sent" && found.sent_via === "owner_pending"))) throw new AnnotationError("这条意见已经交付处理或已闭环，请刷新");
    if (context.trim().length > 4000) throw new AnnotationError("补充说明最多 4000 字");
    this.append({ op: "route_agent", id, by, at: new Date().toISOString(), context: context.trim() || undefined });
  }

  requestWithdrawal(id: string, by: string): Annotation {
    const found = this.list().find((item) => item.id === id);
    if (!found) throw new AnnotationError(`批注不存在: ${id}`);
    if (found.author !== by) throw new AnnotationPermissionError("只能撤回自己提出的表达");
    if (found.status === "verified" || found.status === "dropped") throw new AnnotationError("已闭环意见保留历史，请新增补充意见");
    if (found.status === "draft" && !found.needs_owner_closure) return this.drop(id, by);
    if (!found.withdrawal_requested) this.append({ op: "withdraw_request", id, by, at: new Date().toISOString() });
    return this.list().find((item) => item.id === id)!;
  }

  /** 确认通过:人看过那处改动,认了。检视闭环的收口一步。 */
  verify(id: string, by: string, override = false): Annotation {
    const found = this.judgeable(id, by, override);
    if (["requirement_queue", "requirement_review", "overall_story_queue", "overall_story_processing"].includes(found.sent_via ?? "")) {
      throw new AnnotationError("这条意见尚在排队或处理中，不能提前确认通过");
    }
    if (found.sent_via === "overall_story" && (!found.response
        || found.response.revision !== (found.rework ?? 0) || found.response.outcome === "needs_clarification")) {
      throw new AnnotationError("请先补充说明并重新提交，再检视整体 Story 修改结果");
    }
    const at = new Date().toISOString();
    const proxy = found.author !== by;
    this.append(proxy ? { op: "verify", id, at, by } : { op: "verify", id, at });
    return { ...found, status: "verified", verified_at: at,
             ...(proxy ? { verified_by: by } : {}) };
  }

  /**
   * 返工:改动没达到要求,退回草稿再送一轮。
   *
   * 不造新的送出机制——草稿本来就有两条路(跑动中插话/决定卡随批)。
   * 锚点可能已经失效(原文被改掉正是返工的常见起因),所以允许带上
   * 当前位置的新原文;旧原文存进 anchor_was,渲染时给模型看历史,
   * 免得它以为是条全新意见、把上一轮的改动又翻回去。
   */
  reopen(id: string, by: string, update?: {
    line?: number; anchor?: string; note?: string;
  }, ownerOverride = false): Annotation {
    const current = this.judgeable(id, by, ownerOverride);
    if (!ownerOverride && ["overall_story_queue", "overall_story_processing"].includes(current.sent_via ?? "")) {
      throw new AnnotationError("整体 Story 仍在处理，请停止本轮后再调整意见");
    }
    this.append({
      op: "reopen", id, at: new Date().toISOString(),
      by, ...(ownerOverride ? { owner_controlled: true } : {}),
      line: update?.line, anchor: update?.anchor?.trim() || undefined,
      note: update?.note?.trim() || undefined,
    });
    const replayed = this.list().find((item) => item.id === id)!;
    return replayed;
  }

  private append(operation: Operation): void {
    appendFileSync(this.path, JSON.stringify(operation) + "\n", "utf-8");
    if (operation.op !== "respond") this.onChanged?.();
  }
}

/** 同一行的多条并排,按文件分组、组内按行号升序。
 * 人是跳着圈的,模型却要一个文件一个文件地改——按点击顺序给它,
 * 它得来回翻(内核那条经验)。 */
export function orderAnnotations(items: Annotation[]): Annotation[] {
  return [...items].sort((left, right) => {
    if (left.file !== right.file) return left.file < right.file ? -1 : 1;
    if (left.line !== right.line) return left.line - right.line;
    return left.created_at.localeCompare(right.created_at);
  });
}

/**
 * 渲染成给模型的清单。
 *
 * 抬头那四条护栏一字不改地沿用内核 panel/annotate.py 的措辞——它们是
 * 对着弱模型踩出来的,看着像客套话,其实是契约:不许"已知悉"式敷衍、
 * 不许顺手改别处、以原文定位、不同意要说理由。本仓复制了一份,所以
 * annotations.test.ts 里钉死了这四条;要改先去内核改,别在这儿各写各的。
 */
export function renderAnnotations(
  items: Annotation[],
  ticket: string,
  options: { allowRelatedChanges?: boolean; headerLine?: string } = {},
): string {
  const ordered = orderAnnotations(items);
  const hasGraphAnnotations = ordered.some((item) =>
    item.artifact === REQUIREMENT_GRAPH_ARTIFACT);
  const files = [...new Set(ordered.map((item) => item.file))];
  const lines: string[] = [
    // 头可覆盖:问题流的 MR 检视意见清单复用本渲染器,但检视人是
    // CodeHub 检视人,"我人工检视"的口吻对它是错的(ADR-0052)。
    options.headerLine
      ?? `这是我人工检视 ${ticket} 的结果,共 ${ordered.length} 条,` +
         `涉及 ${files.length} 个文件。请按下面的意见逐条修改。`,
    "",
    "几点要求:",
    "- 这是检视结论,不是征求意见。逐条落实,不要只回复\"已知悉\"。",
    options.allowRelatedChanges
      ? "- 围绕这些意见修改，必要的相关表格、定义和上下文一起调整，在回执中说明原因与位置，交由人检视。"
      : "- 只改这些地方。确实要连带改别处,先说清为什么,再动。",
    "- 行号仅为历史参考。每条修改前读取当前文件，以原文为准定位，结合批注时上下文核对；处理上一条后重新核对后续位置，不沿用旧行号。",
    "- 找不到原文或匹配多处时，先检查当前实现与意见要求；无法确认就说明，不猜位置、不把原文消失当作已修复，可继续处理其他意见。",
    "- 逐条回我改了什么。有哪条你认为不该改,说明理由,别默默跳过。",
    ...(hasGraphAnnotations ? [
      "- 标为“方案结构”的意见来自模块拆分图。按方案整体、模块 id 或依赖边定位，"
        + "不要拿展示行号去猜 JSON 行号。处理后必须同时更新当前设计文档（新任务 story.md，旧现场 CHAIN）和"
        + " requirement-graph.json，并为两份产物换同一个新 plan_revision。",
    ] : []),
    "",
  ];
  let seen = "";
  let index = 0;
  for (const item of ordered) {
    if (item.file !== seen) {
      seen = item.file;
      lines.push(`【${item.file}】`);
    }
    index += 1;
    // 稳定 id 是逐条回执的连接键。不能再靠“第 1 段大概回答第 1 条”猜，
    // Agent、服务端和页面都必须能精确指回同一条意见。
    const graphAnnotation = item.artifact === REQUIREMENT_GRAPH_ARTIFACT;
    const span = graphAnnotation ? "方案结构"
      : item.line_end && item.line_end > item.line
        ? `历史第 ${item.line}–${item.line_end} 行` : `历史第 ${item.line} 行`;
    lines.push(`${index}. [${item.id}] ${span}`);
    const label = "批注时原文";
    if (item.quote) {
      // 划选了一块:整块给模型看语境;定位仍以首行原文(anchor)为准。
      lines.push(`   ${label}(选中整块):`);
      for (const quoted of item.quote.split("\n")) lines.push(`   | ${quoted}`);
    } else {
      lines.push(`   ${label}:${item.anchor}`);
    }
    if (item.context_before) lines.push(`   批注时前文:\n${item.context_before}`);
    if (item.context_after) lines.push(`   批注时后文:\n${item.context_after}`);
    lines.push(`   要求:${item.note}`);
    if (item.agent_context?.revision === (item.rework ?? 0)) lines.push(`   责任人补充（${item.agent_context.by}）：${item.agent_context.text}`);
    // 附图是意见的一部分:设计稿、期望效果截图。不看图就动手等于没读意见。
    if (item.images?.length) {
      lines.push(`   附图 ${item.images.length} 张,先用 inspect_image 逐张看清再动手(工作区相对路径):`);
      for (const image of item.images) {
        lines.push(`   - ${image.path}${image.label ? `(${image.label})` : ""}`);
      }
    }
    // 追问过的意见:作者已经针对你的问题补充了(改字重提,或在澄清卡上
    // 直接答了),别再问同一件事。
    for (const asked of item.clarifications ?? []) {
      lines.push(`   上一轮你问过:${asked.question}`);
      if (asked.answer !== undefined) {
        lines.push(`   ${asked.answered_by ? `${asked.answered_by} ` : ""}答复:${
          asked.answer.replace(/\s*\n\s*/g, " ")}`);
      }
    }
    if (item.clarifications?.length) {
      lines.push("   作者已针对上面的问题补充了要求;不要再问同一件事,仍不清楚就按"
        + "最合理的理解处理,并在回执里写明你采用的假设。");
    }
    // 返工必须点明,不然模型把它当全新意见——轻则重复上一轮的改法,
    // 重则把已有改动翻回去。历史锚点一并给:它要能对出"上次改成了什么"。
    // 看 returned 不看 rework:改字重提也会换版本,但那不是退回。
    if (item.returned) {
      lines.push(`   注意:这是同一条意见的第 ${item.returned + 1} 次提出,`
        + "上一轮的改动没有达到要求。先弄清上次改了什么、差在哪,再动手;"
        + "不要原样重复上次的改法。");
      if (item.anchor_was) {
        lines.push(`   上一轮针对的原文:${item.anchor_was}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * 送出前重新锚定:原文还在原处吗?
 *
 * 为什么必须在**送出那一刻**做而不是圈注时:靶子是活的。你圈的第 23
 * 行,模型十分钟后重构了那个文件,行号偏移甚至整块消失。更糟的是意见
 * 可能已经过期——它自己已经改好了,你再送一条"要求改 X",轻则白烧一轮,
 * 重则让它改回去。
 *
 * 这里只报告事实,不替人决定撤不撤:判定权是人的。
 */
/** 比对前的归一化:锚点是渲染时抓的,文件里是源文本——两边必须按同
 * 一把尺子量,否则永远"找不到"。踩过两回:
 * - 只折叠空白那版,带缩进的代码全被误报"已被改动"(代码一字没动);
 * - 2026-08-20 内网实锤:带加粗(星号)、行内代码(反引号)、链接、
 *   表格竖线、标题井号的行,渲染把语法字符吃掉了,锚点拿"干净文本"
 *   回源文件里搜,批注刚圈上就被判"原文已删除"。
 * 所以:链接取显示文字,markdown 装饰字符与全部空白一律剥掉再比。
 * 代价是极小概率把"只动了标记/空白"的改动误判成没动——漏报一条提醒,
 * 远好过每条批注生下来就是误报(误报比不报更坏)。 */
function normalize(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_~|>#]/g, "")
    .replace(/\s+/g, "");
}

export function reanchor(
  items: ReadonlyArray<Pick<Annotation, "id" | "artifact" | "anchor" | "line" | "quote" | "line_end"> & { file?: string; kind?: AnnotationKind; context_before?: string; context_after?: string }>,
  read: (artifact: string) => string | undefined,
): AnchorCheck[] {
  const cache = new Map<string, string[] | undefined>();
  const linesOf = (artifact: string): string[] | undefined => {
    if (!cache.has(artifact)) {
      const text = read(artifact);
      cache.set(artifact, text === undefined ? undefined : text.split(/\r\n|[\n\r\u2028\u2029]/));
    }
    return cache.get(artifact);
  };
  return items.map((item): AnchorCheck => {
    const lines = linesOf(item.artifact);
    // 读不到产物不等于靶子没了(可能是权限/路径问题),按 hit 放行——
    // 旁路一律 fail-open,重锚定绝不能挡住人送出意见。
    if (!lines) return { id: item.id, state: "hit", line: item.line, location_verified: false };
    if (item.file && lines.some((line) => line.startsWith("diff --git "))) {
      const projected = annotationDiffLines(lines.join("\n"), item.file);
      const [check] = reanchor([{ ...item, file: undefined }], () => projected.text);
      const line = check.line && projected.numbers[check.line - 1];
      if (!line || check.location_verified === false) {
        // diff 不包含全文；找不到可能只是移出了 hunk，不能据此宣告原文已删。
        return { id: item.id, state: "hit", location_verified: false };
      }
      return { ...check, line,
        state: check.state === "ambiguous" ? "ambiguous" : line === item.line ? "hit" : "moved",
        ...(check.line_end ? { line_end: projected.numbers[check.line_end - 1] } : {}) };
    }
    if (item.artifact === REQUIREMENT_GRAPH_ARTIFACT) {
      const module = item.anchor.match(/^模块 (.+?)：/);
      if (module) {
        const line = lines.findIndex((row) => row.startsWith(`模块 ${module[1]}：`)) + 1;
        return line ? { id: item.id, state: line === item.line ? "hit" : "moved", line }
          : { id: item.id, state: "gone" };
      }
    }
    // 空行/图块的锚点是"第 N 行"占位文本(人指的是位置不是文字),
    // 源文件里当然没有这串字——按位置放行,别把它判成"原文已删除"。
    if (/^第 \d+ 行$/.test(item.anchor)) {
      return { id: item.id, state: "hit", line: item.line, location_verified: false };
    }
    // 代码符号属于语义；只有文档才剥离渲染后的 Markdown 装饰。
    const norm = item.kind === "code" ? (text: string) => text.replace(/\r\n/g, "\n").split("\n").map(line => line.trim()).join("\n").trim() : normalize;
    const needle = norm(item.anchor);
    if (!needle) return { id: item.id, state: "hit", line: item.line, location_verified: false };
    // 表头在长文档里经常重复。划选正文能区分“哪张表”，不能只搜表头
    // 然后退回历史行号。分隔线不显示在页面上，全文匹配也必须跳过它。
    const normalizedLines = lines.map((line) => item.kind !== "code" && /^\s*\|[\s:|-]+\|\s*$/.test(line) ? "" : norm(line));
    const separator = item.kind === "code" ? "\n" : "";
    const joined = normalizedLines.join(separator);
    const lineAt = (offset: number) => {
      let consumed = 0;
      for (const [at, content] of normalizedLines.entries()) {
        consumed += content.length + separator.length;
        if (offset < consumed) return at + 1;
      }
      return lines.length;
    };
    const quote = norm(item.quote?.replace(/…$/, "") ?? "");
    const quoteAt = quote ? joined.indexOf(quote) : -1;
    if (quoteAt >= 0 && joined.indexOf(quote, quoteAt + 1) < 0) {
      const line = lineAt(quoteAt);
      const row = normalizedLines[line - 1];
      if (row.includes(needle) || needle.includes(row)) {
        return { id: item.id, state: line === item.line ? "hit" : "moved", line,
          ...(item.line_end && !item.quote?.endsWith("…")
            ? { line_end: lineAt(quoteAt + quote.length - 1) } : {}) };
      }
    }
    const hits: number[] = [];
    lines.forEach((line, at) => {
      if (norm(line).includes(needle)) hits.push(at + 1);
    });
    if (!hits.length) {
      // 代码块、表格等一个 DOM 块可能跨多行；浏览器抓到的是整块
      // textContent，逐行当然永远匹配不到。再按同一归一化口径搜索
      // 连续全文，并把命中起点还原为源文件行号，避免批注刚记下就 gone。
      const first = joined.indexOf(needle);
      if (first >= 0) {
        let offset = 0;
        let line = 1;
        for (const [at, content] of normalizedLines.entries()) {
          if (first < offset + content.length) {
            line = at + 1;
            break;
          }
          offset += content.length + separator.length;
        }
        const repeated = joined.indexOf(needle, first + 1) >= 0;
        return repeated
          ? { id: item.id, state: "ambiguous", line }
          : line === item.line
            ? { id: item.id, state: "hit", line }
            : { id: item.id, state: "moved", line };
      }
      const now = lines[item.line - 1];
      return {
        id: item.id,
        state: "gone",
        now: now === undefined ? undefined : now.trim(),
      };
    }
    if (hits.length > 1 && (item.context_before || item.context_after)) {
      const contextual = hits.filter((line) => {
        const before = norm(lines.slice(Math.max(0, line - 5), line - 1).join("\n"));
        const after = norm(lines.slice(line, line + 4).join("\n"));
        return (!item.context_before || before.endsWith(norm(item.context_before)))
          && (!item.context_after || after.startsWith(norm(item.context_after)));
      });
      if (contextual.length === 1) return { id: item.id, state: contextual[0] === item.line ? "hit" : "moved", line: contextual[0] };
    }
    if (hits.length > 1) return { id: item.id, state: "ambiguous", line: hits[0] };
    if (hits.includes(item.line)) return { id: item.id, state: "hit", line: item.line };
    return { id: item.id, state: "moved", line: hits[0] };
  });
}
