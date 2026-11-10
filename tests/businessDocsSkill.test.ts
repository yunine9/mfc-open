import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { knowledgeArchiveDefaults } from "../src/knowledgeArchiveDefaults.ts";
import { domainExecutionContract } from "../src/domainKnowledgeExecution.ts";
import { bundledExtractionSkill, extractionSkillTool, KnowledgeExtractionSkills } from "../src/knowledgeExtractionSkills.ts";

const packageRoot = fileURLToPath(new URL("../internal-skills/business-docs-generator/", import.meta.url));
function readPackage(relative = "", files: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true })) {
    const path = posix.join(relative, entry.name);
    if (entry.isDirectory()) readPackage(path, files);
    else {
      assert.equal(entry.isFile(), true, `${path} 应为普通文件`);
      assert.ok(path.endsWith(".md"), `${path} 应可通过领域方法目录上传`);
      files[path] = readFileSync(join(packageRoot, path), "utf8");
    }
  }
  return files;
}

// 保留附件的全部文档类型；模板的示例与说明随平台方法一起精修。
const requiredTemplates = [
  "templates/domain/architecture.md",
  "templates/domain/domain-agents.md",
  "templates/domain/domain.md",
  "templates/domain/external-system.md",
  "templates/domain/glossary.md",
  "templates/domain/interface-contract.md",
  "templates/domain/root-agents.md",
  "templates/repo/business-rules.md",
  "templates/repo/coding-conventions.md",
  "templates/repo/experience.md",
  "templates/repo/module-doc.md",
  "templates/repo/module-map.md",
  "templates/repo/repo-agents.md"
];

test("内置业务方法保留全部 13 种文档模板，执行引用完整", () => {
  const files = readPackage();
  assert.deepEqual(Object.keys(files).filter(path => path.startsWith("templates/")).sort(), requiredTemplates.slice().sort());
  for (const path of requiredTemplates) assert.ok(files[path].trim().length > 100, `${path} 需要完整模板`);
  for (const name of ["plan", "plan-template", "generate-domain", "generate-repo", "verify-doc"]) {
    assert.ok(files[`prompts/${name}.md`], `缺少附件执行提示词 ${name}`);
  }
  // 仅执行文件中的方法链接必须在包内；原模板链接是待生成文稿的示例，不能误当作包引用。
  for (const [path, content] of Object.entries(files).filter(([path]) => !path.startsWith("templates/"))) {
    for (const match of content.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(match[1])) continue;
      assert.ok(files[posix.normalize(posix.join(posix.dirname(path), match[1]))], `${path} 的方法引用缺失：${match[1]}`);
    }
  }
  assert.deepEqual(knowledgeArchiveDefaults(files, "domain"), { domain_directory: "docs", repository_directory: "docs" });
  assert.deepEqual(knowledgeArchiveDefaults({}, "domain"), { domain_directory: "docs", repository_directory: "docs" });
  assert.equal(domainExecutionContract(files), "reviewed-document-plan");
});

test("旧方法的归档默认目录仍允许仓根，但拒绝穿越及嵌入点目录", () => {
  const files = (repository_directory: string) => ({ "references/archive-defaults.md": "```json\n" + JSON.stringify({ domain_directory: "domain-docs", repository_directory }) + "\n```" });
  assert.equal(knowledgeArchiveDefaults(files("."), "domain").repository_directory, ".");
  for (const path of ["../docs", "docs/../other", "./docs", "docs/./other", "/docs", "docs/.git"]) {
    assert.throws(() => knowledgeArchiveDefaults(files(path), "domain"), /归档默认位置无效/);
  }
});

test("新任务直接固定完整内置方法，历史上传不覆盖，运行中旧固定包仍可接续", async () => {
  const root = mkdtempSync(join(tmpdir(), "business-docs-package-"));
  try {
    const files = readPackage(), store = new KnowledgeExtractionSkills(root);
    const saved = store.current("domain");
    assert.equal(saved.name, "business-docs-generator");
    assert.equal(saved.kind, "domain");
    assert.deepEqual(saved.files, files, "新任务直接使用全部提示词、引用与两层模板");
    assert.equal(saved.digest, bundledExtractionSkill("domain").digest);
    const legacyFiles = { "SKILL.md": "---\nname: domain-knowledge-extraction\ndescription: 旧版领域方法\n---\n保留旧任务原方法。" };
    const old = { name: "domain-knowledge-extraction", digest: createHash("sha256").update(JSON.stringify(Object.entries(legacyFiles).sort(([a], [b]) => a.localeCompare(b)))).digest("hex"),
      files: legacyFiles, captured_at: "2026-10-01T00:00:00Z" };
    const oldPath = join(root, "old-task", "skill.json"); mkdirSync(dirname(oldPath), { recursive: true });
    writeFileSync(oldPath, JSON.stringify(old));
    const override = join(store.root, "domain-knowledge-extraction", "current.json"); mkdirSync(dirname(override), { recursive: true });
    writeFileSync(override, JSON.stringify(old));
    assert.equal(store.current("domain").digest, saved.digest);
    assert.equal(readFileSync(override, "utf8"), JSON.stringify(old), "旧上传记录保留原样");
    assert.deepEqual(store.pin("domain", oldPath), old, "旧无kind固定包不被更名或替换");
    const pinned = store.pin("domain", join(root, "new-task", "skill.json"));
    assert.equal(pinned.digest, saved.digest);
    assert.equal(store.pin("domain", join(root, "new-task", "skill.json")).digest, saved.digest, "新包再次加载可通过kind校验");
    const tool: any = extractionSkillTool(pinned);
    for (const path of Object.keys(files)) {
      const result = await tool.execute("package-read", { path });
      assert.equal(result.content[0].text, files[path], path);
    }
    assert.equal(store.pin("domain", oldPath, true).digest, saved.digest, "明确使用最新方法才更新旧任务");
    const archive = join(dirname(oldPath), "skill-packages", `${old.digest}.json`);
    assert.equal(JSON.parse(readFileSync(archive, "utf8")).digest, old.digest);
    await assert.rejects(store.save("domain", files, saved.digest, "admin"), /平台版本维护/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
