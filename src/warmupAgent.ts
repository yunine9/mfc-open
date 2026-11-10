/**
 * 环境预热编译专员(用户 2026-08-26 拍板:"编译尽量用子 Agent 搞",
 * "开始就爆红是好事")。任务现场就绪后,宿主在**同一个编码容器**里
 * 另起一个专职会话编译基线:验证环境真能编译这个仓、焐热按仓持久
 * 缓存、把发现的构建入口沉淀给编码期子 Agent 与 prepush 复用。
 *
 * 定位是观测旁路:fail-open,结果绝不构成交付证据——COMPILE 核销
 * 仍只在推送前验证与绑 SHA 流水线(不信任务自述红线)。收据绑起跑
 * SHA:基线红=环境或上游的锅,增量红才是 Agent 的锅,责任切得开。
 */

import { MAE_FIRST_BUILD_GUIDANCE } from "./maeBuildSupport.ts";
import { prePushBuildGuidance } from "./prepushBuildPlaybook.ts";
import { describeAgentPlatformRoots } from "./agentPlatformPaths.ts";

export interface WarmupRunRequest {
  taskId: string;
  workspace: string;
  /** 预热起跑时的 HEAD(≈任务基线:此刻 Agent 还在需求澄清,没人动代码)。 */
  sha: string;
}

export type WarmupStatus = "passed" | "failed" | "infrastructure_failure";

export interface WarmupRunResult {
  status: WarmupStatus;
  message: string;
  /** 发现的真实构建命令;同时应已沉淀进 build-notes 供后续复用。 */
  build_command?: string;
}

/** 测试/部署可注入其他执行器;生产缺席时由 Cloud 原生 Pi 会话执行。 */
export type WarmupRunner = (
  request: WarmupRunRequest,
) => Promise<WarmupRunResult>;

export const WARMUP_NOTES_PATH = ".mae-flow-work/build-notes.md";

const RESULT_PATTERN = /<warmup-result>\s*([\s\S]*?)\s*<\/warmup-result>/gi;
const STATUSES: readonly WarmupStatus[] = [
  "passed", "failed", "infrastructure_failure",
];

export function warmupMission(
  request: WarmupRunRequest,
  budgetMinutes?: number,
): string {
  return [
    "# 环境预热编译任务",
    MAE_FIRST_BUILD_GUIDANCE,
    "",
    "你是环境预热编译专员。此刻主 Agent 正在需求澄清,还没人改代码;",
    `当前 HEAD ${request.sha.slice(0, 12)} 就是任务基线。你要做三件事:`,
    "",
    "1. **验证基线在本环境能编译**:按仓库真实构建入口(pom/gradle/",
    "   package.json/CMake/Makefile/CI 脚本自己找)执行首次构建。",
    "   刚克隆的仓不需要 clean——直接编译,别浪费一次全量。",
    "2. **焐热构建缓存**:正常编译即达成,依赖会进按仓持久缓存,",
    "   后续增量编译因此变快——不要为省时间跳过依赖解析。",
    "   前端仓(如 website/)的依赖安装也是预热的一部分:它就是",
    "   JS 仓最重的一步,必须先于 Maven 编译完成。",
    "   Java 仓预热必须跑到 Build-Fix 用的那个生命周期(package -DskipTests):",
    "   只跑 compile/test 不会拉 jar/resources 插件,容器没外网时 Build-Fix 的",
    "   package 会在依赖解析上耗光预算(2026-09-06 跨仓演练门户仓子任务实锤)。",
    "   C++ 仓首次编译必须先执行 `mvn generate-sources -DDT_test=UT` 拉取/生成 UT 依赖,",
    "   再执行 `mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT`;后一条命令会同时",
    "   完成编译并执行全量 UT,不要再额外拼接 ctest,也不允许去掉 DT_test=UT。",
    "   首编不得添加模块、suite、case 或覆盖率范围等定向筛选,必须把 UT 全部跑一遍。",
    "   使用首编包装器时以 `bash -c '<generate-sources> && <compile>'` 作为同一条命令,",
    "   确保准备失败后不会继续。必须从输出确认全量 UT 的执行结果。",
    `3. **沉淀构建入口**:把验证过的编译命令与注意事项写入 ${WARMUP_NOTES_PATH}`,
    "   (Markdown,一条命令一行,注明执行目录),编码期的构建自检",
    "   子 Agent 和 Build-Fix 都会先读它。样例:",
    "   ```",
    "   - 打包检查(仓库根): mvn package -DskipTests   # 与 Build-Fix 同一条:预热就要把 jar/resources 插件拉进缓存",
    "   - 增量编译(仓库根): mvn compile   # 日常自检用这条",
    "   - C++ 首编(仓库根): mvn generate-sources -DDT_test=UT && mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT",
    "   - 注意: website/ 需先 npm install --legacy-peer-deps,Maven 不代劳",
    "   ```",
    "",
    "红线:",
    `- 除 ${WARMUP_NOTES_PATH} 外**不修改、不创建任何文件**;依赖安装与构建产物由构建工具自然产生,不算你改的。`,
    // 下面这条 git 红线靠嘱咐不靠闸:预热复用 prepush 安全层,那层为了
    // 让 prepush 能本地提交,刻意放行 add/commit。预热是 fail-open 观测
    // 旁路,违背嘱咐最多弄脏工作区,不会污染交付(推送另有闸)。
    "- **不执行任何 git 写操作**(add/commit/checkout/restore/clean 都不许;只读命令可用)。",
    `- Agent 平台目录(${describeAgentPlatformRoots()})可能由中心服务临时注入，`
      + "只读使用，不修改、不删除、不提交。",
    "- 基线代码红了**不许修**——那是环境或上游的问题,如实报告就是你的交付。",
    "",
    "失败分类:命令缺失、依赖仓/网络/证书/磁盘问题报 infrastructure_failure;",
    "代码本身编译错误或 C++ 全量 UT 失败报 failed,并附前几条错误原文(带文件路径/用例名)。",
    ...(budgetMinutes
      ? [
          "",
          `墙钟预算约 ${budgetMinutes} 分钟:大仓优先保证编译主链路走通,`
          + "时间紧就少探索多编译;预算内完不成如实收口,别硬撑。",
        ]
      : []),
    "",
    "收尾时输出(必须是最后一条回复,JSON 单行):",
    '<warmup-result>{"status":"passed|failed|infrastructure_failure",'
    + '"message":"一句话结论或错误摘要","build_command":"验证过的编译命令"}'
    + "</warmup-result>",
    "",
    "---",
    "",
    prePushBuildGuidance(request.workspace),
  ].join("\n");
}

/** 解析专员收口报告。多次输出以最后一次为准;解析不动返回 undefined,
 * 由调用方按基础设施故障处理(fail-open,不猜)。 */
export function parseWarmupReport(text: string): WarmupRunResult | undefined {
  let raw: string | undefined;
  for (const match of String(text ?? "").matchAll(RESULT_PATTERN)) {
    raw = match[1];
  }
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const status = String(parsed.status ?? "") as WarmupStatus;
    if (!STATUSES.includes(status)) return undefined;
    const result: WarmupRunResult = {
      status,
      message: String(parsed.message ?? "").slice(0, 600),
    };
    if (parsed.build_command) {
      result.build_command = String(parsed.build_command).slice(0, 400);
    }
    return result;
  } catch {
    return undefined;
  }
}
