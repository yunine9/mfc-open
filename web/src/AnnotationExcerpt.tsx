
/** 定位失效仍展示已有证据；历史片段不是完整版本，也不是当前内容。 */
export function AnnotationExcerpt({ item, onOpen }: {
  item: { file: string; anchor: string; quote?: string; note: string; context_before?: string; context_after?: string };
  onOpen?: () => void;
}) {
  return <section className="annotation-excerpt" aria-label="批注时原文与意见">
    <header><strong>批注时原文</strong><span>{item.file}</span>
      {onOpen && <button type="button" onClick={onOpen}>查看当前文件</button>}</header>
    <pre>{item.context_before && <span className="annotation-excerpt-context">{item.context_before}{"\n"}</span>}
      <mark>{item.quote || item.anchor}</mark>
      {item.context_after && <span className="annotation-excerpt-context">{"\n"}{item.context_after}</span>}</pre>
    <p><strong>意见：</strong>{item.note}</p>
  </section>;
}
