/**
 * 五档宽度静态截图:把工作台夹具任务(.ui-fixtures)用真组件 SSR 成静态页,
 * 内联构建产物 CSS,用无头 Chrome 在 1440/1200/900/600/390 五档宽度截图;
 * 再用 --compare 逐像素比对两次截图。2026-09-06 为 CSS 分层立的裁判:改叠层
 * 不能靠眼睛扫,得有"改前改后哪张图变了、变了多少像素"。
 *
 * 用法:
 *   npx tsx scripts/visual-scenes.ts --out <目录> [--themes light,dark]
 *     [--widths 1440,1200,900,600,390] [--css web/dist/assets/index-*.css]
 *   npx tsx scripts/visual-scenes.ts --compare <目录A> <目录B>
 * 先 `cd web && npm run build`,截的是构建产物里的 CSS(和线上同一份)。
 * 边界:静态标记,没有 hover/弹层/滚动状态;字体退回系统字体(file:// 下
 * 取不到 woff2)——前后一致,比对仍成立。要登录态/点击交互的页面走查
 * (登录墙、页签切换、展开/弹层),用 scripts/ui-walkthrough.ts。
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.js";
import { createServer } from "../web/node_modules/vite/dist/node/index.js";
import {
  projectRepairStopped, projectStatusLabel, projectTaskFocus,
} from "../src/taskFocus.ts";
import type { DomainKnowledgeJob } from "../src/domainKnowledgeTypes.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";
import { componentGuideEvidence, componentGuideOverview, componentGuideSection } from "../tests/fixtures/componentGuide.ts";
import type { SkillSubmissionRecord } from "../src/hostSkillLibrary.ts";
import { componentDeletionView } from "../src/componentKnowledgeDeletion.ts";
import { build, stop } from "../web/node_modules/esbuild/lib/main.js";
import { knowledgeManualArchiveFixtures } from "../tests/fixtures/knowledgeManualArchiveFixture.ts";

/** 浏览器可执行文件:环境变量优先;缺省先找 playwright 缓存里的 Linux
 * 无头壳——WSL 上走 Windows Edge 互操作要跨 interop+9p,同页实测 8.7s
 * 起步(2026-09-18 任务里曾达 40-80s/张),Linux 原生 0.8-1.7s/张,默认
 * 原生。找不到再退回 macOS 老路径。要显式指到 Windows 浏览器仍走环境
 * 变量并以 .exe 结尾(自动切 Windows 路径转换),如 MFC_VISUAL_BROWSER=
 * "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"。 */
function defaultBrowser(): string {
  const cache = `${process.env.HOME ?? ""}/.cache/ms-playwright`;
  if (cache.startsWith("/") && existsSync(cache)) {
    const versions = readdirSync(cache)
      .filter((name) => /^chromium_headless_shell-\d+$/.test(name)).sort();
    const bin = versions.length
      ? join(cache, versions[versions.length - 1],
        "chrome-headless-shell-linux64", "chrome-headless-shell")
      : "";
    if (bin && existsSync(bin)) return bin;
  }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}
const CHROME = process.env.MFC_VISUAL_BROWSER ?? defaultBrowser();
/** Windows 浏览器(经 WSL 互操作调用)看不见 /home 路径:场景目录必须
 * 放在 /mnt/<盘> 下,且传给浏览器的路径/URL 要转成 Windows 形式。 */
const WIN_BROWSER = /\.exe$/i.test(CHROME);

function toBrowserPath(path: string): string {
  return WIN_BROWSER
    ? execFileSync("wslpath", ["-w", path], { encoding: "utf-8" }).trim()
    : path;
}

function toBrowserFileUrl(path: string): string {
  if (!WIN_BROWSER) return `file://${path}`;
  // C:\Users\...\a.html → file:///C:/Users/.../a.html
  return `file:///${toBrowserPath(path).replace(/\\/g, "/")}`;
}

