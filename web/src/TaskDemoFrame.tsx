import { useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

/** 独立窗口隔离演示 API；退出后原工作台仍在原来的位置。 */
export function TaskDemoFrame({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const close = (event: MessageEvent) => {
      if (event.origin === location.origin && event.source === frame.current?.contentWindow
        && event.data?.type === "mae-flow-demo-close") onClose();
    };
    window.addEventListener("message", close);
    return () => window.removeEventListener("message", close);
  }, [onClose]);
  const query = new URLSearchParams({ taskDemo: taskId,
    theme: document.documentElement.dataset.theme ?? "light" });
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="!fixed !inset-0 !m-0 !h-dvh !w-screen !max-w-none !translate-x-0 !translate-y-0 !rounded-none !border-0 !p-0 [&>button]:hidden">
      <DialogTitle className="sr-only">任务演示副本</DialogTitle>
      <iframe ref={frame} title="任务演示副本" src={`/?${query}`}
        sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"
        className="h-full w-full border-0" />
    </DialogContent>
  </Dialog>;
}
