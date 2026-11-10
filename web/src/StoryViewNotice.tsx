import { useEffect, useState } from "react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./components/Alert";
import { storyViewCoverage, type StoryViewCoverage } from "../../src/storyViewCoverage";
import { storyViewTitles } from "./storyViewTitles";

/** 方案确认前集中知会覆盖缺口；展示故障不变成确认门禁。 */
export function StoryViewNotice({ taskId, onOpen }: { taskId: string; onOpen(): void }) {
  const [views, setViews] = useState<StoryViewCoverage[]>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function update() {
      try {
        const response = await fetch(`/tasks/${encodeURIComponent(taskId)}/architecture`, { signal: controller.signal });
        if (!response.ok) throw Error("读取失败");
        const data = await response.json();
        if (!controller.signal.aborted) { setViews(data.views ?? storyViewCoverage("")); setError(false); }
      } catch { if (!controller.signal.aborted) { setViews(undefined); setError(true); } }
      if (!controller.signal.aborted) timer = setTimeout(update, 5000);
    }
    setViews(undefined); setError(false); void update();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [taskId]);
  const omitted = views?.filter((view) => view.status === "不涉及") ?? [];
  const pending = views?.filter((view) => view.status === "待补充") ?? [];
  return <Alert aria-label="4+1 方案提示" className="mb-3">
    <AlertTitle>4+1 视图</AlertTitle>
    <AlertAction>
      <button type="button" className="border-0 bg-transparent p-0 text-xs text-(--accent) cursor-pointer"
        onClick={onOpen}>查看依据 / 提意见 ↗</button>
    </AlertAction>
    <AlertDescription>
      {error ? <p role="status">覆盖情况暂时无法读取，请在 Story 中核对。</p>
        : !views ? <p role="status">正在读取覆盖情况…</p>
        : <>
          {omitted.map((view) => <p key={view.id}><b>{storyViewTitles[view.id]}不涉及：</b>{view.reason}</p>)}
          {pending.length > 0 && <p>待补充：{pending.map((view) => storyViewTitles[view.id]).join("、")}。请核对后决定。</p>}
          {!omitted.length && !pending.length && <p>五类视图均已声明完成，可查看设计依据。</p>}
          {views.find((view) => view.classDiagram?.reason.startsWith("类图不涉及"))?.classDiagram?.reason && <p>{views.find((view) => view.id === "logical")!.classDiagram!.reason}</p>}
        </>}
    </AlertDescription>
  </Alert>;
}
