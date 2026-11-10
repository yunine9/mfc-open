import type { ExecutionPlan } from "./api";
import {
  executionPlanFeedbackDraft,
  type ExecutionPlanFeedbackDraft,
} from "./executionPlanFeedback";

const RESOURCE_KIND: Record<ExecutionPlan["resources"][number]["kind"], string> = {
  guidance: "方法",
  standard: "规范",
  agent: "Agent",
  platform: "平台能力",
  knowledge: "知识",
  skill: "Skill",
  tool: "工具",
};

const USAGE: Record<ExecutionPlan["resources"][number]["usage"], string> = {
  required: "必用",
  when_needed: "按情况",
  on_demand: "按需读取",
};

const PROFILE_SCOPE: Record<
  ExecutionPlan["customization"]["layers"][number]["scope"], string
> = {
  team: "团队",
  business_module: "业务模块",
  repository: "代码仓",
  task: "本任务",
};

export function ExecutionPlanCard({ plan, warning, onSuggest }: {
  plan: ExecutionPlan;
  warning?: string;
  onSuggest?: (draft: ExecutionPlanFeedbackDraft) => void;
}) {
  const customizationLayers = plan.customization.layers.length;
  return (
    <section className="execution-plan-card" aria-labelledby="execution-plan-title">
      <header>
        {/* 原有"策"字装饰角标已摘:这张卡现在只出现在阶段弹层里,
            弹层标题已写明"XX · 执行方案",角标是纯噪声(用户点破)。 */}
        <div>
          <span>{plan.step.phase} · 当前步骤 {plan.step.title}</span>
          <strong id="execution-plan-title">{plan.strategy.title}</strong>
          <p>{plan.strategy.summary}</p>
        </div>
        <div className="execution-plan-version">
          <span>{customizationLayers
            ? `平台推荐 + ${customizationLayers} 层补充`
            : "平台推荐"}</span>
          <small>v{plan.strategy.version}</small>
        </div>
      </header>

      <div className="execution-plan-why">
        <strong>为什么这样安排</strong>
        <span>{plan.strategy.selection_reason}</span>
      </div>

      {warning && <p className="execution-plan-warning" role="status">{warning}</p>}

      {plan.customization.layers.length > 0 && (
        <section className="execution-plan-overrides">
          <div>
            <strong>已叠加的执行补充</strong>
            <small>随任务固定 · 真实作用于 Agent</small>
          </div>
          <div className="execution-plan-override-list">
            {plan.customization.layers.map((layer) => (
              <article key={`${layer.scope}:${layer.source_id}`}>
                <span>{PROFILE_SCOPE[layer.scope]}</span>
                <div><strong>{layer.title}</strong><p>{layer.instructions}</p></div>
              </article>
            ))}
          </div>
          <p>这些补充只调整关注点、顺序和协作方式；与平台兜底冲突的部分不会生效。</p>
        </section>
      )}

      <div className="execution-plan-grid">
        <section>
          <h4>默认会做</h4>
          {/* 编号顺序清单:✓ 读起来像"已完成/卖点",这里是"将按此
              顺序做"(与阶段弹层同一口径)。 */}
          <div className="execution-plan-activities">
            {plan.activities.map((activity, index) => (
              <article key={activity.id}
                className={activity.source === "customized" ? "customized" : ""}>
                <i aria-hidden>{index + 1}</i>
                <div><strong>{activity.title}</strong><p>{activity.description}</p></div>
                {activity.source === "customized" && <small>定制新增</small>}
              </article>
            ))}
          </div>
        </section>

        <section>
          <h4>完成时应得到</h4>
          <div className="execution-plan-outputs">
            {plan.contract.outputs.map((output) => <span key={output}>{output}</span>)}
            {plan.contract.evidence.map((evidence) => (
              <span className="evidence" key={evidence.type}>{evidence.label}</span>
            ))}
          </div>
          {plan.contract.human_decision && (
            <p className="execution-plan-human">本阶段包含真实人工决定，Agent 不会替你拍板。</p>
          )}
        </section>
      </div>

      <details className="execution-plan-resources">
        <summary>
          <span>本阶段可用能力</span>
          <small>{plan.resources.length} 项 · 选中不等于全文注入</small>
        </summary>
        <div>
          {plan.resources.map((resource) => (
            <article key={resource.id} className={resource.preferred ? "preferred" : ""}>
              <span>{RESOURCE_KIND[resource.kind]}</span>
              <strong>{resource.name}</strong>
              <small>{resource.preferred ? "定制优先" : USAGE[resource.usage]}</small>
            </article>
          ))}
          <p>{plan.knowledge.explanation}</p>
        </div>
      </details>

      <footer>
        <span>平台兜底</span>
        <p>{plan.customization.locked.join("、")}不可被定制绕过。</p>
        {onSuggest && <button
          type="button"
          onClick={() => onSuggest(executionPlanFeedbackDraft(plan))}
        >反馈这套安排</button>}
        <small>方案 {plan.plan_revision}</small>
      </footer>
    </section>
  );
}
