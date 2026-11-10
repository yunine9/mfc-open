/**
 * 服务端 PlantUML 出图的契约。真件优先:本机有 Java 就真渲;没有就显式
 * skip 并明说(静默跳过等于假装测过)。没有 Java 时仍能验的两条不 skip:
 * 出不了图必须给原因、不许抛;空源码不起进程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findJava, renderPlantUml, PLANTUML_JAR } from "../src/plantumlRender.ts";
import { existsSync } from "node:fs";

const java = findJava();
const SKIP = java ? false : "本机没有 Java(生产宿主有):真渲染用例跳过,只验 fail-open";

test("空源码与缺失运行库:直接给原因,不起进程、不抛", async () => {
  assert.deepEqual(await renderPlantUml("   "), { error: "没有 PlantUML 源码" });
  const missing = await renderPlantUml("A -> B", { jar: "/nonexistent/plantuml.jar" });
  assert.match(missing.error ?? "", /运行库缺失/);
  assert.ok(existsSync(PLANTUML_JAR), "vendor 里的 jar 必须随仓库在");
});

test("没有 Java 时 fail-open:返回原因,页面显示源码", { skip: java ? "本机有 Java,此用例不适用" : false }, async () => {
  const result = await renderPlantUml("A -> B");
  assert.equal(result.svg, undefined);
  assert.match(result.error ?? "", /没有 Java/);
});

test("真渲染:组件图含中文出 SVG;第二次命中缓存", { skip: SKIP }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mfc-puml-"));
  const source = [
    "@startuml", 'package "notify-service" {', "  [MessageAssembler]", "  [Notification]", "}",
    "[notify-web] --> [Notification] : 解析 tenantId", "@enduml",
  ].join("\n");
  const first = await renderPlantUml(source, { cacheDir });
  assert.equal(first.error, undefined, first.error);
  assert.match(first.svg ?? "", /^<(\?xml|svg)/);
  assert.match(first.svg ?? "", /tenantId/);
  assert.equal(first.syntax_error, undefined);
  const second = await renderPlantUml(source, { cacheDir });
  assert.equal(second.cached, true);
  assert.equal(readdirSync(cacheDir).length, 1);
});

test("真渲染:语法错误照样给图(标出错行)并标 syntax_error", { skip: SKIP }, async () => {
  const result = await renderPlantUml("@startuml\n[Notification] : 六字段含 tenantId\n@enduml");
  assert.equal(result.syntax_error, true);
  assert.match(result.svg ?? "", /^<(\?xml|svg)/);
});

test("真渲染:预算到期终止,不无限等", { skip: SKIP }, async () => {
  const result = await renderPlantUml("A -> B", { timeoutMs: 1 });
  assert.match(result.error ?? "", /超过 .* 秒/);
});

test("真渲染:错误图二次缓存命中仍保留 syntax_error，状态与 SVG 保存在同一份完整缓存", { skip: SKIP }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mfc-puml-invalid-cache-"));
  try {
    const source = "@startuml\n[Notification] : 六字段含 tenantId\n@enduml";
    const first = await renderPlantUml(source, { cacheDir, sandbox: true });
    assert.equal(first.error, undefined, first.error); assert.equal(first.syntax_error, true);
    const second = await renderPlantUml(source, { cacheDir, sandbox: true });
    assert.equal(second.error, undefined, second.error); assert.equal(second.cached, true);
    assert.equal(second.syntax_error, true); assert.equal(second.svg, first.svg);
    const files = readdirSync(cacheDir);
    assert.equal(files.length, 1); assert.match(files[0], /\.json$/);
    const cached = JSON.parse(readFileSync(join(cacheDir, files[0]), "utf8"));
    assert.equal(cached.version, 1); assert.equal(cached.syntax_error, true); assert.equal(cached.svg, first.svg);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test("真渲染:缓存损坏或缺少明确错误状态时重新检查，错误图不能因缺字段变成成功", { skip: SKIP }, async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mfc-puml-damaged-cache-"));
  try {
    const source = "@startuml\n[Notification] : 六字段含 tenantId\n@enduml";
    const first = await renderPlantUml(source, { cacheDir, sandbox: true });
    assert.equal(first.error, undefined, first.error); assert.equal(first.syntax_error, true);
    const files = readdirSync(cacheDir); assert.equal(files.length, 1);
    const cachePath = join(cacheDir, files[0]);
    const brokenRecords = [
      '{"version":1,"svg":',
      JSON.stringify({ version: 1, svg: first.svg }),
      JSON.stringify({ version: 1, svg: first.svg, syntax_error: "false" }),
    ];
    for (const broken of brokenRecords) {
      writeFileSync(cachePath, broken);
      const retried = await renderPlantUml(source, { cacheDir, sandbox: true });
      assert.equal(retried.error, undefined, retried.error);
      assert.notEqual(retried.cached, true, "不完整状态不得被当成已验证缓存");
      assert.equal(retried.syntax_error, true, "重新渲染仍应识别真实语法错误");
      const restored = JSON.parse(readFileSync(cachePath, "utf8"));
      assert.equal(restored.version, 1); assert.equal(restored.syntax_error, true);
      assert.deepEqual(readdirSync(cacheDir), files, "原子替换后不遗留临时缓存文件");
    }
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});

test("预先取消时直接拒绝，不进入运行库查找或产生渲染缓存", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "mfc-puml-aborted-"));
  try {
    const controller = new AbortController(), reason = new Error("任务已取消");
    controller.abort(reason);
    await assert.rejects(renderPlantUml("@startuml\nA -> B\n@enduml", {
      signal: controller.signal, cacheDir, jar: "/nonexistent/plantuml.jar",
    }), error => error === reason);
    assert.deepEqual(readdirSync(cacheDir), []);
  } finally { rmSync(cacheDir, { recursive: true, force: true }); }
});
