import { useEffect, useMemo, useState } from "react";
import type {
  WorkflowAssetCatalogItem,
  WorkflowDefinition,
  WorkflowEdit,
  WorkflowExecutionProfile,
  WorkflowStandardBase,
  WorkflowPlanItem,
} from "../api";
import { AssetPicker } from "./AssetPicker";
import { Empty, EmptyContent, EmptyDescription, EmptyTitle } from "@/components/Empty";
import {
  itemFromAsset,
  newEditId,
  previewStages,
  sourceLabel,
} from "./model";
import { StagePlan } from "./StagePlan";
import { StageRail } from "./StageRail";
import { DependencyView, FinalPlanView, WorkflowDiffView } from "./WorkflowViews";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type EditorView = "edit" | "final" | "changes" | "dependencies";

export function WorkflowEditor({
  name,
  description,
  definition,
  base,
  catalog,
  profile,
  busy = false,
  error,
  onDefinitionChange,
  onSave,
  onExit,
}: {
  name: string;
  description?: string;
  definition: WorkflowDefinition;
  base: WorkflowStandardBase;
  catalog: WorkflowAssetCatalogItem[];
  profile?: WorkflowExecutionProfile;
  busy?: boolean;
  error?: string;
  onDefinitionChange: (definition: WorkflowDefinition) => void;
  onSave?: () => void;
  onExit?: () => void;
}) {
  const stages = useMemo(() => previewStages(base, definition), [base, definition]);
  const [view, setView] = useState<EditorView>("edit");
  const [stageId, setStageId] = useState(stages[0]?.id ?? "");
  const [itemId, setItemId] = useState<string>();
  const [picker, setPicker] = useState<"add" | "replace">();
  const stage = stages.find((candidate) => candidate.id === stageId) ?? stages[0];
  const item = stage?.items.find((candidate) => candidate.id === itemId);

  useEffect(() => {
    if (stage && stage.id !== stageId) setStageId(stage.id);
  }, [stage, stageId]);
  useEffect(() => {
    if (itemId && !item) setItemId(undefined);
  }, [item, itemId]);

  function addEdit(edit: WorkflowEdit) {
    onDefinitionChange({ ...definition, edits: [...definition.edits, edit] });
  }

  function chooseAsset(asset: WorkflowAssetCatalogItem) {
    if (!stage) return;
    if (picker === "replace" && item) {
      addEdit({ edit_id: newEditId("replace"), stage_id: stage.id,
        op: "replace", target_id: item.id, item: itemFromAsset(asset, item.id) });
    } else {
      const id = uniqueItemId(asset.ref.id, stage.items);
      addEdit({ edit_id: newEditId("add"), stage_id: stage.id,
        op: "add", item: itemFromAsset(asset, id) });
      setItemId(id);
    }
    setPicker(undefined);
  }

  function removeSelected() {
    if (!stage || !item || item.locked) return;
    addEdit({ edit_id: newEditId("remove"), stage_id: stage.id,
      op: "remove", target_id: item.id });
    setItemId(undefined);
  }

  function moveSelected(direction: -1 | 1) {
    if (!stage || !item || item.locked) return;
    const index = stage.items.findIndex((candidate) => candidate.id === item.id);
    const anchor = stage.items[index + direction];
    if (!anchor) return;
    addEdit({ edit_id: newEditId("move"), stage_id: stage.id,
      op: "move", target_id: item.id,
      position: direction < 0 ? { before: anchor.id } : { after: anchor.id } });
  }

  const changedStages = new Set(definition.edits.map((edit) => edit.stage_id)).size;
  return <section className="wf-editor" aria-labelledby="wf-editor-title">
    <header className="wf-editor-head">
      <div className="wf-editor-identity">
        {onExit && <button type="button" className="wf-editor-back" onClick={onExit}>
          <svg viewBox="0 0 20 20" aria-hidden><path d="m12 5-5 5 5 5" /></svg>
          <span>返回详情</span></button>}
        <span><small>专业模式 · 精确编排</small><h2 id="wf-editor-title">{name}</h2>
          {description && <p>{description}</p>}</span>
      </div>
      <div className="wf-editor-actions">
        <span><strong>{definition.edits.length}</strong> 项变更 · {changedStages} 个阶段</span>
        {onSave && <button type="button" className="wf-primary" disabled={busy}
          onClick={onSave}>{busy ? "保存中…" : "保存草稿"}</button>}
      </div>
    </header>
    {/* (#210)手搓 role=tablist 换 base-ui Tabs 原语:键盘箭头归原语;
        尾部说明 span 原地保留(仍随 .wf-editor-tabs 靠右);下方四个
        view 分支映射为 TabsPanel(keepMounted 默认 false,卸载语义与
        原条件渲染一致);「编排」面板保留 stage 的前置条件。 */}
    <Tabs value={view} className="contents"
      onValueChange={(value) => setView(value as EditorView)}>
      <TabsList aria-label="工作流查看方式" className="wf-editor-tabs h-auto w-full">
        {([ ["edit", "编排"],
          ["final", profile ? "最终方案" : "最终方案（预览）"],
          ["changes", "变更清单"],
          ["dependencies", "依赖与版本"] ] as const).map(([id, label]) =>
          <TabsTrigger key={id} value={id} className="h-auto flex-none">{label}</TabsTrigger>)}
        <span>保存的是相对平台标准方案的精确变更；执行时只产生一个最终方案。</span>
      </TabsList>
      {!profile && <p className="wf-editor-preview-note">这里是即时编排预览；保存和下单时由服务端重新校验并编译，无法安全应用的单项会明确降级，不会影响其余定制。</p>}
      {error && <p className="wf-error" role="alert"><strong>当前修改未保存</strong>{error}</p>}
      {view === "edit" && stage && <TabsContent value="edit" className="contents"><div className="wf-editor-grid">
        <StageRail stages={stages} definition={definition} selectedStageId={stage.id}
          onSelect={(next) => { setStageId(next); setItemId(undefined); setPicker(undefined); }} />
        <StagePlan stage={stage} selectedItemId={itemId}
          onSelectItem={(next) => { setItemId(next); setPicker(undefined); }}
          onAdd={() => { setPicker("add"); setItemId(undefined); }} />
        {picker ? <AssetPicker assets={catalog} title={picker === "add"
          ? `向“${stage.title}”新增资产` : `替换“${item?.title ?? "执行项"}”`}
          onSelect={chooseAsset} onClose={() => setPicker(undefined)} />
          : <EditInspector item={item} stageItems={stage.items}
            onStartAdd={() => { setPicker("add"); setItemId(undefined); }}
            onRemove={removeSelected}
            onReplace={() => item && !item.locked && setPicker("replace")}
            onMove={moveSelected}
            onConfigure={(use, instructions) => {
              if (!item || item.locked) return;
              addEdit({ edit_id: newEditId("configure"), stage_id: stage.id,
                op: "configure", target_id: item.id, use, instructions });
            }} />}
      </div></TabsContent>}
      {view === "final" && <TabsContent value="final" className="contents"><FinalPlanView stages={profile?.final_snapshot?.stages ?? stages}
        diagnostics={profile?.diagnostics} preview={!profile} /></TabsContent>}
      {view === "changes" && <TabsContent value="changes" className="contents"><WorkflowDiffView definition={definition} base={base} /></TabsContent>}
      {view === "dependencies" && <TabsContent value="dependencies" className="contents"><DependencyView stages={stages} catalog={catalog}
        manifest={profile?.asset_manifest} preview={!profile} /></TabsContent>}
    </Tabs>
  </section>;
}

