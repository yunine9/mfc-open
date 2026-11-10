import { useEffect, useMemo, useRef, useState } from "react";
import {
  listCollaborationAssignees,
  type CollaborationAssignee,
} from "./api";
import { UserPicker } from "./UserPicker";
import { cn } from "cn";
import { chainStages } from "./RequirementGraph";
import { Input } from "@/components/ui/input";

export interface RepositoryAssigneeSelection {
  assignments: Record<string, string>;
  tickets: Record<string, string>;
  ready: boolean;
  loading: boolean;
  error?: string;
}

export const EMPTY_REPOSITORY_ASSIGNEE_SELECTION: RepositoryAssigneeSelection = {
  assignments: {}, tickets: {}, ready: false, loading: true,
};

/** 分组来自真实依赖；仓库相同不额外改变执行顺序。 */
export function assignmentStageLabel(stage: ReadonlyArray<{ url: string }>, index: number): string {
  return stage.length <= 1 ? `第 ${index + 1} 步 · ${index === 0 ? "先做" : "接着做"}`
    : `第 ${index + 1} 组 · 可并行`;
}

export function RepositoryAssigneePicker({
  taskId,
  repositories,
  defaultAssignee,
  defaultTicket,
  selection,
  onSelectionChange,
  saveState = "idle",
  dependencies = [],
  onOpenStory,
  onOpenModule,
}: {
  taskId: string;
  repositories: Array<{
    id: string; name: string; url: string; responsibility?: string;
    assignee?: string; ticket?: string;
    scope?: { name: string; paths: string[] };
  }>;
  defaultAssignee?: string;
  defaultTicket?: string;
  selection: RepositoryAssigneeSelection;
  onSelectionChange: (selection: RepositoryAssigneeSelection) => void;
  saveState?: "idle" | "saving" | "saved" | "error";
  dependencies?: Array<{ from: string; to: string; reason?: string }>;
  onOpenStory?: () => void;
  onOpenModule?: (id: string) => void;
}) {
  const [people, setPeople] = useState<CollaborationAssignee[]>([]);
  const draftKey = JSON.stringify([taskId, repositories.map((item) => [item.id, item.url])]);
  const edits = useRef({ key: draftKey, assignments: {} as Record<string, string>, tickets: {} as Record<string, string> });
  const assignmentKey = repositories.map((item) =>
    `${item.id}:${item.assignee ?? ""}:${item.ticket ?? ""}`).join("\0");
  const initialAssignments = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.assignee ?? defaultAssignee ?? "",
    ]),
  ), [taskId, assignmentKey, defaultAssignee]);
  // 一仓拆成多单元时仍在这张卡上逐单元确认 AR；多个串行单元可以
  // 共用同一 AR。只有一仓一单元的老路才沿用下单时填的单号。
  const splitUrls = new Set(repositories.map((item) => item.url)
    .filter((url, index, urls) => urls.indexOf(url) !== index));
  const initialTickets = useMemo(() => Object.fromEntries(
    repositories.map((repository) => [
      repository.id,
      repository.ticket ?? (splitUrls.has(repository.url) ? "" : defaultTicket ?? ""),
    ]),
  ), [taskId, assignmentKey, defaultTicket]);

  type Unit = typeof repositories[number];
  const unitLabel = (unit: Unit) => unit.scope?.name
    ? `${unit.name} · ${unit.scope.name}` : unit.name;
  const ticketsReady = (
    tickets: Record<string, string>,
  ) => repositories.every((repository) => {
      const value = tickets[repository.id]?.trim() ?? "";
      return Boolean(value) && !/\s/.test(value);
    });

  useEffect(() => {
    let alive = true;
    if (edits.current.key !== draftKey) edits.current = { key: draftKey, assignments: {}, tickets: {} };
    // Polling can echo an earlier autosave while typing. Keep local edits, including
    // an intentionally empty field, and also merge edits made while people load.
    const currentDraft = () => ({
      assignments: { ...initialAssignments, ...edits.current.assignments },
      tickets: { ...initialTickets, ...edits.current.tickets },
    });
    onSelectionChange({ ...currentDraft(),
      ready: false, loading: true });
    void listCollaborationAssignees().then((candidates) => {
      if (!alive) return;
      setPeople(candidates);
      const byName = new Map(candidates.map((candidate) =>
        [candidate.username, candidate]));
      const draft = currentDraft();
      const ready = repositories.every((repository) =>
        byName.get(draft.assignments[repository.id])?.ready === true)
        && ticketsReady(draft.tickets);
      onSelectionChange({ ...draft,
        ready, loading: false });
    }).catch((cause) => {
      if (!alive) return;
      onSelectionChange({
        ...currentDraft(),
        ready: false,
        loading: false,
        error: cause instanceof Error ? cause.message : "责任人状态读取失败",
      });
    });
    return () => { alive = false; };
  }, [draftKey, initialAssignments, initialTickets]);

  const peopleByName = new Map(people.map((person) => [person.username, person]));
  function chooseAssignee(repositoryId: string, value: string) {
    edits.current.assignments[repositoryId] = value;
    const nextAssignments = { ...selection.assignments, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(nextAssignments[repository.id])?.ready === true)
      && ticketsReady(selection.tickets);
    onSelectionChange({ ...selection, assignments: nextAssignments, ready,
      error: undefined });
  }

  function chooseTicket(repositoryId: string, value: string) {
    edits.current.tickets[repositoryId] = value;
    const nextTickets = { ...selection.tickets, [repositoryId]: value };
    const ready = repositories.every((repository) =>
      peopleByName.get(selection.assignments[repository.id])?.ready === true)
      && ticketsReady(nextTickets);
    onSelectionChange({ ...selection, tickets: nextTickets, ready,
      error: undefined });
  }

  const stages = chainStages({ repositories, dependencies });
  // 皮(#233 收官):原 module-assignment.css/repository-assignees 皮换装工具类,
  // 该段 CSS 已退役(决策确认态的上下文覆盖随 #233 核对为零消费者)。
  return <section className="m-0 overflow-hidden rounded-[11px] border border-primary/25 bg-surface" aria-label="任务分工">
    <header className="flex items-end justify-between gap-3 border-b border-line bg-surface-2 px-[13px] py-3">
      <div className="grid gap-0.5"><strong className="text-[15px] text-text-strong">任务分工</strong></div>
      {onOpenStory && <button type="button" className="cursor-pointer border-0 bg-none p-0 text-xs text-primary hover:underline" onClick={onOpenStory}>查看完整方案</button>}
    </header>
    <div className="grid gap-4 p-3.5">
      {stages.map((stage, stageIndex) => <section key={stageIndex} className="grid min-w-0 gap-2.5">
        <h4 className="m-0 text-[13px] text-primary">{assignmentStageLabel(stage, stageIndex)}</h4>
      {stage.map((repository) => {
        const selected = selection.assignments[repository.id] ?? "";
        const person = peopleByName.get(selected);
        const ticket = selection.tickets[repository.id] ?? "";
        const ticketProblem = !ticket.trim() ? "缺少 AR 单号"
          : /\s/.test(ticket.trim()) ? "AR 单号无效" : "";
        const rowLabel = unitLabel(repository);
        const prerequisites = dependencies.filter((edge) => edge.from === repository.id);
        // 兼容旧的三项摘要，只取完整“做什么”一句；冗长技术原文留在 Story，
        // 不截出半句话冒充摘要，也不在决策卡再次展开整段实现说明。
        const brief = repository.responsibility?.split(/\r?\n/).find((line) => line.trim())
          ?.replace(/^\s*[-*]\s*(?:做什么[：:]\s*)?/, "").trim();
        return <article key={repository.id} className="min-w-0 rounded-[9px] border border-line bg-surface-soft p-3.5">
          <header className="grid gap-1.5"><div className="flex items-start justify-between gap-2.5"><strong className="text-[15px] leading-[1.6] text-text-strong">{repository.scope?.name ?? repository.name}</strong>
            {onOpenModule && <button type="button" aria-label={`查看${repository.scope?.name ?? repository.name}详情`}
              className="flex-none cursor-pointer border-0 bg-none p-0 text-xs text-primary hover:underline"
              onClick={() => onOpenModule(repository.id)}>查看详情 ↗</button>}
          </div><small className="text-xs text-muted-foreground [overflow-wrap:anywhere]">仓库：{repository.name}</small></header>
          {brief && brief.length <= 160 && <p className="my-2 text-[13px] leading-[1.6] text-text">{brief}</p>}
          {prerequisites.length > 0 && <div className="my-2.5 border-l-2 border-l-primary pl-2.5 text-xs leading-[1.7] text-muted-foreground">
            {prerequisites.map((edge) => {
              const prerequisite = repositories.find((item) => item.id === edge.to);
              return <p key={edge.to} className="my-[3px] text-text">等待「{prerequisite?.scope?.name ?? prerequisite?.name ?? edge.to}」
                完成</p>;
            })}
          </div>}
          <div className="mt-3 grid grid-cols-2 gap-3 max-[600px]:grid-cols-1">
          <div className="grid min-w-0 gap-[3px]">
            <small className="text-xs text-muted-foreground">负责人</small>
            <UserPicker value={selected}
              ariaLabel={`${rowLabel}的执行人`}
              emptyLabel="请选择执行人"
              onChange={(username) => chooseAssignee(repository.id, username)}
              options={[...new Set([selected,
                ...people.map((person) => person.username)])]
                .filter(Boolean).map((name) => {
                  const candidate = peopleByName.get(name);
                  return {
                    username: name,
                    display_name: candidate?.display_name,
                    disabled: candidate ? !candidate.ready : false,
                    detail: candidate && !candidate.ready
                      ? `未就绪：${candidate.missing.join("、")}` : undefined,
                  };
                })} />
          </div>
          <label className="grid min-w-0 gap-[3px]">
            <small className="text-xs text-muted-foreground">任务单号</small>
            <Input type="text" className="min-h-[34px] font-mono text-xs font-semibold" value={ticket}
              aria-label={`${rowLabel}的 AR 单号`}
              aria-invalid={Boolean(ticketProblem)}
              placeholder="例如：REQ2026xxxx"
              onChange={(event) => chooseTicket(repository.id, event.target.value)} />
          </label>
          </div>
          <em className={cn("mt-2 block text-xs not-italic",
            person?.ready && !ticketProblem ? "text-success" : "text-attention")}>
            {ticketProblem || (person?.ready ? "可委派"
              : person ? `未就绪：${person.missing.join("、")}` : "待选择")}
          </em>
        </article>;
      })}</section>)}
    </div>
    {selection.error && <p className="mx-3 mb-2 rounded-[7px] bg-danger/10 px-2.5 py-2 text-xs text-danger">
      {selection.error}
    </p>}
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3 py-2.5">
      <p className="m-0 text-xs leading-[1.45] text-muted-foreground">负责人和单号的修改会自动保存。</p>
      <small className={cn("flex-none text-xs",
        saveState === "saved" && "text-success",
        saveState === "error" && "text-danger",
        (saveState === "saving" || saveState === "idle") && "text-muted-foreground")}>
        {saveState === "saving" ? "正在保存…"
          : saveState === "saved" ? "已自动保存"
          : saveState === "error" ? "保存失败，请继续编辑后重试" : ""}
      </small>
    </footer>
  </section>;
}
