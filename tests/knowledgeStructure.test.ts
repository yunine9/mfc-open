import { test } from "node:test";
import assert from "node:assert/strict";
import { knowledgeHeadings, knowledgeHeadingTree, knowledgeAnchorLine, resolveKnowledgeReference } from "../web/src/knowledgeStructure.ts";

test("知识结构按章节层级组织，代码中的标题不进入目录", () => {
  const source = "# 订单\n## 取消边界\n### 支付后\n~~~md\n## 假标题\n~~~\n## 取消边界\n```md\n# 另一个假标题\n```";
  const tree = knowledgeHeadingTree(source);
  assert.deepEqual(tree.map(h => h.title), ["取消边界", "取消边界"]);
  assert.equal(tree[0].children[0].title, "支付后");
  assert.equal(knowledgeAnchorLine(source, "取消边界-1"), 7);
  assert.equal(knowledgeHeadings(source).length, 4);
  assert.equal(knowledgeAnchorLine('~~~\n<a id="fake"></a>\n~~~\n<a id="real"></a>', "fake"), undefined);
  assert.equal(knowledgeAnchorLine('<a id="real"></a>', "real"), 1);
});

test("知识引用仅匹配同一目标中已萃取的文档，保留中文章节锚点", () => {
  const current = { id: "a", path: "docs/rules/a.md", target_id: "domain" };
  const next = { id: "b", path: "docs/b.md", target_id: "domain" };
  const other = { ...next, id: "other", target_id: "repo" };
  assert.deepEqual(resolveKnowledgeReference([current, other, next], current, "../b.md#取消边界"), { item: next, anchor: "取消边界" });
  assert.deepEqual(resolveKnowledgeReference([current], current, "#%E8%AE%A2%E5%8D%95"), { item: current, anchor: "订单" });
  for (const href of ["https://example.com", "//example.com", "javascript:alert(1)", "../../../b.md", "../missing.md", "%FF"]) assert.equal(resolveKnowledgeReference([current, next], current, href), undefined);
  assert.equal(resolveKnowledgeReference([current, other], current, "../b.md"), undefined);
});
