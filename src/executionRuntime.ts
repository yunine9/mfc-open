import { StartupRecovery } from "./startupRecovery.ts";
import { startStartupDiagnostics, pendingHttpRequests, SystemCheckTrace } from "./runtimeDiagnostics.ts";
/**
 * 启动任务服务。默认演示模式:内置剧本假模型,浏览器打开首页即可
 * 发任务→看进度→点审批走完整环。接真模型(GLM-5.1):
 *
 *   npm run serve -- --models /path/to/models.json --provider glm --model glm-5.1
 *
 * models.json 形状见 README「接真模型」。数据目录默认 .tasks/。
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { ScriptedModelServer, type Scene } from "./scriptedModel.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import { GIT_RUNTIME_RETENTION_MS } from "./gitTransferBudget.ts";
import { requireContinuousReviewCapability } from "./kernelCapabilities.ts";
import {
  DEFAULT_BUILD_CACHE_MAX_GB,
  DEFAULT_BUILD_CACHE_RETENTION_DAYS,
  DEFAULT_WORKSPACE_RETENTION_DAYS,
  TaskService,
} from "./taskService.ts";
import { humanBytes } from "./workspaceReclaim.ts";
import { sweepIssueAttachmentStaging } from "./issueFlowWorkspaceReclaim.ts";
import { EnvironmentRegistry } from "./environmentRegistry.ts";
import { startEnvironmentProbePolling } from "./environmentProbe.ts";
import { createTaskServer } from "./server.ts";
import { FakeLubanServer, Notifier } from "./notifier.ts";
import {
  loadLubanPluginToken,
  lubanApprovalCode,
  LubanApprovalGateway,
} from "./lubanApproval.ts";
import { FakeGitPlatform } from "./gitPlatform.ts";
import { IssueFlowService } from "./issueFlow/service.ts";
import { startAutoClaimScheduler } from "./issueFlow/autoClaim.ts";
import { setupDebugIssue } from "./issueFlow/debugIssue.ts";
import { IssueFlowLubanApproval } from "./issueFlow/lubanApproval.ts";
import {
  McpGateway,
  McpDtsGateway,
  MockDtsGateway,
  UnconfiguredDtsGateway,
  type DtsGateway,
} from "./issueFlow/gateways.ts";
import { PgProjection } from "./projection.ts";
import type { GateDecision } from "./gateService.ts";
import { LocalAuth } from "./auth.ts";
import { RuntimeSettings } from "./settings.ts";
import { resolveContainerUser } from "./containerRuntime.ts";
import { containerUserEnvironment } from "./containerBuildEnvironment.ts";
import {
  acquireInstanceLock,
  INSTANCE_LOCK_FILE,
  InstanceLockedError,
} from "./instanceLock.ts";
import { inspectDeploymentRuntime } from "./deploymentPreflight.ts";
import { muzzleBrokenPipes } from "./processOutput.ts";
import { guardProcess } from "./processGuard.ts";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** 部署版本号:服务启动时间 vYYYY.MM.DD.HHMM(本地时区),每次重启即变。
 *  用来确认部署生效(页面侧边栏底部显示)。不依赖 git,远端 rsync
 *  部署(无 .git)也能显示。用 toLocaleString 取服务器本地时区,不硬编码 UTC。 */
