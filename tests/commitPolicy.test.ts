import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cloudCommitSubject,
  commitHookRejection,
  rejectedCommitSha,
  repairedPlatformCommitSubject,
  validTaskCommitSubject,
  validPlatformCommitSubject,
} from "../src/commitPolicy.ts";

test("CodeHub 默认提交标题契约覆盖业务、平台整理和允许的 merge", () => {
  for (const subject of [
    "[REQ20260727638229][feat]新增部署接口",
    "[REQ_PREPUSH][fix]prepush compile issue",
    "[DTS_123][fix]修复空指针",
    "[REQ1][chore]按交付清单整理提交",
    "Merge remote-tracking branch 'origin/master' into master_bot_REQ1",
    "merge 'dev' into 'master'",
    "Merge branch 'topic' of https://code.example/repo into master",
    "Merge branch 'topic' of https://code.example/repo",
  ]) assert.equal(validPlatformCommitSubject(subject), true, subject);

  for (const subject of [
    "fix: compile",
    "chore: 整理交付清单",
    "Merge branch 'master' into master_bot_REQ1",
    "init",
  ]) assert.equal(validPlatformCommitSubject(subject), false, subject);
});

test("Cloud 生成和修复的标题天然满足同一机器规则", () => {
  assert.equal(
    cloudCommitSubject("REQ-123", "fix", "整理最终清单"),
    "[REQ_123][fix]整理最终清单",
  );
  assert.equal(
    repairedPlatformCommitSubject("REQ123", "fix: prepush compile issue"),
    "[REQ123][fix]prepush compile issue",
  );
  assert.equal(validPlatformCommitSubject(
    repairedPlatformCommitSubject("task-36", "随手写的标题")), true);
  assert.equal(validTaskCommitSubject("[REQ1][feat]新增能力"), true);
  assert.equal(validTaskCommitSubject("[REQ1][fix]整理最终清单"), true);
  assert.equal(validTaskCommitSubject("[REQ1][chore]整理最终清单"), false,
    "CodeHub 虽接受 chore，Mae-Flow 任务契约仍只允许 feat/fix");
  assert.equal(repairedPlatformCommitSubject("REQ1", "chore: 整理最终清单"),
    "[REQ1][fix]整理最终清单");
});

test("识别远端项目 Hook 拒绝并提取提交 SHA", () => {
  const message = "remote: Deny by project hooks setting 'default': message of commit "
    + "'147d36e677cc70e537ce17efdf88d207bd72c735' does not match the regular-expression";
  assert.equal(commitHookRejection(message), true);
  assert.equal(rejectedCommitSha(message),
    "147d36e677cc70e537ce17efdf88d207bd72c735");
});
