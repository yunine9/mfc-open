import { resourceBlocked } from "../repositoryResourcePolicy.ts";
/**
 * 问题会话的首轮提示词与 playbook 改编技能。
 *
 * 技能源头是仓内静态目录 assets/issue-skills/(标准 skill 目录形态,
 * 支持分类层递归组织:直接含 SKILL.md 的目录即一个技能,见
 * discoverIssueSkillPackages),从 every-skill 仓的 playbook 改编而来,适配云上:
 * - 工号不再是 $HOME 目录名,而是平台注入的登录账号;
 * - 二进制/MCP 不由 Agent 直调,换成宿主工具(build_deploy/
 *   push_branch/create_mr/dts_get_ticket/get_issue_meta);
 * - 新增"非问题出口":研究结论可以就是终点,不强制进编码交付。
 * 每次会话启动时从源目录整读、物化到工作区 skills/ 下(幂等重写)。
 * 技能文本与它引用的宿主工具同仓同版本演进——改工具就得同 commit
 * 改技能,评审看得见;想直接改文案就编辑 md 文件,不再碰 TS 字符串。
 *
 * 开场/通知/回执的提示词文案同理外置于 assets/issue-prompts/(ADR-0015),
 * 由 promptCopy 挂载取段;本文件保留的是结构与插值(事实块、阶段简报、
 * 措辞已全部搬走的条文不再在此)。
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IssueSessionState } from "./state.ts";
import type { IssueInterventionTier } from "../auth.ts";
import { issueRepoWorkspaces } from "./state.ts";
import { attachmentSourceText, extractIssueAttachmentPaths } from "./issueAttachments.ts";
import { REVIEWS_DIR, REVIEW_NOTES_SNAPSHOT } from "./reviews.ts";
import {
  FIXED_STAGE_LABELS,
  fixedStages,
  type FixedStage,
  type IssueScenario,
  ENV_TYPE_LABELS,
} from "./state.ts";
import { fixedStageSpec, stageBriefLines, stageToolLine } from "./stageRegistry.ts";
import { businessKnowledgeLines } from "./businessKnowledge.ts";
import { promptCopy } from "./promptCopy.ts";

/** 技能源目录:标准 skill 目录形态——技能包 = 直接含 SKILL.md 的目录,
 * 支持分类层递归组织(如 engineering/<名>/SKILL.md),目录名即技能
 * 装载名且必须全局唯一(测试对源断言用)。 */
export const SKILL_SOURCE_DIR = resolve(
  fileURLToPath(import.meta.url), "..", "..", "..",
  "assets", "issue-skills");

/** 技能发现的递归深度上限(与团队货架 collectSkillFiles 同约定)。 */
const MAX_SKILL_SOURCE_DEPTH = 8;

/** 递归发现源目录下的技能包:目录直接含 SKILL.md 即一个包,发现即止
 * (不进包内再找技能,包的子目录是资源不是分类);普通文件跳过。
 * 分类层只是维护者的源码组织——物化目的地仍平铺 workspace/
 * skills/<名>/,技能正文里写死的 ./skills/<名>/ 引用(如 fetch-logs
 * 的 bin 引擎)不因分层漂移。 */
export function discoverIssueSkillPackages(
  sourceDir: string,
): Array<{ name: string; dir: string }> {
  const found: Array<{ name: string; dir: string }> = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_SKILL_SOURCE_DEPTH) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const absolute = join(dir, entry.name);
      if (existsSync(join(absolute, "SKILL.md"))) {
        found.push({ name: entry.name, dir: absolute });
      } else {
        walk(absolute, depth + 1);
      }
    }
  };
  walk(sourceDir, 0);
  return found.sort((left, right) => left.name < right.name ? -1
    : left.name > right.name ? 1 : 0);
}

