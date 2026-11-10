/**
 * 任务记忆三期上线自查演练(preflight 4.8 调用,也可单独跑)。
 *
 *   npx tsx harness/memory-drill.ts [--memsearch <venv python>]
 *                                   [--models <models.json> --provider <p> [--model <m>]]
 *
 * 用真件把三期的链路走一遍:记录 → 起草收尾 → 台账/效果账 → 目录摘要兜底 →
 * 沉底归档;给了 sidecar 就再验"起草后按新说法能搜到、归档重建后搜不到";
 * 给了模型就真起草一次(90 s 预算)。全部在临时目录,不碰真语料。
 *
 * 部署边界(用户 2026-09-03 追问"容器内可用吗"):这条链路**全在宿主进程里**
 * ——sidecar 是宿主拉的子进程,起草是宿主发的模型调用,corpus_search 是宿主
 * 进程内的 pi 工具;任务容器里不需要 python、memsearch 或语料目录。这里
 * 不碰 docker,跑得过就说明宿主侧齐了。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore, memoryWeight, EMPTY_STATS } from "../src/taskMemory.ts";
import { MemorySidecar } from "../src/memorySidecar.ts";
import {
  MEMORY_DRAFT_BUDGET_MS, buildMemoryDraftPrompt, parseMemoryDraft,
  renderDirectoryDigestFallback,
} from "../src/memoryDraft.ts";
import { draftWithModel } from "../src/modelTransport.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const python = flag("--memsearch");
const modelsPath = flag("--models");
const DAY = 86_400_000;
const notes: string[] = [];
const skipped: string[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "mfc-memory-drill-"));
  const store = new MemoryStore(dataDir);
  let sidecar: MemorySidecar | undefined;
  try {
    // 1. 记录 + 起草收尾
    const record = store.record({
      source: "annotation", judged_by: "human", scope: "local", repo: "_drill",
      paths: ["src/filter/FilterEngine.java"], line: 88, task: "drill",
      evidence: "drill", trigger: "改 src/filter/FilterEngine.java 第 88 行附近时",
      quote: "if (enabled) check();", problem: "黑名单判断放在开关后面了",
      conclusion: "黑名单判断必须在渠道开关之前",
    });
    let draft = { trigger: "调整过滤器里判断先后顺序时", scope: "general" as const };
    if (modelsPath) {
      const modelsJson = JSON.parse(readFileSync(resolve(modelsPath), "utf-8")) as {
        providers?: Record<string, { models?: Array<{ id?: string }> }> };
      const provider = flag("--provider") ?? Object.keys(modelsJson.providers ?? {})[0];
      const model = flag("--model") ?? modelsJson.providers?.[provider ?? ""]?.models?.[0]?.id;
      assert(provider && model, "models.json 里找不到可用的 provider/model");
      const started = Date.now();
      const prompt = buildMemoryDraftPrompt(record);
      const text = await draftWithModel({
        modelsJson: modelsJson as Record<string, unknown>, provider, model,
        system: prompt.system, user: prompt.user, timeoutMs: MEMORY_DRAFT_BUDGET_MS,
      });
      const parsed = parseMemoryDraft(text);
      assert(parsed, `模型起草形状不对: ${text.slice(0, 200)}`);
      draft = parsed;
      notes.push(`模型起草 ${Date.now() - started}ms → ${parsed.scope} / ${parsed.trigger}`);
    } else {
      skipped.push("模型起草(给 --models 后执行)");
    }
    const finalized = store.finalizeDraft(record.id, { ...draft, state: "model" });
    assert(finalized.revision === 2 && store.list().length === 1, "起草收尾没落成同一条记录的第二版");
    assert(readFileSync(join(store.root, finalized.file), "utf-8").includes(`# ${draft.trigger}`),
      "md 标题没换成起草结果");

    // 2. 台账与效果账
    store.ledger.append({ kind: "push", id: record.id, task: "drill-2", note: "launch" });
    const before = memoryWeight(finalized, store.ledger.stats().get(record.id) ?? EMPTY_STATS);
    store.ledger.append({ kind: "rework", id: record.id, task: "drill-2", note: finalized.paths[0] });
    const after = memoryWeight(finalized, store.ledger.stats().get(record.id) ?? EMPTY_STATS);
    // c28e4cfc 起"返工只记关联、不判定经验有害"：返工进效果账，但不再压低权重。
    assert((store.ledger.stats().get(record.id) ?? EMPTY_STATS).reworks === 1, "返工没有记进效果账");
    assert(after === before, "返工不应改变经验权重");

    // 3. 目录摘要兜底
    const many = Array.from({ length: 16 }, (_, index) => store.record({
      source: "prepush_fix", judged_by: "pipeline", scope: "local", repo: "_drill",
      paths: ["pom.xml"], task: `drill-${index}`, evidence: `e${index}`,
      trigger: "加新渠道时", conclusion: `枚举新增渠道要同步改 registry.xml(${index})`,
    }));
    assert(renderDirectoryDigestFallback("", many).includes("另有 11 条"), "目录摘要兜底不对");

    // 4. sidecar:起草后按新说法搜到
    if (python) {
      assert(existsSync(python), `--memsearch 指向的 python 不存在: ${python}`);
      sidecar = new MemorySidecar({
        python, script: resolve("harness/memsearch-sidecar.py"),
        corpusDir: store.root, milvusPath: join(dataDir, "milvus.db"),
        budgets: { bootMs: 120_000, ingestMs: 20_000, searchMs: 5_000 },
        env: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, log: () => {},
      });
      const t0 = Date.now();
      assert(await sidecar.start(), "sidecar 起不来");
      const bootMs = Date.now() - t0;
      assert(await sidecar.ingest(join(store.root, finalized.file)), "ingest 失败");
      assert(await sidecar.ingest(join(store.root, many[0].file)), "ingest 失败");
      const t1 = Date.now();
      const hits = await sidecar.search({ query: draft.trigger, repo: "_drill" });
      const searchMs = Date.now() - t1;
      assert(hits?.[0]?.id === record.id, `起草后的新说法没有首位命中: ${JSON.stringify(hits)}`);
      notes.push(`sidecar ready ${bootMs}ms, search ${searchMs}ms`);
    } else {
      skipped.push("sidecar 检索(给 --memsearch 后执行)");
    }

    // 5. 沉底:一年没人用的挪走、还能读、重建索引后搜不到
    const idle = store.record({
      source: "annotation", judged_by: "human", scope: "local", repo: "_drill",
      paths: ["src/Old.java"], task: "drill-old", evidence: "old",
      trigger: "改 Old.java 时", conclusion: "这条一年没人用",
    });
    if (sidecar) assert(await sidecar.ingest(join(store.root, idle.file)), "ingest 失败");
    const archived = store.sweepArchive({ now: Date.now() + 400 * DAY });
    assert(archived.some((row) => row.id === idle.id), "一年没人用的没沉底");
    assert(!archived.some((row) => row.id === record.id), "刚推过的被误沉底");
    assert(existsSync(join(store.root, "_archive", idle.file)) && store.read(idle.id), "归档后正本丢了或读不到");
    if (sidecar) {
      const t2 = Date.now();
      const chunks = await sidecar.reindex();
      assert(typeof chunks === "number", "归档后索引重建没回块数");
      const gone = await sidecar.search({ query: "一年没人用", repo: "_drill" });
      assert(!(gone ?? []).some((hit) => hit.id === idle.id), "归档重建后仍能搜到");
      notes.push(`reindex ${Date.now() - t2}ms/${chunks} 块`);
    }
    console.log(`memory-drill ok: ${notes.join(", ") || "确定性部分全过"}`
      + (skipped.length ? `;未验:${skipped.join("、")}` : "")
      + ";全链路在宿主进程内,任务容器无需 python/memsearch");
  } finally {
    sidecar?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`memory-drill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
