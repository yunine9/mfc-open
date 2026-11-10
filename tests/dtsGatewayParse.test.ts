/**
 * 单据版本字段的解析钉(#564):版本取 C 版字段 sProdCNoName——
 * 1. B 版字段缺席(单据侧回 JSON null 而非省键)不再被 String(null)
 *    产出字面量 "null" 当版本用;
 * 2. B 版在场也只认 C 版(2026-10-30 拍板:彻底切 C,B 构建号平台内
 *    不再承载,精确 B 版 DTS 门户可查);
 * 3. 两版皆缺(含空串/纯空白)返回 undefined,交给「未配置分支」
 *    禁发起如实拦,不造值。
 * 直驱 McpDtsGateway 的原始 JSON 缝:此前零覆盖(契约测试都走已解析
 * 的 mock 网关),本缺陷因此在真实单据上漏网。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { McpDtsGateway, type McpGateway } from "../src/issueFlow/gateways.ts";

/** 最小 MCP 桩:按工具名回放原始 JSON 文本。 */
class StubMcp {
  constructor(private readonly responses: Record<string, string>) {}
  toolName(_kind: string, fallback: string) {
    return fallback;
  }
  async call(name: string) {
    const text = this.responses[name];
    if (text === undefined) throw new Error(`未预期的工具调用: ${name}`);
    return { content: [{ type: "text", text }] };
  }
  async fetchWithAuth(): Promise<never> {
    throw new Error("本测试不触文件代理");
  }
}

/** 网关真实返回形状(#564 现场留存)。 */
const dtsResponse = (datas: Array<Record<string, unknown>>) =>
  JSON.stringify({ status: "success", error: null,
    result: { datas, fields: [], total: datas.length } });

function gatewayWith(responses: Record<string, string>): McpDtsGateway {
  return new McpDtsGateway(new StubMcp(responses) as unknown as McpGateway);
}

test("列表:B 版 null 的自动化单取 C 版字段,不再是字符串 \"null\"", async () => {
  const gateway = gatewayWith({ listByVersionAndHead: dtsResponse([{
    dtsBizNo: "DTS2026102952884",
    briefDesc: "【SkyEye】异常日志",
    dtsStatusName: "开发人员实施修改",
    sProdBNo: "",
    sProdBNoName: null,
    sProdCNoName: "MAE-NEM V100R027C10",
  }]) });
  const briefs = await gateway.listByOwner("developer 00000000");
  assert.equal(briefs.length, 1);
  assert.equal(briefs[0].version, "MAE-NEM V100R027C10");
});

test("列表:B 版在场也只认 C 版(彻底切 C)", async () => {
  const gateway = gatewayWith({ listByVersionAndHead: dtsResponse([{
    dtsBizNo: "DTS2026102132692",
    briefDesc: "安全测试",
    sProdBNoName: "MAE-NEM V100R027C10B041",
    sProdCNoName: "MAE-NEM V100R027C10",
  }]) });
  const briefs = await gateway.listByOwner("developer 00000000");
  assert.equal(briefs[0].version, "MAE-NEM V100R027C10");
});

test("列表:两版皆缺(null/空串/纯空白)返回 undefined,不造值", async () => {
  const gateway = gatewayWith({ listByVersionAndHead: dtsResponse([
    { dtsBizNo: "DTS1", briefDesc: "t", sProdBNoName: null, sProdCNoName: null },
    { dtsBizNo: "DTS2", briefDesc: "t", sProdBNoName: "", sProdCNoName: "   " },
  ]) });
  const briefs = await gateway.listByOwner("who");
  assert.deepEqual(briefs.map((item) => item.version), [undefined, undefined]);
});

test("详情:同一口径(sProdCNoName;C 缺席即 undefined,B 不顶替)", async () => {
  const present = gatewayWith({ batchQueryTicket: dtsResponse([{
    dtsBizNo: "DTS2026102952884",
    briefDesc: "【SkyEye】异常日志",
    sProdBNoName: null,
    sProdCNoName: "MAE-NEM V100R027C10",
  }]) });
  assert.equal(
    (await present.detail("DTS2026102952884")).version,
    "MAE-NEM V100R027C10");

  const absent = gatewayWith({ batchQueryTicket: dtsResponse([{
    dtsBizNo: "DTS9",
    briefDesc: "t",
    sProdBNoName: "MAE-NEM V100R027C10B041",
    sProdCNoName: null,
  }]) });
  assert.equal((await absent.detail("DTS9")).version, undefined);
});
