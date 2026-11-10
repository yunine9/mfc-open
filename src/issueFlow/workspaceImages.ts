/**
 * 会话工作区图片回显(#376):分析报告 markdown 里嵌入的截图引用
 * (`ticket-images/<单号>/<哈希16>.<扩展名>` 工单截图、
 * `issue-images/<哈希16>.<扩展名>` 登记截图)经此从会话工作区读盘
 * 返给浏览器。拉单时工单截图已落工作区(ticketImages.ts),过程记录
 * 永不回收——清扫器点名的回收目录(repo/local-logs 等)不含
 * ticket-images,图一直在盘上——读落盘件而不是回 DTS 实时取,
 * 单据关闭/图过期/网关不可达时报告照样完整。
 *
 * 形状白名单即边界(与 analysisVersions 的版本名白名单同纪律):
 * 只认上面两种引用形态,穿越段/多段/非法形状一律打回——工作区里的
 * 台账、报告、仓文件不可经这张接口读出。落盘路径再套一次 resolve
 * 包围校验,双保险。
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { EXT_TO_MIME } from "./issueImages.ts";

/** 两种引用形态的共用文件名段:<哈希16>.<扩展名>(与落盘命名同款)。
 * 扩展名锁 EXT_TO_MIME 的键集——落盘命名出自 imageExtension,只会是
 * 这几种;锁表后 .html/.svg 之类非图扩展不再形状合法。新增图片格式
 * 时扩展名判定(imageExtension)与本表一起改。 */
const FILE_SEGMENT = `([0-9a-f]{16})\\.(${
  Object.keys(EXT_TO_MIME).join("|")})`;

/** 校验前端回传的 path 形态。合法返回工作区相对路径原文(键与落盘
 * 相对路径同串);非法/缺席返回 undefined。单号段带 `..` 或空字节
 * (穿越形态)一并拒——与 ticketImages 落盘时的单号校验同尺。 */
export function parseWorkspaceImagePath(
  path: string,
): string | undefined {
  const forms = [
    new RegExp(`^ticket-images/([^/]+)/(?:${FILE_SEGMENT})$`, "i"),
    new RegExp(`^issue-images/(?:${FILE_SEGMENT})$`, "i"),
  ];
  for (const form of forms) {
    const match = form.exec(path);
    if (!match) continue;
    if (match[1]?.includes("..") || match[1]?.includes("\0")) return undefined;
    return path;
  }
  return undefined;
}

/** 读工作区图片(回显用):形状合法且文件在场返回二进制与 MIME,
 * 否则 undefined(形状非法与文件缺失同一个出码,不泄露盘面事实)。 */
export function readWorkspaceImage(input: {
  root: string;
  path: string;
}): { data: Buffer; mime_type: string } | undefined {
  const relative = parseWorkspaceImagePath(input.path);
  if (!relative) return undefined;
  const root = resolve(input.root);
  const file = resolve(join(root, relative));
  if (!file.startsWith(root + sep)) return undefined;
  if (!existsSync(file)) return undefined;
  const ext = relative.split(".").pop()?.toLowerCase() ?? "";
  return {
    data: readFileSync(file),
    mime_type: EXT_TO_MIME[ext] ?? "application/octet-stream",
  };
}
