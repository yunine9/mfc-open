import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeliveryOutbox,
  parseReviewReplies,
} from "../src/deliveryOutbox.ts";

test("检视回复解析支持同行正文，并点名缺失讨论", () => {
  const parsed = parseReviewReplies([
    "[d-1] 已补判空",
    "证据在 src/a.ts:10",
    "[not-this-batch] 不应切段",
    "[d-2]", "这里无需修改，原因是平台误报",
  ].join("\n"), ["d-1", "d-2", "d-3"]);
  assert.deepEqual(parsed.replies.map((item) => item.id), ["d-1", "d-2"]);
  assert.match(parsed.replies[0].body, /not-this-batch/,
    "非本批方括号文本只是正文，不应误切");
  assert.deepEqual(parsed.missing_ids, ["d-3"]);
});

test("outbox 部分成功可恢复：成功项不重投，失败项保留重试", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-outbox-")), "outbox.jsonl");
  const outbox = new DeliveryOutbox(path);
  const one = outbox.enqueueReviewReply({
    discussion_id: "d-1", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  const duplicate = outbox.enqueueReviewReply({
    discussion_id: "d-1", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  assert.equal(duplicate.id, one.id, "同一动作入队必须幂等");
  const two = outbox.enqueueReviewReply({
    discussion_id: "d-2", body: "无需修改", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  outbox.markAttempt(one.id);
  outbox.markDelivered(one.id);
  outbox.markAttempt(two.id);
  outbox.markFailed(two.id, "HTTP 503");

  const recovered = new DeliveryOutbox(path);
  assert.deepEqual(recovered.pendingReviewReplies().map((item) => item.id),
    [two.id]);
  assert.equal(recovered.list().find((item) => item.id === one.id)?.state,
    "delivered");
  assert.equal(recovered.list().find((item) => item.id === two.id)?.attempts, 1);
  assert.match(recovered.list().find((item) => item.id === two.id)?.last_error ?? "",
    /503/);

  appendFileSync(path, '{"op":"attempt"', "utf-8");
  assert.equal(new DeliveryOutbox(path).list().length, 2,
    "崩在半行只丢该行，不能炸掉整份 outbox");
  new DeliveryOutbox(path).markAttempt(two.id);
  const repaired = new DeliveryOutbox(path);
  assert.equal(repaired.list().find((item) => item.id === two.id)?.attempts, 2,
    "下一次写入应截掉崩溃半行后继续，不能与新 JSON 粘连");
  assert.doesNotMatch(readFileSync(path, "utf-8"), /\{"op":"attempt"\{"op"/);
});

test("MR 重复 ID 不以后写覆盖先写，其他明确回复仍可解析", () => {
  const result = parseReviewReplies("[d-1] 已修复\n[d-2] 无需修改\n[d-1] 无法修复", ["d-1", "d-2"]);
  assert.deepEqual(result.duplicate_ids, ["d-1"]);
  assert.deepEqual(result.missing_ids, ["d-1"]);
  assert.deepEqual(result.replies, [{ id: "d-2", body: "无需修改" }]);
});

test("部分回复已入队时，旧讨论的回复不能拼到待发送的正文里", () => {
  const result = parseReviewReplies("[d-new] 新回复\n[d-old] 旧回复\n[d-last] 最后回复",
    ["d-new", "d-last"], ["d-new", "d-old", "d-last"]);
  assert.deepEqual(result.replies, [{ id: "d-new", body: "新回复" }, { id: "d-last", body: "最后回复" }]);
});

test("outbox 中段或完整坏行 fail-closed,不得伪装成空账继续发送", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-outbox-bad-")),
    "outbox.jsonl");
  const outbox = new DeliveryOutbox(path);
  outbox.enqueueReviewReply({
    discussion_id: "d-1", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc",
  });
  const valid = readFileSync(path, "utf-8");
  writeFileSync(path, valid + "这不是 JSON\n" + valid, "utf-8");
  assert.throws(() => new DeliveryOutbox(path).list(), /第 2 行损坏/);
  assert.throws(() => new DeliveryOutbox(path).pendingReviewReplies(),
    /第 2 行损坏/,
  "损坏时不得返回空 pending，避免宿主误以为全部已发送");
});

test("pending 回复可按当前 push SHA 过滤，旧提交不会冒充本轮已排队", () => {
  const path = join(mkdtempSync(join(tmpdir(), "mfc-outbox-sha-")),
    "outbox.jsonl");
  const outbox = new DeliveryOutbox(path);
  const old = outbox.enqueueReviewReply({
    discussion_id: "d-same", body: "旧版修复", repo: "repo", resolve: false,
    expected_sha: "a".repeat(40),
  });
  const current = outbox.enqueueReviewReply({
    discussion_id: "d-same", body: "新版修复", repo: "repo", resolve: false,
    expected_sha: "b".repeat(40),
  });
  assert.deepEqual(outbox.pendingReviewReplies("b".repeat(40))
    .map((item) => item.id), [current.id]);
  assert.ok(outbox.pendingReviewReplies().some((item) => item.id === old.id),
    "旧动作仍须留在台账，不能伪造成已发送或删除审计事实");
});

test("outbox 合法 JSON 也逐字段验真，伪 delivered 与篡改 item 均 fail-closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "mfc-outbox-schema-"));
  const path = join(dir, "outbox.jsonl");
  const outbox = new DeliveryOutbox(path);
  const item = outbox.enqueueReviewReply({
    discussion_id: "d-schema", body: "已修", repo: "repo", resolve: false,
    expected_sha: "abc123",
  });
  const enqueue = JSON.parse(readFileSync(path, "utf-8").trim());

  writeFileSync(path, JSON.stringify({
    ...enqueue, item: { ...enqueue.item, state: "delivered" },
  }) + "\n", "utf-8");
  assert.throws(() => new DeliveryOutbox(path).list(), /入队项无效/,
    "enqueue 不能自报 delivered 后跳过真实发送");

  writeFileSync(path, JSON.stringify({
    ...enqueue, item: { ...enqueue.item, id: "review-reply-forged" },
  }) + "\n", "utf-8");
  assert.throws(() => new DeliveryOutbox(path).list(), /id 与内容不匹配/,
    "稳定动作 id 必须由完整 payload 重新核验");

  writeFileSync(path, JSON.stringify(enqueue) + "\n"
    + JSON.stringify({ op: "delivered", id: item.id }) + "\n", "utf-8");
  assert.throws(() => new DeliveryOutbox(path).list(), /delivered 操作无效/,
    "缺时间的 delivered 不能把 pending 静默改成已发送");

  assert.throws(() => outbox.enqueueReviewReply({
    discussion_id: "d-no-sha", body: "已修", repo: "repo", resolve: false,
  } as any), /expected_sha/,
  "没有对应最终 SHA 的回复不得进入 outbox");
});
