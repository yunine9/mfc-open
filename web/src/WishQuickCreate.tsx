import { useState } from "react";
import { createWish } from "./api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function QuickWishButton({ onOpenWall, inline = false }: { onOpenWall: () => void; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setMessage("");
    try {
      await createWish({ kind: "issue", title: title.trim(),
        detail: detail.trim() || undefined, images: [] });
      setTitle(""); setDetail(""); setMessage("问题已提交到许愿墙");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "提交失败，请重试");
    } finally { setBusy(false); }
  }

  return <>
    <button type="button"
      className={inline
        ? "inline-flex shrink-0 cursor-pointer items-center gap-[5px] rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-text hover:bg-surface-2 hover:border-primary"
        // 浮标定位:24px 安全边距(原 18px 贴视口右/下缘,压卡裁字感强);
        // ≤760px 窄屏锚位抬高避让底部栏、边距 16px,并把浮标收小一号,
        // 680 窄幅下少遮正文(卡片单列铺满,重叠不可避免,只求最小遮挡)。
        : "wish-quick-fab fixed right-6 bottom-6 z-[650] inline-flex min-h-[42px] cursor-pointer items-center gap-[7px] rounded-full border-0 bg-primary px-3.5 text-primary-foreground shadow-lg max-[760px]:bottom-[76px] max-[760px]:right-4 max-[760px]:min-h-[36px] max-[760px]:gap-[5px] max-[760px]:px-3"}
      aria-label="快速提问题" title="快速提问题"
      onClick={() => { setOpen(true); setMessage(""); }}>
      <span aria-hidden className="text-base">✦</span><strong className="text-xs">提问题</strong>
    </button>
    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <DialogContent className="sm:max-w-[460px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>快速提个问题</DialogTitle>
            <DialogDescription>快速反馈</DialogDescription>
          </DialogHeader>
          <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">一句话说明问题</span>
            <Input autoFocus required maxLength={100} value={title}
              placeholder="哪里不好用，或者哪里不符合预期？"
              onChange={(event) => setTitle(event.target.value)} /></label>
          <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">补充现场 <small>（可选）</small></span>
            <Textarea className="min-h-24 resize-y" rows={4} maxLength={2000} value={detail}
              placeholder="刚才做了什么、希望变成什么样"
              onChange={(event) => setDetail(event.target.value)} /></label>
          {message && <p role="status">{message}</p>}
          <DialogFooter>
            <Button type="button" variant="outline"
              onClick={() => { setOpen(false); onOpenWall(); }}>
              查看许愿墙
            </Button>
            <Button type="submit" disabled={busy || !title.trim()}>
              {busy ? "提交中…" : "提交问题"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