function EditInspector({
  item,
  stageItems,
  onStartAdd,
  onRemove,
  onReplace,
  onMove,
  onConfigure,
}: {
  item?: WorkflowPlanItem;
  stageItems: WorkflowPlanItem[];
  onStartAdd: () => void;
  onRemove: () => void;
  onReplace: () => void;
  onMove: (direction: -1 | 1) => void;
  onConfigure: (use: NonNullable<WorkflowPlanItem["use"]>, instructions: string) => void;
}) {
  const [mode, setMode] = useState<NonNullable<WorkflowPlanItem["use"]>["mode"]>("when_needed");
  const [anchor, setAnchor] = useState("");
  const [instructions, setInstructions] = useState("");
  useEffect(() => {
    setMode(item?.use?.mode ?? "when_needed");
    setAnchor(item?.use?.anchor ?? "");
    setInstructions(item?.instructions ?? "");
  }, [item]);
  const index = item ? stageItems.findIndex((candidate) => candidate.id === item.id) : -1;
  const editable = !!item && !item.locked && item.editable;
  return <aside className="wf-edit-inspector" aria-labelledby="wf-inspector-title">
    <header><span>编辑面板</span><h3 id="wf-inspector-title">
      {item ? item.title : "选择一个执行项"}</h3></header>
    {/* 五操作图例撤了:动作按钮自带符号+文字,常驻图例是重复
        (审计 P2-17)。 */}
    {!item && <Empty className="border p-5">
      <EmptyTitle>请选择中间的一项进行精确编辑</EmptyTitle>
      <EmptyDescription>也可以直接新增已经入库的知识、Skill、Agent 或工具。</EmptyDescription>
      <EmptyContent><button type="button" className="wf-primary" onClick={onStartAdd}>＋ 新增执行项</button></EmptyContent>
    </Empty>}
    {item && <>
      <div className={`wf-selected-summary${item.locked ? " locked" : ""}`}>
        <span><b>{item.kind}</b><b>{sourceLabel(item)}</b></span>
        {item.description && <p>{item.description}</p>}
        {item.locked && <p><strong>平台锁定项</strong>不可移除、替换、调序或重新配置
          <small title="锁定项用于保证基本流程、真实证据和权限边界。">（为什么？）</small></p>}
      </div>
      <div className="wf-direct-actions">
        <button type="button" onClick={onStartAdd}>＋ 新增</button>
        <button type="button" disabled={!editable} onClick={onRemove}>− 移除</button>
        <button type="button" disabled={!editable} onClick={onReplace}>⇄ 替换</button>
        <button type="button" disabled={!editable || index <= 0}
          onClick={() => onMove(-1)}>↑ 前移</button>
        <button type="button" disabled={!editable || index >= stageItems.length - 1}
          onClick={() => onMove(1)}>↓ 后移</button>
      </div>
      <fieldset disabled={!editable} className="wf-configure-panel">
        <legend>配置使用方式</legend>
        <label><span>使用时机</span><Select value={mode}
          items={[{ value: "available", label: "全程可用，由 Agent 判断" }, { value: "when_needed", label: "本阶段需要时使用" }, { value: "on_stage_enter", label: "进入本阶段时立即使用" }, { value: "before_item", label: "在指定执行项之前使用" }]}
          onValueChange={(value) => setMode((value ?? mode) as typeof mode)}>
          <SelectTrigger className="w-full" aria-label="使用时机"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="available">全程可用，由 Agent 判断</SelectItem>
              <SelectItem value="when_needed">本阶段需要时使用</SelectItem>
              <SelectItem value="on_stage_enter">进入本阶段时立即使用</SelectItem>
              <SelectItem value="before_item">在指定执行项之前使用</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select></label>
        {mode === "before_item" && <label><span>目标执行项</span>
          <Select value={anchor}
            items={[{ value: "", label: "请选择" },
              ...stageItems.filter((candidate) => candidate.id !== item.id)
                .map((candidate) => ({ value: candidate.id, label: candidate.title }))]}
            onValueChange={(value) => setAnchor(value ?? "")}>
            <SelectTrigger className="w-full" aria-label="目标执行项"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="">请选择</SelectItem>
                {stageItems.filter((candidate) => candidate.id !== item.id)
                  .map((candidate) => <SelectItem key={candidate.id}
                    value={candidate.id}>{candidate.title}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select></label>}
        <label><span>明确指令（可选）</span><Textarea className="min-h-24 resize-y" rows={4} value={instructions}
          placeholder="写清楚 Agent 在此处要做什么、产出什么；不要写模糊的能力偏好。"
          onChange={(event) => setInstructions(event.target.value)} /></label>
        <button type="button" className="wf-primary"
          disabled={mode === "before_item" && !anchor}
          onClick={() => onConfigure({ mode,
            ...(mode === "before_item" ? { anchor } : {}) }, instructions.trim())}>
          应用配置</button>
      </fieldset>
    </>}
  </aside>;
}

function uniqueItemId(seed: string, items: WorkflowPlanItem[]): string {
  const safe = `custom-${seed}`.replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (!items.some((item) => item.id === safe)) return safe;
  let suffix = 2;
  while (items.some((item) => item.id === `${safe}-${suffix}`)) suffix += 1;
  return `${safe}-${suffix}`;
}
