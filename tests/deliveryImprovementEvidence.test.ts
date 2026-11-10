import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { improvementCodeTool, improvementEvidenceTool, redactAnalysisText } from "../src/deliveryImprovementEvidence.ts";
import type { DeliveryCodeMetric } from "../src/deliveryAnalyticsTypes.ts";

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "improvement-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  const commit = (text: string) => { git("add", "--all"); git("commit", "-m", text); return git("rev-parse", "HEAD"); };
  return { root, git, commit };
}
const data = async (tool: any, args: object) => JSON.parse((await tool.execute("call", args)).content[0].text);

test("证据读取：从日志开头分页、完整续读、关联任务及当前平台范围", async t => {
  const f = fixture(t), related = join(f.root, "related"), platform = join(f.root, "platform");
  mkdirSync(related); mkdirSync(platform); mkdirSync(join(platform, "src"));
  const text = "开头证据\n" + "正文与汉字\n".repeat(12000) + "末尾证据\n";
  writeFileSync(join(f.root, "events.jsonl"), text);
  writeFileSync(join(related, "notes.md"), "关联背景，不是本任务验证");
  writeFileSync(join(platform, "src", "sample.ts"), "export const version = 1;");
  writeFileSync(join(platform, "private.log"), "not platform source");
  for (const directory of ["web/src", "tests", "skills/example", "web/node_modules"]) mkdirSync(join(platform, directory), { recursive: true });
  writeFileSync(join(platform, "web/src/page.tsx"), "export const page = 'current frontend';");
  writeFileSync(join(platform, "tests/page.test.ts"), "test('page', () => {});");
  writeFileSync(join(platform, "skills/example/SKILL.md"), "current platform skill");
  writeFileSync(join(platform, "web/.env"), "PRIVATE_WEB_ENV");
  writeFileSync(join(platform, "web/node_modules/private.js"), "PRIVATE_DEPENDENCY");
  const tool = improvementEvidenceTool({ task: { root: f.root, description: "任务" }, related: { root: related, description: "关联" }, platform: { root: platform, description: "当前源码", sourceOnly: true } });
  let page = await data(tool, { action: "read", path: "events.jsonl" });
  assert.equal(page.offset, 0); assert.ok(page.text.startsWith("开头证据")); assert.ok(page.next_offset > 0); assert.doesNotMatch(page.text, /末尾证据/);
  let combined = page.text;
  while (page.next_offset !== null) { page = await data(tool, { action: "read", path: "events.jsonl", offset: page.next_offset }); combined += page.text; }
  assert.equal(combined, text); assert.doesNotMatch(combined, /�/);
  assert.equal((await data(tool, { action: "read", scope: "related", path: "notes.md" })).text, "关联背景，不是本任务验证");
  assert.match((await data(tool, { action: "read", scope: "platform", path: "src/sample.ts" })).text, /version/);
  for (const path of ["web/src/page.tsx", "tests/page.test.ts", "skills/example/SKILL.md"]) {
    assert.ok((await data(tool, { action: "read", scope: "platform", path })).text);
  }
  const frontend = await data(tool, { action: "search", scope: "platform", path: "web", query: "current frontend" });
  assert.equal(frontend.hits.length, 1);
  for (const path of ["private.log", "web/.env", "web/node_modules/private.js"]) await assert.rejects(tool.execute("call", { action: "read", scope: "platform", path }));
  const search = await data(tool, { action: "search", path: "", query: "末尾证据" });
  assert.match(search.limitation, /128KiB/); assert.match(search.limitation, /不证明/);
});

