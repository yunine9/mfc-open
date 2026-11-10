import { useRef, useState } from "react";
import { FileText, FolderOpen, Upload } from "lucide-react";
import { KnowledgeBackButton } from "./KnowledgeBackButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { submitSkill, type SkillUploadFile } from "./api";
import { KnowledgeDestination, destinationMetadata } from "./KnowledgeDestination";

export function skillPackageFiles(files: File[]): Array<{ file: File; path: string }> {
  const withDirectory = files.some(file => !!file.webkitRelativePath);
  const rows = files.map(file => ({ file, path: withDirectory ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name }));
  if (!rows.some(row => row.path === "SKILL.md")) throw new Error("请选择根目录包含 SKILL.md 的完整 Skill 包");
  if (new Set(rows.map(r => r.path)).size !== rows.length) throw new Error("包内存在重复路径，请按目录重新选择");
  return rows;
}
export function base64Text(text: string) { let data = ""; for (const byte of new TextEncoder().encode(text)) data += String.fromCharCode(byte); return btoa(data); }
/** initialText：制作 Skill 的草稿；initialFiles：被退回的提交包（文本文件），用于修改后重新提交。两者都可在线改 SKILL.md。 */
export function KnowledgeSkillImport({ moduleKey = "", initialText, initialFiles, title, onBack, onCreated }: { moduleKey?: string; initialText?: string; initialFiles?: Array<{ path: string; text: string }>; title?: string; onBack: () => void; onCreated: (id: string) => void | Promise<void> }) {
  const input = useRef<HTMLInputElement>(null), directoryInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<Array<{ path: string; file?: File; text?: string }>>(initialFiles ?? (initialText ? [{ path: "SKILL.md", text: initialText }] : []));
  const initialSkill = initialFiles?.find(row => row.path === "SKILL.md")?.text ?? initialText;
  const [name, setName] = useState(initialSkill?.match(/^name:\s*["']?([^\n"']+)/m)?.[1] ?? ""), [destination, setDestination] = useState(moduleKey);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function pick(selected: FileList | null) {
    if (!selected?.length) return; setError("");
    try { const rows = skillPackageFiles([...selected]); setFiles(rows); const root = rows.find(r => r.path === "SKILL.md")!; const text = await root.file.text(); setName(text.match(/^name:\s*["']?([^\n"']+)/m)?.[1] ?? root.file.webkitRelativePath.split("/")[0] ?? ""); }
    catch(e) { setFiles([]); setError((e as Error).message); }
  }
  async function submit() {
    setBusy(true); setError("");
    try {
      const encoded: SkillUploadFile[] = await Promise.all(files.map(async row => { let content = row.text !== undefined ? base64Text(row.text) : ""; if (row.file) { const bytes = new Uint8Array(await row.file.arrayBuffer()); if (bytes.length > 20 * 1024 * 1024) throw new Error("单个文件超过 20 MiB"); let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte); content = btoa(raw); } return { path: row.path, content_base64: content }; }));
      const result = await submitSkill(name.trim(), encoded, destinationMetadata(destination)); await onCreated(`${result.directory}/${result.id}`);
    } catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <section className="knowledge-create" aria-label="导入 Skill"><header className="knowledge-create-header"><div className="knowledge-page-title"><KnowledgeBackButton onClick={onBack} destination={initialText ? "制作 Skill" : initialFiles ? "文稿审查" : "知识库"} /><h2>{title ?? (initialText ? "编辑并提交 Skill" : "导入 Skill")}</h2></div></header>
    {error && <p role="alert" className="text-danger mb-4">{error}</p>}
    <div className="knowledge-create-grid"><div className="knowledge-create-fields"><div className="flex gap-3"><Button variant="outline" onClick={() => input.current?.click()}><Upload size={16} />选择文件</Button><Button variant="outline" onClick={() => directoryInput.current?.click()}><FolderOpen size={16} />选择目录</Button></div>
      <input ref={input} type="file" multiple hidden onChange={e => void pick(e.target.files)} /><input ref={node => { directoryInput.current = node; node?.setAttribute("webkitdirectory", ""); }} type="file" multiple hidden onChange={e => void pick(e.target.files)} />
      <div className="knowledge-import-files" aria-label="Skill 包文件">{files.length ? files.map(row => <div key={row.path} className="knowledge-import-file"><FileText size={15} /><span>{row.path}</span><small>{row.file ? `${Math.ceil(row.file.size/1024)} KB` : "草稿"}</small></div>) : <div className="p-6 text-muted-foreground text-sm">选择包含 SKILL.md 的 Skill 包，保留包内目录与附件。</div>}</div>
      {files.some(row => row.path === "SKILL.md" && row.text !== undefined) && <label className="grid gap-2 text-sm font-medium">SKILL.md（可直接修改）<Textarea aria-label="编辑 SKILL.md" className="min-h-[360px] font-mono text-sm" value={files.find(row => row.path === "SKILL.md")!.text} onChange={e => { const text = e.target.value; setFiles(rows => rows.map(row => row.path === "SKILL.md" ? { ...row, text } : row)); }} /></label>}
    </div><aside className="knowledge-create-aside"><div className="knowledge-create-fields"><label>Skill 名称<Input value={name} onChange={e => setName(e.target.value)} placeholder="例如 alarm-check" /></label><label>知识归属<KnowledgeDestination value={destination} onChange={setDestination} /></label><p className="knowledge-create-hint">选择“工程 · 通用”可用于不同语言和业务的任务。可随包上传脚本和 CLI，程序需兼容任务执行环境。</p></div></aside></div>
    <footer className="knowledge-create-footer"><p className="knowledge-create-hint">提交后进入知识任务中心审查，当前生效版本保持可用。</p><Button disabled={busy || !files.length || !name.trim() || !destination} onClick={() => void submit()}>{busy ? "正在提交…" : "提交并审查"}</Button></footer>
  </section>;
}
