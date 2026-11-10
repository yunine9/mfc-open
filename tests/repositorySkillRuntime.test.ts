import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  materializeRepositorySkills,
  type SelectedRepositorySkill,
  validRepositorySkillPath,
} from "../src/repositorySkillRuntime.ts";
import { mfcTemp } from "./mfcTmp.ts";

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function fixture(): {
  root: string;
  workspace: string;
  snapshot: string;
  content: string;
  selected: SelectedRepositorySkill;
} {
  const root = mfcTemp("mfc-repo-skill-runtime-");
  const workspace = join(root, "repo");
  const directory = join(workspace, ".agents", "skills", "domain-api");
  mkdirSync(directory, { recursive: true });
  const content = "---\nname: domain-api\ndescription: API 约定\n---\n\n正文\n";
  writeFileSync(join(directory, "SKILL.md"), content);
  writeFileSync(join(directory, "reference.md"), "参考资料\n");
  return {
    root,
    workspace,
    snapshot: join(workspace, ".mae-flow-work", "repository-skills"),
    content,
    selected: {
      id: "skill-1",
      repository: "https://codehub/team/api.git",
      revision: "abc",
      name: "domain-api",
      description: "API 约定",
      relative_path: ".agents/skills/domain-api/SKILL.md",
      source: ".agents",
      digest: digest(content),
    },
  };
}

function commitRepository(workspace: string): void {
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "MFC Test"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "mfc@example.test"], {
    cwd: workspace,
  });
  execFileSync("git", ["add", "."], { cwd: workspace });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: workspace });
}

test("只物化用户选中的精确 Skill，并保留相对资源", () => {
  const item = fixture();
  const result = materializeRepositorySkills({
    selected: [item.selected],
    bindings: [{
      repository: item.selected.repository,
      workspace: item.workspace,
    }],
    snapshotRoot: item.snapshot,
  });
  assert.equal(result.paths.length, 1);
  assert.deepEqual(result.names, ["domain-api"]);
  assert.equal(readFileSync(result.paths[0], "utf-8"), item.content);
  assert.equal(readFileSync(join(result.paths[0], "..", "reference.md"), "utf-8"),
    "参考资料\n");
  assert.deepEqual(result.warnings, []);
});

test("显式空选不加载；字段缺席时只发现 Git 已跟踪的仓库原生 Skill", () => {
  const item = fixture();
  commitRepository(item.workspace);
  const binding = [{
    repository: item.selected.repository,
    workspace: item.workspace,
  }];
  assert.deepEqual(materializeRepositorySkills({
    selected: [], bindings: binding, snapshotRoot: item.snapshot,
  }).paths, []);
  const native = materializeRepositorySkills({
    selected: undefined,
    bindings: binding,
    snapshotRoot: join(item.workspace, ".mae-flow-work", "native-skills"),
  });
  assert.equal(native.paths.length, 1);
  assert.match(native.entries[0].skill.revision, /^[0-9a-f]{40}$/);
});

test(".cac/skills 与其他固定根使用同一 Git 原生物化语义", () => {
  const item = fixture();
  const cacDirectory = join(item.workspace, ".cac", "skills", "cac-domain");
  mkdirSync(cacDirectory, { recursive: true });
  const content = "---\nname: cac-domain\ndescription: CAC 领域约定\n---\n\n正文\n";
  writeFileSync(join(cacDirectory, "SKILL.md"), content);
  const selected: SelectedRepositorySkill = {
    ...item.selected,
    id: "cac-skill",
    name: "cac-domain",
    description: "CAC 领域约定",
    relative_path: ".cac/skills/cac-domain/SKILL.md",
    source: ".cac/skills",
    digest: digest(content),
  };
  commitRepository(item.workspace);
  const explicit = materializeRepositorySkills({
    selected: [selected],
    bindings: [{ repository: selected.repository, workspace: item.workspace }],
    snapshotRoot: join(item.workspace, ".mae-flow-work", "cac-selected"),
  });
  assert.deepEqual(explicit.names, ["cac-domain"]);
  assert.equal(readFileSync(explicit.paths[0], "utf-8"), content);

  const native = materializeRepositorySkills({
    selected: undefined,
    bindings: [{ repository: selected.repository, workspace: item.workspace }],
    snapshotRoot: join(item.workspace, ".mae-flow-work", "cac-native"),
  });
  assert.ok(native.names.includes("cac-domain"));
});

test("中心临时注入或被忽略的 Agent 目录不作为仓库原生知识", () => {
  const item = fixture();
  commitRepository(item.workspace);
  const injected = join(item.workspace, ".claude", "skills", "injected");
  mkdirSync(injected, { recursive: true });
  writeFileSync(join(injected, "SKILL.md"), [
    "---", "name: injected", "description: 中心临时注入", "---", "",
  ].join("\n"));
  writeFileSync(join(item.workspace, ".gitignore"), ".cac/\n");
  const ignored = join(item.workspace, ".cac", "skills", "ignored");
  mkdirSync(ignored, { recursive: true });
  writeFileSync(join(ignored, "SKILL.md"), [
    "---", "name: ignored", "description: 被忽略的注入", "---", "",
  ].join("\n"));

  const native = materializeRepositorySkills({
    selected: undefined,
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: join(item.workspace, ".mae-flow-work", "trusted-native"),
  });
  assert.deepEqual(native.names, ["domain-api"]);
});

