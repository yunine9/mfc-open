/**
 * 真模型试跑器(阶段 0/1 收口动作):在 fieldtest-java 上让真模型
 * 跑真需求(缺省 Full，也可 --lane),人工节点由代答策略自动决定并逐张留痕。
 *
 * 这是观察工具不是生产路径:目的是回答"同一个模型换到 pi harness
 * 会长出什么新的绕门禁姿势"——每张审批卡、每次打回、最终停在哪一步,
 * 全部落在现场目录里供对拍。预算(卡数/超时)耗尽即停,不无限烧。
 *
 * 用法:
 *   npm run pilot -- --models .local/models.json --provider glm \
 *     --model glm-5.1 --repo ../demo-repo \
 *     [--requirement "交付 REQ...:..."] [--max-cards 12] [--timeout-min 20]
 * 流水线故障/排除项/取证缺口剧本见 README「跑起来」。
 *
 * 跨仓演练(2026-09-06):再挂一个候选仓,任务走"分析→确认拆分→按仓建子任务"
 * 一整条链,代答循环盯全部任务(父+子),子任务到待合入时在假平台上真合入,
 * 下游子任务才会解阻塞启动——这是"上下游通知"唯一真跑得起来的形态:
 *   npm run pilot -- --label cross-<日期> --repo ../demo-repo \
 *     --repo-aux ../demo-repo --aux-name notify-portal \
 *     --isolate-image mfc-java-pilot:latest --timeout-min 90 --max-cards 30
 *
 * 边跑边看(2026-09-06 用户:"没有可以直接看的真实现场吗?"):试跑器是进程内
 * TaskService,没有 HTTP;另起 serve 指向同一现场会把在跑任务接管过去双跑。
 * 所以在试跑器进程里挂同一份 HTTP 服务,登录账号库从演示数据复制一份:
 *   npm run pilot -- ... --serve-port 8839 --serve-auth .ui-fixtures/auth.json
 *
 * 断点续跑(预算耗尽不等于从头再来——quota 和已走的流程都是钱):
 *   npm run pilot -- --resume <label> [--timeout-min 30]
 * 复用 .pilot/<label> 现场,走任务级恢复:重建会话以内核 current
 * 为锚续跑,等人的卡由代答策略接着答。--requirement 在续跑时无效。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskService } from "./taskService.ts";
import { discoverKernelRoot } from "./kernelDiscovery.ts";
import { FakeGitPlatform } from "./gitPlatform.ts";
import { FakeLubanServer, Notifier } from "./notifier.ts";
import { createTaskServer } from "./server.ts";
import { LocalAuth } from "./auth.ts";
import { copyFileSync } from "node:fs";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

function flag(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
}

function enabled(name: string): boolean {
  return process.argv.includes(name);
}

function pipelineStatuses(value: string | undefined): Array<
  "success" | "failed" | "running"
> {
  if (!value?.trim()) return [];
  const statuses = value.split(",").map((item) => item.trim().toLowerCase());
  const invalid = statuses.filter((item) =>
    !["success", "failed", "running"].includes(item));
  if (invalid.length) {
    throw new Error(`--pipeline-statuses 含非法状态: ${invalid.join(",")}`);
  }
  return statuses as Array<"success" | "failed" | "running">;
}

/** 真模型演练可以在首次交付清单里放一个本地过程件，再观察流水线修复
 * 是否把它带回。它只写隔离出来的任务 clone，不碰源仓；路径必须是仓内
 * 相对路径，避免“为了测安全边界先把演练器写成安全漏洞”。 */
