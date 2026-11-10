import { type EventLog, type SemanticEvent } from "./semanticEvents.ts";
import type {
  GateContract,
  GateDecision,
} from "./gateService.ts";
import {
  isPrePushBuildCommand,
  prePushBuildGuidance,
  type PrePushExecutionBudget,
} from "./prepushBuildPlaybook.ts";
import type { PrePushExecutionAttestation } from "./prePushVerification.ts";
import { describeAgentPlatformRoots } from "./agentPlatformPaths.ts";
import { DEFAULT_COMMIT_CONVENTION } from "./commitPolicy.ts";
import { withoutShellRedirections } from "./shellRedirections.ts";

export type PrePushFailureKind = "code_failure" | "infrastructure_failure";

export interface PrePushCheckReport {
  command: string;
  status: "passed" | "failed" | "skipped";
  summary?: string;
}

export interface PrePushAgentReport {
  status: "passed" | PrePushFailureKind;
  compile: PrePushCheckReport;
  unit_test: PrePushCheckReport;
  summary: string;
}

export interface PrePushRunRequest {
  taskId: string;
  workspace: string;
  sha: string;
  round: number;
  requirement: string;
  branch: string;
  baseline: string;
  /** 与宿主 push 前机械校验同源的人类可读规范。缺席时使用平台默认值。 */
  commitConvention?: string;
  /** 只用于提醒 Build-Fix Agent 自查提交范围，不是按目录硬拦截。
   * 某些仓会合法提交生成代码/二进制，最终判断仍由 Agent 基于仓库事实作出。 */
  changeScope?: BuildFixScopeReview;
  /** 分支上有人直接推的提交。必须点名，否则 Build-Fix 很可能把别人的
   * 改动当成"编译不过的脏东西"回滚掉——它有 commit 权限，做得到。 */
  foreignCommits?: { count: number; subjects: string[] };
}

export interface BuildFixScopeReview {
  totalPaths: number;
  suspiciousPaths: number;
  directorySummary: Array<{ directory: string; count: number }>;
  suspiciousExamples: string[];
}

const COMMON_BUILD_PATH = /(?:^|\/)(?:target|build|dist|out|coverage|node_modules|\.gradle|CMakeFiles|cmake-build[^/]*)(?:\/|$)|(?:^|\/)CMakeCache\.txt$|\.(?:class|o|obj|so|dylib|dll|a|pyc|pyo)$/i;

/** 变更多或带常见产物特征时，给 Agent 一份有界目录摘要。这里只提示、
 * 不删除也不阻断：路径长得像产物不等于它一定不该进仓库。 */
