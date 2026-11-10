import { useState } from "react";
import { diffLines } from "diff";
import { Button } from "@/components/ui/button";
import { documentRequest, type KnowledgeDocument } from "./knowledgeDocumentsApi";
import { KnowledgeMarkdown } from "./KnowledgeMarkdown";

interface Version { revision:string; title:string; published_at:string; operator:string }
export function KnowledgeVersions({ document, onRestored }: { document:KnowledgeDocument; onRestored:()=>void }) {
  const [versions,setVersions]=useState<Version[]>(), [snapshot,setSnapshot]=useState<KnowledgeDocument>(), [error,setError]=useState(""), [busy,setBusy]=useState(false), [compare,setCompare]=useState(true);
  async function load(){try{setVersions((await documentRequest<{versions:Version[]}>(`/${document.id}/versions`)).versions);}catch(e){setError((e as Error).message);}}
  return <details className="mt-5 border-t border-line pt-3 text-sm" onToggle={e=>{if(e.currentTarget.open&&!versions)void load();}}><summary className="text-muted-foreground cursor-pointer">已发布版本</summary>
    {error&&<p role="alert" className="my-3 text-danger">{error}</p>}<div className="my-3 flex flex-wrap gap-2">{versions?.map((v,i)=><Button key={v.revision} size="sm" variant={snapshot?.revision===v.revision?"default":"outline"} onClick={async()=>{try{setSnapshot((await documentRequest<{document:KnowledgeDocument}>(`/${document.id}/versions/${v.revision}`)).document);}catch(e){setError((e as Error).message);}}}>v{versions.length-i}{v.revision===document.revision?" · 当前":""} · {new Date(v.published_at).toLocaleDateString()}</Button>)}</div>
    {snapshot&&<div className="rounded-lg border border-line p-4"><div className="mb-4 flex items-center justify-between gap-3"><label className="flex items-center gap-2"><input type="checkbox" checked={compare} onChange={e=>setCompare(e.target.checked)}/>与当前版本比较</label>{snapshot.revision!==document.revision&&<Button size="sm" variant="outline" disabled={busy} onClick={async()=>{setBusy(true);setError("");try{await documentRequest(`/${document.id}/restore`,{revision:snapshot.revision,expected_revision:document.revision});setSnapshot(undefined);setVersions(undefined);onRestored();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>恢复为新版本</Button>}</div>{compare?<pre className="whitespace-pre-wrap break-words text-sm">{diffLines(snapshot.content??"",document.content??"").map((part,i)=><span key={i} className={part.added?"bg-green-500/15":part.removed?"bg-red-500/15 line-through":""}>{part.value}</span>)}</pre>:<KnowledgeMarkdown text={snapshot.content??""}/>}</div>}
  </details>;
}
