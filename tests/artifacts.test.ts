/**
 * 检视产物语义(只读旁路):工作区文件 → 可在决策处直接看的材料。
 *
 * 钉五件事:
 * - 列表按最近修改倒序(客观信号排序,不猜"哪步该看哪份");
 * - 未提交改动是虚拟产物:已暂存/未暂存/未跟踪都要在快照里;
 * - 白名单是唯一边界:集合外的 name 与 `../` 穿越一律不认;
 * - 超过 512 KB 只回传前 512 KB 并如实标注截断;
 * - fail-open:坏目录、空现场、非 git 仓都只让那一项缺席,不抛错。
 *
 * 不依赖 docker / PostgreSQL / 真模型——纯文件与本地 git。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { readJson } from "../src/jsonBody.ts";
import {
  mkdirSync,
  rmSync,
  mkdtempSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  bundleArtifactDocuments,
  compareDeliveryRevisions,
  deliveryChangeSnapshot,
  DIFF_NAME,
  PIPELINE_EVIDENCE_GAP_ARTIFACT,
  listArtifacts,
  listArtifactsAsync,
  listArtifactChangeDirectoryAsync,
  readArtifact,
  readArtifactAsync,
  readArtifactFileDiffAsync,
  resolveArtifactRoot,
  type ArtifactMeta,
} from "../src/artifacts.ts";
import { ScriptedModelServer, type Scene } from "../src/scriptedModel.ts";
import { TaskService } from "../src/taskService.ts";
import { createTaskServer } from "../src/server.ts";

/** 造一个假工作区:<cwd>/.mae-flow-work/<单号>/*.md,可选 git 仓。 */
function makeSite(options: {
  docs?: Record<string, string>;
  /** 干扰目录(role-tasks 这类基础设施,不该被当成检视材料)。 */
  noise?: Record<string, string>;
  git?: boolean;
} = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), "mfc-artifacts-"));
  const ticket = join(cwd, ".mae-flow-work", "REQ2026081405");
  mkdirSync(ticket, { recursive: true });
  writeFileSync(join(ticket, ".ticket-id"), "REQ2026081405");
  let stamp = new Date("2026-08-15T10:00:00Z").getTime() / 1000;
  for (const [name, body] of Object.entries(options.docs ?? {})) {
    const path = join(ticket, name);
    writeFileSync(path, body);
    // 逐个拉开修改时间,好断言排序:后写的更新。
    stamp += 60;
    utimesSync(path, stamp, stamp);
  }
  for (const [name, body] of Object.entries(options.noise ?? {})) {
    const dir = join(cwd, ".mae-flow-work", "role-tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  if (options.git) {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
    run("init", "--quiet", "-b", "master");
    run("config", "user.email", "bot@test");
    run("config", "user.name", "bot");
    writeFileSync(join(cwd, "tracked.txt"), "第一版\n");
    run("add", ".");
    run("commit", "--quiet", "-m", "init");
  }
  return cwd;
}

const names = (items: ArtifactMeta[]) => items.map((item) => item.name);

function unzipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const method = zip.readUInt16LE(offset + 8);
    const packedSize = zip.readUInt32LE(offset + 18);
    const nameSize = zip.readUInt16LE(offset + 26);
    const extraSize = zip.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameSize + extraSize;
    const packed = zip.subarray(dataStart, dataStart + packedSize);
    entries.set(zip.subarray(nameStart, nameStart + nameSize).toString("utf-8"),
      method === 8 ? inflateRawSync(packed) : Buffer.from(packed));
    offset = dataStart + packedSize;
  }
  return entries;
}

test("列表按最近修改倒序;单号目录之外的噪声不混进来", () => {
  const cwd = makeSite({
    docs: {
      "survey.md": "# 现场勘察\n",
      "grill.md": "# 质询\n",
      "spec.md": "# 规格\n\n最后写的,应该排最前。\n",
    },
    noise: { "grill-critic-prep.md": "# 子 Agent 任务卡,不是检视材料\n" },
  });
  const items = listArtifacts(cwd);
  assert.deepEqual(names(items), [
    "REQ2026081405/spec.md",
    "REQ2026081405/grill.md",
    "REQ2026081405/survey.md",
  ]);
  assert.equal(items[0].label, "spec.md");
  assert.equal(items[0].kind, "doc");
  assert.ok(items[0].bytes > 0);
  assert.match(items[0].modified_at, /^\d{4}-\d{2}-\d{2}T/);

  const spec = readArtifact(cwd, "REQ2026081405/spec.md");
  assert.match(String(spec?.content), /最后写的/);
  assert.equal(spec?.truncated, false);
});

test("过程文档打包:保留单号目录层级并下载完整原文件,不混入虚拟 diff", () => {
  const large = `# 完整规格\n\n${"不能截断。".repeat(120_000)}`;
  const cwd = makeSite({
    docs: { "spec.md": large, "survey.md": "# 现场勘察\n" },
    git: true,
  });
  writeFileSync(join(cwd, "tracked.txt"), "形成虚拟 diff,但不能进文档包\n");

  const archive = bundleArtifactDocuments(cwd);
  assert.ok(archive);
  const entries = unzipEntries(archive.data);
  assert.deepEqual([...entries.keys()].sort(),
    ["REQ2026081405/spec.md", "REQ2026081405/survey.md"].sort());
  assert.equal(entries.get("REQ2026081405/spec.md")?.toString("utf-8"), large,
    "打包下载不能复用页面的 512 KB 截断稿");
  assert.equal(entries.has(DIFF_NAME), false);
});

