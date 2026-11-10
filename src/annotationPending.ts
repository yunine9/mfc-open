/** “已记下、还没交给 Agent”的唯一判据。旧账的 sent/owner_pending 只是
 * 到了责任人队列，不是 Agent 送达收据；保留原事件，不伪造重新发送。 */
export function pendingReviewAnnotation(item: {
  status: string; route?: string; sent_via?: string; owner_reply?: unknown;
  response?: unknown; resolution?: unknown;
}): boolean {
  return !item.owner_reply && !item.resolution
    && (item.status === "draft"
      || (item.status === "sent" && item.sent_via === "owner_pending" && !item.response));
}