export function buildFixScopeReview(
  paths: string[],
): BuildFixScopeReview | undefined {
  const normalized = [...new Set(paths.map((path) => path.trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
  const suspicious = normalized.filter((path) => COMMON_BUILD_PATH.test(path));
  if (normalized.length <= 10 && !suspicious.length) return undefined;
  const directories = new Map<string, number>();
  for (const path of normalized) {
    const parts = path.split("/").filter(Boolean);
    const directory = parts.length <= 1
      ? "(仓库根目录)" : parts.slice(0, Math.min(2, parts.length - 1)).join("/");
    directories.set(directory, (directories.get(directory) ?? 0) + 1);
  }
  return {
    totalPaths: normalized.length,
    suspiciousPaths: suspicious.length,
    directorySummary: [...directories.entries()]
      .map(([directory, count]) => ({ directory, count }))
      .sort((left, right) => right.count - left.count
        || left.directory.localeCompare(right.directory))
      .slice(0, 12),
    suspiciousExamples: suspicious.slice(0, 20),
  };
}

export interface PrePushRunResult {
  status: "passed" | PrePushFailureKind;
  /** Agent 收口后真正验证的 HEAD；它可能包含本轮修复提交。 */
  sha: string;
  message: string;
  report?: PrePushAgentReport;
  /** 原生 runner 的加固容器事实；自定义执行器可暂不提供。 */
  execution?: PrePushExecutionAttestation;
}

/** 测试/部署可注入其他执行器；生产缺席时由 Cloud 原生 Pi 会话执行。 */
export type PrePushRunner = (
  request: PrePushRunRequest,
) => Promise<PrePushRunResult>;

const RESULT_PATTERN = /<prepush-result>\s*([\s\S]*?)\s*<\/prepush-result>/gi;
const MAX_RESULT_BYTES = 64 * 1024;

const DENY = (reason: string): GateDecision => ({ action: "deny", reason });

function shellWords(source: string): string[] {
  return (source.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2"));
}

function unsafeDiscardPath(path: string): boolean {
  const value = path.trim();
  return !value || value === "." || value === ".." || value === ":/"
    || value.startsWith("../") || value.startsWith("/")
    || /[*?\[\]{}]/.test(value)
    || value.startsWith(":(glob)") || value.startsWith(":(top,glob)");
}

/** 精确文件回退是修复能力；全树/通配回退才是现场销毁。 */
function unsafeGitWorktreeDiscard(segment: string): boolean {
  segment = withoutShellRedirections(segment);
  const checkout = segment.match(/\bcheckout\b([\s\S]*)/i);
  if (checkout) {
    const words = shellWords(checkout[1]);
    const marker = words.indexOf("--");
    if (marker >= 0) {
      const paths = words.slice(marker + 1);
      return paths.length === 0 || paths.some(unsafeDiscardPath);
    }
  }
  const restore = segment.match(/\brestore\b([\s\S]*)/i);
  if (!restore) return false;
  const words = shellWords(restore[1]);
  const stagedOnly = (words.includes("--staged") || words.includes("-S"))
    && !words.includes("--worktree") && !words.includes("-W");
  if (stagedOnly) return false; // 只退暂存区，不会丢工作区内容
  if (words.some((word) => word === "--pathspec-from-file"
      || word.startsWith("--pathspec-from-file="))) return true;
  const marker = words.indexOf("--");
  let paths: string[];
  if (marker >= 0) {
    paths = words.slice(marker + 1);
  } else {
    paths = [];
    for (let index = 0; index < words.length; index += 1) {
      const word = words[index];
      if (["-s", "--source"].includes(word)) {
        index += 1;
      } else if (!word.startsWith("-")) {
        paths.push(word);
      }
    }
  }
  return paths.length === 0 || paths.some(unsafeDiscardPath);
}

/**
 * Cloud 推送前会话不是 Mae-Flow 的阶段会话，因此不能借内核 Hook 做裁决。
 * 这里仅焊死这类专项 Agent 永远不该拥有的宿主能力；构建命令本身保持开放，
 * 仓库可以继续自由使用 Maven、Gradle、npm/pnpm、CMake、Make 等真实工具链。
 *
 * 这是 GateContract，而不是第二套流程状态机。调用方可以把部署已有的契约
 * 作为 fallback 传进来：预推送硬边界优先，未命中时再交给部署契约。
 */
export function createPrePushGateContract(
  fallback?: GateContract,
): GateContract {
  return (tool, value, event) =>
    prePushSecurityDecision(tool, value) ?? fallback?.(tool, value, event);
}

/** 语义更短的生产接线名；保留 create* 名称方便策略单测与外部组合。 */
export function prePushGateContract(base?: GateContract): GateContract {
  return createPrePushGateContract(base);
}

/** 返回 undefined 表示预推送安全层不干预，由下一层契约决定。 */
export function prePushSecurityDecision(
  tool: string,
  value: string,
): GateDecision | undefined {
  const kind = tool.trim().toLowerCase();
  const source = value.trim();
  if (!source) return undefined;

  // 专项会话绕开内核 Hook 的前提，是它也绝不能改写/伪造内核现场。
  // 只给 Read 精确豁免宿主/仓库 Skill 的任务内快照；其他内部文件以及
  // 对 Skill 快照的写入仍拒绝，避免先读出状态再用 Bash 改。
  const kernelStatePath = /(?:^|[\\/\s'"`=])\.mae-flow(?:\.json|-[^\\/\s'"`;&|]+|[\\/])(?:$|[\s'"`;&|\\/])/i;
  const readonlySkillSnapshot = kind === "read"
    && /(?:^|[\\/])\.mae-flow-work[\\/](?:repository|host)-skills[\\/]/i.test(source);
  // "为了避开内核现场而提到它"不是访问(实锤:grep -v ".mae-flow-work"、
  // find -path ./.mae-flow-work -prune 被误杀,Agent 搜索业务代码全被拒)。
  // 先抹掉排除语法里的提及再查;正向引用(cat/重定向/参数路径)不在
  // 这些形态里,照样拒。
  const sansExclusionIdioms = source
    // grep -v / --invert-match "<含 .mae-flow 的模式>"
    .replace(/(?:^|\s)(?:-v|--invert-match)\s+(['"]?)[^\s'"|;&]*\.mae-flow[^\s'"|;&]*\1/gi, " ")
    // grep --exclude / --exclude-dir=<...>
    .replace(/--exclude(?:-dir)?=(['"]?)[^\s'"|;&]*\.mae-flow[^\s'"|;&]*\1/gi, " ")
    // find [-not|!] -path <...> [-prune]
    .replace(/(?:(?:-not|!)\s+)?-path\s+(['"]?)[^\s'"|;&]*\.mae-flow[^\s'"|;&]*\1(?:\s+-prune)?/gi, " ")
    // git pathspec :(exclude)<...>
    .replace(/:\(exclude\)[^\s'"|;&]*\.mae-flow[^\s'"|;&]*/gi, " ");
  // build-notes 是预热/prepush 共用的构建入口沉淀,不是内核现场:
  // 精确豁免这一个文件(读写皆可,实锤:预热写入被拦报"沙箱限制")。
  // 豁免方式是"抹掉它再查"——同一条命令若还夹带其他 .mae-flow 路径,
  // 照样拒,不给组合走私留门。
  const sansBuildNotes = sansExclusionIdioms.replace(
    /[^\s'"`;&|]*\.mae-flow-work[\\/]build-notes\.md/gi, " ");
  if (kernelStatePath.test(sansBuildNotes) && !readonlySkillSnapshot) {
    // 这套安全层被 prepush/预热/开发助手多个专项会话复用,文案不许
    // 自称"推送前编译会话"(预热 Agent 撞到过张冠李戴的拒绝);出路
    // 必须写明——构建入口沉淀那一个文件是放行的,别的换路也没用。
    return DENY("本专项会话不能读取或修改 Mae-Flow 内核现场(.mae-flow*)。"
      + "构建入口沉淀请只写 .mae-flow-work/build-notes.md(该文件已放行,"
      + "目录由宿主预建);其余 .mae-flow 路径不要再尝试其他写法访问。");
  }

  // 文件工具和 Bash 都不能伸手碰宿主运行时模型/API Key 或常见凭据。
  // 仓库自己的 .claude/.codex skill 不在此列，避免误伤业务仓能力加载。
  const hostSecretPath = /(?:^|[\\/\s'"`=])(?:pi-agent|\.ssh|\.gnupg|\.aws|\.kube)(?:[\\/]|$)|(?:^|[\\/\s'"`=])\.docker[\\/]config\.json(?:$|[\s'"`;&|])|(?:^|[\\/\s'"`=])(?:\.netrc|\.git-credentials|git-credential(?:\.sh)?)(?:$|[\s'"`;&|])/i;
  if (hostSecretPath.test(source)) {
    return DENY("Build-Fix 会话不能读取或改写宿主模型配置与凭据。");
  }

  // Maven/npm/Git 的用户级配置可能内含仓库凭据，JDK truststore 与 shell
  // profile 则属于整台宿主机。专项 Agent 只能使用部署时准备好的环境，不能
  // 通过文件工具或 Bash 把一次构建诊断固化成全局配置。仓内 pom、package、
  // .npmrc 等项目配置不匹配这些绝对/用户目录规则，仍可正常读取和修复。
  const homeConfigPath = /(?:~|\$(?:HOME|\{HOME\})|\/(?:root|home\/[^\\/\s'"`;&|]+|Users\/[^\\/\s'"`;&|]+))[\\/](?:\.gitconfig|\.npmrc|\.m2[\\/]settings\.xml|\.(?:bashrc|bash_profile|profile|zshrc|zprofile))(?:$|[\s'"`;&|])/i;
  const systemConfigPath = /(?:^|[\s'"`=])\/(?:etc[\\/](?:gitconfig|npmrc|maven[\\/]settings\.xml|profile(?:\.d[\\/][^\\/\s'"`;&|]+)?)|usr[\\/](?:share[\\/]maven[\\/]conf[\\/]settings\.xml|local[\\/](?:etc[\\/]npmrc|[^\\/\s'"`;&|]*jdk[^\\/\s'"`;&|]*[\\/]lib[\\/]security[\\/]cacerts))|Library[\\/]Java[\\/]JavaVirtualMachines[\\/][^\\/\s'"`;&|]+[\\/]Contents[\\/]Home[\\/]lib[\\/]security[\\/]cacerts)(?:$|[\s'"`;&|\\/])/i;
  const systemCertificatePath = /(?:^|[\s'"`=])\/(?:etc[\\/](?:ssl|pki)|usr[\\/]local[\\/]share[\\/]ca-certificates)(?:[\\/]|$)/i;
  const environmentConfigPath = /\$(?:\{(?:JAVA_HOME|M2_HOME|MAVEN_HOME)\}|(?:JAVA_HOME|M2_HOME|MAVEN_HOME))\/(?:lib\/security\/cacerts|conf\/settings\.xml)(?:$|[\s'"`;&|])/i;
  if (homeConfigPath.test(source)
    || systemConfigPath.test(source)
    || systemCertificatePath.test(source)
    || environmentConfigPath.test(source)) {
    return DENY("Build-Fix 会话不能读取或修改宿主的全局 Git、Maven、npm、JDK 或证书配置。");
  }

  // Write/Edit 的 value 在不同接线中可能是路径，也可能带着待写内容；一旦
  // 出现典型认证字段，宁可让宿主注入，也不能把凭据写进仓库配置。
  if (/\b(?:_authToken|authorization|private-token|oauth-token)\b\s*[:=]/i.test(source)) {
    return DENY("Build-Fix 会话不能读取、写入或持久化认证 Token。");
  }

  if (kind !== "bash") return undefined;

  // 不允许通过环境变量侧门把宿主密钥打印进上下文。指定 JAVA_HOME、PATH
  // 等非秘密变量仍可查看，`env FOO=bar npm test` 这类构建命令也不受影响。
  const secretEnvironment = /(?:^|[;&|\n]\s*)(?:env|printenv|set|export\s+-p)\s*(?:$|[;&|\n])|\$(?:\{[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*\}|[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*)|(?:^|[;&|\n]\s*)printenv\s+[A-Z_][A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z0-9_]*/i;
  if (secretEnvironment.test(source)) {
    return DENY("Build-Fix 会话不能枚举或输出宿主凭据环境变量。");
  }

  // Agent 只能产生本地提交。认证注入、remote 以及真正的 push 都由释放
  // 会话后的 Cloud 宿主统一完成，避免模型获得或持久化远端写权限。
  const shellSegments = source.split(/(?:&&|\|\||[;\n])/);
  for (const segment of shellSegments) {
    if (!/\bgit\b/i.test(segment)) continue;
    if (/\bgit\b[\s\S]*\bclone\b/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中重新克隆仓库；请使用 Cloud 已准备好的工作区。");
    }
    if (/\bgit\b[\s\S]*\bpush\b/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中执行 git push；Cloud 会统一推送已复核的 HEAD。");
    }
    if (/\bgit\b[\s\S]*\bremote\b[\s\S]*\b(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)\b/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中改写或更新 Git remote。");
    }
    if (/\bgit\b[\s\S]*\bcredential(?:-[\w-]+)?\b/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中读取、批准或改写 Git 凭据。");
    }
    if (/\bgit\b[\s\S]*\bconfig\b[\s\S]*(?:--global\b|--system\b)/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中修改宿主级 Git 配置；仅允许使用现有配置和本地提交。");
    }
    if (/\bgit\b[\s\S]*(?:\bconfig\b[\s\S]*\bhttp\.sslverify\b(?:\s|=)+["']?(?:false|0|no|off)\b["']?|(?:^|\s)-c\s*http\.sslverify\s*=\s*["']?(?:false|0|no|off)\b["']?)/i.test(segment)) {
      return DENY("禁止关闭 Git TLS 证书校验；证书问题应报告为宿主基础设施故障。");
    }
    if (/\bgit\b[\s\S]*\bconfig\b[\s\S]*(?:credential\.|remote\.|url\.|http\.[^\s=]*(?:extraheader|token|auth)|core\.askpass|include(?:if)?\.path|gpg\.program|[^\s=]*(?:token|password|passwd|secret|oauth)[^\s=]*)/i.test(segment)) {
      return DENY("禁止在 Build-Fix 会话中改写 Git 远端或凭据配置。");
    }
    if (/\bgit\b[\s\S]*\bclean\b/i.test(segment)
      || /\bgit\b[\s\S]*\breset\b[\s\S]*--hard\b/i.test(segment)
      || unsafeGitWorktreeDiscard(segment)) {
      return DENY("禁止整树或通配丢弃工作区改动；需要纠正误提交时，请用 git restore/checkout 精确到具体文件，再重新整理 commit。");
    }
  }

  // 直接编辑 .git/config 同样可以绕过上面的 git 子命令。
  if (/(?:^|[\\/\s'"`=])\.git[\\/]config(?:$|[\s'"`;&|])/i.test(source)
    || /\b(?:GIT|SSH)_ASKPASS\s*=/i.test(source)
    || /\bGIT_SSH_COMMAND\s*=/i.test(source)) {
    return DENY("禁止在 Build-Fix 会话中改写 Git 远端或认证入口。");
  }

  // 避免把 Token 直接塞进 URL/header，或让包管理器在 Agent 会话中登录、
  // 改用户配置和全局安装。常规 install/build/test 不受影响。
  if (/\bhttps?:\/\/[^\s'"/@:]+:[^\s'"/@]+@/i.test(source)
    || /\b(?:authorization|private-token|oauth-token)\s*[:=]\s*(?:bearer\s+)?[^\s'";&|]+/i.test(source)
    || /(?:^|\s)(?:--token|--password|--passwd)(?:=|\s+)/i.test(source)) {
    return DENY("禁止在 Build-Fix 会话中读取、传入或持久化远端 Token/密码。");
  }
  if (/\b(?:npm|pnpm|yarn)\b[\s\S]*\b(?:login|logout|adduser|token)\b/i.test(source)
    || /\b(?:npm|pnpm|yarn)\b[\s\S]*\bconfig\b[\s\S]*\b(?:set|delete|del|edit)\b/i.test(source)
    || /\b(?:npm|pnpm)\b[\s\S]*(?:\s-g\b|\s--global\b)[\s\S]*\b(?:add|install|i)\b/i.test(source)
    || /\b(?:npm|pnpm)\b[\s\S]*\b(?:add|install|i)\b[\s\S]*(?:\s-g\b|\s--global\b)/i.test(source)) {
    return DENY("禁止在 Build-Fix 会话中登录包仓、改写包管理器配置或安装全局工具。");
  }

  // TLS/证书只能由部署侧统一维护；专项 Agent 不得以“先跑通”为由关闭
  // 校验或改写系统/JDK truststore。
  if (/\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*0\b/i.test(source)
    || /\bGIT_SSL_NO_VERIFY\s*=\s*(?:1|true|yes|on)\b/i.test(source)
    || /\bNPM_CONFIG_STRICT_SSL\s*=\s*(?:0|false|no|off)\b/i.test(source)
    || /-Dmaven\.wagon\.http\.ssl\.(?:insecure|allowall)\s*=\s*true\b/i.test(source)
    || /\bkeytool\b[\s\S]*-(?:importcert|importkeystore|delete|changealias|storepasswd|keypasswd|genkeypair)\b/i.test(source)
    || /\b(?:update-ca-certificates|update-ca-trust)\b/i.test(source)
    || /\bsecurity\b[\s\S]*\badd-trusted-cert\b/i.test(source)) {
    return DENY("禁止关闭 TLS 校验或修改宿主/JDK 证书；请报告基础设施故障。");
  }

  // clean 生命周期交给真实构建工具；Agent 不需要原始递归强删能力。
  // 例外(内网实锤:playbook 教它删陈旧 CMake 生成目录,门禁却一刀切
  // 拦所有 rm -rf,自相矛盾):目标**全部**是公认构建产物路径时放行。
  // 判不了的(变量/反引号/绝对路径/..)一律按拒处理,fail-closed。
  // 同时拦住 find -delete，防止工作区被不可恢复地批量清空。
  const rmCommands = withoutShellRedirections(source)
    .match(/(?:\bsudo\s+)?\brm\s+[^;&|\n]*/gi) ?? [];
  for (const command of rmCommands) {
    const hasRecursive = /(?:^|\s)-(?!-)[^\s]*[rR][^\s]*|--recursive\b/.test(command);
    const hasForce = /(?:^|\s)-(?!-)[^\s]*f[^\s]*|--force\b/.test(command);
    // sudo 不享受产物豁免:正常构建清理从不需要提权。
    const viaSudo = /^\s*sudo\b/i.test(command);
    if (hasRecursive && hasForce
        && (viaSudo || !rmTargetsAreBuildArtifacts(command))) {
      return DENY("递归强制删除仅放行构建产物目录（target/、build/、"
        + "cmake-build*、CMakeFiles、CMakeCache.txt、node_modules 及其"
        + "子路径，相对路径）；其余请使用仓库构建工具的 clean 生命周期。");
    }
  }
  if (/\bfind\b[^;&|\n]*\s-delete\b/i.test(source)) {
    return DENY("禁止使用 find -delete 批量删除工作区内容;要清理构建"
      + "产物,请对产物目录整体使用 rm -rf（target/、build/ 等白名单"
      + "路径已放行）或走构建工具的 clean 生命周期。");
  }

  return undefined;
}

/** 递归强删的白名单判定:rm 的每个非选项参数都必须是公认的构建产物
 * 路径。相对路径、无 ..、无 shell 展开(变量/反引号/引号内命令替换)
 * 才有资格判;有一个参数判不了或不在名单,整条按拒。 */
function rmTargetsAreBuildArtifacts(rmCommand: string): boolean {
  if (/[`$]/.test(rmCommand)) return false;
  const targets = rmCommand
    .replace(/^\s*rm\s+/i, "")
    .split(/\s+/)
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter((token) => token && token !== "--" && !token.startsWith("-"));
  if (!targets.length) return false;
  const artifact = /^(?:\.\/)?(?:[\w.@+-]+\/)*(?:target|build|out|cmake-build[^/]*|CMakeFiles|node_modules)(?:\/[\w.@+*/-]*)?$|^(?:\.\/)?(?:[\w.@+-]+\/)*CMakeCache\.txt$/;
  return targets.every((target) =>
    !target.startsWith("/")
    && !target.startsWith("~")
    && !/(?:^|\/)\.\.(?:\/|$)/.test(target)
    && artifact.test(target));
}

export function parsePrePushAgentReport(text: string): PrePushAgentReport | undefined {
  // 只认最后一个收口块：模型在解释过程中可能复述格式示例，不能让前面的
  // 旧块覆盖最终结论。最后一块畸形时直接拒绝，不回退到较早的“通过”。
  const matches = [...text.matchAll(RESULT_PATTERN)];
  const matched = matches.at(-1);
  if (!matched) return undefined;
  if (Buffer.byteLength(matched[1], "utf-8") > MAX_RESULT_BYTES) return undefined;
  try {
    const value = JSON.parse(matched[1]) as Record<string, unknown>;
    const status = String(value.status ?? "");
    if (!["passed", "code_failure", "infrastructure_failure"].includes(status)) {
      return undefined;
    }
    const check = (raw: unknown): PrePushCheckReport | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const row = raw as Record<string, unknown>;
      if (typeof row.command !== "string" || row.command.includes("\0")) {
        return undefined;
      }
      const command = row.command.trim();
      const checkStatus = String(row.status ?? "");
      if (!command || command.length > 8_192
        || !["passed", "failed", "skipped"].includes(checkStatus)) {
        return undefined;
      }
      return {
        command,
        status: checkStatus as PrePushCheckReport["status"],
        ...(String(row.summary ?? "").trim()
          ? { summary: String(row.summary).trim() } : {}),
      };
    };
    const compile = check(value.compile);
    const unitTest = check(value.unit_test);
    if (!compile || !unitTest) return undefined;
    if (status === "passed"
      && (compile.status !== "passed" || unitTest.status !== "passed")) {
      return undefined;
    }
    if (status === "code_failure"
      && compile.status === "passed" && unitTest.status === "passed") {
      return undefined;
    }
    return {
      status: status as PrePushAgentReport["status"],
      compile,
      unit_test: unitTest,
      summary: String(value.summary ?? "").trim() || "Build-Fix 会话已收口",
    };
  } catch {
    return undefined;
  }
}

/** 平台现场文件:.mae-flow-work/ 下的笔记与日志、.mae-flow* 状态文件。
 * 它们由宿主登记进 .git/info/exclude,push 只传 HEAD,永远进不了交付,
 * 所以改它们不算"改过会进交付的文件"(只是事实展示的噪声过滤,不是门禁)。 */
export function isPlatformWorkPath(path: string): boolean {
  const segments = String(path ?? "").split(/[\\/]+/).filter(Boolean);
  if (segments.some((segment) => segment === ".mae-flow-work")) return true;
  const base = segments.at(-1) ?? "";
  // 状态文件按名单认(与 .git/info/exclude 登记的同一批),不吞
  // .mae-flow-workshop 这种名字相近的业务目录。
  return /^\.mae-flow\.json(?:\.exited)?$/.test(base)
    || /^\.mae-flow-(?:order\.json|chain\.md|dependencies\.md|issue\.md|history\.jsonl)$/.test(base);
}

/**
 * PASS 不能只认模型自述:报告中的编译与 UT 命令必须在本会话真实执行成功。
 * 只防凭空报 PASS,零误判。
 *
 * 2026-09-03 用户拍板去掉"必须发生在最后一次代码修改之后"的硬约束:那条
 * 防的是"改完没重跑拿旧绿灯"的走神,本仓记录里一例没发生过,记录在案的
 * 全是反过来——模型真跑了真绿了被冤枉(2026-08-21 整链试跑;内网 task-31
 * 写了一笔构建笔记就被判失效,两轮后 code_failure)。这道闸不是最终裁判,
 * 真裁判是绑 SHA 的流水线,旧绿灯漏过去的代价有界且自动修复;误判的代价
 * 是当场多跑一轮重型编译再把人叫来。顺序事实降级为"展示":见
 * prePushEvidenceFacts,写进收据让人在推送确认时自己看。
 */
export function verifyPrePushEvidence(
  events: SemanticEvent[],
  report: PrePushAgentReport,
): string {
  if (report.status !== "passed") return "验证会话没有报告通过";
  if (report.compile.status !== "passed" || report.unit_test.status !== "passed") {
    return "编译与 UT 必须同时通过";
  }
  const successful = successfulBashRuns(events).map((run) => run.command);
  if (!unmatchedReportedCommands(successful, report).length) return "";
  // 2026-09-04 用户拍板再降一级:上报命令与实跑对不上,但本会话确实成功
  // 跑过重型构建命令的,放行,把"对不上"写进收据让人在推送确认时自己判。
  // 内网 task-38 实锤:模型真改真跑真绿,只因实跑带了 `> /dev/null 2>&1`、
  // 变量加了引号、上报把三条 UT 合成一条加了中文说明,就被判"没跑过"。
  // 使命本来就允许简写(不必带 cd 前缀),等于明示可以整理——一整理就挂,
  // 是设计与使命自相矛盾,不是模型走神。这道闸真正要防的只有"凭空报
  // PASS",那种情况下一条重型命令都不会成功跑过。
  if (successful.some(isPrePushBuildCommand)) return "";
  return "报告中的编译/UT 命令没有在本会话真实成功执行，本会话也没有任何"
    + "重型构建命令成功跑过（编译与 UT 必须真的执行，不能只凭结论收口）: "
    + unmatchedReportedCommands(successful, report).join("；");
}

/** 上报的编译/UT 命令里,哪几条在本会话的成功执行记录里找不到。 */
function unmatchedReportedCommands(
  successful: string[],
  report: PrePushAgentReport,
): string[] {
  return [report.compile.command, report.unit_test.command]
    .filter((command) => !covers(successful, command));
}

/** 事实不裁决:最后一次成功跑过编译/UT 之后,还改过哪些会进交付的文件。
 * 平台笔记与状态文件(进不了交付)不列。给收据与推送确认卡看,人觉得该
 * 重跑就打回,不觉得就推。 */
export function prePushEvidenceFacts(
  events: SemanticEvent[],
  report: PrePushAgentReport,
): { changed_after_run: string[]; command_mismatch: string[] } {
  const runs = successfulBashRuns(events);
  const command_mismatch = unmatchedReportedCommands(
    runs.map((run) => run.command), report);
  const lastRunOf = (reported: string) => Math.max(0, ...runs
    .filter((run) => covers([run.command], reported)).map((run) => run.eventId));
  const lastRun = Math.min(
    lastRunOf(report.compile.command), lastRunOf(report.unit_test.command));
  // 命令对不上就没有"最后一次成功"这个基准点,列什么都是噪声:此时只报
  // 不一致,不谎称"某某文件在成功之后改过"。
  if (!lastRun) return { changed_after_run: [], command_mismatch };
  const changed = new Set<string>();
  for (const event of events) {
    if (event.kind !== "tool_requested" || event.eventId <= lastRun) continue;
    const payload = event.payload as Record<string, any>;
    if (!["Edit", "Write", "MultiEdit"].includes(String(payload.name ?? ""))) continue;
    const path = String(payload.input?.path ?? payload.input?.file_path ?? "");
    if (path && !isPlatformWorkPath(path)) changed.add(path);
  }
  return { changed_after_run: [...changed].sort(), command_mismatch };
}

/** 本会话里真实成功过的 Bash:请求与完成按 call_id 配对,失败的不算。 */
function successfulBashRuns(
  events: SemanticEvent[],
): Array<{ command: string; eventId: number }> {
  const requested = new Map<string, { command: string; eventId: number }>();
  for (const event of events) {
    if (event.kind !== "tool_requested") continue;
    const payload = event.payload as Record<string, any>;
    if (String(payload.name ?? "") !== "Bash") continue;
    requested.set(`${event.sessionId}:${String(payload.call_id ?? "")}`, {
      command: String(payload.input?.command ?? "").trim(),
      eventId: event.eventId,
    });
  }
  const runs: Array<{ command: string; eventId: number }> = [];
  for (const event of events) {
    if (event.kind !== "tool_finished") continue;
    const payload = event.payload as Record<string, any>;
    if (String(payload.name ?? "") !== "Bash" || Boolean(payload.is_error)) continue;
    const call = requested.get(`${event.sessionId}:${String(payload.call_id ?? "")}`);
    if (!call || !call.command || event.eventId <= call.eventId) continue;
    runs.push({ command: call.command, eventId: event.eventId });
  }
  return runs;
}

function covers(bucket: string[], reported: string): boolean {
  const needle = normalizeCommand(reported);
  if (!needle) return false;
  const normalized = bucket.map(normalizeCommand);
  if (normalized.some((actual) => actual.includes(needle))) return true;
  // 整条对不上再按片段:模型常把多条命令合成一条上报,也常省掉前置
  // cd/source。要求每个真正干活的片段都能在某条成功执行里找到——少跑
  // 一条仍然算不上,只是不再因为拼接方式不同而判死。
  const segments = commandSegments(reported);
  return segments.length > 0 && segments.every((segment) =>
    normalized.some((actual) => actual.includes(segment)));
}

/** 上报命令里真正干活的片段。cd/source/export 这类前置不单独算证据。 */
function commandSegments(command: string): string[] {
  return normalizeCommand(command).split(/&&|\|\||;/)
    .map((segment) => segment.trim())
    .filter((segment) => segment
      && !/^(?:cd|source|\.|export|set|unset|umask|pushd|popd)\s/.test(segment));
}

/**
 * 命令比对用的归一化。
 *
 * 为什么不是精确相等:使命要求"命令须与实际 Bash 调用完全一致",但模型
 * 实际发的是 `cd /很长的路径 && mvn test; echo TEST_EXIT=$?`,上报的是
 * `mvn test`——要它逐字节回抄一条带路径前缀和退出码后缀的 shell 命令,
 * 现实中不可能稳定做到。精确相等让这道闸**基本过不去**(2026-08-21
 * 首次整链试跑实测:三次合格的成功执行全部落空)。改成包含匹配。
 *
 * 松了多少要说清楚:上报 `mvn test`、实跑 `mvn test -DskipTests` 现在混得
 * 过去。接受这个代价的理由是这道闸的定位——push 前的快速反馈与流量闸门,
 * **不冒充最终质量裁判**;真裁判是绑提交 SHA 的流水线。一道永远过不去的
 * 闸比一道稍松的闸有害得多。"退出成功"这条硬约束没动。
 */
function normalizeCommand(command: string): string {
  const source = String(command ?? "")
    // 上报时补的说明:"…CommUtils.so（并同口径跑 X 与 Y）"。只削末尾,
    // 命令中间的括号可能是 shell 语法;$( 是命令替换,一律不碰。
    .replace(/(?<!\$)[（(][^（()）]*[)）]\s*$/, " ")
    // 退出码回显尾巴:`; echo TEST_EXIT=$?`
    .replace(/[;&]\s*echo\s+[\w]*EXIT[\w]*=\$\?\s*$/i, " ");
  return withoutShellRedirections(source)
    // 引号:`LD_LIBRARY_PATH="$X"` 与 `LD_LIBRARY_PATH=$X` 是同一条命令
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function prePushMission(
  request: PrePushRunRequest,
  executionBudget?: PrePushExecutionBudget,
): string {
  const buildGuidance = prePushBuildGuidance(request.workspace);
  const budgetGuidance = executionBudget
    ? "平台执行预算：整轮最多 "
      + `${Math.ceil(executionBudget.attemptTimeoutMs / 60_000)} 分钟；`
      + "Maven/CMake/Make/Gradle/npm 等重型构建单条至少获得 "
      + `${Math.ceil(executionBudget.buildCommandTimeoutMs / 60_000)} 分钟。`
      + "不要自行用 600 秒之类的短 timeout 截断已知慢编译；平台会提升"
      + "过短的重型构建 timeout，整轮硬上限仍负责终止真正卡死的任务。"
    : "";
  const foreign = request.foreignCommits;
  const foreignGuidance = foreign?.count ? [
    "",
    `分支上有 ${foreign.count} 条不是本任务产生的提交（有人直接往分支推了`
      + "代码），它们已经在当前历史里：",
    ...foreign.subjects.slice(0, 8).map((line) => `- ${line}`),
    "- 它们默认可信：不要回滚、改写、squash 或\"整理\"掉，也不要因为它们"
      + "编译不过就删代码。",
    "- 修复只针对真实的编译/测试失败；确实是这些提交带来的问题，就把结论"
      + "写进 summary 交给人，不要自己替人决定。",
  ] : [];
  const changeScope = request.changeScope;
  const scopeGuidance = changeScope ? [
    "",
    "提交范围自检（提示，不是目录黑名单，也不会因为文件多就机械拦截）：",
    `- 当前 HEAD 相对任务基线改动 ${changeScope.totalPaths} 个文件；`
      + `其中 ${changeScope.suspiciousPaths} 个带常见构建产物特征。`,
    "- 目录汇总：",
    ...changeScope.directorySummary.map(({ directory, count }) =>
      `  - ${directory}：${count} 个`),
    ...(changeScope.suspiciousExamples.length ? [
      "- 常见产物特征样例（只是线索，生成代码等合法提交要以仓库事实为准）：",
      ...changeScope.suspiciousExamples.map((path) => `  - ${path}`),
    ] : []),
    "- 开始重构建前先用 git diff --stat、git status、仓库忽略规则和需求范围"
      + "审计这些提交。不能只凭目录名删除，也不能把上千条文件甩给用户。",
    "- 全部合理：在最终 summary 用一句话说明原因，然后正常继续；无需询问用户。",
    "- 混入无关内容：使用精确路径 restore/checkout 或 reset --soft 自行整理 commit，"
      + "再重新编译和跑 UT；无需打扰用户。",
    "- 确实无法判断：以 code_failure 停下，只给目录数量汇总、可疑样例和一个"
      + "明确问题；不要输出上千条文件，也不要反复尝试同一操作。",
  ] : [];
  return [
    "你是 Cloud 的 Build-Fix Agent，按本次主动验证请求完成构建、测试与必要修复。这是独立专项会话，不在 Mae-Flow 内核流程中。",
    "不要执行 current、done、AskUserQuestion，也不要读取或修改 .mae-flow 状态。",
    `任务：${request.taskId}；待验证 HEAD：${request.sha}；目标分支：${request.branch}`,
    `需求背景：${request.requirement}`,
    "",
    "你的唯一目标：在当前仓库找到真实构建方式，完成编译与单元测试；遇到代码或测试问题就直接修复，",
    "然后重新执行编译和 UT，直至两项都通过。可以自由检查源码、测试、pom/build/CMake/package 配置，",
    "但不要顺手重构无关代码。代码修改使用 Edit/Write 工具，不要用 shell 文本替换伪装修改。",
    "如有修改，按下面的明确规范提交到本地 HEAD；禁止 push、改 remote、读取或写入任何凭据：",
    `- ${request.commitConvention?.trim() || DEFAULT_COMMIT_CONVENTION}`,
    "- 提交前用 git log -1 --format=%s 自检标题；不要使用 fix: / feat: / chore: 这类 Conventional Commits 简写。",
    `如果此前误带了文件，可以用 git restore --source=${request.baseline} -- <具体文件>`
      + "、git checkout <提交> -- <具体文件> 或 git reset --soft 重新整理本地 commit；"
      + "精确文件回退允许，全树/通配回退和 reset --hard 仍禁止。",
    // 这句话必须与 prePushSecurityDecision 的 rm 白名单同一口径:之前
    // 写成一刀切"禁止递归强删",与 playbook"删掉陈旧 CMake 生成目录"
    // 正面打架,听话的模型永远修不好陈旧 configure。同时定调:删产物
    // 是修理动作不是例行卫生——增量编译全靠这些目录跨轮存活。
    "Cloud 会在会话释放并复核后注入短期凭据、统一推送。构建产物默认**留在"
      + "工作区不要删**（增量编译靠它们跨轮加速，git status 不为空不影响"
      + "通过）；只在确有必要时（如陈旧 CMakeCache 指向旧路径）才 rm -rf "
      + "产物目录（target/、build/、cmake-build*、CMakeFiles、CMakeCache.txt、"
      + "node_modules，相对路径，白名单放行）；除产物目录外禁止递归强删，"
      + "clean 请走构建工具生命周期。",
    "不要仅为隐藏本轮编译产物修改业务仓 .gitignore，更不要把 build/、test/"
      + " 这类可能含源码的宽目录整体忽略；只有需求明确包含仓库忽略规则治理时，"
      + ".gitignore 才是本单交付内容。",
    "平台现场文件(.mae-flow* / openspec/config.yaml 等)不归你管：它们已被平台登记忽略，",
    "即使仍显示为未跟踪也不要提交、删除，更不要为它们修改用户的 .gitignore——那是用户的文件。",
    `Agent 平台目录(${describeAgentPlatformRoots()})也可能是中心服务 clone 后`
      + "注入的本地 Skill/配置：只读使用，禁止修改、强制 add 或提交；"
      + "Cloud 会在 push 前复核整个提交历史。",
    ...scopeGuidance,
    ...foreignGuidance,
    "依赖下载、工具缺失、磁盘/网络/权限等不是改代码能解决的问题，归类为 infrastructure_failure，",
    "写清缺什么后停止，不要为了制造绿灯篡改测试、关闭检查或编造执行结果。",
    "",
    buildGuidance,
    budgetGuidance,
    "改了会进交付的文件(源码、测试、构建配置)之后记得重跑编译和受影响范围的定向 UT——平台不硬拦,"
      + "但会把「最后一次成功之后还改过哪些文件」写进收据给人看;写 .mae-flow-work/build-notes.md"
      + " 这类平台笔记不算改动,不用因此重跑。",
    "同一份代码内容不要原样重复执行同一条重型编译/测试命令：首次失败后先读日志、"
      + "修代码或运行更小范围的定向检查；只有代码改变或确认属于短暂环境抖动时才重试。"
      + "Cloud 会复用同一代码内容上已经成功的相同命令，并在连续失败且代码未变化时阻止第三次空跑。",
    "Build-Fix 不跑全仓 UT：一次全量可能耗时一小时，不应在每轮修复里重复执行。"
      + "只跑本次改动或当前失败直接影响的模块、测试类、suite/case；全量回归由远端权威流水线负责。"
      + "Java/JS/Go/Rust/Python 这类有标准定向入口的，平台会直接拦下无过滤的全量命令，"
      + "换成显式选择器即可。C++/native 平台只提示不拦：先老实找仓库支持的定向方式"
      + "（DT include、ctest -R、runner 的 suite/case 过滤），确实找不到就照常跑全量，"
      + "并在 summary 里写清为什么没能定向——不要因此停下不跑 UT。",
    "",
    // 原文要求"与实际 Bash 调用完全一致",但模型实际发的是带 cd 前缀和
    // 退出码后缀的长命令,做不到逐字节回抄——这条契约把闸卡死过(实测)。
    // 现在只要求写真正执行的那一段构建命令,宿主按包含匹配核对。
    "收口前确认本轮业务代码修改已经提交到 HEAD。编译产物可以留在工作区："
      + "Cloud push 只传 HEAD，不要求 git status 为空；不要为了清空状态把"
      + "编译产物提交进去或修改业务仓 .gitignore。最后一段必须严格输出下面结构"
      + "（command 写你真正执行的那段构建命令原文，如 `mvn -pl order -Dtest=OrderServiceTest test`；不必带 cd 前缀"
      + "和 echo 退出码后缀，但**不能写没跑过的命令**，宿主会回执行记录核对）：",
    "<prepush-result>",
    '{"status":"passed|code_failure|infrastructure_failure",'
      + '"compile":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"unit_test":{"command":"实际命令","status":"passed|failed|skipped","summary":"简述"},'
      + '"summary":"最终结论"}',
    "</prepush-result>",
    "只有编译和 UT 都在最后一次代码修改后真实返回成功，status 才能写 passed。",
    // 用户 2026-08-22 点名的担心:"我就怕只跑编译不跑 UT"。
    // 宿主侧刻意不加"这条命令是不是在跑测试"的判定(会误伤 UT 入口不含
    // test 字样的仓),所以这里必须说到明面上——这条靠的是嘱咐,不是闸。
    // 措辞不许夸大宿主的核对能力:它核的是"你上报的命令确实成功跑过",
    // 核不出那条命令跑的是编译还是测试。
    "unit_test 必须填**真跑过的定向测试**命令（Java 编译栏可用"
      + " `mvn package -DskipTests`，UT 栏使用带 `-pl` / `-Dtest` 的测试命令；"
      + "C++ 使用仓库 DT include、runner suite/case 或 `ctest -R` 过滤；JS 使用测试文件/用例过滤），"
      + "**不能把编译命令填进 UT 栏顶账**：只编译不跑 UT 等于这一关没做，"
      + "代价是把没测过的代码推上去烧流水线。"
      + "C++/native 仓确实找不到可用的定向入口时，可以跑全量 UT 并在 summary 写清原因；"
      + "其他生态没有定向入口时如实报 code_failure 并写清楚。任何情况下都不要以编译代替 UT。",
  ].join("\n");
}

/** A model turn ending is not a build process completion signal. */
export class PrePushCommands {
  private pending = new Set<Promise<unknown>>();
  async run<T>(execute: () => Promise<T>): Promise<T> {
    const command = execute();
    this.pending.add(command);
    try { return await command; }
    finally { this.pending.delete(command); }
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

export function unfinishedPrePushTools(events: SemanticEvent[]): SemanticEvent[] {
  const pending = new Map<string, SemanticEvent>();
  for (const event of events) {
    const key = `${event.sessionId}:${event.payload.call_id}`;
    if (event.kind === "tool_requested") pending.set(key, event);
    if (event.kind === "tool_finished") pending.delete(key);
  }
  return [...pending.values()];
}

/** Called only after the execution container has actually stopped. */
export function recordInterruptedPrePushTools(log: EventLog): void {
  for (const event of unfinishedPrePushTools(log.replay())) {
    log.append({
      ...event, eventId: log.lastEventId() + 1,
      ts: new Date().toISOString(), kind: "tool_finished",
      payload: { ...event.payload, is_error: true,
        result: "Build-Fix 会话结束且容器已停止，工具缺少可靠结果，登记为 interrupted；重试前核实现场",
      },
    });
  }
}
