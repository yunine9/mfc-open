/** 文件内容留在任务中，对话历史只显示原话与可下载的附件。 */
export function TaskAttachmentMessage({ text }: { text: string }) {
  const marker = text.indexOf("[用户上传的日志附件]");
  if (marker < 0) return <>{text}</>;
  const links = [...text.slice(marker).matchAll(/^- \[([^\n]+)\]\((\/tasks\/[^\s)]+\/attachments\?path=[^\s)]+)\) \((\d+) bytes\)/gm)];
  if (!links.length) return <>{text}</>;
  return <><span className="whitespace-pre-wrap">{text.slice(0, marker).trim()}</span>
    <span className="mt-2 flex flex-wrap gap-2">{links.map(match => <a key={match[2]} href={match[2]} download
      className="rounded border px-2 py-1 text-xs underline">{match[1]} · {(Number(match[3]) / 1024).toFixed(1)} KB</a>)}</span></>;
}
