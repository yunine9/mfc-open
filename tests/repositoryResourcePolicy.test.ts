import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeResourceBlocks, resourceBlocked, readResourceBlocks } from "../src/repositoryResourcePolicy.ts";
import { RuntimeSettings, SettingsError } from "../src/settings.ts";
import { skillSelectionLines } from "../src/issueFlow/prompt.ts";

test("按路径段匹配目录和文件，兼容大小写和 Windows 路径，不误伤近似名称", () => {
  const rules = normalizeResourceBlocks([".cac/", "AGENTS.md", ".agents/skills/bad"]);
  assert.equal(resourceBlocked("/repo/.cac/skills/foo/SKILL.md", rules), true);
  assert.equal(resourceBlocked("C:\\repo\\agents.MD", rules), true);
  assert.equal(resourceBlocked("/repo/.cac-other/SKILL.md", rules), false);
  assert.equal(resourceBlocked("/repo/AGENTS.md.backup", rules), false);
  assert.equal(resourceBlocked(".agents/skills/bad-2/SKILL.md", rules), false);
});

test("平台配置持久化、部分更新保留、清空恢复；非法配置不覆盖已有值", t => {
  const root = mkdtempSync(join(tmpdir(), "mfc-policy-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = new RuntimeSettings(root);
  settings.updateExecutionPolicy({ blocked_repository_resources: [".cac", "AGENTS.md"] });
  settings.updateExecutionPolicy({ team_instructions: "注意 UT" });
  assert.deepEqual(readResourceBlocks(root), [".cac", "AGENTS.md"]);
  assert.throws(() => settings.updateExecutionPolicy({ blocked_repository_resources: ["../secret"] }), SettingsError);
  assert.deepEqual(readResourceBlocks(root), [".cac", "AGENTS.md"]);
  settings.updateExecutionPolicy({ blocked_repository_resources: [] });
  assert.deepEqual(readResourceBlocks(root), []);
});

test("问题流历史必读列表也遵循新屏蔽设置", () => {
  const state = { stage: "analyze", skill_selection: { skills: [{ path: "repo/a/.cac/skills/bad/SKILL.md" }, { path: "repo/a/.agents/skills/good/SKILL.md" }] } } as any;
  const prompt = skillSelectionLines(state, [".cac"]).join("\n");
  assert.doesNotMatch(prompt, /bad/); assert.match(prompt, /good/);
});
