import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useTechnologyStacks } from "./useTechnologyStacks";
import { deleteTechnologyStack, saveTechnologyStack } from "./technologyStacks";
import { confirmDialog } from "./ConfirmDialog";

type StackDraft = { id?: string; name: string; enabled?: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function TechnologyStacks() {
  const { stacks, loading, error, reload } = useTechnologyStacks();
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<StackDraft>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");
  const visible = stacks.filter(stack => stack.name.toLocaleLowerCase()
    .includes(query.trim().toLocaleLowerCase()));

  const beginEdit = (draft: StackDraft) => {
    setSaveError(""); setNotice(""); setEdit(draft);
  };
  async function save() {
    if (!edit?.name.trim() || saving) return;
    setSaving(true); setSaveError(""); setNotice("");
    try {
      const saved = await saveTechnologyStack({ ...edit, name: edit.name.trim() });
      setEdit(undefined);
      setNotice(`已保存 ${saved.name}。`);
    } catch (reason) { setSaveError(message(reason)); }
    finally { setSaving(false); }
  }
  async function setEnabled(stack: { id: string; name: string; enabled: boolean }) {
    if (saving) return;
    setSaving(true); setSaveError(""); setNotice("");
    try {
      await saveTechnologyStack({ ...stack, enabled: !stack.enabled });
      setNotice(stack.enabled
        ? `已停用 ${stack.name}。已有知识和仓库关联仍保留。`
        : `已启用 ${stack.name}。`);
    } catch (reason) { setSaveError(message(reason)); }
    finally { setSaving(false); }
  }
  async function remove(stack: { id: string; name: string }) {
    if (saving) return;
    setSaving(true); setSaveError(""); setNotice("");
    try {
      if (!await confirmDialog({ title: `删除技术栈「${stack.name}」？`, danger: true,
        message: "将删除这个技术栈，并清理代码仓、组件、知识和 Skill 中对它的关联。代码、知识文稿和 Skill 内容保留。删除后缺少技术栈的内容需要重新关联。",
        confirmLabel: "删除技术栈" })) return;
      await deleteTechnologyStack(stack.id);
      setNotice(`已删除 ${stack.name} 并清理相关技术栈关联；代码、知识文稿和 Skill 内容保留。`);
    } catch (reason) { setSaveError(message(reason)); }
    finally { setSaving(false); }
  }

  return <section className="rounded-xl border border-line bg-surface p-5 text-base" aria-label="技术栈配置">
    <div className="mb-5 flex items-center gap-3">
      <Input className="max-w-md" type="search" aria-label="搜索技术栈"
        placeholder="搜索技术栈名称" value={query} onChange={event => setQuery(event.target.value)} />
      <Button className="ml-auto" disabled={saving || loading || !!error} onClick={() => beginEdit({ name: "" })}>
        新增技术栈
      </Button>
    </div>
    <p className="mb-5 text-muted-foreground">
      维护团队实际使用的技术栈，供代码仓、基础组件和工程知识统一选择。
      停用后不再提供新的选择，已有知识和仓库关联仍保留。
    </p>
    {error && <div role="alert" className="mb-3 flex items-center gap-3 text-danger">
      <span>技术栈读取失败：{error}</span><Button variant="outline" onClick={() => { void reload().catch(() => {}); }}>重试</Button>
    </div>}
    {saveError && !edit && <p role="alert" className="mb-3 text-danger">{saveError}</p>}
    {notice && <p role="status" className="mb-3 text-sm text-muted-foreground">{notice}</p>}
    {loading && <p role="status" className="p-10 text-center text-muted-foreground">正在读取技术栈…</p>}
    {!loading && stacks.length > 0 && <div className="grid gap-3" aria-label="技术栈列表">
      {visible.map(stack => <article key={stack.id} className="flex items-center gap-5 rounded-lg border border-line p-4" aria-label={stack.name}>
        <div className="min-w-0 flex-1"><h3 className="break-words font-semibold">{stack.name}</h3></div>
        <Badge variant="secondary">{stack.enabled ? "已启用" : "已停用"}</Badge>
        <Button variant="outline" disabled={saving} aria-label={`编辑 ${stack.name}`}
          onClick={() => beginEdit({ ...stack })}>编辑名称</Button>
        <Button variant="outline" disabled={saving} aria-label={`${stack.enabled ? "停用" : "启用"} ${stack.name}`}
          onClick={() => void setEnabled(stack)}>{stack.enabled ? "停用" : "启用"}</Button>
        <Button variant="ghost" className="text-danger hover:text-danger" disabled={saving} aria-label={`删除 ${stack.name}`}
          onClick={() => void remove(stack)}>删除</Button>
      </article>)}
      {!visible.length && <p className="p-10 text-center text-muted-foreground">没有匹配的技术栈，请调整搜索内容。</p>}
    </div>}
    {!loading && !error && !stacks.length && <div className="grid gap-2 p-12 text-center text-muted-foreground">
      <p className="font-semibold text-foreground">尚未配置技术栈</p>
      <p>点击「新增技术栈」，添加团队实际使用的语言、框架或平台。</p>
    </div>}
    <Dialog open={!!edit} onOpenChange={open => { if (!open && !saving) { setEdit(undefined); setSaveError(""); } }}>
      <DialogContent className="tw-root w-[520px] max-w-[520px]">
        <DialogHeader><DialogTitle>{edit?.id ? "编辑技术栈名称" : "新增技术栈"}</DialogTitle></DialogHeader>
        {edit && <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
          <label className="grid gap-2">技术栈名称<Input required autoFocus aria-label="技术栈名称" value={edit.name}
            onChange={event => setEdit({ ...edit, name: event.target.value })} /></label>
          {edit.id && <p className="text-sm text-muted-foreground">改名会更新显示名称，已有知识和仓库关联保持不变。</p>}
          {saveError && <p role="alert" className="text-danger">{saveError}</p>}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setEdit(undefined); setSaveError(""); }}>取消</Button>
            <Button type="submit" disabled={saving || !edit.name.trim()}>{saving ? "保存中…" : "保存"}</Button>
          </div>
        </form>}
      </DialogContent>
    </Dialog>
  </section>;
}
