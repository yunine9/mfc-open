/**
 * DTS 单内嵌截图落工作区(#42):dts_get_ticket 的下载与改写旁路。
 *
 * 单据描述 HTML 里的 <img>(DTS NFS 站内路径)经网关 proxyFile 回取
 * 二进制,落 `<工作区>/ticket-images/<单号>/<sha256 前 16 位>.<扩展名>`,
 * 返回给 AI 的文本里这些 URL 改写为工作区相对路径——AI 随后可对本地
 * 路径调 inspect_image 识图。图片本体绝不进主模型上下文,进上下文的
 * 只有描述文本与相对路径(上下文纪律,#42 红线)。
 *
 * fail-open:单图失败/超时/超 20MB 只标注缺失,不堵详情返回;同一 URL
 * 失败后落标记文件(ticket-images/<单号>/failed.json),本会话不再重试
 * ——比内存 Set 多活一层:进程重启、回合重建工具上下文后依然不轰炸。
 *
 * 去重两层:文件名用内容哈希(不同 URL 同内容只有一份文件);URL →
 * 文件的映射记在 index.json,重复调用 dts_get_ticket 命中索引直接复用,
 * 网关零回取(哈希命中不重复下载)。
 *
 * HTML 是字符串,不用 DOM:img src 的解析/改写与前端
 * web/src/issues/dtsHtml.ts 的 resolveDtsImages 同口径(双引号属性、
 * 绝对地址与 / 开头站内路径两支),后端自写一份纯函数。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { DTS_FILE_ORIGIN, type DtsGateway } from "./gateways.ts";

/** 单张上限,与 inspect_image 的源图上限一致(#42 红线)。 */
export const TICKET_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** 每张单据单轮新下载的内嵌图上限(超出标注截断,不静默丢弃)。 */
export const TICKET_IMAGE_MAX_COUNT = 12;
/** 单张下载预算(#42 红线:凡引入等待必须带预算)。 */
export const TICKET_IMAGE_TIMEOUT_MS = 30_000;

/** 从描述 HTML 提取 <img src>(按出现序)。与前端重写先例同口径:
 * 只认双引号属性——DTS 导出的描述 HTML 的 src 恒为双引号(实测),
 * 单引号变形留给真实网关对拍后再说。 */
export function extractDtsImageSrcs(html: string | undefined): string[] {
  if (!html) return [];
  const srcs: string[] = [];
  const pattern = /<img\s[^>]*?src="([^"]*)"/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    srcs.push(match[1]);
  }
  return srcs;
}

/** src → 站内绝对路径(与 /issues/dts-file 代理同口径:/ 开头)。
 * 只放行两类:站内绝对路径,与 DTS 文件域的绝对地址(真实网关的
 * detail 会把 /v1/nfs/... 补全成绝对地址再返回,这里剥回路径)。外链/
 * 相对路径一律拒绝并给原因——reason 会原样标注给 AI,不让它误以为
 * 本地有图。 */
export function normalizeDtsImagePath(
  src: string,
): { path: string } | { reason: string } {
  const value = src.trim();
  if (!value) return { reason: "空 src" };
  if (/^(https?:)?\/\//i.test(value)) {
    // 绝对地址:仅 DTS 文件域放行(剥回站内路径),其余是外链。
    const dtsHost = new URL(DTS_FILE_ORIGIN).host.toLowerCase();
    const match = /^https?:\/\/([^/"]*)(\/[^"]*)?$/i.exec(value);
    if (!match || match[1].toLowerCase() !== dtsHost || !match[2]) {
      return { reason: `外链(非 DTS 文件域 ${dtsHost}),不经平台下载` };
    }
    return insideStation(match[2]);
  }
  if (value.startsWith("/")) return insideStation(value);
  return { reason: "相对路径,不是站内绝对路径" };
}

/** 站内路径的最终校验:NUL 与 .. 段(路径穿越)拒之门外。查询/锚点
 * 原样保留在路径键里——改写按整串精确匹配,带查询的 URL 也是独立键。 */
function insideStation(path: string): { path: string } | { reason: string } {
  if (path.includes("\0")) return { reason: "路径含空字节" };
  if (path.split("/").some((segment) => segment === "..")) {
    return { reason: "路径含 .. 穿越,已拒绝" };
  }
  return { path };
}

/** 图片扩展名:先认魔数(与 inspect_image 同款判定——识图只认内容,
 * 不认名字),content-type 兜底,实在认不出给 img(不影响落盘)。 */
function imageExtension(data: Buffer, contentType: string): string {
  const at = (...values: number[]) => values.every((value, index) =>
    data[index] === value);
  if (at(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0xff, 0xd8, 0xff)) return "jpg";
  if (at(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0x42, 0x4d)) return "bmp";
  if (at(0x52, 0x49, 0x46, 0x46)
      && data[8] === 0x57 && data[9] === 0x45
      && data[10] === 0x42 && data[11] === 0x50) {
    return "webp";
  }
  const byType: Record<string, string> = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "image/webp": "webp", "image/bmp": "bmp",
  };
  return byType[contentType.split(";")[0].trim().toLowerCase()] ?? "img";
}

