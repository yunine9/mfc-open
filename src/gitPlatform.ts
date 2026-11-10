/**
 * Git 平台与权威流水线——内网能力的可替换模拟(主 spec §7.3/§10/§14.5)。
 *
 * 真假件共同遵守的语义:
 * - 服务端仓库是唯一远端真相:任务从它克隆,分支推回它;
 * - MR 属于(源分支→目标分支),重复创建返回已有 MR,不翻倍;
 * - 流水线结果与 Commit SHA 绑定:旧结果不能用于新代码,
 *   查询时 SHA 不匹配一律视为"没跑过",不许拿旧绿灯背书新提交;
 * - MR 创建成功≠可合入:流水线通过前状态是"验证中"。
 *
 * 假件形态:本地裸仓(git init --bare,从源仓灌历史)+ 环回 HTTP
 * (POST /mr、GET /mr、POST /pipeline/trigger、GET /pipeline/status)。
 * 内网真件(公司 GitLab/流水线)就绪时换 baseUrl 与鉴权,语义不变。
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { PipelineCheck } from "./pipelineContract.ts";

export interface MergeRequest {
  id: number;
  source_branch: string;
  target_branch: string;
  title: string;
  sha: string;
  state: "验证中" | "等待合入";
  url: string;
  /** 平台侧生命周期(门禁契约用):opened=在途,merged/closed=终态。 */
  merge_state: "opened" | "merged" | "closed";
  /** 假平台多仓路由。缺席表示历史单仓数据，回落启动时的 barePath。 */
  repo?: string;
  /** 关联的 E2E 单号(REQ/DTS):真件走 --e2e-issues,假件存证同语义
   * ——测试据此裁"宿主把单号递到了平台",不许只拼进 title。 */
  e2e_issues?: string;
}

/** 检视讨论(真件=CodeHub 的 MR discussion;假件同语义)。 */
export interface Discussion {
  id: string;
  /** 同一 discussion 被编辑后必须成为新反馈，不能被旧回复吞掉。 */
  revision?: number;
  updated_at?: string;
  file?: string;
  line?: number;
  severity?: string;
  author?: string;
  body: string;
  resolved: boolean;
  /** 发布过的回复(测试断言"回复真到了平台"用)。 */
  replies: string[];
  /** 每条回复/代点已解决请求携带的 mr(issue-383:信箱透传断言用)。 */
  replyMrs: unknown[];
}

export interface PipelineRun {
  id: number;
  sha: string;
  status: "running" | "success" | "failed";
  /** 同一 SHA 理论上可出现在不同仓；流水线账也必须按仓隔离。 */
  repo?: string;
  /** 可选的逐项诊断事实；明确 failed/pending 优先于总体状态。缺席时
   * execution_contract 已声明覆盖范围，整体 success 可聚合核销。 */
  checks?: PipelineCheck[];
  /** 失败详情(平台原文)。修复 agent 的口粮:没有它,修就是瞎修。
   * 内网真件从"拉日志"CLI 映射到这个字段,契约同形。 */
  log?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

export class FakeGitPlatform {
  readonly mergeRequests: MergeRequest[] = [];
  readonly pipelines: PipelineRun[] = [];
  /** 测试注入:下一次流水线的结局(默认 success)。
   * "running" = 模拟真实平台的异步流水线:触发后先跑着,
   * 结局由 finishPipeline 事后裁定。 */
  nextPipelineStatus: "success" | "failed" | "running" = "success";
  /** 失败时随 run 带出的日志(默认给个像样的样板)。 */
  nextPipelineLog = "BUILD FAILURE: 模块 notify-service 编译失败";
  /** 逐次结局队列:修复环一类"先红后绿"的剧本按序消费,
   * 空了退回 nextPipelineStatus——比测试里掐时序翻开关可靠。 */
  readonly statusQueue: Array<"success" | "failed" | "running"> = [];
  /** 模拟仅提供总体状态的平台（仍可聚合核销，诊断粒度较低）。 */
  omitTypedChecks = false;
  /** 测试可覆盖下一次 run 的逐项结果；触发后消费一次。 */
  nextPipelineChecks?: PipelineCheck[];
  /** 检视讨论(测试注入 seedDiscussion;修复闭环回复+resolve 落这里)。 */
  readonly discussions: Discussion[] = [];
  /** 故障注入：指定讨论的接下来 N 次回复返回失败。 */
  readonly discussionReplyFailures = new Map<string, number>();
  /** 故障注入：讨论列表接下来 N 次返回 503。 */
  discussionListFailures = 0;
  /** 假平台也兑现幂等键，覆盖“远端成功、本地来不及记账”的重放窗。 */
  private readonly discussionReplyIdempotency = new Set<string>();
  private readonly discussionReplyHolds = new Map<string, Promise<void>>();
  /** 冲突门禁:true=conflict_passed 不过(真件由平台判,假件测试拨)。 */
  conflictGate = false;
  /** 等人类门禁覆盖(approvers_passed 等):不设=通过。
   * 测试拨 false 模拟"等审批",拨回 true 模拟"有人批了"。 */
  readonly humanGates: Record<string, boolean> = {};
  /** 流水线附件(批2 落盘契约):测试注入,按名给文本。 */
  readonly artifacts: Array<{ name: string; text: string }> = [];
  barePath = "";
  private server?: Server;
  private counter = 0;

