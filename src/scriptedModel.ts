/**
 * 剧本化假模型——真 Pi 会话的无 LLM 对拍电源(详设 §8/主 spec §15.3)。
 *
 * 实现 Anthropic Messages 的最小服务端(流式 SSE 与非流式),
 * 按对话里已出现的 tool_result 数量决定走到剧本第几幕。
 * 生产接 GLM-5.1 时只是把 models.json 的 baseUrl 换成真网关,剧本退场。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Scene {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
}

export interface ScriptedSceneContext {
  request: Record<string, any>;
  index: number;
  requestNumber: number;
}

export interface ScriptedModelOptions {
  linear?: boolean;
  /** 上下文预算测试用；包括缓存输入，保持与网关 usage 字段一致。 */
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
  /**
   * Test-fixture hook that runs before a scripted response is emitted.
   *
   * This is deliberately outside the model/tool path: orchestration tests can
   * prepare an authoritative platform/kernel fixture without teaching the fake
   * Agent to overwrite protected state. Production never constructs this
   * server, and ordinary scripted tests leave it unset.
   */
  beforeScene?: (context: ScriptedSceneContext) => void | Promise<void>;
}

type Block = Record<string, unknown>;

function countToolResults(messages: Array<Record<string, any>>): number {
  let count = 0;
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && block.type === "tool_result") count += 1;
    }
  }
  return count;
}

function sceneBlocks(scene: Scene, index: number): Block[] {
  const blocks: Block[] = [];
  if (scene.text) blocks.push({ type: "text", text: scene.text });
  if (scene.tool) {
    blocks.push({
      type: "tool_use",
      id: `scripted-${index}`,
      name: scene.tool.name,
      input: scene.tool.input ?? {},
    });
  }
  return blocks;
}

export class ScriptedModelServer {
  readonly requests: Array<Record<string, unknown>> = [];
  /** 每次请求实际服务的场景下标(诊断用:剧本游标被顶走的轨迹)。 */
  readonly served: number[] = [];
  private server?: Server;
  /** 还要吐几次网关错误(failWith 设置,吐完自动回到正常剧本)。 */
  private failuresLeft = 0;
  private failMessage = "";

  constructor(
    readonly script: Scene[],
    readonly modelId = "scripted-v1",
    /** linear=剧本跨会话顺演(每个请求推进一幕)。默认按当前对话深度
     * 选幕——那是单会话剧本的形状,新会话会从第 0 幕重演;修复环这类
     * "多会话接力"的剧本必须顺演,不然第二个会话拿到的是第一幕
     * (实测:修复会话跑去 checkout -b,报 branch already exists)。 */
    readonly options: ScriptedModelOptions = {},
  ) {}

  /** 让接下来 times 次请求以网关错误告终(测超限自愈这类失败路径)。 */
  failWith(message: string, times = 1): void {
    this.failMessage = message;
    this.failuresLeft = times;
  }

  get baseUrl(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  /** 写进任务 agent 目录的 models.json 内容;生产换 GLM 只改这里。 */
  modelsJson(provider = "maeflow"): Record<string, unknown> {
    return {
      providers: {
        [provider]: {
          baseUrl: this.baseUrl,
          api: "anthropic-messages",
          apiKey: "scripted",
          models: [{ id: this.modelId }],
        },
      },
    };
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => void (async () => {
        let body: Record<string, any>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end();
          return;
        }
        this.requests.push(body);
        // 网关级错误注入(裁判上下文超限自愈用):按次数吐真实形状的
        // 400,内网网关的原文就是这个样子——不吐 200 空回复,那会被
        // 当成"空转回合"走催办,测不到超限这条路。
        if (this.failuresLeft > 0) {
          this.failuresLeft -= 1;
          response.writeHead(400, { "content-type": "application/json" })
            .end(JSON.stringify({
              type: "error",
              error: { type: "invalid_request_error", message: this.failMessage },
            }));
          return;
        }
        let sceneIndex = 0;
        const index = Math.min(
          this.options.linear
            ? this.requests.length - 1
            : countToolResults(body.messages),
          this.script.length - 1);
        try {
          await this.options.beforeScene?.({
            request: body,
            index,
            requestNumber: this.requests.length,
          });
        } catch (error) {
          response.writeHead(500, { "content-type": "application/json" })
            .end(JSON.stringify({
              type: "error",
              error: {
                type: "scripted_fixture_error",
                message: String(error),
              },
            }));
          return;
        }
        sceneIndex = index;
        this.served.push(index);
        const scene = this.script[index];
        const blocks = sceneBlocks(scene, index);
        const stopReason = scene.tool ? "tool_use" : "end_turn";
        if (body.stream) this.stream(response, blocks, stopReason);
        else this.plain(response, blocks, stopReason);
      })());
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    // close 的回调要等存量连接全断才响:客户端 keep-alive 赖着时就
    // 永远不回来,停机本身把测试挂死。主动掐连接 + 兜底超时双保险。
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      setTimeout(resolve, 2_000).unref();
    });
  }

  private plain(
    response: import("node:http").ServerResponse,
    blocks: Block[],
    stopReason: string,
  ): void {
    const body = JSON.stringify({
      id: "msg-scripted",
      type: "message",
      role: "assistant",
      model: this.modelId,
      content: blocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: this.options.usage ?? { input_tokens: 1, output_tokens: 1 },
    });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(body);
  }

  private stream(
    response: import("node:http").ServerResponse,
    blocks: Block[],
    stopReason: string,
  ): void {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (name: string, data: unknown) => {
      response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    emit("message_start", {
      type: "message_start",
      message: {
        id: "msg-scripted", type: "message", role: "assistant",
        model: this.modelId, content: [], stop_reason: null,
        stop_sequence: null,
        usage: this.options.usage ?? { input_tokens: 1, output_tokens: 1 },
      },
    });
    blocks.forEach((block, index) => {
      if (block.type === "text") {
        emit("content_block_start", {
          type: "content_block_start", index,
          content_block: { type: "text", text: "" },
        });
        emit("content_block_delta", {
          type: "content_block_delta", index,
          delta: { type: "text_delta", text: block.text },
        });
      } else {
        emit("content_block_start", {
          type: "content_block_start", index,
          content_block: {
            type: "tool_use", id: block.id, name: block.name, input: {},
          },
        });
        emit("content_block_delta", {
          type: "content_block_delta", index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        });
      }
      emit("content_block_stop", { type: "content_block_stop", index });
    });
    emit("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: this.options.usage?.output_tokens ?? 1 },
    });
    emit("message_stop", { type: "message_stop" });
    response.end();
  }
}
