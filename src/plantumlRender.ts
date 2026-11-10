/**
 * PlantUML 出图:用参考实现,不再自己实现文法。
 *
 * 为什么:前端手搓的四套解析器(时序/类/活动/拓扑)共 1,562 行,八月以来
 * 专门修"又不认某个写法"的提交 7 笔,每补一条还可能抢别的图的判定。
 * PlantUML 语法面大且没有正式文法,靠补是补不完的。用户 2026-09-06 拍板:
 * 生产宿主有 JDK,jar 随仓库 vendored,手搓渲染器删除。
 *
 * 形态:服务端 `java -jar plantuml-mit.jar -tsvg -pipe`,布局用自带 smetana
 * (不依赖 Graphviz),按源码哈希缓存到数据目录;前端只显示 SVG。
 * 出不了图(没有 Java、超时、jar 缺失)一律 fail-open:返回原因,页面原样
 * 显示源码——这是旁路,绝不影响任务。语法错误时 PlantUML 自己会画一张
 * 标出错行的错误图(退出码 200),照样返回给人看,并标 syntax_error。
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PLANTUML_JAR = resolve(
  dirname(fileURLToPath(import.meta.url)), "..", "vendor", "plantuml", "plantuml-mit-1.2026.8.jar");

/** 单张图的预算:smetana 布局大图也就几秒;超过就是卡死,不等。 */
export const PLANTUML_TIMEOUT_MS = 30_000;
export const PLANTUML_SOURCE_LIMIT = 256 * 1024;

export interface PlantUmlResult {
  svg?: string;
  /** PlantUML 判定源码有语法错误:svg 是它画的错误图(标出错行)。 */
  syntax_error?: boolean;
  /** 出不了图的原因(没有 Java / jar 缺失 / 超时 / 进程失败)。 */
  error?: string;
  cached?: boolean;
}

let javaCommand: string | null | undefined;
let javaProbeFailedAt = 0;

/** 找 Java:JAVA_HOME 优先,其次 PATH。失败只缓存 30 秒，补齐环境后可接续。 */
export function findJava(): string | undefined {
  if (javaCommand || javaCommand === null && Date.now() - javaProbeFailedAt < 30_000) return javaCommand ?? undefined;
  // Homebrew 的 openjdk@N 是 keg-only,不进 PATH(2026-09-06 本机装 JDK 21 实锤):
  // 按固定前缀探一遍,免得每台开发机都得改 shell 配置。
  const brewKegs = ["/opt/homebrew/opt", "/usr/local/opt"].flatMap((root) => {
    try {
      return readdirSync(root).filter((name) => /^openjdk(@\d+)?$/.test(name))
        .sort().reverse().map((name) => join(root, name, "bin", "java"));
    } catch { return []; }
  });
  const candidates = [
    ...(process.env.JAVA_HOME ? [join(process.env.JAVA_HOME, "bin", "java")] : []),
    "java",
    ...brewKegs,
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf-8", timeout: 10_000 });
    if (!probe.error && probe.status === 0) {
      javaCommand = candidate;
      return candidate;
    }
  }
  javaCommand = null;
  javaProbeFailedAt = Date.now();
  return undefined;
}

/** 测试与自检用:重置 Java 探测缓存。 */
export function resetJavaProbe(): void {
  javaCommand = undefined;
  javaProbeFailedAt = 0;
}

export function plantUmlCacheKey(source: string): string {
  return createHash("sha256").update(`${PLANTUML_JAR}\0${source}`).digest("hex");
}

export async function renderPlantUml(
  source: string,
  options: { cacheDir?: string; jar?: string; timeoutMs?: number; signal?: AbortSignal; sandbox?: boolean } = {},
): Promise<PlantUmlResult> {
  options.signal?.throwIfAborted();
  const text = String(source ?? "");
  if (!text.trim()) return { error: "没有 PlantUML 源码" };
  if (Buffer.byteLength(text) > PLANTUML_SOURCE_LIMIT) {
    return { error: `源码超过 ${PLANTUML_SOURCE_LIMIT / 1024} KB,不出图` };
  }
  const jar = options.jar ?? PLANTUML_JAR;
  if (!existsSync(jar)) return { error: `PlantUML 运行库缺失: ${jar}` };
  const java = findJava();
  if (!java) return { error: "服务端没有 Java,无法出图(生产宿主应带 JDK)" };

  const key = plantUmlCacheKey(`${jar}\0${options.sandbox ? "SANDBOX" : "default"}\0${text}`);
  const cachePath = options.cacheDir ? join(options.cacheDir, `${key}.json`) : undefined;
  if (cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8"));
      if (cached.version === 1 && typeof cached.svg === "string" && /^<(?:svg|\?xml)/.test(cached.svg)
          && typeof cached.syntax_error === "boolean") return { svg: cached.svg, cached: true, ...(cached.syntax_error ? { syntax_error: true } : {}) };
    } catch { /* 不完整或损坏的缓存重新渲染，不能把缺少错误标记当成功。 */ }
  }

  // 源码里的 @startuml/@enduml 缺席时补上:文档里常常只写正文。
  const wrapped = /@start\w+/.test(text) ? text : `@startuml\n${text}\n@enduml\n`;
  options.signal?.throwIfAborted();
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((done) => {
    const child = spawn(java, [
      "-Djava.awt.headless=true", "-Dfile.encoding=UTF-8",
      ...(options.sandbox ? ["-DPLANTUML_SECURITY_PROFILE=SANDBOX"] : []),
      "-jar", jar, "-tsvg", "-pipe", "-Playout=smetana", "-charset", "UTF-8",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); },
      options.timeoutMs ?? PLANTUML_TIMEOUT_MS);
    const abort = () => { child.kill("SIGKILL"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      done({ code: null, stdout: "", stderr: String(error), timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      done({ code, stdout: Buffer.concat(out).toString("utf-8"),
        stderr: Buffer.concat(err).toString("utf-8"), timedOut });
    });
    child.stdin.on("error", () => { /* 子进程先死时的 EPIPE:close 会给结论 */ });
    child.stdin.end(wrapped);
  });

  options.signal?.throwIfAborted();
  if (outcome.timedOut) return { error: `出图超过 ${(options.timeoutMs ?? PLANTUML_TIMEOUT_MS) / 1000} 秒,已终止` };
  if (outcome.code !== 0 && outcome.code !== 200) return { error: `PlantUML 进程失败(退出码 ${outcome.code ?? "?"}): ${outcome.stderr.trim().slice(0, 300) || "未正常结束"}` };
  const svg = outcome.stdout.trim();
  if (!svg.startsWith("<svg") && !svg.startsWith("<?xml")) {
    return { error: `PlantUML 进程失败(退出码 ${outcome.code ?? "?"}): ${outcome.stderr.trim().slice(0, 300) || "没有输出"}` };
  }
  // 仅明确的语法错误退回作者修订；被终止等进程故障不能伪装成语法错误。
  const syntaxError = outcome.code === 200;
  if (cachePath) {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, svg, syntax_error: syntaxError }), { mode: 0o600 });
      renameSync(temporary, cachePath);
    } catch { /* 缓存是旁路 */ }
    finally { try { unlinkSync(temporary); } catch { /* 已重命名或没有临时文件。 */ } }
  }
  return { svg, ...(syntaxError ? { syntax_error: true } : {}) };
}
