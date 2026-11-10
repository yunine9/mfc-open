/**
 * 登记描述 Quill 富文本编辑器(#271 修订版,2026-09-17 拍板):工具栏
 * 输入形态,dts-auto 同款;存储世界不变——对外仍是 markdown 契约
 * (value/onChange),内部进出各一次 md↔HTML 转换(mdHtml.ts),图片
 * 依旧落暂存体系(issue-images/ 相对引用),不学 base64 内联(description
 * 每回合全量进 AI 上下文,base64 会把上下文撑爆)。
 *
 * 粘贴拦截随行(#276):data:/http(s) 外链/file:/// 三路转存逻辑原样
 * 搬入——剪贴板里有字节(data:/位图)时本地转存,没字节的外链走后端
 * 代理(DTS 域经网关同源凭据)。回退:改 descriptionEditorChoice.ts
 * 常量重新构建即切回 milkdown,存储零迁移。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Quill from "quill";
import "quill/dist/quill.snow.css";
import { Loader2, Paperclip } from "lucide-react";
import { issueImageUrl } from "../api";
import { proxyIssueImage } from "../api";
import {
  markdownToEditorHtml, editorHtmlToMarkdown,
} from "./mdHtml";
import {
  pasteImageFile, classifyExternalImageSrc, isHostedImageSrc,
  transferFailHint,
} from "./useIssueImagePaste";
import { cn } from "cn";

/** 编辑器 src(预览 URL 或相对引用)→ 存储引用。 */
function srcToRef(src: string): string {
  if (src.startsWith("issue-images/")) return src;
  try {
    const url = new URL(src, globalThis.location?.origin ?? "http://x");
    const path = url.searchParams.get("path");
    if (path?.startsWith("issue-images/")) return path;
  } catch { /* 相对引用等非法 URL 原样 */ }
  return src;
}

/** 存储引用 → 编辑器 src;非托管引用原样。 */
function refToSrc(src: string): string {
  return src.startsWith("issue-images/") ? issueImageUrl(src) : src;
}

