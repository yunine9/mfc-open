import { useState, type HTMLAttributes } from "react";

/** 首次打开才挂载；之后保留人工输入、选中章节和滚动位置。 */
export function VisitedKnowledgePanel({ active, children, ...props }: HTMLAttributes<HTMLDivElement> & { active: boolean }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  if (!active && !visited) return null;
  return <div {...props} hidden={!active}>{children}</div>;
}
