/**
 * 内核宿主:云端合成 Hook 载荷,直接复用旧插件适配器当深层门禁引擎。
 *
 * `mae-flow/hooks/dispatch.py` 本来就是 CLI(stdin 单行 JSON → exit 2 =
 * 拦截/打回,文案在 stdout/stderr)。云端把语义事件合成为 sessionstart /
 * userprompt / pretooluse / posttooluse 载荷喂给它——内核零改动,
 * "机器只拦谎言"的全部契约(状态文件保护、伪证识别、证据登记、
 * 子 Agent 生命周期对账)原样生效。已实测:合成 pretooluse 对
 * `echo hacked > .mae-flow.json` 返回 exit 2 + 打回文案。
 *
 * 所有 dispatch 调用串行化:posttooluse 会写状态文件,与下一条
 * pretooluse 交错就是并发写状态——旧世界由宿主天然串行,这里用
 * promise 链保住同一语义。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SemanticEvent } from "./semanticEvents.ts";
import type { GateDecision } from "./gateService.ts";
import { createSafeGitView } from "./safeGit.ts";

export interface KernelHostOptions {
  /** mae-flow 内核仓根目录 */
  kernelRoot: string;
  /** 任务代码工作区(dispatch 的 cwd,即仓库克隆) */
  workspace: string;
  /** 文件工具可达的任务根。缺省与代码仓相同；Cloud 修复任务传代码仓
   * 的直接父目录，使 ../pipeline、../reviews 等任务材料可读写，同时
   * 源码识别与状态文件仍严格锚在 workspace。 */
  fileAccessRoot?: string;
  /** 云端主 transcript 路径(证据契约从这里取工具事实) */
  transcriptPath: string;
  taskId: string;
  python?: string;
  timeoutMs?: number;
  log?: (message: string) => void;
}

interface DispatchResult {
  code: number;
  stdout: string;
  stderr: string;
  infraError?: string;
}

export class KernelHost {
  private chain: Promise<unknown> = Promise.resolve();
  /** Cloud 托管任务已经完成机械启动握手。普通本地插件不经过这里，
   * INACTIVE 仍保持自由开发语义。 */
  private managed = false;

  constructor(readonly options: KernelHostOptions) {}

  /** 用户明确要求合入后继续修改。只由宿主在停止旧执行并保存历史后调用。
   * init 自己归档终态及清理授权；不改 current，不伪造 goto/审批记录。
   * 初始化成功但宿主尚未落盘时允许重试，不能重置已经开始实现的状态。 */
  async initializeNextDelivery(): Promise<void> {
    const before = this.flowState();
    if (before && !before.terminal) {
      if (before.current === "config_confirm") return;
      throw new Error(`内核仍在 ${before.current}，不能作为已合入任务重新初始化`);
    }
    this.requireSuccess("继续修改初始化", await this.spawnCli("init", ["init"]));
    const after = this.flowState();
    if (!after || after.terminal) throw new Error("继续修改初始化未建立新的内核执行状态");
  }

  /** 任务开工:sessionstart + userprompt(捕获需求原话、铺转发壳),
   * 返回内核自己的开工引导文本——首条 prompt 的组成部分,不由云端复述。 */
  async bootstrap(requirement: string): Promise<string> {
    this.requirement = requirement;
    const started = await this.dispatch("sessionstart", {});
    this.requireSuccess("sessionstart", started);
    const prompted = await this.dispatch("userprompt", {
      prompt: requirement,
    });
    this.requireSuccess("userprompt", prompted);
    return [started.stdout, prompted.stdout]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
  }

  /** Cloud 明确创建的是交付任务，不再让模型从需求措辞猜“要不要 init”。
   *
   * 新工作区只初始化一次；已有在途状态只读取 current。持续检视返工
   * 必须由宿主先执行 delivery feedback-open，绝不拿 init 重开任务。
   * 任一步失败都发生在模型会话创建之前，不能落入 INACTIVE 继续改码。 */
  async bootstrapManaged(requirement: string): Promise<string> {
    this.managed = true;
    this.requirement = requirement;
    const before = this.flowState();
    if (!before) {
      const initialized = await this.spawnCli("init", ["init"]);
      this.requireSuccess("init", initialized);
    }
    const active = this.flowState();
    if (!active) {
      throw new Error("内核 init 返回成功但未生成 .mae-flow.json，拒绝启动 Agent");
    }
    if (active.terminal) {
      throw new Error(
        "内核已终态，拒绝重新 init；请先由 Cloud 宿主打开持续检视反馈批次",
      );
    }

    // 状态先存在，再发 Hook 生命周期和需求原话。这样 userprompt 直接进
    // ACTIVE 台账，不再依赖“观察模型执行 init 后补发”的脆弱接缝。
    const started = await this.dispatch("sessionstart", {});
    this.requireSuccess("sessionstart", started);
    const prompted = await this.dispatch("userprompt", { prompt: requirement });
    this.requireSuccess("userprompt", prompted);
    this.requirementCaptured = true;
    const current = await this.spawnCli("current", ["current"]);
    this.requireSuccess("current", current);
    return [started.stdout, prompted.stdout, current.stdout,
      "文档自查：按现有模板写清范围、行为、验收条件和真实未决事项，对照用户原话修正实质遗漏。"
      + "文件名、章节和占位词检查不代表内容质量；local-spec validate 仅作按需结构诊断，"
      + "不要为格式差异重复补材料、重跑检视或索要确认。"
      + "缺少完成需求必需的信息或材料时如实说明并补齐；编译、UT、推送和流水线结果仍以真实执行为准。",
    ]
      .map((text) => text.trim())
      .filter(Boolean)
      .join("\n");
  }

