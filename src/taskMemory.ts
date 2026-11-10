import { resolveBusinessModuleId } from "./businessModuleIdentity.ts";
/**
 * 经验候选与人工采纳。闭环或主动记录先留档，只有明确采纳后才参与复用。
 * 原始依据和每次修订保留在追加索引中，Markdown 是当前全文与向量重建来源。
 * 人工确认只影响复用资格，不改变任务状态；抽象方法由 memoryDraft 提示词指导。
 */

import { randomBytes } from "node:crypto";
import {
  unlinkSync, appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { readAppendOnlyJsonl } from "./jsonlTailRepair.ts";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type MemorySource = "annotation" | "prepush_fix" | "user_note" | "agent_note" | "delivery_review";
export type MemoryJudge = "human" | "pipeline" | "agent";
/** one_off 只检索；local/general 为仓内经验，platform 明确跨仓。 */
export type MemoryScope = "one_off" | "local" | "general" | "platform";

export const MEMORY_DIR = "corpus";
export const MEMORY_ARCHIVE_DIR = "_archive";
export const MEMORY_BODY_LIMIT = 2000;
/** trigger 是记录标题,也是推送时的第一句;超过这个长度就不是"什么情况下"了。 */
export const MEMORY_TRIGGER_LIMIT = 80;

/** trigger/scope 是谁定的:模板(入库那一刻)、模型(起草收尾)、起草失败
 * (模板保留,scope 不动)。user_note 不过起草,固定 template。 */
export type MemoryDraftState = "template" | "model" | "failed";

export const MEMORY_DIMENSIONS = ["业务规则与边界", "组件与接口用法", "设计与实现约束", "编码规范", "测试与验证", "分析与工作方法"] as const;
export type MemoryDimension = typeof MEMORY_DIMENSIONS[number];

export interface MemoryInput {
  dimension?: MemoryDimension;
  source: MemorySource;
  judged_by: MemoryJudge;
  scope: MemoryScope;
  /** 仓库短名(repoSlug),宿主按任务固定,是检索的过滤键。 */
  repo: string;
  paths: string[];
  line?: number;
  module?: string;
  product_versions?: string[];
  source_repo?: string;
  /** 内核七段词表之一;来源决定,不猜。 */
  phase?: string;
  task: string;
  /** 可回溯到现场的指针:annotation:<id> / prepush:<sha> / withdraw:<id>。 */
  evidence: string;
  author?: string;
  /** 什么情况下——记录标题,也是 memsearch 切出来的第一块。 */
  trigger: string;
  /** 圈选或锚定的原文快照。 */
  quote?: string;
  problem?: string;
  conclusion: string;
  supersedes?: string;
}

export interface MemoryReview {
  status: "pending" | "accepted" | "rejected";
  by?: string;
  at?: string;
  /** 首次人工处置前的候选原文，供复核而非运行时使用。 */
  original?: { trigger: string; conclusion: string; scope: MemoryScope };
}
export interface MemoryReviewInput {
  dimension?: MemoryDimension;
  decision: "pending" | "accepted" | "rejected";
  module?: string;
  product_versions?: string[];
  merged_into?: string;
  repo?: string;
  note?: string;
  revision: number;
  trigger?: string;
  conclusion?: string;
  scope?: MemoryScope;
}
export interface MemoryRecord extends MemoryInput {
  review?: MemoryReview;
  edited_by?: string;
  edited_at?: string;
  merged_into?: string;
  maintenance_note?: string;
  basis?: { trigger: string; conclusion: string; scope: MemoryScope };

  id: string;
  at: string;
  /** 相对 corpus/ 的 md 路径。 */
  file: string;
  /** 撤回记录:结论为空、supersedes 指向被撤回的那条。 */
  withdrawn?: boolean;
  /** 同一条记录在索引里的第几版(起草收尾会追加一版);读侧取最后一版。 */
  revision?: number;
  draft?: MemoryDraftState;
  /** 服务读侧派生，只有该条记忆存在在途整理作业才为 true；不落盘。 */
  drafting?: boolean;
  /** 读侧派生:被哪条覆盖了(不落盘)。 */
  superseded_by?: string;
  /** 读侧派生自台账:已沉底归档(md 在 _archive/ 下,不进索引)。 */
  archived?: boolean;
  archive_reason?: string;
}

/** 台账一行:谁在什么时候对哪条记忆做了什么。只追加。 */
export type MemoryLedgerKind =
  | "push"       // 宿主三时刻推给了 Agent
  | "search"     // Agent 检索命中
  | "expand"     // Agent 展开全文
  | "rework"     // 提供经验后同路径出现意见，仅记录关联，不判定经验有害
  | "unanchored" // 消费时发现路径在现场不存在(首次记一行)
  | "archive"    // 沉底归档
  | "restore";   // 从归档捞回(重建索引时可用;暂无入口)

export interface MemoryLedgerRow {
  at: string;
  kind: MemoryLedgerKind;
  id: string;
  task?: string;
  revision?: string;
  /** push 的时刻 / archive 的原因 / rework 的路径。 */
  note?: string;
}

export interface MemoryStats {
  pushes: number;
  hits: number;
  reworks: number;
  last_used?: string;
  unanchored_since?: string;
  archived_at?: string;
  archive_reason?: string;
}

export const EMPTY_STATS: MemoryStats = { pushes: 0, hits: 0, reworks: 0 };

const DAY_MS = 86_400_000;

/**
 * 排序权重(§5「不筛只排」+ §6 效果反馈)。人判 > 流水线;一年减半;
 * 检索/展开提供相关性信号；同文件意见没有因果归属，不用于质量扣分。
 * general 比 local 略重。只影响推不推、排第几,不影响进不进库。
 */
export function memoryWeight(
  record: Pick<MemoryRecord, "judged_by" | "at" | "scope">,
  stats: MemoryStats = EMPTY_STATS,
  now = Date.now(),
): number {
  const base = record.judged_by === "human" ? 1 : record.judged_by === "agent" ? 0.4 : 0.6;
  const ageDays = Math.max(0, (now - new Date(record.at).getTime()) / DAY_MS);
  const decay = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / 365) : 0.5;
  const used = Math.min(0.5, stats.hits * 0.1);
  const scope = record.scope === "general" ? 0.1 : 0;
  return Math.max(0.05, base * decay + used + scope);
}

