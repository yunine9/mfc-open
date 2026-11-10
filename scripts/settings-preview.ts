/**
 * 临时脚本:SSR 渲染个人设置页(人工介入程度按流剥离后的两节四档)
 * 并截图,给"剥离后啥样"一个直观答案。用法:
 *   MFC_VISUAL_BROWSER=<浏览器> npx tsx scripts/settings-preview.ts <输出目录>
 * 截 light/dark 两张;样式取 web/dist 构建产物(先 cd web && npm run build)。
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { PersonalSettingsPage } from "../web/src/App.tsx";

const CHROME = process.env.MFC_VISUAL_BROWSER
  ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIN_BROWSER = /\.exe$/i.test(CHROME);
const toBrowserPath = (path: string): string => WIN_BROWSER
  ? execFileSync("wslpath", ["-w", path], { encoding: "utf-8" }).trim() : path;
const toBrowserFileUrl = (path: string): string => WIN_BROWSER
  ? `file:///${toBrowserPath(path).replace(/\\/g, "/")}` : `file://${path}`;

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const out = resolve(process.argv[2] ?? ".settings-preview");
mkdirSync(out, { recursive: true });
const assets = resolve("web/dist/assets");
const css = readFileSync(join(assets,
  readdirSync(assets).find((name) => /^index-.*\.css$/.test(name))!), "utf-8");

// 两节各落一档,证明互不带动:需求侧"只问推送",问题侧"优先报告"。
const session = {
  username: "dev", role: "developer" as const,
  moonlight: true, push_confirmation: true,
  issue_intervention_tier: "2" as const,
};

const markup = renderToStaticMarkup(
  React.createElement(PersonalSettingsPage, {
    session,
    onSessionPatch: () => undefined,
    onTasksChanged: async () => undefined,
  }));

function page(theme: string, body: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" data-density="comfortable">`
    + `<head><meta charset="utf-8"><style>${css}</style>`
    + `<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>`
    + `</head><body style="background:var(--canvas)"><div id="root">${body}</div></body></html>`;
}

for (const theme of ["light", "dark"]) {
  const htmlFile = join(out, `settings-${theme}.html`);
  writeFileSync(htmlFile, page(theme, markup));
  const png = join(out, `settings-${theme}.png`);
  execFileSync("wslpath", ["-w", png]); // 预热 wslpath,报错提前
  await new Promise<void>((done) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--force-device-scale-factor=1", "--window-size=960,1180",
      "--virtual-time-budget=1200", `--screenshot=${toBrowserPath(png)}`,
      toBrowserFileUrl(htmlFile),
    ], { stdio: "ignore" });
    child.on("exit", () => done());
    child.on("error", () => done());
  });
  console.log(`[settings-preview] ${png}`);
}
