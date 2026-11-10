import type { DeliveryAnalysisReport, DeliveryAnalysisRow } from "../../src/deliveryAnalyticsTypes";
import type { IssueOnceGenerated, IssueRegistrationStats, KnowledgeInsightResource, TeamKnowledgeInsights } from "./api";

export const DEMO_DELIVERY_MAIN_TASK = "demo-preview-source";
export const DEMO_DELIVERY_TASK_IDS = [DEMO_DELIVERY_MAIN_TASK, "demo-preview-order", "demo-preview-stock", "demo-preview-integration"] as const;
const at = "2026-10-22T02:00:00.000Z";
const parentTitle = "演示数据 · 订单取消后释放库存";

function deliveryRow(id: string, title: string, repo: string, first: number, pipeline: number, review: number): DeliveryAnalysisRow {
  return {
    id, title: `演示数据 · ${title}`, parent_id: DEMO_DELIVERY_MAIN_TASK, parent_title: parentTitle,
    delivery_id: `${id}-example-delivery`, started_at: "2026-10-22T01:00:00.000Z", completed_at: at,
    repo, languages: ["typescript"], modules: [title], business_module: { id: "demo-order-inventory", name: "订单与库存（演示）" },
    merged: true, at,
    metric: {
      version: 1, base: `${id}-example-base`, first: `${id}-example-first`, head: `${id}-example-review`,
      collected_at: at, retained: { first, pipeline, review, other: 0 },
      rework: { first: 0, pipeline, review, other: 0 }, deleted: 6, excluded_files: 2,
      initial_implementation: { end: `${id}-example-first`, basis: "repair_record" },
      commits: [
        { sha: `${id}-example-first`, subject: `演示记录：实现${title}`, at: "2026-10-22T01:20:00.000Z", origin: "first", additions: first, deletions: 2,
          origin_evidence: ["虚构样例：展示首轮实现提交的分类方式，不是真实代码证据。"] },
        ...(pipeline ? [{ sha: `${id}-example-pipeline`, subject: "演示记录：补充失败场景断言", at: "2026-10-22T01:35:00.000Z", origin: "pipeline" as const, additions: pipeline, deletions: 2,
          origin_evidence: ["虚构样例：展示流水线反馈后的修复记录，没有运行真实流水线。"] }] : []),
        { sha: `${id}-example-review`, subject: "演示记录：按检视意见完善边界处理", at: "2026-10-22T01:50:00.000Z", origin: "review", additions: review, deletions: 2,
          origin_evidence: ["虚构样例：展示采纳检视意见后产生的修改。"] },
      ],
    },
  };
}

export const taskDemoDeliveryReport: DeliveryAnalysisReport = {
  generated_at: at,
  rows: [
    deliveryRow("demo-preview-order", "订单取消事件", "demo/order-service", 240, 30, 30),
    deliveryRow("demo-preview-stock", "库存幂等释放", "demo/inventory-service", 170, 10, 20),
    deliveryRow("demo-preview-integration", "联调验收", "demo/integration-tests", 90, 0, 10),
  ],
  task_tokens: [
    { id: DEMO_DELIVERY_MAIN_TASK, usage: { input_tokens: 6_000, output_tokens: 2_000, total_tokens: 8_000 } },
    { id: "demo-preview-order", parent_id: DEMO_DELIVERY_MAIN_TASK, usage: { input_tokens: 40_000, output_tokens: 8_000, total_tokens: 48_000 } },
    { id: "demo-preview-stock", parent_id: DEMO_DELIVERY_MAIN_TASK, usage: { input_tokens: 28_000, output_tokens: 6_000, total_tokens: 34_000 } },
    { id: "demo-preview-integration", parent_id: DEMO_DELIVERY_MAIN_TASK, usage: { input_tokens: 15_000, output_tokens: 3_000, total_tokens: 18_000 } },
  ],
};

