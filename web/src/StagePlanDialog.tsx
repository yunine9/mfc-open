/**
 * 进度条阶段弹层:点进度条上的阶段名,看"这个阶段怎么干"。
 *
 * 三层事实,按可信度取用,如实标注,绝不混淆:
 * 1. 当前阶段:内核 execution-plan 编译出的活方案(含定制层与选择
 *    理由),整卡展示——"真实作用于 Agent"的方案;
 * 2. 其他阶段 + 任务有定格工作流:workflow_profile.final_snapshot
 *    里该阶段的 item 清单——任务创建时定格、运行只消费这一份,
 *    这就是"本次任务实际会执行的"(用户点破:别的阶段也该看到
 *    本任务的,不是平台底版);
 * 3. 没有定格方案时才兜底 playbooks.json 标准底版,并明说是底版。
 *
 * 样式全部复用 OverlayDialog(预热浮层同款)与 execution-plan-card,
 * 不新增 CSS(style.css 正在被并行迭代,避免碰撞)。
 */

import { useEffect, useState } from "react";
import {
  getLaunchOptions,
  type ExecutionPlan,
  type ExecutionPlaybookOption,
  type WorkflowExecutionProfile,
  type WorkflowStagePlan,
} from "./api";
import { ExecutionPlanCard } from "./ExecutionPlanCard";
import { OverlayDialog } from "./WarmupPanel";
import { Alert } from "@/components/Alert";
import type { ExecutionPlanFeedbackDraft } from "./executionPlanFeedback";

const ITEM_KIND: Record<WorkflowStagePlan["items"][number]["kind"], string> = {
  activity: "动作",
  knowledge: "知识",
  skill: "Skill",
  agent: "Agent",
  tool: "工具",
  instruction: "补充",
};

export function StagePlanDialog({
  phase,
  currentPhase,
  plan,
  planWarning,
  profile,
  onSuggest,
  onClose,
}: {
  phase: string;
  /** 任务此刻所在阶段;用于把"已过/未到"说清楚。 */
  currentPhase: string;
  plan?: ExecutionPlan;
  planWarning?: string;
  /** 本任务定格的工作流(创建时编译固定,运行只消费 final_snapshot)。 */
  profile?: WorkflowExecutionProfile;
  onSuggest?: (draft: ExecutionPlanFeedbackDraft) => void;
  onClose: () => void;
}) {
  const live = !!plan && plan.step.phase === phase;
  const fixedStages = live ? [] : (profile?.final_snapshot?.stages ?? [])
    .filter((stage) => stage.phase === phase);
  const needCatalog = !live && fixedStages.length === 0;
  const [catalog, setCatalog] = useState<ExecutionPlaybookOption[]>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (!needCatalog) return;
    let alive = true;
    getLaunchOptions().then((options) => {
      if (!alive) return;
      setCatalog(options.execution_playbooks
        .filter((item) => item.phase === phase));
    }).catch((reason) => {
      if (alive) {
        setError(reason instanceof Error
          ? reason.message : "方案目录读取失败");
      }
    });
    return () => { alive = false; };
  }, [needCatalog, phase]);

  return (
    <OverlayDialog ariaLabel={`${phase} 阶段执行方案`}
      title={`${phase} · 执行方案`} onClose={onClose}>
      {live ? (
        <ExecutionPlanCard plan={plan!} warning={planWarning}
          onSuggest={onSuggest} />
      ) : fixedStages.length > 0 ? (
        <div className="execution-plan-card">
          <div className="execution-plan-why">
            <span>
              本任务创建时定格的阶段方案，执行时即按此进行
              {phase === currentPhase ? "" : currentPhase
                && `（当前任务在「${currentPhase}」）`}。
            </span>
          </div>
          {fixedStages.map((stage) => (
            <section key={stage.id}>
              {fixedStages.length > 1 && (
                <div className="execution-plan-why">
                  <strong>{stage.title}</strong>
                </div>
              )}
              {/* 编号执行清单,不用 ✓:对勾读起来像"已完成/卖点介绍",
                  这里是"将按此顺序执行"。长描述默认折叠,点开看细节
                  ——内容多时先给骨架。 */}
              <div className="execution-plan-activities">
                {stage.items.map((item, index) => {
                  const detail = [
                    item.description,
                    item.instructions && `补充要求:${item.instructions}`,
                  ].filter(Boolean) as string[];
                  return (
                    <article key={item.id}
                      className={item.source !== "platform" ? "customized" : ""}>
                      <i aria-hidden>{index + 1}</i>
                      <div>
                        {detail.length ? (
                          <details>
                            <summary><strong>
                              {ITEM_KIND[item.kind]} · {item.title}
                            </strong></summary>
                            {detail.map((text) => <p key={text}>{text}</p>)}
                          </details>
                        ) : (
                          <strong>{ITEM_KIND[item.kind]} · {item.title}</strong>
                        )}
                      </div>
                      {item.locked ? <small>平台底线</small>
                        : item.source !== "platform" && <small>定制</small>}
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="execution-plan-card">
          {/* 没有定格工作流的任务才看标准底版;一句灰字说清出处。 */}
          <div className="execution-plan-why">
            <span>
              {phase === currentPhase
                ? "内核暂未给出本阶段的编译方案，以下为标准方案目录。"
                : "本任务没有定格的阶段工作流；以下为平台标准默认做法，"
                  + "实际执行方案在到达该阶段时结合定制编译产生。"}
            </span>
          </div>
          {/* #217:错误与“没有对应方案”是警示语义,收编 Alert warning;
              “正在读取”只是一句话说明,保留原段落。 */}
          {error && <Alert variant="warning" role="status" className="mx-5 mt-2.5">
            {error}</Alert>}
          {!error && !catalog && <p className="execution-plan-warning">
            正在读取方案目录…</p>}
          {catalog?.length === 0 && (
            <Alert variant="warning" className="mx-5 mt-2.5">
              该阶段没有对应的内核执行方案——阶段名与内核 flow/phases.json
              的词表对不上,不存在可预告的标准做法。
            </Alert>
          )}
          {catalog?.map((playbook) => (
            <section key={playbook.id}>
              <div className="execution-plan-why">
                <strong>{playbook.title} <small>v{playbook.version}</small></strong>
                <span>{playbook.summary}</span>
              </div>
              <div className="execution-plan-activities">
                {playbook.activities.map((activity, index) => (
                  <article key={activity.id}>
                    <i aria-hidden>{index + 1}</i>
                    <div>
                      <details>
                        <summary><strong>{activity.title}</strong></summary>
                        <p>{activity.description}</p>
                      </details>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </OverlayDialog>
  );
}
