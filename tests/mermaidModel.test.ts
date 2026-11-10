import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMermaidFlow } from "../web/src/mermaidModel.ts";

test("Mermaid flowchart:仓库节点、换行标签与依赖原因都能读出", () => {
  const model = parseMermaidFlow(`flowchart LR
  API[service-api<br/>状态接口与契约] -->|契约稳定后联调| WEB[web-console<br/>工作台状态展示]`)!;
  assert.equal(model.direction, "LR");
  assert.deepEqual(model.nodes, [
    { id: "API", label: "service-api\n状态接口与契约" },
    { id: "WEB", label: "web-console\n工作台状态展示" },
  ]);
  assert.deepEqual(model.edges, [{
    from: "API", to: "WEB", label: "契约稳定后联调", dashed: false,
  }]);
});

test("非流程类 Mermaid 不猜画，交给源码兜底", () => {
  assert.equal(parseMermaidFlow("sequenceDiagram\nA->>B: hello"), undefined);
});

