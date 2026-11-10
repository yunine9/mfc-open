/** Startup handshake for Cloud-only Mae-Flow execution contracts. */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface KernelCapabilityCheck {
  ready: boolean;
  continuous_review: boolean;
  agent_host_control?: boolean;
  detail: string;
  schema?: string;
}

export function probeKernelCapabilities(input: {
  kernelRoot: string;
  python?: string;
  cwd: string;
  timeoutMs?: number;
}): KernelCapabilityCheck {
  const script = join(input.kernelRoot, "scripts", "mae-flow.py");
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(
      input.python ?? "python3",
      [script, "capability", "status", "--json"],
      {
        cwd: input.cwd,
        encoding: "utf-8",
        timeout: input.timeoutMs ?? 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
  } catch (error) {
    return {
      ready: false,
      continuous_review: false,
      detail: `内核能力探测启动失败：${String(error)}`,
    };
  }
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stderr, result.stdout]
      .filter(Boolean).join("；").trim();
    return {
      ready: false,
      continuous_review: false,
      detail: `内核能力探测失败${detail ? `：${detail}` : ""}`,
    };
  }
  try {
    const lines = String(result.stdout ?? "").trim().split("\n").filter(Boolean);
    const value = JSON.parse(lines.at(-1) ?? "") as {
      schema?: unknown;
      capabilities?: { continuous_review?: unknown; agent_host_control?: unknown };
    };
    const schema = String(value.schema ?? "");
    const continuous = value.capabilities?.continuous_review === true;
    if (schema !== "mae-flow-capabilities/1" || !continuous) {
      return {
        ready: false,
        continuous_review: continuous,
        schema,
        detail: "内核未声明 continuous_review；拒绝把新任务静默降级到旧 end/init 生命周期",
      };
    }
    return {
      ready: true,
      continuous_review: true,
      agent_host_control: value.capabilities?.agent_host_control === true,
      schema,
      detail: "内核 continuous_review 能力已确认",
    };
  } catch (error) {
    return {
      ready: false,
      continuous_review: false,
      detail: `内核能力响应不是受支持的 JSON：${String(error)}`,
    };
  }
}

export function requireContinuousReviewCapability(input: {
  kernelRoot: string;
  python?: string;
  cwd: string;
  timeoutMs?: number;
}): KernelCapabilityCheck {
  const result = probeKernelCapabilities(input);
  if (!result.ready) {
    throw new Error(`持续检视内核不兼容，需求流程拒绝启动：${result.detail}`);
  }
  return result;
}
