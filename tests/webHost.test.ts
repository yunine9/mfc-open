/**
 * 正式前端静态托管语义:
 * - 配 webRoot:/ 出 index.html,资产按类型出文件,API 路由不受影响;
 * - 不配 webRoot:零构建演示页兜底——两种形态永远有一个能用;
 * - 路径穿越不是 404 的一种,是攻击:webRoot 外的文件一律不认。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "../src/jsonBody.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";

function startServer(webRoot?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "webhost-"));
  const service = new TaskService({
    dataDir, provider: "p", model: "m", modelsJson: {},
  });
  const server = createTaskServer(service, { webRoot });
  return new Promise<{ base: string; close: () => void }>((ready) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      ready({
        base: `http://127.0.0.1:${port}`,
        close: () => server.close(),
      });
    });
  });
}

/** 不走 fetch 的原始 HTTP GET:路径原样上线,不被客户端规范化。 */
function rawGet(base: string, path: string): Promise<string> {
  const port = Number(new URL(base).port);
  return new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk));
    socket.on("end", () => done(data));
    socket.on("error", fail);
  });
}

test("配 webRoot:index 与资产按类型出文件,API 与穿越各归各位", async () => {
  const webRoot = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(webRoot, "assets"));
  mkdirSync(join(webRoot, "help"));
  writeFileSync(join(webRoot, "index.html"), "<title>正式前端</title>");
  writeFileSync(join(webRoot, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "inter.woff2"), "font-data");
  writeFileSync(join(webRoot, "help", "01-overview.png"), "png-data");
  writeFileSync(join(webRoot, "..", "secret.txt"), "不该被读到");
  const { base, close } = await startServer(webRoot);
  try {
    const index = await fetch(base + "/");
    assert.equal(index.headers.get("content-type"),
      "text/html; charset=utf-8");
    assert.match(await index.text(), /正式前端/);

    // 入口页必须每次回源。它一个缓存头都不带的时候,浏览器可以按启发式
    // 规则自己缓存;资产名带 hash 也没用——入口页是旧的,它引的就永远是
    // 旧包。前端修了三轮,人看到的可能一直是修之前那版,而且这种"没生效"
    // 完全无声。
    assert.match(index.headers.get("cache-control") ?? "", /no-cache/);

    const asset = await fetch(base + "/assets/app.js");
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"),
      "text/javascript; charset=utf-8");
    // 带 hash 的资产反过来可以长期缓存:改了内容就是新文件名。
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);

    // 字体随 Linux 服务端的前端构建发布，由 Windows 浏览器下载使用；
    // 必须声明字体类型，不能依赖浏览器容忍 application/octet-stream。
    const font = await fetch(base + "/assets/inter.woff2");
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
    assert.match(font.headers.get("cache-control") ?? "", /immutable/);

    // API 路由优先于静态文件,不被前端接管。
    const api = await fetch(base + "/tasks");
    assert.deepEqual(await readJson(api), []);

    // 任务工作台有真正的可刷新子 URL，由 SPA 入口接管；旧通知若仍指向
    // /tasks/:id，浏览器导航会跳到新地址，而 API fetch 仍返回 JSON。
    const work = await fetch(base + "/work/task-7");
    assert.equal(work.status, 200);
    assert.match(await work.text(), /正式前端/);

    // FAQ 根入口和逐篇直链同样由 React 接管；否则刷新或从消息里直接
    // 打开 /help/:article 会在服务端先变成 404。
    for (const path of ["/help", "/help/getting-started"]) {
      const help = await fetch(base + path);
      assert.equal(help.status, 200);
      assert.equal(help.headers.get("content-type"), "text/html; charset=utf-8");
      assert.match(help.headers.get("cache-control") ?? "", /no-cache/);
      assert.match(await help.text(), /正式前端/);
    }
    // 真实截图优先于 SPA 回退；缺图也必须诚实 404，不能返回 HTML 假图。
    const helpShot = await fetch(base + "/help/01-overview.png");
    assert.equal(helpShot.status, 200);
    assert.equal(helpShot.headers.get("content-type"), "image/png");
    assert.equal(await helpShot.text(), "png-data");
    const missingHelpShot = await fetch(base + "/help/missing.png");
    assert.equal(missingHelpShot.status, 404);

    const legacy = await fetch(base + "/tasks/task-7", {
      headers: { accept: "text/html" }, redirect: "manual",
    });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/work/task-7");
    const apiDetail = await fetch(base + "/tasks/task-7");
    assert.equal(apiDetail.status, 404);
    assert.match(apiDetail.headers.get("content-type") ?? "", /application\/json/);

    // 问题会话工作台深链(小鲁班通知的落点):GET /issues/:id 既是详情
    // API 又是前端路由——判别式与 /tasks/:id 相同,浏览器导航(Accept
    // 要 text/html)拿 SPA 入口,程序 fetch(默认 Accept: */*)照旧拿
    // 问题流 API 的 JSON,契约零变化。
    const issuePage = await fetch(base + "/issues/is-1", {
      headers: { accept: "text/html" },
    });
    assert.equal(issuePage.status, 200);
    assert.match(issuePage.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await issuePage.text(), /正式前端/);
    const issueApi = await fetch(base + "/issues/is-1");
    assert.equal(issueApi.status, 404);
    assert.match(issueApi.headers.get("content-type") ?? "", /application\/json/);

    // 工具列表和详情直开都要进入 SPA，普通 fetch 仍返回 JSON。
    for (const path of ["/pipeline-repairs", "/pipeline-repairs/mr-repair-1"]) {
      const repairPage = await fetch(base + path, { headers: { accept: "text/html" } });
      assert.equal(repairPage.status, 200, `${path} 浏览器导航应进入 SPA`);
      assert.match(repairPage.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await repairPage.text(), /正式前端/);
      const repairApi = await fetch(base + path);
      assert.equal(repairApi.status, 404);
      assert.match(repairApi.headers.get("content-type") ?? "", /application\/json/);
    }

    // 环境管理页签深链(#149):同款判别式——浏览器导航(text/html)拿
    // SPA 入口,程序 fetch(默认 Accept:*/*)照旧拿台账 JSON,契约零变化。
    const envPage = await fetch(base + "/environments", {
      headers: { accept: "text/html" },
    });
    assert.equal(envPage.status, 200);
    assert.match(envPage.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await envPage.text(), /正式前端/);
    const envApi = await fetch(base + "/environments");
    assert.match(envApi.headers.get("content-type") ?? "", /application\/json/);

    // 穿越:fetch 会在客户端就规范化 "..",测不到服务端——
    // 用裸 socket 发未规范化路径,断言真属性:秘密永不泄露。
    const raw = await rawGet(base, "/assets/../../secret.txt");
    assert.ok(!raw.includes("不该被读到"), "webRoot 外的文件泄露了");
    assert.match(raw, /404/);
    const missing = await fetch(base + "/no-such-file.js");
    assert.equal(missing.status, 404);
  } finally {
    close();
  }
});

test("不配 webRoot:零构建演示页兜底", async () => {
  const { base, close } = await startServer();
  try {
    const page = await fetch(base + "/");
    assert.match(await page.text(), /Mae-Flow 云端任务/);
  } finally {
    close();
  }
});