function seedExcludedFile(repoDir: string, path: string): string {
  const repoRoot = realpathSync(repoDir);
  const target = resolve(repoRoot, path);
  const local = relative(repoRoot, target);
  if (!path.trim() || isAbsolute(path) || !local || local.startsWith("..")
      || isAbsolute(local)) {
    throw new Error(`--seed-excluded 必须是任务仓内相对路径: ${path}`);
  }
  if (existsSync(target)) {
    throw new Error(`--seed-excluded 不会覆盖任务 clone 中的已有文件: ${local}`);
  }
  let existingParent = dirname(target);
  while (!existsSync(existingParent)) existingParent = dirname(existingParent);
  const realParent = realpathSync(existingParent);
  const parentFromRepo = relative(repoRoot, realParent);
  if (parentFromRepo.startsWith("..") || isAbsolute(parentFromRepo)) {
    throw new Error(`--seed-excluded 的父目录越出任务 clone: ${path}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target,
    "pilot local artifact: explicitly excluded from remote delivery\n");
  return local;
}

/** 第二个候选仓的裸仓:与 FakeGitPlatform.initBare 同一套做法,放在同一目录下
 * (假平台只路由默认裸仓同目录里的裸仓)。续跑时已存在就直接复用。 */
function initAuxBare(sourceRepo: string, dataDir: string, name: string): string {
  const bare = join(dataDir, `${name}.git`);
  if (existsSync(join(bare, "HEAD"))) return bare;
  mkdirSync(bare, { recursive: true });
  execFileSync("git", ["init", "--bare", "--quiet"], { cwd: bare });
  execFileSync("git", ["push", "--quiet", bare, "--all"],
    { cwd: sourceRepo, encoding: "utf-8" });
  const head = execFileSync("git", ["branch", "--show-current"],
    { cwd: sourceRepo, encoding: "utf-8" }).trim() || "master";
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${head}`], { cwd: bare });
  return bare;
}

/** 跨仓缺省需求:两仓共享一个字段约定,门户仓依赖主仓——正好逼出"上下游通知"。 */
const CROSS_REPO_REQUIREMENT =
  "交付 REQ2026090601:通知平台增加租户标识。主仓(notify-service 模块)在通知消息"
  + "模型与拼装链路里增加 tenantId 字段,非空校验、日志脱敏,并在 docs 写明字段约定;"
  + "门户仓 notify-portal(notify-web 模块)在通知列表与详情解析并展示 tenantId,缺失"
  + "时显示“未标注租户”。门户仓依赖主仓的字段约定,字段名或语义变化必须同步给对方。"
  + "两仓各自补齐单元测试。";

/** 代答策略:已知节点按固定选择,未知卡选第一项并显著标注——
 * 试跑里"第一项"就是模型排的推荐项,偏差本身就是观察数据。 */
function decideAnswers(
  questions: Array<{ question: string; options: string[] }>,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const item of questions) {
    const options = item.options ?? [];
    const pick = (pattern: RegExp) =>
      options.find((option) => pattern.test(option));
    answers[item.question] =
      pick(/确认以上全部配置|全部正确|配置无误/) ??
      // 方案确认优先选规范文案，旧卡片仍可按旧确认选项继续。
      pick(/需求已确认，进入需求分析/) ??
      pick(/^确认方案$/) ??
      pick(/^(确认并生成任务|确认分析结论|确认并继续开发)$/) ??
      (/交付方式/.test(item.question) ? pick(/完整开发/) : undefined) ??
      (/CODE Reviewer/i.test(item.question) ? pick(/不启用/) : undefined) ??
      options[0] ?? "确认";
  }
  return answers;
}

