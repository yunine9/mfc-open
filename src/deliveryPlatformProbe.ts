/** 交付平台的只读能力预检。探测只读取平台根契约，不创建 MR、流水线或任务。 */
export interface DeliveryPlatformCheck {
  ready: boolean;
  detail: string;
  suggestion?: string;
  checked_at: string;
}

const REQUIRED_ENDPOINTS = [
  "POST /mr",
  "POST /pipeline/trigger",
] as const;

function failed(detail: string, suggestion?: string): DeliveryPlatformCheck {
  return {
    ready: false,
    detail,
    ...(suggestion ? { suggestion } : {}),
    checked_at: new Date().toISOString(),
  };
}

/** 地址可达不等于平台可用：200 + `{}` 也必须判红。 */
export async function probeDeliveryPlatform(
  platformUrl: string,
  timeoutMs = 5_000,
): Promise<DeliveryPlatformCheck> {
  const base = platformUrl.trim().replace(/\/+$/, "");
  if (!base) return failed("未配置 MR / 流水线平台地址");
  let url: URL;
  try {
    url = new URL(`${base}/`);
  } catch {
    return failed("交付平台地址格式不正确", "请检查部署参数 --platform");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return failed(
        `交付平台可达，但能力预检返回 HTTP ${response.status}`,
        "请检查平台适配服务地址、路由与鉴权配置",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return failed(
        "交付平台可达，但返回的不是能力契约",
        "该地址应返回 Mae-Flow 交付平台的 JSON 能力清单",
      );
    }
    const contract = payload as { ok?: unknown; endpoints?: unknown };
    const endpoints = Array.isArray(contract?.endpoints)
      ? contract.endpoints.filter((item): item is string => typeof item === "string")
      : [];
    const missing = [
      ...REQUIRED_ENDPOINTS.filter((required) => !endpoints.includes(required)),
      ...(!endpoints.some((entry) => entry.startsWith("GET /pipeline/status"))
        ? ["GET /pipeline/status"] : []),
    ];
    if (contract?.ok !== true || missing.length) {
      return failed(
        "地址可达，但不是完整的 Mae-Flow 交付平台",
        missing.length
          ? `缺少能力：${missing.join("、")}`
          : "平台根接口必须明确返回 ok=true 与 endpoints 能力清单",
      );
    }
    return {
      ready: true,
      detail: "MR 创建、流水线触发与状态查询接口均已就绪",
      checked_at: new Date().toISOString(),
    };
  } catch (error) {
    const timeout = error instanceof Error && error.name === "AbortError";
    return failed(
      timeout
        ? `交付平台 ${timeoutMs}ms 内未响应`
        : "交付平台连接失败",
      timeout ? "请检查平台负载或网络链路" : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}
