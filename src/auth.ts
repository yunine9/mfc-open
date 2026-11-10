/**
 * 本地账号与会话。
 *
 * 用户文件只保存 scrypt 加盐哈希，权限 0600。会话表另落一份 0600
 * 缓存文件——曾经"仅驻内存,重启即失效",在频繁重部署 + 多人在线的
 * 场景里等于每次改 bug 上线都把全员踢回登录页、半填的表单全丢
 * (2026-08-29 部署审计实锤)。落盘的是令牌的 sha256,不是令牌本身:
 * 磁盘上永远没有能直接用的凭据(令牌只写不读的纪律同样适用于自家)。
 * 会话缓存坏了/丢了都不拦启动,代价只是重登一次。
 * 认证只负责"谁在操作"，任务事实仍归 TaskService。
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  jsonProviders,
  mergeModelsForm,
  type ModelsFormPatch,
  type ModelsSettings,
} from "./settings.ts";

export type UserRole = "admin" | "developer";

export interface AuthUser {
  username: string;
  /** 人看的姓名；username 仍是稳定身份、登录账号与权限主键。 */
  display_name?: string;
  role: UserRole;
  /** 可被任务责任人主动邀请检视。它是能力标记，不是第三种角色。 */
  committer?: boolean;
  /** 自动接单开关(ADR-0061,2026-10-10 修订迁入个人设置):true=本人
   *  已开启,名下符合条件的新 DTS 单由平台定时自动发起。个人自助,
   *  缺省关闭。 */
  issue_auto_claim?: boolean;
}

/** 问题处理介入档位(ADR-0019):三档,缺省二档「优先报告」。
 * 需求侧的月光/推送过目两轴在问题侧退役,由这一根旋钮替代。 */
export type IssueInterventionTier = "1" | "2" | "3";

export const DEFAULT_ISSUE_INTERVENTION_TIER: IssueInterventionTier = "2";

/** HTTP 边界与存取共用的档位校验(单一事实源,防两处漂移)。 */
export function isIssueInterventionTier(
  value: unknown,
): value is IssueInterventionTier {
  return value === "1" || value === "2" || value === "3";
}

/** 个人模型网关的掩码形态(给界面确认"配过了、是哪个"):是否已配、
 *  url/model/api 明文与密钥末 4 位——密钥本体永不回传。 */
export interface PersonalModelsView {
  configured: boolean;
  url?: string;
  model?: string;
  api?: string;
  key_hint?: string;
}

/** 登录后交给界面的本人视图。密钥原文永不离开服务端，只暴露能让
 * 用户确认“已经配置、末四位是什么”的掩码。 */
export interface AuthSessionUser extends AuthUser {
  git_token_hint?: string;
  git_email?: string;
  luban_token_hint?: string;
  moonlight: boolean;
  push_confirmation: boolean;
  /** 问题处理介入档位(按流剥离):与需求侧两轴互不带动。 */
  issue_intervention_tier: IssueInterventionTier;
  /** 自动接单开关(ADR-0061 修订):本人当前态,个人设置显示与翻转。 */
  issue_auto_claim: boolean;
  /** 个人模型网关(ADR-0068)的掩码形态。 */
  personal_models: PersonalModelsView;
}

/** 跨仓分工只暴露“能不能接活”和缺项名称，绝不暴露任何令牌提示或
 * 邮箱原文。这个视图给所有已登录开发读取，因此必须比 sessionView
 * 更窄。 */
export interface CollaborationAssignee {
  username: string;
  display_name?: string;
  ready: boolean;
  missing: string[];
}

