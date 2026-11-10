/**
 * tool_requested 的同步裁决点(详设 §4/D3)。
 *
 * 在进程内集成里,拦截通过 pi 的 tool_call 扩展钩子实现:
 * 钩子返回 {block, reason} → reason 成为模型看到的错误工具结果,
 * 与旧插件 exit 2 + stderr 打回文案同构。
 *
 * 深层契约(gate-edit/gate-bash 的证据链)是内核的领地,经 contract
 * 端口注入——接线形态是调用容器内的内核 CLI(python mae-flow.py gate),
 * 不在 TS 里复刻规则。演练默认保留 fail-open；正式任务可显式启用
 * fail-closed，避免门禁/证据登记故障被解释成“允许执行”。
 */

import type { SemanticEvent } from "./semanticEvents.ts";
import { lstatSync, realpathSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

export type GateAction = "allow" | "deny" | "human" | "agent";

export interface GateDecision {
  action: GateAction;
  reason?: string;
}

export const ALLOW: GateDecision = { action: "allow" };

export type GateContract = (
  tool: string,
  value: string,
  event: SemanticEvent,
) => GateDecision | undefined;

/** 宿主自己的账本:在工作区里但不属于会话。读随便读(那都是它自己的
 * 记录),写一律拒绝——伪造事件流/等待记录/流水线事实等于伪造证据。
 * 路径按相对工作区根判定,目录项连同其下全部内容。 */
const HOST_LEDGERS = [
  "events.jsonl", "transcript.jsonl", "waiting.json", "task.json",
  "annotations.jsonl", "pipeline-facts.json", "feedback/index.jsonl",
];
const HOST_LEDGER_DIRS = [".pi", ".claude"];
/** 会话运行时目录:`pi-agent/models.json` 明文存着模型网关 API Key,
 * 所以这里连读都不给——把可达边界放宽到工作区(修复材料在仓外)的
 * 同时,必须把这一格重新焊死,否则等于把密钥递到会话手上。 */
const HOST_SECRET_DIRS = ["pi-agent"];

export interface GateServiceOptions {
  moonlight?: boolean;
  contract?: GateContract;
  /** 追加的宿主账本(相对工作区根):问题流这类旁路会话有自己的
   * 状态文件(issue.json)与注入的技能目录,同样不允许 Agent 改写。
   * dirs 连同其下全部内容,files 认工作区根下的精确相对路径。 */
  extraLedgerDirs?: string[];
  extraLedgerFiles?: string[];
  /** 文件工具的可达边界=**任务工作区**(含代码仓与仓外的修复材料)。
   *
   * 踩过的坑:边界一度锚在代码仓上,而修复使命指挥模型读 ../pipeline/
   * 的完整失败日志、写 ../review_replies.md 的逐条检视回复——两者都在
   * 仓外,于是 Read/Write 被拒(Bash 不走这条路,所以测试全绿也照样没
   * 逮住)。检视修复环因此第一轮就死:回复文件写不出来,宿主发布环节
   * 空转,下一轮判"同一批意见处理过一轮仍未答复完"直接停机。
   * 边界的本意是"别跑出这个任务",不是"别出代码仓"。 */
  workspace?: string;
  /** 相对路径的解析基准=代码仓(会话的 cwd)。模型写的 `../pipeline/x`
   * 是相对它的工作目录说的,不是相对工作区根;两者混用会把仓内相对
   * 路径解析到工作区根上去。缺省时同 workspace。 */
  cwd?: string;
  /** 正式任务的安全边界。开启后，门禁契约本身抛错会拒绝本次工具调用，
   * 不会悄悄落回宿主执行。缺省 false 仅为演练和旧调用兼容。 */
  failClosed?: boolean;
  log?: (message: string) => void;
}

export class GateService {
  private readonly moonlight: boolean;
  private readonly contract?: GateContract;
  private readonly ledgerDirs: readonly string[];
  private readonly ledgerFiles: readonly string[];
  private readonly workspace?: string;
  private readonly cwd?: string;
  private readonly failClosed: boolean;
  private readonly log: (message: string) => void;

  constructor(options: GateServiceOptions = {}) {
    this.moonlight = Boolean(options.moonlight);
    this.contract = options.contract;
    this.ledgerDirs = [
      ...HOST_LEDGER_DIRS, ...(options.extraLedgerDirs ?? []),
    ];
    this.ledgerFiles = [
      ...HOST_LEDGERS, ...(options.extraLedgerFiles ?? []),
    ];
    this.workspace = options.workspace
      ? realpathSync(resolve(options.workspace))
      : undefined;
    this.cwd = options.cwd
      ? realpathSync(resolve(options.cwd))
      : this.workspace;
    this.failClosed = Boolean(options.failClosed);
    this.log = options.log ?? (() => {});
  }

  decide(event: SemanticEvent): GateDecision {
    try {
      return this.route(event);
    } catch (error) {
      const mode = this.failClosed ? "closed" : "open";
      this.log(`gate fail-${mode}: ${String(error)}`);
      if (!this.failClosed) return ALLOW;
      // "请稍后重试"是循环邀请函:同一个确定性异常会一直在,Agent 会
      // 无预算空转(红线:凡引入等待必须带预算或出路)。出路只有一条
      // ——如实停下让人接手。
      return {
        action: "deny",
        reason: "任务安全门禁暂时不可用，本次工具调用已阻止。请**停止重试**"
          + "同类调用，把这次门禁故障如实写进收口发言，交由人工处理。",
      };
    }
  }

  private route(event: SemanticEvent): GateDecision {
    const payload = event.payload as Record<string, any>;
    const tool = String(payload.name ?? "");
    const input = (payload.input ?? {}) as Record<string, any>;
    if (tool === "AskUserQuestion") {
      if (this.moonlight) {
        return {
          action: "deny",
          reason: "月光宝盒模式下不提问;按既定决定继续,待办已记录。",
        };
      }
      // D4:永不真实执行,转 Web 待办;决定以工具结果按 call_id 回注。
      return { action: "human" };
    }
    if (tool === "Task" || tool === "Agent") return { action: "agent" };
    if (
      tool === "Read" || tool === "Edit" || tool === "Write"
      || tool === "MultiEdit"
    ) {
      // Pi 的内建文件工具使用 `path`;旧宿主/Claude Hook 使用
      // `file_path`. 真实执行字段必须优先,否则 Pi 的写入会以空值绕过
      // 注入契约。仓库边界由知道任务 workspace 的内核 pretool 统一裁决。
      const paths = [input.path, input.file_path]
        .filter((value, index, values) =>
          typeof value === "string" && value
          && values.indexOf(value) === index) as string[];
      const escaped = this.workspace
        ? paths.find((path) => !this.insideWorkspace(path))
        : undefined;
      if (escaped) {
        // realTarget 解析失败(NUL/Windows 形态/符号链环/权限)也走到这:
        // 路径可能其实在工作区内。文案必须把两种情况都说了并给出边界,
        // 否则 Agent 会换等价写法反复撞同一堵墙。
        return {
          action: "deny",
          reason: `文件工具只能访问当前任务的工作区（${this.workspace}），`
            + `已阻止: ${escaped}。若该路径确实在工作区内,说明它无法被安全`
            + "解析(特殊字符/符号链接),请改用工作区内的相对普通路径;"
            + "不要反复变换写法重试。",
        };
      }
      const secret = paths.find(
        (path) => this.hitsHostPath(path, HOST_SECRET_DIRS, []));
      if (secret) {
        return {
          action: "deny",
          reason: `会话运行时目录里有宿主凭据,禁止访问: ${secret}。`,
        };
      }
      if (tool !== "Read") {
        const ledger = paths.find(
          (path) => this.hitsHostPath(path, this.ledgerDirs, this.ledgerFiles));
        if (ledger) {
          return {
            action: "deny",
            reason: `这是宿主的账本,不是你的产物,禁止写入: ${ledger}。`
              + "要说的话写进你的收口发言,或写到使命指定的文件里。",
          };
        }
      }
      return this.deep(tool, paths[0] ?? "", event);
    }
    if (tool === "Bash") {
      return this.deep(tool, String(input.command ?? ""), event);
    }
    return ALLOW;
  }

  private deep(tool: string, value: string, event: SemanticEvent): GateDecision {
    if (!this.contract || !value) return ALLOW;
    return this.contract(tool, value, event) ?? ALLOW;
  }

  /** 解析成真实绝对路径;解析不了(畸形/软链跳出)返回空串。 */
  private realTarget(value: string): string {
    if (!this.cwd || !value || value.includes("\0")) return "";
    if (/^[A-Za-z]:[^\\/]/.test(value)) return "";
    // POSIX 上不能把 Windows 绝对/盘符相对路径当成带冒号的普通文件名。
    if (process.platform !== "win32" && /^(?:[A-Za-z]:|[\\/]{2})/.test(value)) {
      return "";
    }
    const normalized = sep === "/" ? value.replaceAll("\\", "/") : value;
    const target = resolve(this.cwd, normalized);

    // 目标可以尚不存在；解析最近的已存在祖先，阻止仓内软链跳到仓外。
    let ancestor = target;
    const missing: string[] = [];
    while (true) {
      // existsSync 对悬空软链也返回 false，会误当成待创建的普通文件。
      // lstat 先认出链接，再交给 realpath；解析失败就拒绝，不能越界写入。
      try { lstatSync(ancestor); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "";
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return "";
      missing.push(basename(ancestor));
      ancestor = parent;
    }
    try {
      return resolve(realpathSync(ancestor), ...missing.reverse());
    } catch {
      return "";
    }
  }

  private insideWorkspace(value: string): boolean {
    const target = this.realTarget(value);
    return target ? this.descendsFromWorkspace(target) : false;
  }

  /** 命中宿主的某类路径(按工作区根下的相对路径判,不看会话在哪个
   * 子目录):dirs 连同其下全部内容,files 只认工作区根下的同名文件。 */
  private hitsHostPath(
    value: string,
    dirs: readonly string[],
    files: readonly string[],
  ): boolean {
    if (!this.workspace) return false;
    const target = this.realTarget(value);
    if (!target) return false;
    const rel = relative(this.workspace, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
    const parts = rel.split(sep);
    // dirs 支持嵌套条目(如问题流的 .mae-flow-work/host-skills):按
    // 相对路径整体做前缀匹配,不能只看首段——首段匹配让带斜杠的条目
    // 永远落空,注入的只读投影对 Agent 变成可写(2026-09-04 探针实锤)。
    // files 认工作区根下的精确相对路径(feedback/index.jsonl 形状,
    // join("/") 顺带归一 Windows sep)。
    return dirs.some((dir) => rel === dir || rel.startsWith(`${dir}${sep}`))
      || files.includes(parts.join("/"));
  }

  private descendsFromWorkspace(target: string): boolean {
    if (!this.workspace) return false;
    const rel = relative(this.workspace, target);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".."
      && !isAbsolute(rel));
  }
}
