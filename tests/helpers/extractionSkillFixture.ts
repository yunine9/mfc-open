import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { runDomainKnowledge, type DomainAgentOptions } from "../../src/domainKnowledgeAgent.ts";
import type { DomainExecution } from "../../src/domainKnowledgeExtraction.ts";
import type { ExtractionSkillSnapshot } from "../../src/knowledgeExtractionSkills.ts";

export function domainSkillFixture(files: Record<string, string>): ExtractionSkillSnapshot {
  const { frontmatter } = parseFrontmatter<{ name?: string }>(files["SKILL.md"] ?? "");
  if (!frontmatter.name) throw new Error("测试方法需要 name");
  const digest = createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  return { name: frontmatter.name, kind: "domain", digest, captured_at: new Date().toISOString(), files };
}

/** 仅固定测试任务的初始方法；服务重启和后续轮次必须继续沿用已固定包。 */
export function pinDomainSkillFixture(root: string, files: Record<string, string>): ExtractionSkillSnapshot {
  const path = join(root, "skill.json");
  if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
  const skill = domainSkillFixture(files);
  mkdirSync(root, { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(skill), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  return skill;
}

export function runDomainKnowledgeFixture(files: Record<string, string>, input: DomainExecution, options: DomainAgentOptions) {
  pinDomainSkillFixture(input.root, files);
  return runDomainKnowledge(input, options);
}

export const genericDomainSkillFixture = {
  "SKILL.md": "---\nname: generic-domain-fixture\ndescription: 验证领域文稿工具与会话恢复。\n---\n按本轮要求保存文稿并明确提交执行结果。",
  "references/domain.md": "读取业务资料与源码依据，保存完整文稿和执行结论。",
};

export function runGenericDomainKnowledge(input: DomainExecution, options: DomainAgentOptions) {
  return runDomainKnowledgeFixture(genericDomainSkillFixture, input, options);
}