test("快照冻结后源 Skill 改动不影响恢复会话", () => {
  const item = fixture();
  const options = {
    selected: [item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: item.snapshot,
  };
  const first = materializeRepositorySkills(options);
  writeFileSync(join(item.workspace, item.selected.relative_path), "已被修改\n");
  const resumed = materializeRepositorySkills(options);
  assert.equal(readFileSync(resumed.paths[0], "utf-8"), item.content);
  assert.equal(first.paths[0], resumed.paths[0]);
});

test("首次物化发现 SKILL.md 已偏离扫描 digest 时跳过，不把 B 冒充 A", () => {
  const item = fixture();
  writeFileSync(join(item.workspace, item.selected.relative_path),
    "---\nname: domain-api\ndescription: 已被替换\n---\n");
  const result = materializeRepositorySkills({
    selected: [item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: item.snapshot,
  });
  assert.deepEqual(result.paths, []);
  assert.match(result.warnings.join("\n"), /版本不一致，已跳过/);
});

test("恢复校验整个 Skill 包：相对资源被改后从仍匹配扫描版本的源重建", () => {
  const item = fixture();
  const options = {
    selected: [item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: item.snapshot,
  };
  const first = materializeRepositorySkills(options);
  const snapshotDirectory = dirname(first.paths[0]);
  const snapshotReference = join(snapshotDirectory, "reference.md");
  chmodSync(snapshotDirectory, 0o755);
  chmodSync(snapshotReference, 0o644);
  writeFileSync(snapshotReference, "被改过的参考资料\n");

  const resumed = materializeRepositorySkills(options);
  assert.equal(resumed.paths[0], first.paths[0]);
  assert.equal(readFileSync(join(dirname(resumed.paths[0]), "reference.md"), "utf-8"),
    "参考资料\n");
  assert.match(resumed.warnings.join("\n"), /快照整体校验失败/);
});

test("快照和扫描源都已变化时只跳过 Skill，任务不被可选能力卡死", () => {
  const item = fixture();
  const options = {
    selected: [item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: item.snapshot,
  };
  const first = materializeRepositorySkills(options);
  const snapshotDirectory = dirname(first.paths[0]);
  const snapshotReference = join(snapshotDirectory, "reference.md");
  chmodSync(snapshotDirectory, 0o755);
  chmodSync(snapshotReference, 0o644);
  writeFileSync(snapshotReference, "快照已变化\n");
  writeFileSync(join(item.workspace, item.selected.relative_path), "源也已变化\n");

  const resumed = materializeRepositorySkills(options);
  assert.deepEqual(resumed.paths, []);
  assert.match(resumed.warnings.join("\n"), /快照整体校验失败/);
  assert.match(resumed.warnings.join("\n"), /版本不一致，已跳过/);
});

test("软链接、越界路径、错误仓归属和常驻同名都不会交给 Pi", () => {
  const item = fixture();
  const outside = join(item.root, "secret.md");
  writeFileSync(outside, "secret\n");
  const linkedDir = join(item.workspace, ".pi", "skills", "linked");
  mkdirSync(linkedDir, { recursive: true });
  symlinkSync(outside, join(linkedDir, "SKILL.md"));
  const linked: SelectedRepositorySkill = {
    ...item.selected,
    id: "linked",
    name: "linked",
    relative_path: ".pi/skills/linked/SKILL.md",
  };
  const wrongRepo = { ...item.selected, id: "wrong", repository: "other" };
  const result = materializeRepositorySkills({
    selected: [linked, wrongRepo, item.selected],
    bindings: [{ repository: item.selected.repository, workspace: item.workspace }],
    snapshotRoot: item.snapshot,
    reservedNames: ["domain-api"],
  });
  assert.deepEqual(result.paths, []);
  assert.match(result.warnings.join("\n"), /软链接|不属于当前仓库|重名/);
  assert.equal(validRepositorySkillPath("../../secret/SKILL.md"), false);
  assert.equal(validRepositorySkillPath(".agents/skills/ok/SKILL.md"), true);
  assert.equal(validRepositorySkillPath(".cac/skills/ok/SKILL.md"), true);
  assert.equal(validRepositorySkillPath(".agents/skills/team/ok/SKILL.md"), false);
});


test("平台屏蔽优先于已选 Skill 和旧快照，解除屏蔽可恢复装配", () => {
  const item = fixture();
  const options = { selected: [item.selected], bindings: [{ repository: item.selected.repository, workspace: item.workspace }], snapshotRoot: item.snapshot };
  assert.equal(materializeRepositorySkills(options).paths.length, 1);
  assert.equal(materializeRepositorySkills({ ...options, blockedPaths: [".agents/skills/domain-api"] }).paths.length, 0);
  assert.equal(materializeRepositorySkills(options).paths.length, 1);
});
