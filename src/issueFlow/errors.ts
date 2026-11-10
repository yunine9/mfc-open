/**
 * 问题流域错误族集中声明 + 单点 HTTP 映射(#9 错误族映射统一)。
 *
 * 域错误过去散在三个文件定义、映射散在路由尾部与各路径的本地 try 里,
 * 同一失败(如 DTS 网关不可达)在拉单/详情/图代理/关联转正四条路分别
 * 落 500/500/502/409——前端没法按码定提示与重试策略。现在类型都住
 * 这里,路由 catch 只问 toHttpError;新错误族只登记这一处。
 *
 * 映射表(域错误族 → HTTP 码):
 *   IssueNotFoundError          → 404  问题会话不存在
 *   IssueControlError           → 409  控制/校验打回,消息人话直出
 *   StateConflictError          → 409  问题卡被抢先作答(固定提示,
 *                                      不透传待办 id/版本号等内部细节)
 *   DtsGatewayUnconfiguredError → 409  DTS 网关未配置(环境缺配置,见下)
 *   McpGatewayError             → 502  DTS 网关查询失败(上游故障,见下)
 *   其余运行时 Error             → 不映射(返回 undefined),交服务器
 *                                      兜底 500——未登记的失败如实当
 *                                      故障,不猜码。
 *
 * DTS 网关类口径(细分两档,理由):
 *   - 未配置(DtsGatewayUnconfiguredError)→ 409:请求本身合法,是部署
 *     环境没配 --dts-mcp-url/token,补配置即可成功。500 会误导成程序
 *     故障,502 会误导成上游挂了(其实根本没连);409 与本域 env_needed
 *     闸同语义——环境未就绪,补齐再来。这也保住拉单/详情路径的既有
 *     对外码(原先缺席守卫抛 IssueControlError 落 409,不因统一而漂移)。
 *   - 可达但查询失败(其余 McpGatewayError:HTTP 错误/超时/非 JSON/
 *     查无此单/应答形状未识别)→ 502:本服务就是 DTS 的网关侧代理,
 *     Bad Gateway 语义精确,提示与"稍后重试"策略随码一致;这是拉单/
 *     详情(原 500)与关联转正(原包 409)的归一口径,也是图代理路径
 *     的既有码(不漂移)。
 */

import { ConfigurationInputError } from "../configurationCenter.ts";
import { StateConflictError } from "../humanGate.ts";

// ---- 错误族声明 ----

/** 问题会话不存在:路由层回 404。原先定义在 service.ts,收拢至此。 */
export class IssueNotFoundError extends Error {
  constructor(id: string) {
    super(`问题会话 ${id} 不存在`);
  }
}

/** 控制类错误(登记/作答/配置的校验打回):路由层回 409 带人话,
 * 而不是当异常 500。原先定义在 state.ts(状态模型文件),住错了地方,
 * 收拢至此。 */
export class IssueControlError extends Error {}

/** 基础设施瞬断(Docker daemon 不可达、容器启动失败等,票 #159 对齐
 *  拍板 2026-09-10):时间可恢复,回合 catch 据此落 idle 交还人工,
 *  不判死整单。配置类错误(模型名/凭据错)不用它——那是 failed。 */
export class IssueInfraError extends Error {}

/** DTS/MCP 网关失败:网关不可达、上游应答异常、查无此单等。路由层
 * 回 502(上游故障)。原先定义在 gateways.ts,收拢至此。 */
export class McpGatewayError extends Error {}

/** 网关未配置变体:部署缺 --dts-mcp-url/token,是环境问题而非上游
 * 故障,路由层回 409(见文件头口径)。是 McpGatewayError 的子类——
 * 凡按"网关类失败"处理的地方不必区分两档,映射时子类先判。 */
export class DtsGatewayUnconfiguredError extends McpGatewayError {}

// ---- 单点映射 ----

export interface HttpError {
  status: number;
  /** 对外消息:域错误的人话原文;仅 StateConflictError 用固定提示
   * (内部细节不透传)。前端只消费文本,不按码推断状态。 */
  message: string;
}

/** 域错误 → {状态码, 对外消息};未登记的族返回 undefined,由调用方
 * 决定兜底(路由层原样上抛交服务器 500)。纯函数,可直接单测。 */
export function toHttpError(error: unknown): HttpError | undefined {
  if (error instanceof ConfigurationInputError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof IssueNotFoundError) {
    return { status: 404, message: error.message };
  }
  // 子类在前:未配置是网关失败里的环境档,先于父类的 502 判定。
  if (error instanceof DtsGatewayUnconfiguredError) {
    return { status: 409, message: error.message };
  }
  if (error instanceof McpGatewayError) {
    return { status: 502, message: error.message };
  }
  if (error instanceof IssueControlError) {
    return { status: 409, message: error.message };
  }
  if (error instanceof StateConflictError) {
    return { status: 409, message: "问题卡状态已变化(先到决定生效)" };
  }
  return undefined;
}
