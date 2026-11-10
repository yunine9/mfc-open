import { useCallback, useEffect, useRef, useState } from "react";
/**
 * 登记描述所见即所得编辑器(#184 票2):milkdown(ProseMirror 内核)
 * 的命令式封装——单面渲染,输入即所见,截图粘贴/拖拽后原地显示缩略。
 *
 * 边界(可整体替换的契约):对外只有三个口——markdown 值、onChange、
 * 图片上传钩子(上传后返回 issue-images/ 相对引用,插入光标位置)。
 * 存储世界(相对引用)与浏览器世界(预览 URL)的映射在 issueImageRef
 * 收敛:进入编辑器前 ref→URL,序列化出场时 URL→ref,description 管线
 * (AI 上下文/登记提交/staging 提取)永远只见相对引用。
 *
 * 待补充令牌(**【待补充】**)就是普通加粗,两侧渲染面都不做特殊化
 * (2026-09-15 拍板:原生 markdown 效果一致,预览侧染红退役)。
 */
import { Editor, editorViewCtx, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
import { Loader2 } from "lucide-react";
import { replaceAll } from "@milkdown/kit/utils";
import { commonmark } from "@milkdown/kit/preset/commonmark";
import { gfm } from "@milkdown/kit/preset/gfm";
import { history } from "@milkdown/kit/plugin/history";
import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
import { upload, uploadConfig } from "@milkdown/kit/plugin/upload";
import { DOMParser as ProseMirrorDOMParser } from "@milkdown/kit/prose/model";
import { issueImageUrl, proxyIssueImage } from "../api";
import { displayUrlToRef, refToDisplayUrl } from "./issueImageRef";
import { pasteImageFile, classifyExternalImageSrc, isHostedImageSrc,
  transferFailHint } from "./useIssueImagePaste";
import { cn } from "cn";

export function DescriptionEditor({
  value,
  onChange,
  onUploadImage,
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
  /** 仅编辑器初始化失败时上报(上传路径不走这里)。 */
  onError?: (message: string) => void;
  placeholderText?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Editor | null>(null);
  // 值回路防抖:onChange 出来的序列化文本记为"内部已知",父态回灌时
  // 只有真正外部变更(如草稿回读)才 replaceAll,键入不回灌不打断光标。
  const internalRef = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const uploadRef = useRef(onUploadImage);
  uploadRef.current = onUploadImage;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const [empty, setEmpty] = useState(!value.trim());
  // 灯箱(#184 拍板方案1):编辑区内图片限高成缩略,点击看原图。
  const [zoom, setZoom] = useState<string | null>(null);
  // 上传进行态:粘贴到缩略图原地出现之间有网络往返,无反馈会让人以为
  // 没粘上(2026-09-15 用户实测)。挂编辑器容器右上角浮层,比页脚静
  // 文案更显眼;上传插件通路与外链图转存(data: 本地上传、http(s)
  // 后端代理)共用同一计数,并发不互踩。
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
  const trackUpload = useCallback(
    (file: File) => trackPending(() => uploadRef.current(file)),
    [trackPending]);

  useEffect(() => {
    let disposed = false;
    const root = rootRef.current;
    if (!root) return;
    const editor = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, refToDisplayUrl(value, issueImageUrl));
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          const next = displayUrlToRef(markdown);
          internalRef.current = next;
          setEmpty(!next.trim());
          onChangeRef.current(next);
        });
        ctx.update(uploadConfig.key, (prev) => ({
          ...prev,
          uploader: async (files: FileList, schema: any) => {
            const nodes = [];
            for (const file of Array.from(files)) {
              try {
                const ref = await trackUpload(file);
                const node = schema.nodes.image?.createAndFill?.({
                  src: issueImageUrl(ref), alt: "截图",
                });
                if (node) nodes.push(node);
              } catch {
                // 上传失败的用户提示归上传钩子所有(它自己 onError);
                // 这里只跳过该图,不让单图失败中断整批插入。
              }
            }
            return nodes;
          },
        }));
      })
      .use(commonmark)
      .use(gfm)
      .use(history)
      .use(listener)
      .use(upload);
    void editor.create()
      .then(() => {
        if (disposed) {
          void editor.destroy();
          return;
        }
        editorRef.current = editor;
      })
      .catch((reason) => {
        errorRef.current?.(`编辑器初始化失败:${
          String(reason instanceof Error ? reason.message : reason)}`);
      });
    return () => {
      disposed = true;
      editorRef.current = null;
      void editor.destroy().catch(() => undefined);
    };
    // 初始化只跑一次:后续值变更走 replaceAll 回路,不重建编辑器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部值变更:整体重排;内部键入不回灌。
  useEffect(() => {
    if (value === internalRef.current) return;
    internalRef.current = value;
    setEmpty(!value.trim());
    const editor = editorRef.current;
    editor?.action(replaceAll(refToDisplayUrl(value, issueImageUrl)));
  }, [value]);

  // 外部图片粘贴转存(#276,与 useIssueImagePaste 同款判定):剪贴板
  // 无 image/* 文件、只有 text/html 时按 <img src> 协议分三路——
  // data: 的字节就在 src 里,客户端转 Blob 走同一条上传钩子(生产是
  // HTTP,异步 Clipboard API 兜底在非安全上下文不可用的死路已删);
  // http(s):// 外链前端拿不到字节(跨域带不上对方站的 Cookie),交
  // 后端 proxy-image 下载落 staging;file:/// 后端也访问不到用户本机,
  // 丢弃保文字计入失败。已托管的(issue-images/ 相对引用、本站预览
  // URL)不拦;混排的文字随改写后的 HTML 一并插入,不再因带字放行外链。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const intercept = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data) return;
      // 剪贴板带位图文件(截图软件/能拉到字节的网页图)归 upload 插件。
      for (const item of Array.from(data.items)) {
        if (item.type.startsWith("image/") && item.getAsFile()) return;
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
            // 字节已在 src 里,本地转 Blob 即可。取字节失败(如 data
            // URL 畸形)计入失败提示;上传失败由上传钩子自行上报,这里
            // 只丢该图(不代发第二遍)。
            let blob: Blob;
            try {
              blob = await (await fetch(src)).blob();
            } catch {
              img.remove();
              failed += 1;
              continue;
            }
            try {
              const ref = await trackUpload(pasteImageFile(blob));
              img.setAttribute("src", issueImageUrl(ref));
            } catch {
              img.remove();
            }
          } else if (kind === "external") {
            // 外链前端拿不到字节,后端代理下载;失败丢图计入失败提示。
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
        editorRef.current?.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const container = document.createElement("div");
          container.innerHTML = doc.body.innerHTML;
          const slice = ProseMirrorDOMParser.fromSchema(view.state.schema)
            .parseSlice(container);
          view.dispatch(
            view.state.tr.replaceSelection(slice).scrollIntoView());
        });
        if (failed > 0) errorRef.current?.(transferFailHint(failed));
      })();
    };
    // 捕获段拦截:抢在 ProseMirror 的原生 paste 处理之前拿住事件。
    root.addEventListener("paste", intercept, true);
    return () => root.removeEventListener("paste", intercept, true);
  }, [trackPending, trackUpload]);

  // #231 换装:.issue-desc-editor 家族(style.css)退役,壳/占位/灯箱与
  // ProseMirror 生成内容(节点由编辑器内部建树,类挂不上去)一律用
  // [&_*] 任意变体直译配方。
  // 空态给足约 500px 的写作高度(2026-09-15 拍板):结构化描述模板渲染
  // 出来约 17 行文本 + 块间距,写长后框高基本不变,视觉稳定;更长的
  // 内容长到 70vh 封顶,超出部分框内滚动,不再把整张表无限撑高。
  return <div className={cn(
    "relative [&_.ProseMirror]:min-h-[500px] [&_.ProseMirror]:max-h-[70vh] [&_.ProseMirror]:overflow-y-auto [&_.ProseMirror]:rounded-lg [&_.ProseMirror]:border [&_.ProseMirror]:border-line [&_.ProseMirror]:bg-(--surface-muted) [&_.ProseMirror]:px-2.5 [&_.ProseMirror]:py-2 [&_.ProseMirror]:text-base [&_.ProseMirror]:leading-[1.65] [&_.ProseMirror]:text-text-strong [&_.ProseMirror]:outline-none [overflow-wrap:anywhere] focus-within:[&_.ProseMirror]:border-(--accent)",
    "[&_p]:mb-2 [&_:last-child]:mb-0 [&_h1]:mb-2 [&_h2]:mb-2 [&_h3]:mb-2 [&_h1]:mt-2.5 [&_h2]:mt-2.5 [&_h3]:mt-2.5 [&_h1]:leading-snug [&_h2]:leading-snug [&_h3]:leading-snug",
    "[&_ul]:mb-2 [&_ol]:mb-2 [&_ul]:pl-6 [&_ol]:pl-6 [&_ul]:list-disc [&_ol]:list-decimal",
    "[&_img]:max-h-[200px] [&_img]:max-w-full [&_img]:h-auto [&_img]:w-auto [&_img]:cursor-zoom-in [&_img]:rounded-md [&_img]:border [&_img]:border-line",
    "[&_blockquote]:mb-2 [&_blockquote]:border-l-[3px] [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
    "[&_code]:rounded-sm [&_code]:bg-surface-3 [&_code]:font-mono [&_code]:text-[.88em]",
    "[&_pre]:mb-2 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-surface-2 [&_pre]:p-2.5 [&_pre]:text-[.86em] [&_pre]:leading-[1.6] [&_pre_code]:bg-transparent [&_pre_code]:p-0",
    "[&_table]:mb-2 [&_table]:border-collapse [&_th]:border [&_td]:border [&_th]:border-line [&_td]:border-line [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:text-left [&_td]:text-left",
    "[&_a]:text-primary")}>
    <div ref={rootRef}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.tagName === "IMG") {
          setZoom(target.getAttribute("src"));
        }
      }}>
    </div>
    {pendingUploads > 0 && <span role="status"
      className="absolute right-2 top-2 z-10 flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-muted-foreground shadow-sm">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />截图上传中…
    </span>}
    {empty && placeholderText
      && <span className="pointer-events-none absolute left-[11px] top-[9px] text-sm text-faint" aria-hidden="true">
        {placeholderText}
      </span>}
    {zoom && <div role="dialog" aria-label="截图原图" aria-modal="true"
      className="fixed inset-0 z-[80] flex cursor-zoom-out items-center justify-center bg-black/70 [&_img]:max-h-[92vh] [&_img]:max-w-[min(1200px,94vw)] [&_img]:rounded-lg [&_img]:bg-surface"
      onClick={() => setZoom(null)}>
      <img src={zoom} alt="截图原图" />
    </div>}
  </div>;
}
