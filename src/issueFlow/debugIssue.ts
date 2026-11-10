/**
 * 问题流调试形态(--debug-issue)——本机全链仿真的单一开关。
 *
 * 定位:把问题会话依赖的全部外部触点落到本机,让"从 DTS 列表发起一路
 * 跑到 MR 全绿收口"在没有 DTS/CodeHub/网管环境的机器上完整可走:
 * - 远端代码仓:把指定本机仓做 bare 镜像(纯只读,源仓零接触),
 *   克隆源于镜像、推送落回镜像(推送目标必须是 bare,git 才收);
 * - 交付平台:复用 FakeGitPlatform(与 --fake-platform 同一件,默认
 *   恒绿),问题流消费的 /mr、/mr/gates、/mr/discussions、pipeline
 *   trigger/status、/pipeline/artifacts 它全都在;多仓路由按"裸仓
 *   必须在主裸仓同目录下"的既定边界,镜像目录天然满足;
 * - DTS 单据:不直接改 assets/mock,调试专属单据文件种在
 *   <dataDir>/debug-issue/dts-tickets.json(MockDtsGateway 指过去);
 * - 网管日志:罐头日志源 + 假 fetch-logs 引擎(会话技能物化后覆盖
 *   bin,成功判据与真引擎一致:退出码 0 + 输出「解压完成」);
 * - 团队资产:幂等播种示例业务模块(绑镜像)与假网管环境条目;
 * - 账号:执行侧接线保证 dev 账号存在并配好 Git 署名(提交不因
 *   "Author identity unknown" 断在修复阶段)。
 *
 * 纪律:旗标缺席时本模块一个函数都不该被调用——所有副作用只在
 * executionRuntime 的 --debug-issue 接线点发生;正式形态零改动。
 * 播种一律幂等:已存在就跳过,不覆盖用户改过的内容。
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BusinessModuleError, createBusinessModule, readBusinessModule,
  updateBusinessModule }
  from "../businessModuleLibrary.ts";
import { EnvironmentRegistry } from "../environmentRegistry.ts";
import { FakeGitPlatform } from "../gitPlatform.ts";

/** 调试形态的目标仓(本机,2026-09-14 拍板):镜像的唯一来源。
 * clone --bare 对源仓纯只读,不写引用不碰工作区。 */
export const DEBUG_ISSUE_REPOS: Array<{ name: string; path: string }> = [
  { name: "example-web", path: "/workspace/code/example-web" },
  { name: "example-service", path: "/workspace/code/example-service" },
];

/** 调试形态的公共组件登记表种子(ADR-0054,2026-09-23):每个条目独立
 * 建镜像(仓名不同于绑定仓),登记表 repository 写镜像路径——问题流的
 * 身份归类与模块订阅快照读的就是这份本地文件,本地路径即可全链闭环。 */
export const DEBUG_ISSUE_COMPONENTS: Array<{
  id: string;
  name: string;
  path: string;
  languages: string[];
  description: string;
}> = [
  {
    id: "debug-common-web-kit",
    name: "公共组件演示·Web 套件",
    path: "/workspace/code/example-web",
    languages: ["TypeScript"],
    description: "排查表格/导出等公共组件行为时读取"
      + "(调试演示条目,镜像 example-web 源)",
  },
];

/** 播种器对账号面的最小依赖(结构化,不绑 LocalAuth 具体类,测试好替身)。 */
export interface DebugIssueAuth {
  gitCredential(username: string | undefined):
    { username: string; password: string; email?: string } | undefined;
  setGitToken(username: string, token: string, gitEmail?: string): void;
}

export interface DebugIssueSetup {
  /** 调试专属 DTS 单据文件(MockDtsGateway 的数据源)。 */
  dtsTicketFile: string;
  /** 罐头日志源目录(假 fetch-logs 从这里复制)。 */
  demoLogsDir: string;
  /** 假抓日志引擎目录(会话技能物化后覆盖 skills/fetch-logs/bin)。 */
  opsMockBinDir: string;
  /** bare 镜像根目录(同时是 FakeGitPlatform 的多仓路由边界)。 */
  remotesDir: string;
  /** 进程内交付平台(FakeGitPlatform)的环回地址。 */
  platformUrl: string;
  /** 已就位的镜像(源仓缺失的会跳过并大声记账)。 */
  mirrors: Array<{ name: string; path: string }>;
  /** 已就位的公共组件登记表条目(镜像路径;ADR-0054)。 */
  components: Array<{ id: string; name: string; path: string }>;
}