test("证据读取：越界、秘密目录、链接和脱敏", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "notes.md"), "password=abc123 api_key=key123 Bearer bearer123 https://user:pass@example.test/x");
  writeFileSync(join(f.root, ".env"), "hidden");
  mkdirSync(join(f.root, "agent")); writeFileSync(join(f.root, "agent", "models.json"), "hidden");
  symlinkSync(join(f.root, "notes.md"), join(f.root, "link.md"));
  const tool = improvementEvidenceTool({ task: { root: f.root, description: "任务" } });
  for (const path of ["../notes.md", "/etc/passwd", ".env", "agent/models.json", "link.md"]) await assert.rejects(tool.execute("x", { action: "read", path }));
  const listing = await data(tool, { action: "list" });
  assert.ok(!listing.items.some((item: any) => [".env", "agent", "link.md"].includes(item.name)));
  const page = await data(tool, { action: "read", path: "notes.md" });
  assert.doesNotMatch(page.text, /abc123|key123|bearer123|user:pass/); assert.match(page.text, /REDACTED/);
  const alias = join(f.root, "root-link"); symlinkSync(f.root, alias);
  await assert.rejects(improvementEvidenceTool({ task: { root: alias, description: "link" } }).execute("x", { action: "list" }));
  assert.doesNotMatch(redactAnalysisText('authorization: "token123"'), /token123/);
});

test("真实Git：逐提交diff与历史源码，不受工作树影响，拒绝范围外SHA和敏感路径", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "sample.ts"), "const result = 0;\n"); const base = f.commit("baseline");
  writeFileSync(join(f.root, "sample.ts"), "const result = 1;\n"); const first = f.commit("first");
  writeFileSync(join(f.root, "sample.ts"), "const result = 2;\n"); const head = f.commit("fix");
  const metric = { version: 1, base, first, head, commits: [{ sha: first }, { sha: head }] } as DeliveryCodeMetric;
  const tool = improvementCodeTool(f.root, metric);
  writeFileSync(join(f.root, "sample.ts"), "const result = 999;\n");
  assert.match((await data(tool, { action: "read", sha: first, path: "sample.ts" })).text, /result = 1/);
  const patch = await data(tool, { action: "diff", sha: head });
  assert.match(patch.text, /-const result = 1/); assert.match(patch.text, /\+const result = 2/); assert.doesNotMatch(patch.text, /999/);
  for (const args of [{ action: "read", sha: "f".repeat(40), path: "sample.ts" }, { action: "read", path: ".env" }, { action: "read", path: "../sample.ts" }, { action: "diff", sha: "HEAD" }]) await assert.rejects(tool.execute("x", args));
  await assert.rejects(improvementCodeTool(undefined, metric).execute("x", { action: "read", path: "sample.ts" }));
});

test("Git整体diff和无path搜索不能绕过敏感路径保护", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "sample.ts"), "const result = 0;\n"); const base = f.commit("baseline");
  writeFileSync(join(f.root, ".env"), "PRIVATE_SENTINEL_9b7c\n");
  writeFileSync(join(f.root, "sample.ts"), "const result = 1;\n"); const head = f.commit("implementation");
  const metric = { version: 1, base, first: head, head, commits: [{ sha: head }] } as DeliveryCodeMetric;
  const tool = improvementCodeTool(f.root, metric);
  for (const args of [{ action: "diff" }, { action: "diff", sha: head }, { action: "search", query: "PRIVATE_SENTINEL_9b7c" }]) {
    assert.doesNotMatch(JSON.stringify(await tool.execute("x", args)), /PRIVATE_SENTINEL_9b7c/);
  }
});

test("真实Git：合并提交展示相对第一父提交引入的变化，不能误报无变更", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "sample.ts"), "export const original = 0;\n");
  const base = f.commit("baseline");
  writeFileSync(join(f.root, "sample.ts"), "export const original = 1;\n");
  const first = f.commit("first implementation");
  f.git("checkout", "-b", "upstream");
  writeFileSync(join(f.root, "upstream.ts"), "export const upstreamRule = true;\n");
  const upstream = f.commit("upstream rule");
  f.git("checkout", "main");
  writeFileSync(join(f.root, "local.ts"), "export const localChange = true;\n");
  const local = f.commit("local followup");
  f.git("merge", "--no-ff", "upstream", "-m", "merge upstream branch");
  const head = f.git("rev-parse", "HEAD");
  const metric = { version: 1, base, first, head,
    commits: [{ sha: first }, { sha: upstream }, { sha: local }, { sha: head }] } as DeliveryCodeMetric;
  const patch = await data(improvementCodeTool(f.root, metric), { action: "diff", sha: head });
  assert.match(patch.text, /upstream\.ts/);
  assert.match(patch.text, /\+export const upstreamRule = true/);
  assert.doesNotMatch(patch.text, /无可读取/);
  assert.doesNotMatch(patch.text, /\+export const localChange/);
});

