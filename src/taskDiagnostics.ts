/**
 * 问题定位诊断包:把一个任务的全部可定位事实汇成**一个 markdown 文件**。
 *
 * 设计口径(2026-08-31 用户拍板):
 * - 不脱敏,原样采集——包是给自己人和模型看的,清洗会把线索洗掉。
 *   唯一例外:`<data>/.runtime/**` 下的明文 git 令牌文件**永不入包**
 *   (对定位零信息量,而诊断包生来就要被转发);这里靠"白名单采集"
 *   从结构上保证——采集器只收下面明确列出的路径,从不整目录扫 dataDir。
 * - 每一节独立 fail-soft:坏现场更需要能出包,一节读不到就写一行
 *   "读取失败:<原因>",绝不让整包难产。
 * - 大文件截尾:events/transcript/容器日志只取尾部,并写明总行数与
 *   完整文件路径,要全量的人知道去哪拿。
 */

import { execFile } from "node:child_process";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** 单文件全文的体积上限:超过就头尾各半,中间说明省略了多少。 */
const FILE_BYTE_CAP = 200 * 1024;
const EVENTS_TAIL = 200;
const TRANSCRIPT_TAIL = 100;
const CONTAINER_LOG_TAIL = 200;

export interface DiagnosticsInput {
  taskId: string;
  /** 任务目录(task.json / events.jsonl / waiting.json / reviews/)。 */
  workspace: string;
  /** 代码现场(git 仓 + .mae-flow.json*);没有就跳过相关节。 */
  cwd?: string;
  /** 触发原因(自动触发写状态语,手动触发写"人工导出")。 */
  reason?: string;
  /** 服务日志环形缓冲切片(serve 注入;测试可缺席)。 */
  serviceLogTail?: string[];
  /** 容器句柄(名字/ID);在跑时补 docker inspect + 日志尾部。 */
  container?: { name?: string; containerId?: string };
  /** dataDir 级 crash.log 所在目录(缺席则跳过)。 */
  dataDir?: string;
}

function clip(text: string, cap = FILE_BYTE_CAP): string {
  if (Buffer.byteLength(text) <= cap) return text;
  const half = Math.floor(cap / 2);
  return `${text.slice(0, half)}\n…（中间省略,原文 ${
    Buffer.byteLength(text)} 字节,请看原始文件）…\n${text.slice(-half)}`;
}

function tail(text: string, lines: number): { body: string; total: number } {
  const rows = text.split("\n").filter((row) => row.length > 0);
  return {
    body: rows.slice(-lines).join("\n"),
    total: rows.length,
  };
}

