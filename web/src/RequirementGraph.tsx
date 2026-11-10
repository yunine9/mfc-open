import { PersonName } from "./People";
import { requirementGraphVisible } from "./taskHierarchy";
import { useState, type ReactNode } from "react";
import {
  REQUIREMENT_GRAPH_ARTIFACT,
  addAnnotation,
  type Annotation,
  type TaskSummary,
} from "./api";
import { graphAnnotationLocationKey } from "./annotateTargets";
import { requirementNodeLabel } from "./requirementGraphLabel";
import { Textarea } from "@/components/ui/textarea";

interface GraphAnnotationTarget {
  label: string;
  file: string;
  line: number;
  anchor: string;
  quote: string;
}

function repoName(id: string, task: TaskSummary): string {
  const node = task.requirement_graph?.repositories.find((item) => item.id === id);
  if (!node) return id;
  return requirementNodeLabel(node);
}

const childStatusText: Record<string, string> = {
  queued: "排队中", running: "执行中", pausing: "暂停中", paused: "已暂停",
  waiting_for_human: "待确认", verifying: "验证中", await_merge: "等待合入",
  coordinating: "子任务进行中", completed: "已完成", stalled: "已停机",
  failed: "失败", canceled: "已取消",
};

/** 按依赖把交付单元排成串行阶段:能先行的一批、等它们的下一批……
 * Agent 产物若暂时成环,先如实放同一阶段(确认时服务端会阻止落单)。
 * 图和右栏确认卡共用,两处报的"几个阶段"才不会打架。 */
export function chainStages<T extends { id: string }>(graph: {
  repositories: readonly T[];
  dependencies: ReadonlyArray<{ from: string; to: string }>;
}): T[][] {
  const remaining = new Set(graph.repositories.map((repository) => repository.id));
  const stages: T[][] = [];
  while (remaining.size) {
    const ready = graph.repositories.filter((repository) => remaining.has(repository.id)
      && graph.dependencies.filter((edge) => edge.from === repository.id)
        .every((edge) => !remaining.has(edge.to)));
    const current = ready.length ? ready
      : graph.repositories.filter((repository) => remaining.has(repository.id));
    stages.push(current);
    current.forEach((repository) => remaining.delete(repository.id));
  }
  return stages;
}

