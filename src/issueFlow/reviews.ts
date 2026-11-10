import { pendingReviewAnnotation } from "../annotationPending.ts";
import { renderAnnotations } from "../annotations.ts";
/**
 * 检视账本(问题域,ADR-0007):用户对分析报告(issue-analysis.md)的
 * 检视意见。
 *
 * 存储与锚点整体复用需求流的 annotations.ts(AnnotationStore 的
 * append-only jsonl、坐标+原文快照+要求三元组、reanchor 四态检测)
 * ——同一套检视语义不许两份实现,artifact 恒为分析报告,清单渲染
 * 是唯一的分叉点:单文档、无逐文件分组,护栏原文沿用(它们是
 * 对着弱模型踩出来的契约,不在这儿各写各的)。
 *
 * 闭环(ADR-0035 检视分诊):意见递给 AI 逐条自判回复型/修改型——
 * 回复型(澄清、追问、确认语义)在意见处 respond 回复(AnnotationStore
 * 的 respond 操作,对齐需求侧批注回复的呈现),原地闭环:不回退、
 * 不重跑、不出版本、不再举确认卡;含修改型的批次才由 AI 申报
 * (declare_review_rework)触发整体回退重写(ADR-0007 链路),版本
 * 快照在申报时刻冻结,重写完成后修改型意见同样逐条 respond 交代
 * (ADR-0036:检视回复一律落账在意见处,报告不带应答段)。锚点徽标
 * (reanchor 白送,只服务草稿:ADR-0025)与新版报告上的整体把关照旧。
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnnotationStore,
  orderAnnotations,
  reanchor,
  type AnchorCheck,
  type Annotation,
} from "../annotations.ts";
import { ANALYSIS_DOC_NAME } from "./documents.ts";

/** 检视账本落点(会话工作区根,与 events.jsonl 同层;GateService 的
 * 账本规则只守 issue.json 与 skills/,这里不设硬闸——Agent 改自己的
 * 意见清单骗不到用户,意见原文快照在事件账里另有凭据)。 */
export const REVIEWS_FILE = "reviews.jsonl";

/** 被检视报告的版本快照目录(子目录:顶层 .md 扫描是过程文档页签的
 * 清单,快照不能混进去当页签)。版本投影(analysisVersions.ts)以它为
 * 唯一边界:冻结版只准从这里读。 */
export const REVIEWS_DIR = "reviews";

/** 意见清单快照文件名(#366):全部可引用意见的渲染清单。注入回合的
 * 意见正文随上下文压缩/服务重启即丢,清单落盘后 AI 随时可读回。
 * 不叫 current-batch:内容是可引用全集,而「当前批」在
 * outstandingReviewBatch 里另有定义(按快照时刻划窗),同名不同义
 * 会埋坑。 */
export const REVIEW_NOTES_SNAPSHOT = "review-notes.md";

export function reviewStore(root: string): AnnotationStore {
  return new AnnotationStore(join(root, REVIEWS_FILE));
}

/**
 * 下一个意见号(#261,ADR-0025):单个问题会话内自 1 单调递增、永不
 * 复用、跨批次连续。max 的口径是台账里的**全部历史 add 操作**——软删
 * 的、已送出的都继续占号。读侧口径(list/visible/drafts)都是过滤
 * 语义,哪天过滤规则变了也不能让已发出的号回填:删掉末条(号 5)再
 * 新增,新号必须是 6 不是 5,否则带号的回应会指错条。意见号是落账
 * 硬要求:扫描只认 seq 字段,历史 add 缺号一律按坏账炸出来——系统
 * 未上线,不存在无号的旧账,不为它留宽容分支。
 */
function nextReviewNumber(store: AnnotationStore): number {
  let max = 0;
  for (const operation of store.history()) {
    if (operation.op === "add") {
      const seq = operation.record.seq;
      if (seq === undefined) {
        throw new Error(
          `检视台账出现无意见号的 add(${operation.record.id}):`
            + "意见号是落账硬要求(ADR-0025),无号即坏账");
      }
      max = Math.max(max, seq);
    }
  }
  return max + 1;
}