  /** 从源仓灌历史建裸仓——任务的 origin,推送的唯一去处。 */
  initBare(sourceRepo: string, dataDir: string): string {
    this.barePath = join(dataDir, "origin.git");
    // 续跑:裸仓已经在(可能已被 MR 合入推进过 master),再从源仓 push 会撞
    // 非快进被拒(2026-09-06 跨仓续跑实锤)。现场是真相,原样复用。
    if (existsSync(join(this.barePath, "HEAD"))) return this.barePath;
    mkdirSync(this.barePath, { recursive: true });
    git(this.barePath, "init", "--bare", "--quiet");
    execFileSync(
      "git", ["push", "--quiet", this.barePath, "--all"],
      { cwd: sourceRepo, encoding: "utf-8" });
    // 裸仓 HEAD 默认指向 init.defaultBranch,与源仓分支名不符时
    // clone 会得到空工作树(git 只警告不报错)。显式对齐源仓当前分支。
    const head = git(sourceRepo, "branch", "--show-current") || "master";
    git(this.barePath, "symbolic-ref", "HEAD", `refs/heads/${head}`);
    return this.barePath;
  }

  get baseUrl(): string {
    const address = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  branchSha(branch: string, repo?: string): string {
    return git(this.repositoryPath(repo), "rev-parse", branch);
  }

  /** --fake-platform 只允许访问默认裸仓同目录下的本地裸仓。多仓 E2E
   * 会把 origin.git/origin-aux.git 并排放置；既兑现请求里的 repo 路由，
   * 又不把环回 HTTP 变成可任意操作本机 Git 仓的入口。 */
  private repositoryPath(requested?: unknown): string {
    const raw = String(requested ?? "").trim();
    if (!raw || raw === this.barePath) return this.barePath;
    if (!isAbsolute(raw) || /^(https?|ssh|git):\/\//i.test(raw)) {
      throw new Error("假平台 repo 必须是已登记目录下的本地裸仓");
    }
    const candidate = resolve(raw);
    const root = resolve(dirname(this.barePath));
    const rel = relative(root, candidate);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("假平台 repo 不在已登记的多仓目录中");
    }
    if (git(candidate, "rev-parse", "--is-bare-repository") !== "true") {
      throw new Error("假平台 repo 不是裸仓");
    }
    return candidate;
  }

