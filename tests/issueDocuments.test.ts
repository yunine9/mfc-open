/**
 * 过程文档数据面的契约测试(「分析报告」页签;#260 起页面只留报告
 * 本身,本文件只守数据面):
 * - 清单:分析报告固定首位,其余最近修改在前;非 .md/子目录不入列;
 * - 读取:白名单即边界(零路径拼接),缺失如实 undefined;
 * - 打包:完整原文件出 ZIP(其他 .md 的唯一复盘出口)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import {
  mkdirSync,
  mkdtempSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANALYSIS_DOC_NAME,
  bundleSessionDocuments,
  listSessionDocuments,
  readSessionDocument,
} from "../src/issueFlow/documents.ts";
import { handleIssueRoutes } from "../src/issueFlow/routes.ts";
import { mfcTemp } from "./mfcTmp.ts";

/** 测试只需读 ZIP 的 local file headers；生成器不写 data descriptor，
 * 因而无需引入第三方解压库就能核对文件名与完整内容。 */
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
    const content = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    entries.set(zip.subarray(nameStart, nameStart + nameSize).toString("utf-8"),
      content);
    offset = dataStart + packedSize;
  }
  return entries;
}

test("过程文档清单:分析报告固定首位,其余最近修改在前;非顶层 .md 不入列", () => {
  const root = mfcTemp("mfc-issue-docs-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 分析报告");
  writeFileSync(join(root, "extra-notes.md"), "# 笔记");
  writeFileSync(join(root, "ignore.txt"), "不是文档");
  mkdirSync(join(root, "skills", "demo"), { recursive: true });
  writeFileSync(join(root, "skills", "demo", "SKILL.md"), "技能不是过程文档");
  // extra-notes 比分析报告新:mtime 排序不能把分析报告从首位挤下去。
  utimesSync(join(root, ANALYSIS_DOC_NAME), new Date(0), new Date(0));

  const docs = listSessionDocuments(root);
  assert.deepEqual(docs.map((doc) => doc.name),
    [ANALYSIS_DOC_NAME, "extra-notes.md"]);
  assert.equal(docs[0].label, "分析报告", "分析报告的页签名是服务端给的");
  assert.equal(docs[1].label, "extra-notes.md");
});

test("过程文档读取:白名单即边界,路径拼接零容忍;缺失返回 undefined", () => {
  const root = mfcTemp("mfc-issue-doc-read-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 分析报告\n\n根因在此。");

  const read = readSessionDocument(root, ANALYSIS_DOC_NAME);
  assert.ok(read);
  assert.equal(read.meta.label, "分析报告");
  assert.match(read.content, /根因在此/);
  assert.equal(read.truncated, false);

  assert.equal(readSessionDocument(root, "missing.md"), undefined,
    "不在清单里的名字一律 undefined");
  assert.equal(readSessionDocument(root, "../issue.json"), undefined,
    "带路径分隔的名字直接打回(读的是清单,不拼路径)");
  assert.equal(readSessionDocument(root, ""), undefined);
});

test("过程文档打包:只收清单白名单且保留完整原文件,不是页面截断稿", () => {
  const root = mfcTemp("mfc-issue-doc-archive-");
  const large = `# 完整分析\n\n${"根因。".repeat(180_000)}`;
  writeFileSync(join(root, ANALYSIS_DOC_NAME), large);
  writeFileSync(join(root, "补充结论.md"), "# 补充结论\n\n需要回归。\n");
  writeFileSync(join(root, "events.jsonl"), "过程问答不是文档文件");

  const archive = bundleSessionDocuments(root);
  assert.ok(archive);
  assert.equal(archive.files, 2);
  const entries = unzipEntries(archive.data);
  assert.deepEqual([...entries.keys()].sort(),
    [ANALYSIS_DOC_NAME, "补充结论.md"].sort());
  assert.equal(entries.get(ANALYSIS_DOC_NAME)?.toString("utf-8"), large,
    "下载包必须是完整原文,不能复用 512 KB 页面截断内容");
  assert.equal(entries.has("events.jsonl"), false, "非 Markdown 不入包");
});

test("过程文档打包路由:返回标准附件头与 ZIP 二进制;空清单给人话", async () => {
  const root = mfcTemp("mfc-issue-doc-route-");
  writeFileSync(join(root, ANALYSIS_DOC_NAME), "# 分析报告\n");
  const service = {
    list: () => [{ id: "issue-zip", account: "dev" }],
    session: () => ({ root }),
  } as any;

  async function download(): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      let status = 0;
      let headers: Record<string, string> = {};
      void handleIssueRoutes(
        { method: "GET", url: "/issues/issue-zip/documents/archive" } as any,
        {
          writeHead: (code: number, values: Record<string, string>) => {
            status = code;
            headers = values;
          },
          end: (payload?: string | Buffer) => resolve({
            status,
            headers,
            body: Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? ""),
          }),
        } as any,
        ["issues", "issue-zip", "documents", "archive"],
        { issueFlow: service, authEnabled: false },
      ).catch(reject);
    });
  }

  const response = await download();
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/zip");
  assert.match(response.headers["content-disposition"], /attachment/);
  assert.match(response.headers["content-disposition"], /filename\*=UTF-8''/);
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  assert.equal(unzipEntries(response.body).get(ANALYSIS_DOC_NAME)?.toString(),
    "# 分析报告\n");

  unlinkSync(join(root, ANALYSIS_DOC_NAME));
  const empty = await download();
  assert.equal(empty.status, 409);
  assert.deepEqual(JSON.parse(empty.body.toString("utf-8")),
    { error: "暂无可打包的过程文档" });
});
