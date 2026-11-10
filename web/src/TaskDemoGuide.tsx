import { useState } from "react";
import { BotIcon, MoveHorizontalIcon, UsersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "./BrandMark";
import { getTaskDemoGuideContent, taskDemoPhaseTitle } from "./taskDemoGuideContent";
import "./TaskDemo.css";

export interface TaskDemoGuideProps {
  phase: string;
  decomposition?: boolean;
}

/** 只呈现讲解内容；真实材料、回复选择和演示副本权限由工作台管理。 */
export function TaskDemoGuide({ phase, decomposition = false }: TaskDemoGuideProps) {
  const content = getTaskDemoGuideContent(decomposition ? "需求拆分" : phase);
  const [selection, setSelection] = useState<{ phase: string; segment: string }>();
  const segment = content?.segments?.find((item) =>
    selection?.phase === phase && item.id === selection.segment)
    ?? content?.segments?.[0];
  const narration = segment ?? content;

  return <section className="task-demo-guide" aria-label={`${content?.title ?? taskDemoPhaseTitle(phase)}的人机协作`}
    data-demo-phase={phase}>
    <div className="task-demo-guide-body">
        {content?.segments && <div className="task-demo-guide-segments" role="group" aria-label="检视与验证讲解内容">
          {content.segments.map((item) => <Button key={item.id}
            variant={segment?.id === item.id ? "secondary" : "ghost"} size="sm"
            aria-pressed={segment?.id === item.id}
            onClick={() => setSelection({ phase, segment: item.id })}>{item.label}</Button>)}
        </div>}
      {!content || !narration ? <p className="task-demo-guide-empty">
        这个阶段还没有讲解文案，可以先查看任务材料和实际回复。
      </p> : <>
        <div className="task-demo-guide-flow">
          <section className="task-demo-guide-role task-demo-guide-agent" aria-label="Agent 的工作">
            <span className="task-demo-guide-symbol" role="img" aria-label="Agent 的工作" title="Agent 的工作"><BotIcon aria-hidden /></span>
            <p>{narration.agent}</p>
          </section>
          <MoveHorizontalIcon className="task-demo-guide-link" aria-hidden />
          <section className="task-demo-guide-boundary" aria-label="平台的作用与人机边界">
            <span className="task-demo-guide-symbol task-demo-guide-platform-symbol" role="img" aria-label="Mae-Flow 平台" title="Mae-Flow 平台"><BrandMark className="task-demo-guide-platform-logo size-9 [&_svg]:size-6" /></span>
            <p className="task-demo-guide-boundary-decision">{narration.platform}</p>
          </section>
          <MoveHorizontalIcon className="task-demo-guide-link" aria-hidden />
          <section className="task-demo-guide-role task-demo-guide-human" aria-label="开发和需求 owner 的工作">
            <span className="task-demo-guide-symbol" role="img" aria-label="开发和需求 owner 的工作" title="开发和需求 owner 的工作"><UsersIcon aria-hidden /></span>
            <p>{narration.human}</p>
          </section>
        </div>
      </>}
    </div>
  </section>;
}
