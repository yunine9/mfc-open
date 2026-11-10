import { StateConflictError } from "./humanGate.ts";
import { bindArchifyArtifact, storyArchitecture } from "./storyArchitecture.ts";
import { renderArchify } from "./archifyRender.ts";
import { compileSemanticArchitecture } from "./semanticArchitecture.ts";
import { readArchitectureStory } from "./storyArchitectureSource.ts";
import { requirementDiff } from "./documentDiff.ts";
import { readStoryOutput } from "./overallStoryAgent.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { AnnotationStore, type Annotation } from "./annotations.ts";
import { listArtifactDocuments, readArtifact } from "./artifacts.ts";
import { auxiliarySessionEpoch } from "./auxiliarySessions.ts";
import { TaskControlError, NotFoundError } from "./errors.ts";
import { reanchorRequirementAnnotations } from "./requirementDocument.ts";
import { parseDocumentReviewReceipts } from "./documentReviewReceipts.ts";
import type { TaskSummary } from "./taskService.ts";
import { OVERALL_STORY_ARTIFACT, readStoryState, readCurrentStory, storyHash,
  storyPath, storyRevisionPath, writeStoryState, type StorySnapshot, type StoryState } from "./overallStoryStore.ts";

export interface StoryInput extends StorySnapshot { files: Record<string, string> }
export interface StoryRun {
  architectureOnly?: boolean;
  onProgress?(message: string): void;
  root: string; id: string; before: string; input: StoryInput; annotations: Annotation[]; signal: AbortSignal;
}
export interface StoryStatus extends StoryState {
  eligible: boolean; sources: StorySnapshot["sources"]; stale: boolean;
  pending_reviews: number; can_confirm: boolean; label: string;
}
interface Owner { summary: TaskSummary }
interface Options<T extends Owner> {
  /** 分析未提供架构产物时自动补图；测试和固定剧本可关闭，默认开启。 */
  autoArchitecture?: boolean;
  task(id: string): T | undefined;
  artifactRoot(id: string): string | undefined;
  run(task: T, job: StoryRun): Promise<void>;
  ready(): void;
  published?(task: T, content: string, revision: string): void;
  log?(message: string): void;
}

/** 只汇总已拆分主任务，来源用真实文件摘要识别，不依赖频繁刷新的任务时间。 */
export function collectStoryInput<T extends Owner>(task: T, options: Pick<Options<T>, "task" | "artifactRoot">): StoryInput {
  const graph = task.summary.requirement_graph;
  const files: Record<string, string> = { "requirement.md": task.summary.requirement };
  files["decomposition.json"] = JSON.stringify({ repositories: graph?.repositories.map((r) => ({
    id: r.id, name: r.name, task_id: r.task_id, scope: r.scope,
    // 旧汇总稿保持原输入摘要形态，升级本身不能把历史设计标成过期。
    ...(graph.source_document === "story.md" ? { responsibility: r.responsibility } : {}),
  })), dependencies: graph?.dependencies }, null, 2);
  const sources: StorySnapshot["sources"] = (graph?.repositories ?? []).map((r, index) => {
    const source: StorySnapshot["sources"][number] = { id: r.id, name: r.name, task_id: r.task_id };
    const child = r.task_id ? options.task(r.task_id) : undefined;
    const root = child ? options.artifactRoot(child.summary.id) : undefined;
    if (!child || !root) return { ...source, missing: "子任务 Story 尚不可读" };
    try {
      const docs = listArtifactDocuments(root).filter((d) => /(?:^|\/)story\.md$/i.test(d.name));
      const ticket = child.summary.ticket ?? r.ticket;
      const exact = ticket ? docs.filter((d) => d.name === `${ticket}/story.md`) : [];
      const doc = ticket ? exact[0] : docs.length === 1 ? docs[0] : undefined;
      if (!doc) return { ...source, missing: docs.length ? "存在多份 Story，无法确定当前版本" : "尚未产出 Story" };
      const content = readArtifact(root, doc.name);
      if (!content || content.truncated || !content.content.trim()) return { ...source, missing: "Story 为空、过大或不可读" };
      files[`children/${index + 1}.md`] = content.content;
      return { ...source, artifact: doc.name, sha256: storyHash(content.content), input_file: `children/${index + 1}.md` };
    } catch { return { ...source, missing: "Story 读取失败" }; }
  });
  files["sources.json"] = JSON.stringify(sources, null, 2);
  return { files, sources, fingerprint: storyHash(JSON.stringify(files)) };
}

