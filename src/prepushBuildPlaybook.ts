import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { MAE_FIRST_BUILD_GUIDANCE, maeBuildRoot } from "./maeBuildSupport.ts";

export type PrePushBuildStack = "java" | "javascript" | "cpp";

export interface PrePushBuildProfile {
  stacks: PrePushBuildStack[];
  mae?: boolean;
  /** 所有已识别语言是否都由根 pom.xml 编排。 */
  maven: boolean;
  maven_command: "./mvnw" | "mvn";
  repository_guides: string[];
  selected_skill_snapshot: boolean;
  javascript?: {
    root: "website";
    package_manager: "npm" | "pnpm" | "yarn";
    dependencies_present: boolean;
  };
  signals: string[];
}

export interface PrePushExecutionBudget {
  /** 整个专项 Agent 的墙钟上限。 */
  attemptTimeoutMs: number;
  /** 被识别为重型构建的单条命令至少获得的墙钟预算。 */
  buildCommandTimeoutMs: number;
}

export interface PrePushExecutionBudgetOptions {
  attemptTimeoutMs?: number;
  buildCommandTimeoutMs?: number;
}

const MINUTE_MS = 60_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30 * MINUTE_MS;
const DEFAULT_NATIVE_ATTEMPT_TIMEOUT_MS = 60 * MINUTE_MS;
const DEFAULT_BUILD_COMMAND_TIMEOUT_MS = 20 * MINUTE_MS;
const DEFAULT_NATIVE_BUILD_COMMAND_TIMEOUT_MS = 45 * MINUTE_MS;
const MAX_ATTEMPT_SAFETY_MARGIN_MS = 5 * MINUTE_MS;