  /** pretooluse:exit 2 → deny,打回文案原样给模型(exit 2+stderr 同构)。 */
  async preTool(event: SemanticEvent): Promise<GateDecision | undefined> {
    const payload = event.payload as Record<string, any>;
    let managedStateProblem = "";
    if (this.managed) {
      try {
        if (!this.flowState()) managedStateProblem = "内核状态不存在";
      } catch (error) {
        managedStateProblem = String(error);
      }
    }
    if (managedStateProblem) {
      const tool = String(payload.name ?? "");
      if (["Edit", "Write", "MultiEdit", "Bash", "Task", "Agent"]
          .includes(tool)) {
        return {
          action: "deny",
          reason: `Cloud 托管任务的内核状态缺失或不可读（${managedStateProblem}），`
            + "已阻止继续执行。"
            + "请停止重试并查看任务启动诊断；不得在 INACTIVE 状态修改代码。",
        };
      }
    }
    // tool_use_id 必须随 pretooluse 进内核:Agent 生命周期观察以它为
    // invocation_id,posttooluse 按同一 id 精确对账。缺了它内核只能
    // 自造 id + 按"当前步同类开放启动恰一条"兜底——同类子 Agent 并行
    // 派发时兜底判 ambiguous,两个返回全部丢失(run3 实测)。
    const result = await this.dispatch("pretooluse", {
      tool_name: payload.name,
      tool_input: payload.input,
      tool_use_id: payload.call_id,
      ...this.common(),
    });
    if (result.infraError || (result.code !== 0 && result.code !== 2)) {
      const detail = result.infraError
        ?? (result.stdout + "\n" + result.stderr).trim();
      // 宿主自己已带预算重试过(INFRA_ATTEMPTS);对 Agent 必须说明
      // "别再试了",否则每次重试都白烧三轮 dispatch 再拒,无限空转。
      return {
        action: "deny",
        reason: `内核门禁不可用，已安全拒绝本次工具调用: ${detail}。`
          + "宿主已重试过,请停止重试同类调用,把这次门禁故障如实写进"
          + "收口发言,交由人工处理。",
      };
    }
    if (result.code === 2) {
      const reason = (result.stdout + "\n" + result.stderr).trim();
      // 兜底句原来是零信息量的"被打回":内核没给原因时至少要给出路。
      return {
        action: "deny",
        reason: reason || "被 mae-flow 门禁打回(内核未附原因)。请不要"
          + "原样重试;执行 current 查看本步指引,或换合规路径。",
      };
    }
    return undefined;
  }

  /** posttooluse:证据登记、契约校验、Task 完成对账都走这条。
   *
   * 退 2 不是登记失败,是内核裁决完给模型的纠偏话(补模板章节、Task
   * 返回对账不符),单机形态里这段 stderr 由 harness 直接喂回模型——
   * 这里返回给调用方送回会话。只有 infra(重试后仍起不来)和其余非零
   * 才是真·登记失败。2026-08-20 内网实锤:IMPLEMENTATION 缺"定稿自查"
   * 一节,退 2 被当成登记失败,整单判死,push/MR 全没发生;而模型全程
   * 没见过那句"请补齐缺失章节"。 */
  async postTool(event: SemanticEvent): Promise<string | undefined> {
    const payload = event.payload as Record<string, any>;
    // AskUserQuestion 的回传形状是结构化 answers(问题→选项):
    // 内核 ack 的"整份背书"判定按结构而非措辞——键是配置项名的只代表
    // 单项,独立确认题才能替整份配置背书。包一层 content 会让 ack 只
    // 看到一坨 JSON 原文,永远判不出肯定回答(实测踩过)。
    const response =
      payload.name === "AskUserQuestion" && payload.answers
        ? { answers: payload.answers }
        : {
            content: [{ type: "text", text: String(payload.result ?? "") }],
            is_error: Boolean(payload.is_error),
            ...(["Task", "Agent"].includes(payload.name) ? {
              agentId: payload.child_session_id,
              status: payload.lifecycle ?? (payload.is_error ? "failed" : "returned"),
              completed_at: event.ts,
            } : {}),
          };
    const result = await this.dispatch("posttooluse", {
      tool_name: payload.name,
      tool_input: payload.input,
      tool_use_id: payload.call_id,
      tool_response: response,
      ...this.common(),
    });
    if (!result.infraError && result.code === 2) {
      await this.captureRequirementAfterInit(payload);
      return (result.stdout + "\n" + result.stderr).trim()
        || "[mae-flow] 已打回,内核未给出原因";
    }
    this.requireSuccess("posttooluse", result);
    await this.captureRequirementAfterInit(payload);
    return undefined;
  }