/** 把技能整包物化到工作区(幂等重写),返回工作区内物化后的 SKILL.md 路径。
 * 整包 = 技能目录内所有文件随 SKILL.md 一起走(2026-09-04 拍板:平台
 * 自带技能与团队货架同范式,可携带 bin/ 可执行引擎——日志抓取引擎
 * 已落 fetch-logs/bin)。支持分类层源目录(递归发现,见上),物化目的地
 * 恒平铺。源目录缺失、递归后一个技能都没有、目录名重复,都 fail-loud:
 * 技能是行为契约,静默少一个等于让 Agent 少一条规矩,不如启动就响。
 * 返回物化路径而非源路径:pi 把它原样写进系统提示的技能索引 location
 * (name/description/location 三件套),AI 照指路读文件,而沙箱只放行
 * 会话工作区——喂源路径(#359 的事故路径)AI 一读就被拦,只能靠猜
 * 相对路径自愈。需求侧货架 skill 喂的同样是工作区内快照路径。 */
export function materializeIssueSkills(
  workspace: string,
  sourceDir: string = SKILL_SOURCE_DIR,
): string[] {
  if (!existsSync(sourceDir)) {
    throw new Error(`问题会话技能源目录缺失: ${sourceDir}`);
  }
  const packages = discoverIssueSkillPackages(sourceDir);
  if (!packages.length) {
    throw new Error(
      `技能源目录递归后未发现任何技能(直接含 SKILL.md 的目录): ${sourceDir}`);
  }
  const paths: string[] = [];
  const claimed = new Set<string>();
  for (const pkg of packages) {
    if (claimed.has(pkg.name)) {
      throw new Error(
        `技能目录名重复: ${pkg.name}(分类层只改组织不重名,源: ${sourceDir})`);
    }
    claimed.add(pkg.name);
    copyPackage(pkg.dir, join(workspace, "skills", pkg.name));
    paths.push(join(workspace, "skills", pkg.name, "SKILL.md"));
  }
  return paths;
}

/** 递归整包拷贝;bin/ 下的引擎补执行位(git 不一定保留 +x,物化兜底)。 */
function copyPackage(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyPackage(src, dest);
    else {
      copyFileSync(src, dest);
      if (entry.parentPath.endsWith("bin")) chmodSync(dest, 0o755);
    }
  }
}

// ---- 登记元信息(提示词块与 get_issue_meta 工具的同一事实源) ----

/** 网管环境从 vault 解出的明文凭据。ADR-0003 裁定:网管口令是现场
 * 公开的出厂默认值,允许进 AI 上下文——"密码不进上下文"的铁律只
 * 覆盖平台凭据(Git 令牌、登录口令);vault 落盘的卫生不变,解密只
 * 由持有 vault 的服务层做,这里只收解出的明文。解不出(闸未补配/
 * 凭据组缺席)按缺省,对应字段不出现。 */
export interface IssueEnvCredentials {
  /** 网管后台密码(operator/serviceaccount/administrator 共用)。 */
  backend?: string;
  /** 独立 root 密码(#150,ADR-0020):只在显式凭据组在场时由服务层
   * 解出;继承后台密码的会话缺席,出口按"没有独立 root"处理。 */
  root?: string;
}

/** 登记元信息:手工登记时人填的输入全量(标题/现象/登记附件/模块/
 * 带出仓/产品版本/网管环境/登记人/责任人)加现场指针(流程形态/单号/
 * 修复分支/知识仓/转正来源)。大块内容一律给引用不给本体——知识仓给
 * 工作区路径,附件给文件路径,AI 拿指针自己读。
 * module/environment 只在会话真带这些信息时出现——DTS 页签发起的会话
 * 环境闸还没补配,键整段缺席,不造空壳。reporter 只在登记人≠责任人
 * (登记指派,ADR-0031)时出现——AI 该知道现象描述出自谁之手,自登记
 * 两号同一不必赘述。 */
