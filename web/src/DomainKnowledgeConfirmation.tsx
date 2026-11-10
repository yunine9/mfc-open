import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./markdown";
import type { DomainKnowledgeJob, DomainTurn } from "../../src/domainKnowledgeTypes";

export function DomainKnowledgeConfirmation({ job, waiting, compact, disabled, onRead, onReadWork, onShow, onReply }: {
  job: DomainKnowledgeJob; waiting: NonNullable<DomainTurn["waiting"]>; compact: boolean; disabled?: boolean;
  onRead: (id: string) => void; onReadWork: (turnId: string, id: string) => void; onShow: () => void;
  onReply: (message: string) => Promise<boolean>;
}) {
  const [adjusting, setAdjusting] = useState(false), [message, setMessage] = useState("");
  const turnId = job.turns.at(-1)!.id;
  return <section aria-label="待确认内容" className="mx-4 my-2 shrink-0 rounded-lg border border-line bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><strong className="font-medium">等待你的答复</strong>{compact && <Button size="sm" variant="link" onClick={onShow}>查看待确认内容</Button>}</div>
    {!compact && <><div className="mt-2 max-h-56 overflow-auto"><Markdown text={waiting.summary} /></div>
      <div className="mt-2 flex flex-wrap gap-2">{waiting.work_document_ids.map(id => {
        const document = job.work_documents?.find(document => document.turn_id === turnId && document.id === id);
        return document && <Button key={`work:${id}`} className="h-auto max-w-full whitespace-normal break-words text-left" size="sm" variant="outline" onClick={() => onReadWork(turnId, id)}>审阅 · {document.title}</Button>;
      })}{waiting.document_ids.map(id => {
        const document = job.documents.find(document => document.id === id);
        return document && <Button key={id} className="h-auto max-w-full whitespace-normal break-words text-left" size="sm" variant="outline" onClick={() => onRead(id)}>审阅 · {document.title}</Button>;
      })}</div></>}
    {adjusting ? <div className="mt-3 space-y-3"><label className="block text-sm" htmlFor={`reply-${waiting.id}`}>需要调整或补充什么？</label><Textarea id={`reply-${waiting.id}`} aria-label="研究确认意见" rows={3} value={message} onChange={event => setMessage(event.target.value)} placeholder="写下修改意见或补充信息，Agent 会按你的答复接着处理。" /><div className="flex gap-2"><Button disabled={disabled || !message.trim()} onClick={() => void onReply(message)}>提交意见</Button><Button variant="outline" disabled={disabled} onClick={() => setAdjusting(false)}>取消</Button></div></div>
      : <div className="mt-3 flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void onReply("确认当前内容，请按此继续。")}>确认并继续</Button><Button variant="outline" disabled={disabled} onClick={() => setAdjusting(true)}>我想调整或补充</Button></div>}
  </section>;
}