  /** Wait until every queued Hook write is durable before a turn can settle. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** 需求原话是 init 前发的,进不了 ACTIVE 台账(老宿主同样如此,
   * 靠用户重发恢复)。云端不折腾用户:观察到 init 成功后补发一次
   * userprompt 载荷,需求进台账,requirement-record --message-id 可用。 */
  private requirement = "";
  private requirementCaptured = false;

  private async captureRequirementAfterInit(
    payload: Record<string, any>,
  ): Promise<void> {
    if (this.requirementCaptured || !this.requirement) return;
    if (payload.name !== "Bash") return;
    const command = String(payload.input?.command ?? "");
    if (!/mae-flow\.py"?\s+init\b/.test(command)) return;
    if (!String(payload.result ?? "").includes("流程已初始化")) return;
    this.requirementCaptured = true;
    const result = await this.dispatch(
      "userprompt", { prompt: this.requirement });
    this.requireSuccess("userprompt(requirement)", result);
  }

  private requireSuccess(event: string, result: DispatchResult): void {
    if (!result.infraError && result.code === 0) return;
    const detail = result.infraError
      ?? ((result.stdout + "\n" + result.stderr).trim()
        || `exit ${result.code}`);
    throw new Error(`内核 ${event} 登记失败: ${detail}`);
  }

  private common(): Record<string, unknown> {
    return {
      cwd: this.options.workspace,
      workspace_root: this.options.fileAccessRoot ?? this.options.workspace,
      session_id: this.options.taskId,
      transcript_path: this.options.transcriptPath,
    };
  }

  /** 只读阶段事实，供宿主在重置已合入任务的代码目录前检查。 */
  flowState(): { current: string; terminal: boolean } | undefined {
    const statePath = join(this.options.workspace, ".mae-flow.json");
    if (!existsSync(statePath)) return undefined;
    let state: Record<string, any>;
    try {
      state = JSON.parse(readFileSync(statePath, "utf-8"));
    } catch (error) {
      throw new Error(`内核状态文件不可读，拒绝启动 Agent: ${String(error)}`);
    }
    const current = typeof state.current === "string" ? state.current : "";
    if (!current) throw new Error("内核状态缺少 current，拒绝启动 Agent");
    let terminal = current === "end";
    try {
      const flow = JSON.parse(readFileSync(
        join(this.options.kernelRoot, "flow", "flow.json"), "utf-8"));
      terminal = Boolean(flow?.steps?.[current]?.terminal);
    } catch {
      // 兼容测试桩与旧快照；现行主流程唯一终态就是 end。
    }
    return { current, terminal };
  }

  /** 基础设施故障重试:超时/起不来才重试,内核**答了**(退 0 或退 2)
   * 就是它的裁决,一次都不重试。
   *
   * 为什么要有这一层:门禁与证据登记现在是 fail-closed(登记失败还往下
   * 走,等于让没记账的动作过关),但 fail-closed 不等于"一次抖动就判死"
   * ——宿主负载高、python 冷启动、内网巨仓的一次 30 秒超时,不该让整轮
   * 白跑。先自己再试,试不动了再如实停。 */
  private static readonly INFRA_ATTEMPTS = 3;

  private async dispatchWithRetry(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    let last = await this.spawnDispatch(event, payload);
    for (let attempt = 2;
         last.infraError && attempt <= KernelHost.INFRA_ATTEMPTS;
         attempt += 1) {
      this.options.log?.(
        `${last.infraError},第 ${attempt}/${KernelHost.INFRA_ATTEMPTS} 次重试`);
      await new Promise((tick) =>
        setTimeout(tick, 200 * (attempt - 1)).unref());
      last = await this.spawnDispatch(event, payload);
    }
    if (last.infraError) {
      last = {
        ...last,
        infraError: `${last.infraError}(已重试 `
          + `${KernelHost.INFRA_ATTEMPTS} 次仍不可用)`,
      };
      this.options.log?.(
        `${last.infraError};门禁与证据登记按 fail-closed 处理,`
        + "任务如实收口请人工查看内核环境");
    }
    return last;
  }

  private dispatch(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const run = this.chain.then(() => this.dispatchWithRetry(event, payload));
    // 失败不断链:fail-open 由调用方语义决定,串行化必须继续。
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** 执行受信任的内核 CLI。仍使用安全 Git 视图，避免业务仓写入的
   * fsmonitor/filter/config 在宿主 init/current 期间获得执行机会。 */
  private spawnCli(label: string, args: string[]): Promise<DispatchResult> {
    const { kernelRoot, workspace } = this.options;
    let gitView: ReturnType<typeof createSafeGitView>;
    try {
      gitView = createSafeGitView(workspace);
    } catch (error) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: String(error),
        infraError: `内核 ${label} 无法建立安全 Git 视图: ${String(error)}`,
      });
    }
    return new Promise((resolve) => {
      let closed = false;
      const finish = (result: DispatchResult) => {
        if (closed) return;
        closed = true;
        gitView.cleanup();
        resolve(result);
      };
      const child = spawn(
        this.options.python ?? "python3",
        [join(kernelRoot, "scripts", "mae-flow.py"), ...args],
        {
          cwd: workspace,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...gitView.environment(), MAE_FLOW_HOOK_STRICT: "1" },
        },
      );
      let stdout = "";
      let stderr = "";
      let infraError = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => {
        infraError = `内核 ${label} 超时`;
        child.kill("SIGKILL");
      }, this.options.timeoutMs ?? 30_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal) infraError ||= `内核 ${label} 被信号 ${signal} 中断`;
        finish({
          code: code ?? (infraError ? 1 : 0),
          stdout,
          stderr,
          infraError: infraError || undefined,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        finish({
          code: 1,
          stdout,
          stderr: String(error),
          infraError: `内核 ${label} 启动失败: ${String(error)}`,
        });
      });
    });
  }

  private spawnDispatch(
    event: string,
    payload: Record<string, unknown>,
  ): Promise<DispatchResult> {
    const { kernelRoot, workspace } = this.options;
    const script = join(kernelRoot, "hooks", "dispatch.py");
    let gitView: ReturnType<typeof createSafeGitView>;
    try {
      gitView = createSafeGitView(workspace);
    } catch (error) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: String(error),
        infraError: `dispatch ${event} 无法建立安全 Git 视图: ${String(error)}`,
      });
    }
    return new Promise((resolve) => {
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        gitView.cleanup();
      };
      const child = spawn(
        this.options.python ?? "python3",
        [script, event],
        {
          cwd: workspace,
          stdio: ["pipe", "pipe", "pipe"],
          // dispatch.py 会间接执行很多 git status/diff/rev-parse。它们必须
          // 看真实 index/objects，却绝不能读取 Agent 可写的 .git/config。
          env: { ...gitView.environment(), MAE_FLOW_HOOK_STRICT: "1" },
        },
      );
      let stdout = "";
      let stderr = "";
      let infraError = "";
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => (stdout += chunk));
      child.stderr.on("data", (chunk: string) => (stderr += chunk));
      const timer = setTimeout(() => {
        // 这里只记事实,判不判死是 dispatchWithRetry 的事(可能只是抖了
        // 一下)。原来这行直接宣布"按 fail-closed 停止推进",而那时候
        // 还没试第二次,日志比真相严重。
        infraError = `dispatch ${event} 超时`;
        this.options.log?.(infraError);
        child.kill("SIGKILL");
      }, this.options.timeoutMs ?? 30_000);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (signal || code === 75) infraError ||= signal
          ? `dispatch ${event} 被信号 ${signal} 中断`
          : `dispatch ${event} 登记基础设施故障: ${stderr.trim()}`;
        cleanup();
        resolve({ code: code ?? (infraError ? 1 : 0), stdout, stderr,
                  infraError: infraError || undefined });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        cleanup();
        this.options.log?.(`dispatch ${event} 启动失败: ${String(error)}`);
        resolve({ code: 1, stdout: "", stderr: String(error),
                  infraError: `dispatch ${event} 启动失败: ${String(error)}` });
      });
      // stdin 的 error 必须有人接:子进程若在我们写之前就没了(超时被
      // SIGKILL、python 崩了、管道断了),EPIPE 会作为流上的 error 事件
      // 抛出来——**没有监听器的 error 事件是 uncaughtException,直接掀
      // 掉整个进程**。这是"通知/门禁一条旁路不许带走服务"红线里最不
      // 显眼的一个漏口:它连 Promise 都不经过,catch 拦不住。
      child.stdin.on("error", (error) => {
        infraError = `dispatch ${event} 写入失败: ${error}`;
        this.options.log?.(`${infraError}(当前任务按 fail-closed 停止推进)`);
      });
      child.stdin.write(JSON.stringify({ ...this.common(), ...payload }) + "\n");
      child.stdin.end();
    });
  }
}
