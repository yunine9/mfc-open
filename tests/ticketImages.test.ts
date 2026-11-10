/**
 * DTS 单内嵌截图落工作区(#42)的契约:dts_get_ticket 把描述里的
 * <img>(DTS NFS 站内路径)经网关 proxyFile 落到工作区
 * ticket-images/<单号>/,回执文本里的 URL 改写为工作区相对路径,
 * AI 可对本地路径调 inspect_image 识图。
 *
 * 钉死的红线:
 * - fail-open:单图失败/超 20MB 只标注缺失,详情照常;同一 URL 本会话
 *   只试一次(failed.json 记账,进程重启也不轰炸);
 * - 上限:单张 ≤20MB(与 inspect_image 一致)、单轮新下载 ≤12 张,
 *   超出如实标注截断;
 * - 去重:文件名用内容哈希,重复调用命中 index.json 零网关回取;
 * - 边界:外链/相对路径/.. 穿越一律拒绝并标注,从不发起下载。
 */

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  applyTicketImageRewrites,
  extractDtsImageSrcs,
  normalizeDtsImagePath,
  syncTicketImages,
  TICKET_IMAGE_MAX_COUNT,
} from "../src/issueFlow/ticketImages.ts";
import {
  DTS_FILE_ORIGIN,
  MockDtsGateway,
  type DtsGateway,
  type DtsTicketDetail,
} from "../src/issueFlow/gateways.ts";
import { McpGatewayError } from "../src/issueFlow/errors.ts";
import { createIssueTools, type IssueToolContext } from "../src/issueFlow/tools.ts";
import type { IssueSessionState } from "../src/issueFlow/state.ts";
import { visionProbePng } from "../src/visionCapability.ts";

const PNG = visionProbePng();

/** 造 13 张用:尾部带序号字节让内容哈希各不相同(哈希去重才会各落各
 * 的文件);PNG 解码器忽略 IEND 之后的尾字节,魔数校验不受影响。 */
const pngVariant = (n: number) => Buffer.concat([PNG, Buffer.from([n])]);

/** 数回取次数的假网关:files 是可回取的罐头图,账外路径按 404 语义
 * 抛错(坏图),fetchCounts 是"网关回取计数"——去重断言的裁判。 */
class FakeImageGateway implements DtsGateway {
  readonly fetchCounts = new Map<string, number>();
  constructor(
    private readonly files: Record<string, Buffer>,
    private readonly describe: (ticket: string) => DtsTicketDetail,
  ) {}
  async listByOwner(): Promise<never[]> { return []; }
  async detail(ticket: string): Promise<DtsTicketDetail> {
    return this.describe(ticket);
  }
  async proxyFile(path: string): Promise<{ data: Buffer; contentType: string }> {
    this.fetchCounts.set(path, (this.fetchCounts.get(path) ?? 0) + 1);
    const data = this.files[path];
    if (!data) throw new McpGatewayError(`DTS 文件代理 HTTP 404: ${path}`);
    return { data, contentType: "image/png" };
  }
}

/** 最小固定流程会话态 + 工具集(dts_get_ticket 是工读类,任意阶段可调)。 */
function toolHarness(workspace: string, dts: DtsGateway) {
  const state: IssueSessionState = {
    id: "issue-img", account: "dev",
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    title: "t", description: "", source: "dts", ticket: "DTS-IMG-1",
    repo_url: "", scenario: "ticket", round: 1,
    stage_states: ["pending", "pending", "pending", "pending", "pending", "pending", "pending"],
    status: "idle", stage: "dts_info", stage_note: "", stage_at: new Date().toISOString(),
  };
  const ctx: IssueToolContext = {
    state, workspace, dataRoot: join(workspace, ".data"),
    persist: () => undefined, dts,
    pullRepo: async (url) => ({
      dir: `repo/${url.split("/").at(-1)}`, cloned: true, head: "a".repeat(12),
    }),
  };
  const tools = createIssueTools(ctx) as Array<{
    name: string;
    execute: (id: string, params: any) => Promise<unknown>;
  }>;
  const tool = tools.find((item) => item.name === "dts_get_ticket");
  assert.ok(tool, "dts_get_ticket 应注册");
  const textOf = (result: unknown) =>
    (result as { content: Array<{ text: string }> }).content[0].text;
  return {
    getTicket: (ticket?: string) =>
      tool!.execute("x", ticket ? { ticket } : {}),
    textOf,
  };
}

