import { accessSync, constants } from "node:fs";
import type { TaskService, SystemCheckResult, SystemCheckItem, SystemCheckStatus } from "./taskService.ts";
import type { DeliveryPlatformCheck } from "./deliveryPlatformProbe.ts";
import type { SystemCheckTrace } from "./runtimeDiagnostics.ts";

/** 自检只读取必要配置，各项外部检查并行，保持原有结果顺序与失败语义。 */
export async function runDeploymentCheck(input: {
  options: TaskService["options"];
  model?: { provider: string; model: string };
  vision?: { provider: string; model: string };
  linkBase?: string;
  platform?: string;
  buildSlots: number;
  trace: SystemCheckTrace;
  refreshPlatform: () => Promise<DeliveryPlatformCheck | undefined>;
  probeContainer: () => Promise<{ ready: boolean; detail: string; suggestion?: string }>;
}): Promise<SystemCheckResult> {
    const items: SystemCheckItem[] = [];
    const runtime = input.options.deploymentRuntime;
    items.push(runtime
      ? { key: "runtime", label: "Linux 部署", ...runtime }
      : { key: "runtime", label: "Linux 部署", status: "warning",
          detail: "当前调用形态没有部署运行信息",
          suggestion: "请从正式 serve 入口运行部署自检" });
    try {
      accessSync(input.options.dataDir, constants.R_OK | constants.W_OK);
      items.push({ key: "data", label: "任务数据", status: "ok",
        detail: "数据目录可读写" });
    } catch (error) {
      items.push({ key: "data", label: "任务数据", status: "error",
        detail: "数据目录不可读写", suggestion: String(error) });
    }

    const active = input.model;
    items.push(active
      ? { key: "model", label: "模型网关", status: "ok",
          detail: `${active.provider}/${active.model} 已配置` }
      : { key: "model", label: "模型网关", status: "error",
          detail: "没有可用模型",
          suggestion: "管理页 → 模型网关：填写网关地址、API Key 和模型名称" });

    const vision = input.vision;
    items.push(vision
      ? { key: "vision", label: "图片识别", status: "ok",
          detail: `${vision.provider}/${vision.model} 已配置（未做实时调用）`,
          suggestion: "可在管理页点击“测试识图能力”做真实端到端验证" }
      : { key: "vision", label: "图片识别", status: "warning",
          detail: "尚未配置专用图片识别模型",
          suggestion: "管理页 → 图片识别：配置内部多模态模型网关；不影响纯文本任务" });

    const notify = input.options.notifier?.health();
    items.push(!notify?.configured
      ? { key: "notify", label: "消息通知", status: "warning",
          detail: "通知通道未配置",
          suggestion: "这是部署项；成员只需在个人设置中填写自己的小鲁班 Token" }
      : notify.last_error
        ? { key: "notify", label: "消息通知", status: "warning",
            detail: "已配置，但最近一次发送失败", suggestion: notify.last_error }
        : { key: "notify", label: "消息通知", status: "ok",
            detail: "小鲁班通知通道已就绪" });

    // 通知链接地址:2026-08-19 内网实锤——没配 --public-url,发起人又
    // 只从回环地址(本机/SSH 隧道)访问,通知里的链接别人打不开。回环
    // 已不入账,所以这里能如实分三种:显式配置 > 已自学 > 还没着落。
    const linkBase = input.linkBase;
    items.push(input.options.linkBase
      ? { key: "link", label: "通知链接地址", status: "ok",
          detail: `固定为 ${input.options.linkBase}(--public-url)` }
      : linkBase
        ? { key: "link", label: "通知链接地址", status: "ok",
            detail: `已从内网访问自学:${linkBase}`,
            suggestion: "建议启动时加 --public-url 固定,不依赖谁先登录" }
        : { key: "link", label: "通知链接地址", status: "warning",
            detail: "尚无可用地址:未配 --public-url,也还没有人从内网地址"
              + "访问过(回环地址不算——发给别人打不开)",
            suggestion: "启动加 --public-url http://<内网IP>:<端口>,"
              + "或先用内网地址打开一次本页面" });

    // 三项互不依赖，数据库故障不能挡住平台及容器自检。
    const platform = input.platform;
    const [projection, platformCheck, containerProbe] = await Promise.all([
      input.trace.phase("postgres", async () => input.options.projection?.health()),
      input.trace.phase("platform", async () => platform ? input.refreshPlatform() : undefined),
      input.trace.phase("container", () => input.probeContainer()),
    ]);
    items.push(!projection
      ? { key: "postgres", label: "PostgreSQL", status: "warning",
          detail: "未配置历史投影", suggestion: "任务仍可运行，但无跨生命周期历史" }
      : !projection.reachable
        ? { key: "postgres", label: "PostgreSQL", status: "error",
            detail: "数据库不可达", suggestion: projection.last_error }
        : projection.last_error
          ? { key: "postgres", label: "PostgreSQL", status: "warning",
              detail: "连接正常，但最近有投影写入失败", suggestion: projection.last_error }
          : { key: "postgres", label: "PostgreSQL", status: "ok",
              detail: "连接与投影正常" });

    items.push(!input.options.host
      ? { key: "git", label: "Git 交付", status: "warning",
          detail: "当前是纯会话模式", suggestion: "交付代码前启用内核模式与代码仓" }
      : !platform
        ? { key: "git", label: "Git 交付", status: "error",
            detail: "MR / 流水线服务未就绪",
            suggestion: "请部署维护人员检查平台适配服务" }
        : !platformCheck?.ready
          ? { key: "git", label: "Git 交付", status: "error",
              detail: platformCheck?.detail ?? "平台能力预检未完成",
              suggestion: platformCheck?.suggestion }
          : { key: "git", label: "Git 交付", status: "ok",
              detail: platformCheck.detail });

    items.push(!input.options.prepush?.enabled
      ? { key: "prepush", label: "Build-Fix", status: "warning",
          detail: "当前部署未启用 Build-Fix" }
      : !containerProbe.ready
        ? { key: "prepush", label: "Build-Fix", status: "error",
            detail: "已启用，但任务构建环境未通过真实自检",
            suggestion: containerProbe.suggestion }
        : { key: "prepush", label: "Build-Fix", status: "ok",
            detail: "按需可用；主动请求时独立执行编译与 UT，不在交付前自动补跑，构建槽位 "
              + `${input.buildSlots}` });

    if (!input.options.isolation) {
      items.push({ key: "container", label: "统一任务容器",
        status: input.options.host ? "error" : "warning",
        detail: "未启用任务容器",
        suggestion: "正式部署必须配置 --isolate-image；业务命令不会回退宿主" });
    } else {
      items.push(containerProbe.ready
        ? { key: "container", label: "统一任务容器", status: "ok",
            detail: containerProbe.detail }
        : { key: "container", label: "统一任务容器", status: "error",
            detail: containerProbe.detail, suggestion: containerProbe.suggestion });
    }

    const overall: SystemCheckStatus = items.some((item) => item.status === "error")
      ? "error" : items.some((item) => item.status === "warning") ? "warning" : "ok";
    return { checked_at: new Date().toISOString(), overall, items };
}
