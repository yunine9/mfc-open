import { insertMarkdownAtCursor, useIssueImagePaste } from "./useIssueImagePaste";

/**
 * 问题卡的决策卡:任务侧 WaitingCard(TaskCard.tsx)anatomy 的问题域移植。
 *
 * 提交语义与旧版完全一致——同一个 answerIssue 接口、同一个 state_version。
 * 区别只在交互:旧版"点选项立即提交",这里改成"先选/先填,统一按提交",
 * 让多题卡片能一次看清再作答。协议上是"码+文案"双通道(举卡裁决协议化):
 * 选项渲染 label(纯显示),提交回传 code(平台闸的裁决按它单点分派,
 * Agent 卡由服务端把码还原成选项原文再交给 AI)——文案改字零协议后果。
 * 服务端还会随题下发推荐码(questions[].recommended,ADR-0004):渲染
 * 成「AI 推荐」徽标+描边,只标注不预选——初始无选中,答案仍由用户
 * 亲手点选产生。
 * decision 仍是人话文本(显示/审计/自由作答);平台闸的 code 是单题卡
 * 的所选项,Agent 卡的 answers 是逐题(码或自由文本)。补充说明走 notes。
 * 后果提示(choice_effects)是任务侧的服务端能力,问题域没有对应账目,
 * 这里不伪造。
 *
 * 例外是 env_needed 闸(2026-08-28;#150 起从台账快选,2026-09-10 走查
 * 裁定「只选不手填」):通用选项卡换成语义化表单。唯一作答面是环境管理
 * 台账快选(EnvironmentPicker,可搜索下拉:IP 即名字,按 IP/标签/形态
 * 过滤;搜不到点「新增环境」弹共用表单,录入成功自动选中新条目),选中
 * 提交 environment_id——服务端从台账解密快照进会话 vault(ADR-0020
 * 「选入即快照」,前端永远没有密码)。提交走 onEnvironment(由会话视图
 * 接到 attachIssueEnvironment——密码不进浏览器草稿,在服务端 vault 加密
 * 保存;配置后会按 ADR-0003 进入本问题会话的 AI 上下文供工具消费,
 * 但不出现在会话列表、状态摘要或事件流)。
 * 拒绝是同一提交口的另一条路(票 93):AI 误判要日志/要部署时,用户
 * 可按闸的 scope 拒绝(硬拒绝:同 scope 工具再调不再举卡)。拒绝是
 * 两段式:第一段点拒绝只展开理由框(硬拒绝值得一步确认),第二段
 * 「确认拒绝」才提交,选填一句理由随平台通知转给 AI;配置环境成功即
 * 自动解除拒绝(解锢)。拒绝 wire 复用 /environment 请求体
 * (decline:true + note),hosts/backend_password 在拒绝路径上服务端
 * 不读,占位只为过表单类型。
 *
 * 另一例外是 skill_select 闸(ADR-0011):多选圈选卡——清单来自服务端
 * 扫描已拉仓的 .cac/skills,按仓分组;提交走 answer 的 selection 专用
 * 口(必须是清单子集,自报路径服务端拒收),空选=「都不用,AI 自主」。
 * 卡上没有「AI 推荐」:本卡只在月光关时举起、永远人答,推荐没有下游。
 *
 * 再一类例外是流水线红灯人工闸(2026-09-01,票 03):pipeline_unfixable
 * (不可修告警)与 pipeline_evidence(证据回灌)同卡形态、两种作答面。
 * 卡面(context)是服务端组装的失败摘要/逐维度明细/产物位置/处置指引,
 * markdown 直出;gate_pipeline 带闸归属的仓与提交。不可修卡就一个出口
 * ——「已在平台处理/豁免,重新监看」(code=resume),可附补充说明;
 * 证据卡是自由文本主通道(粘贴报错原文,空文本不可提交,code=supply)。
 * 两张卡问的都是人工事实,没有「AI 推荐」。
 *
 * 卡座形态(#125,ADR-0018 决策三「举卡入流」):卡住在协作流末尾的
 * Agent 气泡里,卡上只留题面/表单/选项;提交动作(附言输入+提交/拒绝
 * 按钮)经 React portal 挂进输入区的 dock 位(IssueConversationStream
 * 预留的 ws-reply-dock 容器)。接线链:输入区 dock 节点(dockRef 回调)
 * → 会话视图存为 footerTarget → 卡组件 → IssueDecisionFooterMount
 * (任务侧 DecisionFooterMount 同款):有目标经 createPortal 挂入,
 * 无目标(首帧/未接线的兜底,如 rail 直挂)原位渲染。表单状态(附言
 * 草稿、提交失败提示)仍归卡组件自己——portal 只搬 DOM 不搬状态。
 * #126 其余三类卡(通用决策/skill 圈选/流水线两闸)已照此换壳:四类卡
 * 的提交区走同一个挂载器,字段/校验/提交语义零变化。
 *
 * 皮肤(#231 换装):原 .issue-decision* 手搓皮(琥珀洗头/计数 pill/
 * 全局 .question/.option/.radio 搭车)退役,整卡改 shadcn 默认皮——
 * 白卡圆角细边 + 令牌工具类,推荐标注/已选态用 attention/ink 令牌
 * 直译;共享的 .question/.option/.radio CSS 为任务侧 TaskCard 保留,
 * 问题域不再搭车。
 */
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IssueEnvironmentForm, IssueSkillChoice, IssueWaitingCard } from "../api";
import { EnvironmentPicker } from "../EnvironmentPicker";
import type { EnvironmentView } from "../api";
import { toggleDecisionChoice } from "../decisionSelection";
import { Markdown } from "../markdown";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "cn";