const buildHash = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `v${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
    + `.${pad(d.getHours())}${pad(d.getMinutes())}`;
})();

// 断管免疫要装在**第一行输出之前**(下面 CONFIG 的模块级初始化就会
// console.log):装晚一步,启动期的日志就有机会成为死因。
muzzleBrokenPipes();

const DEMO_SCRIPT: Scene[] = [
  { text: "先确认工作区状态",
    tool: { name: "bash", input: { command: "git status --short" } } },
  { tool: { name: "AskUserQuestion",
            input: { questions: [{ question: "当前改动可以继续交付吗?",
                                   options: ["通过", "打回"],
                                   recommended: "通过" }] } } },
  { text: "已按你的决定继续交付。" },
];

/**
 * 配置文件(--config <file.json>):键 = 去掉 "--" 的 flag 名,
 * 值 = 字符串/数字/布尔/数组。命令行永远压过文件——排障时临时改一个
 * 参数不必动文件。文件坏了直接拒启,不静默忽略:带着一半配置起服,
 * 比不起服更害人(你以为切了真件,其实还在假件上)。
 *
 * 不带 --config 时自动装载 /etc/mae-flow-cloud/serve.json(存在才装):
 * 服务器裸起即得全量配置,排障临时参数走命令行覆盖。
 *
 * 为什么不用环境变量堆:十几个 MAE_FLOW_* 散在 systemd 单元里没法
 * review;一个 JSON 文件即配置面清单,git 里能 diff(密钥除外——
 * apiKey 类仍走 secrets.env / models.json,权限 600,永不进仓)。
 */
const CONFIG: Record<string, unknown> = (() => {
  const index = process.argv.indexOf("--config");
  // 显式 --config 给路径;不给则自动装载部署侧固定位置的 serve.json——
  // 内网服务器 npm run serve 裸起即得全量配置,systemd 单元不必再拼一串
  // 参数。自动路径不存在不算错(视为无配置文件);显式给了 --config 却
  // 缺值/读不到才是错,照旧拒启。
  const DEFAULT_CONFIG_PATH = "/etc/mae-flow-cloud/serve.json";
  if (index >= 0 && !process.argv[index + 1]) {
    console.error("[serve] --config 需要文件路径");
    process.exit(2);
  }
  const path = index >= 0
    ? process.argv[index + 1]
    : (existsSync(DEFAULT_CONFIG_PATH) ? DEFAULT_CONFIG_PATH : undefined);
  if (!path) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("顶层必须是对象");
    }
    console.log(`[serve] 配置文件: ${resolve(path)}`);
    return parsed as Record<string, unknown>;
  } catch (error) {
    console.error(`[serve] 配置文件读取失败,拒绝启动: ${String(error)}`);
    process.exit(2);
  }
})();

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index > 0 && process.argv[index + 1] !== undefined) {
    return process.argv[index + 1];
  }
  const fromFile = CONFIG[name.replace(/^--/, "")];
  return fromFile === undefined ? undefined : String(fromFile);
}

/** 开关参数(无值);配置文件里写布尔 true。 */
function has(name: string): boolean {
  return process.argv.includes(name)
    || CONFIG[name.replace(/^--/, "")] === true;
}

/** 位置参数拒绝(2026-09-16 实连坑三次):本服务只认 --flag 形态,
 * `serve.ts <dataDir> <port>` 这类位置写法会被整体静默忽略——服务照常
 * 起来,却跑在默认数据目录与缺省模式上,人还以为带上了自己的数据,
 * 排障极难察觉。启动即炸并指出正确用法(与"文案错配宁可启动就炸"
 * 同一纪律)。已知边界:布尔旗标后紧跟的裸词会被当成它的值放过,但
 * 首位裸词(最常见形态)必炸。 */
(() => {
  const extra = process.argv.slice(2);
  const offenders = extra.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    return !(extra[index - 1]?.startsWith("--") ?? false);
  });
  if (offenders.length) {
    console.error(`[serve] 不认识的位置参数: ${offenders.join(" ")}——本服务只认 --flag 形态(如 --data <目录> --port 8787);位置参数会被静默忽略,拒绝带错配置启动。`);
    process.exit(2);
  }
})();

/** 内核解释器选择:MAE_FLOW_PYTHON 显式指定 > 启动时真跑一次探测。
 * Windows 的 python3 常是应用商店的执行别名桩——`--version` 有回显、
 * 真执行却无输出直接失败(2026-08-25 本机实测 rc=49),内核 dispatch
 * 挂上去整条链都起不来。坏桩回落到 python;都探测不动就保留缺省值,
 * 内核链失败会带着原始报错如实报告,不静默换解释器。 */
function resolveKernelPython(): string {
  const override = process.env.MAE_FLOW_PYTHON;
  if (override?.trim()) return override.trim();
  const candidates = process.platform === "win32"
    ? ["python3", "python"] : ["python3"];
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ["-c", "print(1)"],
        { encoding: "utf-8", timeout: 15_000 });
      if (probe.status === 0 && probe.stdout.toString().trim() === "1") {
        return candidate;
      }
    } catch {
      // 超时/找不到都继续试下一个候选。
    }
  }
  return "python3";
}

/** 可重复参数(如 --isolate-volume a:b --isolate-volume c:d);
 * 配置文件里写数组。命令行给了就整组压过文件,不做合并——半边文件
 * 半边命令行的挂载列表没人能排障。 */
function flags(name: string): string[] {
  const values: string[] = [];
  process.argv.forEach((argument, index) => {
    if (argument === name && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  });
  if (values.length) return values;
  const fromFile = CONFIG[name.replace(/^--/, "")];
  return Array.isArray(fromFile) ? fromFile.map(String) : [];
}

/** 选中的模型有没有声明上下文窗口(pi 的 models.json 原样透传,
 * contextWindow 是它自己的字段)。读不动一律当"没声明"——这只是
 * 一句启动提醒,不许因为配置形状意外把服务拦下。 */
function declaresContextWindow(
  modelsJson: Record<string, unknown>,
  provider: string,
  model: string,
): boolean {
  try {
    const providers = (modelsJson as { providers?: Record<string, any> })
      .providers ?? {};
    const models = (providers[provider]?.models ?? []) as Array<
      { id?: string; contextWindow?: number }>;
    const entry = models.find((item) => item?.id === model) ?? models[0];
    return typeof entry?.contextWindow === "number" && entry.contextWindow > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // 云端服务默认静音内核桌面弹窗:该被叫的是控制台前的人,不是跑服务的
  // 那台机器。内核默认开弹窗,是为"人坐在终端旁"的单机场景设计的;放到
  // 服务里,同一台机器上跑几单就弹几倍的通知,而真正的送达通道是待办与
  // 通知服务。要恢复单机手感就加 --desktop-notify。
  if (has("--desktop-notify")) {
    // TaskService 默认闸静音(防的是测试/probe 把用户 mac 弹一串),
    // 这里显式声明"人就在这台机器旁",闸才放行。
    process.env.MAE_FLOW_DESKTOP_NOTIFY = "1";
  } else {
    process.env.MAE_FLOW_NO_NOTIFY = "1";
  }
  // 告诉内核:用户不在这台机器上。内核的提示词默认"用户就坐在这里"——
  // 会让他去 IDE 里检视代码、把现场面板的本机绝对路径念给他听。这些话
  // 是被模型原样转述给用户的(内核为面板路径专门加过转述义务),而在
  // 控制台里那个路径他打不开、IDE 也不存在,材料本来就在页面上。
  // 用户实测撞到这个:"还让去 ide 检视代码,明显不对了"。
  process.env.MAE_FLOW_HOST = "cloud";
  const port = Number(flag("--port") ?? 8787);
  const bindHost = flag("--host") ?? "127.0.0.1";
  const publicUrlFlag = flag("--public-url")?.trim();
  let publicUrl: string | undefined;
  if (publicUrlFlag) {
    try {
      const parsed = new URL(publicUrlFlag);
      if (!/https?:/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("只接受不含账号密码的 http/https 地址");
      }
      publicUrl = publicUrlFlag.replace(/\/+$/, "");
    } catch (error) {
      console.error(`[serve] --public-url 无效:${String(error)}`);
      process.exit(2);
    }
  }
  const dataDir = resolve(flag("--data") ?? join(REPO_ROOT, ".tasks"));
  mkdirSync(dataDir, { recursive: true });
  // 独占锁必须在碰这个目录的任何东西之前拿到:实例身份就是 dataDir
  // 指纹,起服会按它清扫"本实例"的遗留容器——第二个实例起来的瞬间
  // 就会杀掉第一个正在跑的编译/prepush 容器。这不是抢资源,是踩现场。
  let instanceLock;
  try {
    instanceLock = acquireInstanceLock(dataDir,
      { log: (message) => console.log(`[serve] ${message}`) });
  } catch (error) {
    if (error instanceof InstanceLockedError) {
      console.error(`[serve] 拒绝启动:${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  guardProcess(dataDir);   // 旁路异常不许带走整个服务(见函数注释)
  sweepStaleGitRuntime(dataDir);   // 上个进程留下的明文凭据现场(旁路)
  // 管理旋钮(主 spec §4:最大并发由管理员配置,超出排队)。
  const maxConcurrent = Number(flag("--max-concurrent") ?? 2);
  // 管理页运行时设置先立起来:模型网关与运行参数
  // 都可能已在界面配过——boot 判定要读它。
  const settings = new RuntimeSettings(
    dataDir, (message) => console.log(`  [settings] ${message}`));

  let modelsJson: Record<string, unknown>;
  let provider = flag("--provider") ?? "maeflow";
  let model = flag("--model") ?? "scripted-v1";
  const modelsPath = flag("--models");
  const visionProvider = flag("--vision-provider")?.trim();
  const visionModel = flag("--vision-model")?.trim();
  if (!!visionProvider !== !!visionModel) {
    console.error("[serve] --vision-provider 与 --vision-model 必须同时配置");
    process.exit(2);
  }
  const settingsModels = settings.models();
  // 演示判定是三态:--models > 管理页配过模型网关 > 才算演示。
  // 曾经"无 --models 即演示"会让最小启动(--data --port)每次重启
  // 清空数据目录——界面配的一切陪葬(用户要 UI 优先形态时逮住)。
  const demoMode = !modelsPath && !settingsModels.json;
  if (modelsPath) {
    modelsJson = JSON.parse(readFileSync(modelsPath, "utf-8"));
    console.log(`[serve] 使用真模型配置: ${modelsPath} (${provider}/${model})`);
  } else if (settingsModels.json) {
    // 模型网关来自管理页:真模式,保数据。launch 时设置层还会现读,
    // 这里只是给部署层一个兜底值。
    modelsJson = settingsModels.json;
    provider = settingsModels.provider ?? provider;
    model = settingsModels.model ?? model;
    console.log(`[serve] 模型网关来自管理页设置 (${provider}/${model})`);
  } else {
    // 演示模式曾经**每次启动静默删光数据目录**(理由:剧本假设新场)。
    // 用户实测踩到:随手起个演示实例指到真数据目录,一条 await_merge
    // 的真单当场没了——"要不要清"这种事不该靠人记住命令的副作用。
    // 现在:清场必须显式 --fresh,且清之前把要删的东西数出来告诉人;
    // 不加 --fresh 就沿用现有数据(演示剧本照跑,顶多列表里有旧单)。
    if (has("--fresh")) {
      const doomed = existsSync(dataDir)
        ? readdirSync(dataDir).filter((name) => name.startsWith("task-")).length
        : 0;
      console.log(`[serve] --fresh:清空数据目录 ${dataDir}`
        + (doomed ? `(含 ${doomed} 个任务现场,不可恢复)` : ""));
      // 逐项删,跳过本进程刚拿到的独占锁。整目录 rmSync 会把锁一起
      // 带走,等于清场期间大门敞开——那正是并发实例踩进来的窗口。
      for (const name of readdirSync(dataDir)) {
        if (name === INSTANCE_LOCK_FILE) continue;
        rmSync(join(dataDir, name), { recursive: true, force: true });
      }
    } else if (existsSync(dataDir)
        && readdirSync(dataDir).some((name) => name.startsWith("task-"))) {
      console.log("[serve] 演示模式沿用现有数据目录(要白纸起步加 --fresh)");
    }
    const scripted = new ScriptedModelServer(DEMO_SCRIPT);
    await scripted.start();
    modelsJson = scripted.modelsJson();
    console.log("[serve] 演示模式:内置剧本假模型(接真模型用 --models)");
  }
  // 窗口没声明就提醒一句(内网实测:网关上限 169984,pi 按自己估的
  // 窗口做自动压缩,估大了就撞硬报错——宿主有一次压缩自愈,但那已经
  // 白跑一轮。声明了 pi 会提前压,根本不撞墙)。只提醒不拦路。
  if (!demoMode && !declaresContextWindow(modelsJson, provider, model)) {
    console.log(
      `[serve] 提示:models.json 里 ${provider}/${model} 没声明 contextWindow`
      + ";网关窗口若小于 pi 的默认估计会撞\"input too long\"硬报错。"
      + "建议按网关真实上限留出余量声明(如上限 169984 → 写 160000)");
  }

  // 本地账号是控制台身份源。生产首次启动必须从环境变量注入管理员
  // 密码；演示模式给固定演示密码并醒目标注，避免把随机密码藏在日志里。
  // 调试形态(--debug-issue)同演示待遇:本机仿真不该被启动密码卡住。
  const debugIssue = has("--debug-issue");
  const auth = new LocalAuth(join(dataDir, "auth.json"));
  if (!auth.hasUsers()) {
    const adminUser = process.env.MAE_FLOW_ADMIN_USER ?? "admin";
    const adminPassword = process.env.MAE_FLOW_ADMIN_PASSWORD
      ?? (demoMode || debugIssue ? "mae-flow-demo" : "");
    if (!adminPassword) {
      throw new Error(
        "首次启动需设置 MAE_FLOW_ADMIN_PASSWORD(至少 10 个字符)",
      );
    }
    auth.bootstrapAdmin(adminUser, adminPassword);
    if (demoMode || debugIssue) {
      // 管理员不发起任务(用户拍板:管理平台与干活是两个角色),
      // 演示必须再给一个开发者账号——只有 admin 的演示是发不了单的。
      auth.createUser("dev", "mae-flow-demo", "developer");
      console.log("[serve] 演示登录: dev / mae-flow-demo(下单用)"
        + "; admin / mae-flow-demo(管理平台,不发起任务)");
    } else {
      console.log(`[serve] 已创建管理员账号: ${adminUser}`
        + "(管理员不发起任务,请为成员建开发者账号)");
    }
  }

  // 调试形态(--debug-issue):问题流全链本机仿真——bare 镜像远端、
  // 进程内交付平台假件(FakeGitPlatform,恒绿)、调试专属 DTS 单、
  // 罐头日志与假抓日志引擎、示例业务模块与假网管环境、dev 账号署名。
  // 幂等播种,已存在不覆盖;旗标缺席时以下全程不执行,正式形态
  // 零改动(ADR-0028)。
  const debugSetup = debugIssue
    ? await setupDebugIssue({
        dataDir, auth,
        log: (message) => console.log(`  [debug-issue] ${message}`),
      })
    : undefined;
  if (debugSetup) {
    console.log(`[serve] 调试形态(--debug-issue)就绪: 交付平台(进程内恒绿) `
      + `${debugSetup.platformUrl};bare 镜像 ${
        debugSetup.mirrors.map((item) => item.name).join("、") || "(无)"}`
      + `;调试单 ${debugSetup.dtsTicketFile}(改完列表页点刷新即生效)`);
  }

  // 内核自动发现:链的语义与顺序见 kernelDiscovery.ts(serve/pilot/
  // 测试共用一条链,不许各写各的)。
  let kernelRoot: string | undefined;
  try {
    kernelRoot = discoverKernelRoot(REPO_ROOT,
      !has("--issue-only") && (has("--kernel-mode") || !!flag("--repo")));
  } catch (error) {
    console.error(`[serve] ${String(error)}`);
    process.exit(2);
  }

  // 问题流专用部署(--issue-only):需求流程的重依赖(内核/交付平台/
  // prepush/容器镜像守卫)整体不加载——它们缺配时也不再拒绝启动,
  // 问题处理照常服务。这是对"需求侧配置问题不许拖死问题流"的正面
  // 回答;反过来,没加 --issue-only 的内核模式部署仍按宪法 fail-loud。
  const issueOnly = has("--issue-only");

  // 内核模式开启条件:找得到内核,且用 --repo 钉死单仓(演示/测试)
  // 或明确 --kernel-mode(正式形态,代码仓由开发逐单必填)。
  // --issue-only 压过内核模式:给了两者就按问题流专用跑,并说清楚。
  const repoFlag = flag("--repo");
  const kernelRequested = !!kernelRoot
    && (!!repoFlag || has("--kernel-mode"));
  if (issueOnly && kernelRequested) {
    console.log("[serve] --issue-only 与内核模式同时给出:按问题流专用跑,"
      + "内核/交付平台/Build-Fix 本次不加载(需求流程停用)");
  }
  const kernelMode = !issueOnly && kernelRequested;
  // URL 仓不许过 resolve(会被拼成本地路径,实测毁 URL);本地路径才归一化。
  const repoPath = repoFlag
    ? (/^(https?|ssh|git):\/\//i.test(repoFlag)
        ? repoFlag : resolve(repoFlag))
    : undefined;
  const kernelPython = kernelMode ? resolveKernelPython() : undefined;
  const kernelCapability = kernelMode
    ? requireContinuousReviewCapability({
        kernelRoot: kernelRoot!, python: kernelPython, cwd: REPO_ROOT,
      })
    : undefined;
  let host = kernelMode
    ? { kernelRoot: kernelRoot!, repoPath, python: kernelPython,
        continuousReview: kernelCapability?.continuous_review === true,
        // --repo 钉死单仓的部署形态:逐单仓从入口就拒(MFC-024)。
        ...(repoPath ? { repoPinned: true } : {}) }
    : undefined;
  if (host) {
    console.log(`[serve] 内核模式:内核 ${host.kernelRoot}`
      + `,代码仓 ${repoPath ?? "(下单时逐单填写)"}`
      + `,内核 python: ${host.python},持续检视契约:已确认`);
  } else if (kernelRoot) {
    console.log("[serve] 内核在场但未开内核模式:演示形态。"
      + "正式部署请加 --kernel-mode；--repo 仅用于钉死单仓的试跑");
  }

  // Git 交付链:--platform <url> 接真件(内网 MR/流水线网关);
  // --fake-platform 本地起假件——从 --repo 灌一个裸仓当远端,
  // 推送/MR/流水线全环回,与 pilot 同款(部署手册的切换点在此落地)。
  let delivery: { platformUrl: string } | undefined;
  const platformUrl = flag("--platform");
  // 交付链的预算旋钮:修复轮(默认 20,0=关)、状态轮询(默认 10s)、
  // 红灯证据重采(默认 3 分钟)与总轮询预算(默认 30 分钟)。只暴露数值,
  // "无限等待"这种取值不存在——预算的存在性不是配置项。
  const pace = {
    repairRounds: flag("--repair-rounds") !== undefined
      ? Number(flag("--repair-rounds")) : 20,
    pollIntervalMs: flag("--poll-interval") !== undefined
      ? Number(flag("--poll-interval")) * 1000 : undefined,
    evidenceRetryMs: flag("--evidence-retry-interval") !== undefined
      ? Number(flag("--evidence-retry-interval")) * 1000 : undefined,
    pollTimeoutMs: flag("--poll-timeout") !== undefined
      ? Number(flag("--poll-timeout")) * 1000 : undefined,
  };
  for (const [key, value] of Object.entries(pace)) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      console.error(`[serve] ${key} 必须是非负数字,拒绝启动`);
      process.exit(2);
    }
  }
  // --resolve-discussions:发布检视回复时顺手代点"已解决"。默认不开
  // ——内网既有框架的实证(能力核对报告 D3):resolve 归检视人,
  // 代点是越权;平台/团队明确允许的部署才加这个 flag。
  const resolveDiscussions = has("--resolve-discussions");
  // --unfixable-tools(配置文件里写数组):CODECHECK 红灯全部来自这些
  // 工具(如 SuperChecker)时不派发修复会话,直接如实等人——修复 Agent
  // 改代码解决不了平台侧告警,派了就是白烧一轮(2026-08-28 对比报告)。
  const unfixableTools = flags("--unfixable-tools")
    .flatMap((value) => value.split(","))
    .map((tool) => tool.trim()).filter(Boolean);
  if (platformUrl) {
    delivery = { platformUrl, ...pace,
                 ...(resolveDiscussions ? { resolveDiscussions } : {}),
                 ...(unfixableTools.length ? { unfixableTools } : {}) };
    console.log(`[serve] 交付平台: ${platformUrl}`
      + (unfixableTools.length
        ? `(不可修工具: ${unfixableTools.join("、")})` : ""));
  } else if (host && has("--fake-platform")) {
    // 假平台从 --repo 的本地仓灌裸仓;URL 仓/无仓没得灌,如实拒绝。
    if (!host.repoPath || /^(https?|ssh|git):\/\//i.test(host.repoPath)) {
      console.error("[serve] --fake-platform 需要 --repo 指向本地仓(灌裸仓用)");
      process.exit(2);
    }
    const platform = new FakeGitPlatform();
    platform.initBare(host.repoPath, dataDir);
    await platform.start();
    host = { ...host, repoPath: platform.barePath };
    delivery = { platformUrl: platform.baseUrl, ...pace,
                 ...(resolveDiscussions ? { resolveDiscussions } : {}) };
    console.log(`[serve] 假 Git 平台已就位(裸仓远端): ${platform.baseUrl}`);
  }

  // --pg 开启 PostgreSQL 投影(主 spec §11):看板/审计/恢复引导的
  // 读侧。纯旁路——没配一切照旧,配了写失败也不影响流程。
  const pgUrl = flag("--pg");
  const projection = pgUrl
    ? new PgProjection(pgUrl, (message) => console.log(`  ${message}`))
    : undefined;
  if (projection) console.log(`[serve] PostgreSQL 投影已接线`);

  // 通知端点:--luban <endpoint> 接真件;不配则起假通知服务。原来这里
  // 永远起假件——部署手册写着"换 endpoint 零改动",代码里却没有那个
  // 口子,真件根本切不过去(盘配置面时逮住的缺口)。
  // --luban-header "Name: value"(可重复)带鉴权头;头的值是密钥,
  // 建议放配置文件并把文件权限设 600,别写进 systemd 单元。
  let lubanEndpoint = flag("--luban");
  let lubanIsFake = false;
  if (lubanEndpoint) {
    console.log(`[serve] 通知服务真件: ${lubanEndpoint}`);
  } else if (issueOnly) {
    // 问题流专用部署:通知假件起不来也不许挡住问题处理(需求流程
    // 反正停用,没人消费通知)。完整部署保持 fail-loud 不变。
    try {
      const luban = new FakeLubanServer();
      await luban.start();
      lubanEndpoint = luban.endpoint;
      lubanIsFake = true;
      console.log("[serve] 假通知服务已就位(问题流专用部署)");
    } catch (error) {
      console.log(`[serve] 假通知服务启动失败,问题流专用模式继续(通知不可用): ${String(error)}`);
    }
  } else {
    const luban = new FakeLubanServer();
    await luban.start();
    lubanEndpoint = luban.endpoint;
    lubanIsFake = true;  // 假件不索个人令牌(配置门禁据此放行)
    console.log("[serve] 假通知服务已就位,消息可查: " + luban.endpoint.replace("/notify", ""));
  }
  const lubanHeaders: Record<string, string> = {};
  for (const header of flags("--luban-header")) {
    const at = header.indexOf(":");
    if (at <= 0) {
      console.error(`[serve] --luban-header 需要 "名字: 值" 形状,拿到: ${header}`);
      process.exit(2);
    }
    lubanHeaders[header.slice(0, at).trim()] = header.slice(at + 1).trim();
  }
  // 通知文案模板(可选):三类通知各一条,占位符词汇表与示例见
  // docs/luban-notification-templates.md。配错(表外占位符)在 Notifier
  // 构造期点名并拒绝启动——部署配置语义;通知运行期仍是旁路 fail-open,
  // 两件事不冲突:错模板一次也别投出去。
  const lubanTemplateWaiting = flag("--luban-template-waiting");
  const lubanTemplateOutcome = flag("--luban-template-outcome");
  const lubanTemplateReview = flag("--luban-template-review");
  // 手机审批是入站回调，与上面的出站通知令牌是两套身份。Token 只从
  // 0600 文件读，不允许塞进命令行或 JSON 配置的明文字段。
  const lubanPluginTokenFile = flag("--luban-plugin-token-file");
  // Token 只让 Cloud 的接收端点就绪；真实通知服务是否会把回复送进来是
  // 另一项部署事实。未完成端到端验收时绝不能在通知里承诺“直接回复”。
  const lubanPluginReplies = has("--luban-plugin-replies");
  let lubanPluginToken: string | undefined;
  if (lubanPluginTokenFile) {
    try {
      lubanPluginToken = loadLubanPluginToken(
        resolve(lubanPluginTokenFile));
      console.log("[serve] 通知服务 Cloud 回调端点已就绪: "
        + "/integrations/luban/plugin");
    } catch (error) {
      console.error(`[serve] 通知服务插件 Token 无效，拒绝启动: ${String(error)}`);
      process.exit(2);
    }
  }
  if (lubanPluginReplies && !lubanPluginToken) {
    console.error("[serve] --luban-plugin-replies 需要同时配置 "
      + "--luban-plugin-token-file；只有真实入站插件验收通过后才能开启");
    process.exit(2);
  }
  if (lubanPluginToken && !lubanPluginReplies) {
    console.log("[serve] 通知服务回调端点已就绪，但尚未声明入站回复已接通；"
      + "通知不会提示直接回复序号");
  } else if (lubanPluginReplies) {
    console.log("[serve] 通知服务入站回复已由部署显式启用；通知将提供手机审批指令");
  }

  // 统一任务执行面:普通编码/修复/子 Agent/Build-Fix 的 Bash
  // 全部进入同一类加固容器。Cloud 控制面、Git 凭据、MR/通知仍留宿主。
  const isolateImage = flag("--isolate-image");
  // 任务记忆检索旁路(docs/knowledge-memory-design.md §7):给 venv 的
  // python 就起常驻 sidecar;不给则只有索引级的开局推送,任务照跑。
  // 旧启动命令继续可用；经验整理统一跟随任务主模型。
  if (flag("--memory-draft-provider") || flag("--memory-draft-model")) {
    console.warn("[serve] memory-draft 配置已废弃并忽略，经验整理使用任务主模型");
  }
  const memsearchPython = flag("--memsearch");
  if (memsearchPython && !existsSync(memsearchPython)) {
    console.error(`[serve] --memsearch 指向的 python 不存在: ${memsearchPython}`);
    process.exit(2);
  }
  const isolateMemory = flag("--isolate-memory") ?? "8g";
  const isolateCpus = flag("--isolate-cpus") ?? "8";
  const hostAvailableCpus = availableParallelism();
  const isolatePids = Number(flag("--isolate-pids") ?? "512");
  const isolateNetwork = flag("--isolate-network") ?? "bridge";
  const isolateUser = flag("--isolate-user");
  const isolateHome = flag("--isolate-home");
  if (isolateHome !== undefined) containerUserEnvironment(isolateHome);
  // 容器里只有 npm_config_cache 没有源地址,内网 npm 会打公网直到超时
  // (2026-09-03 issue #75)。显式配置优先;没配时按部署形态判定:挂载了
  // Maven settings.xml 就是内网镜像形态,回落内置缺省源——与 DTS 网关
  // 同款"值是死的就硬编码,但生效有门"(2026-09-03 部署反馈:零配置
  // 部署要直接可用,不能指望多配一行)。URL 待 #77 与 issue-28 现场
  // 对拍确认;演示/外网形态没有 settings.xml 挂载,npm 维持公网现状。
  const NPM_REGISTRY_INTRANET_DEFAULT = "https://npm.example.com/npm/";
  const isolateVolumes = flags("--isolate-volume");
  const isolateNpmRegistryExplicit = flag("--isolate-npm-registry");
  const isolateNpmRegistry = isolateNpmRegistryExplicit
    ?? (isolateVolumes.some((volume) =>
          volume.split(":")[1]?.replace(/\/+$/, "")
            === "/etc/mae-flow/maven/settings.xml")
      ? NPM_REGISTRY_INTRANET_DEFAULT
      : undefined);
  const isolateCacheRoot = resolve(
    flag("--isolate-cache-root") ?? join(dataDir, "build-cache"),
  );
  const buildSlots = Number(flag("--build-slots") ?? "1");
  // 新部署只暴露 Build-Fix 命名；旧 flag 保留兼容，避免滚动升级断配置。
  const prepushAttemptTimeoutValue = flag("--build-fix-attempt-timeout-minutes")
    ?? flag("--prepush-attempt-timeout-minutes");
  const prepushAttemptTimeoutMinutes = prepushAttemptTimeoutValue !== undefined
    ? Number(prepushAttemptTimeoutValue) : undefined;
  const prepushBuildTimeoutValue = flag("--build-fix-command-timeout-minutes")
    ?? flag("--prepush-build-timeout-minutes");
  const prepushBuildTimeoutMinutes = prepushBuildTimeoutValue !== undefined
    ? Number(prepushBuildTimeoutValue) : undefined;
  // 现场保留期:终态任务过期后回收克隆等重货,台账原样留下。
  // 以前一条回收策略都没有,dataDir 只涨不消(2026-08-22 查出来的)。
  const retentionDays = Number(
    flag("--workspace-retention-days") ?? String(DEFAULT_WORKSPACE_RETENTION_DAYS));
  const buildCacheRetentionDays = Number(
    flag("--build-cache-retention-days")
      ?? String(DEFAULT_BUILD_CACHE_RETENTION_DAYS));
  const buildCacheMaxGb = Number(
    flag("--build-cache-max-gb") ?? String(DEFAULT_BUILD_CACHE_MAX_GB));
  if (!Number.isFinite(retentionDays) || retentionDays < 0) {
    console.error("[serve] --workspace-retention-days 必须是 ≥0 的数字"
      + "(0 = 永不回收),拒绝启动");
    process.exit(2);
  }
  if (!Number.isFinite(buildCacheRetentionDays)
      || buildCacheRetentionDays < 0) {
    console.error("[serve] --build-cache-retention-days 必须是 ≥0 的数字"
      + "(0 = 不按时间回收),拒绝启动");
    process.exit(2);
  }
  if (!Number.isFinite(buildCacheMaxGb) || buildCacheMaxGb < 0) {
    console.error("[serve] --build-cache-max-gb 必须是 ≥0 的数字"
      + "(0 = 不限容量),拒绝启动");
    process.exit(2);
  }
  if (!Number.isInteger(isolatePids) || isolatePids <= 0) {
    console.error("[serve] --isolate-pids 必须是正整数,拒绝启动");
    process.exit(2);
  }
  if (!Number.isFinite(Number(isolateCpus)) || Number(isolateCpus) <= 0) {
    console.error("[serve] --isolate-cpus 必须是正数,拒绝启动");
    process.exit(2);
  }
  if (!Number.isInteger(buildSlots) || buildSlots <= 0) {
    console.error("[serve] --build-slots 必须是正整数,拒绝启动");
    process.exit(2);
  }
  for (const [name, value] of [
    ["--build-fix-attempt-timeout-minutes", prepushAttemptTimeoutMinutes],
    ["--build-fix-command-timeout-minutes", prepushBuildTimeoutMinutes],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      console.error(`[serve] ${name} 必须是正数,拒绝启动`);
      process.exit(2);
    }
  }
  if (/^(?:host|container(?::.*)?)$/i.test(isolateNetwork)) {
    console.error("[serve] --isolate-network 不能使用 host/container 模式,拒绝启动");
    process.exit(2);
  }
  if (isolateUser !== undefined
      && (!isolateUser.trim()
        || /^(?:root|0)(?::|$)/i.test(isolateUser.trim())
        || /:0$/i.test(isolateUser.trim()))) {
    console.error("[serve] --isolate-user 禁止使用 root/0 或空值,拒绝启动");
    process.exit(2);
  }
  // 容器用户在 Linux 上决定工作区文件的宿主属主,配错要到 push 前才炸。
  let containerUser;
  try {
    containerUser = resolveContainerUser({
      configured: isolateUser,
      platform: process.platform,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
    });
  } catch (error) {
    console.error(`[serve] 拒绝启动:${String((error as Error).message)}`);
    process.exit(2);
  }
  if (isolateImage) {
    console.log(`[serve] 统一任务容器: ${isolateImage}`
      + `;memory=${isolateMemory},cpus=${isolateCpus},pids=${isolatePids}`
      + `,network=${isolateNetwork},build-slots=${buildSlots}`
      + `,host-available-cpus=${hostAvailableCpus}`);
    if (Number(isolateCpus) > hostAvailableCpus) {
      console.warn(`[serve] 容器 CPU 上限 ${isolateCpus} 超过服务可用的`
        + ` ${hostAvailableCpus} 个逻辑 CPU；不会获得额外算力，建议按宿主调整`);
    }
    console.log(`[serve] 任务容器用户: ${containerUser.user ?? "镜像默认"}`
      + `(${containerUser.reason})`);
    console.log(`[serve] 分仓构建缓存: ${isolateCacheRoot}`);
    console.log(`[serve] 容器 HOME: ${isolateHome ?? "/home/mae-flow"}（Maven/npm 用户配置与 tmpfs 同步）`);
    // registry 配错只会在容器内 npm 报错时才暴露,启动期摆到明面好排障;
    // 来源(显式配置/内网形态缺省)也摆出来,运维一眼看出该不该改配置。
    if (isolateNpmRegistry) {
      console.log(`[serve] 容器 npm 源: ${isolateNpmRegistry}${
        isolateNpmRegistryExplicit ? ""
          : "(内网形态缺省——挂载了 Maven settings.xml 自动注入,"
            + "--isolate-npm-registry 可覆盖)"}`);
    } else {
      console.log("[serve] 容器 npm 源: 未注入,npm 将打公网"
        + "(内网部署请挂载 Maven settings.xml 或配置 --isolate-npm-registry)");
    }
    console.log(`[serve] 构建缓存策略:连续 ${buildCacheRetentionDays} 天未使用回收，`
      + `总量上限 ${buildCacheMaxGb > 0 ? `${buildCacheMaxGb}GB` : "不限"}`);
  }

  // 历史开关仅保留命令行兼容。内核的最终验证契约仍只有一种：三项
  // 由流水线核销；push 前的服务器编译/UT Agent 是 Cloud 加速层，
  // 不改变该契约，也不让内核新增步骤。
  if (has("--verify-via-pipeline")) {
    console.warn("[serve] --verify-via-pipeline 已弃用并被忽略:"
      + "最终编译、UT 与 CodeCheck 仍固定由流水线核销");
  }
  if (host) {
    // 内核模式下执行契约固定为"三项交流水线",流程必然停在 external_verify
    // 等宿主递事实。没有平台就没人递,每一单都会走到等待点后无人核销——
    // 起服=每单必卡。这条守卫是 --verify-via-pipeline 时代就有的,退役那个
    // 开关时被一并删掉了;契约固定之后它反而更该在,因为现在没有"不走
    // 流水线"的形态可退。宁可拒绝启动,也不要起一台每单都废的服务。
    if (!delivery) {
      console.error(
        "[serve] 内核模式需要交付平台在场:请加 --platform <url> 接真件,"
        + "或 --fake-platform 起本地假件。\n"
        + "        原因:云端执行契约把编译/UT/CodeCheck 交给权威流水线,"
        + "流程会停在 external_verify 等平台事实;没有平台就没人核销,"
        + "每一单都会卡在验证中且无法自愈。");
      process.exit(2);
    }
    if (!isolateImage) {
      console.error(
        "[serve] 内核模式要求统一任务容器:请加 --isolate-image <构建镜像>。\n"
        + "        原因:编码、修复、子 Agent 及 push 前编译/UT 的业务命令"
        + "必须隔离执行；缺少镜像时拒绝静默回退宿主机。\n"
        + "        镜像构建见 deploy/build-image/README.md。",
      );
      process.exit(2);
    }
    console.log("[serve] Cloud 执行契约:所有任务 Bash 进入加固容器;每次 push 前"
      + "由独立 Agent 在新构建容器完成编译与 UT，CodeCheck 和最终复核仍由流水线执行");
  }

  // 提交信息规范:平台 pre-receive 钩子按正则拒收不合规提交(内网
  // 实测),规矩要开场就进提示词。部署级给一句,管理页可热改覆盖。
  const commitConvention = flag("--commit-convention");
  if (commitConvention) {
    console.log(`[serve] 提交信息规范已上膛: ${commitConvention.slice(0, 60)}`
      + (commitConvention.length > 60 ? "…" : ""));
  }

  // 问题流(与需求内核完全分离的会话域):MCP 网关按需接线。
  // token 只从文件读(缺省 /etc/mae-flow-cloud/mcp-token,文件在场即
  // 自动装载,可用 --mcp-token-file 覆盖)——命令行/JSON 配置里不许
  // 出现明文密钥。
  // DTS 网关地址是站点固定值(2026-08-28 拍板:内网唯一实例,值是死
  // 的),直接给代码缺省——serve.json 不必为 DTS 写任何键。两条护栏:
  // ①缺省 URL 仅在 token 文件在场时生效,否则开发机/演示形态会被
  // "配了 URL 没 token 拒启"的 fail-fast 干掉;②显式 --dts-mock 压过
  // 缺省(生产机想开 mock 测试不该撞互斥),互斥只拦显式 --dts-mcp-url。
  // --dts-mock:过渡期假单据(真实网关完整实现在位),供外部环境跑通
  // 全流程。
  const DEFAULT_DTS_MCP_URL =
    "http://mcp.example.com/mcp/route";
  const dtsMock = has("--dts-mock") || debugIssue;
  const explicitDtsMcpUrl = flag("--dts-mcp-url");
  const mcpTokenFile = flag("--mcp-token-file")
    ?? (existsSync("/etc/mae-flow-cloud/mcp-token")
      ? "/etc/mae-flow-cloud/mcp-token" : undefined);
  const dtsMcpUrl = explicitDtsMcpUrl
    ?? (dtsMock || !mcpTokenFile ? undefined : DEFAULT_DTS_MCP_URL);
  // 问题流的网关配置坏了,不许连累需求流。--issue-only 下问题处理就是
  // 全部业务,配置坏了必须当场拒启;完整部署下 DTS 网关只是问题域的一路
  // 旁路,按红线"旁路一律 fail-open"降级成不接线并大声记账——需求流程
  // 照常起服,问题页由 UnconfiguredDtsGateway 当场说人话,不静默装可用。
  // 踩过的坑:缺省会自动装载 /etc/mae-flow-cloud/mcp-token,一个空文件
  // 就能让整台机器(含需求流)起不来,而没人点过问题处理。
  let dtsDisabledReason = "";
  const issueGatewayFault = (reason: string): void => {
    if (issueOnly) {
      console.error(`[serve] ${reason};--issue-only 下问题处理是全部业务,拒绝启动`);
      process.exit(2);
    }
    dtsDisabledReason = reason;
    console.error(`[serve] ${reason};本次不接 DTS 网关——`
      + "「问题处理」页拉单会当场报缺配置,需求流程不受影响");
  };
  if (dtsMock && explicitDtsMcpUrl) {
    issueGatewayFault("--dts-mock/--debug-issue 与 --dts-mcp-url 互斥:"
      + "前者是假单据,后者是真网关,别同时配");
  }
  // token 不在启动时读定值——只校验文件在场且非空,之后每次请求经闭包
  // 重读文件。token 在网关侧轮换后服务不用重启;运行时文件被删/不可读
  // 则降级为不带头,让网关 401 显形而不是拖垮整个进程。
  let mcpTokenProvider: (() => string) | undefined;
  if (mcpTokenFile && !dtsDisabledReason) {
    try {
      const initial = readFileSync(mcpTokenFile, "utf-8").trim();
      if (!initial) throw new Error("token 文件为空");
      console.log(`[serve] MCP token 文件(动态读取): ${mcpTokenFile}`);
      mcpTokenProvider = () => {
        try {
          return readFileSync(mcpTokenFile, "utf-8").trim();
        } catch {
          return "";
        }
      };
    } catch (error) {
      issueGatewayFault(`MCP token 读取失败(${mcpTokenFile}): ${String(error)}`);
    }
  }
  if (dtsMcpUrl && !mcpTokenProvider && !dtsDisabledReason) {
    issueGatewayFault("配置了 MCP 网关地址但没有 token:"
      + "请配置 --mcp-token-file(正式服务器为 /etc/mae-flow-cloud/mcp-token)");
  }
  let issueDts: DtsGateway | undefined;
  let mcpGateway: McpGateway | undefined;
  if (dtsDisabledReason) {
    // 已经如实记过账,这里只是不接线;issueDtsGateway 会落到占位网关。
  } else if (dtsMock) {
    issueDts = new MockDtsGateway((message) => console.log(`  [issue-dts] ${message}`),
      debugSetup?.dtsTicketFile);
    console.log(`[serve] 问题流 DTS 网关: DEV·模拟(${debugIssue
      ? "--debug-issue 调试专属单据 " + debugSetup?.dtsTicketFile
      : "--dts-mock,单据来自 assets/mock/dts-tickets.json"}`
      + ",改完点刷新即生效,页签有 DEV 标识)");
  } else if (dtsMcpUrl && mcpTokenProvider) {
    mcpGateway = new McpGateway({
      url: dtsMcpUrl, tokenProvider: mcpTokenProvider,
      log: (message) => console.log(`  [issue-dts] ${message}`),
    });
    issueDts = new McpDtsGateway(mcpGateway);
    console.log(`[serve] 问题流 DTS 网关: ${dtsMcpUrl}`
      + (explicitDtsMcpUrl ? "" : "(站点缺省地址,--dts-mcp-url/serve.json 可覆盖)"));
  }
  // 运维工具(拉日志/换库):在场即接上,凭据由保险箱解密后经环境
  // 变量注入子进程(见 src/issueFlow/opsTools.ts)。
  const goToolsDir = join(REPO_ROOT, "assets", "ops-tools");
  // 未配置也挂 fail-loud 占位:问题服务的工具取数与路由直连的拉单都
  // 走同一个网关实例,未配置时由占位网关说人话,不静默 404。
  const issueDtsGateway = issueDts ?? new UnconfiguredDtsGateway();
  const issueLog = (message: string) => console.log(`  [issue] ${message}`);
  // issue-only 下假通知服务起不来时 endpoint 缺席:通知器整个不接
  // (notifier 是可选项),不让它变成问题流的启动依赖。
  const notifier = lubanEndpoint
    ? new Notifier({
        endpoint: lubanEndpoint,
        headers: lubanHeaders,
        fake: lubanIsFake,
        mobileApproval: lubanPluginReplies,
        approvalCode: lubanPluginReplies && lubanPluginToken
          ? (input) => lubanApprovalCode({ token: lubanPluginToken, ...input })
          : undefined,
        // 发起人的通知令牌:普通任务提醒是自己发给自己；主动邀请检视时，
        // 用责任人的令牌向所选 Committer 工号发送，不要求收件人配令牌。
        personalToken: (account) => auth.lubanToken(account),
        ...(lubanTemplateWaiting || lubanTemplateOutcome || lubanTemplateReview
          ? {
              templates: {
                ...(lubanTemplateWaiting
                  ? { waiting: lubanTemplateWaiting } : {}),
                ...(lubanTemplateOutcome
                  ? { outcome: lubanTemplateOutcome } : {}),
                ...(lubanTemplateReview
                  ? { review: lubanTemplateReview } : {}),
              },
            }
          : {}),
      })
    : undefined;
  const issueFlow = new IssueFlowService({
    dataDir, provider, model, modelsJson, settings,
    // 知识检索与需求侧共享同一 KnowledgeSearch(全进程一个 memsearch
    // 常驻子进程)。晚绑定:service 在下方才构造,闭包只在会话回合
    // 时调用(ADR-0062)。
    knowledgeSearch: () => service.getKnowledgeSearch(),
    // 必须等统一容器清扫完成后再恢复并启动；否则构造期恢复出的新 issue
    // 容器可能被紧随其后的“上次进程孤儿清扫”误杀。
    deferRecovery: true,
    // 检视回复发布时代点"已解决"(--resolve-discussions):默认关,
    // resolve 归检视人(与需求交付同一面旗,2026-09-08 问题流接入)。
    ...(resolveDiscussions ? { resolveDiscussions } : {}),
    // 问题处理介入档位(ADR-0019,个人设置按流剥离,现读现判):闸
    // 策略、提示词节奏与推送过目全部由档位派生——三档优先对齐,二档
    // 只停在分析报告,一档全自动;缺省二档。
    interventionTier: (account) => auth.issueInterventionTier(account),
    gitCredential: (account) => auth.gitCredential(account),
    // 个人模型网关(ADR-0068):问题会话按责任人现取,配齐即整体换装。
    personalModels: (account) => auth.personalModels(account),
    // 登记指派校验(ADR-0031):责任人是存在的普通开发账号才放行——
    // 管理员不写问题会话,指派即造死会话。
    userRole: (username) => auth.roleOf(username),
    opsToolsDir: existsSync(join(goToolsDir, process.platform === "win32"
      ? "fetch-logs.exe" : "fetch-logs-linux-amd64"))
      ? goToolsDir
      : undefined,
    dts: issueDtsGateway,
    // MR 与需求交付共用同一交付平台适配层(--platform)。
    ...(platformUrl ? { platformUrl } : {}),
    // 调试形态(--debug-issue)的进程内交付平台假件;显式 --platform 优先。
    ...(debugSetup && !platformUrl
      ? { platformUrl: debugSetup.platformUrl } : {}),
    // 调试形态(--debug-issue):会话技能物化后换装假抓日志引擎。
    ...(debugSetup
      ? { debugIssue: { opsMockBinDir: debugSetup.opsMockBinDir } } : {}),
    // 不可修工具名单(--unfixable-tools,需求交付同一面旗同一语义):
    // 问题流红灯分诊用——失败项全部落在名单内时不派发修复回合,停表
    // 请人在交付平台处理/豁免。缺席=不分诊,行为照旧。
    ...(unfixableTools.length ? { unfixableTools } : {}),
    // 视觉旁路与需求侧共用同一对旗标(--vision-provider/--vision-model):
    // 配齐才透传,问题会话由此获得 inspect_image;缺席一切照旧。
    ...(visionProvider && visionModel
      ? { vision: { provider: visionProvider, model: visionModel } } : {}),
    maxConcurrentTurns: Number(flag("--issue-max-turns") ?? "10"),
    // 环境预热与需求侧同条件启用(host + 统一任务容器):拉仓收口进
    // analyze 时后台编译基线、焐热分仓缓存,修复阶段少一次全量冷启。
    // fail-open 旁路,缺席(测试/无隔离形态)不预热,行为照旧。
    ...(host && isolateImage ? { warmup: { enabled: true } } : {}),
    ...(isolateImage
      ? {
          isolation: {
            image: isolateImage,
            volumes: flags("--isolate-volume"),
            // 与 taskService 同一 cacheRoot(2026-09-01):issueFlow 容器内
            // build_deploy 要跑 mvn,没缓存挂载就找不到 parent POM。
            cacheRoot: isolateCacheRoot,
            memory: isolateMemory,
            cpus: isolateCpus,
            ...(containerUser.user ? { user: containerUser.user } : {}),
            pidsLimit: isolatePids,
            network: isolateNetwork,
            environment: { ...(isolateHome ? { HOME: isolateHome } : {}),
              ...(isolateNpmRegistry ? { npm_config_registry: isolateNpmRegistry } : {}) },
          },
        }
      : {}),
    log: issueLog,
    // 通知服务通知是公共能力:问题流 AI 举卡等决策时也提醒归属用户
    // (与需求侧同一实例;--issue-only 专用部署同样接线)。
    ...(notifier ? { notifier } : {}),
    // 通知深链落到问题会话工作台 /issues/<id>(与需求侧 /work 同一地位)。
    linkBase: publicUrl,
  });
  // 复用同一执行器；工具使用独立存储与接口，不接 DTS 网关或交付通知。
  const pipelineRepairs = issueFlow.createPipelineRepairTool();

  if (issueOnly) {
    console.log("[serve] 问题流专用模式(--issue-only):需求流程停用"
      + "(发起任务入口会被拦截,在途需求任务不拉起);"
      + "「问题处理」全功能可用");
  }

  // 任务日志环形缓冲(诊断包切片用):进程存活期间保留最近几千行。
  const taskLogRing: string[] = [];
  const deploymentRuntime = inspectDeploymentRuntime();
  const service = new TaskService({
    dataDir, provider, model, modelsJson, maxConcurrent, settings,
    autoArchitecture: !demoMode,
    deploymentRuntime,
    ...(memsearchPython ? { memory: {
      python: memsearchPython,
      script: join(REPO_ROOT, "harness", "memsearch-sidecar.py"),
      milvusPath: join(dataDir, "memsearch", "milvus.db"),
    } } : {}),
    ...(issueOnly ? { requirementDisabled: true } : {}),
    vision: visionProvider && visionModel
      ? { provider: visionProvider, model: visionModel } : undefined,
    // 个人 Git 令牌(界面只写不读):任务启动时按归属人取,经
    // credential helper 注入;没配的用户走部署级访问方式。
    gitCredential: (account) => auth.gitCredential(account),
    // 个人模型网关(ADR-0068,个人设置自助配):会话启动解析时按归属人
    // 现取,配齐则名下任务的主模型调用整体走它;没配走平台网关。
    personalModels: (account) => auth.personalModels(account),
    platformGitCredential: () => {
      const tokenFile = flag("--codehub-token-file");
      if (!tokenFile) return undefined;
      try {
        const password = readFileSync(tokenFile, "utf8").trim();
        return password ? { username: "oauth2", password } : undefined;
      } catch { return undefined; }
    },
    // 月光模式(需求侧独立的「人工介入程度·需求交付」过程轴):
    // 每张卡到达时现读——开着的直行,关了的恢复审批。
    moonlight: (account) => auth.moonlightEnabled(account),
    // push 前清单过目(需求侧独立的交付轴):同样现读个人默认(真人缺省即开)。
    pushConfirmation: (account) => auth.pushConfirmationEnabled(account),
    collaborationAssigneeReadiness: (account) => {
      const needs = {
        git_token: !!host,
        luban_token: notifier?.needsPersonalToken() ?? false,
      };
      return auth.collaborationAssignees(needs)
        .find((candidate) => candidate.username === account)
        ?? { ready: false, missing: ["账号不存在或不是可用开发账号"] };
    },
    // 2026-08-28 摘除 demoContract:那是阶段一的演示桩("rm -rf"裸子串
    // 一律拒),却一直接在生产兜底位——prepush 构建产物删除白名单放行后
    // 被它照拒,死循环还收口成 code_failure 冤枉代码。危险命令的真裁决
    // 在内核 gate(bash-recursive-delete 等)与 prepush 安全层,宿主不再
    // 叠一层无出路的子串匹配。
    host,
    // 资产定制只读标准目录，不等同于启用内核代码执行。
    workflowCatalogRoot: kernelRoot,
    delivery,
    // 环境预热编译:隔离模式显式开启(缺席即关,测试形态零意外会话)。
    warmup: host && isolateImage ? { enabled: true } : undefined,
    // 仅启用按需验证工具；常规交付不自动启动，预热独立保留。
    prepush: host ? {
      enabled: true,
      buildSlots,
      ...(prepushAttemptTimeoutMinutes !== undefined
        ? { attemptTimeoutMs: prepushAttemptTimeoutMinutes * 60_000 } : {}),
      ...(prepushBuildTimeoutMinutes !== undefined
        ? { buildCommandTimeoutMs: prepushBuildTimeoutMinutes * 60_000 } : {}),
    } : undefined,
    workspaceRetentionDays: retentionDays,
    buildCacheRetentionDays,
    buildCacheMaxGb,
    commitConvention,
    isolation: isolateImage
      ? {
          image: isolateImage,
          volumes: flags("--isolate-volume"),
          cacheRoot: isolateCacheRoot,
          memory: isolateMemory,
          cpus: isolateCpus,
          user: containerUser.user,
          pidsLimit: isolatePids,
          network: isolateNetwork,
          environment: { ...(isolateHome ? { HOME: isolateHome } : {}),
            ...(isolateNpmRegistry ? { npm_config_registry: isolateNpmRegistry } : {}) },
        }
      : undefined,
    ...(notifier ? { notifier } : {}),
    projection,
    // 正式部署建议固定 public-url；未配置时，服务会从已登录用户的
    // 实际请求 Host 学到内网入口，绝不再默认写死 127.0.0.1。
    linkBase: publicUrl,
    // 任务日志除了进 stdout,还进内存环形缓冲——诊断包(问题定位
    // 一键采集)靠它切最近日志;进程重启缓冲清零,历史看 stdout 归档。
    log: (message) => {
      const line = `${new Date().toISOString()} [task] ${message}`;
      console.log(`  [task] ${message}`);
      taskLogRing.push(line);
      if (taskLogRing.length > 4000) {
        taskLogRing.splice(0, taskLogRing.length - 2000);
      }
    },
    recentLog: () => [...taskLogRing],
  });
  const startup = new StartupRecovery();
  const stopDiagnostics = await startStartupDiagnostics(console.log, () => ({
    startup: startup.state, postgres: projection?.diagnostics(),
    system_check: service.systemCheckStatus(), requests: pendingHttpRequests(),
  }));
  const restoreTasks = async () => {
    const trace = new SystemCheckTrace(message => console.log(message.replace("[system-check]", "[startup-phase]")));
    try {
    const platformCheck = await trace.phase("platform", () => service.refreshDeliveryPlatformCheck());
    const runtimeLog = deploymentRuntime.status === "error"
      ? console.error : console.log;
    runtimeLog(`[serve] Linux 部署自检(${deploymentRuntime.status}): `
      + deploymentRuntime.detail
      + (deploymentRuntime.suggestion ? `；${deploymentRuntime.suggestion}` : ""));
    if (platformCheck) {
      const platformLog = platformCheck.ready ? console.log : console.error;
      platformLog(`[serve] 交付平台预检(${platformCheck.ready ? "ok" : "error"}): `
        + platformCheck.detail
        + (platformCheck.suggestion ? `；${platformCheck.suggestion}` : ""));
    }
    // 先清理本 dataDir 实例上次崩溃遗留的 coding/prepush/system-check/
    // issue 容器，再恢复两类任务。顺序不能反：recover 一旦入队就可能
    // 启动新容器，随后清扫会把新旧现场混在一起。
    const swept = await trace.phase("orphan_containers", () => service.sweepOrphanContainers());
    if (swept.removed.length) {
      console.log(`[serve] 已清理遗留任务容器 ${swept.removed.length} 个: `
        + swept.removed.join(", "));
    }
    await trace.phase("issue_recovery", async () => { issueFlow.start(); pipelineRepairs.start(); });
    // 进程可死任务不死:重启后重建索引,在跑的任务续跑,等人的继续等。
    const recovered = await trace.phase("task_recovery", async () => service.recover());
    if (recovered.restored) {
      console.log(`[serve] 恢复任务 ${recovered.restored} 个`
        + `(重新入队 ${recovered.requeued} 个)`);
    }
    } finally { trace.finish(); }
  };
  const lubanApproval = lubanPluginToken
    ? new LubanApprovalGateway([
        // 需求任务与问题会话的等待卡同一部手机都能答:问题会话经
        // 适配层投影(list 现查、decide 转 answer),审批真相各自
        // 只在自家一处,网关不认识两个域的差别。
        service,
        new IssueFlowLubanApproval(issueFlow),
      ], {
        token: lubanPluginToken,
        accountEnabled: (account) => !!auth.sessionView(account),
        ...(notifier ? {
          recentNotification: (account) => notifier.latestApproval(account),
        } : {}),
        log: (message) => console.log(`  [luban-plugin] ${message}`),
      })
    : undefined;
  // 现场与构建缓存回收:启动扫一次(服务可能停了很久),之后每天一次。
  // 缓存体积扫描/递归删除全部异步，不能重演同步磁盘 I/O 拖死 HTTP。
  // 纯旁路 fail-open；unref() 不成为进程不肯退出的理由。
  let storageSweepActive = false;
  const sweepStorage = async () => {
    if (storageSweepActive) return;
    storageSweepActive = true;
    // 保留期一次读定:两流同一旋钮,一次清扫内不许读出不同的值。
    const retentionDays = service.workspaceRetentionDays();
    try {
      const swept = service.reclaimIdleWorkspaces();
      if (swept.reclaimed) {
        console.log(`[serve] 现场回收 ${swept.reclaimed} 个任务,`
          + `释放 ${humanBytes(swept.freed)}(保留期 `
          + `${retentionDays} 天;台账与证据保留)`);
      }
    } catch (error) {
      console.log(`[serve] 现场回收失败(不影响服务): ${String(error)}`);
    }
    // 问题会话的现场回收(ADR-0073)走两段:终态当场清与兜底清扫都挂在
    // IssueFlowService(当场在归档入口,兜底在 issueDiskSweep 定时器,
    // 判据单点住在 judgeIssueReclaim)——这里只剩附件中转的孤儿 GC;
    // 图片中转是回显依赖,永不入清扫。
    try {
      const sweptStaging = sweepIssueAttachmentStaging(dataDir,
        { retentionDays });
      if (sweptStaging.removed) {
        console.log(`[serve] 附件中转清理 ${sweptStaging.removed} 个孤儿文件,`
          + `释放 ${humanBytes(sweptStaging.freed)}(保留期 `
          + `${retentionDays} 天;已提交的在会话工作区,不受影响)`);
      }
    } catch (error) {
      console.log(`[serve] 附件中转清理失败(不影响服务): ${String(error)}`);
    }
    try {
      if (service.buildCacheRetentionDays() > 0 || service.buildCacheMaxGb() > 0) {
        const swept = await service.reclaimIdleBuildCaches();
        if (swept.reclaimed) {
          console.log(`[serve] 构建缓存回收 ${swept.reclaimed} 个仓库分区，`
            + `释放 ${humanBytes(swept.freed_bytes)}`);
        }
      }
    } catch (error) {
      console.log(`[serve] 构建缓存回收失败(不影响服务): ${String(error)}`);
    } finally {
      storageSweepActive = false;
    }
  };
  // 回收首轮在任务恢复后再启动，不能把同步磁盘扫描夹在 HTTP 监听之前。
  if (retentionDays === 0) {
    console.log("[serve] 现场保留期配置为 0:永不回收,dataDir 需自行看管");
  }

  // 环境台账探活(#151,ADR-0020):约 10 分钟一轮全量扫描(环境变量
  // MFC_ENVIRONMENT_PROBE_INTERVAL_MS 可覆盖),按条目后台密码以
  // operator 发起 SSH 认证,三态写回。与现场回收同一套旁路纪律:逐条
  // 串行、单条失败只记日志不抛;unref() 不阻进程退出。定时器只接在
  // 正式入口 serve.ts——createTaskServer(测试/旁路直连形态)不带任何
  // 定时器,测试环境永不起新轮询。
  startEnvironmentProbePolling({
    registry: new EnvironmentRegistry(dataDir),
    log: (message) => console.log(`  [env-probe] ${message}`),
  });

  // 问题流磁盘清扫(磁盘治理票 01/03;ADR-0073 扩为终态当场制的兜底):
  // 启动 1 分钟后首跑(让恢复先落定)清存量欠账,此后每小时一轮。
  // 终态(canceled/archived)按保留名单清 repo/ 与名单外全部,崩溃缺口
  // 与存量见一个清一个;idle/waiting_user 按冷却期回收构建产物;旋钮关
  // 则空转。两条流各自扫自己的根(issues/ 与 pipeline-repairs/)。定时器
  // 只接在正式入口 serve.ts——测试/旁路直连形态不起定时器,要清扫直接调
  // sweepTerminalRepos()。
  const issueDiskSweep = () => {
    for (const [label, flow] of [["issue", issueFlow],
                                 ["mr-repair", pipelineRepairs]] as const) {
      void flow.sweepTerminalRepos().then((result) => {
        if (result.reclaimed > 0 || result.productBytes > 0
            || result.looseBytes > 0) {
          console.log(`  [issue-disk] ${label} 清扫回收终态现场 `
            + `${result.reclaimed} 个(${(result.bytes / 1024 ** 3).toFixed(2)} GB)`
            + `,名单外 ${(result.looseBytes / 1024 ** 2).toFixed(0)} MB,构建产物 `
            + `${(result.productBytes / 1024 ** 2).toFixed(0)} MB`);
        }
      }).catch((error) => {
        console.error(`  [issue-disk] ${label} 清扫失败: ${String(error)}`);
      });
    }
  };
  const issueDiskSweepTimer = setTimeout(issueDiskSweep, 60_000);
  const issueDiskSweepInterval = setInterval(issueDiskSweep, 3_600_000);
  issueDiskSweepTimer.unref?.();
  issueDiskSweepInterval.unref?.();

  // 问题流自动接单(ADR-0061;开关在个人设置,缺省关闭):定时扫描
  // 已开启自动接单的责任人名下的 DTS 单,同尺校验全过才发起,发不了
  // 静默跳过落审计。间隔旋钮现读现判(缺省半小时,0=暂停——个人开关
  // 原样保留,恢复即续),单飞防重入;纯旁路 fail-open,unref() 不阻
  // 进程退出。只接正式入口——测试/旁路直连形态不起定时器,要扫描
  // 直接调 runAutoClaimTick。
  startAutoClaimScheduler({
    dts: issueDtsGateway,
    issueFlow,
    auth,
    settings,
    log: (message) => console.log(`  ${message}`),
  });

  // 正式前端:--web <dist> 显式指定;web/dist 存在时自动接上
  // (构建过就用正式版,没构建就是零构建演示页,永远有页面可开)。
  const webRoot = flag("--web")
    ?? [join(REPO_ROOT, "web", "dist")].find((dir) =>
         existsSync(join(dir, "index.html")));
  if (webRoot) console.log(`[serve] 正式前端: ${webRoot}`);
  warnStaleWeb(webRoot);
  // --host 0.0.0.0 = 暴露给内网同事用(默认只听本机回环——不声明
  // 就不上网,是姿态不是疏忽)。暴露时登录/权限本来就在,但要认两条:
  // 内网是明文 http(会话 cookie 可被同网段嗅探,正式部署前加反代
  // TLS);工作机合盖=全员断线,它是工作站不是服务器。
  const server = createTaskServer(service, {
    webRoot, auth, lubanApproval, lubanKnowledgeToken: lubanPluginToken, issueFlow, pipelineRepairs, mcpGateway,
    // 问题路由直连所需的 DTS 网关与台账日志(与问题服务同一实例/口径)。
    dts: issueDtsGateway,
    log: issueLog,
    buildHash, startup,
  });
  let terminating = false;
  const terminate = async (signal: "SIGTERM" | "SIGINT") => {
    if (terminating) return;
    terminating = true;
    await stopDiagnostics();
    console.log(`[serve] 收到 ${signal}，停止接单并清理会话/任务容器...`);
    // Docker 默认只给 10 秒优雅退出。任务容器清理或外部连接偶发卡住
    // 时，旧进程会在 release() 之前被 SIGKILL，下一容器便被陈旧锁永
    // 久挡住。提前两秒做最后兜底：先撒锁、立即退出；残留的受管容器
    // 会由下一实例按同一 dataDir 指纹清扫，绝不与旧进程并行运行。
    const forcedExit = setTimeout(() => {
      console.error("[serve] 优雅关闭超过 8 秒，释放实例锁后退出；"
        + "残留任务容器将由下一实例接管清扫");
      try {
        instanceLock.release();
      } catch (error) {
        console.error(`[serve] 超时释放数据目录锁失败: ${String(error)}`);
      }
      process.exit(1);
    }, 8_000);
    forcedExit.unref();
    const closed = new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    let exitCode = 0;
    try {
      await service.shutdown();
      await issueFlow.shutdown();
      await pipelineRepairs.shutdown();
      console.log("[serve] 所有任务会话与容器已确认释放；业务状态保持不变，"
        + "下次启动将继续恢复");
    } catch (error) {
      exitCode = 1;
      console.error(`[serve] 优雅关闭未完全成功: ${String(error)}`);
      if (error instanceof AggregateError) {
        error.errors.forEach((cause, index) => {
          console.error(`[serve] 关闭失败 ${index + 1}: ${String(cause)}`);
        });
      }
    }
    // SSE/keep-alive 连接不会自行让 server.close 回调；业务资源清完后
    // 再断开这些纯读连接，保证 systemd stop 不悬挂。
    server.closeAllConnections?.();
    await closed;
    await projection?.close().catch((error) => {
      exitCode = 1;
      console.error(`[serve] PostgreSQL 投影关闭失败: ${String(error)}`);
    });
    // 最后才撒手:锁在容器确认释放之前松开,下一个实例会去清扫还没
    // 死透的容器。释放本身不许把退出码带坏——留个陈旧锁下次能接管,
    // 但拿不到退出码会让 systemd 误判。
    try {
      instanceLock.release();
    } catch (error) {
      console.error(`[serve] 释放数据目录锁失败(下次启动会自动接管): ${String(error)}`);
    }
    clearTimeout(forcedExit);
    process.exit(exitCode);
  };
  process.once("SIGTERM", () => { void terminate("SIGTERM"); });
  process.once("SIGINT", () => { void terminate("SIGINT"); });
  // 监听失败要说人话就退。没有这个处理器时 EADDRINUSE 会作为未捕获的
  // error 事件把进程炸掉,现场只剩一段栈——实战里表现为"服务莫名其妙
  // 挂了",而真相往往只是上一次的进程还占着端口。
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`[serve] 端口 ${port} 已被占用:上一次的服务可能还在跑。`
        + `\n  查:lsof -i :${port} 或 ss -lptn 'sport = :${port}'`
        + `\n  然后停掉它,或换一个 --port 重启`);
    } else {
      console.error(`[serve] 监听失败(${error.code ?? "未知"}): ${error.message}`);
    }
    process.exit(2);
  });
  await new Promise<void>((listening) => server.listen(port, bindHost, () => {
    const actual = (server.address() as AddressInfo).port;
    console.log(`[serve] http://${bindHost}:${actual}  (数据目录 ${dataDir})`);
    if (publicUrl) console.log(`[serve] 通知访问地址:${publicUrl}`);
    if (bindHost !== "127.0.0.1") {
      console.log("[serve] 已对外监听:同事经内网 IP 访问;明文 http,"
        + "正式部署前套反代 TLS");
    }
    console.log("[serve] 前台进程:关掉这个终端/断开 SSH 服务就没了。"
      + "长期跑请用 tmux 或 systemd(部署手册「启动与守护」)");
    listening();
  }));
  if (await startup.run(restoreTasks, console.error) && !terminating) {
    setImmediate(() => void sweepStorage());
    setInterval(() => void sweepStorage(), 24 * 60 * 60_000).unref();
  }
}

