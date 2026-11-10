/**
 * 登记附件(2026-09-19 拍板;2026-10-15 #502 起 DTS 发起随单上传同链路):
 * 上传流式落 staging、扩展名净化、引用扫描(描述/附加信息两源)、工作区
 * 同步,以及 POST /issues/issue-attachment 的路由边界(管理员 403 同截图)。
 * 与 issueImageProxy 同款 harness:直调 handleIssueRoutes,不起真服务。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  attachmentExtension,
  extractIssueAttachmentPaths,
  stageIssueAttachmentStream,
  syncIssueAttachmentsToWorkspace,
} from "../src/issueFlow/issueAttachments.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import type { IssueFlowService } from "../src/issueFlow/service.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 伪上传请求:真 Readable(路由层走 stream pipeline),只补 url/method。 */
function uploadRequest(chunks: Buffer[], url?: string): any {
  const stream = Readable.from(chunks) as any;
  stream.method = "POST";
  stream.url = url ?? "/issues/issue-attachment?name=app.log";
  return stream;
}

/** POST /issues/issue-attachment 直调;响应只取状态码与 JSON 体。 */
function attachmentPost(request: any, options: {
  dataDir?: string;
  viewer?: { username: string; role?: string };
} = {}): Promise<{ status: number; body: Record<string, any> }> {
  return new Promise((resolve, reject) => {
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
      ["issues", "issue-attachment"],
      {
        issueFlow: { dataDir: options.dataDir } as unknown as IssueFlowService,
        authEnabled: false,
        viewer: options.viewer,
      },
    ).catch(reject);
  });
}

test("扩展名净化:留末段字母数字,怪形退 bin;路径分隔取末段", () => {
  assert.equal(attachmentExtension("app-2026-09-19.log"), "log");
  assert.equal(attachmentExtension("dump.tar.gz"), "gz");
  assert.equal(attachmentExtension("TRACE.LOG"), "log");
  assert.equal(attachmentExtension("noext"), "bin");
  assert.equal(attachmentExtension("weird.<script>"), "bin");
  assert.equal(attachmentExtension(undefined), "bin");
  assert.equal(attachmentExtension("C:\\tmp\\a\\x.txt"), "txt");
});

