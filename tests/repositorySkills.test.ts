import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRepositorySkills,
  REPOSITORY_SKILL_ROOTS,
} from "../src/repositorySkills.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "mfc-repository-skills-src-"));
  git(dir, "init", "--quiet", "-b", "main");
  git(dir, "config", "user.email", "bot@test");
  git(dir, "config", "user.name", "bot");
  writeFileSync(join(dir, "README.md"), "# demo\n");
  commit(dir, "init");
  return dir;
}

function commit(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function writeSkill(
  repo: string,
  root: string,
  directory: string,
  name: string,
  description: string,
  extra = "",
): void {
  const skillDir = join(repo, root, directory);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    extra,
    "---",
    "",
    "只在任务匹配时读取并执行这些指引。",
    "",
  ].filter((line) => line !== "").join("\n"));
}

test("固定四根、支持分类层递归发现，并生成绑定仓库版本与内容的稳定 id", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".agents/skills", "java-review", "java-review",
    "检查 Java 代码约束");
  writeSkill(repo, ".pi/skills", "api-contract", "api-contract",
    "读取接口契约并指导实现");
  writeSkill(repo, ".claude/skills", "db-migrate", "db-migrate",
    "数据库迁移规范");
  writeSkill(repo, ".cac/skills", "cac-review", "cac-review",
    "CAC 随仓检视规范");
  // 分类层(2026-09-04):目录直接含 SKILL.md 即技能包,分类目录只是
  // 组织。嵌套与平铺同清单共存。
  writeSkill(repo, ".agents/skills/engineering", "nested",
    "nested", "分类层嵌套的技能");
  // 根目录散文件不是技能;技能包内部的 SKILL.md 是资源不是新技能
  // (发现即止,不进包内再找)。
  writeFileSync(join(repo, ".pi/skills/loose.md"),
    "---\nname: loose\ndescription: 不应发现\n---\n");
  const inner = join(repo, ".cac/skills/cac-review/templates");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "SKILL.md"),
    "---\nname: inner\ndescription: 包内资源不应单独发现\n---\n");
  const revision = commit(repo, "skills");

  const first = await discoverRepositorySkills({ repository: repo });
  const again = await discoverRepositorySkills({ repository: repo });
  assert.equal(first.error, undefined);
  assert.equal(first.revision, revision);
  // 候选按相对路径排序:分类层嵌套与平铺混排时顺序仍确定。
  assert.deepEqual(first.skills.map((skill) => skill.name),
    ["nested", "java-review", "cac-review", "db-migrate", "api-contract"]);
  assert.deepEqual(first.skills.map((skill) => skill.source),
    [".agents/skills", ".agents/skills", ".cac/skills",
      ".claude/skills", ".pi/skills"]);
  assert.ok(first.skills.every((skill) => /^[0-9a-f]{64}$/.test(skill.digest)));
  assert.deepEqual(first.skills.map((skill) => skill.id),
    again.skills.map((skill) => skill.id), "同仓同版本 id 必须稳定");
  const nestedSkill = first.skills.find((skill) => skill.name === "nested")!;
  assert.equal(nestedSkill.relative_path,
    ".agents/skills/engineering/nested/SKILL.md",
    "嵌套技能的相对路径携带分类层");
  assert.ok(!first.skills.some((skill) => skill.name === "loose"),
    "根目录散文件不发现");
  assert.ok(!first.skills.some((skill) => skill.name === "inner"),
    "技能包内部不递归发现(包是原子的)");
});

test("仓库没有 Skill 时成功返回空目录，不把可选能力变成下单故障", async () => {
  const repo = makeRepo();
  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.skills.length, 0);
  assert.equal(catalog.revision, git(repo, "rev-parse", "HEAD"));
});

test("Skill 发现只读取固定 Skill 根，不读取仓库其他文件", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "docs", "domain"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), [
    "# 项目约定",
    "开发订单能力前先阅读 docs/domain/orders.md。",
  ].join("\n"));
  writeFileSync(join(repo, "docs", "domain", "orders.md"),
    "# 订单领域\n\n订单状态机与幂等约束。\n");
  writeFileSync(join(repo, "docs", "misc.md"),
    "# 其他说明\n\n按需阅读。\n");
  commit(repo, "knowledge");

  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.deepEqual(catalog.skills, []);
});

test("disable-model-invocation 仍展示，但不可被自动选择", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".pi/skills", "manual-only", "manual-only",
    "只允许人显式调用", "disable-model-invocation: true");
  commit(repo, "manual skill");

  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.skills[0].selectable, false);
  assert.match(catalog.skills[0].warning ?? "", /禁止模型自动调用/);
});