interface StoredUser extends AuthUser {
  password_hash: string;
  /** 密码重置时随账号一起保存；旧会话文件即使写失败也不能恢复登录。 */
  session_version?: number;
  created_at: string;
  disabled: boolean;
  /** 个人 Git 平台令牌(PAT)。密码是哈希,这个必须明文存——git 要用
   * 原文;所以只许住在 0600 的本文件里,永不进公开视图/日志/URL。 */
  git_token?: string;
  /** 个人通知令牌(小鲁班):该接口以令牌对应的人的身份发消息,
   * 所以按人存,不是服务级配一个。 */
  luban_token?: string;
  /** 平台侧的 git 用户名,PAT 的搭档;不填默认用登录账号名。 */
  git_username?: string;
  /** 平台邮箱:commit 署名用。平台(CodeHub,类比 GitHub)判定
   * "这个 commit 是谁的"按 commit email 映射账号——令牌只管推送
   * 鉴权,署名归这里。不是密钥,可以回显。 */
  git_email?: string;
  /** 月光模式(免审批):开着时本人**需求交付**任务的人工节点由系统
   * 代答放行,事后复盘。随时可开可关,是持续状态不是下单时的一次性
   * 选择。问题处理不走这两根轴——那里是独立的介入档位(ADR-0019)。 */
  moonlight?: boolean;
  /** push 前人工确认(交付清单过目):与 moonlight 合成**需求交付**
   * "人工介入程度"的两个正交轴——月光管过程节点停不停,这个管交付
   * 内容出门前给不给人看。个人级默认、**缺省即开**(用户 2026-08-26
   * 拍板:默认开启、不做任务粒度),所以只落盘显式的 false。问题处理
   * 侧没有独立开关——过目并进介入档位定义(ADR-0019)。 */
  push_confirmation?: boolean;
  /** 问题处理的介入档位(v2 按流剥离,2026-09-09 拍板):三档,缺省
   * 二档「优先报告」,全员从二档起步不继承需求侧。稀疏存储:二档
   * 即缺省不落盘,只落显式的 1/3。 */
  issue_intervention_tier?: IssueInterventionTier;
  /** 自动接单开关(ADR-0061,2026-10-10 修订迁入个人设置):true=本人
   *  已开启,名下符合条件的新 DTS 单由平台定时自动发起。缺省关闭,
   *  稀疏存储:缺席=关闭。管理员账号在 setIssueAutoClaim 拒收。 */
  issue_auto_claim?: boolean;
  /** 个人模型网关(ADR-0068):成员自配的模型接入(地址/密钥/模型/
   *  接口格式),配齐则名下任务的主模型调用整体走它。形态与 settings
   *  的 models 同构,json 里含 apiKey 明文——所以与个人令牌同纪律:
   *  只住 0600 的本文件,永不进公开视图/日志,界面只看掩码。 */
  personal_models?: ModelsSettings;
}

interface UserFile {
  /** v2(2026-09-09):人工介入程度按流剥离——需求侧沿用 moonlight/
   * push_confirmation,问题侧换成单一介入档位 issue_intervention_tier
   * (缺省二档,不继承,v1 升级只改文件格式)。 */
  version: 2;
  users: StoredUser[];
  /** 已删除账号永久占用用户名，避免后来同名账号继承旧任务操作权。 */
  retired_usernames?: string[];
}

interface FailureWindow {
  attempts: number;
  startedAt: number;
}

const USERNAME = /^[A-Za-z0-9._-]{2,48}$/;
const FAILURE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

export class LocalAuth {
  private users = new Map<string, StoredUser>();
  private retiredUsernames = new Set<string>();
  /** 键是令牌的 sha256 hex——内存里也不留原始令牌,与落盘口径一致。 */
  private sessions = new Map<string, { username: string; user_session_version: number }>();
  private failures = new Map<string, FailureWindow>();
  private readonly sessionsFile: string;

  constructor(readonly file: string) {
    this.sessionsFile = `${file}.sessions`;
    this.load();
    this.loadSessions();
  }

  hasUsers(): boolean {
    return this.users.size > 0;
  }

  bootstrapAdmin(username: string, password: string): AuthUser {
    if (this.hasUsers()) {
      const existing = this.users.get(username);
      if (!existing) {
        throw new Error("账号库已存在，但引导管理员账号不在其中");
      }
      return publicUser(existing);
    }
    return this.createUser(username, password, "admin");
  }