export interface IssueRegistrationMeta {
  /** 流程形态(有单/无单):阶段路线与出口不同,工具清单随之有别。 */
  scenario: IssueScenario;
  title: string;
  description: string;
  /** 附加信息(原发起备注,2026-10-15 #502 更名):DTS 列表发起时
   * 人随单填写的文字,尾部可带随单上传的附件路径引用(要求 AI 重点
   * 优先读);缺席=发起时没填。 */
  remark?: string;
  /** 登记人(ADR-0031):通常是测试,问题由其登记提交;缺席=自登记。 */
  reporter?: string;
  /** 责任人工号:会话归属人与唯一推进者(CONTEXT.md 登记元信息词条
   * 本就包含它,此前实现漏了,2026-09-19 补齐)。 */
  account: string;
  /** 登记附件(attachments/<hash>.<ext>,工作区相对路径):人随描述
   * 或 DTS 发起附加信息上传的日志等分析材料,开场词单列一行引导优先
   * 查看;缺席=没传。 */
  attachments?: string[];
  module?: { id: string; name: string };
  /** 登记仓全量:url 是克隆源,dir 是会话工作区内的落位(AI 按工作区
   * 相对路径读代码,不必自己从地址推仓名)。 */
  repos: Array<{ url: string; dir: string }>;
  /** 产品版本(登记必填;DTS 发起按单据版本号经配置中心映射,手工
   * 登记人选)与解析出的拉仓基线分支。 */
  product_version?: string;
  baseline?: string;
  /** 单号与修复分支(有单才有;无单会话两键缺席)。 */
  ticket?: string;
  repair_branch?: string;
  /** 知识仓指针(#286,ADR-0033):只读参考件的工作区落位,内容 AI
   * 自己翻目录;装载未成功(skipped)缺席。 */
  knowledge_repo?: { name: string; dir: string };
  /** 转正来源:本会话由哪个无单挂起会话转正而来,交付账在旧会话。 */
  inherited_issue?: string;
  environment?: {
    name: string;
    hosts: string[];
    /** 环境形态(虚拟化/容器化 K8s):日志抓取引擎的选择依据;
     * 登记或配置卡没选时缺席,AI 举卡补齐,不自行猜。 */
    env_type?: "virtualized" | "k8s";
    backend_password?: string;
    /** 独立 root 密码:显式设置时才有(留空语义 = 与后台密码相同,
     * 那种会话这里缺席)。 */
    root_password?: string;
  };
}

/** 元信息组装单源:开场词/续聊词的渲染与 get_issue_meta 的返回都
 * 从这里出,工具与提示词永不各说各话。 */
export function issueRegistrationMeta(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
): IssueRegistrationMeta {
  const env = state.environment;
  // 工作区落位与仓一一对应(issueRepoWorkspaces 内含 repo_urls/repo_url
  // 兼容与重名去重),剥掉可能的前导分隔符,给人看的恒是相对形态。
  const repos = issueRepoWorkspaces(state, "").map(({ url, dir }) => ({
    url, dir: dir.replace(/^[\\/]/, ""),
  }));
  // 附件两源(#502):无单嵌在描述,DTS 发起随单上传的拼在附加信息
  // 尾部——合并提取去重,开场词/续聊词/元信息工具同一份。
  const attachments = extractIssueAttachmentPaths(
    attachmentSourceText(state.description, state.remark));
  return {
    scenario: state.scenario ?? "ticket",
    title: state.title,
    description: state.description,
    ...(state.remark ? { remark: state.remark } : {}),
    account: state.account,
    ...(attachments.length ? { attachments } : {}),
    ...(state.reporter && state.reporter !== state.account
      ? { reporter: state.reporter }
      : {}),
    ...(state.module_id
      ? { module: {
        id: state.module_id,
        name: state.module || state.module_id,
      } }
      : {}),
    repos,
    ...(state.product_version ? { product_version: state.product_version } : {}),
    ...(state.baseline ? { baseline: state.baseline } : {}),
    ...(state.ticket
      ? { ticket: state.ticket,
        // 修复分支定名(ADR-0063)在首次拉仓时生成并持久化;未定名时
        // 缺席,如实让 AI 以拉仓回执为准,不预写一个算不出的名字。
        ...(state.fix_branch ? { repair_branch: state.fix_branch } : {}) }
      : {}),
    ...(knowledgeReady(state)
      ? { knowledge_repo: {
        name: state.knowledge_repo!.name,
        dir: `repo/${state.knowledge_repo!.name}/`,
      } }
      : {}),
    ...(state.converted_from ? { inherited_issue: state.converted_from } : {}),
    ...(env
      ? { environment: {
        name: env.name,
        hosts: [...env.hosts],
        ...(env.env_type ? { env_type: env.env_type } : {}),
        ...(credentials.backend
          ? { backend_password: credentials.backend }
          : {}),
        ...(credentials.root ? { root_password: credentials.root } : {}),
      } }
      : {}),
  };
}