/** 前端构建过期就明说。
 *
 * `web/dist` 是 gitignore 的(构建产物不进仓),所以**拉了新代码不重新
 * 构建,页面就还是旧的**——而页面不会自己声明版本,人只会觉得"这个功能
 * 坏了/点不了",其实是他手上那份前端根本没有这段代码(内网实测:界面
 * 是 25 个提交之前构建的)。零构建是本仓的原则,但 web/ 是唯一例外,
 * 这一句提醒就是那个例外的守卫。
 *
 * fail-open:读不到时间戳(权限/文件系统怪)就不说话,绝不挡启动。 */
function warnStaleWeb(webRoot: string | undefined): void {
  if (!webRoot) return;
  try {
    const built = statSync(join(webRoot, "index.html")).mtimeMs;
    const srcDir = join(REPO_ROOT, "web", "src");
    if (!existsSync(srcDir)) return;   // 只带 dist 的发布件:没源码可比
    let newest = 0;
    for (const name of readdirSync(srcDir)) {
      const at = statSync(join(srcDir, name)).mtimeMs;
      if (at > newest) newest = at;
    }
    if (newest > built) {
      console.log("[serve] ⚠ 前端构建比源码旧:页面上看到的是上一次构建的"
        + "版本(新功能会像\"坏了/点不了\")。修:cd web && npm run build,"
        + "然后刷新浏览器(强制刷新 Cmd/Ctrl+Shift+R)");
    }
  } catch { /* 比不出来就不说话:提醒是旁路,不许挡启动 */ }
}

