/** 问题侧环境预热直播(对齐清单⑤):分析阶段开头后台编译焐热缓存,
 *  原来用户只见神秘静默——现在直播命令输出(PrepushLiveLog 域中立,
 *  source 注入),结束后折叠成一行结果;基线红明确"环境的锅,与本单
 *  无关"。收据形状对齐 src/issueFlow/warmup.ts 的 IssueWarmupReceipt。 */

import { tailIssueWarmupEvents } from "../api";
import { PrepushLiveLog } from "../PrepushLiveLog";

export interface IssueWarmupReceiptView {
  status: "running" | "passed" | "infrastructure_failure" | "skipped";
  started_at: string;
  finished_at?: string;
  detail?: string;
  build_command?: string;
}

export function IssueWarmupLive({ id, warmup }: {
  id: string;
  warmup?: IssueWarmupReceiptView;
}) {
  if (!warmup) return null;
  if (warmup.status === "running") {
    return <PrepushLiveLog taskId={id}
      active source={tailIssueWarmupEvents}
      title="环境预热 · 正在编译基线(焐热缓存,分析继续,无需等待)"
      emptyText="等待预热 Agent 的第一条命令……" />;
  }
  return <div className={`issue-warmup-result is-${warmup.status}`}
    aria-label="环境预热结果" title={warmup.detail}>
    <i aria-hidden />
    <strong>{warmup.status === "passed" ? "环境预热完成"
      : warmup.status === "infrastructure_failure"
        ? "环境预热失败(基线/环境问题,与本单修复无关)"
        : "环境预热跳过"}</strong>
    {warmup.detail ? <span>{warmup.detail}</span> : null}
  </div>;
}
