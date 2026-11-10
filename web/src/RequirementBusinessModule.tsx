import { useEffect, useState } from "react";
import { getBusinessModules, type BusinessModule, type TaskSummary } from "./api";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function RequirementBusinessModule({ task, onChanged }: { task: TaskSummary; onChanged: () => void }) {
  const [modules, setModules] = useState<BusinessModule[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true;
    getBusinessModules().then(result => { if (active) { setModules(result.modules); setError(""); } })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [open]);
  async function save(moduleId: string) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/tasks/${encodeURIComponent(task.id)}/business-module`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ module_id: moduleId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "保存失败");
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const current = modules.find(m => m.id === task.business_module?.id)?.name ?? task.business_module?.name;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger className="h-8 rounded-md border border-line bg-surface px-3 text-sm font-medium text-text-strong hover:bg-surface-2">
      业务模块：{current ?? "选择业务模块"} ▾
    </PopoverTrigger>
    <PopoverContent className="w-80" align="start">
      <label className="grid gap-2 text-base font-medium">所属业务模块
        <select aria-label="所属业务模块" className="h-10 rounded-md border border-line bg-surface px-2"
          value={task.business_module?.id ?? ""} disabled={busy} onChange={e => void save(e.target.value)}>
          <option value="">未关联模块</option>
          {task.business_module && !modules.some(m => m.id === task.business_module!.id) && <option value={task.business_module.id}>{task.business_module.name}</option>}
          {modules.filter(m => m.status === "active" || m.id === task.business_module?.id).map(m => <option key={m.id} value={m.id} disabled={m.status !== "active"}>{m.name}{m.status !== "active" ? "（已归档）" : ""}</option>)}
        </select>
      </label>
      {busy && <p className="mt-2 text-sm text-muted-foreground">正在保存…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
      {!!task.business_module_history?.length && <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">修改记录</summary>
        <ul className="mt-2 max-h-48 space-y-2 overflow-auto">{[...task.business_module_history].reverse().map((change, index) => <li key={index}>
          <div>{change.from?.name ?? "未关联"} → {change.to?.name ?? "未关联"}</div>
          <div className="text-muted-foreground">{change.by} · {new Date(change.at).toLocaleString("zh-CN")}</div>
        </li>)}</ul>
      </details>}
    </PopoverContent>
  </Popover>;
}