  listUsers(): AuthUser[] {
    return [...this.users.values()]
      .map(publicUser)
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  collaborationAssignees(needs: {
    git_token: boolean;
    luban_token: boolean;
  }): CollaborationAssignee[] {
    return [...this.users.values()]
      .filter((user) => !user.disabled && user.role === "developer")
      .map((user) => {
        const missing: string[] = [];
        if (needs.git_token && !user.git_token) missing.push("CodeHub Token");
        if (needs.git_token && !user.git_email) missing.push("提交邮箱");
        if (needs.luban_token && !user.luban_token) missing.push("小鲁班 Token");
        return {
          username: user.username,
          ...(user.display_name ? { display_name: user.display_name } : {}),
          ready: missing.length === 0,
          missing,
        };
      })
      .sort((a, b) => a.username.localeCompare(b.username));
  }

  createUser(
    username: string,
    password: string,
    role: UserRole,
    displayName?: string,
  ): AuthUser {
    const normalized = username.trim();
    validateCredentials(normalized, password);
    if (role !== "admin" && role !== "developer") {
      throw new Error("role 只能是 admin 或 developer");
    }
    if (this.users.has(normalized)) {
      throw new Error(`账号 ${normalized} 已存在`);
    }
    if (this.retiredUsernames.has(normalized)) {
      throw new Error(`账号 ${normalized} 已删除，不能同名重建；历史任务仍归原账号`);
    }
    const user: StoredUser = {
      username: normalized,
      ...normalizeDisplayName(displayName),
      role,
      password_hash: hashPassword(password),
      created_at: new Date().toISOString(),
      disabled: false,
    };
    this.users.set(normalized, user);
    this.persist();
    return publicUser(user);
  }

  /** 管理员维护显示名。清空等于回退为只显示工号，不影响身份与历史。 */
  setDisplayName(username: string, displayName?: string): AuthUser {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const normalized = normalizeDisplayName(displayName);
    if (normalized.display_name) stored.display_name = normalized.display_name;
    else delete stored.display_name;
    this.persist();
    return publicUser(stored);
  }

  /** 管理员删账号。内部平台的口径:人走了账号就清,不搞停用/归档两套
   * 状态。两条底线仍要守——不许删自己(正在用的会话把自己删了,页面
   * 立刻变砖,误触无法挽回),不许删掉最后一个管理员(没人能再进管理
   * 页,只能上服务器改文件)。历史任务不受影响:任务台账记的是账号名
   * 字符串,人没了名字还在,凭据消费口查不到人自然返回空(fail-open)。 */
  deleteUser(username: string, operator: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (username === operator) {
      throw new Error("不能删除自己——请让另一位管理员操作");
    }
    if (stored.role === "admin"
        && [...this.users.values()]
          .filter((user) => user.role === "admin" && !user.disabled)
          .length <= 1) {
      throw new Error("这是最后一个管理员账号,删掉就没人能管理平台了");
    }
    this.users.delete(username);
    // 任务归属当前以用户名作为稳定身份。若允许同名重建，新用户会立刻
    // 获得旧用户历史任务的决定/暂停/取消权，因此删除名必须永久保留。
    this.retiredUsernames.add(username);
    // 他手里的活会话一并作废:账号都没了,令牌不该再能用。
    for (const [token, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(token);
    }
    this.persist();
    this.persistSessions();
  }

  /** 管理员直接改密码,不验旧密码(内部平台,用户拍板:忘了密码找管理
   * 员重置,不搞自助找回那套)。新密码仍走同一套长度校验;改完把这个
   * 人的活会话全部作废——旧会话若还能用,"重置"就只是半截。 */
  resetPassword(username: string, password: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    validateCredentials(stored.username, password);
    stored.password_hash = hashPassword(password);
    stored.session_version = (stored.session_version ?? 0) + 1;
    for (const [token, session] of this.sessions) {
      if (session.username === username) this.sessions.delete(token);
    }
    this.persist();
    this.persistSessions();
  }

  authenticate(
    username: string,
    password: string,
    source: string,
  ): { user?: AuthUser; blockedForMs?: number } {
    const normalized = username.trim();
    const key = `${source}:${normalized}`;
    const now = Date.now();
    const failure = this.failures.get(key);
    if (failure && now - failure.startedAt < FAILURE_WINDOW_MS
        && failure.attempts >= MAX_FAILURES) {
      return {
        blockedForMs: FAILURE_WINDOW_MS - (now - failure.startedAt),
      };
    }
    if (failure && now - failure.startedAt >= FAILURE_WINDOW_MS) {
      this.failures.delete(key);
    }

    const stored = this.users.get(normalized);
    if (!stored || stored.disabled
        || !verifyPassword(password, stored.password_hash)) {
      const current = this.failures.get(key);
      this.failures.set(key, current
        ? { ...current, attempts: current.attempts + 1 }
        : { attempts: 1, startedAt: now });
      return {};
    }
    this.failures.delete(key);
    return { user: publicUser(stored) };
  }

  /** 设置/更换/删除个人 Git 令牌 + 署名邮箱。只写不读:调用方拿不回
   * 明文,想看只有掩码(gitTokenHint)。空令牌=删除(连邮箱一起清)。
   *
   * **邮箱必填**(用户 2026-08-19 拍板):commit 署名要它,内网平台还
   * 按邮箱对人——没有它推上去的提交是无主的。**用户名不另配**:git
   * 用户名就是登录账号名(同一次拍板)——账号由管理员按平台用户名建,
   * 再开一个"平台用户名"字段只会造出两个可以互相不一致的真相。 */
  setGitToken(
    username: string,
    token: string,
    gitEmail?: string,
  ): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const trimmed = token.trim();
    if (!trimmed) {
      delete stored.git_token;
      delete stored.git_username;
      delete stored.git_email;
    } else {
      if (Buffer.byteLength(trimmed, "utf-8") > 512) {
        throw new Error("令牌过长");
      }
      const email = (gitEmail ?? "").trim();
      if (!email) {
        throw new Error("平台邮箱必填:commit 署名与平台对人都要它");
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error(`平台邮箱格式不对: ${email}`);
      }
      stored.git_token = trimmed;
      // 旧版遗留的独立 git_username 顺手清掉:用户名以账号名为准。
      delete stored.git_username;
      stored.git_email = email;
    }
    this.persist();
  }

  /** 掩码提示(••••末4位),给界面确认"配过了、是哪个"用。 */
  gitTokenHint(username: string): string | undefined {
    return maskToken(this.users.get(username)?.git_token);
  }

  /** 设置/删除个人通知令牌(小鲁班)。与 Git 令牌同样是"只写不读"。
   *
   * 为什么按人存而不是全服务配一个:那个接口是**以令牌对应的人的
   * 身份发消息**——用服务号统一发,所有人收到的都是同一个机器人;
   * 每人配自己的,普通提醒可自己发给自己,也能主动发给检视人,
   * 不需要额外申请机器人账号
   * (用户 2026-08-18 拍板)。空串=删除。 */
  setLubanToken(username: string, token: string): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const trimmed = token.trim();
    if (!trimmed) {
      delete stored.luban_token;
    } else {
      if (Buffer.byteLength(trimmed, "utf-8") > 512) {
        throw new Error("令牌过长");
      }
      stored.luban_token = trimmed;
    }
    this.persist();
  }

