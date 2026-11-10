import { PersonName } from "../People";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/Empty";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList,
} from "@/components/ui/breadcrumb";
import type { WorkflowAssetDetail } from "../api";
import { technologyStackLabel } from "../technologyStacks";
import { useTechnologyStacks } from "../useTechnologyStacks";
import { statusBadgeVariants, statusLabels } from "./model";

export function WorkflowDetail({
  detail,
  loading = false,
  error,
  onBack,
  onEdit,
  onCopy,
  onSubmit,
  onWithdraw,
  onApprove,
  onReject,
  onArchive,
}: {
  detail?: WorkflowAssetDetail;
  loading?: boolean;
  error?: string;
  onBack: () => void;
  onEdit?: () => void;
  onCopy?: () => void;
  onSubmit?: () => void;
  onWithdraw?: () => void;
  onApprove?: () => void;
  onReject?: () => void;
  onArchive?: () => void;
}) {
  const { stacks } = useTechnologyStacks();
  if (loading) return <section className="wf-detail"><div className="wf-empty large">
    <strong>正在读取工作流…</strong><span>稍后会显示草稿和历史版本。</span>
  </div></section>;
  if (error || !detail) return <section className="wf-detail"><div className="wf-state-banner error">
    <strong>工作流详情不可用</strong><span>{error ?? "该资产可能已归档或你没有查看权限。"}</span>
    <button type="button" onClick={onBack}>返回资产库</button>
  </div></section>;
  const { asset, draft, versions } = detail;
  return <section className="wf-detail" aria-labelledby="wf-detail-title">
    <header className="wf-detail-head">
      <div>{/* #220 返回钮套进 Breadcrumb 原语:nav/列表语义归位,而
        「返回」的按钮语义经 render 原样保留(仍是真 button+onClick)。 */}
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink render={<button type="button" className="wf-breadcrumb-back" onClick={onBack} />}>
                <svg viewBox="0 0 20 20" aria-hidden><path d="m12 5-5 5 5 5" /></svg>
                <span>工作流</span>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <span><small>{asset.scope === "team" ? "团队工作流" : "个人工作流"}</small>
          <h2 id="wf-detail-title">{asset.name}</h2><p>{asset.description || "暂无说明"}</p></span></div>
      <Badge variant={statusBadgeVariants[asset.status]}>{statusLabels[asset.status]}</Badge>
    </header>
    <div className="wf-detail-summary">
      <div><small>当前草稿</small><strong>r{draft.revision}</strong><span>{shortDigest(draft.digest)}</span></div>
      <div><small>最新发布</small><strong>{asset.latest_version ? `v${asset.latest_version}` : "未发布"}</strong>
        <span>{versions.at(-1)?.published_at ? formatDate(versions.at(-1)!.published_at) : "—"}</span></div>
      <div><small>Owner</small><strong><PersonName account={asset.owner} /></strong><span>
        {asset.maintainers.length ? `${asset.maintainers.length} 位维护者` : "无额外维护者"}</span></div>
      {/* 说内容不报数:"3 个限定条件"回答不了"适用于哪"(审计 P2-17) */}
      {(() => {
        const scope = draft.definition.applicability;
        const parts = [...scope.repositories, ...scope.technologies.map(id => technologyStackLabel(id, stacks)),
          ...scope.business_module_ids];
        return <div><small>适用范围</small>
          <strong>{asset.technology_assignment_required ? "待补技术栈关联" : parts.length ? parts.slice(0, 2).join("、")
            + (parts.length > 2 ? "…" : "") : "不限"}</strong>
          <span title={parts.join("、")}>{asset.technology_assignment_required ? "补充技术栈关联后才能发布" : parts.length
            ? `共 ${parts.length} 项限定` : "全部任务可选"}</span></div>;
      })()}
    </div>
    <div className="wf-detail-actions">
      {asset.permissions.can_edit && onEdit && <button type="button" className="wf-primary" onClick={onEdit}>编辑草稿</button>}
      {onCopy && <button type="button" onClick={onCopy}>复制为新工作流</button>}
      {asset.permissions.can_submit && asset.status === "draft" && onSubmit &&
        <button type="button" onClick={onSubmit}>提交审核</button>}
      {asset.permissions.can_submit && asset.status === "pending_review" && onWithdraw &&
        <button type="button" onClick={onWithdraw}>撤回审核</button>}
      {asset.permissions.can_publish && asset.status === "pending_review" && onApprove &&
        <button type="button" className="wf-primary" onClick={onApprove}>审核通过并发布</button>}
      {asset.permissions.can_publish && asset.status === "pending_review" && onReject &&
        <button type="button" onClick={onReject}>驳回并说明原因</button>}
      {asset.permissions.can_archive && asset.status !== "archived" && onArchive &&
        <button type="button" className="wf-danger" onClick={onArchive}>
          {asset.status === "draft" && asset.latest_version === 0 ? "删除草稿" : "归档工作流"}
        </button>}
    </div>
    <div className="wf-detail-grid">
      <article><header><span><small>草稿基线</small><strong>{draft.definition.base.standard_id}</strong></span>
        <b>{draft.definition.base.standard_version}</b></header>
        <dl><div><dt>精确变更</dt><dd>{draft.definition.edits.length} 项</dd></div>
          <div><dt>业务模块</dt><dd>{listOrAll(draft.definition.applicability.business_module_ids)}</dd></div>
          <div><dt>代码仓</dt><dd>{listOrAll(draft.definition.applicability.repositories)}</dd></div>
          <div><dt>技术栈</dt><dd>{asset.technology_assignment_required ? "待补技术栈关联"
            : listOrAll(draft.definition.applicability.technologies.map(id => technologyStackLabel(id, stacks)))}</dd></div></dl>
        <footer>更新于 {formatDate(draft.updated_at)} · {draft.updated_by}</footer></article>
      <article><header><span><small>发布历史</small><strong>{versions.length} 个不可变版本</strong></span></header>
        {versions.length ? <ol className="wf-version-list">{[...versions].reverse().map((version) => <li key={version.version}>
          <strong>v{version.version}</strong><span><b>{shortDigest(version.digest)}</b>
            <small>{formatDate(version.published_at)} · {version.published_by}</small></span></li>)}</ol>
          : <Empty className="border p-5"><EmptyTitle>还没有发布版本</EmptyTitle>
            <EmptyDescription>个人工作流由所有者发布；团队工作流需要管理员审核。</EmptyDescription></Empty>}
      </article>
    </div>
    {asset.copied_from && <p className="wf-copy-source">复制来源：{asset.copied_from.id}
      {asset.copied_from.version ? ` · ${asset.copied_from.version}` : ""}
      {asset.copied_from.digest ? ` · ${shortDigest(asset.copied_from.digest)}` : ""}</p>}
  </section>;
}

function listOrAll(values: string[]): string {
  return values.length ? values.join("、") : "不限定";
}

function shortDigest(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("zh-CN", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