export class OverallStoryCoordinator<T extends Owner> {
  private active = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  private stopped = false;
  constructor(private options: Options<T>) {}
  private owner(id: string): T {
    const task = this.options.task(id);
    if (!task) throw new NotFoundError(`任务 ${id} 不存在`);
    return task;
  }
  private store(task: T) { return new AnnotationStore(join(task.summary.workspace, "annotations.jsonl")); }
  private eligible(task: T) { return !task.summary.parent_task_id
    && task.summary.requirement_graph?.stage === "confirmed"
    && (task.summary.requirement_graph.source_document === "story.md"
      || Boolean(task.summary.requirement_graph.repositories.length)); }
  /** 分析 Agent 的 Story 直接进入现有版本库，不再等待子任务后另写汇总。 */
  adoptAnalysis(id: string, content: string, by: string, architecture?: string,
    semanticArchitecture?: string): void {
    const task = this.owner(id);
    if (this.active.has(id)) throw new TaskControlError("整体 Story 正在更新，请稍后重试");
    const state = this.recover(task);
    if (state.current) {
      const published = readCurrentStory(task.summary.workspace);
      if (published) this.options.published?.(task, published, state.current);
      return; // 重试不覆盖已发布版本，但补齐派生材料和通知。
    }
    const input = collectStoryInput(task, this.options);
    const revision = randomUUID(), path = storyRevisionPath(task.summary.workspace, revision);
    const diff = requirementDiff("", content);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
    if (architecture?.trim()) {
      try {
        writeFileSync(storyRevisionPath(task.summary.workspace, revision, "architecture.json"),
          bindArchifyArtifact(content, architecture), { mode: 0o600 });
      } catch (error) { this.options.log?.(`分析 Story 的平台架构产物未采用：${String(error)}`); }
    }
    writeFileSync(join(dirname(path), "inputs.json"), JSON.stringify(input), { mode: 0o600 });
    writeFileSync(join(dirname(path), "receipts.json"), "[]", { mode: 0o600 });
    writeFileSync(storyRevisionPath(task.summary.workspace, revision, "diff.patch"), diff.text, { mode: 0o600 });
    state.revisions.push({ id: revision, at: new Date().toISOString(), by,
      fingerprint: input.fingerprint, sources: input.sources, annotation_ids: [],
      additions: diff.additions, deletions: diff.deletions });
    state.current = revision;
    state.confirmed = { revision, by, at: new Date().toISOString() };
    writeStoryState(task.summary.workspace, state);
    this.options.published?.(task, content, revision);
    if (!architecture?.trim() && semanticArchitecture?.trim()) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(async () => {
        const artifact = await compileSemanticArchitecture(content, semanticArchitecture);
        const projection = storyArchitecture(content, artifact);
        const errors = projection.warnings.filter((message) => message.startsWith("平台架构产物"));
        for (const diagram of projection.diagrams) {
          const rendered = await renderArchify(diagram.source);
          if (!rendered.html || rendered.error) errors.push(rendered.error || "架构图渲染失败");
        }
        if (!projection.diagrams.length || errors.length) throw new Error(errors.join("；") || "未生成可展示的架构图");
        if (controller.signal.aborted || this.stopped || this.options.task(id) !== task) return;
        const current = readStoryState(task.summary.workspace);
        if (current.current !== revision) return;
        writeFileSync(storyRevisionPath(task.summary.workspace, revision, "architecture.json"),
          artifact, { mode: 0o600 });
        current.job = undefined; current.error = undefined; current.error_kind = undefined;
        writeStoryState(task.summary.workspace, current);
      }).catch((error) => {
        if (this.options.task(id) !== task || !existsSync(task.summary.workspace)) return;
        const current = readStoryState(task.summary.workspace);
        if (current.current !== revision) return;
        current.job = undefined; current.error_kind = "architecture";
        current.error = `架构语义编译失败：${error instanceof Error ? error.message : String(error)}`;
        writeStoryState(task.summary.workspace, current);
      }).finally(() => { this.active.delete(id); });
      const current = readStoryState(task.summary.workspace);
      current.job = { id: revision, by, started_at: new Date().toISOString(),
        kind: "architecture", progress: "正在程序化布局模块协作图" };
      writeStoryState(task.summary.workspace, current);
      this.active.set(id, { promise, controller });
    } else if (!architecture?.trim() && this.options.autoArchitecture !== false
      && !this.stopped && task.summary.status !== "canceled" && !task.summary.parent_task_id
      && !this.active.has(id)) {
      // 已发布修订由上方早退去重；沿用手动补图的异步任务，不等待模型或重试。
      try { this.generateArchitecture(id, "系统"); }
      catch (error) { this.options.log?.(`分析 Story 自动补充架构图未启动 ${id}：${String(error)}`); }
    }
  }
  private mutable(task: T) {
    if (task.summary.parent_task_id) throw new TaskControlError("请在主任务中生成、更新或确认整体 Story");
    if (this.stopped || this.options.task(task.summary.id) !== task || task.summary.status === "canceled") throw new TaskControlError("任务已停止，不能更新整体 Story");
    if (!this.eligible(task)) throw new TaskControlError("确认模块拆分后才能生成整体 Story");
  }
  private recover(task: T): StoryState {
    const state = readStoryState(task.summary.workspace);
    // 兼容升级前没有错误归属的 state.json；新错误均由写入点精确标记。
    if (state.error && !state.error_kind) state.error_kind = /架构图|图源|渲染|arch(?:itecture|ify)|diagram/i.test(state.error)
      ? "architecture" : "story";
    if (!this.active.has(task.summary.id)) {
      const store = this.store(task);
      for (const item of store.list()) {
        if (item.status === "sent" && ["overall_story_queue", "overall_story_processing"].includes(item.sent_via ?? "")) {
          // 发布文档与登记回执之间重启时，先恢复已发布修订中的回执，避免重复改文档。
          const recovered = [...state.revisions].reverse().find((r) => r.annotation_ids.includes(item.id));
          let receipt;
          if (recovered) {
            try {
              const rows = JSON.parse(readFileSync(storyPath(task.summary.workspace,
                `revisions/${recovered.id}/receipts.json`), "utf8"));
              receipt = rows.find((r: { annotation_id: string; revision: number }) => r.annotation_id === item.id && r.revision === (item.rework ?? 0));
            } catch { /* 未发布的回执不能充当处理结果 */ }
          }
          if (receipt) { store.markSent([item.id], "overall_story"); store.respond(item.id, receipt); }
          else store.resetRequirementDelivery(item.id, "整体 Story 会话已中断，意见可重新提交");
        }
      }
      if (state.job) {
        const interruptedKind = state.job.kind === "architecture" ? "architecture" : "story";
        state.job = undefined;
        state.error_kind = interruptedKind;
        state.error = interruptedKind === "architecture"
          ? "上次架构图生成会话已中断；已发布版本保留，可重新生成"
          : "上次整体 Story 会话已中断；已发布版本保留，可重新更新";
        writeStoryState(task.summary.workspace, state);
      }
    }
    return state;
  }
  recoverTask(id: string): void { this.recover(this.owner(id)); }
  status(id: string): StoryStatus {
    const task = this.owner(id), state = this.recover(task);
    const input = collectStoryInput(task, this.options);
    const current = state.revisions.find((r) => r.id === state.current);
    const stale = Boolean(current && current.fingerprint !== input.fingerprint);
    const pending = this.store(task).list().filter((a) => a.artifact === OVERALL_STORY_ARTIFACT
      && ["draft", "sent"].includes(a.status)).length;
    const complete = task.summary.requirement_graph?.source_document === "story.md"
      || (input.sources.length > 0 && input.sources.every((s) => !s.missing));
    return { ...state, eligible: this.eligible(task), sources: input.sources, stale, pending_reviews: pending,
      can_confirm: Boolean(this.eligible(task) && current && complete && !stale && !this.active.has(id) && !state.job && !pending && task.summary.status !== "canceled"),
      label: this.active.has(id) || state.job ? state.job?.kind === "architecture" ? "Agent 正在更新架构图" : "Agent 正在整理整体 Story" : !current ? "尚未生成整体 Story"
        : stale ? "子任务或需求已变化 · 待同步" : !complete ? "部分 Story 尚未产出"
          : pending ? "有检视意见待闭环" : state.confirmed?.revision === current.id ? "责任人已确认" : "待检视与确认" };
  }
  generate(id: string, by: string): StoryStatus {
    const task = this.owner(id); this.mutable(task); this.recover(task);
    if (this.active.has(id)) return this.status(id);
    this.options.ready();
    this.launch(task, by, true);
    return this.status(id);
  }
  /** 图源更新共用文档会话互斥，但不修改正文、确认状态或检视回执。 */
  generateArchitecture(id: string, by: string): StoryStatus {
    const task = this.owner(id);
    if (this.stopped || task.summary.status === "canceled") throw new TaskControlError("任务已停止，不能更新架构图");
    this.recover(task);
    if (this.active.has(id)) throw new TaskControlError("Story 或架构图正在更新，请稍后重试");
    const load = () => readArchitectureStory(task.summary, this.options.artifactRoot(id));
    const document = load(), state = readStoryState(task.summary.workspace);
    if (!document?.content.trim()) throw new TaskControlError(task.summary.parent_task_id
      ? "尚未找到可读取的模块 Story，请先完成当前模块设计" : "尚未找到可读取的 Story，请先完成主任务分析");
    if (document.truncated) throw new TaskControlError("Story 超过读取上限，无法完整生成架构图");
    const before = document.content;
    this.options.ready();
    const revision = state.current, jobId = randomUUID(), controller = new AbortController();
    const epoch = auxiliarySessionEpoch(task), root = storyPath(task.summary.workspace, `jobs/${jobId}`);
    state.job = { id: jobId, by, started_at: new Date().toISOString(), kind: "architecture", progress: "正在准备 Story 与绘图资料" };
    state.error = undefined; state.error_kind = undefined; writeStoryState(task.summary.workspace, state);
    const progress = (message: string) => {
      if (controller.signal.aborted || this.options.task(id) !== task || !existsSync(task.summary.workspace)) return;
      const current = readStoryState(task.summary.workspace);
      if (current.job?.id !== jobId) return;
      current.job.progress = message; writeStoryState(task.summary.workspace, current);
    };
    const promise = Promise.resolve().then(async () => {
      mkdirSync(root, { recursive: true });
      const previous = storyPath(task.summary.workspace, "architecture.json");
      const reference = existsSync(previous) ? previous : revision ? storyRevisionPath(task.summary.workspace, revision, "architecture.json") : undefined;
      if (reference && existsSync(reference)) writeFileSync(join(root, "architecture.json"), readFileSync(reference));
      await this.options.run(task, { id: jobId, root, before, input: collectStoryInput(task, this.options),
        annotations: [], signal: controller.signal, architectureOnly: true, onProgress: progress });
      progress("图源已生成，正在检查格式");
      const artifact = bindArchifyArtifact(before, readStoryOutput(join(root, "architecture.json"), 2 * 1024 * 1024));
      const projection = storyArchitecture(before, artifact);
      const errors = projection.warnings.filter((message) => message.startsWith("平台架构产物"));
      if (!projection.diagrams.length || errors.length) throw new Error(errors.join("；") || "未生成可展示的架构图，原图已保留");
      for (const [index, diagram] of projection.diagrams.entries()) {
        progress(`正在校验渲染 ${index + 1}/${projection.diagrams.length}：${diagram.title}`);
        const result = await renderArchify(diagram.source);
        if (!result.html || result.error) throw new Error(result.error || "架构图渲染失败，原图已保留");
      }
      if (controller.signal.aborted || this.stopped || auxiliarySessionEpoch(task) !== epoch
        || this.options.task(id) !== task) throw new Error("架构图生成已停止");
      const current = readStoryState(task.summary.workspace);
      if (current.current !== revision || load()?.content !== before) throw new Error("Story 已更新，请重新补充架构图");
      const temporary = `${previous}.${jobId}.tmp`;
      progress(`已通过 ${projection.diagrams.length} 张图的渲染校验，正在发布`);
      writeFileSync(temporary, artifact, { mode: 0o600 }); renameSync(temporary, previous);
      current.job = undefined; current.error = undefined; current.error_kind = undefined;
      writeStoryState(task.summary.workspace, current);
    }).catch((error) => {
      if (this.options.task(id) !== task || !existsSync(task.summary.workspace)) return;
      const current = readStoryState(task.summary.workspace);
      current.job = undefined;
      current.error = error instanceof Error ? error.message : String(error);
      current.error_kind = "architecture";
      writeStoryState(task.summary.workspace, current);
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, { promise, controller });
    return this.status(id);
  }
  submit(id: string, picked: Annotation[], by?: string) {
    const task = this.owner(id); this.mutable(task); this.recover(task); this.options.ready();
    if (!readStoryState(task.summary.workspace).current) throw new TaskControlError("整体 Story 尚未生成");
    if (picked.some((a) => a.artifact !== OVERALL_STORY_ARTIFACT)) throw new TaskControlError("请将整体 Story 与其他材料的意见分开提交");
    const store = this.store(task);
    const selected = new Set(picked.map((a) => a.id));
    const pending = store.list().filter((a) => selected.has(a.id)
      && (a.status === "draft" || a.sent_via === "owner_pending"));
    store.markSent(pending.map((a) => a.id), "overall_story_queue", by);
    if (pending.length && !this.active.has(id)) this.launch(task, by ?? "检视人", false);
    return { sent: picked.map((a) => a.id), text: "已排队，Agent 将修改整体 Story，完成后请检视改动" };
  }
  private launch(task: T, by: string, generate: boolean) {
    const id = task.summary.id, controller = new AbortController();
    const epoch = auxiliarySessionEpoch(task);
    const starting = readStoryState(task.summary.workspace);
    starting.job = { id: randomUUID(), by, started_at: new Date().toISOString() };
    starting.error = undefined; starting.error_kind = undefined;
    writeStoryState(task.summary.workspace, starting);
    // 在异步创建会话前占住写者位置，重复请求只返回已有工作。
    const promise = Promise.resolve().then(async () => {
      let initial = generate;
      while (true) {
        const batch = this.store(task).list().filter((a) => a.status === "sent" && a.sent_via === "overall_story_queue");
        if (!initial && !batch.length) return;
        const refreshSources = initial;
        initial = false;
        if (controller.signal.aborted || auxiliarySessionEpoch(task) !== epoch) throw new Error("任务已停止");
        this.mutable(task);
        const state = readStoryState(task.summary.workspace), jobId = state.job?.id ?? randomUUID();
        // 批注只修当前文档；只有责任人“更新”才引入新的子任务来源。
        const input: StoryInput = !refreshSources && state.current
          ? JSON.parse(readFileSync(storyPath(task.summary.workspace, `revisions/${state.current}/inputs.json`), "utf8"))
          : collectStoryInput(task, this.options);
        const before = readCurrentStory(task.summary.workspace);
        const root = storyPath(task.summary.workspace, `jobs/${jobId}`);
        state.job = { id: jobId, by, started_at: new Date().toISOString() };
        state.error = undefined; state.error_kind = undefined;
        writeStoryState(task.summary.workspace, state);
        const store = this.store(task);
        store.markSent(batch.map((a) => a.id), "overall_story_processing");
        await this.options.run(task, { id: jobId, root, before, input,
          annotations: reanchorRequirementAnnotations(before, batch), signal: controller.signal });
        if (controller.signal.aborted || auxiliarySessionEpoch(task) !== epoch || this.stopped) throw new Error("任务已停止，本轮文档未发布");
        this.mutable(task);
        const after = readStoryOutput(join(root, "story.md"));
        if (!after.trim()) throw new Error("Agent 未产出整体 Story，旧版保留");
        const receipts = batch.length ? parseDocumentReviewReceipts(readStoryOutput(join(root, "receipts.json"), 256 * 1024), batch) : [];
        const diff = requirementDiff(before, after);
        const path = storyRevisionPath(task.summary.workspace, jobId);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, after, { mode: 0o600 });
        const architecturePath = join(root, "architecture.json");
        if (existsSync(architecturePath)) {
          try {
            writeFileSync(storyRevisionPath(task.summary.workspace, jobId, "architecture.json"),
              bindArchifyArtifact(after, readStoryOutput(architecturePath, 2 * 1024 * 1024)), { mode: 0o600 });
          } catch (error) { this.options.log?.(`整体 Story 的平台架构产物未采用：${String(error)}`); }
        }
        writeFileSync(join(dirname(path), "inputs.json"), JSON.stringify(input), { mode: 0o600 });
        writeFileSync(storyRevisionPath(task.summary.workspace, jobId, "diff.patch"), diff.text, { mode: 0o600 });
        writeFileSync(join(dirname(path), "receipts.json"), JSON.stringify(receipts), { mode: 0o600 });
        const current = readStoryState(task.summary.workspace);
        current.revisions.push({ id: jobId, at: new Date().toISOString(), by,
          fingerprint: input.fingerprint, sources: input.sources,
          annotation_ids: batch.map((a) => a.id), additions: diff.additions, deletions: diff.deletions });
        current.current = jobId; current.job = undefined; current.confirmed = undefined;
        current.error = undefined; current.error_kind = undefined;
        writeStoryState(task.summary.workspace, current);
        const applied = new Set(store.markSentFor(batch, "overall_story"));
        for (const receipt of receipts) {
          if (!applied.has(receipt.annotation_id)) continue;
          store.respond(receipt.annotation_id, { ...receipt, evidence: receipt.evidence ?? [] });
        }
        // 子任务同步是发布后的副作用；失败可重试，但不能抹掉已经发布的处理回执。
        this.options.published?.(task, after, jobId);
      }
    }).catch((error) => {
      // 清空重跑/删除可能已替换任务，不允许旧回调重新创建工作区或污染新任务。
      if (this.options.task(id) !== task || !existsSync(task.summary.workspace)) return;
      try {
        const state = readStoryState(task.summary.workspace);
        state.job = undefined;
        state.error = error instanceof Error ? error.message : String(error);
        state.error_kind = "story";
        writeStoryState(task.summary.workspace, state);
        const store = this.store(task);
        for (const item of store.list()) {
          if (item.status === "sent" && ["overall_story_queue", "overall_story_processing"].includes(item.sent_via ?? "")) {
            store.resetRequirementDelivery(item.id, `整体 Story 修改未完成：${state.error}`);
          }
        }
      } catch (storageError) {
        this.options.log?.(`整体 Story ${id} 失败状态未落盘：${String(storageError)}`);
      }
    }).finally(() => { this.active.delete(id); });
    this.active.set(id, { promise, controller });
  }
  async stop(id: string) {
    this.active.get(id)?.controller.abort();
    await this.active.get(id)?.promise;
    return this.status(id);
  }
  async shutdown() {
    this.stopped = true;
    for (const job of this.active.values()) job.controller.abort();
    await Promise.all([...this.active.values()].map((job) => job.promise));
  }
  async settled(id: string) { await this.active.get(id)?.promise; }
  confirm(id: string, revision: string, by: string): StoryStatus {
    const task = this.owner(id); this.mutable(task);
    const status = this.status(id);
    if (status.current !== revision || !status.can_confirm) throw new StateConflictError("整体 Story 已变化、来源不完整或仍有检视意见，请刷新后确认");
    const state = readStoryState(task.summary.workspace);
    state.confirmed = { revision, by, at: new Date().toISOString() };
    writeStoryState(task.summary.workspace, state);
    return this.status(id);
  }
  revision(id: string, revision: string) {
    const task = this.owner(id), state = readStoryState(task.summary.workspace);
    if (!state.revisions.some((r) => r.id === revision)) throw new NotFoundError("整体 Story 修订不存在");
    return { diff: readFileSync(storyRevisionPath(task.summary.workspace, revision, "diff.patch"), "utf8"),
      content: readFileSync(storyRevisionPath(task.summary.workspace, revision), "utf8") };
  }
}