// 时间冻结:页面上的"x 分钟前"随真实时钟走,前后两次截图隔了几分钟就会
// 在几百个像素上假报差异(首轮实测 111 张"差异"全是它)。SSR 是同步的,
// 换掉全局 Date 就够;截图里看到的相对时间因此永远是同一个。
const FROZEN_NOW = Date.parse("2026-09-06T12:00:00+08:00");
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args: ConstructorParameters<typeof RealDate>) {
    super(...(args.length ? args : [FROZEN_NOW] as unknown as ConstructorParameters<typeof RealDate>));
  }
  static now(): number { return FROZEN_NOW; }
} as DateConstructor;
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

function bundledCss(): string {
  const explicit = flag("--css");
  if (explicit) return readFileSync(explicit, "utf-8");
  const dir = resolve("web/dist/assets");
  const file = readdirSync(dir).find((name) => /^index-.*\.css$/.test(name));
  if (!file) throw new Error("web/dist 里没有 index-*.css,先 cd web && npm run build");
  return readFileSync(join(dir, file), "utf-8");
}

function loadFixtures(): Array<{ id: string; summary: Record<string, unknown> }> {
  const root = resolve(".ui-fixtures");
  return readdirSync(root).filter((name) => /^task-\d+$/.test(name))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
    .flatMap((name) => {
      const file = join(root, name, "task.json");
      if (!existsSync(file)) return [];
      const summary = JSON.parse(readFileSync(file, "utf-8")).summary;
      // 页面只认服务端投影字段:和 project() 一样现算。
      return [{ id: name, summary: {
        ...summary,
        focus: projectTaskFocus(summary),
        status_label: projectStatusLabel(summary),
        repair_stopped: projectRepairStopped(summary),
      } }];
    });
}

function page(theme: string, body: string, css: string): string {
  return `<!doctype html><html lang="zh-CN" data-theme="${theme}" data-density="comfortable">`
    + `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>${css}</style>`
    // 截图裁判要的是布局与颜色,不是动画的某一帧:脉冲圆点、过渡动画在两次
    // 截图里相位不同就会假报差异(冻结时间后仍剩 110 张 ≤150px 的"差异")。
    + `<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style>`
    + `</head><body><div id="root">${body}</div></body></html>`;
}