function positiveBudget(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * 慢 native 仓不能沿用普通 Java 仓的墙钟预算。这里由平台给出默认值，
 * 部署仍可按代表仓的 P95 显式覆盖；无论怎样都给整轮留出清理和收口余量。
 */
export function resolvePrePushExecutionBudget(
  profile: PrePushBuildProfile,
  options: PrePushExecutionBudgetOptions = {},
): PrePushExecutionBudget {
  const native = profile.stacks.includes("cpp");
  const firstBuild = profile.mae;
  const attemptTimeoutMs = positiveBudget(
    options.attemptTimeoutMs,
    firstBuild ? 90 * MINUTE_MS : native ? DEFAULT_NATIVE_ATTEMPT_TIMEOUT_MS : DEFAULT_ATTEMPT_TIMEOUT_MS,
  );
  const requestedBuildTimeoutMs = positiveBudget(
    options.buildCommandTimeoutMs,
    firstBuild ? 75 * MINUTE_MS : native
      ? DEFAULT_NATIVE_BUILD_COMMAND_TIMEOUT_MS
      : DEFAULT_BUILD_COMMAND_TIMEOUT_MS,
  );
  const safetyMarginMs = Math.min(
    MAX_ATTEMPT_SAFETY_MARGIN_MS,
    Math.max(1_000, Math.floor(attemptTimeoutMs / 10)),
  );
  const buildCeilingMs = Math.max(1_000, attemptTimeoutMs - safetyMarginMs);
  return {
    attemptTimeoutMs,
    buildCommandTimeoutMs: Math.min(requestedBuildTimeoutMs, buildCeilingMs),
  };
}

/**
 * 只识别明确进入构建/测试生命周期的命令。普通只读探查不能因为仓库含
 * C++ 就被放宽到几十分钟；反过来，命令带 cd/env/重定向也不能漏识别。
 */
export function isPrePushBuildCommand(command: string): boolean {
  const value = command.toLowerCase();
  const maven = /(?:^|[\s;&|()])(?:mvn|\.\/mvnw)(?:\s|$)/.test(value)
    && /(?:^|\s)(?:compile|test|package|verify|install)(?:\s|$)/.test(value);
  const gradle = /(?:^|[\s;&|()])(?:gradle|\.\/gradlew)(?:\s|$)/.test(value)
    && /(?:^|\s)(?:assemble|build|check|test)(?:\s|$)/.test(value);
  const cmake = /(?:^|[\s;&|()])cmake\s+[^;&|\n]*--build(?:\s|$)/.test(value);
  const nativeRunner = /(?:^|[\s;&|()])(?:make|gmake|ninja|ctest)(?:\s|$)/
    .test(value);
  const packageRunner = /(?:^|[\s;&|()])(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:build|test|check)(?:\s|$)/
    .test(value);
  const otherRunner = /(?:^|[\s;&|()])(?:cargo\s+(?:build|test)|go\s+test)(?:\s|$)/
    .test(value);
  const maeRunner = /(?:^|[\s;&|()])node\s+\/opt\/mae-flow-build\/first-build\.mjs\s+run(?:\s|$)/.test(value)
    || /(?:^|[\s;&|()])bash\s+["']?[^\s;&|]*\/(?:build_service|build)\.sh(?:["']?\s|$)/.test(value);
  return maven || gradle || cmake || nativeRunner || packageRunner || otherRunner || maeRunner;
}

/** 全仓 UT 护栏的三种结论。`advised` 是刻意的中间态,见下。 */
export type FullSuiteVerdict = "none" | "advised" | "blocked";

/**
 * 只拦一眼就能确认的“全仓 UT”入口，不猜业务仓自定义脚本的语义。
 * 目的不是做第三套构建解析器，而是保证 Agent 即使忽略提示，也不能把
 * 最常见的一小时全量命令真正跑起来；拒绝文案会要求它换成显式选择器。
 *
 * **C++/native 只提示不拦截**(用户 2026-09-04 拍板"改成提示吧")。
 * Java/JS/Rust/Go/Python 的定向选择器(-Dtest / -pl / 测试文件 / -run /
 * 用例路径)是语言生态的标配,拦下去 Agent 一定换得出来;C++ 那条 DT 链路
 * 不一样——`-DDT_COV_INCLUDES` 能不能用取决于仓库自己的 DT 插件配置,
 * 平台没有在真仓上验证过。硬拒的代价是 Agent 按嘱咐报“未找到定向 UT”
 * 直接停下,整个 C++ 仓从此跑不了 UT;放行的代价只是一次有预算上限的
 * 全量。两边不对等,所以这里给提示、把决定权留在现场。
 */
export function fullSuiteCommandVerdict(command: string): FullSuiteVerdict {
  const value = prePushCommandIdentity(command);
  if (!value || /(?:-DskipTests(?:=true)?|-Dmaven\.test\.skip(?:=true)?)/i
    .test(value)) return "none";
  const targeted = /(?:^|\s)(?:-pl|--projects)(?:=|\s)|-D(?:test|it\.test|DT_COV_INCLUDES)=|(?:^|\s)ctest(?:\s|$)[^;&|\n]*(?:-R|--tests-regex|-L|--label-regex|-I|--tests-information)(?:=|\s)|(?:^|\s)(?:npm|pnpm|yarn)(?:\s+run)?\s+test(?::[^\s;&|]+)|(?:^|\s)(?:npm|pnpm|yarn)(?:\s+run)?\s+test\s+--\s+[^-\s]/i
    .test(value);
  if (targeted) return "none";

  const mavenAll = /(?:^|[\s;&|()])(?:mvn|\.\/mvnw)\s+[^;&|\n]*\b(?:test|verify)\b/i
    .test(value);
  // mcde 的 mae-remote-build skill(用户 2026-09-04 提供的真件)口径是
  // `mvn compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT`,压根没有 -DDT_run;
  // 只认带 DT_run 的写法等于对真实命令视而不见。
  const nativeMavenAll = /(?:^|[\s;&|()])(?:mvn|\.\/mvnw)(?:\s|$)[^;&|\n]*-DDT_test=UT\b/i
    .test(value);
  const barePackageTest = /(?:^|[;&|]\s*)(?:npm|pnpm|yarn)(?:\s+run)?\s+test\s*(?:$|[;&|>])/i
    .test(value);
  const bareCtest = /(?:^|[;&|]\s*)ctest(?:\s+--output-on-failure)?\s*(?:$|[;&|>])/i
    .test(value);
  const bareGradle = /(?:^|[\s;&|()])(?:gradle|\.\/gradlew)\s+(?:test|check)\s*(?:$|[;&|>])/i
    .test(value);
  const bareCargo = /(?:^|[;&|]\s*)cargo\s+test\s*(?:$|[;&|>])/i.test(value);
  const allGo = /(?:^|[;&|]\s*)go\s+test\s+\.\/\.\.\.(?:\s|$|[;&|>])/i.test(value);
  const barePytest = /(?:^|[;&|]\s*)(?:pytest|python\s+-m\s+pytest)\s*(?:$|[;&|>])/i
    .test(value);
  // C++/native 的两个入口只提示:DT 参数的定向能力因仓而异,ctest 的
  // -R 又要先知道用例名。真定向不了时,让它带着预算跑完并说明,好过
  // 让整个仓卡在“未找到定向 UT”。
  if (nativeMavenAll || bareCtest) return "advised";
  return (mavenAll || barePackageTest || bareGradle || bareCargo || allGo
    || barePytest) ? "blocked" : "none";
}

/** 同一代码内容上的同一重型命令使用稳定键；只折叠空白，不猜 shell 语义。 */
export function prePushCommandIdentity(command: string): string {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

export type PrePushRepeatDecision = "execute" | "reuse_success" | "block_repeat";

/**
 * 轻量防空跑：同一内容上成功命令直接复用；失败允许一次环境抖动重试，
 * 连续两次仍失败就把第三次挡回给 Agent 先诊断。代码内容变化后键自然变化。
 */
export class PrePushCommandRepeatGuard {
  private readonly records = new Map<string, { failures: number; passed: boolean }>();

  decide(contentIdentity: string, command: string): PrePushRepeatDecision {
    const record = this.records.get(this.key(contentIdentity, command));
    if (!record) return "execute";
    if (record.passed) return "reuse_success";
    return record.failures >= 2 ? "block_repeat" : "execute";
  }

  record(contentIdentity: string, command: string, exitCode: number | null): void {
    const key = this.key(contentIdentity, command);
    const previous = this.records.get(key) ?? { failures: 0, passed: false };
    this.records.set(key, exitCode === 0
      ? { ...previous, passed: true }
      : { ...previous, failures: previous.failures + 1 });
  }

  private key(contentIdentity: string, command: string): string {
    return `${contentIdentity}\0${prePushCommandIdentity(command)}`;
  }
}

/**
 * 模型可以建议 timeout，但不能用一个随手填的 600 秒截断平台已知的慢构建。
 * 重型命令的 timeout 被抬到平台下限，并限制在整轮预算的安全余量内。
 */
export function prePushCommandTimeoutSeconds(
  command: string,
  requested: number | undefined,
  budget: PrePushExecutionBudget,
): number | undefined {
  if (!isPrePushBuildCommand(command)) return requested;
  if (requested !== undefined
      && (!Number.isFinite(requested) || requested <= 0)) return requested;
  const floor = Math.max(1, Math.ceil(budget.buildCommandTimeoutMs / 1_000));
  const safetyMarginMs = Math.min(
    MAX_ATTEMPT_SAFETY_MARGIN_MS,
    Math.max(1_000, Math.floor(budget.attemptTimeoutMs / 10)),
  );
  const ceiling = Math.max(
    1,
    Math.floor((budget.attemptTimeoutMs - safetyMarginMs) / 1_000),
  );
  return Math.min(Math.max(requested ?? floor, floor), ceiling);
}

const MAX_TEXT_BYTES = 512 * 1024;

function safeFixedPath(workspace: string, relativePath: string): string | undefined {
  const parts = relativePath.split(/[\\/]/);
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) {
    return undefined;
  }
  let current = resolve(workspace);
  try {
    // O_NOFOLLOW 只保护末级；逐段 lstat 才能拒绝 website 等中间目录链接。
    for (const part of parts) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) return undefined;
    }
    return current;
  } catch {
    return undefined;
  }
}

