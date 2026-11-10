import { componentArchiveFiles, componentArchiveParts } from "./componentKnowledgeArchiveFormat.ts";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { HostGitSandbox, runGitProcess } from "./hostGitSandbox.ts";
import { gitCommitIdentityConfigs } from "./gitCommitIdentity.ts";
import { deliveryBranchName } from "./deliveryBranchName.ts";
import { cloudCommitSubject, commitHookRejection, rejectedCommitSha } from "./commitPolicy.ts";
import { closeMergeRequest, createMergeRequest, type MergeRequestCredential } from "./mrClient.ts";
import { readModuleMrParticipants } from "./moduleMrParticipants.ts";
import { hasMrParticipants } from "./mrParticipants.ts";
import { fetchMrGates, readMrFailureBody } from "./mrGateClient.ts";
import { classifyKnowledgeGitFailure, knowledgeGitFailure, knowledgeHttpFailure, knowledgeMrFailure } from "./knowledgeProductionErrors.ts";
import { listKnowledgeDocuments, readKnowledgeArchiveVersion } from "./knowledgeDocuments.ts";
import { readKnowledgeDeletion } from "./knowledgeDeletionStore.ts";
import { scanForSecrets } from "./hostSkillLibrary.ts";
import { knowledgeIssueDescription, knowledgeIssueNumber, knowledgeRelativePath, type DomainKnowledgeJob, type DomainPublication, type KnowledgeRepository } from "./domainKnowledgeExtraction.ts";
import type { DomainDocument, KnowledgeCleanupPlan, KnowledgeCleanupPublication } from "./domainKnowledgeTypes.ts";
import { assertModuleKnowledgePath } from "./domainKnowledgeLayout.ts";
import { repositoryIdentity } from "./knowledgeAssetModel.ts";

/** 只读取可读索引中的路径，不继承旧根正文。 */
function readableKnowledgeIndex(content: string): string[] {
  const paths: string[] = [];
  let inIndex = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^#{1,2}(?:\s|$)/.test(line)) { inIndex = line.trim() === "## 模块索引"; continue; }
    if (!inIndex) continue;
    const entry = /^-[ \t]+(`+)[ \t]*(.*?)[ \t]*\1[ \t]*$/.exec(line);
    if (entry?.[2].trim()) paths.push(entry[2].trim());
  }
  return paths;
}

function rememberedModuleKnowledgeBases(content: string): string[] {
  const bases = new Set<string>();
  const remember = (value: unknown) => {
    if (typeof value !== "string") return;
    try { bases.add(knowledgeRelativePath(value)); } catch { /* 无效元数据不作为知识目录。 */ }
  };
  for (const path of readableKnowledgeIndex(content)) if (path.endsWith("/")) remember(path.slice(0, -1));
  for (const match of content.matchAll(/<!-- mae-flow:module-knowledge-bases:v1 ([^\r\n]*?) -->/g)) {
    try {
      const values: unknown = JSON.parse(match[1]);
      if (Array.isArray(values)) values.forEach(remember);
    } catch { /* 旧正文不符合目录元数据格式时不采纳。 */ }
  }
  for (const match of content.matchAll(/<!-- mae-flow:module-knowledge:([a-f0-9]{16}):start -->([\s\S]*?)<!-- mae-flow:module-knowledge:\1:end -->/g)) {
    const directory = /业务模块知识保存在 (`+)([^\r\n]*?)\1 的各子目录/.exec(match[2]);
    if (!directory) continue;
    const base = directory[2].trim().replace(/\/$/, "");
    if (createHash("sha256").update(base).digest("hex").slice(0, 16) === match[1]) remember(base);
  }
  return [...bases];
}

function rememberedKnowledgeFiles(content: string): string[] {
  return readableKnowledgeIndex(content).flatMap(path => {
    try { return /(?:^|\/)AGENTS\.md$/i.test(path) ? [] : [knowledgeRelativePath(path, true)]; }
    catch { return []; }
  });
}

function moduleReadmeName(name: string): boolean {
  return /^README(?:-[A-Za-z0-9_-]+)?\.md$/i.test(name);
}

