/**
 * 模型网关解析的单一咽喉(ADR-0039 建,ADR-0068 增个人通道)。
 *
 * 「管理页 settings 覆盖压部署参数(--models/--provider/--model)」这条
 * 合并链原本内联在 taskService/issueFlow 的每个会话启动点,共约九处,
 * 各写各的;任何新通道若没有唯一合并点,就会散弹式漏站——主会话换了
 * 网关、摘要还走老网关之类。所有"本次会话用哪套 models.json +
 * provider/model"的问题都从 resolveModelConfig 进。
 *
 * 个人通道(ADR-0068):成员在个人设置自配的模型接入,由调用点按
 * 会话归属人(operator)从账号库现取现传。配齐即整体换装——该成员
 * 名下任务的全部主模型调用走它;任务级 model_choice 的让位由调用点
 * 执行(它不在解析器手里);视觉角色绑定不参与换装——vision 恒走
 * 平台网关的绑定,校验口径归调用方的 activeVisionChoice/
 * visionCapability(平台 json),解析器只负责把平台 vision 的 provider
 * 条目并进个人现场 json,保证个人通道会话照样能解析出视觉模型。
 *
 * fail-open 口径(承 ADR-0039 的 Beta 先例):个人网关配置残缺(解析
 * 不出可用的 provider+model)视同未配,静默按平台网关走,只出一行
 * 日志;运行期的网关故障不中途换道,靠下次会话启动的现算自愈。
 */

import { jsonProviders, type ModelsSettings } from "./settings.ts";

/** 设置侧最小接口:RuntimeSettings 与各服务的 options.settings 子集
 *  类型都满足它,解析器不认完整类。 */
export interface ModelSettingsSource {
  models(): ModelsSettings;
}

/** 本会话应用的网关通道:任务记录 model_lane 标记认它。历史任务还有
 *  "beta"(Beta 网关,ADR-0068 退役)——那是事实账,读取侧照常兼容,
 *  解析器不再产出。 */
export type ModelLane = "platform" | "personal";

export interface ResolvedModelConfig {
  lane: ModelLane;
  /** 现场 models.json 的内容(pi models.json 同形,含 apiKey);
   * 落盘纪律(0600/明文+掩码)归调用点。 */
  json: Record<string, unknown>;
  provider?: string;
  model?: string;
}

export interface DeploymentModels {
  modelsJson?: Record<string, unknown>;
  provider?: string;
  model?: string;
  /** 部署层视觉角色(settings 未配 vision 时的兜底),只用于个人通道
   *  现场 json 的 vision provider 合并,不参与主模型选择。 */
  vision?: { provider: string; model: string };
}

/** settings 逐字段压部署参数;归属人配了可用的个人网关时整体换装
 *  (ADR-0068)。operator=会话归属人(任务=发起人,问题=责任人),
 *  缺席=平台口径——无归属的调用(视觉校验/后台研究)不传个人配置。 */
export function resolveModelConfig(input: {
  settings?: ModelSettingsSource;
  deployment: DeploymentModels;
  /** 归属人的个人网关配置(调用点从账号库现取);缺席=未配,走平台。
   *  多认一个 null:auth.json 被手改成 "personal_models": null 时,
   *  运行期会真出现 null(账号库只 JSON.parse 不清洗),按未配处理。 */
  personal?: ModelsSettings | null;
  operator?: string;
  log?: (message: string) => void;
}): ResolvedModelConfig {
  const platform = input.settings?.models();
  const platformJson = platform?.json ?? input.deployment.modelsJson;
  const vision = platform?.vision ?? input.deployment.vision;
  if (input.personal) {
    if (laneUsable(input.personal)) {
      return {
        lane: "personal",
        json: withPlatformVision(input.personal.json, vision, platformJson),
        provider: laneProvider(input.personal),
        model: input.personal.model,
      };
    }
    input.log?.(`个人网关配置残缺(账号 ${input.operator ?? "未知"}),`
      + "本次按平台网关处理(fail-open,ADR-0068)");
  }
  return {
    lane: "platform",
    json: platformJson ?? {},
    provider: platform?.provider ?? input.deployment.provider,
    model: platform?.model ?? input.deployment.model,
  };
}

function laneProvider(lane: ModelsSettings): string | undefined {
  return lane.provider
    || Object.keys(jsonProviders(lane.json))[0] || undefined;
}

/** 个人通道命中时优先采用的主模型选择(唯一的让位判定,ADR-0068 承
 *  Beta 旧例):lane=personal 且 provider/model 完整时返回之,调用点
 *  用它顶掉任务级 model_choice/平台现选——模型以个人网关配置为准。
 *  未命中或残缺返回 undefined,调用点落回自己的平台口径。
 *  lane=personal 由 laneUsable 保证 provider/model 完整,兜底
 *  undefined 只是类型收口的保险。 */
export function personalLaneChoice(
  resolved: ResolvedModelConfig | undefined,
): { provider: string; model: string } | undefined {
  return resolved?.lane === "personal" && resolved.provider && resolved.model
    ? { provider: resolved.provider, model: resolved.model }
    : undefined;
}

/** 个人网关配置是否完整可用:providers 里能解析出带 baseUrl+apiKey
 *  的 provider,且 model 在其目录中。残缺=视同未配(fail-open 走平台)。 */
function laneUsable(lane: ModelsSettings | undefined): boolean {
  if (!lane) return false;
  const providers = jsonProviders(lane.json);
  if (!Object.keys(providers).length) return false;
  const provider = laneProvider(lane);
  const spec = providers[provider ?? ""];
  if (!spec?.baseUrl || !spec.apiKey) return false;
  const listed = (spec.models ?? [])
    .map((item: { id?: unknown }) => String(item?.id ?? ""))
    .filter(Boolean);
  const model = lane.model || listed[0];
  return Boolean(provider && model && listed.includes(model));
}

/** 平台 vision 的 provider 条目并进个人通道现场 json(承 Beta 先例):
 *  个人网关会话的 models.json 必须能解析出视觉模型,否则 inspect_image
 *  在 pi 侧直接失踪。同名 provider 撞车时连接信息以个人网关为准,只补
 *  vision 模型条目。深拷贝返回,绝不改到账号库的存量对象。 */
function withPlatformVision(
  laneJson: Record<string, unknown> | undefined,
  vision: { provider: string; model: string } | undefined,
  platformJson: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cloned = structuredClone(laneJson ?? {});
  if (!vision?.provider || !vision?.model) return cloned;
  const providers = jsonProviders(cloned);
  const source = jsonProviders(platformJson)[vision.provider];
  if (!source) return cloned;
  const visionModel = (source.models ?? []).find(
    (item: { id?: unknown }) => String(item?.id ?? "") === vision.model);
  const existing = providers[vision.provider];
  if (!existing) {
    providers[vision.provider] = structuredClone(source);
    return cloned;
  }
  existing.models = upsertVisionModel(existing.models, visionModel
    ?? { id: vision.model });
  return cloned;
}

function upsertVisionModel(
  models: Array<Record<string, any>> | undefined,
  entry: Record<string, any>,
): Array<Record<string, any>> {
  const items = [...(models ?? [])];
  const index = items.findIndex((item) =>
    String(item?.id ?? "") === String(entry.id ?? ""));
  if (index < 0) return [...items, structuredClone(entry)];
  items[index] = { ...items[index], ...structuredClone(entry) };
  return items;
}
