import { spawn, type ChildProcess } from "node:child_process";
import type {
  TaskCommandContainer,
  TaskContainerFactory,
  TaskContainerFactoryInput,
} from "../../src/taskService.ts";
import {
  TaskContainerExecTimeoutError,
  TaskContainerUnavailableError,
} from "../../src/containerRuntime.ts";
import { PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER } from
  "../../src/prepushEnvironment.ts";

export interface FakeContainerRecord {
  name: string;
  workspace: string;
  volumes: string[];
  started: boolean;
  stopped: boolean;
  stopCalls: number;
  commands: string[];
  commandTimeouts: Array<number | undefined>;
}

/** Docker daemon 不应成为编排单测的前提。这一后端仍真实执行普通的
 * fixture shell 命令，同时给长构建提供可由 stop/Abort 终止的挂起点。 */
export class FakeTaskContainerHarness {
  readonly records: FakeContainerRecord[] = [];
  readonly events: string[] = [];
  /** 专门验证“环境坏时不启动模型”的集成路径。 */
  preflightFailure?: string;
  /** 环境预检通过后的执行面故障，用于证明宿主会熔断而不是让模型重试。 */
  executionUnavailable?: "missing" | "stopped" | "inspect_unavailable";
  /** 模拟真实容器在第一次业务命令上耗尽墙钟预算。 */
  executionTimeoutSeconds?: number;

  readonly factory: TaskContainerFactory = (
    input: TaskContainerFactoryInput,
  ): TaskCommandContainer => {
    const record: FakeContainerRecord = {
      name: input.name,
      workspace: input.workspace,
      volumes: [...input.volumes],
      started: false,
      stopped: false,
      stopCalls: 0,
      commands: [],
      commandTimeouts: [],
    };
    this.records.push(record);
    const children = new Set<ChildProcess>();
    const held = new Set<() => void>();

    return {
      start: async () => {
        record.started = true;
        this.events.push(`start:${record.name}`);
      },
      exec: async (command, cwd, options) => {
        if (!record.started || record.stopped) {
          throw new Error(`fake container ${record.name} is not running`);
        }
        record.commands.push(command);
        record.commandTimeouts.push(options.timeout);
        this.events.push(`exec:${record.name}:${command}`);
        if (command.includes(PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER)) {
          if (this.preflightFailure) {
            options.onData(Buffer.from(
              `__MFC_PREPUSH_ENV_FAIL__:${this.preflightFailure}\n`,
            ));
            return { exitCode: 78 };
          }
          options.onData(Buffer.from(`${PRE_PUSH_ENVIRONMENT_SUCCESS_MARKER}\n`));
          return { exitCode: 0 };
        }
        if (this.executionUnavailable) {
          throw new TaskContainerUnavailableError(
            this.executionUnavailable,
            `simulated ${this.executionUnavailable}`,
          );
        }
        if (this.executionTimeoutSeconds !== undefined) {
          record.stopped = true;
          throw new TaskContainerExecTimeoutError(
            options.timeout ?? this.executionTimeoutSeconds,
          );
        }
        if (command.includes("__MFC_HOLD__")) {
          options.onData(Buffer.from("build is running\n"));
          return await new Promise<{ exitCode: number | null }>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              held.delete(finish);
              resolve({ exitCode: null });
            };
            held.add(finish);
            options.signal?.addEventListener("abort", finish, { once: true });
          });
        }
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          const child = spawn("sh", ["-lc", command], {
            cwd,
            env: { ...process.env, ...(options.env ?? {}) },
            stdio: ["ignore", "pipe", "pipe"],
          });
          children.add(child);
          child.stdout?.on("data", options.onData);
          child.stderr?.on("data", options.onData);
          let timer: NodeJS.Timeout | undefined;
          const terminate = () => child.kill("SIGKILL");
          if (options.timeout) {
            timer = setTimeout(terminate, options.timeout);
            timer.unref?.();
          }
          options.signal?.addEventListener("abort", terminate, { once: true });
          child.once("error", (error) => {
            children.delete(child);
            if (timer) clearTimeout(timer);
            reject(error);
          });
          child.once("close", (code) => {
            children.delete(child);
            if (timer) clearTimeout(timer);
            resolve({ exitCode: code });
          });
        });
      },
      stop: async () => {
        record.stopCalls += 1;
        if (record.stopped) return;
        record.stopped = true;
        this.events.push(`stop:${record.name}`);
        for (const finish of [...held]) finish();
        for (const child of children) child.kill("SIGKILL");
      },
    };
  };
}
