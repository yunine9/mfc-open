import type { WorkflowAssetSummary } from "../api";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export interface WorkflowSchemeSelection {
  id: string;
  version?: number;
}

export function SchemeSelector({
  workflows,
  value,
  onChange,
  onOpenEditor,
  disabled = false,
}: {
  workflows: WorkflowAssetSummary[];
  value?: WorkflowSchemeSelection;
  onChange: (selection?: WorkflowSchemeSelection) => void;
  onOpenEditor?: (workflowId?: string) => void;
  disabled?: boolean;
}) {
  const selectable = workflows.filter((item) => item.selectable_for_tasks);
  const selected = value && workflows.find((item) => item.id === value.id);
  return <section className="wf-scheme-selector" aria-labelledby="wf-scheme-title">
    <span className="wf-scheme-title"><b id="wf-scheme-title">执行方案</b>
      <small>不设置时沿用平台标准方案</small></span>
    <Select disabled={disabled} value={value?.id ?? ""}
      items={[{ value: "", label: "平台标准方案（推荐）" },
        ...selectable.map((workflow) => ({
          value: workflow.id,
          label: `${workflow.name} · v${workflow.latest_version} · ${workflow.scope === "team" ? "团队" : "个人"}`,
        }))]}
      onValueChange={(selected) => {
        const workflow = workflows.find((item) => item.id === selected);
        onChange(workflow ? { id: workflow.id, version: workflow.latest_version } : undefined);
      }}>
      <SelectTrigger className="w-full" aria-label="选择执行方案"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="">平台标准方案（推荐）</SelectItem>
          {selectable.map((workflow) => <SelectItem key={workflow.id} value={workflow.id}>
            {workflow.name} · v{workflow.latest_version} · {workflow.scope === "team" ? "团队" : "个人"}
          </SelectItem>)}
        </SelectGroup>
      </SelectContent>
    </Select>
    {selected && <span className="wf-scheme-version">固定 v{value?.version ?? selected.latest_version}</span>}
    {onOpenEditor && <button type="button" disabled={disabled}
      onClick={() => onOpenEditor(value?.id)}>{value ? "查看方案" : "专业定制"}</button>}
  </section>;
}