function runGit(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile("git", args, { cwd, encoding: "utf-8" },
      (error, stdout) => {
        if (error) reject(new Error(String(error).slice(0, 300)));
        else resolveRun(String(stdout ?? "").trim());
      });
  });
}

/** 源仓 → bare 镜像(幂等:镜像已在就原样复用,续跑的推送历史是真相)。
 * HEAD 显式对齐源仓当前分支——clone --bare 后 HEAD 指向远端 HEAD,
 * 与源仓分支名不符时克隆会得到空工作树(git 只警告不报错)。 */
async function ensureBareMirror(
  source: string, target: string, log: (message: string) => void,
): Promise<void> {
  if (existsSync(join(target, "HEAD"))) return;
  mkdirSync(target, { recursive: true });
  await runGit(target, "clone", "--bare", "--quiet", "--", source, target);
  const head = await runGit(source, "branch", "--show-current") || "master";
  await runGit(target, "symbolic-ref", "HEAD", `refs/heads/${head}`);
  log(`bare 镜像就位: ${source} → ${target}`);
}

/** 调试单据种子:三张量身定制(单仓/单仓/双仓),状态全部落在可发起
 * 的「开发人员实施修改」。正文点名关联仓名与后台服务名——服务名与
 * 罐头日志目录一一对应,AI 按技能 fetch-logs 抓取即中。 */
export const DEBUG_DTS_TICKETS = [
  {
    ticket: "DTS-2026-9001",
    title: "【DEV·调试】example-web 订单导出大数据量超时",
    status: "开发人员实施修改",
    version: "V100R025C10SPC010B009",
    severity: "严重",
    submitter: "debugger",
    description: "<p>订单中心导出 10 万行时网关 504,小数据量正常。"
      + "关联仓 example-web,后台服务 order-export。</p>",
    content: "【DEV·调试单】example-web 订单导出超时\n\n"
      + "现象: 导出 10 万行时网关 504,千行以内正常。\n"
      + "关联仓: example-web(业务模块「调试示例业务」已绑定,直接拉仓即可)\n"
      + "后台服务: order-export(可用技能 fetch-logs 抓日志,--service order-export)\n"
      + "初步定位: 怀疑同步全量加载后串行渲染,等待分析会话定位。",
  },
  {
    ticket: "DTS-2026-9002",
    title: "【DEV·调试】example-service 案件看板轮询报 500",
    status: "开发人员实施修改",
    version: "V100R025C10SPC010B009",
    severity: "一般",
    submitter: "debugger",
    description: "<p>案件看板页每 5 秒轮询接口偶发 500。"
      + "关联仓 example-service,后台服务 case-board。</p>",
    content: "【DEV·调试单】example-service 案件看板轮询 500\n\n"
      + "现象: 看板页轮询接口偶发 500,重启后恢复一段时间。\n"
      + "关联仓: example-service(业务模块「调试示例业务」已绑定)\n"
      + "后台服务: case-board(可用技能 fetch-logs 抓日志,--service case-board)\n"
      + "初步定位: 疑似连接池耗尽,等待分析会话定位。",
  },
  {
    ticket: "DTS-2026-9003",
    title: "【DEV·调试】双仓联动:通知模板变量渲染错位",
    status: "开发人员实施修改",
    version: "V100R025C10SPC010B011",
    severity: "一般",
    submitter: "debugger",
    description: "<p>通知模板变量渲染错位,前端占位与后端字段名不一致。"
      + "涉及 example-web 与 example-service 两个仓,后台服务 notify-render。</p>",
    content: "【DEV·调试单】通知模板变量渲染错位(双仓)\n\n"
      + "现象: 通知正文里 {{userName}} 原样露出,变量没被替换。\n"
      + "关联仓: example-web 与 example-service(业务模块「调试示例业务」已绑定"
      + ",两个仓都要看)\n"
      + "后台服务: notify-render(可用技能 fetch-logs 抓日志,--service notify-render)\n"
      + "初步定位: 前后端字段名不对齐,等待分析会话定位。",
  },
];