export function readJsonlRows<T>(path: string): T[] {
  // 断写尾巴读口自愈(票 #160):半行不清,下一次 append 粘行,一次
  // 崩溃最多吞两条账——读时修掉就不会发生。
  return readAppendOnlyJsonl<T>(path, { middleCorrupt: "skip" });
}

export class MemoryError extends Error {}

/** 仓库 URL → 目录名。只留 [A-Za-z0-9._-],别让 URL 里的东西变成路径。 */
export function repoSlug(url: string | undefined): string {
  const tail = String(url ?? "").trim().replace(/\/+$/, "")
    .split(/[/:]/).filter(Boolean).at(-1) ?? "";
  const slug = tail.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return slug || "_unknown";
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value));
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

/** 正文四段固定。空段不写,免得 memsearch 切出一堆空块。 */
export function renderMemoryMarkdown(record: MemoryRecord): string {
  const front: Array<[string, string]> = [
    ["id", yamlScalar(record.id)],
    ["source", record.source],
    ...(record.dimension ? [["dimension", yamlScalar(record.dimension)] as [string, string]] : []),
    ["judged_by", record.judged_by],
    ["scope", record.scope],
    ["review_status", record.review?.status ?? "pending"],
    ["repo", yamlScalar(record.repo)],
    ["paths", `[${record.paths.map(yamlScalar).join(", ")}]`],
    ...(record.line ? [["line", String(record.line)] as [string, string]] : []),
    ...(record.module ? [["module", yamlScalar(record.module)] as [string, string]] : []),
    ...(record.phase ? [["phase", yamlScalar(record.phase)] as [string, string]] : []),
    ...(record.product_versions?.length ? [["product_versions", JSON.stringify(record.product_versions)] as [string, string]] : []),
    ["task", yamlScalar(record.task)],
    ["evidence", yamlScalar(record.evidence)],
    ...(record.author ? [["author", yamlScalar(record.author)] as [string, string]] : []),
    ...(record.supersedes
      ? [["supersedes", yamlScalar(record.supersedes)] as [string, string]] : []),
    ["at", yamlScalar(record.at)],
    ...(record.draft ? [["draft", record.draft] as [string, string]] : []),
  ];
  const sections: string[] = [`# ${record.trigger.replace(/\s+/g, " ").trim()}`];
  if (record.quote?.trim()) {
    sections.push("## 原文\n" + record.quote.trim().split("\n")
      .map((line) => `> ${line}`).join("\n"));
  }
  if (record.problem?.trim()) sections.push(`## 问题\n${record.problem.trim()}`);
  sections.push(`## 结论\n${record.conclusion.trim() || "(已撤回)"}`);
  return `---\n${front.map(([key, value]) => `${key}: ${value}`).join("\n")}\n---\n`
    + sections.join("\n\n") + "\n";
}

