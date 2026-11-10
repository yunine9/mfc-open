import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializeTaskKnowledgeIndex } from "../src/taskKnowledgeIndex.ts";

test("统一知识索引只给摘要与路径，业务正文不进入索引", () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-task-knowledge-index-"));
  const businessPath = join(workspace, ".mae-flow-work", "business", "refund.md");
  mkdirSync(join(workspace, ".mae-flow-work", "business"), { recursive: true });
  writeFileSync(businessPath, "BUSINESS-BODY-MUST-NOT-BE-IN-INDEX\n");

  const index = materializeTaskKnowledgeIndex({
    workspace,
    businessKnowledge: [{
      id: "module:orders:refund:v2",
      module_id: "orders", module_name: "订单模块", module_owner: "owner-a",
      title: "退款边界", summary: "说明退款状态与业务边界",
      when_to_use: "修改退款流程或状态机时", form: "document",
      repositories: [], version: 2, digest: "business-digest",
      relative_path: ".mae-flow-work/business/refund.md", path: businessPath,
    }],
  });

  assert.deepEqual(index.warnings, []);
  assert.ok(index.path);
  assert.match(index.content!, /## 业务模块知识/);
  assert.match(index.content!, /退款边界/);
  assert.match(index.content!, /修改退款流程或状态机时/);
  assert.doesNotMatch(index.content!, /BUSINESS-BODY-MUST-NOT-BE-IN-INDEX/);
  assert.doesNotMatch(index.content!, /代码仓自带知识/,
    "代码仓 docs 不属于平台知识索引");
  assert.equal(readFileSync(index.path!, "utf-8"), index.content);
  assert.equal(statSync(index.path!).mode & 0o777, 0o440);
});

test("正文不在 Agent 工作区时明确跳过，不泄露外部路径", () => {
  const root = mkdtempSync(join(tmpdir(), "mfc-task-knowledge-outside-"));
  const workspace = join(root, "repo");
  const outside = join(root, "outside.md");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(outside, "OUTSIDE-SECRET\n");
  const index = materializeTaskKnowledgeIndex({
    workspace,
    businessKnowledge: [{
      id: "outside", title: "越界知识", summary: "不应进入索引",
      when_to_use: "永不", form: "document", module_id: "orders", module_name: "订单", module_owner: "owner",
      repositories: [], version: 1, digest: "outside",
      relative_path: "outside.md", path: outside,
    }],
  });
  assert.equal(index.path, undefined);
  assert.match(index.warnings.join("\n"), /不在当前 Agent 工作区/);
  assert.doesNotMatch(index.warnings.join("\n"), /OUTSIDE-SECRET/);
});
