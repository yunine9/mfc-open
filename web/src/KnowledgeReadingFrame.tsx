import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FileText, Maximize2, Minimize2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useKnowledgeReader } from "./useKnowledgeReader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export function KnowledgeReadingFrame({ children, actions, documentActions, title, focused = false, sidePanelOpen = false, inspectionMode = false }: { children: ReactNode; actions?: ReactNode; documentActions?: ReactNode; title: string; focused?: boolean; sidePanelOpen?: boolean; inspectionMode?: boolean }) {
  const { fullscreen, setFullscreen, showTree, toggleTree, frameRef, yieldTree } = useKnowledgeReader();
  const wasInspecting = useRef(false);
  useEffect(() => {
    if (inspectionMode) setFullscreen(true);
    else if (wasInspecting.current) setFullscreen(false);
    wasInspecting.current = inspectionMode;
  }, [inspectionMode]);
  useEffect(() => { yieldTree(sidePanelOpen); }, [sidePanelOpen, yieldTree]);
  const [host] = useState(() => { const node = document.createElement("div"); node.className = "knowledge-reading-host"; return node; });
  const mountReader = useCallback((node: HTMLDivElement | null) => { if (node) node.appendChild(host); }, [host]);
  const body = <section ref={frameRef} className={`domain-file-workspace ${showTree ? "" : "tree-hidden"}${focused ? " is-focused-reader" : ""}`} aria-label="领域知识审查工作区" style={{ height: fullscreen || focused ? "100%" : "max(500px, calc(100dvh - 340px))" }}>
    <header className="research-review-toolbar">
      <div className="reader-tree-tools"><Button variant="ghost" size="sm" aria-expanded={showTree} onClick={toggleTree}>{showTree ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}{showTree ? "收起目录" : "展开目录"}</Button></div>
      <div className="reader-file-tools"><FileText size={20} /><strong title={title}>{title}</strong><div className="reader-file-actions">{documentActions}{actions}
        {!focused && <Button variant="outline" size="sm" onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}{fullscreen ? "退出全屏" : "全屏阅读"}</Button>}
      </div></div>
    </header>{children}
  </section>;
  // 移动同一个阅读器，保留目录折叠、正文滚动和正在编辑的内容。
  return <>{!fullscreen && <div className="knowledge-reading-host" ref={mountReader} />}{createPortal(body, host)}<Dialog open={fullscreen} onOpenChange={setFullscreen}>
    <DialogContent showCloseButton={false} style={{ animation: "none" }} className="tw-root knowledge-reader-dialog h-[100dvh] w-[100vw] max-w-none gap-0 overflow-hidden rounded-none p-0 sm:max-w-none">
      <DialogTitle className="sr-only">领域知识全屏阅读</DialogTitle>{fullscreen && <div className="knowledge-reading-host" ref={mountReader} />}
    </DialogContent>
  </Dialog></>;
}
