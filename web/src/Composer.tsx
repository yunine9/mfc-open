import { TaskAttachments } from "./TaskAttachments";
import type { TaskAttachment } from "./api";
/**
 * 右栏唯一的输入框。
 *
 * 两个档(2026-09-05 用户拍板,接替原「补充给主任务 / 开发助手」两页签):
 * - 「说给 Agent」:等你决定时,这里就是决定卡的提交区(卡上的选项是动作,
 *   这里只写附言/自定义答复);没有卡时是 pi steer——不打断当前工具,下一
 *   回合送达;@ 引用知识照旧。
 * - 「接管现场」:先把主任务停在安全边界,再起不挂 KernelHost 的开发助手
 *   会话。往来在上面的流里,这里只发下一条指令、停止、交还主任务。
 *
 * 容器、工作区、凭据与 Git 交付边界仍由服务端强制;这里所有"不可用"都
 * 把原因写出来,不留灰框让人猜。
 */

import { useEffect, useRef, useState } from "react";
import {
  getBusinessModules,
  getDeveloperAssistant,
  getSkillLibrary,
  interruptTask,
  returnDeveloperAssistant,
  startDeveloperAssistant,
  stopDeveloperAssistant,
  type BusinessModule,
  type DeveloperAssistantView,
  type HostSkillShelfEntry,
  type SteerReference,
  type TaskSummary,
  publishCrossRepositoryUpdate,
} from "./api";
import { startVisiblePolling } from "./visiblePolling";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert } from "@/components/Alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

/** sync=通知所有子任务:只有跨仓子任务有这一档。 */
export type CollaborationMode = "steer" | "assistant" | "sync";

const EMPTY_ASSISTANT: DeveloperAssistantView = {
  state: "idle",
  messages: [],
  tools: [],
  availability: {
    available: false,
    code: "core_unavailable",
    mode: "unavailable",
    reason: "正在确认当前内核步骤…",
  },
};

const ASSISTANT_STATE: Record<DeveloperAssistantView["state"], string> = {
  idle: "等待接手",
  acquiring: "正在接手",
  working: "正在工作",
  ready: "CLI 已就绪",
  returning: "正在交回给 Agent",
  running: "正在工作",
  completed: "CLI 已就绪",
  failed: "本轮失败",
  interrupted: "已中断",
};

/** 选中的 @ 引用:发送只传结构化标识,label 仅本地展示。 */
type PickedReference = SteerReference & { key: string; label: string };

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 接管是否在进行(含刚接管完等你下一条的空档)。 */
export function takeoverActiveOf(assistant: DeveloperAssistantView): boolean {
  return ["acquiring", "working", "ready", "returning", "running", "completed"]
    .includes(assistant.state) || assistant.handoff?.state === "running";
}