/** 提交区的 dock 挂载器(#125,任务侧 TaskCard 的 DecisionFooterMount
 * 同款):target 在场时把提交区 portal 进输入区 dock,缺席时原位渲染。
 * 挂载器只搬 DOM;children 的状态与回调都由卡组件持有,不随挂载点变。 */
function IssueDecisionFooterMount({ target, children }: {
  target?: HTMLElement | null;
  children: ReactNode;
}) {
  return target ? createPortal(children, target) : children;
}

/** 四类卡共用外壳:白卡圆角细边。接上 dock(docked=#125 foot-docked)
 * 后提交区搬进输入区,卡体不投影——住进气泡,外阴影会与气泡描边叠加
 * 发糊(原 .conv-card.current .issue-decision 收敛规则直译)。 */
function DecisionShell({ docked, label, children }: {
  docked: boolean;
  label: string;
  children: ReactNode;
}) {
  return <section aria-label={label}
    className={cn("overflow-hidden rounded-lg border border-border bg-card text-card-foreground",
      docked && "shadow-none")}>
    {children}
  </section>;
}

/** 卡头:词签(attention 语义)+ 计数软徽标。 */
function DecisionHead({ kicker, count }: { kicker: string; count: string }) {
  return <header className="flex items-baseline justify-between gap-3 border-b border-border/70 px-3.5 py-2.5">
    <span className="inline-flex items-center gap-1.5 text-xs font-bold text-attention">
      <i aria-hidden className="size-[7px] rounded-full bg-current" />{kicker}
    </span>
    <Badge variant="warning" className="shrink-0 font-bold">{count}</Badge>
  </header>;
}

/** 决策背景:agent 的一段话,markdown 直读,超高内滚(同 waiting-context 口径)。 */
function DecisionContext({ label, className, children }: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn(
    "mx-3.5 mt-3 max-h-60 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3 text-sm leading-[1.65]",
    className)}>
    <div className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</div>
    {children}
  </div>;
}

/** 表单字段壳(原 .issue-field 直译):label 词签 + 控件,窄列自适应。 */
function DecisionField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="grid min-w-0 gap-1.5 text-sm text-muted-foreground">
    <span>{label}</span>
    {children}
  </label>;
}

/** 说明行:卡上的状态/提示句;[role=alert] 走 attention 警示色。 */
const DECISION_NOTE = "mx-3.5 mt-3 text-sm text-muted-foreground";

/** 提交区容器(#125 卡座/dock 双上下文):原位(未接线)是卡内一节,
 * 自带卡内留白;挂进输入区 dock 后是输入区自己的铺陈,dock 容器
 * (ws-reply-dock)自带留白,这里收平。env 卡根节点已自带侧留白,
 * 传 className 只补垫底。 */
function DecisionDockFoot({ docked, className, children }: {
  docked: boolean;
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn("grid gap-2.5",
    !docked && (className ?? "px-3.5 pb-3.5 pt-3"))}>{children}</div>;
}

/** 提交/拒绝按钮排:主档满宽,次档(拒绝/都不用)同排等宽。 */
const DECISION_SUBMIT_ROW = "flex gap-2";

const ENV_SCOPE_TEXT: Record<string, string> = {
  logs: "拉取日志",
  deploy: "换库部署",
};

/** 拒绝钮的拍板文案(票 93,按闸 scope 分叉;缺省按 logs——服务端
 * 对缺 scope 的旧卡也按 logs 处理,两端同一缺省)。2026-09-08 走查:
 * "无需拉日志"没人认出这是拒绝口,直说拒绝;理由走上方选填框。 */
const ENV_DECLINE_TEXT: Record<string, string> = {
  logs: "拒绝填写,继续分析",
  deploy: "拒绝填写,继续",
};

/** 拒绝分支的 wire 形(票 93):复用 POST /issues/:id/environment
 * 请求体,decline:true 走服务端拒绝路;note 是选填理由。api.ts 的
 * 表单镜像暂未带这两个键(扩展收敛在本卡,不波及登记侧复用点),
 * 交叉类型在这里补齐——结构上仍是 IssueEnvironmentForm 的子型,
 * onEnvironment 管线原样透传。 */