function markdownPath(path: string): string {
  const fence = "`".repeat(Math.max(0, ...(path.match(/`+/g) ?? []).map(run => run.length)) + 1);
  return `${fence} ${path} ${fence}`;
}

/** 每个目录优先保留导航文件；没有导航时以一篇实际文稿作为入口。 */
function knowledgeEntryPaths(paths: string[]): string[] {
  const directories = new Map<string, string[]>();
  for (const path of new Set(paths)) {
    const directory = path.slice(0, path.lastIndexOf("/") + 1);
    directories.set(directory, [...(directories.get(directory) ?? []), path]);
  }
  return [...directories.values()].flatMap(values => {
    const navigation = values.filter(path => /^(?:README|index|module-map)(?:-[A-Za-z0-9_-]+)?\.md$/i.test(path.split("/").at(-1)!));
    return navigation.length ? navigation : values.sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 1);
  });
}

function repositoryKnowledgeRoot(entries: string[]): string {
  return `# AGENTS.md — 仓库知识导航\n\n`
    + `## 项目概述\n\n按任务涉及的源码路径、接口或业务术语定位模块；无法定位时查源码与资料，不按仓名推断归属。\n\n`
    + `## 模块索引\n\n`
    + (entries.length ? "以下入口使用仓根相对路径，按任务范围选择：\n\n" + entries.map(path => `- ${markdownPath(path)}`).join("\n")
      : "暂无可识别的知识入口，按任务范围核对源码与资料。")
    + `\n\n## 阅读与维护约定\n\n`
    + `- 先读相关入口，再沿索引按需读取同目录文稿、规则和契约。核对各文稿声明的业务范围，避免全量加载知识目录。\n`
    + `- 使用结论前核对版本与来源。当前行为查源码和配置，业务目标及约束查资料；冲突保留双方依据与差异，缺失信息明确未知。\n`
    + `- 模块规则只适用于声明范围；跨模块任务分别核对调用边界与契约。\n`
    + `- 构建、测试和运行命令取自实际脚本或配置，确认工作目录及前置条件。\n`
    + `- 修改行为、接口或路径时，同步受影响文稿与索引。业务规则放在对应文稿，本文件保留导航；各目录使用普通 Markdown 索引。\n`;
}

/** 领域知识的入口位于所选目录，索引路径相对于该目录。 */
function directoryKnowledgeRoot(entries: string[]): string {
  return `# AGENTS.md — 领域知识导航\n\n`
    + `## 项目概述\n\n本目录保存领域知识。按任务涉及的业务术语选择入口，核对文稿声明的业务范围。\n\n`
    + `## 模块索引\n\n`
    + (entries.length ? "以下入口使用本目录相对路径，按任务范围选择：\n\n" + entries.map(path => `- ${markdownPath(path)}`).join("\n")
      : "暂无可识别的知识入口，按任务范围核对资料与源码。")
    + `\n\n## 阅读与维护约定\n\n`
    + `- 先读相关入口，再沿索引按需读取规则、流程与契约，避免全量加载本目录。\n`
    + `- 使用结论前核对业务范围、版本与来源。业务目标及约束查资料，当前实现查源码和配置；冲突保留双方依据与差异，缺失信息明确未知。\n`
    + `- 规则只适用于文稿声明的范围；跨模块任务分别核对调用边界与契约。\n`
    + `- 修改规则、接口或文稿路径时，同步相关文稿与索引。本文件只保留阅读导航，研究正文保存在普通 Markdown 文稿中。\n`;
}

function moduleKnowledgeRoot(bases: string[], files: string[] = []): string {
  return `# AGENTS.md — 仓库知识导航\n\n`
    + `## 项目概述\n\n按任务涉及的源码路径、接口或业务术语定位模块；无法定位时查源码与资料，不按仓名推断归属。\n\n`
    + `## 模块索引\n\n`
    + (bases.length ? "以下目录的直接子目录存放模块入口：\n\n" + bases.map(base => `- ${markdownPath(`${base}/`)}`).join("\n")
      : "暂无可识别的模块入口，按任务范围核对源码与资料。")
    + (files.length ? "\n\n其他已归档的直接文稿入口：\n\n" + files.map(path => `- ${markdownPath(path)}`).join("\n") : "")
    + `\n\n## 阅读与维护约定\n\n`
    + `- 只读相关模块的 \`README.md\`；同目录存在 \`README-*.md\` 时一并核对入口，再沿索引按需读取规则、流程与契约，不全量加载知识目录。\n`
    + `- 使用结论前核对范围、版本与来源。当前行为查源码和配置，业务目标及约束查资料；冲突保留双方依据与差异，缺失信息明确未知。\n`
    + `- 模块规则只适用于声明范围，不推广全仓；跨模块任务分别核对调用边界与契约。\n`
    + `- 构建、测试和运行命令取自实际脚本或配置，确认工作目录及前置条件，不推测可用命令。\n`
    + `- 修改行为、接口或路径时，同步受影响文稿与索引。业务规则放在对应模块，本文件不复制；模块使用 \`README.md\` 和普通索引，不新增子目录 \`AGENTS.md\`。\n`;
}

export class KnowledgeMrPublisher {
  private stopped = false;
  private active = new Map<AbortController, Promise<unknown>>();
  constructor(private options: {
    dataDir: string; platformUrl: () => string | undefined;
    credential: (operator: string) => (MergeRequestCredential & { email?: string }) | undefined;
  }) {
    // kill -9 不执行 finally。知识归档的仓和凭据放在同一个专用根，
    // 起服清扫只处理这个根，不能误删问题流或需求交付正在用的 Git 凭据。
    const area = this.temporaryRoot();
    for (const name of readdirSync(area).filter(name => name.startsWith("publish-"))) rmSync(join(area, name), { recursive: true, force: true });
  }
  private temporaryRoot() {
    const area = join(this.options.dataDir, "knowledge-publication-tmp");
    if (existsSync(area) && (!lstatSync(area).isDirectory() || lstatSync(area).isSymbolicLink())) throw new Error("知识归档临时目录不是可信普通目录");
    mkdirSync(area, { recursive: true, mode: 0o700 });
    return area;
  }
  private assertActive(signal?: AbortSignal) { signal?.throwIfAborted(); if (this.stopped) throw new Error("知识归档服务已停止"); }
  async shutdown() {
    this.stopped = true;
    for (const controller of this.active.keys()) controller.abort(new Error("知识归档服务已停止"));
    if (!this.active.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.allSettled([...this.active.values()]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("知识归档关停超时：归档操作 60 秒内未退出")), 60_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private identity(operator: string) {
    const credential = this.options.credential(operator), platformUrl = this.options.platformUrl();
    if (!credential?.username || !credential.password || !credential.email) throw new Error("请先配置个人 Git 账号、令牌和提交邮箱，归档不会使用系统只读凭据");
    if (!platformUrl) throw new Error("未配置 MR 平台服务");
    return { credential, platformUrl, headers: { "x-mfc-git-user": encodeURIComponent(credential.username), "x-mfc-git-token": encodeURIComponent(credential.password) } };
  }
  private async withGit<T>(operator: string, work: (git: (args: string[], allowFailure?: boolean) => Promise<string>, root: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) {
    this.assertActive(signal);
    const identity = this.identity(operator), controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    const root = mkdtempSync(join(this.temporaryRoot(), "publish-")), sandbox = new HostGitSandbox(root);
    const operation = (async () => {
      let prepared: ReturnType<HostGitSandbox["prepare"]> | undefined;
      try {
        prepared = sandbox.prepare(identity.credential);
        const git = async (args: string[], allowFailure = false) => {
          operationSignal.throwIfAborted(); this.assertActive(signal);
          const env = { ...prepared!.env };
          for (const key of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) delete env[key];
          const result = await runGitProcess([...prepared!.args, ...gitCommitIdentityConfigs(identity.credential).flatMap(([key, value]) => ["-c", `${key}=${value}`]), ...args], { cwd: root, env, timeoutMs: 90_000, signal: operationSignal });
          operationSignal.throwIfAborted(); this.assertActive(signal);
          if (result.status !== 0 && !allowFailure) {
            const output = `${result.stderr}\n${result.stdout}`;
            if (commitHookRejection(output)) {
              const sha = rejectedCommitSha(output);
              throw new Error(`CodeHub 拒绝推送：提交说明不符合仓库规范${sha ? `（提交 ${sha.slice(0, 12)}）` : ""}，请检查仓库提交格式要求`);
            }
            throw knowledgeGitFailure(result.timedOut ? "network" : classifyKnowledgeGitFailure(output), "知识文档");
          }
          return result.status === 0 ? result.stdout : "";
        };
        await git(["init", "--bare"]);
        const result = await work(git, root, operationSignal);
        operationSignal.throwIfAborted(); this.assertActive(signal);
        return result;
      } finally {
        sandbox.cleanup(prepared);
        rmSync(root, { recursive: true, force: true });
      }
    })();
    this.active.set(controller, operation);
    try { return await operation; }
    finally { this.active.delete(controller); }
  }
  private async content(git: (args: string[]) => Promise<string>, revision: string, path: string) {
    knowledgeRelativePath(path, true);
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      const parent = await git(["--literal-pathspecs", "ls-tree", revision, "--", segments.slice(0, i).join("/")]);
      if (parent && !parent.startsWith("040000 tree ")) throw new Error("文档父路径包含文件或软链接，未写入");
    }
    const entry = await git(["--literal-pathspecs", "ls-tree", revision, "--", path]);
    if (!entry) return null;
    if (!/^100(?:644|755) blob /.test(entry)) throw new Error("文档路径不是普通文件，未写入");
    return git(["show", `${revision}:${path}`]);
  }
  /** 只有已推送的文件快照能证明旧文件身份；待归档草稿与修订历史不能作为删除依据。 */
  private archivedDocuments(job: DomainKnowledgeJob, target: KnowledgeRepository, previous?: DomainPublication): DomainPublication["documents"] {
    const documents: DomainPublication["documents"] = [];
    const frozen = new Set<string>();
    const sameTarget = (value?: KnowledgeRepository) => value?.repository === target.repository && value.branch === target.branch;
    for (const batch of job.archive_batches ?? []) for (const publication of batch.publications) {
      frozen.add(JSON.stringify([publication.branch, publication.revision]));
      if (publication.revision && sameTarget(batch.targets.find(value => value.id === publication.target_id))) documents.push(...publication.documents.filter(document => !document.deleted));
    }
    // 本次重试的 previous 来自当前归档批次，其目标已经由调用方固定。
    if (previous?.revision && sameTarget([job.knowledge_target, ...job.repositories].find(value => value.id === previous.target_id))) documents.push(...previous.documents.filter(document => !document.deleted));
    for (const publication of [...job.publications, ...job.publication_history ?? []]) {
      if (!publication.revision || frozen.has(JSON.stringify([publication.branch, publication.revision]))) continue;
      // 旧记录没有冻结目标配置，不能用后来修改过的仓配置猜旧文件所在仓和分支。
      for (const document of publication.documents) {
        if (document.deleted || !document.knowledge_document_id || !document.knowledge_revision) continue;
        try {
          const location = readKnowledgeArchiveVersion(this.options.dataDir, document.knowledge_document_id, document.knowledge_revision).document.archive_target;
          if (location?.repository === target.repository && location.branch === target.branch) documents.push(document);
        } catch { /* 缺少精确正式版本时，这份旧记录不能授权删除文件。 */ }
      }
    }
    return documents;
  }
  private cleanupPaths(paths: unknown, limit = 20): string[] {
    if (!Array.isArray(paths) || paths.length > limit || paths.some(path => typeof path !== "string")) throw new Error(`每仓最多选择 ${limit} 条清理目录或文件路径`);
    return [...new Set(paths.map(path => knowledgeRelativePath(path)))].sort();
  }
  private async cleanupEntries(git: (args: string[]) => Promise<string>, revision: string, paths: string[]) {
    if (!paths.length) return [];
    const result = await git(["--literal-pathspecs", "ls-tree", "-r", "-z", revision, "--", ...paths]);
    const entries = result.split("\0").filter(Boolean).map(line => {
      const match = /^(\d{6}) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match || match[2] !== "blob") throw new Error("清理范围包含子模块，请移除该路径");
      const path = knowledgeRelativePath(match[4]);
      if (!paths.some(scope => path === scope || path.startsWith(`${scope}/`))) throw new Error("清理预览超出指定路径");
      return { path, mode: match[1], oid: match[3] };
    }).sort((a, b) => a.path.localeCompare(b.path));
    if (entries.length > 1000) throw new Error("每仓最多预览 1000 个旧文件，请缩小清理范围");
    return entries;
  }
  async previewCleanup(target: KnowledgeRepository, input: unknown, operator: string, signal?: AbortSignal): Promise<KnowledgeCleanupPlan> {
    const paths = this.cleanupPaths(input);
    return this.withGit(operator, async git => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const target_revision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      const entries = await this.cleanupEntries(git, target_revision, paths);
      return { id: `cleanup-${randomUUID()}`, target_id: target.id, paths, target_revision, entries, selected_paths: entries.map(entry => entry.path) };
    }, signal);
  }
  private async discoverMr(target: KnowledgeRepository, publication: DomainPublication, operator: string, signal?: AbortSignal) {
    const identity = this.identity(operator), query = new URLSearchParams({ repo: target.repository, source_branch: publication.branch, target_branch: target.branch });
    const operationSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    let body: { mrs?: Array<{ id: string | number; url: string; source_branch: string; target_branch: string }> };
    try {
      const response = await fetch(`${identity.platformUrl.replace(/\/+$/, "")}/mr/discover?${query}`, { headers: identity.headers, signal: operationSignal });
      this.assertActive(operationSignal);
      if (!response.ok) {
        const failure = knowledgeHttpFailure(response, `HTTP ${response.status}`);
        const detail = await readMrFailureBody(response, operationSignal).catch(error => error instanceof Error ? error.message : String(error));
        this.assertActive(operationSignal); failure.message += detail ? `：${detail}` : ""; throw failure;
      }
      try { body = await response.json() as typeof body; this.assertActive(operationSignal); }
      catch (error) { if (error instanceof SyntaxError) throw new Error("交付平台响应不完整：原分支 MR 查询响应不是合法 JSON"); throw error; }
    } catch (error) { this.assertActive(signal); throw knowledgeMrFailure(error, "原分支 MR 查询", [identity.credential.password]); }
    if (!Array.isArray(body.mrs) || body.mrs.length > 1 || body.mrs.some(mr => mr.source_branch !== publication.branch
      || mr.target_branch !== target.branch || !/^https?:\/\//.test(mr.url) || mr.id === undefined)) throw new Error("原分支 MR 查询结果不明确，未重复创建");
    return body.mrs[0];
  }
  private async openMr<T extends DomainPublication>(job: Pick<DomainKnowledgeJob, "title" | "issue_no" | "issue_description" | "module_id">,
    target: KnowledgeRepository, publication: T, operator: string, save: (publication: T) => void, signal: AbortSignal): Promise<T> {
    this.assertActive(signal);
    const identity = this.identity(operator), issue = knowledgeIssueNumber(job.issue_no);
    const title = knowledgeIssueDescription(job.issue_description?.trim() ? job.issue_description : undefined) ?? job.title;
    // 保存本次创建使用的名单；回执丢失后保留原请求事实，已存在的 MR 不再追加人员。
    const participants = publication.mr_participants?.requested ?? readModuleMrParticipants(this.options.dataDir, job.module_id);
    if (hasMrParticipants(participants)) publication.mr_participants = { status: "failed", requested: structuredClone(participants), message: "MR 人员设置结果尚未确认" };
    publication.mr_attempted = true; save(publication);
    let receipt;
    try { receipt = await createMergeRequest({ platformUrl: identity.platformUrl, repo: target.repository, sourceBranch: publication.branch,
      targetBranch: target.branch, title, credential: identity.credential, dtsNo: issue, purpose: "knowledge", participants, signal, includeFailureMetadata: true }); }
    catch (error) { signal.throwIfAborted(); this.assertActive(signal); throw knowledgeMrFailure(error, "MR 创建", [identity.credential.password]); }
    this.assertActive(signal);
    if (!/^https?:\/\//.test(receipt.url)) throw new Error("MR 链接无效，请恢复平台查询后手动重试");
    publication.url = receipt.url; publication.mr_id = receipt.id; publication.state = "opened";
    if (receipt.participants) publication.mr_participants = receipt.participants;
    save(publication); return publication;
  }
  async publishCleanup(job: Pick<DomainKnowledgeJob, "id" | "title" | "issue_no" | "issue_description" | "module_id">, target: KnowledgeRepository,
    plan: KnowledgeCleanupPlan, input: unknown, previous: KnowledgeCleanupPublication | undefined, operator: string,
    save: (publication: KnowledgeCleanupPublication) => void, signal?: AbortSignal): Promise<KnowledgeCleanupPublication> {
    this.assertActive(signal);
    const issue = knowledgeIssueNumber(job.issue_no), selected = this.cleanupPaths(input, 1000);
    const branch = deliveryBranchName(target.branch, this.identity(operator).credential.username, issue);
    if (plan.target_id !== target.id || !selected.length || selected.some(path => !plan.entries.some(entry => entry.path === path))) throw new Error("请选择预览中的待删文件");
    const samePlan = previous?.cleanup_plan_id === plan.id;
    const continuing = samePlan && JSON.stringify(previous!.removed_paths) === JSON.stringify(selected);
    if (samePlan && !continuing && (previous!.revision || previous!.mr_attempted || previous!.url)) throw new Error("原清理分支已确定删除范围，请按原范围重试");
    let publication: KnowledgeCleanupPublication = continuing ? { ...structuredClone(previous!), state: "pending", error: undefined }
      : { target_id: target.id, cleanup_plan_id: plan.id, removed_paths: selected, documents: [], state: "pending", branch };
    const saveLive = (value: KnowledgeCleanupPublication) => { this.assertActive(signal); save(structuredClone(value)); };
    if (publication.url) { publication.state = "opened"; saveLive(publication); return publication; }
    if (publication.mr_attempted) {
      const found = await this.discoverMr(target, publication, operator, signal);
      if (found) { publication = { ...publication, state: "opened", url: found.url, mr_id: found.id }; saveLive(publication); return publication; }
    }
    saveLive(publication);
    return this.withGit(operator, async (git, root, operationSignal) => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const base = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      let remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim().split(/\s/)[0];
      // 未推送的旧失败记录可改名；已在远端的分支仍沿原记录恢复，避免重复 MR。
      if (!remote && publication.branch !== branch) {
        publication.branch = branch; publication.revision = undefined; publication.mr_attempted = undefined; saveLive(publication);
        remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${branch}`])).trim().split(/\s/)[0];
      }
      if (remote) {
        if (!continuing || !publication.revision || remote !== publication.revision) throw knowledgeGitFailure("non_fast_forward", "同名清理分支已有提交，请先核对本单原分支");
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
      } else {
        const entries = await this.cleanupEntries(git, base, plan.paths);
        if (JSON.stringify(entries) !== JSON.stringify(plan.entries)) throw new Error("清理范围内的文件已变化，请重新预览，尚未删除文件");
        await git(["read-tree", base]);
        // 删除只改临时仓的索引；Git 在 bare 仓执行此命令时仍要求显式工作树位置。
        for (const path of selected) await git(["--work-tree", root, "update-index", "--force-remove", "--", path]);
        const tree = (await git(["write-tree"])).trim();
        publication.revision = (await git(["commit-tree", tree, "-p", base, "-m", cloudCommitSubject(issue, "feat", "清理萃取前旧知识")])).trim();
        saveLive(publication);
        await git(["push", target.repository, `${publication.revision}:refs/heads/${publication.branch}`]);
      }
      return this.openMr(job, target, publication, operator, saveLive, operationSignal);
    }, signal);
  }
  async publish(job: DomainKnowledgeJob, target: KnowledgeRepository, previous: DomainPublication | undefined, operator: string,
    save: (publication: DomainPublication) => void, signal?: AbortSignal): Promise<DomainPublication> {
    this.assertActive(signal);
    const issue = knowledgeIssueNumber(job.issue_no);
    const branch = deliveryBranchName(target.branch, this.identity(operator).credential.username, issue);
    const logicalTargets = new Map([job.knowledge_target, ...job.repositories].filter(candidate => candidate.repository === target.repository
      && candidate.branch === target.branch).map(candidate => [candidate.id, candidate]));
    const formalVersions = new Map<string, ReturnType<typeof readKnowledgeArchiveVersion>["document"]>();
    const componentFiles = new Map<string, ReturnType<typeof componentArchiveFiles>>();
    const docs: DomainDocument[] = job.documents.filter(doc => doc.selected && logicalTargets.has(doc.target_id)).flatMap(doc => {
      if (!job.component_research_id) {
        const outgoing = { ...doc, path: doc.archive_path ?? doc.path };
        assertModuleKnowledgePath(job, logicalTargets.get(doc.target_id)!, outgoing.path);
        return [outgoing];
      }
      if (!doc.knowledge_document_id || !doc.published_revision) throw new Error("请先发布所选知识，再手动归档正式版本");
      const deletion = readKnowledgeDeletion(this.options.dataDir, doc.knowledge_document_id);
      if (doc.deleted && (!deletion || deletion.revision !== doc.published_revision || doc.published_document_revision !== doc.revision)) throw new Error("请先确认发布当前删除文稿，再归档 Git 删除操作");
      if (!doc.deleted && deletion) throw new Error("知识已删除，旧归档操作不能重新写入文档");
      const versionKey = JSON.stringify([doc.knowledge_document_id, doc.published_revision]);
      let formal = formalVersions.get(versionKey);
      if (!formal) { formal = readKnowledgeArchiveVersion(this.options.dataDir, doc.knowledge_document_id, doc.published_revision).document; formalVersions.set(versionKey, formal); }
      const outgoing = { ...doc, path: doc.archive_path ?? doc.path };
      if (doc.deleted && job.knowledge_layout === "directory-v1") {
        // 同批次其他文稿可以迁入新目录，已确认删除仍须作用于该正式版本的原位置。
        const location = formal.archive_target ?? formal.research_source;
        if (!location || location.repository !== target.repository || location.branch !== target.branch || location.path !== outgoing.path) {
          throw new Error("删除文稿的归档位置与已确认正式版本不一致，请重新预览");
        }
      } else assertModuleKnowledgePath(job, logicalTargets.get(doc.target_id)!, outgoing.path);
      // 历史失败批次仍可按原整篇快照重试；新批次逐项比对同一正式版本的能力文件。
      const parts = componentArchiveParts(formal.content), requested = componentArchiveParts(doc.content);
      if (parts.content === requested.content) return [{ ...outgoing, content: parts.content }];
      let files = componentFiles.get(versionKey);
      if (!files) {
        const index = job.documents.find(item => item.knowledge_document_id === doc.knowledge_document_id && item.published_revision === doc.published_revision
          && (item.archive_path ?? item.path).endsWith("/README.md"));
        if (!index) throw new Error("组件能力归档缺少对应目录，请重新预览");
        files = componentArchiveFiles(formal.content, (index.archive_path ?? index.path).replace(/\/README\.md$/, ".md"), index.id);
        componentFiles.set(versionKey, files);
      }
      const file = files.find(file => file.id === doc.id && file.path === outgoing.path);
      if (!file || file.content !== doc.content) throw new Error("组件归档正文与所选正式版本不一致，请重新预览");
      return [{ ...outgoing, content: file.content }];
    });
    if (!docs.length) throw new Error("请选择至少一篇已发布知识进行归档");
    const documents: DomainPublication["documents"] = docs.map(doc => ({ id: doc.id, path: doc.path,
      content: doc.content, revision: doc.revision, knowledge_document_id: doc.knowledge_document_id, knowledge_revision: doc.published_revision,
      ...(doc.deleted ? { deleted: true } : {}) }));
    if (new Set(documents.map(doc => doc.path)).size !== documents.length) throw new Error("归档文件路径不能重复");
    for (const doc of docs) {
      knowledgeRelativePath(doc.path, true);
      scanForSecrets(doc.path, Buffer.from(doc.content));
    }
    const archived = this.archivedDocuments(job, target, previous);
    const moduleDirectories = job.knowledge_layout === "module-v1"
      ? [...new Set([...logicalTargets.values(), ...(job.archive_batches ?? []).flatMap(batch => batch.targets)]
        .filter(value => value.repository === target.repository && value.branch === target.branch && value.docs_path.endsWith(`/${job.module_id}`))
        .map(value => value.docs_path))] : undefined;
    const knownFiles = new Map(docs.map(doc => {
      const files = archived.filter(file => file.id === doc.id && (!file.knowledge_document_id || file.knowledge_document_id === doc.knowledge_document_id))
        .map(file => ({ path: knowledgeRelativePath(file.path, true), content: file.content }));
      if (typeof doc.base_content === "string") files.push({ path: knowledgeRelativePath(doc.base_path ?? doc.path, true), content: doc.base_content });
      if (doc.deleted) files.push({ path: doc.path, content: doc.content });
      return [doc.id, files];
    }));
    const documentKey = (values: DomainPublication["documents"]) => JSON.stringify(values.map(doc => [doc.id, doc.path, doc.content, doc.revision,
      doc.knowledge_document_id, doc.knowledge_revision, doc.deleted === true]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const samePlan = !!previous && documentKey(previous.attempted_documents ?? previous.documents) === documentKey(documents);
    if (!job.component_research_id && previous?.mr_attempted && !previous.url) {
      const found = await this.discoverMr(target, previous, operator, signal);
      if (found) {
        previous = { ...previous, url: found.url, mr_id: found.id };
        // 先保存真实 MR 身份；即使随后查询或续推失败，也不能丢失链接后再创建一个。
        save(structuredClone({ ...previous, state: "pending" }));
      }
    }
    if (!job.component_research_id && previous?.url) {
      previous = await this.refreshPublication(target, previous, operator);
      if (previous.mr_state === "merged") throw new Error("此任务 MR 已合入，请从正式知识库开始新的检视");
      if (previous.mr_state === "closed") throw new Error("此任务 MR 已关闭，请重新打开原 MR 后继续修改");
    }
    const continuing = !!previous && previous.target_id === target.id && (samePlan || !job.component_research_id && !!previous.branch && !!(previous.url || previous.revision || previous.mr_attempted));
    // 同一任务尚未合入时继续原分支；正式库发起的新检视使用独立任务与 MR。
    let publication: DomainPublication = { target_id: target.id, branch: continuing ? previous!.branch : branch,
      state: "pending", documents, ...(continuing ? { revision: previous!.revision, url: previous!.url, mr_id: previous!.mr_id,
        mr_attempted: previous!.mr_attempted, mr_participants: structuredClone(previous!.mr_participants),
        navigation_files: structuredClone(previous!.navigation_files), mr_state: previous!.mr_state, checked_at: previous!.checked_at } : {}) };
    const saveLive = (value: DomainPublication) => { this.assertActive(signal); save(structuredClone(value)); };
    if (continuing && publication.url && samePlan) { publication.state = "opened"; saveLive(publication); return publication; }
    if (continuing && publication.mr_attempted && !publication.url) {
      const found = await this.discoverMr(target, publication, operator, signal);
      if (found) {
        publication = { ...publication, state: "opened", url: found.url, mr_id: found.id };
        if (samePlan) { saveLive(publication); return publication; }
      }
    }
    const saveAttempt = () => saveLive({ ...publication, documents: continuing ? previous!.documents : [], attempted_documents: documents });
    saveAttempt();
    return this.withGit(operator, async (git, root, operationSignal) => {
      await git(["fetch", "--no-tags", target.repository, `refs/heads/${target.branch}`]);
      const targetRevision = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      let remote: string | undefined;
      if (!continuing || !publication.revision && !publication.mr_attempted) {
        const heads = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${branch}*`])).trim().split(/\r?\n/)
          .map(line => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, "")).filter((name): name is string => !!name);
        const occupied = new Set(heads);
        // 新版本另建 MR；已删除远端分支的历史 MR 也不复用其分支名。
        for (const batch of job.archive_batches ?? []) for (const entry of batch.publications) {
          const location = batch.targets.find(value => value.id === entry.target_id);
          if (location?.repository === target.repository && location.branch === target.branch
            && (entry.revision || entry.mr_attempted || entry.url)) occupied.add(entry.branch);
        }
        for (const entry of [...job.publications, ...job.publication_history ?? [], ...(previous ? [previous] : [])]) {
          if (logicalTargets.has(entry.target_id) && (entry.revision || entry.mr_attempted || entry.url)) occupied.add(entry.branch);
        }
        const unavailable = (candidate: string) => [...occupied].some(name => name === candidate || name.startsWith(`${candidate}/`) || candidate.startsWith(`${name}/`));
        let candidate = branch;
        for (let attempt = 2; unavailable(candidate); attempt++) candidate = `${branch}_${attempt}`;
        publication.branch = candidate;
        saveAttempt();
      } else {
        remote = (await git(["ls-remote", "--heads", target.repository, `refs/heads/${publication.branch}`])).trim().split(/\s/)[0];
      }
      let parent = targetRevision;
      if (remote) {
        if (!continuing || !publication.revision || remote !== publication.revision) throw knowledgeGitFailure("non_fast_forward", "归档分支已有人工修改");
        await git(["fetch", "--no-tags", target.repository, `refs/heads/${publication.branch}`]);
        parent = (await git(["rev-parse", "FETCH_HEAD^{commit}"])).trim();
      }
      await git(["read-tree", parent]);
      const removed = new Map<string, string>();
      for (const doc of docs) {
        const known = knownFiles.get(doc.id)!;
        const moving = !!doc.base_path && doc.base_path !== doc.path || known.some(file => file.path !== doc.path);
        if (!moving && !doc.deleted) {
          const current = await this.content(git, parent, doc.path);
          const baselines = known.filter(file => file.path === doc.path);
          // 同路径更新也要保护研究后发生的人工修改；正文已经相同时允许恢复原归档。
          // 已推送的 MR 可能尚未合入；只有研究基线中已存在的文件消失才视为外部删除。
          const removedSinceResearch = current === null && typeof doc.base_content === "string";
          if (current !== doc.content && (current === null ? removedSinceResearch : !baselines.some(file => file.content === current))) {
            throw new Error(`归档文件 ${doc.path} 已变化或缺少原始内容，未覆盖；请核对最新文件后继续归档，无需重新研究`);
          }
          continue;
        }
        const action = doc.deleted ? "删除" : "改名";
        const destination = doc.deleted ? null : await this.content(git, parent, doc.path);
        // 精确分支恢复时，远端 SHA 已经核对为本次保存的版本；不能因落盘窗口再重复提交。
        const committedAttempt = !!remote && continuing && destination === doc.content;
        if (destination !== null && !committedAttempt && !known.some(file => file.path === doc.path && file.content === destination)) {
          throw new Error(`改名目标 ${doc.path} 已有其他文件或内容已变化，未覆盖；请调整文件路径或先核对冲突`);
        }
        const oldPaths = [...known.map(file => file.path), ...(doc.base_path ? [knowledgeRelativePath(doc.base_path, true)] : []), ...(doc.deleted ? [doc.path] : [])]
          .filter(path => (doc.deleted || path !== doc.path) && !(["repository-v1", "directory-v1"].includes(job.knowledge_layout ?? "") && /^AGENTS\.md$/i.test(path))
            && (!moduleDirectories || moduleDirectories.some(directory => path.startsWith(`${directory}/`))
            || /\/AGENTS\.md$/i.test(path) && known.some(file => file.path === path)
              && [...logicalTargets.values()].some(value => value.docs_path.startsWith(`${path.slice(0, path.lastIndexOf("/"))}/`))));
        // 公共文稿保留；已知归属的旧父 AGENTS 随模块入口迁移，避免继续影响新目录。
        for (const path of new Set(oldPaths)) {
          if (documents.some(file => file.id !== doc.id && file.path === path)) throw new Error(`${action}原路径 ${path} 被其他文档使用，未删除；请先调整冲突路径`);
          const content = await this.content(git, parent, path);
          if (content === null) continue;
          if (!known.some(file => file.path === path)) throw new Error(`${action}原文件 ${path} 无法核对已知内容，未删除；请先核对原文件`);
          if (!known.some(file => file.path === path && file.content === content)) throw new Error(`${action}原文件 ${path} 已被修改，未删除；请先核对最新内容`);
          if (removed.has(path) && removed.get(path) !== doc.knowledge_document_id) throw new Error(`${action}原路径 ${path} 对应多篇知识，未删除；请先核对文件归属`);
          removed.set(path, doc.knowledge_document_id!);
        }
      }
      for (const [path, knowledgeId] of removed) {
        const owner = listKnowledgeDocuments(this.options.dataDir).find(formal => {
          const location = formal.archive_target ?? formal.source;
          return formal.id !== knowledgeId && location?.repository === target.repository && location.branch === target.branch && location.path === path;
        });
        if (owner) throw new Error(`原路径 ${path} 已被其他正式知识使用，未删除；请先核对文件归属`);
        await git(["--work-tree", root, "--literal-pathspecs", "update-index", "--force-remove", "--", path]);
      }
      for (const doc of documents) {
        if (doc.deleted) continue;
        await this.content(git, parent, doc.path);
        const file = join(root, "knowledge-content.tmp"); writeFileSync(file, doc.content, { mode: 0o600 });
        const blob = (await git(["hash-object", "-w", file])).trim();
        await git(["update-index", "--add", "--cacheinfo", "100644", blob, doc.path]);
      }
      // 已推送的精确版本只恢复 MR，不因其他模块后来发布的位置改变本次提交。
      if (job.knowledge_layout === "module-v1" && !(remote && continuing)) {
        const currentBases = new Set(docs.filter(doc => !doc.deleted).map(doc => {
          const directory = logicalTargets.get(doc.target_id)!.docs_path;
          return directory.slice(0, -(`/${job.module_id}`).length);
        }));
        const original = await this.content(git, parent, "AGENTS.md");
        const remembered = new Set(rememberedKnowledgeFiles(original ?? "")), directEntries = new Set<string>();
        const candidates = new Set([...currentBases, ...rememberedModuleKnowledgeBases(original ?? "")]);
        for (const formal of listKnowledgeDocuments(this.options.dataDir)) {
          if (formal.scope !== "module") continue;
          const location = formal.archive_target ?? formal.research_source ?? formal.source;
          if (!location || repositoryIdentity(location.repository) !== repositoryIdentity(target.repository) || location.branch !== target.branch) continue;
          const parts = location.path.split("/");
          if (!moduleReadmeName(parts.at(-1)!)) continue;
          const directory = parts.slice(0, -1).join("/");
          for (const moduleId of formal.module_ids) {
            if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(moduleId)) continue;
            const suffix = `/${moduleId}`;
            if (directory.endsWith(suffix)) {
              try { candidates.add(knowledgeRelativePath(directory.slice(0, -suffix.length))); }
              catch { /* 无效的历史位置不作为模块知识入口。 */ }
            }
          }
        }
        const bases = new Set(currentBases);
        // 仅检查已知知识目录的索引；源码目录里同名 README 不能成为模块知识入口。
        const indexedPaths = [...new Set([...candidates, ...remembered])];
        if (indexedPaths.length) for (const entry of (await git(["ls-files", "--stage", "-z", "--", ...indexedPaths.map(path => `:(literal)${path}`)])).split("\0")) {
          const match = /^100(?:644|755) [a-f0-9]+ 0\t([^\r\n]+)$/.exec(entry);
          if (!match) continue;
          if (remembered.has(match[1])) directEntries.add(match[1]);
          const parts = match[1].split("/");
          if (parts.length < 3 || !moduleReadmeName(parts.at(-1)!)) continue;
          const base = parts.slice(0, -2).join("/");
          if (candidates.has(base)) bases.add(base);
        }
        const content = moduleKnowledgeRoot([...bases].sort(), [...directEntries].sort());
        if (content !== original) {
          const entry = await git(["--literal-pathspecs", "ls-tree", parent, "--", "AGENTS.md"]);
          const mode = entry.startsWith("100755 ") ? "100755" : "100644";
          const file = join(root, "knowledge-navigation.tmp"); writeFileSync(file, content, { mode: 0o600 });
          const blob = (await git(["hash-object", "-w", file])).trim();
          await git(["update-index", "--add", "--cacheinfo", mode, blob, "AGENTS.md"]);
        }
      }
      if (job.knowledge_layout === "repository-v1" && !(remote && continuing)) {
        const original = await this.content(git, parent, "AGENTS.md");
        const remembered = new Set(rememberedKnowledgeFiles(original ?? "")), candidates = new Set(docs.filter(doc => !doc.deleted).map(doc => doc.path));
        for (const path of remembered) candidates.add(path);
        for (const formal of listKnowledgeDocuments(this.options.dataDir)) {
          const location = formal.archive_target;
          if (!location || repositoryIdentity(location.repository) !== repositoryIdentity(target.repository) || location.branch !== target.branch) continue;
          try { candidates.add(knowledgeRelativePath(location.path, true)); } catch { /* 无效正式位置不作为入口。 */ }
        }
        const bases = rememberedModuleKnowledgeBases(original ?? "");
        const paths = [...new Set([...candidates, ...bases])];
        const indexed = paths.length ? await git(["ls-files", "--stage", "-z", "--", ...paths.map(path => `:(literal)${path}`)]) : "";
        const available = new Set<string>(), legacyEntries = new Set<string>();
        for (const line of indexed.split("\0").filter(Boolean)) {
          const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(line);
          const path = match?.[1];
          if (!path || /(?:^|\/)AGENTS\.md$/i.test(path)) continue;
          if (candidates.has(path)) available.add(path);
          if (bases.some(base => {
            if (!path.startsWith(`${base}/`)) return false;
            const parts = path.slice(base.length + 1).split("/");
            return parts.length === 2 && moduleReadmeName(parts[1]);
          })) legacyEntries.add(path);
        }
        const entries = new Set([...legacyEntries, ...[...remembered].filter(path => available.has(path)), ...knowledgeEntryPaths([...available])]);
        // 同目录可承载多个模块；各本次目标至少保留自己的入口，不能被别人的 README 抢占。
        for (const logical of logicalTargets.keys()) {
          for (const path of knowledgeEntryPaths(docs.filter(doc => doc.target_id === logical && !doc.deleted && available.has(doc.path)).map(doc => doc.path))) entries.add(path);
        }
        const content = repositoryKnowledgeRoot([...entries].sort());
        if (content !== original) {
          const entry = await git(["--literal-pathspecs", "ls-tree", parent, "--", "AGENTS.md"]);
          const mode = entry.startsWith("100755 ") ? "100755" : "100644";
          const file = join(root, "knowledge-navigation.tmp"); writeFileSync(file, content, { mode: 0o600 });
          const blob = (await git(["hash-object", "-w", file])).trim();
          await git(["update-index", "--add", "--cacheinfo", mode, blob, "AGENTS.md"]);
        }
      }
      if (job.knowledge_layout === "directory-v1" && !(remote && continuing && samePlan)) {
        const sameRepository = (location: { repository: string; branch: string } | undefined) => !!location
          && repositoryIdentity(location.repository) === repositoryIdentity(target.repository) && location.branch === target.branch;
        const formal = listKnowledgeDocuments(this.options.dataDir).filter(document => sameRepository(document.archive_target));
        const role = (document: (typeof formal)[number]) => document.research_source?.layer
          ?? job.documents.find(draft => draft.knowledge_document_id === document.id)?.layer
          ?? (document.scope === "repository" ? "repository" : undefined);
        const domainFiles = new Set(formal.filter(document => role(document) === "domain").map(document => document.archive_target!.path));
        for (const doc of docs) if (doc.layer === "domain") domainFiles.add(doc.path);
        const availableFiles = async (paths: Iterable<string>) => {
          const candidates = [...new Set(paths)];
          const indexed = candidates.length ? await git(["ls-files", "--stage", "-z", "--", ...candidates.map(path => `:(literal)${path}`)]) : "";
          const available = new Set<string>();
          for (const line of indexed.split("\0").filter(Boolean)) {
            const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(line);
            if (match && candidates.includes(match[1]) && !/(?:^|\/)AGENTS\.md$/i.test(match[1])) available.add(match[1]);
          }
          return available;
        };
        const navigationFiles: NonNullable<DomainPublication["navigation_files"]> = [];
        const writeNavigation = async (path: string, content: string, original: string | null) => {
          navigationFiles.push({ path, content });
          if (content === original) return;
          const entry = await git(["--literal-pathspecs", "ls-tree", parent, "--", path]);
          const mode = entry.startsWith("100755 ") ? "100755" : "100644";
          const file = join(root, "knowledge-navigation.tmp"); writeFileSync(file, content, { mode: 0o600 });
          const blob = (await git(["hash-object", "-w", file])).trim();
          await git(["update-index", "--add", "--cacheinfo", mode, blob, path]);
        };
        const currentDomainEntry = `${job.knowledge_target.docs_path.replace(/\/$/, "")}/AGENTS.md`;
        // 只有已推送快照能证明派生入口的身份；完整迁移其文稿后才移除旧入口。
        for (const batch of job.archive_batches ?? []) for (const archivedPublication of batch.publications) {
          if (!archivedPublication.revision || !sameRepository(batch.targets.find(logical => logical.id === archivedPublication.target_id))) continue;
          for (const navigation of archivedPublication.navigation_files ?? []) {
            if (navigation.path === "AGENTS.md" || navigation.path === currentDomainEntry || !navigation.path.endsWith("/AGENTS.md")) continue;
            const directory = navigation.path.slice(0, -"/AGENTS.md".length);
            const domainDocuments = archivedPublication.documents.filter(document => batch.documents.some(frozen => frozen.id === document.id
              && frozen.layer === "domain" && frozen.target_id === job.knowledge_target.id) && document.path.startsWith(`${directory}/`));
            if (!domainDocuments.length || !domainDocuments.every(document => docs.some(current => current.layer === "domain"
              && current.id === document.id && (!document.knowledge_document_id || current.knowledge_document_id === document.knowledge_document_id)))) continue;
            if (documents.some(document => document.path === navigation.path)) continue;
            const otherOwner = formal.some(document => document.archive_target!.path.startsWith(`${directory}/`)
              && !docs.some(current => current.knowledge_document_id === document.id));
            if (otherOwner) continue;
            if (await this.content(git, parent, navigation.path) !== navigation.content) continue;
            await git(["--work-tree", root, "--literal-pathspecs", "update-index", "--force-remove", "--", navigation.path]);
          }
        }
        // 同一物理仓可以同时承担两种角色；领域入口始终留在领域目标目录。
        const domainTargets = [...logicalTargets.values()].filter(logical => logical.id === job.knowledge_target.id
          && docs.some(doc => doc.target_id === logical.id));
        for (const logical of domainTargets) {
          const directory = logical.docs_path.replace(/\/$/, ""), path = `${directory}/AGENTS.md`;
          const original = await this.content(git, parent, path);
          const candidates = new Set(docs.filter(doc => doc.target_id === logical.id && !doc.deleted).map(doc => doc.path));
          for (const document of formal) if (role(document) === "domain" && document.archive_target!.path.startsWith(`${directory}/`)) candidates.add(document.archive_target!.path);
          for (const relative of rememberedKnowledgeFiles(original ?? "")) candidates.add(`${directory}/${relative}`);
          const available = await availableFiles(candidates);
          if (!available.size && original === null) continue;
          const entries = knowledgeEntryPaths([...available]).map(value => value.slice(directory.length + 1));
          await writeNavigation(path, directoryKnowledgeRoot(entries.sort()), original);
        }
        const codeTargets = [...logicalTargets.values()].filter(logical => logical.id !== job.knowledge_target.id
          && docs.some(doc => doc.target_id === logical.id));
        if (codeTargets.length) {
          const original = await this.content(git, parent, "AGENTS.md"), remembered = rememberedKnowledgeFiles(original ?? "");
          const codeTargetIds = new Set(codeTargets.map(logical => logical.id));
          const candidates = new Set(docs.filter(doc => codeTargetIds.has(doc.target_id) && !doc.deleted).map(doc => doc.path));
          for (const path of remembered) if (!domainFiles.has(path)) candidates.add(path);
          for (const document of formal) if (role(document) === "repository") candidates.add(document.archive_target!.path);
          const bases = rememberedModuleKnowledgeBases(original ?? ""), legacyEntries = new Set<string>();
          // 旧根索引只记模块父目录；仅从这些已知目录恢复仍在 Git 中的入口。
          if (bases.length) for (const line of (await git(["ls-files", "--stage", "-z", "--", ...bases.map(path => `:(literal)${path}`)])).split("\0")) {
            const match = /^100(?:644|755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(line), path = match?.[1];
            if (!path || domainFiles.has(path)) continue;
            if (bases.some(base => {
              if (!path.startsWith(`${base}/`)) return false;
              const parts = path.slice(base.length + 1).split("/");
              return parts.length === 2 && moduleReadmeName(parts[1]);
            })) { candidates.add(path); legacyEntries.add(path); }
          }
          const available = await availableFiles(candidates);
          const entries = new Set([...legacyEntries, ...remembered].filter(path => available.has(path)));
          for (const path of knowledgeEntryPaths([...available])) entries.add(path);
          // 每个代码目标保留自己的入口；其他模块的同目录 README 不能隐藏本模块知识。
          for (const logical of codeTargets) for (const path of knowledgeEntryPaths(docs.filter(doc => doc.target_id === logical.id
            && !doc.deleted && available.has(doc.path)).map(doc => doc.path))) entries.add(path);
          await writeNavigation("AGENTS.md", repositoryKnowledgeRoot([...entries].sort()), original);
        }
        publication.navigation_files = navigationFiles;
      }
      const tree = (await git(["write-tree"])).trim(), before = (await git(["rev-parse", `${parent}^{tree}`])).trim();
      // 纯适用范围新版本也独立尝试建MR；平台拒绝无差异时如实返回原文，不虚写成功。
      const revision = remote && tree === before ? parent : (await git(["commit-tree", tree, "-p", parent, "-m", cloudCommitSubject(issue, "feat", `更新${job.title}知识`)])).trim();
      publication.revision = revision; saveAttempt();
      // 空期望值只允许创建尚不存在的分支，防止并行归档在查名后占用同名分支。
      if (revision !== remote) await git(["push", ...(!remote ? [`--force-with-lease=refs/heads/${publication.branch}:`] : []),
        target.repository, `${revision}:refs/heads/${publication.branch}`]);
      saveLive(publication);
      if (publication.url) { publication.state = "opened"; saveLive(publication); return publication; }
      return this.openMr(job, target, publication, operator, saveLive, operationSignal);
    }, signal);
  }
  async refreshPublication(target: KnowledgeRepository, publication: DomainPublication, operator: string): Promise<DomainPublication> {
    this.assertActive();
    if (!publication.url && publication.mr_id === undefined) return structuredClone(publication);
    const identity = this.identity(operator); let failure = "MR 状态查询未返回有效结果";
    const state = await fetchMrGates({ platformUrl: identity.platformUrl, repo: target.repository, headers: identity.headers, requireExisting: true,
      delivery: { source_branch: publication.branch, target_branch: target.branch, mr_id: publication.mr_id, mr_url: publication.url }, onFailure: reason => { failure = reason; } });
    if (!state) throw new Error(`无法确认原 MR 状态：${failure}；文稿已保留，可稍后重试`);
    return { ...structuredClone(publication), mr_state: state.mrState, checked_at: new Date().toISOString() };
  }
  async closePublication(job: DomainKnowledgeJob, target: KnowledgeRepository, publication: DomainPublication, operator = job.operator): Promise<"closed" | "merged"> {
    this.assertActive();
    let mr = publication.mr_id ?? publication.url;
    if (publication.url) {
      try { mr = new URL(publication.url).pathname.match(/\/merge_requests\/(\d+)\/?$/)?.[1] ?? mr; }
      catch { /* 非标准链接使用已保存的 MR 标识。 */ }
    }
    if (mr === undefined || mr === "") throw new Error("旧归档缺少 MR 标识，无法撤销");
    const identity = this.identity(operator);
    const readState = () => fetchMrGates({ platformUrl: identity.platformUrl, repo: target.repository, headers: identity.headers, requireExisting: true,
      delivery: { source_branch: publication.branch, target_branch: target.branch, mr_id: publication.mr_id, mr_url: publication.url } });
    const before = await readState();
    if (before?.mrState === "closed" || before?.mrState === "merged") return before.mrState;
    this.assertActive();
    try {
      await closeMergeRequest({ platformUrl: identity.platformUrl, repo: target.repository, mr, credential: identity.credential });
    } catch (error) {
      // 关闭成功后的回执可能丢失；只凭同一个 MR 的确定状态恢复，不关闭其他分支。
      const state = await readState();
      if (state?.mrState === "merged") return "merged";
      if (state?.mrState !== "closed") throw error;
    }
    return "closed";
  }
}
