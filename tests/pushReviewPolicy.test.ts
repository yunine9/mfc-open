import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pushReviewCallId,
  hasPushApproval,
} from "../src/pushReviewPolicy.ts";

test("推送确认不绑定历史文件集合；明确返工不会复用旧确认", () => {
  assert.equal(hasPushApproval({ status: "confirmed" }), true);
  assert.equal(hasPushApproval({ status: "requested" }), false);
  assert.equal(hasPushApproval(undefined), false);
});

test("已有人工决定是确认依据；最新返工覆盖旧清单的 confirmed 状态", () => {
  const decision = { step: "cloud_push_confirm", status: "resolved" as const,
    waiting_id: "one", resolved_at: "2026-09-23T01:00:00Z", decision: "确认推送" };
  assert.equal(hasPushApproval(undefined, [decision]), true);
  const adjust = { ...decision, waiting_id: "two", resolved_at: "2026-09-23T02:00:00Z", decision: "需要调整代码" };
  assert.equal(hasPushApproval({ status: "confirmed" }, [adjust, decision]), false);
  assert.equal(hasPushApproval({ status: "requested" }, [decision]), true);
});

test("同范围的卡键不因 HEAD 换卡，明确返工才开新轮", () => {
  const snapshot = { head: "head-a", paths: ["src/a.ts"] };
  assert.equal(pushReviewCallId(snapshot), pushReviewCallId(snapshot));
  assert.equal(pushReviewCallId(snapshot), pushReviewCallId({
    ...snapshot, head: "head-b",
  }));
  assert.notEqual(pushReviewCallId(snapshot, "round-1"),
    pushReviewCallId(snapshot, "round-2"));
});

// ── 2026-09-06 绞杀第三块:push 前确认与交付范围的决策表 ──────────────
import {
  deliveryScopeViolations, describeDirtyPaths, listedPaths, pathWithinScope,
  pushReviewPolicyFor, pushWaitingDetail,
  scopeViolationDetail,
} from "../src/pushReviewPolicy.ts";

const policyInput = {
  reviewSource: undefined, workspaceRecheckRequired: undefined,
  unresolvedAnnotations: 0, taskSetting: undefined,
  accountDefault: () => undefined,
} as const;

test("要不要人过目:三个来源任一成立;任务级设置压过个人默认,且在时不查个人默认", () => {
  assert.equal(pushReviewPolicyFor({ ...policyInput }).required, false);
  assert.equal(pushReviewPolicyFor({ ...policyInput, accountDefault: () => true }).ordinaryReviewEnabled, true);
  let asked = 0;
  const p = pushReviewPolicyFor({ ...policyInput, taskSetting: false,
    accountDefault: () => { asked += 1; return true; } });
  assert.equal(p.ordinaryReviewEnabled, false, "任务级关掉就是关掉");
  assert.equal(asked, 0, "任务级设置在时不查个人默认(保住原来的短路)");
  assert.equal(pushReviewPolicyFor({ ...policyInput, taskSetting: false, unresolvedAnnotations: 2 }).required, true,
    "未闭环人工意见是安全例外,全自动吞不掉");
  const recheck = pushReviewPolicyFor({ ...policyInput, taskSetting: false,
    reviewSource: "workspace", workspaceRecheckRequired: true });
  assert.equal(recheck.recheckRequired, true);
  assert.equal(pushReviewPolicyFor({ ...policyInput, reviewSource: "platform", workspaceRecheckRequired: true }).recheckRequired,
    false, "只有工作台意见返工才算复检");
});

test("给人看的话:等待文案、脏路径与越界清单的截断", () => {
  assert.equal(pushWaitingDetail(false, 3), "等待确认推送");
  assert.equal(pushWaitingDetail(true, 2), "等待 2 条检视意见由提出人确认");
  assert.equal(pushWaitingDetail(true, 0), "检视意见已闭环，等待责任人确认推送");
  assert.equal(describeDirtyPaths(["a", "b"]), "a、b");
  assert.equal(describeDirtyPaths(["1", "2", "3", "4", "5", "6", "7"]), "1、2、3、4、5 等 7 个路径");
  const many = Array.from({ length: 23 }, (_, i) => `f${i}`);
  assert.ok(listedPaths(many).endsWith(" 等 23 个"));
  assert.equal(listedPaths(["x"]), "x");
});

test("越界判定:前缀按路径段闭合、豁免与流程规格不算;裁决话术点名外来提交", () => {
  assert.ok(pathWithinScope("src/filter/A.java", ["src/filter"]));
  assert.ok(pathWithinScope("src/filter", ["src/filter/"]), "尾斜杠不影响");
  assert.ok(!pathWithinScope("src/filterX/B.java", ["src/filter"]), "裸 startsWith 会把邻居目录错认成面内");
  const violations = deliveryScopeViolations({
    committed: ["docs/specs/index.md", "src/filter/A.java", "src/filterX/B.java", "pom.xml"],
    scopePaths: ["src/filter"], exempt: new Set(["pom.xml"]),
    processArtifact: (path) => path.startsWith("docs/specs/"),
  });
  assert.deepEqual(violations, ["src/filterX/B.java"]);
  const detail = scopeViolationDetail("接口模块", "src/filterX/B.java", 2);
  assert.match(detail, /^本单元\(接口模块\)的提交改动越出负责文件面:src\/filterX\/B\.java。/);
  assert.match(detail, /本分支上有 2 条别人直接推的提交/);
  assert.doesNotMatch(scopeViolationDetail("接口模块", "x", 0), /别人直接推/);
});
