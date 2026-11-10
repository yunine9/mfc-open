/**
 * 问题流的 MCP 网关客户端(最小实现 + 留缝)。
 *
 * 背景:Pi 运行时按设计不带 MCP(README:"No MCP"),问题流的
 * "AI 调 DTS-MCP / Codehub-MCP" 因此走宿主桥——平台在宿主侧终结
 * MCP 协议,以会话工具的形态把能力递给 Agent。好处是 x-auth-token
 * 止步于宿主进程,不进容器、不进模型上下文、不进事件流。
 *
 * 【遗留事项(用户待提供后接线)】DTS MCP 的 URL 与工具名尚未给出。
 * 本模块把协议实现好、把配置面留成显式注入,未配置时 fail-loud
 * (人话报错),绝不静默假装成功。
 *
 * 协议形态:streamable HTTP(JSON-RPC 2.0 over HTTP POST,响应可能
 * 是 application/json 单体,也可能回 text/event-stream 流)。初始化
 * 握手(initialize → notifications/initialized)按需建立,服务端返回
 * 的 Mcp-Session-Id 在后续请求回带;会话过期按一次性重试处理。
 */

// 错误类型住 errors.ts(#9 集中声明):本模块只负责抛,码由路由层的
// toHttpError 单点译出。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { DtsGatewayUnconfiguredError, McpGatewayError } from "./errors.ts";

export interface McpGatewayConfig {
  url: string;
  /** 静态 token(与 tokenProvider 二选一)。 */
  token?: string;
  /** 动态 token 读取函数:每次请求调用,token 文件轮换后无需重启。
   * 优先级:tokenProvider > token;都未提供时请求不携带 x-auth-token。 */
  tokenProvider?: () => string;
  /** 能力 → 工具名。真实工具名待 DTS 集成时对拍;缺省给常用名。 */
  toolNames?: Record<string, string>;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class McpGateway {
  private mcpSessionId?: string;
  private ready = false;
  private callSeq = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: McpGatewayConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  toolName(capability: string, fallback: string): string {
    return this.config.toolNames?.[capability] ?? fallback;
  }

  /** 用 MCP 网关同源 token 请求 DTS 域的文件(如问题单描述里的图片),
   * 返回二进制与 MIME。描述内嵌图是内网地址且无 cookie 可带,浏览器
   * 直连必跨域失败——由后端代理一次,AI 会话页才有完整现场。 */
  async fetchWithAuth(url: string): Promise<{ data: Buffer; contentType: string }> {
    const headers: Record<string, string> = {};
    const token = this.currentToken();
    if (token) headers["x-auth-token"] = token;
    const response = await this.fetchImpl(url, { headers });
    if (!response.ok) {
      throw new McpGatewayError(
        `DTS 文件代理 HTTP ${response.status}: ${url}`);
    }
    const contentType = response.headers.get("content-type")
      ?? "application/octet-stream";
    const arrayBuf = await response.arrayBuffer();
    return { data: Buffer.from(arrayBuf), contentType };
  }

  // token 每次请求现取现用:provider 在场优先,文件轮换后无需重启;
  // 为空时不设头(而非报错),无认证网关也能走同一条路。
  private currentToken(): string | undefined {
    if (this.config.tokenProvider) return this.config.tokenProvider();
    return this.config.token;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      // streamable HTTP 觅音:两种响应形态都要声明可收。
      accept: "application/json, text/event-stream",
    };
    const token = this.currentToken();
    if (token) headers["x-auth-token"] = token;
    if (this.mcpSessionId) headers["mcp-session-id"] = this.mcpSessionId;
    return headers;
  }