test("未提交改动:已暂存/未暂存/未跟踪都在快照里", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" }, git: true });
  writeFileSync(join(cwd, "tracked.txt"), "第二版:未暂存改动\n");
  writeFileSync(join(cwd, "staged.txt"), "暂存的新文件\n");
  execFileSync("git", ["-C", cwd, "add", "staged.txt"]);
  writeFileSync(join(cwd, "untracked.txt"), "没跟踪的新文件\n");

  const items = listArtifacts(cwd);
  const diff = items.find((item) => item.name === DIFF_NAME);
  assert.ok(diff, `未提交改动没出现: ${names(items).join(" | ")}`);
  assert.equal(diff!.kind, "diff");
  assert.equal(diff!.label, "本任务变更");
  assert.equal(diff!.file_count, 3);
  assert.ok(diff!.bytes > 0);

  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.equal(snapshot?.branch,
    execFileSync("git", ["-C", cwd, "branch", "--show-current"],
      { encoding: "utf-8" }).trim());
  assert.match(String(snapshot?.content), /已暂存/);
  assert.match(String(snapshot?.content), /staged\.txt/);
  assert.match(String(snapshot?.content), /未暂存/);
  assert.match(String(snapshot?.content), /第二版/);
  assert.match(String(snapshot?.content), /未跟踪/);
  assert.match(String(snapshot?.content), /untracked\.txt/);
  assert.match(String(snapshot?.content), /没跟踪的新文件/);
});

test("异步工作台读侧与原有差异快照语义一致", async () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" }, git: true });
  writeFileSync(join(cwd, "tracked.txt"), "异步路径修改\n");
  writeFileSync(join(cwd, "untracked.txt"), "异步路径未跟踪\n");

  const items = await listArtifactsAsync(cwd);
  const diff = items.find((item) => item.name === DIFF_NAME);
  assert.ok(diff);
  assert.equal(diff.file_count, 2);
  assert.ok(items.some((item) => item.name.endsWith("/spec.md")));
  const documents = await listArtifactsAsync(cwd, {}, "doc");
  const changes = await listArtifactsAsync(cwd, {}, "diff");
  assert.deepEqual(documents, items.filter(item => item.kind === "doc"));
  assert.deepEqual(changes, items.filter(item => item.kind === "diff"));
  const snapshot = await readArtifactAsync(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /异步路径修改/);
  assert.match(String(snapshot?.content), /异步路径未跟踪/);
});

