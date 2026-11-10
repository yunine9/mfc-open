/**
 * 工作台修复轮中途的确认卡是内部节点(隔壁 Agent 2026-09-04 的状态机分析):
 * 回执此刻已在盘上,平台先读先记、自动过节点;人的验收只在最终推送卡。
 * 真歧义题、或还有别的未闭环意见时照旧留给人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskService } from "../src/taskService.ts";

function kernelWithInspect(): string {
  const kernelRoot = mkdtempSync(join(tmpdir(), "mfc-node-kernel-"));
  mkdirSync(join(kernelRoot, "flow"));
  writeFileSync(join(kernelRoot, "flow", "flow.json"), JSON.stringify({
    steps: {
      inspect: {
        approval_subject: { kind: "worktree" },
        confirmation_answers: ["修改范围无需再调整，确认进入编码"],
        next: "build",
      },
      build: { clear_hint: true },
    },
  }));
  return kernelRoot;
}

test("修复轮中途举卡:读回执、认出确认项就自动交卷;歧义题和别的未闭环意见留给人", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-review-node-"));
  const notified: Array<{ account: string; status: string }> = [];
  const service = new TaskService({
    dataDir, provider: "test", model: "test", modelsJson: {}, maxConcurrent: 0,
    host: { kernelRoot: kernelWithInspect(), repoPath: "/unused" } as any,
    notifier: { notifyOutcome: async (input: any) => { notified.push(input); } } as any,
  });
  try {
    const id = service.create("处理空值", { account: "owner" }).id;
    const internal = (service as any).tasks.get(id);
    const store = (service as any).annotations(internal);
    const first = store.add({
      author: "reviewer-a", artifact: "本任务变更", file: "src/a.ts", line: 3,
      anchor: "return x", note: "空值要处理", kind: "code",
    });
    const second = store.add({
      author: "reviewer-b", artifact: "本任务变更", file: "src/b.ts", line: 9,
      anchor: "loop", note: "补边界测试", kind: "code",
    });
    store.markSent([first.id, second.id], "review_repair");
    internal.summary.delivery = { loop: {
      round: 0, max: 3, state: "repairing", kind: "review",
      review_source: "workspace", workspace_review_recheck_required: true,
      workspace_review_annotation_ids: [first.id, second.id],
    } };
    const reviews = join(internal.summary.workspace, "reviews");
    mkdirSync(reviews, { recursive: true });
    writeFileSync(join(reviews, "local-receipts.json"), JSON.stringify({ receipts: [
      { annotation_id: first.id, revision: 0, outcome: "needs_clarification",
        summary: "空值指的是入参还是返回值？", evidence: [] },
      { annotation_id: second.id, revision: 0, outcome: "fixed",
        summary: "已补边界测试", evidence: ["src/b.ts:9"] },
    ] }));
    const card = (questions: unknown[], step = "inspect") => {
      internal.summary.waiting = {
        waiting_id: `${id}:c`, task_id: id, step, call_id: "c",
        question: { questions }, state_version: 1, status: "waiting",
        decision: "", notes: "", created_at: "", resolved_at: "",
      };
      internal.summary.status = "waiting_for_human";
    };

    // 内核确认节点:认契约里的确认项;回执当场登记,追问通知作者。
    card([{ question: "修改范围是否确认?",
      options: ["修改范围无需再调整，确认进入编码", "需要调整范围（按当前检视意见修改）"] }]);
    const kernelNode = await (service as any).workspaceReviewNodeAnswer(internal);
    assert.deepEqual(kernelNode?.answers,
      { "修改范围是否确认?": "修改范围无需再调整，确认进入编码" });
    assert.match(kernelNode.notes, /每条意见仍需任务责任人逐条处置/);
    assert.match(kernelNode.why, /1 条需意见作者补充说明/);
    const after = service.listAnnotations(id).items;
    assert.equal(after.find((item) => item.id === second.id)?.response?.outcome, "fixed",
      "卡开着时回执就已登记,面板能按回执显示");
    assert.deepEqual(notified.map((row) => [row.account, row.status]),
      [["reviewer-a", "review_clarification"]]);

    // 模型自造的"检视结果确认"卡:按措辞认确认项。
    card([{ question: "9 条意见已全部闭环,是否确认?", options: ["确认", "需要调整"] }],
      "no_such_step");
    const modelNode = await (service as any).workspaceReviewNodeAnswer(internal);
    assert.equal(modelNode?.answers["9 条意见已全部闭环,是否确认?"], "确认");

    // 真歧义题:认不出确认项,留给人。
    card([{ question: "空值按入参处理还是按返回值处理?", options: ["入参", "返回值"] }],
      "no_such_step");
    assert.equal(await (service as any).workspaceReviewNodeAnswer(internal), undefined);

    // 责任人自己还有草稿:不是修复轮的账,留给人处理。
    card([{ question: "修改范围是否确认?",
      options: ["修改范围无需再调整，确认进入编码", "需要调整范围（按当前检视意见修改）"] }]);
    store.add({ author: "owner", artifact: "本任务变更", file: "src/c.ts", line: 1,
      anchor: "x", note: "责任人草稿", kind: "code" });
    assert.equal(await (service as any).workspaceReviewNodeAnswer(internal), undefined);
  } finally {
    // 无并发额度的服务没有会话可停。
  }
});
