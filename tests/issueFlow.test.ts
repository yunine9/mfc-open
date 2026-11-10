/**
 * 环境凭据保险箱的原子能力单测(src/issueEnvironment.ts)。
 *
 * 保险箱是需求/问题两个会话域共享的基建:任务侧已不存凭据(旧 DTS
 * triage 流已下线),问题流(src/issueFlow/)按 playbook 契约存
 * "单一共用密码"(三账号同密)。这里钉死:API 引用无密码、宿主可解密、
 * 落盘不是明文、清理干净。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { IssueEnvironmentVault } from "../src/issueEnvironment.ts";
import {
  discoverIssueSkillPackages,
  materializeIssueSkills,
  SKILL_SOURCE_DIR,
} from "../src/issueFlow/prompt.ts";
import { mfcTemp } from "./mfcTmp.ts";

test("B1验收2：问题流技能源目录保持标准形态，物化幂等且内容一致", () => {
  // vendor/mattpocock/ 下是原封照搬的外部技能(同步时整目录覆盖,不本地
  // 改),与平台自有技能同一张清单注册。
  const expected = [
    "code-review", "codebase-design", "fetch-logs",
    "grilling", "implement", "issue-analysis", "issue-delivery",
    "repo-docs", "tdd",
  ];
  const workspace = mfcTemp("mfc-issue-skills-");
  const first = materializeIssueSkills(workspace);
  assert.deepEqual(first.map((path) => path.split("/").at(-2)), expected,
    "平台技能与 vendor 技能必须齐装;少一个等于 Agent 少一条行为规矩");
  for (const path of first) {
    const body = readFileSync(path, "utf-8");
    assert.match(body, /^---\nname: [^\n]+\ndescription: [^\n]+\n/,
      "SKILL.md 必须带 name+description frontmatter(pi 靠它进系统提示词)");
    // 返回的是物化路径且必须落在工作区内:pi 把它原样写进系统提示的
    // 技能索引 location,沙箱只放行工作区内——源路径混进来(#359)
    // AI 一读就被拦。物化目的地恒 skills/<名>/,工作区一变即漂。
    const rel = relative(workspace, path);
    assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel),
      `物化返回路径必须落在工作区内: ${path}`);
  }
  const second = materializeIssueSkills(workspace);
  assert.deepEqual(first, second, "幂等重写:路径稳定,重复物化不漂移");
  // 源可带分类层(vendor/mattpocock/engineering/<名>/),按发现器拿
  // 真源路径逐个比对,不假设平铺;返回值已是物化路径,当不得源用。
  const sources = new Map(
    discoverIssueSkillPackages(SKILL_SOURCE_DIR).map((pkg) => [pkg.name, pkg.dir]));
  assert.equal(sources.size, first.length);
  for (const path of first) {
    const name = path.split("/").at(-2)!;
    assert.equal(
      readFileSync(join(workspace, "skills", name, "SKILL.md"), "utf-8"),
      readFileSync(join(sources.get(name)!, "SKILL.md"), "utf-8"),
      `${name} 物化内容必须与仓内源文件逐字节一致`);
  }
  assert.equal(readdirSync(join(workspace, "skills")).length, expected.length);
});

test("技能源目录分类层(2026-09-04):递归发现、物化平铺、重名 fail-loud", () => {
  const source = mfcTemp("mfc-issue-skills-src-");
  const workspace = mfcTemp("mfc-issue-skills-nest-");
  const write = (rel: string, name: string) => {
    const dir = join(source, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name}\n---\n`);
  };
  write("engineering/alpha", "alpha");
  write("beta", "beta");
  write("db/alpha", "alpha-dup");
  // 分类目录可以没有技能(empty 目录保留,不写 SKILL.md)。
  mkdirSync(join(source, "empty"), { recursive: true });

  // 整树零技能必须响(递归后一个包都没有)。
  assert.throws(
    () => materializeIssueSkills(mkdtempSync(join(tmpdir(), "mfc-x-")),
      join(source, "empty")),
    /未发现任何技能/);
  // 重名(不同分类里的同名目录)fail-loud——装载名必须全局唯一。
  assert.throws(() => materializeIssueSkills(workspace, source),
    /技能目录名重复: alpha/);
  rmSync(join(source, "db"), { recursive: true, force: true });

  const paths = materializeIssueSkills(workspace, source);
  assert.deepEqual(paths.map((path) => path.split("/").at(-2)),
    ["alpha", "beta"], "发现嵌套与顶层技能");
  // 目的地恒平铺:分类层只是源码组织,AI 看到的 skills/<名>/ 不变,
  // 技能正文里写死的 ./skills/<名>/ 引用(如 fetch-logs bin)不漂移。
  assert.equal(readdirSync(join(workspace, "skills")).sort().join(","),
    "alpha,beta");
  assert.ok(!existsSync(join(workspace, "skills", "engineering")),
    "分类层不进物化产物");
  const again = materializeIssueSkills(workspace, source);
  assert.deepEqual(paths, again, "幂等重写:路径稳定");
});

test("环境保险箱:API 引用无密码、宿主可解密、文件不是明文", () => {
  const dataDir = mfcTemp("mfc-issue-vault-");
  const vault = new IssueEnvironmentVault(dataDir);
  const refs = vault.store("issue-1", [{
    name: "灰度 A",
    purpose: "both",
    host: "192.0.2.8",
    port: 22,
    accounts: [
      { username: "operator", password: "shared-secret" },
      { username: "serviceaccount", password: "shared-secret" },
      { username: "administrator", password: "shared-secret" },
    ],
  }]);
  assert.equal(refs.length, 1);
  assert.deepEqual(refs[0].accounts.map((account) => account.username),
    ["operator", "serviceaccount", "administrator"]);
  assert.equal(refs[0].accounts.some((account) => "password" in account), false);
  assert.deepEqual(vault.credential("issue-1", refs[0].id, "operator"), {
    username: "operator",
    password: "shared-secret",
  });
  assert.equal(vault.credentials("issue-1", refs[0].id).length, 3);
  const ciphertext = readFileSync(
    join(dataDir, ".issue-environments", "issue-1.json"), "utf8");
  assert.doesNotMatch(ciphertext, /shared-secret|operator|10\.0\.0\.8/);
  vault.remove("issue-1");
  assert.equal(existsSync(join(dataDir, ".issue-environments", "issue-1.json")), false);
});

test("环境保险箱:混合用途(both)按 playbook 契约放行,任务号与问题号同区不碰撞", () => {
  const dataDir = mfcTemp("mfc-issue-vault-both-");
  const vault = new IssueEnvironmentVault(dataDir);
  const refs = vault.store("issue-2", [{
    name: "共用环境",
    purpose: "both",
    host: "192.0.2.16",
    accounts: [
      { username: "operator", password: "p" },
      { username: "serviceaccount", password: "p" },
      { username: "administrator", password: "p" },
    ],
  }]);
  assert.equal(refs[0].purpose, "both");
  assert.throws(() => vault.store("bad", []),
    /任务编号格式不合法/);
});