test("大量未跟踪编译产物按目录聚合并分页展开", async () => {
  const cwd = makeSite({ git: true });
  writeFileSync(join(cwd, "tracked.txt"), "只有这个已跟踪文件发生修改\n");
  for (let index = 0; index < 260; index += 1) {
    const directory = join(cwd, "target", "CMakeFiles", `module-${index}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "object.o"), `compiled-${index}\n`);
  }

  const items = await listArtifactsAsync(cwd);
  const diff = items.find((item) => item.name === DIFF_NAME);
  assert.deepEqual(diff?.change_files?.map((file) => file.path), [
    "tracked.txt",
  ], "编译目录不能展开成 260 条首屏清单");
  assert.equal(diff?.file_count, 1,
    "入口数字应表示逐文件展示的真实变更，不能冒充编译产物总数");
  assert.deepEqual(diff?.untracked_directories, [
    { path: "target", stage: "untracked" },
  ]);

  const target = await listArtifactChangeDirectoryAsync(cwd, "target");
  assert.equal(target?.total_files, 260);
  assert.deepEqual(target?.entries, [{
    path: "target/CMakeFiles",
    kind: "directory",
    file_count: 260,
    stage: "untracked",
  }]);

  const first = await listArtifactChangeDirectoryAsync(
    cwd, "target/CMakeFiles");
  assert.equal(first?.entries.length, 200);
  assert.equal(first?.total_entries, 260);
  assert.equal(first?.next_offset, 200);
  const second = await listArtifactChangeDirectoryAsync(
    cwd, "target/CMakeFiles", first?.next_offset);
  assert.equal(second?.entries.length, 60);
  assert.equal(second?.next_offset, undefined);

  const file = await readArtifactFileDiffAsync(
    cwd, "target/CMakeFiles/module-259/object.o");
  assert.match(String(file?.content), /compiled-259/,
    "目录未进入首屏清单也必须支持按文件安全读取");
  assert.equal(await listArtifactChangeDirectoryAsync(cwd, "../target"),
    undefined, "目录展开接口不能越出仓库");
});

test("大文件不会挤掉完整变更目录，后面的源码可按文件读取", async () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  mkdirSync(join(cwd, "docs"), { recursive: true });
  mkdirSync(join(cwd, "src"), { recursive: true });
  const original = Array.from({ length: 45_000 }, (_, index) =>
    `旧文档第 ${index} 行`).join("\n");
  writeFileSync(join(cwd, "docs", "01-大文档.md"), `${original}\n`);
  writeFileSync(join(cwd, "src", "z-last.ts"),
    "export const visibleAfterLargeDoc = false;\n");
  run("add", "docs/01-大文档.md", "src/z-last.ts");
  run("commit", "--quiet", "-m", "large fixture");

  const changed = Array.from({ length: 45_000 }, (_, index) =>
    `新文档第 ${index} 行`).join("\n");
  writeFileSync(join(cwd, "docs", "01-大文档.md"), `${changed}\n`);
  writeFileSync(join(cwd, "src", "z-last.ts"),
    "export const visibleAfterLargeDoc = true;\n");

  const items = await listArtifactsAsync(cwd);
  const meta = items.find((item) => item.name === DIFF_NAME);
  assert.deepEqual(meta?.change_files?.map((file) => file.path), [
    "docs/01-大文档.md",
    "src/z-last.ts",
  ]);
  assert.equal(meta?.file_count, 2);

  const oldAggregate = await readArtifactAsync(cwd, DIFF_NAME);
  assert.equal(oldAggregate?.truncated, true,
    "夹具必须真实打到旧聚合正文的 512 KB 上限");
  assert.doesNotMatch(String(oldAggregate?.content), /visibleAfterLargeDoc/,
    "证明旧实现下后面的源码确实会被大文档挤掉");

  const chinese = await readArtifactFileDiffAsync(cwd, "docs/01-大文档.md");
  assert.equal(chinese?.path, "docs/01-大文档.md");
  assert.match(String(chinese?.content),
    /diff --git a\/docs\/01-大文档\.md b\/docs\/01-大文档\.md/,
    "中文路径必须用真实 UTF-8 名字读取，不能保留 Git 八进制转义");
  const source = await readArtifactFileDiffAsync(cwd, "src/z-last.ts");
  assert.match(String(source?.content), /visibleAfterLargeDoc = true/);
  assert.equal(source?.path, "src/z-last.ts");
  assert.equal(await readArtifactFileDiffAsync(cwd, "../secret"), undefined,
    "清单外路径不能进入 Git 读取参数");
});

test("任务级流水线证据缺口无需代码现场也能在工作台列出并读取", async () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "mfc-pipeline-material-"));
  const pipelineRoot = join(taskRoot, "pipeline");
  mkdirSync(pipelineRoot);
  writeFileSync(join(pipelineRoot, "流水线证据缺口.md"),
    "# 流水线证据缺口\n\n请粘贴平台报错原文。\n");

  const items = await listArtifactsAsync(undefined, { pipelineRoot });
  assert.deepEqual(names(items), [PIPELINE_EVIDENCE_GAP_ARTIFACT]);
  assert.equal(items[0].purpose, "pipeline_evidence_gap");
  const artifact = await readArtifactAsync(
    undefined, PIPELINE_EVIDENCE_GAP_ARTIFACT, { pipelineRoot });
  assert.match(String(artifact?.content), /粘贴平台报错原文/);
});

test("任务级流水线材料不跟随越出白名单目录的符号链接", async () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "mfc-pipeline-boundary-"));
  const pipelineRoot = join(taskRoot, "pipeline");
  mkdirSync(pipelineRoot);
  const secret = join(taskRoot, "secret.md");
  writeFileSync(secret, "不能通过材料接口读取\n");
  symlinkSync(secret, join(pipelineRoot, "流水线证据缺口.md"));

  assert.deepEqual(await listArtifactsAsync(undefined, { pipelineRoot }), []);
  assert.equal(await readArtifactAsync(
    undefined, PIPELINE_EVIDENCE_GAP_ARTIFACT, { pipelineRoot }), undefined);
});

test("拆分子任务在排队时也能看到自己的任务书和整体方案", async () => {
  const taskMaterialRoot = mkdtempSync(join(tmpdir(), "mfc-unit-material-"));
  writeFileSync(join(taskMaterialRoot, "unit-brief.md"),
    "# 当前单元任务书\n\n只实现订单接口。\n");
  writeFileSync(join(taskMaterialRoot, "chain-plan.md"),
    "# 整体拆分方案\n\n接口先于页面。\n");

  const sources = { taskMaterialRoot };
  const items = await listArtifactsAsync(undefined, sources);
  assert.deepEqual(new Set(names(items)), new Set([
    "task-materials/unit-brief.md", "task-materials/chain-plan.md",
  ]));
  assert.equal(items.find((item) => item.purpose === "delivery_unit_brief")
    ?.label, "当前单元任务书");
  assert.match(String((await readArtifactAsync(undefined,
    "task-materials/unit-brief.md", sources))?.content), /只实现订单接口/);
  assert.match(String((await readArtifactAsync(undefined,
    "task-materials/chain-plan.md", sources))?.content), /接口先于页面/);
});

test("子任务材料只认固定文件且不跟随越界符号链接", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-unit-material-boundary-"));
  const taskMaterialRoot = join(root, "task");
  mkdirSync(taskMaterialRoot);
  const secret = join(root, "secret.md");
  writeFileSync(secret, "不能通过任务材料接口读取\n");
  symlinkSync(secret, join(taskMaterialRoot, "unit-brief.md"));
  writeFileSync(join(taskMaterialRoot, "unrelated.md"), "也不能读取\n");

  assert.deepEqual(await listArtifactsAsync(undefined, { taskMaterialRoot }), []);
  assert.equal(await readArtifactAsync(undefined,
    "task-materials/unit-brief.md", { taskMaterialRoot }), undefined);
});

test("Mae-Flow 流程状态不混入代码差异,普通未跟踪文件仍展示", () => {
  const cwd = makeSite({ git: true });
  writeFileSync(join(cwd, "feature.ts"), "export const ready = true;\n");
  writeFileSync(join(cwd, ".mae-flow.json"), "{\"current\":\"build\"}\n");
  writeFileSync(join(cwd, ".mae-flow.json.agent-writes"), "{}\n");
  writeFileSync(join(cwd, ".mae-flow-history.jsonl"), "{}\n");
  writeFileSync(join(cwd, ".mae-flow-need-reload"), "1\n");
  mkdirSync(join(cwd, ".mae-flow-work", "REQ1"), { recursive: true });
  writeFileSync(join(cwd, ".mae-flow-work", "REQ1", "story.md"), "过程件\n");
  mkdirSync(join(cwd, ".codecheckcli"), { recursive: true });
  writeFileSync(join(cwd, ".codecheckcli", "result.json"), "{}\n");

  const content = String(readArtifact(cwd, DIFF_NAME)?.content);
  assert.match(content, /feature\.ts/);
  assert.match(content, /ready = true/);
  assert.doesNotMatch(content, /\.mae-flow/);
  assert.doesNotMatch(content, /\.codecheckcli/);
});

test("误暂存的流程状态也不进入代码差异", () => {
  const cwd = makeSite({ git: true });
  writeFileSync(join(cwd, "business.txt"), "业务改动\n");
  writeFileSync(join(cwd, ".mae-flow.json.last"), "{\"current\":\"end\"}\n");
  execFileSync("git", ["-C", cwd, "add", "business.txt", ".mae-flow.json.last"]);

  const content = String(readArtifact(cwd, DIFF_NAME)?.content);
  assert.match(content, /business\.txt/);
  assert.doesNotMatch(content, /\.mae-flow\.json\.last/);
});

test("任务基线后的误提交流程状态也不进入代码差异", () => {
  const cwd = makeSite({ git: true });
  const baseline = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"],
    { encoding: "utf-8" }).trim();
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  writeFileSync(join(cwd, "delivered.ts"), "export const result = 1;\n");
  writeFileSync(join(cwd, ".mae-flow.json.last"), "{\"current\":\"end\"}\n");
  execFileSync("git", ["-C", cwd, "add", "delivered.ts", ".mae-flow.json.last"]);
  execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "task result"]);

  const content = String(readArtifact(cwd, DIFF_NAME)?.content);
  assert.match(content, /已提交\(committed\)/);
  assert.match(content, /delivered\.ts/);
  assert.doesNotMatch(content, /\.mae-flow\.json\.last/);
});

test("变更快照包含完整文件上下文,前端才能默认折叠后按需展开", () => {
  const cwd = makeSite({ git: true });
  const original = Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 行`);
  writeFileSync(join(cwd, "full.txt"), `${original.join("\n")}\n`);
  execFileSync("git", ["-C", cwd, "add", "full.txt"]);
  execFileSync("git", ["-C", cwd, "commit", "--quiet", "-m", "add full"]);
  original[14] = "第 15 行（已修改）";
  writeFileSync(join(cwd, "full.txt"), `${original.join("\n")}\n`);

  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /第 1 行/);
  assert.match(String(snapshot?.content), /第 15 行（已修改）/);
  assert.match(String(snapshot?.content), /第 30 行/);
});