/** 罐头日志:目录名 = 服务名(假引擎按 --service 复制同目录)。
 * 内容带像样的报错栈,分析会话 grep 有东西可找。 */
const DEMO_LOG_SERVICES: Record<string, Array<{ file: string; body: string }>> = {
  "order-export": [{
    file: "app.log",
    body: ["2026-09-14 10:00:01 INFO  order-export 收到导出请求 rows=100000",
      "2026-09-14 10:02:31 WARN  query export progress 12%",
      "2026-09-14 10:05:02 ERROR export task timeout after 180s",
      "java.util.concurrent.TimeoutException: export rows=100000 did not finish in 180s",
      "\tat com.demo.order.export.ExportTask.run(ExportTask.java:88)",
      "\tat java.base/java.util.concurrent.Executors$RunnableAdapter.call(Executors.java:572)",
      "2026-09-14 10:05:02 ERROR gateway upstream aborted, respond 504"].join("\n"),
  }],
  "case-board": [{
    file: "service.log",
    body: ["2026-09-14 11:00:00 INFO  case-board board poll",
      "2026-09-14 11:03:17 ERROR poll board failed: connection pool exhausted",
      "org.demo.board.PoolTimeoutException: wait idle connection timeout 30000ms",
      "\tat org.demo.board.ConnectionPool.borrow(ConnectionPool.java:141)",
      "2026-09-14 11:03:17 ERROR http 500 GET /api/board/poll"].join("\n"),
  }],
  "notify-render": [{
    file: "render.log",
    body: ["2026-09-14 12:00:00 INFO  notify-render template render start",
      "2026-09-14 12:00:00 WARN  variable {{userName}} not bound, keep literal",
      "2026-09-14 12:00:00 ERROR render finished with 1 unbound variable(s)",
      "\tat com.demo.notify.render.TemplateEngine.bind(TemplateEngine.java:64)"].join("\n"),
  }],
};

const MOCK_FETCH_LOGS_TEMPLATE = `#!/usr/bin/env bash
# [debug-issue] 假日志抓取引擎:从本机罐头目录复制,不连任何网管环境。
# 与真引擎同款 CLI 面(--service/--local-dir,--host 一律忽略)与同一
# 成功判据:退出码 0 且输出包含「解压完成」(技能 fetch-logs 靠它判成)。
set -u
LOG_SOURCE={{LOG_SOURCE}}
service=""
out="local-logs"
node_suffix="mock-node"
case "$(basename "$0")" in
  fetch-logs-k8s) node_suffix="mock-pod" ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --service) service="\${2:-}"; shift 2 ;;
    --local-dir) out="\${2:-}"; shift 2 ;;
    --host|--single-host|--port|-p) shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$service" ]; then
  echo "[debug-issue] 缺 --service,抓不了(真引擎语义:服务名必填)"
  exit 2
fi
dest="\$out/\${service}_\$(date +%Y%m%d%H%M%S)_\${node_suffix}"
mkdir -p "\$dest"
src="\$LOG_SOURCE/\$service"
if [ -d "\$src" ]; then
  cp -r "\$src"/. "\$dest"/
  echo "[debug-issue] 已从 \$src 复制 \$(find "\$dest" -type f | wc -l) 个文件"
else
  echo "[debug-issue] 罐头里没有服务 \$service(源目录: \$LOG_SOURCE),抓到空目录"
fi
echo "解压完成"
exit 0
`;

/** 播种调试形态的全部本机资产 + 起进程内交付平台。幂等:任何一项已
 * 在场就跳过(改过的调试单/罐头日志/镜像推送历史都不会被覆盖)。 */
