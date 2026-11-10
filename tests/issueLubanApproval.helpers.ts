/**
 * issueLubanApproval 拆分后的共享夹具与辅助函数(原 tests/issueLubanApproval.test.ts 逐字搬移;
 * 2026-09-11 负载均衡拆分——node:test 按文件并行、文件内串行,60s+ 的
 * 单文件拖累全量墙钟)。不带 .test.ts 后缀,测试运行器不会执行本文件;
 * 各 part 按需 import,断言与测试行为零变化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { IssueFlowService } from "../src/issueFlow/service.ts";
import { IssueFlowLubanApproval } from "../src/issueFlow/lubanApproval.ts";
import { MockDtsGateway } from "../src/issueFlow/gateways.ts";
import { FakeLubanServer, Notifier } from "../src/notifier.ts";
import {
  lubanApprovalCode,
  LubanApprovalGateway,
  type LubanApprovalService,
} from "../src/lubanApproval.ts";
import type { TaskSummary } from "../src/taskService.ts";
import { mfcTemp } from "./mfcTmp.ts";
/**
 * 问题会话接入小鲁班手机审批的契约测试(与需求侧同一网关、同一审批码):
 * - 等待卡(平台闸卡与 Agent 问题卡)经适配层进网关,手机纯文本回复
 *   (裸序号/审批码)能落账到问题会话,后续回合照常续跑;
 * - 通知里的审批码与网关侧派码同源(同 token、同四元组),回复即达;
 * - 卡被抢先作答/状态漂移回"审批码已过期"(stale),不是 500;
 * - 码表标注「填写补充说明」的选项,手机必须带说明(与页面同纪律)。
 *
 * 范式与 issueFlowNotify.test.ts 同款:ScriptedModelServer 剧本 +
 * FakeLubanServer 假小鲁班,只走公开 API 断言。
 */


export const TICKET = "DTS-2026-1001";
export const TOKEN = "test-luban-plugin-token-32-bytes-minimum";

export async function until<T>(
  probe: () => T | undefined,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`等待超时:${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 与 serve.ts 同一条派码路:通知与网关共用同一 token,审批码才对得上。 */
export function makeNotifier(luban: FakeLubanServer): Notifier {
  return new Notifier({
    endpoint: luban.endpoint,
    mobileApproval: true,
    approvalCode: (input) => lubanApprovalCode({ token: TOKEN, ...input }),
    backoffMs: [0],
  });
}

export function makeGateway(
  sources: LubanApprovalService | LubanApprovalService[],
  notifier: Notifier,
): LubanApprovalGateway {
  return new LubanApprovalGateway(sources, {
    token: TOKEN,
    accountEnabled: () => true,
    recentNotification: (account) => notifier.latestApproval(account),
  });
}

export function reply(gateway: LubanApprovalGateway, content: string) {
  return gateway.handle({
    rawBody: JSON.stringify({
      message_id: `msg-${Math.random().toString(36).slice(2)}`,
      sender: "dev",
      content,
    }),
    token: TOKEN,
  });
}

export async function makeService(
  model: ScriptedModelServer,
  notifier: Notifier,
) {
  const service = new IssueFlowService({
    dataDir: mfcTemp("mfc-issue-luban-"),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
    dts: new MockDtsGateway(),
    notifier,
    linkBase: "https://mfc.example.com",
    // 这些用例验证的是“真人收到小鲁班审批卡并作答”的通路。默认
    // 二档会代答带推荐项的纯选择题，并有意抑制即将失效的通知；
    // 显式使用三档，避免把自动节奏和人工审批混在同一用例里。
    interventionTier: () => "3",
  });
  const created = service.create({
    account: "dev", title: "登录超时", ticket: TICKET, source: "dts",
  });
  return { service, id: created.id };
}

export const ANALYZE_SCRIPT: Scene[] = [
  { tool: { name: "complete_stage", input: { note: "单据已通读" } } },
  { tool: { name: "complete_stage", input: { note: "本单无需代码仓" } } },
  { tool: { name: "bash", input: { command:
    "printf '# 问题分析\\n\\n现象:登录超时。\\n## 问题现象\\n演示现象。\\n## 问题根因\\n连接池耗尽。\\n## 置信度\\n高:日志直接指向。\\n## 修改方案\\n超时回收。\\n' > issue-analysis.md" } } },
  { tool: { name: "submit_analysis",
    input: { summary: "根因=连接池耗尽,方案=超时回收" } } },
  { text: "分析报告已提交,等待用户确认。" },
];
