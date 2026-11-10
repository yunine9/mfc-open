import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { browserResultDump } from "./fixtures/browserResultDump.ts";
const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

for (const scenario of ["materials", "module"]) test(scenario === "module"
  ? "需求下单：知识跟随所属模块，恢复、切换、提交和清空保持一致"
  : "需求多资料桌面上传：全部预览、失败可见、补充与草稿保留、原件可下载", {
  skip: !existsSync(chrome) && "需要真实 Chrome；设置 MFC_TEST_CHROME 后运行",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-requirement-materials-browser-"));
  try {
    const built = await build({ entryPoints: [resolve("tests/browser/requirementMaterials.tsx")], bundle: true, write: false,
      format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"),
      define: { "process.env.NODE_ENV": '"production"' } });
    const css = readdirSync("web/dist/assets").filter(p => p.endsWith(".css")).map(p => readFileSync(join("web/dist/assets", p), "utf8")).join("\n");
    const html = join(dir, "check.html"), dump = join(dir, "result.html");
    writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>' + css + '</style><div id="app"></div><pre id="result"></pre><script>'
      + built.outputFiles[0].text.replaceAll("</script", "<\\/script") + "</script>");
    await browserResultDump(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions",
      `--user-data-dir=${join(dir, "profile")}`, "--window-size=1920,1080", "--virtual-time-budget=16000", "--dump-dom", `file://${html}?scenario=${scenario}`], dump);
    const result = readFileSync(dump, "utf8").match(/<pre id="result">([^<]+)<\/pre>/)?.[1];
    assert.ok(result, "桌面浏览器未完成验证");
    assert.deepEqual(JSON.parse(result), scenario === "module"
      ? { moduleFollowsSelection: true, restoredDraft: true, submittedScope: true, clearedScope: true, width: 1920 }
      : { multiUpload: true, retainedSupplement: true, failedFileVisible: true, completePreview: true, restoredDraft: true, sourceDownloads: true, failedResearchBlocked: true, uploadLifecycle: true, width: 1920 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
