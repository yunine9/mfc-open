import { useState } from "react";

/** 兜底是查询事实，不是强制完成；失败与歧义均留在按钮旁可见。 */
export function RefreshMrButton({ taskId, onChanged }: { taskId: string; onChanged(): void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [candidates, setCandidates] = useState<Array<{ id: string | number; url: string }>>([]);
  async function refresh(mrId?: string) {
    if (busy) return;
    setBusy(true); setError(false); setMessage("");
    try {
      const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/refresh-mr`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mr_id: mrId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "查询失败，请重试");
      setMessage(result.message); setCandidates(result.candidates ?? []);
      await onChanged();
    } catch (reason) { setError(true); setMessage(reason instanceof Error ? reason.message : "查询失败，请重试"); }
    finally { setBusy(false); }
  }
  return <span className="diagnostics-action">
    <button type="button" className="diagnostics-link" disabled={busy} onClick={() => void refresh()}>
      {busy ? "正在查询 MR…" : "刷新 MR 状态"}
    </button>
    {message && <small role={error ? "alert" : "status"}>{message}</small>}
    {candidates.map(mr => <span key={mr.id}>
      <a href={mr.url} target="_blank" rel="noreferrer">MR !{mr.id} ↗</a>{" "}
      <button type="button" className="diagnostics-link" disabled={busy} onClick={() => void refresh(String(mr.id))}>关联此 MR</button>
    </span>)}
  </span>;
}
