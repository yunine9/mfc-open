/**
 * 团队看板里的问题会话卡片:IssueCard 的轻量子集,只为团队看板的
 * 扫读态服务——不拉 IssueBoard 的重组件(Registration/SessionView/
 * EventsPane),不破坏问题处理页的懒加载分包。
 *
 * 与 TaskCard 共用 task-overview-row class,列表混排视觉一致;
 * 整行是新页签链接(ADR-0040):打开问题工作台不再页内跳转,
 * 团队页现场不被带走。
 */
import { TaskOverviewRow } from "../TaskOverviewRow";
import { issueStageText, issueStatusText, type IssueSummary } from "../api";
import { issueSessionPath } from "./issueLink";

export function TeamIssueCard({ issue }: { issue: IssueSummary }) {
  const stageLine = [
    issueStageText(issue),
    issue.round && issue.round > 1 ? ` · 第 ${issue.round} 轮` : "",
    issue.stage_note ? ` · ${issue.stage_note}` : "",
  ].join("");
  return <TaskOverviewRow issue id={issue.id} ticket={issue.ticket}
    title={issue.title} status={issue.status} statusLabel={issueStatusText(issue)}
    owner={issue.account} updatedAt={issue.updated_at} detail={stageLine}
    href={issueSessionPath(issue.id)} />;
}
