import type { IncomingMessage, ServerResponse } from "node:http";
import { KnowledgeExtractionSkills, type ExtractionKind } from "./knowledgeExtractionSkills.ts";
import { wxdoubaoConfig, callWxdoubao, WxdoubaoError } from "./wxdoubao.ts";

export async function extractionConfigurationRoute(request: IncomingMessage, response: ServerResponse, parts: string[],
  dataDir: string, operator: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<any>, json: (response: ServerResponse, status: number, value: any) => unknown) {
  try {
    if (parts[1] === "skills" && ["component", "component-analysis", "domain"].includes(parts[2])) {
      const skills = methodStore(dataDir), kind = parts[2] as ExtractionKind;
      if (request.method === "GET" && parts.length === 3) return json(response, 200, { ...skills.current(kind), can_manage: false });
      if (request.method === "POST" && [undefined, "rollback"].includes(parts[3])) {
        return json(response, 405, { error: "萃取 Skill 由平台版本维护，仅供查看；请在代码仓修改后发布" });
      }
    }
    if (parts[1] === "wxdoubao" && request.method === "GET") {
      try { wxdoubaoConfig(); return json(response, 200, { configured: true, state: "unverified", message: "已配置；实际查询时验证连接与权限" }); }
      catch (error) { return json(response, 200, { configured: false, state: "configuration", message: error instanceof WxdoubaoError ? error.message : "配置不可用" }); }
    }
    if (parts[1] === "wxdoubao" && parts[2] === "check" && request.method === "POST") {
      const controller = new AbortController();
      const close = () => controller.abort();
      response.once("close", close);
      try {
        const result = await callWxdoubao({ question: "知识库连接验证" }, { signal: controller.signal });
        return json(response, 200, { configured: true, state: result.state, message: result.state === "empty" ? "连接成功，本次查询无结果" : "连接和检索权限正常" });
      } finally { response.removeListener("close", close); }
    }
    return json(response, 404, { error: "未知萃取配置操作" });
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : "萃取配置操作失败" });
  }
}
const stores = new Map<string, KnowledgeExtractionSkills>();
function methodStore(dataDir: string) {
  let store = stores.get(dataDir);
  if (!store) { store = new KnowledgeExtractionSkills(dataDir); stores.set(dataDir, store); }
  return store;
}
