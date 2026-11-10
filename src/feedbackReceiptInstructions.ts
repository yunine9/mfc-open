/** Keep opaque feedback identities separate from prose, including on retry.
 * The platform supplies identities only; outcomes and evidence remain the
 * agent's responsibility and the unchanged batch validator checks the result.
 */
export function feedbackReceiptInstructions(active: {
  batchId: string;
  path: string;
  items: Array<{ id: unknown; summary?: unknown }>;
}): string {
  const template = {
    schema: "mae-flow-feedback-results/1",
    batch_id: active.batchId,
    results: active.items.map((item) => ({
      id: String(item.id), status: "", summary: "", evidence: "",
    })),
  };
  return [
    "逐条处理完成后，必须写一份机器可核对的反馈回执；总体回复不算回执。",
    `写入唯一绝对路径 ${JSON.stringify(active.path)}（不随工作目录变化），只写 JSON，不要 Markdown 围栏：`,
    "以下模板已填入真实 batch_id 和完整 id，请原样保留这些字段。id 是不可拆解的标识，不得追加冒号、摘要、状态或解释，也不得截断。",
    JSON.stringify(template, null, 2),
    "只填写每条的 status、summary、evidence：status 必须是 fixed、explained、needs_human、not_applicable 之一；summary 写清具体做了什么或为什么不改；evidence 填文件:行或核对事实。空模板不是完成回执。",
    "每个 id 必须恰好一条；缺失、重复、陈旧或夹带都会原地要求补交，绝不会拿收口发言代填。",
    "反馈原文如下（id 与 summary 是两个独立 JSON 字段；summary 仅供理解问题，不属于 id）：",
    JSON.stringify(active.items.map((item) => ({
      id: String(item.id), summary: String(item.summary ?? ""),
    })), null, 2),
  ].join("\n");
}
