import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { build } from "../web/node_modules/esbuild/lib/main.js";
import { knowledgeLibraryProductionFixtures } from "./fixtures/knowledgeLibraryProduction.ts";
import { projectKnowledgeProduction } from "../src/knowledgeProductionState.ts";
import type { ResearchRecord } from "../src/componentResearch.ts";

const chrome = process.env.MFC_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const pause = (ms = 120) => new Promise(r => setTimeout(r, ms));
async function until(check: () => Promise<boolean> | boolean) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(50); } throw new Error("浏览器未就绪"); }

test("萃取滚轮：内部区域可滚动，到边界后继续滚动外层，弹窗关闭不锁住页面", { skip: !existsSync(chrome), timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-wheel-"));
  const child = spawn(chrome, ["--headless=new", "--window-size=1920,1080", "--disable-gpu", "--no-first-run", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(root, "profile")}`], { stdio: "ignore" });
  let socket: WebSocket | undefined, nextId = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (reason: any) => void; timer: ReturnType<typeof setTimeout> }>();
  try {
    // 文件先建后写：8 路并发下读到空文件，端口是 undefined，WebSocket 报 Invalid URL（2026-10-08 实测）。
    const activePort = join(root, "profile", "DevToolsActivePort");
    await until(() => existsSync(activePort) && readFileSync(activePort, "utf8").trim().split("\n").length === 2);
    const [port, endpoint] = readFileSync(activePort, "utf8").trim().split("\n");
    socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
    await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
    socket.onmessage = message => { const data = JSON.parse(String(message.data)), entry = pending.get(data.id); if (entry) { clearTimeout(entry.timer); pending.delete(data.id); data.error ? entry.reject(data.error) : entry.resolve(data.result); } };
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
      const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const assets = resolve("web/dist/assets"), css = readdirSync(assets).filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8")).join("\n");
    for (const kind of ["domain", "component"]) {
      const fixture = kind === "domain" ? "knowledgeLibrary" : "componentResearchReview";
      const bundle = await build({ entryPoints: [resolve(`tests/browser/${fixture}.tsx`)], bundle: true, write: false, format: "iife", jsx: "automatic", loader: { ".css": "empty" }, jsxImportSource: resolve("web/node_modules/react"), define: { "process.env.NODE_ENV": '"production"' } });
      const html = join(root, `${kind}.html`);
      const domainFixture = kind === "domain" ? await knowledgeLibraryProductionFixtures() : undefined;
      const fixtureData = kind === "domain" ? `window.__KNOWLEDGE_LIBRARY_FIXTURES__=${JSON.stringify(domainFixture)};`
        : `window.__COMPONENT_REVIEW_PRODUCTIONS__=${JSON.stringify({ initial: projectKnowledgeProduction({ kind: "component", record: { id: "cr-browser", topic: "基础组件联合使用指南", status: "done", stage: "草稿待审查", language: "cpp", operator: "专家", created_at: "2026-09-21T08:00:00Z", evidence: [], review_turns: [], document: { overview: "组件使用指南", sections: Array.from({ length: 35 }, (_, i) => ({ id: `cap-${i}`, title: i === 0 ? "安全打开与关闭" : i === 1 ? "异步读取与取消" : i === 2 ? "批量写入与错误恢复" : `组件能力 ${i + 1}：资源管理与错误恢复`, revision: 1, selected: true })) } } as unknown as ResearchRecord }) })};`;
      writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>${css} #result {display:none} ${kind === "component" ? ".knowledge-extraction-content main { padding-bottom: 320px; }" : ""}</style><div style="padding:24px"><h1 style="height:52px">知识库</h1><div id="app"></div><footer style="height:200px">页面下方内容</footer></div><pre id="result"></pre><script>${fixtureData.replaceAll("</script", "<\\/script")}</script><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script>`);
      const { targetId } = await send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
      const evaluate = async (expression: string) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
      const click = async (label: string) => { assert.ok(await evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && b.getClientRects().length); if(!b)return false;b.click();return true;})()`), `missing ${label}`); await pause(); };
      const wheel = async (selector: string, deltaY: number) => {
        await pause(550); // End the previous native wheel gesture before checking a new boundary.
        // 落点裁到最近的滚动容器内:专注页里研究过程上方是固定的任务头,落在那里滚轮不会生效。
        const point = await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect(),p=e.closest('.knowledge-task-progress, .knowledge-extraction-content')?.getBoundingClientRect();const top=Math.max(r.top,p?.top??0,0),bottom=Math.min(r.bottom,p?.bottom??innerHeight,innerHeight);if(bottom-top<8)throw new Error('wheel target not visible');return {x:r.left+Math.min(r.width/2,250),y:top+Math.min(40,(bottom-top)/2)};})()`);
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
        // A short wheel burst also settles fractional scroll positions at the boundary.
        for (let step = 0; step < 2; step++) {
          await send("Input.synthesizeScrollGesture", { ...point, yDistance: -deltaY, gestureSourceType: "mouse", preventFling: true, speed: 1200 }, sessionId);
          await pause(280);
        }
      };
      // 领域任务按 #447 进入知识库的专注页(研究过程自己滚动);组件夹具仍是页面内的萃取工作区。
      const scroller = kind === "domain" ? ".knowledge-task-progress" : ".knowledge-extraction-content";
      const outerTop = () => evaluate(`document.querySelector(${JSON.stringify(scroller)}).scrollTop`);
      const url = kind === "domain" ? `?scrollCheck=1&kbPage=task&kbKind=domain&kbTask=${domainFixture!.running.id}` : "?scrollCheck=1&kbPage=task&kbKind=component&kbTask=cr-browser";
      for (const [width, height] of [[1920, 1080], [1366, 768]]) {
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await send("Page.navigate", { url: `${pathToFileURL(html)}${url}` }, sessionId);
        await until(async () => !!await evaluate(kind === "component" ? "!!document.querySelector('[aria-label=\"组件萃取文档\"]')" : "!!document.querySelector('[aria-label=\"研究过程记录\"] .knowledge-progress-entries')"));
        if (kind === "component") await click("审阅与修订");
        if (kind === "domain") {
          // #447 拍板打开任务即近乎全屏的专注阅读,平台导航退出主画面;
          // 取代旧口径"知识留在平台页面内(不得 fixed)"。
          const hub = await evaluate("(()=>{const h=document.querySelector('.knowledge-hub.is-focused');if(!h)return null;const r=h.getBoundingClientRect();return {position:getComputedStyle(h).position,left:r.left,top:r.top,width:r.width,height:r.height}})()");
          assert.ok(hub && hub.position === "fixed" && Math.abs(hub.left) <= 1 && Math.abs(hub.top) <= 1 && hub.width >= width - 2 && hub.height >= height - 2, `${width}: focused task covers the viewport ${JSON.stringify(hub)}`);
        }
        await pause();
        if (kind === "domain") {
          const list = ".knowledge-progress-entries > ol";

          await evaluate(`document.querySelector(${JSON.stringify(list)}).scrollIntoView({block:'center'})`);
          await wheel(list, 250);
          assert.ok(await outerTop() > 0, `${width}: timeline wheel scrolls the outer detail directly`);
          assert.equal(await evaluate(`document.querySelector(${JSON.stringify(list)}).scrollTop`), 0, "timeline has no nested scroll trap");
          const before = await outerTop(); await wheel(list, -250);
          assert.ok(await outerTop() < before, `${width}: timeline scrolls upward with outer detail`);
          // 新建任务已改为独立页面,任务页上留下的模态框是删除确认;打开再关闭后滚轮必须恢复。
          await evaluate("document.querySelector('[aria-label=\"更多萃取操作\"]').click()"); await pause(300);
          assert.ok(await evaluate("(()=>{const item=[...document.querySelectorAll('[role=menuitem]')].find(e=>e.textContent.trim()==='删除任务');if(!item)return false;item.click();return true;})()"), "missing 删除任务");
          await pause(300); assert.ok(await evaluate("!!document.querySelector('[role=dialog]')"), "deletion dialog opens");
          await evaluate("[...document.querySelectorAll('[role=dialog] details')].forEach(e=>e.open=true)"); await pause();
          const canScroll = await evaluate("(()=>{const e=document.querySelector('[role=dialog]');return e.scrollHeight>e.clientHeight})()");
          if (canScroll) { await wheel('[role="dialog"]', 250); assert.ok(await evaluate("document.querySelector('[role=dialog]').scrollTop>0"), "dialog content scrolls while page is locked"); }
          await evaluate("document.querySelector('[role=dialog] [data-slot=dialog-close]').click()"); await pause(200);
          assert.ok(await evaluate("!document.querySelector('[role=dialog]')"), "deletion dialog closes");
          await evaluate(`document.querySelector(${JSON.stringify(scroller)}).scrollTop=0`);
          await wheel(list, 250); assert.ok(await outerTop() > 0, "closing dialog releases page wheel scrolling");
        } else {
          const reader = ".research-document-content";
          await evaluate(`document.querySelector(${JSON.stringify(reader)}).scrollIntoView({block:'center'})`);
          await wheel(reader, 250); assert.ok(await evaluate(`document.querySelector(${JSON.stringify(reader)}).scrollTop>0`), "component document scrolls internally");
          await evaluate(`document.querySelector(${JSON.stringify(reader)}).scrollTop=1e7;document.querySelector('.knowledge-extraction-content').scrollTop=0`);
          const hasOuterOverflow = await evaluate("(()=>{const e=document.querySelector('.knowledge-extraction-content');return e.scrollHeight>e.clientHeight})()");
          const pageBefore = await evaluate("window.scrollY");
          await wheel(reader, 250);
          assert.ok(hasOuterOverflow ? await outerTop() > 0 : await evaluate("window.scrollY") > pageBefore, `${width}: component reader boundary continues to the next scrolling parent`);
        }
        await evaluate("document.querySelectorAll('.knowledge-extraction-content, .knowledge-task-progress, .research-reader, .research-document-content, .knowledge-progress-entries > ol').forEach(e=>e.scrollTop=1e7);window.scrollTo(0,0)");
        const before = await evaluate("window.scrollY");
        await wheel(kind === "domain" ? '.knowledge-progress-entries > ol > li:last-child summary' : ".knowledge-extraction-content", 300);
        // 页面内的组件工作区:到底后原生滚轮链继续滚动平台页面。
        if (kind === "component") assert.ok(await evaluate("window.scrollY") > before, `${kind} ${width}: workspace boundary must allow page scrolling`);
        // 专注页铺满视口,背后的平台页面被锁定,滚到底也不能把看不见的页面带着走。
        else assert.equal(await evaluate("window.scrollY"), before, `${kind} ${width}: focused task keeps the hidden platform page still`);
      }
      await send("Target.closeTarget", { targetId });
    }
  } finally {
    socket?.close(); for (const entry of pending.values()) clearTimeout(entry.timer);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await closed; clearTimeout(timer);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
