import { useEffect, useRef, useState } from "react";
import { FileQuestion, FileText, Folder, GitBranch, ListFilter, LoaderCircle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { businessModuleKnowledgeScopeRequest, type BusinessModuleKnowledgeScope } from "./api";
import { knowledgeScopeRows, selectKnowledgePath } from "./knowledgeScopeSelection";

const repositoryName = (repository: string) => repository.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/");

export function KnowledgeModuleScope({ moduleId, moduleName }: { moduleId: string; moduleName: string }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState<BusinessModuleKnowledgeScope>();
  const [savedExclusions, setSavedExclusions] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const saveRequest = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(""); setValue(undefined);
    void businessModuleKnowledgeScopeRequest(moduleId, undefined, controller.signal)
      .then(next => { if (!controller.signal.aborted) { setValue(next); setSavedExclusions(Object.fromEntries(next.repositories.map(repo => [repo.repository, repo.excluded_paths]))); } })
      .catch(reason => { if (!controller.signal.aborted) setError((reason as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, moduleId, reload]);

  function select(repository: string, path: string, included: boolean) {
    setValue(current => current && ({ ...current, repositories: current.repositories.map(repo => repo.repository === repository
      ? { ...repo, excluded_paths: selectKnowledgePath(repo.excluded_paths, path, included) } : repo) }));
  }
  async function save() {
    if (!value || saveRequest.current) return;
    saveRequest.current = true; setSaving(true); setError("");
    try {
      await businessModuleKnowledgeScopeRequest(moduleId, {
        expected_revision: value.module_revision,
        repositories: value.repositories.map(({ repository, excluded_paths }) => ({ repository, excluded_paths })),
      });
      if (mounted.current) setOpen(false);
    } catch (reason) { if (mounted.current) setError((reason as Error).message); }
    finally { saveRequest.current = false; if (mounted.current) setSaving(false); }
  }
  const excludedCount = value?.repositories.reduce((count, repo) => count + repo.excluded_paths.length, 0) ?? 0;
  return <>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}><ListFilter size={15} />筛选文档</Button>
    <Dialog open={open} onOpenChange={next => { if (!saveRequest.current) setOpen(next); }}>
      <DialogContent className="tw-root flex max-h-[85vh] flex-col sm:max-w-[720px]" showCloseButton={!saving}>
        <DialogHeader className="shrink-0 pr-7">
          <DialogTitle>筛选文档</DialogTitle>
          <DialogDescription>选择「{moduleName}」保留的目录和文件。取消目录会排除其下全部内容，仅影响当前模块。</DialogDescription>
        </DialogHeader>
        {loading ? <div role="status" className="flex items-center justify-center gap-2 py-12 text-muted-foreground"><LoaderCircle size={16} className="animate-spin" />正在读取文档清单…</div>
          : value && <div className="min-h-0 overflow-y-auto rounded-lg border border-line" aria-label="代码仓文档筛选">
            {value.repositories.map(repo => <section key={repo.repository} className="border-b border-line last:border-b-0" aria-label={repo.repository}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-muted px-4 py-2.5">
                <GitBranch size={15} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium" title={repo.repository}>{repositoryName(repo.repository)}</span>
              </div>
              <div className="grid gap-0.5 p-2">
                {knowledgeScopeRows(repo.directories, repo.files ?? [], repo.excluded_paths, savedExclusions[repo.repository]).map(row => <label key={row.path} className={`flex min-h-9 items-center gap-2.5 rounded-md py-1.5 pr-3 text-sm hover:bg-muted/50 ${row.inherited ? "text-muted-foreground" : "cursor-pointer"}`} style={{ paddingLeft: 10 + Math.min(row.path.split("/").length - 1, 6) * 16 }}>
                  <Checkbox checked={!row.excluded && !row.partial} indeterminate={row.partial} disabled={saving || row.inherited}
                    aria-label={`${repo.repository} ${row.path}`} onCheckedChange={checked => select(repo.repository, row.path, checked)} />
                  {row.kind === "directory" ? <Folder size={15} aria-label="目录" className="shrink-0 text-muted-foreground" />
                    : row.kind === "file" ? <FileText size={15} aria-label="文件" className="shrink-0 text-muted-foreground" />
                    : <FileQuestion size={15} className="shrink-0 text-muted-foreground" />}
                  <span className="min-w-0 break-all font-mono text-xs">{row.path}</span>
                  {row.missing && <span className="ml-auto shrink-0 text-xs text-muted-foreground">当前快照中暂无</span>}
                </label>)}
                {!repo.directories.length && !repo.files?.length && !repo.excluded_paths.length && <p className="px-2 py-3 text-xs text-muted-foreground">当前快照中暂无 docs 文档</p>}
              </div>
            </section>)}
            {!value.repositories.length && <p className="p-8 text-center text-muted-foreground">此模块暂无关联代码仓。</p>}
          </div>}
        <p className="shrink-0 text-xs leading-relaxed text-muted-foreground">随时重新勾选即可恢复，不删除资料、不重新萃取。仓根 AGENTS.md 和领域知识仓目录始终保留。</p>
        {error && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 text-sm text-danger"><span className="min-w-0 break-words">{error}</span><Button variant="outline" size="sm" disabled={loading || saving} onClick={() => setReload(count => count + 1)}>重新读取</Button></div>}
        <DialogFooter className="shrink-0">
          <Button variant="ghost" className="sm:mr-auto" disabled={!value || saving || !excludedCount} onClick={() => setValue(current => current && ({ ...current, repositories: current.repositories.map(repo => ({ ...repo, excluded_paths: [] })) }))}><RotateCcw size={15} />恢复全部</Button>
          <Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>取消</Button>
          <Button disabled={!value || loading || saving} onClick={() => void save()}>{saving && <LoaderCircle size={15} className="animate-spin" />}{saving ? "正在保存…" : "保存"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