/** 元信息的网管环境段(开场词/续聊词用):四件套明文(ADR-0003),
 * 没有环境整段缺席——闸未补配的会话不渲染空壳。 */
function environmentLines(meta: IssueRegistrationMeta): string[] {
  const env = meta.environment;
  if (!env) return [];
  return [
    `- 网管环境「${env.name}」(网管口令是现场公开的出厂默认值,凭据`
      + "明文如下,用户问起直接回答):",
    `    - 服务器地址: ${env.hosts.join(", ")}`,
    ...(env.env_type
      ? [`    - 环境形态: ${ENV_TYPE_LABELS[env.env_type]}(决定日志抓取用哪套引擎,见技能 fetch-logs)`]
      : []),
    ...(env.backend_password
      ? [`    - 网管后台密码(operator/serviceaccount/administrator 共用): ${env.backend_password}`]
      : []),
    ...(env.root_password
      ? [`    - root 密码(独立设置;与后台密码不同): ${env.root_password}`]
      : []),
  ];
}

/** 元信息的模块行(模块是三路发起的必选项,开场必在,ADR-0056)。 */
function moduleLine(meta: IssueRegistrationMeta): string {
  if (!meta.module) return "";
  return `- 业务模块: ${meta.module.name}(id: ${meta.module.id})`;
}

/** 多仓清单块:全部平铺 repo/<仓名>/(2026-08-28 拍板:仓平等,无主从)。
 * 路径相对会话工作区(Agent 的 cwd 就是工作区根),每行 = 工作区路径 +
 * 克隆源地址。本地路径仓补一句不可直读:源路径与本机真实目录同名同在,
 * 被当可读路径会撞工作区护栏(实测 issue-24 踩坑)。克隆状态不标注——
 * 契约已要求登记在册的仓逐个 pull_repo 落地(幂等),不必在此复述。
 * 空清单返回空串,由调用方给"未登记"文案。 */
function repoLines(state: IssueSessionState): string {
  const repos = issueRepoWorkspaces(state, "");
  if (!repos.length) return "";
  const lines = repos.map((repo) => {
    const rel = repo.dir.replace(/^[\\/]/, "");
    const source = /^https?:\/\//i.test(repo.url)
      ? repo.url
      : `本地路径源 ${repo.url}(工作区外不可直读,读代码用 ${rel}/ 相对路径)`;
    return `  - ${rel}/ —— ${source}`;
  });
  return `- 代码仓(平铺在 repo/ 下,使用工作区相对路径):\n${lines.join("\n")}`;
}

/** 知识仓装载成功的会话判定:指针行与交接提醒共用的唯一门(#286)——
 * skipped 一律不注入,不给 AI 指一个不存在的路径。 */
function knowledgeReady(state: IssueSessionState): boolean {
  return state.knowledge_repo?.status === "ready";
}

/** 知识仓指针行(#286,ADR-0033):只在装载成功在场——skipped
 * 不注入,不给 AI 指一个不存在的路径。只读语义由交付链切割保证(不在
 * 关联仓台账),这里声明给 AI 是行为引导,不是安全边界。 */
function knowledgeRepoLine(state: IssueSessionState): string {
  if (!knowledgeReady(state)) return "";
  const knowledge = state.knowledge_repo!;
  return `- 知识仓: repo/${knowledge.name}/(只读参考——团队领域知识统一治理仓,`
    + "缺领域事实先翻它的目录;不可修改、不可交付)";
}

