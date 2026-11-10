import { useEffect, useRef, useState } from "react";
import { FileText, FolderOpen, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { updateSkillPackage, type SkillUploadFile } from "./api";
import { componentRequest } from "./componentResearchApi";
import { base64Text, skillPackageFiles } from "./KnowledgeSkillImport";
import { confirmDialog } from "./ConfirmDialog";

interface SkillPackage {
  package_digest: string;
  files: Array<{ path: string; bytes: number; content?: string }>;
}

export function SkillPackageEditor({ directory, mode, initialPath = "SKILL.md", onClose, onSaved }: {
  directory: string; mode: "edit" | "replace"; initialPath?: string;
  onClose: () => void; onSaved: () => void;
}) {
  const [pack, setPack] = useState<SkillPackage>(), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState(initialPath), [edits, setEdits] = useState<Record<string, string>>({});
  const [replacement, setReplacement] = useState<Array<{ path: string; file: File }>>([]), [busy, setBusy] = useState(false);
  const directoryInput = useRef<HTMLInputElement>(null), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let active = true;
    setError("");
    void componentRequest<SkillPackage>(`/skills/${encodeURIComponent(directory)}/package`)
      .then(value => { if (active) setPack(value); })
      .catch(error => { if (active) setError((error as Error).message); });
    return () => { active = false; };
  }, [directory, retry]);
  const changed = pack?.files.filter(file => edits[file.path] !== undefined && edits[file.path] !== file.content) ?? [];
  const removed = replacement.length ? pack?.files.filter(file => !replacement.some(row => row.path === file.path)) ?? [] : [];
  const current = pack?.files.find(file => file.path === selected);
  const dirty = mode === "edit" ? changed.length > 0 : replacement.length > 0;
  function close() {
    if (busy) return;
    if (dirty) void confirmDialog({
      title: "放弃未保存的修改？",
      message: "本次改动尚未保存。",
      confirmLabel: "放弃修改",
      danger: true,
    }).then(confirmed => { if (confirmed) onClose(); });
    else onClose();
  }
  function pick(files: FileList | null) {
    if (!files?.length) return;
    setError(""); setReplacement([]);
    try {
      const rows = skillPackageFiles([...files]);
      if (rows.length > 400 || rows.reduce((sum, row) => sum + row.file.size, 0) > 16 * 1024 * 1024) {
        throw new Error("Skill 包最多 400 个文件，总大小不超过 16 MiB");
      }
      setReplacement(rows);
    } catch (error) { setError((error as Error).message); }
  }
  async function save() {
    if (!pack || busy) return;
    setBusy(true); setError("");
    try {
      const files: SkillUploadFile[] = mode === "edit"
        ? changed.map(file => ({ path: file.path, content_base64: base64Text(edits[file.path]) }))
        : await Promise.all(replacement.map(async row => {
          const bytes = new Uint8Array(await row.file.arrayBuffer());
          let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
          return { path: row.path, content_base64: btoa(raw) };
        }));
      await updateSkillPackage(directory, mode, pack.package_digest, files);
      onSaved();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent className="tw-root flex max-h-[90vh] flex-col sm:max-w-5xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{mode === "edit" ? "编辑 Skill" : "替换 Skill 包"} · {directory}</DialogTitle>
        <DialogDescription>名称与知识归属保持不变，保存后平台直接生效，旧版自动留存。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="whitespace-pre-wrap break-words text-danger">{error}{!pack && <Button variant="link" onClick={() => setRetry(value => value + 1)}>重新读取</Button>}</p>}
      {!pack ? <p className="py-8 text-muted-foreground">{error ? "未能读取当前 Skill。" : "正在读取当前 Skill…"}</p> : mode === "edit" ? <>
        <p className="text-sm text-muted-foreground">可编辑正文、参考文档和脚本；其他附件自动保留。</p>
        <div className="flex min-h-0 gap-4" style={{ height: "min(55vh, 560px)" }}>
          <nav aria-label="选择编辑文件" className="w-64 shrink-0 overflow-y-auto rounded-lg border border-line p-2">
            {pack.files.map(file => <Button key={file.path} variant="ghost" disabled={busy} aria-current={file.path === selected ? "page" : undefined}
              className={`h-auto min-h-10 w-full justify-start whitespace-normal px-2 py-2 text-left ${file.path === selected ? "bg-primary/10 text-primary" : ""}`} onClick={() => setSelected(file.path)}>
              <FileText size={15} className="shrink-0" /><span className="min-w-0 break-all">{file.path}{changed.some(row => row.path === file.path) && " *"}{file.content === undefined && <small className="block text-muted-foreground">附件 · 保留</small>}</span>
            </Button>)}
          </nav>
          <div className="flex min-w-0 flex-1 flex-col gap-2"><label htmlFor="skill-file-content" className="break-all text-sm font-medium">{selected}</label>
            {current?.content !== undefined ? <Textarea id="skill-file-content" aria-label={`编辑 ${selected}`} disabled={busy} spellCheck={false}
              className="min-h-0 flex-1 resize-none font-mono text-sm leading-relaxed" value={edits[selected] ?? current.content}
              onChange={event => setEdits(old => ({ ...old, [selected]: event.target.value }))} />
              : <p className="rounded-lg bg-muted p-5 text-sm text-muted-foreground">此文件不支持在线编辑，保存时会原样保留。需要更换附件时，请使用「替换」入口上传完整 Skill 包。</p>}
          </div>
        </div>
      </> : <div className="grid min-h-0 gap-4 overflow-y-auto">
        <p className="text-sm text-muted-foreground">选择包含 SKILL.md 的完整目录。替换后以新包为准，旧包中未包含的文件将移除。</p>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => directoryInput.current?.click()}><FolderOpen size={16} />选择目录</Button><Button variant="outline" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} />选择文件</Button></div>
        <input ref={node => { directoryInput.current = node; node?.setAttribute("webkitdirectory", ""); }} type="file" multiple hidden disabled={busy} onChange={event => { pick(event.target.files); event.target.value = ""; }} />
        <input ref={fileInput} type="file" multiple hidden disabled={busy} onChange={event => { pick(event.target.files); event.target.value = ""; }} />
        {replacement.length > 0 && <><p className="text-sm">新包共 {replacement.length} 个文件 · 将移除 {removed.length} 个旧文件</p>
          <div className="max-h-[38vh] overflow-y-auto rounded-lg border border-line p-3 text-sm" aria-label="替换文件清单">
            {replacement.map(file => <p key={file.path} className="break-all py-1">{file.path} <span className="text-muted-foreground">· {Math.ceil(file.file.size / 1024)} KB</span></p>)}
            {removed.map(file => <p key={file.path} className="break-all py-1 text-danger">移除 · {file.path}</p>)}
          </div></>}
      </div>}
      <footer className="flex items-center justify-between gap-4 border-t border-line pt-3">
        <p className="text-sm text-muted-foreground">{mode === "edit" ? `已修改 ${changed.length} 个文件` : "正文、脚本和二进制附件一起替换"}</p>
        <div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={close}>取消</Button>
          <Button disabled={!pack || !dirty || busy} onClick={() => void save()}>{busy ? "正在保存…" : mode === "edit" ? "保存并生效" : "替换并生效"}</Button></div>
      </footer>
    </DialogContent>
  </Dialog>;
}