test("任务基线到当前工作区:提交后的文件不消失,再次修改会标明来源", () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  const baseline = run("rev-parse", "HEAD").trim();
  writeFileSync(join(cwd, ".git", "info", "exclude"), ".mae-flow.json\n");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    config: { "基线分支": "master" },
    step_heads: { branch_create: baseline },
  }));

  writeFileSync(join(cwd, "committed.txt"), "已经提交的任务代码\n");
  writeFileSync(join(cwd, "tracked.txt"), "任务提交版本\n");
  run("add", "committed.txt", "tracked.txt");
  run("commit", "--quiet", "-m", "task changes");
  writeFileSync(join(cwd, "tracked.txt"), "提交后又修改\n");

  const snapshot = readArtifact(cwd, DIFF_NAME);
  const content = String(snapshot?.content);
  assert.match(content, /## 已提交\(committed\)/);
  assert.match(content, /committed\.txt/);
  assert.match(content, /已经提交的任务代码/);
  assert.match(content, /## 已提交后又修改\(committed-working\)/);
  assert.match(content, /提交后又修改/);
});

test("交付文件快照区分工作区可见项与 HEAD 真正会推送的文件", async () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  const baseline = run("rev-parse", "HEAD").trim();
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "feature.ts"), "export const ready = true;\n");
  run("add", "src/feature.ts");
  run("commit", "--quiet", "-m", "feature");
  mkdirSync(join(cwd, "target", "classes"), { recursive: true });
  writeFileSync(join(cwd, "target", "classes", "Feature.class"), "bytecode");

  const snapshot = await deliveryChangeSnapshot(cwd);
  assert.deepEqual(snapshot?.committed_paths, ["src/feature.ts"]);
  assert.deepEqual(snapshot?.workspace_paths,
    ["src/feature.ts", "target/classes/Feature.class"]);
  assert.equal(snapshot?.baseline, baseline);
  assert.equal(snapshot?.head, run("rev-parse", "HEAD").trim());
});