export class MemoryStore {
  readonly ledger: MemoryLedger;

  constructor(private readonly dataDir: string) {
    this.ledger = new MemoryLedger(dataDir);
  }

  get root(): string {
    return join(this.dataDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return join(this.root, "index.jsonl");
  }

  /** 落一条。校验只有三样:结论不能空(撤回除外)、正文不超上限、
   * 定位键不能空。不判断质量——质量靠排序,不靠门口的人(§5)。 */
  record(input: MemoryInput, options: { withdrawn?: boolean } = {}): MemoryRecord {
    const trigger = String(input.trigger ?? "").trim();
    if (!trigger || trigger.length > MEMORY_TRIGGER_LIMIT) throw new MemoryError("请填写触发条件（最多 80 字）");
    const conclusion = String(input.conclusion ?? "").trim();
    if (!conclusion && !options.withdrawn) throw new MemoryError("记忆缺少结论");
    if (!["one_off", "local", "general", "platform"].includes(input.scope)) throw new MemoryError("未知记忆范围");
    if (!String(input.repo ?? "").trim()) throw new MemoryError("记忆缺少仓库");
    if (!String(input.task ?? "").trim() && !(input.source === "user_note" && input.evidence === "manual")) throw new MemoryError("记忆缺少任务号");
    const body = [trigger, input.quote ?? "", input.problem ?? "", conclusion]
      .join("\n").length;
    if (body > MEMORY_BODY_LIMIT) {
      throw new MemoryError(
        `记忆是短句,单条不超过 ${MEMORY_BODY_LIMIT} 字(现在 ${body} 字);`
        + "这更像一条 Skill,请去团队知识货架提交");
    }
    const at = new Date().toISOString();
    const id = `c-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const repo = repoSlug(input.repo) === input.repo ? input.repo : repoSlug(input.repo);
    const file = join(input.scope === "platform" ? "_platform" : repo, at.slice(0, 7), `${id}.md`);
    const record: MemoryRecord = {
      ...input,
      review: { status: "pending" },
      basis: { trigger, conclusion, scope: input.scope },
      repo, source_repo: repo,
      paths: [...new Set((input.paths ?? []).map((path) => String(path).trim())
        .filter(Boolean))],
      trigger,
      conclusion,
      id,
      at,
      file,
      ...(options.withdrawn ? { withdrawn: true } : {}),
    };
    const absolute = resolve(this.root, file);
    if (!contained(this.root, absolute)) {
      throw new MemoryError("记忆路径越出语料目录");
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, renderMemoryMarkdown(record), "utf-8");
    // 索引行先于 md 不行(读到索引找不到文件),md 先于索引可以(多一个
    // 没人引用的文件,重建索引时照样收进去)。
    appendFileSync(this.indexPath, JSON.stringify(record) + "\n", "utf-8");
    return record;
  }

  /** 读侧派生 superseded_by / archived;同 id 多版取最后一版(起草收尾
   * 追加的);半行 JSON(崩在写一半)只丢它自己。 */
  list(filter: { task?: string } = {}): MemoryRecord[] {
    if (!existsSync(this.indexPath)) return [];
    const latest = new Map<string, MemoryRecord>();
    for (const row of readJsonlRows<MemoryRecord>(this.indexPath)) {
      if (!row || typeof row.id !== "string") continue;
      latest.set(row.id, row);                     // Map 保插入序,后来的版本原位替换
    }
    const rows = [...latest.values()];
    const supersededBy = new Map<string, string>();
    for (const row of rows) {
      if (row.supersedes) supersededBy.set(row.supersedes, row.id);
    }
    const stats = this.ledger.stats();
    return rows
      .map((row) => {
        const derived: MemoryRecord = { ...row, ...(row.module ? { module: resolveBusinessModuleId(this.dataDir, row.module) } : {}) };
        if (supersededBy.has(row.id)) derived.superseded_by = supersededBy.get(row.id);
        const own = stats.get(row.id);
        if (own?.archived_at) {
          derived.archived = true;
          derived.archive_reason = own.archive_reason;
        }
        return derived;
      })
      .filter((row) => !filter.task || row.task === filter.task);
  }

  /** 起草收尾:模型给出的 trigger/scope 补进同一条记录。md 改标题与
   * frontmatter,索引追加一版。只对还是模板态、未撤回未覆盖的记录做,
   * 且只做一次——起草不是编辑面,不给任何人第二次机会改别人的记录。 */
  finalizeDraft(
    id: string,
    draft: { trigger?: string; scope?: MemoryScope; conclusion?: string; state: MemoryDraftState },
  ): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.edited_by || found.withdrawn || found.superseded_by || found.archived || (found.review?.status ?? "pending") !== "pending") {
      throw new MemoryError("这条记忆已处置，不再由模型改写");
    }
    if ((found.draft ?? "template") !== "template") {
      throw new MemoryError("这条记忆已经起草收尾过");
    }
    const trigger = String(draft.trigger ?? "").replace(/\s+/g, " ").trim();
    const next: MemoryRecord = {
      ...found,
      ...(draft.state === "model" && trigger
        ? { trigger: trigger.slice(0, MEMORY_TRIGGER_LIMIT) } : {}),
      ...(draft.state === "model" && draft.scope && found.scope !== "platform" ? { scope: draft.scope } : {}),
      ...(draft.state === "model" && draft.conclusion?.trim() ? { conclusion: draft.conclusion.trim() } : {}),
      draft: draft.state,
      revision: (found.revision ?? 1) + 1,
    };
    if ([next.trigger, next.quote ?? "", next.problem ?? "", next.conclusion].join("\n").length > MEMORY_BODY_LIMIT) throw new MemoryError("提炼结果过长，保留原候选");
    delete next.superseded_by;
    delete next.archived;
    delete next.archive_reason;
    const absolute = resolve(this.root, next.file);
    if (!contained(this.root, absolute)) throw new MemoryError("记忆路径越出语料目录");
    writeFileSync(absolute, renderMemoryMarkdown(next), "utf-8");
    appendFileSync(this.indexPath, JSON.stringify(next) + "\n", "utf-8");
    return next;
  }

  /** 采纳只改变复用资格，不改变任务执行或原始证据。旧记录无采纳事实时也待确认。 */
  review(id: string, by: string, input: MemoryReviewInput): MemoryRecord {
    const found = this.find(id);
    if (!found || found.withdrawn || found.superseded_by) throw new MemoryError("记忆不存在或已撤回");
    if (!by.trim()) throw new MemoryError("缺少确认人");
    if (input.revision !== (found.revision ?? 1)) throw new MemoryError("候选内容已更新，请重新查看后确认");
    if (!["pending", "accepted", "rejected"].includes(input.decision)) throw new MemoryError("请选择采纳或不采纳");
    const trigger = String(input.trigger ?? found.trigger).trim();
    const conclusion = String(input.conclusion ?? found.conclusion).trim();
    const scope = input.scope ?? found.scope;
    if (input.decision !== "rejected") {
      if (!trigger || !conclusion || trigger.length > MEMORY_TRIGGER_LIMIT) throw new MemoryError("请填写触发条件（最多 80 字）与经验结论");
      if (!["one_off", "local", "general", "platform"].includes(scope)) throw new MemoryError("未知记忆范围");
      if ([trigger, found.quote ?? "", found.problem ?? "", conclusion].join("\n").length > MEMORY_BODY_LIMIT) throw new MemoryError("经验超过 2000 字，请缩短或整理为 Skill");
    }
    if (input.repo !== undefined && !String(input.repo).trim()) throw new MemoryError("请选择适用代码仓");
    if (input.product_versions !== undefined && (!Array.isArray(input.product_versions) || input.product_versions.some(v => typeof v !== "string" || !v.trim()))) throw new MemoryError("适用版本必须是非空文本列表");
    if (input.merged_into) {
      const target = this.find(input.merged_into);
      if (!target || target.id === id || !memoryAccessible(target, target.repo, target.module ? [target.module] : [], target.product_versions?.[0])) throw new MemoryError("请选择另一条已采纳的有效经验作为合并目标");
      if (input.decision !== "rejected") throw new MemoryError("合并来源必须停用");
    }
    if (input.dimension !== undefined && !MEMORY_DIMENSIONS.includes(input.dimension)) throw new MemoryError("未知经验维度");
    const next: MemoryRecord = { ...found, dimension: input.dimension ?? found.dimension,
      ...(input.decision !== "rejected" ? { trigger, conclusion, scope } : {}),
      source_repo: found.source_repo ?? found.repo,
      repo: input.repo === undefined ? found.repo : repoSlug(String(input.repo).trim()),
      module: input.module === undefined ? found.module : String(input.module).trim() || undefined,
      product_versions: input.product_versions === undefined ? found.product_versions : input.product_versions,
      edited_by: by, edited_at: new Date().toISOString(),
      maintenance_note: input.note === undefined ? found.maintenance_note : String(input.note).trim(),
      merged_into: input.merged_into || undefined,
      review: { status: input.decision, by, at: new Date().toISOString(),
        original: found.review?.original ?? { trigger: found.trigger, conclusion: found.conclusion, scope: found.scope } },
      revision: (found.revision ?? 1) + 1,
    };
    if (!next.repo) throw new MemoryError("请选择适用代码仓");
    delete next.archived; delete next.archive_reason;
    next.file = join(next.scope === "platform" ? "_platform" : next.repo, next.at.slice(0, 7), `${next.id}.md`);
    const path = resolve(this.root, next.file);
    if (!contained(this.root, path)) throw new MemoryError("记忆路径越出语料目录");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, renderMemoryMarkdown(next), "utf8");
    appendFileSync(this.indexPath, JSON.stringify(next) + "\n", "utf8");
    if (found.archived) this.ledger.append({ kind: "restore", id, note: `由 ${by} 恢复为${input.decision}` });
    if (found.file !== next.file) {
      const previous = resolve(this.root, found.file);
      // 当前版本已经落账；旧索引残留仍由 Cloud 当前记录过滤，清理失败不回滚采纳。
      try { if (contained(this.root, previous) && existsSync(previous)) unlinkSync(previous); } catch { /* 下次维护可清理旧副本 */ }
    }
    return next;
  }

  history(id: string): MemoryRecord[] {
    return readJsonlRows<MemoryRecord>(this.indexPath).filter(row => row.id === id);
  }

  /** 沉底:md 挪进 _archive/ 同路径,台账记一行。不删、不改索引行;
   * 索引重建(sidecar reindex)时 _archive/** 被排除,自然不再命中。 */
  archive(id: string, reason: string): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.archived) return found;
    const from = resolve(this.root, found.file);
    const to = resolve(this.root, MEMORY_ARCHIVE_DIR, found.file);
    if (!contained(this.root, from) || !contained(join(this.root, MEMORY_ARCHIVE_DIR), to)) {
      throw new MemoryError("记忆路径越出语料目录");
    }
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    }
    this.ledger.append({ kind: "archive", id, note: reason });
    return { ...found, archived: true, archive_reason: reason };
  }

  /**
   * 沉底扫描(§6):两类候选——失锚超 unanchoredDays 的;年头超 idleDays
   * 且从未被推送/命中的。撤回和被覆盖的不用扫(它们本来就不推)。
   * 返回归档了哪些,调用方决定要不要重建索引。
   */
  sweepArchive(options: {
    now?: number; idleDays?: number; unanchoredDays?: number;
  } = {}): Array<{ id: string; reason: string }> {
    const now = options.now ?? Date.now();
    const idleDays = options.idleDays ?? 365;
    const unanchoredDays = options.unanchoredDays ?? 180;
    const stats = this.ledger.stats();
    const archived: Array<{ id: string; reason: string }> = [];
    for (const row of this.list()) {
      if (row.archived || row.withdrawn || row.superseded_by) continue;
      const own = stats.get(row.id) ?? EMPTY_STATS;
      const ageDays = (now - new Date(row.edited_at ?? row.at).getTime()) / DAY_MS;
      let reason = "";
      if (own.unanchored_since
          && (now - new Date(own.unanchored_since).getTime()) / DAY_MS >= unanchoredDays) {
        reason = `失锚超过 ${unanchoredDays} 天(自 ${own.unanchored_since.slice(0, 10)})`;
      } else if (ageDays >= idleDays && own.pushes === 0 && own.hits === 0) {
        reason = `入库超过 ${idleDays} 天且从未被推送或命中`;
      }
      if (!reason) continue;
      this.archive(row.id, reason);
      archived.push({ id: row.id, reason });
    }
    return archived;
  }

  find(id: string): MemoryRecord | undefined {
    return this.list().find((row) => row.id === id);
  }

  /** md 原文。路径来自索引,仍做一次目录包含校验——索引文件是宿主写的,
   * 但"宿主写的就可信"这种话在这个仓里从来不成立。 */
  read(id: string): string | undefined {
    const found = this.find(id);
    if (!found) return undefined;
    const absolute = resolve(this.root, found.file);
    if (!contained(this.root, absolute)) return undefined;
    if (existsSync(absolute)) return readFileSync(absolute, "utf-8");
    // 归档的还能读:可见不可管,沉底不等于消失。
    const archived = resolve(this.root, MEMORY_ARCHIVE_DIR, found.file);
    if (contained(this.root, archived) && existsSync(archived)) {
      return readFileSync(archived, "utf-8");
    }
    return undefined;
  }

  /** 撤回 = 追加一条结论为空的覆盖记录。只有人圈的能撤,且只能作者撤:
   * 闭环批注和 Build-Fix 是事实,不是意见,事实不能撤。 */
  withdraw(id: string, by: string): MemoryRecord {
    const found = this.find(id);
    if (!found) throw new MemoryError(`记忆 ${id} 不存在`);
    if (found.withdrawn || found.superseded_by) {
      throw new MemoryError("这条记忆已经被撤回或覆盖");
    }
    if (found.source !== "user_note") {
      throw new MemoryError("只有人圈选记下的记忆可以撤回;闭环事实不撤");
    }
    if (found.author && found.author !== by) {
      throw new MemoryError(`这条记忆是 ${found.author} 记的,只能由本人撤回`);
    }
    return this.record({
      ...found,
      trigger: found.trigger,
      conclusion: "",
      evidence: `withdraw:${found.id}`,
      supersedes: found.id,
      author: by,
    }, { withdrawn: true });
  }
}

/** 台账:corpus/ledger.jsonl,只追加;stats() 一次读全,按 id 归并。 */
export class MemoryLedger {
  constructor(private readonly dataDir: string) {}

  get path(): string {
    return join(this.dataDir, MEMORY_DIR, "ledger.jsonl");
  }

  append(row: Omit<MemoryLedgerRow, "at"> & { at?: string }): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path,
      JSON.stringify({ at: row.at ?? new Date().toISOString(), ...row }) + "\n", "utf-8");
  }

  rows(): MemoryLedgerRow[] {
    return readJsonlRows<MemoryLedgerRow>(this.path)
      .filter((row) => row && typeof row.id === "string" && typeof row.kind === "string");
  }

  stats(): Map<string, MemoryStats> {
    const out = new Map<string, MemoryStats>();
    for (const row of this.rows()) {
      const own = out.get(row.id) ?? { ...EMPTY_STATS };
      switch (row.kind) {
        case "push": own.pushes += 1; own.last_used = row.at; break;
        case "search":
        case "expand": own.hits += 1; own.last_used = row.at; break;
        case "rework": own.reworks += 1; break;
        case "unanchored": own.unanchored_since ??= row.at; break;
        case "archive": own.archived_at = row.at; own.archive_reason = row.note; break;
        case "restore":
          own.archived_at = undefined; own.archive_reason = undefined; own.unanchored_since = undefined; break;
        default: break;
      }
      out.set(row.id, own);
    }
    return out;
  }
}

/** 效能页只读页签的数据形状(§9)。 */
export interface MemoryRepoInsight {
  repo: string;
  total: number;
  active: number;
  archived: number;
  withdrawn: number;
  one_off: number;
  pushes: number;
  hits: number;
  reworks: number;
}

export interface MemoryInsightRow {
  module?: string;
  product_versions?: string[];
  review?: MemoryReview;
  edited_by?: string;
  edited_at?: string;
  merged_into?: string;
  maintenance_note?: string;
  id: string;
  repo: string;
  trigger: string;
  conclusion: string;
  source: MemorySource;
  judged_by: MemoryJudge;
  scope: MemoryScope;
  draft: MemoryDraftState;
  drafting: boolean;
  at: string;
  task: string;
  paths: string[];
  line?: number;
  weight: number;
  pushes: number;
  hits: number;
  reworks: number;
  last_used?: string;
  archived?: boolean;
  archive_reason?: string;
  withdrawn?: boolean;
  superseded_by?: string;
}

export interface MemoryInsights {
  generated_at: string;
  /** 在途的起草作业数。 */
  drafting: number;
  sidecar: "ready" | "unavailable" | "absent";
  repos: MemoryRepoInsight[];
  memories: MemoryInsightRow[];
}

/** 来源仓库保留用于追溯；只有明确的平台范围可跨仓使用。 */
export function memoryAccessible(row: MemoryRecord, repo: string, modules: string[] = [], productVersion?: string): boolean {
  return row.review?.status === "accepted" && !row.withdrawn && !row.superseded_by && !row.archived
    && !row.merged_into
    && (!row.product_versions?.length || !productVersion || row.product_versions.includes(productVersion))
    && (row.module ? modules.includes(row.module) : row.repo === repo || row.scope === "platform");
}