  /** 单次 HTTP 往返:JSON 体直接解,SSE 体读首个带匹配 id 的 data 帧。 */
  private async post(body: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(this.config.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const sessionHeader = response.headers.get("mcp-session-id");
      if (sessionHeader) this.mcpSessionId = sessionHeader;
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new McpGatewayError(
          `MCP 网关 HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        return await this.readSseResponse(response, body);
      }
      const text = await response.text();
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new McpGatewayError(`MCP 网关返回非 JSON: ${text.slice(0, 400)}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSseResponse(
    response: Response,
    request: unknown,
  ): Promise<JsonRpcResponse> {
    const wantId = (request as { id?: number | string }).id;
    const reader = response.body?.getReader();
    if (!reader) throw new McpGatewayError("MCP 网关 SSE 无响应体");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n\n");
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = frame.split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("");
        if (data) {
          try {
            const parsed = JSON.parse(data) as JsonRpcResponse;
            if (parsed.id !== undefined && parsed.id === wantId) {
              return parsed;
            }
          } catch {
            // 非 JSON 帧通知(心跳/进度)继续读。
          }
        }
        cut = buffer.indexOf("\n\n");
      }
    }
    throw new McpGatewayError("MCP 网关 SSE 流结束仍未等到应答");
  }

  private async rpc(
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const id = ++this.callSeq;
    const reply = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
    if (reply.error) {
      throw new McpGatewayError(
        `MCP ${method} 失败(${reply.error.code ?? "?"}): `
        + String(reply.error.message ?? "").slice(0, 400));
    }
    return reply.result;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mae-flow-cloud-issue-flow", version: "1" },
    }, 30_000);
    await this.post({
      jsonrpc: "2.0", method: "notifications/initialized",
    }, 15_000).catch(() => undefined);
    this.ready = true;
  }

  /** tools/call,返回 MCP 结果。会话过期只重试一次(重建握手)。 */
  async call(
    tool: string,
    args: Record<string, unknown>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    // 华为 MCP 网关把 Java 方法参数映射成 arg0/arg1/... 且不保留参数
    // 名(实测:命名参数传过去被丢弃为 null,见 docs/mcp-dynamic-token-
    // and-healthcheck.md),所以按 Object.entries 的声明顺序补一份
    // argN;原始命名参数同时保留——标准 MCP 网关忽略 argN 不受影响。
    // **顺序敏感**:调用方必须按工具文档的参数顺序传参(JS 对象保持
    // 插入序),排错位等于传错值。
    const argN: Record<string, unknown> = {};
    const entries = Object.entries(args);
    for (let i = 0; i < entries.length; i++) {
      argN[`arg${i}`] = entries[i][1];
    }
    const arguments_ = { ...args, ...argN };
    try {
      await this.ensureReady();
      return await this.rpc("tools/call", { name: tool, arguments: arguments_ }, timeoutMs);
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const sessionLost = /404|session|expired|not found/i.test(message);
      if (!sessionLost || this.ready === false) throw error;
      this.ready = false;
      this.mcpSessionId = undefined;
      await this.ensureReady();
      return await this.rpc("tools/call", { name: tool, arguments: arguments_ }, timeoutMs);
    }
  }

  /** 健康检查:握手 + tools/list。失败返回 ok:false 而不抛异常——健康
   * 检查的语义是"如实报告网关状态",不是把故障再炸一次给路由层。
   * inputSchema 原样带回,华为网关的 arg0/arg1 形状要靠它对拍。
   * tokenSource 按此刻实际取没取到 token 区分:provider 配了但文件刚
   * 被删空,要显形为 未配置,不能谎报动态读取正常。 */
  async healthCheck(timeoutMs = 15_000): Promise<{
    ok: boolean;
    tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
    error?: string;
    tokenSource?: string;
  }> {
    const tokenSourceOf = () => this.currentToken()
      ? (this.config.tokenProvider ? "动态文件读取" : "启动时固定")
      : "未配置";
    try {
      await this.ensureReady();
      const result = await this.rpc("tools/list", {}, timeoutMs) as {
        tools?: Array<{ name?: string; description?: string; inputSchema?: unknown }>;
      };
      return {
        ok: true,
        tools: (result.tools ?? [])
          .filter((t): t is { name: string; description?: string; inputSchema?: unknown } =>
            Boolean(t.name))
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        tokenSource: tokenSourceOf(),
      };
    } catch (error) {
      return {
        ok: false,
        error: String((error as Error)?.message ?? error),
        tokenSource: tokenSourceOf(),
      };
    }
  }
}

/** MCP 工具结果 → 人话文本。content 可能是文本块数组;结构化字段
 * 原样带回(fallback),调用方按能力自行解析。 */
