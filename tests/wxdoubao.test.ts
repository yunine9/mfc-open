import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { callWxdoubao, decodeWxdoubao, wxdoubaoConfig, WxdoubaoError, wxdoubaoTool } from "../src/wxdoubao.ts";

const raw = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: 3, result });
test("无线豆包区分业务鉴权失败、无数据和带定位信息的知识", () => {
  assert.throws(() => decodeWxdoubao(raw({ content: [{ type: "text", text: "WxDouBaoToken和userId输入不匹配" }], isError: false })), (e: WxdoubaoError) => e.code === "authentication");
  assert.equal(decodeWxdoubao(raw({ structuredContent: { code: 200, data: {}, message: "未找到" }, isError: false })).state, "empty");
  const data = [{ filename: "规则", chapterpath: "状态", content: "校验后提交", url: "https://example.test/doc" }];
  assert.deepEqual(decodeWxdoubao(raw({ content: [{ type: "text", text: JSON.stringify(data) }] })), { state: "available", data });
  assert.throws(() => decodeWxdoubao(raw({ structuredContent: { code: 403 }, isError: false })), /权限和参数/);
  assert.throws(() => decodeWxdoubao(raw({ isError: true })), /执行失败/);
  assert.throws(() => decodeWxdoubao("SSE 未处理"), /JSON/);
});
test("无线豆包不使用内置账户和令牌，路径必须明确", () => {
  assert.throws(() => wxdoubaoConfig({}), /用户和令牌/);
  assert.throws(() => wxdoubaoConfig({ MAE_FLOW_WXDOUBAO_BIN: "wxdoubao" }), /绝对路径/);
});
test("CLI 保留参数边界、使用环境凭据且取消实际子进程", async () => {
  const root = mkdtempSync(join(tmpdir(), "wxdoubao-test-")), executable = join(root, "cli");
  const config = { executable, userId: "fixture-user", token: "fixture-secret-value", timeoutMs: 1500 };
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst args=process.argv.slice(2); if(args.includes(process.env.WXDOUBAO_TOKEN)) process.exit(1); console.log(JSON.stringify({result:{structuredContent:{code:200,data:{args,user:process.env.WXDOUBAO_USERID}}}}));`, { mode: 0o700 });
    const question = '引号 " ; $(echo injected)';
    const result = await callWxdoubao({ question, sources: "  " }, { config });
    const data = (result.data as any).data;
    assert.equal(data.user, "fixture-user");
    assert.deepEqual(JSON.parse(data.args[data.args.indexOf("--json") + 1]), { question });
    assert.ok(data.args.includes("--raw"));
    assert.equal(data.args[data.args.indexOf("call") + 1], "knowledge_search", "只调用知识检索");
    await assert.rejects(callWxdoubao({ question: "状态", ar_code: "AR123" }, { config }), /不支持的参数/);
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`, { mode: 0o700 });
    const controller = new AbortController();
    const pending = callWxdoubao({ question: "状态" }, { config, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, (e: WxdoubaoError) => e.code === "cancelled");
    writeFileSync(executable, `#!${process.execPath}\nconsole.error(process.env.WXDOUBAO_TOKEN); process.exit(3);`, { mode: 0o700 });
    await assert.rejects(callWxdoubao({ question: "状态" }, { config }), (e: Error) => !e.message.includes(config.token) && /连接/.test(e.message));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("参数错误可一次定位，失败证据不保存正文或未知字段名", async () => {
  const events: Record<string, unknown>[] = [];
  const tool = wxdoubaoTool(new AbortController().signal, event => events.push(event));
  for (const [input, expected] of [
    [{ question: " " }, /缺少必填参数 question/],
    [{}, /缺少必填参数 question/],
    [{ question: "private-query", ar_code: "private-ar" }, /不支持的参数.*question、sources/],
    [{ question: "private-query", sources: 123 }, /sources 必须是字符串/],
    [{ question: "private-query", "private-field": "private-value" }, /不支持的参数/],
  ] as const) {
    const result = await tool.execute("invalid", input, undefined, undefined, {} as never);
    assert.equal((result as typeof result & { isError?: boolean }).isError, true);
    assert.equal(result.content[0].type, "text");
    if (result.content[0].type === "text") assert.match(result.content[0].text, expected);
  }
  assert.doesNotMatch(JSON.stringify(events), /private-/);
  assert.equal(events[0].error_code, "arguments");
  assert.deepEqual(events[0].arguments, { fields: { question: "empty" }, unknown_field_count: 0 });
  assert.deepEqual(events[2].arguments, { fields: { question: "string" }, unknown_field_count: 1 });
  assert.equal((events[4].arguments as any).unknown_field_count, 1);
});