function resource(key: string, name: string, kind: KnowledgeInsightResource["kind"], provided: number, accessed: number, events: number): KnowledgeInsightResource {
  return { key, name, kind, path: `demo-knowledge/${key}`, scope: kind === "document" ? "module" : "team",
    ...(kind === "document" ? { module_id: "demo-order-inventory", module_name: "订单与库存（演示）" } : {}),
    description: "演示数据：展示任务装载与实际读取的区别", provided_tasks: provided, selected_tasks: provided,
    loaded_tasks: provided, accessed_tasks: accessed, access_events: events, completed_tasks: Math.min(accessed, 3),
    repair_tasks: accessed ? 1 : 0, attention_tasks: 0, ...(accessed ? { last_used_at: at } : {}),
  };
}

export const taskDemoKnowledgeInsights: TeamKnowledgeInsights = {
  generated_at: at,
  summary: { tracked_tasks: 4, accessed_tasks: 4, unique_resources: 4, active_resources: 3, selected_unused: 1, opportunities: 2, access_rate: 100 },
  resources: [
    resource("order-inventory-domain", "演示 · 订单与库存领域知识", "document", 4, 4, 9),
    resource("idempotency", "演示 · 事件幂等处理 Skill", "skill", 3, 2, 4),
    resource("code-review", "演示 · 代码检视 Skill", "skill", 3, 3, 5),
    resource("retry-policy", "演示 · 重试策略 Skill", "skill", 2, 0, 0),
  ],
  recommendations: [
    { id: "demo-unused", kind: "selected-unused", tone: "attention", title: "演示线索：重试策略已装载，但没有读取记录",
      evidence: "样例中 2 个任务可用、0 次读取；装载次数不能代替实际使用。", action: "核对任务是否需要，再检查 Skill 说明及匹配范围。",
      resource_key: "retry-policy", task_ids: ["demo-preview-order", "demo-preview-stock"] },
    { id: "demo-review", kind: "needs-review", tone: "info", title: "演示线索：补充幂等经验的适用条件",
      evidence: "两个交付单元涉及重复事件，经验需要说明业务标识与失败后的处理方式。", action: "由开发核对来源和边界后更新经验；这些样例数字不证明质量提升。",
      resource_key: "idempotency", task_ids: ["demo-preview-stock", "demo-preview-integration"] },
  ],
};

const emptyIssueStats: IssueOnceGenerated = {
  threshold_percent: 90, supported_since: "2026-10-22", total: 0, passed: 0, rate: null, delivered: 0, terminated: 0,
  localization: { passed: 0, total: 0, rate: null }, verify: { passed: 0, total: 0, rate: null }, solved: { passed: 0, total: 0, rate: null },
  by_repo: [], pending: 0, unsupported: 0, no_code: 0, per_session: [],
};
const emptyRegistrationStats: IssueRegistrationStats = {
  total: 0, non_issue: 0, issue_confirmed: 0, localization: { passed: 0, total: 0, rate: null }, per_session: [], by_module: [], by_reporter: [],
};

/** DEV 页面专用：不连接服务器，不将任何写请求转发出去。 */
export function createTaskDemoDeliveryRead(origin: string): typeof fetch {
  const reads = new Map<string, unknown>([
    ["/delivery-analytics", taskDemoDeliveryReport],
    ["/knowledge-insights", taskDemoKnowledgeInsights],
    ["/technology-stacks", { stacks: [{ id: "typescript", name: "TypeScript", enabled: true }] }],
    ["/issues/once-generated", emptyIssueStats],
    ["/issues/registration-stats", emptyRegistrationStats],
  ]);
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw new DOMException("演示读取已取消。", "AbortError");
    const url = new URL(input instanceof Request ? input.url : String(input), origin);
    if (!["GET", "HEAD"].includes(method)) return Response.json({ error: "交付分析演示仅提供只读样例，不保存修改。" }, { status: 405 });
    if (url.origin !== origin || !reads.has(url.pathname)) return Response.json({ error: "这项内容未提供演示数据。" }, { status: 404 });
    return method === "HEAD" ? new Response(null, { status: 200 }) : Response.json(reads.get(url.pathname));
  };
}
