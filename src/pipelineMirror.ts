/**
 * 流水线红灯"可修性判定"的公共层(需求交付与问题流单一来源)。
 *
 * - mirrorPipelineArtifacts: 平台 /pipeline/artifacts 的失败产物全文
 *   镜像到会话工作区 pipeline/,AI 用 Bash 读全文而不是 1500 字摘要。
 *   原先需求侧(taskService 私有方法)与问题流(pipelineRepair 导出)
 *   各有一份拷贝,语义微差;这里合并为一份,以需求侧踩过坑的版本为准
 *   (临时文件原子落盘/只读位/路径穿越防线/"成功查询但零
 *   产物也必须清空上一轮")。
 * - isBlindPipelineInput: 盲输入判据——失败摘要抠掉链接后没有诊断
 *   内容 = 修复会话手里没有可信失败证据。内网实锤:适配层把 log 填成
 *   流水线页面链接(会话没有登录态,打不开),使命却把它包装成"失败
 *   详情(平台原文)"——会话以为自己有输入,硬着头皮定位→修改→提交,
 *   看着专业实为猜改。判据从需求侧修复使命组装的内联逻辑抽出,语义
 *   逐字保持。
 *
 * 与 pipelineContract/pipelineEvidence/pipelineClient 同一纪律:只放
 * 与 TaskService 无关的机械;执行层(修复会话/使命组装/派单通道)不
 * 在这条线上。
 */
import { renameSync, writeFileSync }
  from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { scopePipelineArtifacts, currentPipelineArtifactScope } from "./pipelineArtifactScope.ts";

/** 平台不给失败详情时需求侧写入 loop.failure 的占位文本(判据的一部分,
 * 语义锁定,别改字面)。 */
export const MISSING_FAILURE_PLACEHOLDER = "(平台未提供失败详情)";

/**
 * 盲输入判据:修复会话手里没有可信失败证据时为 true。
 *
 * - 有镜像产物就不算盲——产物全文比任何摘要都可信;
 * - 占位符"(平台未提供失败详情)"算盲;
 * - 其余按"抠链接后还剩多少诊断内容"判:剩下的比原文短(说明链接在
 *   替内容站岗)且剩不足 120 字 = 盲。判据不能只认裸链接:内网真实
 *   形态是"标签 + 链接"
 *   (`FAILED stage=CodeCheck2.0 job=CodeCheck2.0  detail: https://…`),
 *   只认裸链接的第一版正好漏掉了它要防的那个场景(2026-08-21 读进场
 *   报告逮住)。没有链接则不论长短都是平台给的真内容(如
 *   "BUILD FAILURE: 模块 x 编译失败"),不算无证据。
 */
export function isBlindPipelineInput(
  failure: string,
  hasArtifacts: boolean,
): boolean {
  if (hasArtifacts) return false;
  if (failure === MISSING_FAILURE_PLACEHOLDER) return true;
  const withoutLinks = failure.replace(/https?:\/\/\S+/g, "").trim();
  return withoutLinks.length < failure.trim().length
    && withoutLinks.length < 120;
}

/**
 * 拉取并镜像流水线失败产物(需求侧/问题流共用的单一实现):
 * - 端点是 MR-first:mr 参要完整 MR URL(status 主路用的 iid 在这里
 *   不被 artifacts 编排器消费,SSE 的 query_mr_info 直接消费 URL);
 * - 每次镜像先清空目录内容再落盘:上一轮的旧 SHA 日志若还躺着,修复
 *   会话会按错误现场继续改代码。**成功查询但本轮零产物也必须清空
 *   上一轮**;但绝不删除目录本身——它是运行中 Coding 容器的只读
 *   bind 源,替换根目录会让容器继续看到旧 inode;
 * - fail-open:404/坏响应/网络失败一律返回空清单，旧材料预先归档——镜像
 *   只是取证的增强,红灯主链路(账本+回合)不因它中断,调用方按返回
 *   清单决定给 AI 的指引文案(照常走摘要通道);
 * - 落盘走临时文件原子改名、只读位(0o444)，保留服务返回的全文;文件
 *   名只留基名,别让平台字段写出目录外。
 */
export async function mirrorPipelineArtifacts(input: {
  platformUrl: string;
  sha: string;
  /** 仓地址(明文,这里统一 percent 编码)。 */
  repo: string;
  /** 完整 MR URL(不是仅供 status 用的 MR iid)。 */
  mrUrl?: string;
  /** 会话工作区下的落点目录(不存在则创建)。 */
  dir: string;
  /** 平台身份头(与 pipelineClient 同源凭据通道)。 */
  headers?: Record<string, string>;
  /** 非 404 失败(网络断/5xx/坏响应)的人话告警口:fail-open 返回空,
   *  但调用方的日志要能看见"为什么没产物"。 */
  log?: (message: string, retryable?: boolean) => void;
  timeoutMs?: number;
  current?: () => boolean;
}): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 120_000);
  let readingRemote = false;
  try {
    if (input.current && !input.current()) return [];
    const generation = scopePipelineArtifacts(input.dir, input.sha, true);
    const repo = encodeURIComponent(input.repo);
    readingRemote = true;
    const response = await fetch(
      `${input.platformUrl}/pipeline/artifacts?sha=${input.sha}`
      + `&repo=${repo}`
      + (input.mrUrl
        ? `&mr=${encodeURIComponent(input.mrUrl)}` : ""),
      { headers: input.headers, signal: controller.signal });
    if (response.status === 404) return [];
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 408 || response.status === 429;
      input.log?.(`流水线产物镜像失败(HTTP ${response.status}),走摘要通道`, retryable);
      return [];
    }
    let body: { files?: unknown; sha?: string };
    try {
      body = await response.json() as { files?: unknown; sha?: string };
    } catch (error) {
      input.log?.(`流水线产物镜像失败(响应非 JSON),走摘要通道: ${
        String(error)}`, !(error instanceof SyntaxError));
      return [];
    }
    readingRemote = false;
    const files = (Array.isArray(body.files) ? body.files : [])
      .filter((file: any) => typeof file?.name === "string"
        && typeof file?.text === "string");
    if ((body.sha && body.sha !== input.sha) || (input.current && !input.current())
        || !currentPipelineArtifactScope(input.dir, generation)) return [];
    // 成功查询但本轮没有材料,也必须把上一轮清空;否则修复会话会
    // 在稳定挂载里读到旧 SHA 的日志,按错误现场继续改代码。
    if (!files.length) return [];
    const written: string[] = [];
    for (const file of files) {
      // 路径穿越防线:文件名只留基名,别让平台字段写出目录外。
      const name = basename(String(file.name));
      if (!name || name === "." || name === ".." || name === ".pipeline-context.json") continue;
      const target = join(input.dir, name);
      const temporary = join(
        input.dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporary, file.text, {
        mode: 0o444,
        flag: "wx",
      });
      renameSync(temporary, target);
      written.push(name);
    }
    return written;
  } catch (error) {
    // 网络失败/坏 JSON/落盘异常都不抛:镜像缺席时红灯主链路照走,
    // 但要在调用方日志里留一句"为什么没产物"。
    input.log?.(`流水线产物镜像失败(网络/落盘异常),走摘要通道: ${
      String(error)}`, readingRemote);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