test("流式落 staging:内容寻址命名、字节计数、同内容去重不重复落盘", async () => {
  const dataDir = mfcTemp("mfc-issue-attach-");
  try {
    const body = Buffer.from("line1\nline2\n");
    const first = await stageIssueAttachmentStream(uploadRequest([body]),
      { dataDir, filename: "app.log" });
    assert.match(first.path, /^attachments\/[0-9a-f]{16}\.log$/);
    assert.equal(first.bytes, body.length);
    const staged = join(dataDir, "issue-attachment-staging",
      first.path.split("/")[1]);
    assert.ok(existsSync(staged), `staging 应有 ${staged}`);
    assert.equal(readFileSync(staged).toString(), "line1\nline2\n");

    // 同内容再传:同一路径,不写第二份(content-addressed 去重)。
    const again = await stageIssueAttachmentStream(uploadRequest([body]),
      { dataDir, filename: "app.log" });
    assert.equal(again.path, first.path);

    // 同内容不同扩展名:不同名(扩展名参与文件名)。
    const otherExt = await stageIssueAttachmentStream(uploadRequest([body]),
      { dataDir, filename: "app.txt" });
    assert.notEqual(otherExt.path, first.path);
    assert.match(otherExt.path, /\.txt$/);

    // 分片到达(逐 chunk 传)与整包到达同哈希。
    const sliced = await stageIssueAttachmentStream(
      uploadRequest([body.subarray(0, 3), body.subarray(3)]),
      { dataDir, filename: "app.log" });
    assert.equal(sliced.path, first.path);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("超上限中途拒绝:掐流、报上限、staging 不留残件", async () => {
  const dataDir = mfcTemp("mfc-issue-attach-cap-");
  try {
    await assert.rejects(
      stageIssueAttachmentStream(
        uploadRequest([Buffer.alloc(6), Buffer.alloc(6)]),
        { dataDir, filename: "big.log", maxBytes: 10 }),
      /上限/);
    // 残件零容忍:staging 目录可在(建目录先于流开始),但里面什么
    // 都不该留(.tmp 已清、成品未落)。
    const staging = join(dataDir, "issue-attachment-staging");
    const residual = existsSync(staging) ? readdirSync(staging) : [];
    assert.deepEqual(residual, [], "超限上传不应在 staging 留任何文件");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("引用扫描与工作区同步:去重按出现序,staging 缺席 fail-open 记缺席", () => {
  const dataDir = mfcTemp("mfc-issue-attach-sync-");
  try {
    const description = "日志见 attachments/0123456789abcdef.log 与 "
      + "attachments/0123456789abcdef.log(重复不重算),压缩包见 "
      + "attachments/ffffffffffffffff.zip";
    assert.deepEqual(extractIssueAttachmentPaths(description), [
      "attachments/0123456789abcdef.log",
      "attachments/ffffffffffffffff.zip",
    ]);
    // staging 只有前者:复制 1 个、缺席 1 个,不阻断。
    const stagedName = "0123456789abcdef.log";
    mkdirSyncStaging(dataDir, stagedName, "hello log");
    const workspace = join(dataDir, "issues", "issue-1");
    const result = syncIssueAttachmentsToWorkspace({
      description, dataDir, workspace,
    });
    assert.deepEqual(result, { copied: 1, missing: 1 });
    assert.equal(
      readFileSync(join(workspace, "attachments", stagedName)).toString(),
      "hello log");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("附加信息两源同步(#502):DTS 发起随单附件拼在 remark 尾部,与描述同规则提取", () => {
  const dataDir = mfcTemp("mfc-issue-attach-remark-");
  try {
    // 只有 remark 带引用(描述是单据标题,没附件):照样同步。
    const stagedName = "1111222233334444.log";
    mkdirSyncStaging(dataDir, stagedName, "dts log");
    const workspace = join(dataDir, "issues", "issue-2");
    const result = syncIssueAttachmentsToWorkspace({
      description: "播放器升级后黑屏",
      remark: "先复现黑屏再查日志\n随单附件: attachments/1111222233334444.log",
      dataDir, workspace,
    });
    assert.deepEqual(result, { copied: 1, missing: 0 });
    assert.equal(
      readFileSync(join(workspace, "attachments", stagedName)).toString(),
      "dts log");

    // 两源同引用:合并去重,只复制一份。
    const both = syncIssueAttachmentsToWorkspace({
      description: "日志见 attachments/1111222233334444.log",
      remark: "随单附件: attachments/1111222233334444.log",
      dataDir, workspace: join(dataDir, "issues", "issue-3"),
    });
    assert.deepEqual(both, { copied: 1, missing: 0 });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("路由:POST 落 staging 返回引用;管理员 403 不动手", async () => {
  const dataDir = mfcTemp("mfc-issue-attach-route-");
  try {
    const body = Buffer.from("ERROR 2026-09-19 boom\n");
    const ok = await attachmentPost(
      uploadRequest([body], "/issues/issue-attachment?name=trace.log"),
      { dataDir });
    assert.equal(ok.status, 201, `应上传成功,实际 ${ok.status}: ${ok.body.error ?? ""}`);
    assert.match(ok.body.path, /^attachments\/[0-9a-f]{16}\.log$/);
    assert.equal(ok.body.bytes, body.length);
    assert.ok(existsSync(join(dataDir, "issue-attachment-staging",
      ok.body.path.split("/")[1])));

    const denied = await attachmentPost(
      uploadRequest([body]),
      { dataDir, viewer: { username: "root", role: "admin" } });
    assert.equal(denied.status, 403);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

/** staging 造一个已知内容的附件文件(同步测试用,不走上传流)。 */
function mkdirSyncStaging(dataDir: string, filename: string, content: string): void {
  mkdirSync(join(dataDir, "issue-attachment-staging"), { recursive: true });
  writeFileSync(join(dataDir, "issue-attachment-staging", filename), content);
}
