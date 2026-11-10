/**
 * Authoritative test-side flow preparation for platform orchestration tests.
 *
 * Delivery/MR/pre-push tests are not flow-engine tests.  They used to make the
 * scripted Agent overwrite `.mae-flow.json` from Bash, which both bypassed the
 * kernel and taught the fixture the exact unsafe behaviour production must
 * reject.  This controller keeps the real KernelHost/gates in the test while
 * moving fixture-only stage preparation to the trusted test process.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { ScriptedSceneContext } from "../../src/scriptedModel.ts";

export interface ManagedFlowFixtureOptions {
  branch?: string;
  ticket?: string;
  terminalStep?: "end" | "external_verify";
  /** Cloud continuous-review tests stop the Agent at external_verify; the
   * trusted pipeline command advances it to delivery_watch. */
  continuousReview?: boolean;
  /** Simulate an authoritative transport outage after the Agent has worked. */
  takeRepositoryOffline?: string;
}

function findState(root: string): string {
  const pending = [root];
  while (pending.length) {
    const directory = pending.shift()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === ".mae-flow.json") return path;
      if (entry.isDirectory()
          && !["node_modules", ".git", "agent"].includes(entry.name)) {
        pending.push(path);
      }
    }
  }
  throw new Error(`托管流程测试夹具在 ${root} 下找不到 .mae-flow.json`);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function readState(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeState(path: string, state: Record<string, any>): void {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Returns a ScriptedModel `beforeScene` callback.
 *
 * Scene 0: the trusted fixture places the real initialized flow at `build` and
 * creates the delivery branch.  The scripted Agent may only change business
 * files; the real gate still decides whether that tool call is legal.
 * Scene 1: after the tool result, the fixture commits the business change and
 * places the kernel at the delivery wait/terminal used by the platform test.
 */
export function managedFlowFixture(
  dataDir: string,
  options: ManagedFlowFixtureOptions = {},
): (context: ScriptedSceneContext) => void {
  const branch = options.branch ?? "master_bot_REQ9";
  const ticket = options.ticket ?? "REQ9";
  const terminal = options.terminalStep
    ?? (options.continuousReview ? "external_verify" : "end");
  let prepared = false;
  let finished = false;
  let feedbackPrepared = false;

  const prepareBuild = (statePath: string, cwd: string): void => {
    git(cwd, "config", "user.email", "bot@test");
    git(cwd, "config", "user.name", "bot");
    const state = readState(statePath);
    state.current = "build";
    state.revision = Number(state.revision ?? 0) + 1;
    state.execution_contract = {
      schema: "mae-flow-execution/1",
      host: "cloud",
      compile: "pipeline",
      ut_write: "agent",
      ut_run: "pipeline",
      codecheck: "pipeline",
      git_push: "host",
      ...(options.continuousReview ? { continuous_review: true } : {}),
      ...(state.execution_contract?.host_authority
        ? { host_authority: state.execution_contract.host_authority }
        : {}),
    };
    state.config = {
      ...(state.config ?? {}),
      "分支名": branch,
      "基线分支": "master",
      "单号": ticket,
    };
    const history = Array.isArray(state.history) ? state.history : [];
    if (!history.some((item: any) =>
      item?.step === "workflow_select" && item?.result === "done")) {
      history.push({ step: "workflow_select", result: "done" });
    }
    state.history = history;
    writeState(statePath, state);
  };

  const finishFlow = (statePath: string, cwd: string): void => {
    git(cwd, "add", "-A");
    if (git(cwd, "diff", "--cached", "--name-only")) {
      git(cwd, "commit", "--quiet", "-m", `[${ticket}][feat]测试交付提交`);
    }
    const state = readState(statePath);
    state.current = terminal;
    state.revision = Number(state.revision ?? 0) + 1;
    writeState(statePath, state);
  };

  return ({ index }) => {
    const statePath = findState(dataDir);
    const cwd = dirname(statePath);
    if (index === 0 && !prepared) {
      git(cwd, "checkout", "--quiet", "-B", branch);
      prepareBuild(statePath, cwd);
      prepared = true;
      return;
    }
    if (index === 1 && !finished) {
      finishFlow(statePath, cwd);

      const repository = options.takeRepositoryOffline;
      if (repository && existsSync(repository)) {
        const offline = `${repository}.offline`;
        if (existsSync(offline)) {
          throw new Error(`测试离线目标已存在: ${offline}`);
        }
        // Verify it is a real repository/directory before the destructive rename.
        if (!statSync(repository).isDirectory()) {
          throw new Error(`测试权威仓不是目录: ${repository}`);
        }
        renameSync(repository, offline);
      }
      finished = true;
      return;
    }

    // Continuous feedback stays in the same managed flow. Platform tests may
    // have another scripted tool pair; prepare/close that active feedback turn
    // from the trusted fixture too. CI/conflict repairs that are already at a
    // host wait remain untouched.
    const state = readState(statePath);
    const active = !["end", "external_verify"].includes(String(state.current));
    if (index >= 2 && active && !feedbackPrepared) {
      prepareBuild(statePath, cwd);
      feedbackPrepared = true;
      return;
    }
    if (index >= 3 && feedbackPrepared) {
      finishFlow(statePath, cwd);
      feedbackPrepared = false;
      return;
    }
    if (!finished && index > 1) {
      throw new Error(
        `托管流程测试夹具错过首轮收口: scene=${index} current=${state.current}`,
      );
    }
  };
}