test("缺少 gitignore 的依赖安装不膨胀交付事实，显式跟踪文件仍保留", async () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  const put = (path: string) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), "content\n");
  };
  const tracked = "website/node_modules/vendor/maintained.js";
  put(tracked);
  run("add", tracked);
  run("commit", "--quiet", "-m", "baseline vendor");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: run("rev-parse", "HEAD").trim() },
  }));
  writeFileSync(join(cwd, tracked), "changed\n");
  for (let index = 0; index < 12000; index++) {
    put(`website/node_modules/package/long-dependency-filename-${index}.js`);
  }
  for (const path of ["node_modules/root.js", "website/.venv/lib/a.py",
    "website/__pycache__/a.pyc", "website/.pytest_cache/cache",
    "website/src/new.ts", "build/script.ts", "dist/source.ts", "target/config.xml",
    "website/node_modules/vendor/explicit.js"]) put(path);
  const explicit = "website/node_modules/vendor/explicit.js";
  run("add", explicit);
  const raw = run("status", "--porcelain", "--untracked-files=all");
  assert.ok(Buffer.byteLength(raw) > 512 * 1024, "复现旧路径超过内核事实限制");
  const snapshot = await deliveryChangeSnapshot(cwd);
  assert.ok(snapshot);
  const expected = ["build/script.ts", "dist/source.ts", "target/config.xml",
    explicit, tracked, "website/src/new.ts"].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(snapshot.workspace_paths, expected);
  const excluded = snapshot.workspace_paths.filter((path) => path !== explicit);
  assert.ok(Buffer.byteLength(JSON.stringify({ paths: [explicit], excluded_paths: excluded })) < 4096);
  run("commit", "--quiet", "-m", "explicit vendor");
  assert.deepEqual((await deliveryChangeSnapshot(cwd))?.committed_paths, [explicit]);
});

test("文件清单直接包含重命名和未跟踪文件的行数，无需逐个打开正文", async (t) => {
  const cwd = makeSite({ git: true });
  t.after(() => rmSync(cwd,{recursive:true,force:true}));
  const run = (...args:string[]) => execFileSync("git",["-C",cwd,...args],{encoding:"utf-8"}).trim();
  const lines = Array.from({length:30},(_,i)=>`const item${i} = ${i};`);
  writeFileSync(join(cwd,"old.ts"),lines.join("\n")+"\n");
  run("add","old.ts");run("commit","-qm","baseline");
  writeFileSync(join(cwd,".mae-flow.json"),JSON.stringify({step_heads:{branch_create:run("rev-parse","HEAD")}}));
  const renamed = '新文件 "renamed".ts';run("mv","old.ts",renamed);
  lines[10]="const item10 = -1;";writeFileSync(join(cwd,renamed),lines.join("\n")+"\n");
  run("commit","-qam","rename and edit");
  writeFileSync(join(cwd,"new.ts"),"one\ntwo\nthree");
  mkdirSync(join(cwd,"new-folder"));
  writeFileSync(join(cwd,"new-folder","other.ts"),"one\ntwo\n");
  writeFileSync(join(cwd,"binary.bin"),Buffer.from([0,1,2,3]));
  const manifest=(await listArtifactsAsync(cwd)).find(item=>item.kind==="diff")!.change_files!;
  const changed=manifest.find(file=>file.path===renamed)!;
  assert.equal(changed.additions,1);assert.equal(changed.deletions,1);
  assert.equal(manifest.find(file=>file.path==="new.ts")?.additions,3);
  assert.equal(manifest.find(file=>file.path==="binary.bin")?.stats_status,"binary");
  const page=await listArtifactChangeDirectoryAsync(cwd,"new-folder");
  assert.equal(page?.entries[0].additions,2);assert.equal(page?.entries[0].deletions,0);
});

test("比较范围导航不会复制大文件里未修改的全文", async (t) => {
  const cwd = makeSite({ git: true });
  t.after(() => rmSync(cwd, {recursive:true, force:true}));
  const run = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {encoding:"utf-8"}).trim();
  const lines = Array.from({length:10000}, (_,i) => `export const value${i} = ${i};`);
  writeFileSync(join(cwd,"large.ts"), lines.join("\n") + "\n");
  run("add","large.ts");run("commit","-qm","base");const base=run("rev-parse","HEAD");
  lines[5000] = "export const value5000 = -1;";
  writeFileSync(join(cwd,"large.ts"),lines.join("\n") + "\n");
  run("commit","-qam","one line change");const head=run("rev-parse","HEAD");
  const full = await compareDeliveryRevisions(cwd,base,head);
  const compact = await compareDeliveryRevisions(cwd,base,head,{compact:true});
  assert.ok(full && compact);
  assert.ok(full.content.length > 200000);
  assert.ok(compact.content.length < 1000);
  assert.deepEqual([compact.paths,compact.additions,compact.deletions], [full.paths,full.additions,full.deletions]);
});

