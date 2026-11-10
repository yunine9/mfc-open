import { recordComponentObservations, applyComponentExemptions } from "./componentKnowledgePolicy.ts";
import { isAbsolute, relative, resolve } from "node:path";
import type { KnowledgeContext } from "./knowledgeSearch.ts";
import type { ComponentPlan } from "./componentPlan.ts";
import { componentKnowledgeCatalog, type ComponentKnowledgeCatalog } from "./componentKnowledgeCatalog.ts";
import { checkComponentKnowledge, componentCheckMessage, type ComponentKnowledgeCheckReport } from "./componentKnowledgeCheck.ts";

/** 代码检查现读统一的正式知识源，不提供独立的选型或知识查询工具。 */
export class ComponentKnowledgeConsumption {
  private lastNote = "";
  constructor(private options: {
    dataDir: string; cwd: string; context: () => KnowledgeContext; languages: () => string[]; baseline: () => string;
    plan?: () => ComponentPlan;
    onReport?: (report: ComponentKnowledgeCheckReport) => void;
  }) {}
  catalog(): ComponentKnowledgeCatalog {
    try { return componentKnowledgeCatalog(this.options.dataDir, this.options.context(), this.options.languages()); }
    catch (error) { return { paradigms: [], rules: [], digest: "unavailable", warnings: [`组件正式知识读取未完成：${String(error)}`] }; }
  }
  async check(input: { target?: string; paths?: string[]; trigger: ComponentKnowledgeCheckReport["trigger"] }) {
    const report = await checkComponentKnowledge({ cwd: this.options.cwd, baseline: this.options.baseline(), catalog: this.catalog(), ...input });
    if (input.trigger === "mr" && this.options.plan) {
      report.plans = [];
      // 组件计划核对是观察(blocks_delivery=false)。读足迹/建计划本身失败
      // 也只记进报告——原来 recordedPaths() 在逐条 try 之外,读足迹一抛
      // 就冒泡到宿主 push,把一次正常推送整个打断(delivery.part6 实测
      // TypeError 从 readMemoryUsage 一路抛到 pushFromHost)。
      try {
        const plan = this.options.plan();
        for (const path of plan.recordedPaths()) {
          try { const result = await plan.check(path, input.target); report.plans.push({ path, findings: result.findings }); }
          catch (e) { report.plans.push({ path, findings: [], error: e instanceof Error ? e.message : String(e) }); }
        }
      } catch (e) {
        report.warnings.push(`组件计划核对未完成：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    try { const repository = this.options.context().repositories[0] ?? this.options.context().repo;
      applyComponentExemptions(this.options.dataDir, repository, report);
      recordComponentObservations(this.options.dataDir, repository, report); } catch { /* 观察记录失败不阻塞开发。 */ }
    try { this.options.onReport?.(report); } catch { /* 消费记录不可改变代码或交付结果。 */ }
    return report;
  }
  async afterTool(name: string, input: Record<string, unknown>) {
    if (!["Write", "Edit", "Bash"].includes(name)) return;
    const path = name !== "Bash" ? relative(this.options.cwd, resolve(this.options.cwd, String(input.file_path ?? input.path ?? ""))).replaceAll("\\", "/") : undefined;
    if (path !== undefined && (isAbsolute(path) || path.startsWith("../") || !/\.(?:c|cpp|cc|cxx|h|hpp|hh|hxx|java)$/i.test(path))) return;
    const report = await this.check({ trigger: "edit", ...(path === undefined ? {} : { paths: [path] }) });
    if (report.status === "not_applicable") return;
    const note = componentCheckMessage(report);
    if (note === this.lastNote) return;
    this.lastNote = note;
    // 无命中时保留检查记录；无需在每次写文件后用成功提示占用上下文。
    return report.findings.some(f => f.level === "warning" && !f.exempt_reason) ? note : undefined;
  }
}
