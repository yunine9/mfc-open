import { PersonName } from "./People";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createWish,
  deleteWish,
  listWishes,
  setWishStatus,
  setWishVote,
  type WishImageUpload,
  type WishKind,
  type WishStatus,
  type WishWallItem,
} from "./api";
import { confirmDialog } from "./ConfirmDialog";
import { Spinner } from "@/components/Spinner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatLocalDateTime, relativeTime } from "./time";
import { Button } from "@/components/ui/button";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/Empty";
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  nextWishImageDraftKey,
  WISH_IMAGE_TYPES,
  wishImageFilesFromClipboard,
  wishPasteModifier,
} from "./wishWallClipboard";

const IMAGE_LIMIT = 4;
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export interface WishWallDraft {
  key: string;
  kind: WishKind;
  title: string;
  detail?: string;
}

interface ImageDraft {
  key: string;
  file: File;
  preview: string;
}

type Scope = "all" | WishKind;
type Sort = "recent" | "popular";
type StatusScope = "active" | WishStatus | "all";

const STATUS_COPY: Record<WishStatus, { label: string; hint: string }> = {
  open: { label: "待回应", hint: "已收进墙里，等待明确答复" },
  accepted: { label: "已接纳", hint: "这件事会进入后续安排" },
  done: { label: "已闭环", hint: "已经处理完成，可以回来验收" },
  declined: { label: "暂不接纳", hint: "当前不处理，并附有原因" },
};

/** 心愿状态徽标→Badge variant(#216;原 .wish-status is-* 色板收编):
 * 待回应=warning、已接纳=brand(存量 --accent 主动作紫原色)、
 * 已闭环=success、暂不接纳=neutral。 */
const WISH_VARIANT = {
  open: "warning",
  accepted: "brand",
  done: "success",
  declined: "neutral",
} as const;