test("提交比较只展示检视锚之后的修改，并把内容标成已提交", async () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
  const baseline = run("rev-parse", "HEAD");
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "feature.ts"), "export const value = 1;\n");
  run("add", "src/feature.ts");
  run("commit", "--quiet", "-m", "feat: initial delivery");
  const reviewed = run("rev-parse", "HEAD");
  writeFileSync(join(cwd, "src", "feature.ts"), "export const value = 2;\n");
  writeFileSync(join(cwd, "src", "repair.ts"), "export const repaired = true;\n");
  run("add", "src/feature.ts", "src/repair.ts");
  run("commit", "--quiet", "-m", "fix: address review");
  const head = run("rev-parse", "HEAD");

  const comparison = await compareDeliveryRevisions(cwd, reviewed, head);
  assert.ok(comparison);
  assert.equal(comparison?.from, reviewed);
  assert.equal(comparison?.to, head);
  assert.deepEqual(comparison?.paths, ["src/feature.ts", "src/repair.ts"]);
  assert.match(String(comparison?.content), /^## 已提交\(committed\)/);
  assert.match(String(comparison?.content), /export const value = 2/);
  assert.match(String(comparison?.content), /export const repaired = true/);
  assert.doesNotMatch(String(comparison?.content), /feat: initial delivery/);
  assert.deepEqual(comparison?.commits.map((item) => item.subject),
    ["fix: address review"]);
  const compact = await compareDeliveryRevisions(cwd, reviewed, head, { compact: true });
  assert.ok(compact);
  assert.deepEqual({paths:compact.paths,additions:compact.additions,deletions:compact.deletions,commits:compact.commits},
    {paths:comparison.paths,additions:comparison.additions,deletions:comparison.deletions,commits:comparison.commits},
    "首屏比较摘要不生成全文，仍保持相同文件清单、统计和提交记录");
  assert.equal(await compareDeliveryRevisions(cwd, head, reviewed), undefined,
    "反向或不构成祖先关系的锚不能参与比较");
  assert.equal(await compareDeliveryRevisions(cwd, "HEAD", head), undefined,
    "页面不能把任意 ref 送进 Git 命令");
});

test("Agent 平台注入目录不混入工作区检视，误提交后按完整历史拦截", async () => {
  const cwd = makeSite({ git: true });
  const run = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  mkdirSync(join(cwd, ".agents", "skills", "existing"), { recursive: true });
  writeFileSync(join(cwd, ".agents", "skills", "existing", "SKILL.md"),
    "仓库原本跟踪的 Skill\n");
  run("add", ".agents/skills/existing/SKILL.md");
  run("commit", "--quiet", "-m", "repository skill baseline");
  const baseline = run("rev-parse", "HEAD").trim();
  writeFileSync(join(cwd, ".mae-flow.json"), JSON.stringify({
    step_heads: { branch_create: baseline },
  }));

  mkdirSync(join(cwd, ".claude", "skills", "central"), { recursive: true });
  mkdirSync(join(cwd, ".cac", "skills", "central"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "central", "SKILL.md"),
    "CLAUDE_CENTER_ONLY\n");
  writeFileSync(join(cwd, ".cac", "skills", "central", "SKILL.md"),
    "CAC_CENTER_ONLY\n");
  writeFileSync(join(cwd, ".agents", "skills", "existing", "SKILL.md"),
    "仓库本来就跟踪，任务允许正常修改\n");

  const beforeCommit = await deliveryChangeSnapshot(cwd);
  assert.ok(beforeCommit?.workspace_paths.includes(
    ".agents/skills/existing/SKILL.md"));
  assert.equal(beforeCommit?.workspace_paths.some((path) =>
    path.startsWith(".claude/") || path.startsWith(".cac/")), false,
  "未跟踪的中心注入资产不应出现在检视/交付清单");
  assert.doesNotMatch(String(readArtifact(cwd, DIFF_NAME)?.content),
    /CLAUDE_CENTER_ONLY|CAC_CENTER_ONLY/);

  // -f 模拟 Agent 绕过本地 ignore；随后删除 .claude 再提交，验证最终
  // 树看不见它也不能绕过历史扫描。
  run("add", ".agents/skills/existing/SKILL.md");
  run("add", "-f", ".claude/skills/central/SKILL.md",
    ".cac/skills/central/SKILL.md");
  run("commit", "--quiet", "-m", "accidentally add injected skills");
  run("rm", "--quiet", ".claude/skills/central/SKILL.md");
  run("commit", "--quiet", "-m", "remove visible injected skill");

  const afterCommit = await deliveryChangeSnapshot(cwd);
  assert.deepEqual(afterCommit?.added_agent_platform_paths, [
    ".cac/skills/central/SKILL.md",
    ".claude/skills/central/SKILL.md",
  ]);
  assert.ok(afterCommit?.committed_paths.includes(
    ".agents/skills/existing/SKILL.md"),
  "基线已经跟踪的仓内 Skill 仍是正常业务增量");
  assert.equal(afterCommit?.added_agent_platform_paths.includes(
    ".agents/skills/existing/SKILL.md"), false,
  "不能把仓库原有 Skill 的修改误报成中心注入");
});

