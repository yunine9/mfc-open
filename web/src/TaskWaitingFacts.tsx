import { PersonName } from "./People";
import type { TaskSummary } from "./api";
import { Markdown } from "./markdown";

/** 有任务查看权限的人也能读当前问题；本组件没有作答状态或提交入口。 */
export function TaskWaitingFacts({ task }: { task: TaskSummary }) {
  const waiting = task.waiting;
  if (!waiting) return null;
  const questions = waiting.question?.questions ?? [];
  return <section className="decision-card" aria-labelledby={`waiting-facts-${task.id}`}>
    <header className="decision-head">
      <div>
        <h3 id={`waiting-facts-${task.id}`}>待回答的问题</h3>
        <p>等待 <PersonName account={task.luban_account} fallback="任务责任人" /> 答复；你可以只读查看题目和选项。</p>
      </div>
    </header>
    {waiting.context && <details className="waiting-context-details">
      <summary>Agent 的说明</summary>
      <Markdown text={waiting.context} />
    </details>}
    <div className="question-list">
      {questions.map((item, index) => <div className="question" key={index}>
        <p className="question-text">{questions.length > 1 ? `${index + 1}. ` : ""}{item.question || "需要确认"}</p>
        {!!item.options?.length && <ul>
          {item.options.map((option, optionIndex) => <li key={optionIndex}>{option}</li>)}
        </ul>}
        {!item.options?.length && <p className="option-hint">本题需要文字答复。</p>}
      </div>)}
      {!questions.length && <p className="option-hint">尚未取得问题正文，请稍后刷新。</p>}
    </div>
  </section>;
}
