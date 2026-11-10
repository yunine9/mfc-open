/**
 * 提单模板卡(ADR-0048):确认是问题闭环的会话,把平台产出的提单文稿
 * (单据标题+登记元信息+分析报告全文+「参考」两节防采信说明)原样展示
 * 并一键复制,测试拿去 DTS 提单系统。登记人(查看模式)与责任人同看
 * 这一张——读路由登录即可。模板缺席(404)整卡不渲染;加载失败只降
 * 说明行,不挡会话页其他内容(fail-open)。
 */
import { useEffect, useState } from "react";
import { ClipboardCheck, ClipboardCopy, FileText } from "lucide-react";
import { getIssueTicketTemplate } from "../api";

export function TicketTemplateCard({ issueId }: { issueId: string }) {
  const [template, setTemplate] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    getIssueTicketTemplate(issueId).then((text) => {
      if (alive) setTemplate(text);
    }).catch(() => {
      if (alive) setFailed(true);
    });
    return () => { alive = false; };
  }, [issueId]);

  if (!template && !failed) return null;
  if (failed) return <section
    aria-label="提单模板"
    className="rounded-lg border border-line bg-surface px-4 py-3 text-[13px] text-muted-foreground">
    提单模板加载失败,可稍后重试。
  </section>;

  const copy = async () => {
    if (!template) return;
    try {
      await navigator.clipboard.writeText(template);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 剪贴板不可用:模板全文可见,手动选中复制。 */ }
  };

  return <section
    aria-label="提单模板"
    className="overflow-hidden rounded-lg border border-line bg-surface">
    <div className="flex items-center gap-2 border-b border-line bg-surface-2/70 px-4 py-2.5">
      <FileText size={15} className="text-muted-foreground" />
      <h3 className="text-[13px] font-semibold text-text-strong">提单模板</h3>
      <span className="text-xs text-muted-foreground">复制进 DTS 提单系统提单</span>
      <button type="button" onClick={copy}
        className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-text transition-colors hover:bg-primary/10 hover:text-primary">
        {copied
          ? <><ClipboardCheck size={13} className="text-success" />已复制</>
          : <><ClipboardCopy size={13} />一键复制</>}
      </button>
    </div>
    <pre className="max-h-72 overflow-auto px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text">{template}</pre>
  </section>;
}
