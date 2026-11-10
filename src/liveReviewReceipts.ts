import type { HostHooks } from "./sessionDriver.ts";
import type { Annotation } from "./annotations.ts";
import { agentReviewAnnotations } from "./feedbackPolicy.ts";

/** 文件回执的实时投影，不登记人工验收，也不提前结束内核反馈批次。 */
export function withLiveReviewReceipts(base: HostHooks | undefined, options: {
  current(): boolean;
  list(): Annotation[];
  consume(): Promise<string | undefined>;
  log(message: string): void;
}): HostHooks {
  let chain: Promise<unknown> = Promise.resolve();
  let observed = "";
  let notice: string | undefined;
  let currentNote: string | undefined;
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work);
    chain = next.catch(() => undefined);
    return next;
  };
  async function refresh() {
    if (!options.current()) return;
    const error = await options.consume();
    if (!options.current()) { notice = undefined; currentNote = undefined; return; }
    const items = agentReviewAnnotations(options.list());
    const answered = items.filter((a) => a.response?.revision === (a.rework ?? 0));
    const fixed = answered.filter((a) => a.response?.outcome === "fixed");
    const signature = JSON.stringify([error, items.map((a) => [a.id, a.rework, a.response])]);
    currentNote = answered.length ? `宿主已登记 ${answered.length} 条当前轮逐条回应，其中 ${fixed.length} 条 fixed。`
      + `另有 ${items.length - fixed.length} 条已发送意见尚未取得 fixed 回执。`
      + "current 中的反馈清单保留原始意见和来源 SHA，不代表这些意见需要重新修改。"
      + "请完成尚未完成的工作和当前内核步骤，完成后结束本轮，由宿主登记反馈结果并续推；"
      + "不要自行 push 或调用 verifyAnnotation，意见作者仍需验收。" : undefined;
    if (error) currentNote = [currentNote, `部分回执未登记：${error}；已登记的有效回应保留，请只补正有问题的回执。`].filter(Boolean).join("\n");
    if (signature !== observed) {
      observed = signature;
      notice = currentNote;
      if (notice) options.log(notice);
    }
  }
  return {
    preTool: (event) => serial(async () => {
      await refresh();
      return base?.preTool?.(event);
    }),
    postTool: (event) => serial(async () => {
      const result = await base?.postTool?.(event);
      await refresh();
      return result;
    }),
    toolResultNote: (tool) => serial(async () => {
      await refresh();
      const baseNote = await base?.toolResultNote?.(tool);
      const readsCurrent = tool.name === "Bash"
        && /\bcurrent\b/.test(String(tool.input.command ?? ""));
      const message = notice ?? (readsCurrent ? currentNote : undefined);
      notice = undefined;
      return [baseNote, message].filter(Boolean).join("\n\n") || undefined;
    }),
    flush: async () => { await chain; await base?.flush?.(); },
  };
}