type IssueEnvironmentDeclineForm = IssueEnvironmentForm & {
  decline: true;
  note?: string;
};

export function IssueDecisionCard({ waiting, busy, footerTarget, onAnswer, onEnvironment }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 卡座 dock 目标(#125):提交区经 portal 挂进输入区 dock;缺席时
   * 提交区原位渲染。#126 起四类卡(env/通用/skill 圈选/流水线)全部
   * 走同一条透传链。 */
  footerTarget?: HTMLElement | null;
  /** 组装好的答复。返回 true 表示提交成功(此时父级会带着新详情回来)。 */
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string,
    selection?: string[]) => Promise<boolean>;
  /** env_needed 闸的专用提交口(会话视图接到 /issues/:id/environment)。 */
  onEnvironment?: (input: IssueEnvironmentForm) => Promise<boolean>;
}) {
  if (waiting.gate_kind === "env_needed") {
    // foot-docked:提交区已(将)搬进输入区 dock,卡体底部补回垫底留白。
    return <DecisionShell docked={Boolean(footerTarget)} label="配置网管环境">
      <DecisionHead kicker="配置网管环境"
        count={`${ENV_SCOPE_TEXT[waiting.gate_scope ?? ""] ?? "拉日志/换库"}需要`} />
      {waiting.context && <DecisionContext label="决策背景">
        <Markdown text={waiting.context} />
      </DecisionContext>}
      <EnvNeededForm busy={busy} scope={waiting.gate_scope}
        footerTarget={footerTarget} onSubmit={onEnvironment} />
    </DecisionShell>;
  }
  if (waiting.gate_kind === "skill_select") {
    // foot-docked:提交区已(将)搬进输入区 dock,卡体底部补回垫底留白。
    return <DecisionShell docked={Boolean(footerTarget)} label="圈选必读知识">
      <DecisionHead kicker="圈选必读知识"
        count={`${(waiting.gate_skills ?? []).length} 个可选`} />
      {waiting.context && <DecisionContext label="决策背景">
        <Markdown text={waiting.context} />
      </DecisionContext>}
      <SkillSelectForm busy={busy} skills={waiting.gate_skills ?? []}
        footerTarget={footerTarget}
        onSubmit={(selection, decision) =>
          onAnswer(decision, undefined, undefined, undefined, selection)} />
    </DecisionShell>;
  }
  if (waiting.gate_kind === "pipeline_unfixable"
      || waiting.gate_kind === "pipeline_evidence") {
    return <PipelineGateCard waiting={waiting} busy={busy}
      footerTarget={footerTarget} onAnswer={onAnswer} />;
  }
  return <GenericDecisionCard waiting={waiting} busy={busy}
    footerTarget={footerTarget} onAnswer={onAnswer} />;
}

/** 网管环境表单(2026-09-10 走查重铸,「只选不手填」):
 * - 唯一作答面:EnvironmentPicker 可搜索下拉列台账条目(IP/标签/形态),
 *   选中提交 environment_id——服务端从台账解密快照进会话 vault
 *   (ADR-0020 选入即快照),前端永远没有密码,凭据区一个都不填;
 *   搜不到就在下拉里点「新增环境」弹共用表单,录完自动选中。
 * - 拒绝(票 93)两段式:第一段展开理由框,第二段才真正提交——
 *   硬拒绝(同 scope 工具不再举卡)值得一步确认;理由选填。
 * 密码经 POST 进服务端 vault(AES-GCM 加密文件),前端不存草稿;之后会
 * 进入本问题会话的 AI 上下文供拉日志工具消费,但不出现在会话列表、状态摘要或事件流。
 * 样式(#215 迁过不重做):表单区块(快选+快照说明)保持 Tailwind 工具
 * 类;#231 起提交区容器也交 DecisionDockFoot 工具类铺陈(dock 在
 * portal 目标子树,卡片内新块一律工具类)。
 * 卡座分工(#125):快选与快照说明留在卡上;拒绝理由与提交/拒绝按钮
 * 经 IssueDecisionFooterMount 挂进输入区 dock——草稿与失败提示的状态
 * 仍归本组件,portal 只搬 DOM。 */

/** 闸卡说明文字(拒绝理由框的皮已交 shadcn Textarea 原语)。 */
const ENV_NOTE = "text-sm text-muted-foreground";

