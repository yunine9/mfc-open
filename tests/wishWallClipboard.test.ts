import { test } from "node:test";
import assert from "node:assert/strict";
import {
  nextWishImageDraftKey,
  wishImageFilesFromClipboard,
  wishPasteModifier,
} from "../web/src/wishWallClipboard.ts";

const image = (type: string, name = "screenshot.png") => ({
  type,
  name,
  size: 128,
  lastModified: 1,
});

test("许愿墙图片草稿 key 不依赖安全上下文的 crypto.randomUUID", () => {
  const file = image("image/png");
  const first = nextWishImageDraftKey(file);
  const second = nextWishImageDraftKey(file);
  assert.notEqual(first, second);
  assert.match(first, /screenshot\.png-128-1-/);
});

test("许愿墙可从 Windows 剪贴板 items 读取类型缺失的截图", () => {
  const file = image("image/png");
  const files = wishImageFilesFromClipboard({
    items: [{ kind: "file", getAsFile: () => file }],
    files: [],
  });
  assert.deepEqual(files, [file]);
});

test("许愿墙在剪贴板 items 不完整时回退到 files", () => {
  const file = image("image/jpeg", "photo.jpg");
  const files = wishImageFilesFromClipboard({
    items: [],
    files: [file],
  });
  assert.deepEqual(files, [file]);
});

test("许愿墙过滤不支持的剪贴板文件并显示正确系统快捷键", () => {
  const text = image("text/plain", "note.txt");
  assert.deepEqual(wishImageFilesFromClipboard({
    items: [],
    files: [text],
  }), []);
  assert.equal(wishPasteModifier("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Ctrl");
  assert.equal(wishPasteModifier("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "⌘");
});
