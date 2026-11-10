/**
 * 逐仓上屏的呈现派生契约(perRepo.ts,issue #5 一仓一 MR 上屏)。
 *
 * 口径钉在这里,组件只渲染:数据侧没有"变更仓"标记字段,呈现层认的
 * 唯一交付事实是推送账(有推送记录=变更仓;没有=未交付)。流水线徽标
 * 只认 pipelines 里该仓的 status,记录缺席就不出徽标——前端不推断状态,
 * 这些判据换了实现也必须仍然成立。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  repoDeliveryRows,
  repoName,
  repoPipelineBadge,
  repoRole,
  splitDiffByRepo,
} from "../web/src/issues/perRepo.ts";

test("展示名取地址末段去 .git,与克隆目录取名同源", () => {
  assert.equal(repoName("https://codehub.example.com/group/media-center.git"),
    "media-center");
  assert.equal(repoName("https://codehub.example.com/group/play-core/"),
    "play-core");
  assert.equal(repoName("repo"), "repo");
});

test("多仓全账:每个仓一行,各带各的推送/MR/流水线事实", () => {
  const rows = repoDeliveryRows({
    repo_urls: [
      "https://codehub.example.com/g/media-center.git",
      "https://codehub.example.com/g/play-core.git",
    ],
    pushes: [{
      repo: "https://codehub.example.com/g/media-center.git",
      branch: "master_z1001_DTS123", sha: "abcdef1234567890", at: "t1",
    }],
    mrs: [{
      repo: "https://codehub.example.com/g/media-center.git",
      branch: "master_z1001_DTS123", title: "[DTS123] 修黑屏",
      url: "https://codehub.example.com/g/media-center/-/merge_requests/7",
      iid: "7", at: "t2",
    }],
    pipelines: {
      "https://codehub.example.com/g/media-center.git": {
        sha: "abcdef1234567890", status: "failed", watching: false,
        last_error: "编译失败", round: 1,
        checks: [
          { dimension: "COMPILE", status: "failed" },
          { dimension: "UT", status: "success" },
          { dimension: "CODECHECK", status: "failed", job: "lint-1" },
        ],
      },
    },
  });
  assert.equal(rows.length, 2);
  const [delivered, untouched] = rows;
  assert.equal(delivered.name, "media-center");
  assert.equal(delivered.delivered, true);
  assert.equal(delivered.push?.branch, "master_z1001_DTS123");
  assert.equal(delivered.mr?.iid, "7");
  assert.equal(delivered.pipeline?.status, "failed");
  // 失败项只取 status=failed 的检查项,文案用 API 原文。
  assert.deepEqual(delivered.pipeline?.failedChecks,
    ["COMPILE", "CODECHECK · lint-1"]);
  assert.equal(repoRole(delivered).tag, "变更仓");
  assert.equal(repoPipelineBadge(delivered)?.tone, "failed");

  // 没有任何账的关联仓:未交付,不出流水线徽标。
  assert.equal(untouched.name, "play-core");
  assert.equal(untouched.delivered, false);
  assert.equal(untouched.push, undefined);
  assert.equal(untouched.mr, undefined);
  assert.equal(untouched.pipeline, undefined);
  assert.equal(repoRole(untouched).tag, "未交付");
  assert.equal(repoPipelineBadge(untouched), undefined);
});

test("旧会话单仓形状(服务端 loadState 迁移后):单仓单行,照常成卡", () => {
  const rows = repoDeliveryRows({
    repo_url: "https://codehub.example.com/g/solo.git",
    repo_urls: ["https://codehub.example.com/g/solo.git"],
    pushes: [{
      repo: "https://codehub.example.com/g/solo.git",
      branch: "master_z1001_DTS9", sha: "1234567890abcdef", at: "t",
    }],
    mrs: [{
      repo: "https://codehub.example.com/g/solo.git",
      branch: "master_z1001_DTS9", title: "[DTS9] 修复", at: "t",
    }],
    pipelines: {
      "https://codehub.example.com/g/solo.git": {
        sha: "1234567890abcdef", status: "success", watching: false, round: 1,
      },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].delivered, true);
  assert.equal(repoPipelineBadge(rows[0])?.label, "流水线通过");
  // 没有 url 的 MR:行还在,链接交给组件降级成文本。
  assert.equal(rows[0].mr?.url, undefined);
});

test("转正生成的新会话:只继承登记仓、没有任何交付账——全部如实显示未交付", () => {
  const rows = repoDeliveryRows({
    repo_urls: [
      "https://codehub.example.com/g/media-center.git",
      "https://codehub.example.com/g/play-core.git",
    ],
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => !row.delivered));
  assert.ok(rows.every((row) => repoPipelineBadge(row) === undefined));
  assert.ok(rows.every((row) => repoRole(row).tag === "未交付"));
});

test("账里出现登记清单之外的仓也不丢账:追加在尾部", () => {
  const rows = repoDeliveryRows({
    repo_urls: ["https://codehub.example.com/g/a.git"],
    pushes: [{
      repo: "https://codehub.example.com/g/b.git",
      branch: "x", sha: "s", at: "t",
    }],
  });
  assert.deepEqual(rows.map((row) => row.name), ["a", "b"]);
  assert.equal(rows[1].delivered, true);
});

test("流水线徽标只认 status 字段;预算耗尽(running+last_error)不硬造终态", () => {
  const make = (watch: {
    status: "running" | "success" | "failed";
    last_error?: string;
  }) => repoDeliveryRows({
    repo_urls: ["https://codehub.example.com/g/a.git"],
    pushes: [{ repo: "https://codehub.example.com/g/a.git",
      branch: "x", sha: "s", at: "t" }],
    pipelines: { "https://codehub.example.com/g/a.git":
      { sha: "s", watching: false, round: 1, ...watch } },
  })[0];
  assert.equal(repoPipelineBadge(make({ status: "running" }))?.tone, "running");
  assert.equal(repoPipelineBadge(make({ status: "success" }))?.label, "流水线通过");
  // 监看停了但 status 还是 running:徽标照字段出,错误原文并行呈现。
  const exhausted = make({ status: "running", last_error: "轮询预算耗尽,请人工查看流水线" });
  assert.equal(repoPipelineBadge(exhausted)?.tone, "running");
  assert.equal(exhausted.pipeline?.last_error, "轮询预算耗尽,请人工查看流水线");
});

test("聚合 diff 按服务端分段标记切成逐仓片段", () => {
  const merged = [
    "===== 仓库 a =====",
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "+hello",
    "===== 仓库 b =====",
    "diff --git a/y.ts b/y.ts",
    "--- a/y.ts",
    "+++ b/y.ts",
    "+world",
  ].join("\n");
  const sections = splitDiffByRepo(merged);
  assert.deepEqual(sections.map((section) => section.name), ["a", "b"]);
  assert.match(sections[0].diff, /^\+hello$/m);
  assert.doesNotMatch(sections[0].diff, /仓库/);
  assert.match(sections[1].diff, /^\+world$/m);
});

test("空 diff 没有分段;无标记的原文整段兜底(名字留空)", () => {
  assert.deepEqual(splitDiffByRepo(""), []);
  assert.deepEqual(splitDiffByRepo("   \n  "), []);
  const bare = "diff --git a/x.ts b/x.ts\n+hi";
  const sections = splitDiffByRepo(bare);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, "");
  assert.equal(sections[0].diff, bare);
});
