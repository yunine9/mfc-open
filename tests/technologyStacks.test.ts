import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { createTechnologyStack, listTechnologyStacks, normalizeTechnologyStackIds, removeTechnologyStack, requireTechnologyStacks, updateTechnologyStack } from "../src/technologyStacks.ts";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function temporary() { return mkdtempSync(join(tmpdir(), "mfc-technology-stacks-")); }
function json(dir: string, path: string, value: unknown) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), JSON.stringify(value));
}

test("新部署技术栈目录为空，不注入固定清单；用户创建后可改名和停用且编号不变", () => {
  const dir = temporary();
  try {
    assert.deepEqual(listTechnologyStacks(dir), []);
    const java = createTechnologyStack(dir, { name: " Java " }, "dev");
    const chinese = createTechnologyStack(dir, { name: "自研框架" }, "dev");
    assert.deepEqual(java, { id: "java", name: "Java", enabled: true });
    assert.match(chinese.id, /^stack-[a-f0-9]{8}$/);
    const saved = updateTechnologyStack(dir, chinese.id, { name: "平台框架", enabled: false }, "maintainer");
    assert.deepEqual(saved, { id: chinese.id, name: "平台框架", enabled: false });
    assert.deepEqual(listTechnologyStacks(dir), [java, saved]);
    assert.deepEqual(requireTechnologyStacks(dir, [java.id]), [java.id]);
    assert.throws(() => requireTechnologyStacks(dir, [chinese.id]), /已停用/);
    assert.deepEqual(requireTechnologyStacks(dir, [chinese.id], { allowDisabled: true }), [chinese.id]);
    assert.throws(() => requireTechnologyStacks(dir, ["missing"]), /尚未登记/);
    const audit = readFileSync(join(dir, "technology-stack-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(audit.map((row) => row.action), ["initialize", "create", "create", "update"]);
    assert.equal(audit.at(-1).operator, "maintainer");
    assert.equal(audit.at(-1).previous.name, "自研框架");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("目录从实际组件仓、画像、知识和 Skill 标签初始化一次，保留来源和停用状态", () => {
  const dir = temporary();
  const document = "kd-00000000-0000-0000-0000-000000000001.json";
  const removed = "kd-00000000-0000-0000-0000-000000000002.json";
  try {
    json(dir, "component-repositories.json", [{ languages: ["c++", "agnostic", "untagged"] }]);
    json(dir, "repository-profiles/profiles.json", [{ technologies: ["java", "cpp"] }]);
    json(dir, "workflow-assets/local-flow/asset.json", { applicability: { technologies: ["dotnet"] } });
    json(dir, "workflow-assets/local-flow/draft.json", { definition: { applicability: { technologies: ["quarkus"] } } });
    json(dir, `knowledge-documents/${document}`, { technologies: ["react-native"], active: false });
    json(dir, `knowledge-documents/${removed}`, { technologies: ["removed-stack"] });
    json(dir, `knowledge-deletions/${removed}`, { id: removed.slice(0, -5) });
    mkdirSync(join(dir, "skills", "kotlin-guide"), { recursive: true });
    writeFileSync(join(dir, "skills", "kotlin-guide", "SKILL.md"), "---\nname: kotlin-guide\ndescription: Kotlin 实现\nknowledge_nature: engineering\ntechnologies: [kotlin]\n---\n说明\n");
    mkdirSync(join(dir, "skills", "legacy-guide"), { recursive: true });
    writeFileSync(join(dir, "skills", "legacy-guide", "SKILL.md"), "---\nname: legacy-guide\ndescription: TypeScript 实现\nlanguages: [ts]\n---\n说明\n");
    writeFileSync(join(dir, "skills", "root-guide.md"), "---\nname: root-guide\ndescription: Vue 开发\nknowledge_nature: engineering\ntechnologies: [vue]\n---\n说明\n");
    const source = readFileSync(join(dir, "component-repositories.json"), "utf8");
    assert.deepEqual(listTechnologyStacks(dir), [
      { id: "cpp", name: "C++", enabled: true },
      { id: "dotnet", name: "dotnet", enabled: true },
      { id: "java", name: "Java", enabled: true },
      { id: "kotlin", name: "Kotlin", enabled: true },
      { id: "quarkus", name: "quarkus", enabled: true },
      { id: "react-native", name: "react-native", enabled: true },
      { id: "typescript", name: "TypeScript", enabled: true },
      { id: "vue", name: "vue", enabled: true },
    ]);
    updateTechnologyStack(dir, "java", { enabled: false }, "dev");
    json(dir, "repository-profiles/profiles.json", [{ technologies: ["python"] }]);
    const after = listTechnologyStacks(dir);
    assert.equal(after.find((row) => row.id === "java")!.enabled, false);
    assert.equal(after.some((row) => row.id === "python"), false);
    assert.equal(readFileSync(join(dir, "component-repositories.json"), "utf8"), source);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("新增和编辑拒绝重复名称、保留词、无效名称和编号变更", () => {
  const dir = temporary();
  try {
    const row = createTechnologyStack(dir, { name: "JVM 应用", id: "jvm" }, "dev");
    const other = createTechnologyStack(dir, { name: "C++" }, "dev");
    assert.equal(other.id, "cpp");
    const javascript = createTechnologyStack(dir, { name: "JavaScript" }, "dev");
    const node = createTechnologyStack(dir, { name: "NodeJS" }, "dev");
    assert.notEqual(node.id, javascript.id, "不同技术栈名称不能被旧语言别名合并");
    assert.equal(listTechnologyStacks(dir).find(item => item.id === node.id)?.name, "NodeJS");
    assert.throws(() => createTechnologyStack(dir, { name: "jvm 应用" }, "dev"), /已存在/);
    assert.throws(() => createTechnologyStack(dir, { name: "重复编号", id: "jvm" }, "dev"), /已存在/);
    assert.throws(() => createTechnologyStack(dir, { name: "别名", id: "cxx" }, "dev"), /cpp/);
    for (const name of ["", " ", "x".repeat(81), "line\nbreak", "agnostic", "all", "untagged", "通用"]) {
      assert.throws(() => createTechnologyStack(dir, { name }, "dev"));
    }
    assert.throws(() => updateTechnologyStack(dir, row.id, { id: "other" }, "dev"), /不能修改/);
    assert.throws(() => updateTechnologyStack(dir, row.id, { enabled: "false" }, "dev"), /布尔值/);
    assert.throws(() => updateTechnologyStack(dir, row.id, { name: "c++" }, "dev"), /已存在/);
    assert.throws(() => updateTechnologyStack(dir, "missing", { name: "new" }, "dev"), /不存在/);
    assert.deepEqual(normalizeTechnologyStackIds(["JVM", "jvm", "react-native"]), ["jvm", "react-native"]);
    assert.deepEqual(normalizeTechnologyStackIds(["node"]), ["node"], "稳定编号归一化不使用语言别名");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("损坏的目录或迁移来源拒绝写入，不覆盖原始文件", () => {
  const dir = temporary();
  try {
    const file = join(dir, "technology-stacks.json");
    for (const content of ["broken", "{}", '[{"id":"java","name":"Java","enabled":"yes"}]', '[{"id":"java","name":"Java","enabled":true},{"id":"java","name":"Other","enabled":false}]']) {
      writeFileSync(file, content);
      assert.throws(() => listTechnologyStacks(dir), /损坏/);
      assert.throws(() => createTechnologyStack(dir, { name: "Rust" }, "dev"), /损坏/);
      assert.throws(() => updateTechnologyStack(dir, "java", { name: "JVM" }, "dev"), /损坏/);
      assert.equal(readFileSync(file, "utf8"), content);
    }
    rmSync(file);
    writeFileSync(join(dir, "component-repositories.json"), "broken");
    assert.throws(() => listTechnologyStacks(dir));
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(join(dir, "component-repositories.json"), "utf8"), "broken");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("关联清理完成后的目录移除可重复调用，空目录不再次导入旧标签", () => {
  const dir = temporary();
  try {
    json(dir, "repository-profiles/profiles.json", [{ technologies: ["java"] }]);
    assert.equal(listTechnologyStacks(dir)[0].id, "java");
    removeTechnologyStack(dir, "java", "dev");
    removeTechnologyStack(dir, "java", "dev");
    assert.deepEqual(listTechnologyStacks(dir), []);
    const operations = readFileSync(join(dir, "technology-stack-operations.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(operations.filter((row) => row.action === "delete").length, 1);
    assert.deepEqual(operations.at(-1).previous, { id: "java", name: "Java", enabled: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("技术栈 API 仅登录成员可维护，返回停用项且禁止改编号", async () => {
  const dir = temporary();
  const auth = new LocalAuth(join(dir, "auth.json"));
  auth.bootstrapAdmin("admin", "admin-password");
  auth.createUser("dev", "dev-password", "developer");
  const service = new TaskService({ dataDir: dir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0 });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/technology-stacks`)).status, 401);
    assert.equal((await fetch(`${base}/technology-stacks`, { method: "POST", body: JSON.stringify({ name: "Java" }) })).status, 401);
    assert.equal((await fetch(`${base}/technology-stacks/platform-stack`, { method: "DELETE" })).status, 401);
    const login = await fetch(`${base}/auth/login`, { method: "POST", body: JSON.stringify({ username: "dev", password: "dev-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const call = (method: string, path = "", body?: unknown) => fetch(`${base}/technology-stacks${path}`, { method, headers: { cookie }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.deepEqual(await (await call("GET")).json(), { stacks: [] });
    const created = await call("POST", "", { name: "平台框架", id: "platform-stack" });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), { stack: { id: "platform-stack", name: "平台框架", enabled: true } });
    const changed = await call("PUT", "/platform-stack", { name: "平台框架 v2", enabled: false });
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { stack: { id: "platform-stack", name: "平台框架 v2", enabled: false } });
    let extractionStarts = 0;
    service.startSkillExtraction = () => { extractionStarts += 1; throw new Error("不应启动提取"); };
    const extraction = await fetch(`${base}/knowledge/skill-extract`, { method: "POST", headers: { cookie },
      body: JSON.stringify({ repo: "https://code.example/team/app.git", intent: "提取平台方法", nature: "engineering", technologies: ["platform-stack"] }) });
    assert.equal(extraction.status, 400);
    assert.equal(extractionStarts, 0);
    assert.equal((await call("PUT", "/platform-stack", { id: "changed" })).status, 400);
    assert.deepEqual(await (await call("GET")).json(), { stacks: [{ id: "platform-stack", name: "平台框架 v2", enabled: false }] });
    mkdirSync(join(dir, "repository-profiles"), { recursive: true });
    writeFileSync(join(dir, "repository-profiles", "profiles.json"), "broken");
    const failedDelete = await call("DELETE", "/platform-stack");
    assert.equal(failedDelete.status, 400);
    assert.match(JSON.stringify(await failedDelete.json()), /清理未完成/);
    assert.equal(listTechnologyStacks(dir).length, 1);
    json(dir, "repository-profiles/profiles.json", []);
    assert.equal((await call("DELETE", "/platform-stack")).status, 200);
    assert.equal((await call("DELETE", "/platform-stack")).status, 200);
    assert.deepEqual(await (await call("GET")).json(), { stacks: [] });
    const audit = readFileSync(join(dir, "technology-stack-operations.jsonl"), "utf8");
    assert.match(audit, /"operator":"dev"/);
  } finally {
    await service.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
