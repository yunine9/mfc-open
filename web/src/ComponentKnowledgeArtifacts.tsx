import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ComponentDocumentReader } from "./ComponentDocumentReader";
import { componentRequest } from "./componentResearchApi";

type Artifacts = { document_id: string; document_revision: string; source_digest: string; files: Record<string, string> };
export function ComponentKnowledgeArtifacts({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<Artifacts>(), [file, setFile] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    let live = true; setData(undefined); setError("");
    if (id) void componentRequest<Artifacts>(`/component-knowledge/${encodeURIComponent(id)}/artifacts`).then(result => {
      if (live) { setData(result); setFile(Object.keys(result.files).find(p => p.includes("/rules/")) ?? "source.md"); }
    }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id]);
  function download() {
    if (!data || !file) return;
    const url = URL.createObjectURL(new Blob([data.files[file]], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = file.split("/").at(-1)!; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <Dialog open={!!id} onOpenChange={value => { if (!value) onClose(); }}><DialogContent className="tw-root h-[96dvh] w-[98vw] max-w-none grid-rows-[auto_minmax(0,1fr)] sm:max-w-none">
    <DialogHeader><DialogTitle>程序化产物</DialogTitle></DialogHeader>
    {error ? <p role="alert" className="text-danger">{error}</p> : !data ? <p>正在从当前知识生成产物…</p> : <ComponentDocumentReader allowRaw height="100%" treeLabel="产物文件" contentLabel="产物内容" selected={file} onSelect={setFile}
      files={Object.entries(data.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ id: path, path: path.split("/"), content }))}
      actions={<Button variant="ghost" onClick={download}>下载</Button>} />}
  </DialogContent></Dialog>;
}
