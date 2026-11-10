import type { ComponentKnowledgeCheckReport } from "../../src/componentKnowledgeTypes";
import { formatLocalDateTime } from "./time";

export function ComponentKnowledgeCheck({ report }: { report?: ComponentKnowledgeCheckReport }) {
  if (!report) return null;
  const planIssues = report.plans?.reduce((sum, p) => sum + p.findings.length + (p.error ? 1 : 0), 0) ?? 0;
  const exempt = report.findings.filter(f => f.exempt_reason).length;
  const shadow = report.findings.filter(f => f.level !== "warning").length;
  report = { ...report, findings: report.findings.filter(f => f.level === "warning" && !f.exempt_reason) };
  return <section aria-label="组件使用检查" className="mb-6 rounded-lg border border-line bg-surface p-4 text-sm">
    <h3 className="font-semibold">组件使用检查 · {planIssues ? `计划有 ${planIssues} 处需核对` : report.status === "incomplete" ? "检查未完成" : report.status === "not_applicable" ? "无适用规则" : report.findings.length ? `${report.findings.length} 处需核对` : shadow ? `${shadow} 处候选观察` : "本次无提示"}</h3>
    <p className="mt-2 text-muted-foreground">{report.trigger === "mr" ? "推送提交" : "代码工作区"} · {report.checked_files} 个文件 · {report.rules} 条规则 · {formatLocalDateTime(report.checked_at)}</p>
    {exempt > 0 && <p className="text-muted-foreground">已豁免 {exempt} 处</p>}
    {shadow > 0 && <p className="mt-2 text-muted-foreground">候选观察 {shadow} 处</p>}
    {report.warnings.map((w, i) => <p key={i} className="mt-2 break-words text-attention">{w}</p>)}
    {!!report.plans?.length && <details className="mt-3"><summary className="cursor-pointer text-primary">组件计划对照</summary>{report.plans.map(plan => <div key={plan.path} className="mt-3"><p>{plan.path}</p>{plan.error ? <p className="text-attention">{plan.error}</p> : plan.findings.length ? plan.findings.map((finding, i) => <p key={i} className="mt-1">{finding}</p>) : <p>未发现接口名层面的差异，设计约束仍需结合实现核对。</p>}</div>)}</details>}
    {report.findings.length > 0 && <details className="mt-3"><summary className="cursor-pointer text-primary">查看位置与推荐用法</summary>
      <ul className="mt-3 space-y-3">{report.findings.map((f, i) => <li key={i} className="break-words border-t border-line pt-3">
        <strong>{f.path}:{f.line}</strong><p>{f.need}：核对是否使用 {f.component} / {f.api.join("、")}</p>
        <p className="text-muted-foreground">适用条件：{f.applicability}</p>
        <a className="text-primary" href={`/?kbPage=module&kbModule=unassigned&knowledgeDocument=${encodeURIComponent(f.document_id)}`}>查看知识依据</a>
        <span className="ml-2 text-xs text-muted-foreground">{f.paradigm_id} · 原文第 {f.document_line} 行</span>
      </li>)}</ul>
    </details>}
    <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">检查版本</summary><p className="break-all">规则：{report.rules_digest}<br />提交：{report.head ?? "未取得"}<br />比较基线：{report.base ?? "未取得"}</p></details>
  </section>;
}