async function render(out: string): Promise<void> {
  const themes = (flag("--themes") ?? "light,dark").split(",");
  const backgroundOnly = args.includes("--only-production-background");
  const knowledgeOnly = args.includes("--only-knowledge") || backgroundOnly;
  const widths = (flag("--widths") ?? (knowledgeOnly ? "1920,1680,1600,1440,1366" : "1440,1200,900,600,390")).split(",").map(Number);
  const source = resolve(flag("--source-root") ?? ".");
  const { projectKnowledgeProduction }: typeof import("../src/knowledgeProductionState.ts") = await import(pathToFileURL(join(source, "src/knowledgeProductionState.ts")).href);
  const { domainKnowledgeTask }: typeof import("../src/knowledgeTaskCenter.ts") = await import(pathToFileURL(join(source, "src/knowledgeTaskCenter.ts")).href);
  const css = bundledCss();
  mkdirSync(out, { recursive: true });
  const vite = await createServer({
    root: join(source, "web"), server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
  });
  try {
    const { TaskWorkspace } = await vite.ssrLoadModule("/src/TaskWorkspace.tsx");
    const { TaskCard } = await vite.ssrLoadModule("/src/TaskCard.tsx");
    const noop = () => undefined;
    const scenes: Array<{ name: string; html: string }> = [];
    const failures: string[] = [];
    for (const fixture of knowledgeOnly ? [] : loadFixtures()) {
      const task = fixture.summary;
      const variants: Array<[string, () => React.ReactElement]> = [
        ["workspace", () => React.createElement(TaskWorkspace, {
          task, viewerUsername: "dev", viewerDisplayName: "开发者",
          canOverride: false, canOperate: true, canCollaborate: true,
          canRequestReview: true, onChanged: noop, onClose: noop,
        })],
        ["card", () => React.createElement("div", { style: { maxWidth: 1100, margin: "0 auto", padding: 24 } },
          React.createElement(TaskCard, { task, onChanged: noop, focused: true }))],
        ["row", () => React.createElement("div", { style: { maxWidth: 1100, margin: "0 auto", padding: 24 } },
          React.createElement(TaskCard, { task, onChanged: noop, compact: true, onOpenArtifacts: noop }))],
      ];
      for (const [variant, make] of variants) {
        let markup: string;
        try {
          markup = renderToStaticMarkup(make());
        } catch (error) {
          failures.push(`${fixture.id}/${variant}: ${String(error).split("\n")[0]}`);
          continue;
        }
        for (const theme of themes) {
          scenes.push({ name: `${fixture.id}-${variant}-${theme}`, html: page(theme, markup, css) });
        }
      }
    }
    // 生产线界面以前没有进入截图集，删入口与页面时仅对拍任务卡会漏验。
    if (knowledgeOnly) {
      const { KnowledgeLibrary } = await vite.ssrLoadModule("/src/KnowledgeLibrary.tsx");
      const { KnowledgeResearchCreate } = await vite.ssrLoadModule("/src/KnowledgeResearchCreate.tsx");
      const { KnowledgeAssetsWorkspace } = await vite.ssrLoadModule("/src/KnowledgeAssets.tsx");
      const { KnowledgeTaskCenter } = await vite.ssrLoadModule("/src/KnowledgeTaskCenter.tsx");
      const { DomainKnowledgePublicationStatus } = await vite.ssrLoadModule("/src/DomainKnowledgePublicationStatus.tsx");
      // 同一份原始事实在前后各经后端投影，不能用截图夹具掩盖状态误判。
      const manual = await knowledgeManualArchiveFixtures();
      const productionJobs = [manual.partial.job, manual.domainReady.job, manual.completed.job, manual.partial.job].map((record, index) => {
        const job = structuredClone(record);
        job.id = `dkx-visual-${index}`;
        job.title = ["单仓归档失败", "已发布待归档", "MR 已创建", "归档与研究均失败"][index];
        if (index === 3) { job.status = "failed"; job.error = "研究读取源码失败，请检查仓库连接后继续研究。"; }
        job.production = projectKnowledgeProduction({ kind: "domain", record: job });
        return job;
      });
      const productionRows = productionJobs.map(domainKnowledgeTask);
      const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
      Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "http://localhost/?kbPage=home", search: "?kbPage=home" } });
      try {
        const variants: Array<[string, () => React.ReactElement]> = [
          ["knowledge-home", () => React.createElement(KnowledgeLibrary, { onOpenTask: noop })],
          ...(["domain", "component", "skill-extraction"] as const).map(kind => [`knowledge-create-${kind}`, () => React.createElement(KnowledgeResearchCreate, { initialKind: kind, onBack: noop, onCreated: noop })] as [string, () => React.ReactElement]),
          ["knowledge-skills", () => React.createElement(KnowledgeAssetsWorkspace, { onOpenTask: noop })],
          ["knowledge-task-warning", () => React.createElement(KnowledgeTaskCenter, { onOpen: noop, onBack: noop, data: {
            tasks: [], summary: { running: 0, attention: 1, total: 0 },
            warnings: ["请检查损坏的知识记录：domain-extraction/dkx-00000000-0000-4000-8000-000000000001/job.json；其余任务照常可用"],
          } })],
          ["knowledge-task-status", () => React.createElement(KnowledgeTaskCenter, { onOpen: noop, onBack: noop, data: {
            tasks: productionRows, warnings: [], summary: { running: productionRows.filter(row => row.group === "running").length,
              attention: productionRows.filter(row => row.group === "attention").length, total: productionRows.length },
          } })],
          ["knowledge-archive-sync-failed", () => React.createElement("div", { style: { padding: 24 } }, React.createElement(DomainKnowledgePublicationStatus, {
            job: { ...productionJobs[0], production: (productionRows[0] as any).production }, onConfigure: noop,
          }))],
        ];
        for (const [name, make] of variants) {
          try {
            const markup = renderToStaticMarkup(make());
            for (const theme of themes) scenes.push({ name: `${name}-${theme}`, html: page(theme, markup, css) });
          } catch (error) { failures.push(`${name}: ${String(error).split("\n")[0]}`); }
        }
        if (args.includes("--production-detail") || backgroundOnly) {
          const bundle = await build({ entryPoints: [resolve("tests/browser/knowledgeProductionVisual.tsx")], bundle: true, write: false, format: "iife", jsx: "automatic", jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' },
            plugins: [{ name: "visual-source", setup(builder) { builder.onResolve({ filter: /^\.\.\/\.\.\/web\/src\/(KnowledgeSkillTask|ComponentKnowledgeDelete|ComponentResearch)$/ }, args => ({ path: join(source, `web/src/${args.path.split("/").at(-1)}.tsx`) })); } }] });
          stop();
          const content = "---\nname: file-guide\ndescription: 文件组件操作指南\n---\n\n# 文件组件\n\n读取指定文件，核对错误处理，再保存修订。";
          for (const status of ["pending", "approving", "approved", "rejected"] as const) {
            const record: SkillSubmissionRecord = { id: "visual-skill", directory: "file-guide", operator: "alice", created_at: "2026-09-06T01:00:00Z", status,
              skill_digest: "a".repeat(64), package_digest: "b".repeat(64), base_package_digest: null, files: 1, bytes: Buffer.byteLength(content), nature: "engineering", business_module_ids: [], technologies: ["cpp"], repositories: [],
              ...(status === "pending" ? {} : { decided_at: "2026-09-06T02:00:00Z", decided_by: "admin" }) };
            const fixture = { kind: "skill-submission", id: `${record.directory}/${record.id}`, response: { record, files: [{ path: "SKILL.md", bytes: record.bytes, content }], production: projectKnowledgeProduction({ kind: "skill-submission", record }) } };
            const json = JSON.stringify(fixture).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
            const markup = `<div id="visual-app" style="padding:24px"></div><script id="visual-fixture" type="application/json">${json}</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`;
            for (const theme of themes) scenes.push({ name: `knowledge-skill-${status}-${theme}`, html: page(theme, markup, css) });
          }
          const deletion = { ...componentDeletionView(out), documents: [{ id: "kd-deletion", title: "文件组件操作指南", revision: "v1", active: true,
            archive_target: { repository: "https://example.test/components.git", branch: "main", path: "docs/components/files.md" } }] };
          const json = JSON.stringify({ kind: "component-deletion", response: deletion }).replaceAll("<", "\\u003c");
          const markup = `<div id="visual-app"></div><script id="visual-fixture" type="application/json">${json}</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`;
          for (const theme of themes) scenes.push({ name: `knowledge-component-deletion-${theme}`, html: page(theme, markup, css) });
          const component = { id: "component-file", name: "文件组件", repository: "https://example.test/file.git", branch: "main", path: "src", languages: ["cpp"], description: "文件句柄与异步回调", enabled: true };
          const componentRecord: ResearchRecord = { id: "cr-00000000-0000-4000-8000-000000000010", key: "visual-component", language: "cpp", topic: "文件组件使用指南", mode: "all", format: "joint-document", operator: "alice", created_at: "2026-09-06T01:00:00Z", status: "done", stage: "待审查", component, components: [component], revisions: { [component.id]: "a".repeat(40) }, evidence: componentGuideEvidence("cpp", [component.id]), document: {
            overview: componentGuideOverview("文件组件提供句柄管理与异步读取。调用方先停止回调，再释放句柄，所有等待都须有明确超时。"),
            sections: ["打开与关闭", "异步读取"].map((title, index) => ({
              ...componentGuideSection(`section-${index}`, [component.id], { title,
                content: index ? "取消读取后等待正在执行的回调结束；超时后报告失败。" : "打开失败时返回错误；关闭操作只执行一次，释放前确认读取已经结束。" }),
              selected: true, revision: 3,
            })),
          } };
          componentRecord.review_turns = componentRecord.document!.sections.map((section, index) => ({ id: `review-visual-${index}`, section_id: section.id, mode: "rework", message: "请明确关闭顺序与等待预算", operator: "alice", status: "done", created_at: componentRecord.created_at,
            proposal: { status: "pending", base_revision: section.revision, section: { ...section, content: `${section.content}\n\n最新修订：取消后最多等待 60 秒；用完预算如实记录失败并通知负责人。` } } }));
          const formalId = manual.componentReady.record.document_id!, formalRevision = manual.componentReady.record.published_revision!;
          for (const state of ["publish-ready", "published-no-git", "published-missing-archive"] as const) {
            const record = structuredClone(componentRecord), sourceFixture = state === "published-no-git" ? manual.unconfigured : manual.componentReady;
            const job = structuredClone(sourceFixture.job); job.component_research_id = record.id;
            if (state === "publish-ready") { delete job.documents[0].knowledge_document_id; delete job.documents[0].published_revision; delete job.documents[0].published_document_revision; }
            else { record.document_id = formalId; record.published_revision = formalRevision; record.stage = "已入库"; record.review_turns!.forEach(turn => { turn.proposal!.status = "accepted"; }); }
            record.production = projectKnowledgeProduction({ kind: "component", record, archive: job });
            job.production = projectKnowledgeProduction({ kind: "domain", record: job });
            const fixture = { kind: "component-research", id: record.id, interaction: state === "publish-ready" ? "publication-settings" : "archive-settings", response: record, archive_preview: sourceFixture.preview };
            const json = JSON.stringify(fixture).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
            const markup = `<div id="visual-app" style="height:100vh"></div><script id="visual-fixture" type="application/json">${json}</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`;
            for (const theme of themes) scenes.push({ name: `knowledge-background-component-${state}-${theme}`, html: page(theme, markup, css) });
          }
          const trackingJob = structuredClone(productionJobs[0]);
          trackingJob.title = "文件组件手动归档失败";
          trackingJob.production = projectKnowledgeProduction({ kind: "domain", record: trackingJob });
          const trackingRow = domainKnowledgeTask(trackingJob);
          const trackingVariants: Array<[string, React.ReactElement]> = [
            ["knowledge-background-tracking-failed-task", React.createElement(KnowledgeTaskCenter, { onOpen: noop, onBack: noop, data: { tasks: [trackingRow], warnings: [], summary: { running: Number(trackingRow.group === "running"), attention: Number(trackingRow.group === "attention"), total: 1 } } })],
            ["knowledge-background-tracking-failed-archive", React.createElement("div", { style: { padding: 24 } }, React.createElement(DomainKnowledgePublicationStatus, { job: trackingJob, onConfigure: noop }))],
          ];
          for (const [name, element] of trackingVariants) for (const theme of themes) scenes.push({ name: `${name}-${theme}`, html: page(theme, renderToStaticMarkup(element), css) });
        }
      } finally {
        if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
        else Reflect.deleteProperty(globalThis, "location");
      }
    }
    if (args.includes("--only-production-deletion")) scenes.splice(0, scenes.length, ...scenes.filter(scene => scene.name.startsWith("knowledge-component-deletion-")));
    if (backgroundOnly) scenes.splice(0, scenes.length, ...scenes.filter(scene => scene.name.startsWith("knowledge-background-")));
    for (const scene of scenes) writeFileSync(join(out, `${scene.name}.html`), scene.html);
    writeFileSync(join(out, "scenes.json"), JSON.stringify({ widths, scenes: scenes.map((s) => s.name), failures }, null, 2));
    console.log(`[visual] ${scenes.length} 个场景写入 ${out}${failures.length ? `;${failures.length} 个渲染失败` : ""}`);
    for (const failure of failures) console.log(`  ! ${failure}`);
    if (args.includes("--no-shoot")) return;
    await shoot(out, scenes.map((s) => s.name), widths);
  } finally {
    await vite.close();
  }
}

