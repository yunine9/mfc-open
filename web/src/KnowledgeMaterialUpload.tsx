import { useEffect, useRef, useState } from "react";
import { componentRequest } from "./componentResearchApi";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface MaterialSummary { id: string; name: string; version: string; scope: string; state: "ready" | "failed"; error?: string; sections: number; images?: Array<{ path: string }>; warnings?: string[] }
export function KnowledgeMaterialUpload({ materials, onChange, onBusy, purpose = "extraction", disabled = false }: { materials: MaterialSummary[]; onChange: (materials: MaterialSummary[]) => void; onBusy?: (busy: boolean) => void; purpose?: "extraction" | "requirement"; disabled?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const uploadController = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { uploadController.current?.abort(); onBusy?.(false); }, [onBusy]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [version, setVersion] = useState("");
  const requirement = purpose === "requirement";
  const label = requirement ? "上传需求资料" : "上传业务资料";
  async function upload(files: File[]) {
    if (uploading.current || disabled) return;
    uploading.current = true;
    const controller = new AbortController(); uploadController.current = controller;
    setBusy(true); onBusy?.(true); setError(""); const next = [...materials];
    try {
      for (const file of files) {
        try {
          if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} 超过 20 MiB`);
          const content_base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
          if (controller.signal.aborted) break;
          const material = await componentRequest<MaterialSummary>("/knowledge-materials", { name: file.name, content_base64, version, ...(requirement ? { scope: "本次需求" } : {}) }, controller.signal);
          if (controller.signal.aborted) break;
          next.push(material);
        } catch (cause) {
          if (controller.signal.aborted) break;
          next.push({ id: `upload-failed-${crypto.randomUUID()}`, name: file.name, version,
            scope: requirement ? "本次需求" : "", state: "failed", sections: 0,
            error: cause instanceof Error ? cause.message : "上传失败，请移除后重新选择" });
        }
        onChange([...next]);
      }
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); } finally { uploading.current = false; if (!controller.signal.aborted) { setBusy(false); onBusy?.(false); } }
  }
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label={requirement ? "需求资料上传" : "业务资料上传"}
    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
    onDrop={event => { event.preventDefault(); if (event.dataTransfer.files.length) void upload(Array.from(event.dataTransfer.files)); }}>
    <strong>{requirement ? "需求资料" : "补充资料"}</strong>
    <p className="text-sm text-muted-foreground">支持 MD、TXT、DOCX、PDF、XLSX、PPTX，可多选或拖入文件，也可上传包含这些文档及图片的 ZIP。单份最多 20 MiB；ZIP 解压后最多 100 MiB、1000 个条目，单个文件最多 10 MiB。{requirement ? "所有文档共同构成需求，保留原文件，不需要指定主文档。" : "资料自动用于本次萃取，原文件保留。"} PDF 扫描件请先识别为文字。</p>
    {!requirement && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">填写资料版本（可选）</summary><label className="mt-2 grid gap-1">资料版本<Input aria-label="资料版本（可选）" value={version} onChange={e => setVersion(e.target.value)} placeholder="如 v2.1 或文档发布日期；不知道可留空" disabled={busy || disabled} /><span className="text-muted-foreground">用于区分不同版本的业务规则，无固定格式；仅应用于接下来上传的文件。系统自动记录上传时间和文件指纹。</span></label></details>}
    <div className="flex items-center gap-3"><Button type="button" variant="outline" disabled={busy || disabled} onClick={() => fileInput.current?.click()}>{busy ? "上传中…" : "选择文件"}</Button><span className="text-sm text-muted-foreground">可多选文档或 ZIP，选择后自动上传</span></div>
    <input ref={fileInput} hidden aria-label={label} type="file" multiple disabled={busy || disabled} accept=".md,.txt,.docx,.pdf,.xlsx,.pptx,.zip" onChange={e => { const files = Array.from(e.target.files ?? []); if (files.length) void upload(files); e.target.value = ""; }} />
    {busy && <p role="status">正在上传并解析资料…</p>}{error && <p role="alert" className="text-danger">{error}</p>}
    {materials.some(material => material.state === "failed") && <p role="alert" className="text-sm text-danger">有资料上传或解析失败，请移除后重新上传；其他已上传资料仍保留。</p>}
    {materials.map(material => <div key={material.id} className="flex items-start gap-2 border-t border-line pt-2 text-sm"><span className="min-w-0 flex-1 break-words">{material.name} · {material.version ? `${material.version} · ` : ""}{material.state === "ready" ? `${material.sections} 个文本片段${material.images?.length ? ` · ${material.images.length} 张图片` : ""}` : material.error}{!!material.warnings?.length && <details className="mt-1 text-amber-700"><summary>有 {material.warnings.length} 条解析提醒</summary><ul>{material.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</span><button type="button" className="shrink-0 text-primary" aria-label={`移除 ${material.name}`} disabled={busy || disabled} onClick={() => onChange(materials.filter(m => m.id !== material.id))}>移除</button></div>)}
  </section>;
}