test("拒绝符号链接、submodule、超大文件、非法路径和非法 frontmatter", async () => {
  const repo = makeRepo();

  const target = join(repo, "target-skill.md");
  writeFileSync(target,
    "---\nname: linked\ndescription: 不得跟随软链\n---\n");
  const linkDir = join(repo, ".agents/skills/linked");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync("../../../target-skill.md", join(linkDir, "SKILL.md"));

  const hugeDir = join(repo, ".pi/skills/huge");
  mkdirSync(hugeDir, { recursive: true });
  writeFileSync(join(hugeDir, "SKILL.md"),
    "---\nname: huge\ndescription: 太大\n---\n" + "x".repeat(128 * 1024));

  const unsafeDir = join(repo, ".claude/skills/bad\\path");
  mkdirSync(unsafeDir, { recursive: true });
  writeFileSync(join(unsafeDir, "SKILL.md"),
    "---\nname: unsafe\ndescription: 非法路径\n---\n");

  const emptyDir = join(repo, ".claude/skills/empty");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "SKILL.md"),
    "---\nname: empty\ndescription: ''\n---\n");

  const yamlDir = join(repo, ".claude/skills/broken-yaml");
  mkdirSync(yamlDir, { recursive: true });
  writeFileSync(join(yamlDir, "SKILL.md"),
    "---\nname: [broken\ndescription: nope\n---\n");

  const invalidNameDir = join(repo, ".claude/skills/invalid-name");
  mkdirSync(invalidNameDir, { recursive: true });
  writeFileSync(join(invalidNameDir, "SKILL.md"),
    "---\nname: INVALID_NAME\ndescription: 名字不合规范\n---\n");
  const parent = commit(repo, "unsafe candidates");

  // 直接向 index 写 gitlink；它不会被当目录深入，也不会触发 submodule。
  git(repo, "update-index", "--add", "--cacheinfo",
    `160000,${parent},.agents/skills/a-submodule`);
  git(repo, "commit", "--quiet", "-m", "gitlink");

  const catalog = await discoverRepositorySkills({ repository: repo });
  assert.equal(catalog.error, undefined);
  assert.deepEqual(catalog.skills, []);
});

test("最多返回 100 项，超出的目录不再读取", async () => {
  const repo = makeRepo();
  for (let index = 0; index < 101; index += 1) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    writeSkill(repo, ".agents/skills", name, name, `第 ${index} 个能力`);
  }
  commit(repo, "many skills");
  // 本用例验证的是 100 项截断,不是发现超时;全量套件并行负载下
  // 缺省 15s 预算会被无关用例的负载顶穿(负载型抖动),显式放宽。
  const catalog = await discoverRepositorySkills({
    repository: repo, timeoutMs: 120_000 });
  assert.equal(catalog.error, undefined);
  assert.equal(catalog.skills.length, 100);
  assert.equal(catalog.skills[0].name, "skill-000");
  assert.equal(catalog.skills.at(-1)?.name, "skill-099");
});

test("baseline 精确读取对应分支版本，不拿默认分支的新内容冒充", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".pi/skills", "release-guide", "release-guide",
    "稳定分支旧版说明");
  const stableRevision = commit(repo, "stable skill");
  git(repo, "branch", "stable");
  writeSkill(repo, ".pi/skills", "release-guide", "release-guide",
    "主分支新版说明");
  const mainRevision = commit(repo, "main skill");

  const stable = await discoverRepositorySkills({
    repository: repo,
    baseline: "stable",
  });
  const main = await discoverRepositorySkills({
    repository: repo,
    baseline: "main",
  });
  assert.equal(stable.revision, stableRevision);
  assert.equal(main.revision, mainRevision);
  assert.equal(stable.skills[0].description, "稳定分支旧版说明");
  assert.equal(main.skills[0].description, "主分支新版说明");
  assert.notEqual(stable.skills[0].id, main.skills[0].id);
});

test("克隆失败也清理临时目录，错误不泄露成未处理异常", async () => {
  const prefix = "mae-flow-repository-skills-";
  const before = new Set(readdirSync(tmpdir()).filter((name) =>
    name.startsWith(prefix)));
  const missing = join(tmpdir(), `missing-repo-${Date.now()}-${Math.random()}`);
  const catalog = await discoverRepositorySkills({
    repository: missing,
    timeoutMs: 5_000,
  });
  assert.match(catalog.error ?? "", /不可访问/);
  assert.deepEqual(catalog.skills, []);
  const after = new Set(readdirSync(tmpdir()).filter((name) =>
    name.startsWith(prefix)));
  // 断言"没有新增残留"而不是 after==before:before 里可能有上轮强杀
  // 留下的孤儿目录,它们不归本测试管,拿等式比会被环境残留误伤。
  const leaked = [...after].filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], "克隆失败的临时目录必须清干净");
});

test("仓库技能目录发现过滤平台屏蔽项", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".cac/skills", "department", "department", "部门规则");
  writeSkill(repo, ".agents/skills", "business", "business", "业务知识");
  commit(repo, "skills");
  const catalog = await discoverRepositorySkills({ repository: repo, baseline: "main", blockedPaths: [".cac"] });
  assert.equal(catalog.error, undefined);
  assert.deepEqual(catalog.skills.map(skill => skill.name), ["business"]);
});

test("屏蔽详情读取真实 Git 原文，但不进入可选 Skill 清单", async () => {
  const repo = makeRepo();
  writeSkill(repo, ".cac/skills", "department", "department", "部门规则原文");
  writeFileSync(join(repo, "AGENTS.md"), "# 被屏蔽的仓库指令\n");
  commit(repo, "blocked resources");
  const result = await discoverRepositorySkills({ repository: repo, baseline: "main", blockedPaths: [".cac", "AGENTS.md"], previewBlocked: true });
  assert.equal(result.error, undefined);
  assert.equal(result.skills.length, 0);
  assert.equal(result.blocked_resources?.files.length, 2);
  assert.match(result.blocked_resources!.files.find(file => file.path === "AGENTS.md")!.content!, /被屏蔽的仓库指令/);
  assert.deepEqual(result.blocked_resources!.files.find(file => file.path === "AGENTS.md")!.rules, ["AGENTS.md"]);
});
