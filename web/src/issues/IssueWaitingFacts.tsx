/**
 * 查看模式的等待卡事实面(#127 自 IssueRail 迁出,rail 随右栏侧栏拆除):
 * 决策背景、题面与选项照常陈列(替归属人判断卡在哪、值不值得催),作答
 * 控件一个不渲染。流水线红灯人工闸(票 03)如实点名"等归属人处理",
 * 其余闸沿用通用文案。
 *
 * 挂载点(#125 卡座):会话视图把当前等待卡按身份分派——归属人拿
 * IssueDecisionCard,查看者拿本事实卡——经 currentCard 钉进协作流末尾
 * 的 Agent 气泡;组件只管排版,不感知挂载位置。
 */
import type { IssueWaitingCard } from "../api";
import { Markdown } from "../markdown";

export function IssueWaitingFacts({ waiting }: { waiting: IssueWaitingCard }) {
  const questions = waiting.question?.questions ?? [];
  const head = waiting.gate_kind === "pipeline_unfixable"
    ? "等归属人在交付平台处理/豁免流水线告警"
    : waiting.gate_kind === "pipeline_evidence"
      ? "等归属人贴回流水线报错原文"
      : waiting.gate_kind === "env_needed"
        ? `等归属人配置网管环境(${waiting.gate_scope === "deploy" ? "换库部署" : "拉取日志"}需要)`
        : waiting.gate_kind === "env_verify"
          // 通过无需作答,合入即通过(ADR-0034)——等的是验证不是答复。
          ? "等归属人验证修复效果(通过无需作答,MR 全部合入即视为通过)"
          : "等归属人答复";
  return <div className="issue-rail-card is-waiting">
    <strong>{head}</strong>
    {waiting.context && <div className="issue-waiting-context">
      <Markdown text={waiting.context} />
    </div>}
    {questions.map((item, index) => <div key={index}
      className="issue-waiting-question">
      <p>{index + 1}. {item.question || "需要归属人确认"}</p>
      {item.options.length > 0 && <ul className="issue-waiting-options">
        {item.options.map((option) => <li key={option.code}>{option.label}</li>)}
      </ul>}
    </div>)}
    {questions.length === 0 && !waiting.context && <p>
      会话正等一张问题卡的答复,题面还没取到。</p>}
    <small>查看模式:作答入口只有归属人可见。</small>
  </div>;
}
