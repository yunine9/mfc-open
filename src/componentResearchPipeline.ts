import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validComponentId } from "./componentParadigms.ts";

export interface ComponentWorkResult {
  findings: string; open_questions: string[];
  components?: Array<{ id: string; title: string; repository_ids: string[]; scope: string; dependencies?: string[] }>;
  paradigms?: Array<{ id: string; title: string; need: string }>;
}
export interface ComponentWork {
  id: string; phase: "inventory" | "plan" | "contracts" | "paradigm" | "pitfalls" | "index" | "synthesis";
  title: string; component?: string; spec: string; dependencies: string[];
  status: "pending" | "running" | "done" | "failed"; attempts: number;
  result?: ComponentWorkResult; feedback?: string;
}
export interface ComponentPipelineState { version: 1; skill: string; tasks: ComponentWork[] }
const task = (id: string, phase: ComponentWork["phase"], title: string, dependencies: string[], spec = "", component?: string): ComponentWork =>
  ({ id, phase, title, dependencies, spec, component, status: "pending", attempts: 0 });
export class ComponentResearchPipeline {
  readonly state: ComponentPipelineState;
  constructor(private file: string, skill: string, private repositoryIds: string[], legacyDigest?: string) {
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, skill,
      tasks: [task("inventory", "inventory", "盘点组件能力", [])] };
    if (this.state.version !== 1 || this.state.skill !== skill && this.state.skill !== legacyDigest) throw new Error("研究方法版本已变化，请新建研究；已完成任务保留原版本");
    // 旧任务只记录萃取包版本；增加独立分析包时保留已通过项及原萃取快照。
    this.state.skill = skill;
    for (const t of this.state.tasks) if (["running", "failed"].includes(t.status)) { t.status = "pending"; t.attempts = 0; }
    this.persist();
  }
  private persist() { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file + ".tmp", JSON.stringify(this.state), { mode: 0o600 }); renameSync(this.file + ".tmp", this.file); }
  private expand(t: ComponentWork, r: ComponentWorkResult) {
    const unique = (ids: string[]) => ids.every(validComponentId) && new Set(ids).size === ids.length;
    if (t.phase === "inventory") {
      const cs = r.components;
      if (!cs?.length || cs.length > 100 || !unique(cs.map(c => c.id)) || cs.some(c => !c.title?.trim() || !c.scope?.trim()
        || !c.repository_ids?.length || c.repository_ids.some(id => !this.repositoryIds.includes(id)))) throw new Error("盘点需提供 1～100 个唯一能力、范围与有效基础仓编号");
      const modules = new Map(cs.map(c => [c.id, c]));
      for (const c of cs) {
        if (c.dependencies !== undefined && (!Array.isArray(c.dependencies) || !unique(c.dependencies)
          || c.dependencies.some(id => id === c.id || !modules.has(id)))) throw new Error("模块依赖需引用已盘点的其它模块编号，不能重复或引用自身");
      }
      const visited = new Set<string>(), visiting = new Set<string>();
      const visit = (id: string) => {
        if (visiting.has(id)) throw new Error("模块依赖不能形成循环，请重新划分模块范围");
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dependency of modules.get(id)!.dependencies ?? []) visit(dependency);
        visiting.delete(id); visited.add(id);
      };
      cs.forEach(c => visit(c.id));
      // 模块依赖描述组合关系；各模块直接读取源码，可独立研究。
      return [...cs.map(c => task(`plan-${c.id}`, "plan", c.title, [t.id], JSON.stringify(c), c.id)),
        task("synthesis", "synthesis", "汇总组件使用指南", cs.map(c => `index-${c.id}`))];
    }
    if (t.phase === "plan") {
      const ps = r.paradigms;
      if (!ps?.length || ps.length > 50 || !unique(ps.map(p => p.id)) || ps.some(p => !p.title?.trim() || !p.need?.trim())) throw new Error("规划需提供 1～50 个唯一范式及需求；超出范围请重新划分，不能静默截断");
      const contract = `contracts-${t.component}`, pit = `pitfalls-${t.component}`;
      return [task(contract, "contracts", `${t.title}：使用契约`, [t.id], t.spec, t.component),
        ...ps.map(p => task(`paradigm-${t.component}-${p.id}`, "paradigm", p.title, [contract], JSON.stringify({ ...p, module: JSON.parse(t.spec) }), t.component)),
        task(pit, "pitfalls", `${t.title}：误用陷阱`, ps.map(p => `paradigm-${t.component}-${p.id}`), t.spec, t.component),
        task(`index-${t.component}`, "index", `${t.title}：使用导航`, [pit], t.spec, t.component)];
    }
    return [];
  }
  async run(options: { signal: AbortSignal; concurrency?: number; execute: (t: ComponentWork) => Promise<ComponentWorkResult>;
    review: (t: ComponentWork, r: ComponentWorkResult) => Promise<string | undefined>; changed: (s: ComponentPipelineState) => void }) {
    const concurrency = options.concurrency ?? 3;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new Error("组件研究并发数需为 1～10 的整数");
    options.signal.throwIfAborted();
    const changed = () => { this.persist(); options.changed(structuredClone(this.state)); };
    changed();
    const additionsAvailable = (additions: ComponentWork[]) => {
      const ids = new Set(this.state.tasks.map(t => t.id));
      for (const addition of additions) {
        if (ids.has(addition.id)) throw new Error("任务编号与已有产物重复，请调整组件或范式编号");
        ids.add(addition.id);
      }
    };
    const execute = async (t: ComponentWork) => {
      options.signal.throwIfAborted();
      t.status = "running"; t.attempts++; changed();
      let awaitingReview = false;
      try {
        options.signal.throwIfAborted();
        // 作者结果在评审前已落盘；评审中断时只续评审，避免重做数天的研究。
        const result = t.result ?? await options.execute(structuredClone(t)); options.signal.throwIfAborted();
        if (!result.findings?.trim() || !Array.isArray(result.open_questions) || result.open_questions.some(q => typeof q !== "string")) throw new Error("任务必须保存具体结论和待确认问题");
        const additions = this.expand(t, result);
        additionsAvailable(additions);
        t.result = result; changed();
        options.signal.throwIfAborted();
        awaitingReview = true;
        const feedback = await options.review(structuredClone(t), result); options.signal.throwIfAborted();
        awaitingReview = false;
        if (feedback) { delete t.result; throw new Error(feedback); }
        // 评审期间其它模块可能已完成，提交前再次核对全局编号。
        additionsAvailable(additions);
        t.status = "done"; delete t.feedback;
        this.state.tasks.push(...additions); changed();
      } catch (error) {
        if (options.signal.aborted) return;
        if (!awaitingReview) delete t.result;
        t.feedback = error instanceof Error ? error.message : String(error);
        t.status = t.attempts >= 3 ? "failed" : "pending"; changed();
      }
    };
    const running = new Set<Promise<void>>();
    let onAbort!: () => void;
    const aborted = new Promise<void>(resolve => { onAbort = resolve; });
    options.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        if (options.signal.aborted) break;
        const ready = this.state.tasks.filter(t => t.status === "pending"
          && t.dependencies.every(id => this.state.tasks.some(d => d.id === id && d.status === "done")));
        for (const t of ready.slice(0, concurrency - running.size)) {
          if (options.signal.aborted) break;
          let pending!: Promise<void>;
          pending = execute(t).finally(() => running.delete(pending));
          running.add(pending);
        }
        if (!running.size) break;
        await Promise.race([...running, aborted]);
      }
    } finally {
      options.signal.removeEventListener("abort", onAbort);
      await Promise.allSettled(running);
    }
    options.signal.throwIfAborted();
    const unfinished = this.state.tasks.filter(t => t.status !== "done");
    if (unfinished.length) throw new Error(`组件研究未完成，已通过的任务保留，可重试接续。${unfinished.filter(t => t.status === "failed").map(t => `${t.title}：${t.feedback}`).join("；")}`);
    return "组件范式研究与独立评审完成，草稿等待人工审查，派生规则尚未启用。";
  }
}