test("好图落盘改写、坏图超限标注缺失;再调一次网关零回取(哈希命中)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ticket-img-"));
  const goodSha = createHash("sha256").update(PNG).digest("hex").slice(0, 16);
  // 一张好图 + 一张坏图(网关 404)+ 一张超 20MB,同张单据三种下场。
  const gateway = new FakeImageGateway(
    {
      "/v1/nfs/t42/good.png": PNG,
      "/v1/nfs/t42/huge.png": Buffer.alloc(20 * 1024 * 1024 + 1),
    },
    (ticket) => ({
      ticket,
      title: "带图单",
      content: "【详情】现象如下\n"
        + '<img src="/v1/nfs/t42/good.png">'
        + '<img src="/v1/nfs/t42/broken.png">'
        + '<img src="/v1/nfs/t42/huge.png">',
      description: '<p>现象:</p><img src="/v1/nfs/t42/good.png">'
        + '<img src="/v1/nfs/t42/broken.png">'
        + '<img src="/v1/nfs/t42/huge.png">',
    }),
  );
  try {
    const { getTicket, textOf } = toolHarness(workspace, gateway);
    const first = textOf(await getTicket());
    // 好图:落 ticket-images/<单号>/<sha256 前 16 位>.png,正文改写为
    // 工作区相对路径(原 URL 只剩回执清单里"原 …"一处)。
    const localPath = join(workspace, "ticket-images", "DTS-IMG-1", `${goodSha}.png`);
    assert.ok(existsSync(localPath), "好图应落盘(内容哈希文件名)");
    assert.deepEqual(readFileSync(localPath), PNG, "落盘字节与网关回取一致");
    assert.ok(first.includes(`ticket-images/DTS-IMG-1/${goodSha}.png`));
    assert.equal(
      first.split("/v1/nfs/t42/good.png").length - 1, 1,
      "正文里的原 URL 已改写,只剩清单标注一处");
    assert.match(first, /可对它调 inspect_image/);
    // 坏图与超限图:标注缺失,URL 原样保留,详情照常返回。
    assert.match(first, /\/v1\/nfs\/t42\/broken\.png:未能下载到工作区/);
    assert.match(first, /超过单张 20MB 上限/);
    assert.ok(first.includes("【详情】现象如下"), "详情本体不因图片失败缺席");
    assert.ok(!existsSync(join(workspace, "ticket-images", "DTS-IMG-1",
      `${createHash("sha256").update(Buffer.alloc(20 * 1024 * 1024 + 1))
        .digest("hex").slice(0, 16)}.png`)), "超限图不落盘");

    // 再调一次:好图命中 index 复用,坏图/超限图记过账不再试——
    // 网关回取计数原地不动(哈希命中不重复下载)。
    const second = textOf(await getTicket());
    assert.equal(gateway.fetchCounts.get("/v1/nfs/t42/good.png"), 1);
    assert.equal(gateway.fetchCounts.get("/v1/nfs/t42/broken.png"), 1,
      "失败 URL 本会话不再重试(failed.json 记账)");
    assert.equal(gateway.fetchCounts.get("/v1/nfs/t42/huge.png"), 1);
    assert.match(second, /本地已有 1/, "复用要在回执里显形");
    assert.match(second, /此前已失败,本会话不再重试/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test(`单轮上限 ${TICKET_IMAGE_MAX_COUNT} 张:13 张内嵌图落 12 张,第 13 张标注截断`, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ticket-img-cap-"));
  const paths = Array.from({ length: 13 }, (_v, i) =>
    `/v1/nfs/many/i${String(i + 1).padStart(2, "0")}.png`);
  const files = Object.fromEntries(paths.map((path, i) => [path, pngVariant(i)]));
  const gateway = new FakeImageGateway(files, (ticket) => ({
    ticket,
    title: "多图单",
    content: `<p>批量截图</p>${paths.map((path) => `<img src="${path}">`).join("")}`,
    description: paths.map((path) => `<img src="${path}">`).join(""),
  }));
  try {
    const { getTicket, textOf } = toolHarness(workspace, gateway);
    const receipt = textOf(await getTicket("DTS-MANY"));
    const dir = join(workspace, "ticket-images", "DTS-MANY");
    const images = readdirSync(dir).filter((name) => name.endsWith(".png"));
    assert.equal(images.length, 12, "恰好 12 张落盘");
    assert.equal(readdirSync(dir).includes("index.json"), true, "URL→文件账在");
    for (const [path, count] of gateway.fetchCounts) {
      assert.equal(count, 1, `${path} 只回取一次`);
    }
    assert.equal(gateway.fetchCounts.get(paths[12]), undefined,
      "第 13 张从未发起下载");
    assert.match(receipt, /截断 1 张/);
    assert.match(receipt, new RegExp(`${paths[12]}:超出单轮新下载 12 张上限`));
    assert.ok(receipt.split("/v1/nfs/many/").length - 1 >= 13,
      "13 个 URL 都可追溯(12 个'原 …' + 1 个截断标注)");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("非法 URL(外链/相对路径/../ 穿越)拒绝且标注,一次下载都不发起", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ticket-img-badurl-"));
  const gateway = new FakeImageGateway({}, (ticket) => ({
    ticket,
    title: "脏描述单",
    content: '<p>现象</p><img src="https://evil.example.com/a.png">'
      + '<img src="images/local.png">'
      + '<img src="/v1/nfs/../../etc/passwd">',
    description: '<img src="https://evil.example.com/a.png">'
      + '<img src="images/local.png">'
      + '<img src="/v1/nfs/../../etc/passwd">',
  }));
  try {
    const { getTicket, textOf } = toolHarness(workspace, gateway);
    const receipt = textOf(await getTicket("DTS-DIRTY"));
    assert.equal(gateway.fetchCounts.size, 0, "非法 URL 不碰网关");
    assert.match(receipt, /evil\.example\.com\/a\.png:外链/);
    assert.match(receipt, /images\/local\.png:相对路径/);
    assert.match(receipt, /\.\. 穿越/);
    assert.equal(existsSync(join(workspace, "ticket-images")), false,
      "没有可下载的图就不建目录");
    assert.ok(receipt.includes("<p>现象</p>"), "详情照常返回");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("--dts-mock 全链:1007 号模拟单两张内嵌图落盘识图,重查零回取", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ticket-img-mock-"));
  class CountingMock extends MockDtsGateway {
    fetches = 0;
    override async proxyFile(path: string) {
      this.fetches += 1;
      return super.proxyFile(path);
    }
  }
  const gateway = new CountingMock();
  try {
    const { getTicket, textOf } = toolHarness(workspace, gateway);
    const receipt = textOf(await getTicket("DTS-2026-1007"));
    const dir = join(workspace, "ticket-images", "DTS-2026-1007");
    const images = readdirSync(dir).filter((name) => name.endsWith(".png"));
    assert.equal(images.length, 2, "两张罐头图各自落盘");
    for (const name of images) {
      assert.equal(
        readFileSync(join(dir, name)).subarray(0, 4).toString("latin1"), "\x89PNG",
        "落盘的是真 PNG(--dts-mock 演示能走通识图)");
      assert.match(receipt, new RegExp(`ticket-images/DTS-2026-1007/${name}`));
    }
    assert.match(receipt, /\/v1\/nfs\/mock\/2026-1007\/export-error\.png/);
    assert.equal(gateway.fetches, 2, "两张各回取一次");
    // 重查:命中索引,mock 网关零回取。
    await getTicket("DTS-2026-1007");
    assert.equal(gateway.fetches, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("纯函数:DTS 文件域绝对地址剥回站内路径,外链/相对/穿越拒;改写兼容两种形态", () => {
  // 真实网关的 detail 会把站内路径补全成绝对地址(#42 口径:剥回路径,
  // 与 /issues/dts-file 代理同一把尺);他域一律外链。
  assert.deepEqual(
    normalizeDtsImagePath(`${DTS_FILE_ORIGIN}/v1/nfs/a b.png`),
    { path: "/v1/nfs/a b.png" });
  assert.equal(
    "reason" in normalizeDtsImagePath("https://evil.example.com/a.png"), true);
  assert.equal("reason" in normalizeDtsImagePath("images/a.png"), true);
  assert.match(JSON.stringify(normalizeDtsImagePath("/v1/nfs/../../etc/passwd")),
    /穿越/);
  assert.equal(
    "reason" in normalizeDtsImagePath("/v1/nfs/a.png?v=1#frag"), false,
    "查询/锚点原样保留在路径键里(整串精确匹配改写)");
  assert.deepEqual(extractDtsImageSrcs('<p>x</p><img src="/a.png"><IMG SRC="/b.png">'),
    ["/a.png", "/b.png"], "按出现序,大小写不敏感");
  assert.deepEqual(extractDtsImageSrcs(undefined), []);

  // 改写:绝对地址包含站内路径子串,两种形态一并换成工作区相对路径;
  // 更长的失败 URL 不被短键误吃(后边界断言)。
  const rewritten = applyTicketImageRewrites(
    `<img src="${DTS_FILE_ORIGIN}/v1/nfs/a.png"> 与 <img src="/v1/nfs/a.png">`
    + " 失败保留:<img src=\"/v1/nfs/a.png.bak\">",
    [{ url: "/v1/nfs/a.png", relativePath: "ticket-images/T/x.png",
       bytes: 1, reused: false }]);
  assert.ok(!rewritten.includes(DTS_FILE_ORIGIN), "绝对地址形态一并改写");
  assert.equal(rewritten.split("ticket-images/T/x.png").length - 1, 2);
  assert.ok(rewritten.includes("/v1/nfs/a.png.bak"),
    "更长的未下载 URL 不被短键的前缀替换吃掉");
});

test("单图下载超时(30s 预算):标注缺失并记账,详情照常", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mfc-ticket-img-slow-"));
  const gateway = new FakeImageGateway({}, (ticket) => ({
    ticket, title: "慢图单",
    content: '<img src="/v1/nfs/slow/a.png">',
    description: '<img src="/v1/nfs/slow/a.png">',
  }));
  gateway.proxyFile = () => new Promise(() => undefined); // 永不返回
  try {
    // syncTicketImages 对单图 fail-open:超时不会冒泡成 rejection,
    // 而是记进 failures;假时钟把 30s 预算压成同步 tick。
    mock.timers.enable({ apis: ["setTimeout"] });
    const pending = syncTicketImages({
      description: '<img src="/v1/nfs/slow/a.png">',
      ticket: "DTS-SLOW", workspace, gateway,
    });
    mock.timers.tick(30_001);
    const first = await pending;
    mock.timers.reset();
    assert.match(first.failures[0].reason, /超时/);
    // 第二次:失败已记账,直接标注、不再等预算。
    const second = await syncTicketImages({
      description: '<img src="/v1/nfs/slow/a.png">',
      ticket: "DTS-SLOW", workspace, gateway,
    });
    assert.match(second.failures[0].reason, /此前已失败,本会话不再重试/);
  } finally {
    mock.timers.reset();
    rmSync(workspace, { recursive: true, force: true });
  }
});