function pathKind(workspace: string, relativePath: string): "file" | "directory" | undefined {
  try {
    // 只检查固定相对路径，并拒绝符号链接；业务仓内容不能借扫描器读取工作区外文件。
    const target = safeFixedPath(workspace, relativePath);
    if (!target) return undefined;
    const stat = lstatSync(target);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
  } catch {
    // 缺失、无权限或损坏均视为没有该提示，真正执行时由 Agent 报告。
  }
  return undefined;
}

function textFile(workspace: string, relativePath: string): string {
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW 让“先 lstat、随后被替换成链接”的竞态也无法越出工作区。
    const target = safeFixedPath(workspace, relativePath);
    if (!target) return "";
    descriptor = openSync(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return "";
    const value = readFileSync(descriptor);
    if (value.includes(0)) return "";
    return value.toString("utf-8");
  } catch {
    return "";
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function hasFile(workspace: string, relativePath: string): boolean {
  return pathKind(workspace, relativePath) === "file";
}

function hasDirectory(workspace: string, relativePath: string): boolean {
  return pathKind(workspace, relativePath) === "directory";
}

/**
 * 只做保守的仓库特征识别，不替 Agent 决定构建命令。仓库可能同时包含
 * Java、前端和 native 模块，因此 stacks 是集合而不是互斥的“仓库类型”。
 */
export function detectPrePushBuildProfile(workspace: string): PrePushBuildProfile {
  const pom = textFile(workspace, "pom.xml");
  const hasPom = Boolean(pom);
  const signals: string[] = [];
  const stacks: PrePushBuildStack[] = [];

  const hasWebsite = hasFile(workspace, "website/package.json");
  if (hasWebsite) {
    stacks.push("javascript");
    signals.push("website/package.json");
  }

  const nativeSignals = [
    "CMakeLists.txt",
    "src/main/cpp",
    "src/test/cpp",
    "src/main/native",
    "src/test/native",
    "native",
  ].filter((path) => hasFile(workspace, path) || hasDirectory(workspace, path));
  const nativePom = /(?:DT_test|DT_run|DT_COV_INCLUDES|DT_COV_EXCLUDES|cmake|cpp|native)/i
    .test(pom);
  if (nativeSignals.length || nativePom) {
    stacks.push("cpp");
    signals.push(...nativeSignals);
    if (nativePom) signals.push("pom.xml:native/DT");
  }

  const javaSignals = ["src/main/java", "src/test/java"]
    .filter((path) => hasDirectory(workspace, path));
  const javaPom = /(?:maven-compiler-plugin|maven-surefire-plugin|<maven\.compiler\.|<source>\s*(?:8|11|17|21)\s*<\/source>)/i
    .test(pom);
  if (javaSignals.length || javaPom || (hasPom && !nativePom && !hasWebsite)) {
    stacks.push("java");
    signals.push(...javaSignals);
    if (javaPom) signals.push("pom.xml:java");
    else if (hasPom && !nativePom && !hasWebsite) signals.push("pom.xml:maven-default");
  }

  const repositoryGuides = [
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "mvnw",
    "build.sh",
    "compile.sh",
    "install.sh",
    "website/install.sh",
  ].filter((path) => hasFile(workspace, path));

  let javascript: PrePushBuildProfile["javascript"];
  if (hasWebsite) {
    const packageManager = hasFile(workspace, "website/pnpm-lock.yaml")
      ? "pnpm"
      : hasFile(workspace, "website/yarn.lock")
        ? "yarn"
        : "npm";
    javascript = {
      root: "website",
      package_manager: packageManager,
      dependencies_present: hasDirectory(workspace, "website/node_modules"),
    };
  }

  return {
    stacks,
    ...(maeBuildRoot(workspace) ? { mae: true } : {}),
    maven: hasPom,
    maven_command: hasFile(workspace, "mvnw") ? "./mvnw" : "mvn",
    repository_guides: repositoryGuides,
    selected_skill_snapshot: hasDirectory(
      workspace,
      ".mae-flow-work/repository-skills",
    ),
    ...(javascript ? { javascript } : {}),
    signals: [...new Set(signals)],
  };
}

function stackLabel(stack: PrePushBuildStack): string {
  if (stack === "javascript") return "JS/前端";
  if (stack === "cpp") return "C++";
  return "Java";
}

/**
 * 把内网实战经验作为 advisory 送给专项 Agent。它不是硬编码执行器：业务仓
 * 的可执行配置与脚本是事实，相关 Skill 负责解释，内网经验只在二者未说明时兜底。
 */
export function renderPrePushBuildGuidance(profile: PrePushBuildProfile): string {
  const mvn = profile.maven_command;
  const lines = [
    "### 内网 Build-Fix 参考（建议，不是第二套流程）",
    MAE_FIRST_BUILD_GUIDANCE,
    `识别到：${profile.stacks.length ? profile.stacks.map(stackLabel).join(" + ") : "尚未识别明确语言"}${profile.maven ? "；根目录由 Maven 编排" : ""}。`,
    "先以 pom/package、wrapper、仓库脚本与 CI 配置确认真实可执行入口；再根据已选择业务仓 Skill 的名称和描述判断是否相关，需要时读取其说明。Skill 是辅助说明，不得覆盖真实配置或安全边界；下述内网经验只在仓库材料没有说明时兜底。",
  ];

  if (profile.selected_skill_snapshot) {
    lines.push("当前工作区存在已选择 Skill 的只读快照；按当前任务判断相关性后自行决定是否读取，不要求逐个调用，也不要修改该快照。");
  }
  if (profile.repository_guides.length) {
    lines.push(`优先检查的仓库入口：${profile.repository_guides.join("、")}。`);
  }

  if (profile.maven) {
    lines.push(
      "根 POM 是构建入口线索，不代表 Maven 是唯一入口。MAE 首次构建遵循 mae-first-build 与仓库脚本；后续按已验证语言 Skill 和生成目录做增量，svc_profile 必须与编译在同一 shell 中使用。",
    );
  }
  lines.push(
    "基础设施预检：工具链版本以仓库 POM、脚本及镜像实测为准；部分仓需要 JDK 21，不能推广到全部 Java/C++ 仓。前端核对仓库兼容的 Node/npm；C++ 核对 GCC/G++、binutils、bison、flex。ccache 是可选加速器，缺席不构成基础设施失败。缺失、版本不兼容、制品仓 TLS/网络/权限或磁盘问题归类 infrastructure_failure，不要通过改业务代码伪装修复。低版本 JDK 的典型症状是 UnsupportedClassVersionError——那是环境问题，不是代码问题。",
    "镜像、证书信任与凭据按生态由平台分工注入，不要手动改配置自救（2026-09-03 勘误：npm 侧此前并没有镜像兜底）：Maven 镜像由平台只读挂载 /etc/mae-flow/maven/settings.xml（并接入 ~/.m2/settings.xml）负责；npm registry 由部署注入环境变量 `npm_config_registry`（配置项 isolate-npm-registry）负责，MAE 任务另由平台从固定版本 MAEBuild 恢复用户 .npmrc 和 scope 路由，并以该配置的默认源覆盖旧的全局 registry；两者都缺席才报告部署缺配。",
    "不要克隆新副本、注入令牌，也不要改全局 Git/Maven/npm 配置自救——`npm config set`、写 ~/.npmrc、/etc/npmrc、~/.gitconfig 都会被沙箱拒绝；同样不要关闭 TLS/SSL 校验；遇到证书或鉴权故障只记录证据并报告基础设施失败。",
    `增量优先：非首次构建用不带 clean 的 \`${mvn} compile\`（内网实测 C++ 仓 3 分钟→18 秒）；刚克隆的仓上 clean 没有意义，别浪费一次全量。`,
    "长构建不要用管道直连截尾（如 `mvn compile | tail -80`）——tail 要等命令退出才输出，进行中一个字都看不到，超时被杀连诊断都留不下。先落文件再看尾巴：`mvn compile > build.log 2>&1; tail -80 build.log`。",
    "并行度以容器配额为准，不要信 nproc：容器 CPU 是 CFS 配额不是绑核，nproc 虚报宿主全部核数，-j 超过配额会因限流不升反降（内网实锤：-j16 挤 8 核配额比干净 8 路还慢）。真实配额看 `cat /sys/fs/cgroup/cpu.max`（如 800000 100000 = 8 核），构建自带并行参数时按它设 -j。",
    "平台持久缓存事实：Maven 远端依赖（含 SDK zip）跨仓共享，install 和 cpp_sdk_repository 解压内容仍按仓隔离；/cache/maven 由 MAVEN_OPTS 注入，npm 用 /cache/npm，ccache 用 /cache/ccache。Java 模块依赖变化时平台会触发该模块重编，依赖不变保留增量，不必因此每轮 clean。工作区 target/、build/ 等产物跨轮持久；$HOME 与 /tmp 是易失的。",
    "构建慢先核对缓存真被吃到（内网实锤：每轮重拉依赖+全量编译）：Maven 若在重新下载依赖，多半是仓库包装脚本 export MAVEN_OPTS 把平台注入覆盖了——把 `-Dmaven.repo.local=/cache/maven/repository` 显式追加到 mvn 命令行（命令行 -D 优先级最高），并把“谁覆盖了缓存配置”写进收口摘要，这是平台要修的线索。",
    "同一容器里修完代码重编还在“Downloading”？先看下载的是什么：集中在 maven-metadata.xml 与 -SNAPSHOT 工件的，是 Maven 的 SNAPSHOT 更新策略在每次构建重查远端，不是缓存失效；修复循环内的重编可加 `-nsu`（--no-snapshot-updates）省掉重复检查，但收口前的最后一次编译不要加，保持与流水线同口径。下载的是 release 版工件才说明本地仓真没命中，按上一条排查。",
    "Build-Fix 的 UT 只跑受本次改动影响的模块和用例，禁止把全仓 UT 当作收口动作；一次全量可能耗时一小时，不能在每轮修复中重复浪费。全量回归由远端权威流水线负责。先从变更文件、失败日志、模块依赖和仓库测试配置确定最小可靠范围；找不到可靠的定向入口就明确报告“未找到定向 UT”，不得悄悄退回全量。",
  );

  if (profile.stacks.includes("java")) {
    lines.push(
      `Java：编译/打包检查默认用 \`${mvn} package -DskipTests\`，UT 再单独使用带模块/用例过滤的 test 命令。不要先跑一次带测试的 package 又重复跑 test；只需验证编译时 \`${mvn} compile\` 就够。仓库脚本、pom 或已选择 Skill 明确给出其他入口时以仓库事实为准。`,
      "Java 定向 UT 使用 `-Dtest=ClassName`、`-Dtest=ClassName#method`、通配符及 `-pl <module>`，只跑受影响模块/用例；Build-Fix 收口也不要跑全仓 UT。必须带上仓库支持的模块或用例选择参数。",
      "Java UT 缺 native 系统库（如 SQLite）属环境问题：报 infrastructure_failure 并点名缺哪个库，不要改业务代码绕。",
    );
  }

  if (profile.stacks.includes("javascript")) {
    const packageManager = profile.javascript?.package_manager ?? "npm";
    const installState = profile.javascript?.dependencies_present
      ? "website/node_modules 已存在；除非 package 清单/锁文件变化或依赖损坏，不要重复安装"
      : "website/node_modules 未发现；按仓库锁文件和脚本安装依赖";
    lines.push(
      `JS/前端：${installState}。检测到 ${packageManager}；优先遵循锁文件/仓库脚本，npm 无更明确入口时才在 website 使用 \`npm install --legacy-peer-deps\`。`,
      "依赖安装必须先于任何 Maven 编译——Maven 的 antrun 插件只调用 `npm run build`，不负责 install，漏了这步编译必失败。依赖版本冲突时先找项目的 install.sh 或仓库指定的 Node 版本，不要盲目改锁文件。",
      `JS/前端由 Maven 编排时优先增量 \`${mvn} compile\`。不要无脑执行 Maven clean，它可能删除 website/node_modules；只有仓库明确要求且已规划重新安装依赖时才 clean。`,
      "UT 必须从 package scripts、pom 或 CI 找到真实入口；不要把前端 build 冒充 UT。仓库明确要求产物构建时，才使用其 `npm run build-prod <version>` 等脚本。",
    );
  }

  if (profile.stacks.includes("cpp")) {
    lines.push(
      "C++ 动手前先看能力目录里有没有构建类 skill（如 mae-remote-build）：有就先读它——里面是团队蒸馏过的真实命令与增量/全量时机，比自行摸索准确得多。",
      `首编成功不代表 UT 依赖已准备：首编可能跳过测试。定向 UT configure 前，先核对本仓 skill/POM 的依赖生成入口及 cbbdevtest SDK（含 binmock.hpp）实际位置；对采用该配方的仓，在仓库要求的目录执行 \`${mvn} generate-sources -DDT_test=UT\`，沿用本轮 Maven 缓存和 settings 参数，成功后再核对 SDK 文件。已就绪则跳过；下载失败如实报告，不能靠反复 configure 或改测试代码绕过。`,
      "UT 依赖就绪后若确认旧 CMake 缓存与本轮配置不兼容，仅清理受影响模块的生成目录/CMakeCache.txt/CMakeFiles，再按 skill 做子目录 configure 和定向 UT。不要因一个模块失败改跑全仓 reconfigure；target already exists 也可能是重复声明，必须先读具体 CMake 错误，不能一律归因缓存。",
      "skill 与本手册冲突时分两类看：**仓库事实**（命令形状、构建入口、DT/插件参数、增量与全量的判据）以 skill 为准，它更贴仓库；"
        + "**平台事实**（并行度按容器 CPU 配额、缓存目录、超时预算、产物与提交纪律）以本手册为准。"
        + "典型例子：skill 里写死的 `make -j12` 是它自己远端机器的假设，本平台容器是 CFS 配额，照抄会因限流更慢——并行度仍按配额算。",
      `C++/native：优先从 Maven 插件进入。mcde 的 mae-remote-build skill 口径是 \`${mvn} compile -U -DDEBUG_FLAG=DEBUG -DDT_test=UT\`（存在 \`\${HOME}/settings.xml\` 时把 compile 换成 \`install ... -s \${HOME}/settings.xml\`）；另一处内网经验还带过 \`-DDT_run=true\`，两者不一致时以本仓 pom/脚本/skill 为准，不要两个都往上堆。`,
      "mcde 口径里「增量 UT / 全量 UT」的差别只是**带不带 clean**，不是测试选择：不加 clean 就是增量。所以修复循环里绝不要用 clean 触发全仓重编与全量测试。",
      "必须从输出确认 UT 进程确实执行并产生用例/结果摘要，不能只看 Maven BUILD SUCCESS 就把它记作 UT。若 DT 参数只生成或编译测试，则继续使用仓库生成目录中的 ctest --output-on-failure 或仓库专用 runner，最终上报真正执行测试的命令。",
      "C++ 缩小 UT 范围的**首选是目录**：进受本次改动影响的子模块目录（自带 `pom.xml` 或 `CMakeLists.txt` 的那一层）再构建/跑 UT——mcde 的 mae-remote-build 就是这么做的，它整份 skill 里没有任何按用例过滤的开关。",
      "CMake 子目录 UT 的现成配方（mae-remote-build skill 原文，并行度换成按容器配额）："
        + "`export without_tests=0 && export DT_test=UT && source <仓库根>/build/svc_profile.sh"
        + " && mkdir -p <子目录>/build && cd <子目录>/build"
        + " && cmake -DDEBUG_FLAG=DEBUG -DCMAKE_EXPORT_COMPILE_COMMANDS=1 .. && make -j<按 cpu.max>`；"
        + "跑完 unset 这两个环境变量，别让它们泄进后面的纯编译验证。",
      "`-DDT_COV_INCLUDES=\"*ModuleName*\"` 不在 mcde skill 里，不要当成通用开关：先在本仓 pom/插件说明里核实它是否存在，"
        + "核实不到就别写进命令。runner 层面还有 `ctest -R <pattern>` 和测试框架自带的 suite/case 过滤可用。"
        + "确实没有任何可用的定向入口时可以跑全量（平台只提示不拦），但要在 summary 写清核实过程和为什么没能定向。",
      `C++ 只需验证编译时去掉 DT 参数：\`${mvn} compile\` 即可；SDK 与 CMake 依赖由 Maven 插件自动拉取，一般无需手动安装。`,
      "svc_profile、SDK 等若由 Maven 生成或拉取，不要手工 export/伪造；工具链或专用依赖确实缺失时报告 infrastructure_failure。",
      "C++ 修复循环的增量入口（mcde 源码实锤）：生成目录已存在且构建配置未变时，`source <仓库根>/build/svc_profile.sh && cd <仓库根>/target/build && make -j<按 cpu.max>` 直接驱动已生成的 Makefile——绕开 Maven 插件的重新生成（插件每次调用都会刷 svc_profile/配置头的时间戳，必然全量）。收口只需对受影响目标做可复现的增量编译与定向 UT，完整回归留给远端流水线。",
      "C++ 增量的两级现实：①工作区里的生成目录跨轮持久，构建系统若按时间戳增量则天然生效——绝不无谓 clean；②对象级缓存靠 ccache，平台在容器登录 shell 确认 ccache 存在后才接入 CMAKE_C/CXX_COMPILER_LAUNCHER，并提供 CCACHE_BASEDIR（跨任务路径相对化）；缺席时直接使用原生编译器，不安装、不报失败。有 ccache 时，编译收口后跑 `ccache -s` 核对命中/文件数并写进收口摘要：缓存文件数在涨说明已接上（首轮全 miss 属正常，是在灌缓存）；仍是 0 个文件且 target 下存在早于本轮的 CMakeCache.txt，说明旧 configure 缓存没带 launcher——删掉该 CMake 生成目录让插件重新 configure（一次性全量，换来后续对象级命中），并把这个决定写进收口摘要。除此之外不要为接 ccache 硬改仓库工具链。",
    );
  }

  if (profile.stacks.length > 1) {
    lines.push("这是混合仓：先按改动文件确定受影响模块；能由一次 Maven 生命周期定向覆盖时不要重复构建，不能覆盖的 UT 只按受影响模块真实入口补跑并分别记录证据，不扩成全仓回归。");
  }
  if (!profile.stacks.length) {
    lines.push("未识别到标准入口：继续从仓库 Skill、说明、脚本和 CI 发现真实编译/UT 命令，不要凭语言印象编造命令；确实没有 UT 入口时如实报告而非以 build 代替。");
  }

  return lines.join("\n");
}

export function prePushBuildGuidance(workspace: string): string {
  return renderPrePushBuildGuidance(detectPrePushBuildProfile(workspace));
}
