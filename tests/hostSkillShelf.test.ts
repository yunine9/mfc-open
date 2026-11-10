/**
 * 团队 Skill 货架契约(知识资产运营第一步,只读):
 * 货架回答"现在生效的是什么"——包括放坏了的。足迹(knowledge-insights
 * 的 resources)只看得见被任务带过的资源,一个 frontmatter 写坏的 skill
 * 在足迹里是隐形的,货架必须把它照出来并说明原因,否则"放了没生效"
 * 只能靠试跑撞见(autout 未被消费的教训)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHostSkillShelf } from "../src/hostSkillShelf.ts";
import { TaskService } from "../src/taskService.ts";

function skillDoc(name: string, description?: string): string {
  return [
    "---",
    `name: ${name}`,
    ...(description ? [`description: ${description}`] : []),
    "---",
    "",
    `# ${name} 正文`,
  ].join("\n");
}

test("货架照见全部 SKILL.md:可装载给身份指纹,坏的标出来并说明", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-shelf-"));
  const root = join(dataDir, "skills");
  mkdirSync(join(root, "java-autout"), { recursive: true });
  const goodDoc = skillDoc("java-autout", "Java 单测编写规范");
  writeFileSync(join(root, "java-autout", "SKILL.md"), goodDoc);
  // 坏件:缺 description,pi 装载器不认——货架必须照出来而不是漏掉。
  mkdirSync(join(root, "broken-skill"), { recursive: true });
  writeFileSync(join(root, "broken-skill", "SKILL.md"), skillDoc("broken-skill"));

  const shelf = listHostSkillShelf(dataDir);
  assert.equal(shelf.root_exists, true);
  assert.deepEqual(shelf.skills.map((skill) => skill.name),
    ["broken-skill", "java-autout"], "按名称排序,坏件也在架上");

  const good = shelf.skills.find((skill) => skill.name === "java-autout")!;
  assert.equal(good.loadable, true);
  assert.equal(good.description, "Java 单测编写规范");
  assert.equal(good.path, "java-autout/SKILL.md");
  assert.equal(good.digest,
    createHash("sha256").update(goodDoc).digest("hex"),
    "digest 是正文指纹——后续留痕/回退的版本锚");
  assert.ok(good.updated_at.endsWith("Z"));
  assert.ok(good.bytes > 0);

  const broken = shelf.skills.find((skill) => skill.name === "broken-skill")!;
  assert.equal(broken.loadable, false, "pi 装载器是装载性的唯一判据");
  assert.ok(shelf.warnings.some((warning) =>
    warning.includes("broken-skill/SKILL.md") && warning.includes("不可装载")),
  "坏件要有指向具体文件的警告,不能只标 flag");
});

test("货架随团队知识运营接口一起出——零足迹时资产也可见", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-shelf-svc-"));
  mkdirSync(join(dataDir, "skills", "java-autout"), { recursive: true });
  writeFileSync(join(dataDir, "skills", "java-autout", "SKILL.md"),
    skillDoc("java-autout", "Java 单测编写规范"));
  const service = new TaskService({
    dataDir, provider: "fixture", model: "fixture", modelsJson: {},
  });
  const insights = service.knowledgeInsights();
  assert.equal(insights.host_skills.root_exists, true);
  assert.deepEqual(insights.host_skills.skills.map((skill) => skill.name),
    ["java-autout"]);
});

test("skills 根缺席如实说,不伪造空货架;软链接跳过并留痕", () => {
  const missing = listHostSkillShelf(mkdtempSync(join(tmpdir(), "mfc-shelf-")));
  assert.equal(missing.root_exists, false);
  assert.deepEqual(missing.skills, []);

  const dataDir = mkdtempSync(join(tmpdir(), "mfc-shelf-link-"));
  const root = join(dataDir, "skills");
  mkdirSync(join(root, "real"), { recursive: true });
  writeFileSync(join(root, "real", "SKILL.md"), skillDoc("real", "真件"));
  // 软链接与快照器同纪律:不追出去,但要说明跳过了什么。
  const outside = mkdtempSync(join(tmpdir(), "mfc-shelf-outside-"));
  writeFileSync(join(outside, "SKILL.md"), skillDoc("escaped", "越界件"));
  try {
    symlinkSync(outside, join(root, "linked"));
  } catch {
    return; // 无软链接权限的环境(Windows 非管理员)显式放弃本段
  }
  const shelf = listHostSkillShelf(dataDir);
  assert.deepEqual(shelf.skills.map((skill) => skill.name), ["real"]);
  assert.ok(shelf.warnings.some((warning) => warning.includes("软链接")));
});