function EnvNeededForm({ busy, scope, footerTarget, onSubmit }: {
  busy: boolean;
  /** 闸的用途面(logs=拉日志 / deploy=换库部署),拒绝文案按它分叉。 */
  scope?: string;
  /** 卡座 dock 目标(#125);缺席时提交区原位渲染。 */
  footerTarget?: HTMLElement | null;
  onSubmit?: (input: IssueEnvironmentForm) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<EnvironmentView | null>(null);
  /** 拒绝两段式:第一段只展开理由框,第二段「确认拒绝」才提交。 */
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [error, setError] = useState("");

  function pickEnvironment(entry: EnvironmentView) {
    setPicked(entry);
    setError("");
  }

  async function submit() {
    if (busy || !onSubmit || !picked) return;
    // 快选:只上送条目 id,值由服务端从台账解密快照(前端零密码)。
    const ok = await onSubmit({ environment_id: picked.id });
    if (ok) {
      setPicked(null);
      setError("");
    } else {
      setError("提交未成功,请稍后重试");
    }
  }

  /** 拒绝(票 93):不填环境也能推进——硬拒绝后同 scope 工具不再举卡,
   * 配置环境成功即自动解除。提交走 /environment 的 decline 分支。 */
  async function decline() {
    if (busy || !onSubmit) return;
    if (!declineOpen) {
      setDeclineOpen(true);
      return;
    }
    const wire: IssueEnvironmentDeclineForm = {
      hosts: [],
      backend_password: "",
      decline: true,
      ...(declineNote.trim() ? { note: declineNote.trim() } : {}),
    };
    const ok = await onSubmit(wire);
    setError(ok ? "" : "提交未成功,请稍后重试");
  }

  return <div className={`tw-root grid gap-[10px] px-[15px] pt-[13px] text-base text-foreground${footerTarget ? " pb-[15px]" : ""}`}>
    <EnvironmentPicker selectedId={picked?.id ?? null}
      onPick={pickEnvironment} />
    {picked && <p className={ENV_NOTE} role="status">
      将使用「环境管理」中的 {picked.ip}:密码以选定时为准,之后环境
      管理里的改动不影响本次处理;密码无需在此填写，不会出现在页面或事件流，
      但会在执行问题处理时明文进入当前 AI 上下文。
    </p>}
    <IssueDecisionFooterMount target={footerTarget}>
      <DecisionDockFoot docked={Boolean(footerTarget)} className="pb-3.5">
        {declineOpen && <label className="grid gap-1.5 text-sm text-muted-foreground">
          <span>确定不需要?留一句理由帮 AI 调整方向(可选)</span>
          <Textarea rows={2} autoFocus
            placeholder="如:问题在页面侧即可复现,与后台日志无关…"
            value={declineNote}
            onChange={(event) => setDeclineNote(event.target.value)} />
        </label>}
        {error && <p className="text-sm text-attention" role="alert">{error}</p>}
        <div className={DECISION_SUBMIT_ROW}>
          <Button type="button" size="sm" className="flex-1"
            disabled={busy || !picked} onClick={() => void submit()}>
            {busy ? "提交中…" : "使用所选环境,继续"}
          </Button>
          <Button type="button" variant="outline" size="sm" className="flex-1"
            disabled={busy} onClick={() => void decline()}>
            {declineOpen ? "确认拒绝,继续分析"
              : ENV_DECLINE_TEXT[scope ?? "logs"] ?? ENV_DECLINE_TEXT.logs}
          </Button>
        </div>
      </DecisionDockFoot>
    </IssueDecisionFooterMount>
  </div>;
}

/** 手动输入选项的虚拟 code(不会与真实选项 code 冲突)。选了它
 * 后该问题不再要求选其他选项——用户可能对所有给定选项都不满意,
 * 需要自行手写答案。提交时手写文本作为该题答案(与开放题同通道)。 */
const MANUAL_CODE = "__manual_input__";

/** 选项行皮(原全局 .option/.radio 搭车退役,本卡自带):整行可点的
 * 单选/多选卡,圆点表选中;推荐(ADR-0004 只标注不预选)未选时琥珀
 * 描边,已选态永远压过推荐描边——拍板后卡片只呈现"已选"。 */
const OPTION_BASE = "flex w-full items-start gap-2.5 rounded-md border px-3 py-2.5 text-left text-base transition-colors";
const optionStateClass = (chosen: boolean, suggested: boolean) => chosen
  ? "border-ink bg-accent shadow-[inset_2px_0_0_var(--ink)]"
  : suggested
    ? "border-attention/55 shadow-[0_0_0_1px_color-mix(in_srgb,var(--attention)_14%,transparent)] hover:bg-accent/60"
    : "border-border hover:bg-accent/60";
const OPTION_DOT = "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]";
const OPTION_BODY = "min-w-0 flex-1 select-text";
const OPTION_TITLE = "block text-base font-medium leading-normal text-text-strong [overflow-wrap:anywhere]";
const OPTION_HINT = "block text-sm leading-normal text-muted-foreground [overflow-wrap:anywhere]";

/** skill 圈选表单(ADR-0011):按仓分组的多选清单,path 是提交身份
 * (仓段天然区分同名 skill)。「确认勾选」至少勾一项才可点;「都不用」
 * 提交空选,AI 按方法论取用次序自主——两条路的裁决在服务端同口。
 * 卡座分工(#126):勾选清单留在卡上;错误提示与「确认勾选/都不用」
 * 按钮排经 IssueDecisionFooterMount 挂进输入区 dock——勾选状态仍归
 * 本组件,portal 只搬 DOM。 */
function SkillSelectForm({ busy, skills, footerTarget, onSubmit }: {
  busy: boolean;
  skills: IssueSkillChoice[];
  /** 卡座 dock 目标(#126);缺席时提交区原位渲染。 */
  footerTarget?: HTMLElement | null;
  onSubmit: (selection: string[], decision: string) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState("");
  // 按仓分组,组内保持扫描顺序;同名 skill 靠仓段区分,不拼假名字。
  const groups: Array<{ repo: string; items: IssueSkillChoice[] }> = [];
  for (const skill of skills) {
    const group = groups.find((candidate) => candidate.repo === skill.repo);
    if (group) group.items.push(skill);
    else groups.push({ repo: skill.repo, items: [skill] });
  }

  function toggle(path: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function submit(selection: string[]) {
    if (busy) return;
    const chosen = skills.filter((skill) => selection.includes(skill.path));
    const ok = await onSubmit(
      selection,
      chosen.length
        ? `圈选必读 skill:${chosen.map((skill) => skill.name).join("、")}`
        : "都不用,AI 按取用次序自主");
    setError(ok ? "" : "提交未成功,请稍后重试");
  }

  return <div className={cn("grid gap-2.5 px-3.5 pt-3",
    footerTarget && "pb-3.5")}>
    {groups.map((group) => <fieldset className="m-0 min-w-0 border-b border-border py-3 last:border-b-0" key={group.repo}>
      <legend className="mb-2 p-0">
        <span className="text-base font-semibold text-text-strong">{group.repo}</span>
      </legend>
      <div className="grid gap-1.5">
        {group.items.map((skill) => {
          const chosen = picked.has(skill.path);
          return <button type="button" key={skill.path} role="checkbox"
            aria-checked={chosen}
            className={cn(OPTION_BASE, optionStateClass(chosen, false))}
            onClick={() => toggle(skill.path)}>
            <span aria-hidden
              className={cn(OPTION_DOT, chosen ? "border-ink" : "border-line-strong")}>
              {chosen && <span className="size-2.5 rounded-full bg-ink" />}
            </span>
            <span className={OPTION_BODY}><span className={OPTION_TITLE}>
              {skill.name}
            </span>
            {skill.description && <span className={OPTION_HINT}>
              {skill.description}
            </span>}
            </span>
          </button>;
        })}
      </div>
    </fieldset>)}
    <IssueDecisionFooterMount target={footerTarget}>
      <DecisionDockFoot docked={Boolean(footerTarget)}>
        {error && <p className="text-sm text-attention" role="alert">{error}</p>}
        <div className={DECISION_SUBMIT_ROW}>
          <Button type="button" size="sm" className="flex-1"
            disabled={!picked.size || busy}
            onClick={() => void submit([...picked])}>
            {busy ? "提交中…" : `确认勾选(${picked.size})`}
          </Button>
          <Button type="button" variant="outline" size="sm" className="flex-1"
            disabled={busy} onClick={() => void submit([])}>
            都不用,AI 按取用次序自主
          </Button>
        </div>
      </DecisionDockFoot>
    </IssueDecisionFooterMount>
  </div>;
}

/** 流水线红灯人工闸卡(2026-09-01,票 03):不可修告警与证据回灌同卡
 * 形态、两种作答面。卡面(context,服务端组装的失败摘要/逐维度明细/
 * 产物位置/处置指引)markdown 直出;仓与提交按 gate_pipeline 陈列。
 * - pipeline_unfixable:单出口作答「已在平台处理/豁免,重新监看」
 *   (code=resume),可附补充说明(随答复入账);
 * - pipeline_evidence:自由文本主通道——粘贴报错原文提交(code=supply),
 *   原文作为人工证据注入下一修复回合;空文本不可提交(服务端同尺打回)。
 * 卡座分工(#126):证据卡的报错原文是主作答字段留在卡上;不可修卡的
 * 补充说明是附言,与提交按钮一起经 IssueDecisionFooterMount 挂进输入
 * 区 dock(与 env 卡的附言+按钮同一铺陈)——草稿与失败提示仍归本组件。 */
function PipelineGateCard({ waiting, busy, footerTarget, onAnswer }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 卡座 dock 目标(#126);缺席时提交区原位渲染。 */
  footerTarget?: HTMLElement | null;
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
}) {
  const evidence = waiting.gate_kind === "pipeline_evidence";
  const [text, setText] = useState("");
  const [notes, setNotes] = useState("");
  // 补充说明截图粘贴(2026-09-10 验证闸配套):环境验证发现问题时贴
  // 现场截图,引用随作答提升进工作区,AI inspect_image 识图。
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const notesPaste = useIssueImagePaste();
  const [error, setError] = useState("");
  const ready = evidence ? !!text.trim() : true;
  // 码与文案来自服务端下发的 options 镜像(前端不推断状态);单码闸,
  // 缺 options 时回退本地字面量仅为极端旧现场的兜底显示。
  const option = waiting.question?.questions?.[0]?.options?.[0];
  const code = option?.code ?? (evidence ? "supply" : "resume");
  const actionLabel = option?.label
    ?? (evidence ? "已粘贴报错原文,继续修复" : "已在平台处理/豁免,重新监看");

  async function submit() {
    if (!ready || busy) return;
    const decision = evidence ? text.trim() : actionLabel;
    const ok = await onAnswer(
      decision,
      code,
      undefined,
      evidence ? undefined : (notes.trim() || undefined));
    setError(ok ? "" : "提交未成功,请稍后重试");
  }

  return <DecisionShell docked={Boolean(footerTarget)}
    label={evidence ? "贴回流水线报错原文" : "流水线红灯人工处理"}>
    <DecisionHead
      kicker={evidence ? "流水线红灯·贴回报错原文" : "流水线红灯·需要人工处理"}
      count={evidence ? "粘贴原文后继续修复" : "交付平台处理/豁免"} />
    {waiting.gate_pipeline && <p className={DECISION_NOTE}>
      仓 {waiting.gate_pipeline.repo} · 提交 {waiting.gate_pipeline.sha.slice(0, 12)}
    </p>}
    {waiting.context && <DecisionContext
      label={evidence ? "缺口详情" : "失败详情"}
      className={cn(!evidence && footerTarget && "mb-3.5")}>
      <Markdown text={waiting.context} />
    </DecisionContext>}
    {evidence && <div className={cn("grid gap-2.5 px-3.5 pt-3",
      footerTarget && "pb-3.5")}>
      <DecisionField label="报错原文(带文件/行号/堆栈)">
        <Textarea className="min-h-48 resize-y" rows={8}
          placeholder="把交付平台上失败项的报错原文粘贴到这里——它会作为人工证据注入下一修复回合…"
          value={text}
          onChange={(event) => setText(event.target.value)} />
      </DecisionField>
    </div>}
    <IssueDecisionFooterMount target={footerTarget}>
      <DecisionDockFoot docked={Boolean(footerTarget)}>
        {/* 不可修卡的补充说明是附言(票 03),随提交钮进 dock;证据卡的
            主字段(报错原文)已在卡上,dock 里只剩错误提示与提交钮。 */}
        {!evidence && <div className="grid gap-2.5">
          <DecisionField label="补充说明(可选):在平台做了什么处理">
            <Textarea className="min-h-17 resize-y" rows={3}
              ref={notesRef}
              onPaste={(event) => notesPaste.onPaste(event, (markdown) => {
                const { next, caret } = insertMarkdownAtCursor(notesRef.current, notes, markdown);
                setNotes(next);
                window.requestAnimationFrame(() => {
                  notesRef.current?.focus();
                  notesRef.current?.setSelectionRange(caret, caret);
                });
              })}
              placeholder="如:已豁免规则 R1 / 已处理 SuperChecker 告警…"
              value={notes}
              onChange={(event) => setNotes(event.target.value)} />
          </DecisionField>
        </div>}
        {error && <p className="text-sm text-attention" role="alert">{error}</p>}
        <div className={DECISION_SUBMIT_ROW}>
          <Button type="button" size="sm" className="flex-1"
            disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "提交中…" : actionLabel}
          </Button>
        </div>
      </DecisionDockFoot>
    </IssueDecisionFooterMount>
  </DecisionShell>;
}


export function areIssueQuestionsComplete(
  questions: Array<{ options: ReadonlyArray<unknown> }>,
  picked: Record<string, string>,
  custom: Record<number, string>,
): boolean {
  return questions.length > 0 && questions.every((item, index) => {
    if (item.options.length > 0) {
      const pick = picked[index];
      if (!pick) return false;
      // 选了手动输入:要求填了自定义文本才算答完。
      if (pick === MANUAL_CODE) return !!custom[index]?.trim();
      return true;
    }
    return !!custom[index]?.trim();
  });
}

function GenericDecisionCard({ waiting, busy, footerTarget, onAnswer }: {
  waiting: IssueWaitingCard;
  busy: boolean;
  /** 卡座 dock 目标(#126);缺席时提交区原位渲染。 */
  footerTarget?: HTMLElement | null;
  onAnswer: (decision: string, code?: string,
    answers?: Record<string, string>, notes?: string) => Promise<boolean>;
}) {
  const questions = waiting.question?.questions ?? [];
  const contextLabel = "决策背景";
  // picked 存决策码(选项的身份是 code,文案只用于显示)。
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<number, string>>({});
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const radioRefs = useRef<Record<number, Array<HTMLButtonElement | null>>>({});

  // 一张卡可能同时有选择题和开放题。逐题全答完才允许提交，不能让
  // “选择题都选了”或“任一开放题写了”掩盖同卡里仍空着的问题。
  const ready = areIssueQuestionsComplete(questions, picked, custom)
    || (questions.length === 0 && !!notes.trim());

  function moveRadio(
    questionIndex: number,
    optionIndex: number,
    key: string,
  ): boolean {
    const options = questions[questionIndex]?.options ?? [];
    if (!options.length) return false;
    // 自定义答复也是这个单选组里的正式选项，必须能用方向键到达。
    const choices = [...options.map((option) => option.code), MANUAL_CODE];
    const next = key === "Home" ? 0
      : key === "End" ? choices.length - 1
        : key === "ArrowRight" || key === "ArrowDown"
          ? (optionIndex + 1) % choices.length
          : key === "ArrowLeft" || key === "ArrowUp"
            ? (optionIndex - 1 + choices.length) % choices.length
            : undefined;
    if (next === undefined) return false;
    setPicked((current) => ({
      ...current,
      [questionIndex]: choices[next],
    }));
    window.requestAnimationFrame(() =>
      radioRefs.current[questionIndex]?.[next]?.focus());
    return true;
  }

  async function submit() {
    if (!ready || busy) return;
    const labels: string[] = [];
    const answers: Record<string, string> = {};
    let code: string | undefined;
    questions.forEach((item, index) => {
      if (item.options.length) {
        const pickedCode = picked[index];
        if (!pickedCode) return;
        if (pickedCode === MANUAL_CODE) {
          // 手动输入:自定义文本作为该题答案(与开放题同通道)。
          const own = custom[index]?.trim();
          if (!own) return;
          answers[String(index)] = own;
          labels.push(own);
        } else {
          const option = item.options.find((candidate) =>
            candidate.code === pickedCode);
          if (option) labels.push(option.label);
          answers[String(index)] = pickedCode;
          code ??= pickedCode;
        }
      } else {
        const own = custom[index]?.trim();
        if (!own) return;
        answers[String(index)] = own;
        labels.push(own);
      }
    });
    const ok = await onAnswer(
      labels.join("\n"), code, answers, notes.trim() || undefined);
    if (ok) {
      setPicked({});
      setCustom({});
      setNotes("");
      setNotesOpen(false);
    }
  }

  // 环境验证卡等的是验证不是答复(ADR-0043):卡壳措辞随卡种换——
  // 通过无需作答,合入即通过;其余卡照旧「等你答复」。
  const cardKicker = waiting.gate_kind === "env_verify" ? "待验证" : "等你答复";
  return <DecisionShell docked={Boolean(footerTarget)} label={cardKicker}>
    <DecisionHead kicker={cardKicker} count={`${questions.length} 个问题`} />

    {waiting.context && <DecisionContext label={contextLabel}
      className={cn(questions.length === 0 && footerTarget && "mb-3.5")}>
      <Markdown text={waiting.context} />
    </DecisionContext>}

    {questions.some((item) => item.options.length > 0) && (
      <p className={DECISION_NOTE} role="status" aria-live="polite">
        {busy ? "正在提交答复…" : Object.values(picked).some(Boolean)
          ? <><strong>已选择，尚未提交。</strong>可补充说明，再点击下方「提交答复」。</>
          : "选中选项不会立即发送；请在下方提交答复。"}
      </p>
    )}
    {questions.map((item, index) => <fieldset
      className="m-0 min-w-0 border-b border-border px-3.5 py-3 last:border-b-0" key={index}>
      <legend className="mb-2.5 flex w-full items-start gap-2.5 p-0">
        <span className="mt-0.5 shrink-0 font-mono text-xs tabular-nums text-faint">{String(index + 1).padStart(2, "0")}</span>
        <span className="whitespace-pre-wrap text-base font-semibold leading-[1.55] text-text-strong [overflow-wrap:anywhere]">{item.question || "需要你确认"}</span>
      </legend>
      {item.options.length > 0
        ? <div className="grid gap-1.5" role="radiogroup"
            aria-label={`问题 ${index + 1}：${item.question || "需要你确认"}`}>
            {item.options.map((option, optionIndex) => {
              const chosen = picked[index] === option.code;
              // 推荐按码标注(ADR-0004 只标注不预选):无推荐的旧卡
              // 该键缺席,谁都不匹配,渲染与现状一致;推荐被点中后
              // 正常进已选态,徽标常驻但描边让位(accent 蓝)。
              const suggested = item.recommended === option.code;
              return <button type="button" key={option.code} role="radio"
                ref={(node) => {
                  (radioRefs.current[index] ??= [])[optionIndex] = node;
                }}
                aria-checked={chosen}
                tabIndex={chosen || (!picked[index] && optionIndex === 0) ? 0 : -1}
                className={cn(OPTION_BASE, optionStateClass(chosen, suggested))}
                title={chosen ? "再次点击取消选择" : undefined}
                onKeyDown={(event) => {
                  if (moveRadio(index, optionIndex, event.key)) event.preventDefault();
                }}
                onClick={() => setPicked((current) =>
                  toggleDecisionChoice(current, index, option.code))}>
                <span aria-hidden
                  className={cn(OPTION_DOT, chosen ? "border-ink" : "border-line-strong")}>
                  {chosen && <span className="size-2.5 rounded-full bg-ink" />}
                </span>
                <span className={OPTION_BODY}><span className={OPTION_TITLE}>
                  {option.label}
                  {suggested && <Badge variant="warning" className="ml-1.5 align-middle">AI 推荐</Badge>}
                </span></span>
              </button>;
            })}
            {/* 手动输入:每个问题都可以不选给定选项,自行手写答案。
              选了它后该问题不再要求选其他选项——用户可能对所有
              给定选项都不满意,需要自行手写。提交时手写文本作为
              该题答案(与开放题同通道)。 */}
            {(() => {
              const manualChosen = picked[index] === MANUAL_CODE;
              const manualIndex = item.options.length;
              return <button type="button" key={MANUAL_CODE} role="radio"
                ref={(node) => {
                  (radioRefs.current[index] ??= [])[manualIndex] = node;
                }}
                aria-checked={manualChosen}
                tabIndex={manualChosen ? 0 : -1}
                className={cn(OPTION_BASE, optionStateClass(manualChosen, false))}
                title={manualChosen ? "再次点击取消自定义答复" : undefined}
                onKeyDown={(event) => {
                  if (moveRadio(index, manualIndex, event.key)) event.preventDefault();
                }}
                onClick={() => setPicked((current) =>
                  toggleDecisionChoice(current, index, MANUAL_CODE))}>
                <span aria-hidden
                  className={cn(OPTION_DOT, manualChosen ? "border-ink" : "border-line-strong")}>
                  {manualChosen && <span className="size-2.5 rounded-full bg-ink" />}
                </span>
                <span className={OPTION_BODY}><span className={cn(OPTION_TITLE, "text-muted-foreground")}>
                  自定义答复
                </span><span className={OPTION_HINT}>
                  {waiting.gate_kind === "env_verify"
                    ? "有别的插曲要说:交给 AI 处理,验证继续等合入"
                    : "以上选项都不合适时使用"}
                </span></span>
              </button>;
            })()}
            {picked[index] === MANUAL_CODE && (
              <Textarea className="mt-2 min-h-16"
                placeholder="写下你对这道题的答案…"
                value={custom[index] ?? ""}
                onChange={(event) => setCustom({ ...custom, [index]: event.target.value })} />
            )}
          </div>
        : <Textarea className="min-h-16"
            placeholder="这道题没有给定选项——写下你的具体答案…"
            value={custom[index] ?? ""}
            onChange={(event) => setCustom({ ...custom, [index]: event.target.value })} />}
    </fieldset>)}

    {questions.length === 0 && <p className={cn(DECISION_NOTE,
      footerTarget && "mb-3.5")}>
      这张问题卡没有列出选项——在下方补充说明里写下你的答复。
    </p>}

    {/* 卡座分工(#126):附言(补充说明)与提交按钮经挂载器进输入区
        dock;题面/选项/推荐徽标留在卡上——作答状态(picked/custom/
        notes 草稿)仍归本组件,portal 只搬 DOM。 */}
    <IssueDecisionFooterMount target={footerTarget}>
      <DecisionDockFoot docked={Boolean(footerTarget)}>
        {notesOpen
          ? <div className="grid gap-1.5">
              <Textarea
                placeholder="补充说明(可选):原因、约束、现场信息…"
                value={notes}
                onChange={(event) => setNotes(event.target.value)} />
              <span className="text-xs text-muted-foreground">这段说明会随答复一起交给 AI,不会改变上面所选的分支。</span>
            </div>
          : <Button type="button" variant="ghost" size="sm"
              className="h-auto w-fit px-0 text-sm text-muted-foreground hover:text-foreground"
              onClick={() => setNotesOpen(true)}>+ 补充说明(可选)</Button>}

        <div className={DECISION_SUBMIT_ROW}>
          <Button type="button" size="sm" className="flex-1"
            disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? "提交中…" : "提交答复"}
          </Button>
        </div>
      </DecisionDockFoot>
    </IssueDecisionFooterMount>
  </DecisionShell>;
}