function fence(body: string, lang = ""): string {
  // 内容里可能有 ``` 围栏(markdown 材料):用四反引号包,避免提前闭合。
  return `\`\`\`\`${lang}\n${body}\n\`\`\`\`\n`;
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

function readFileSection(title: string, path: string): string {
  try {
    if (!existsSync(path)) return section(title, `（不存在:${path}）`);
    return section(`${title}\n\n> ${path}`,
      fence(clip(readFileSync(path, "utf-8"))));
  } catch (error) {
    return section(title, `读取失败:${String(error)}`);
  }
}

function readTailSection(title: string, path: string, lines: number): string {
  try {
    if (!existsSync(path)) return section(title, `（不存在:${path}）`);
    const { body, total } = tail(readFileSync(path, "utf-8"), lines);
    return section(
      `${title}(尾部 ${Math.min(lines, total)}/${total} 行)\n\n> ${path}`,
      fence(clip(body)));
  } catch (error) {
    return section(title, `读取失败:${String(error)}`);
  }
}

async function command(
  title: string,
  file: string,
  args: string[],
  cwd?: string,
): Promise<string> {
  try {
    const result = await run(file, args, {
      cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    });
    const body = [result.stdout, result.stderr]
      .map((part) => String(part ?? "").trim()).filter(Boolean).join("\n");
    return `### ${title}\n\n> ${file} ${args.join(" ")}\n\n${
      fence(clip(body || "（无输出）"))}`;
  } catch (error) {
    // 命令失败本身就是定位事实(比如 is-ancestor 非 0 = 基线脱离),
    // 带着退出码和输出如实入包。
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    const body = [failed.stdout, failed.stderr, `exit=${failed.code ?? "?"}`]
      .map((part) => String(part ?? "").trim()).filter(Boolean).join("\n");
    return `### ${title}\n\n> ${file} ${args.join(" ")}\n\n${
      fence(clip(body || String(error)))}`;
  }
}

/** 内核建分支时记录的定格基线(与 artifacts.frozenTaskBaseline 同口径,
 * 这里独立实现以保持采集器零内部依赖——采集器要能在别的模块坏掉时
 * 照常出包)。 */
function frozenBaselineOf(cwd: string): string | undefined {
  try {
    const state = JSON.parse(readFileSync(join(cwd, ".mae-flow.json"), "utf-8"));
    const recorded = [
      state?.step_heads?.branch_create,
      state?.step_heads?.workflow_select,
    ].find((value) => typeof value === "string" && value.trim());
    return recorded ? String(recorded).trim() : undefined;
  } catch {
    return undefined;
  }
}

async function gitFacts(cwd: string): Promise<string> {
  const parts: string[] = [];
  parts.push(await command("HEAD 与分支", "git",
    ["-C", cwd, "status", "--porcelain=v1", "-b"]));
  parts.push(await command("最近 20 条提交", "git",
    ["-C", cwd, "log", "--oneline", "--decorate", "-20"]));
  const frozen = frozenBaselineOf(cwd);
  if (frozen) {
    parts.push(await command(
      `定格基线 ${frozen.slice(0, 12)} 是否仍为 HEAD 祖先(exit=0 是)`,
      "git", ["-C", cwd, "merge-base", "--is-ancestor", frozen, "HEAD"]));
  } else {
    parts.push("### 定格基线\n\n（内核状态里没有 step_heads 记录）\n");
  }
  parts.push(await command("远端配置", "git", ["-C", cwd, "remote", "-v"]));
  return section("Git 事实", parts.join("\n"));
}

async function containerFacts(
  container: NonNullable<DiagnosticsInput["container"]>,
): Promise<string> {
  const handle = container.containerId || container.name;
  if (!handle) return section("容器", "（无容器句柄）");
  const parts: string[] = [];
  parts.push(await command("docker inspect(状态/镜像/资源)", "docker", [
    "inspect", "--format",
    "{{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} "
    + "image={{.Config.Image}} started={{.State.StartedAt}} "
    + "mem={{.HostConfig.Memory}} cpus={{.HostConfig.NanoCpus}} "
    + "user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}}",
    handle,
  ]));
  parts.push(await command(`容器日志尾部 ${CONTAINER_LOG_TAIL} 行`, "docker",
    ["logs", "--tail", String(CONTAINER_LOG_TAIL), handle]));
  return section("容器事实", parts.join("\n"));
}

function reviewsSection(workspace: string): string {
  const dir = join(workspace, "reviews");
  try {
    if (!existsSync(dir)) return section("人审现场 reviews/", "（不存在）");
    const files = readdirSync(dir)
      .filter((name) => statSync(join(dir, name)).isFile()).sort();
    if (!files.length) return section("人审现场 reviews/", "（空目录）");
    return section("人审现场 reviews/", files.map((name) =>
      readFileSection(name, join(dir, name))).join("\n"));
  } catch (error) {
    return section("人审现场 reviews/", `读取失败:${String(error)}`);
  }
}

function kernelSection(cwd: string): string {
  // 内核状态文件族:.mae-flow.json 与它的旁账(quality-executions /
  // agent-observations / advisories …)。只在代码现场根目录按前缀收,
  // 不做任何递归扫描。
  try {
    const names = readdirSync(cwd)
      .filter((name) => name.startsWith(".mae-flow.json")).sort();
    if (!names.length) return section("内核现场", "（无 .mae-flow.json*）");
    return section("内核现场", names.map((name) =>
      readFileSection(name, join(cwd, name))).join("\n"));
  } catch (error) {
    return section("内核现场", `读取失败:${String(error)}`);
  }
}

/** 汇集全部事实,返回 markdown 全文。 */
export async function collectTaskDiagnostics(
  input: DiagnosticsInput,
): Promise<string> {
  const parts: string[] = [];
  parts.push(`# 任务 ${input.taskId} 诊断包\n`);
  parts.push(section("采集信息", [
    `- 生成时间:${new Date().toISOString()}`,
    `- 触发原因:${input.reason ?? "人工导出"}`,
    `- 任务目录:${input.workspace}`,
    `- 代码现场:${input.cwd ?? "（无)"}`,
    `- 主机:node ${process.version} / ${process.platform} ${process.arch}`,
  ].join("\n")));

  parts.push(readFileSection("任务状态 task.json",
    join(input.workspace, "task.json")));
  parts.push(readFileSection("待办与决定 waiting.json",
    join(input.workspace, "waiting.json")));
  if (input.cwd) {
    parts.push(kernelSection(input.cwd));
    parts.push(await gitFacts(input.cwd));
  }
  parts.push(reviewsSection(input.workspace));
  parts.push(readTailSection("会话事件 events.jsonl",
    join(input.workspace, "events.jsonl"), EVENTS_TAIL));
  parts.push(readTailSection("会话转写 transcript.jsonl",
    join(input.workspace, "transcript.jsonl"), TRANSCRIPT_TAIL));
  if (input.serviceLogTail?.length) {
    parts.push(section(`服务日志(环形缓冲尾部 ${
      input.serviceLogTail.length} 行)`,
      fence(clip(input.serviceLogTail.join("\n")))));
  }
  if (input.container) {
    parts.push(await containerFacts(input.container));
  }
  if (input.dataDir) {
    parts.push(readTailSection("服务崩溃日志 crash.log",
      join(input.dataDir, "crash.log"), 100));
  }
  return parts.join("\n");
}

/** 采集并落盘到 <workspace>/diagnostics/,返回文件路径。
 * dedupeKey:自动触发用,同一事故(状态+原因)只落一份,重启/重复
 * persist 不刷屏;人工导出不传,每次都出新文件。 */
export async function writeTaskDiagnostics(
  input: DiagnosticsInput & { dedupeKey?: string },
): Promise<{ path: string; skipped: boolean }> {
  const dir = join(input.workspace, "diagnostics");
  mkdirSync(dir, { recursive: true });
  const suffix = input.dedupeKey
    ? `-${hashOf(input.dedupeKey)}` : "";
  if (suffix) {
    const existing = readdirSync(dir)
      .find((name) => name.endsWith(`${suffix}.md`));
    if (existing) return { path: join(dir, existing), skipped: true };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}${suffix}.md`);
  writeFileSync(path, await collectTaskDiagnostics(input));
  return { path, skipped: false };
}

function hashOf(text: string): string {
  // 8 位 FNV-1a:只用来给同一事故做文件名去重,不是安全用途。
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