test("模型输入脱敏覆盖原文件带引号凭据及嵌套JSON工具原文", async t => {
  const f = fixture(t);
  const cases = ['password="FAKE_PASSWORD_SENTINEL"', JSON.stringify({ secret: "FAKE_SECRET_SENTINEL", password: "FAKE_PASSWORD_SENTINEL" }), JSON.stringify({ payload: { tool_result: JSON.stringify({ secret: "FAKE_SECRET_SENTINEL", apiKey: "FAKE_API_SENTINEL" }) } })];
  writeFileSync(join(f.root, "events.jsonl"), cases.join("\n"));
  const tool = improvementEvidenceTool({ task: { root: f.root, description: "任务" } });
  for (const args of [{ action: "read", path: "events.jsonl" }, { action: "search", query: "FAKE_" }]) {
    const result = await tool.execute("x", args);
    assert.doesNotMatch(JSON.stringify(result), /FAKE_(?:PASSWORD|SECRET|API)_SENTINEL/);
    assert.match(JSON.stringify(result), /REDACTED/);
  }
});

test("Git显式目录不能绕过敏感后代文件保护，代码原文也须脱敏", async t => {
  const f = fixture(t);
  mkdirSync(join(f.root, "config"));
  writeFileSync(join(f.root, "sample.ts"), "const value = 0;\n"); const base = f.commit("baseline");
  writeFileSync(join(f.root, ".env"), "FAKE_ROOT_ENV_SENTINEL\n");
  writeFileSync(join(f.root, "config", ".env.production"), "FAKE_CHILD_ENV_SENTINEL\n");
  writeFileSync(join(f.root, "config", "safe.ts"), 'const password = "FAKE_CODE_PASSWORD_SENTINEL";\n');
  const head = f.commit("implementation");
  const metric = { version: 1, base, first: head, head, commits: [{ sha: head }] } as DeliveryCodeMetric;
  const tool = improvementCodeTool(f.root, metric);
  for (const path of [".", "config"]) for (const args of [{ action: "diff", path }, { action: "diff", path, sha: head }, { action: "search", query: "FAKE_", path }]) {
    assert.doesNotMatch(JSON.stringify(await tool.execute("x", args)), /FAKE_(?:ROOT_ENV|CHILD_ENV|CODE_PASSWORD)_SENTINEL/);
  }
  assert.doesNotMatch(JSON.stringify(await tool.execute("x", { action: "read", path: "config/safe.ts" })), /FAKE_CODE_PASSWORD_SENTINEL/);
});

test("Git归档后按同SHA回读缓存，缺失版本或未缓存项诚实拒绝", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "sample.ts"), "const value = 0;\n"); const base = f.commit("baseline");
  writeFileSync(join(f.root, "sample.ts"), "const value = 1;\n"); const head = f.commit("implementation");
  const archive = join(f.root, "archive"), metric = { version: 1, base, first: head, head, commits: [{ sha: head }] } as DeliveryCodeMetric;
  const live = improvementCodeTool(f.root, metric, archive);
  const original = await data(live, { action: "read", sha: head, path: "sample.ts" });
  await live.execute("x", { action: "diff", sha: head });
  const archived = improvementCodeTool(undefined, metric, archive);
  assert.deepEqual(await data(archived, { action: "read", sha: head, path: "sample.ts" }), original);
  assert.match((await data(archived, { action: "diff", sha: head })).text, /value = 1/);
  await assert.rejects(archived.execute("x", { action: "read", sha: base, path: "sample.ts" }), /未保存|没有保存|回收/);
  await assert.rejects(archived.execute("x", { action: "read", sha: "f".repeat(40), path: "sample.ts" }), /交付范围/);
});