export function mcpResultText(result: unknown): string {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      const text = record.content
        .filter((block): block is { type: string; text?: string } =>
          Boolean(block) && typeof block === "object")
        .map((block) => String(block.text ?? ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if ("isError" in record && record.isError) {
      return `工具报错: ${JSON.stringify(result).slice(0, 400)}`;
    }
  }
  return JSON.stringify(result, null, 1).slice(0, 4_000);
}

// ---- DTS 问题单网关 ----

/** DTS 文件域域名(描述内嵌图的 host)。与 MCP 网关不是一域,当前
 * 内网部署只有这一个文件域,先写死;多环境再升配置。ticketImages 的
 * 站内路径归一(#42)用同一常量判"绝对地址是不是本域",别抄两份。 */
export const DTS_FILE_ORIGIN = "https://dts.example.com";

export interface DtsTicketBrief {
  ticket: string;
  title: string;
  status?: string;
  /** C 版本(DTS 字段 sProdCNoName,#564:自动化提的单不填 B 版字段,
   * B 构建号也无机制消费,精确 B 版 DTS 门户可查);R 版本不用。 */
  version?: string;
  /** 分支匹配结果(ADR-0038):路由层按配置中心映射补齐,网关不产;
   * 未命中配置时不加字段,前端按「未配置分支」呈现。 */
  branch?: string;
  severity?: string;
  submitter?: string;
  url?: string;
  description?: string;
  /** 特性名(单据字段 sFeatureNoName,列表查询需 fields 显式请求):
   * 业务模块强匹配的关键字段(ADR-0056),路由层据此带出 module_id。 */
  featureName?: string;
  /** 自动接单排除标记(ADR-0070):路由层按服务端排除表补齐,网关
   * 不产;被排除的单带 true,缺省允许不加字段。 */
  auto_claim_excluded?: boolean;
}

export interface DtsTicketDetail {
  ticket: string;
  title: string;
  content: string;
  /** 完整描述(batchQueryTicket 的 detailDesc,HTML)。 */
  description?: string;
  severity?: string;
  version?: string;
  /** 分支匹配结果(ADR-0038):路由层补齐,同列表;远程查单入列也带。 */
  branch?: string;
  url?: string;
  submitter?: string;
  /** 状态名(batchQueryTicket 的 dtsStatusName,需 fields 显式请求)。
   * 远程查单的前端要靠它判断可拉取(拉单只接"开发人员实施修改"),
   * 缺了它远程命中的单会被一律误判为状态不可拉取。 */
  status?: string;
  /** 特性名(batchQueryTicket/listByVersionAndHead 的 sFeatureNoName,
   * 需 fields 显式请求):业务模块强匹配的关键字段(ADR-0056)。 */
  featureName?: string;
}

export interface DtsGateway {
  listByOwner(account: string): Promise<DtsTicketBrief[]>;
  detail(ticket: string): Promise<DtsTicketDetail>;
  /** DTS 域文件(描述内嵌图等)按单据同源凭据代理回取。 */
  proxyFile(path: string): Promise<{ data: Buffer; contentType: string }>;
  /** 模拟网关标记:外部开发模式(--dts-mock)下为 true,列表 API
   * 与前端页签据此挂 DEV 徽标,防止模拟单被当成真实单据。 */
  readonly mock?: boolean;
}

/** 从网关文本里尽力解出单据列表。真实形状待 DTS 对拍(遗留),
 * 解不动时如实报错并把原文带给用户,不静默返回空列表。 */
function parseTicketList(raw: string): DtsTicketBrief[] {
  const candidate = raw.trim().startsWith("[") || raw.trim().startsWith("{")
    ? JSON.parse(raw) : undefined;
  const rows = Array.isArray(candidate)
    ? candidate
    : Array.isArray((candidate as Record<string, unknown>)?.items)
      ? ((candidate as Record<string, unknown>).items as unknown[])
      : Array.isArray((candidate as Record<string, unknown>)?.data)
        ? ((candidate as Record<string, unknown>).data as unknown[])
        : undefined;
  if (!rows) {
    throw new McpGatewayError(
      `DTS 列表返回形状未识别(集成时需对拍解析): ${raw.slice(0, 300)}`);
  }
  return rows.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      ticket: String(record.ticket ?? record.id ?? record["单号"] ?? ""),
      title: String(record.title ?? record.subject ?? record["标题"] ?? ""),
      status: record.status === undefined ? undefined : String(record.status),
      version: record.version === undefined ? undefined : String(record.version),
      severity: record.severity === undefined ? undefined : String(record.severity),
      submitter: record.submitter === undefined ? undefined : String(record.submitter),
      url: record.url === undefined ? undefined : String(record.url),
      description: record.description === undefined
        ? undefined : String(record.description),
    };
  }).filter((item) => item.ticket);
}

/** 网关单据字段 → 有值字符串:null/undefined/空串/纯空白一律缺席
 * (单据侧字段缺席回 JSON null 而非省键,String(null) 会产出字面量
 * "null" 当版本用,#564 实测)。 */
