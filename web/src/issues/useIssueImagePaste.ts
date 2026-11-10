/**
 * 会话侧截图粘贴(2026-09-10 验证闸配套,与登记页同款红线):粘贴图片
 * → 上传落 staging(POST /issues/issue-image,content-addressed)→ 在
 * 光标处插入 ![截图](issue-images/<hash>.<ext>) 引用。图片本体不进
 * 消息文本,进的只有工作区相对路径——服务端在消息入口把引用从 staging
 * 提升到会话工作区,AI 侧 inspect_image 按该路径识图。
 *
 * 剪贴板两类来源待遇不同(#276):截图软件放真实位图,paste 事件里有
 * image/* 文件,直走上传;网页/WeLink 复制的只有 text/html 里的
 * <img src>,按 src 协议分三路转存——data: 的字节就在 src 里,本地转
 * Blob 走同一条上传;http(s):// 外链前端拿不到字节(跨域带不上对方
 * 站的 Cookie),交后端 proxy-image 下载落 staging;file:/// 后端也
 * 访问不到用户本机,丢弃保文字。生产是 HTTP,异步 Clipboard API 在
 * 非安全上下文不可用,旧的「Clipboard 兜底取回位图」是死路,已删。
 */

import { useCallback, useState } from "react";
import { proxyIssueImage, uploadIssueImage } from "../api";

/** 在 textarea 光标处插入 markdown(无 ref 时追加到末尾),返回
 * 下一段文本与光标落点——受控组件拿 next 设值,ref 存在时再摆焦点。 */
export function insertMarkdownAtCursor(
  textarea: HTMLTextAreaElement | null,
  fallback: string,
  markdown: string,
): { next: string; caret: number } {
  // 转存期间用户可能继续键入:textarea 活值优先,不信任调用方渲染期
  // 闭包传入的 fallback(#276),转存完成的插入不覆盖新键入。
  const current = textarea?.value ?? fallback;
  const start = textarea?.selectionStart ?? current.length;
  const end = textarea?.selectionEnd ?? current.length;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const needPrefix = before.length > 0 && !before.endsWith("\n");
  const needSuffix = after.length > 0 && !after.startsWith("\n");
  const insert = `${needPrefix ? "\n" : ""}${markdown}${needSuffix ? "\n" : ""}`;
  return { next: before + insert + after, caret: (before + insert).length };
}

/** 已托管引用不拦:issue-images/ 相对引用与本站预览 URL。从本站复制
 * 出去的 HTML 里 src 会被浏览器序列化成绝对 URL,预览形态用 includes 认。 */
export function isHostedImageSrc(src: string): boolean {
  return src === ""
    || src.startsWith("issue-images/")
    || src.includes("/issues/issue-image?path=issue-images/");
}

/** 外部 <img src> 三路分类(#276):data: 的字节就在 src 里,本地转
 * Blob 直传;http(s) 外链前端拿不到字节,后端代理下载;其余(file:///
 * 等)后端也够不着用户本机,丢弃保文字。登记编辑器与会话粘贴钩子
 * 共用这一份判定,防两份拷贝漂移。 */
export function classifyExternalImageSrc(
  src: string,
): "data" | "external" | "local" {
  if (/^data:image\//i.test(src)) return "data";
  if (/^https?:\/\//i.test(src)) return "external";
  return "local";
}

/** 转存失败的统一指路(登记编辑器与会话粘贴钩子共用一句)。 */
export function transferFailHint(count: number): string {
  return `${count} 张图转存失败(可能需认证或本地文件),请截图后粘贴`;
}

/** data: URL 转出的 Blob 包成 File(上传钩子的入参形):扩展名取自
 * MIME 子类型,认不出落 png(与粘贴位图命名同款)。 */
export function pasteImageFile(blob: Blob): File {
  const subtype = blob.type.split("/")[1] ?? "";
  const ext = /^[a-z0-9]+$/i.test(subtype) ? subtype : "png";
  return new File([blob], `paste.${ext}`, { type: blob.type || "image/png" });
}

/** 截图粘贴钩子:onPaste 挂到 textarea;命中图片即上传并把 markdown
 * 交给调用方的 insert(受控文本由调用方持有)。uploading 供占位提示。 */
export function useIssueImagePaste(onError?: (message: string) => void) {
  const [uploading, setUploading] = useState(false);

  const onPaste = useCallback((
    event: { clipboardData?: { items?: Iterable<{ type: string; getAsFile(): File | null }>; getData?(type: string): string } ; preventDefault(): void },
    insert: (markdown: string) => void,
  ) => {
    const upload = (file: File) => {
      setUploading(true);
      uploadIssueImage(file).then((result) => {
        insert(`![截图](${result.path})`);
      }).catch((reason) => {
        onError?.(`图片上传失败:${String(reason instanceof Error ? reason.message : reason)}`);
      }).finally(() => setUploading(false));
    };

    const items = event.clipboardData?.items;
    if (items) {
      for (const item of items) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (!file) continue;
        event.preventDefault();
        upload(file);
        return;
      }
    }

    // 网页/WeLink 复制的 text/html:剪贴板没有位图文件,按 <img src>
    // 协议三路转存(#276)。成功引用合并一次插入,少与用户继续键入交错。
    const html = event.clipboardData?.getData?.("text/html") ?? "";
    if (!html) return;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pending = Array.from(doc.querySelectorAll("img"))
      .map((img) => img.getAttribute("src") ?? "")
      .filter((src) => !isHostedImageSrc(src));
    if (!pending.length) return;
    event.preventDefault();

    void (async () => {
      setUploading(true);
      const refs: string[] = [];
      let failed = 0;
      for (const src of pending) {
        const kind = classifyExternalImageSrc(src);
        if (kind === "data") {
          // data URL 畸形等本地取字节失败:与外链转存失败同账,计入
          // 失败提示(还没到上传,报错不归上传通道)。
          let blob: Blob;
          try {
            blob = await (await fetch(src)).blob();
          } catch {
            failed += 1;
            continue;
          }
          try {
            const result = await uploadIssueImage(pasteImageFile(blob));
            refs.push(`![截图](${result.path})`);
          } catch (reason) {
            onError?.(`图片上传失败:${
              String(reason instanceof Error ? reason.message : reason)}`);
          }
        } else if (kind === "external") {
          // 外链前端拿不到字节,交后端代理下载;失败计入失败提示。
          try {
            const result = await proxyIssueImage(src);
            refs.push(`![截图](${result.path})`);
          } catch {
            failed += 1;
          }
        } else {
          failed += 1;
        }
      }
      if (refs.length > 0) insert(refs.join("\n"));
      if (failed > 0) onError?.(transferFailHint(failed));
      setUploading(false);
    })();
  }, [onError]);

  return { uploading, onPaste };
}