export function RequirementGraph({
  task,
  onOpenTask,
  teamInvite,
  annotationEnabled = false,
  annotations = [],
  onAnnotationAdded,
}: {
  task: TaskSummary;
  onOpenTask?: (taskId: string) => void;
  /** 邀请讨论参与人的表单。它属于"主任务团队"那一块,就长在药丸旁边的
   * 按钮后面——单独挂在图下面成一条细条,看着像掉出来的页脚(用户实测)。 */
  teamInvite?: ReactNode;
  /** 图批注仍落进任务统一批注账，只是锚点从“第几行”换成整体/模块/边。 */
  annotationEnabled?: boolean;
  annotations?: ReadonlyArray<Pick<Annotation,
    "artifact" | "anchor" | "status">>;
  onAnnotationAdded?: () => void;
}) {
  const graph = task.requirement_graph;
  const [expanded, setExpanded] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [annotationTarget, setAnnotationTarget] =
    useState<GraphAnnotationTarget>();
  const [annotationNote, setAnnotationNote] = useState("");
  const [annotationBusy, setAnnotationBusy] = useState(false);
  const [annotationError, setAnnotationError] = useState("");
  if (!graph || !requirementGraphVisible(task)) return null;
  const candidateCount = graph.repository_assessments?.length
    ?? task.repositories?.length
    ?? graph.repositories.length;
  const projectionReady = graph.stage === "confirmed"
    || graph.projection_state === "ready";
  const participantNames = [...new Set([
    ...(task.collaborators ?? []),
    ...graph.repositories.map((repository) => repository.assignee)
      .filter((account): account is string => !!account),
  ])].filter((account) => account !== task.luban_account);
  const inMain = graph.repositories.length === 1 && (!graph.repositories[0].task_id || graph.repositories[0].task_id === task.id);
  const generated = graph.repositories.filter((repository) => repository.task_id).length;
  const completed = graph.repositories.filter((repository) =>
    repository.task_status === "completed").length;
  const stages = projectionReady ? chainStages(graph) : [];
  const noChange = graph.repository_assessments?.filter((assessment) =>
    assessment.outcome === "no_change") ?? [];
  const splitUrls = new Set(graph.repositories.map((item) => item.url)
    .filter((url, index, urls) => urls.indexOf(url) !== index));
  const canAnnotateGraph = annotationEnabled && graph.stage === "analysis"
    && projectionReady;
  const annotationCount = (anchor: string) => annotations.filter((item) =>
    item.artifact === REQUIREMENT_GRAPH_ARTIFACT
      && item.anchor === anchor && item.status !== "dropped").length;
  const openAnnotation = (target: GraphAnnotationTarget) => {
    setAnnotationTarget(target);
    setAnnotationNote("");
    setAnnotationError("");
  };
  const saveAnnotation = async () => {
    if (!annotationTarget || !annotationNote.trim() || annotationBusy) return;
    setAnnotationBusy(true);
    setAnnotationError("");
    try {
      const result = await addAnnotation(task.id, {
        artifact: REQUIREMENT_GRAPH_ARTIFACT,
        file: annotationTarget.file,
        line: annotationTarget.line,
        anchor: annotationTarget.anchor,
        quote: annotationTarget.quote,
        note: annotationNote.trim(),
        kind: "doc",
        route: "agent",
      });
      if (result.error) {
        setAnnotationError(result.error);
        return;
      }
      setAnnotationTarget(undefined);
      setAnnotationNote("");
      onAnnotationAdded?.();
    } catch (reason) {
      setAnnotationError(reason instanceof Error
        ? reason.message : "批注保存失败，请重试");
    } finally {
      setAnnotationBusy(false);
    }
  };
  const planAnchor = "模块拆分与依赖：整体方案";
  return <details className="requirement-graph" open={expanded}
    onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary>
      <div>
        <span>模块拆分与依赖</span>
        <strong id="requirement-graph-title">模块拆分与依赖</strong>
      </div>
      <small>{!projectionReady
        ? graph.projection_state === "invalid" ? "分析产物需要修正" : "正在生成分析产物"
        : graph.repositories.length === 0 ? "确认后结束 · 无需开发"
        : inMain ? graph.stage === "confirmed" ? "在本任务开发与交付" : "待确认 · 在本任务继续开发"
        : generated < graph.repositories.length
          ? `待确认 · ${graph.repositories.length} 个模块任务`
          : `${completed}/${graph.repositories.length} 个模块任务已完成`}</small>
      <i className="requirement-toggle" aria-hidden />
    </summary>
    <div className="requirement-graph-body">
      {canAnnotateGraph && <div className="requirement-graph-review-tools">
        <div>
          <strong>直接在图上提意见</strong>
          <small>整体切法、某个模块或某条依赖都可以单独批注</small>
        </div>
        <button type="button" onClick={() => openAnnotation({
          label: "整体拆分方案",
          file: "模块拆分与依赖 / 整体方案",
          line: 1,
          anchor: planAnchor,
          quote: `${graph.repositories.length} 个模块任务 · ${
            graph.dependencies.length} 条硬依赖 · 方案版本 ${
            graph.plan_revision ?? "未标记"}`,
        })}>
          对整体方案提意见
          {annotationCount(planAnchor) > 0
            && <i>{annotationCount(planAnchor)}</i>}
        </button>
      </div>}
      <div className="requirement-root-task" data-review-anchor={planAnchor}>
        <span>主任务</span>
        <div><strong>{task.title ?? task.requirement}</strong>
          <small>{task.ticket ?? task.id} · 先排查候选仓，再按实际交付范围推进</small></div>
        <em className={task.status}>{childStatusText[task.status] ?? task.status}</em>
      </div>
      <div className="requirement-split-label">
        <span>{!projectionReady
          ? `正在排查 ${candidateCount} 个候选仓，不会直接按仓建任务`
          : graph.repositories.length === 0
            ? "全部候选仓均无需修改，不生成开发任务"
            : inMain ? graph.stage === "confirmed" ? "方案已确认，由本任务完成开发与交付" : "一个交付单元，确认后在本任务继续开发"
            : generated
              ? `已创建 ${generated} 个模块任务`
              : `确认方案后创建 ${graph.repositories.length} 个模块任务`}</span>
        {/* 从直接开发转过来的单子:说清是谁、在哪个阶段、为什么提议拆分,
            人才知道这张确认卡从哪来。 */}
        {task.split_escalation && <details className="requirement-split-escalation">
          <summary>查看拆分依据{task.split_escalation.phase
            ? ` · ${task.split_escalation.phase}` : ""}</summary>
          <p>{task.split_escalation.reason}</p>
        </details>}
      </div>
      <div className="requirement-main-team">
        <div><span>主任务团队</span>
          <small>1 位主责任人 · {participantNames.length} 位参与成员</small>
          {teamInvite && <button type="button" className="requirement-team-invite"
            aria-expanded={inviteOpen}
            onClick={() => setInviteOpen((value) => !value)}>
            {inviteOpen ? "收起邀请" : "邀请参与人"}
          </button>}
        </div>
        <div className="requirement-team-pills">
          <strong><PersonName account={task.luban_account} fallback="本地主责任人" /><i>主责任人</i></strong>
          {participantNames.map((account) => <span key={account}>{account}
            <i>{task.collaborators?.includes(account) ? "参与讨论" : "单元执行"}</i>
          </span>)}
          {participantNames.length === 0 && <em>尚未邀请讨论参与人</em>}
        </div>
        {teamInvite && inviteOpen && <div className="requirement-team-invite-body">
          {teamInvite}
        </div>}
      </div>
      {!projectionReady && (
        <section className={`requirement-projection-state ${
          graph.projection_state === "invalid" ? "invalid" : "pending"}`}>
          <strong>{graph.projection_state === "invalid"
            ? "模块拆分与依赖图还不能确认"
            : "Agent 正在生成模块拆分与依赖图"}</strong>
          <p>{graph.projection_error
            ?? "下面这些只是候选仓，分析完成后只有确实需要修改的模块才会生成任务。"}</p>
          <div>{graph.repositories.map((repository) => (
            <span key={repository.url}>{repository.name}</span>
          ))}</div>
        </section>
      )}
      {projectionReady && graph.repository_assessments?.length ? (
        <section className="requirement-assessments" aria-label="候选仓排查结论">
          <header>
            <strong>候选仓排查结论</strong>
            <small>{graph.repository_assessments.length} 个已排查 · {noChange.length} 个无需修改</small>
          </header>
          <div>{graph.repository_assessments.map((assessment) => (
            <article key={assessment.url} className={assessment.outcome}>
              <span>{assessment.outcome === "change_required" ? "需要修改" : "无需修改"}</span>
              <strong>{assessment.name}</strong>
              <p>{assessment.reason}</p>
            </article>
          ))}</div>
        </section>
      ) : null}
      {projectionReady && graph.repositories.length > 0 && (
      <div className="requirement-stages" aria-labelledby="requirement-graph-title">
        {stages.map((repositories, stage) => <div className="requirement-stage"
          key={repositories.map((repository) => repository.id).join("-")}>
          <small>{stage === 0 ? "可先行" : `第 ${stage + 1} 阶段`}</small>
          <div>
            {repositories.map((repository) => {
              const parents = graph.dependencies.filter((edge) => edge.from === repository.id);
              return <article key={repository.id}
                data-review-anchor={graphAnnotationLocationKey(`模块 ${repository.id}：`)}
                className={parents.length ? "has-prerequisite" : "ready"}
                title={repository.url}>
                <div className="repo-node-head">
                  <i aria-hidden />
                  <strong>{requirementNodeLabel(repository)}</strong>
                  {canAnnotateGraph && (() => {
                    const anchor = `模块 ${repository.id}：${
                      repository.scope?.name ?? repository.name}`;
                    return <button type="button" className="graph-node-annotate"
                      onClick={() => openAnnotation({
                        label: `模块：${repository.scope?.name ?? repository.name}`,
                        file: `模块拆分与依赖 / 模块 / ${
                          repository.scope?.name ?? repository.name}`,
                        line: graph.repositories.indexOf(repository) + 2,
                        anchor,
                        quote: [
                          requirementNodeLabel(repository),
                          `职责：${repository.responsibility ?? "未说明"}`,
                          `参考位置：${repository.scope?.paths.join("、") ?? "未说明"}`,
                        ].join("\n"),
                      })}>
                      批注{annotationCount(anchor) > 0
                        && <i>{annotationCount(anchor)}</i>}
                    </button>;
                  })()}
                  {repository.task_id && repository.task_id !== task.id && <button type="button"
                    onClick={() => onOpenTask?.(repository.task_id!)}>查看子任务</button>}
                </div>
                {repository.task_id && <span className={`repo-task-status ${
                  repository.task_status ?? "queued"}`}>
                  {childStatusText[repository.task_status ?? "queued"] ?? repository.task_status}
                  {repository.current_phase ? ` · ${repository.current_phase}` : ""}
                </span>}
                <span className="repo-assignee">
                  {repository.assignee ? <>负责人 · <PersonName account={repository.assignee} /></> : "负责人待确认"}
                </span>
                <span className="repo-ticket">
                  {/* 一仓拆多单元时单号逐单元填,父任务单号不是任何一块的
                      单号;原来这里回落到它,和右栏留空等人填的输入框打架。 */}
                  AR 单号 · {repository.ticket
                    ?? (splitUrls.has(repository.url) ? "待填" : task.ticket ?? "待确认")}
                </span>
                {repository.scope && repository.scope.paths.length > 0 &&
                  <span className="repo-scope-paths" title={repository.scope.paths.join("\n")}>
                    参考位置 · {repository.scope.paths.join("、")}
                  </span>}
                {repository.responsibility && (repository.responsibility.length > 160
                  ? <details className="repo-responsibility"><summary>职责与验收详情</summary><p>{repository.responsibility}</p></details>
                  : <p>{repository.responsibility}</p>)}
                {parents.length > 0 && <span className="repo-prerequisite">
                  等待 {parents.map((edge) => repoName(edge.to, task)).join("、")}
                </span>}
              </article>;
            })}
          </div>
        </div>)}
      </div>)}
      {projectionReady && graph.repositories.length === 0 && (
        <div className="requirement-no-delivery">
          <strong>无需创建开发任务</strong>
          <span>所有候选仓均已排查并确认不需要修改，确认后本分析任务直接结束。</span>
        </div>
      )}
      {projectionReady && graph.repositories.length > 1
        && graph.dependencies.length === 0 && (
          <div className="requirement-parallel-note">
            <strong>这些模块没有硬依赖，可以并行推进</strong>
          </div>
        )}
      {projectionReady && graph.dependencies.length > 0 && <div className="requirement-edges">
        {graph.dependencies.map((edge, index) => <div key={`${edge.from}-${edge.to}-${index}`}
          data-review-anchor={`依赖 ${edge.from} -> ${edge.to}`}>
          <span><strong>{repoName(edge.from, task)}</strong><i>依赖</i>
            <strong>{repoName(edge.to, task)}</strong></span>
          {edge.reason && <small>{edge.reason}</small>}
          {canAnnotateGraph && (() => {
            const anchor = `依赖 ${edge.from} -> ${edge.to}`;
            return <button type="button" className="graph-edge-annotate"
              onClick={() => openAnnotation({
                label: `依赖：${repoName(edge.from, task)} → ${repoName(edge.to, task)}`,
                file: `模块拆分与依赖 / 依赖 / ${repoName(edge.from, task)} → ${
                  repoName(edge.to, task)}`,
                line: graph.repositories.length + index + 2,
                anchor,
                quote: `${repoName(edge.from, task)} 依赖 ${repoName(edge.to, task)}`
                  + `${edge.reason ? `\n原因：${edge.reason}` : ""}`,
              })}>
              批注{annotationCount(anchor) > 0
                && <i>{annotationCount(anchor)}</i>}
            </button>;
          })()}
        </div>)}
      </div>}
      {(task.cross_repository_updates?.length ?? 0) > 0 && (
        <details className="cross-repository-ledger">
          <summary>分工后的跨仓影响 <b>{task.cross_repository_updates!.length}</b></summary>
          <ol>{task.cross_repository_updates!.slice(-10).reverse().map((update) => (
            <li key={update.id}>
              <div><strong>{update.source_repository ?? update.source_task_id}</strong>
                <span><PersonName account={update.author} /></span></div>
              <p>{update.text}</p>
            </li>
          ))}</ol>
        </details>
      )}
      {task.status === "waiting_for_human" && <p className="requirement-graph-note">
        {!projectionReady
          ? "当前只能退回让 Agent 补齐产物，不能用候选仓占位数据创建任务。"
          : inMain ? "核对完成后，请在右侧确认并在本任务继续开发，或退回修改。"
          : graph.repositories.length > 0
            ? `核对完成后，请在右侧确认创建 ${graph.repositories.length} 个模块任务，或退回修改。`
            : "核对完成后，请在右侧确认分析结论并结束，或退回修改。"}
      </p>}
      {annotationTarget && <div className="graph-annotation-backdrop"
        role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !annotationBusy) {
            setAnnotationTarget(undefined);
          }
        }}>
        <section className="graph-annotation-editor" role="dialog"
          aria-modal="true" aria-labelledby="graph-annotation-title">
          <header>
            <div><span>方案批注</span>
              <strong id="graph-annotation-title">{annotationTarget.label}</strong></div>
            <button type="button" aria-label="关闭批注"
              disabled={annotationBusy}
              onClick={() => setAnnotationTarget(undefined)}>×</button>
          </header>
          <blockquote>{annotationTarget.quote}</blockquote>
          <Textarea className="min-h-[118px] resize-y bg-surface" autoFocus rows={5} value={annotationNote}
            placeholder="直接说明希望怎么调整；不需要为了批注去找文档中的某一行"
            onChange={(event) => setAnnotationNote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !annotationBusy) {
                setAnnotationTarget(undefined);
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                void saveAnnotation();
              }
            }} />
          {annotationError && <p className="graph-annotation-error" role="alert">
            {annotationError}</p>}
          <footer><small>记下后，在右侧选择“需要修改”，意见会随决定交给 Agent</small>
            <div><button type="button" disabled={annotationBusy}
              onClick={() => setAnnotationTarget(undefined)}>取消</button>
            <button type="button" className="primary"
              disabled={annotationBusy || !annotationNote.trim()}
              onClick={() => void saveAnnotation()}>
              {annotationBusy ? "记下中…" : "记下意见"}
            </button></div>
          </footer>
        </section>
      </div>}
    </div>
  </details>;
}
