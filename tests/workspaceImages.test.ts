/**
 * 会话工作区图片回显的路由契约测试(#376/#381):
 * - 形状白名单即边界:只认 ticket-images/<单号>/<哈希16>.<扩展名> 与
 *   issue-images/<哈希16>.<扩展名> 两种引用,穿越段/多段/非法形状/
 *   缺失文件一律 4xx/404,工作区其余文件(台账、报告)不可经此读出;
 * - 读无闸(查看模式):挂 issues 域,登录语义由全局 gate 管,路由层
 *   不再做角色分叉(与 documents/reviews 同款);
 * - 命中回二进制:200 + 按扩展名给 content-type + inline/nosniff/私有缓存,
 *   与 staging 回显(issue-image GET)同款响应头。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { mfcTemp } from "./mfcTmp.ts";

const PNG_1PX = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000"
  + "01f15c4890000000a49444154789c6300010000050001"
  + "0d0a2db40000000049454e44ae426082", "hex");

function workspaceWithImages(): string {
  const root = mfcTemp("mfc-issue-wsimg-");
  const ticketDir = join(root, "ticket-images", "DTS2026091738381");
  mkdirSync(ticketDir, { recursive: true });
  writeFileSync(join(ticketDir, "d65d964ac359071a.png"), PNG_1PX);
  mkdirSync(join(root, "issue-images"), { recursive: true });
  writeFileSync(join(root, "issue-images", "abcd1234ef567890.jpg"), PNG_1PX);
  // 台账在场:白名单外的典型文件,不许被这张接口读出。
  writeFileSync(join(root, "issue.json"), "{}");
  return root;
}

async function call(root: string, url: string): Promise<{
  status: number;
  contentType?: string;
  disposition?: string;
  body: Buffer | any;
}> {
  return new Promise((resolve, reject) => {
    let status = 0;
    let headers: Record<string, string> = {};
    void handleIssueRoutes(
      { method: "GET", url } as any,
      {
        writeHead: (code: number, written?: Record<string, string>) => {
          status = code;
          headers = written ?? {};
        },
        end: (payload?: string | Buffer) => resolve({
          status,
          contentType: headers["content-type"],
          disposition: headers["content-disposition"],
          body: payload instanceof Buffer
            ? payload
            : JSON.parse(Buffer.from(payload ?? "").toString("utf-8")),
        }),
      } as any,
      ["issues", "issue-wsimg", "workspace-image"],
      { issueFlow: {
          list: () => [],
          session: () => ({ state: {} as never, root }),
        } as any, authEnabled: false },
    ).then((handled) => {
      if (!handled) reject(new Error("未被问题域接管"));
    }).catch((reason) => {
      resolve({ status: 500, body: { error: String(reason) } });
    });
  });
}

test("白名单命中:工单截图与登记截图都按扩展名回二进制", async () => {
  const root = workspaceWithImages();

  const ticket = await call(root,
    "/issues/issue-wsimg/workspace-image"
    + "?path=ticket-images%2FDTS2026091738381%2Fd65d964ac359071a.png");
  assert.equal(ticket.status, 200);
  assert.equal(ticket.contentType, "image/png");
  assert.equal(ticket.disposition, "inline");
  assert.ok(Buffer.isBuffer(ticket.body) && ticket.body.equals(PNG_1PX));

  const reg = await call(root,
    "/issues/issue-wsimg/workspace-image?path=issue-images%2Fabcd1234ef567890.jpg");
  assert.equal(reg.status, 200);
  assert.equal(reg.contentType, "image/jpeg");
});

test("白名单即边界:穿越/台账/目录越级/非法形状/缺失一律拒", async () => {
  const root = workspaceWithImages();

  const escapes: Array<[string, string]> = [
    ["穿越段", "ticket-images/../issue.json"],
    ["穿越段+合法文件名", "ticket-images/../abcd1234ef567890.png"],
    ["单号含空字节", "ticket-images/D\0TS/abcd1234ef567890.png"],
    ["绝对路径形态", "/etc/passwd"],
    ["台账直取", "issue.json"],
    ["越级目录", "repo/mgr/main.py"],
    ["登记截图带单号段", "issue-images/DTS2026091738381/d65d964ac359071a.png"],
    ["工单截图少一段", "ticket-images/d65d964ac359071a.png"],
    ["非法哈希长度", "ticket-images/DTS2026091738381/abc.png"],
    ["非图扩展", "ticket-images/DTS2026091738381/d65d964ac359071a.html"],
    ["矢量图扩展不在落盘集", "issue-images/abcd1234ef567890.svg"],
    ["缺 path 参数", ""],
  ];
  for (const [what, path] of escapes) {
    const bad = await call(root,
      "/issues/issue-wsimg/workspace-image?path=" + encodeURIComponent(path));
    assert.ok(bad.status >= 400 && bad.status < 500,
      `${what}(${path}) 应被拒,实得 ${bad.status}`);
    if (Buffer.isBuffer(bad.body)) {
      assert.fail(`${what} 不该回二进制`);
    }
  }

  const missing = await call(root,
    "/issues/issue-wsimg/workspace-image"
    + "?path=ticket-images%2FDTS2026091738381%2F0000000000000000.png");
  assert.equal(missing.status, 404, "形状合法但文件缺席是 404");
});
