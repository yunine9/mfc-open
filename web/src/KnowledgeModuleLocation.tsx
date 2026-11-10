import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, FolderGit2, GitBranch, LoaderCircle, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { businessModuleKnowledgeRequest, type BusinessModuleKnowledgeLocationResult } from "./api";
import { componentRequest } from "./componentResearchApi";
import { checkKnowledgeRevision, subscribeKnowledgeRevisionChecks } from "./knowledgeRevision";

export function knowledgeLocationSettingsUrl(moduleId: string) {
  return `/configuration?tab=modules&module=${encodeURIComponent(moduleId)}&section=knowledge`;
}
const repositoryLabel = (value: string) => value.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/");

/** 正式阅读页只展示来源，长期绑定统一在配置中心维护。 */
export function KnowledgeModuleLocation({ moduleId, onSynced }: { moduleId: string; onSynced: () => void }) {
  const [value, setValue] = useState<BusinessModuleKnowledgeLocationResult>(), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const owner = useRef(moduleId); owner.current = moduleId;
  const refreshStatus = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true, reading = false, syncing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValue(undefined); setError(""); setBusy(false);
    const refresh = async () => {
      clearTimeout(timer);
      if (!live || reading || document.visibilityState !== "visible") return;
      reading = true;
      try {
        const next = await businessModuleKnowledgeRequest(moduleId);
        if (!live) return;
        const finished = syncing && next.sync?.state !== "syncing";
        syncing = next.sync?.state === "syncing";
        setValue(current => JSON.stringify(current) === JSON.stringify(next) ? current : next);
        setError("");
        if (finished) checkKnowledgeRevision();
      } catch (reason) { if (live) setError((reason as Error).message); }
      finally {
        reading = false;
        if (live && syncing && document.visibilityState === "visible") timer = setTimeout(refresh, 2000);
      }
    };
    refreshStatus.current = () => { void refresh(); };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") void refresh();
      else clearTimeout(timer);
    };
    const unsubscribe = subscribeKnowledgeRevisionChecks(() => { void refresh(); });
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => { live = false; clearTimeout(timer); unsubscribe(); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [moduleId]);
  const location = value?.location, sync = value?.sync;
  async function synchronize() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await componentRequest(`/business-modules/${encodeURIComponent(moduleId)}/knowledge-sync`, {}, AbortSignal.timeout(190_000));
      if (owner.current !== moduleId) return;
      refreshStatus.current(); onSynced();
    } catch (reason) { if (owner.current === moduleId) { setError((reason as Error).message); refreshStatus.current(); } }
    finally { if (owner.current === moduleId) setBusy(false); }
  }
  return <section className={`km-source-location ${value && !location ? "is-unconfigured" : ""}`} aria-label="领域知识来源">
    <FolderGit2 size={20} className="shrink-0 text-primary" />
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm"><strong className="font-medium">领域知识目录</strong>{location ? <><span className="truncate" title={location.repository}>{repositoryLabel(location.repository)}</span><span className="inline-flex items-center gap-1 text-muted-foreground"><GitBranch size={13} />{location.branch}</span><code className="break-all text-primary">{location.docs_path}/</code></> : <span className="text-muted-foreground">{value ? "平台领域知识仓尚未配置，请联系管理员" : error ? "来源读取失败" : "正在读取来源…"}</span>}</div>
      {location && <p className="mt-1 text-xs text-muted-foreground">{busy || sync?.state === "syncing" ? "正在同步远端正式文件…" : sync?.state === "failed" ? `同步失败${sync.synced_at ? "，当前保留上次成功内容" : "，尚无可用内容"}：${sync.error || "请重试"}` : sync?.synced_at ? `上次同步 ${new Date(sync.synced_at).toLocaleString("zh-CN")}${sync.commit ? ` · ${sync.commit.slice(0, 8)}` : ""}` : "保存目录后，点击同步读取远端文件。后续 MR 使用同一目录。"}</p>}
      {sync?.state === "partial" && <p role="status" className="mt-1 text-xs text-attention">部分同步：{sync.warnings?.join("；") || "部分关联代码仓暂未更新，已保留上次成功内容。"}</p>}
      {error && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
    </div>
    {location && <Button size="sm" variant="ghost" disabled={busy || sync?.state === "syncing"} onClick={() => void synchronize()}>{busy ? <LoaderCircle size={14} className="animate-spin" /> : <RefreshCw size={14} />}同步</Button>}
    <a href={knowledgeLocationSettingsUrl(moduleId)} className="km-location-settings"><Settings2 size={14} />调整路径<ArrowUpRight size={13} /></a>
  </section>;
}
