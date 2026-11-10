import { useRef, useState } from "react";
import { Paperclip, LoaderCircle, X } from "lucide-react";
import { uploadTaskAttachment, type TaskAttachment } from "./api";
import { Button } from "./components/ui/button";

/** 输入框只显示附件图标；已选文件按需展开。 */
export function TaskAttachments({ taskId, files, onChange, onBusy, disabled = false }: {
  taskId: string; files: TaskAttachment[]; onChange: (files: TaskAttachment[]) => void;
  onBusy: (busy: boolean) => void; disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  async function upload(selected: File[]) {
    if (busy || disabled || !selected.length) return;
    if (files.length + selected.length > 10) { setError("一次最多附加 10 个文件"); setOpen(true); return; }
    setBusy(true); onBusy(true); setError("");
    let next = [...files];
    try {
      for (const file of selected) {
        if (file.size > 500 * 1024 * 1024) throw new Error(`${file.name} 超过 500MB 上限`);
        if (!file.size) throw new Error(`${file.name} 是空文件`);
        const uploaded = await uploadTaskAttachment(taskId, file);
        next = [...next.filter(item => item.path !== uploaded.path), uploaded];
        onChange(next);
      }
      setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败，请重试"); setOpen(true); }
    finally { setBusy(false); onBusy(false); if (input.current) input.current.value = ""; }
  }
  const title = busy ? "附件上传中" : files.length ? `已附加 ${files.length} 个文件：${files.map(file => file.name).join("、")}；点击管理` : "添加日志或压缩包";
  return <div className="absolute bottom-2 right-2 z-10" aria-label="日志附件"
    onDragOver={event => event.preventDefault()}
    onDrop={event => { event.preventDefault(); void upload(Array.from(event.dataTransfer.files)); }}>
    <input ref={input} type="file" multiple hidden onChange={event => void upload(Array.from(event.target.files ?? []))} />
    <Button type="button" variant="ghost" size="icon-xs" disabled={disabled || busy} title={title}
      aria-label={title} aria-expanded={open} className={files.length ? "text-primary" : "text-muted-foreground"}
      onClick={() => files.length || error ? setOpen(!open) : input.current?.click()}>
      {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
    </Button>
    {open && <div className="absolute bottom-8 right-0 w-64 rounded-md border bg-background p-2 text-xs shadow-md" role="region" aria-label="管理附件">
      {files.map(file => <div key={file.path} className="flex items-center gap-2 py-1">
        <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`移除 ${file.name}`} disabled={disabled || busy}
          onClick={() => { onChange(files.filter(item => item.path !== file.path)); if (files.length === 1) setOpen(false); }}><X className="size-3" /></Button>
      </div>)}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button type="button" variant="ghost" size="xs" disabled={disabled || busy} onClick={() => input.current?.click()}>添加文件</Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => setOpen(false)}>收起</Button>
    </div>}
  </div>;
}
