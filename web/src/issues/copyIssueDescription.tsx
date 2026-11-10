/**
 * 登记描述「复制出去」:markdown(存储世界,issue-images/ 相对引用)
 * 写上剪贴板双格式——
 * - text/plain:markdown 原文(引用换成绝对 URL);
 * - text/html:渲染稿,结构与自有 <Markdown> 渲染器同一把尺
 *   (renderToStaticMarkup 复用),截图尽力内联 data URL。
 * 富文本目标(飞书/语雀/工单系统)拾取 HTML 直得排版与图;纯文本
 * 目标拾取原文。
 *
 * 截图必须内联而不能只给绝对 URL:登录 cookie 是 SameSite=Strict,
 * 别家页面发起的 <img> 请求带不上会话,外链图贴出去必裂;data URL
 * 让图随剪贴板走,目标编辑器把它当本地图收下(飞书/语雀会转存自家
 * 图床)。单图内联失败退回绝对 URL,不阻塞整次复制。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { issueImageUrl } from "../api";
import { Markdown } from "../markdown";

/** issue-images/ 相对引用 → 绝对预览 URL:纯文本世界没有「站内相对」
 * 语义,贴出去的引用必须自己站得住(至少人能点开看)。 */
function absolutizeImageRefs(markdown: string): string {
  return markdown.replace(
    /(!\[[^\]]*\]\()(issue-images\/[0-9a-f]{16}\.[a-z]+)(\))/gi,
    (_match, head: string, ref: string, tail: string) =>
      `${head}${new URL(issueImageUrl(ref), window.location.href)}${tail}`,
  );
}

/** 渲染稿 HTML:走与帮助中心同一个 <Markdown> 渲染器,不另
 * 养一份 markdown→HTML 翻译。目标编辑器自带的皮肤会盖掉渲染类名,
 * 保真的是结构(标题/列表/表格/粗体/图片)。 */
function renderedHtml(markdown: string): string {
  return renderToStaticMarkup(
    <Markdown
      text={absolutizeImageRefs(markdown)}
      resolveImage={(path) => /^https?:/i.test(path) ? path
        : new URL(issueImageUrl(path), window.location.href).toString()}
    />,
  );
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("截图读取失败"));
    reader.readAsDataURL(blob);
  });
}

/** 渲染稿里的本服务截图逐张内联 data URL。图刚在编辑器/预览里展示过
 * (cache-control max-age 一天),fetch 基本都命中本地缓存。 */
async function inlineImages(html: string): Promise<string> {
  const document = new DOMParser().parseFromString(html, "text/html");
  await Promise.all(Array.from(document.querySelectorAll("img[src]"),
    async (image) => {
      const url = new URL(image.getAttribute("src") ?? "", window.location.href);
      if (url.origin !== window.location.origin
        || url.pathname !== "/issues/issue-image") return;
      try {
        const response = await fetch(url);
        if (!response.ok) return;
        image.setAttribute("src", await blobToDataUrl(await response.blob()));
      } catch { /* 拉不到就保留绝对 URL,人不该为一张图丢掉整次复制。 */ }
    }));
  return document.body.innerHTML;
}

/** 降级路径(内网 http 下 async Clipboard 常不可用):把渲染稿选进
 * 离屏容器走 execCommand——浏览器会同时给出 text/html 与 text/plain
 * 两路格式,与手选复制等价。 */
function legacyCopy(html: string): boolean {
  const host = document.createElement("div");
  host.setAttribute("contenteditable", "true");
  host.style.position = "fixed";
  host.style.left = "-9999px";
  host.innerHTML = html;
  document.body.appendChild(host);
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(host);
  selection?.removeAllRanges();
  selection?.addRange(range);
  const copied = document.execCommand("copy");
  selection?.removeAllRanges();
  host.remove();
  return copied;
}

/** 复制问题描述(可抛错,由按钮呈状态):async Clipboard 写双格式,
 * 不可用/被拒退 execCommand 渲染稿,再退纯文本,全灭才向上抛。 */
export async function copyIssueDescription(markdown: string): Promise<void> {
  const plain = absolutizeImageRefs(markdown);
  const html = await inlineImages(renderedHtml(markdown));
  const clipboard = navigator.clipboard;
  if (clipboard?.write && typeof ClipboardItem === "function") {
    try {
      await clipboard.write([new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      })]);
      return;
    } catch { /* 权限或浏览器不支持双格式写,走降级。 */ }
  }
  if (legacyCopy(html)) return;
  if (clipboard?.writeText) {
    await clipboard.writeText(plain);
    return;
  }
  throw new Error("浏览器剪贴板不可用,请手动选中复制");
}
