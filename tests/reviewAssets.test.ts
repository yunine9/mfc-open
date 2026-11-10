/**
 * 批注附图资产的契约:按内容哈希落任务目录并铺进 Agent 工作区(inspect_image
 * 只认工作区相对路径);扩展名按魔数不信客户端;现场重建能重新铺;读取只认
 * 本模块产出的路径形状(别的路径一律 404,不给越界机会)。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REVIEW_ASSET_ROOT, ReviewAssetError, isReviewAssetPath, materializeReviewAssets,
  readReviewAsset, storeReviewAsset,
} from "../src/reviewAssets.ts";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake-png-body")]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake-jpeg-body")]);

test("存图:任务目录是真相,同时铺进 Agent 工作区;同图只存一份;扩展名按魔数", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ra-ws-"));
  const cwd = mkdtempSync(join(tmpdir(), "mfc-ra-cwd-"));
  const stored = storeReviewAsset(workspace, cwd, PNG);
  assert.match(stored.path, /^\.mae-flow-work\/review-assets\/[0-9a-f]{24}\.png$/);
  assert.equal(stored.mime_type, "image/png");
  assert.ok(isReviewAssetPath(stored.path));
  assert.ok(existsSync(join(workspace, "reviews", "assets", stored.path.split("/").at(-1)!)));
  assert.ok(existsSync(join(cwd, stored.path)), "Agent 工作区里必须有同名文件");
  assert.equal(storeReviewAsset(workspace, cwd, PNG).path, stored.path, "同一张图同一个路径");
  assert.equal(storeReviewAsset(workspace, undefined, JPG).mime_type, "image/jpeg");
  const back = readReviewAsset(workspace, stored.path)!;
  assert.equal(back.mime_type, "image/png");
  assert.ok(back.content.equals(PNG));
});

test("拒绝:空文件、非图片、超限;读取不认非资产路径", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ra-ws-"));
  assert.throws(() => storeReviewAsset(workspace, undefined, Buffer.alloc(0)), ReviewAssetError);
  assert.throws(() => storeReviewAsset(workspace, undefined, Buffer.from("<svg/>")), /只支持 PNG/);
  assert.throws(() => storeReviewAsset(workspace, undefined, Buffer.alloc(9 * 1024 * 1024, 1)), /超过/);
  assert.equal(readReviewAsset(workspace, "../../etc/passwd"), undefined);
  assert.equal(readReviewAsset(workspace, `${REVIEW_ASSET_ROOT}/../../task.json`), undefined);
  assert.equal(isReviewAssetPath("docs/a.png"), false);
});

test("现场重建:把任务目录里的图重新铺进新的 Agent 工作区", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ra-ws-"));
  const stored = storeReviewAsset(workspace, undefined, PNG);
  const rebuilt = mkdtempSync(join(tmpdir(), "mfc-ra-cwd2-"));
  materializeReviewAssets(workspace, rebuilt);
  assert.ok(existsSync(join(rebuilt, stored.path)));
});