/** 给回取套 30s 预算:proxyFile 内部没有信号可传(Pi 网关的 fetch 无
 * abort 位),这里 race 掉——到点放弃该图并标注,不让一张图拖死详情。 */
function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`超时(${TICKET_IMAGE_TIMEOUT_MS / 1000}s)`)),
      TICKET_IMAGE_TIMEOUT_MS,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface TicketImageDownload {
  /** 站内路径(改写文本时的精确匹配键)。 */
  url: string;
  /** 工作区相对路径(改写产物,进 AI 上下文)。 */
  relativePath: string;
  bytes: number;
  /** true=index 命中复用,本轮没有碰网关(重复调用不重复下载)。 */
  reused: boolean;
}

export interface TicketImageProblem {
  /** 非法 URL 场景是原始 src;失败/截断场景是站内路径(改写键)。 */
  url: string;
  reason: string;
}

export interface TicketImageOutcome {
  downloads: TicketImageDownload[];
  /** 下载失败(含超时/超 20MB/此前失败不再重试)。 */
  failures: TicketImageProblem[];
  /** 非法 URL(外链/相对路径/穿越),从未发起下载。 */
  rejected: TicketImageProblem[];
  /** 超出单轮张数上限被截断的。 */
  truncated: TicketImageProblem[];
}

interface IndexFile {
  schema: "ticket-image-index/1";
  files: Record<string, string>;
}

interface FailuresFile {
  schema: "ticket-image-failures/1";
  failed: Record<string, { reason: string; at: string }>;
}

const INDEX_SCHEMA: IndexFile["schema"] = "ticket-image-index/1";
const FAILURES_SCHEMA: FailuresFile["schema"] = "ticket-image-failures/1";

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    // 不在场/损坏都按"没有账"起头:索引只是缓存,丢了顶多重下一次。
    return undefined;
  }
}

/** 单张单据的内嵌图同步:下载落盘 + 产出改写所需的全部事实。整体性
 * 故障(如磁盘不可写)由调用方(dts_get_ticket)兜成一条标注,这里
 * 只对"单图"fail-open。 */
export async function syncTicketImages(input: {
  description: string;
  ticket: string;
  /** 会话工作区根(= inspect_image 的路径基准,live.root)。 */
  workspace: string;
  gateway: DtsGateway;
  log?: (message: string) => void;
}): Promise<TicketImageOutcome> {
  const outcome: TicketImageOutcome = {
    downloads: [], failures: [], rejected: [], truncated: [],
  };
  // 单号要进目录名:带分隔符/穿越段直接整体放弃(工具层会标注),
  // 不给路径穿越留口子。
  if (!input.ticket || /[\\/]|\.\./.test(input.ticket)) {
    outcome.rejected.push({ url: input.ticket, reason: "单号不能用作目录名" });
    return outcome;
  }
  // 归一 + 去重:同一张图的绝对地址与站内路径形态归并为一个下载键,
  // 按首次出现序处理;非法 src 按 src 本身去重(标注不重复刷屏)。
  const paths: string[] = [];
  const seenPath = new Set<string>();
  const seenSrc = new Set<string>();
  for (const src of extractDtsImageSrcs(input.description)) {
    const normalized = normalizeDtsImagePath(src);
    if ("path" in normalized) {
      if (!seenPath.has(normalized.path)) {
        seenPath.add(normalized.path);
        paths.push(normalized.path);
      }
    } else if (!seenSrc.has(src)) {
      seenSrc.add(src);
      outcome.rejected.push({ url: src, reason: normalized.reason });
    }
  }
  if (!paths.length) return outcome;

  const workspaceRoot = resolve(input.workspace);
  const ticketDir = resolve(join(workspaceRoot, "ticket-images", input.ticket));
  if (!ticketDir.startsWith(workspaceRoot + sep)) {
    outcome.rejected.push({ url: input.ticket, reason: "落盘目录越出工作区" });
    return outcome;
  }
  const indexPath = join(ticketDir, "index.json");
  const failuresPath = join(ticketDir, "failed.json");
  const indexRaw = readJson<IndexFile>(indexPath);
  const index: IndexFile = indexRaw?.schema === INDEX_SCHEMA && indexRaw.files
    ? indexRaw : { schema: INDEX_SCHEMA, files: {} };
  const failuresRaw = readJson<FailuresFile>(failuresPath);
  const failures: FailuresFile = failuresRaw?.schema === FAILURES_SCHEMA
      && failuresRaw.failed
    ? failuresRaw : { schema: FAILURES_SCHEMA, failed: {} };
  let indexDirty = false;
  let failuresDirty = false;

  const relFor = (filename: string) =>
    relative(workspaceRoot, join(ticketDir, filename)).split(sep).join("/");

  // 张数上限只数本轮真正动网关的新下载;index 命中复用与已知失败的
  // 复述都零成本,不占名额——第二次调用同一张单,已处理的图不会被误标。
  let freshDownloads = 0;
  for (const path of paths) {
    const indexed = index.files[path];
    if (indexed && existsSync(join(ticketDir, indexed))) {
      outcome.downloads.push({
        url: path, relativePath: relFor(indexed),
        bytes: statSync(join(ticketDir, indexed)).size, reused: true,
      });
      continue;
    }
    const earlier = failures.failed[path];
    if (earlier) {
      outcome.failures.push({
        url: path,
        reason: `${earlier.reason}(此前已失败,本会话不再重试)`,
      });
      continue;
    }
    if (freshDownloads >= TICKET_IMAGE_MAX_COUNT) {
      outcome.truncated.push({
        url: path,
        reason: `超出单轮新下载 ${TICKET_IMAGE_MAX_COUNT} 张上限`,
      });
      continue;
    }
    try {
      freshDownloads += 1;
      const file = await withTimeout(
        input.gateway.proxyFile(path), `下载 ${path}`);
      if (file.data.length > TICKET_IMAGE_MAX_BYTES) {
        throw new Error(
          `图片 ${Math.round(file.data.length / 1024 / 1024)}MB,超过单张 `
          + `${Math.round(TICKET_IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限`);
      }
      const digest = createHash("sha256").update(file.data).digest("hex");
      const filename = `${digest.slice(0, 16)}.`
        + imageExtension(file.data, file.contentType);
      mkdirSync(ticketDir, { recursive: true });
      const target = join(ticketDir, filename);
      // 同内容不同 URL 只有一份文件:哈希同名时补一次索引就够。
      if (!existsSync(target)) writeFileSync(target, file.data);
      index.files[path] = filename;
      indexDirty = true;
      outcome.downloads.push({
        url: path, relativePath: relFor(filename),
        bytes: file.data.length, reused: false,
      });
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      failures.failed[path] = { reason, at: new Date().toISOString() };
      failuresDirty = true;
      outcome.failures.push({ url: path, reason });
    }
  }
  if (indexDirty) {
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(index, null, 2));
  }
  if (failuresDirty) {
    mkdirSync(ticketDir, { recursive: true });
    writeFileSync(failuresPath, JSON.stringify(failures, null, 2));
  }
  input.log?.(`[ticket-images] ${input.ticket}:新下 ${freshDownloads},`
    + `复用 ${outcome.downloads.length - freshDownloads}`
    + `,失败 ${outcome.failures.length}`
    + `,截断 ${outcome.truncated.length}`
    + `,拒绝 ${outcome.rejected.length}`);
  return outcome;
}