/** 统一检索工具引导行(ADR-0062):knowledge 工具常驻问题会话,正式
 *  知识(团队文档/业务知识/已采纳经验)优先走它;知识仓克隆在场
 *  时声明主次——工具检索的是平台权威正本,克隆是可能滞后的人读副本。
 *  用「业务知识」不用「业务模块知识」:后者是需求侧消费形态名
 *  (CONTEXT.md 该词条 Avoid)。 */
function knowledgeToolLine(state: IssueSessionState): string {
  return knowledgeReady(state)
    ? "- 团队知识: 正式文档、业务知识与已采纳经验优先用 knowledge 工具检索"
      + "(权威正本,实时可查);repo/ 下知识仓克隆只作补充参考"
    : "- 团队知识: 正式文档、业务知识与已采纳经验用 knowledge 工具检索";
}

/** 阶段名(固定流程词表;无场景的存量现场按原始键兜底显示)。 */
export function stageLabelOf(state: IssueSessionState): string {
  return state.scenario
    ? FIXED_STAGE_LABELS[state.scenario][state.stage as FixedStage]
      ?? String(state.stage)
    : String(state.stage);
}

// ---- 固定流程(2026-08-27 拍板:宿主权威阶段机,Agent 只在阶段内干活) ----

// 阶段简报(引导层)从阶段注册表生成:目标/出口/可用工具都是注册表的
// 一行声明,与工具门禁(权威层)同源——这里不再手工复写工具清单,
// 引导层说能用的与权威层放行的不会漂移。渲染函数 stageBriefLines 也
// 住在注册表:开场词/交接词/催办词/工具回执共用同一份三行简报。

/** 必读 skill 清单行(ADR-0011,已封存——ADR-0014 起不再产生新台账):
 * 仅存量会话的 skill_selection 在场时随 analyze 简报注入,开场词与
 * 续聊词共用,重启重建的上下文同样看得见历史圈选结果。 */
export function skillSelectionLines(state: IssueSessionState, blockedPaths: string[] = []): string[] {
  const skills = (state.skill_selection?.skills ?? []).filter(skill => !resourceBlocked(skill.path, blockedPaths));
  if (state.stage !== "analyze" || !skills.length) return [];
  return [
    "必读 skill(用户圈选,分析前先读;路径相对会话工作区):",
    ...skills.map((skill) =>
      `- ${skill.path}${skill.description ? ` — ${skill.description}` : ""}`),
  ];
}