export async function setupDebugIssue(options: {
  dataDir: string;
  auth: DebugIssueAuth;
  /** 目标仓(测试注入替身;缺省用 DEBUG_ISSUE_REPOS)。 */
  repos?: Array<{ name: string; path: string }>;
  /** 公共组件登记表种子(测试注入替身;缺省用 DEBUG_ISSUE_COMPONENTS)。 */
  components?: Array<{
    id: string;
    name: string;
    path: string;
    languages: string[];
    description: string;
  }>;
  /** 执行侧保证 dev 账号在场(缺省 true;纯资产播种的测试可关)。 */
  ensureDevAccount?: boolean;
  log?: (message: string) => void;
}): Promise<DebugIssueSetup> {
  const log = options.log ?? (() => {});
  const debugRoot = join(options.dataDir, "debug-issue");
  const remotesDir = join(debugRoot, "remotes");
  const demoLogsDir = join(debugRoot, "demo-logs");
  const opsMockBinDir = join(debugRoot, "ops-mock-bin");
  const dtsTicketFile = join(debugRoot, "dts-tickets.json");
  for (const dir of [debugRoot, remotesDir, demoLogsDir, opsMockBinDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // ① bare 镜像(源仓缺失跳过该仓并大声记账,不挡其余资产)。
  const mirrors: Array<{ name: string; path: string }> = [];
  for (const repo of options.repos ?? DEBUG_ISSUE_REPOS) {
    if (!existsSync(join(repo.path, ".git"))) {
      log(`源仓不存在或不是 git 仓,跳过: ${repo.path}`);
      continue;
    }
    const target = join(remotesDir, `${repo.name}.git`);
    await ensureBareMirror(repo.path, target, log);
    mirrors.push({ name: repo.name, path: target });
  }

  // ①.5 公共组件仓登记表(ADR-0054):组件源仓独立建镜像,登记表
  // repository 写镜像路径——问题流的身份归类与模块订阅快照读同一份
  // 文件,本地路径即可全链闭环。整表每次启动重写:调试形态的登记表
  // 是播种物(与罐头日志"只在缺时写"不同——正式形态的登记表在正式
  // dataDir,互不相干,这里不覆盖任何用户资产)。
  const seededComponents: Array<{ id: string; name: string; path: string }> = [];
  const componentRows: Array<Record<string, unknown>> = [];
  for (const component of options.components ?? DEBUG_ISSUE_COMPONENTS) {
    if (!existsSync(join(component.path, ".git"))) {
      log(`组件源仓不存在或不是 git 仓,跳过: ${component.path}`);
      continue;
    }
    const target = join(remotesDir, `${component.id}.git`);
    await ensureBareMirror(component.path, target, log);
    componentRows.push({
      id: component.id,
      name: component.name,
      repository: target,
      branch: "master",
      path: "",
      languages: component.languages,
      description: component.description,
      enabled: true,
    });
    seededComponents.push({
      id: component.id, name: component.name, path: target,
    });
  }
  if (componentRows.length) {
    writeFileSync(join(options.dataDir, "component-repositories.json"),
      JSON.stringify(componentRows, null, 2) + "\n");
    log(`公共组件仓登记表已播种: ${componentRows.length} 条`
      + "(订阅注入与拉取归类同源)");
  }

  // ② dev 账号的 Git 署名:没有它,宿主模式克隆不写 user.email,
  // 修复阶段 AI 的 git commit 死在 "Author identity unknown"。
  // 只在缺时补,不覆盖用户自己配的令牌/邮箱。
  if (options.ensureDevAccount !== false) {
    try {
      if (!options.auth.gitCredential("dev")) {
        options.auth.setGitToken("dev", "debug-issue-token", "dev@debug.local");
        log("已为 dev 账号补 Git 署名(演示令牌 + dev@debug.local)");
      }
    } catch (error) {
      log(`dev 账号不在(不补署名,提交前请自行配置): ${String(error)}`);
    }
  }

  // ③ 示例业务模块(绑镜像路径;已存在原样保留——用户可能改过绑定)。
  if (mirrors.length > 0) {
    const moduleId = "debug-sample";
    try {
      readBusinessModule(options.dataDir, moduleId);
    } catch (error) {
      if (!(error instanceof BusinessModuleError)) throw error;
      try {
        createBusinessModule(options.dataDir, {
          id: moduleId,
          name: "调试示例业务",
          description: "调试形态(--debug-issue)播种的示例模块:绑定本机"
            + " bare 镜像仓。调试单(DTS-2026-9001~9003)按仓名命中本模块。",
          owner: "dev",
          repositories: mirrors.map((item) => item.path),
          reference_component_repos: seededComponents
            .map((item) => item.id),
        }, "dev");
        log(`示例业务模块已播种: ${moduleId}(绑 ${mirrors.length} 个镜像)`
          + (seededComponents.length
            ? `,订阅 ${seededComponents.length} 个参考组件仓` : ""));
      } catch (seedError) {
        log(`示例模块播种失败(不影响其余资产): ${String(seedError)}`);
      }
    }
    if (seededComponents.length) {
      // 存量示例模块(本特性之前的调试 dataDir)幂等补订阅:差的才补,
      // 已订阅原样跳过;更新失败不挡其余资产。
      try {
        const current = readBusinessModule(options.dataDir, moduleId);
        const wanted = seededComponents.map((item) => item.id);
        const nowHave = current.reference_component_repos ?? [];
        if (wanted.some((id) => !nowHave.includes(id))) {
          updateBusinessModule(options.dataDir, moduleId, {
            reference_component_repos:
              [...new Set([...nowHave, ...wanted])],
          }, "debug-issue");
          log("示例模块已补参考组件仓订阅");
        }
      } catch (error) {
        log(`示例模块补订阅失败(不影响其余资产): ${String(error)}`);
      }
    }
  }

  // ④ 假网管环境条目(环境闸举卡时从台账快选;假引擎根本不连它)。
  const registry = new EnvironmentRegistry(options.dataDir);
  if (!registry.findByIp("127.0.0.1")) {
    registry.create({
      ip: "127.0.0.1",
      port: 22,
      form: "virtualized",
      backendPassword: "debug-issue-demo",
      tags: ["调试形态"],
    }, "debug-issue");
    log("假网管环境已播种: 127.0.0.1(虚拟化,演示密码)");
  }

  // ⑤ 调试专属 DTS 单据文件 + 罐头日志(只在缺时写,内容可随手改)。
  if (!existsSync(dtsTicketFile)) {
    writeFileSync(dtsTicketFile,
      JSON.stringify(DEBUG_DTS_TICKETS, null, 2) + "\n");
    log(`调试 DTS 单据已播种: ${dtsTicketFile}(改完列表页点刷新即生效)`);
  }
  for (const [service, files] of Object.entries(DEMO_LOG_SERVICES)) {
    const dir = join(demoLogsDir, service);
    mkdirSync(dir, { recursive: true });
    for (const item of files) {
      const target = join(dir, item.file);
      if (!existsSync(target)) writeFileSync(target, item.body + "\n");
    }
  }

  // ⑥ 假抓日志引擎(每次重写:罐头路径要跟本次 dataDir 对齐)。
  const script = MOCK_FETCH_LOGS_TEMPLATE
      .replace("{{LOG_SOURCE}}", demoLogsDir);
  for (const name of ["fetch-logs", "fetch-logs-k8s"]) {
    const target = join(opsMockBinDir, name);
    writeFileSync(target, script);
    chmodSync(target, 0o755);
  }

  // ⑦ 进程内交付平台(FakeGitPlatform,默认恒绿):主裸仓取首个镜像
  // ——它的多仓路由边界是"请求 repo 必须在主裸仓同目录下",全部镜像
  // 同住 remotes/ 天然满足;问题流 create_mr 报的 repo 就是镜像路径。
  const platform = new FakeGitPlatform();
  if (mirrors.length === 0) {
    throw new Error("调试形态没有一个可用的 bare 镜像"
      + `(源仓都在吗?${DEBUG_ISSUE_REPOS.map((r) => r.path).join(", ")})`);
  }
  platform.barePath = mirrors[0].path;
  await platform.start();
  log(`交付平台假件已就位(进程内,恒绿): ${platform.baseUrl}`);

  return {
    dtsTicketFile,
    demoLogsDir,
    opsMockBinDir,
    remotesDir,
    platformUrl: platform.baseUrl,
    mirrors,
    components: seededComponents,
  };
}

/** 会话技能物化后的假引擎覆盖:只动工作区 skills/fetch-logs/bin 下两个
 * wrapper(真引擎的架构二进制原样保留,不再被调用)。技能源不变,
 * 旗标缺席时本函数不存在于任何调用路径。 */
export function applyDebugIssueSkillPatch(
  workspace: string, opsMockBinDir: string,
): void {
  const binDir = join(workspace, "skills", "fetch-logs", "bin");
  if (!existsSync(binDir)) return;
  for (const name of ["fetch-logs", "fetch-logs-k8s"]) {
    const source = join(opsMockBinDir, name);
    if (!existsSync(source)) continue;
    const target = join(binDir, name);
    copyFileSync(source, target);
    chmodSync(target, 0o755);
  }
}
