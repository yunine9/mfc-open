import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

export const gitAiEnabled = () => process.env.MFC_GIT_AI_ENABLED === "1";
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type Context = { cwd: string; model?: { provider?: string; id?: string };
  sessionManager: { getSessionId(): string } };
type Call = { toolName: string; toolCallId: string; input?: Record<string, unknown> };
type Payload = Record<string, unknown>;

/** 归因命令使用既有非 root 容器后端，绝不在宿主执行仓库配置。 */
export class GitAiSession {
  private available?: boolean;
  private pending = new Map<string, Payload>();
  readonly binary: string;
  constructor(private readonly backend: BashOperations, private readonly workspace: string,
    private readonly log?: (message: string) => void, binary = process.env.MFC_GIT_AI_BIN ?? "/opt/git-ai/bin/git-ai") {
    this.binary = binary;
  }
  private warn(operation: string): void {
    // CLI 错误可能带有命令、仓库配置或凭据，不直接转发。
    try { this.log?.(`Git AI ${operation}未完成，代码操作继续；本次归因可能缺失`); } catch { /* 观察不影响执行 */ }
  }
  private async command(command: string, cwd = this.workspace): Promise<string> {
    let output = "";
    const result = await this.backend.exec(command, cwd, { onData: data => {
      output = (output + data.toString()).slice(-4 * 1024 * 1024);
    } });
    if (result.exitCode !== 0) throw new Error("Git AI command failed");
    return output;
  }
  private async ready(): Promise<boolean> {
    if (this.available === false) return false;
    try {
      if (!isAbsolute(this.binary)) throw new Error("Expected absolute container executable");
      // 仅初始化容器的临时目录，不复制模型凭据或完整会话。镜像可预配配置。
      await this.command(`test -x ${quote(this.binary)} && command -v timeout >/dev/null && `
        + `mkdir -p "$HOME/.git-ai" && if [ ! -f "$HOME/.git-ai/config.json" ]; then `
        + `(umask 077; printf '%s\\n' ${quote(JSON.stringify({ telemetry_oss: "off", disable_version_checks: true,
          disable_auto_updates: true, prompt_storage: "local", quiet: true, notes_backend: { kind: "git_notes" } }))}`
        + ` > "$HOME/.git-ai/config.$$.json"; ln "$HOME/.git-ai/config.$$.json" "$HOME/.git-ai/config.json" 2>/dev/null || true; rm -f "$HOME/.git-ai/config.$$.json"); fi`);
      this.available = true;
    } catch { this.available = false; this.warn("初始化"); }
    return this.available;
  }
  private cli(args: string[]): string {
    // 仅终止卡住的观察子进程。不能使用 TaskContainer timeout，它会销毁编码容器。
    return `timeout --kill-after=1s 15s ${quote(this.binary)} ${args.map(quote).join(" ")}`;
  }
  private async checkpoint(payload: Payload): Promise<void> {
    const output = await this.command(`printf '%s' ${quote(JSON.stringify(payload))} | `
      + this.cli(["checkpoint", "pi", "--hook-input", "stdin"])
      + ` && ${this.cli(["await", "--timeout", "10"])}`);
    // 上游在部分 checkpoint 失败时仍返回 0。
    if (/error:|failed to|checkpoint failed/i.test(output)) throw new Error("Checkpoint not recorded");
  }

  async before(event: Call, ctx: Context): Promise<void> {
    const tool = event.toolName.toLowerCase();
    if (!["edit", "write", "bash"].includes(tool)) return;
    try {
      if (!await this.ready()) return;
      const common: Payload = { session_id: ctx.sessionManager.getSessionId(),
        session_path: "/dev/null", cwd: ctx.cwd,
        model: [ctx.model?.provider, ctx.model?.id].filter(Boolean).join("/"),
        tool_name: tool, tool_name_raw: event.toolName, tool_use_id: event.toolCallId };
      if (tool === "bash") {
        await this.checkpoint({ ...common, hook_event_name: "before_command", command: event.input?.command });
      } else {
        if (typeof event.input?.path !== "string") return;
        const path = resolve(ctx.cwd, event.input.path);
        const fromRoot = relative(resolve(this.workspace), path);
        if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) return;
        common.path = path;
        await this.checkpoint({ ...common, hook_event_name: "before_edit",
          will_edit_filepaths: [path] });
      }
      this.pending.set(event.toolCallId, common);
    } catch { this.warn("修改前记录"); }
  }
  async after(event: { toolCallId: string }): Promise<void> {
    const common = this.pending.get(event.toolCallId);
    this.pending.delete(event.toolCallId);
    if (!common) return;
    try {
      if (common.tool_name === "bash") {
        await this.checkpoint({ ...common, hook_event_name: "after_command" });
      } else {
        const path = String(common.path);
        await this.checkpoint({ ...common, hook_event_name: "after_edit",
          edited_filepaths: [path] });
      }
    } catch { this.warn("修改后记录"); }
  }
  operations(): BashOperations {
    return { exec: async (command, cwd, options) => {
      const traced = [...this.pending.values()].some(call => call.tool_name === "bash")
        ? `export GIT_TRACE2_EVENT="af_unix:stream:$HOME/.git-ai/internal/daemon/trace2.sock"\n${command}`
        : command;
      return this.backend.exec(traced, cwd, options);
    } };
  }
}