export function addReview(
  root: string,
  input: { author: string; line: number; anchor: string; note: string; quote?: string; line_end?: number; context_before?: string; context_after?: string },
): Annotation {
  const store = reviewStore(root);
  return store.add({
    author: input.author,
    // artifact/file 恒为分析报告:问题域的检视对象只有它(ADR-0007)。
    artifact: ANALYSIS_DOC_NAME,
    file: ANALYSIS_DOC_NAME,
    line: input.line,
    anchor: input.anchor,
    quote: input.quote, line_end: input.line_end, context_before: input.context_before, context_after: input.context_after,
    note: input.note,
    kind: "doc",
    // 意见号在落账口分配(ADR-0025):台账 append-only,add 记录即
    // 凭据,号随条目永久稳定;展示与 AI 引用统一用「意见N」。
    seq: nextReviewNumber(store),
  });
}

export function dropReview(root: string, id: string, by: string): Annotation {
  return reviewStore(root).drop(id, by);
}

/** 送出前重锚定:草稿清单 vs 当前分析报告。reanchor 的读取是注入的
 * (只认分析报告,其余 artifact 按 hit 放行)——需求流的产物扫描
 * 不被牵扯进来。只服务草稿(ADR-0025):已提交的意见锚在自己批次的
 * 冻结版上,冻结文本永不漂移,对着 live 判定只会产出无意义的徽标。 */
export function anchorChecks(root: string): AnchorCheck[] {
  const drafts = reviewStore(root).drafts();
  let text: string | undefined;
  try {
    text = readFileSync(join(root, ANALYSIS_DOC_NAME), "utf-8");
  } catch {
    text = undefined;
  }
  return reanchor(drafts, (artifact) =>
    artifact === ANALYSIS_DOC_NAME ? text : undefined);
}

/** 提交检视:草稿清单 + 送出标记。版本快照不在这里(ADR-0035):
 * 提交不再无条件伴重写,快照时机迁到修改型申报触发整体回退时
 * (snapshotAnalysisVersion),纯回复型批次不出版本。 */
export function submitReviews(root: string, ids?: string[]): Annotation[] {
  const store = reviewStore(root);
  const drafts = store.list().filter(item => pendingReviewAnnotation(item)
    && (ids ? ids.includes(item.id) : !item.external_review));
  if (!drafts.length) return [];
  for (const item of drafts) if (item.external_review) store.assignToAgent(item.id, item.assignee ?? item.author);
  store.markSent(drafts.map((item) => item.id), "issue_review");
  // 送出态从台账重放取(不手拼字段):账本是唯一真相。
  const sentIds = new Set(drafts.map((item) => item.id));
  return orderAnnotations(store.list()
    .filter((item) => sentIds.has(item.id)));
}

/** reviews/ 内既有快照的最新冻结时刻(读自己写出的文件名时间戳;
 * 目录不存在=0)。批次边界与读侧(analysisVersions.ts)同一形状。 */
function lastSnapshotStampMs(root: string): number {
  let floor = 0;
  try {
    for (const entry of readdirSync(join(root, REVIEWS_DIR), { withFileTypes: true })) {
      const stamp = entry.isFile()
        ? /^issue-analysis@r([0-9a-z]+)\.md$/.exec(entry.name) : null;
      if (stamp) floor = Math.max(floor, Number.parseInt(stamp[1], 36));
    }
  } catch {
    // reviews/ 还不存在:floor=0,首批意见全部待覆盖。
  }
  return floor;
}

/** 当前检视批:已送出且未被任何快照覆盖的意见(送出时刻晚于最新
 * 快照时刻)。申报修改的「回退重写」以它为对象;更早批次的意见已
 * 锚在自己的冻结版上,不再混进新一轮清单。 */
export function outstandingReviewBatch(root: string): Annotation[] {
  const floor = lastSnapshotStampMs(root);
  return reviewStore(root).list().filter((item) =>
    item.status === "sent" && item.sent_via === "issue_review"
    && Date.parse(String(item.sent_at ?? "")) > floor);
}

/** 版本快照——报告即将被整体重写时冻结,写侧唯一入口。两个触发源:
 * 检视修改型申报(tools 的 declare_review_rework,ADR-0035)与验证
 * 打回回退(service 的 env_verify fail 分派)——两者都是重写来源,
 * 重写前的报告必须留账(AI 重写后 live 即新版)。文件名时刻取当前批
 * 最早的送出时刻:读侧批次推导(sent_at 落在相邻快照时刻之间即该批)
 * 在新时机(送出在先、冻结在后)与旧时机(提交即冻结)下都把意见对回
 * 它锚定的那一版;验证打回场景无意见批,时刻落在打回当下。报告不在场
 * 不落,写失败不挡申报/回退(fail-open,意见自带原文快照,损失的只是
 * 全文对照)。 */
