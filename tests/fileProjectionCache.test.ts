import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileProjectionCache } from "../src/fileProjectionCache.ts";

test("列表文件缓存复用未变化文件，同路径同大小同修改时间的替换仍重新读取", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-projection-cache-")), file = join(dir, "record.json");
  try {
    writeFileSync(file, '{"revision":"a"}'); const before = statSync(file);
    const cache = new FileProjectionCache<{ revision: string }>(); let reads = 0;
    const read = () => cache.read(file, () => { reads++; return JSON.parse(readFileSync(file, "utf8")); });
    assert.equal(read().revision, "a"); assert.equal(read().revision, "a"); assert.equal(reads, 1);
    const replacement = join(dir, "replacement.json"); writeFileSync(replacement, '{"revision":"b"}');
    utimesSync(replacement, before.atime, before.mtime); renameSync(replacement, file);
    assert.equal(statSync(file).size, before.size); assert.equal(read().revision, "b"); assert.equal(reads, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("坏 JSON 不重复解析，修复和删除文件立即作废旧的校验结果", () => {
  const dir = mkdtempSync(join(tmpdir(), "file-projection-errors-")), file = join(dir, "record.json");
  try {
    writeFileSync(file, "{"); const cache = new FileProjectionCache<{ revision: string }>(); let reads = 0;
    const read = () => cache.read(file, () => { reads++; return JSON.parse(readFileSync(file, "utf8")); });
    assert.throws(read, SyntaxError); assert.throws(read, SyntaxError); assert.equal(reads, 1);
    writeFileSync(file, '{"revision":"fixed"}'); assert.equal(read().revision, "fixed"); assert.equal(reads, 2);
    rmSync(file); assert.throws(read, { code: "ENOENT" });
    writeFileSync(file, '{"revision":"restored"}'); assert.equal(read().revision, "restored"); assert.equal(reads, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
