// 假 sidecar:与 harness/memsearch-sidecar.py 同协议,不装模型。
// 语义:search 按子串在 corpus/index.jsonl 里找(query 或 path_prefix 命中
// trigger/conclusion/paths),expand 读 md。开关:
//   STUB_DIE_AFTER=<n>   应答 n 条后自杀(测重拉)
//   STUB_SLOW_SEARCH=1   search 睡 3 秒(测预算)
//   STUB_BOOT_FAIL=1     启动即报错(测起不来)
//   STUB_BOOT_DELAY_MS=n 延后 ready(测启动与查询预算分别计时)
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const corpus = args[args.indexOf("--corpus") + 1];
const out = (payload) => process.stdout.write(JSON.stringify(payload) + "\n");
if (process.env.STUB_IGNORE_TERM) process.on("SIGTERM", () => {});

if (process.env.STUB_BOOT_FAIL) {
  out({ id: 0, error: "sidecar 启动失败: stub" });
  process.exit(2);
}
if (process.env.STUB_BOOT_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.STUB_BOOT_DELAY_MS)));
out({ id: 0, ok: true, ready: true });

let answered = 0;
const rows = () => {
  const path = join(corpus, "index.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return undefined; } })
    .filter(Boolean);
};

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  let req;
  try { req = JSON.parse(line); } catch { out({ id: null, error: "bad json" }); return; }
  const done = (payload) => {
    out({ id: req.id, ...payload });
    answered += 1;
    if (process.env.STUB_DIE_AFTER && answered >= Number(process.env.STUB_DIE_AFTER)) {
      process.exit(9);
    }
  };
  if (req.op === "health") return done({ ok: true, corpus });
  if (req.op === "ingest") return done({ ok: true, chunks: 3 });
  if (req.op === "reindex") return done({ ok: true, chunks: rows().length * 3 });
  if (req.op === "search") {
    if (process.env.STUB_SLOW_SEARCH) await new Promise((r) => setTimeout(r, 3000));
    const needle = String(req.query ?? "");
    const hits = rows()
      .filter((row) => (!req.repo || row.repo === req.repo)
        && (!req.path_prefix || (row.paths ?? []).some((p) => p.startsWith(req.path_prefix)))
        && (`${row.trigger}${row.conclusion}`.includes(needle)
          || needle.split(/[\s:：,，]+/).some((w) => w && `${row.trigger}${row.conclusion}`.includes(w))))
      .slice(0, req.limit ?? 8)
      .map((row) => ({ id: row.id, score: 0.5, heading: "结论", snippet: `## 结论\n${row.conclusion}`,
        file: join(corpus, row.file), repo: row.repo, judged_by: row.judged_by, source: row.source,
        scope: row.scope, at: row.at, task: row.task, paths: row.paths, line: row.line, phase: row.phase }));
    return done({ ok: true, hits });
  }
  if (req.op === "expand") {
    const row = rows().find((item) => item.id === req.memory_id);
    if (!row) return done({ error: `记忆 ${req.memory_id} 不存在` });
    return done({ ok: true, memory_id: row.id, content: readFileSync(join(corpus, row.file), "utf-8") });
  }
  return done({ error: `未知操作: ${req.op}` });
});
lines.on("close", () => process.exit(0));