export function snapshotAnalysisVersion(root: string): void {
  if (!existsSync(join(root, ANALYSIS_DOC_NAME))) return;
  const batch = outstandingReviewBatch(root);
  let stampMs = Number.NaN;
  for (const item of batch) {
    const at = Date.parse(String(item.sent_at ?? ""));
    if (Number.isFinite(at)
        && (Number.isNaN(stampMs) || at < stampMs)) {
      stampMs = at;
    }
  }
  if (Number.isNaN(stampMs)) stampMs = Date.now();
  try {
    mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
    copyFileSync(
      join(root, ANALYSIS_DOC_NAME),
      join(root, REVIEWS_DIR,
        `issue-analysis@r${stampMs.toString(36)}.md`),
    );
  } catch {
    // 快照失败不挡申报/回退。
  }
}

/**
 * 渲染成给模型的意见清单。护栏与 annotations.ts 的 renderAnnotations
 * 同一份契约原文(逐条落实/只改这些/以原文定位/逐条回话);差异有三:
 * 抬头(单文档、意见数量)、问题域独有的逐条 respond 交代要求
 * (ADR-0036:回复一律经 respond_review 落账在意见处,报告正文不带
 * 应答段)与收尾(交代完重新 submit_analysis)。
 *
 * mode(ADR-0035 检视分诊):"rework"(默认)= 修改型重写的正式通道,
 * 交代契约随 ADR-0036 收敛为逐条 respond;"triage" = 提交检视时随清单
 * 递给 AI 的分诊版——不预设
 * 整批重写,判断准则与 respond_review/declare_review_rework 用法在
 * 提示词资产(notices.review.triage),这里只保留抬头、共用的定位
 * 护栏与带号清单。
 */
export function renderReviewNotes(
  items: Annotation[],
  title: string,
  round: number,
  mode: "rework" | "triage" = "rework",
): string {
  if (items.some(item => item.external_review)) return renderAnnotations(items, title, {
      // MR 检视意见的检视人是 CodeHub 检视人,"我人工检视"是报告检视的
      // 口吻——混称正是 issue-383 的根因,清单头一并分家(ADR-0052)。
      headerLine: `这是检视人在 CodeHub 的 MR 讨论区对本会话修复代码提的意见,`
        + `共 ${items.length} 条、涉及 ${[...new Set(items.map(item => item.file))].length} 个文件。`
        + "处理口径按上方平台通知执行,逐条 respond_review 交代。",
    })
    + "\n这些是责任人明确选择的修改意见。按责任人补充要求处理，只回应本批；未选的外部报告不构成修复任务。本地处理不自动代表远端 resolve。";
  // 清单按意见号编排(ADR-0025):orderAnnotations 是行号序,跨批次会
  // 把意见5 排在意见3 前——这里只认意见号升序。意见必须带号(#261,
  // 落账硬要求):无号即坏账,炸出来,不给续编兜底。
  const ordered = items.map((item) => {
    if (item.seq === undefined) {
      throw new Error(
        `检视意见 ${item.id} 没有意见号:意见必须带号(ADR-0025),无号即坏账`);
    }
    return item as Annotation & { seq: number };
  }).sort((left, right) => left.seq - right.seq);
  const lines: string[] = [
    mode === "triage"
      ? `这是我人工检视《${title}》分析报告(issue-analysis.md)的结果,`
        + `共 ${ordered.length} 条意见。请先逐条分诊再动手,不要不分类`
        + "就整批重写。"
      : `这是我人工检视《${title}》分析报告(issue-analysis.md)的结果,`
        + `共 ${ordered.length} 条意见。这是第 ${round} 轮分析——请按意见修订报告与方案。`,
    "",
  ];
  if (mode === "rework") {
    lines.push(
      "几点要求:",
      "- 这是检视结论,不是征求意见。逐条落实,不要只回复\"已知悉\"。",
      "- 只按这些意见修订。确实要连带改别处,先说清为什么,再动。",
    );
  }
  lines.push(
    // 定位护栏两版共用:分诊回合里 respond 也要按原文核对意见。
    "- 行号仅为历史参考。每条修改前读取当前文件，以原文为准定位，结合批注时上下文核对；处理上一条后重新核对后续位置，不沿用旧行号。",
    "- 找不到原文或匹配多处时先检查当前实现；无法确认就说明，不猜位置、不把原文消失当作已修复，可继续处理其他意见。",
    // 恢复源指路(#366):清单文本流到哪个注入点,指向就跟到哪——
    // 上下文压缩丢正文后,AI 第一次读清单就知道去哪拿回全部意见。
    `- 全部可引用检视意见的正文与要求已落盘工作区 reviews/${REVIEW_NOTES_SNAPSHOT}：上下文被压缩或服务重启后，先读该文件恢复意见内容，不要凭记忆或凭空编号引用。`,
  );
  if (mode === "rework") {
    lines.push(
      // 逐条交代落账在意见处(ADR-0036):报告是交付物,不带应答段。
      "- 修订后对本批意见逐条调 respond_review 交代:改了什么/答了什么,"
        + "未被采纳或仅是提问的意见也要逐条给交代,不许漏号;分诊回合里"
        + "已回复过的不必重发。有哪条你认为不该改,说明理由,别默默跳过。",
      "- 报告正文不写「检视意见回应」之类的应答段:检视回复只落在"
        + "意见处,重写版保持干净纸面。",
      "",
    );
  } else {
    lines.push("");
  }
  // 清单序号 = 意见号(#261):展示与 AI 引用统一用「意见N」,不再是批次
  // 内 1..N 重新编号——号跨批次连续,带号的回应才能在整个会话内唯一定位。
  for (const item of ordered) {
    const number = item.seq;
    // 稳定 id 沿用:它让用户与 Agent 能精确指回同一条意见,不靠猜。
    lines.push(`意见${number}. [${item.id}] 历史第 ${item.line} 行`);
    lines.push(`   批注时原文:${item.quote || item.anchor}`);
    if (item.context_before) lines.push(`   批注时前文:\n${item.context_before}`);
    if (item.context_after) lines.push(`   批注时后文:\n${item.context_after}`);
    lines.push(`   要求:${item.note}`);
  }
  lines.push("");
  if (mode === "rework") {
    lines.push("逐条交代完再重新 submit_analysis 提交,平台会再次举确认卡等用户过目。");
  }
  return lines.join("\n");
}

