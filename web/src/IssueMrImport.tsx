import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { importIssueMr, type IssueSummary } from "./api";

/** 仅接收 MR，成功后进入现有问题工作台，不维护另一套状态或过程界面。 */
export function IssueMrImport({ onCreated, visible }: { onCreated: (issue: IssueSummary) => void; visible: boolean }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form hidden={!visible} aria-label="从已有 MR 开始" className="rounded-xl border border-line bg-surface p-5" onSubmit={async event => {
    event.preventDefault(); if (busy || !url.trim()) return;
    setBusy(true); setError("");
    try { onCreated(await importIssueMr(url.trim())); }
    catch (error) { setError(error instanceof Error ? error.message : "接入 MR 失败，请重试"); }
    finally { setBusy(false); }
  }}>
    <label htmlFor="issue-mr-url" className="mb-2 block text-sm font-medium text-text-strong">MR 链接</label>
    <div className="flex items-center gap-3"><Input id="issue-mr-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="粘贴 CodeHub MR 链接" className="min-w-0 flex-1" /><Button type="submit" disabled={busy || !url.trim()}>{busy ? "正在接入…" : "开始修复"}</Button></div>
    <p className="mb-0 mt-2 text-sm text-muted-foreground">拉取 MR 源分支，检查报错并修复；记录只保留在本工具，不计入 DTS 交付数据。</p>
    {error && <p role="alert" className="mb-0 mt-3 text-sm text-danger">{error}</p>}
  </form>;
}
