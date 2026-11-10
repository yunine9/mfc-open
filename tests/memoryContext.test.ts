import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryContext, MEMORY_CONTEXT_TYPE, memoryTurnQuery } from "../src/memoryContext.ts";
import { ExtensionRunner } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js";
import { convertToLlm } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";

const user = { role: "user", content: "实现功能", timestamp: 0 };
const result = (text: string) => ({role: "toolResult", toolCallId: "call1", toolName: "bash",
  content: [{type: "text", text}], isError: false, timestamp: 0});

test("同阶段新工具证据触发召回；重复上下文复用，撤回立即从下一轮消失", async () => {
  const queries: string[] = [];
  let active = true;
  const hook = createMemoryContext({ context: () => "当前任务", search: async query => {
    queries.push(query); return query.includes("toolchain failure") ? ["m1"] : [];
  }, resolve: ids => active ? ids.map(id => ({id, text: "平台工具链经验"})) : [] });
  assert.deepEqual(await hook([user]), [user]);
  const messages = [user, result("toolchain failure")];
  const snapshot = structuredClone(messages);
  const first = await hook(messages);
  assert.equal(first.at(-1).customType, MEMORY_CONTEXT_TYPE);
  assert.equal(queries.length, 2);
  assert.deepEqual(messages, snapshot, "不改工具原文和原始历史");
  const repeated = await hook(first);
  assert.equal(repeated.filter(m => m.customType === MEMORY_CONTEXT_TYPE).length, 1);
  assert.equal(queries.length, 2, "不对相同问题重复检索");
  active = false;
  assert.deepEqual(await hook(messages), messages, "缓存 ID 每轮仍检查撤回");
  await hook([...messages, {role: "user", content: "改为另一个目标"}]);
  assert.equal(queries.length, 3);
});

test("超时继续；迟到旧查询不串入新目标，每个会话缓存隔离", async () => {
  let finish!: (ids: string[]) => void;
  let calls = 0;
  const hook = createMemoryContext({budgetMs: 5, context: () => "", search: async () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  }, resolve: ids => ids.map(id => ({id, text: id}))});
  assert.deepEqual(await hook([user]), [user], "挂起的检索不阻止模型继续");
  const newer = [{role: "user", content: "新目标"}];
  assert.deepEqual(await hook(newer), newer);
  assert.equal(calls, 1, "在途查询未结束不堆积请求");
  finish(["旧目标经验"]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await hook(newer), newer, "旧请求结果不能用于新目标");
  finish([]);
  const other = createMemoryContext({context: () => "", search: async () => [], resolve: () => []});
  assert.deepEqual(await other([user]), [user]);
});

test("失败和日志写入故障不影响工具循环；查询不包含思考或图片", async () => {
  const hook = createMemoryContext({context: () => "", search: async () => { throw Error("offline"); },
    resolve: () => [], onUse: () => { throw Error("disk full"); }});
  assert.deepEqual(await hook([user, result("stderr")]), [user, result("stderr")]);
  const query = memoryTurnQuery([user, {role: "assistant", content: [{type: "thinking", thinking: "private"}]},
    {role: "toolResult", content: [{type: "image", data: "imagebase64"}, {type: "text", text: "public log"}]}], "目标");
  assert.match(query, /public log/);
  assert.doesNotMatch(query, /private|imagebase64/);
});

test("实际 PI context runner 接入：消息可转换给模型，重复调用不污染持久历史", async () => {
  const runner: any = Object.create(ExtensionRunner.prototype);
  runner.createContext = () => ({});
  runner.emitError = (error: unknown) => { throw error; };
  const hook = createMemoryContext({context: () => "", search: async () => ["m"],
    resolve: () => [{id: "m", text: "当前记忆"}]});
  runner.extensions = [{handlers: new Map([["context", [async (event: any) => ({messages: await hook(event.messages)})]]])}];
  const history = [user, {role: "assistant", content: [{type: "toolCall", id: "call1", name: "bash", arguments: {command: "pwd"}}]}, result("工具返回")];
  for (let i = 0; i < 2; i++) {
    const outgoing = await runner.emitContext(history);
    assert.equal(outgoing.length, 4);
    const llm = convertToLlm(outgoing);
    assert.match(JSON.stringify(llm.at(-1)), /当前记忆/);
    assert.deepEqual(outgoing.slice(0, 3), history);
  }
  assert.equal(history.length, 3);
});

test("成功空结果复用，刷新可召回新记忆；独立会话各自发起查询", async () => {
  let count = 0;
  const create = () => createMemoryContext({context: () => "", refreshMs: 0,
    search: async () => { count++; return count === 1 ? [] : ["new"]; },
    resolve: ids => ids.map(id => ({id, text: "新记忆"}))});
  const first = create();
  assert.deepEqual(await first([user]), [user]);
  assert.match((await first([user])).at(-1).content, /新记忆/);
  const second = create();
  assert.match((await second([user])).at(-1).content, /新记忆/);
  assert.equal(count, 3);
});

test("默认召回预算覆盖正常的秒级语义检索，不提前丢弃有效结果", async () => {
  const usage: string[] = [];
  const hook = createMemoryContext({ context: () => "C++ 编译", search: async () => {
    await new Promise(resolve => setTimeout(resolve, 1600)); return ["ut-rule"];
  }, resolve: ids => ids.map(id => ({ id, text: "首次编译执行 UT" })), onUse: event => usage.push(event.status) });
  assert.match((await hook([user])).at(-1).content, /首次编译执行 UT/);
  assert.deepEqual(usage, ["ready"]);
});