async function shoot(out: string, names: string[], widths: number[]): Promise<void> {
  if (WIN_BROWSER && !out.startsWith("/mnt/")) {
    throw new Error(`Windows 浏览器看不见 Linux 路径:${out}。`
      + "请把 --out 放到 /mnt/<盘> 下(如 /mnt/c/Users/<你>/AppData/Local/Temp/mfc-visual)");
  }
  const jobs = names.flatMap((name) => widths.map((width) => ({ name, width })));
  let next = 0; let done = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const png = join(out, `${job.name}@${job.width}.png`);
      await new Promise<void>((resolveJob) => {
        const child = spawn(CHROME, [
          "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
          "--force-device-scale-factor=1", `--window-size=${job.width},${args.includes("--only-knowledge") || args.includes("--only-production-background") ? Math.round(job.width * 9 / 16) : 1800}`,
          "--virtual-time-budget=1500", `--screenshot=${toBrowserPath(png)}`,
          toBrowserFileUrl(join(out, `${job.name}.html`)),
        ], { stdio: "ignore" });
        child.on("exit", () => resolveJob());
        child.on("error", () => resolveJob());
      });
      done += 1;
      if (done % 50 === 0) console.log(`[visual] 已截 ${done}/${jobs.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`[visual] 截图完成:${jobs.length} 张`);
}

/** 最小 PNG 解码:只认 Chromium 系截图的产出形态(8-bit RGB/RGBA,
 * 非隔行)。逐像素比对要同尺寸同布局的字节阵;原先转 BMP 用的是
 * macOS 独有的 sips,WSL/Linux 上没有——zlib 是 node 内置,直接解。 */
function decodePng(file: string): { width: number; height: number; bpp: number; bytes: Buffer } {
  const data = readFileSync(file);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!data.subarray(0, 8).equals(signature)) throw new Error(`不是 PNG: ${file}`);
  let at = 8;
  let width = 0; let height = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat: Buffer[] = [];
  while (at + 8 <= data.length) {
    const length = data.readUInt32BE(at);
    const type = data.toString("ascii", at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9]; interlace = body[12];
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`不支持的 PNG 形态(位深 ${bitDepth}, 隔行 ${interlace}): ${file}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}(只认 RGB/RGBA): ${file}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const bytes = Buffer.alloc(height * stride);
  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor++];
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const out = bytes.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[x - channels] : 0;
      const up = y > 0 ? bytes[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? bytes[(y - 1) * stride + x - channels] : 0;
      const value = line[x];
      out[x] = filter === 0 ? value
        : filter === 1 ? (value + left) & 0xff
        : filter === 2 ? (value + up) & 0xff
        : filter === 3 ? (value + ((left + up) >> 1)) & 0xff
        : (() => {
          const estimate = left + up - upLeft;
          const pa = Math.abs(estimate - left);
          const pb = Math.abs(estimate - up);
          const pc = Math.abs(estimate - upLeft);
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          return (value + predictor) & 0xff;
        })();
    }
  }
  return { width, height, bpp: channels, bytes };
}

