import { join } from "node:path";
import assert from "node:assert/strict";
import { saveKnowledgeMaterial } from "../src/knowledgeMaterials.ts";

export async function businessMaterial(root: string, text = "业务决策：为避免月底结算期间重复扣款，已结算订单不能立即取消，须走冲正流程。历史评审明确这一限制。ORIGINAL_BUSINESS_CONTEXT") {
  const material = await saveKnowledgeMaterial(join(root, "knowledge-materials"), { name: "business-decisions.txt", content_base64: Buffer.from(text).toString("base64"), version: "业务评审 v1" });
  assert.equal(material.state, "ready", material.error); return material;
}