test("本任务没有代码变更时如实说明,而不是假装没这项", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" }, git: true });
  const snapshot = readArtifact(cwd, DIFF_NAME);
  assert.match(String(snapshot?.content), /本任务暂无代码变更/);
});

test("白名单是唯一边界:集合外的 name 与穿越一律不认", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" } });
  writeFileSync(join(cwd, "秘密.md"), "不该被读到\n");
  for (const bad of [
    "../秘密.md",
    "REQ2026081405/../../秘密.md",
    "/etc/passwd",
    "REQ2026081405/.ticket-id",
    "",
    "不存在.md",
  ]) {
    assert.equal(readArtifact(cwd, bad), undefined, `${bad} 竟然读到了`);
  }
});

test("超过 512 KB 只回传前 512 KB 并标注截断", () => {
  const cwd = makeSite({ docs: { "spec.md": "# 规格\n" } });
  const huge = join(cwd, ".mae-flow-work", "REQ2026081405", "huge.md");
  // 单字符 3 字节的中文:顺带验证按字节切不会留下半个字。
  writeFileSync(huge, "巨".repeat(300_000));
  const artifact = readArtifact(cwd, "REQ2026081405/huge.md");
  assert.equal(artifact?.truncated, true);
  assert.match(String(artifact?.content), /只回传前 512 KB/);
  assert.ok(!String(artifact?.content).includes("�"), "留下了半个字");
  assert.ok(
    Buffer.byteLength(String(artifact?.content), "utf-8")
      <= 512 * 1024 + 200,
    "截断后仍然超限",
  );
});

test("fail-open:空现场、非 git 仓、坏目录都不抛错", () => {
  const empty = mkdtempSync(join(tmpdir(), "mfc-artifacts-empty-"));
  assert.deepEqual(listArtifacts(empty), []);
  assert.equal(readArtifact(empty, "spec.md"), undefined);
  assert.deepEqual(listArtifacts("/不存在的目录/也不该炸"), []);
  assert.equal(readArtifact("/不存在的目录", DIFF_NAME), undefined);

  // 非 git 仓:文档照列,未提交改动这项缺席。
  const noGit = makeSite({ docs: { "spec.md": "# 规格\n" } });
  const items = listArtifacts(noGit);
  assert.deepEqual(names(items), ["REQ2026081405/spec.md"]);

  // 没有 .ticket-id 时退化为扫所有子目录,宁可多列也不空着。
  const loose = mkdtempSync(join(tmpdir(), "mfc-artifacts-loose-"));
  const dir = join(loose, ".mae-flow-work", "REQ9");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.md"), "# 无标记也要看得到\n");
  assert.deepEqual(names(listArtifacts(loose)), ["REQ9/spec.md"]);
});

test("现场定位:cwd 给了就用,没给就在工作区下找克隆目录", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-artifacts-ws-"));
  const clone = join(workspace, "origin");
  mkdirSync(join(clone, ".mae-flow-work", "REQ1"), { recursive: true });
  writeFileSync(join(clone, ".mae-flow-work", "REQ1", ".ticket-id"), "REQ1");
  writeFileSync(join(clone, ".mae-flow-work", "REQ1", "spec.md"), "# 规格\n");
  assert.equal(resolveArtifactRoot(workspace), clone);
  assert.equal(resolveArtifactRoot(workspace, clone), clone);
  assert.equal(
    resolveArtifactRoot(mkdtempSync(join(tmpdir(), "mfc-artifacts-none-"))),
    undefined,
  );
});