export function Composer({
  task,
  isOwner,
  steerOnly = false,
  decisionDock = false,
  dockContext,
  dockRef,
  onChanged,
  onAssistant,
  crossRepository = false,
  recoveryRequest = 0,
}: {
  task: TaskSummary;
  /** 只有主责任人能把已停下的主会话从验证/待合入/失败现场恢复。 */
  isOwner: boolean;
  /** 跨仓子任务:多一档「通知所有子任务」。原来是流末尾一个单独的折叠工具块,
   * 和输入区两套皮、两种口吻(2026-09-06 用户:"为什么不放在下面那个里面
   * 平行"),现在与「说给 Agent」「我来接手」并列成第三档。 */
  crossRepository?: boolean;
  /** 失败原因旁的处理入口只聚焦输入框，不自动发送指令或重跑。 */
  recoveryRequest?: number;
  /** 跨仓分析主任务是共享讨论室,没有可编辑的单仓代码现场。 */
  steerOnly?: boolean;
  /** 等这位读者决定:输入区让给决定卡的提交区(WaitingCard 的 footer 经
   * portal 挂到 dockRef 指向的节点)。 */
  decisionDock?: boolean;
  /** 提交区上方那一句"这里写的会怎么送"。 */
  dockContext?: string;
  dockRef: (node: HTMLDivElement | null) => void;
  onChanged?: () => void;
  /** 开发助手快照(状态/工具/可用性)提升给父级:流里要渲它的往来与步骤。 */
  onAssistant?: (view: DeveloperAssistantView) => void;
}) {
  // 默认档跟着"哪边真能用"走,不按状态硬猜(2026-09-02 实测:不在运行就
  // 落到灰掉的开发助手)。人自己点过档位后不再替他换。
  const [mode, setMode] = useState<CollaborationMode>("steer");
  const [decisionToolsOpen, setDecisionToolsOpen] = useState(false);
  const modePicked = useRef(false);
  const steerInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!recoveryRequest) return;
    modePicked.current = true;
    setMode("steer");
    const frame = requestAnimationFrame(() => {
      steerInput.current?.scrollIntoView({ block: "nearest" });
      steerInput.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [recoveryRequest]);
  const [syncText, setSyncText] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState("");

  async function sendSync() {
    const message = syncText.trim();
    if (!message || syncBusy) return;
    setSyncBusy(true);
    setSyncFeedback("");
    try {
      const result = await publishCrossRepositoryUpdate(task.id, message);
      setSyncText("");
      setSyncFeedback(result.target_task_ids.length
        ? `已同步主任务和 ${result.target_task_ids.length} 个其他子任务；排队任务启动时读取`
        : "已同步主任务；后续创建的子任务也会收到");
      onChangedRef.current?.();
    } catch (cause) {
      setSyncFeedback(cause instanceof Error ? cause.message : "通知所有子任务失败");
    } finally {
      setSyncBusy(false);
    }
  }
  const [logAttachments, setLogAttachments] = useState<TaskAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  useEffect(() => { setLogAttachments([]); }, [task.id]);
  const [steerText, setSteerText] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [steerBusy, setSteerBusy] = useState(false);
  const [assistantRequestBusy, setAssistantRequestBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [refs, setRefs] = useState<PickedReference[]>([]);
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  const [refFilter, setRefFilter] = useState("");
  const [refOptions, setRefOptions] = useState<{
    skills: HostSkillShelfEntry[]; modules: BusinessModule[] }>();
  const [assistant, setAssistant] =
    useState<DeveloperAssistantView>(EMPTY_ASSISTANT);
  const lastAssistantUpdate = useRef("");
  const assistantPollSequence = useRef(0);
  const onChangedRef = useRef(onChanged);
  const onAssistantRef = useRef(onAssistant);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  useEffect(() => { onAssistantRef.current = onAssistant; }, [onAssistant]);

  useEffect(() => {
    modePicked.current = false;
    setMode("steer");
    setDecisionToolsOpen(false);
    setSent(false);
  }, [task.id, steerOnly]);

  const takeoverActive = takeoverActiveOf(assistant);
  // 与服务端 interrupt 的 ownerMayResume 对齐：运行中允许协作者插话；
  // 已进入宿主验证、等待合入或失败现场时，只允许责任人恢复主 Agent。
  const resumesMainTask = isOwner
    && ["verifying", "await_merge", "failed"].includes(task.status);
  const canSteer = (task.status === "running" || resumesMainTask)
    && !takeoverActive;
  useEffect(() => { setDecisionToolsOpen(false); }, [task.waiting?.waiting_id]);
  useEffect(() => {
    if (takeoverActive) setMode("assistant");
  }, [takeoverActive]);

  // 主任务不在运行且助手真可接管时才默认落到「接管现场」;可用性来自
  // 服务端快照(首轮拉取前一律按不可用算),人点过档位就不动了。
  useEffect(() => {
    if (modePicked.current || steerOnly) return;
    setMode(!canSteer && assistant.availability.available
      ? "assistant" : "steer");
  }, [canSteer, assistant.availability.available, steerOnly]);

  // 助手回复和工具结果分别来自快照与事件账。隐藏页不轮询。
  useEffect(() => {
    let alive = true;
    const load = () => {
      const sequence = ++assistantPollSequence.current;
      void getDeveloperAssistant(task.id)
      .then((view) => {
        if (!alive || sequence !== assistantPollSequence.current) return;
        setAssistant(view);
        onAssistantRef.current?.(view);
        if (view.updated_at && view.updated_at !== lastAssistantUpdate.current) {
          if (["completed", "failed", "interrupted"].includes(view.state)) {
            onChangedRef.current?.();
          }
          lastAssistantUpdate.current = view.updated_at;
        }
      })
      .catch((cause) => {
        if (alive && sequence === assistantPollSequence.current) {
          setError(errorMessage(cause));
        }
      });
    };
    const stop = startVisiblePolling(load, 1500, document);
    return () => { alive = false; stop(); };
  }, [task.id]);

  async function sendSteer() {
    const message = steerText.trim();
    if ((!message && !refs.length && !logAttachments.length) || steerBusy || attachmentBusy) return;
    setSteerBusy(true);
    setError("");
    try {
      const result = await interruptTask(task.id, message, refs, logAttachments);
      if (result.error) { setError(result.error); return; }
      setSteerText("");
      setLogAttachments([]);
      setRefs([]);
      setRefPickerOpen(false);
      setSent(true);
      onChangedRef.current?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally { setSteerBusy(false); }
  }

  function toggleRefPicker() {
    const open = !refPickerOpen;
    setRefPickerOpen(open);
    if (open && !refOptions) {
      // 两路都 fail-open:拉不到哪路就少哪组,不挡另一组。
      void Promise.all([
        getSkillLibrary().catch(() => undefined),
        getBusinessModules().catch(() => undefined),
      ]).then(([library, catalog]) => setRefOptions({
        skills: (library?.skills ?? []).filter((skill) => skill.loadable),
        modules: (catalog?.modules ?? []).filter((module) =>
          module.status === "active"
          && module.assets.some((asset) => asset.status === "published")),
      }));
    }
  }

  function addRef(picked: PickedReference) {
    setRefs((current) => {
      if (current.some((item) => item.key === picked.key)) return current;
      if (current.length >= 4) {
        setError("一次插话最多引用 4 项知识");
        return current;
      }
      return [...current, picked];
    });
    setRefPickerOpen(false);
    setRefFilter("");
  }

  async function sendAssistant() {
    const message = assistantText.trim();
    if (!message || assistantRequestBusy) return;
    if (!assistant.availability.available) {
      setError(assistant.availability.reason);
      return;
    }
    setMode("assistant");
    setAssistantRequestBusy(true);
    setError("");
    try {
      const view = await startDeveloperAssistant(task.id, message);
      setAssistant(view);
      onAssistantRef.current?.(view);
      setAssistantText("");
      onChangedRef.current?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  async function stopAssistant() {
    if (assistantRequestBusy) return;
    setAssistantRequestBusy(true);
    setError("");
    try {
      const view = await stopDeveloperAssistant(task.id);
      setAssistant(view);
      onAssistantRef.current?.(view);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  async function resumeMainTask() {
    if (assistantRequestBusy) return;
    setAssistantRequestBusy(true);
    setError("");
    try {
      await returnDeveloperAssistant(task.id);
      onChangedRef.current?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setAssistantRequestBusy(false);
    }
  }

  const assistantWorking = ["acquiring", "working", "returning", "running"]
    .includes(assistant.state);
  // @ 引用比纯文字宽:等人决定/排队时引用也有明确送达路径(决定
  // continuation / 并入使命),纯文字仍按原契约走决定卡。
  const canSteerKnowledge = !takeoverActive
    && (["running", "queued", "waiting_for_human"].includes(task.status)
      || resumesMainTask);
  const refDeliveryHint = task.status === "running"
    ? "本轮工具调用结束后送达"
    : task.status === "queued" ? "任务启动时并入使命"
    : resumesMainTask ? "恢复任务时并入使命"
    : "随下一次决定一起送达";
  const steerEnabledCopy = resumesMainTask ? {
    title: "让 Agent 继续处理",
    detail: task.status === "await_merge"
      ? "发送后恢复当前任务，Agent 按新要求继续修改；仍使用原分支和 MR。"
      : task.status === "verifying"
        ? "发送后停止当前验证并恢复 Agent，按新要求继续处理。"
        : "发送后从当前现场恢复 Agent，继续处理你的新要求。",
    placeholder: "说明需要继续处理什么，也可以说“帮我沉淀这条经验”",
  } : {
    title: "捎一句给正在跑的 Agent",
    detail: "现在就能交办；当前工具结束后读取，结合正在做的工作处理",
    placeholder: "补充开发要求，也可以说“帮我沉淀这条经验”",
  };
  const steerDisabledReason = canSteer ? undefined
    : takeoverActive ? {
        title: "现在由你操作中",
        detail: "先交回给 Agent；它恢复运行后才能继续补充。",
      }
    : task.status === "waiting_for_human" ? {
        title: "主任务正在等待人工决定",
        detail: "请在上面的卡片里回答,或在材料上添加批注;这些意见会随决定一起交给 Agent。",
      }
    : task.status === "paused" ? {
        title: "主任务已暂停",
        detail: steerOnly
          ? "需要由主责任人先恢复主任务,Agent 运行后才能接收补充。"
          : "先恢复任务；要马上查代码或改代码，切到「我来接手」。",
      }
    : task.status === "pausing" ? {
        title: "主任务正在暂停",
        detail: "系统正在停止当前会话，完成后可以恢复任务或自己接手。",
      }
    : task.status === "verifying" ? {
        title: "当前正在验证交付结果",
        detail: "主 Agent 已结束本轮编码,当前由构建或流水线核验;出现失败后系统会进入修复流程。",
      }
    : task.status === "await_merge" ? {
        title: "当前正在等待合入",
        detail: "只有任务责任人可以补充新要求并恢复 Agent；其他人可在材料上提检视意见。",
      }
    : task.status === "failed" ? {
        title: "当前任务已停下",
        detail: "只有任务责任人可以从当前现场恢复 Agent 继续处理。",
      }
    : task.status === "queued" ? {
        title: "主任务还在排队",
        detail: "Agent 尚未开始运行,任务启动后才能发送补充。",
      }
    : {
        title: "当前没有运行中的主 Agent",
        detail: "只有主任务处于“执行中”时,这里的补充才能可靠送达。",
      };
  const assistantAvailable = assistant.availability.available;
  const canReturn = task.status === "paused"
    && !["acquiring", "working", "returning", "running"].includes(assistant.state);
  const compactDecision = decisionDock && !takeoverActive && !decisionToolsOpen;
  const showAssistant = mode === "assistant" && !steerOnly && !compactDecision;
  const showSync = mode === "sync" && crossRepository && !steerOnly && !compactDecision;

  return (
    <section className={`ws-composer${decisionDock && !takeoverActive ? " is-deciding" : ""}`} aria-label="回复与提交">
      {decisionDock && !takeoverActive && <div className="decision-tools-toggle">
        <span>回复上方决定</span>
        {!steerOnly && <Button type="button" variant="link" size="sm"
          className="h-auto px-0 text-xs" aria-expanded={decisionToolsOpen}
          onClick={() => { setDecisionToolsOpen(!decisionToolsOpen); modePicked.current = true; setMode("assistant"); }}>
          {decisionToolsOpen ? "收起接手操作" : "需要接手排查？"}
        </Button>}
      </div>}
      <div className="ws-composer-ctx" hidden={compactDecision}>
        {!steerOnly && (
          /* (#210)手搓 role=tablist 换 base-ui Tabs 原语;选中值由
              mode 派生(原 aria-selected 语义:!showAssistant→说给
              Agent),切换回调(modePicked + setMode)原样。 */
          <Tabs className="contents"
            value={showAssistant ? "assistant" : showSync ? "sync" : "steer"}
            onValueChange={(value) => { modePicked.current = true; setMode(value as "steer" | "assistant" | "sync"); }}>
            <TabsList variant="line" aria-label="对谁说" className="ws-composer-modes h-auto">
              <TabsTrigger value="steer" disabled={takeoverActive}
                title={takeoverActive ? "先交回给 Agent" : undefined}
                className={`h-auto flex-none after:hidden${!showAssistant ? " on" : ""}`}>
                说给 Agent
              </TabsTrigger>
              <TabsTrigger value="assistant"
                title={assistantAvailable || takeoverActive ? "你自己接手：查代码、跑命令、改文件"
                  : assistant.availability.reason}
                className={`h-auto flex-none after:hidden${showAssistant ? " on" : ""}`}>
                我来接手
              </TabsTrigger>
              {crossRepository && (
                <TabsTrigger value="sync"
                  title="接口或约定变了,告诉依赖你或你依赖的仓库"
                  className={`h-auto flex-none after:hidden${showSync ? " on" : ""}`}>
                  通知所有子任务
                </TabsTrigger>
              )}
            </TabsList>
          </Tabs>
        )}
        {showAssistant ? (
          <>
            <span className={`ws-composer-mode ${takeoverActive ? "active" : "quiet"}`}>
              {takeoverActive ? "现在由你操作" : assistantAvailable ? "现在可以接手" : "现在不能接手"}
            </span>
            <span className="ws-composer-hint">
              {takeoverActive ? "Agent 暂停中，直到你交回" : assistantAvailable
                ? "发出第一条指令后 Agent 会停下，改由你操作" : assistant.availability.reason}
            </span>
            {canReturn && takeoverActive && (
              <Button type="button" variant="outline" size="xs"
                className="ml-auto border-line-strong bg-surface text-text-strong"
                disabled={assistantRequestBusy}
                onClick={() => void resumeMainTask()}>
                交回给 Agent
              </Button>
            )}
          </>
        ) : showSync ? (
          <>
            <span className="ws-composer-mode active">告诉依赖你或你依赖的仓库</span>
            <span className="ws-composer-hint">
              会回流给大任务,并送到依赖图上直接相邻的仓库;对方 Agent 当作待核对的事实,不是聊天广播
            </span>
          </>
        ) : decisionDock ? (
          <>
            <span className="ws-composer-mode active">选好后，在下方提交答复</span>
            <span className="ws-composer-hint">{dockContext ?? "这里写的说明会随选项一起送给 Agent"}</span>
          </>
        ) : (
          <>
            <span className={`ws-composer-mode ${canSteer ? "active" : "quiet"}`}>
              {canSteer ? steerEnabledCopy.title : steerDisabledReason?.title ?? "主任务当前未运行"}
            </span>
            <span className="ws-composer-hint">
              {canSteer ? steerEnabledCopy.detail
                : refs.length > 0 && canSteerKnowledge ? refDeliveryHint
                : steerDisabledReason?.detail}
            </span>
          </>
        )}
      </div>

      {/* 切换输入模式不等于已接管。待确认卡仍须可提交；只有实际接管后才隐藏。 */}
      <div className="ws-reply-dock" ref={dockRef} role="region" aria-label="决定的附言与提交"
        hidden={!decisionDock || takeoverActive} />

      {showSync && (
        <>
          <Textarea id={`sync-${task.id}`} className="min-h-13 max-h-40 resize-y overflow-y-auto bg-surface"
            value={syncText} disabled={syncBusy} rows={3}
            placeholder="说清楚:哪个接口或约定变了,影响什么,哪里还需要谁确认…"
            onChange={(event) => { setSyncText(event.target.value); if (syncFeedback) setSyncFeedback(""); }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendSync();
              }
            }} />
          <div className="ws-composer-row">
            <div className="ws-composer-left">
              <span className="steer-hint">
                {syncFeedback || "同一需求全部子任务都会记录；排队/暂停任务继续时读取，已结束任务不重启。"}
              </span>
            </div>
            <Button type="button" size="lg"
              disabled={syncBusy || !syncText.trim()}
              onClick={() => void sendSync()}>
              {syncBusy ? "发送中…" : "通知所有子任务"}
            </Button>
          </div>
        </>
      )}

      {!showAssistant && !showSync && !decisionDock && (
        <>
          <div className="relative">
          <Textarea ref={steerInput} id={`steer-${task.id}`} className="pr-12 min-h-13 max-h-40 resize-y overflow-y-auto bg-surface"
            value={steerText}
            disabled={(!canSteer && !(refs.length > 0 && canSteerKnowledge))
              || steerBusy}
            placeholder={canSteer
              ? steerEnabledCopy.placeholder
              : refs.length > 0 && canSteerKnowledge
                ? `可以再补一句说明;${refDeliveryHint}`
              : steerOnly && task.status === "waiting_for_human"
                ? "方案正在等主责人确认;请在材料上圈批注,意见会随最终决定送给 AI"
                : steerOnly
                  ? "主任务当前未运行,暂不能追加给 AI"
                  : steerDisabledReason?.title ?? "主任务当前未运行"}
            rows={3} onChange={(event) => {
              setSteerText(event.target.value);
              if (sent) setSent(false);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendSteer();
              }
            }} />
          <TaskAttachments taskId={task.id} files={logAttachments} onChange={setLogAttachments}
            onBusy={setAttachmentBusy} disabled={!canSteer || steerBusy} />
          </div>
          <div className="ws-composer-row">
            <div className="ws-composer-left">
              {canSteerKnowledge && <Button type="button" variant="outline" size="xs"
                className="rounded-full border-dashed bg-transparent font-normal text-muted-foreground hover:border-primary hover:bg-transparent hover:text-primary dark:hover:bg-transparent aria-expanded:border-primary aria-expanded:bg-transparent aria-expanded:text-primary"
                aria-expanded={refPickerOpen}
                onClick={toggleRefPicker}>@ 引用知识</Button>}
              {refs.map((item) => (
                <span key={item.key} className="steer-ref-chip">
                  {item.label}
                  <Button type="button" variant="ghost" size="icon-xs"
                    className="size-4 rounded-[4px] text-[13px] leading-none text-muted-foreground hover:bg-transparent hover:text-primary dark:hover:bg-transparent"
                    aria-label={`移除 ${item.label}`}
                    onClick={() => setRefs((current) =>
                      current.filter((ref) => ref.key !== item.key))}>
                    ×</Button>
                </span>
              ))}
              <span className="steer-hint">
                {sent && !steerText ? "已捎过去,读取状态在上面的流里更新" : "⌘/Ctrl + Enter 发送"}
              </span>
            </div>
            <Button type="button" size="lg"
              disabled={steerBusy || attachmentBusy
                || (!steerText.trim() && !refs.length && !logAttachments.length)
                || (refs.length ? !canSteerKnowledge : !canSteer)}
              onClick={() => void sendSteer()}>
              {steerBusy ? "发送中…" : "发送"}
            </Button>
          </div>
          {refPickerOpen && <div className="steer-ref-picker"
            aria-label="选择要引用的知识">
            <Input className="text-sm" type="text" value={refFilter} placeholder="筛选…"
              onChange={(event) => setRefFilter(event.target.value)} />
            {!refOptions && <small>读取知识清单…</small>}
            {refOptions && (() => {
              const needle = refFilter.trim().toLowerCase();
              const hit = (text: string) =>
                !needle || text.toLowerCase().includes(needle);
              const skills = refOptions.skills.filter((skill) =>
                hit(`${skill.name} ${skill.description}`));
              const assets = refOptions.modules.flatMap((module) =>
                module.assets
                  .filter((asset) => asset.status === "published"
                    && hit(`${module.name} ${asset.title} ${asset.summary}`))
                  .map((asset) => ({ module, asset })));
              if (!skills.length && !assets.length) {
                return <small>没有匹配的知识;团队货架与业务模块里上架后即可引用。</small>;
              }
              return <>
                {skills.length > 0 && <div className="steer-ref-group">
                  <strong>团队 Skill</strong>
                  {skills.slice(0, 12).map((skill) => {
                    const directory = skill.path.split("/")[0];
                    return <Button type="button" variant="ghost" key={skill.path}
                      className="grid h-auto w-full gap-px px-2 py-[5px] text-left font-normal text-primary"
                      onClick={() => addRef({
                        kind: "skill", directory,
                        key: `skill:${directory}`,
                        label: skill.name })}>
                      <span>{skill.name}</span>
                      <small>{skill.description}</small>
                    </Button>;
                  })}
                </div>}
                {assets.length > 0 && <div className="steer-ref-group">
                  <strong>业务知识</strong>
                  {assets.slice(0, 12).map(({ module, asset }) => (
                    <Button type="button" variant="ghost"
                      key={`${module.id}:${asset.id}`}
                      className="grid h-auto w-full gap-px px-2 py-[5px] text-left font-normal text-primary"
                      onClick={() => addRef({
                        kind: "business",
                        module_id: module.id, asset_id: asset.id,
                        key: `business:${module.id}:${asset.id}`,
                        label: `${module.name}/${asset.title}@v${asset.version}` })}>
                      <span>{module.name} / {asset.title}@v{asset.version}</span>
                      <small>{asset.summary}</small>
                    </Button>
                  ))}
                </div>}
              </>;
            })()}
          </div>}
        </>
      )}

      {showAssistant && (
        <>
          <div className={`assistant-state ${assistant.state}`
            + `${assistantAvailable ? " available" : " unavailable"}`}>
            <div>
              <i aria-hidden />
              <strong>{ASSISTANT_STATE[assistant.state]}</strong>
            </div>
            <span>
              {!assistantAvailable
                ? assistant.availability.reason
                : assistant.state === "acquiring"
                  ? "正在收好主任务当前动作,消息已经可靠保存"
                  : ["working", "running"].includes(assistant.state)
                    ? "输出、工具和代码变化持续记录;可随时追加指令"
                    : assistant.state === "returning"
                      ? "正在释放开发会话并与内核核对现场"
                      : takeoverActive
                        ? "Agent 暂停中；继续输入，或交回给 Agent"
                        : "多轮排查、修改和运行命令;主任务在后台保持暂停"}
            </span>
          </div>
          {/* 边界要在接管前说清:它不是本地那种想 commit 就 commit 的 CLI,
              第一次撞上"不能 git commit"的人会以为坏了(2026-09-02 定的)。 */}
          <details className="assistant-bounds-details">
            <summary>开发助手的边界</summary>
            <ul className="assistant-bounds" aria-label="开发助手的边界">
              <li><strong>Git 只读</strong>:不能 commit、push、切分支或 reset,改动只留在工作树。</li>
              <li><strong>不推进流程</strong>:不调用 Mae-Flow 命令,不生成审批卡。</li>
              <li><strong>交回后由 Agent 接着做</strong>:改动作为现场修改交给主 Agent,在当前步骤检视、提交、交付。</li>
            </ul>
          </details>

          {assistant.handoff && assistant.handoff.state !== "running" && (
            <div className={`assistant-handoff ${assistant.handoff.state === "blocked"
              ? "changed" : assistant.handoff.state}`}>
              <div>
                <i aria-hidden />
                <strong>{assistant.handoff.state === "changed"
                  ? "有修改，等待交回"
                  : assistant.handoff.state === "unchanged"
                    ? "无代码变化"
                    : assistant.handoff.state === "returned"
                      ? "已交给主任务"
                      : "现场将重新读取"}</strong>
              </div>
              <p>{assistant.handoff.message}</p>
              {!!assistant.handoff.changed_paths?.length && (
                <details>
                  <summary>{assistant.handoff.changed_paths.length} 个变更文件</summary>
                  <ul>
                    {assistant.handoff.changed_paths.map((path) => (
                      <li key={path}>{path}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          <Textarea id={`assistant-${task.id}`} className="min-h-13 max-h-40 resize-y overflow-y-auto bg-surface font-mono text-sm"
            value={assistantText}
            disabled={assistantRequestBusy || !assistantAvailable
              || assistant.state === "returning"}
            placeholder={assistantAvailable
              ? "下一条指令:查代码、跑命令、改文件…"
              : assistant.availability.reason}
            rows={3} onChange={(event) => setAssistantText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void sendAssistant();
              }
            }} />
          <div className="ws-composer-row">
            <div className="ws-composer-left">
              <span className="steer-hint">
                {assistantWorking
                  ? "当前轮执行中;新输入会在安全边界追加给助手"
                  : takeoverActive
                    ? "CLI 已保持现场和上下文,继续输入下一步"
                    : "⌘/Ctrl + Enter 接手并执行"}
              </span>
              {assistant.error && <small className="ws-composer-error">{assistant.error}</small>}
            </div>
            <div className="assistant-buttons">
              {["acquiring", "working", "running"].includes(assistant.state) && (
                <Button type="button" variant="outline" size="lg"
                  className="border-line-strong bg-surface text-text hover:bg-(--surface-soft)"
                  disabled={assistantRequestBusy}
                  onClick={() => void stopAssistant()}>
                  停止当前动作
                </Button>
              )}
              <Button type="button" size="lg"
                disabled={assistantRequestBusy || !assistantAvailable
                  || assistant.state === "returning" || !assistantText.trim()}
                onClick={() => void sendAssistant()}>
                {assistantRequestBusy ? "发送中…"
                  : ["working", "running", "acquiring"].includes(assistant.state)
                    ? "追加指令" : takeoverActive ? "执行" : "接手并执行"}
              </Button>
            </div>
          </div>
        </>
      )}

      {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    </section>
  );
}
