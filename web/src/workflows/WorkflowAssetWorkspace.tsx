import { useEffect, useMemo, useState } from "react";
import {
  WorkflowApiError,
  copyWorkflowAsset,
  createWorkflowAsset,
  getWorkflowAsset,
  getWorkflowAssetCatalog,
  getWorkflowStandard,
  listWorkflowAssets,
  saveWorkflowDraft,
  workflowAssetAction,
  type WorkflowAssetCatalogItem,
  type WorkflowAssetDetail,
  type WorkflowAssetSummary,
  type WorkflowDefinition,
  type WorkflowStandardBase,
} from "../api";
import { WorkflowDetail } from "./WorkflowDetail";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowLibrary } from "./WorkflowLibrary";
import { confirmDialog } from "../ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Page = "library" | "detail" | "editor";
type CreateDialog = {
  kind: "create" | "copy";
  source?: WorkflowAssetSummary;
  name: string;
  description: string;
  scope: "personal" | "team";
};
type ActionDialog = {
  action: "submit" | "withdraw" | "approve" | "reject" | "archive";
  title: string;
  explanation: string;
  requireReason?: boolean;
  targetId?: string;
  confirmLabel?: string;
  destructive?: boolean;
};

export function WorkflowAssetWorkspace({
  initialWorkflowId,
}: {
  /** 下单选择器"查看方案"带来的直达目标:挂载时直接打开它的详情
   * (复制/编辑入口都在详情),不让用户在首页再找一遍(审计 P1-9)。 */
  initialWorkflowId?: string;
} = {}) {
  const [page, setPage] = useState<Page>("library");
  const [workflows, setWorkflows] = useState<WorkflowAssetSummary[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<WorkflowAssetCatalogItem[]>([]);
  const [standard, setStandard] = useState<WorkflowStandardBase>();
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<WorkflowAssetDetail>();
  const [definition, setDefinition] = useState<WorkflowDefinition>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editorError, setEditorError] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [notice, setNotice] = useState("");
  const [createDialog, setCreateDialog] = useState<CreateDialog>();
  const [actionDialog, setActionDialog] = useState<ActionDialog>();
  // 冲突暂存的失效计数:恢复/丢弃后靠它触发重读,不把暂存搬进状态。
  const [stashVersion, setStashVersion] = useState(0);

  async function refreshLibrary(showLoading = false): Promise<void> {
    if (showLoading) setLoading(true);
    try {
      const result = await listWorkflowAssets();
      setWorkflows(result.items);
      setWarnings(result.warnings);
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      listWorkflowAssets(), getWorkflowAssetCatalog(), getWorkflowStandard(),
    ]).then(([libraryResult, catalogResult, launchResult]) => {
      if (!alive) return;
      if (libraryResult.status === "fulfilled") {
        setWorkflows(libraryResult.value.items);
        setWarnings(libraryResult.value.warnings);
      } else setError(messageOf(libraryResult.reason));
      if (catalogResult.status === "fulfilled") {
        setCatalog(catalogResult.value.items);
        setWarnings((current) => [...current, ...catalogResult.value.warnings]);
      } else {
        setWarnings((current) => [...current,
          `资产目录暂不可用：${messageOf(catalogResult.reason)}`]);
      }
      if (launchResult.status === "fulfilled") {
        setStandard(launchResult.value);
      } else {
        setWarnings((current) => [...current,
          `平台标准方案暂不可读：${messageOf(launchResult.reason)}`]);
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!initialWorkflowId) return;
    let alive = true;
    setSelectedId(initialWorkflowId);
    setPage("detail");
    setDetail(undefined);
    setDetailLoading(true);
    getWorkflowAsset(initialWorkflowId)
      .then((loaded) => { if (alive) setDetail(loaded); })
      .catch((cause) => { if (alive) setError(messageOf(cause)); })
      .finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [initialWorkflowId]);

  async function openWorkflow(asset: WorkflowAssetSummary): Promise<void> {
    setSelectedId(asset.id);
    setPage("detail");
    setDetail(undefined);
    setDetailLoading(true);
    setError("");
    try {
      setDetail(await getWorkflowAsset(asset.id));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setDetailLoading(false);
    }
  }

  function startCreate(): void {
    setDialogError("");
    setCreateDialog({ kind: "create", name: "", description: "", scope: "personal" });
  }

  function startCopy(asset: WorkflowAssetSummary): void {
    setDialogError("");
    setCreateDialog({
      kind: "copy", source: asset, name: `${asset.name}（副本）`,
      description: asset.description ?? "", scope: "personal",
    });
  }

  async function submitCreate(dialog: CreateDialog): Promise<void> {
    if (!dialog.name.trim() || busy) return;
    if (dialog.kind === "create" && !standard) {
      setDialogError("平台标准方案暂不可读，不能创建一个无法准确编译的工作流；刷新后重试即可。");
      return;
    }
    setBusy(true);
    setDialogError("");
    try {
      const created = dialog.kind === "copy" && dialog.source
        ? await copyWorkflowAsset(dialog.source.id, {
            name: dialog.name.trim(), description: dialog.description.trim() || undefined,
            scope: dialog.scope,
          })
        : await createWorkflowAsset({
            name: dialog.name.trim(), description: dialog.description.trim() || undefined,
            scope: dialog.scope,
            definition: emptyDefinition(standard!),
          });
      setCreateDialog(undefined);
      await refreshLibrary();
      await openWorkflow(created);
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  async function runAction(action: ActionDialog, reason = ""): Promise<void> {
    const targetId = action.targetId ?? detail?.asset.id;
    if (!targetId || busy) return;
    setBusy(true);
    setDialogError("");
    try {
      await workflowAssetAction(targetId, action.action,
        reason.trim() ? { reason: reason.trim() } : {});
      setActionDialog(undefined);
      await refreshLibrary();
      if (action.action === "archive") {
        setNotice(action.destructive
          ? "草稿已从当前工作流中移除；审计记录仍保留在“已归档”。"
          : "工作流已归档，不再供新任务选择；历史版本保持不变。");
        setPage("library");
        setSelectedId("");
        setDetail(undefined);
      } else {
        setNotice("");
        setDetail(await getWorkflowAsset(targetId));
      }
    } catch (cause) {
      setDialogError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  function askAction(action: ActionDialog["action"]): void {
    setDialogError("");
    const copy: Record<ActionDialog["action"], Omit<ActionDialog, "action">> = {
      submit: { title: "提交审核", explanation: "提交后草稿进入待审核状态；在审核前仍可撤回。" },
      withdraw: { title: "撤回审核", explanation: "撤回后回到草稿状态，可以继续编辑再提交。" },
      approve: { title: "审核通过并发布", explanation: "会生成一个不可覆盖的新版本，后续任务可精确选择它。" },
      reject: { title: "驳回工作流", explanation: "请明确写出需要调整的内容，维护者会看到原因。", requireReason: true },
      archive: detail?.asset.status === "draft" && detail.asset.latest_version === 0
        ? { title: "删除工作流草稿", explanation: "草稿会从当前工作流中移除。为保留操作留痕，记录仍可在“已归档”中查看或复制。", confirmLabel: "确认删除", destructive: true }
        : { title: "归档工作流", explanation: "历史任务仍保留原版本；归档后新任务不能继续选择。", confirmLabel: "确认归档" },
    };
    setActionDialog({ action, ...copy[action] });
  }

  function askRemoveDraft(asset: WorkflowAssetSummary): void {
    setDialogError("");
    setActionDialog({
      action: "archive",
      targetId: asset.id,
      title: `删除“${asset.name}”草稿`,
      explanation: "它会从当前工作流中移除。为保留操作留痕，记录仍可在“已归档”中查看或复制。",
      confirmLabel: "确认删除",
      destructive: true,
    });
  }

  const dirty = useMemo(() => Boolean(detail && definition
    && JSON.stringify(detail.draft.definition) !== JSON.stringify(definition)),
  [detail, definition]);
  const baselineMismatch = useMemo(() => Boolean(detail && standard && (
    detail.draft.definition.base.standard_id !== standard.standard_id
    || detail.draft.definition.base.standard_version !== standard.standard_version
    || detail.draft.definition.base.catalog_digest !== standard.catalog_digest
  )), [detail, standard]);

  if (page === "editor" && detail && definition && standard && !baselineMismatch) {
    const stash = stashVersion >= 0 ? readConflictStash(detail.asset.id) : undefined;
    const stashDiffers = stash
      && JSON.stringify(stash.definition) !== JSON.stringify(definition);
    return <div className="wf-asset-workspace">
      {stashDiffers && <div className="wf-state-banner warning" role="status">
        <strong>发现冲突时的本机暂存</strong>
        <span>
          上次保存冲突时（{new Date(stash.stashed_at).toLocaleString()}）暂存的
          {stash.definition.edits.length} 项变更还留在本机，可恢复到编辑器后
          在最新草稿上重新合并。
        </span>
        <button type="button" onClick={() => {
          setDefinition(structuredClone(stash.definition));
          clearConflictStash(detail.asset.id);
          setStashVersion((version) => version + 1);
        }}>恢复我的改动</button>
        <button type="button" onClick={() => {
          clearConflictStash(detail.asset.id);
          setStashVersion((version) => version + 1);
        }}>丢弃暂存</button>
      </div>}
      <WorkflowEditor name={detail.asset.name}
      description={detail.asset.description} definition={definition}
      base={standard} catalog={catalog} busy={busy} error={editorError}
      onDefinitionChange={(next) => { setDefinition(next); setEditorError(""); }}
      onSave={() => {
        if (busy) return;
        setBusy(true);
        setEditorError("");
        void saveWorkflowDraft(detail.asset.id, definition, detail.draft.revision)
          .then((updated) => {
            setDetail(updated);
            setDefinition(structuredClone(updated.draft.definition));
            clearConflictStash(updated.asset.id);
            setStashVersion((version) => version + 1);
            void refreshLibrary();
          }).catch((cause) => {
            if (cause instanceof WorkflowApiError
                && cause.code === "revision_conflict") {
              // 重合并不能全靠人脑记住刚才改了什么(审计 P1-10):
              // 落一份本机暂存,刷新回来编辑器会主动提示恢复。
              writeConflictStash(detail.asset.id, definition);
              setStashVersion((version) => version + 1);
              setEditorError(`草稿已被别人更新到 r${cause.currentRevision ?? "?"}；`
                + "你的修改没有覆盖对方，已在本机暂存一份。"
                + "返回详情刷新草稿后再进编辑器，可一键恢复你的改动再合并。");
            } else setEditorError(messageOf(cause));
          }).finally(() => setBusy(false));
      }}
      onExit={async () => {
        if (!dirty || await confirmDialog({
          title: "未保存的修改",
          message: "当前有尚未保存的修改，返回详情将离开编辑器"
            + "（改动可一键恢复）。",
          confirmLabel: "返回详情",
        })) {
          setPage("detail");
          setEditorError("");
        }
      }} />
    </div>;
  }

  return <div className="wf-asset-workspace">
    {page === "library" ? <WorkflowLibrary workflows={workflows}
      loading={loading} error={error} warnings={warnings} selectedId={selectedId}
      onSelect={(asset) => void openWorkflow(asset)} onCreate={startCreate}
      onCopy={startCopy} onRemoveDraft={askRemoveDraft} notice={notice}
      onRefresh={() => void refreshLibrary(true)} />
      : <>
        {detail && error && <div className="wf-state-banner error" role="alert">
          <strong>操作未完成</strong><span>{error}</span>
        </div>}
        {detail && !standard && <div className="wf-state-banner warning" role="status">
          <strong>暂不可编辑</strong><span>平台标准方案读取失败；详情和生命周期操作仍可使用，刷新页面后再编辑。</span>
        </div>}
        {detail && baselineMismatch && <div className="wf-state-banner warning" role="status">
          <strong>基线已经升级</strong><span>这份草稿绑定旧版平台标准方案，历史内容仍可查看；系统不会拿新基线生成不准确的预览。请返回资产库新建一份当前基线方案。</span>
        </div>}
        <WorkflowDetail detail={detail} loading={detailLoading} error={detail ? "" : error}
          onBack={() => { setPage("library"); setError(""); }}
          onEdit={detail?.asset.permissions.can_edit && standard && !baselineMismatch ? () => {
            setDefinition(structuredClone(detail.draft.definition));
            setEditorError("");
            setPage("editor");
          } : undefined}
          onCopy={detail ? () => startCopy(detail.asset) : undefined}
          onSubmit={() => askAction("submit")}
          onWithdraw={() => askAction("withdraw")}
          onApprove={() => askAction("approve")}
          onReject={() => askAction("reject")}
          onArchive={() => askAction("archive")} />
      </>}
    {createDialog && <CreateWorkflowDialog value={createDialog} busy={busy}
      error={dialogError} onChange={setCreateDialog} onClose={() => {
        setCreateDialog(undefined); setDialogError("");
      }}
      onSubmit={() => void submitCreate(createDialog)} />}
    {actionDialog && <WorkflowActionDialog value={actionDialog} busy={busy}
      error={dialogError} onClose={() => {
        setActionDialog(undefined); setDialogError("");
      }}
      onSubmit={(reason) => void runAction(actionDialog, reason)} />}
  </div>;
}

/* 冲突暂存(审计 P1-10):revision_conflict 时本地未保存的编辑不能就地
 * 蒸发。只存本机 localStorage,不含任何令牌/密钥,失败静默——暂存是
 * 兜底便利,不是第二个草稿权威。 */
type ConflictStash = { definition: WorkflowDefinition; stashed_at: string };

function conflictStashKey(id: string): string {
  return `mfc-wf-conflict-stash:${id}`;
}

function readConflictStash(id: string): ConflictStash | undefined {
  try {
    const raw = localStorage.getItem(conflictStashKey(id));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ConflictStash>;
    return parsed?.definition && typeof parsed.stashed_at === "string"
      ? parsed as ConflictStash : undefined;
  } catch {
    return undefined;
  }
}

function writeConflictStash(id: string, definition: WorkflowDefinition): void {
  try {
    localStorage.setItem(conflictStashKey(id), JSON.stringify({
      definition, stashed_at: new Date().toISOString(),
    }));
  } catch {
    // 存不进去(隐私模式/配额)就只剩错误提示,不阻塞保存流程。
  }
}

function clearConflictStash(id: string): void {
  try {
    localStorage.removeItem(conflictStashKey(id));
  } catch {
    // 清不掉也无妨:恢复入口只在内容与当前不同才出现。
  }
}

function emptyDefinition(
  standard: WorkflowStandardBase,
): WorkflowDefinition {
  return {
    schema: "mae-flow-workflow-definition/1",
    base: {
      standard_id: standard.standard_id,
      standard_version: standard.standard_version,
      catalog_digest: standard.catalog_digest,
    },
    applicability: {
      business_module_ids: [], repositories: [], technologies: [],
    },
    edits: [],
  };
}

function CreateWorkflowDialog({ value, busy, error, onChange, onClose, onSubmit }: {
  value: CreateDialog;
  busy: boolean;
  error?: string;
  onChange: (value: CreateDialog) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="tw-root sm:max-w-[560px]">
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault(); onSubmit();
      }}>
        <DialogHeader>
          <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-primary">
            {value.kind === "copy" ? "COPY WORKFLOW" : "NEW WORKFLOW"}</span>
          <DialogTitle>{value.kind === "copy" ? "复制为独立工作流" : "创建工作流草稿"}</DialogTitle>
          <DialogDescription>{value.kind === "copy"
            ? "副本记录来源，但不会跟随原方案自动变化。"
            : "从当前 Mae-Flow 标准方案开始，只保存你明确做出的结构化变更。"}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert"
          className="m-0 rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
          {error}</p>}
        <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">名称</span><Input required autoFocus maxLength={120}
          value={value.name} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
        <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">说明</span><Textarea className="min-h-17 resize-y" rows={3} maxLength={500}
          value={value.description}
          onChange={(event) => onChange({ ...value, description: event.target.value })} /></label>
        <fieldset className="flex gap-4 rounded-lg border border-input p-3">
          <legend className="text-xs font-medium text-foreground">保存范围</legend>
          <RadioGroup className="flex gap-4" name="workflow-scope" value={value.scope}
            onValueChange={(scope) => onChange({ ...value, scope })}>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RadioGroupItem value="personal" />个人资产</label>
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <RadioGroupItem value="team" />团队资产</label>
          </RadioGroup>
        </fieldset>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" disabled={busy || !value.name.trim()}>
            {busy ? "正在保存…" : value.kind === "copy" ? "创建副本" : "创建草稿"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function WorkflowActionDialog({ value, busy, error, onClose, onSubmit }: {
  value: ActionDialog;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
    <DialogContent className="tw-root sm:max-w-[500px]">
      <form className="grid gap-4" onSubmit={(event) => {
        event.preventDefault(); onSubmit(reason);
      }}>
        <DialogHeader>
          <span className="text-[10px] font-extrabold uppercase tracking-[0.14em] text-primary">WORKFLOW ACTION</span>
          <DialogTitle>{value.title}</DialogTitle>
          <DialogDescription>{value.explanation}</DialogDescription>
        </DialogHeader>
        {error && <p role="alert"
          className="m-0 rounded-md border border-destructive/40 bg-danger-soft px-3 py-2 text-xs leading-relaxed text-danger">
          {error}</p>}
        {value.requireReason && <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">调整说明</span><Textarea className="min-h-24 resize-y" autoFocus required
          rows={4} value={reason} onChange={(event) => setReason(event.target.value)}
          placeholder="写清楚需要修改什么，避免只说“不通过”。" /></label>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" variant={value.destructive ? "destructive" : "default"}
            disabled={busy || (value.requireReason && !reason.trim())}>
            {busy ? "正在处理…" : value.confirmLabel ?? "确认"}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
