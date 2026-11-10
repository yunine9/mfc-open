import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { LocalAuth } from "../src/auth.ts";
import { createTaskServer } from "../src/server.ts";
import { TaskService } from "../src/taskService.ts";
import {
  WishWallError,
  WishWallNotFoundError,
  WishWallPermissionError,
  WishWallStore,
} from "../src/wishWall.ts";

// 完整的 1x1 PNG；接口仍会用文件头复核，不能只改 MIME 混进来。
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("许愿墙台账:发布、去重点亮、接纳闭环与软删除可重放", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-wish-store-"));
  const store = new WishWallStore(root);
  const created = store.create({
    kind: "issue",
    title: "  手机端代码块溢出  ",
    detail: "横屏也看不全",
    images: [{ mime_type: "image/png", content_base64: PIXEL.toString("base64") }],
  }, "alice");
  assert.equal(created.title, "手机端代码块溢出");
  assert.equal(created.kind, "issue");
  assert.equal(created.images.length, 1);

  store.setVote(created.id, "bob", true);
  store.setVote(created.id, "bob", true);
  store.setVote(created.id, "alice", true);
  assert.deepEqual(new Set(store.list()[0].voters), new Set(["alice", "bob"]),
    "重试同一点赞不能把票数叠高");
  store.setVote(created.id, "bob", false);
  assert.deepEqual(store.list()[0].voters, ["alice"]);

  const accepted = store.setStatus(created.id, "accepted", "boss", "纳入下个迭代");
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.decision_note, "纳入下个迭代");
  const done = store.setStatus(created.id, "done", "boss", "已随 1.2.0 上线");
  assert.equal(done.status, "done");
  assert.equal(done.decided_by, "boss");

  const restored = new WishWallStore(root).list()[0];
  assert.equal(restored.status, "done");
  assert.equal(restored.decision_note, "已随 1.2.0 上线");
  assert.deepEqual(new WishWallStore(root).readImage(created.images[0].id).data, PIXEL);

  assert.throws(() => store.delete(created.id, "bob"), WishWallPermissionError);
  store.delete(created.id, "alice");
  assert.deepEqual(store.list(), []);
  assert.throws(() => store.readImage(created.images[0].id), WishWallNotFoundError,
    "软删除后旧图片地址也不能继续读取");
});

test("许愿墙图片边界:拒绝 SVG、伪造格式、超限数量和无说明拒绝", () => {
  const store = new WishWallStore(mkdtempSync(join(tmpdir(), "mfc-wish-image-")));
  assert.throws(() => store.create({ title: "SVG", images: [{
    mime_type: "image/svg+xml",
    content_base64: Buffer.from("<svg onload=alert(1) />").toString("base64"),
  }] }, "alice"), /仅支持 PNG/);
  assert.throws(() => store.create({ title: "伪图片", images: [{
    mime_type: "image/png",
    content_base64: Buffer.from("not a png").toString("base64"),
  }] }, "alice"), /格式不一致/);
  assert.throws(() => store.create({ title: "太多", images: Array.from({ length: 5 }, () => ({
    mime_type: "image/png", content_base64: PIXEL.toString("base64"),
  })) }, "alice"), /最多放 4 张/);
  const record = store.create({ title: "需要答复" }, "alice");
  assert.throws(() => store.setStatus(record.id, "declined", "boss"), WishWallError);
  assert.equal(store.setStatus(record.id, "declined", "boss", "当前投入产出不合适").status,
    "declined");
});

test("许愿墙 HTTP:登录可见、成员发布点赞、管理员回应、图片受保护", async () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-wish-http-"));
  const auth = new LocalAuth(join(root, "auth.json"));
  auth.bootstrapAdmin("boss", "administrator-pass");
  auth.createUser("alice", "alice-password-1", "developer");
  auth.createUser("bob", "bob-password-123", "developer");
  const service = new TaskService({
    dataDir: join(root, "data"), provider: "test", model: "test",
    modelsJson: {}, maxConcurrent: 0,
  });
  const server = createTaskServer(service, { auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = async (username: string, password: string) => {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST", body: JSON.stringify({ username, password }),
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie")!.split(";")[0];
  };
  try {
    assert.equal((await fetch(`${base}/wishes`)).status, 401);
    const alice = await login("alice", "alice-password-1");
    const bob = await login("bob", "bob-password-123");
    const boss = await login("boss", "administrator-pass");
    const response = await fetch(`${base}/wishes`, {
      method: "POST", headers: { cookie: alice }, body: JSON.stringify({
        kind: "wish", title: "一键生成复盘", detail: "完成后直接沉淀",
        images: [{ mime_type: "image/png", content_base64: PIXEL.toString("base64") }],
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json() as {
      id: string;
      images: Array<{ url: string }>;
      can_delete: boolean;
      can_manage: boolean;
    };
    assert.equal(created.can_delete, true);
    assert.equal(created.can_manage, false);

    const bobList = await fetch(`${base}/wishes`, { headers: { cookie: bob } });
    const bobView = (await bobList.json() as { wishes: Array<{
      can_delete: boolean; can_manage: boolean;
    }> }).wishes[0];
    assert.equal(bobView.can_delete, false);
    assert.equal(bobView.can_manage, false);

    assert.equal((await fetch(`${base}${created.images[0].url}`)).status, 401,
      "知道图片 URL 也不能绕过登录");
    const image = await fetch(`${base}${created.images[0].url}`, {
      headers: { cookie: bob },
    });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PIXEL);

    const vote = await fetch(`${base}/wishes/${created.id}/vote`, {
      method: "POST", headers: { cookie: bob }, body: JSON.stringify({ voted: true }),
    });
    assert.equal(vote.status, 200);
    assert.equal((await vote.json() as { votes: number }).votes, 1);
    const deniedStatus = await fetch(`${base}/wishes/${created.id}/status`, {
      method: "PATCH", headers: { cookie: bob },
      body: JSON.stringify({ status: "accepted" }),
    });
    assert.equal(deniedStatus.status, 403);
    const deniedDelete = await fetch(`${base}/wishes/${created.id}`, {
      method: "DELETE", headers: { cookie: bob },
    });
    assert.equal(deniedDelete.status, 403);

    const vagueDecline = await fetch(`${base}/wishes/${created.id}/status`, {
      method: "PATCH", headers: { cookie: boss },
      body: JSON.stringify({ status: "declined" }),
    });
    assert.equal(vagueDecline.status, 400, "暂不接纳必须给明确说明");
    const closed = await fetch(`${base}/wishes/${created.id}/status`, {
      method: "PATCH", headers: { cookie: boss },
      body: JSON.stringify({ status: "done", note: "已上线，可在任务页使用" }),
    });
    assert.equal(closed.status, 200);
    assert.deepEqual(await closed.json().then((body: { status: string; decision_note: string }) => ({
      status: body.status, note: body.decision_note,
    })), { status: "done", note: "已上线，可在任务页使用" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