function fieldText(value: unknown): string | undefined {
  const text = value === undefined || value === null
    ? "" : String(value).trim();
  return text ? text : undefined;
}

export class McpDtsGateway implements DtsGateway {
  constructor(private readonly gateway: McpGateway) {}

  async proxyFile(path: string): Promise<{ data: Buffer; contentType: string }> {
    return this.gateway.fetchWithAuth(`${DTS_FILE_ORIGIN}${path}`);
  }

  async listByOwner(account: string): Promise<DtsTicketBrief[]> {
    // 工具名与参数形状按真实 DTS 网关对拍落地(占位名 list_issues 在
    // 真实网关不存在):listByVersionAndHead 共 14 参按声明顺序映射
    // arg0-arg13;查本人名下用 otherConditions.currentHandler 精确
    // 匹配(EqualName),pageIndex/pageSize 是前两个位置参数。
    const result = await this.gateway.call(
      this.gateway.toolName("list", "listByVersionAndHead"),
      {
        pageIndex: 1,
        pageSize: 200,
        pbiId: "",
        productType: "PBI",
        filterId: "",
        workBenchViewId: "",
        brief: "",
        dtsNos: [],
        dtsStatus: [],
        severity: [],
        convertAttachment: false,
        // 特性名是模块强匹配的关键字段(ADR-0056),列表也要显式请求
        // 才返回——与 detail 的 batchQueryTicket 同一纪律。
        fields: ["sFeatureNoName"],
        otherConditions: [{
          fieldName: "currentHandler",
          operator: "EqualName",
          value: [account],
        }],
        orderBy: [],
      },
    );
    const raw = mcpResultText(result);
    // 真实返回形状 {"status":"success","result":{"datas":[...]}}(单号
    // 在 dtsBizNo/简要描述在 briefDesc/状态名在 dtsStatusName);解不动
    // 时退回通用解析器如实报错——契约再变也不静默给空列表。
    try {
      const parsed = JSON.parse(raw);
      const datas = (parsed as {
        status?: string;
        result?: { datas?: Array<Record<string, unknown>> };
      })?.result?.datas;
      if ((parsed as { status?: string })?.status === "success"
          && Array.isArray(datas)) {
        return datas.map((item) => ({
          ticket: String(item.dtsBizNo ?? ""),
          title: String(item.briefDesc ?? ""),
          status: item.dtsStatusName === undefined
            ? undefined : String(item.dtsStatusName),
          version: fieldText(item.sProdCNoName),
          severity: item.serverityNoName !== undefined
            ? String(item.serverityNoName) : undefined,
          submitter: item.creator !== undefined
            ? String(item.creator) : undefined,
          url: item.outerLinkUrl !== undefined
            ? String(item.outerLinkUrl) : undefined,
          description: item.briefDesc !== undefined
            ? String(item.briefDesc) : undefined,
          featureName: item.sFeatureNoName !== undefined
            ? String(item.sFeatureNoName) : undefined,
        })).filter((item) => item.ticket);
      }
    } catch {
      // 非 JSON 形状走 fallback。
    }
    return parseTicketList(raw);
  }

  async detail(ticket: string): Promise<DtsTicketDetail> {
    // batchQueryTicket 按单号批量查详情(arg0=dtsNos, arg1=fields,
    // arg2=attachmentView),取第一条作详情;标题从 briefDesc 补上——
    // 原实现永远是空串。解不动时把原文整块带回,不编造。
    const result = await this.gateway.call(
      this.gateway.toolName("detail", "batchQueryTicket"),
      {
        dtsNos: [ticket],
        // 特性名是业务模块强匹配的关键字段(ADR-0056),状态名是远程
        // 查单的可拉取判据——batchQueryTicket 都必须在 fields 里显式
        // 请求才返回(实测缺省不给)。
        fields: ["sFeatureNoName", "dtsStatusName"],
        attachmentView: false,
      },
    );
    const raw = mcpResultText(result);
    try {
      const parsed = JSON.parse(raw) as {
        status?: string;
        result?: { datas?: Array<Record<string, unknown>> };
      };
      if (parsed?.status === "success") {
        const first = parsed.result?.datas?.[0];
        if (first) {
          const outerLink = first.outerLinkUrl !== undefined
            ? String(first.outerLinkUrl) : undefined;
          // 描述优先 detailDesc(完整 HTML),退回 briefDesc;里面 <img>
          // 的站内相对路径(/v1/nfs/...)要用 DTS 域补全成绝对地址,
          // 交给前端再重写为代理 URL。
          let description = first.detailDesc !== undefined
            ? String(first.detailDesc)
            : String(first.briefDesc ?? "");
          if (outerLink) {
            try {
              const dtsOrigin = new URL(outerLink).origin;
              description = description.replace(
                /(<img\s[^>]*src=")(\/[^"]*)(")/gi,
                `$1${dtsOrigin}$2$3`,
              );
            } catch { /* URL 解析失败则不处理 */ }
          }
          return {
            ticket: String(first.dtsBizNo ?? ticket),
            title: String(first.briefDesc ?? ""),
            content: raw,
            description,
            severity: first.serverityNoName !== undefined
              ? String(first.serverityNoName) : undefined,
            version: fieldText(first.sProdCNoName),
            url: outerLink,
            submitter: first.creator !== undefined
              ? String(first.creator) : undefined,
            status: first.dtsStatusName !== undefined
              ? String(first.dtsStatusName) : undefined,
            featureName: first.sFeatureNoName !== undefined
              ? String(first.sFeatureNoName) : undefined,
          };
        }
      }
    } catch {
      // 非 JSON 形状走 fallback。
    }
    return { ticket, title: "", content: raw };
  }
}

