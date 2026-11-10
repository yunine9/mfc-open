import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentKnowledgeCheckReport, ComponentKnowledgeFinding, ComponentPolicy, ComponentFeedback } from "./componentKnowledgeTypes.ts";

export const componentDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const root = (dir: string) => join(dir, "component-governance");
function read<T>(dir: string, name: string, fallback: T): T {
  const file = join(root(dir), name + ".json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback;
}
function write(dir: string, name: string, value: unknown) {
  mkdirSync(root(dir), { recursive: true });
  const file = join(root(dir), name + ".json"), temporary = file + "." + randomUUID() + ".tmp";
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, file);
}
export type ComponentPolicyFile = { version: 1; revision: number; items: Record<string, ComponentPolicy> };
export function readComponentPolicies(dir: string): ComponentPolicyFile {
  const value = read<ComponentPolicyFile>(dir, "rule-policy", { version: 1, revision: 0, items: {} });
  if (value.version !== 1 || !Number.isInteger(value.revision) || !value.items || typeof value.items !== "object" || Array.isArray(value.items)) throw new Error("组件策略文件损坏，暂不启用提示");
  for (const item of Object.values(value.items)) {
    if (!["shadow", "warning", "off"].includes(item.level) || typeof item.source_digest !== "string" || !Array.isArray(item.scope)) throw new Error("组件策略格式无效，暂不启用提示");
    validateScopes(item.scope);
  }
  return value;
}
export function effectiveComponentPolicy(policy: ComponentPolicy | undefined, digest: string): ComponentPolicy {
  const base: ComponentPolicy = { level: "shadow", source_digest: digest, owner: "", scope: [], reason: "新候选，尚未人工启用", updated_at: "", operator: "" };
  if (!policy) return base;
  if (policy.level === "off" || policy.source_digest === digest) return policy;
  return { ...base, owner: policy.owner, reason: "知识内容或适用范围已变化，请重新核对", stale: true };
}
function validateScopes(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 30 || value.some(p => typeof p !== "string" || !p || p.length > 300 || p.startsWith("/") || p.split("/").some(s => !s || s === "." || s === "..") || /[\\\x00-\x20\[\]{}!?]/.test(p))) throw new Error("路径范围需使用仓内相对路径，仅支持 * 和 **，例如 src/**");
}
export function componentPathMatches(path: string, scope: string[]) {
  return !scope.length || scope.some(pattern => {
    let expression = "";
    for (let i = 0; i < pattern.length; i++) {
      if (pattern.slice(i, i + 3) === "**/") { expression += "(?:.*/)?"; i += 2; }
      else if (pattern.slice(i, i + 2) === "**") { expression += ".*"; i++; }
      else if (pattern[i] === "*") expression += "[^/]*";
      else expression += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp("^" + expression + "$", "u").test(path);
  });
}
export function saveComponentPolicy(dir: string, id: string, digest: string, input: Record<string, unknown>, operator: string) {
  const file = readComponentPolicies(dir);
  if (input.revision !== file.revision) throw new Error("策略已被其他人更新，请刷新后重试");
  if (input.source_digest !== digest) throw new Error("源知识已变化，请刷新后核对当前内容");
  const level = input.level;
  if (level !== "shadow" && level !== "warning" && level !== "off") throw new Error("仅支持候选、提示、停用；组件知识不能拦截交付");
  const owner = String(input.owner ?? "").trim(), reason = String(input.reason ?? "").trim(), scope = input.scope ?? [];
  if (!reason || reason.length > 2000 || owner.length > 100 || (level === "warning" && !owner)) throw new Error("请填写变更理由；启用提示还需填写组件负责人");
  validateScopes(scope);
  const policy: ComponentPolicy = { level, source_digest: digest, owner, reason, scope, operator, updated_at: new Date().toISOString() };
  file.items[id] = policy; file.revision++;
  // 策略原子保存；操作记录独立保留，开发会话不会写策略。
  const history = read<any[]>(dir, "policy-history", []);
  write(dir, "rule-policy", file);
  write(dir, "policy-history", [...history, { id, ...policy }]);
  return file;
}
export interface ComponentObservation extends ComponentKnowledgeFinding {
  id: string; repository: string; checked_at: string; head?: string;
}
export function componentObservations(dir: string): ComponentObservation[] { return read(dir, "observations", []); }
export function componentFeedback(dir: string): ComponentFeedback[] { return read(dir, "feedback", []); }
export function componentObservationId(repository: string, f: ComponentKnowledgeFinding) {
  return componentDigest([repository, f.rule_id, f.source_digest, f.path, f.line, f.context]);
}
export function applyComponentExemptions(dir: string, repository: string, report: ComponentKnowledgeCheckReport) {
  const feedback = componentFeedback(dir);
  for (const f of report.findings) {
    f.observation_id = componentObservationId(repository, f);
    const exemption = feedback.findLast(r => r.observation_id === f.observation_id && ["useful", "false_positive"].includes(r.kind) && r.source_digest === f.source_digest);
    if (exemption?.kind === "false_positive") f.exempt_reason = exemption.reason;
  }
}
export function recordComponentObservations(dir: string, repository: string, report: ComponentKnowledgeCheckReport) {
  if (!report.findings.length) return;
  const entries = new Map(componentObservations(dir).map(o => [o.id, o]));
  for (const f of report.findings) {
    const id = componentObservationId(repository, f);
    entries.delete(id); entries.set(id, { ...f, id, repository, checked_at: report.checked_at, head: report.head });
  }
  // 人工反馈引用命中编号；新样本不能挤掉已有样本及其判断依据。
  write(dir, "observations", [...entries.values()]);
}
export function addComponentFeedback(dir: string, input: Record<string, unknown>, operator: string) {
  const kind = input.kind, reason = String(input.reason ?? "").trim();
  if (!["useful", "false_positive", "counterexample", "quality_ok", "quality_error"].includes(String(kind)) || !reason || reason.length > 4000) throw new Error("请选择反馈类型并说明具体依据（最多 4000 字）");
  const observation = typeof input.observation_id === "string" ? componentObservations(dir).find(o => o.id === input.observation_id) : undefined;
  if (["useful", "false_positive"].includes(String(kind)) && !observation) throw new Error("请先选择实际命中样本");
  if (input.observation_id && !observation) throw new Error("命中样本已不存在，请刷新");
  const row: ComponentFeedback = { id: randomUUID(), item_id: String(input.item_id), source_digest: String(input.source_digest),
    kind: kind as ComponentFeedback["kind"], reason, operator, at: new Date().toISOString(), ...(observation ? { observation_id: observation.id } : {}) };
  if (observation && (observation.rule_id !== row.item_id || observation.source_digest !== row.source_digest)) throw new Error("反馈与命中版本不一致");
  const previous = componentFeedback(dir).filter(f => !(f.item_id === row.item_id && f.source_digest === row.source_digest && f.operator === operator && f.observation_id === row.observation_id && f.kind === row.kind));
  write(dir, "feedback", [...previous, row]); return row;
}