  /** 每个请求的身份头台账(测试断言用):真适配层靠这两个头把
   * MR 发起人落到任务归属人,假件只记录不消费。 */
  readonly seenIdentity: Array<{
    path: string;
    query: string;
    user?: string;
    token?: string;
  }> = [];

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk as Buffer));
      request.on("end", () => {
        const url = new URL(request.url ?? "/", "http://localhost");
        this.seenIdentity.push({
          path: url.pathname,
          query: url.search,
          user: request.headers["x-mfc-git-user"] as string | undefined,
          token: request.headers["x-mfc-git-token"] as string | undefined,
        });
        let body: Record<string, any> = {};
        try {
          body = JSON.parse(
            Buffer.concat(chunks).toString("utf-8") || "{}");
        } catch {
          response.writeHead(400).end();
          return;
        }
        const reply = (status: number, payload: unknown) => {
          const text = JSON.stringify(payload);
          response
            .writeHead(status, { "content-type": "application/json" })
            .end(text);
        };
        try {
          const replyMatch = url.pathname.match(
            /^\/mr\/discussions\/([^/]+)\/reply$/);
          // 浏览器可达的 MR 页面与合入按钮(MFC-005):任务卡上的 mr_url
          // 点开曾是 404,整链 E2E 没法在浏览器里收口。页面只做最小
          // 事实展示+合入表单;合入真实推进目标 ref,不是翻状态字段。
          const pageMatch = url.pathname.match(/^\/mr\/(\d+)$/);
          const mergeMatch = url.pathname.match(/^\/mr\/(\d+)\/merge$/);
          if (request.method === "GET" && url.pathname === "/") {
            reply(200, {
              ok: true,
              endpoints: [
                "POST /mr",
                "POST /pipeline/trigger",
                "GET /pipeline/status?sha=&repo=",
              ],
            });
          } else if (request.method === "GET" && pageMatch) {
            const html = this.mergeRequestPage(Number(pageMatch[1]));
            response
              .writeHead(html ? 200 : 404,
                { "content-type": "text/html; charset=utf-8" })
              .end(html ?? "<h1>MR 不存在</h1>");
          } else if (request.method === "POST" && mergeMatch) {
            const outcome = this.mergeMergeRequest(Number(mergeMatch[1]));
            if (outcome.ok) {
              response.writeHead(303,
                { location: `/mr/${mergeMatch[1]}` }).end();
            } else {
              // 浏览器点合入失败时人必须原地看到原因(MFC-037:裸 409
              // JSON 在浏览器里就是白屏死路)。任务侧门禁与此同源,下一
              // 拍监控会看到红灯并自动接手,页面把这条路说清楚。
              response.writeHead(409,
                { "content-type": "text/html; charset=utf-8" })
                .end([
                  "<!doctype html><html lang=\"zh-CN\"><head>",
                  "<meta charset=\"utf-8\"><title>合入失败</title></head>",
                  "<body style=\"font:14px/1.7 system-ui;max-width:640px;",
                  "margin:40px auto;padding:0 16px\">",
                  "<h1>合入失败</h1>",
                  `<p style=\"color:#b3261e\">${String(outcome.error ?? "")
                    .replace(/[&<>"]/g, (ch) => ({ "&": "&amp;",
                      "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!))}</p>`,
                  "<p>任务侧门禁会在下一轮监控看到同样的红灯并自动派发修复;",
                  "也可回到 MR 页刷新门禁状态。</p>",
                  `<p><a href=\"/mr/${mergeMatch[1]}\">返回 MR 页</a></p>`,
                  "</body></html>",
                ].join("\n"));
            }
          } else if (request.method === "POST" && url.pathname === "/mr") {
            reply(201, this.createMergeRequest(body));
          } else if (request.method === "GET" && url.pathname === "/mr") {
            reply(200, this.mergeRequests);
          } else if (request.method === "POST"
              && url.pathname === "/pipeline/trigger") {
            reply(201, this.triggerPipeline(
              String(body.sha ?? ""), String(body.repo ?? "") || undefined));
          } else if (request.method === "GET"
              && url.pathname === "/pipeline/status") {
            reply(200, this.pipelineStatus(
              url.searchParams.get("sha") ?? "",
              url.searchParams.get("repo") ?? undefined));
          } else if (request.method === "GET" && url.pathname === "/mr/discover") {
            const repo = this.repositoryPath(url.searchParams.get("repo") ?? "");
            reply(200, { mrs: this.mergeRequests.filter(mr => (mr.repo ?? this.barePath) === repo
              && mr.source_branch === url.searchParams.get("source_branch")
              && mr.target_branch === url.searchParams.get("target_branch"))
              .map(mr => ({ id: mr.id, url: mr.url, source_branch: mr.source_branch, target_branch: mr.target_branch })) });
          } else if (request.method === "GET"
              && url.pathname === "/mr/gates") {
            reply(200, this.mergeGates(
              url.searchParams.get("source_branch") ?? "",
              url.searchParams.get("target_branch") ?? "",
              url.searchParams.get("repo") ?? undefined,
              url.searchParams.get("mr") ?? undefined));
          } else if (request.method === "GET"
              && url.pathname === "/mr/discussions") {
            if (this.discussionListFailures > 0) {
              this.discussionListFailures -= 1;
              reply(503, { error: "讨论服务暂时不可用" });
            } else {
              reply(200, { discussions: this.discussions
                .filter((item) => !item.resolved)
                .map(({ replies: _r, resolved: _s, ...rest }) => rest) });
            }
          } else if (request.method === "POST" && replyMatch) {
            const hold = this.discussionReplyHolds.get(replyMatch[1]);
            if (hold) {
              // 只扣住一次：放行后同讨论的后续回复照常即时应答。
              this.discussionReplyHolds.delete(replyMatch[1]);
              const id = replyMatch[1];
              void hold.then(() => {
                try { reply(200, this.replyDiscussion(id, body)); }
                catch (error) { reply(400, { error: String(error) }); }
              });
            } else reply(200, this.replyDiscussion(replyMatch[1], body));
          } else if (request.method === "POST"
              && /^\/mr\/discussions\/([^/]+)\/resolve$/.test(url.pathname)) {
            // 仅标已解决、不跟帖(问题流「忽略」,2026-09-18)。
            const id = decodeURIComponent(url.pathname.match(
              /^\/mr\/discussions\/([^/]+)\/resolve$/)![1]);
            const discussion = this.discussions.find(
              (item) => item.id === id);
            if (!discussion) reply(404, { error: "讨论不存在" });
            else {
              discussion.resolved = true;
              discussion.replyMrs.push(body.mr);
              reply(200, { ok: true, resolved: true });
            }
          } else if (request.method === "GET"
              && url.pathname === "/pipeline/artifacts") {
            reply(200, { files: this.artifacts });
          } else {
            reply(404, { error: "未知路径" });
          }
        } catch (error) {
          reply(400, { error: String(error) });
        }
      });
    });
    await new Promise<void>((resolve) =>
      this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  /** 同(源→目标)分支已有 MR 时幂等返回——恢复重放不翻倍(§10 幂等键)。
   * 幂等复用时顺带把 sha 对齐到分支最新(修复推了新提交,MR 跟着走,
   * 真平台就是这个行为)。 */
  private createMergeRequest(body: Record<string, any>): MergeRequest {
    const source = String(body.source_branch ?? "");
    const target = String(body.target_branch ?? "");
    if (!source || !target) throw new Error("source_branch/target_branch 必填");
    const repo = this.repositoryPath(body.repo);
    const existing = this.mergeRequests.find(
      (mr) => mr.source_branch === source && mr.target_branch === target
        && (mr.repo ?? this.barePath) === repo
        && mr.merge_state === "opened");
    if (existing) {
      existing.sha = this.branchSha(source, repo);
      return existing;
    }
    const sha = this.branchSha(source, repo); // 分支必须已推到位
    this.counter += 1;
    const mr: MergeRequest = {
      id: this.counter,
      source_branch: source,
      target_branch: target,
      title: String(body.title ?? source),
      e2e_issues: String(body.dts_no ?? "") || undefined,
      sha,
      state: "验证中",
      url: `${this.baseUrl}/mr/${this.counter}`,
      merge_state: "opened",
      ...(repo !== this.barePath ? { repo } : {}),
    };
    this.mergeRequests.push(mr);
    return mr;
  }

  /** 门禁九项的假件版:三项可修按真实状态算,等人类由测试拨。
   * 语义与真件对齐:名字用 CodeHub 原始拼写,passed 是布尔。 */
  private mergeGates(source: string, target: string, requestedRepo?: string, requestedMr?: string): {
    mr_state: string;
    sha: string;
    gates: Array<{ name: string; passed: boolean; detail?: string }>;
  } {
    const repo = this.repositoryPath(requestedRepo);
    const mr = this.mergeRequests.find(
      (item) => item.source_branch === source
        && item.target_branch === target
        && (item.repo ?? this.barePath) === repo
        && (!requestedMr || String(item.id) === requestedMr || item.url === requestedMr));
    if (!mr) throw new Error(`MR(${source}->${target}) 不存在`);
    const unresolved = this.discussions.filter((item) => !item.resolved);
    const lastRun = this.pipelines.findLast((run) => run.sha === mr.sha
      && (run.repo ?? this.barePath) === repo);
    const gates = [
      {
        name: "resolve_discussion_passed",
        passed: unresolved.length === 0,
        ...(unresolved.length
          ? { detail: `${unresolved.length} 条检视意见未解决` } : {}),
      },
      // 冲突门禁必须和真正 merge 用同一套事实(MFC-037:此前门禁读
      // 测试布尔恒绿,点合入才在 Git 层撞 409,MFC 看见假绿永远不派
      // 冲突修复)。这里用 bare 仓真实祖先关系判断能否快进;测试布尔
      // 只保留"强拨红"一个方向,不能把真实冲突拨绿。
      (() => {
        let targetAdvanced = false;
        try {
          execFileSync("git", ["-C", repo, "merge-base",
            "--is-ancestor", mr.target_branch, mr.sha],
            { encoding: "utf-8" });
        } catch {
          targetAdvanced = true;
        }
        const passed = !this.conflictGate
          && (!targetAdvanced || mr.merge_state === "merged");
        return {
          name: "conflict_passed",
          passed,
          ...(passed ? {} : {
            detail: this.conflictGate
              ? "与目标分支存在冲突"
              : "目标分支已前进且非快进,请先在任务侧合并目标分支再推送",
          }),
        };
      })(),
      {
        name: "ci_state_passed",
        passed: lastRun?.status === "success",
        ...(lastRun?.status !== "success"
          ? { detail: `流水线 ${lastRun?.status ?? "未跑"}` } : {}),
      },
      ...Object.entries(this.humanGates).map(([name, passed]) => ({
        name, passed,
      })),
    ];
    // sha 是门禁契约的一等公民(MFC-038):宿主要用它核对"平台上被
    // 验证/合入的提交"确实等于任务验证过的 delivery.sha,防止分支被
    // 平台侧改写后旧绿灯背书新代码。
    return { mr_state: mr.merge_state, sha: mr.sha, gates };
  }

  private replyDiscussion(
    id: string,
    body: Record<string, any>,
  ): { ok: boolean } {
    const discussion = this.discussions.find((item) => item.id === id);
    if (!discussion) throw new Error(`讨论 ${id} 不存在`);
    const remaining = this.discussionReplyFailures.get(id) ?? 0;
    if (remaining > 0) {
      this.discussionReplyFailures.set(id, remaining - 1);
      throw new Error(`讨论 ${id} 模拟回复失败`);
    }
    const idempotencyKey = String(body.idempotency_key ?? "").trim();
    if (idempotencyKey && this.discussionReplyIdempotency.has(idempotencyKey)) {
      return { ok: true };
    }
    discussion.replies.push(String(body.body ?? ""));
    discussion.replyMrs.push(body.mr);
    if (idempotencyKey) this.discussionReplyIdempotency.add(idempotencyKey);
    if (body.resolve === true) discussion.resolved = true;
    return { ok: true };
  }

  /** 测试注入:扣住下一次对该讨论的回复应答,直到调用返回的 release——用来撑开
   *  "发送在途时别处往信箱追加"的竞态窗口。 */
  holdNextDiscussionReply(id: string): () => void {
    let release!: () => void;
    this.discussionReplyHolds.set(id, new Promise<void>((resolve) => { release = resolve; }));
    return release;
  }

  failNextDiscussionReplies(id: string, count = 1): void {
    this.discussionReplyFailures.set(id, Math.max(0, Math.trunc(count)));
  }

  /** 测试注入:种一条未解决的检视意见。 */
  seedDiscussion(input: Omit<Discussion, "resolved" | "replies" | "replyMrs">): void {
    this.discussions.push({ ...input, resolved: false, replies: [], replyMrs: [] });
  }

  /** MR 详情页(最小 HTML,零依赖):事实 + 合入按钮。 */
  private mergeRequestPage(id: number): string | undefined {
    const mr = this.mergeRequests.find((item) => item.id === id);
    if (!mr) return undefined;
    const gates = this.mergeGates(
      mr.source_branch, mr.target_branch, mr.repo, String(mr.id)).gates;
    const blocked = gates.filter((gate) => !gate.passed);
    const esc = (value: string) => value.replace(/[&<>"]/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]!));
    return [
      "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">",
      `<title>MR !${mr.id} · ${esc(mr.title)}</title>`,
      "<style>body{font:14px/1.7 system-ui;max-width:640px;margin:40px auto;padding:0 16px}",
      "code{background:#f2f2f4;padding:1px 5px;border-radius:4px}",
      "button{padding:8px 20px;font-size:14px;cursor:pointer}",
      ".ok{color:#0a7a3d}.bad{color:#b3261e}</style></head><body>",
      `<h1>MR !${mr.id} ${esc(mr.title)}</h1>`,
      `<p><code>${esc(mr.source_branch)}</code> → `
        + `<code>${esc(mr.target_branch)}</code> · SHA `
        + `<code>${esc(mr.sha.slice(0, 12))}</code></p>`,
      `<p>状态:<b>${mr.merge_state === "merged" ? "已合入"
        : mr.merge_state === "closed" ? "已关闭" : "在途"}</b></p>`,
      "<ul>",
      ...gates.map((gate) => `<li class=\"${gate.passed ? "ok" : "bad"}\">`
        + `${gate.passed ? "✔" : "✘"} ${esc(gate.name)}`
        + `${gate.detail ? ` — ${esc(gate.detail)}` : ""}</li>`),
      "</ul>",
      mr.merge_state === "opened"
        ? (blocked.length
            ? `<p class=\"bad\">${blocked.length} 项门禁未过,不能合入。</p>`
            : `<form method=\"post\" action=\"/mr/${mr.id}/merge\">`
              + "<button type=\"submit\">合入</button></form>")
        : "",
      "</body></html>",
    ].join("\n");
  }

  /** 浏览器合入:门禁全绿才放行,真实快进目标 ref 再翻状态——
   * 交付事实来自远端真实状态,假件也不许只翻字段。 */
  private mergeMergeRequest(id: number): { ok: boolean; error?: string } {
    const mr = this.mergeRequests.find((item) => item.id === id);
    if (!mr) return { ok: false, error: `MR ${id} 不存在` };
    if (mr.merge_state !== "opened") {
      return { ok: false, error: `MR ${id} 已是 ${mr.merge_state}` };
    }
    const repo = this.repositoryPath(mr.repo);
    const blocked = this.mergeGates(
      mr.source_branch, mr.target_branch, repo, String(mr.id))
      .gates.filter((gate) => !gate.passed);
    if (blocked.length) {
      return { ok: false,
        error: `门禁未过: ${blocked.map((gate) => gate.name).join("、")}` };
    }
    try {
      execFileSync("git", ["-C", repo, "merge-base",
        "--is-ancestor", mr.target_branch, mr.sha], { encoding: "utf-8" });
    } catch {
      return { ok: false,
        error: "目标分支已前进且非快进,请先在任务侧合并目标分支再推送" };
    }
    git(repo, "update-ref",
      `refs/heads/${mr.target_branch}`, mr.sha);
    mr.merge_state = "merged";
    mr.state = "等待合入" as MergeRequest["state"];
    return { ok: true };
  }

  /** 测试裁定:平台侧把 MR 合入/关闭(审批人点了按钮)。 */
  settleMr(source: string, state: "merged" | "closed"): void {
    for (const mr of this.mergeRequests) {
      if (mr.source_branch === source) mr.merge_state = state;
    }
  }

  private triggerPipeline(sha: string, requestedRepo?: string): PipelineRun {
    if (!sha) throw new Error("sha 必填:流水线结果必须绑定代码版本");
    const repo = this.repositoryPath(requestedRepo);
    this.counter += 1;
    const status = this.statusQueue.shift() ?? this.nextPipelineStatus;
    const run: PipelineRun = {
      id: this.counter,
      sha,
      status,
      ...(repo !== this.barePath ? { repo } : {}),
      ...(!this.omitTypedChecks
        ? { checks: this.consumePipelineChecks(status) } : {}),
      log: status === "failed" ? this.nextPipelineLog : undefined,
    };
    this.pipelines.push(run);
    if (run.status === "success") {
      for (const mr of this.mergeRequests) {
        if (mr.sha === sha && (mr.repo ?? this.barePath) === repo) {
          mr.state = "等待合入";
        }
      }
    }
    return run;
  }

  /** SHA 精确匹配才算数:旧绿灯不背书新代码(§14.5)。 */
  private pipelineStatus(
    sha: string,
    requestedRepo?: string,
  ): { sha: string; runs: PipelineRun[] } {
    const repo = this.repositoryPath(requestedRepo);
    return { sha, runs: this.pipelines.filter((run) => run.sha === sha
      && (run.repo ?? this.barePath) === repo) };
  }

  /** 异步流水线的事后裁定(模拟真实平台跑完):running → 终态,
   * 绿灯连带把同 SHA 的 MR 升为等待合入——与同步路径同一语义。 */
  finishPipeline(sha: string, status: "success" | "failed", log?: string): void {
    for (const run of this.pipelines) {
      if (run.sha === sha && run.status === "running") {
        run.status = status;
        if (!this.omitTypedChecks) {
          run.checks = this.consumePipelineChecks(status);
        }
        if (status === "failed") run.log = log ?? this.nextPipelineLog;
      }
    }
    if (status === "success") {
      for (const mr of this.mergeRequests) {
        if (mr.sha === sha) mr.state = "等待合入";
      }
    }
  }

  private consumePipelineChecks(
    status: "running" | "success" | "failed",
  ): PipelineCheck[] {
    const injected = this.nextPipelineChecks;
    this.nextPipelineChecks = undefined;
    if (injected) return injected.map((item) => ({ ...item }));
    if (status === "success") {
      return [
        { dimension: "COMPILE", status: "success", job: "compile" },
        { dimension: "UT", status: "success", job: "unit-test" },
        { dimension: "CODECHECK", status: "success", job: "codecheck" },
      ];
    }
    if (status === "running") {
      return [
        { dimension: "COMPILE", status: "running", job: "compile" },
        { dimension: "UT", status: "pending", job: "unit-test" },
        { dimension: "CODECHECK", status: "pending", job: "codecheck" },
      ];
    }
    return [
      { dimension: "COMPILE", status: "failed", job: "compile" },
      { dimension: "UT", status: "not_run", job: "unit-test" },
      { dimension: "CODECHECK", status: "not_run", job: "codecheck" },
    ];
  }
}
