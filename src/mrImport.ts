import { pipelineHeaders, type PipelineCredential } from "./pipelineClient.ts";
import { parseDeliveryMr, parseRepairMr, type DeliveryMr, type RepairMr } from "./mrImportTypes.ts";
export { normalizeRepairMrUrl, parseDeliveryMr, parseRepairMr, type DeliveryMr, type RepairMr } from "./mrImportTypes.ts";

type MrLookup = { platformUrl: string; url: string; credential?: PipelineCredential; signal?: AbortSignal; versionHead?: string };
async function getMrDetails(options: MrLookup): Promise<unknown> {
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  const query = new URLSearchParams({ mr_url: options.url });
  if (options.versionHead) query.set("version_head", options.versionHead);
  const response = await fetch(`${options.platformUrl.replace(/\/+$/, "")}/mr/detail?${query}`, {
    headers: pipelineHeaders(options.credential), signal,
  });
  if (!response.ok) throw new Error(response.status === 404
    ? "交付平台尚未支持 MR 详情查询，请联系管理员更新配置"
    : `读取 MR 详情失败（HTTP ${response.status}），请核对个人 Git 令牌与 MR 权限`);
  return response.json();
}

export async function readFinalDeliveryMr(options: MrLookup): Promise<DeliveryMr> {
  return parseDeliveryMr(await getMrDetails(options), options.url);
}

export async function readRepairMr(options: MrLookup): Promise<RepairMr> {
  return parseRepairMr(await getMrDetails(options), options.url);
}

/** 已经换过提交的旧 MR，也只能拿相同源版本的比较基线。 */
export async function readMrVersionBase(options: { platformUrl: string; url: string; head: string; credential?: PipelineCredential }): Promise<string | undefined> {
  const result = await readFinalDeliveryMr({ ...options, versionHead: options.head });
  return result.version?.head === options.head ? result.version.base : undefined;
}