async function main(): Promise<number> {
  // 试跑全程代答,没有真人在等裁决:静掉内核的桌面弹窗
  // (dispatch.py 与转发壳都是本进程子进程,继承这里的环境)。
  process.env.MAE_FLOW_NO_NOTIFY = "1";
  // 试跑走的是同一套宿主:没有真人坐在这台机器前等着开 IDE 或点面板路径。
  process.env.MAE_FLOW_HOST = "cloud";
  const modelsPath = resolve(flag("--models", ".local/models.json")!);
  const provider = flag("--provider", "glm")!;
  const model = flag("--model", "glm-5.1")!;
  const repoPath = resolve(flag("--repo", "../demo-repo")!);
  const auxRepoPath = flag("--repo-aux") ? resolve(flag("--repo-aux")!) : undefined;
  const auxName = flag("--aux-name", "notify-portal")!;
  const crossRepo = Boolean(auxRepoPath);
  const kernelRoot = discoverKernelRoot(REPO_ROOT);
  if (!kernelRoot) {
    console.error("[pilot] 找不到内核(MAE_FLOW_HOME/仓内 kernel/ 皆无),不硬跑");
    process.exit(1);
  }
  const maxCards = Number(flag("--max-cards", "12"));
  const timeoutMs = Number(flag("--timeout-min", "20")) * 60_000;
  const requirement = flag(
    "--requirement",
    crossRepo ? CROSS_REPO_REQUIREMENT :
    "交付 REQ2026081402:notify-service 的通知文本工具增加脱敏能力," +
    "对通知正文里的 11 位手机号打码为前三后四(如 138****5678)," +
    "提供 TextUtil.maskPhone(String) 并在现有拼装链路中启用,补齐单元测试。",
  )!;
  const statuses = pipelineStatuses(flag("--pipeline-statuses"));
  const pipelineLog = flag("--pipeline-log",
    "BUILD FAILURE: 模块 notify-service 编译失败")!;
  const failedDimension = flag("--pipeline-failure-dimension", "COMPILE")!
    .trim().toUpperCase();
  if (!["COMPILE", "UT", "CODECHECK"].includes(failedDimension)) {
    console.error(`[pilot] --pipeline-failure-dimension 非法: ${failedDimension}`);
    return 1;
  }
  const failureFile = flag("--pipeline-failure-file",
    "notify-common/src/main/java/com/demo/notify/common/TextUtil.java")!;
  const failureRule = flag("--pipeline-failure-rule", "PILOT-CHECK-01")!;
  const failureLine = Number(flag("--pipeline-failure-line", "1"));
  if (!Number.isInteger(failureLine) || failureLine < 1) {
    console.error(`[pilot] --pipeline-failure-line 非法: ${failureLine}`);
    return 1;
  }
  const pollTimeoutSeconds = flag("--poll-timeout-s") === undefined
    ? undefined : Number(flag("--poll-timeout-s"));
  const pollIntervalSeconds = flag("--poll-interval-s") === undefined
    ? undefined : Number(flag("--poll-interval-s"));
  if ([pollTimeoutSeconds, pollIntervalSeconds].some((value) =>
    value !== undefined && (!Number.isFinite(value) || value < 0))) {
    console.error("[pilot] --poll-timeout-s/--poll-interval-s 必须是非负数");
    return 1;
  }
  // --customize-playbook 系列参数已随 v1 有界定制退役(2026-08-29):
  // 结构化定制走工作流资产;文字补充用 --task-instructions。
  for (const retired of ["--customize-playbook", "--customize-instructions",
    "--customize-activities", "--customize-resources"]) {
    if (flag(retired) !== undefined) {
      console.error(`[pilot] ${retired} 已退役:阶段结构定制请在工作流`
        + "资产库编排;文字补充用 --task-instructions");
      return 1;
    }
  }

  if (!existsSync(modelsPath)) {
    console.error(`[pilot] 找不到模型配置: ${modelsPath}`);
    return 1;
  }
  // 每次试跑一个独立现场目录:不删现场是纪律,目录隔离让纪律免维护
  // (跑完即归档,无需手动搬走,也不可能互相覆盖)。
  // --resume <label> 复用既有现场断点续跑。
  const resumeLabel = flag("--resume");
  const label = resumeLabel ?? flag("--label",
    "run-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19))!;
  const dataDir = join(REPO_ROOT, ".pilot", label);
  if (resumeLabel && !existsSync(dataDir)) {
    console.error(`[pilot] 现场不存在,无从续跑: ${dataDir}`);
    return 1;
  }
  // 内网件全用假件:裸仓当 Git 服务端,MR/流水线走环回 API,小鲁班收消息。
  const platform = new FakeGitPlatform();
  platform.initBare(repoPath, dataDir);
  const auxBare = auxRepoPath ? initAuxBare(auxRepoPath, dataDir, auxName) : undefined;
  if (auxBare) console.log(`[pilot] 跨仓演练:候选仓 origin.git + ${auxName}.git`);
  platform.statusQueue.push(...statuses);
  platform.nextPipelineLog = pipelineLog;
  if (statuses[0] === "failed") {
    platform.nextPipelineChecks = ["COMPILE", "UT", "CODECHECK"].map(
      (dimension) => dimension === failedDimension
        ? {
            dimension: dimension as "COMPILE" | "UT" | "CODECHECK",
            status: "failed" as const,
            job: dimension.toLowerCase(),
            ...(!enabled("--pipeline-no-details") ? { details: [{
              tool: dimension === "CODECHECK" ? "pilot-codecheck" : "maven",
              rule: failureRule,
              file: failureFile,
              line: failureLine,
              message: pipelineLog.slice(0, 2_000),
            }] } : {}),
          }
        : {
            dimension: dimension as "COMPILE" | "UT" | "CODECHECK",
            status: "success" as const,
            job: dimension.toLowerCase(),
          },
    );
  }
  await platform.start();
  const luban = new FakeLubanServer();
  await luban.start();
  const service = new TaskService({
    autoArchitecture: false,
    dataDir,
    provider,
    model,
    modelsJson: JSON.parse(readFileSync(modelsPath, "utf-8")),
    host: { kernelRoot, repoPath: platform.barePath, python: "python3" },
    delivery: {
      platformUrl: platform.baseUrl,
      ...(pollTimeoutSeconds !== undefined
        ? { pollTimeoutMs: pollTimeoutSeconds * 1000 } : {}),
      ...(pollIntervalSeconds !== undefined
        ? { pollIntervalMs: pollIntervalSeconds * 1000 } : {}),
    },
    // serve 里这是 `host ? { enabled: true } : undefined`,试跑器整个漏了
    // ——于是 push 前的编译+UT **一次都没跑过**,而试跑照样收口 await_merge,
    // 看不出少了一环(2026-08-21 首次整链试跑实测:全部 bash 日志里
    // 连一次 mvn 都没有)。试跑器必须和真服务同形,否则它证明不了什么。
    // 试跑器与真服务同形:隔离模式下预热同样开跑,真模型顺带验它。
    warmup: flag("--isolate-image") ? { enabled: true } : undefined,
    prepush: { enabled: true, buildSlots: Number(flag("--build-slots", "1")) },
    // 跨仓:父任务协调 + 两个子任务,缺省 2 个并发位会让下游排队等位。
    maxConcurrent: Number(flag("--max-concurrent", crossRepo ? "3" : "2")),
    isolation: flag("--isolate-image")
      ? {
          image: flag("--isolate-image")!,
          // serve 的 --isolate-cache-root 永远有默认值,试跑器却漏了它。
          // 统一构建镜像的 entrypoint 会校验 /cache/* 可写,不给缓存
          // 挂载就退 73——试跑一起手就是"容器启动后未处于 running"。
          cacheRoot: join(dataDir, "build-cache"),
          volumes: process.argv.flatMap((argument, index) =>
            argument === "--isolate-volume" && process.argv[index + 1]
              ? [process.argv[index + 1]]
              : []),
        }
      : undefined,
    notifier: new Notifier({ endpoint: luban.endpoint }),
    linkBase: "http://127.0.0.1:8787",
    ...(enabled("--push-confirm")
      ? { pushConfirmation: () => true } : {}),
    log: (message) => console.log(`  [task] ${message}`),
  });

  console.log(`[pilot] 真模型试跑: ${provider}/${model}`);
  // 这句在 cc2da9d 之后就不准了:编码会话确实不编译,但宿主会在每个新
  // HEAD push 前另起一个容器里的 prepush Agent 跑真实编译与 UT。
  console.log("[pilot] Cloud 执行契约:编码会话只写代码/UT;"
    + (flag("--isolate-image")
      ? "push 前由独立 Agent 在构建容器跑编译与 UT;"
      : "未配 --isolate-image,内核模式会拒绝启动;")
    + "CodeCheck 与最终核销由流水线执行");
  let task;
  if (resumeLabel) {
    // 断点续跑 = 服务重启语义:崩溃时在跑的任务重新入队,以内核
    // current 为锚重建会话;等人的卡恢复后由下面的代答循环接着答。
    const recovered = service.recover();
    // 跨仓现场里最后一个任务是子任务:续跑要盯的是家族根(没有父任务的那个),
    // 代答循环再按 parent_task_id 把子任务一起带上。
    task = service.list().find((item) => !item.parent_task_id) ?? service.list().at(-1);
    if (!task) {
      console.error(`[pilot] 现场 ${dataDir} 里没有可续跑的任务`);
      return 1;
    }
    console.log(`[pilot] 断点续跑: 恢复 ${recovered.restored} 个任务`
      + `(重新入队 ${recovered.requeued}),任务 ${task.id}`
      + ` 状态 ${task.status}`);
    // 终态但内核没走到 end(环境故障被迫收口的形状)→ 重跑续推。
    if (["completed", "failed", "canceled"].includes(task.status)) {
      const statePath = join(task.workspace, "origin", ".mae-flow.json");
      const current = existsSync(statePath)
        ? String(JSON.parse(readFileSync(statePath, "utf-8"))?.current ?? "")
        : "";
      if (current && current !== "end") {
        task = service.retry(task.id);
        console.log(`[pilot] 流程停在 ${current} 未到 end,重跑续推`);
      }
    }
  } else {
    console.log(`[pilot] 需求: ${requirement}`);
    task = service.create(requirement, {
      account: "developer",
      ...(auxBare ? { repos: [platform.barePath, auxBare] } : {}),
      ...(flag("--lane") ? { lane: flag("--lane") } : {}),
      ...(flag("--task-instructions")
        ? { taskInstructions: flag("--task-instructions") } : {}),
    });
  }
  console.log(`[pilot] 任务 ${task.id},现场: ${task.workspace}`);
  if (statuses.length) {
    console.log(`[pilot] 流水线剧本: ${statuses.join(" → ")}`
      + `(首轮失败维度 ${failedDimension})`);
  }

  // 边跑边看:同一进程、同一 TaskService,页面读到的就是代答循环看到的。
  const servePort = flag("--serve-port") ? Number(flag("--serve-port")) : undefined;
  if (servePort) {
    const authPath = join(dataDir, "auth.json");
    const authSource = flag("--serve-auth");
    if (!existsSync(authPath) && authSource && existsSync(authSource)) {
      copyFileSync(authSource, authPath);
    }
    const webRoot = join(REPO_ROOT, "web", "dist");
    const viewer = createTaskServer(service, {
      auth: new LocalAuth(authPath),
      ...(existsSync(join(webRoot, "index.html")) ? { webRoot } : {}),
    });
    viewer.listen(servePort, "127.0.0.1", () => {
      console.log(`[pilot] 现场可看: http://127.0.0.1:${servePort}`
        + (existsSync(authPath) ? "(账号库来自 --serve-auth)" : "(没有账号库,先在页面建账号)"));
    });
    viewer.unref();
  }
  const deadline = Date.now() + timeoutMs;
  let cards = 0;
  let seededExcluded = false;
  const rootId = task.id;
  const lastWaiting = new Map<string, string>();
  const lastStatus = new Map<string, string>();
  const merged = new Set<string>();
  const terminal = (status: string) =>
    ["completed", "failed", "canceled"].includes(status);
  const repairStopped = (item: typeof task) => item.status === "verifying" && (
    Boolean(item.delivery?.stalled)
    || ["halted", "exhausted"].includes(item.delivery?.loop?.state ?? "")
    || item.delivery?.evidence_gap?.state === "waiting_human"
  );
  const tag = (item: typeof task) => item.id === rootId
    ? item.id : `${item.id}·${item.title ?? "子任务"}`;
  let budgetExhausted = false;
  for (;;) {
    await new Promise((tick) => setTimeout(tick, 1000));
    if (Date.now() > deadline) {
      console.log(`[pilot] ⏱ 超时预算耗尽,当前状态: ${service.get(rootId)!.status}`);
      break;
    }
    // 跨仓时子任务由服务按拆分方案自己建出来:同一家族一起盯。
    const family = service.list().filter((item) =>
      item.id === rootId || item.parent_task_id === rootId);
    const root = family.find((item) => item.id === rootId)!;
    for (const item of family) {
      if (lastStatus.get(item.id) !== item.status) {
        console.log(`[pilot] ${tag(item)} 状态: ${lastStatus.get(item.id) ?? "(创建)"}`
          + ` → ${item.status}` + (item.detail ? ` — ${item.detail}` : ""));
        lastStatus.set(item.id, item.status);
      }
    }
    if (!crossRepo) {
      if (terminal(root.status) || root.status === "await_merge" || repairStopped(root)) {
        console.log(`[pilot] 任务收口: ${root.status}`
          + (root.detail ? ` — ${root.detail}` : ""));
        break;
      }
    } else {
      // 子任务到待合入就在假平台真合入:下游子任务只认"上游 MR 已合入",
      // 不合就永远排队,跨仓链路根本走不到通知那一步。
      for (const item of family) {
        const mrId = item.delivery?.mr_id;
        if (item.status !== "await_merge" || mrId === undefined || merged.has(String(mrId))) continue;
        merged.add(String(mrId));
        try {
          const response = await fetch(`${platform.baseUrl}/mr/${mrId}/merge`,
            { method: "POST", redirect: "manual" });
          console.log(`[pilot] ${tag(item)} MR ${mrId} 合入 → HTTP ${response.status}`
            + (response.status >= 400 ? ` ${await response.text()}` : ""));
        } catch (error) {
          console.log(`[pilot] ${tag(item)} MR ${mrId} 合入失败: ${String(error)}`);
        }
      }
      const settled = family.every((item) => terminal(item.status)
        || repairStopped(item)
        || (item.status === "await_merge" && item.delivery?.mr_id === undefined));
      if (terminal(root.status) || (family.length > 1 && settled)) {
        console.log(`[pilot] 家族收口: ${family.map((item) =>
          `${tag(item)}=${item.status}`).join(", ")}`);
        break;
      }
    }
    for (const now of family) {
      if (now.status !== "waiting_for_human"
          || !now.waiting
          || now.waiting.waiting_id === lastWaiting.get(now.id)) {
        continue;
      }
      lastWaiting.set(now.id, now.waiting.waiting_id);
      cards += 1;
      const questions =
        ((now.waiting.question as any)?.questions ?? []) as Array<{
          question: string; options: string[];
        }>;
      console.log(`\n[pilot] ── 审批卡 #${cards}(${tag(now)},步骤 ${now.waiting.step || "?"})`);
      for (const item of questions) {
        console.log(`  Q: ${item.question}`);
        console.log(`     选项: ${(item.options ?? []).join(" | ")}`);
      }
      if (cards > maxCards) {
        console.log(`[pilot] 卡数预算(${maxCards})耗尽,停在这张卡,现场保留。`);
        budgetExhausted = true;
        break;
      }
      const excludedPath = flag("--seed-excluded");
      if (!seededExcluded && excludedPath && now.id === rootId
          && now.waiting.step === "cloud_push_confirm") {
        const local = seedExcludedFile(join(now.workspace, "origin"), excludedPath);
        seededExcluded = true;
        console.log(`  [pilot] 已在任务 clone 放入本地过程件 ${local};`
          + "本次确认不选它，后续专测拒绝项是否回流");
      }
      const answers = decideAnswers(questions);
      for (const [question, answer] of Object.entries(answers)) {
        console.log(`  ✔ 代答: ${question} → ${answer}`);
      }
      try {
        await service.decide(now.id, {
          state_version: now.waiting.state_version,
          answers,
          notes: "pilot 代答(真模型试跑)",
        });
      } catch (error) {
        console.log(`  代答失败: ${String(error)}`);
      }
    }
    if (budgetExhausted) break;
  }

  // 收口报告:阶段真相只看内核状态文件。
  const done = service.get(task.id)!;
  const repoDir = join(done.workspace, "origin");
  const statePath = join(repoDir, ".mae-flow.json");
  if (existsSync(statePath)) {
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    console.log(`\n[pilot] 内核阶段真相: current=${state.current}`);
    console.log(`[pilot] 已确认配置: ${JSON.stringify(state.config ?? {})}`);
  } else {
    console.log("\n[pilot] 内核状态文件不存在——流程没走到 init。");
  }
  console.log(`[pilot] 现场目录(transcript/events/waiting/面板): ${done.workspace}`);
  console.log(`[pilot] 审批卡共 ${cards} 张;状态: ${done.status}`);
  if (crossRepo) {
    for (const item of service.list().filter((entry) => entry.parent_task_id === rootId)) {
      console.log(`[pilot] 子任务 ${item.id}(${item.title ?? "?"}): ${item.status}`
        + (item.detail ? ` — ${item.detail}` : "")
        + (item.delivery?.mr_url ? ` MR=${item.delivery.mr_url}` : ""));
    }
    console.log(`[pilot] 跨仓同步记录: ${JSON.stringify(done.cross_repository_updates ?? [])}`);
  }
  if (done.delivery) {
    console.log(`[pilot] 交付: ${JSON.stringify(done.delivery)}`);
  }
  console.log(`[pilot] 平台侧 MR: ${JSON.stringify(platform.mergeRequests)}`);
  console.log(`[pilot] 平台侧流水线: ${JSON.stringify(platform.pipelines)}`);
  console.log(`[pilot] 小鲁班收到 ${luban.messages.length} 条通知`);
  if (enabled("--show-luban")) {
    for (const [index, message] of luban.messages.entries()) {
      console.log(`[pilot] 小鲁班 #${index + 1}: ${String(message.text ?? "")}`);
    }
  }
  await platform.stop();
  await luban.stop();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error("[pilot] 异常:", error);
    process.exit(1);
  },
);
