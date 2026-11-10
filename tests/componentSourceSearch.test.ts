import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { codeSearchTool, languageComponentSourceTool } from "../src/componentResearchTools.ts";

test("Every Code 可注入执行器并保留独立参数和取消信号", async () => {
  const controller = new AbortController(), query = 'Close " ; $(echo injected)';
  const calls: Array<{ file: string; args: string[]; cwd?: string; signal?: AbortSignal }> = [];
  const tool = codeSearchTool(() => {}, { executor: async (file, args, cwd, signal) => {
    calls.push({ file, args, cwd, signal }); return "真实代码";
  } });
  const result = await tool.execute("test", { action: "kw", query }, controller.signal, undefined, {} as never);
  assert.ok(!(result as any).isError);
  assert.deepEqual(calls[0].args, ["kw", query]);
  assert.equal(calls[0].cwd, undefined); assert.equal(calls[0].signal, controller.signal);
  await tool.execute("read", { action: "read", repository: "repo", path: "code.cpp", start: 5, end: 9 }, controller.signal, undefined, {} as never);
  assert.deepEqual(calls[1].args, ["read", "repo", "code.cpp", "--start:=5", "--end:=9"]);
});

test("everycode 区分调用与测试检索，读取完整测试上下文并保留用途", async () => {
  const root = mkdtempSync(join(tmpdir(), "everycode-test-evidence-")), previous = process.env.MAE_FLOW_EC_BIN;
  const events: Array<Record<string, unknown>> = [];
  try {
    const binary = join(root, "ec");
    writeFileSync(binary, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === 'read') console.log('TEST(File, Close) { ASSERT_EQ(Close(handle), 0); }');\nelse console.log('consumer/tests/file_test.cpp');\n`, { mode: 0o700 });
    process.env.MAE_FLOW_EC_BIN = binary;
    const tool = codeSearchTool(event => events.push(event), { captureRead: true });
    const call = async (input: object): Promise<any> => tool.execute("test", input as never, undefined, undefined, {} as never);
    await call({ action: "kw", query: "Close lang:cpp" });
    await call({ action: "kw", query: "Close repo:consumer lang:cpp", purpose: "unit-test" });
    const result = await call({ action: "read", repository: "consumer", path: "tests/file_test.cpp", start: 1, end: 40, purpose: "unit-test" });
    assert.ok(!result.isError);
    assert.match(result.content.map(item => item.type === "text" ? item.text : "").join("\n"), /ASSERT_EQ/);
    assert.equal(events[0].purpose, "usage");
    assert.equal(events[1].purpose, "unit-test");
    assert.equal(events[2].purpose, "unit-test");
    assert.equal(events[2].path, "tests/file_test.cpp");
    assert.match(String(events[2].content), /ASSERT_EQ/);
    assert.equal((await call({ action: "kw", query: "Close", purpose: "other" })).isError, true);
  } finally {
    if (previous === undefined) delete process.env.MAE_FLOW_EC_BIN; else process.env.MAE_FLOW_EC_BIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("源码搜索支持多词任意命中、短语、大小写与逐仓范围", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-search-"));
  try {
    const sources = new Map<string, { root: string; revision: string }>();
    for (const id of ["repo-1", "repo-2"]) {
      const dir = join(root, id); mkdirSync(join(dir, "src"), { recursive: true });
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      git("init");
      writeFileSync(join(dir, "src/code.txt"), id === "repo-1" ? "CODC module\npci policy\nMRO feature\nfull phrase\n-e literal\n" : "SECOND_ONLY\n");
      writeFileSync(join(dir, "outside.txt"), "OUTSIDE_ONLY\n");
      git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
      sources.set(id, { root: dir, revision: git("rev-parse", "HEAD") });
    }
    const components = [...sources.keys()].map(id => ({ id, name: id, description: "fixture", repository: `https://example.test/${id}`, branch: "master", path: "src", languages: ["cpp"], enabled: true }));
    const tool = languageComponentSourceTool(components, async c => sources.get(c.id)!, () => {});
    const search = async (input: object) => {
      const result = await tool.execute("test", { action: "search", component_id: "repo-1", ...input }, undefined, undefined, {} as never);
      return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
    };
    const multiple = await search({ keywords: ["CODC", "PCI", "MRO"] });
    assert.match(multiple, /CODC module/); assert.match(multiple, /pci policy/); assert.match(multiple, /MRO feature/);
    assert.match(multiple, /repo-1.*example.test\/repo-1/); assert.match(multiple, /范围：src/); assert.match(multiple, /多关键词任意命中；忽略大小写/);
    assert.match(await search({ query: "CODC PCI MRO mro pci codc" }), /没有命中.*keywords/);
    assert.match(await search({ query: "full phrase" }), /full phrase/);
    assert.match(await search({ keywords: ["PCI"], ignore_case: false }), /没有命中/);
    assert.match(await search({ keywords: ["-e"] }), /-e literal/);
    assert.match(await search({ keywords: ["SECOND_ONLY"] }), /没有命中/);
    assert.match(await search({ component_id: "repo-2", keywords: ["SECOND_ONLY"] }), /SECOND_ONLY/);
    assert.match(await search({ keywords: ["OUTSIDE_ONLY"] }), /没有命中/);
    assert.match(await search({ query: "CODC", keywords: ["PCI"] }), /只能填写一个/);
    assert.match(await search({ keywords: [""] }), /非空字符串/);
    assert.match(await search({ keywords: ["CODC\nPCI"] }), /不能包含换行/);
    const read = async (path: string) => {
      const result = await tool.execute("read", { action: "read", component_id: "repo-1", path }, undefined, undefined, {} as never);
      return result.content.map(c => c.type === "text" ? c.text : "").join("\n");
    };
    assert.match(await read("src/missing.txt"), /文件不存在.*list/);
    assert.doesNotMatch(await read("src/missing.txt"), /凭据|网络/);
    assert.match(await read("src"), /路径是目录.*list/);
    assert.match(await read("src/code.txt"), /CODC module/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("源码目录默认显示业务层级，平台文件不挤占分页且可显式查看", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-tree-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    mkdirSync(join(root, ".cac/mae-flow"), { recursive: true }); mkdirSync(join(root, "src/deep"), { recursive: true });
    for (let i = 0; i < 110; i++) writeFileSync(join(root, `.cac/mae-flow/${i}.md`), "BUSINESS_TOKEN\n");
    writeFileSync(join(root, "src/deep/rule.ts"), "BUSINESS_TOKEN real implementation\n");
    git("init"); git("add", "."); git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture");
    const tool = languageComponentSourceTool([{ id: "one", name: "one", repository: "https://example.test/one", branch: "master", path: "", languages: ["ts"], enabled: true, description: "" }], async () => ({ root, revision: git("rev-parse", "HEAD") }), () => {});
    const invoke = async (input: object) => (await tool.execute("test", input as never, undefined, undefined, {} as never)).content.map(c => c.type === "text" ? c.text : "").join("\n");
    const list = await invoke({ action: "list" }); assert.match(list, /src\//); assert.doesNotMatch(list, /\.cac\//); assert.match(list, /排除平台及依赖文件 110/);
    assert.match(await invoke({ action: "list", path: "src/" }), /src\/deep\//);
    assert.match(await invoke({ action: "list", recursive: true }), /src\/deep\/rule.ts/);
    assert.match(await invoke({ action: "list", include_platform: true }), /\.cac\//);
    const search = await invoke({ action: "search", query: "BUSINESS_TOKEN" }); assert.match(search, /real implementation/); assert.doesNotMatch(search, /\.cac\//);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
