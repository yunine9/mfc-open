/**
 * 问题流的环境预热编译(2026-09-04,需求侧 warmupAgent 的移植)。
 *
 * 动机:问题流每个新单现拉仓、现装依赖,容器里第一次 npm install/
 * mvn 就要真下载,环境缺配(证书、源、缓存挂载)全都当场撞上,还把
 * 冷启等待算进修复时长。预热专员在拉仓完成、主 Agent 转入分析时,
 * 于同一个任务容器里另起专职会话把基线编译一遍:验证环境真能编译、
 * 焐热分仓持久缓存、把构建入口沉淀进 build-notes 供修复阶段复用。
 *
 * 定位与需求侧一致:fail-open 观测旁路——预热失败绝不打断主流程,
 * 收据如实记账,不构成任何交付证据(编译权威仍是流水线验绿门)。
 * 收口报告沿用需求侧的 <warmup-result> JSON 协议与解析器。
 */

import { MAE_FIRST_BUILD_GUIDANCE } from "../maeBuildSupport.ts";
import { WARMUP_NOTES_PATH } from "../warmupAgent.ts";

export type IssueWarmupStatus = "passed" | "failed" | "infrastructure_failure";

/** 预热执行请求:workspace = 会话工作区根(repo/ 在其下)。 */
export interface IssueWarmupRequest {
  workspace: string;
}

/** 预热执行器结果。测试注入 runner 时用;原生执行器内部转
 * <warmup-result> 报告(同一形状)。 */
export interface IssueWarmupOutcome {
  status: IssueWarmupStatus;
  message?: string;
  build_command?: string;
}

export type IssueWarmupRunner = (
  request: IssueWarmupRequest,
) => Promise<IssueWarmupOutcome>;

/** 状态台账里的预热收据(需求侧 baseline_build 的问题流形态)。 */
export interface IssueWarmupReceipt {
  status: IssueWarmupStatus | "running";
  started_at: string;
  finished_at?: string;
  detail?: string;
  build_command?: string;
}

export function issueWarmupMission(budgetMinutes: number): string {
  return [
    "# 环境预热编译任务(问题会话)",
    MAE_FIRST_BUILD_GUIDANCE,
    "只编译登记的业务仓；MAEStarterParent、MAEServiceBuild、MAEBuild、DeployBuildTool 是平台辅助仓，不是待验证业务仓。",
    "",
    "你是环境预热编译专员。代码仓刚克隆到 `repo/<仓名>/`,主 Agent 正在",
    "分析问题,还没人改代码。你要做三件事:",
    "",
    "1. **验证基线在本环境能编译**:遍历 `repo/` 下每个代码仓,按仓库",
    "   真实构建入口(pom/gradle/package.json/CMake/Makefile/CI 脚本自己",
    "   找)执行首次构建。刚克隆的仓不需要 clean——直接编译。",
    "   C++ 仓首次编译必须先执行 `mvn generate-sources -DDT_test=UT`,再执行",
    "   `mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT`;后一条命令同时完成编译",
    "   和全量 UT。使用首编包装器时用 `bash -c '<generate-sources> && <compile>'`,",
    "   不额外拼接 ctest,不去掉 DT_test=UT,不添加模块/suite/case 等定向筛选,",
    "   必须把 UT 全部跑一遍,并从输出确认全量 UT 结果。",
    "   前端仓的依赖安装也是预热的一部分:它往往是 JS 仓最重的一步。",
    "2. **焐热构建缓存**:正常编译即达成,依赖会进平台按仓持久缓存",
    "   (/cache/maven、/cache/npm、/cache/ccache),后续修复阶段的增量",
    "   编译因此变快——不要为省时间跳过依赖解析。",
    `3. **沉淀构建入口**:把验证过的编译命令与注意事项写入 ${WARMUP_NOTES_PATH}`,
    "   (Markdown,按仓分节,一条命令一行,注明执行目录),修复阶段的",
    "   Agent 会先读它。样例:",
    "   ```",
    "   ## <份数>",
    "   - 首次打包(仓库根): mvn package -DskipTests",
    "   - 增量编译(仓库根): mvn compile   # 日常自检用这条",
    "   - C++ 首编(仓库根): mvn generate-sources -DDT_test=UT && mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT",
    "   - 注意: website/ 需先 npm install --legacy-peer-deps,Maven 不代劳",
    "   ```",
    "",
    "红线:",
    `- 除 ${WARMUP_NOTES_PATH} 外**不修改、不创建任何文件**;依赖安装与构建产物由构建工具自然产生,不算你改的。`,
    "- **不执行任何 git 写操作**(add/commit/checkout/restore/clean 都不许;只读命令可用)。修复阶段要做真正的提交,你弄脏 git 状态就是给它添乱。",
    "- **辅助仓是只读基座**:repo/ 下的 MAE 辅助仓(MAEStarterParent/MAEServiceBuild/MAEBuild/DeployBuildTool)只供编译参照;构建链要在其下落产物时(签名工具改写 config、__pycache__ 等),重定向到业务仓或 /tmp——把它们的工作树写脏,重启续跑的完整性校验会把整个会话卡死。",
    `- Agent 平台目录(.mae-flow-work/ 下的只读投影)可能由平台注入,只读使用,不修改、不删除;你能写的只有 ${WARMUP_NOTES_PATH}。`,
    "- **基线代码红了不许修**——多仓问题里其他仓可能已在修复分支上,你只评判刚克隆的基线;编译失败如实报告就是你的交付。",
    "",
    "失败分类:命令缺失、依赖仓/网络/证书/磁盘问题报 infrastructure_failure;",
    "代码本身编译错误或 C++ 全量 UT 失败报 failed,并附前几条错误原文(带文件路径/用例名)。",
    "全部仓完成各自首编要求后报 passed。",
    "",
    `预算 ${budgetMinutes} 分钟。到点前必须收口:最后一行输出单行 JSON 的报告,`,
    "格式: <warmup-result>{\"status\":\"passed|failed|infrastructure_failure\",",
    "\"message\":\"一句话\",\"build_command\":\"可选,主编译命令\"}</warmup-result>",
  ].join("\n");
}