// ---- 未配置网关:fail-loud 的占位 ----

export class UnconfiguredDtsGateway implements DtsGateway {
  readonly reason: string;
  constructor(reason = "DTS MCP 网关未配置(启动需 --dts-mcp-url 与 --mcp-token-file,"
    + "正式服务器 token 在 /etc/mae-flow-cloud/mcp-token)") {
    this.reason = reason;
  }
  async listByOwner(_account: string): Promise<DtsTicketBrief[]> {
    throw new DtsGatewayUnconfiguredError(this.reason);
  }
  async detail(_ticket: string): Promise<DtsTicketDetail> {
    throw new DtsGatewayUnconfiguredError(this.reason);
  }
  async proxyFile(_path: string): Promise<{ data: Buffer; contentType: string }> {
    throw new DtsGatewayUnconfiguredError(this.reason);
  }
}

// ---- Mock 网关:过渡期测试用(--dts-mock) ----

/** 构造一张极小的确定性 PNG(单色块,颜色由种子派生):mock 内嵌图要有
 * 真图片字节,落盘后才能过 inspect_image 的魔数校验、真被识图;不同
 * 种子内容不同,内容哈希文件名各归各。编码手写(PNG 三件套 IHDR/IDAT/
 * IEND + CRC),不引依赖,先例同 src/visionCapability.ts 的探测图。 */