export function RichTextEditor({
  value,
  onChange,
  onUploadImage,
  onUploadAttachment,
  onError,
  placeholderText,
}: {
  /** markdown(存储世界,相对引用)。 */
  value: string;
  /** 内容变更(已映射回相对引用,可直接进 description)。 */
  onChange: (next: string) => void;
  /** 图片上传:落 staging,返回 issue-images/ 相对引用。上传失败由
   * 钩子自行向用户报告(编辑器只跳过该图,不代发第二遍)。 */
  onUploadImage: (file: File) => Promise<string>;
  /** 登记附件上传(日志等非图片文件):落 staging,返回 attachments/
   * 相对引用,编辑器在光标处插入纯文本路径——附件是给 AI 读的,不渲染
   * 内容。缺席=该壳不支持附件(按钮不渲染、粘贴/拖拽不接管非图片)。 */
  onUploadAttachment?: (file: File) => Promise<string>;
  /** 仅编辑器初始化失败时上报(上传路径不走这里)。 */
  onError?: (message: string) => void;
  placeholderText?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const quillRef = useRef<Quill | null>(null);
  // 值回路防抖:onChange 出来的 markdown 记为"内部已知",父态回灌时
  // 只有真正外部变更(如草稿回读/提交后重置)才整体覆盖,键入不回灌。
  const internalRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const attachmentUploadRef = useRef(onUploadAttachment);
  attachmentUploadRef.current = onUploadAttachment;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  // 上传进行态浮层:与旧编辑器同款契约(截图上传中…),位图/data:/
  // 外链代理三条上传路共用计数。
  const [pendingUploads, setPendingUploads] = useState(0);
  const trackPending = useCallback(
    async <T,>(run: () => Promise<T>): Promise<T> => {
      setPendingUploads((count) => count + 1);
      try {
        return await run();
      } finally {
        setPendingUploads((count) => Math.max(0, count - 1));
      }
    }, []);

  // 登记附件:上传后在光标处插入纯文本路径引用(attachments/<hash>.<ext>)
  // ——不是图片,没有嵌入对象可渲染,路径文本就是描述的一部分。
  const uploadAndInsertAttachment = useCallback(async (file: File) => {
    const upload = attachmentUploadRef.current;
    if (!upload) return;
    try {
      const ref = await trackPending(() => upload(file));
      const quill = quillRef.current;
      if (!quill) return;
      const index = quill.getSelection(true)?.index ?? quill.getLength() ?? 0;
      quill.insertText(index, ref);
    } catch {
      // 上传失败的用户提示归上传钩子所有(它自己 onError);这里只跳过。
    }
  }, [trackPending]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || quillRef.current) return;
    const quill = new Quill(root, {
      theme: "snow",
      placeholder: placeholderText,
      modules: {
        toolbar: [
          [{ header: [1, 2, 3, false] }],
          ["bold", "italic", "code", "blockquote", "code-block"],
          [{ list: "ordered" }, { list: "bullet" }],
          ["link", "clean"],
        ],
      },
    });
    quillRef.current = quill;
    quill.root.innerHTML = markdownToEditorHtml(value, refToSrc);
    quill.on("text-change", () => {
      const next = editorHtmlToMarkdown(
        quill.getSemanticHTML(), srcToRef);
      if (next === internalRef.current) return;
      internalRef.current = next;
      onChangeRef.current(next);
    });
    return () => {
      quillRef.current = null;
      quill.off("text-change");
    };
    // 初始化只跑一次;后续值变更走下方回路。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变更:整体重排;内部键入不回灌。
  useEffect(() => {
    if (value === internalRef.current) return;
    internalRef.current = value;
    const quill = quillRef.current;
    if (quill) quill.root.innerHTML = markdownToEditorHtml(value, refToSrc);
  }, [value]);

  // 外部图片粘贴/拖拽转存(#276 随行)+ 登记附件随行(2026-09-19):
  // 剪贴板/拖入的文件按类型分路——位图走截图转存嵌入预览,其余文件
  // (日志/压缩包等)走附件上传插纯文本路径。没有附件回调的壳不接管
  // 非图片文件(交回浏览器默认行为)。
  useEffect(() => {
    const root = quillRef.current?.root;
    if (!root) return;
    const uploadAndInsert = async (file: File, index: number) => {
      try {
        const ref = await trackPending(() => uploadRef.current(file));
        quillRef.current?.insertEmbed(index, "image", issueImageUrl(ref));
      } catch {
        // 上传失败的用户提示归上传钩子所有(它自己 onError);这里只跳过。
      }
    };
    const uploadFiles = (files: File[]) => {
      const index = quillRef.current?.getSelection(true)?.index
        ?? quillRef.current?.getLength() ?? 0;
      void (async () => {
        for (const file of files) {
          if (file.type.startsWith("image/")) await uploadAndInsert(file, index);
          else await uploadAndInsertAttachment(file);
        }
      })();
    };
    const transferAndPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      const images: File[] = [];
      const others: File[] = [];
      for (const item of Array.from(data.items)) {
        const file = item.getAsFile();
        if (!file) continue;
        if (item.type.startsWith("image/")) images.push(file);
        else others.push(file);
      }
      if (images.length || (others.length && attachmentUploadRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        uploadFiles([...images, ...others]);
        return;
      }
      const html = data.getData("text/html") ?? "";
      if (!html) return;
      const doc = new DOMParser().parseFromString(html, "text/html");
      const pending = Array.from(doc.querySelectorAll("img"))
        .map((img) => ({ img, src: img.getAttribute("src") ?? "" }))
        .filter(({ src }) => !isHostedImageSrc(src));
      if (!pending.length) return;
      // 拦截必须在同步阶段:先按住默认粘贴,再异步逐张转存。
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        let failed = 0;
        for (const { img, src } of pending) {
          const kind = classifyExternalImageSrc(src);
          if (kind === "data") {
            let blob: Blob;
            try {
              blob = await (await fetch(src)).blob();
            } catch {
              img.remove();
              failed += 1;
              continue;
            }
            try {
              const ref = await trackPending(() =>
                uploadRef.current(pasteImageFile(blob)));
              img.setAttribute("src", issueImageUrl(ref));
            } catch {
              img.remove();
            }
          } else if (kind === "external") {
            try {
              const result = await trackPending(() => proxyIssueImage(src));
              img.setAttribute("src", issueImageUrl(result.path));
            } catch {
              img.remove();
              failed += 1;
            }
          } else {
            img.remove();
            failed += 1;
          }
        }
        quillRef.current?.clipboard.dangerouslyPasteHTML(doc.body.innerHTML);
        if (failed > 0) errorRef.current?.(transferFailHint(failed));
      })();
    };
    root.addEventListener("paste", transferAndPaste, true);
    const handleDrop = (event: DragEvent) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) return;
      if (!files.some((file) => file.type.startsWith("image/"))
        && !attachmentUploadRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      uploadFiles(files);
    };
    root.addEventListener("drop", handleDrop, true);
    return () => {
      root.removeEventListener("paste", transferAndPaste, true);
      root.removeEventListener("drop", handleDrop, true);
    };
  }, [trackPending, uploadAndInsertAttachment]);

  return <div className={cn(
    "relative [&_.ql-toolbar]:rounded-lg [&_.ql-toolbar]:border-line",
    // Quill 默认 .ql-container height:100%——容器占满父盒却排在工具栏
    // 之后,底缘溢出父盒 42px(一条工具栏高),把紧跟其后的兄弟内容
    // (描述页脚的复制按钮)盖在编辑器下面点不到;改随内容自适应。
    // Quill 规则未分层,Tailwind 工具类在 @layer 里压不过它,须 ! 提权。
    "[&_.ql-container]:h-auto! [&_.ql-container]:rounded-b-lg [&_.ql-container]:border [&_.ql-container]:border-line",
    "[&_.ql-editor]:min-h-[500px] [&_.ql-editor]:max-h-[70vh] [&_.ql-editor]:overflow-y-auto",
    "[&_.ql-editor]:text-base [&_.ql-editor]:leading-[1.65] [&_.ql-editor.ql-empty::before]:text-faint"
    // Tailwind preflight 清零了标题/段落自带外边距,Quill 不补——块间距在此定:
    // 没有它标题与段落全部贴死(#271 实测丑态)。
    + " [&_h1]:mt-3 [&_h1]:mb-2 [&_h2]:mt-2.5 [&_h2]:mb-1.5 [&_h3]:mt-2 [&_h3]:mb-1"
    + " [&_p]:my-1.5 [&_li]:my-0.5 [&_blockquote]:my-2 [&_pre]:my-2")}>
    <div ref={rootRef} />
    {onUploadAttachment && (
      <>
        {/* 登记附件入口:点选或直接把文件拖进编辑器。附件不做预览渲染
            (人是看不懂路径之外的内容的,它们是给 AI 读的分析材料)。 */}
        <button type="button"
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "mt-1 flex items-center gap-1.5 rounded-md border border-dashed"
            + " border-line px-2.5 py-1 text-xs text-muted-foreground",
            "transition-colors hover:border-foreground/30"
            + " hover:text-foreground")}>
          <Paperclip className="size-3.5" aria-hidden />添加附件(日志等)
        </button>
        <input ref={fileInputRef} type="file" multiple className="hidden"
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            for (const file of files) void uploadAndInsertAttachment(file);
          }} />
      </>
    )}
    {pendingUploads > 0 && <span role="status"
      className="absolute right-2 top-12 z-10 flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />文件上传中…
    </span>}
  </div>;
}
