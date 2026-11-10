/**
 * 外部图片代理转存(POST /issues/proxy-image,#276):粘贴的外部
 * <img src="https://..."> 图前端拿不到字节(跨域带不上对方站的
 * Cookie),由后端下载落 staging,返回 issue-images/<hash>.<ext> 引用。
 * data: URL 的字节就在 src 里,前端本地转 Blob 走既有上传,不进这里;
 * file:/// 在前端拦截,路由层仍以协议白名单兜一道。
 *
 * 直调 handleIssueRoutes(与 issueFlowContract 同款 harness),上游用
 * 本机 http server 假装图片站,不碰真外网。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import type { IssueFlowService } from "../src/issueFlow/service.ts";
import type { DtsGateway } from "../src/issueFlow/gateways.ts";
import { ISSUE_IMAGE_MAX_BYTES } from "../src/issueFlow/issueImages.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 最小 PNG:魔数齐即可,stageIssueImage 靠它认扩展名。 */
const PNG_BYTES = Buffer.from(
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

/** 假上游图片站:每笔请求都按 handler 回。listen(0) 拿空闲端口。 */
function upstream(
  handler: (response: import("node:http").ServerResponse) => void,
): Promise<{ origin: string; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((_request, response) =>
      handler(response));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** POST /issues/proxy-image 直调:与浏览器同一 readBody 协议过线。
 * issueFlow 只被这一条路由读到 dataDir,桩进去即可,不起真服务。 */
function proxyPost(
  payload: unknown,
  options: {
    dataDir?: string;
    viewer?: { username: string; role?: string };
    dts?: DtsGateway;
  } = {},
): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const request = new EventEmitter() as any;
    request.method = "POST";
    let status = 0;
    void handleIssueRoutes(
      request,
      {
        writeHead: (code: number) => {
          status = code;
        },
        end: (output?: string) => {
          try {
            resolve({ status, body: JSON.parse(output ?? "{}") });
          } catch (error) {
            reject(error);
          }
        },
      } as any,
      ["issues", "proxy-image"],
      {
        issueFlow: { dataDir: options.dataDir } as unknown as IssueFlowService,
        authEnabled: false,
        viewer: options.viewer,
        dts: options.dts,
      },
    ).catch(reject);
    request.emit("data", Buffer.from(JSON.stringify(payload)));
    request.emit("end");
  });
}

test("代理转存:http(s) 外链图经后端下载落 staging,返回相对引用", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const site = await upstream((response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(PNG_BYTES);
  });
  try {
    const { status, body } = await proxyPost(
      { url: `${site.origin}/album/pic.png` }, { dataDir });
    assert.equal(status, 201, `应转存成功,实际 ${status}: ${body.error ?? ""}`);
    assert.match(body.path, /^issue-images\/[0-9a-f]{16}\.png$/);
    assert.equal(body.bytes, PNG_BYTES.length);
    // staging 里真有这张图(文件名与返回引用同名)。
    const staged = join(dataDir, "issue-image-staging", body.path.split("/")[1]);
    assert.ok(existsSync(staged), `staging 应有 ${staged}`);
  } finally {
    await site.close();
  }
});

test("代理转存:上游回 HTML(需认证被拦的典型形态)→ 415 不落盘", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const site = await upstream((response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body>login please</body></html>");
  });
  try {
    const { status, body } = await proxyPost(
      { url: `${site.origin}/pic.png` }, { dataDir });
    assert.equal(status, 415);
    assert.match(body.error, /不是图片/);
    assert.equal(existsSync(join(dataDir, "issue-image-staging")), false,
      "垃圾字节不应落 staging");
  } finally {
    await site.close();
  }
});

test("代理转存:上游 404 → 502 带上游状态", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const site = await upstream((response) => {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("no such pic");
  });
  try {
    const { status, body } = await proxyPost(
      { url: `${site.origin}/gone.png` }, { dataDir });
    assert.equal(status, 502);
    assert.match(body.error, /HTTP 404/);
  } finally {
    await site.close();
  }
});

test("代理转存:非 http(s) 协议白名单拒绝,file:/// 不外泄", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const { status, body } = await proxyPost(
    { url: "file:///C:/Users/me/secret.png" }, { dataDir });
  assert.equal(status, 400);
  assert.match(body.error, /http\/https/);
});

test("代理转存:缺 url → 400", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const { status, body } = await proxyPost({}, { dataDir });
  assert.equal(status, 400);
  assert.match(body.error, /缺少 url/);
});

test("代理转存:管理员不发起问题会话,同 issue-image 角色边界", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const { status, body } = await proxyPost(
    { url: "https://example.com/pic.png" },
    { dataDir, viewer: { username: "boss", role: "admin" } });
  assert.equal(status, 403);
  assert.match(body.error, /管理员/);
});

test("代理转存:边读边限量,超 20MiB 上限 413 且不落盘", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const tooBig = Buffer.concat(
    [PNG_BYTES, Buffer.alloc(ISSUE_IMAGE_MAX_BYTES - PNG_BYTES.length + 1)]);
  const site = await upstream((response) => {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(tooBig);
  });
  try {
    const { status, body } = await proxyPost(
      { url: `${site.origin}/huge.png` }, { dataDir });
    assert.equal(status, 413);
    assert.match(body.error, /上限/);
    assert.equal(existsSync(join(dataDir, "issue-image-staging")), false,
      "超限图不应落 staging");
  } finally {
    await site.close();
  }
});

// ---- DTS 域:裸 fetch 无凭据必 401(#276 环境实测),改走网关同源凭据 ----

const DTS_ORIGIN = "https://dts.example.com";

test("代理转存:DTS 域图走网关 proxyFile 同源凭据,不裸 fetch", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const fetchedPaths: string[] = [];
  const dts = {
    proxyFile: async (path: string) => {
      fetchedPaths.push(path);
      return { data: PNG_BYTES, contentType: "image/png" };
    },
  } as unknown as DtsGateway;
  const { status, body } = await proxyPost(
    { url: `${DTS_ORIGIN}/v1/nfs/downLoadFile?filePath=%2F202608%2Fa.png` },
    { dataDir, dts });
  assert.equal(status, 201, `应经网关转存成功,实际 ${status}: ${body.error ?? ""}`);
  // 网关收到的就是站内绝对路径(pathname+search),凭据由网关注入。
  assert.deepEqual(fetchedPaths,
    ["/v1/nfs/downLoadFile?filePath=%2F202608%2Fa.png"]);
  assert.match(body.path, /^issue-images\/[0-9a-f]{16}\.png$/);
  const staged = join(dataDir, "issue-image-staging", body.path.split("/")[1]);
  assert.ok(existsSync(staged));
});

test("代理转存:DTS 域但网关未配置 → 409,不假装能裸拉", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const { status, body } = await proxyPost(
    { url: `${DTS_ORIGIN}/v1/nfs/downLoadFile?filePath=%2F202608%2Fa.png` },
    { dataDir });
  assert.equal(status, 409);
  assert.match(body.error, /DTS 网关未配置/);
});

test("代理转存:DTS 网关回取失败 → 502 带网关错误", async () => {
  const dataDir = mfcTemp("mfc-issue-image-proxy-");
  const dts = {
    proxyFile: async () => {
      throw new Error("DTS 文件代理 HTTP 401");
    },
  } as unknown as DtsGateway;
  const { status, body } = await proxyPost(
    { url: `${DTS_ORIGIN}/v1/nfs/downLoadFile?filePath=%2F202608%2Fa.png` },
    { dataDir, dts });
  assert.equal(status, 502);
  assert.match(body.error, /401/);
});