function fileToUpload(file: File): Promise<WishImageUpload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取图片 ${file.name || "截图"} 失败`));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("图片编码失败"));
      else resolve({ mime_type: file.type, content_base64: value.slice(comma + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function StatusPath({ item }: { item: WishWallItem }) {
  const accepted = item.status === "accepted" || item.status === "done";
  return <div aria-label={`当前状态：${STATUS_COPY[item.status].label}`}
    className="mt-4 mb-0.5 grid grid-cols-[auto_1fr_auto_1fr_auto] items-center gap-[7px] text-faint max-[620px]:gap-1">
    <span className="inline-flex items-center gap-[5px] whitespace-nowrap text-xs font-bold text-success">
      <i className="size-2 rounded-full border-2 border-current bg-current shadow-[inset_0_0_0_1px_var(--surface)]" />已发布</span>
    <b aria-hidden className="h-px bg-line-strong" />
    <span className={cn("inline-flex items-center gap-[5px] whitespace-nowrap text-xs font-bold",
      accepted ? "text-success" : item.status === "declined" ? "text-muted-foreground" : "")}>
      <i className={cn("size-2 rounded-full border-2 border-current", accepted && "bg-current shadow-[inset_0_0_0_1px_var(--surface)]")} />
      {item.status === "declined" ? "暂不接纳" : "已接纳"}
    </span>
    <b aria-hidden className="h-px bg-line-strong" />
    <span className={cn("inline-flex items-center gap-[5px] whitespace-nowrap text-xs font-bold",
      item.status === "done" && "text-success")}>
      <i className={cn("size-2 rounded-full border-2 border-current", item.status === "done" && "bg-current shadow-[inset_0_0_0_1px_var(--surface)]")} />已闭环</span>
  </div>;
}

export function WishWall({ viewer, draft, onDraftConsumed }: {
  viewer: { username: string; role: string };
  draft?: WishWallDraft;
  onDraftConsumed?: () => void;
}) {
  const [items, setItems] = useState<WishWallItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState<WishKind>(draft?.kind ?? "wish");
  const [title, setTitle] = useState(draft?.title ?? "");
  const [detail, setDetail] = useState(draft?.detail ?? "");
  const [images, setImages] = useState<ImageDraft[]>([]);
  const imageRef = useRef<ImageDraft[]>([]);
  const [composerError, setComposerError] = useState("");
  const [notice, setNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [scope, setScope] = useState<Scope>("all");
  const [statusScope, setStatusScope] = useState<StatusScope>("active");
  const [sort, setSort] = useState<Sort>("recent");
  const [expandedId, setExpandedId] = useState("");
  const [busyId, setBusyId] = useState("");
  const [lightbox, setLightbox] = useState<{ url: string; title: string }>();
  const [manage, setManage] = useState<{
    id: string;
    status: WishStatus;
    note: string;
  }>();

  useEffect(() => { imageRef.current = images; }, [images]);
  useEffect(() => { if (draft) onDraftConsumed?.(); }, [draft?.key]);
  useEffect(() => () => {
    imageRef.current.forEach((image) => URL.revokeObjectURL(image.preview));
  }, []);

  async function refresh(): Promise<void> {
    setLoadError("");
    try { setItems(await listWishes()); }
    catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "许愿墙加载失败");
    } finally { setLoading(false); }
  }

  useEffect(() => { void refresh(); }, []);

  const addFiles = useCallback((files: File[]): number => {
    setComposerError("");
    const current = imageRef.current;
    const accepted: ImageDraft[] = [];
    for (const file of files) {
      if (!WISH_IMAGE_TYPES.includes(file.type as typeof WISH_IMAGE_TYPES[number])) {
        setComposerError("图片仅支持 PNG、JPG、WebP 或 GIF");
        continue;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        setComposerError(`${file.name || "这张图片"} 超过 5 MB，请压缩后再试`);
        continue;
      }
      if (current.length + accepted.length >= IMAGE_LIMIT) {
        setComposerError(`一条最多放 ${IMAGE_LIMIT} 张图片`);
        break;
      }
      accepted.push({
        key: nextWishImageDraftKey(file),
        file,
        preview: URL.createObjectURL(file),
      });
    }
    if (accepted.length) {
      const next = [...current, ...accepted];
      imageRef.current = next;
      setImages(next);
    }
    return accepted.length;
  }, []);

  function removeImage(key: string): void {
    setImages((current) => {
      const found = current.find((image) => image.key === key);
      if (found) URL.revokeObjectURL(found.preview);
      const next = current.filter((image) => image.key !== key);
      imageRef.current = next;
      return next;
    });
  }

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      const files = wishImageFilesFromClipboard(event.clipboardData);
      if (!files.length) return;
      event.preventDefault();
      const added = addFiles(files);
      if (added > 0) setNotice(`已粘贴 ${added} 张图片`);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    if (!title.trim()) {
      setComposerError("先写一句标题，让大家一眼看懂");
      return;
    }
    setSubmitting(true); setComposerError(""); setNotice("");
    try {
      const uploads = await Promise.all(images.map((image) => fileToUpload(image.file)));
      const created = await createWish({
        kind, title: title.trim(), detail: detail.trim() || undefined, images: uploads,
      });
      images.forEach((image) => URL.revokeObjectURL(image.preview));
      imageRef.current = [];
      setImages([]); setTitle(""); setDetail("");
      setItems((current) => [created, ...current]);
      setNotice(kind === "issue" ? "问题已贴上墙，等一个明确回应 🧭" : "愿望已升空，等大家来点亮 ✨");
    } catch (cause) {
      setComposerError(cause instanceof Error ? cause.message : "发布失败，请重试");
    } finally { setSubmitting(false); }
  }

  async function toggleVote(item: WishWallItem): Promise<void> {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const updated = await setWishVote(item.id, !item.viewer_voted);
      setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry));
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "点亮失败，请重试");
    } finally { setBusyId(""); }
  }

  async function saveStatus(): Promise<void> {
    if (!manage || busyId) return;
    if (manage.status === "declined" && !manage.note.trim()) {
      setNotice("暂不接纳时请留一句原因，让提出的人有明确下文");
      return;
    }
    setBusyId(manage.id);
    try {
      const updated = await setWishStatus(manage.id, manage.status, manage.note.trim());
      setItems((current) => current.map((entry) => entry.id === manage.id ? updated : entry));
      setManage(undefined);
      setNotice(`${STATUS_COPY[updated.status].label}，状态已同步给所有人`);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "状态更新失败");
    } finally { setBusyId(""); }
  }

  async function remove(item: WishWallItem): Promise<void> {
    if (busyId || !(await confirmDialog({
      title: "移除愿望",
      message: `将从墙上取下「${item.title}」，这不会影响其他内容。`,
      confirmLabel: "取下",
    }))) return;
    setBusyId(item.id);
    try {
      await deleteWish(item.id);
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setNotice("已从墙上取下");
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "移除失败");
    } finally { setBusyId(""); }
  }

  const matchesStatus = useCallback((item: WishWallItem, value: StatusScope) => value === "all"
    || (value === "active" ? item.status === "open" || item.status === "accepted" : item.status === value), []);
  const shown = useMemo(() => items
    .filter((item) => matchesStatus(item, statusScope))
    .filter((item) => scope === "all" || item.kind === scope)
    .sort((left, right) => sort === "popular"
      ? right.votes - left.votes || right.created_at.localeCompare(left.created_at)
      : right.created_at.localeCompare(left.created_at)), [items, matchesStatus, scope, sort, statusScope]);
  const statusCounts = useMemo(() => ({
    active: items.filter((item) => matchesStatus(item, "active")).length,
    open: items.filter((item) => item.status === "open").length,
    accepted: items.filter((item) => item.status === "accepted").length,
    done: items.filter((item) => item.status === "done").length,
    declined: items.filter((item) => item.status === "declined").length,
    all: items.length,
  }), [items, matchesStatus]);
  const scopedItems = useMemo(() => items.filter((item) => matchesStatus(item, statusScope)), [items, matchesStatus, statusScope]);
  const acceptedCount = items.filter((item) => item.status === "accepted").length;
  const doneCount = items.filter((item) => item.status === "done").length;
  const pasteModifier = useMemo(() => wishPasteModifier(), []);

  return <div className="grid gap-6 max-[620px]:gap-4">
    <section className="relative flex min-h-[210px] items-center justify-between gap-[30px] overflow-hidden
      rounded-3xl border border-primary/25 bg-gradient-to-br from-surface-2 via-surface to-surface-3
      px-[38px] py-8 shadow-sm max-[840px]:min-h-0 max-[840px]:p-[27px] max-[620px]:rounded-[17px] max-[620px]:p-[22px]">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 size-56 rounded-full
        bg-[#ffcf68]/25 blur-2xl" />
      <span aria-hidden className="pointer-events-none absolute -bottom-16 -left-10 size-44 rounded-full
        bg-[#7fd7bd]/20 blur-2xl" />
      <div className="relative z-1 max-w-[720px]">
        <h2 className="mt-2 mb-2.5 text-[clamp(25px,3vw,38px)] font-bold leading-[1.15] tracking-[-0.045em] text-text-strong max-[620px]:text-[26px]">
          让每个“小别扭”，都有一个好下文</h2>
        <p className="m-0 max-w-[650px] text-[15px] leading-[1.8] text-muted-foreground max-[620px]:text-sm">
          遇到问题、想到改进，随手贴上来。大家一起点亮，负责人明确接纳，完成后公开闭环。</p>
        <div className="mt-[23px] flex flex-wrap gap-2 max-[620px]:mt-4" aria-label="许愿墙摘要">
          <span className="rounded-full border border-primary/20 bg-surface/75 px-[11px] py-[7px] text-[13px] text-muted-foreground"><strong className="mr-[3px] text-[15px] text-text-strong">{items.length}</strong> 个声音</span>
          <span className="rounded-full border border-primary/20 bg-surface/75 px-[11px] py-[7px] text-[13px] text-muted-foreground"><strong className="mr-[3px] text-[15px] text-text-strong">{acceptedCount}</strong> 个已接纳</span>
          <span className="rounded-full border border-primary/20 bg-surface/75 px-[11px] py-[7px] text-[13px] text-muted-foreground"><strong className="mr-[3px] text-[15px] text-text-strong">{doneCount}</strong> 个已闭环</span>
        </div>
      </div>
      <div aria-hidden className="relative z-1 grid size-[156px] shrink-0 place-items-center rounded-full
        border border-dashed border-primary/40 animate-[wishFloat_5s_ease-in-out_infinite]
        max-[840px]:size-[120px] max-[620px]:hidden">
        <span className="absolute top-[-7px] left-[14px] grid size-[34px] -rotate-9 place-items-center rounded-[11px]
          border border-line bg-surface text-[17px] shadow-xs">✨</span>
        <span className="absolute right-[-9px] top-[51px] grid size-[34px] rotate-9 place-items-center rounded-[11px]
          border border-line bg-surface text-[17px] shadow-xs">💡</span>
        <span className="absolute bottom-0 left-[3px] grid size-[34px] rotate-7 place-items-center rounded-[11px]
          border border-line bg-surface text-[17px] shadow-xs">🛠️</span>
        <i className="grid size-24 place-items-center rounded-full border border-primary/25 bg-surface/90
          text-center text-[15px] font-extrabold not-italic leading-[1.4] text-text-strong shadow-sm
          max-[840px]:size-[76px] max-[840px]:text-[13px]">愿望<br />发射台</i>
      </div>
    </section>

    <form className={cn("relative grid content-start gap-[17px] rounded-[20px] border bg-surface px-[27px] pt-6 pb-[21px] shadow-sm",
      "max-[620px]:rounded-[15px] max-[620px]:p-[18px]",
      dragging ? "border-primary shadow-[0_0_0_4px_var(--active-soft),var(--shadow-sm)]" : "border-line")}
      onSubmit={submit}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false); addFiles([...event.dataTransfer.files]);
      }}>
      <div className="flex items-center justify-between gap-4 max-[620px]:flex-col max-[620px]:items-start">
        <div className="flex items-center gap-2 text-lg text-text-strong">
          <span aria-hidden className="grid size-[29px] place-items-center rounded-[9px] bg-gradient-to-br from-primary to-merge text-[13px] text-primary-foreground">✦</span>
          <strong>我想说一件事</strong></div>
        <div className="flex gap-[3px] rounded-[11px] border border-line bg-surface-2 p-[3px] max-[620px]:w-full" role="group" aria-label="内容类型">
          <button type="button" className={cn("min-h-[34px] flex-1 cursor-pointer rounded-lg border-0 px-3 text-[13px] font-bold text-muted-foreground hover:text-text",
            kind === "wish" && "bg-surface text-primary shadow-xs")}
            onClick={() => setKind("wish")}>💫 我有个诉求</button>
          <button type="button" className={cn("min-h-[34px] flex-1 cursor-pointer rounded-lg border-0 px-3 text-[13px] font-bold text-muted-foreground hover:text-text",
            kind === "issue" && "bg-surface text-attention shadow-xs")}
            onClick={() => setKind("issue")}>🧩 我遇到问题</button>
        </div>
      </div>
      <label className="relative grid gap-[7px]">
        <span className="text-[13px] font-bold text-text">一句话说清楚</span>
        <Input className="h-11 pr-[53px] font-semibold" value={title} onChange={(event) => setTitle(event.target.value)}
          maxLength={100} placeholder={kind === "issue"
            ? "例如：手机上看任务详情时，代码块会横向溢出"
            : "例如：希望任务完成后能一键生成复盘摘要"} />
        <small className="absolute bottom-3.5 right-3 text-xs text-faint">{title.length}/100</small>
      </label>
      <label className="grid gap-[7px]">
        <span className="text-[13px] font-bold text-text">再补充一点 <small className="font-medium text-faint">（可选）</small></span>
        <Textarea className="min-h-21 resize-y" value={detail} onChange={(event) => setDetail(event.target.value)}
          maxLength={2000} rows={3} placeholder="什么场景下遇到的？你希望它变成什么样？不用写成正式需求。" />
      </label>
      {images.length > 0 && <div className="grid grid-cols-2 gap-2.5 min-[621px]:grid-cols-[repeat(4,minmax(0,150px))]">
        {images.map((image, index) => <figure key={image.key} className="relative m-0 aspect-[4/3] overflow-hidden rounded-[11px] border border-line bg-surface-2">
          <img src={image.preview} alt={`待发布图片 ${index + 1}`} className="size-full object-cover" />
          <button type="button" onClick={() => removeImage(image.key)} aria-label={`移除第 ${index + 1} 张图片`}
            className="absolute top-1.5 right-1.5 size-[25px] cursor-pointer rounded-full border border-white/40
              bg-[#0f141f]/70 p-0 text-lg leading-[20px] text-white">×</button>
        </figure>)}
      </div>}
      <div className="flex items-center gap-[13px] max-[840px]:flex-wrap max-[620px]:flex-col max-[620px]:items-stretch">
        <label className="relative inline-flex min-h-9 cursor-pointer items-center gap-[7px] rounded-[9px] border border-line
          bg-surface-2 px-[11px] text-[13px] font-bold text-text hover:border-line-strong hover:bg-surface-3">
          <input type="file" accept={WISH_IMAGE_TYPES.join(",")} multiple onChange={(event) => {
            addFiles([...(event.target.files ?? [])]); event.target.value = "";
          }} className="absolute size-px opacity-0" />
          <span aria-hidden className="text-[17px] text-primary">▧</span> 添加图片
        </label>
        <span className="min-w-[250px] flex-1 text-[13px] text-faint max-[620px]:order-3 max-[620px]:min-w-full max-[620px]:leading-[1.55]">
          <kbd className="mr-0.5 inline-grid h-5 min-w-5 place-items-center rounded border border-b-2 border-line-strong bg-surface-2 px-1 font-mono text-[11px] text-muted-foreground">{pasteModifier}</kbd>
          <kbd className="mr-0.5 inline-grid h-5 min-w-5 place-items-center rounded border border-b-2 border-line-strong bg-surface-2 px-1 font-mono text-[11px] text-muted-foreground">V</kbd>
          直接粘贴截图，也可拖到这里 · 最多 4 张</span>
        <button className="ml-auto inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-[10px] border-0
          bg-gradient-to-br from-primary to-merge px-4 text-[13px] font-extrabold text-primary-foreground shadow-md
          transition hover:-translate-y-px disabled:translate-y-0 disabled:opacity-60 disabled:cursor-wait" type="submit" disabled={submitting}>
          {submitting ? "正在贴上墙…" : kind === "issue" ? "把问题贴上墙" : "发射这个愿望"}
          <span aria-hidden className="text-base">↗</span>
        </button>
      </div>
      {dragging && <div className="pointer-events-none absolute inset-2 z-[4] grid place-content-center gap-1 rounded-2xl
        border-2 border-dashed border-primary bg-surface/85 text-center text-primary backdrop-blur-[7px]">
        <strong className="text-lg">放手，图片就留在这里</strong><span className="text-[13px] text-muted-foreground">最多 4 张，每张不超过 5 MB</span></div>}
      {composerError && <p className="-mt-1 text-[13px] text-danger" role="alert">{composerError}</p>}
    </form>

    <section className="pt-1" aria-labelledby="wish-board-title">
      <div className="grid grid-cols-[minmax(250px,0.8fr)_minmax(520px,1.35fr)] items-center gap-6 rounded-2xl
        border border-line bg-surface px-[21px] py-[19px] shadow-xs max-[840px]:grid-cols-1 max-[840px]:gap-[15px]">
        <div>
          <h2 id="wish-board-title" className="mt-1.5 mb-[5px] text-[22px] tracking-[-0.025em] text-text-strong">大家最近在意什么</h2>
          <p className="m-0 max-w-[450px] text-[13px] leading-[1.55] text-muted-foreground">先看仍需推进的声音；已闭环和暂不接纳的内容随时可查，但不再和待办挤在一起。</p>
        </div>
        <div className="grid grid-cols-3 gap-[7px]" role="group" aria-label="按处理状态筛选">
          {([
            ["active", "进行中"],
            ["open", "待回应"],
            ["accepted", "已接纳"],
            ["done", "已闭环"],
            ["declined", "暂不接纳"],
            ["all", "全部"],
          ] as [StatusScope, string][]).map(([value, label]) => <button type="button" key={value}
            className={cn("flex min-h-12 min-w-0 cursor-pointer items-center justify-between gap-2.5 rounded-[10px] border px-3 text-[13px] font-bold",
              "bg-surface-2 text-muted-foreground hover:border-line-strong hover:bg-surface-3",
              statusScope === value && value !== "done" && "border-primary/35 bg-primary/10 text-primary shadow-[inset_3px_0_0_var(--primary)]",
              statusScope === value && value === "done" && "border-success/35 bg-success/10 text-success shadow-[inset_3px_0_0_var(--success)]")}
            onClick={() => { setStatusScope(value); setScope("all"); setExpandedId(""); }}>
            <span>{label}</span><strong className="text-[17px] text-text-strong">{statusCounts[value]}</strong>
          </button>)}
        </div>
      </div>
      <div className="my-2.5 flex items-center justify-between gap-4 max-[620px]:flex-col max-[620px]:items-start">
        <span className="text-[13px] text-faint">当前显示 <strong className="text-text">{shown.length}</strong> 条</span>
        <div className="flex gap-2 max-[620px]:w-full">
          <div role="group" aria-label="筛选类型" className="flex gap-0.5 rounded-[10px] border border-line bg-surface p-[3px] max-[620px]:flex-1">
            {(["all", "wish", "issue"] as Scope[]).map((value) => <button type="button"
              key={value}
              className={cn("min-h-[31px] flex-1 cursor-pointer rounded-[7px] border-0 px-[11px] text-[13px] font-bold text-muted-foreground hover:text-text max-[620px]:px-2",
                scope === value && "bg-primary/10 text-primary")}
              onClick={() => setScope(value)}>
              {value === "all" ? `全部 ${scopedItems.length}` : value === "wish"
                ? `诉求 ${scopedItems.filter((item) => item.kind === "wish").length}`
                : `问题 ${scopedItems.filter((item) => item.kind === "issue").length}`}
            </button>)}
          </div>
          <Select value={sort}
            items={[{ value: "recent", label: "最新发布" }, { value: "popular", label: "最多点亮" }]}
            onValueChange={(value) => setSort((value ?? "recent") as Sort)}>
            <SelectTrigger aria-label="排序方式"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="recent">最新发布</SelectItem>
                <SelectItem value="popular">最多点亮</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </div>
      {notice && <p className="mb-3.5 flex items-center justify-between gap-3 rounded-[10px] border border-success/25 bg-success/10 px-[13px] py-2.5 text-[13px] text-success" role="status">{notice}<button type="button" onClick={() => setNotice("")} aria-label="关闭提示" className="cursor-pointer border-0 bg-transparent text-lg text-current">×</button></p>}
      {loadError && <div className="grid min-h-[150px] place-content-center justify-items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2 text-center text-danger"><strong>墙暂时没加载出来</strong><span>{loadError}</span><button type="button" onClick={() => void refresh()} className="cursor-pointer rounded-lg border border-line bg-surface px-[11px] py-[7px] text-text">再试一次</button></div>}
      {loading && <div className="grid min-h-[150px] place-content-center justify-items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2 text-center text-muted-foreground"><Spinner className="size-3" />正在把大家的声音搬过来…</div>}
      {!loading && !loadError && shown.length === 0 && <Empty className="min-h-[150px] border rounded-2xl" role="status">
        <EmptyMedia className="text-3xl">{scope === "issue" ? "🪁" : "🌱"}</EmptyMedia>
        <EmptyTitle>{items.length ? "这里暂时没有内容" : "墙面刚刷好，等第一个声音"}</EmptyTitle>
        <EmptyDescription>{items.length ? "换个状态或类型看看，也可以把你的想法贴上来。" : "不用想得很完整，一句话也值得被看见。"}</EmptyDescription>
      </Empty>}
      <div className="mt-[15px] grid gap-2">
        {shown.map((item) => {
          const expanded = expandedId === item.id;
          const issue = item.kind === "issue";
          return <article key={item.id}
            className={cn("relative grid min-h-[98px] min-w-0 grid-cols-[42px_minmax(0,1fr)_auto] items-start gap-[13px] overflow-hidden",
              "rounded-[13px] border bg-surface p-4 transition max-[620px]:grid-cols-[38px_minmax(0,1fr)] max-[620px]:p-[15px]",
              issue ? "hover:border-attention/30" : "hover:border-primary/30",
              expanded && (issue ? "border-attention/30 bg-gradient-to-br from-attention/[0.03] to-surface" : "border-primary/30 bg-gradient-to-br from-primary/[0.03] to-surface"),
              !expanded && "border-line hover:shadow-xs")}>
            <span aria-hidden className={cn("grid size-10 place-items-center rounded-[11px] text-lg max-[620px]:size-9",
              issue ? "bg-attention/10" : "bg-primary/10")}>{issue ? "🧩" : "💫"}</span>
            <div className="min-w-0">
              <header className="flex items-center gap-2">
                <span className={cn("inline-flex items-center gap-1.5 text-xs font-extrabold tracking-[0.03em]",
                  issue ? "text-attention" : "text-primary")}>{issue ? "问题" : "诉求"}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-faint"><strong className="max-w-[130px] truncate text-muted-foreground"><PersonName account={item.author} /></strong><i className="not-italic">·</i><time title={formatLocalDateTime(item.created_at)}>{relativeTime(item.created_at)}</time></span>
              </header>
              <h3 className="mt-1.5 mb-1 text-base leading-[1.42] tracking-[-0.01em] text-text-strong [overflow-wrap:anywhere]">{item.title}</h3>
              {item.detail && !expanded && <p className="m-0 line-clamp-2 whitespace-pre-wrap text-[13px] leading-[1.55] text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>}
              {item.decision_note && !expanded && <p className={cn("mt-[7px] flex min-w-0 gap-[7px] overflow-hidden border-l-2 pl-2 text-xs leading-[1.45] whitespace-nowrap text-muted-foreground",
                item.status === "done" ? "border-success" : "border-primary")}>
                <strong className="shrink-0 text-text">{item.status === "declined" ? "暂不接纳说明" : item.status === "done" ? "闭环反馈" : "处理反馈"}</strong>
                <span className="truncate">{item.decision_note}</span>
              </p>}
              {item.images.length > 0 && !expanded && <span className="mt-1.5 inline-block text-xs text-faint">▧ {item.images.length} 张图片</span>}
            </div>
            <aside className="flex min-w-[265px] flex-col items-end justify-between gap-[13px] self-stretch max-[840px]:min-w-[230px] max-[620px]:col-start-2 max-[620px]:min-w-0 max-[620px]:items-start">
              <Badge variant={WISH_VARIANT[item.status]} title={STATUS_COPY[item.status].hint}>
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
                {STATUS_COPY[item.status].label}
              </Badge>
              <div className="flex items-center justify-end gap-[5px] max-[620px]:flex-wrap max-[620px]:justify-start">
              <button type="button"
                className={cn("min-h-[30px] cursor-pointer whitespace-nowrap rounded-lg border bg-surface px-[9px] text-xs font-bold text-muted-foreground disabled:opacity-55 disabled:cursor-wait",
                  item.viewer_voted ? "border-primary/35 bg-primary/10 text-primary" : "border-line hover:border-primary/35 hover:text-primary")}
                disabled={busyId === item.id} aria-pressed={item.viewer_voted}
                onClick={() => void toggleVote(item)} title={item.viewer_voted ? "取消点亮" : "我也期待"}>
                <span aria-hidden className="mr-1 text-base text-primary">{item.viewer_voted ? "✦" : "☆"}</span>{item.votes || "点亮"}
              </button>
              <button type="button" aria-expanded={expanded}
                className="min-h-[30px] cursor-pointer whitespace-nowrap rounded-lg border border-line bg-surface px-[9px] text-xs font-bold text-muted-foreground hover:border-primary/35 hover:text-primary"
                onClick={() => setExpandedId(expanded ? "" : item.id)}>{expanded ? "收起" : "查看详情"}</button>
              {item.can_manage && <button type="button"
                className="min-h-[30px] cursor-pointer whitespace-nowrap rounded-lg border border-line bg-surface px-[9px] text-xs font-bold text-muted-foreground hover:border-primary/35 hover:text-primary"
                onClick={() => setManage({ id: item.id, status: item.status, note: item.decision_note ?? "" })}>回应</button>}
              {/* #220 ••• 直删钮换 DropdownMenu:菜单只承载现场原有的
                  「移除」一个动作,confirmDialog 确认链与 busy 门原样;
                  触发钮经 render 仍是真 button,••• 与 aria-label 不变。 */}
              {item.can_delete && <DropdownMenu>
                <DropdownMenuTrigger render={
                  <button type="button" aria-label={`移除 ${item.title}`}
                    className="w-[31px] min-h-[30px] cursor-pointer whitespace-nowrap rounded-lg border border-line bg-surface px-0 text-xs font-bold tracking-[1px] text-muted-foreground hover:border-primary/35 hover:text-primary"
                    disabled={busyId === item.id} />
                }>•••</DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-24">
                  <DropdownMenuItem variant="destructive" onClick={() => void remove(item)}>移除</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>}
              </div>
            </aside>
            {expanded && <div className="col-[2/-1] min-w-0 border-t border-line pt-3.5 max-[620px]:col-start-2">
              {item.detail && <p className="mb-[13px] whitespace-pre-wrap text-sm leading-[1.7] text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>}
              {item.images.length > 0 && <div className="mb-[15px] grid grid-cols-[repeat(auto-fill,minmax(140px,180px))] gap-[7px] max-[620px]:grid-cols-2">
                {item.images.map((image, imageIndex) => <button type="button" key={image.id}
                  onClick={() => setLightbox({ url: image.url, title: `${item.title} · 图片 ${imageIndex + 1}` })}
                  className="group h-[120px] min-w-0 cursor-zoom-in overflow-hidden rounded-[9px] border border-line bg-surface-3 p-0">
                  <img src={image.url} alt={`${item.title}的补充图片 ${imageIndex + 1}`} loading="lazy"
                    className="block size-full object-cover transition-transform duration-200 group-hover:scale-[1.025]" />
                </button>)}
              </div>}
              <StatusPath item={item} />
              {item.decision_note && <blockquote className={cn("mt-3.5 rounded-r-[9px] border-l-[3px] px-[13px] py-[11px]",
                item.status === "done" ? "border-success bg-success/10" : "border-primary bg-primary/10")}>
                <span className="text-xs font-extrabold text-muted-foreground">{item.status === "declined" ? "暂不接纳说明" : item.status === "done" ? "闭环反馈" : "处理反馈"}</span>
                <p className="my-1 whitespace-pre-wrap text-[13px] leading-[1.55] text-text">{item.decision_note}</p>
                <footer className="text-xs text-faint">{item.decided_by} · {formatLocalDateTime(item.decided_at)}</footer>
              </blockquote>}
            </div>}
          </article>;
        })}
      </div>
    </section>

    {lightbox && <Dialog open onOpenChange={(next) => { if (!next) setLightbox(undefined); }}>
      <DialogContent showCloseButton={false}
        className="w-auto max-w-[min(1100px,94vw)] gap-2 p-2 sm:max-w-[min(1100px,94vw)]">
        <DialogTitle className="sr-only">{lightbox.title}</DialogTitle>
        <img src={lightbox.url} alt={lightbox.title}
          className="max-h-[88vh] w-full rounded-lg object-contain" />
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭图片"
          className="absolute top-3 right-3 bg-background/70" />}>
          <XIcon />
        </DialogClose>
      </DialogContent>
    </Dialog>}
    {manage && <Dialog open onOpenChange={(next) => { if (!next) setManage(undefined); }}>
      <DialogContent showCloseButton={false} className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>给这件事一个明确下文</DialogTitle>
        </DialogHeader>
        <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭"
          className="absolute top-2 right-2" />}>
          <XIcon />
        </DialogClose>
        <div className="my-5 grid grid-cols-2 gap-2 max-[620px]:grid-cols-1" role="group" aria-label="处理状态">
          {(["open", "accepted", "done", "declined"] as WishStatus[]).map((status) => <button
            type="button" key={status}
            className={cn("flex min-h-16 cursor-pointer items-start gap-2 rounded-[10px] border p-2.5 text-left text-muted-foreground",
              manage.status === status && status !== "done" && "border-primary bg-primary/10",
              manage.status === status && status === "done" && "border-success bg-success/10")}
            onClick={() => setManage({ ...manage, status })}>
            <i className={cn("mt-1 size-2.5 shrink-0 rounded-full border-2 border-line-strong",
              manage.status === status && status !== "done" && "border-primary bg-primary shadow-[inset_0_0_0_2px_var(--surface)]",
              manage.status === status && status === "done" && "border-success bg-success shadow-[inset_0_0_0_2px_var(--surface)]")} />
            <span className="grid gap-[3px]"><strong className="text-[13px] text-text">{STATUS_COPY[status].label}</strong><small className="text-xs leading-[1.4] text-faint">{STATUS_COPY[status].hint}</small></span>
          </button>)}
        </div>
        <label className="grid gap-1.5"><span className="text-sm font-medium text-foreground">给提出人的反馈 {manage.status === "declined" ? "（必填）" : "（可选）"}</span>
          <Textarea className="min-h-24 resize-y" value={manage.note} maxLength={500} rows={4} onChange={(event) => setManage({ ...manage, note: event.target.value })}
            placeholder={manage.status === "declined" ? "请说明现在为什么不做，或者什么条件下会重新考虑" : "例如：已纳入下个迭代；已上线，可在个人设置中体验"} /></label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setManage(undefined)}>取消</Button>
          <Button type="button" disabled={busyId === manage.id} onClick={() => void saveStatus()}>
            {busyId === manage.id ? "保存中…" : "确认并公开回应"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </div>;
}