function pixels(png: string): { width: number; height: number; bytes: Buffer; bpp: number } {
  return decodePng(png);
}

function compare(a: string, b: string): void {
  const names = readdirSync(a).filter((name) => name.endsWith(".png")).sort();
  const rows: Array<[string, number, string]> = [];
  for (const name of names) {
    const other = join(b, name);
    if (!existsSync(other)) { rows.push([name, -1, "B 里没有"]); continue; }
    const pa = pixels(join(a, name)); const pb = pixels(other);
    if (pa.width !== pb.width || pa.height !== pb.height || pa.bpp !== pb.bpp) {
      rows.push([name, -1, `尺寸不同 ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`]); continue;
    }
    let diff = 0;
    const stride = pa.bpp;
    for (let i = 0; i + stride <= pa.bytes.length; i += stride) {
      for (let k = 0; k < stride; k += 1) {
        if (pa.bytes[i + k] !== pb.bytes[i + k]) { diff += 1; break; }
      }
    }
    rows.push([name, diff, diff ? `${(diff * 100 / (pa.width * pa.height)).toFixed(3)}%` : "一致"]);
  }
  const changed = rows.filter(([, diff]) => diff !== 0);
  console.log(`[visual] 比对 ${rows.length} 张:${rows.length - changed.length} 张一致,${changed.length} 张有差异`);
  for (const [name, diff, note] of changed.sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(diff).padStart(8)} px  ${note.padStart(8)}  ${name}`);
  }
  process.exitCode = changed.length ? 1 : 0;
}

const compareA = flag("--compare");
if (compareA) {
  const compareB = args[args.indexOf("--compare") + 2];
  if (!compareB) throw new Error("--compare 需要两个目录");
  compare(resolve(compareA), resolve(compareB));
} else {
  const out = flag("--out");
  if (!out) throw new Error("需要 --out <目录>");
  await render(resolve(out));
}
