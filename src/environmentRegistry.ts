/**
 * 环境管理:全局维护的网管环境台账(ADR-0020;#147 spec、#149 后端片)。
 *
 * 一条记录一个环境,主 IP 是唯一键(允许修改,改后查重)。字段:主 IP、
 * 端口、环境形态(virtualized | k8s)、后台密码(机密)、可选独立 root
 * 密码(可空——"数据层恒有有效值"是解析语义:留空不落冻结拷贝,消费方
 * 解析为后台密码)、标签数组、探活状态(探测本身是 #151,本票只留字段,
 * 默认 unverified)、created_by/updated_by 审计。
 *
 * 存储:整个台账密封进 <dataDir>/.environment-registry/registry.json
 * (AES-256-GCM,机制在 src/sealedFile.ts,抽自会话级 vault 的同一套
 * 纪律;key.bin 与会话 vault 互相独立)。明文密码绝不进普通 json,
 * 视图/API 只出非密字段与"已配置"布尔。台账是全局团队资源:登录即可
 * 读写(归属闸与 admin 403 都不做,ADR-0020 裁定),写操作记 updated_by。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { SealedFile } from "./sealedFile.ts";

export type EnvironmentForm = "virtualized" | "k8s";

export type EnvironmentProbeStatus = "unverified" | "ok" | "failed";

export type EnvironmentProbeFailureReason = "auth" | "unreachable";

export interface EnvironmentProbeState {
  state: EnvironmentProbeStatus;
  /** 失败二分:认证失败 / 不可达(#151 探测回填)。 */
  reason?: EnvironmentProbeFailureReason;
  at?: string;
}

export interface EnvironmentRegistryInput {
  ip: string;
  port?: number;
  form: EnvironmentForm;
  backendPassword: string;
  /** 缺席/空 = 留空继承后台密码(解析语义)。 */
  rootPassword?: string | null;
  tags?: string[];
}

export interface EnvironmentRegistryPatch {
  ip?: string;
  port?: number;
  form?: EnvironmentForm;
  tags?: string[];
  /** 缺席或空 = 不变(编辑不回显,留空即不改)。 */
  backendPassword?: string;
  /** 缺席 = 不变;null/空 = 清掉显式值,回落继承后台密码。 */
  rootPassword?: string | null;
}

/** 台账视图:非密字段 + 机密"已配置"布尔。进 API/列表/日志的安全投影。 */
export interface EnvironmentRegistryView {
  id: string;
  ip: string;
  port: number;
  form: EnvironmentForm;
  tags: string[];
  probe: EnvironmentProbeState;
  /** 非密标志:true = 没有显式 root 密码,解析值 = 后台密码(页面
   * placeholder 与断言用;明文只有 secrets() 一条解密路)。 */
  root_password_inherited: boolean;
  /** 机密只出"已配置"布尔(ADR-0020:状态与接口只出引用与非密元信息)。 */
  password_configured: boolean;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

/** 消费方(#151 探活、快照拷进会话 vault)经解密路径取用的形状。
 * rootPassword 恒有有效值:显式值,或继承的后台密码。 */
export interface EnvironmentSecrets {
  backendPassword: string;
  rootPassword: string;
}

/** 录入校验打回(路由层映射 400)。 */
export class EnvironmentRegistryError extends Error {}

/** 条目不存在(路由层映射 404)。 */
export class EnvironmentNotFoundError extends EnvironmentRegistryError {
  constructor(readonly id: string) {
    super(`环境条目 ${id} 不存在`);
  }
}

/** 主 IP 撞车(创建与更新都查;路由层映射 409,带既有条目 id)。 */
export class EnvironmentIpConflictError extends EnvironmentRegistryError {
  constructor(readonly ip: string, readonly existingId: string) {
    super(`环境 ${ip} 已登记(条目 ${existingId})`);
  }
}

interface StoredEntry {
  id: string;
  ip: string;
  port: number;
  form: EnvironmentForm;
  backend_password: string;
  /** 显式独立 root 密码;缺席 = 继承后台密码(解析语义,不落冻结拷贝)。 */
  root_password?: string;
  tags: string[];
  probe: EnvironmentProbeState;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface RegistryFile {
  version: 1;
  entries: StoredEntry[];
}

const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;

function requiredText(value: unknown, label: string, max: number): string {
  const text = String(value ?? "").trim();
  if (!text) throw new EnvironmentRegistryError(`${label}不能为空`);
  if (text.length > max) {
    throw new EnvironmentRegistryError(`${label}不能超过 ${max} 个字符`);
  }
  if (/\0|[\r\n]/.test(text)) {
    throw new EnvironmentRegistryError(`${label}不能含控制字符`);
  }
  return text;
}

export function normalizeIp(value: unknown): string {
  const ip = requiredText(value, "主 IP", 255);
  if (/\s/.test(ip) || ip.startsWith("-")) {
    throw new EnvironmentRegistryError("主 IP 格式不合法");
  }
  return ip;
}

function normalizePort(value: unknown): number {
  const port = value === undefined || value === null ? 22 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new EnvironmentRegistryError("端口必须是 1-65535");
  }
  return port;
}

function normalizeForm(value: unknown): EnvironmentForm {
  const form = String(value ?? "");
  if (form !== "virtualized" && form !== "k8s") {
    throw new EnvironmentRegistryError("环境形态必须是 virtualized 或 k8s");
  }
  return form;
}

function normalizeTags(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new EnvironmentRegistryError("标签必须是数组");
  }
  const tags: string[] = [];
  for (const raw of value) {
    const tag = String(raw ?? "").trim();
    if (!tag) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new EnvironmentRegistryError(
        `标签不能超过 ${MAX_TAG_LENGTH} 个字符`);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS) {
    throw new EnvironmentRegistryError(`标签最多 ${MAX_TAGS} 个`);
  }
  return tags;
}