/**
 * 意见清单快照(#366):把**全部可引用意见**(status=sent 且
 * sent_via=issue_review,与 respond_review 的定位口径一致)按当前
 * 注入点的契约渲染落盘 reviews/review-notes.md。注入回合的清单只带
 * 本批,且正文随上下文压缩/服务重启即丢;快照是超集恢复源,AI 读
 * 文件即可拿回全部意见正文。覆写制、永不回收(过期引用由
 * locateSentReview 与台账拦截);写失败不挡提交/申报(fail-open,
 * unknown_ref/unknown_seq 回执兜底仍在)。
 */
export function writeReviewNotesSnapshot(
  root: string,
  title: string,
  round: number,
  mode: "rework" | "triage",
): void {
  try {
    const items = reviewStore(root).list().filter((item) =>
      item.status === "sent" && item.sent_via === "issue_review");
    if (!items.length) return;
    mkdirSync(join(root, REVIEWS_DIR), { recursive: true });
    writeFileSync(
      join(root, REVIEWS_DIR, REVIEW_NOTES_SNAPSHOT),
      renderReviewNotes(items, title, round, mode));
  } catch {
    // 快照失败不挡提交/申报;回执兜底仍在。
  }
}

/**
 * 渲染一条意见的回复线程(用户在意见处回复后唤醒 AI 用):意见原文
 * + 各轮「Agent 回复 → 用户回复」按序排列——被回复清空的旧回执快照在
 * author_replies 里,最新回应(还没有用户回复的)在 response。AI 看
 * 完整线程再作答,不会把用户的追问当新意见、重复回答别的意见号。
 */
export function renderReviewThread(item: Annotation): string {
  if (item.seq === undefined) {
    throw new Error(
      `检视意见 ${item.id} 没有意见号:意见必须带号(ADR-0025),无号即坏账`);
  }
  const lines: string[] = [
    `意见${item.seq}. [${item.id}] 历史第 ${item.line} 行`,
    `   批注时原文:${item.quote || item.anchor}`,
    `   要求:${item.note}`,
    "",
  ];
  const rounds = [
    ...(item.author_replies ?? []).map((reply) => [
      { who: "你的回复", text: reply.response.summary, at: reply.response.responded_at },
      { who: "用户的回复", text: reply.text, at: reply.replied_at },
    ]).flat(),
    ...(item.response
      ? [{ who: "你的回复", text: item.response.summary, at: item.response.responded_at }]
      : []),
  ];
  for (const round of rounds) {
    lines.push(`— ${round.who}(${round.at}):${round.text}`);
  }
  lines.push("");
  return lines.join("\n");
}