/** 把下载成功的图 URL 在 AI 可见文本里改写为工作区相对路径。两种形态
 * 都要接住:站内路径,与"DTS 文件域 + 路径"的绝对地址(长键先换,绝
 * 对形态整串消失,不给 AI 留半截拼错的地址);失败/截断的 URL 原样保留
 * (缺失由 renderTicketImageNote 标注)。 */
export function applyTicketImageRewrites(
  text: string,
  downloads: TicketImageDownload[],
): string {
  let rewritten = text;
  const keys = downloads.flatMap((download) => {
    const bare = { key: download.url, to: download.relativePath };
    return download.url.startsWith("/")
      ? [bare, { key: `${DTS_FILE_ORIGIN}${download.url}`, to: download.relativePath }]
      : [bare];
  });
  for (const { key, to } of keys.sort((a, b) => b.key.length - a.key.length)) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    rewritten = rewritten.replace(
      new RegExp(escaped + "(?![A-Za-z0-9._/%~-])", "g"),
      to,
    );
  }
  return rewritten;
}

/** 内嵌图处理结果 → 给 AI 的人话清单(拼在单据详情之后)。描述无图时
 * 返回空串,回执零噪音。 */
export function renderTicketImageNote(outcome: TicketImageOutcome): string {
  const total = outcome.downloads.length + outcome.failures.length
    + outcome.truncated.length + outcome.rejected.length;
  if (!total) return "";
  const reused = outcome.downloads.filter((item) => item.reused).length;
  const lines = [`[内嵌图] 描述含 ${total} 张图片:落工作区 `
    + `${outcome.downloads.length} 张`
    + (reused ? `(本轮新下 ${outcome.downloads.length - reused},`
      + `本地已有 ${reused})` : "")
    + (outcome.failures.length ? `,失败 ${outcome.failures.length} 张` : "")
    + (outcome.truncated.length ? `,截断 ${outcome.truncated.length} 张` : "")
    + (outcome.rejected.length ? `,拒绝 ${outcome.rejected.length} 张` : "") + "。"];
  for (const download of outcome.downloads) {
    lines.push(`- ${download.relativePath}(原 ${download.url})`
      + "——已在工作区,可对它调 inspect_image 识图");
  }
  for (const failure of outcome.failures) {
    lines.push(`- ${failure.url}:未能下载到工作区(${failure.reason})`
      + "——本地没有此图,勿对它调 inspect_image");
  }
  for (const cut of outcome.truncated) {
    lines.push(`- ${cut.url}:${cut.reason},未下载——本地没有此图`);
  }
  for (const rejection of outcome.rejected) {
    lines.push(`- ${rejection.url}:${rejection.reason}——本地没有此图`);
  }
  return lines.join("\n");
}
