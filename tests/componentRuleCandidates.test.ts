import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { componentRuleFiles } from "../src/componentRuleCandidates.ts";
import { componentAstGrepBinary } from "../src/componentKnowledgeCheck.ts";
const candidates = [
  { language: "cpp", kind: "identifiers", value: "std::thread" },
  { language: "cpp", kind: "imports", value: "<thread>" },
  { language: "c", kind: "identifiers", value: "malloc" },
  { language: "java", kind: "identifiers", value: "Thread" },
  { language: "java", kind: "identifiers", value: "Executors.newFixedThreadPool" },
  { language: "java", kind: "imports", value: "java.util.concurrent.Executors" },
].map((p, i) => ({ ...p, id: String(i), component: "pool", paradigm_id: "submit", applicability: "仅已确认使用内部组件的业务模块" }));
test("规则派生区分 C/C++，未知语言明确标注，无候选不会伪造规则", () => {
  const files = componentRuleFiles(candidates);
  assert.equal(JSON.parse(files["derived/ast-grep/rules/component-2.yml"]).language, "C");
  assert.equal(JSON.parse(files["derived/ast-grep/rules/component-0.yml"]).language, "Cpp");
  for (const [path, value] of Object.entries(files)) if (path.includes("/rules/")) assert.equal(JSON.parse(value).severity, "warning");
  const unknown = componentRuleFiles([{ ...candidates[0], language: "rust" }]);
  assert.match(unknown["derived/rule-report.md"], /暂无/); assert.ok(!Object.keys(unknown).some(p => p.includes("/rules/")));
});
const executable = componentAstGrepBinary();
test("真实 ast-grep 校验派生规则正反例，新增 .c 文件能命中 malloc", () => {
  assert.ok(executable && existsSync(executable), "需要安装锁定的 ast-grep npm 依赖");
  const root = mkdtempSync(join(tmpdir(), "component-rules-"));
  try {
    for (const [path, content] of Object.entries(componentRuleFiles(candidates))) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); }
    execFileSync(executable!, ["test", "-c", "sgconfig.yml", "--skip-snapshot-tests"], { cwd: join(root, "derived/ast-grep"), encoding: "utf8" });
    const c = join(root, "new.c"); writeFileSync(c, "void* f() { return malloc(10); }\n");
    const output = execFileSync(executable!, ["scan", "-c", join(root, "derived/ast-grep/sgconfig.yml"), "--json=stream", c], { encoding: "utf8" });
    assert.match(output, /component-2/);
    writeFileSync(c, 'const char* text = "malloc(10)"; // malloc(10)\n');
    assert.equal(execFileSync(executable!, ["scan", "-c", join(root, "derived/ast-grep/sgconfig.yml"), "--json=stream", c], { encoding: "utf8" }).trim(), "");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