function normalizePassword(value: unknown, label: string): string {
  return requiredText(value, label, 4096);
}

/** 可空 root 密码:缺席/null/空白都解析为"继承"(不落冻结拷贝)。 */
function optionalRootPassword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? normalizePassword(text, "root 密码") : undefined;
}

function now(): string {
  return new Date().toISOString();
}

function rootField(value: unknown): { root_password?: string } {
  const root = optionalRootPassword(value);
  return root ? { root_password: root } : {};
}

/** IP 唯一键:创建与更新都走这里;selfId 用于更新时排除自己。 */
function assertIpFree(
  entries: StoredEntry[],
  ip: string,
  selfId?: string,
): void {
  const clash = entries.find((entry) =>
    entry.ip === ip && entry.id !== selfId);
  if (clash) throw new EnvironmentIpConflictError(ip, clash.id);
}

function view(entry: StoredEntry): EnvironmentRegistryView {
  return {
    id: entry.id,
    ip: entry.ip,
    port: entry.port,
    form: entry.form,
    tags: [...entry.tags],
    probe: { ...entry.probe },
    root_password_inherited: entry.root_password === undefined,
    password_configured: true,
    created_by: entry.created_by,
    updated_by: entry.updated_by,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

export class EnvironmentRegistry {
  private readonly store: SealedFile;

  constructor(dataDir: string) {
    this.store = new SealedFile(join(dataDir, ".environment-registry"));
  }

  /** 按条目 id 取非密视图(消费方快照定位用,#150);不存在返回 undefined。 */
  get(id: string): EnvironmentRegistryView | undefined {
    const entry = this.read().find((item) => item.id === id);
    return entry ? view(entry) : undefined;
  }

  /** 台账列表(非密视图)。 */
  list(): EnvironmentRegistryView[] {
    return this.read().map(view);
  }

  /** 按主 IP 找条目(查重与快选消费方用);比对前做同一把规范化。 */
  findByIp(ip: unknown): EnvironmentRegistryView | undefined {
    const needle = normalizeIp(ip);
    const found = this.read().find((entry) => entry.ip === needle);
    return found ? view(found) : undefined;
  }

  create(
    input: EnvironmentRegistryInput,
    actor: string,
  ): EnvironmentRegistryView {
    const by = requiredText(actor, "操作人账号", 128);
    const entry: StoredEntry = {
      id: randomUUID(),
      ip: normalizeIp(input.ip),
      port: normalizePort(input.port),
      form: normalizeForm(input.form),
      backend_password: normalizePassword(input.backendPassword, "后台密码"),
      ...rootField(input.rootPassword),
      tags: normalizeTags(input.tags),
      probe: { state: "unverified" },
      created_by: by,
      updated_by: by,
      created_at: now(),
      updated_at: now(),
    };
    this.write((entries) => {
      assertIpFree(entries, entry.ip);
      entries.push(entry);
    });
    return view(entry);
  }

  update(
    id: string,
    patch: EnvironmentRegistryPatch,
    actor: string,
  ): EnvironmentRegistryView {
    const by = requiredText(actor, "操作人账号", 128);
    let result: EnvironmentRegistryView | undefined;
    this.write((entries) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new EnvironmentNotFoundError(id);
      if (patch.ip !== undefined) {
        const ip = normalizeIp(patch.ip);
        assertIpFree(entries, ip, entry.id);
        entry.ip = ip;
      }
      if (patch.port !== undefined) entry.port = normalizePort(patch.port);
      if (patch.form !== undefined) entry.form = normalizeForm(patch.form);
      if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags);
      // 后台密码留空 = 不变(编辑不回显的既定契约);给了就整串替换。
      const password = patch.backendPassword === undefined
        ? "" : String(patch.backendPassword).trim();
      if (password) {
        entry.backend_password = normalizePassword(password, "后台密码");
      }
      if (patch.rootPassword !== undefined) {
        const root = optionalRootPassword(patch.rootPassword);
        if (root) entry.root_password = root;
        else delete entry.root_password;
      }
      entry.updated_by = by;
      entry.updated_at = now();
      result = view(entry);
    });
    return result!;
  }

  remove(id: string): void {
    this.write((entries) => {
      const at = entries.findIndex((item) => item.id === id);
      if (at < 0) throw new EnvironmentNotFoundError(id);
      entries.splice(at, 1);
    });
  }

  /** 解密路径:只有服务端消费方(#151 探活、快照拷进会话 vault)走
   * 这里,不经任何 HTTP 面。rootPassword 恒有有效值——显式值,或继承
   * 的后台密码(解析语义,读时解析,不落冻结拷贝)。 */
  secrets(id: string): EnvironmentSecrets | undefined {
    const entry = this.read().find((item) => item.id === id);
    if (!entry) return undefined;
    return {
      backendPassword: entry.backend_password,
      rootPassword: entry.root_password ?? entry.backend_password,
    };
  }

  /** 探活写回(#151):只改 probe 三态与时间戳——失败一次即标 failed
   * (带原因二分),下一次成功翻回 ok(原因一并清掉),unverified 只
   * 是首录缺省。这是后台观察不是人工编辑:updated_by/updated_at 与
   * 台账其余字段一概不碰。未知条目 404。 */
  recordProbe(
    id: string,
    outcome: { ok: true } | { ok: false; reason: EnvironmentProbeFailureReason },
  ): EnvironmentRegistryView {
    const at = now();
    let result: EnvironmentRegistryView | undefined;
    this.write((entries) => {
      const entry = entries.find((item) => item.id === id);
      if (!entry) throw new EnvironmentNotFoundError(id);
      entry.probe = outcome.ok
        ? { state: "ok", at }
        : { state: "failed", reason: outcome.reason, at };
      result = view(entry);
    });
    return result!;
  }

  private read(): StoredEntry[] {
    const file = this.store.read<RegistryFile>("registry.json");
    if (!file) return [];
    if (file.version !== 1 || !Array.isArray(file.entries)) {
      throw new EnvironmentRegistryError("环境台账文件版本不合法");
    }
    return file.entries;
  }

  private write(mutate: (entries: StoredEntry[]) => void): void {
    const entries = this.read();
    mutate(entries);
    this.store.write("registry.json",
      { version: 1, entries } satisfies RegistryFile);
  }
}