  lubanTokenHint(username: string): string | undefined {
    return maskToken(this.users.get(username)?.luban_token);
  }

  /** 设置/更换/清空个人模型网关(ADR-0068)。表单四字段与平台网关共用
   *  同一套合并口径(mergeModelsForm:api_key 留空=沿用已存,其余缺席
   *  沿用已存值);四字段全空或显式 clear=删除配置,名下任务回落平台
   *  网关。只写不读:明文只住本文件,界面拿到的只有掩码视图。 */
  setPersonalModels(
    username: string,
    patch: ModelsFormPatch & { clear?: unknown },
  ): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    const blank = (value: unknown) =>
      value === undefined || value === null || String(value).trim() === "";
    if (patch.clear === true
        || (blank(patch.url) && blank(patch.api_key)
          && blank(patch.model) && blank(patch.api))) {
      delete stored.personal_models;
      this.persist();
      return;
    }
    stored.personal_models = mergeModelsForm(
      stored.personal_models ?? {}, patch, "maeflow-personal");
    this.persist();
  }

  /** 消费口(唯一允许碰明文的出口):会话启动解析模型网关时按归属人
   *  现取。停用账号不给——与 gitCredential/lubanToken 同纪律。 */
  personalModels(username: string | undefined): ModelsSettings | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return stored.personal_models;
  }

  /** 个人网关的掩码视图:是否已配、url/model/api 明文与密钥末 4 位。 */
  personalModelsView(username: string): PersonalModelsView {
    const config = this.users.get(username)?.personal_models;
    const providers = jsonProviders(config?.json);
    const provider = config?.provider || Object.keys(providers)[0];
    const spec = providers[provider ?? ""] ?? {};
    return {
      configured: !!spec?.baseUrl && !!spec?.apiKey && !!config?.model,
      ...(spec?.baseUrl ? { url: String(spec.baseUrl) } : {}),
      ...(config?.model ? { model: config.model } : {}),
      ...(spec?.api ? { api: String(spec.api) } : {}),
      ...(spec?.apiKey
        ? { key_hint: maskToken(String(spec.apiKey)) } : {}),
    };
  }

  /** 消费口(唯一碰明文的出口):发送通知时按发起人取发送令牌。
   * 停用账号不给——离职/停权的人不该继续以他的身份发消息。 */
  lubanToken(username: string | undefined): string | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return stored.luban_token;
  }

  /** 月光模式开关。开=本人任务免审批(系统代答),关=恢复人工闸。 */
  setMoonlight(username: string, on: boolean): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) stored.moonlight = true;
    else delete stored.moonlight;
    this.persist();
  }

  /** 管理员维护 Committer 名单；权限校验由 HTTP 边界负责。 */
  setCommitter(username: string, on: boolean): AuthUser {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) stored.committer = true;
    else delete stored.committer;
    this.persist();
    return publicUser(stored);
  }

  /** 自动接单开关(ADR-0061;2026-10-10 修订迁入个人设置):本人自助
   * 开关,缺省关闭。管理员账号不收:管理员不写问题会话,开了也永远
   * 轮不到他。 */
  setIssueAutoClaim(username: string, on: boolean): AuthUser {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on && stored.role === "admin") {
      throw new Error("管理员不处理问题单,不能开启自动接单");
    }
    if (on) stored.issue_auto_claim = true;
    else delete stored.issue_auto_claim;
    this.persist();
    return publicUser(stored);
  }

  /** 自动接单开关读取口:已开启且未停用的开发责任人,现读现判
   * ——开关翻转下一拍生效,不必重启。 */
  issueAutoClaimAccounts(): string[] {
    return [...this.users.values()]
      .filter((user) => user.issue_auto_claim
        && !user.disabled && user.role === "developer")
      .map((user) => user.username)
      .sort((a, b) => a.localeCompare(b));
  }

  /** 本人开关的当前态(个人设置显示与翻转的基准)。 */
  issueAutoClaimEnabled(username: string | undefined): boolean {
    if (!username) return false;
    return !!this.users.get(username)?.issue_auto_claim;
  }

  moonlightEnabled(username: string | undefined): boolean {
    if (!username) return false;
    const stored = this.users.get(username);
    return !!stored?.moonlight && !stored.disabled;
  }

  /** 问题处理介入档位(ADR-0019):缺省二档;闸位策略由问题流按档位
   * 现读现判,这里只管存取。非法档位拒绝( HTTP 边界转 400)。 */
  setIssueInterventionTier(username: string, tier: IssueInterventionTier): void {
    if (!isIssueInterventionTier(tier)) {
      throw new Error(`非法介入档位: ${String(tier)}`);
    }
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (tier === "2") delete stored.issue_intervention_tier;
    else stored.issue_intervention_tier = tier;
    this.persist();
  }

  issueInterventionTier(username: string | undefined): IssueInterventionTier {
    if (!username) return DEFAULT_ISSUE_INTERVENTION_TIER;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return DEFAULT_ISSUE_INTERVENTION_TIER;
    return stored.issue_intervention_tier ?? DEFAULT_ISSUE_INTERVENTION_TIER;
  }

  /** push 前人工确认默认值(缺省即开,只落盘显式的关)。改动即时
   * 生效于本人后续到达推送点的任务;已经在等确认的卡不撤——那张卡
   * 是按当时的意愿举的,点一下"确认按清单推送"就走,不存在悬死。 */
  setPushConfirmation(username: string, on: boolean): void {
    const stored = this.users.get(username);
    if (!stored) throw new Error(`账号 ${username} 不存在`);
    if (on) delete stored.push_confirmation;
    else stored.push_confirmation = false;
    this.persist();
  }

  /** 无账号(未接登录的部署、probe/pilot 演练链)不默认举卡——
   * 那些链路没有"人"在场,默认开只会卡死自动化;默认开只对真人。 */
  pushConfirmationEnabled(username: string | undefined): boolean {
    if (!username) return false;
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return false;
    return stored.push_confirmation !== false;
  }

  /** 登录与 /auth/me 共用同一份本人视图，避免登录响应漏字段后让前端
   * 误以为个人配置丢失。只按传入账号读取，不接受客户端指定目标用户。 */
  sessionView(username: string): AuthSessionUser | undefined {
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return {
      ...publicUser(stored),
      ...this.gitProfile(username),
      luban_token_hint: this.lubanTokenHint(username),
      moonlight: this.moonlightEnabled(username),
      push_confirmation: this.pushConfirmationEnabled(username),
      issue_intervention_tier: this.issueInterventionTier(username),
      issue_auto_claim: this.issueAutoClaimEnabled(username),
      personal_models: this.personalModelsView(username),
    };
  }

  /** 给界面回显的非密部分:掩码提示 + 平台用户名/邮箱。 */
  gitProfile(username: string): {
    git_token_hint?: string;
    git_email?: string;
  } {
    const stored = this.users.get(username);
    if (!stored?.git_token) return {};
    return {
      git_token_hint: this.gitTokenHint(username),
      git_email: stored.git_email,
    };
  }

  /** 消费口(唯一允许碰明文的出口):任务启动时注入 credential
   * helper 与 commit 署名用。git 用户名没配就用登录账号名。 */
  gitCredential(
    username: string | undefined,
  ): { username: string; password: string; email?: string } | undefined {
    if (!username) return undefined;
    const stored = this.users.get(username);
    if (!stored?.git_token || stored.disabled) return undefined;
    return {
      // 用户名=账号名(用户拍板):账号由管理员按平台用户名建,不留
      // 第二个可以与之不一致的字段。旧数据里的 git_username 不再读。
      username: stored.username,
      password: stored.git_token,
      email: stored.git_email,
    };
  }

  /** 账号角色查询(问题登记指派校验用,ADR-0031):账号不存在或已
   * 停用返回 undefined。只回角色,不回任何个人数据——与 listUsers
   * 的管理员专享边界不同,这只是"这个工号存不存在、是不是管理员"
   * 的单点事实。 */
  roleOf(username: string): UserRole | undefined {
    const stored = this.users.get(username);
    if (!stored || stored.disabled) return undefined;
    return stored.role;
  }

  createSession(user: AuthUser): string {
    const stored = this.users.get(user.username);
    if (!stored || stored.disabled) throw new Error("账号不可登录");
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(sessionKey(token), {
      username: user.username,
      user_session_version: stored.session_version ?? 0,
    });
    this.persistSessions();
    return token;
  }

  sessionUser(token: string | undefined): AuthUser | undefined {
    if (!token) return undefined;
    const key = sessionKey(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    const user = this.users.get(session.username);
    return user && !user.disabled
      && session.user_session_version === (user.session_version ?? 0)
      ? publicUser(user) : undefined;
  }

  endSession(token: string | undefined): void {
    if (!token) return;
    if (this.sessions.delete(sessionKey(token))) this.persistSessions();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as
      { version?: number; users?: StoredUser[]; retired_usernames?: unknown[] };
    if ((parsed.version !== 1 && parsed.version !== 2)
        || !Array.isArray(parsed.users)) {
      throw new Error(`账号文件格式不受支持: ${this.file}`);
    }
    for (const user of parsed.users) {
      this.users.set(user.username, user);
    }
    for (const username of parsed.retired_usernames ?? []) {
      if (typeof username === "string") this.retiredUsernames.add(username);
    }
    // v1→v2 只升文件格式,不做任何继承:问题处理介入档位全员缺省
    // 二档(ADR-0019 拍板),需求侧字段原值保留。
    if (parsed.version === 1) this.persist();
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    const body: UserFile = {
      version: 2,
      users: [...this.users.values()],
      ...(this.retiredUsernames.size
        ? { retired_usernames: [...this.retiredUsernames].sort() } : {}),
    };
    writeFileSync(temp, JSON.stringify(body, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(temp, this.file);
    chmodSync(this.file, 0o600);
  }

  /** 会话缓存是旁路:读坏了丢掉重登,写失败静默——绝不反噬认证请求。 */
  private loadSessions(): void {
    try {
      if (!existsSync(this.sessionsFile)) return;
      const parsed = JSON.parse(readFileSync(this.sessionsFile, "utf-8"));
      if (![1, 2].includes(parsed?.version) || !Array.isArray(parsed.sessions)) return;
      const now = Date.now();
      for (const item of parsed.sessions) {
        if (typeof item?.token_sha256 !== "string"
            || typeof item?.username !== "string") continue;
        // 部署时保留仍有效的旧登录；已经过期的旧令牌不重新启用。
        if (parsed.version === 1 && (typeof item.expiresAt !== "number"
            || !Number.isFinite(item.expiresAt) || item.expiresAt <= now)) continue;
        const user = this.users.get(item.username);
        if (!user || user.disabled) continue;
        const version = user.session_version ?? 0;
        if (parsed.version === 1 ? version !== 0 : item.user_session_version !== version) continue;
        this.sessions.set(item.token_sha256,
          { username: item.username, user_session_version: version });
      }
      if (parsed.version === 1) this.persistSessions();
    } catch { /* 损坏就当没有:代价只是全员重登一次 */ }
  }

  private persistSessions(): void {
    try {
      mkdirSync(dirname(this.sessionsFile), { recursive: true });
      const temp = `${this.sessionsFile}.tmp`;
      writeFileSync(temp, JSON.stringify({
        version: 2,
        sessions: [...this.sessions.entries()]
          .map(([token_sha256, session]) => ({ token_sha256, ...session })),
      }), { encoding: "utf-8", mode: 0o600 });
      renameSync(temp, this.sessionsFile);
      chmodSync(this.sessionsFile, 0o600);
    } catch { /* 写不动只影响下次重启后的续登,不许打断本次请求 */ }
  }
}

/** 会话表键=令牌 sha256:内存与磁盘上都不存在可直接使用的令牌。 */
function sessionKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 掩码:••••末4位。密钥一律只写不读,界面只用它确认"配过了、是哪个"。 */
function maskToken(token: string | undefined): string | undefined {
  if (!token) return undefined;
  return token.length <= 4 ? "••••" : `••••${token.slice(-4)}`;
}

function publicUser(user: StoredUser): AuthUser {
  return {
    username: user.username,
    ...(user.display_name ? { display_name: user.display_name } : {}),
    role: user.role,
    ...(user.committer ? { committer: true } : {}),
    ...(user.issue_auto_claim ? { issue_auto_claim: true } : {}),
  };
}

function normalizeDisplayName(value: string | undefined): { display_name?: string } {
  const displayName = value?.trim() ?? "";
  if (!displayName) return {};
  if (displayName.length > 40) throw new Error("姓名最多 40 个字符");
  if (/\r|\n|\t/.test(displayName)) throw new Error("姓名不能包含换行或制表符");
  return { display_name: displayName };
}

function validateCredentials(username: string, password: string): void {
  if (!USERNAME.test(username)) {
    throw new Error("账号需为 2–48 位字母、数字、点、下划线或短横线");
  }
  if (password.length < 10) {
    throw new Error("密码至少需要 10 个字符");
  }
  if (Buffer.byteLength(password, "utf-8") > 256) {
    throw new Error("密码过长");
  }
}

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${digest.toString("base64")}`;
}

function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, saltText, digestText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !digestText) return false;
  try {
    const expected = Buffer.from(digestText, "base64");
    const actual = scryptSync(password, Buffer.from(saltText, "base64"), 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function cookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
