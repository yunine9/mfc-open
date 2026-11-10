import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIFY_SOURCE_LIMIT, ARCHIFY_TYPES, assertOfflineDiagram } from "./storyArchitecture.ts";

export const ARCHIFY_COMMIT = "10722002bb8777ecb639d93c49586fae4adf3ae4";
export const ARCHIFY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../vendor/archify");
export interface ArchifyResult { html?: string; error?: string }
const cache = new Map<string, string>();
const pending = new Map<string, Promise<ArchifyResult>>();
const MAX_CACHE_BYTES = 12 * 1024 * 1024;
let cacheBytes = 0;

/** 沙箱 iframe 只运行固定渲染器的交互脚本，禁止网络、表单和外部资源。 */
export function isolateArchifyHtml(html: string): string {
  const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return html.replace(/<head[^>]*>/i, (head) => `${head}<meta http-equiv="Content-Security-Policy" content="${policy}">`);
}

/** 使用上游原生渲染器。限时、限量、临时目录和小缓存均只影响预览，不改变任务状态。 */
export async function renderArchify(source: Record<string, unknown>): Promise<ArchifyResult> {
  let text: string;
  try {
    if (!ARCHIFY_TYPES.includes(source.diagram_type as typeof ARCHIFY_TYPES[number])) throw new Error("不支持的图类型");
    text = JSON.stringify(source);
    if (Buffer.byteLength(text) > ARCHIFY_SOURCE_LIMIT) throw new Error("单图超过 256 KB");
    assertOfflineDiagram(source);
  } catch (error) { return { error: String(error) }; }
  const key = createHash("sha256").update(`${ARCHIFY_COMMIT}\0${text}`).digest("hex");
  if (cache.has(key)) return { html: cache.get(key) };
  if (pending.has(key)) return pending.get(key)!;
  if (pending.size >= 2) return { error: "架构图正在生成，请稍后重试" };
  const work = (async (): Promise<ArchifyResult> => {
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), "mfc-archify-"));
      const input = join(dir, "input.json"), output = join(dir, "diagram.html");
      await writeFile(input, text, { mode: 0o600 });
      // 直接调用类型入口，避开 CLI 更新检查。固定输出路径覆盖 meta.output，
      // 环境只传运行所需变量，不能继承宿主凭据、NODE_OPTIONS 或仓库取证配置。
      await new Promise<void>((done, reject) => execFile(process.execPath,
        [join(ARCHIFY_ROOT, "renderers", String(source.diagram_type), `render-${source.diagram_type}.mjs`), input, output],
        { cwd: dir, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
          env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", ARCHIFY_UPDATE_CHECK_DISABLED: "1" } },
        (error, _stdout, stderr) => error ? reject(new Error(stderr.slice(0, 2500) || error.message)) : done()));
      const html = isolateArchifyHtml(await readFile(output, "utf8"));
      const bytes = Buffer.byteLength(html);
      if (bytes > 4 * 1024 * 1024) throw new Error("生成页面超过 4 MB，请精简图源");
      while (cache.size && cacheBytes + bytes > MAX_CACHE_BYTES) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= Buffer.byteLength(cache.get(oldest)!); cache.delete(oldest);
      }
      cache.set(key, html); cacheBytes += bytes;
      return { html };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    finally { if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined); }
  })();
  pending.set(key, work);
  try { return await work; } finally { pending.delete(key); }
}