function mockTicketPng(seed: string): Buffer {
  const crc32 = (bytes: Buffer): number => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const kind = Buffer.from(type, "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([length, kind, data, crc]);
  };
  const width = 8;
  const height = 8;
  const hash = [...seed].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const color = [hash % 256, (hash * 7) % 256, (hash * 13) % 256];
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 3] = color[0];
    row[2 + x * 3] = color[1];
    row[3 + x * 3] = color[2];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(
      Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 1007 号模拟单的内嵌图:NFS 站内路径 → 罐头 PNG。proxyFile 按这份
 * 账回取,路径之外一律如实报错(真实网关 404 语义,不静默给空图)。 */
const MOCK_TICKET_IMAGES: Record<string, Buffer> = {
  "/v1/nfs/mock/2026-1007/export-error.png": mockTicketPng("export-error"),
  "/v1/nfs/mock/2026-1007/topology.png": mockTicketPng("topology"),
};

/** mock 单据数据源:外置 JSON(assets/mock/dts-tickets.json,字段说明
 * 见同目录 README)。改文件 → 列表页点「刷新」即生效,不用重启——
 * 开发者"随心所欲造单"的入口。 */
export const MOCK_DTS_SOURCE = resolve(
  fileURLToPath(import.meta.url), "..", "..", "..",
  "assets", "mock", "dts-tickets.json");

type MockTicket = DtsTicketBrief & { content?: string };

/** 现读现用:每次拉单/查单都重读 JSON(小文件,读盘开销可忽略)。
 * 缺失、坏 JSON、条目缺 ticket/title 都 fail-loud 并带路径——模拟数据
 * 静默变空列表看起来像"没单",会骗人。 */
function loadMockTickets(source: string = MOCK_DTS_SOURCE): MockTicket[] {
  let raw: string;
  try {
    raw = readFileSync(source, "utf-8");
  } catch {
    throw new McpGatewayError(`mock 单据文件读不到: ${source}(--dts-mock 需要它)`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("应为非空 JSON 数组");
    }
    for (const item of parsed) {
      const entry = item as Record<string, unknown>;
      if (typeof entry.ticket !== "string" || !entry.ticket) {
        throw new Error(`有条目缺 ticket 字段: ${JSON.stringify(item).slice(0, 80)}`);
      }
      if (typeof entry.title !== "string") {
        throw new Error(`单 ${entry.ticket} 缺 title 字段`);
      }
    }
    return parsed as MockTicket[];
  } catch (cause) {
    throw new McpGatewayError(`mock 单据文件不合法: ${source}(${
      cause instanceof Error ? cause.message : String(cause)})`);
  }
}

/** DTS MCP 未接入期间的确定性假单据(2026-08-27 拍板:真实网关完整
 * 实现在位等 URL,过渡期 mock 拉单/查单让全流程可测)。单据集住在
 * assets/mock/dts-tickets.json(字段说明见同目录 README),拉单按账号
 * 哈希错开展示顺序,detail 对数据集里的单给正文,查无此单即拒——
 * 关联转正的拒绝路径用乱编单号就能测。1007 号自带内嵌截图(#42):
 * dts_get_ticket 的下载改写与 --dts-mock 演示形态全链可走。与真实
 * 网关同接口,接线处一行替换;启动横幅会醒目标注 MOCK。 */
export class MockDtsGateway implements DtsGateway {
  readonly mock = true;

  /** 数据源可注入(调试形态 --debug-issue 指到 dataDir 下的专属文件);
   * 缺省仍是 assets/mock/dts-tickets.json,既有调用方零感知。 */
  constructor(
    private readonly log?: (message: string) => void,
    private readonly source: string = MOCK_DTS_SOURCE,
  ) {}

  async listByOwner(account: string): Promise<DtsTicketBrief[]> {
    const tickets = loadMockTickets(this.source);
    this.log?.(`[dts-mock] listByOwner(${account}) → ${tickets.length} 张`);
    // 稳定可预期:按账号哈希错开起点,人人在列表里都能看见单。
    const offset = [...account].reduce((sum, ch) => sum + ch.charCodeAt(0), 0)
      % tickets.length;
    return [...tickets.slice(offset), ...tickets.slice(0, offset)];
  }

  async detail(ticket: string): Promise<DtsTicketDetail> {
    const known = loadMockTickets(this.source).find((item) => item.ticket === ticket);
    if (known) {
      this.log?.(`[dts-mock] detail(${ticket}) → 已知单`);
      // version 必须随详情走:发起的分支硬闸按单据版本解析基线
      // (ADR-0038),列表有、详情没有就会"列上带分支、发起却说
      // 读不到版本"的精神分裂。
      if (known.content) {
        return {
          ticket: known.ticket,
          title: known.title,
          status: known.status,
          ...(known.version ? { version: known.version } : {}),
          ...(known.featureName ? { featureName: known.featureName } : {}),
          ...(known.description ? { description: known.description } : {}),
          content: known.content,
        };
      }
      return {
        ticket: known.ticket,
        title: known.title,
        status: known.status,
        ...(known.version ? { version: known.version } : {}),
        ...(known.featureName ? { featureName: known.featureName } : {}),
        content:
          `【MOCK 单据】${known.title}\n\n`
          + `单号: ${known.ticket}\n状态: ${known.status ?? "打开"}\n`
          + "现象: 压测/生产环境偶发,复现步骤见附件。\n"
          + "影响: 下游系统超时重试放大。\n"
          + "初步定位: 由测试转开发,等待问题会话分析。",
      };
    }
    this.log?.(`[dts-mock] detail(${ticket}) → 查无此单`);
    throw new McpGatewayError(
      `DTS 查无此单: ${ticket}(mock 数据集见 ${this.source})`);
  }

  /** mock 的内嵌图按约定路径回取罐头 PNG(与真实网关的 proxyFile 同
   * 语义:带单据同源凭据回二进制——mock 无凭据可带,直接给字节)。
   * 账外路径如实报错,不给"图在但空"的假象。 */
  async proxyFile(path: string): Promise<{ data: Buffer; contentType: string }> {
    const image = MOCK_TICKET_IMAGES[path];
    if (!image) {
      throw new McpGatewayError(
        `mock 网关没有这个 DTS 域文件: ${path}(只有 1007 号单的两张内嵌图)`);
    }
    return { data: image, contentType: "image/png" };
  }
}