test("路由 GET /tasks/:id/artifacts[/:name]:能看任务就能看材料", async () => {
  const script: Scene[] = [{ text: "一步收工。" }];
  const model = new ScriptedModelServer(script);
  await model.start();
  const service = new TaskService({
    dataDir: mkdtempSync(join(tmpdir(), "mfc-artifacts-api-")),
    provider: "maeflow",
    model: "scripted-v1",
    modelsJson: model.modelsJson(),
  });
  const server = createTaskServer(service);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const created = await fetch(`${base}/tasks`, {
      method: "POST",
      body: JSON.stringify({ requirement: "演练:检视产物路由" }),
    }).then((response) => readJson(response));
    const confirmation = service.get(created.id)!.waiting!;
    const confirmationQuestion = (confirmation.question.questions as
      Array<{ question: string }>)[0].question;
    await service.decide(created.id, {
      waiting_id: confirmation.waiting_id,
      state_version: confirmation.state_version,
      selected_options: {
        [confirmationQuestion]: "需求已确认，进入需求分析",
      },
    });
    const deadline = Date.now() + 30_000;
    while (service.get(created.id)!.status !== "completed") {
      if (Date.now() > deadline) throw new Error("任务未收口");
      await new Promise((tick) => setTimeout(tick, 50));
    }

    // 演练模式没有内核现场:空列表而不是 500——流程没到 init 不是错误。
    const list = await fetch(`${base}/tasks/${created.id}/artifacts`);
    assert.equal(list.status, 200);
    assert.deepEqual(await readJson(list), []);
    const emptyArchive = await fetch(
      `${base}/tasks/${created.id}/artifacts/archive`);
    assert.equal(emptyArchive.status, 409);
    assert.deepEqual(await readJson(emptyArchive),
      { error: "暂无可打包的过程文档" });

    // 任务级补证材料不依赖代码现场，也必须先能列出来、读出来。
    const workspace = service.get(created.id)!.workspace;
    const pipeline = join(workspace, "pipeline");
    mkdirSync(pipeline, { recursive: true });
    writeFileSync(join(pipeline, "流水线证据缺口.md"),
      "# 流水线证据缺口\n\n粘贴真实报错。\n");
    const pipelineOnly = await fetch(`${base}/tasks/${created.id}/artifacts`)
      .then((response) => readJson(response)) as ArtifactMeta[];
    assert.deepEqual(names(pipelineOnly), [PIPELINE_EVIDENCE_GAP_ARTIFACT]);
    const pipelineRead = await fetch(`${base}/tasks/${created.id}/artifacts/${
      encodeURIComponent(PIPELINE_EVIDENCE_GAP_ARTIFACT)}`);
    assert.equal(pipelineRead.status, 200);
    assert.match(String((await readJson(pipelineRead)).content), /粘贴真实报错/);

    // 代码现场铺上过程文档后，两类材料在同一接口汇合。
    const ticket = join(workspace, "origin", ".mae-flow-work", "REQ7");
    mkdirSync(ticket, { recursive: true });
    writeFileSync(join(ticket, ".ticket-id"), "REQ7");
    writeFileSync(join(ticket, "spec.md"), "# 规格\n\n决策与证据同屏。\n");
    const repository = join(workspace, "origin");
    execFileSync("git", ["-C", repository, "init", "--quiet", "-b", "master"]);
    execFileSync("git", ["-C", repository, "config", "user.email", "bot@test"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "bot"]);
    writeFileSync(join(repository, "feature.ts"), "export const routeValue = 1;\n");
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "--quiet", "-m", "init"]);
    writeFileSync(join(repository, "feature.ts"), "export const routeValue = 2;\n");
    const listed = await fetch(`${base}/tasks/${created.id}/artifacts`)
      .then((response) => readJson(response)) as ArtifactMeta[];
    assert.deepEqual(new Set(names(listed)), new Set([
      "REQ7/spec.md", PIPELINE_EVIDENCE_GAP_ARTIFACT, DIFF_NAME,
    ]));
    for (const kind of ["doc", "diff"]) {
      const filtered = await fetch(`${base}/tasks/${created.id}/artifacts?kind=${kind}`)
        .then(response => readJson(response));
      assert.deepEqual(filtered, listed.filter(item => item.kind === kind));
    }
    const diffMeta = listed.find((item) => item.name === DIFF_NAME);
    assert.deepEqual(diffMeta?.change_files?.map((file) => file.path),
      ["feature.ts"]);
    const fileDiff = await fetch(`${base}/tasks/${created.id}/artifacts/file-diff?path=${
      encodeURIComponent("feature.ts")}`);
    assert.equal(fileDiff.status, 200);
    assert.match(String((await readJson(fileDiff)).content), /routeValue = 2/);
    const escapedDiff = await fetch(
      `${base}/tasks/${created.id}/artifacts/file-diff?path=${
        encodeURIComponent("../secret")}`);
    assert.equal(escapedDiff.status, 404);

    const archiveResponse = await fetch(
      `${base}/tasks/${created.id}/artifacts/archive`);
    assert.equal(archiveResponse.status, 200);
    assert.equal(archiveResponse.headers.get("content-type"), "application/zip");
    assert.match(String(archiveResponse.headers.get("content-disposition")),
      /filename\*=UTF-8''/);
    const archiveEntries = unzipEntries(
      Buffer.from(await archiveResponse.arrayBuffer()));
    assert.deepEqual(new Set(archiveEntries.keys()), new Set([
      "REQ7/spec.md", PIPELINE_EVIDENCE_GAP_ARTIFACT,
    ]));
    assert.match(String(archiveEntries.get("REQ7/spec.md")), /决策与证据同屏/);

    const encoded = encodeURIComponent("REQ7/spec.md");
    const read = await fetch(`${base}/tasks/${created.id}/artifacts/${encoded}`);
    assert.equal(read.status, 200);
    assert.match(String((await readJson(read)).content), /决策与证据同屏/);

    const missing = await fetch(
      `${base}/tasks/${created.id}/artifacts/${encodeURIComponent("没有这份.md")}`);
    assert.equal(missing.status, 404);
    const noTask = await fetch(`${base}/tasks/task-99/artifacts`);
    assert.equal(noTask.status, 404);
  } finally {
    server.close();
    await model.stop();
  }
});