export function issueFixedOpeningPrompt(
  state: IssueSessionState,
  credentials: IssueEnvCredentials = {},
  /** 介入档位的节奏渲染(ADR-0019,现读现判):一档=全自动(报告
   * 会被代答确认);二档=优先报告(报告是唯一停靠点);三档=优先
   * 对齐,主动问与对齐(ADR-0006)。 */
  options: { tier?: IssueInterventionTier; blockedPaths?: string[] } = {},
): string {
  const scenario = state.scenario ?? "ticket";
  const stages = fixedStages(scenario).map((stage) =>
    FIXED_STAGE_LABELS[scenario][stage]).join(" → ");
  const current = state.stage as FixedStage;
  // 文案在 assets/issue-prompts/opening.md(ADR-0015);结构与插值留代码。
  const inheritedNote = state.converted_from
    ? "\n- " + promptCopy("opening", "fixed.inherited",
      { from: state.converted_from })
    : "";
  const meta = issueRegistrationMeta(state, credentials);
  const skillLines = skillSelectionLines(state, options.blockedPaths);
  // 资产库地图(ADR-0012)只在 analyze 注入;docs 置信度分层已挪技能
  // repo-docs(ADR-0021 同日修订),不再随开场/续聊常驻。
  const knowledgeLines = businessKnowledgeLines(state);
  const brief = promptCopy("briefs", `stage.${current}`);
  const contract = promptCopy("opening", "fixed.contract", {
    stage_brief:
      `当前阶段「${FIXED_STAGE_LABELS[scenario][current]}」:`
      // 简报锚点自带收尾句号时不再补,修"。。"双句号(2026-09-11 实锤)。
      + `${brief.replace(/。+$/, "")}。`
      + `怎么算完:${fixedStageSpec(current).exit}。可用工具:${stageToolLine(current)}。`,
    skill_lines: skillLines.length ? skillLines.join("\n") + "\n" : "",
    knowledge_lines: knowledgeLines.length
      ? knowledgeLines.join("\n") + "\n" : "",
    intervention: promptCopy("opening",
      options.tier === "3" ? "fixed.intervention.guard"
        : options.tier === "1" ? "fixed.intervention.full_auto"
        : "fixed.intervention.report_review"),
  });
  if (scenario === "mr_repair") return [
    "你在流水线修复工具中处理用户提供的 MR，复用已有工作台和修复能力，独立于问题会话与 DTS 交付。拉单、问题分析和问题修改等前置阶段不适用，没有被执行或自动批准。",
    `MR：${state.imported_mr?.url}；源分支：${state.fix_branch}；目标分支：${state.baseline}；仓库：${state.repo_url}。`,
    ...stageBriefLines(scenario, "mr_green", ""),
    "沿用本工作台的工具、代码差异、对话、执行日志和恢复能力。不要关闭测试或检查规则来制造绿灯；无法修复时如实说明原因。流水线通过后总结本次工具修复并结束；不推进 DTS、审批、合入或归档，不要求网管环境验证。",
  ].join("\n\n");
  const facts = [
    `- 标题: ${meta.title}`,
    `- 描述: ${meta.description || "(无补充描述)"}`,
    // 附加信息单列一行(2026-09-20 拍板,2026-10-15 #502 更名):发起
    // 人随单填写的指示与随单附件,埋在描述里会被略读——单列并明确
    // "重点优先读、遵照执行"。附件行已单列,这里不重复引导。
    ...(meta.remark
      ? [`- 附加信息: ${meta.remark}(发起人在 DTS 列表随单填写,`
          + "重点优先读:开工前先完整读一遍并遵照其中的指示处理)"]
      : []),
    // 登记附件单列一行(2026-09-19 拍板):日志是核心分析材料,埋在
    // 描述正文里容易被略读,单列并明确"优先查看"。
    ...(meta.attachments?.length
      ? [`- 登记附件: ${meta.attachments.join("、")}`
          + "(用户上传的日志等文件,优先查看附件再下结论;"
          + "压缩包先解压再读)"]
      : []),
    moduleLine(meta),
    `- 单号: ${state.ticket ?? "(无单号场景:测试/开发自行定位,确认是问题即闭环归档并产出提单模板)"}`,
    `- 工号: ${state.account}`,
    ...(meta.reporter
      ? [`- 登记人: ${meta.reporter}(问题由登记人登记并指派,现象描述出自其视角,` +
          "你推进过程中作答与决策的对象是责任人)"]
      : []),
    ...(meta.product_version
      ? [`- 产品版本: ${meta.product_version}`
          + (meta.baseline ? `(拉仓基线分支: ${meta.baseline})` : "")]
      : meta.baseline
        ? [`- 拉仓基线分支: ${meta.baseline}`]
        : []),
    repoLines(state)
      || "- 代码仓: (未登记——AskUserQuestion 问用户要地址,再 pull_repo 拉取)",
    knowledgeRepoLine(state),
    knowledgeToolLine(state),
    ...(scenario === "ticket" && state.ticket
      ? [state.fix_branch
        ? `- 修复分支 ${state.fix_branch}(平台生成并全程固定,推送与 MR 源分支都用它)`
        : "- 修复分支:首次拉仓时由平台生成并固定"
          + "(命名 基线_工号_单号_时间戳),以 pull_repo 回执为准"]
      : []),
    ...environmentLines(meta),
    inheritedNote,
  ].filter(Boolean).join("\n");
  // 段落间空行是渲染结构(filter(Boolean) 会吞 "" 占位,空行随段块拼接)。
  // 参考组件仓目录(ADR-0054):发起时刻的订阅快照,skill 描述同款
  // 机制——AI 天天看得见,按「何时需要读取」自行决定拉不拉;无订阅
  // 整节省略(零污染)。
  const referenceRepoCatalog = (state.reference_repos ?? []).length
    ? `## 参考组件仓目录(公共组件源码,按需研读)\n\n`
      + (state.reference_repos ?? []).map((row) =>
        `- ${row.name}(${row.url})\n  何时需要读取: ${row.description}`)
          .join("\n")
      + `\n\n定位问题需要看公共组件源码时,照抄地址调 pull_repo 拉取;`
        + `命中登记表的地址会成为参考仓(只读参考件:可研读,不可修改、`
        + `不可交付)。不需要就不拉。`
    : "";
  return [
    promptCopy("opening", "fixed.header"),
    `## 问题事实\n\n${facts}`,
    referenceRepoCatalog,
    `## 阶段路线(${scenario === "ticket" ? "有单五阶段" : "无单三节点"})\n${stages}`,
    `## 阶段机契约(平台机械执行,说了算)\n${contract}`,
    promptCopy("opening", "fixed.kickoff"),
  ].filter(Boolean).join("\n\n");
}