/** 清掉上一个进程遗留的 git 凭据现场。
 *
 * host-git/issue-git 每次动 git 都在 .runtime 下开 operation-* 私有
 * 目录,里面躺着**明文个人令牌**;正常路径 finally 里删,kill -9 不给
 * finally 机会——不扫的话每次硬重启都往磁盘上多留一份长期明文凭据
 * (2026-08-29 部署审计实锤)。只删"够老"的:推送走 detached 进程组,
 * 服务死了 git 可能还在传输预算内收尾,扫早了等于拔它的凭据。
 * 纯旁路:任何一步失败只记日志,绝不拦启动。 */
function sweepStaleGitRuntime(dataDir: string): void {
  const cutoff = Date.now() - GIT_RUNTIME_RETENTION_MS;
  for (const lane of ["host-git", "issue-git"]) {
    const root = join(dataDir, ".runtime", lane);
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;   // 目录还没建过:无现场可扫
    }
    for (const name of entries) {
      if (!name.startsWith("operation-")) continue;
      const path = join(root, name);
      try {
        const stat = statSync(path);
        if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
        // 只报目录名,凭据内容永不上日志。
        console.log(`[serve] 已清理遗留 git 凭据现场 ${lane}/${name}`);
      } catch (error) {
        console.log(`[serve] 清理 ${lane}/${name} 失败(不拦启动): `
          + String(error));
      }
    }
  }
  // skill 换包的暂存目录同理是 kill -9 遗留(正常路径 finally 里删)。
  // 它没有 detached 写者,不需要年龄闸,起服时全量清。
  try {
    const staging = join(dataDir, "skill-staging");
    for (const name of existsSync(staging) ? readdirSync(staging) : []) {
      rmSync(join(staging, name), { recursive: true, force: true });
      console.log(`[serve] 已清理遗留 skill 暂存 ${name}`);
    }
  } catch (error) {
    console.log(`[serve] 清理 skill 暂存失败(不拦启动): ${String(error)}`);
  }
}


main().catch((error) => {
  console.error("[serve] 启动失败:", error);
  process.exit(1);
});
