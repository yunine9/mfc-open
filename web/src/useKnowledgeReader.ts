import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/** 页面内展开阅读；目录按面板宽度收起，保留用户的选择和阅读位置。 */
export function useKnowledgeReader() {
  const [fullscreen, updateFullscreen] = useState(false);
  const [showTree, setShowTree] = useState(true);
  const manualTree = useRef(false);
  const frame = useRef<HTMLElement | null>(null);
  const positions = useRef<Array<{ node: Element; top: number; left: number }>>([]);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  const frameRef = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect(); frame.current = node;
    if (!node) return;
    const resize = () => { if (!manualTree.current) setShowTree(node.clientWidth >= 850); };
    resize(); observer.current = new ResizeObserver(resize); observer.current.observe(node);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  useLayoutEffect(() => {
    const saved = positions.current;
    const restore = () => saved.forEach(({ node, top, left }) => { node.scrollTop = top; node.scrollLeft = left; });
    restore();
    // 弹层完成焦点定位后再恢复，避免焦点管理把长文带回开头。
    const id = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(id);
  }, [fullscreen]);
  function setFullscreen(next: boolean) {
    positions.current = [...(frame.current?.querySelectorAll("*") ?? [])]
      .filter(node => node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)
      .map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }));
    updateFullscreen(next);
  }
  // 正文优先：侧栏（如讨论）打开时目录让位，关掉再恢复原样；让位期间手动展开照常生效。
  const beforeYield = useRef<boolean | undefined>(undefined);
  const yieldTree = useCallback((active: boolean) => {
    if (active && beforeYield.current === undefined) { setShowTree(value => { beforeYield.current = value; return false; }); }
    if (!active && beforeYield.current !== undefined) { const previous = beforeYield.current; beforeYield.current = undefined; setShowTree(previous); }
  }, []);
  return { fullscreen, setFullscreen, showTree, frameRef, yieldTree,
    toggleTree: () => { manualTree.current = true; setShowTree(value => !value); } };
}