/** 同步预留(#149:只留 IP 幂等 upsert 形状,不做同步实现、不开导入
 * 路由):按主 IP 幂等 upsert 的纯函数——有则按输入整条更新(payload
 * 全量覆盖,root 密码缺席按继承清),无则创建;IP 唯一键保证同一输入
 * 反复导入收敛为同一条目。 */
export function upsertEnvironmentByIp(
  registry: EnvironmentRegistry,
  input: EnvironmentRegistryInput,
  actor: string,
): { entry: EnvironmentRegistryView; created: boolean } {
  const existing = registry.findByIp(input.ip);
  if (!existing) {
    return { entry: registry.create(input, actor), created: true };
  }
  return {
    entry: registry.update(existing.id, {
      ip: input.ip,
      port: input.port,
      form: input.form,
      backendPassword: input.backendPassword,
      rootPassword: input.rootPassword ?? null,
      tags: input.tags,
    }, actor),
    created: false,
  };
}

/** 手动沉淀(#150,闸卡手填作答带 save_to_registry):按 IP 幂等地把
 * 人现场填的环境存进团队台账,创建者/更新人 = 作答人。合并语义刻意比
 * upsertEnvironmentByIp 保守——沉淀是旁路贡献,绝不覆盖台账维护者显式
 * 配置过的数据:
 * - 台账无该 IP → 整条创建(后台密码、显式 root 若给定);
 * - 已有同 IP → 密码只补缺:后台密码恒已配置(创建必填)不动;root 仅
 *   在继承态(root_password_inherited=true)且本次给了显式值时补写——
 *   不清人家的显式 root,也不替换已显式配置的后台密码;
 * - 端口/形态/标签是维护者的数据,沉淀不改写(闸上的一次手填没有越权
 *   改写团队台账的道理)。 */
export function contributeEnvironmentByIp(
  registry: EnvironmentRegistry,
  input: EnvironmentRegistryInput,
  actor: string,
): { entry: EnvironmentRegistryView; created: boolean } {
  const existing = registry.findByIp(input.ip);
  if (!existing) {
    return { entry: registry.create(input, actor), created: true };
  }
  if (existing.root_password_inherited && input.rootPassword) {
    return {
      entry: registry.update(existing.id,
        { rootPassword: input.rootPassword }, actor),
      created: false,
    };
  }
  return { entry: existing, created: false };
}