/** 固定流程的平台推进通知(continueWith 注入):带上下文的阶段交接词。
 * 知识仓交接提醒(#286)随词注入:进分析/进修复各一次(拍板:开场
 * 指针行之外,分析、修改两处再提醒);未装载(skipped)不提醒。 */
export function fixedAdvanceNotice(
  state: IssueSessionState,
  message: string,
): string {
  const scenario = state.scenario ?? "ticket";
  const current = state.stage as FixedStage;
  const knowledge = state.knowledge_repo;
  const remindKnowledge = knowledge && knowledgeReady(state)
    && (current === "analyze" || current === "fix")
    ? [promptCopy("notices", "advance.knowledge_remind",
      { name: knowledge.name })]
    : [];
  return [
    `平台通知: ${message}`,
    ...stageBriefLines(scenario, current,
      promptCopy("briefs", `stage.${current}`)),
    ...remindKnowledge,
  ].join("\n");
}

/** 催办续跑通知:模型在阶段未收口时提前收嘴,把阶段简报原样砸回去。 */
export function fixedNudgeNotice(
  state: IssueSessionState,
  attempt: number,
  budget: number,
): string {
  const scenario = state.scenario ?? "ticket";
  const current = state.stage as FixedStage;
  // 欠环境验证卡(mr_green 已收口、卡未举)用专用催办词:要的不是
  // "继续推进阶段",而是"把验证卡交出去"(#246,ADR-0024)。
  if (current === "mr_green" && !state.gate) {
    return promptCopy("notices", "nudge.env_verify_owed", {
      attempt, budget,
      remain: budget - attempt + 1,
    });
  }
  // fix 阶段推完代码停在原地等绿(#357)用专用催办词:此轨迹下没有
  // MR 也没有监看表(挂表要该仓已有 MR),"等绿"等不到任何通知;通用
  // 催办词砸回简报纠正不了"等绿才能申报"的误读,专用词直接拆掉前提。
  // 有 MR 在账不走这里——监看在场时催办本就不触发,等绿后归
  // settlePipeline 的全绿提醒(pipeline.green.remind_fix)。
  if (current === "fix" && !state.mrs?.length && state.pushes?.length
      && !Object.values(state.pipelines ?? {})
        .some((watch) => watch.watching || watch.status === "running")) {
    return promptCopy("notices", "nudge.fix_wait_pipeline", {
      attempt, budget,
      remain: budget - attempt + 1,
    });
  }
  return promptCopy("notices", "nudge.body", {
    attempt,
    budget,
    stage_brief: stageBriefLines(scenario, current,
      promptCopy("briefs", `stage.${current}`)).join("\n"),
    remain: budget - attempt + 1,
  });
}

/** 续聊提示词的选项(服务侧组装;独立成接口是让 service 的组装助手
 * 与本函数共享同一形状)。 */
