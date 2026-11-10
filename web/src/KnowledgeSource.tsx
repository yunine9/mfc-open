import { useEffect, useState } from "react";
import { readTaskKnowledgeSource, type TaskKnowledgeResource, type TaskKnowledgeSource } from "./api";
import { OverlayDialog } from "./WarmupPanel";
import { Markdown } from "./markdown";
import { knowledgeOrigin } from "./knowledgeOrigin";

export function KnowledgeSource({ taskId, resource, onClose }: {
  taskId: string; resource: TaskKnowledgeResource; onClose: () => void;
}) {
  const [source, setSource] = useState<TaskKnowledgeSource>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setSource(undefined); setError("");
    void readTaskKnowledgeSource(taskId, resource.id).then((value) => {
      if (active) setSource(value);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "原文读取失败，请稍后重试");
    });
    return () => { active = false; };
  }, [taskId, resource.id]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [onClose]);
  // #226:knowledge-source.css 整档退役,标记工具类化。
  return <OverlayDialog ariaLabel={`知识原文：${resource.name}`} title={resource.name} onClose={onClose}>
    <section className="max-h-[72vh] overflow-auto p-5 pb-7">
      <p className="mb-2 text-sm text-muted-foreground">{knowledgeOrigin(resource)}</p>
      <code className="block break-all text-sm text-muted-foreground">{resource.path}</code>
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : source ? <>
        <p className="mt-2.5 mb-5 text-sm text-muted-foreground">{source.version_changed
          ? "当前文件与任务记录的版本不同，以下展示当前原文。"
          : "当前可读取的原文；知识使用时间见工作台记录。"}</p>
        <Markdown showLineNumbers text={source.content} />
      </> : <p role="status" className="text-sm text-muted-foreground">正在读取原文…</p>}
    </section>
  </OverlayDialog>;
}
