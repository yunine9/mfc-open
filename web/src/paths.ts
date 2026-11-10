/**
 * 路径缩写。侧栏就那么宽,`notify-service/src/main/java/com/.../handler/
 * NotifyRenderer.java` 靠 CSS 省略号截,截掉的恰恰是文件名和行号——最有
 * 用的那截在末尾。所以从头砍,留末几段,完整路径挂 title。
 */

export function shortPath(path: string, keep = 2): string {
  const parts = String(path ?? "").split("/").filter(Boolean);
  if (parts.length <= keep) return path;
  return `…/${parts.slice(-keep).join("/")}`;
}