export interface IssueResumeOptions {
  tier?: IssueInterventionTier;
  workspace?: string;
  blockedPaths?: string[];
  /** 分析报告指针(ADR-0055):落盘路径+「修改方案」章节要点。服务
   *  侧算好传入,这里只投影——报告读不出就不带,提示词不留空洞。 */
  report?: { path: string; plan: string };
}

/** 续聊提示词(重启/归档前的下一轮):锚定已有现场,不从头推翻。
 * 登记元信息随现场一并重给(服务重启后模型上下文是重建的,元信息
 * 不随对话流失——含网管环境明文,与开场词同一事实源)。 */
export function issueResumePrompt(
  state: IssueSessionState,
  userText: string,
  credentials: IssueEnvCredentials = {},
  options: IssueResumeOptions = {},
): string {
  const meta = issueRegistrationMeta(state, credentials);
  return [
    promptCopy("opening", "resume.header"),
    `- 标题: ${meta.title}`,
    ...(meta.reporter
      ? [`- 登记人: ${meta.reporter}(问题由其登记提交)`]
      : []),
    `- 单号: ${state.ticket ?? "(未绑定)"}`,
    ...(state.scenario === "mr_repair"
      ? [`- 从已有 MR 开始: ${state.imported_mr?.url}；源分支 ${state.fix_branch}；目标分支 ${state.baseline}。前置调查步骤不适用。`,
         ...stageBriefLines("mr_repair", "mr_green", "")]
      : []),
    // 附加信息与附件随续聊词重给(与开场词同一事实源):重启后模型
    // 上下文是重建的,登记材料不随对话流失。
    ...(meta.remark
      ? [`- 附加信息: ${meta.remark}(发起人随单填写,重点优先读并遵照执行)`]
      : []),
    // 附件与产品版本随续聊词重给(与开场词同一事实源):重启后模型
    // 上下文是重建的,登记材料不随对话流失。
    ...(meta.attachments?.length
      ? [`- 登记附件: ${meta.attachments.join("、")}`
          + "(用户上传的日志等文件,优先查看;压缩包先解压再读)"]
      : []),
    ...(meta.product_version
      ? [`- 产品版本: ${meta.product_version}`]
      : []),
    moduleLine(meta),
    ...environmentLines(meta),
    `- 最近阶段: ${stageLabelOf(state)}(${state.stage_note || "无说明"})`,
    // 分析报告指针(ADR-0055):分析收口过的现场,重启/异常重跑的降级
    // 开局也要直接知道报告在哪、方案要点是什么,不必从头重找。服务侧
    // 算好传入,报告缺席就不带,提示词不留空洞。
    ...(options.report
      ? [`- 分析报告: ${options.report.path}`,
         `- 修改方案要点: ${options.report.plan}`]
      : []),
    // 检视意见恢复源(#366):文件在场才指路——正文随上下文压缩即丢,
    // 续聊重建的上下文靠这一行知道去哪拿回全部可引用意见。
    ...(options.workspace
      && existsSync(join(options.workspace, REVIEWS_DIR, REVIEW_NOTES_SNAPSHOT))
      ? [`- 检视意见:全部可引用意见的原文清单在 reviews/${REVIEW_NOTES_SNAPSHOT},引用意见前先读它,不要凭记忆或凭空编号`]
      : []),
    ...skillSelectionLines(state, options.blockedPaths),
    ...businessKnowledgeLines(state),
    promptCopy("opening",
      options.tier === "3" ? "resume.intervention.guard"
        : options.tier === "1" ? "resume.intervention.full_auto"
        : "resume.intervention.report_review"),
    state.pushes?.length
      ? `- 已推送: ${state.pushes.map((push) =>
          `${push.branch} @ ${push.sha.slice(0, 12)}`).join(";")}` : "",
    state.mrs?.length
      ? `- ${state.scenario === "mr_repair" ? "已有" : "已建"} MR: ${state.mrs.map((mr) =>
          mr.url ?? mr.title).join(";")}` : "",
    "",
    `用户的最新输入:\n\n${userText}`,
  ].filter(Boolean).join("\n");
}
