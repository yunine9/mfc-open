/**
 * 报告嵌图引用的两个世界(#376/#381,与 issueImageRef 同风格):
 * - 存储/AI 世界:报告 markdown 里的工作区相对引用
 *   (`ticket-images/<单号>/<哈希16>.<扩展名>` 工单截图、
 *   `issue-images/<哈希16>.<扩展名>` 登记截图);
 * - 浏览器世界:`/issues/:id/workspace-image?path=…` 回显 URL
 *   (<img> 只有它才显示得出来)。
 * Markdown 渲染的 resolveImage 回调经这里换算;白名单外(代码路径、
 * 附件、任意文本)返回 undefined,渲染器原样显文本。形状与后端
 * parseWorkspaceImagePath 同尺——单号段的 .. 与空字节、扩展名锁
 * 图类键集,两边谁也放不进对方拒的。
 */

// 文件名段与后端 workspaceImages.ts 的 FILE_SEGMENT 镜像:扩展名锁
// 服务端落盘命名(imageExtension)会产出的图类键集,.html/.svg 等
// 非图扩展两边都拒;前端不 import 后端模块,小常量各持一份(#230
// ANALYSIS_DOC 同款镜像纪律)。
const IMAGE_FILE = `[0-9a-f]{16}\\.(?:png|jpg|gif|bmp|webp|img)`;
const TICKET_FORM = new RegExp(`^ticket-images/([^/]+)/${IMAGE_FILE}$`, "i");
const REGISTRATION_FORM = new RegExp(`^issue-images/${IMAGE_FILE}$`, "i");

/** 报告嵌图引用 → 会话图片回显 URL;白名单外返回 undefined。 */
export function resolveWorkspaceImage(
  sessionId: string,
  ref: string,
): string | undefined {
  const value = ref.trim();
  const ticket = TICKET_FORM.exec(value);
  if (ticket) {
    if (ticket[1]?.includes("..") || ticket[1]?.includes("\0")) {
      return undefined;
    }
  } else if (!REGISTRATION_FORM.test(value)) {
    return undefined;
  }
  return `/issues/${encodeURIComponent(sessionId)}/workspace-image`
    + `?path=${encodeURIComponent(value)}`;
}
